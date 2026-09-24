import { and, eq, gte } from 'drizzle-orm'
import type { ErpAdapter, ErpShipment, WaybillStatus } from '@nk/domain'
import type { Db } from '../db/client.ts'
import { mockErpShipment, mockErpWriteback } from '../db/schema.ts'

/** Учётная система — модель на таблицах mock.erp_*. Доводит Егор в HAKATON-37. */
export class MockErp implements ErpAdapter {
  constructor(private readonly db: Db) {}

  private toErp(r: typeof mockErpShipment.$inferSelect): ErpShipment {
    return {
      ref: r.ref,
      shipperInn: r.shipperInn,
      consignee: { inn: r.consigneeInn, name: r.consigneeName },
      loadingAddress: r.loadingAddress,
      unloadingAddress: r.unloadingAddress,
      plannedLoadingAt: r.plannedLoadingAt?.toISOString() ?? null,
      lines: r.lines,
      places: r.places,
      grossKg: r.grossKg,
    }
  }

  async listShipments(shipperInn: string, since: string | null): Promise<ErpShipment[]> {
    const rows = await this.db
      .select()
      .from(mockErpShipment)
      .where(and(eq(mockErpShipment.shipperInn, shipperInn), since ? gte(mockErpShipment.createdAt, new Date(since)) : undefined))
      .orderBy(mockErpShipment.plannedLoadingAt)
    return rows.map((r) => this.toErp(r))
  }

  async getShipment(ref: string): Promise<ErpShipment | null> {
    const [row] = await this.db.select().from(mockErpShipment).where(eq(mockErpShipment.ref, ref))
    return row ? this.toErp(row) : null
  }

  async writeBack(ref: string, status: WaybillStatus): Promise<void> {
    await this.db.insert(mockErpWriteback).values({ ref, status })
  }
}
