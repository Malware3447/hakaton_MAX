import { and, eq, gt, sql } from 'drizzle-orm'
import type { Role } from '@nk/domain'
import type { Db } from '../db/client.ts'
import { dialog, membership, mockErpShipment, org, person } from '../db/schema.ts'

// Чтение и запись того, что нужно меню ролей и анкетам. Перевозки — в ядре (HAKATON-24).

export type PersonRow = typeof person.$inferSelect
export type OrgRow = typeof org.$inferSelect

export interface RoleInfo {
  role: Role
  org: OrgRow | null
  isAdmin: boolean
  canSign: boolean
  poaNumber: string | null
  poaValidTo: Date | null
}

export interface DialogState {
  step: string
  context: Record<string, unknown>
}

const DIALOG_TTL_MS = 30 * 60 * 1000

export class BotStore {
  constructor(readonly db: Db) {}

  async upsertPerson(maxUserId: number, name: string): Promise<PersonRow> {
    const [row] = await this.db
      .insert(person)
      .values({ maxUserId, name })
      .onConflictDoUpdate({ target: person.maxUserId, set: { name } })
      .returning()
    return row!
  }

  async personByMaxUserId(maxUserId: number): Promise<PersonRow | null> {
    const [row] = await this.db.select().from(person).where(eq(person.maxUserId, maxUserId))
    return row ?? null
  }

  async roles(personId: string): Promise<RoleInfo[]> {
    const rows = await this.db
      .select({ m: membership, o: org })
      .from(membership)
      .leftJoin(org, eq(org.id, membership.orgId))
      .where(eq(membership.personId, personId))
      .orderBy(membership.createdAt)
    return rows.map(({ m, o }) => ({
      role: m.role,
      org: o,
      isAdmin: m.isAdmin,
      canSign: m.canSign,
      poaNumber: m.poaNumber,
      poaValidTo: m.poaValidTo,
    }))
  }

  /** Подтверждённый номер: только отпечаток и время согласия. */
  async savePhone(personId: string, phoneSha256: string) {
    await this.db.update(person).set({ phoneSha256, consentAt: new Date() }).where(eq(person.id, personId))
  }

  async setActiveRole(personId: string, role: Role | null) {
    await this.db.update(person).set({ activeRole: role }).where(eq(person.id, personId))
  }

  async getDialog(personId: string): Promise<DialogState | null> {
    const [row] = await this.db
      .select()
      .from(dialog)
      .where(and(eq(dialog.personId, personId), gt(dialog.expiresAt, sql`now()`)))
    return row ? { step: row.step, context: row.context } : null
  }

  async setDialog(personId: string, state: DialogState) {
    const expiresAt = new Date(Date.now() + DIALOG_TTL_MS)
    await this.db
      .insert(dialog)
      .values({ personId, step: state.step, context: state.context, expiresAt })
      .onConflictDoUpdate({ target: dialog.personId, set: { step: state.step, context: state.context, expiresAt } })
  }

  async clearDialog(personId: string) {
    await this.db.delete(dialog).where(eq(dialog.personId, personId))
  }

  async orgByInn(inn: string): Promise<OrgRow | null> {
    const [row] = await this.db.select().from(org).where(eq(org.inn, inn))
    return row ?? null
  }

  /** Кто уже держит эту роль от этой организации: администратор или первый подключившийся. */
  async roleHolder(orgId: string, role: Role): Promise<string | null> {
    const [row] = await this.db
      .select({ name: person.name })
      .from(membership)
      .innerJoin(person, eq(person.id, membership.personId))
      .where(and(eq(membership.orgId, orgId), eq(membership.role, role)))
      .orderBy(sql`${membership.isAdmin} desc`, membership.createdAt)
      .limit(1)
    return row?.name ?? null
  }

  /** Завести роль: организацию по ИНН (если её ещё нет), членство, текущую роль. Всё или ничего. */
  async addRole(input: {
    personId: string
    role: Role
    org: {
      inn: string
      kpp: string | null
      name: string
      address: string
      verified: boolean
      erpLinked: boolean
      source: 'demo' | 'dadata' | 'manual'
      ogrn: string | null
    } | null
    canSign: boolean
    poaNumber: string | null
    poaValidTo: Date | null
  }) {
    await this.db.transaction(async (tx) => {
      let orgId: string | null = null
      if (input.org) {
        const o = input.org
        const [existing] = await tx.select().from(org).where(eq(org.inn, o.inn))
        if (existing) {
          orgId = existing.id
          if (o.erpLinked && !existing.erpKind) await tx.update(org).set({ erpKind: 'mock' }).where(eq(org.id, existing.id))
        } else {
          const [created] = await tx
            .insert(org)
            .values({
              inn: o.inn,
              kpp: o.kpp,
              name: o.name,
              address: o.address,
              verified: o.verified,
              erpKind: o.erpLinked ? 'mock' : null,
              requisitesSource: o.source,
              ogrn: o.ogrn,
            })
            .returning({ id: org.id })
          orgId = created!.id
        }
      }
      await tx.insert(membership).values({
        personId: input.personId,
        role: input.role,
        orgId,
        // Решение 24.09: первый человек организации в роли — администратор, остальные — по приглашению
        isAdmin: orgId !== null,
        canSign: input.canSign,
        poaNumber: input.poaNumber,
        poaValidTo: input.poaValidTo,
      })
      await tx.update(person).set({ activeRole: input.role }).where(eq(person.id, input.personId))
    })
  }

  /** Роль в уже известной организации (по приглашению): организация из перевозки, ИНН не спрашиваем. */
  async addRoleForOrg(personId: string, role: Role, orgId: string, canSign: boolean) {
    await this.db.transaction(async (tx) => {
      const [holder] = await tx
        .select({ id: membership.id })
        .from(membership)
        .where(and(eq(membership.orgId, orgId), eq(membership.role, role)))
        .limit(1)
      await tx.insert(membership).values({ personId, role, orgId, isAdmin: !holder, canSign })
    })
  }

  /** Водителю без перевозчика — организация перевозчика, который его позвал. */
  async setRoleOrg(personId: string, role: Role, orgId: string) {
    await this.db
      .update(membership)
      .set({ orgId })
      .where(and(eq(membership.personId, personId), eq(membership.role, role), sql`${membership.orgId} is null`))
  }

  /** Люди организации в роли: администратор первым. */
  async orgMembers(orgId: string, role: Role) {
    return this.db
      .select({ personId: person.id, maxUserId: person.maxUserId, name: person.name })
      .from(membership)
      .innerJoin(person, eq(person.id, membership.personId))
      .where(and(eq(membership.orgId, orgId), eq(membership.role, role)))
      .orderBy(sql`${membership.isAdmin} desc`, membership.createdAt)
  }

  async erpShipmentCount(shipperInn: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(mockErpShipment)
      .where(eq(mockErpShipment.shipperInn, shipperInn))
    return row?.n ?? 0
  }
}
