import type { AcceptanceResult, Role, State, Turn } from './enums.ts'

// Команды ядра. Всё, что делают люди, оператор и учётная система, приходит в ядро
// одной из этих команд через execute(command, actor).
//
// Подписи создаются ДО команды: SignatureProvider собирает титул, получает подпись
// (демо-УЦ сразу, «Госключ» — когда человек перешлёт .sig), проверяет её и сохраняет.
// Команда несёт только id сохранённой подписи, execute проверяет, что она подходит.

/** Кого назначаем: найденного у нас человека или того, кого ещё нужно пригласить. */
export type PersonRef =
  | { personId: string }
  | {
      invite: {
        /** user_id из пересланного контакта (max_info), если контакт есть в MAX */
        expectedMaxUserId: number | null
        /** sha256 от нормализованного телефона из vCard; сам номер не храним */
        expectedPhoneSha256: string | null
        /** имя из контакта — только чтобы показать пригласившему */
        displayName: string | null
      }
    }

/**
 * Доказательства простой подписи нажатием кнопки в MAX.
 * Номер спрашиваем один раз, перед первой подписью человека (решение 24.09):
 * без подтверждённого номера бот сначала просит «Поделиться номером».
 */
export interface PepEvidence {
  maxUserId: number
  /** sha256 номера, подтверждённого кнопкой request_contact (hash проверен по токену бота) */
  phoneSha256: string
  callbackId: string
  messageMid: string
  buttonText: string
  at: string // ISO-время нажатия
}

export interface CommandPayloads {
  'shipper.offerCarrier': { carrier: PersonRef; carrierOrgId: string | null }
  'shipper.signT1': { signatureId: string }
  'shipper.cancel': { reason: string | null }

  'carrier.accept': Record<string, never>
  'carrier.decline': { reason: string }
  'carrier.assign': { vehicleId: string; driver: PersonRef }
  'carrier.signT2': { signatureId: string }
  'carrier.signT4': { signatureId: string }

  'driver.acceptTrip': Record<string, never>
  'driver.declineTrip': { reason: string }
  'driver.arrivedLoading': Record<string, never>
  'driver.confirmLoading': { remarks: string | null; evidence: PepEvidence }
  'driver.arrivedUnloading': Record<string, never>
  'driver.confirmDelivered': { remarks: string | null; evidence: PepEvidence }

  'consignee.recordAcceptance': { result: AcceptanceResult; discrepancies: string | null; evidence: PepEvidence }
  'consignee.signT3': { signatureId: string }

  'operator.registered': { operatorDocId: string; uid: string }
  'operator.rejected': { operatorDocId: string; code: string; message: string }
}

export type CommandType = keyof CommandPayloads

export type Command<T extends CommandType = CommandType> = T extends CommandType
  ? { type: T; shipmentId: string; payload: CommandPayloads[T] }
  : never

/** Кто выполняет команду. Роль человека берётся из participant, а не из кнопки. */
export type Actor =
  | { kind: 'person'; personId: string; role: Role }
  | { kind: 'operator' }
  | { kind: 'erp' }
  | { kind: 'timer' }
  | { kind: 'system' }

/** Кто вправе выполнить команду: роль человека или системный актёр. */
export type CommandSubject = Role | 'operator'

export interface Transition {
  command: CommandType
  from: readonly State[]
  by: CommandSubject
  to: State
}

const BEFORE_T1: readonly State[] = ['draft', 'offered', 'carrier_accepted', 'assigned', 'trip_accepted', 'loading', 'loaded']

/**
 * Таблица переходов — основной путь и ветки MVP.
 * Реализация решения (decide) и тесты — HAKATON-22.
 * Порядок строк — порядок кнопок в карточке: главное действие роли идёт первым.
 */
export const TRANSITIONS: readonly Transition[] = [
  { command: 'shipper.offerCarrier', from: ['draft'], by: 'shipper', to: 'offered' },
  { command: 'carrier.accept', from: ['offered'], by: 'carrier', to: 'carrier_accepted' },
  { command: 'carrier.decline', from: ['offered'], by: 'carrier', to: 'draft' },
  { command: 'carrier.assign', from: ['carrier_accepted'], by: 'carrier', to: 'assigned' },
  { command: 'driver.acceptTrip', from: ['assigned'], by: 'driver', to: 'trip_accepted' },
  { command: 'driver.declineTrip', from: ['assigned', 'trip_accepted'], by: 'driver', to: 'carrier_accepted' },
  { command: 'driver.arrivedLoading', from: ['trip_accepted'], by: 'driver', to: 'loading' },
  { command: 'driver.confirmLoading', from: ['loading'], by: 'driver', to: 'loaded' },
  { command: 'shipper.signT1', from: ['loaded'], by: 'shipper', to: 't1_signed' },
  { command: 'carrier.signT2', from: ['t1_signed'], by: 'carrier', to: 'registering' },
  { command: 'operator.registered', from: ['registering'], by: 'operator', to: 'in_transit' },
  { command: 'operator.rejected', from: ['registering'], by: 'operator', to: 't1_signed' },
  { command: 'driver.arrivedUnloading', from: ['in_transit'], by: 'driver', to: 'unloading' },
  { command: 'driver.confirmDelivered', from: ['unloading'], by: 'driver', to: 'receiving' },
  { command: 'consignee.recordAcceptance', from: ['receiving'], by: 'consignee', to: 'received' },
  { command: 'consignee.signT3', from: ['received'], by: 'consignee', to: 't3_signed' },
  { command: 'carrier.signT4', from: ['t3_signed'], by: 'carrier', to: 'closed' },
  { command: 'shipper.cancel', from: BEFORE_T1, by: 'shipper', to: 'cancelled' },
]

/** Чей ход в каждом состоянии. Хранится в shipment.turn, значение берём отсюда при переходе. */
export const TURN_BY_STATE: Readonly<Record<State, Turn>> = {
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

/** Какие команды роль может выполнить в этом состоянии — из них бот рисует кнопки. */
export function allowedCommands(state: State, role: Role): CommandType[] {
  return TRANSITIONS.filter((t) => t.by === role && t.from.includes(state)).map((t) => t.command)
}
