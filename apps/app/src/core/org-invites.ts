import { and, eq, isNull, ne, notInArray, sql } from 'drizzle-orm'
import type { Role } from '@nk/domain'
import type { Db } from '../db/client.ts'
import { event, membership, org, orgInvite, participant, person, shipment } from '../db/schema.ts'
import { INVITE_TTL_MS, newInviteToken, sha256 } from './invites.ts'

// Люди компании (HAKATON-48). Первый человек организации в роли — администратор (решение 24.09),
// остальных добавляет он: пересланным контактом, ссылкой или одобрив просьбу о доступе.
// Одна роль — одна компания (кроме водителя), поэтому сотрудник другой компании в той же роли добавиться не может.

export const orgInviteLink = (botUsername: string, token: string) => `https://max.ru/${botUsername}?start=org_${token}`

export type OrgInviteRow = typeof orgInvite.$inferSelect

export type JoinResult =
  | { ok: true; orgId: string; orgName: string; role: Role; canSign: boolean; admins: { personId: string; maxUserId: number }[]; invitedBy: string | null }
  | { ok: false; reason: 'not_found' | 'expired' | 'taken' | 'declined' | 'already' | 'other_org'; otherOrg?: string }

export type InviteLookup =
  | { kind: 'not_found' | 'expired' | 'declined' }
  | { kind: 'taken'; invite: OrgInviteRow }
  | { kind: 'open'; invite: OrgInviteRow; orgName: string }

export class OrgInviteService {
  constructor(private readonly db: Db) {}

  /** Сотрудники организации в роли: администраторы первыми. */
  staff(orgId: string, role: Role) {
    return this.db
      .select({ personId: person.id, maxUserId: person.maxUserId, name: person.name, isAdmin: membership.isAdmin, canSign: membership.canSign, poaNumber: membership.poaNumber })
      .from(membership)
      .innerJoin(person, eq(person.id, membership.personId))
      .where(and(eq(membership.orgId, orgId), eq(membership.role, role)))
      .orderBy(sql`${membership.isAdmin} desc`, membership.createdAt)
  }

  /** Ссылка-приглашение; expectedMaxUserId — кого ждём по пересланному контакту. */
  async create(orgId: string, role: Role, byPersonId: string, expectedMaxUserId: number | null = null): Promise<string> {
    const { token, sha256: hash } = newInviteToken()
    await this.db.insert(orgInvite).values({
      orgId,
      role,
      tokenSha256: hash,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      invitedByPersonId: byPersonId,
      expectedMaxUserId,
    })
    return token
  }

  async lookup(token: string): Promise<InviteLookup> {
    const [row] = await this.db
      .select({ i: orgInvite, name: org.name })
      .from(orgInvite)
      .innerJoin(org, eq(org.id, orgInvite.orgId))
      .where(eq(orgInvite.tokenSha256, sha256(token)))
    if (!row) return { kind: 'not_found' }
    if (row.i.acceptedPersonId) return { kind: 'taken', invite: row.i }
    if (row.i.declinedAt) return { kind: 'declined' }
    if (row.i.expiresAt && row.i.expiresAt.getTime() < Date.now()) return { kind: 'expired' }
    return { kind: 'open', invite: row.i, orgName: row.name }
  }

  /** Человек просит доступ сам (ИНН уже подключён). Повторная просьба — та же запись. */
  async request(orgId: string, role: Role, personId: string): Promise<{ id: string; admins: { personId: string; maxUserId: number; name: string }[] }> {
    const [open] = await this.db
      .select({ id: orgInvite.id })
      .from(orgInvite)
      .where(and(eq(orgInvite.orgId, orgId), eq(orgInvite.role, role), eq(orgInvite.requestedByPersonId, personId), isNull(orgInvite.acceptedAt), isNull(orgInvite.declinedAt)))
    const id = open?.id ?? (await this.db.insert(orgInvite).values({ orgId, role, requestedByPersonId: personId }).returning({ id: orgInvite.id }))[0]!.id
    const admins = (await this.staff(orgId, role)).filter((s) => s.isAdmin)
    return { id, admins }
  }

  async get(id: string) {
    const [row] = await this.db.select({ i: orgInvite, name: org.name }).from(orgInvite).innerJoin(org, eq(org.id, orgInvite.orgId)).where(eq(orgInvite.id, id))
    return row ?? null
  }

  async isAdmin(personId: string, orgId: string, role: Role) {
    const [m] = await this.db
      .select({ isAdmin: membership.isAdmin })
      .from(membership)
      .where(and(eq(membership.personId, personId), eq(membership.orgId, orgId), eq(membership.role, role)))
    return m?.isAdmin ?? false
  }

  /** Администратор отказал в доступе. */
  async decline(id: string) {
    const [row] = await this.db
      .update(orgInvite)
      .set({ declinedAt: new Date() })
      .where(and(eq(orgInvite.id, id), isNull(orgInvite.acceptedAt), isNull(orgInvite.declinedAt)))
      .returning()
    return row ?? null
  }

  /**
   * Добавить человека в компанию по приглашению (ссылка или одобренная просьба).
   * Подписывать за компанию могут отправитель и перевозчик; получатель по умолчанию только принимает груз —
   * он может сказать, что подписывает, сразу после входа.
   */
  async join(inviteId: string, personId: string): Promise<JoinResult> {
    return this.db.transaction(async (tx) => {
      const [i] = await tx.select().from(orgInvite).where(eq(orgInvite.id, inviteId)).for('update')
      if (!i) return { ok: false, reason: 'not_found' } as const
      if (i.acceptedPersonId) return { ok: false, reason: i.acceptedPersonId === personId ? 'already' : 'taken' } as const
      if (i.declinedAt) return { ok: false, reason: 'declined' } as const
      if (i.expiresAt && i.expiresAt.getTime() < Date.now()) return { ok: false, reason: 'expired' } as const

      const mine = await tx
        .select({ orgId: membership.orgId, name: org.name })
        .from(membership)
        .leftJoin(org, eq(org.id, membership.orgId))
        .where(and(eq(membership.personId, personId), eq(membership.role, i.role)))
      // уже в компании — ссылку не тратим: её ещё может открыть тот, кого звали
      if (mine.some((m) => m.orgId === i.orgId)) return { ok: false, reason: 'already' } as const
      const other = mine.find((m) => m.orgId)
      if (other && i.role !== 'driver') return { ok: false, reason: 'other_org', otherOrg: other.name ?? '' } as const

      const canSign = i.role === 'shipper' || i.role === 'carrier'
      await tx.insert(membership).values({ personId, role: i.role, orgId: i.orgId, isAdmin: false, canSign })
      await tx.update(orgInvite).set({ acceptedPersonId: personId, acceptedAt: new Date() }).where(eq(orgInvite.id, i.id))
      await tx.update(person).set({ activeRole: i.role }).where(eq(person.id, personId))

      const [o] = await tx.select({ name: org.name }).from(org).where(eq(org.id, i.orgId))
      const admins = await tx
        .select({ personId: person.id, maxUserId: person.maxUserId })
        .from(membership)
        .innerJoin(person, eq(person.id, membership.personId))
        .where(and(eq(membership.orgId, i.orgId), eq(membership.role, i.role), eq(membership.isAdmin, true)))
      return { ok: true, orgId: i.orgId, orgName: o?.name ?? '', role: i.role, canSign, admins, invitedBy: i.invitedByPersonId } as const
    })
  }

  /** Пересланный контакт того, кто уже в боте: добавляем сразу, запись приглашения — для журнала. */
  async addDirect(orgId: string, role: Role, personId: string, byPersonId: string): Promise<JoinResult> {
    const [row] = await this.db.insert(orgInvite).values({ orgId, role, invitedByPersonId: byPersonId }).returning({ id: orgInvite.id })
    return this.join(row!.id, personId)
  }

  /** Получатель после входа: подписывает ли он документы за компанию. */
  async setCanSign(personId: string, orgId: string, role: Role, canSign: boolean) {
    await this.db
      .update(membership)
      .set({ canSign })
      .where(and(eq(membership.personId, personId), eq(membership.orgId, orgId), eq(membership.role, role)))
  }

  /**
   * Что будет при выходе из компании: кто станет администратором, если уходит последний,
   * и кому перейдут перевозки в работе. Без сотрудников перевозки передать некому — выход запрещён.
   */
  async leavePlan(personId: string, orgId: string, role: Role, db: Db = this.db): Promise<LeavePlan> {
    const others = await db
      .select({ personId: person.id, maxUserId: person.maxUserId, name: person.name, isAdmin: membership.isAdmin })
      .from(membership)
      .innerJoin(person, eq(person.id, membership.personId))
      .where(and(eq(membership.orgId, orgId), eq(membership.role, role), ne(membership.personId, personId)))
      .orderBy(membership.createdAt)
    const [me] = await db
      .select({ isAdmin: membership.isAdmin })
      .from(membership)
      .where(and(eq(membership.personId, personId), eq(membership.orgId, orgId), eq(membership.role, role)))
    const newAdmin = me?.isAdmin && !others.some((o) => o.isAdmin) ? (others[0] ?? null) : null
    const heir = others.find((o) => o.isAdmin) ?? newAdmin
    const orgCol = role === 'shipper' ? shipment.shipperOrgId : role === 'consignee' ? shipment.consigneeOrgId : shipment.carrierOrgId
    const active = await db
      .select({ id: shipment.id, erpRef: shipment.erpRef })
      .from(participant)
      .innerJoin(shipment, eq(shipment.id, participant.shipmentId))
      .where(and(eq(participant.personId, personId), eq(participant.role, role), eq(orgCol, orgId), notInArray(shipment.state, ['closed', 'cancelled'])))
    return { member: Boolean(me), others, newAdmin, heir, active }
  }

  /** Выйти из компании: роль пропадает, права администратора и перевозки в работе переходят к сотруднику. */
  async leave(personId: string, orgId: string, role: Role): Promise<{ ok: true; plan: LeavePlan } | { ok: false; reason: 'not_member' | 'nobody_to_take' }> {
    return this.db.transaction(async (tx) => {
      const plan = await this.leavePlan(personId, orgId, role, tx as unknown as Db)
      if (!plan.member) return { ok: false, reason: 'not_member' } as const
      if (plan.active.length && !plan.heir) return { ok: false, reason: 'nobody_to_take' } as const
      if (plan.newAdmin)
        await tx.update(membership).set({ isAdmin: true }).where(and(eq(membership.personId, plan.newAdmin.personId), eq(membership.orgId, orgId), eq(membership.role, role)))
      for (const s of plan.active) {
        await tx
          .update(participant)
          .set({ personId: plan.heir!.personId, source: 'known', joinedAt: new Date() })
          .where(and(eq(participant.shipmentId, s.id), eq(participant.role, role), eq(participant.personId, personId)))
        await tx.insert(event).values({
          shipmentId: s.id,
          type: 'participant.transferred',
          actorKind: 'person',
          actorPersonId: personId,
          actorRole: role,
          payload: { to: plan.heir!.personId, reason: 'left_company' },
        })
      }
      await tx.delete(membership).where(and(eq(membership.personId, personId), eq(membership.orgId, orgId), eq(membership.role, role)))
      await tx.update(person).set({ activeRole: null }).where(and(eq(person.id, personId), eq(person.activeRole, role)))
      return { ok: true, plan } as const
    })
  }
}

export interface LeavePlan {
  member: boolean
  others: { personId: string; maxUserId: number; name: string; isAdmin: boolean }[]
  /** уходит последний администратор — права переходят этому сотруднику */
  newAdmin: { personId: string; maxUserId: number; name: string } | null
  /** кому перейдут перевозки в работе */
  heir: { personId: string; maxUserId: number; name: string } | null
  active: { id: string; erpRef: string }[]
}
