import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MockDirectory } from '../adapters/mock-directory.ts'
import { MockErp } from '../adapters/mock-erp.ts'
import { openDb, readSeed } from '../db/boot.ts'
import { event, membership, org, participant, person } from '../db/schema.ts'
import { resetDemo } from '../db/seed.ts'
import { ShipmentService } from './shipments.ts'

// Ядро на настоящей базе. Нужна TEST_DATABASE_URL — база стирается.
const url = process.env.TEST_DATABASE_URL

describe.skipIf(!url)('ядро перевозки', () => {
  let conn: Awaited<ReturnType<typeof openDb>>
  let svc: ShipmentService
  let shipperId: string, carrierId: string, strangerId: string, shipperOrgId: string, carrierOrgId: string
  let shipmentId: string

  beforeAll(async () => {
    conn = await openDb(url!)
    await resetDemo(conn.db, await readSeed())
    const db = conn.db
    const dir = new MockDirectory(db)
    svc = new ShipmentService(db, new MockErp(db), dir)
    const [so] = await db.insert(org).values({ inn: '9782242514', name: 'Завод', address: 'Елабуга' }).returning()
    const [co] = await db.insert(org).values({ inn: '3603931407', name: 'ГрузЛайн', address: 'Казань' }).returning()
    shipperOrgId = so!.id
    carrierOrgId = co!.id
    const [a, b, c] = await db.insert(person).values([{ maxUserId: 101, name: 'Марина' }, { maxUserId: 102, name: 'Олег' }, { maxUserId: 103, name: 'Чужой' }]).returning()
    shipperId = a!.id
    carrierId = b!.id
    strangerId = c!.id
    await db.insert(membership).values([
      { personId: shipperId, role: 'shipper', orgId: shipperOrgId, isAdmin: true },
      { personId: carrierId, role: 'carrier', orgId: carrierOrgId, isAdmin: true },
    ])
  })
  afterAll(() => conn.pool.end())

  it('отгрузка из учётки становится черновиком, повторное открытие — та же перевозка', async () => {
    shipmentId = await svc.openFromErp({ shipperOrgId, shipperInn: '9782242514', erpRef: 'ОТГ-2026-1040', personId: shipperId })
    const again = await svc.openFromErp({ shipperOrgId, shipperInn: '9782242514', erpRef: 'ОТГ-2026-1040', personId: shipperId })
    expect(again).toBe(shipmentId)
    const v = await svc.view(shipmentId, 'shipper')
    expect(v).toMatchObject({ state: 'draft', turn: 'shipper', consignee: { name: 'ООО «Волга»' }, actions: ['shipper.offerCarrier', 'shipper.cancel'] })
    expect(v!.cargo).toMatchObject({ places: 86, grossKg: 2730 })
  })

  it('чужой человек не может выполнить команду', async () => {
    const r = await svc.execute(
      { type: 'shipper.offerCarrier', shipmentId, payload: { carrier: { personId: carrierId }, carrierOrgId } },
      { kind: 'person', personId: strangerId, role: 'shipper' },
    )
    expect(r).toMatchObject({ ok: false, code: 'not_participant' })
  })

  it('назначение перевозчика: переход, участник, очередь «ждут вас», журнал', async () => {
    const r = await svc.execute(
      { type: 'shipper.offerCarrier', shipmentId, payload: { carrier: { personId: carrierId }, carrierOrgId } },
      { kind: 'person', personId: shipperId, role: 'shipper' },
    )
    expect(r).toMatchObject({ ok: true, from: 'draft', to: 'offered', turn: 'carrier' })
    expect(await svc.participantOf(shipmentId, 'carrier')).toMatchObject({ personId: carrierId, maxUserId: 102 })
    expect((await svc.waiting(carrierId)).map((w) => w.erpRef)).toEqual(['ОТГ-2026-1040'])
    expect(await svc.waiting(shipperId)).toEqual([])
    expect((await svc.view(shipmentId, 'carrier'))!.carrier?.name).toBe('ГрузЛайн')
  })

  it('двойное нажатие «Принять» — второй раз «уже сделано», и это видно в журнале', async () => {
    const actor = { kind: 'person', personId: carrierId, role: 'carrier' } as const
    const first = await svc.execute({ type: 'carrier.accept', shipmentId, payload: {} }, actor)
    const second = await svc.execute({ type: 'carrier.accept', shipmentId, payload: {} }, actor)
    expect(first.ok).toBe(true)
    expect(second).toMatchObject({ ok: false, code: 'already_done' })
    const types = (await conn.db.select({ t: event.type }).from(event).where(eq(event.shipmentId, shipmentId)).orderBy(event.at)).map((r) => r.t)
    expect(types).toEqual(['shipment.created', 'command.rejected', 'shipper.offerCarrier', 'carrier.accept', 'command.rejected'])
  })

  it('незнакомого перевозчика приглашаем: токен один раз, в базе только хеш и ожидаемый user_id', async () => {
    const id = await svc.openFromErp({ shipperOrgId, shipperInn: '9782242514', erpRef: 'ОТГ-2026-1041', personId: shipperId })
    const r = await svc.execute(
      { type: 'shipper.offerCarrier', shipmentId: id, payload: { carrier: { invite: { expectedMaxUserId: 555, expectedPhoneSha256: null, displayName: 'Новый' } }, carrierOrgId: null } },
      { kind: 'person', personId: shipperId, role: 'shipper' },
    )
    if (!r.ok) throw new Error(r.message)
    expect(r.invites).toHaveLength(1)
    const [p] = await conn.db.select().from(participant).where(and(eq(participant.shipmentId, id), eq(participant.role, 'carrier')))
    expect(p).toMatchObject({ personId: null, expectedMaxUserId: 555, inviteSingleUse: false })
    expect(p!.inviteTokenSha256).toHaveLength(64)
    expect(p!.inviteTokenSha256).not.toContain(r.invites[0]!.token)
  })

  it('отказ перевозчика снимает его с перевозки и возвращает ход отправителю', async () => {
    const id = await svc.openFromErp({ shipperOrgId, shipperInn: '9782242514', erpRef: 'ОТГ-2026-1043', personId: shipperId })
    await svc.execute({ type: 'shipper.offerCarrier', shipmentId: id, payload: { carrier: { personId: carrierId }, carrierOrgId } }, { kind: 'person', personId: shipperId, role: 'shipper' })
    const r = await svc.execute({ type: 'carrier.decline', shipmentId: id, payload: { reason: 'нет машин' } }, { kind: 'person', personId: carrierId, role: 'carrier' })
    expect(r).toMatchObject({ ok: true, to: 'draft', turn: 'shipper' })
    expect(await svc.participantOf(id, 'carrier')).toBeNull()
    expect((await svc.view(id, 'shipper'))!.carrier).toBeNull()
  })
})
