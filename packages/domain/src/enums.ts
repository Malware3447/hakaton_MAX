// Перечни предметной области. Словарь — CONTEXT.md в папке проекта.
// Контракты живые: кто меняет перечень, правит здесь и пишет строку в чат команды.

/** Роль человека: место стороны в перевозке. Одна организация на роль человека. */
export const ROLES = ['shipper', 'carrier', 'driver', 'consignee'] as const
export type Role = (typeof ROLES)[number]

/** Состояние перевозки. Порядок — основной путь из docs/model-i-sostoyaniya.md, раздел 3. */
export const STATES = [
  'draft', // отгрузка пришла из учётной системы, отправитель назначает перевозчика
  'offered', // заявка у перевозчика: принять или отклонить
  'carrier_accepted', // перевозчик принял, выбирает машину и водителя
  'assigned', // водитель назначен, ждём, что он примет рейс
  'trip_accepted', // водитель принял рейс, едет на погрузку
  'loading', // водитель на погрузке, сверяет груз
  'loaded', // водитель подтвердил приём груза (простая подпись), ход отправителя: Т1
  't1_signed', // ход перевозчика: Т2
  'registering', // Т1 и Т2 у оператора, ждём УИД и QR
  'in_transit', // УИД и QR есть, машина в пути
  'unloading', // водитель на выгрузке
  'receiving', // водитель отметил «груз сдан» (простая подпись к Т4), ход получателя: приёмка
  'received', // приёмка отмечена, ход получателя: Т3
  't3_signed', // ход перевозчика: Т4
  'closed', // Т4 подписан, документооборот закрыт
  'cancelled', // отменена отправителем до подписи Т1
] as const
export type State = (typeof STATES)[number]

/** Состояния, в которых перевозка считается активной (для «одна активная на машину и водителя»). */
export const ACTIVE_STATES: readonly State[] = STATES.filter((s) => s !== 'closed' && s !== 'cancelled' && s !== 'draft')

/** Кто действует прямо сейчас. null — ждём систему (оператора) или перевозка завершена. */
export type Turn = Role | null

export const TITLE_KINDS = ['T1', 'T2', 'T3', 'T4'] as const
export type TitleKind = (typeof TITLE_KINDS)[number]

/**
 * Виды подписи.
 * pep_max — простая подпись нажатием кнопки в MAX с доказательствами;
 * goskey — УНЭП или УКЭП «Госключа», присланная человеком и проверенная нами;
 * demo_ca — подпись демо-удостоверяющего центра от имени организации (модель).
 */
export const SIGNATURE_KINDS = ['pep_max', 'goskey', 'demo_ca'] as const
export type SignatureKind = (typeof SIGNATURE_KINDS)[number]

/** Кто совершил событие. */
export const ACTOR_KINDS = ['person', 'erp', 'operator', 'timer', 'system'] as const
export type ActorKind = (typeof ACTOR_KINDS)[number]

export const ACCEPTANCE_RESULTS = ['full', 'partial', 'refused'] as const
export type AcceptanceResult = (typeof ACCEPTANCE_RESULTS)[number]

/** Вид владения машиной — нужен в Т1. */
export const VEHICLE_OWNERSHIP = ['own', 'lease', 'rent', 'other'] as const
export type VehicleOwnership = (typeof VEHICLE_OWNERSHIP)[number]
