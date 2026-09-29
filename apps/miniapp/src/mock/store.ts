import QRCode from 'qrcode'
import type {
  Command,
  Company,
  DataSource,
  Driver,
  FileLink,
  ListQuery,
  Me,
  Notice,
  OrgBrief,
  Ownership,
  Role,
  ShipEvent,
  Shipment,
  SignatureKind,
  State,
  TitleKind,
  Vehicle,
  VehicleInput,
} from '../model.ts'
import { ROLE_TITLE } from '../texts.ts'
import { listView } from '../list.ts'
import { SEED } from './seed.ts'

// Мок источника данных для макета: перевозки живут в памяти и ходят по тем же состояниям, что ядро
// (packages/domain/src/machine.ts). Шаги других участников и оператора ЭПД (модель) случаются сами
// через пару секунд — так видно живое обновление экрана.

const ME_NAME = 'Проверяющий'
const MY_CARRIER = 'car-1'
const MY_CONSIGNEE = 'cp-001'
const MY_DRIVER = 'drv-me'
const SHIPPER_ORG: OrgBrief = { id: 'org-shipper', name: SEED.shipper.name, inn: SEED.shipper.inn }

const TURN: Record<State, Role | null> = {
  draft: 'shipper',
  offered: 'carrier',
  carrier_accepted: 'carrier',
  assigned: 'driver',
  trip_accepted: 'driver',
  loading: 'driver',
  loaded: 'shipper',
  t1_signed: 'carrier',
  registering: null,
  in_transit: 'driver',
  unloading: 'driver',
  receiving: 'consignee',
  received: 'consignee',
  t3_signed: 'carrier',
  closed: null,
  cancelled: null,
}

const ORDER: State[] = ['draft', 'offered', 'carrier_accepted', 'assigned', 'trip_accepted', 'loading', 'loaded', 't1_signed', 'registering', 'in_transit', 'unloading', 'receiving', 'received', 't3_signed', 'closed']
const reached = (s: State, from: State) => s !== 'cancelled' && ORDER.indexOf(s) >= ORDER.indexOf(from)

type Actor = { name: string; role: Role | 'erp' | 'operator'; me: boolean }

const DAY = 86_400_000
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())

/** Где перевозка стоит в начале показа: у каждой роли есть что ждать, что вести и что закрыто. */
const START: Record<string, { state: State; carrierId?: string | null; driverId?: string | null; vehicleId?: string | null; consigneeId?: string; discrepancy?: boolean }> = {
  'ОТГ-2026-1040': { state: 'draft', carrierId: null, driverId: null, vehicleId: null },
  'ОТГ-2026-1041': { state: 'offered', driverId: null, vehicleId: null },
  'ОТГ-2026-1042': { state: 'offered', driverId: null, vehicleId: null },
  'ОТГ-2026-1043': { state: 'in_transit', consigneeId: MY_CONSIGNEE },
  'ОТГ-2026-1044': { state: 'loaded' },
  'ОТГ-2026-1045': { state: 't1_signed', vehicleId: 'veh-2' },
  'ОТГ-2026-1046': { state: 'in_transit', driverId: MY_DRIVER, vehicleId: 'veh-1' },
  'ОТГ-2026-1047': { state: 'closed', carrierId: MY_CARRIER, driverId: MY_DRIVER, vehicleId: 'veh-1', consigneeId: MY_CONSIGNEE },
  'ОТГ-2026-1048': { state: 'closed', discrepancy: true },
  'ОТГ-2026-1049': { state: 'trip_accepted' },
  'ОТГ-2026-1050': { state: 'assigned', driverId: MY_DRIVER, vehicleId: 'veh-1' },
  'ОТГ-2026-1051': { state: 'carrier_accepted', driverId: null, vehicleId: null },
  'ОТГ-2026-1052': { state: 'draft', carrierId: null, driverId: null, vehicleId: null },
  'ОТГ-2026-1053': { state: 'draft', carrierId: null, driverId: null, vehicleId: null },
  'ОТГ-2026-1054': { state: 'draft', carrierId: null, driverId: null, vehicleId: null },
  'ОТГ-2026-1056': { state: 'receiving', carrierId: MY_CARRIER, driverId: 'drv-2', vehicleId: 'veh-2' },
  'ОТГ-2026-1057': { state: 'cancelled', carrierId: null, driverId: null, vehicleId: null },
}

interface World {
  shipments: Shipment[]
  vehicles: (Vehicle & { carrierId: string })[]
  drivers: { id: string; name: string; carrierId: string }[]
  activeRole: Role
  readAt: number
  companies: Record<Role, Company>
  seq: number
}

export class MockData implements DataSource {
  readonly features = { invite: true, photos: true, addDriver: true }
  private w!: World
  private listeners = new Set<(e: ShipEvent | null) => void>()
  private timers: ReturnType<typeof setTimeout>[] = []

  constructor() {
    this.reset(false)
  }

  // ---------- демо-пульт ----------

  reset(notify = true) {
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
    const shift = startOfDay(new Date()).getTime() - startOfDay(new Date('2026-09-23T12:00:00+03:00')).getTime()
    const counterparties = new Map<string, (typeof SEED.counterparties)[number]>(SEED.counterparties.map((c) => [c.id, c]))
    const carriers = new Map<string, (typeof SEED.carriers)[number]>(SEED.carriers.map((c) => [c.id, c]))
    const drivers = [...SEED.drivers.map((d) => ({ id: d.id, name: d.name, carrierId: d.carrierId })), { id: MY_DRIVER, name: ME_NAME, carrierId: MY_CARRIER }]
    const own: Record<string, Ownership> = { собственность: 'own', лизинг: 'lease', аренда: 'rent' }
    this.w = {
      shipments: [],
      vehicles: [
        ...SEED.vehicles.map((v) => ({ id: v.id, plate: v.plate, brand: v.brand, ownership: own[v.ownership] ?? 'other', ownerName: null, bodyType: 'Тентованный', capacityT: 20, volumeM3: 82, carrierId: v.carrierId, busyWith: null })),
        // свободная машина перевозчика, чтобы ОТГ-2026-1040 было на чём везти
        { id: 'veh-free', plate: 'Р318ТК116', brand: 'ГАЗон Next', ownership: 'own' as Ownership, ownerName: null, bodyType: 'Тентованный', capacityT: 5, volumeM3: 30, carrierId: MY_CARRIER, busyWith: null },
      ],
      drivers,
      activeRole: 'shipper',
      readAt: Date.now() - 30 * 60_000,
      companies: companies(),
      seq: 0,
    }
    // Историю каждой перевозки проигрываем теми же переходами, что и живые нажатия, с временем в прошлом
    const now = Date.now()
    SEED.shipments.forEach((s, i) => {
      const start = START[s.erpRef] ?? { state: 'draft' as State }
      const cp = counterparties.get(start.consigneeId ?? s.consigneeId)!
      const planned = new Date(new Date(s.plannedLoadingAt).getTime() + shift)
      const carrierId = start.carrierId === undefined ? s.carrierId : start.carrierId
      const sh: Shipment = {
        id: s.id,
        erpRef: s.erpRef,
        state: 'draft',
        turn: 'shipper',
        turnSince: new Date(now - (6 + i) * 3600_000).toISOString(),
        shipper: SHIPPER_ORG,
        carrier: null,
        consignee: { id: cp.id, name: cp.name, inn: cp.inn },
        driver: null,
        vehicle: null,
        loadingAddress: `${SEED.shipper.address}, ${SEED.shipper.loading_point}`,
        unloadingAddress: cp.address,
        plannedLoadingAt: planned.toISOString(),
        cargo: { lines: s.lines.map((l) => ({ ...l })), places: s.places, grossKg: s.grossKg },
        loadingRemarks: null,
        acceptance: null,
        declineReason: null,
        uid: null,
        titles: [],
        events: [],
        canAct: true,
        handledBy: null,
      }
      this.w.shipments.push(sh)
      const target = start.state
      let t = now - (target === 'closed' ? 3 * DAY : 5 * 3600_000) - i * 600_000
      const tick = () => (t += 17 * 60_000)
      this.event(sh, { name: 'учётная система завода', role: 'erp', me: false }, 'Отгрузка пришла из учётной системы', t)
      if (target === 'cancelled') {
        this.apply(sh, { type: 'shipper.cancel' }, this.other(sh, 'shipper'), tick())
        return
      }
      const carrier = carrierId ? carriers.get(carrierId) : null
      const driverId = start.driverId === undefined ? s.driverId : start.driverId
      const vehicleId = start.vehicleId === undefined ? s.vehicleId : start.vehicleId
      const path: Command[] = []
      if (carrier) path.push({ type: 'shipper.offerCarrier', carrierId: carrier.id })
      path.push({ type: 'carrier.accept' })
      if (vehicleId && driverId) path.push({ type: 'carrier.assign', vehicleId, driverId })
      const lines = sh.cargo.lines
      path.push(
        { type: 'driver.acceptTrip' },
        { type: 'driver.arrivedLoading' },
        { type: 'driver.confirmLoading', remarks: null },
        { type: 'shipper.signT1' },
        { type: 'carrier.signT2' },
      )
      for (const cmd of path) {
        if (sh.state === target) break
        const role = cmd.type.split('.')[0] as Role
        this.apply(sh, cmd, this.other(sh, role), tick(), false)
        if (sh.state === 'registering') this.operatorRegister(sh, tick(), false)
      }
      if (reached(target, 'unloading') && sh.state !== target) {
        this.apply(sh, { type: 'driver.arrivedUnloading' }, this.other(sh, 'driver'), tick(), false)
      }
      if (reached(target, 'receiving') && sh.state !== target) {
        this.apply(sh, { type: 'driver.confirmDelivered' }, this.other(sh, 'driver'), tick(), false)
      }
      if (reached(target, 'received') && sh.state !== target) {
        const discrepancy = start.discrepancy
        const accLines = lines.map((l, k) => ({ sku: l.sku, qty: discrepancy && k === 0 ? l.qty - 2 : l.qty, grossKg: discrepancy && k === 0 ? Math.round((l.grossKg * (l.qty - 2)) / l.qty) : l.grossKg, reason: discrepancy && k === 0 ? ('damage' as const) : null, photos: [] }))
        this.apply(sh, { type: 'consignee.recordAcceptance', acceptance: { result: discrepancy ? 'partial' : 'full', lines: accLines, comment: discrepancy ? 'Две канистры с подтёками, приняты не будут' : null } }, this.other(sh, 'consignee'), tick(), false)
      }
      if (reached(target, 't3_signed') && sh.state !== target) this.apply(sh, { type: 'consignee.signT3' }, this.other(sh, 'consignee'), tick(), false)
      if (reached(target, 'closed') && sh.state !== target) this.apply(sh, { type: 'carrier.signT4' }, this.other(sh, 'carrier'), tick(), false)
      sh.turnSince = new Date(Math.min(t, now - (i + 1) * 7 * 60_000)).toISOString()
    })
    // ОТГ-2026-1040 — начало сценария показа: ждёт дольше всех и стоит первой в «Ждут меня»
    const hero = this.w.shipments.find((x) => x.erpRef === 'ОТГ-2026-1040')
    if (hero) hero.turnSince = new Date(now - 9 * 3600_000).toISOString()
    this.recountBusy()
    if (notify) this.emit(null)
  }

  /** Новая отгрузка из учётной системы: появляется у отправителя в «Ждут меня». */
  newErpShipment() {
    const n = this.w.shipments.length
    const cp = SEED.counterparties[(n * 7) % SEED.counterparties.length]!
    const base = SEED.shipments[n % SEED.shipments.length]!
    const ref = `ОТГ-2026-${1058 + n - SEED.shipments.length}`
    const sh: Shipment = {
      ...structuredClone(this.w.shipments[0]!),
      id: `shp-new-${n}`,
      erpRef: ref,
      state: 'draft',
      turn: 'shipper',
      turnSince: new Date().toISOString(),
      carrier: null,
      driver: null,
      vehicle: null,
      consignee: { id: cp.id, name: cp.name, inn: cp.inn },
      unloadingAddress: cp.address,
      plannedLoadingAt: new Date(startOfDay(new Date()).getTime() + DAY + 10 * 3600_000).toISOString(),
      cargo: { lines: base.lines.map((l) => ({ ...l })), places: base.places, grossKg: base.grossKg },
      loadingRemarks: null,
      acceptance: null,
      declineReason: null,
      uid: null,
      titles: [],
      events: [],
      canAct: true,
      handledBy: null,
    }
    this.w.shipments.unshift(sh)
    this.event(sh, { name: 'учётная система завода', role: 'erp', me: false }, 'Отгрузка пришла из учётной системы', Date.now(), 'shipper')
  }

  // ---------- DataSource ----------

  async me(): Promise<Me> {
    const roles: Role[] = ['shipper', 'carrier', 'driver', 'consignee']
    return {
      name: ME_NAME,
      activeRole: this.w.activeRole,
      roles: roles.map((role) => ({
        role,
        title: ROLE_TITLE[role],
        orgName: role === 'driver' ? SEED.carriers[0]!.name : this.w.companies[role].name,
        waiting: this.visible(role).filter((s) => s.turn === role && this.isMine(s, role)).length,
      })),
    }
  }

  async setRole(role: Role) {
    this.w.activeRole = role
    this.emit(null)
    return this.me()
  }

  async list(q: ListQuery) {
    const role = this.w.activeRole
    return listView(this.visible(role).map((s) => this.view(s, role)), role, q)
  }

  async shipment(id: string) {
    return this.view(this.get(id), this.w.activeRole)
  }

  /** Копия для роли: в макете человек ведёт всё, что видит в своей роли. */
  private view(sh: Shipment, role: Role): Shipment {
    return { ...structuredClone(sh), canAct: this.isMine(sh, role), handledBy: null }
  }

  async execute(id: string, cmd: Command) {
    const sh = this.get(id)
    const role = cmd.type.split('.')[0] as Role
    if (sh.turn !== role) throw new Error('Сейчас ход другого участника — экран обновлён')
    this.apply(sh, cmd, { name: ME_NAME, role, me: true }, Date.now())
    this.recountBusy()
    this.after(sh)
    return this.view(sh, role)
  }

  async carriers() {
    return SEED.carriers.map((c) => ({ id: c.id, name: c.name, inn: c.inn }))
  }

  async vehicles(): Promise<Vehicle[]> {
    return this.w.vehicles.filter((v) => v.carrierId === MY_CARRIER).map(({ carrierId: _, ...v }) => ({ ...v }))
  }

  async saveVehicle(v: VehicleInput) {
    const plate = v.plate.toUpperCase().replace(/\s+/g, '')
    if (!/^[АВЕКМНОРСТУХ]\d{3}[АВЕКМНОРСТУХ]{2}\d{2,3}$/.test(plate)) throw new Error('Госномер в формате А245КМ116: буквы кириллицей, без пробелов')
    const dup = this.w.vehicles.find((x) => x.plate === plate && x.id !== v.id && x.carrierId === MY_CARRIER)
    if (dup) throw new Error('Такая машина уже есть в списке')
    const data = { plate, brand: v.brand.trim(), ownership: v.ownership, ownerName: v.ownerName, bodyType: v.bodyType, capacityT: v.capacityT, volumeM3: v.volumeM3 }
    const existing = v.id ? this.w.vehicles.find((x) => x.id === v.id) : null
    if (existing) Object.assign(existing, data)
    else this.w.vehicles.push({ id: `veh-${Date.now()}`, ...data, carrierId: MY_CARRIER, busyWith: null })
    this.emit(null)
    return this.vehicles()
  }

  async drivers(): Promise<Driver[]> {
    return this.w.drivers
      .filter((d) => d.carrierId === MY_CARRIER)
      .map((d) => ({ id: d.id, name: d.id === MY_DRIVER ? `${ME_NAME} (вы)` : d.name, isMe: d.id === MY_DRIVER, busyWith: this.activeFor((s) => s.driver?.id === d.id) }))
  }

  async company() {
    return structuredClone(this.w.companies[this.w.activeRole])
  }

  async saveCompany(patch: { name?: string; address?: string; signerKind?: 'head' | 'employee'; poa?: { number: string; issuedAt: string; validTo: string } }) {
    const c = this.w.companies[this.w.activeRole]
    if ((patch.name || patch.address) && c.verified) throw new Error('Реквизиты из справочника не правятся вручную')
    if (patch.name) c.name = patch.name.trim()
    if (patch.address) c.address = patch.address.trim()
    if (patch.signerKind) c.signerKind = patch.signerKind
    if (patch.poa) {
      // те же проверки, что на сервере (apps/app/src/core/poa.ts → addManual)
      const number = patch.poa.number.trim().toLowerCase()
      if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/.test(number)) throw new Error('Номер доверенности из реестра ФНС выглядит так: 4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f')
      if (new Date(patch.poa.issuedAt).getTime() > Date.now()) throw new Error('Дата выдачи ещё не наступила')
      if (new Date(patch.poa.validTo).getTime() < startOfDay(new Date()).getTime()) throw new Error('Доверенность уже истекла — укажите действующую')
      c.poa = { number, issuedAt: patch.poa.issuedAt, validTo: patch.poa.validTo, source: 'manual', signatureOk: null }
      c.signerKind = 'employee'
    }
    this.emit(null)
    return structuredClone(c)
  }

  async invite() {
    const r = this.w.activeRole
    return `https://max.ru/t397_hakaton_max_bot?start=inv_${r}_${Math.random().toString(36).slice(2, 10)}`
  }

  /** Раздел событий текущей роли: у каждой роли свои перевозки — и свои события. */
  async notices(): Promise<Notice[]> {
    const mine = new Set(this.visible(this.w.activeRole).map((s) => s.id))
    return this.w.shipments
      .filter((s) => mine.has(s.id))
      .flatMap((s) => s.events)
      .filter((e) => !e.mine)
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 60)
      .map((event) => ({ event, read: new Date(event.at).getTime() <= this.w.readAt }))
  }

  async markRead() {
    this.w.readAt = Date.now()
    this.emit(null)
  }

  /** Тот же QR, что выдаёт модель оператора ЭПД (core/qr-gif.ts), только без анимации. */
  async qr(id: string) {
    const sh = this.get(id)
    return QRCode.toDataURL(JSON.stringify({ uid: sh.uid, number: sh.erpRef, model: true }), { margin: 1, width: 640, errorCorrectionLevel: 'M' })
  }

  /** В макете файлов накладной нет: XML собирает сервер. */
  async files(): Promise<FileLink[]> {
    return []
  }

  subscribe(cb: (e: ShipEvent | null) => void) {
    this.listeners.add(cb)
    return () => void this.listeners.delete(cb)
  }

  // ---------- переходы ----------

  private apply(sh: Shipment, cmd: Command, who: Actor, at: number, live = true) {
    const carriers = SEED.carriers
    const say = (text: string, turnFor: Role | null = TURN[sh.state]) => this.event(sh, who, text, at, turnFor, live)
    const go = (state: State) => {
      sh.state = state
      sh.turn = TURN[state]
      sh.turnSince = new Date(at).toISOString()
    }
    switch (cmd.type) {
      case 'shipper.offerCarrier': {
        const c = carriers.find((x) => x.id === cmd.carrierId)!
        sh.carrier = { id: c.id, name: c.name, inn: c.inn }
        sh.declineReason = null
        go('offered')
        return say(`Заявка отправлена перевозчику ${c.name}`)
      }
      case 'shipper.cancel':
        go('cancelled')
        return say('Отгрузка отменена отправителем', null)
      case 'carrier.accept':
        go('carrier_accepted')
        return say('Перевозчик принял заявку')
      case 'carrier.decline':
        sh.declineReason = cmd.reason
        sh.carrier = null
        go('draft')
        return say(`Перевозчик отказался: ${cmd.reason}`)
      case 'carrier.assign': {
        const v = this.w.vehicles.find((x) => x.id === cmd.vehicleId)!
        const d = this.w.drivers.find((x) => x.id === cmd.driverId)!
        sh.vehicle = { id: v.id, plate: v.plate, brand: v.brand }
        sh.driver = { id: d.id, name: d.id === MY_DRIVER ? ME_NAME : d.name }
        go('assigned')
        return say(`Назначены машина ${v.plate} и водитель ${sh.driver.name}`)
      }
      case 'driver.acceptTrip':
        go('trip_accepted')
        return say('Водитель принял рейс и едет на погрузку')
      case 'driver.arrivedLoading':
        go('loading')
        return say('Водитель на погрузке')
      case 'driver.confirmLoading':
        sh.loadingRemarks = cmd.remarks
        this.sign(sh, 'T2', 'driver', 'pep_max', who, at)
        go('loaded')
        return say(cmd.remarks ? `Водитель принял груз с замечаниями${cmd.remarks.comment ? `: ${cmd.remarks.comment}` : ''}` : `Водитель принял груз: ${sh.cargo.places} мест, ${fmtKg(sh.cargo.grossKg)}`)
      case 'shipper.signT1':
        this.sign(sh, 'T1', 'shipper', who.me ? 'goskey' : 'demo_ca', who, at)
        go('t1_signed')
        return say('Отправитель подписал накладную')
      case 'carrier.signT2':
        this.sign(sh, 'T2', 'carrier', 'demo_ca', who, at)
        go('registering')
        return say('Перевозчик подписал приём груза, накладная ушла оператору ЭПД (модель)', null)
      case 'driver.arrivedUnloading':
        go('unloading')
        return say('Машина на выгрузке')
      case 'driver.confirmDelivered':
        this.sign(sh, 'T4', 'driver', 'pep_max', who, at)
        go('receiving')
        return say('Водитель сдал груз, идёт приёмка')
      case 'consignee.recordAcceptance': {
        sh.acceptance = cmd.acceptance
        go('received')
        const r = { full: 'принято без расхождений', partial: 'принято с расхождениями', refused: 'отказ от груза' }[cmd.acceptance.result]
        return say(`Получатель отметил приёмку: ${r}`)
      }
      case 'consignee.signT3':
        this.sign(sh, 'T3', 'consignee', 'goskey', who, at)
        go('t3_signed')
        return say('Получатель подписал приёмку «Госключом»')
      case 'carrier.signT4':
        this.sign(sh, 'T4', 'carrier', 'demo_ca', who, at)
        go('closed')
        say('Перевозчик подписал сдачу груза. Накладная закрыта', null)
        return this.event(sh, { name: 'учётная система завода', role: 'erp', me: false }, 'Статус «закрыта» и номер накладной ушли в учётную систему завода (модель)', at + 1000, null, live)
    }
  }

  private operatorRegister(sh: Shipment, at: number, live: boolean) {
    sh.uid = `ЭТрН-${sh.erpRef.slice(-4)}-${(sh.id.length * 7919 + at).toString(36).slice(-6).toUpperCase()}`
    sh.state = 'in_transit'
    sh.turn = 'driver'
    sh.turnSince = new Date(at).toISOString()
    const op = { name: 'оператор ЭПД (модель)', role: 'operator' as const, me: false }
    this.event(sh, op, `Накладная зарегистрирована в ГИС ЭПД (модель), номер ${sh.uid}`, at, null, live)
    this.event(sh, op, 'QR-код накладной отправлен водителю', at + 1000, 'driver', live)
  }

  /** Что происходит без вас: оператор регистрирует накладную, чужие перевозчики и водители делают свои шаги. */
  private after(sh: Shipment) {
    const later = (ms: number, fn: () => void) => this.timers.push(setTimeout(() => (fn(), this.recountBusy(), this.after(sh)), ms))
    if (sh.state === 'registering') return later(2500, () => this.operatorRegister(sh, Date.now(), true))
    const role = sh.turn
    if (!role || this.isMine(sh, role)) return
    const who = this.other(sh, role)
    const cmd: Command | null =
      sh.state === 'offered' ? { type: 'carrier.accept' }
      : sh.state === 'carrier_accepted' ? this.autoAssign(sh)
      : sh.state === 'assigned' ? { type: 'driver.acceptTrip' }
      : sh.state === 'trip_accepted' ? { type: 'driver.arrivedLoading' }
      : sh.state === 'loading' ? { type: 'driver.confirmLoading', remarks: null }
      : sh.state === 'in_transit' ? { type: 'driver.arrivedUnloading' }
      : sh.state === 'unloading' ? { type: 'driver.confirmDelivered' }
      : sh.state === 'receiving' ? { type: 'consignee.recordAcceptance', acceptance: { result: 'full', lines: sh.cargo.lines.map((l) => ({ sku: l.sku, qty: l.qty, grossKg: l.grossKg, reason: null, photos: [] })), comment: null } }
      : sh.state === 'received' ? { type: 'consignee.signT3' }
      : sh.state === 't3_signed' || sh.state === 't1_signed' ? { type: sh.state === 't1_signed' ? 'carrier.signT2' : 'carrier.signT4' }
      : null
    if (cmd) later(3000, () => this.apply(sh, cmd, who, Date.now()))
  }

  private autoAssign(sh: Shipment): Command | null {
    const v = this.w.vehicles.find((x) => x.carrierId === sh.carrier?.id)
    const d = this.w.drivers.find((x) => x.carrierId === sh.carrier?.id && x.id !== MY_DRIVER)
    return v && d ? { type: 'carrier.assign', vehicleId: v.id, driverId: d.id } : null
  }

  private sign(sh: Shipment, kind: TitleKind, role: Role, sig: SignatureKind, who: Actor, at: number) {
    let t = sh.titles.find((x) => x.kind === kind)
    if (!t) {
      t = { kind, signatures: [] }
      sh.titles.push(t)
      sh.titles.sort((a, b) => a.kind.localeCompare(b.kind))
    }
    t.signatures.push({ role, kind: sig, signerName: who.name, at: new Date(at).toISOString() })
  }

  private event(sh: Shipment, who: Actor, text: string, at: number, turnFor: Role | null = null, live = true) {
    const e: ShipEvent = { id: `e${++this.w.seq}`, at: new Date(at).toISOString(), shipmentId: sh.id, erpRef: sh.erpRef, text, actor: who.me ? `${ME_NAME}` : who.name, mine: who.me, turnFor }
    sh.events.unshift(e)
    if (live) this.emit(e)
  }

  private emit(e: ShipEvent | null) {
    for (const cb of this.listeners) cb(e)
  }

  // ---------- кто что видит ----------

  private isMine(sh: Shipment, role: Role) {
    if (role === 'shipper') return true
    if (role === 'carrier') return sh.carrier?.id === MY_CARRIER
    if (role === 'driver') return sh.driver?.id === MY_DRIVER
    return sh.consignee.id === MY_CONSIGNEE
  }

  private visible(role: Role) {
    return this.w.shipments.filter((s) => {
      if (!this.isMine(s, role)) return false
      if (role === 'carrier') return s.state !== 'draft'
      if (role === 'driver') return reached(s.state, 'assigned')
      if (role === 'consignee') return reached(s.state, 'registering')
      return true
    })
  }

  private other(sh: Shipment, role: Role): Actor {
    const name =
      role === 'shipper' ? 'Марина Соколова'
      : role === 'carrier' ? (SEED.carriers.find((c) => c.id === sh.carrier?.id)?.dispatcher ?? 'диспетчер перевозчика')
      : role === 'driver' ? (sh.driver?.name ?? 'водитель')
      : sh.consignee.id === MY_CONSIGNEE ? 'Дмитрий К.' : 'приёмщик получателя'
    return { name, role, me: false }
  }

  private activeFor(pred: (s: Shipment) => boolean) {
    return this.w.shipments.find((s) => pred(s) && reached(s.state, 'assigned') && s.state !== 'closed')?.erpRef ?? null
  }

  private recountBusy() {
    for (const v of this.w.vehicles) v.busyWith = this.activeFor((s) => s.vehicle?.id === v.id)
  }

  private get(id: string) {
    const sh = this.w.shipments.find((s) => s.id === id)
    if (!sh) throw new Error('Перевозка не найдена')
    return sh
  }
}

const fmtKg = (kg: number) => `${kg.toLocaleString('ru-RU')} кг`

function companies(): Record<Role, Company> {
  const car = SEED.carriers[0]!
  const vol = SEED.counterparties[0]!
  const soon = new Date(Date.now() + 5 * DAY).toISOString().slice(0, 10)
  return {
    shipper: {
      role: 'shipper',
      name: SEED.shipper.name,
      inn: SEED.shipper.inn,
      kpp: SEED.shipper.kpp,
      address: SEED.shipper.address,
      verified: true,
      signerKind: 'employee',
      poa: { number: '4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f', issuedAt: '2026-09-01', validTo: SEED.shipper.poaValidTo, source: 'file', signatureOk: true },
      employees: [
        { name: 'Марина Соколова', isAdmin: true, isMe: false },
        { name: 'Галина Фёдорова', isAdmin: false, isMe: false },
        { name: ME_NAME, isAdmin: false, isMe: true },
      ],
    },
    carrier: {
      role: 'carrier',
      name: car.name,
      inn: car.inn,
      kpp: car.kpp,
      address: car.address,
      verified: true,
      signerKind: 'employee',
      poa: { number: '9b2e7c41-3d5a-4f86-a1c0-6e8d2b4f7a13', issuedAt: '2025-10-05', validTo: soon, source: 'manual', signatureOk: null },
      employees: [
        { name: car.dispatcher, isAdmin: true, isMe: false },
        { name: ME_NAME, isAdmin: false, isMe: true },
      ],
    },
    driver: {
      role: 'driver',
      name: car.name,
      inn: car.inn,
      kpp: car.kpp,
      address: car.address,
      verified: true,
      signerKind: null,
      poa: null,
      employees: [],
    },
    consignee: {
      role: 'consignee',
      name: vol.name,
      inn: vol.inn,
      kpp: vol.kpp,
      address: vol.address,
      verified: false,
      signerKind: 'head',
      poa: null,
      employees: [
        { name: ME_NAME, isAdmin: true, isMe: true },
        { name: 'Дмитрий К.', isAdmin: false, isMe: false },
      ],
    },
  }
}
