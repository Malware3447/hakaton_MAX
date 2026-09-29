import { and, eq, gte, inArray } from 'drizzle-orm'
import type { ErpAdapter, ErpShipment, WaybillStatus } from '@nk/domain'
import type { Db } from '../db/client.ts'
import { mockErpShipment, mockErpWriteback, org, shipment } from '../db/schema.ts'

/** Учётная система — модель на таблицах mock.erp_* (HAKATON-37); новые отгрузки — загрузкой из Excel (HAKATON-46). */
export class MockErp implements ErpAdapter {
  constructor(private readonly db: Db) {}

  private toErp(r: typeof mockErpShipment.$inferSelect): ErpShipment {
    return {
      ref: r.ref,
      shipperInn: r.shipperInn,
      consignee: { inn: r.consigneeInn, name: r.consigneeName, contactName: r.consigneeContactName, phone: r.consigneePhone },
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

  async getShipment(shipperInn: string, ref: string): Promise<ErpShipment | null> {
    const [row] = await this.db
      .select()
      .from(mockErpShipment)
      .where(and(eq(mockErpShipment.shipperInn, shipperInn), eq(mockErpShipment.ref, ref)))
    return row ? this.toErp(row) : null
  }

  async writeBack(shipperInn: string, ref: string, status: WaybillStatus): Promise<void> {
    await this.db.insert(mockErpWriteback).values({ shipperInn, ref, status })
  }

  /** Что уже есть по этим номерам в учётке этого отправителя и начата ли по отгрузке перевозка. */
  async existing(shipperInn: string, refs: string[]): Promise<Map<string, { started: boolean }>> {
    if (!refs.length) return new Map()
    const rows = await this.db
      .select({ ref: mockErpShipment.ref, shipmentId: shipment.id })
      .from(mockErpShipment)
      .leftJoin(org, eq(org.inn, mockErpShipment.shipperInn))
      .leftJoin(shipment, and(eq(shipment.shipperOrgId, org.id), eq(shipment.erpRef, mockErpShipment.ref)))
      .where(and(eq(mockErpShipment.shipperInn, shipperInn), inArray(mockErpShipment.ref, refs)))
    return new Map(rows.map((r) => [r.ref, { started: r.shipmentId != null }]))
  }

  /**
   * Новые отгрузки из таблицы. В одной транзакции: либо все, либо ни одной.
   * Отгрузку того же отправителя, по которой перевозка ещё не начата, заменяем.
   */
  async importShipments(list: ErpShipment[]): Promise<{ added: number; replaced: number }> {
    return this.db.transaction(async (tx) => {
      const inns = [...new Set(list.map((s) => s.shipperInn))]
      if (inns.length !== 1) throw new Error('в одной загрузке — отгрузки одного отправителя')
      const before = await new MockErp(tx as unknown as Db).existing(inns[0]!, list.map((s) => s.ref))
      for (const s of list) if (before.get(s.ref)?.started) throw new Error(`отгрузку ${s.ref} заменить нельзя`)
      for (const s of list) {
        const row = {
          ref: s.ref,
          shipperInn: s.shipperInn,
          consigneeInn: s.consignee.inn,
          consigneeName: s.consignee.name,
          consigneeContactName: s.consignee.contactName ?? null,
          consigneePhone: s.consignee.phone ?? null,
          loadingAddress: s.loadingAddress,
          unloadingAddress: s.unloadingAddress,
          plannedLoadingAt: s.plannedLoadingAt ? new Date(s.plannedLoadingAt) : null,
          lines: s.lines,
          places: s.places,
          grossKg: s.grossKg,
        }
        const { ref: _ref, shipperInn: _inn, ...set } = row
        await tx.insert(mockErpShipment).values(row).onConflictDoUpdate({ target: [mockErpShipment.shipperInn, mockErpShipment.ref], set })
      }
      return { added: list.filter((s) => !before.has(s.ref)).length, replaced: list.filter((s) => before.has(s.ref)).length }
    })
  }
}
