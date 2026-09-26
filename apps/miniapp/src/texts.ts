import type { DiscrepancyReason, Ownership, Role, Shipment, SignatureKind, State, StatusFilter, TitleKind } from './model.ts'

// Тексты экранов. Как и в боте (apps/app/src/bot/cards.ts): без слов «титул», «УИД», «эмулятор».
// Всё смоделированное помечаем «(модель)».

export const ROLE_TITLE: Record<Role, string> = {
  shipper: 'Отправитель',
  carrier: 'Перевозчик',
  driver: 'Водитель',
  consignee: 'Получатель',
}

export const STATE_TEXT: Record<State, string> = {
  draft: 'ждёт назначения перевозчика',
  offered: 'заявка у перевозчика',
  carrier_accepted: 'перевозчик назначает машину и водителя',
  assigned: 'ждём, что водитель примет рейс',
  trip_accepted: 'водитель едет на погрузку',
  loading: 'идёт погрузка',
  loaded: 'груз у водителя, нужна подпись отправителя',
  t1_signed: 'нужна подпись перевозчика',
  registering: 'накладная регистрируется в ГИС ЭПД (модель)',
  in_transit: 'в пути',
  unloading: 'машина на выгрузке',
  receiving: 'груз сдан, идёт приёмка',
  received: 'нужна подпись получателя',
  t3_signed: 'нужна подпись перевозчика о сдаче груза',
  closed: 'закрыта',
  cancelled: 'отменена',
}

export const STATE_SHORT: Record<State, string> = {
  draft: 'новая',
  offered: 'у перевозчика',
  carrier_accepted: 'назначают машину',
  assigned: 'ждём водителя',
  trip_accepted: 'едет на погрузку',
  loading: 'погрузка',
  loaded: 'нужна подпись',
  t1_signed: 'подпись перевозчика',
  registering: 'регистрация',
  in_transit: 'в пути',
  unloading: 'выгрузка',
  receiving: 'приёмка',
  received: 'подпись получателя',
  t3_signed: 'закрытие',
  closed: 'закрыта',
  cancelled: 'отменена',
}

/** Что сделать роли, когда ход за ней: подпись строки в списке и главная кнопка карточки. */
export const TODO: Partial<Record<State, string>> = {
  draft: 'Назначить перевозчика',
  offered: 'Принять или отклонить заявку',
  carrier_accepted: 'Назначить машину и водителя',
  assigned: 'Принять рейс',
  trip_accepted: 'Отметить прибытие на погрузку',
  loading: 'Сверить груз',
  loaded: 'Подписать отгрузку',
  t1_signed: 'Подписать приём груза',
  in_transit: 'Отметить прибытие на выгрузку',
  unloading: 'Сдать груз',
  receiving: 'Принять груз',
  received: 'Подписать приёмку',
  t3_signed: 'Подписать сдачу груза',
}

export const STATUS_FILTER_TEXT: Record<StatusFilter, string> = {
  new: 'Новые',
  carrier: 'Перевозчик и машина',
  loading: 'Погрузка и подписи',
  transit: 'В пути',
  receiving: 'Приёмка',
  closed: 'Закрытые',
  discrepancy: 'С расхождениями',
}

export const TITLE_TEXT: Record<TitleKind, { name: string; who: string }> = {
  T1: { name: 'Отгрузка', who: 'отправитель' },
  T2: { name: 'Приём груза перевозчиком', who: 'перевозчик и водитель' },
  T3: { name: 'Приёмка', who: 'получатель' },
  T4: { name: 'Сдача груза, закрытие', who: 'перевозчик и водитель' },
}

export const SIGNATURE_TEXT: Record<SignatureKind, string> = {
  pep_max: 'простая подпись в MAX',
  goskey: '«Госключ», проверена',
  demo_ca: 'подпись организации (модель)',
}

export const OWNERSHIP_TEXT: Record<Ownership, string> = {
  own: 'собственность',
  lease: 'лизинг',
  rent: 'аренда',
  other: 'другое',
}

/** Тип кузова — в накладной (Т1); тот же список, что в боте (apps/app/src/bot/trip-flows.ts). */
export const BODY_TYPES = ['Бортовой', 'Тентованный', 'Фургон', 'Рефрижератор', 'Цистерна', 'Самосвал']

/** Чего не хватает машине для накладной; null — всё есть. */
export function missingForWaybill(v: { bodyType: string | null; capacityT: number | null; volumeM3: number | null }): string | null {
  const miss = [!v.bodyType && 'тип кузова', v.capacityT == null && 'грузоподъёмность', v.volumeM3 == null && 'объём'].filter(Boolean)
  return miss.length ? miss.join(', ') : null
}

export const REASON_TEXT: Record<DiscrepancyReason, string> = {
  shortage: 'недостача',
  damage: 'бой или повреждение',
  mismatch: 'пересорт',
  surplus: 'излишек',
}

/** Четыре этапа шкалы в шапке карточки. */
export const STAGES = ['Отгрузка', 'Перевозка', 'Приёмка', 'Закрытие'] as const

export function stageOf(state: State): number {
  if (state === 'closed') return 4
  if (['receiving', 'received', 't3_signed'].includes(state)) return 2
  if (['t1_signed', 'registering', 'in_transit', 'unloading'].includes(state)) return 1
  return 0
}

const dtf = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' })
const tf = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' })

export function fmtDay(iso: string) {
  const d = new Date(iso)
  const today = new Date()
  const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86_400_000)
  const day = diff === 0 ? 'сегодня' : diff === 1 ? 'завтра' : diff === -1 ? 'вчера' : dtf.format(d)
  return `${day}, ${tf.format(d)}`
}

export function fmtTime(iso: string) {
  return tf.format(new Date(iso))
}

export function fmtAgo(iso: string) {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000))
  if (min < 1) return 'только что'
  if (min < 60) return `${min} мин`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} ч ${min % 60 ? `${min % 60} мин` : ''}`.trim()
  return `${Math.floor(h / 24)} дн`
}

export const fmtKg = (kg: number) => `${kg.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} кг`

export function city(address: string) {
  const m = address.match(/г\.\s*([^,]+)/)
  return m?.[1]?.trim() ?? address.split(',')[0]!
}

export function route(s: Shipment) {
  return `${city(s.loadingAddress)} → ${city(s.unloadingAddress)}`
}

export function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10
  const m100 = n % 100
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? few : many
}

export function hasDiscrepancy(s: Shipment) {
  return (!!s.acceptance && s.acceptance.result !== 'full') || !!s.loadingRemarks
}
