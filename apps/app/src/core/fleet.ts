import { and, eq } from 'drizzle-orm'
import type { VehicleInput } from '@nk/domain'
import type { Db } from '../db/client.ts'
import { membership, person, vehicle } from '../db/schema.ts'

// Машины и водители перевозчика. Машину вводят при первом назначении, дальше выбирают кнопкой;
// водитель — это роль driver в организации перевозчика (решение 24.09).

export class FleetService {
  constructor(private readonly db: Db) {}

  vehicles(orgId: string) {
    return this.db.select().from(vehicle).where(eq(vehicle.orgId, orgId)).orderBy(vehicle.createdAt)
  }

  /** Машина по госномеру: если уже есть у этой организации — вернуть её, данные обновить. */
  async upsertVehicle(orgId: string, v: VehicleInput): Promise<string> {
    const [row] = await this.db
      .insert(vehicle)
      .values({ orgId, plate: v.plate, brand: v.brand, ownership: v.ownership, ownerName: v.ownerName })
      .onConflictDoUpdate({ target: [vehicle.orgId, vehicle.plate], set: { brand: v.brand, ownership: v.ownership, ownerName: v.ownerName } })
      .returning({ id: vehicle.id })
    return row!.id
  }

  drivers(orgId: string) {
    return this.db
      .select({ personId: person.id, name: person.name, maxUserId: person.maxUserId })
      .from(membership)
      .innerJoin(person, eq(person.id, membership.personId))
      .where(and(eq(membership.orgId, orgId), eq(membership.role, 'driver')))
      .orderBy(person.name)
  }
}
