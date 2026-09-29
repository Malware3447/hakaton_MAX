import { and, desc, eq, gt, inArray, isNotNull, isNull, ne, notInArray, or, sql } from 'drizzle-orm'
import { ACTIVE_STATES, type Role } from '@nk/domain'
import type { Db } from '../db/client.ts'
import { event, membership, mockErpShipment, org, participant, person, poa, shipment, signature, title, vehicle } from '../db/schema.ts'
import { ROLE_TITLE } from '../bot/screens.ts'
import { BotStore } from '../bot/store.ts'
import { isParticipant, scopeOf, visibleTo, type Scope } from './access.ts'
import { HIDDEN_EVENTS, eventActor, eventText, eventTurn, referencedIds, type EventNames } from './feed.ts'
import type { Company, Driver, FileLink, LineCheck, Me, Notice, OrgBrief, PoaAlert, ShipEvent, Shipment, TitleView, Vehicle } from './view.ts'

/** За сколько дней до конца доверенности напоминать */
const POA_WARN_DAYS = 14

// Чтение для экранов мини-приложения (HAKATON-42): списки, карточка, лента, раздел событий,
// машины и водители, компания. Всё — в пределах роли человека и его организации (access.ts).

type ShipmentRow = typeof shipment.$inferSelect
type OrgRow = typeof org.$inferSelect
type EventRow = typeof event.$inferSelect

/** Отгрузка учётной системы, по которой перевозка ещё не заведена: id вида erp:ОТГ-2026-1040. */
export const ERP_PREFIX = 'erp:'

/** Человек для API: ролей может ещё не быть — тогда приложение просит завести роль в чате. */
export type MeView = Omit<Me, 'activeRole'> & { activeRole: Role | null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (s: string) => UUID.test(s)

const brief = (o: OrgRow): OrgBrief => ({ id: o.id, name: o.name, inn: o.inn })
const noPhotos = (lines: { sku: string; qty: number; grossKg: number; reason: LineCheck['reason'] }[]): LineCheck[] => lines.map((l) => ({ ...l, photos: [] }))

export class MiniAppReader {
  private readonly store: BotStore

  constructor(private readonly db: Db) {
    this.store = new BotStore(db)
  }

  // ---------- человек и роли ----------

  /** Роль человека и его организации в ней; null — такой роли нет. */
  scope(personId: string, role: Role): Promise<Scope | null> {
    return scopeOf(this.db, personId, role)
  }

  /** Роли в том же порядке, что меню бота; «ждут вас» — где ход за человеком, у отправителя ещё новые отгрузки. */
  async me(personId: string): Promise<MeView | null> {
    const [p] = await this.db.select().from(person).where(eq(person.id, personId))
    if (!p) return null
    const roles = []
    for (const r of await this.store.roles(personId)) {
      const scope = await scopeOf(this.db, personId, r.role)
      roles.push({ role: r.role, title: ROLE_TITLE[r.role], orgName: r.org?.name ?? null, waiting: scope ? await this.waitingCount(scope) : 0, poaAlert: await this.poaAlert(personId, r.role) })
    }
    const activeRole = roles.find((r) => r.role === p.activeRole)?.role ?? roles[0]?.role ?? null
    return { name: p.name, activeRole, roles }
  }

  /**
   * Напоминание о доверенности (HAKATON-49): только сотруднику, который подписывает за компанию по МЧД.
   * Руководителю, ИП и водителю доверенность не нужна — им ничего не показываем.
   */
  private async poaAlert(personId: string, role: Role, now = new Date()): Promise<PoaAlert | null> {
    if (role === 'driver') return null
    const [m] = await this.db
      .select()
      .from(membership)
      .where(and(eq(membership.personId, personId), eq(membership.role, role), isNotNull(membership.orgId)))
      .orderBy(membership.createdAt)
      .limit(1)
    if (!m || m.signerKind !== 'employee') return null
    const current = await this.poaOf(m)
    if (!current || current.source === 'legacy') return { kind: 'missing', daysLeft: null, validTo: current?.validTo ?? null }
    const day = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    const daysLeft = Math.round((day(new Date(current.validTo)) - day(now)) / 86_400_000)
    if (daysLeft < 0) return { kind: 'expired', daysLeft, validTo: current.validTo }
    if (daysLeft <= POA_WARN_DAYS) return { kind: 'expiring', daysLeft, validTo: current.validTo }
    return null
  }

  private async waitingCount(scope: Scope): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(shipment)
      .where(and(eq(shipment.turn, scope.role), isParticipant(this.db, scope)))
    const erp = scope.role === 'shipper' ? (await this.erpDrafts(scope)).length : 0
    return (row?.n ?? 0) + erp
  }

  // ---------- списки и карточка ----------

  /** Перевозки роли без ленты и подписей: главная сама раскладывает их по вкладкам и фильтрам. */
  async list(scope: Scope): Promise<Shipment[]> {
    const rows = await this.db.select().from(shipment).where(visibleTo(this.db, scope)).orderBy(desc(shipment.updatedAt))
    const items = await this.build(scope, rows, false)
    if (scope.role === 'shipper') items.push(...(await this.erpDrafts(scope)))
    return items
  }

  /** Карточка целиком. Чужая перевозка — null, как несуществующая. */
  async shipment(scope: Scope, id: string): Promise<Shipment | null> {
    if (!isUuid(id)) return null
    const [row] = await this.db.select().from(shipment).where(and(eq(shipment.id, id), visibleTo(this.db, scope)))
    return row ? ((await this.build(scope, [row], true))[0] ?? null) : null
  }

  /** Отгрузка учётной системы своей организации, по которой перевозка ещё не заведена. */
  async erpDraft(scope: Scope, ref: string): Promise<Shipment | null> {
    if (scope.role !== 'shipper') return null
    return (await this.erpDrafts(scope)).find((s) => s.erpRef === ref) ?? null
  }

  private async build(scope: Scope, rows: ShipmentRow[], full: boolean): Promise<Shipment[]> {
    if (!rows.length) return []
    const ids = rows.map((r) => r.id)
    const orgs = new Map((await this.orgs(rows.flatMap((r) => [r.shipperOrgId, r.consigneeOrgId, r.carrierOrgId]))).map((o) => [o.id, o]))
    const driverIds = rows.flatMap((r) => (r.driverPersonId ? [r.driverPersonId] : []))
    const drivers = new Map(driverIds.length ? (await this.db.select().from(person).where(inArray(person.id, driverIds))).map((p) => [p.id, p]) : [])
    const carIds = rows.flatMap((r) => (r.vehicleId ? [r.vehicleId] : []))
    const cars = new Map(carIds.length ? (await this.db.select().from(vehicle).where(inArray(vehicle.id, carIds))).map((v) => [v.id, v]) : [])
    // Кто ведёт перевозку в роли зрителя: он сам — может действовать, иначе — имя коллеги
    const holders = new Map(
      (
        await this.db
          .select({ shipmentId: participant.shipmentId, personId: participant.personId, name: person.name })
          .from(participant)
          .leftJoin(person, eq(person.id, participant.personId))
          .where(and(inArray(participant.shipmentId, ids), eq(participant.role, scope.role)))
      ).map((h) => [h.shipmentId, h]),
    )
    const titles = full ? await this.titles(ids) : new Map<string, TitleView[]>()
    const feeds = full ? await this.feed(scope.personId, rows) : new Map<string, ShipEvent[]>()
    const declines = full ? await this.declineReasons(rows.filter((r) => r.state === 'draft').map((r) => r.id)) : new Map<string, string>()

    return rows.map((r) => {
      const d = r.driverPersonId ? drivers.get(r.driverPersonId) : undefined
      const v = r.vehicleId ? cars.get(r.vehicleId) : undefined
      const holder = holders.get(r.id)
      const events = feeds.get(r.id) ?? []
      return {
        id: r.id,
        erpRef: r.erpRef,
        state: r.state,
        turn: r.turn ?? null,
        turnSince: r.turnSince.toISOString(),
        shipper: brief(orgs.get(r.shipperOrgId)!),
        carrier: r.carrierOrgId && orgs.has(r.carrierOrgId) ? brief(orgs.get(r.carrierOrgId)!) : null,
        consignee: brief(orgs.get(r.consigneeOrgId)!),
        driver: d ? { id: d.id, name: d.name } : null,
        vehicle: v ? { id: v.id, plate: v.plate, brand: v.brand } : null,
        loadingAddress: r.loadingAddress,
        unloadingAddress: r.unloadingAddress,
        // Дату погрузки учётка задаёт всегда (сид, загрузка из Excel); на всякий случай — дата заведения
        plannedLoadingAt: (r.plannedLoadingAt ?? r.createdAt).toISOString(),
        cargo: { lines: r.cargo.lines.map((l) => ({ sku: l.sku, name: l.name, qty: l.qty, grossKg: l.grossKg })), places: r.cargo.places, grossKg: r.cargo.grossKg },
        // По позициям — если отмечали в приложении; из чата приходит только текст
        loadingRemarks: r.loadingCheck
          ? { lines: noPhotos(r.loadingCheck.lines), comment: r.loadingCheck.comment }
          : r.loadingRemarks
            ? { lines: [], comment: r.loadingRemarks }
            : null,
        acceptance: r.acceptance
          ? {
              result: r.acceptance.result,
              lines: r.acceptanceCheck ? noPhotos(r.acceptanceCheck.lines) : [],
              comment: r.acceptanceCheck ? r.acceptanceCheck.comment : r.acceptance.discrepancies,
            }
          : null,
        declineReason: declines.get(r.id) ?? null,
        uid: r.uid,
        titles: titles.get(r.id) ?? [],
        events,
        canAct: holder?.personId === scope.personId,
        handledBy: holder?.personId && holder.personId !== scope.personId ? (holder.name ?? null) : null,
      }
    })
  }

  /** Подписи по частям накладной: часть без подписей ещё не подписана. */
  private async titles(ids: string[]): Promise<Map<string, TitleView[]>> {
    const rows = await this.db
      .select({ s: signature, name: person.name })
      .from(signature)
      .leftJoin(person, eq(person.id, signature.signerPersonId))
      .where(inArray(signature.shipmentId, ids))
      .orderBy(signature.createdAt)
    const out = new Map<string, TitleView[]>()
    for (const { s, name } of rows) {
      const list = out.get(s.shipmentId) ?? []
      let t = list.find((x) => x.kind === s.titleKind)
      if (!t) list.push((t = { kind: s.titleKind, signatures: [] }))
      t.signatures.push({ role: s.role, kind: s.kind, signerName: s.signerName ?? name ?? ROLE_TITLE[s.role], at: s.createdAt.toISOString() })
      out.set(s.shipmentId, list)
    }
    for (const list of out.values()) list.sort((a, b) => a.kind.localeCompare(b.kind))
    return out
  }

  /** Почему прошлый перевозчик отказался: последний отказ в журнале — для черновика после отказа. */
  private async declineReasons(ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map()
    const rows = await this.db
      .select({ shipmentId: event.shipmentId, payload: event.payload })
      .from(event)
      .where(and(inArray(event.shipmentId, ids), eq(event.type, 'carrier.decline')))
      .orderBy(desc(event.at))
    const out = new Map<string, string>()
    for (const r of rows) if (r.shipmentId && !out.has(r.shipmentId) && typeof r.payload.reason === 'string') out.set(r.shipmentId, r.payload.reason)
    return out
  }

  /** Лента: новые сверху, служебные записи журнала не показываем. */
  private async feed(viewerId: string, rows: ShipmentRow[]): Promise<Map<string, ShipEvent[]>> {
    const refs = new Map(rows.map((r) => [r.id, r.erpRef]))
    const evs = await this.db
      .select()
      .from(event)
      .where(and(inArray(event.shipmentId, [...refs.keys()]), notInArray(event.type, HIDDEN_EVENTS)))
      .orderBy(desc(event.at))
    const out = new Map<string, ShipEvent[]>()
    for (const e of await this.describe(viewerId, evs.map((e) => ({ e, erpRef: refs.get(e.shipmentId!) ?? '' })))) {
      out.set(e.shipmentId, [...(out.get(e.shipmentId) ?? []), e])
    }
    return out
  }

  /** Отгрузки учётной системы (модель) своей организации, по которым перевозка ещё не заведена. */
  private async erpDrafts(scope: Scope): Promise<Shipment[]> {
    const own = await this.orgs(scope.orgIds)
    if (!own.length) return []
    const byInn = new Map(own.map((o) => [o.inn, o]))
    const rows = await this.db
      .select({ e: mockErpShipment })
      .from(mockErpShipment)
      .leftJoin(shipment, and(eq(shipment.erpRef, mockErpShipment.ref), inArray(shipment.shipperOrgId, scope.orgIds)))
      .where(and(inArray(mockErpShipment.shipperInn, [...byInn.keys()]), isNull(shipment.id)))
      .orderBy(mockErpShipment.plannedLoadingAt)
    if (!rows.length) return []
    const consigneeInns = [...new Set(rows.map((r) => r.e.consigneeInn))]
    const consignees = new Map((await this.db.select().from(org).where(inArray(org.inn, consigneeInns))).map((o) => [o.inn, o]))
    return rows.map(({ e }) => {
      const c = consignees.get(e.consigneeInn)
      return {
        id: `${ERP_PREFIX}${e.ref}`,
        erpRef: e.ref,
        state: 'draft',
        turn: 'shipper',
        turnSince: e.createdAt.toISOString(),
        shipper: brief(byInn.get(e.shipperInn)!),
        carrier: null,
        consignee: c ? brief(c) : { id: `inn:${e.consigneeInn}`, name: e.consigneeName, inn: e.consigneeInn },
        driver: null,
        vehicle: null,
        loadingAddress: e.loadingAddress,
        unloadingAddress: e.unloadingAddress,
        plannedLoadingAt: (e.plannedLoadingAt ?? e.createdAt).toISOString(),
        cargo: { lines: e.lines.map((l) => ({ sku: l.sku, name: l.name, qty: l.qty, grossKg: l.grossKg })), places: e.places, grossKg: e.grossKg },
        loadingRemarks: null,
        acceptance: null,
        declineReason: null,
        uid: null,
        titles: [],
        events: [],
        canAct: true,
        handledBy: null,
      } satisfies Shipment
    })
  }

  // ---------- раздел событий и живое обновление ----------

  /**
   * Чужие события по перевозкам роли: новые сверху. Раздел у каждой роли свой — как и всё в приложении:
   * о ходе в других ролях человеку говорит счётчик у переключателя ролей и сообщения бота.
   */
  async notices(scope: Scope, limit = 60): Promise<Notice[]> {
    const [p] = await this.db.select({ seen: person.eventsSeen }).from(person).where(eq(person.id, scope.personId))
    const seenAt = p?.seen?.[scope.role] ? Date.parse(p.seen[scope.role]!) : null
    const events = await this.othersEvents(scope, null, limit)
    return events.map((event) => ({ event, read: seenAt !== null && Date.parse(event.at) <= seenAt }))
  }

  /** Что случилось у других после since — для живого обновления экрана и всплывашек. */
  pulse(scope: Scope, since: Date): Promise<ShipEvent[]> {
    return this.othersEvents(scope, since, 10)
  }

  /** Открыл раздел событий роли — всё, что было до этой минуты, в ней прочитано. */
  async markRead(scope: Scope) {
    await this.db
      .update(person)
      .set({ eventsSeen: sql`coalesce(${person.eventsSeen}, '{}'::jsonb) || jsonb_build_object(${scope.role}::text, ${new Date().toISOString()}::text)` })
      .where(eq(person.id, scope.personId))
  }

  private async othersEvents(scope: Scope, since: Date | null, limit: number): Promise<ShipEvent[]> {
    const evs = await this.db
      .select({ e: event, erpRef: shipment.erpRef })
      .from(event)
      .innerJoin(shipment, eq(shipment.id, event.shipmentId))
      .where(
        and(
          visibleTo(this.db, scope),
          notInArray(event.type, HIDDEN_EVENTS),
          or(isNull(event.actorPersonId), ne(event.actorPersonId, scope.personId)),
          since ? gt(event.at, since) : undefined,
        ),
      )
      .orderBy(desc(event.at))
      .limit(limit)
    return this.describe(scope.personId, evs)
  }

  private async describe(viewerId: string, evs: { e: EventRow; erpRef: string }[]): Promise<ShipEvent[]> {
    const names = await this.names(evs.map((x) => x.e))
    return evs.flatMap(({ e, erpRef }) => {
      const record = { type: e.type, actorKind: e.actorKind, actorPersonId: e.actorPersonId, actorRole: e.actorRole, payload: e.payload }
      const text = eventText(record, names)
      if (!text || !e.shipmentId) return []
      return [
        {
          id: e.id,
          at: e.at.toISOString(),
          shipmentId: e.shipmentId,
          erpRef,
          text,
          actor: eventActor(record, names),
          mine: e.actorPersonId === viewerId,
          turnFor: eventTurn(record),
        },
      ]
    })
  }

  private async names(evs: EventRow[]): Promise<EventNames> {
    const ids = referencedIds(evs.map((e) => ({ type: e.type, actorKind: e.actorKind, actorPersonId: e.actorPersonId, actorRole: e.actorRole, payload: e.payload })))
    const orgs = new Map((await this.orgs(ids.orgs)).map((o) => [o.id, o.name]))
    const cars = new Map(ids.vehicles.length ? (await this.db.select().from(vehicle).where(inArray(vehicle.id, ids.vehicles))).map((v) => [v.id, v.plate]) : [])
    const people = new Map(ids.people.length ? (await this.db.select().from(person).where(inArray(person.id, ids.people))).map((p) => [p.id, p.name]) : [])
    return { org: (id) => orgs.get(id) ?? null, vehicle: (id) => cars.get(id) ?? null, person: (id) => people.get(id) ?? null }
  }

  // ---------- перевозчик: машины, водители; отправитель: перевозчики ----------

  /** Перевозчики, с которыми организация отправителя уже работала: для фильтра списка. */
  async carriers(scope: Scope): Promise<OrgBrief[]> {
    if (scope.role !== 'shipper' || !scope.orgIds.length) return []
    const rows = await this.db
      .selectDistinct({ o: org })
      .from(shipment)
      .innerJoin(org, eq(org.id, shipment.carrierOrgId))
      .where(inArray(shipment.shipperOrgId, scope.orgIds))
    return rows.map((r) => brief(r.o)).sort((a, b) => a.name.localeCompare(b.name, 'ru'))
  }

  async vehicles(scope: Scope): Promise<Vehicle[]> {
    if (scope.role !== 'carrier' || !scope.orgIds.length) return []
    const cars = await this.db.select().from(vehicle).where(inArray(vehicle.orgId, scope.orgIds)).orderBy(vehicle.createdAt)
    const busy = cars.length ? await this.busy('vehicle', cars.map((c) => c.id)) : new Map<string, string>()
    return cars.map((c) => ({
      id: c.id,
      plate: c.plate,
      brand: c.brand,
      ownership: c.ownership,
      ownerName: c.ownerName,
      bodyType: c.bodyType,
      capacityT: c.capacityT,
      volumeM3: c.volumeM3,
      busyWith: busy.get(c.id) ?? null,
    }))
  }

  /** Водители перевозчика — роль «водитель» в его организации. */
  async drivers(scope: Scope): Promise<Driver[]> {
    if (scope.role !== 'carrier' || !scope.orgIds.length) return []
    const rows = await this.db
      .selectDistinct({ id: person.id, name: person.name })
      .from(membership)
      .innerJoin(person, eq(person.id, membership.personId))
      .where(and(inArray(membership.orgId, scope.orgIds), eq(membership.role, 'driver')))
      .orderBy(person.name)
    const busy = rows.length ? await this.busy('driver', rows.map((r) => r.id)) : new Map<string, string>()
    return rows.map((r) => ({ id: r.id, name: r.id === scope.personId ? `${r.name} (вы)` : r.name, busyWith: busy.get(r.id) ?? null, isMe: r.id === scope.personId }))
  }

  /** В какой активной перевозке сейчас машина или водитель — номер первой из них. */
  private async busy(what: 'vehicle' | 'driver', ids: string[]): Promise<Map<string, string>> {
    const col = what === 'vehicle' ? shipment.vehicleId : shipment.driverPersonId
    const rows = await this.db
      .select({ id: col, erpRef: shipment.erpRef })
      .from(shipment)
      .where(and(inArray(col, ids), inArray(shipment.state, [...ACTIVE_STATES])))
      .orderBy(shipment.turnSince)
    const out = new Map<string, string>()
    for (const r of rows) if (r.id && !out.has(r.id)) out.set(r.id, r.erpRef)
    return out
  }

  // ---------- файлы накладной ----------

  /** XML подписанных частей накладной и файлы подписей; ссылки на них подписывает FileSigner. */
  async files(scope: Scope, shipmentId: string): Promise<(Omit<FileLink, 'url'> & { kind: 'title' | 'signature'; id: string })[]> {
    if (!isUuid(shipmentId)) return []
    const [s] = await this.db.select({ id: shipment.id }).from(shipment).where(and(eq(shipment.id, shipmentId), visibleTo(this.db, scope)))
    if (!s) return []
    const titles = await this.db.select({ id: title.id, kind: title.kind, idFile: title.idFile }).from(title).where(eq(title.shipmentId, shipmentId)).orderBy(title.kind)
    const sigs = await this.db
      .select({ id: signature.id, titleKind: signature.titleKind, role: signature.role, hasCms: sql<boolean>`${signature.cms} is not null` })
      .from(signature)
      .where(eq(signature.shipmentId, shipmentId))
      .orderBy(signature.createdAt)
    const NAME = { T1: 'отгрузка', T2: 'приём груза', T3: 'приёмка', T4: 'сдача груза' } as const
    const out: (Omit<FileLink, 'url'> & { kind: 'title' | 'signature'; id: string })[] = []
    for (const t of titles) {
      const own = sigs.filter((g) => g.titleKind === t.kind)
      // Часть без подписей — ещё заготовка: не показываем
      if (!own.length) continue
      out.push({ label: `${NAME[t.kind]}, XML по формату ФНС`, name: `${t.idFile}.xml`, kind: 'title', id: t.id })
      for (const g of own.filter((x) => x.hasCms)) {
        out.push({ label: `${NAME[t.kind]}, подпись: ${ROLE_TITLE[g.role].toLowerCase()}`, name: `${t.idFile}.${g.role}.sig`, kind: 'signature', id: g.id })
      }
    }
    return out
  }

  /** Байты файла по подписанной ссылке — только из той перевозки, на которую ссылка выдана. */
  async fileBytes(shipmentId: string, kind: 'title' | 'signature', id: string): Promise<{ bytes: Uint8Array; type: string } | null> {
    if (!isUuid(id) || !isUuid(shipmentId)) return null
    if (kind === 'title') {
      const [t] = await this.db.select().from(title).where(and(eq(title.id, id), eq(title.shipmentId, shipmentId)))
      return t ? { bytes: new Uint8Array(t.xml), type: 'application/xml; charset=windows-1251' } : null
    }
    const [g] = await this.db.select().from(signature).where(and(eq(signature.id, id), eq(signature.shipmentId, shipmentId)))
    return g?.cms ? { bytes: new Uint8Array(g.cms), type: 'application/pkcs7-signature' } : null
  }

  // ---------- компания ----------

  /** Компания роли: реквизиты, своя доверенность, люди компании в этой роли. */
  async company(scope: Scope): Promise<Company | null> {
    const [row] = await this.db
      .select({ m: membership, o: org })
      .from(membership)
      .innerJoin(org, eq(org.id, membership.orgId))
      .where(and(eq(membership.personId, scope.personId), eq(membership.role, scope.role), isNotNull(membership.orgId)))
      .orderBy(membership.createdAt)
      .limit(1)
    if (!row) return null
    const { m, o } = row
    const people =
      scope.role === 'driver'
        ? []
        : await this.db
            .select({ id: person.id, name: person.name, isAdmin: membership.isAdmin })
            .from(membership)
            .innerJoin(person, eq(person.id, membership.personId))
            .where(and(eq(membership.orgId, o.id), eq(membership.role, scope.role)))
            .orderBy(sql`${membership.isAdmin} desc`, membership.createdAt)
    return {
      role: scope.role,
      name: o.name,
      inn: o.inn,
      kpp: o.kpp,
      address: o.address,
      verified: o.verified,
      signerKind: m.signerKind ?? null,
      poa: await this.poaOf(m),
      employees: people.map((x) => ({ name: x.name, isAdmin: x.isAdmin, isMe: x.id === scope.personId })),
    }
  }

  /** Текущая МЧД роли; записанная до HAKATON-49 — только номер и срок из membership. */
  private async poaOf(m: typeof membership.$inferSelect): Promise<Company['poa']> {
    const [p] = await this.db
      .select()
      .from(poa)
      .where(and(eq(poa.membershipId, m.id), isNull(poa.replacedAt)))
      .orderBy(desc(poa.createdAt))
      .limit(1)
    if (p) return { number: p.number, issuedAt: p.issuedAt.toISOString(), validTo: p.validTo.toISOString(), source: p.source, signatureOk: p.signatureOk }
    return m.poaNumber && m.poaValidTo ? { number: m.poaNumber, issuedAt: null, validTo: m.poaValidTo.toISOString(), source: 'legacy', signatureOk: null } : null
  }

  private async orgs(ids: (string | null)[]): Promise<OrgRow[]> {
    const list = [...new Set(ids.filter((x): x is string => Boolean(x)))]
    return list.length ? this.db.select().from(org).where(inArray(org.id, list)) : []
  }
}
