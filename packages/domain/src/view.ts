import type { CommandType } from './commands.ts'
import type { AcceptanceResult, ActorKind, Role, SignatureKind, State, TitleKind, Turn } from './enums.ts'

// Что видит роль в перевозке. Собирает ядро (HAKATON-24), рисует бот (HAKATON-28).
// Только данные и коды: человеческие тексты живут в слое бота, а не здесь.

export interface OrgBrief {
  id: string
  name: string
  inn: string
}

export interface PersonBrief {
  id: string
  name: string
}

export interface CargoLine {
  name: string
  qty: number
  grossKg: number
}

export interface TitleBrief {
  kind: TitleKind
  signatures: { role: Role; kind: SignatureKind; signerName: string | null; at: string }[]
}

export interface EventBrief {
  at: string
  type: string
  actorKind: ActorKind
  actorRole: Role | null
  actorName: string | null
  /** короткие данные события, например замечания водителя */
  data: Record<string, unknown>
}

export interface ShipmentView {
  id: string
  erpRef: string
  state: State
  turn: Turn
  turnSince: string
  /** роль того, для кого собран вид */
  viewerRole: Role
  /** команды, которые зритель может выполнить сейчас — это кнопки карточки */
  actions: CommandType[]

  shipper: OrgBrief
  carrier: OrgBrief | null
  consignee: OrgBrief
  driver: PersonBrief | null
  vehicle: { plate: string; brand: string } | null

  loadingAddress: string
  unloadingAddress: string
  plannedLoadingAt: string | null
  cargo: { lines: CargoLine[]; places: number; grossKg: number }

  loadingRemarks: string | null
  acceptance: { result: AcceptanceResult; discrepancies: string | null } | null
  uid: string | null
  titles: TitleBrief[]
  /** последние события для ленты; полная лента — отдельным запросом */
  recentEvents: EventBrief[]
}

/** Строка очереди «ждут вас»: перевозки, где ход за ролью человека, дольше ждущие первыми. */
export interface WaitingItem {
  shipmentId: string
  erpRef: string
  state: State
  role: Role
  turnSince: string
}
