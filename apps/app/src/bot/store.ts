import { and, eq, gt, sql } from 'drizzle-orm'
import type { Role } from '@nk/domain'
import type { Db } from '../db/client.ts'
import { dialog, formDraft, membership, mockErpShipment, org, person, shipment, type FormDraft, type LineChecks } from '../db/schema.ts'

// Чтение и запись того, что нужно меню ролей и анкетам. Перевозки — в ядре (HAKATON-24).

export type PersonRow = typeof person.$inferSelect
export type OrgRow = typeof org.$inferSelect

export interface RoleInfo {
  role: Role
  /** организация роли; у водителя — первый из его перевозчиков */
  org: OrgRow | null
  /** все организации роли: у водителя их может быть несколько, у остальных одна */
  orgs: OrgRow[]
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

  async personById(id: string): Promise<PersonRow | null> {
    const [row] = await this.db.select().from(person).where(eq(person.id, id))
    return row ?? null
  }

  // ---------- черновики форм мини-приложения (HAKATON-42) ----------

  /** Итог формы ждёт нажатия кнопки в чате: там ставится простая подпись. */
  async saveDraft(personId: string, shipmentId: string, kind: 'remarks' | 'acceptance', payload: FormDraft) {
    await this.db
      .insert(formDraft)
      .values({ personId, shipmentId, kind, payload })
      .onConflictDoUpdate({ target: [formDraft.personId, formDraft.shipmentId, formDraft.kind], set: { payload, createdAt: new Date() } })
  }

  async draft(personId: string, shipmentId: string, kind: 'remarks' | 'acceptance'): Promise<FormDraft | null> {
    const [row] = await this.db
      .select({ payload: formDraft.payload })
      .from(formDraft)
      .where(and(eq(formDraft.personId, personId), eq(formDraft.shipmentId, shipmentId), eq(formDraft.kind, kind)))
    return row?.payload ?? null
  }

  async dropDrafts(personId: string, shipmentId: string) {
    await this.db.delete(formDraft).where(and(eq(formDraft.personId, personId), eq(formDraft.shipmentId, shipmentId)))
  }

  /** Шаг подписан: сверка по позициям из формы остаётся в перевозке — её видят все участники. */
  async saveCheck(shipmentId: string, kind: 'loading' | 'acceptance', check: LineChecks) {
    await this.db
      .update(shipment)
      .set(kind === 'loading' ? { loadingCheck: check } : { acceptanceCheck: check })
      .where(eq(shipment.id, shipmentId))
  }

  async roles(personId: string): Promise<RoleInfo[]> {
    const rows = await this.db
      .select({ m: membership, o: org })
      .from(membership)
      .leftJoin(org, eq(org.id, membership.orgId))
      .where(eq(membership.personId, personId))
      .orderBy(membership.createdAt)
    // Строки одной роли (у водителя — по перевозчику) сводим в одну роль со списком организаций
    const byRole = new Map<Role, RoleInfo>()
    for (const { m, o } of rows) {
      const seen = byRole.get(m.role)
      if (seen) {
        if (o) seen.orgs.push(o)
        seen.org ??= o
        continue
      }
      byRole.set(m.role, {
        role: m.role,
        org: o,
        orgs: o ? [o] : [],
        isAdmin: m.isAdmin,
        canSign: m.canSign,
        poaNumber: m.poaNumber,
        poaValidTo: m.poaValidTo,
      })
    }
    return [...byRole.values()]
  }

  /** Подтверждённый номер: сам номер (для накладной), отпечаток (для доказательств подписи) и время согласия. */
  async savePhone(personId: string, phone: string, phoneSha256: string) {
    await this.db.update(person).set({ phone, phoneSha256, consentAt: new Date() }).where(eq(person.id, personId))
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

  /**
   * Водитель работает на перевозчика orgId (решение 26.09: перевозчиков у водителя может быть несколько).
   * pendingShipmentId — рейс, через который он пришёл: до его принятия связь временная.
   * Строка без перевозчика превращается в эту, иначе добавляется новая; повторный вызов ничего не меняет.
   */
  async ensureDriverOrg(personId: string, orgId: string, pendingShipmentId: string | null = null) {
    const rows = await this.db.select().from(membership).where(and(eq(membership.personId, personId), eq(membership.role, 'driver')))
    if (rows.some((r) => r.orgId === orgId)) return
    // Пришёл через назначение на рейс: связь с перевозчиком временная, пока не примет рейс (находка 27.09).
    // «Водителя без перевозчика» не трогаем — если откажется, роль у него останется, как была.
    if (pendingShipmentId) {
      await this.db.insert(membership).values({ personId, role: 'driver', orgId, isAdmin: false, canSign: false, pendingShipmentId })
      return
    }
    const free = rows.find((r) => r.orgId === null)
    if (free) await this.db.update(membership).set({ orgId }).where(eq(membership.id, free.id))
    else await this.db.insert(membership).values({ personId, role: 'driver', orgId, isAdmin: false, canSign: false })
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
