import { and, desc, eq, isNull } from 'drizzle-orm'
import type { Role } from '@nk/domain'
import { checkPoa, fio, parsePoa, PoaFormatError, samePerson, verifyPoaSignature, type PkiStore, type PoaCheck, type SignerAuthority } from '@nk/etrn'
import type { Db } from '../db/client.ts'
import { membership, org, person, poa } from '../db/schema.ts'

// МЧД подписантов (HAKATON-49, разбор — docs артефакт «МЧД подписантов»).
// Сотрудник подписывает за компанию только по действующей МЧД; руководитель и ИП — без неё.
// Проверяем сами: формат 003, сроки, доверитель — эта компания, представитель — этот человек,
// подпись руководителя под файлом. Статус в реестре ФНС — через PoaRegistry, если он доступен.

export type PoaRow = typeof poa.$inferSelect
export type SignerKind = 'head' | 'employee'

export type RegistryStatus = 'active' | 'revoked' | 'not_found' | 'expired' | 'unavailable'

/** Реестр МЧД ФНС (FnsPoaRegistry). unavailable — реестр не ответил или ответ не разобран: подпись не блокируем. */
export interface PoaRegistry {
  status(number: string, principalInn: string): Promise<RegistryStatus>
}

const REGISTRY_BAD: Record<'revoked' | 'not_found' | 'expired', string> = { revoked: 'отозвана', not_found: 'не найдена', expired: 'истекла' }
const isBad = (s: string | null | undefined): s is keyof typeof REGISTRY_BAD => s === 'revoked' || s === 'not_found' || s === 'expired'

export type SignGate =
  | { ok: true; authority: SignerAuthority }
  | { ok: false; reason: 'ask_kind' | 'no_poa' | 'expired' | 'revoked'; message: string; membershipId: string }

export interface AddResult {
  ok: boolean
  checks: PoaCheck[]
  /** коротко, что не так — первая непройденная проверка */
  error: string | null
  poa: PoaRow | null
}

const DAY = 86_400_000
const GUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i
const today = (now: Date) => Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
const dayOf = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
/** ГГГГ-ММ-ДД → полдень UTC: дата не «съезжает» на соседний день ни в Москве, ни на сервере */
const noon = (iso: string) => new Date(`${iso}T12:00:00Z`)

export class PoaService {
  constructor(
    private readonly db: Db,
    private readonly opts: { pki: PkiStore | null; registry: PoaRegistry | null } = { pki: null, registry: null },
  ) {}

  /** Роль человека в организации: у отправителя, перевозчика и получателя она одна. */
  async membershipOf(personId: string, role: Role, orgId?: string | null) {
    const rows = await this.db
      .select({ m: membership, o: org, p: person })
      .from(membership)
      .innerJoin(person, eq(person.id, membership.personId))
      .leftJoin(org, eq(org.id, membership.orgId))
      .where(and(eq(membership.personId, personId), eq(membership.role, role), orgId ? eq(membership.orgId, orgId) : undefined))
      .limit(1)
    return rows[0] ?? null
  }

  async setSignerKind(membershipId: string, kind: SignerKind) {
    await this.db.update(membership).set({ signerKind: kind, canSign: true }).where(eq(membership.id, membershipId))
  }

  async current(membershipId: string): Promise<PoaRow | null> {
    const [row] = await this.db
      .select()
      .from(poa)
      .where(and(eq(poa.membershipId, membershipId), isNull(poa.replacedAt)))
      .orderBy(desc(poa.createdAt))
      .limit(1)
    return row ?? null
  }

  /** Файл МЧД (и, если прислали, подпись руководителя под ним): разобрать, проверить, сохранить как текущую. */
  async addFromFile(input: { membershipId: string; file: Uint8Array; sig?: Uint8Array | null; now?: Date }): Promise<AddResult> {
    const ctx = await this.context(input.membershipId)
    let doc
    try {
      doc = parsePoa(input.file)
    } catch (e) {
      const message = e instanceof PoaFormatError ? `Это не похоже на машиночитаемую доверенность: ${e.message}.` : 'Файл не удалось прочитать.'
      return { ok: false, checks: [{ name: 'format', ok: false, level: 'error', message }], error: message, poa: null }
    }
    const res = checkPoa(doc, { orgInn: ctx.orgInn, personName: ctx.personName, personInn: ctx.repInn, now: input.now })
    const checks = [...res.checks]
    let signatureOk: boolean | null = null
    let signedBy: string | null = null
    if (input.sig) {
      if (!this.opts.pki) checks.push({ name: 'format', ok: true, level: 'warning', message: 'подпись руководителя не проверена: на сервере нет проверки ГОСТ' })
      else {
        const s = await verifyPoaSignature({ poa: doc, file: input.file, sig: input.sig, orgInn: ctx.orgInn, pki: this.opts.pki, now: input.now })
        signatureOk = s.ok
        signedBy = s.signature.signer?.fullName ?? null
        for (const c of [...s.signature.checks.filter((x) => !x.ok), s.signerIsHead]) checks.push({ name: 'principal', ok: c.ok, level: c.ok ? 'info' : 'error', message: `подпись руководителя: ${c.message}` })
      }
    }
    const ok = checks.every((c) => c.ok)
    if (!ok) return { ok, checks, error: checks.find((c) => !c.ok)!.message, poa: null }

    const reg = await this.registryCheck(doc.number, ctx.orgInn, checks, input.now)
    if (!reg.ok) return { ok: false, checks, error: reg.error, poa: null }
    const principal = doc.principals.find((p) => p.inn === ctx.orgInn)!
    const rep = res.representative!
    const row = await this.save(input.membershipId, {
      ...reg.fields,
      number: doc.number,
      internalNumber: doc.internalNumber,
      issuedAt: noon(doc.issuedAt),
      validTo: noon(doc.validTo),
      principalInn: ctx.orgInn,
      principalName: principal.name,
      repName: fio(rep),
      repInn: rep.inn,
      repSnils: rep.snils,
      source: 'file',
      file: Buffer.from(input.file),
      sig: input.sig ? Buffer.from(input.sig) : null,
      signatureOk,
      signedBy,
      checks,
    })
    return { ok: true, checks, error: null, poa: row }
  }

  /**
   * Номер и даты руками: файла нет, поэтому доверителя и представителя берём с чужих слов.
   * Проверяем то, что можно: номер из реестра (UUID), дата выдачи не в будущем, срок не истёк.
   */
  async addManual(input: { membershipId: string; number: string; issuedAt: Date; validTo: Date; now?: Date }): Promise<AddResult> {
    const now = input.now ?? new Date()
    const ctx = await this.context(input.membershipId)
    const number = input.number.trim().toLowerCase()
    const checks: PoaCheck[] = []
    const add = (name: PoaCheck['name'], ok: boolean, message: string, level: PoaCheck['level'] = ok ? 'info' : 'error') => checks.push({ name, ok, level, message })
    add('number', GUID.test(number), GUID.test(number) ? `номер ${number}` : 'Номер доверенности из реестра ФНС выглядит так: 4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f')
    add('issued', dayOf(input.issuedAt) <= today(now), dayOf(input.issuedAt) <= today(now) ? 'дата выдачи в прошлом' : 'Дата выдачи ещё не наступила')
    const left = Math.round((dayOf(input.validTo) - today(now)) / DAY)
    if (left < 0) add('valid_to', false, 'Доверенность уже истекла — укажите действующую')
    else if (dayOf(input.validTo) < dayOf(input.issuedAt)) add('valid_to', false, 'Срок действия раньше даты выдачи')
    else add('valid_to', true, left <= 14 ? `осталось ${left} дн., пора продлить` : 'срок действия в порядке', left <= 14 ? 'warning' : 'info')
    add('representative', true, 'представитель и доверитель не проверены: введено вручную, без файла', 'warning')
    const ok = checks.every((c) => c.ok)
    if (!ok) return { ok, checks, error: checks.find((c) => !c.ok)!.message, poa: null }
    const reg = await this.registryCheck(number, ctx.orgInn, checks, now)
    if (!reg.ok) return { ok: false, checks, error: reg.error, poa: null }
    const row = await this.save(input.membershipId, {
      ...reg.fields,
      number,
      internalNumber: null,
      issuedAt: input.issuedAt,
      validTo: input.validTo,
      principalInn: ctx.orgInn,
      principalName: ctx.orgName,
      repName: ctx.personName,
      repInn: null,
      repSnils: null,
      source: 'manual',
      file: null,
      sig: null,
      signatureOk: null,
      signedBy: null,
      checks,
    })
    return { ok: true, checks, error: null, poa: row }
  }

  /** Можно ли человеку подписать за компанию прямо сейчас, и что писать в «Подписант» титула. */
  async gate(personId: string, role: Role, orgId: string | null, now = new Date()): Promise<SignGate> {
    const row = await this.membershipOf(personId, role, orgId)
    if (!row) return { ok: true, authority: { kind: 'head' } }
    const m = row.m
    const company = row.o?.name ?? 'компанию'
    // ИП подписывает сам: доверенность ему не нужна
    if (m.signerKind === 'head' || (row.o && row.o.inn.length === 12 && m.signerKind !== 'employee')) return { ok: true, authority: { kind: 'head' } }
    if (!m.signerKind) return { ok: false, reason: 'ask_kind', membershipId: m.id, message: `Кто подписывает за ${company}: вы руководитель или сотрудник по доверенности?` }
    const p = await this.current(m.id)
    if (!p) return { ok: false, reason: 'no_poa', membershipId: m.id, message: `Чтобы подписать за ${company}, нужна машиночитаемая доверенность. Пришлите её файл из реестра ФНС или номер и даты.` }
    if (dayOf(p.validTo) < today(now)) return { ok: false, reason: 'expired', membershipId: m.id, message: `Доверенность ${p.number} закончилась ${p.validTo.toLocaleDateString('ru-RU')}. Пришлите действующую.` }
    // Отзыв бывает в любой момент, поэтому реестр спрашиваем перед каждой подписью (ответ клиент помнит 10 минут)
    if (this.opts.registry && p.registryStatus !== 'revoked') {
      const status = await this.opts.registry.status(p.number, p.principalInn).catch(() => 'unavailable' as const)
      if (status !== 'unavailable') {
        await this.db.update(poa).set({ registryStatus: status, registryCheckedAt: now }).where(eq(poa.id, p.id))
        p.registryStatus = status
      }
    }
    if (isBad(p.registryStatus))
      return { ok: false, reason: 'revoked', membershipId: m.id, message: `Доверенность ${p.number} ${REGISTRY_BAD[p.registryStatus]} в реестре ФНС. Пришлите действующую.` }
    return { ok: true, authority: { kind: 'poa', number: p.number, issuedAt: p.issuedAt, internalNumber: p.internalNumber } }
  }

  /** Подписал ли титул тот, на кого выдана МЧД. Руководителя и ИП не сверяем: у них МЧД нет. */
  async signerMatches(personId: string, role: Role, orgId: string | null, signer: { fullName: string | null; personInn: string | null; snils: string | null }): Promise<{ ok: boolean; message: string }> {
    const row = await this.membershipOf(personId, role, orgId)
    if (!row || row.m.signerKind !== 'employee') return { ok: true, message: 'подписант не по доверенности' }
    const p = await this.current(row.m.id)
    if (!p?.repName) return { ok: true, message: 'в доверенности нет сведений о представителе' }
    const [surname = '', name = '', patronymic = null] = p.repName.split(/\s+/)
    const ok = samePerson({ surname, name, patronymic, inn: p.repInn, snils: p.repSnils, position: null }, { name: signer.fullName ?? '', inn: signer.personInn, snils: signer.snils })
    return { ok, message: ok ? `подписал представитель по доверенности ${p.repName}` : `подпись поставил ${signer.fullName ?? 'другой человек'}, а доверенность выдана ${p.repName}` }
  }

  /** Статус в реестре ФНС при приёме доверенности: отозванную, истёкшую и незарегистрированную не принимаем. */
  private async registryCheck(number: string, principalInn: string, checks: PoaCheck[], now = new Date()) {
    const status = this.opts.registry ? await this.opts.registry.status(number, principalInn).catch(() => 'unavailable' as const) : null
    if (isBad(status)) {
      const error = `Доверенность ${number} ${REGISTRY_BAD[status]} в реестре ФНС`
      checks.push({ name: 'registry', ok: false, level: 'error', message: error })
      return { ok: false as const, error }
    }
    if (status === 'active') checks.push({ name: 'registry', ok: true, level: 'info', message: 'в реестре ФНС действует' })
    else if (status) checks.push({ name: 'registry', ok: true, level: 'warning', message: 'реестр ФНС сейчас не отвечает — проверим статус перед подписью' })
    return {
      ok: true as const,
      fields: status === 'active' ? { registryStatus: 'active' as const, registryCheckedAt: now } : {},
    }
  }

  private async context(membershipId: string) {
    const [row] = await this.db
      .select({ m: membership, o: org, p: person })
      .from(membership)
      .innerJoin(person, eq(person.id, membership.personId))
      .innerJoin(org, eq(org.id, membership.orgId))
      .where(eq(membership.id, membershipId))
    if (!row) throw new Error('роль без организации: доверенность не к чему привязать')
    const cur = await this.current(membershipId)
    return { orgInn: row.o.inn, orgName: row.o.name, personName: row.p.name, repInn: cur?.repInn ?? null }
  }

  private async save(membershipId: string, values: Omit<typeof poa.$inferInsert, 'membershipId'>) {
    return this.db.transaction(async (tx) => {
      await tx.update(poa).set({ replacedAt: new Date() }).where(and(eq(poa.membershipId, membershipId), isNull(poa.replacedAt)))
      const [row] = await tx.insert(poa).values({ ...values, membershipId }).returning()
      // зеркало для экранов бота и мини-приложения, которые показывают номер и срок
      await tx.update(membership).set({ signerKind: 'employee', canSign: true, poaNumber: values.number, poaValidTo: values.validTo }).where(eq(membership.id, membershipId))
      return row!
    })
  }
}
