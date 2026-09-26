import { STATES, TURN_BY_STATE, type ActorKind, type Role, type State } from '@nk/domain'
import { ROLE_TITLE } from '../bot/screens.ts'

// Лента перевозки и раздел событий мини-приложения: запись журнала event → фраза для человека.
// Тексты как в боте (bot/guidance.ts): без «титул», «УИД», «эмулятор»; модели помечены «(модель)».

export interface EventRecord {
  type: string
  actorKind: ActorKind
  actorPersonId: string | null
  actorRole: Role | null
  payload: Record<string, unknown>
}

/** Имена для текстов: перевозчик из заявки, машина и водитель из назначения, люди. */
export interface EventNames {
  org(id: string): string | null
  vehicle(id: string): string | null
  person(id: string): string | null
}

/** Служебные записи журнала: в ленту не попадают. */
export const HIDDEN_EVENTS = ['command.rejected', 'notify.failed']

const ACCEPTANCE_TEXT = { full: 'принято без расхождений', partial: 'принято с расхождениями', refused: 'отказ от груза' } as const

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
const obj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : null)

/** Кого назначили: найденный человек или приглашённый по контакту. */
function whom(ref: unknown, names: EventNames): string | null {
  const r = obj(ref)
  if (!r) return null
  const personId = str(r.personId)
  if (personId) return names.person(personId)
  return str(obj(r.invite)?.displayName)
}

/** Идентификаторы, которые нужны текстам: собрать заранее и прочитать одним запросом. */
export function referencedIds(events: EventRecord[]) {
  const orgs = new Set<string>()
  const vehicles = new Set<string>()
  const people = new Set<string>()
  for (const e of events) {
    if (e.actorPersonId) people.add(e.actorPersonId)
    const org = str(e.payload.carrierOrgId)
    if (org) orgs.add(org)
    const car = str(e.payload.vehicleId)
    if (car) vehicles.add(car)
    const driver = str(obj(e.payload.driver)?.personId)
    if (driver) people.add(driver)
    const carrier = str(obj(e.payload.carrier)?.personId)
    if (carrier) people.add(carrier)
  }
  return { orgs: [...orgs], vehicles: [...vehicles], people: [...people] }
}

export function eventText(e: EventRecord, names: EventNames): string | null {
  const p = e.payload
  switch (e.type) {
    case 'shipment.created':
      return 'Отгрузка пришла из учётной системы'
    case 'shipper.offerCarrier': {
      const org = str(p.carrierOrgId)
      const name = (org && names.org(org)) ?? whom(p.carrier, names)
      return name ? `Заявка отправлена перевозчику: ${name}` : 'Заявка отправлена перевозчику'
    }
    case 'carrier.accept':
      return 'Перевозчик принял заявку'
    case 'carrier.decline':
      return `Перевозчик отказался${str(p.reason) ? `: ${str(p.reason)}` : ''}`
    case 'carrier.assign': {
      const car = str(p.vehicleId)
      const plate = car ? names.vehicle(car) : null
      const driver = whom(p.driver, names)
      return `Назначены машина ${plate ?? '—'} и водитель ${driver ?? '—'}`
    }
    case 'invite.accepted':
      return `Принято приглашение${e.actorRole ? `: ${ROLE_TITLE[e.actorRole].toLowerCase()}` : ''}`
    case 'participant.assigned': {
      const role = str(p.role) as Role | null
      return role === 'consignee' ? 'Приёмщик получателя подключён к перевозке' : 'Участник подключён к перевозке'
    }
    case 'driver.acceptTrip':
      return 'Водитель принял рейс и едет на погрузку'
    case 'driver.declineTrip':
      return `Водитель отказался от рейса${str(p.reason) ? `: ${str(p.reason)}` : ''}`
    case 'driver.arrivedLoading':
      return 'Водитель на погрузке'
    case 'driver.confirmLoading':
      return str(p.remarks) ? `Водитель принял груз с замечаниями: ${str(p.remarks)}` : 'Водитель принял груз без замечаний'
    case 'shipper.signT1':
      return 'Отправитель подписал накладную'
    case 'carrier.signT2':
      return 'Перевозчик подписал приём груза, накладная ушла оператору ЭПД (модель)'
    case 'operator.registered':
      return `Накладная зарегистрирована в ГИС ЭПД (модель)${str(p.uid) ? `, номер ${str(p.uid)}` : ''}`
    case 'operator.rejected':
      return `Оператор ЭПД (модель) не принял накладную${str(p.message) ? `: ${str(p.message)}` : ''}`
    case 'driver.arrivedUnloading':
      return 'Машина на выгрузке'
    case 'driver.confirmDelivered':
      return 'Водитель сдал груз, идёт приёмка'
    case 'consignee.recordAcceptance': {
      const r = ACCEPTANCE_TEXT[p.result as keyof typeof ACCEPTANCE_TEXT]
      return `Получатель отметил приёмку: ${r ?? 'итог не указан'}${str(p.discrepancies) ? ` — ${str(p.discrepancies)}` : ''}`
    }
    case 'consignee.signT3':
      return 'Получатель подписал приёмку'
    case 'carrier.signT4':
      return 'Перевозчик подписал сдачу груза. Накладная закрыта'
    case 'shipper.cancel':
      return `Перевозка отменена отправителем${str(p.reason) ? `: ${str(p.reason)}` : ''}`
    default:
      return null
  }
}

/** Кто сделал: имя человека, иначе его роль; системы — с пометкой модели. */
export function eventActor(e: EventRecord, names: EventNames): string {
  switch (e.actorKind) {
    case 'person':
      return (e.actorPersonId && names.person(e.actorPersonId)) ?? (e.actorRole ? ROLE_TITLE[e.actorRole] : 'участник')
    case 'erp':
      return 'учётная система (модель)'
    case 'operator':
      return 'оператор ЭПД (модель)'
    default:
      return 'система'
  }
}

/** Для чьей роли после события настал ход: переход команды несёт to, отгрузка из учётки ждёт отправителя. */
export function eventTurn(e: EventRecord): Role | null {
  if (e.type === 'shipment.created') return 'shipper'
  const to = e.payload.to
  return typeof to === 'string' && (STATES as readonly string[]).includes(to) ? TURN_BY_STATE[to as State] : null
}
