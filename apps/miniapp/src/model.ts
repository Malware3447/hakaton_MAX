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
  /** сделал сам зритель: такие не всплывают и не попадают в раздел событий */
  mine: boolean
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
  /**
   * Зритель — участник перевозки в своей роли и может делать шаги. Коллега по компании видит
   * перевозку своей организации, но шаги делает тот, кто её ведёт (handledBy).
   */
  canAct: boolean
  /** кто ведёт перевозку в роли зрителя, если не он сам */
  handledBy: string | null
}

export interface Vehicle {
  id: string
  plate: string
  brand: string
  ownership: Ownership
  /** владелец при аренде и лизинге */
  ownerName: string | null
  /** для накладной: тип кузова, грузоподъёмность в тоннах, объём кузова в м³ */
  bodyType: string | null
  capacityT: number | null
  volumeM3: number | null
  /** в какой активной перевозке сейчас */
  busyWith: string | null
}

export type VehicleInput = Pick<Vehicle, 'plate' | 'brand' | 'ownership' | 'ownerName' | 'bodyType' | 'capacityT' | 'volumeM3'> & { id?: string }

/** Файл накладной для скачивания: XML части по формату ФНС или файл подписи. */
export interface FileLink {
  label: string
  name: string
  url: string
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
  /** кто подписывает за компанию (HAKATON-49): руководитель или ИП — сам, сотрудник — по МЧД; null — ещё не выбрали */
  signerKind: 'head' | 'employee' | null
  /** текущая МЧД: откуда она и что проверено */
  poa: {
    number: string
    issuedAt: string | null
    validTo: string
    /** file — прислан файл МЧД, manual — номер и даты руками, legacy — записано до проверки МЧД */
    source: 'file' | 'manual' | 'legacy'
    /** подпись руководителя под файлом: true — проверена, null — не присылали */
    signatureOk: boolean | null
  } | null
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

/**
 * Что уходит в чат на подпись или на простой шаг: приложение закрывается, бот присылает сообщение.
 * text и buttons — как это сообщение выглядит (макет рисует его окном), handoff — что попросить у сервера.
 */
export interface ChatStep {
  shipmentId: string
  text: string
  buttons: { label: string; command: Command; primary?: boolean }[]
  handoff: Handoff
}

export type Handoff =
  /** главный шаг роли: бот присылает карточку перевозки с кнопкой этого шага */
  | { kind: 'card' }
  /** замечания водителя по позициям: бот присылает их итог и кнопку простой подписи */
  | { kind: 'remarks'; remarks: { lines: LineCheck[]; comment: string | null } }
  /** приёмка по позициям: бот присылает итог и кнопку простой подписи */
  | { kind: 'acceptance'; acceptance: { result: AcceptanceResult; lines: LineCheck[]; comment: string | null } }
  /** новый водитель: бот просит переслать его контакт, машина уже выбрана */
  | { kind: 'driverContact'; vehicleId: string | null }

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
  /** что источник умеет: в продукте часть разделов пока делается только в чате */
  readonly features: {
    /** приглашение сотрудника в компанию ссылкой */
    invite: boolean
    /** фото повреждений при приёмке */
    photos: boolean
    /** добавить водителя вне рейса; в продукте водитель появляется при назначении на рейс */
    addDriver: boolean
  }
  me(): Promise<Me>
  setRole(role: Role): Promise<Me>
  list(q: ListQuery): Promise<{ items: Shipment[]; counts: Record<ListQuery['tab'], number> }>
  shipment(id: string): Promise<Shipment>
  /** null — после шага перевозка этой роли больше не видна (перевозчик отклонил заявку) */
  execute(shipmentId: string, cmd: Command): Promise<Shipment | null>
  /** шаг в чате: в продукте сервер просит бота прислать сообщение, и приложение закрывается; у макета метода нет — он рисует окно «чат с ботом» */
  toChat?(step: ChatStep): Promise<void>
  carriers(): Promise<OrgBrief[]>
  vehicles(): Promise<Vehicle[]>
  saveVehicle(v: VehicleInput): Promise<Vehicle[]>
  drivers(): Promise<Driver[]>
  company(): Promise<Company>
  saveCompany(patch: { name?: string; address?: string; signerKind?: 'head' | 'employee'; poa?: { number: string; issuedAt: string; validTo: string } }): Promise<Company>
  invite(): Promise<string>
  notices(): Promise<Notice[]>
  markRead(): Promise<void>
  /** картинка QR-кода накладной (src для img) */
  qr(shipmentId: string): Promise<string>
  /** XML частей накладной и файлы подписей для скачивания */
  files(shipmentId: string): Promise<FileLink[]>
  /** что-то поменялось: пересчитать экран. В продукте — опрос сервера, в макете — мок. */
  subscribe(cb: (e: ShipEvent | null) => void): () => void
}
