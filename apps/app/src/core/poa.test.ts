import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DemoCa, gostAvailable } from '@nk/etrn'
import { poaSampleXml, SAMPLE_HEAD, SAMPLE_REP } from '../../../../packages/etrn/src/testing/poa-sample.ts'
import { openDb, readSeed } from '../db/boot.ts'
import { membership, org, person, poa } from '../db/schema.ts'
import { resetDemo } from '../db/seed.ts'
import { PoaService } from './poa.ts'

// МЧД подписантов на настоящей базе (HAKATON-49). Нужна TEST_DATABASE_URL — база стирается.
const url = process.env.TEST_DATABASE_URL
const enc = (s: string) => new TextEncoder().encode(s)
const ORG = '9782242514'
const now = new Date('2026-09-29T09:00:00Z')
const gost = await gostAvailable()

describe.skipIf(!url)('МЧД подписантов', () => {
  let conn: Awaited<ReturnType<typeof openDb>>
  let svc: PoaService
  let orgId: string, marinaId: string, bossId: string, marinaM: string, bossM: string
  let dir = ''

  beforeAll(async () => {
    conn = await openDb(url!)
    await resetDemo(conn.db, await readSeed())
    const db = conn.db
    dir = await mkdtemp(join(tmpdir(), 'nk-poa-svc-'))
    svc = new PoaService(db, { pki: gost ? new DemoCa(dir) : null, registry: null })
    const [o] = await db.insert(org).values({ inn: ORG, name: 'ООО «Волжский завод моторных масел»', address: 'Елабуга' }).returning()
    orgId = o!.id
    const [a, b] = await db.insert(person).values([{ maxUserId: 201, name: 'Марина Соколова' }, { maxUserId: 202, name: 'Рустам Галиев' }]).returning()
    marinaId = a!.id
    bossId = b!.id
    const [m1, m2] = await db
      .insert(membership)
      .values([
        { personId: marinaId, role: 'shipper', orgId, isAdmin: false },
        { personId: bossId, role: 'consignee', orgId, isAdmin: true },
      ])
      .returning()
    marinaM = m1!.id
    bossM = m2!.id
  })
  afterAll(async () => {
    await conn.pool.end()
    await rm(dir, { recursive: true, force: true })
  })

  it('пока не спросили, кто подписывает, — подписать нельзя: сначала вопрос', async () => {
    expect(await svc.gate(marinaId, 'shipper', null, now)).toMatchObject({ ok: false, reason: 'ask_kind', membershipId: marinaM })
  })

  it('руководитель подписывает без доверенности', async () => {
    await svc.setSignerKind(bossM, 'head')
    expect(await svc.gate(bossId, 'consignee', null, now)).toEqual({ ok: true, authority: { kind: 'head' } })
  })

  it('сотрудник без доверенности — подписать нельзя, бот её попросит', async () => {
    await svc.setSignerKind(marinaM, 'employee')
    expect(await svc.gate(marinaId, 'shipper', null, now)).toMatchObject({ ok: false, reason: 'no_poa' })
  })

  it('файл МЧД другой компании или на другого человека не принимаем и ничего не сохраняем', async () => {
    const other = await svc.addFromFile({ membershipId: marinaM, file: enc(poaSampleXml({ orgInn: '1167049238', orgName: 'ООО «Волга»' })), now })
    expect(other).toMatchObject({ ok: false, poa: null })
    expect(other.error).toMatch(/другой компанией/)
    const stranger = await svc.addFromFile({ membershipId: marinaM, file: enc(poaSampleXml({ rep: { ...SAMPLE_REP, surname: 'Петрова', name: 'Анна' } })), now })
    expect(stranger.error).toMatch(/не вам/)
    expect(await svc.addFromFile({ membershipId: marinaM, file: enc('<Файл/>'), now })).toMatchObject({ ok: false })
    expect(await conn.db.select().from(poa)).toEqual([])
  })

  it('действующий файл МЧД: сохраняем реквизиты, представителя и зеркало номера и срока в роли', async () => {
    const r = await svc.addFromFile({ membershipId: marinaM, file: enc(poaSampleXml()), now })
    expect(r.error).toBeNull()
    expect(r.poa).toMatchObject({ number: '4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f', source: 'file', principalInn: ORG, repName: 'Соколова Марина Андреевна', repInn: SAMPLE_REP.inn, signatureOk: null })
    const [m] = await conn.db.select().from(membership).where(eq(membership.id, marinaM))
    expect(m).toMatchObject({ signerKind: 'employee', canSign: true, poaNumber: '4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f' })
    expect(m!.poaValidTo!.toISOString().slice(0, 10)).toBe('2026-10-31')
    const g = await svc.gate(marinaId, 'shipper', null, now)
    expect(g).toMatchObject({ ok: true, authority: { kind: 'poa', number: '4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f', internalNumber: 'МЧД-2026-000417' } })
  })

  it('подписал по доверенности не тот человек — отказ; тот — годится', async () => {
    expect(await svc.signerMatches(marinaId, 'shipper', null, { fullName: 'Романов Олег', personInn: '500100732259', snils: null })).toMatchObject({ ok: false })
    expect(await svc.signerMatches(marinaId, 'shipper', null, { fullName: 'Соколова Марина Андреевна', personInn: null, snils: null })).toMatchObject({ ok: true })
    expect(await svc.signerMatches(marinaId, 'shipper', null, { fullName: 'кто угодно', personInn: SAMPLE_REP.inn, snils: null })).toMatchObject({ ok: true })
  })

  it('срок кончился — подписать нельзя', async () => {
    expect(await svc.gate(marinaId, 'shipper', null, new Date('2026-11-01T09:00:00Z'))).toMatchObject({ ok: false, reason: 'expired' })
  })

  it('номер вручную: проверки формата и дат; новая доверенность заменяет старую, старая остаётся в истории', async () => {
    const bad = await svc.addManual({ membershipId: marinaM, number: 'МЧД-1', issuedAt: new Date('2026-09-01'), validTo: new Date('2027-01-01'), now })
    expect(bad.error).toMatch(/выглядит так/)
    const future = await svc.addManual({ membershipId: marinaM, number: '11111111-2222-4333-8444-555555555555', issuedAt: new Date('2026-10-05'), validTo: new Date('2027-01-01'), now })
    expect(future.error).toMatch(/не наступила/)
    const ok = await svc.addManual({ membershipId: marinaM, number: '11111111-2222-4333-8444-555555555555', issuedAt: new Date('2026-09-20'), validTo: new Date('2027-03-31'), now })
    expect(ok).toMatchObject({ ok: true, poa: { source: 'manual', repName: 'Марина Соколова' } })
    const all = await conn.db.select().from(poa).where(eq(poa.membershipId, marinaM))
    expect(all).toHaveLength(2)
    expect(all.filter((x) => x.replacedAt === null).map((x) => x.number)).toEqual(['11111111-2222-4333-8444-555555555555'])
  })

  it.skipIf(!gost)('файл с подписью руководителя: подпись проверена; подпись не руководителя — не принимаем', async () => {
    const ca = new DemoCa(dir)
    const file = enc(poaSampleXml())
    const head = { surname: SAMPLE_HEAD.surname, givenName: SAMPLE_HEAD.name, inn: SAMPLE_HEAD.inn, snils: SAMPLE_HEAD.snils }
    // подпись демо-УЦ ставит настоящее время — и проверяем относительно настоящего «сейчас»
    const good = await svc.addFromFile({ membershipId: marinaM, file, sig: await ca.sign(file, { inn: ORG, name: 'Завод', head }) })
    expect(good.checks.filter((c) => !c.ok)).toEqual([])
    expect(good).toMatchObject({ ok: true, poa: { signatureOk: true } })
    const wrong = await svc.addFromFile({ membershipId: marinaM, file, sig: await ca.sign(file, { inn: ORG, name: 'Завод', head: { ...head, surname: 'Романов', inn: '500100732259', snils: '123-456-789 64' } }) })
    expect(wrong.ok).toBe(false)
    expect(wrong.error).toMatch(/подпись руководителя/)
  }, 60_000)
})
