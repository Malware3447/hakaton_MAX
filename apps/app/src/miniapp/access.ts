import { and, eq, exists, inArray, ne, notInArray, or, type SQL } from 'drizzle-orm'
import type { Role, State } from '@nk/domain'
import type { Db } from '../db/client.ts'
import { membership, participant, shipment } from '../db/schema.ts'

// Кто что видит в мини-приложении (HAKATON-42). Данные — только своей организации в этой роли:
// кто подключился в боте отправителем от ООО «Ложки-Картошки», видит перевозки ООО «Ложки-Картошки».
// Отправитель, перевозчик и получатель видят перевозки своей организации, водитель — свои рейсы.
// Шаги делает участник перевозки в этой роли: коллега по компании видит перевозку, но действует тот,
// кто её ведёт, — так же решает ядро (ShipmentService.execute проверяет participant).
// Чужую организацию в боте не присвоить: роль компании, которая уже подключена, — только по приглашению.

export interface Scope {
  personId: string
  role: Role
  /** организации человека в этой роли: одна, у водителя — его перевозчики */
  orgIds: string[]
}

/**
 * Получатель видит перевозку, когда накладная ушла на регистрацию: зовут его, когда машина выезжает
 * (последствие inviteConsignee). Отменить перевозку можно только до первой подписи — отменённые он не видит.
 */
const BEFORE_CONSIGNEE: State[] = ['draft', 'offered', 'carrier_accepted', 'assigned', 'trip_accepted', 'loading', 'loaded', 't1_signed', 'cancelled']

/** Роль человека: его организации в ней; null — такой роли у него нет. */
export async function scopeOf(db: Db, personId: string, role: Role): Promise<Scope | null> {
  const rows = await db
    .select({ orgId: membership.orgId })
    .from(membership)
    .where(and(eq(membership.personId, personId), eq(membership.role, role)))
  if (!rows.length) return null
  return { personId, role, orgIds: rows.flatMap((r) => (r.orgId ? [r.orgId] : [])) }
}

/** Человек — участник перевозки в этой роли: назначен или вошёл по приглашению. Условие для запроса из shipment. */
export function isParticipant(db: Db, scope: Scope): SQL {
  return exists(
    db
      .select({ id: participant.id })
      .from(participant)
      .where(and(eq(participant.shipmentId, shipment.id), eq(participant.role, scope.role), eq(participant.personId, scope.personId))),
  )
}

/** Перевозка видна роли. Условие для запроса из shipment. */
export function visibleTo(db: Db, scope: Scope): SQL {
  const orgs = scope.orgIds
  const byOrg: Record<Role, SQL | undefined> = {
    shipper: inArray(shipment.shipperOrgId, orgs),
    // Черновик перевозчику не показываем: заявки ещё нет
    carrier: and(inArray(shipment.carrierOrgId, orgs), ne(shipment.state, 'draft')),
    consignee: and(inArray(shipment.consigneeOrgId, orgs), notInArray(shipment.state, BEFORE_CONSIGNEE)),
    // Водитель — человек, а не организация: видит рейсы, на которые назначен
    driver: eq(shipment.driverPersonId, scope.personId),
  }
  return or(byOrg[scope.role], isParticipant(db, scope))!
}
