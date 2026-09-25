import { and, eq, isNull } from 'drizzle-orm'
import type { Role } from '@nk/domain'
import type { Db } from '../db/client.ts'
import { event, participant, person, shipment } from '../db/schema.ts'
import { INVITE_TTL_MS, newInviteToken, sha256 } from './invites.ts'

// Вход по ссылке-приглашению (HAKATON-27). Правила — docs/model-i-sostoyaniya.md, раздел 9:
// ссылка живёт 7 дней; принявший становится участником, и по той же ссылке ему дальше показываем
// перевозку, а другим — «уже вошёл другой человек»; если пришёл не тот,
// кого ждали по контакту, — пускаем, помечаем и сообщаем пригласившему.

export type InviteRow = typeof participant.$inferSelect

export type InviteLookup =
  | { kind: 'not_found' }
  | { kind: 'taken'; invite: InviteRow }
  | { kind: 'expired'; invite: InviteRow }
  | { kind: 'open'; invite: InviteRow; shipment: typeof shipment.$inferSelect }

export type AcceptResult =
  | { ok: true; shipmentId: string; role: Role; mismatch: boolean; inviter: { personId: string; maxUserId: number } | null }
  | { ok: false; reason: 'taken' | 'expired' | 'not_found' | 'org_conflict' }

export class InviteService {
  constructor(private readonly db: Db) {}

  async lookup(token: string): Promise<InviteLookup> {
    const [row] = await this.db
      .select({ p: participant, s: shipment })
      .from(participant)
      .innerJoin(shipment, eq(shipment.id, participant.shipmentId))
      .where(eq(participant.inviteTokenSha256, sha256(token)))
    if (!row) return { kind: 'not_found' }
    if (row.p.personId) return { kind: 'taken', invite: row.p }
    if (row.p.inviteExpiresAt && row.p.inviteExpiresAt.getTime() < Date.now()) return { kind: 'expired', invite: row.p }
    return { kind: 'open', invite: row.p, shipment: row.s }
  }

  /**
   * Принять приглашение. orgId — организация человека в этой роли: у перевозчика она становится
   * перевозчиком перевозки, у водителя должна совпасть с перевозчиком, у получателя — с получателем.
   */
  async accept(participantId: string, personId: string, orgId: string | null): Promise<AcceptResult> {
    return this.db.transaction(async (tx) => {
      const [p] = await tx.select().from(participant).where(eq(participant.id, participantId)).for('update')
      if (!p) return { ok: false, reason: 'not_found' } as const
      if (p.personId) return { ok: false, reason: 'taken' } as const
      if (p.inviteExpiresAt && p.inviteExpiresAt.getTime() < Date.now()) return { ok: false, reason: 'expired' } as const

      const [s] = await tx.select().from(shipment).where(eq(shipment.id, p.shipmentId)).for('update')
      if (!s) return { ok: false, reason: 'not_found' } as const
      if (p.role === 'driver' && s.carrierOrgId && orgId && orgId !== s.carrierOrgId) return { ok: false, reason: 'org_conflict' } as const
      if (p.role === 'consignee' && orgId !== s.consigneeOrgId) return { ok: false, reason: 'org_conflict' } as const

      const [me] = await tx.select({ maxUserId: person.maxUserId }).from(person).where(eq(person.id, personId))
      const mismatch = p.expectedMaxUserId != null && p.expectedMaxUserId !== me?.maxUserId

      await tx
        .update(participant)
        .set({ personId, joinedAt: new Date(), identityMismatch: mismatch })
        .where(eq(participant.id, p.id))
      if (p.role === 'carrier') await tx.update(shipment).set({ carrierOrgId: orgId, updatedAt: new Date() }).where(eq(shipment.id, s.id))
      if (p.role === 'driver') await tx.update(shipment).set({ driverPersonId: personId, updatedAt: new Date() }).where(eq(shipment.id, s.id))

      await tx.insert(event).values({
        shipmentId: s.id,
        type: 'invite.accepted',
        actorKind: 'person',
        actorPersonId: personId,
        actorRole: p.role,
        payload: { mismatch },
      })

      const [inviter] = p.invitedByPersonId
        ? await tx.select({ personId: person.id, maxUserId: person.maxUserId }).from(person).where(eq(person.id, p.invitedByPersonId))
        : []
      return { ok: true, shipmentId: s.id, role: p.role, mismatch, inviter: inviter ?? null } as const
    })
  }

  /** Кто пригласил — чтобы попросить у него новую ссылку. */
  async inviterOf(participantId: string) {
    const [row] = await this.db
      .select({ personId: person.id, maxUserId: person.maxUserId, shipmentId: participant.shipmentId, role: participant.role, erpRef: shipment.erpRef })
      .from(participant)
      .innerJoin(person, eq(person.id, participant.invitedByPersonId))
      .innerJoin(shipment, eq(shipment.id, participant.shipmentId))
      .where(eq(participant.id, participantId))
    return row ?? null
  }

  /** Новая ссылка взамен устаревшей. Выдаёт только тот, кто приглашал, и только пока никто не вошёл. */
  async reissue(shipmentId: string, role: Role, byPersonId: string): Promise<string | null> {
    const { token, sha256: hash } = newInviteToken()
    const updated = await this.db
      .update(participant)
      .set({ inviteTokenSha256: hash, inviteExpiresAt: new Date(Date.now() + INVITE_TTL_MS) })
      .where(
        and(
          eq(participant.shipmentId, shipmentId),
          eq(participant.role, role),
          isNull(participant.personId),
          eq(participant.invitedByPersonId, byPersonId),
        ),
      )
      .returning({ id: participant.id })
    return updated.length ? token : null
  }
}
