import { and, eq } from 'drizzle-orm'
import Fastify, { type FastifyInstance } from 'fastify'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Messenger, OutMessage, Role } from '@nk/domain'
import { MockDirectory } from '../adapters/mock-directory.ts'
import { MockErp } from '../adapters/mock-erp.ts'
import { openDb, readSeed } from '../db/boot.ts'
import { resetDemo } from '../db/seed.ts'
import { formDraft, mockErpShipment, participant, person, shipment, signature, title } from '../db/schema.ts'
import { ShipmentService } from '../core/shipments.ts'
import { InviteService } from '../core/invite-service.ts'
import { FleetService } from '../core/fleet.ts'
import { TitleService } from '../core/titles.ts'
import { SignatureService } from '../core/signatures.ts'
import { Bot } from '../bot/bot.ts'
import { BotStore } from '../bot/store.ts'
import { CardStore } from '../bot/card-store.ts'
import type { MaxUpdate } from '../max/types.ts'
import { signInitData } from './init-data.ts'
import { registerMiniAppApi } from './routes.ts'
import { MiniAppReader } from './reader.ts'
import { MiniAppActions } from './actions.ts'
import type { Shipment } from './view.ts'

// Мини-приложение на настоящей базе: у каждой роли — данные только своей организации.
// Нужна TEST_DATABASE_URL — база стирается.
const url = process.env.TEST_DATABASE_URL
const TOKEN = 'test-token'

class FakeMessenger implements Messenger {
  sent: { userId: number; m: OutMessage }[] = []
  private n = 0
  async send(userId: number, m: OutMessage) {
    this.sent.push({ userId, m })
    return { mid: `m${++this.n}` }
  }
  async edit() {}
  async delete() {}
  async answerCallback() {}
}

const A = { inn: '9782242514', name: 'ООО «Волжский завод моторных масел»' }
const L = { inn: '7702123454', name: 'ООО «Ложки-Картошки»' }
const C1 = { inn: '3603931407', name: 'ООО «ГрузЛайн-Казань»' }
const C2 = { inn: '8390825665', name: 'ООО «Челны-Транс»' }
const V = { inn: '1167049238', name: 'ООО «Волга»' }

/** Люди: max user_id → имя. */
const P = { marina: 101, larisa: 102, oleg: 103, rinat: 104, ivan: 105, petr: 106, dmitry: 107, ildar: 108 } as const

describe.skipIf(!url)('мини-приложение: у каждой роли — своя организация', () => {
  let conn: Awaited<ReturnType<typeof openDb>>
  let app: FastifyInstance
  let store: BotStore
  let bot: Bot
  const out = new FakeMessenger()
  const ids = {} as Record<'marina' | 'larisa' | 'oleg' | 'rinat' | 'ivan' | 'petr' | 'dmitry' | 'ildar' | 'c1' | 'c2' | 'v1' | 'v2' | 's1' | 's2' | 's3', string>
  const tokens = new Map<number, string>()

  const login = async (maxUserId: number) => {
    const cached = tokens.get(maxUserId)
    if (cached) return cached
    const initData = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: maxUserId, first_name: 'x' }) }, TOKEN)
    const res = await app.inject({ method: 'POST', url: '/api/session', payload: { initData } })
    const token = res.json().token as string
    tokens.set(maxUserId, token)
    return token
  }
  const get = async (who: number, path: string) => app.inject({ method: 'GET', url: `/api${path}`, headers: { authorization: `Bearer ${await login(who)}` } })
  const post = async (who: number, path: string, payload: unknown) =>
    app.inject({ method: 'POST', url: `/api${path}`, headers: { authorization: `Bearer ${await login(who)}` }, payload: payload as object })
  const list = async (who: number, role: Role) => {
    const res = await get(who, `/shipments?role=${role}`)
    expect(res.statusCode).toBe(200)
    return res.json() as Shipment[]
  }

  const person_ = async (maxUserId: number, name: string) => (await store.upsertPerson(maxUserId, name)).id
  const orgRole = async (personId: string, role: Role, o: { inn: string; name: string }) =>
    store.addRole({
      personId,
      role,
      org: { inn: o.inn, kpp: null, name: o.name, address: '420000, г. Казань, ул. Тестовая, д. 1', verified: o.inn !== L.inn, erpLinked: role === 'shipper', source: o.inn === L.inn ? 'manual' : 'demo', ogrn: null },
      canSign: true,
      poaNumber: null,
      poaValidTo: null,
    })

  beforeAll(async () => {
    conn = await openDb(url!)
    await resetDemo(conn.db, await readSeed())
    const db = conn.db
    store = new BotStore(db)
    const erp = new MockErp(db)
    const svc = new ShipmentService(db, erp, new MockDirectory(db))
    const titles = new TitleService(db)
    bot = new Bot(store, out, new MockDirectory(db), svc, new InviteService(db), new FleetService(db), out, new CardStore(db), { titles, signatures: new SignatureService(db), verifier: null, demo: null }, TOKEN, 'test_bot', pino({ level: 'silent' }))
    const actions = new MiniAppActions(db, svc, store, new FleetService(db), bot, null, pino({ level: 'silent' }))
    app = Fastify()
    registerMiniAppApi(app, { botToken: TOKEN, people: store, read: new MiniAppReader(db), actions: () => actions })

    // Люди и роли: две компании-отправителя, два перевозчика (у первого — коллега), водители, получатель
    ids.marina = await person_(P.marina, 'Марина Соколова')
    ids.larisa = await person_(P.larisa, 'Лариса Ложкина')
    ids.oleg = await person_(P.oleg, 'Олег Р.')
    ids.rinat = await person_(P.rinat, 'Ринат Ф.')
    ids.ivan = await person_(P.ivan, 'Иван Водителев')
    ids.petr = await person_(P.petr, 'Пётр Рулёв')
    ids.dmitry = await person_(P.dmitry, 'Дмитрий К.')
    ids.ildar = await person_(P.ildar, 'Ильдар Коллегин')
    await orgRole(ids.marina, 'shipper', A)
    await orgRole(ids.larisa, 'shipper', L)
    await orgRole(ids.oleg, 'carrier', C1)
    await orgRole(ids.rinat, 'carrier', C2)
    await orgRole(ids.dmitry, 'consignee', V)
    const c1 = (await store.orgByInn(C1.inn))!.id
    const c2 = (await store.orgByInn(C2.inn))!.id
    ids.c1 = c1
    ids.c2 = c2
    await store.addRoleForOrg(ids.ildar, 'carrier', c1, false)
    // У Ларисы две роли: отправитель «Ложки-Картошки» и перевозчик Челны-Транс (коллега Рината)
    await store.addRoleForOrg(ids.larisa, 'carrier', c2, false)
    for (const [p, org] of [[ids.ivan, c1], [ids.petr, c2]] as const) {
      await store.addRole({ personId: p, role: 'driver', org: null, canSign: false, poaNumber: null, poaValidTo: null })
      await store.ensureDriverOrg(p, org)
    }
    for (const p of [ids.rinat, ids.dmitry, ids.petr]) await store.savePhone(p, '+79170000000', 'hash')
    const fleet = new FleetService(db)
    ids.v1 = await fleet.upsertVehicle(c1, { plate: 'А111АА116', brand: 'КАМАЗ', ownership: 'own', ownerName: null, bodyType: 'Тентованный', capacityT: 20, volumeM3: 82 })
    ids.v2 = await fleet.upsertVehicle(c2, { plate: 'В222ВВ116', brand: 'МАН', ownership: 'own', ownerName: null, bodyType: 'Фургон', capacityT: 10, volumeM3: 40 })

    // Отгрузки «Ложки-Картошки» в учётке (модель): одна станет перевозкой, вторая ждёт
    const lk = (ref: string) => ({
      ref,
      shipperInn: L.inn,
      consigneeInn: V.inn,
      consigneeName: V.name,
      loadingAddress: '101000, г. Москва, ул. Ложечная, д. 2',
      unloadingAddress: '420000, г. Казань, ул. Волжская, д. 3',
      plannedLoadingAt: new Date(Date.now() + 86_400_000),
      lines: [{ sku: 'LK-1', name: 'Ложки деревянные', qty: 10, grossKg: 50, declaration: null }],
      places: 10,
      grossKg: 50,
    })
    await db.insert(mockErpShipment).values([lk('ЛК-2026-0001'), lk('ЛК-2026-0002')])

    const open = (personId: string, org: { inn: string }, ref: string) =>
      store.orgByInn(org.inn).then((o) => svc.openFromErp({ shipperOrgId: o!.id, shipperInn: org.inn, erpRef: ref, personId }))
    ids.s1 = await open(ids.marina, A, 'ОТГ-2026-1040') // Волжский → Волга, в пути
    ids.s2 = await open(ids.marina, A, 'ОТГ-2026-1041') // Волжский → Кама, заявка у Челны-Транс
    ids.s3 = await open(ids.larisa, L, 'ЛК-2026-0001') // Ложки → Волга, груз у водителя: получатель ещё не видит

    const set = (id: string, v: Partial<typeof shipment.$inferInsert>) => db.update(shipment).set(v).where(eq(shipment.id, id))
    const join = (id: string, role: Role, personId: string) =>
      db.insert(participant).values({ shipmentId: id, role, personId, source: 'known', joinedAt: new Date() }).onConflictDoNothing()
    await set(ids.s1, { state: 'in_transit', turn: 'driver', carrierOrgId: c1, vehicleId: ids.v1, driverPersonId: ids.ivan, uid: 'ЭТрН-ТЕСТ-1' })
    await join(ids.s1, 'carrier', ids.oleg)
    await join(ids.s1, 'driver', ids.ivan)
    await join(ids.s1, 'consignee', ids.dmitry)
    await set(ids.s2, { state: 'offered', turn: 'carrier', carrierOrgId: c2 })
    await join(ids.s2, 'carrier', ids.rinat)
    await set(ids.s3, { state: 'loaded', turn: 'shipper' })
  })

  afterAll(async () => {
    await conn?.pool.end()
  })

  it('отправитель видит перевозки и отгрузки только своей организации', async () => {
    const marina = await list(P.marina, 'shipper')
    expect(marina.map((s) => s.id)).toEqual(expect.arrayContaining([ids.s1, ids.s2]))
    expect(marina.every((s) => s.shipper.inn === A.inn)).toBe(true)
    expect(marina.some((s) => s.erpRef.startsWith('ЛК-'))).toBe(false)
    // 17 отгрузок учётки завода: две уже перевозки, 15 ждут в «новых»
    expect(marina.filter((s) => s.id.startsWith('erp:'))).toHaveLength(15)

    const larisa = await list(P.larisa, 'shipper')
    expect(larisa.map((s) => s.erpRef).sort()).toEqual(['ЛК-2026-0001', 'ЛК-2026-0002'])
    expect(larisa.every((s) => s.shipper.inn === L.inn && s.shipper.name === L.name)).toBe(true)
    expect(larisa.find((s) => s.erpRef === 'ЛК-2026-0002')?.id).toBe('erp:ЛК-2026-0002')
  })

  it('чужую перевозку не открыть даже по id, чужую отгрузку учётки — тоже', async () => {
    expect((await get(P.larisa, `/shipments/${ids.s1}?role=shipper`)).statusCode).toBe(404)
    expect((await get(P.marina, `/shipments/${ids.s3}?role=shipper`)).statusCode).toBe(404)
    expect((await get(P.larisa, `/shipments/${encodeURIComponent('erp:ОТГ-2026-1043')}?role=shipper`)).statusCode).toBe(404)
    // Чужая отгрузка учётки не превратилась в перевозку «Ложки-Картошки»
    const [ghost] = await conn.db.select().from(shipment).where(eq(shipment.erpRef, 'ОТГ-2026-1043'))
    expect(ghost).toBeUndefined()
    expect((await get(P.marina, '/shipments/not-a-uuid?role=shipper')).statusCode).toBe(404)
  })

  it('своя отгрузка учётки открывается карточкой и становится перевозкой', async () => {
    const res = await get(P.larisa, `/shipments/${encodeURIComponent('erp:ЛК-2026-0002')}?role=shipper`)
    expect(res.statusCode).toBe(200)
    const s = res.json() as Shipment
    expect(s.id).not.toMatch(/^erp:/)
    expect(s).toMatchObject({ erpRef: 'ЛК-2026-0002', state: 'draft', turn: 'shipper', canAct: true, shipper: { inn: L.inn } })
    expect(s.events.map((e) => e.text)).toContain('Отгрузка пришла из учётной системы')
  })

  it('роль — только своя: чужую не подставить', async () => {
    expect((await get(P.marina, '/shipments?role=carrier')).statusCode).toBe(403)
    expect((await get(P.marina, '/shipments')).statusCode).toBe(400)
    expect((await get(P.marina, '/fleet/vehicles')).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: '/api/shipments?role=shipper' })).statusCode).toBe(401)
  })

  it('перевозчик видит заявки своей компании, коллега — видит, но шаги делает тот, кто ведёт', async () => {
    const oleg = await list(P.oleg, 'carrier')
    expect(oleg.map((s) => s.id)).toEqual([ids.s1])
    expect(oleg[0]).toMatchObject({ canAct: true, handledBy: null, carrier: { inn: C1.inn } })
    expect((await get(P.oleg, `/shipments/${ids.s2}?role=carrier`)).statusCode).toBe(404)

    const rinat = await list(P.rinat, 'carrier')
    expect(rinat.map((s) => s.id)).toEqual([ids.s2])

    const ildar = await list(P.ildar, 'carrier')
    expect(ildar.map((s) => s.id)).toEqual([ids.s1])
    expect(ildar[0]).toMatchObject({ canAct: false, handledBy: 'Олег Р.' })
    const handoff = await post(P.ildar, `/shipments/${ids.s1}/handoff?role=carrier`, { handoff: { kind: 'card' } })
    expect(handoff.statusCode).toBe(403)
  })

  it('водитель видит только свои рейсы, получатель — только после регистрации накладной', async () => {
    expect((await list(P.ivan, 'driver')).map((s) => s.id)).toEqual([ids.s1])
    expect(await list(P.petr, 'driver')).toEqual([])

    const dmitry = await list(P.dmitry, 'consignee')
    expect(dmitry.map((s) => s.id)).toEqual([ids.s1])
    expect((await get(P.dmitry, `/shipments/${ids.s3}?role=consignee`)).statusCode).toBe(404)
  })

  it('компания, машины и водители — своей организации', async () => {
    const larisa = (await get(P.larisa, '/company?role=shipper')).json()
    expect(larisa).toMatchObject({ name: L.name, inn: L.inn, verified: false, employees: [{ name: 'Лариса Ложкина', isAdmin: true, isMe: true }] })
    const olegCo = (await get(P.oleg, '/company?role=carrier')).json()
    expect(olegCo.employees.map((e: { name: string }) => e.name)).toEqual(['Олег Р.', 'Ильдар Коллегин'])

    const olegCars = (await get(P.oleg, '/fleet/vehicles')).json()
    expect(olegCars.map((v: { plate: string }) => v.plate)).toEqual(['А111АА116'])
    expect(olegCars[0].busyWith).toBe('ОТГ-2026-1040')
    const rinatCars = (await get(P.rinat, '/fleet/vehicles')).json()
    expect(rinatCars.map((v: { plate: string }) => v.plate)).toEqual(['В222ВВ116'])
    expect((await get(P.oleg, '/fleet/drivers')).json().map((d: { name: string }) => d.name)).toEqual(['Иван Водителев'])
  })

  it('раздел событий — только по перевозкам своей роли, прочитанное — тоже по роли', async () => {
    const marina = (await get(P.marina, '/notices?role=shipper')).json() as { event: { erpRef: string } }[]
    expect(marina.length).toBeGreaterThan(0)
    expect(marina.some((n) => n.event.erpRef.startsWith('ЛК-'))).toBe(false)
    type N = { event: { erpRef: string }; read: boolean }
    const asShipper = (await get(P.larisa, '/notices?role=shipper')).json() as N[]
    expect(asShipper.length).toBeGreaterThan(0)
    expect(asShipper.every((n) => n.event.erpRef.startsWith('ЛК-'))).toBe(true)
    const asCarrier = (await get(P.larisa, '/notices?role=carrier')).json() as N[]
    expect(asCarrier.map((n) => n.event.erpRef)).toEqual(expect.arrayContaining(['ОТГ-2026-1041']))
    expect(asCarrier.every((n) => n.event.erpRef === 'ОТГ-2026-1041')).toBe(true)
    expect((await get(P.larisa, '/notices')).statusCode).toBe(400)

    await post(P.larisa, '/notices/read?role=carrier', {})
    expect(((await get(P.larisa, '/notices?role=carrier')).json() as N[]).every((n) => n.read)).toBe(true)
    expect(((await get(P.larisa, '/notices?role=shipper')).json() as N[]).some((n) => n.read)).toBe(false)
  })

  it('отказ перевозчика: причина — у отправителя, перевозчику перевозка больше не видна', async () => {
    const a = (await store.orgByInn(A.inn))!
    const id = await new ShipmentService(conn.db, new MockErp(conn.db), new MockDirectory(conn.db)).openFromErp({ shipperOrgId: a.id, shipperInn: A.inn, erpRef: 'ОТГ-2026-1042', personId: ids.marina })
    await conn.db.update(shipment).set({ state: 'offered', turn: 'carrier', carrierOrgId: ids.c2 }).where(eq(shipment.id, id))
    await conn.db.insert(participant).values({ shipmentId: id, role: 'carrier', personId: ids.rinat, source: 'known', joinedAt: new Date() })
    const res = await post(P.rinat, `/shipments/${id}/commands?role=carrier`, { command: { type: 'carrier.decline', reason: '  Нет свободных машин  ' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ chat: false, shipment: null })
    expect((await get(P.rinat, `/shipments/${id}?role=carrier`)).statusCode).toBe(404)
    const s = (await get(P.marina, `/shipments/${id}?role=shipper`)).json() as Shipment
    expect(s).toMatchObject({ state: 'draft', declineReason: 'Нет свободных машин', carrier: null })
    expect(out.sent.some((x) => x.userId === P.marina && /Нет свободных машин/.test(x.m.text))).toBe(true)
  })

  it('шаги без подписи — из приложения, через ядро; чужой шаг не сделать', async () => {
    // Олег не может принять заявку Челны-Транс
    expect((await post(P.oleg, `/shipments/${ids.s2}/commands?role=carrier`, { command: { type: 'carrier.accept' } })).statusCode).toBe(404)
    // Подпись — только в чате
    const sign = await post(P.rinat, `/shipments/${ids.s2}/commands?role=carrier`, { command: { type: 'carrier.signT2' } })
    expect(sign.json()).toMatchObject({ error: 'chat_only' })

    const accept = await post(P.rinat, `/shipments/${ids.s2}/commands?role=carrier`, { command: { type: 'carrier.accept' } })
    expect(accept.statusCode).toBe(200)
    expect(accept.json().shipment).toMatchObject({ state: 'carrier_accepted', turn: 'carrier' })

    // Чужая машина и чужой водитель не назначаются
    const foreign = await post(P.rinat, `/shipments/${ids.s2}/commands?role=carrier`, { command: { type: 'carrier.assign', vehicleId: ids.v1, driverId: ids.petr } })
    expect(foreign.statusCode).toBe(400)
    const wrongDriver = await post(P.rinat, `/shipments/${ids.s2}/commands?role=carrier`, { command: { type: 'carrier.assign', vehicleId: ids.v2, driverId: ids.ivan } })
    expect(wrongDriver.statusCode).toBe(400)

    const assign = await post(P.rinat, `/shipments/${ids.s2}/commands?role=carrier`, { command: { type: 'carrier.assign', vehicleId: ids.v2, driverId: ids.petr } })
    expect(assign.statusCode).toBe(200)
    expect(assign.json().shipment).toMatchObject({ state: 'assigned', driver: { name: 'Пётр Рулёв' }, vehicle: { plate: 'В222ВВ116' } })
    // Водителю ушло «ваш ход» от бота
    expect(out.sent.some((x) => x.userId === P.petr && /рейс/.test(x.m.text))).toBe(true)

    expect((await list(P.petr, 'driver')).map((s) => s.id)).toEqual([ids.s2])
    const trip = await post(P.petr, `/shipments/${ids.s2}/commands?role=driver`, { command: { type: 'driver.acceptTrip' } })
    expect(trip.json().shipment).toMatchObject({ state: 'trip_accepted' })
  })

  it('приёмка по позициям: черновик → кнопка в чате → простая подпись с этим текстом', async () => {
    await conn.db.update(shipment).set({ state: 'receiving', turn: 'consignee' }).where(eq(shipment.id, ids.s1))
    const s1 = (await get(P.dmitry, `/shipments/${ids.s1}?role=consignee`)).json() as Shipment
    const first = s1.cargo.lines[0]!
    const lines = s1.cargo.lines.map((l, i) => ({ sku: l.sku, qty: i === 0 ? l.qty - 2 : l.qty, grossKg: i === 0 ? l.grossKg - 37.6 : l.grossKg, reason: i === 0 ? 'damage' : null, photos: [] }))
    out.sent = []
    const res = await post(P.dmitry, `/shipments/${ids.s1}/handoff?role=consignee`, {
      handoff: { kind: 'acceptance', acceptance: { result: 'partial', lines, comment: 'Две канистры с подтёками' } },
    })
    expect(res.statusCode).toBe(200)
    const msg = out.sent.find((x) => x.userId === P.dmitry)!.m
    const button = msg.buttons!.flat().find((b) => b.text === 'Принято частично')!
    expect(button.payload).toBe(`pep:accept_partial:${ids.s1}`)
    expect(msg.text).toContain(`${first.name}: ${first.qty - 2} из ${first.qty} мест`)

    // Нажатие в чате — простая подпись; бот берёт текст из черновика и ничего не переспрашивает
    const press: MaxUpdate = {
      update_type: 'message_callback',
      timestamp: 0,
      callback: { timestamp: 0, callback_id: 'cb-accept', payload: button.payload, user: { user_id: P.dmitry, first_name: 'Дмитрий', is_bot: false } },
      message: { recipient: { chat_type: 'dialog' }, timestamp: 0, body: { mid: 'handoff-mid', seq: 0 } },
    }
    await bot.handle(press)
    const [row] = await conn.db.select().from(shipment).where(eq(shipment.id, ids.s1))
    expect(row!.state).toBe('received')
    expect(row!.acceptance).toMatchObject({ result: 'partial' })
    expect(row!.acceptance!.discrepancies).toContain('бой или повреждение')
    expect(row!.acceptance!.discrepancies).toContain('Две канистры с подтёками')
    const [pep] = await conn.db.select().from(signature).where(and(eq(signature.shipmentId, ids.s1), eq(signature.titleKind, 'T3')))
    expect(pep!.evidence).toMatchObject({ buttonText: 'Принято частично', messageMid: 'handoff-mid' })
    expect(await conn.db.select().from(formDraft).where(eq(formDraft.personId, ids.dmitry))).toEqual([])

    // Сверку по позициям видят все стороны перевозки
    for (const [who, role] of [[P.dmitry, 'consignee'], [P.marina, 'shipper'], [P.oleg, 'carrier']] as const) {
      const s = (await get(who, `/shipments/${ids.s1}?role=${role}`)).json() as Shipment
      expect(s.acceptance).toMatchObject({ result: 'partial', comment: 'Две канистры с подтёками' })
      expect(s.acceptance!.lines[0]).toMatchObject({ sku: first.sku, qty: first.qty - 2, reason: 'damage' })
    }
  })

  it('файлы накладной — по подписанной ссылке и только своей перевозки', async () => {
    const [t] = await conn.db
      .insert(title)
      .values({ shipmentId: ids.s1, kind: 'T1', idFile: 'ON_TRNACLGROT_TEST', xml: Buffer.from('<Файл/>'), sha256: 'x' })
      .returning()
    await conn.db.insert(signature).values({ shipmentId: ids.s1, titleKind: 'T1', titleId: t!.id, role: 'shipper', kind: 'goskey', signerPersonId: ids.marina, cms: Buffer.from('SIG'), verified: true })
    const files = (await get(P.marina, `/shipments/${ids.s1}/files?role=shipper`)).json() as { name: string; url: string }[]
    expect(files.map((f) => f.name)).toEqual(['ON_TRNACLGROT_TEST.xml', 'ON_TRNACLGROT_TEST.shipper.sig'])
    const xml = await app.inject({ method: 'GET', url: files[0]!.url })
    expect(xml.statusCode).toBe(200)
    expect(xml.headers['content-disposition']).toContain('ON_TRNACLGROT_TEST.xml')
    expect(xml.body).toBe('<Файл/>')
    const tampered = files[0]!.url.replace(/\.[^.]+$/, '.AAAA')
    expect((await app.inject({ method: 'GET', url: tampered })).statusCode).toBe(404)
    expect((await get(P.larisa, `/shipments/${ids.s1}/files?role=shipper`)).json()).toEqual([])
  })

  it('живое обновление: чужие шаги с прошлого раза, свои — нет', async () => {
    const since = new Date(Date.now() - 60_000).toISOString()
    const marina = (await get(P.marina, `/pulse?role=shipper&since=${encodeURIComponent(since)}`)).json() as { events: { erpRef: string; mine: boolean }[] }
    expect(marina.events.length).toBeGreaterThan(0)
    expect(marina.events.every((e) => !e.mine && !e.erpRef.startsWith('ЛК-'))).toBe(true)
    const rinat = (await get(P.rinat, `/pulse?role=carrier&since=${encodeURIComponent(since)}`)).json() as { events: { erpRef: string }[] }
    // Ринат не видит приёмку по чужой для него перевозке ОТГ-2026-1040
    expect(rinat.events.some((e) => e.erpRef === 'ОТГ-2026-1040')).toBe(false)
  })

  it('человек без ролей получает сессию, но экраны — только после подключения в чате', async () => {
    await store.upsertPerson(999, 'Новичок')
    const me = (await get(999, '/me')).json()
    expect(me).toMatchObject({ name: 'Новичок', activeRole: null, roles: [] })
    expect((await get(999, '/shipments?role=shipper')).statusCode).toBe(403)
    const [p] = await conn.db.select().from(person).where(eq(person.maxUserId, 999))
    expect(p).toBeTruthy()
  })
})
