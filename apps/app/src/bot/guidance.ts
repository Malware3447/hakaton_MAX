import type { CommandType, Role, ShipmentView, State } from '@nk/domain'
import { esc } from '../max/messenger.ts'

// Что сказать человеку на каждом шаге перевозки (решение Максима 26.09):
// тому, чей ход, — короткая инструкция, что от него ждут; остальным, кого шаг касается, —
// что произошло; тому, кто нажал, — что у него получилось. Не полагаемся на то, что человек
// сам заметит смену статуса в карточке: всё приходит сообщением с кнопкой «Открыть».

/** Что ждём от того, чей сейчас ход. reason — причина отказа или сбоя, если переход из-за неё. */
export function instruction(v: ShipmentView, reason?: string | null): string | null {
  const why = reason ? `${esc(reason)}. ` : ''
  switch (v.state) {
    case 'draft':
      return reason
        ? `Перевозчик отклонил заявку: ${why}Назначьте другого — перешлите контакт его диспетчера.`
        : 'Назначьте перевозчика: перешлите контакт его диспетчера.'
    case 'offered':
      return `${esc(v.shipper.name)} предлагает перевезти груз. Посмотрите маршрут и груз, примите заявку или откажитесь.`
    case 'carrier_accepted':
      return reason ? `Водитель отказался от рейса: ${why}Назначьте другого водителя.` : 'Назначьте машину и водителя на рейс.'
    case 'assigned':
      return `Вам назначен рейс от ${esc(v.carrier?.name ?? 'перевозчика')}. Примите его или откажитесь с причиной.`
    case 'trip_accepted':
      return 'Когда приедете на погрузку, нажмите «Я на погрузке».'
    case 'loading':
      return 'Проверьте груз и подтвердите: «Всё верно» или «Есть замечания».'
    case 'loaded':
      return `Водитель принял груз${v.loadingRemarks ? ` с замечаниями: ${esc(v.loadingRemarks)}` : ' без замечаний'}. Подпишите накладную — после неё машина получит документы.`
    case 't1_signed':
      return reason
        ? `${why}Подпишите накладную ещё раз.`
        : 'Отправитель подписал накладную. Подпишите её со своей стороны — после этого водитель получит QR-код.'
    case 'in_transit':
      return 'Накладная зарегистрирована, можно ехать. QR-код для проверки на дороге пришёл файлом. На месте нажмите «Я на выгрузке».'
    case 'unloading':
      return 'Когда груз выгружен и передан получателю, нажмите «Груз сдан».'
    case 'receiving':
      return 'Груз у вас. Проверьте его и отметьте приёмку: без расхождений, частично или отказ.'
    case 'received':
      return 'Подпишите накладную о приёмке груза.'
    case 't3_signed':
      return 'Получатель подписал приёмку. Подпишите накладную — это закроет перевозку.'
    default:
      return null
  }
}

/** Кому из остальных участников важен переход и что им сказать. */
export function eventFor(v: ShipmentView, from: State): { roles: Role[]; text: string } | null {
  switch (v.state) {
    case 'carrier_accepted':
      return from === 'offered' ? { roles: ['shipper'], text: `Перевозчик ${esc(v.carrier?.name ?? '')} принял заявку.` } : null
    case 'assigned':
      return {
        roles: ['shipper'],
        text: `Назначены машина ${esc(v.vehicle ? `${v.vehicle.brand} ${v.vehicle.plate}` : '')} и водитель ${esc(v.driver?.name ?? '')}.`,
      }
    case 'trip_accepted':
      return { roles: ['carrier', 'shipper'], text: `Водитель ${esc(v.driver?.name ?? '')} принял рейс.` }
    case 'loading':
      return { roles: ['carrier', 'shipper'], text: 'Машина на погрузке.' }
    case 'loaded':
      return { roles: ['carrier'], text: `Водитель принял груз${v.loadingRemarks ? ` с замечаниями: ${esc(v.loadingRemarks)}` : ''}. Ждём подписи отправителя.` }
    case 't1_signed':
      return from === 'loaded' ? { roles: ['driver'], text: 'Отправитель подписал накладную. Ждём подписи перевозчика.' } : null
    case 'registering':
      return { roles: ['shipper', 'driver'], text: 'Перевозчик подписал накладную. Ждём регистрации в ГИС ЭПД.' }
    case 'in_transit':
      return { roles: ['shipper', 'carrier', 'consignee'], text: 'Накладная зарегистрирована в ГИС ЭПД, машина в пути.' }
    case 'unloading':
      return { roles: ['shipper', 'consignee'], text: 'Машина на выгрузке.' }
    case 'receiving':
      return { roles: ['shipper', 'carrier'], text: 'Водитель сдал груз. Ждём приёмки у получателя.' }
    case 'received': {
      const r = v.acceptance ? { full: 'без расхождений', partial: 'частично', refused: 'отказ от груза' }[v.acceptance.result] : ''
      return { roles: ['shipper', 'carrier', 'driver'], text: `Получатель отметил приёмку: ${r}${v.acceptance?.discrepancies ? ` — ${esc(v.acceptance.discrepancies)}` : ''}.` }
    }
    case 't3_signed':
      return { roles: ['shipper'], text: 'Получатель подписал накладную. Ждём закрытия перевозчиком.' }
    default:
      return null
  }
}

/** Что получилось у того, кто нажал. */
export const DONE: Partial<Record<CommandType, string>> = {
  'carrier.accept': '✅ Заявка принята.',
  'driver.acceptTrip': '✅ Рейс принят.',
  'driver.arrivedLoading': '✅ Отметили прибытие на погрузку.',
  'driver.confirmLoading': '✅ Приём груза подтверждён вашей подписью.',
  'shipper.signT1': '✅ Накладная подписана.',
  'carrier.signT2': '✅ Накладная подписана. Ждём регистрации в ГИС ЭПД — водитель получит QR-код.',
  'driver.arrivedUnloading': '✅ Отметили прибытие на выгрузку.',
  'driver.confirmDelivered': '✅ Сдача груза подтверждена вашей подписью.',
  'consignee.recordAcceptance': '✅ Приёмка отмечена вашей подписью.',
  'consignee.signT3': '✅ Накладная подписана.',
  'carrier.signT4': '✅ Накладная подписана, перевозка закрыта.',
}
