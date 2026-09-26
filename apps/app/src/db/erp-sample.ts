import type { TemplateRow } from '../core/erp-import.ts'
import type { PlantSeed } from './seed.ts'

// Заполненные таблицы отгрузок для проверки загрузки из Excel (HAKATON-46).
// Данные — демо-завода из seed/plant-seed.json (всё вымышлено), но номера другие:
// ОТГ-2026-1040 → ОТГ-2026-2040, иначе таблица «заменит» отгрузки сида. Даты — на неделю позже сида.

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

export function sampleRows(seed: PlantSeed): TemplateRow[] {
  const byId = new Map(seed.counterparties.map((c) => [c.id, c]))
  const loadingAddress = `${seed.shipper.address}, ${seed.shipper.loading_point}`
  return seed.shipments.flatMap((s) => {
    const c = byId.get(s.consignee_id)
    if (!c) throw new Error(`в сиде нет получателя ${s.consignee_id}`)
    return s.positions.map((p, i) => ({
      ref: s.number.replace(/-1(\d{3})$/, '-2$1'),
      // поля отгрузки — только в первой строке, как заполнил бы человек
      ...(i === 0
        ? {
            loadingAt: new Date(Date.parse(s.planned_loading_at) + WEEK_MS).toISOString(),
            consigneeInn: c.inn,
            consigneeName: s.consignee_name,
            unloadingAddress: s.unloading_address,
            contactName: c.contact?.name ?? null,
            phone: c.contact?.phone ?? null,
            loadingAddress,
          }
        : { loadingAt: '', consigneeInn: '' }),
      sku: p.sku,
      name: p.name,
      qty: p.qty,
      grossKg: p.gross_kg,
      declaration: p.decl ?? null,
    }))
  })
}

/** Та же таблица с типичными ошибками: бот должен найти каждую и ничего не загрузить. */
export function sampleRowsWithErrors(seed: PlantSeed): TemplateRow[] {
  const rows = sampleRows(seed).filter((r) => /-20(40|41|42|43)$/.test(r.ref))
  const first = (ref: string) => rows.find((r) => r.ref.endsWith(ref) && r.consigneeInn)!
  first('2040').consigneeInn = '1167049239' // контрольная цифра не сходится
  first('2041').loadingAt = '31.09.2026 10:00' // такой даты нет
  first('2042').phone = '12-34' // не телефон
  const line = rows.find((r) => r.ref.endsWith('2043'))!
  line.qty = 0 // количество мест
  line.grossKg = -5 // вес
  return rows
}
