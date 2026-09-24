import { sql } from 'drizzle-orm'
import type { Db } from './client.ts'
import { mockErpShipment, mockOrgRegistry } from './schema.ts'

// Демо-данные завода (seed/plant-seed.json) → таблицы моделей mock.*.
// Решение 24.09: перевозчика, машину и водителя из отгрузки не берём, водителей и машин не грузим.

interface SeedOrg {
  name: string
  inn: string
  kpp: string | null
  address: string
}

interface SeedShipment {
  number: string
  planned_loading_at: string
  consignee_id: string
  consignee_name: string
  unloading_address: string
  positions: { sku: string; name: string; qty: number; gross_kg: number; decl: string | null }[]
  places: number
  gross_kg: number
}

export interface PlantSeed {
  generated_at: string
  shipper: SeedOrg & { loading_point: string }
  counterparties: (SeedOrg & { id: string })[]
  carriers: (SeedOrg & { id: string })[]
  shipments: SeedShipment[]
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Сдвиг дат: день генерации сида становится сегодняшним днём, время суток сохраняется. */
export function dayShiftMs(generatedAt: string, today: Date): number {
  const base = Date.parse(`${generatedAt}T00:00:00Z`)
  const now = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  return Math.round((now - base) / DAY_MS) * DAY_MS
}

export function seedRows(seed: PlantSeed, today: Date) {
  const shift = dayShiftMs(seed.generated_at, today)
  const orgs = [seed.shipper, ...seed.counterparties, ...seed.carriers].map((o) => ({
    inn: o.inn,
    kpp: o.kpp ?? null,
    name: o.name,
    address: o.address,
  }))
  const innById = new Map(seed.counterparties.map((c) => [c.id, c.inn]))
  const loadingAddress = `${seed.shipper.address}, ${seed.shipper.loading_point}`
  const shipments = seed.shipments.map((s) => {
    const consigneeInn = innById.get(s.consignee_id)
    if (!consigneeInn) throw new Error(`в сиде нет получателя ${s.consignee_id} для ${s.number}`)
    return {
      ref: s.number,
      shipperInn: seed.shipper.inn,
      consigneeInn,
      consigneeName: s.consignee_name,
      loadingAddress,
      unloadingAddress: s.unloading_address,
      plannedLoadingAt: new Date(Date.parse(s.planned_loading_at) + shift),
      lines: s.positions.map((p) => ({ sku: p.sku, name: p.name, qty: p.qty, grossKg: p.gross_kg, declaration: p.decl ?? null })),
      places: s.places,
      grossKg: s.gross_kg,
    }
  })
  return { orgs, shipments }
}

/** Все таблицы продукта и моделей, кроме служебных миграций и очередей. */
const RESET_TABLES = [
  'public.inbox', 'public.event', 'public.dialog', 'public.menu_message', 'public.card',
  'public.signature', 'public.title', 'public.participant', 'public.shipment', 'public.vehicle',
  'public.membership', 'public.person', 'public.org',
  'mock.epd_title', 'mock.epd_document', 'mock.epd_settings', 'mock.erp_writeback', 'mock.erp_shipment', 'mock.org_registry',
]

/**
 * Сброс демо: «пустая система» — ни людей, ни организаций, ни перевозок;
 * модели внешних систем заново заполнены из сида с датами от сегодняшнего дня.
 */
export async function resetDemo(db: Db, seed: PlantSeed, today = new Date()): Promise<{ orgs: number; shipments: number }> {
  const { orgs, shipments } = seedRows(seed, today)
  await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`truncate ${RESET_TABLES.join(', ')} restart identity cascade`))
    await tx.insert(mockOrgRegistry).values(orgs)
    await tx.insert(mockErpShipment).values(shipments)
  })
  return { orgs: orgs.length, shipments: shipments.length }
}

/** Засеять модели, только если база пустая (первый запуск). */
export async function seedIfEmpty(db: Db, seed: PlantSeed): Promise<boolean> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(mockOrgRegistry)
  if ((row?.n ?? 0) > 0) return false
  await resetDemo(db, seed)
  return true
}
