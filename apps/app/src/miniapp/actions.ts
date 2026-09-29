import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import { normalizePlate, OperatorBusy, type Command as CoreCommand, type EpdOperator, type OutMessage, type Role } from '@nk/domain'
import type { FastifyBaseLogger } from 'fastify'
import type { Db } from '../db/client.ts'
import { membership, org, participant, person, shipment, vehicle, type LineChecks } from '../db/schema.ts'
import type { ExecResult, ShipmentService } from '../core/shipments.ts'
import type { FleetService } from '../core/fleet.ts'
import type { BotStore } from '../bot/store.ts'
import { PoaService, type PoaRegistry } from '../core/poa.ts'
import { BODY_TYPES, PEP } from '../bot/trip-flows.ts'
import { S, cb } from '../bot/screens.ts'
import { esc } from '../max/messenger.ts'
import { visibleTo, type Scope } from './access.ts'
import { isUuid } from './reader.ts'
import type { AcceptanceResult, Command, Handoff, LineCheck, VehicleInput } from './view.ts'

// Действия мини-приложения (HAKATON-42). Шаги без подписи — прямо из приложения через то же ядро,
// что и кнопки бота (ShipmentService.execute), с теми же сообщениями участникам. Подписи и отметки
// с простой подписью — только кнопкой в чате: приложение просит бота прислать сообщение с этой кнопкой,
// итог формы (замечания, приёмка по позициям) ждёт нажатия в черновике.

/** Что мини-приложению нужно от бота. Реализует Bot (bot/bot.ts). */
export interface MiniAppBot {
  afterMiniAppStep(res: Extract<ExecResult, { ok: true }>, actor: { personId: string; role: Role }, reason?: string): Promise<void>
  cardFromMiniApp(personId: string, shipmentId: string, role: Role, note: string): Promise<void>
  messageFromMiniApp(personId: string, message: OutMessage): Promise<void>
  driverContactFromMiniApp(personId: string, shipmentId: string, vehicleId: string): Promise<void>
}

export type ActionResult =
  /** chat — шаг продолжится в чате: бот прислал сообщение, приложение можно закрыть */
  | { ok: true; chat?: boolean }
  | { ok: false; status: number; error: string; message: string }

const fail = (status: number, error: string, message: string): ActionResult => ({ ok: false, status, error, message })

/** Шаги без доказательства простой подписи: их можно сделать прямо в приложении. */
const IN_APP: Command['type'][] = ['carrier.accept', 'carrier.decline', 'carrier.assign', 'driver.acceptTrip', 'driver.arrivedLoading', 'driver.arrivedUnloading']

const EXEC_FAIL: Record<string, [number, string]> = {
  not_participant: [403, 'Этот шаг делает тот, кто ведёт перевозку в вашей компании'],
  wrong_role: [403, 'Это шаг другой стороны'],
  wrong_state: [409, 'Сейчас этот шаг недоступен — экран обновлён'],
  already_done: [409, 'Уже сделано'],
  not_found: [404, 'Перевозка не найдена'],
}

const REASON_TEXT: Record<NonNullable<LineCheck['reason']>, string> = { shortage: 'недостача', damage: 'бой или повреждение', mismatch: 'пересорт', surplus: 'излишек' }
const REASONS = Object.keys(REASON_TEXT) as NonNullable<LineCheck['reason']>[]
const fmtKg = (kg: number) => `${kg.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} кг`

/** Пояснение над карточкой, которую бот присылает по кнопке из приложения. */
const FROM_APP = '👇 Продолжите здесь: шаг делается кнопкой под карточкой.'

type Cargo = { lines: { sku: string; name: string; qty: number; grossKg: number }[] }

export class MiniAppActions {
  constructor(
    private readonly db: Db,
    private readonly shipments: ShipmentService,
    private readonly store: BotStore,
    private readonly fleet: FleetService,
    private readonly bot: MiniAppBot,
    private readonly operator: EpdOperator | null,
    private readonly log: FastifyBaseLogger,
    private readonly poaRegistry: PoaRegistry | null = null,
  ) {}

  /** Отгрузка из учётной системы своей организации → перевозка. То же, что нажать её в списке бота. */
  async openErp(scope: Scope, ref: string): Promise<string | null> {
    if (scope.role !== 'shipper') return null
    const [own] = await this.db.select().from(org).where(inArray(org.id, scope.orgIds.length ? scope.orgIds : ['00000000-0000-0000-0000-000000000000']))
    if (!own) return null
    return this.shipments.openFromErp({ shipperOrgId: own.id, shipperInn: own.inn, erpRef: ref, personId: scope.personId }).catch(() => null)
  }

  // ---------- шаги ----------

  async command(scope: Scope, shipmentId: string, cmd: Command): Promise<ActionResult> {
    if (!IN_APP.includes(cmd.type)) return fail(400, 'chat_only', 'Этот шаг делается кнопкой в чате с ботом')
    const role = cmd.type.split('.')[0] as Role
    if (role !== scope.role) return fail(403, 'wrong_role', 'Это шаг другой стороны')
    const s = await this.visible(scope, shipmentId)
    if (!s) return fail(404, 'not_found', 'Перевозка не найдена')

    let core: CoreCommand
    let reason: string | undefined
    switch (cmd.type) {
      case 'carrier.accept': {
        // Номер перевозчика идёт в накладную: без подтверждённого номера — в чат, там бот спросит его
        const [p] = await this.db.select({ phone: person.phone }).from(person).where(eq(person.id, scope.personId))
        if (!p?.phone) {
          if (!(await this.holds(scope, shipmentId))) return fail(403, 'not_participant', EXEC_FAIL.not_participant![1])
          await this.bot.cardFromMiniApp(scope.personId, shipmentId, 'carrier', '📱 Чтобы принять заявку, подтвердите номер телефона: нажмите «Принять заявку» ниже.')
          return { ok: true, chat: true }
        }
        core = { type: 'carrier.accept', shipmentId, payload: {} }
        break
      }
      case 'carrier.decline':
        reason = String(cmd.reason ?? '').trim().slice(0, 500)
        if (reason.length < 3) return fail(400, 'invalid_payload', 'Напишите причину отказа')
        core = { type: 'carrier.decline', shipmentId, payload: { reason } }
        break
      case 'carrier.assign': {
        const car = await this.ownVehicle(scope, cmd.vehicleId)
        if (!car) return fail(400, 'invalid_payload', 'Такой машины нет у вашей компании')
        const missing = missingForWaybill(car)
        if (missing) return fail(400, 'vehicle_incomplete', `У машины ${car.plate} не хватает данных для накладной: ${missing}. Дополните их в «Машины и водители».`)
        const self = cmd.driverId === 'self' || cmd.driverId === scope.personId
        if (!self && !(await this.ownDriver(scope, cmd.driverId))) return fail(400, 'invalid_payload', 'Такого водителя нет у вашей компании')
        // Перевозчик сам за рулём: он становится и водителем своей компании, как по кнопке «Я сам за рулём»
        if (self) await this.store.ensureDriverOrg(scope.personId, car.orgId)
        core = { type: 'carrier.assign', shipmentId, payload: { vehicleId: car.id, driver: { personId: self ? scope.personId : cmd.driverId } } }
        break
      }
      default:
        core = { type: cmd.type, shipmentId, payload: {} } as CoreCommand
    }

    const res = await this.shipments.execute(core, { kind: 'person', personId: scope.personId, role })
    if (!res.ok) {
      const [status, message] = EXEC_FAIL[res.code] ?? [400, res.message]
      return fail(status, res.code, message)
    }
    // Сообщения участникам и живые карточки — не повод падать: шаг уже сделан
    await this.bot
      .afterMiniAppStep(res, { personId: scope.personId, role }, reason)
      .catch((err) => this.log.warn({ err, shipmentId }, 'мини-приложение: не удалось разослать сообщения после шага'))
    return { ok: true }
  }

  /** Шаг в чате: бот присылает карточку или итог формы с кнопкой подписи, приложение закрывается. */
  async handoff(scope: Scope, shipmentId: string, h: Handoff): Promise<ActionResult> {
    const s = await this.visible(scope, shipmentId)
    if (!s) return fail(404, 'not_found', 'Перевозка не найдена')
    if (!(await this.holds(scope, shipmentId))) return fail(403, 'not_participant', EXEC_FAIL.not_participant![1])
    if (h.kind !== 'card' && s.turn !== scope.role) return fail(409, 'wrong_state', EXEC_FAIL.wrong_state![1])

    switch (h.kind) {
      case 'card':
        await this.bot.cardFromMiniApp(scope.personId, shipmentId, scope.role, FROM_APP)
        return { ok: true, chat: true }

      case 'remarks': {
        if (scope.role !== 'driver' || s.state !== 'loading') return fail(409, 'wrong_state', EXEC_FAIL.wrong_state![1])
        const check = cleanChecks(s.cargo, h.remarks)
        const text = checkText(s.cargo, check)
        if (!text) return fail(400, 'invalid_payload', 'Отметьте, что не сошлось, или напишите комментарий')
        await this.store.saveDraft(scope.personId, shipmentId, 'remarks', { ...check, text })
        await this.bot.messageFromMiniApp(scope.personId, {
          text: [
            `<b>Перевозка ${esc(s.erpRef)}: замечания при погрузке</b>`,
            '',
            esc(text),
            '',
            `Нажмите «${PEP.load_rm.button}» — это ваша простая подпись: груз принят с этими замечаниями. Отправитель увидит их до своей подписи.`,
          ].join('\n'),
          buttons: [[cb(PEP.load_rm.button, `cl:rm:${shipmentId}`)], [cb('Назад к перевозке', S.view(shipmentId))]],
        })
        return { ok: true, chat: true }
      }

      case 'acceptance': {
        if (scope.role !== 'consignee' || s.state !== 'receiving') return fail(409, 'wrong_state', EXEC_FAIL.wrong_state![1])
        const check = cleanChecks(s.cargo, h.acceptance)
        const differs = check.lines.some((l, i) => l.qty !== s.cargo.lines[i]!.qty || l.grossKg !== s.cargo.lines[i]!.grossKg)
        const result: AcceptanceResult = h.acceptance.result === 'refused' ? 'refused' : differs ? 'partial' : 'full'
        const text = result === 'refused' ? (check.comment ? `Отказ от груза: ${check.comment}` : null) : checkText(s.cargo, check)
        if (result !== 'full' && !text) return fail(400, 'invalid_payload', result === 'refused' ? 'Напишите, почему отказываетесь от груза' : 'Опишите расхождения')
        await this.store.saveDraft(scope.personId, shipmentId, 'acceptance', { ...check, result, text })
        const kind = ({ full: 'accept_full', partial: 'accept_partial', refused: 'accept_refused' } as const)[result]
        const summary = { full: 'принято без расхождений', partial: 'принято с расхождениями', refused: 'отказ от груза' }[result]
        await this.bot.messageFromMiniApp(scope.personId, {
          text: [
            `<b>Перевозка ${esc(s.erpRef)}: приёмка — ${summary}</b>`,
            ...(text ? ['', esc(text)] : []),
            '',
            `Нажмите «${PEP[kind].button}» — это ваша простая подпись под приёмкой. Дальше бот попросит подписать накладную.`,
          ].join('\n'),
          buttons: [[cb(PEP[kind].button, `pep:${kind}:${shipmentId}`)], [cb('Назад к перевозке', S.view(shipmentId))]],
        })
        return { ok: true, chat: true }
      }

      case 'driverContact': {
        if (scope.role !== 'carrier' || s.state !== 'carrier_accepted') return fail(409, 'wrong_state', EXEC_FAIL.wrong_state![1])
        if (!h.vehicleId) {
          await this.bot.cardFromMiniApp(scope.personId, shipmentId, 'carrier', FROM_APP)
          return { ok: true, chat: true }
        }
        const car = await this.ownVehicle(scope, h.vehicleId)
        if (!car) return fail(400, 'invalid_payload', 'Такой машины нет у вашей компании')
        const missing = missingForWaybill(car)
        if (missing) return fail(400, 'vehicle_incomplete', `У машины ${car.plate} не хватает данных для накладной: ${missing}. Дополните их в «Машины и водители».`)
        await this.bot.driverContactFromMiniApp(scope.personId, shipmentId, car.id)
        return { ok: true, chat: true }
      }
    }
  }

  // ---------- машины ----------

  /** Машина перевозчика: новая или правка своей. Госномер — как в боте, данные для накладной обязательны. */
  async saveVehicle(scope: Scope, v: VehicleInput): Promise<ActionResult> {
    if (scope.role !== 'carrier' || !scope.orgIds.length) return fail(403, 'wrong_role', 'Машины ведёт перевозчик')
    const plate = normalizePlate(String(v.plate ?? ''))
    if (!plate) return fail(400, 'invalid_payload', 'Госномер в формате А245КМ116: буквы кириллицей, без пробелов')
    const brand = String(v.brand ?? '').trim()
    if (brand.length < 2) return fail(400, 'invalid_payload', 'Укажите марку и модель')
    if (!['own', 'lease', 'rent', 'other'].includes(v.ownership)) return fail(400, 'invalid_payload', 'Укажите вид владения')
    const ownerName = v.ownership === 'own' ? null : String(v.ownerName ?? '').trim() || null
    if (v.ownership !== 'own' && (!ownerName || ownerName.length < 3)) return fail(400, 'invalid_payload', 'Укажите владельца машины: компанию или ФИО')
    if (!v.bodyType || !BODY_TYPES.includes(v.bodyType)) return fail(400, 'invalid_payload', 'Выберите тип кузова')
    const capacityT = Number(v.capacityT)
    if (!Number.isFinite(capacityT) || capacityT < 0.5 || capacityT > 60) return fail(400, 'invalid_payload', 'Грузоподъёмность в тоннах, от 0,5 до 60')
    const volumeM3 = Number(v.volumeM3)
    if (!Number.isFinite(volumeM3) || volumeM3 < 1 || volumeM3 > 200) return fail(400, 'invalid_payload', 'Объём кузова в м³, от 1 до 200')

    const orgId = scope.orgIds[0]!
    const input = { plate, brand: brand.slice(0, 100), ownership: v.ownership, ownerName, bodyType: v.bodyType, capacityT, volumeM3 }
    if (v.id) {
      const own = await this.ownVehicle(scope, v.id)
      if (!own) return fail(404, 'not_found', 'Такой машины нет у вашей компании')
      const [clash] = await this.db.select({ id: vehicle.id }).from(vehicle).where(and(eq(vehicle.orgId, own.orgId), eq(vehicle.plate, plate)))
      if (clash && clash.id !== own.id) return fail(409, 'duplicate', 'Машина с таким госномером уже есть в списке')
      await this.db.update(vehicle).set(input).where(eq(vehicle.id, own.id))
    } else {
      const [clash] = await this.db.select({ id: vehicle.id }).from(vehicle).where(and(eq(vehicle.orgId, orgId), eq(vehicle.plate, plate)))
      if (clash) return fail(409, 'duplicate', 'Машина с таким госномером уже есть в списке')
      await this.fleet.upsertVehicle(orgId, input)
    }
    return { ok: true }
  }

  // ---------- компания ----------

  /**
   * Реквизиты правит администратор и только введённые вручную (из справочника — не правятся),
   * доверенность — своя: она у каждого подписанта своя.
   */
  async saveCompany(
    scope: Scope,
    patch: { name?: string; address?: string; signerKind?: 'head' | 'employee'; poa?: { number: string; issuedAt: string; validTo: string } },
  ): Promise<ActionResult> {
    const [row] = await this.db
      .select({ m: membership, o: org })
      .from(membership)
      .innerJoin(org, eq(org.id, membership.orgId))
      .where(and(eq(membership.personId, scope.personId), eq(membership.role, scope.role), isNotNull(membership.orgId)))
      .orderBy(membership.createdAt)
      .limit(1)
    if (!row) return fail(404, 'not_found', 'Компания не подключена')
    if (patch.name !== undefined || patch.address !== undefined) {
      if (row.o.verified) return fail(403, 'verified', 'Реквизиты из справочника не правятся вручную')
      if (!row.m.isAdmin) return fail(403, 'not_admin', 'Реквизиты меняет администратор компании')
      const name = patch.name?.trim()
      const address = patch.address?.trim()
      if (name !== undefined && name.length < 3) return fail(400, 'invalid_payload', 'Слишком короткое название')
      if (address !== undefined && address.length < 10) return fail(400, 'invalid_payload', 'Нужен полный адрес с индексом')
      await this.db.update(org).set({ ...(name ? { name } : {}), ...(address ? { address } : {}) }).where(eq(org.id, row.o.id))
    }
    // МЧД и «кто подписывает» — своё у каждого подписанта (HAKATON-49); проверки те же, что в боте
    if ((patch.signerKind || patch.poa) && scope.role === 'driver') return fail(400, 'invalid_payload', 'Водитель подтверждает приём и сдачу груза своей подписью — доверенность не нужна')
    const poas = new PoaService(this.db, { pki: null, registry: this.poaRegistry })
    if (patch.signerKind) await poas.setSignerKind(row.m.id, patch.signerKind)
    if (patch.poa) {
      const day = (s: string) => {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
        return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12)) : null
      }
      const issuedAt = day(patch.poa.issuedAt)
      const validTo = day(patch.poa.validTo)
      if (!issuedAt) return fail(400, 'invalid_payload', 'Укажите дату выдачи доверенности')
      if (!validTo) return fail(400, 'invalid_payload', 'Укажите, до какого числа действует доверенность')
      const res = await poas.addManual({ membershipId: row.m.id, number: patch.poa.number, issuedAt, validTo })
      if (!res.ok) return fail(400, 'invalid_payload', res.error ?? 'Доверенность не принята')
    }
    return { ok: true }
  }

  // ---------- документы ----------

  /** Анимированный QR-код накладной от оператора ЭПД (модель) — тот же, что приходит водителю в чат. */
  async qr(scope: Scope, shipmentId: string): Promise<Uint8Array | null> {
    const s = await this.visible(scope, shipmentId)
    if (!s?.uid || !s.operatorDocId || !this.operator) return null
    try {
      return await this.operator.qr(s.operatorDocId)
    } catch (err) {
      if (err instanceof OperatorBusy) return null
      throw err
    }
  }

  // ---------- проверки ----------

  private async visible(scope: Scope, shipmentId: string) {
    if (!isUuid(shipmentId)) return null
    const [row] = await this.db.select().from(shipment).where(and(eq(shipment.id, shipmentId), visibleTo(this.db, scope)))
    return row ?? null
  }

  /** Человек ведёт перевозку в этой роли — он её участник. */
  private async holds(scope: Scope, shipmentId: string) {
    const [row] = await this.db
      .select({ personId: participant.personId })
      .from(participant)
      .where(and(eq(participant.shipmentId, shipmentId), eq(participant.role, scope.role)))
    return row?.personId === scope.personId
  }

  private async ownVehicle(scope: Scope, id: string) {
    if (!isUuid(id) || !scope.orgIds.length) return null
    const [row] = await this.db.select().from(vehicle).where(and(eq(vehicle.id, id), inArray(vehicle.orgId, scope.orgIds)))
    return row ?? null
  }

  private async ownDriver(scope: Scope, personId: string) {
    if (!isUuid(personId) || !scope.orgIds.length) return false
    const [row] = await this.db
      .select({ id: membership.id })
      .from(membership)
      .where(and(eq(membership.personId, personId), eq(membership.role, 'driver'), inArray(membership.orgId, scope.orgIds)))
      .limit(1)
    return Boolean(row)
  }
}

/** Чего не хватает машине для накладной (Т1): машины из бота до 25.09 заводились без этого. */
function missingForWaybill(car: { bodyType: string | null; capacityT: number | null; volumeM3: number | null }): string | null {
  const miss = [!car.bodyType && 'тип кузова', car.capacityT == null && 'грузоподъёмность', car.volumeM3 == null && 'объём кузова'].filter(Boolean)
  return miss.length ? miss.join(', ') : null
}

/** Сверка из формы: по строке на каждую позицию груза, в порядке накладной; чужие позиции и мусор — отбрасываем. */
export function cleanChecks(cargo: Cargo, input: { lines?: unknown; comment?: unknown }): LineChecks {
  const given = new Map<string, Record<string, unknown>>()
  if (Array.isArray(input.lines)) for (const l of input.lines) if (l && typeof l === 'object' && typeof (l as { sku?: unknown }).sku === 'string') given.set((l as { sku: string }).sku, l as Record<string, unknown>)
  const lines = cargo.lines.map((c) => {
    const g = given.get(c.sku)
    const qty = Number(g?.qty)
    const kg = Number(g?.grossKg)
    const reason = REASONS.includes(g?.reason as never) ? (g!.reason as LineCheck['reason']) : null
    return {
      sku: c.sku,
      qty: Number.isInteger(qty) && qty >= 0 && qty <= c.qty * 10 ? qty : c.qty,
      grossKg: Number.isFinite(kg) && kg >= 0 && kg <= c.grossKg * 10 ? Math.round(kg * 10) / 10 : c.grossKg,
      reason,
    }
  })
  const comment = typeof input.comment === 'string' && input.comment.trim() ? input.comment.trim().slice(0, 1000) : null
  return { lines, comment }
}

/** Текст для накладной: что не сошлось по позициям и комментарий. Пусто — расхождений нет. */
export function checkText(cargo: Cargo, check: LineChecks): string | null {
  const parts = check.lines.flatMap((l, i) => {
    const c = cargo.lines[i]!
    if (l.qty === c.qty && l.grossKg === c.grossKg) return []
    return [`${c.name}: ${l.qty} из ${c.qty} мест, ${fmtKg(l.grossKg)} из ${fmtKg(c.grossKg)}${l.reason ? `, ${REASON_TEXT[l.reason]}` : ''}`]
  })
  if (check.comment) parts.push(check.comment)
  return parts.length ? parts.join('; ') : null
}
