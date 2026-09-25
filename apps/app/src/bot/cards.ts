import type { Button, CommandType, OutMessage, Role, ShipmentView, State, WaitingItem } from '@nk/domain'
import { esc } from '../max/messenger.ts'
import type { ShipperListItem } from '../core/shipments.ts'
import { P, S, cb } from './screens.ts'

// Карточка перевозки и списки. Тексты — для людей: без «титул», «УИД», «эмулятор».

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

const STATE_SHORT: Record<State, string> = {
  draft: 'черновик',
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

const shortOrg = (name: string) => name.replace(/^(ООО|АО|ПАО|ИП|ЗАО)\s+/, '').replace(/[«»"]/g, '')
const shortRef = (ref: string) => ref.replace(/^ОТГ-\d{4}-/, '')
const fmt = (iso: string | Date | null) =>
  iso
    ? new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(',', ' в')
    : 'не указана'
const fmtDay = (d: Date | null) => (d ? d.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit' }) : '')

/** Кнопки для действия: простые выполняются сразу, остальные открывают ввод или пока заглушки. */
function actionButtons(cmd: CommandType, id: string): Button[] {
  switch (cmd) {
    case 'shipper.offerCarrier':
      return [cb('Назначить перевозчика', S.assignCarrier(id))]
    case 'carrier.accept':
      return [cb('Принять заявку', S.run(cmd, id))]
    case 'carrier.decline':
      return [cb('Отклонить', S.decline(id))]
    case 'carrier.assign':
      return [cb('Назначить машину и водителя', `as:${id}`)]
    case 'driver.acceptTrip':
      return [cb('Принять рейс', S.run(cmd, id))]
    case 'driver.declineTrip':
      return [cb('Отказаться от рейса', `dt:${id}`)]
    case 'driver.arrivedLoading':
      return [cb('Я на погрузке', S.run(cmd, id))]
    case 'driver.confirmLoading':
      return [cb('Всё верно, груз принят', `cl:ok:${id}`), cb('Есть замечания', `cl:rm:${id}`)]
    case 'shipper.signT1':
      return [cb('Подписать накладную', P.stub(cmd))]
    case 'shipper.cancel':
      return [cb('Отменить перевозку', P.stub(cmd))]
    default:
      return [cb('Следующий шаг', P.stub(cmd))]
  }
}

export function shipmentCard(v: ShipmentView, note?: string): OutMessage {
  const lines = [`<b>Перевозка ${esc(v.erpRef)}</b>`]
  if (note) lines.push(note)
  lines.push(
    '',
    `Статус: ${STATE_TEXT[v.state]}`,
    `Погрузка: ${fmt(v.plannedLoadingAt)}`,
    `Откуда: ${esc(v.loadingAddress)}`,
    `Куда: ${esc(v.unloadingAddress)}`,
    '',
    `Отправитель: ${esc(v.shipper.name)}`,
    `Получатель: ${esc(v.consignee.name)}`,
    `Перевозчик: ${v.carrier ? esc(v.carrier.name) : '—'}`,
  )
  if (v.loadingRemarks) lines.push(`Замечания при погрузке: ${esc(v.loadingRemarks)}`)
  if (v.vehicle || v.driver) lines.push(`Машина: ${v.vehicle ? esc(`${v.vehicle.brand} ${v.vehicle.plate}`) : '—'}, водитель: ${v.driver ? esc(v.driver.name) : '—'}`)
  lines.push('', `Груз: ${v.cargo.places} мест, ${v.cargo.grossKg} кг`)
  for (const l of v.cargo.lines.slice(0, 3)) lines.push(`• ${esc(l.name)} — ${l.qty} шт.`)
  if (v.cargo.lines.length > 3) lines.push(`• и ещё ${v.cargo.lines.length - 3}`)
  if (v.turn === v.viewerRole && v.actions.length) lines.push('', '<b>Сейчас ваш ход.</b>')

  const buttons: Button[][] = v.actions.map((a) => actionButtons(a, v.id))
  buttons.push([cb('Обновить', S.view(v.id)), cb('В меню', P.open(v.viewerRole))])
  return { text: lines.join('\n'), buttons }
}

const PAGE = 6

export function shipperList(items: ShipperListItem[], page: number): OutMessage {
  const pages = Math.max(1, Math.ceil(items.length / PAGE))
  const p = Math.min(Math.max(page, 0), pages - 1)
  const slice = items.slice(p * PAGE, (p + 1) * PAGE)
  const buttons: Button[][] = slice.map((it) => [
    cb(
      `${shortRef(it.erpRef)} · ${shortOrg(it.consigneeName)} · ${fmtDay(it.plannedLoadingAt)} · ${it.state ? STATE_SHORT[it.state] : 'новая'}`,
      it.shipmentId ? S.view(it.shipmentId) : S.openErp(it.erpRef),
    ),
  ])
  const navRow: Button[] = []
  if (p > 0) navRow.push(cb('← Назад', S.list(p - 1)))
  if (p < pages - 1) navRow.push(cb('Дальше →', S.list(p + 1)))
  if (navRow.length) buttons.push(navRow)
  buttons.push([cb('В меню', P.open('shipper'))])
  return {
    text: [`<b>Отгрузки из учётной системы</b> (модель)`, `Всего ${items.length}, страница ${p + 1} из ${pages}. Номер · получатель · дата погрузки · статус.`].join('\n'),
    buttons,
  }
}

export function shipmentList(title: string, items: { shipmentId: string; erpRef: string; state: State }[], back: Role, empty: string): OutMessage {
  if (!items.length) return { text: `<b>${title}</b>\n\n${empty}`, buttons: [[cb('В меню', P.open(back))]] }
  return {
    text: `<b>${title}</b>`,
    buttons: [...items.slice(0, 20).map((it) => [cb(`${it.erpRef} · ${STATE_SHORT[it.state]}`, S.view(it.shipmentId))]), [cb('В меню', P.open(back))]],
  }
}

export const waitingList = (items: WaitingItem[], role: Role) =>
  shipmentList('Ждут вашего действия', items, role, 'Сейчас ничего не ждёт вас.')

const ROLE_INVITE: Record<Role, string> = {
  shipper: 'Вас приглашают в перевозку как отправителя',
  carrier: 'Вам предлагают перевезти груз',
  driver: 'Вас назначили водителем на рейс',
  consignee: 'К вам едет груз',
}

/** Что человек видит по ссылке-приглашению до того, как что-то нажать. */
export function invitePreview(v: ShipmentView, role: Role): string {
  const card = shipmentCard({ ...v, actions: [] }).text
  return [`<b>${ROLE_INVITE[role]}</b>`, '', card].join('\n')
}
