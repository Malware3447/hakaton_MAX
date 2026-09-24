import {
  TRANSITIONS,
  TURN_BY_STATE,
  type Actor,
  type Command,
  type CommandPayloads,
  type CommandType,
  type PepEvidence,
  type PersonRef,
  type Transition,
} from './commands.ts'
import type { AcceptanceResult, Role, State, TitleKind, Turn } from './enums.ts'

// Решение по команде: можно ли её выполнить и что из этого следует.
// Чистая функция без базы и сети. Ядро (HAKATON-24) до вызова проверяет то, что требует
// ввода-вывода: что человек — участник перевозки в этой роли и что подпись signatureId
// существует и подходит. После — применяет patch, пишет события и ставит effects в очередь.

/** То, что домену нужно знать о перевозке. */
export interface ShipmentSnapshot {
  state: State
  carrierOrgId: string | null
  vehicleId: string | null
  driverPersonId: string | null
  operatorDocId: string | null
}

/** Поля перевозки, которые меняет переход (кроме state и turn). undefined — не трогать. */
export interface ShipmentPatch {
  carrierOrgId?: string | null
  vehicleId?: string | null
  driverPersonId?: string | null
  loadingRemarks?: string | null
  acceptance?: { result: AcceptanceResult; discrepancies: string | null }
  uid?: string
}

/**
 * Последствия перехода, которые ядро ставит заданиями после коммита.
 * Сообщение «ваш ход» тому, чей ход, и перерисовка карточек идут после любого перехода
 * и здесь не перечисляются.
 */
export type Effect =
  | { kind: 'invite'; role: Role; ref: Extract<PersonRef, { invite: unknown }> }
  | { kind: 'recordPep'; title: TitleKind; role: Role; evidence: PepEvidence }
  | { kind: 'submitTitle'; title: TitleKind }
  | { kind: 'sendQrToDriver' }
  | { kind: 'inviteConsignee' }
  | { kind: 'erpWriteBack'; status: 'closed' | 'cancelled' }

export type DecisionErrorCode =
  | 'unknown_command'
  | 'wrong_actor' // команду выполняет не тот вид актёра (человек вместо оператора и наоборот)
  | 'wrong_role' // человек в роли, которой эта команда не положена
  | 'already_done' // перевозка уже в том состоянии, куда ведёт команда: повторное нажатие
  | 'wrong_state' // в этом состоянии команда недоступна
  | 'invalid_payload'

export type Decision =
  | { ok: true; from: State; to: State; turn: Turn; patch: ShipmentPatch; effects: Effect[]; eventType: CommandType }
  | { ok: false; code: DecisionErrorCode; message: string }

const fail = (code: DecisionErrorCode, message: string): Decision => ({ ok: false, code, message })

const TRANSITIONS_BY_COMMAND = new Map<CommandType, Transition>(TRANSITIONS.map((t) => [t.command, t]))

function isBlank(s: string | null | undefined): boolean {
  return s == null || s.trim() === ''
}

function cleanText(s: string | null): string | null {
  return isBlank(s) ? null : s!.trim()
}

function checkEvidence(e: PepEvidence | undefined): string | null {
  if (!e) return 'нет доказательств простой подписи'
  if (!Number.isInteger(e.maxUserId) || e.maxUserId <= 0) return 'в доказательствах нет user_id'
  if (isBlank(e.phoneSha256)) return 'нет подтверждённого номера: сначала «Поделиться номером»'
  if (isBlank(e.callbackId) || isBlank(e.messageMid)) return 'в доказательствах нет нажатия кнопки'
  if (Number.isNaN(Date.parse(e.at))) return 'в доказательствах нет времени нажатия'
  return null
}

function checkPersonRef(ref: PersonRef | undefined, what: string): string | null {
  if (!ref) return `не указан ${what}`
  if ('personId' in ref) return isBlank(ref.personId) ? `не указан ${what}` : null
  const { expectedMaxUserId } = ref.invite
  // Кого нет в MAX, тому бот не напишет: приглашать можно только по user_id из контакта
  if (expectedMaxUserId == null) return `${what} не пользуется MAX — бот не сможет ему написать`
  return null
}

type Outcome = { patch: ShipmentPatch; effects: Effect[] } | { error: string }

/** Проверка данных команды и её последствия. Состояние и роль к этому моменту уже проверены. */
function outcome(cmd: Command, snap: ShipmentSnapshot): Outcome {
  const p = cmd.payload as CommandPayloads[CommandType]
  switch (cmd.type) {
    case 'shipper.offerCarrier': {
      const { carrier, carrierOrgId } = p as CommandPayloads['shipper.offerCarrier']
      const err = checkPersonRef(carrier, 'перевозчик')
      if (err) return { error: err }
      const effects: Effect[] = 'invite' in carrier ? [{ kind: 'invite', role: 'carrier', ref: carrier }] : []
      return { patch: { carrierOrgId }, effects }
    }
    case 'carrier.decline':
    case 'driver.declineTrip': {
      const { reason } = p as CommandPayloads['carrier.decline']
      if (isBlank(reason)) return { error: 'нужна причина отказа' }
      return cmd.type === 'carrier.decline'
        ? { patch: { carrierOrgId: null }, effects: [] }
        : { patch: { driverPersonId: null }, effects: [] }
    }
    case 'carrier.assign': {
      const { vehicleId, driver } = p as CommandPayloads['carrier.assign']
      if (isBlank(vehicleId)) return { error: 'не выбрана машина' }
      const err = checkPersonRef(driver, 'водитель')
      if (err) return { error: err }
      if ('invite' in driver) return { patch: { vehicleId, driverPersonId: null }, effects: [{ kind: 'invite', role: 'driver', ref: driver }] }
      return { patch: { vehicleId, driverPersonId: driver.personId }, effects: [] }
    }
    case 'driver.confirmLoading': {
      const { remarks, evidence } = p as CommandPayloads['driver.confirmLoading']
      const err = checkEvidence(evidence)
      if (err) return { error: err }
      return { patch: { loadingRemarks: cleanText(remarks) }, effects: [{ kind: 'recordPep', title: 'T2', role: 'driver', evidence }] }
    }
    case 'driver.confirmDelivered': {
      const { evidence } = p as CommandPayloads['driver.confirmDelivered']
      const err = checkEvidence(evidence)
      if (err) return { error: err }
      return { patch: {}, effects: [{ kind: 'recordPep', title: 'T4', role: 'driver', evidence }] }
    }
    case 'consignee.recordAcceptance': {
      const { result, discrepancies, evidence } = p as CommandPayloads['consignee.recordAcceptance']
      if (!['full', 'partial', 'refused'].includes(result)) return { error: 'неизвестный итог приёмки' }
      const text = cleanText(discrepancies)
      if (result !== 'full' && !text) return { error: 'при частичной приёмке или отказе нужно описать расхождения' }
      const err = checkEvidence(evidence)
      if (err) return { error: err }
      return {
        patch: { acceptance: { result, discrepancies: text } },
        effects: [{ kind: 'recordPep', title: 'T3', role: 'consignee', evidence }],
      }
    }
    case 'shipper.signT1':
    case 'carrier.signT2':
    case 'consignee.signT3':
    case 'carrier.signT4': {
      const { signatureId } = p as CommandPayloads['shipper.signT1']
      if (isBlank(signatureId)) return { error: 'нет подписи' }
      const title = ({ 'shipper.signT1': 'T1', 'carrier.signT2': 'T2', 'consignee.signT3': 'T3', 'carrier.signT4': 'T4' } as const)[cmd.type]
      const effects: Effect[] = [{ kind: 'submitTitle', title }]
      if (title === 'T4') effects.push({ kind: 'erpWriteBack', status: 'closed' })
      return { patch: {}, effects }
    }
    case 'operator.registered':
    case 'operator.rejected': {
      const { operatorDocId } = p as CommandPayloads['operator.registered']
      if (snap.operatorDocId && operatorDocId !== snap.operatorDocId) return { error: 'ответ оператора по другому документу' }
      if (cmd.type === 'operator.rejected') return { patch: {}, effects: [] }
      const { uid } = p as CommandPayloads['operator.registered']
      if (isBlank(uid)) return { error: 'оператор не вернул УИД' }
      return { patch: { uid }, effects: [{ kind: 'sendQrToDriver' }, { kind: 'inviteConsignee' }] }
    }
    case 'shipper.cancel':
      return { patch: {}, effects: [{ kind: 'erpWriteBack', status: 'cancelled' }] }
    case 'carrier.accept':
    case 'driver.acceptTrip':
    case 'driver.arrivedLoading':
    case 'driver.arrivedUnloading':
      return { patch: {}, effects: [] }
  }
}

/** Можно ли выполнить команду и что из этого следует. */
export function decide(snap: ShipmentSnapshot, cmd: Command, actor: Actor): Decision {
  const t = TRANSITIONS_BY_COMMAND.get(cmd.type)
  if (!t) return fail('unknown_command', `неизвестная команда ${String(cmd.type)}`)

  if (t.by === 'operator') {
    if (actor.kind !== 'operator') return fail('wrong_actor', 'эту команду присылает только оператор')
  } else {
    if (actor.kind !== 'person') return fail('wrong_actor', 'эту команду выполняет только человек')
    if (actor.role !== t.by) return fail('wrong_role', `это действие роли ${t.by}, а не ${actor.role}`)
  }

  if (!t.from.includes(snap.state)) {
    if (snap.state === t.to) return fail('already_done', 'уже сделано')
    return fail('wrong_state', `в состоянии ${snap.state} это действие недоступно`)
  }

  const out = outcome(cmd, snap)
  if ('error' in out) return fail('invalid_payload', out.error)

  return { ok: true, from: snap.state, to: t.to, turn: TURN_BY_STATE[t.to], patch: out.patch, effects: out.effects, eventType: cmd.type }
}
