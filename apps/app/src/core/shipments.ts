import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import {
  allowedCommands,
  decide,
  type Actor,
  type Command,
  type DecisionErrorCode,
  type Effect,
  type ErpAdapter,
  type OrgDirectory,
  type Role,
  type ShipmentView,
  type State,
  type Turn,
  type WaitingItem,
} from '@nk/domain'
import type { Db } from '../db/client.ts'
import { event, mockErpShipment, org, participant, person, shipment, signature, vehicle } from '../db/schema.ts'
import { INVITE_TTL_MS, newInviteToken } from './invites.ts'

// Ядро перевозки (HAKATON-24). Всё, что меняет перевозку, идёт через execute():
// одна транзакция — блокировка строки, проверка участника, решение домена, запись
// изменений, журнала и того, что делается без внешних систем (приглашения, простые подписи).
// Последствия с внешними системами (оператор, учётка, файлы) возвращаются вызывающему
// и уходят в очередь заданий после коммита — адаптеры внутри транзакции не вызываем.

export type ExecResult =
  | {
      ok: true
      shipmentId: string
      from: State
      to: State
      turn: Turn
      /** последствия для очереди заданий после коммита */
      afterCommit: Effect[]
      /** выданные приглашения: токен показываем один раз, в базе только хеш */
      invites: { role: Role; token: string }[]
    }
  | { ok: false; code: DecisionErrorCode | 'not_found' | 'not_participant' | 'busy'; message: string }

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

const IN_TX_EFFECTS = new Set<Effect['kind']>(['invite', 'recordPep'])

/** Что из команды пишем в журнал: без доказательств подписи, они лежат в signature. */
function eventPayload(cmd: Command): Record<string, unknown> {
  const { evidence: _evidence, ...rest } = cmd.payload as Record<string, unknown>
  return rest
}

/** Куда ядро отдаёт последствия после коммита: очередь заданий (jobs/jobs.ts). */
export interface EffectSink {
  enqueue(shipmentId: string, effects: Effect[]): Promise<void>
}

export interface ShipperListItem {
  erpRef: string
  consigneeName: string
  plannedLoadingAt: Date | null
  shipmentId: string | null
  state: State | null
}

export class ShipmentService {
  constructor(
    private readonly db: Db,
    private readonly erp: ErpAdapter,
    private readonly directory: OrgDirectory,
    private readonly sink: EffectSink | null = null,
  ) {}

  // ---------- создание ----------

  /** Отгрузка из учётной системы → перевозка в черновике. Повторный вызов вернёт ту же перевозку. */
  async openFromErp(input: { shipperOrgId: string; shipperInn: string; erpRef: string; personId: string }): Promise<string> {
    const [existing] = await this.db
      .select({ id: shipment.id })
      .from(shipment)
      .where(and(eq(shipment.shipperOrgId, input.shipperOrgId), eq(shipment.erpRef, input.erpRef)))
    if (existing) {
      await this.db
        .insert(participant)
        .values({ shipmentId: existing.id, role: 'shipper', personId: input.personId, source: 'known', joinedAt: new Date() })
        .onConflictDoNothing()
      return existing.id
    }

    const src = await this.erp.getShipment(input.erpRef)
    if (!src || src.shipperInn !== input.shipperInn) throw new Error(`отгрузки ${input.erpRef} нет в учётной системе отправителя`)
    const consigneeOrgId = await this.ensureOrg(src.consignee.inn, src.consignee.name)

    return this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(shipment)
        .values({
          erpRef: src.ref,
          shipperOrgId: input.shipperOrgId,
          consigneeOrgId,
          loadingAddress: src.loadingAddress,
          unloadingAddress: src.unloadingAddress,
          plannedLoadingAt: src.plannedLoadingAt ? new Date(src.plannedLoadingAt) : null,
          cargo: { lines: src.lines, places: src.places, grossKg: src.grossKg },
          state: 'draft',
          turn: 'shipper',
        })
        .onConflictDoNothing()
        .returning({ id: shipment.id })
      // Две вкладки открыли одну отгрузку одновременно — берём ту, что успела первой
      const id =
        created?.id ??
        (await tx
          .select({ id: shipment.id })
          .from(shipment)
          .where(and(eq(shipment.shipperOrgId, input.shipperOrgId), eq(shipment.erpRef, input.erpRef))))[0]!.id
      await tx
        .insert(participant)
        .values({ shipmentId: id, role: 'shipper', personId: input.personId, source: 'known', joinedAt: new Date() })
        .onConflictDoNothing()
      if (created) await tx.insert(event).values({ shipmentId: id, type: 'shipment.created', actorKind: 'erp', payload: { erpRef: src.ref } })
      return id
    })
  }

  /** Организация по ИНН: наша, иначе из справочника, иначе по названию из учётки (не проверена). */
  private async ensureOrg(inn: string, fallbackName: string): Promise<string> {
    const [known] = await this.db.select({ id: org.id }).from(org).where(eq(org.inn, inn))
    if (known) return known.id
    const found = await this.directory.findByInn(inn)
    await this.db
      .insert(org)
      .values(
        found
          ? { inn, kpp: found.kpp, name: found.name, address: found.address, verified: true }
          : { inn, name: fallbackName, address: '', verified: false },
      )
      .onConflictDoNothing()
    const [row] = await this.db.select({ id: org.id }).from(org).where(eq(org.inn, inn))
    return row!.id
  }

  // ---------- команды ----------

  async execute(cmd: Command, actor: Actor): Promise<ExecResult> {
    let res: ExecResult
    try {
      res = await this.executeTx(cmd, actor)
    } catch (err) {
      // Частичные уникальные индексы: одна активная перевозка на машину и на водителя
      const pg = err as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } }
      const code = pg.code ?? pg.cause?.code
      const constraint = pg.constraint ?? pg.cause?.constraint ?? ''
      if (code === '23505' && constraint.startsWith('shipment_active_')) {
        const what = constraint.includes('vehicle') ? 'Эта машина' : 'Этот водитель'
        return { ok: false, code: 'busy', message: `${what} уже в другой перевозке, которая ещё не закрыта` }
      }
      throw err
    }
    // После коммита: последствия с внешними системами — в очередь.
    // Если процесс упадёт между коммитом и постановкой, последствие потеряется; для MVP допустимо.
    if (res.ok && res.afterCommit.length && this.sink) await this.sink.enqueue(res.shipmentId, res.afterCommit)
    return res
  }

  private async executeTx(cmd: Command, actor: Actor): Promise<ExecResult> {
    return this.db.transaction(async (tx) => {
      const [s] = await tx.select().from(shipment).where(eq(shipment.id, cmd.shipmentId)).for('update')
      if (!s) return { ok: false, code: 'not_found', message: 'перевозка не найдена' } as const

      if (actor.kind === 'person') {
        const [p] = await tx
          .select({ personId: participant.personId })
          .from(participant)
          .where(and(eq(participant.shipmentId, s.id), eq(participant.role, actor.role)))
        if (p?.personId !== actor.personId) {
          await tx.insert(event).values({
            shipmentId: s.id,
            type: 'command.rejected',
            actorKind: 'person',
            actorPersonId: actor.personId,
            actorRole: actor.role,
            payload: { command: cmd.type, code: 'not_participant', state: s.state },
          })
          return { ok: false, code: 'not_participant', message: 'вы не участник этой перевозки в этой роли' } as const
        }
      }

      const d = decide(
        { state: s.state, carrierOrgId: s.carrierOrgId, vehicleId: s.vehicleId, driverPersonId: s.driverPersonId, operatorDocId: s.operatorDocId },
        cmd,
        actor,
      )
      const actorPersonId = actor.kind === 'person' ? actor.personId : null
      const actorRole = actor.kind === 'person' ? actor.role : null
      if (!d.ok) {
        // В журнал пишем и неудачные попытки: по ним видно, где люди путаются
        await tx.insert(event).values({
          shipmentId: s.id,
          type: 'command.rejected',
          actorKind: actor.kind,
          actorPersonId,
          actorRole,
          payload: { command: cmd.type, code: d.code, state: s.state },
        })
        return d
      }

      await tx
        .update(shipment)
        .set({
          ...d.patch,
          state: d.to,
          turn: d.turn,
          turnSince: sql`now()`,
          version: sql`${shipment.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(shipment.id, s.id))

      await this.syncParticipants(tx, cmd, s.id, actorPersonId)

      const invites: { role: Role; token: string }[] = []
      for (const e of d.effects) {
        if (e.kind === 'invite') invites.push({ role: e.role, token: await this.createInvite(tx, s.id, e, actorPersonId) })
        if (e.kind === 'recordPep' && actorPersonId) {
          await tx.insert(signature).values({
            shipmentId: s.id,
            titleKind: e.title,
            role: e.role,
            kind: 'pep_max',
            signerPersonId: actorPersonId,
            verified: true,
            evidence: e.evidence as unknown as Record<string, unknown>,
          })
        }
      }

      await tx.insert(event).values({
        shipmentId: s.id,
        type: cmd.type,
        actorKind: actor.kind,
        actorPersonId,
        actorRole,
        payload: { from: d.from, to: d.to, ...eventPayload(cmd) },
      })

      return {
        ok: true,
        shipmentId: s.id,
        from: d.from,
        to: d.to,
        turn: d.turn,
        afterCommit: d.effects.filter((e) => !IN_TX_EFFECTS.has(e.kind)),
        invites,
      } as const
    })
  }

  /** Кто участвует: назначенный по контакту становится участником, отказавшийся — перестаёт. */
  private async syncParticipants(tx: Tx, cmd: Command, shipmentId: string, invitedBy: string | null) {
    const assign = async (role: Role, personId: string) => {
      await tx
        .insert(participant)
        .values({ shipmentId, role, personId, source: 'contact', invitedByPersonId: invitedBy, joinedAt: new Date() })
        .onConflictDoUpdate({
          target: [participant.shipmentId, participant.role],
          set: { personId, source: 'contact', invitedByPersonId: invitedBy, joinedAt: new Date(), inviteTokenSha256: null, inviteExpiresAt: null },
        })
    }
    const drop = (role: Role) => tx.delete(participant).where(and(eq(participant.shipmentId, shipmentId), eq(participant.role, role)))

    switch (cmd.type) {
      case 'shipper.offerCarrier':
        if ('personId' in cmd.payload.carrier) await assign('carrier', cmd.payload.carrier.personId)
        break
      case 'carrier.assign':
        if ('personId' in cmd.payload.driver) await assign('driver', cmd.payload.driver.personId)
        break
      case 'carrier.decline':
        await drop('carrier')
        break
      case 'driver.declineTrip':
        await drop('driver')
        break
    }
  }

  private async createInvite(tx: Tx, shipmentId: string, e: Extract<Effect, { kind: 'invite' }>, invitedBy: string | null) {
    const { token, sha256 } = newInviteToken()
    const values = {
      personId: null,
      inviteTokenSha256: sha256,
      inviteExpiresAt: new Date(Date.now() + INVITE_TTL_MS),
      inviteSingleUse: e.role === 'consignee',
      expectedMaxUserId: e.ref.invite.expectedMaxUserId,
      expectedPhoneSha256: e.ref.invite.expectedPhoneSha256,
      invitedByPersonId: invitedBy,
      source: 'link' as const,
      joinedAt: null,
    }
    await tx
      .insert(participant)
      .values({ shipmentId, role: e.role, ...values })
      .onConflictDoUpdate({ target: [participant.shipmentId, participant.role], set: values })
    return token
  }

  // ---------- чтение ----------

  /** Кто сейчас в роли перевозки — чтобы написать ему. */
  async participantOf(shipmentId: string, role: Role): Promise<{ personId: string; maxUserId: number } | null> {
    const [row] = await this.db
      .select({ personId: person.id, maxUserId: person.maxUserId })
      .from(participant)
      .innerJoin(person, eq(person.id, participant.personId))
      .where(and(eq(participant.shipmentId, shipmentId), eq(participant.role, role)))
    return row ?? null
  }

  /** Все вошедшие участники перевозки — чтобы перерисовать их живые карточки. */
  async participants(shipmentId: string): Promise<{ personId: string; maxUserId: number; role: Role }[]> {
    return this.db
      .select({ personId: person.id, maxUserId: person.maxUserId, role: participant.role })
      .from(participant)
      .innerJoin(person, eq(person.id, participant.personId))
      .where(eq(participant.shipmentId, shipmentId))
  }

  /** Роли человека в перевозке. */
  async rolesIn(shipmentId: string, personId: string): Promise<Role[]> {
    const rows = await this.db
      .select({ role: participant.role })
      .from(participant)
      .where(and(eq(participant.shipmentId, shipmentId), eq(participant.personId, personId)))
    return rows.map((r) => r.role)
  }

  /** Очередь «ждут вас»: перевозки, где ход за ролью человека; дольше ждущие первыми. */
  async waiting(personId: string, role?: Role): Promise<WaitingItem[]> {
    const rows = await this.db
      .select({ shipmentId: shipment.id, erpRef: shipment.erpRef, state: shipment.state, role: participant.role, turnSince: shipment.turnSince })
      .from(participant)
      .innerJoin(shipment, and(eq(shipment.id, participant.shipmentId), eq(shipment.turn, participant.role)))
      .where(and(eq(participant.personId, personId), role ? eq(participant.role, role) : undefined))
      .orderBy(shipment.turnSince)
    return rows.map((r) => ({ ...r, turnSince: r.turnSince.toISOString() }))
  }

  /** Отгрузки отправителя из учётной системы вместе с состоянием перевозки, если она уже заведена. */
  async shipperList(shipperOrgId: string, shipperInn: string): Promise<ShipperListItem[]> {
    return this.db
      .select({
        erpRef: mockErpShipment.ref,
        consigneeName: mockErpShipment.consigneeName,
        plannedLoadingAt: mockErpShipment.plannedLoadingAt,
        shipmentId: shipment.id,
        state: shipment.state,
      })
      .from(mockErpShipment)
      .leftJoin(shipment, and(eq(shipment.erpRef, mockErpShipment.ref), eq(shipment.shipperOrgId, shipperOrgId)))
      .where(eq(mockErpShipment.shipperInn, shipperInn))
      .orderBy(mockErpShipment.plannedLoadingAt)
  }

  /** Перевозки человека в роли, по желанию — только в этих состояниях. Свежие сверху. */
  async listFor(personId: string, role: Role, states?: State[]) {
    return this.db
      .select({ shipmentId: shipment.id, erpRef: shipment.erpRef, state: shipment.state, plannedLoadingAt: shipment.plannedLoadingAt })
      .from(participant)
      .innerJoin(shipment, eq(shipment.id, participant.shipmentId))
      .where(and(eq(participant.personId, personId), eq(participant.role, role), states ? inArray(shipment.state, states) : undefined))
      .orderBy(desc(shipment.updatedAt))
  }

  /** Вид перевозки для роли: данные и коды, тексты рисует бот. */
  async view(shipmentId: string, viewerRole: Role): Promise<ShipmentView | null> {
    const [s] = await this.db.select().from(shipment).where(eq(shipment.id, shipmentId))
    if (!s) return null

    const orgIds = [s.shipperOrgId, s.consigneeOrgId, ...(s.carrierOrgId ? [s.carrierOrgId] : [])]
    const orgs = new Map((await this.db.select().from(org).where(inArray(org.id, orgIds))).map((o) => [o.id, o]))
    const brief = (id: string | null) => {
      const o = id ? orgs.get(id) : undefined
      return o ? { id: o.id, name: o.name, inn: o.inn } : null
    }
    const [driver] = s.driverPersonId ? await this.db.select().from(person).where(eq(person.id, s.driverPersonId)) : []
    const [car] = s.vehicleId ? await this.db.select().from(vehicle).where(eq(vehicle.id, s.vehicleId)) : []

    const events = await this.db
      .select({ e: event, name: person.name })
      .from(event)
      .leftJoin(person, eq(person.id, event.actorPersonId))
      .where(and(eq(event.shipmentId, s.id), sql`${event.type} <> 'command.rejected'`))
      .orderBy(desc(event.at))
      .limit(5)

    return {
      id: s.id,
      erpRef: s.erpRef,
      state: s.state,
      turn: s.turn ?? null,
      turnSince: s.turnSince.toISOString(),
      viewerRole,
      actions: allowedCommands(s.state, viewerRole),
      shipper: brief(s.shipperOrgId)!,
      carrier: brief(s.carrierOrgId),
      consignee: brief(s.consigneeOrgId)!,
      driver: driver ? { id: driver.id, name: driver.name } : null,
      vehicle: car ? { plate: car.plate, brand: car.brand } : null,
      loadingAddress: s.loadingAddress,
      unloadingAddress: s.unloadingAddress,
      plannedLoadingAt: s.plannedLoadingAt?.toISOString() ?? null,
      cargo: { lines: s.cargo.lines.map((l) => ({ name: l.name, qty: l.qty, grossKg: l.grossKg })), places: s.cargo.places, grossKg: s.cargo.grossKg },
      loadingRemarks: s.loadingRemarks,
      acceptance: s.acceptance ?? null,
      uid: s.uid,
      titles: [],
      recentEvents: events.map(({ e, name }) => ({
        at: e.at.toISOString(),
        type: e.type,
        actorKind: e.actorKind,
        actorRole: e.actorRole ?? null,
        actorName: name ?? null,
        data: e.payload,
      })),
    }
  }

  /** Есть ли у перевозки приглашение в роль, которое ещё никто не принял. */
  async pendingInvite(shipmentId: string, role: Role): Promise<boolean> {
    const [row] = await this.db
      .select({ id: participant.id })
      .from(participant)
      .where(and(eq(participant.shipmentId, shipmentId), eq(participant.role, role), isNull(participant.personId)))
    return Boolean(row)
  }
}
