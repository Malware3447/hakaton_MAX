import type { ListQuery, Role, Shipment, State, StatusFilter } from './model.ts'
import { hasDiscrepancy } from './texts.ts'

// Главная роли: вкладки, поиск и фильтры поверх перевозок роли. Сервер отдаёт перевозки роли целиком
// (их десятки), раскладывает их приложение — одной логикой и в продукте, и в макете.

const STATUS_GROUP: Record<Exclude<StatusFilter, 'discrepancy'>, State[]> = {
  new: ['draft'],
  carrier: ['offered', 'carrier_accepted', 'assigned'],
  loading: ['trip_accepted', 'loading', 'loaded', 't1_signed', 'registering'],
  transit: ['in_transit', 'unloading'],
  receiving: ['receiving', 'received', 't3_signed'],
  closed: ['closed', 'cancelled'],
}

const DAY = 86_400_000
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

/** Вкладка: закрытые; «ждут меня» — ход за ролью и перевозку ведёт сам человек; остальное — в работе. */
export function tabOf(s: Shipment, role: Role): ListQuery['tab'] {
  if (s.state === 'closed' || s.state === 'cancelled') return 'done'
  return s.turn === role && s.canAct ? 'waiting' : 'active'
}

export function listView(all: Shipment[], role: Role, q: ListQuery): { items: Shipment[]; counts: Record<ListQuery['tab'], number> } {
  const counts = { waiting: 0, active: 0, done: 0 }
  for (const s of all) counts[tabOf(s, role)]++
  const today = startOfDay(new Date())
  const text = q.q.trim().toLowerCase()
  const items = all.filter((s) => {
    if (tabOf(s, role) !== q.tab) return false
    if (text && !`${s.erpRef} ${s.consignee.name} ${s.shipper.name} ${s.carrier?.name ?? ''} ${s.unloadingAddress} ${s.loadingAddress}`.toLowerCase().includes(text)) return false
    if (q.states.length && !q.states.some((f) => (f === 'discrepancy' ? hasDiscrepancy(s) : STATUS_GROUP[f].includes(s.state)))) return false
    if (q.date !== 'all') {
      const d = startOfDay(new Date(s.plannedLoadingAt))
      if (q.date === 'today' && d !== today) return false
      if (q.date === 'tomorrow' && d !== today + DAY) return false
      if (q.date === 'week' && (d < today || d >= today + 7 * DAY)) return false
    }
    if (q.carrierIds.length && !q.carrierIds.includes(s.carrier?.id ?? 'none')) return false
    return true
  })
  // Ждут меня — дольше ждущие первыми, закрытые — свежие сверху, в работе — по дате погрузки
  items.sort((a, b) =>
    q.tab === 'waiting' ? a.turnSince.localeCompare(b.turnSince) : q.tab === 'done' ? b.turnSince.localeCompare(a.turnSince) : a.plannedLoadingAt.localeCompare(b.plannedLoadingAt),
  )
  return { items, counts }
}
