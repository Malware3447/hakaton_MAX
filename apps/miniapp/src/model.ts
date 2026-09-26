// Что рисуют экраны мини-приложения. Повторяет ShipmentView ядра (packages/domain/src/view.ts)
// и добавляет то, что нужно спискам, формам и разделу событий. Источник данных — DataSource:
// в продукте API сервера, в макете — мок в памяти (src/mock/store.ts).

export type Role = 'shipper' | 'carrier' | 'driver' | 'consignee'

export type State =
  | 'draft'
  | 'offered'
  | 'carrier_accepted'
  | 'assigned'
  | 'trip_accepted'
  | 'loading'
  | 'loaded'
  | 't1_signed'
  | 'registering'
  | 'in_transit'
  | 'unloading'
  | 'receiving'
  | 'received'
  | 't3_signed'
  | 'closed'
  | 'cancelled'

export type SignatureKind = 'pep_max' | 'goskey' | 'demo_ca'
export type TitleKind = 'T1' | 'T2' | 'T3' | 'T4'
export type Ownership = 'own' | 'lease' | 'rent' | 'other'
export type DiscrepancyReason = 'shortage' | 'damage' | 'mismatch' | 'surplus'
export type AcceptanceResult = 'full' | 'partial' | 'refused'

export interface OrgBrief {
  id: string
  name: string
  inn: string
}

export interface CargoLine {
  sku: string
  name: string
  qty: number
  grossKg: number
}

/** Что получатель или водитель отметил по позиции. */
export interface LineCheck {
  sku: string
  qty: number
  grossKg: number
  reason: DiscrepancyReason | null
  photos: string[]
}

export interface Signature {
  role: Role
  kind: SignatureKind
  signerName: string
  at: string
}

export interface TitleView {
  kind: TitleKind
  signatures: Signature[]
}

export interface ShipEvent {
  id: string
  at: string
  shipmentId: string
  erpRef: string
  text: string
  /** кто сделал: имя человека, «учётная система», «оператор ЭПД (модель)» */
  actor: string
  /** для чьей роли это «ваш ход» — тогда событие попадает в раздел событий как важное */
  turnFor: Role | null
}

export interface Shipment {
  id: string
  erpRef: string
  state: State
  turn: Role | null
  turnSince: string
  shipper: OrgBrief
  carrier: OrgBrief | null
  consignee: OrgBrief
  driver: { id: string; name: string } | null
  vehicle: { id: string; plate: string; brand: string } | null
  loadingAddress: string
  unloadingAddress: string
  plannedLoadingAt: string
  cargo: { lines: CargoLine[]; places: number; grossKg: number }
  loadingRemarks: { lines: LineCheck[]; comment: string | null } | null
  acceptance: { result: AcceptanceResult; lines: LineCheck[]; comment: string | null } | null
  declineReason: string | null
  uid: string | null
  titles: TitleView[]
  events: ShipEvent[]
}

export interface Vehicle {
  id: string
  plate: string
  brand: string
  ownership: Ownership
  /** в какой активной перевозке сейчас */
  busyWith: string | null
}

export interface Driver {
  id: string
  name: string
  busyWith: string | null
  isMe: boolean
}

export interface Employee {
  name: string
  isAdmin: boolean
  isMe: boolean
}

export interface Company {
  role: Role
  name: string
  inn: string
  kpp: string | null
  address: string
  /** false — реквизиты введены руками: их можно править */
  verified: boolean
  poa: { number: string; validTo: string } | null
  employees: Employee[]
}

export interface RoleSummary {
  role: Role
  title: string
  orgName: string | null
  waiting: number
}

export interface Me {
  name: string
  activeRole: Role
  roles: RoleSummary[]
}

export interface Notice {
  event: ShipEvent
  read: boolean
}

/** Что уходит в чат на подпись или на простой шаг: приложение закрывается, бот присылает сообщение. */
export interface ChatStep {
  shipmentId: string
  text: string
  buttons: { label: string; command: Command; primary?: boolean }[]
}

export type Command =
  | { type: 'shipper.offerCarrier'; carrierId: string }
  | { type: 'shipper.signT1' }
  | { type: 'shipper.cancel' }
  | { type: 'carrier.accept' }
  | { type: 'carrier.decline'; reason: string }
  | { type: 'carrier.assign'; vehicleId: string; driverId: string }
  | { type: 'carrier.signT2' }
  | { type: 'carrier.signT4' }
  | { type: 'driver.acceptTrip' }
  | { type: 'driver.arrivedLoading' }
  | { type: 'driver.confirmLoading'; remarks: { lines: LineCheck[]; comment: string | null } | null }
  | { type: 'driver.arrivedUnloading' }
  | { type: 'driver.confirmDelivered' }
  | { type: 'consignee.recordAcceptance'; acceptance: { result: AcceptanceResult; lines: LineCheck[]; comment: string | null } }
  | { type: 'consignee.signT3' }

export interface ListQuery {
  tab: 'waiting' | 'active' | 'done'
  q: string
  states: StatusFilter[]
  date: DateFilter
  carrierIds: string[]
}

export type StatusFilter = 'new' | 'carrier' | 'loading' | 'transit' | 'receiving' | 'closed' | 'discrepancy'
export type DateFilter = 'all' | 'today' | 'tomorrow' | 'week'

export interface DataSource {
  me(): Promise<Me>
  setRole(role: Role): Promise<Me>
  list(q: ListQuery): Promise<{ items: Shipment[]; counts: Record<ListQuery['tab'], number> }>
  shipment(id: string): Promise<Shipment>
  execute(shipmentId: string, cmd: Command): Promise<Shipment>
  carriers(): Promise<OrgBrief[]>
  vehicles(): Promise<Vehicle[]>
  saveVehicle(v: { id?: string; plate: string; brand: string; ownership: Ownership }): Promise<Vehicle[]>
  drivers(): Promise<Driver[]>
  company(): Promise<Company>
  saveCompany(patch: { name?: string; address?: string; poa?: { number: string; validTo: string } }): Promise<Company>
  invite(): Promise<string>
  notices(): Promise<Notice[]>
  markRead(): Promise<void>
  /** что-то поменялось: пересчитать экран. В продукте — SSE или опрос, в макете — мок. */
  subscribe(cb: (e: ShipEvent | null) => void): () => void
}
