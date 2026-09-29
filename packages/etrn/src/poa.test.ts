import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DemoCa } from './demo-ca.ts'
import { encode1251 } from './format.ts'
import { gostAvailable } from './openssl.ts'
import { checkPoa, parsePoa, PoaFormatError, samePerson, verifyPoaSignature } from './poa.ts'
import { poaSampleXml, SAMPLE_HEAD, SAMPLE_REP } from './testing/poa-sample.ts'
import { validatePoaXml } from './testing/xsd.ts'

const enc = (s: string) => new TextEncoder().encode(s)
const ORG = '9782242514'
const now = new Date('2026-09-29T09:00:00Z')
const ctx = { orgInn: ORG, personName: 'Марина Соколова', now }
const failed = (r: ReturnType<typeof checkPoa>) => r.checks.filter((c) => !c.ok).map((c) => c.name)

describe('МЧД: разбор файла формата 003', () => {
  it('образец проходит официальную XSD ФНС', async () => {
    const r = await validatePoaXml(poaSampleXml())
    expect(r.errors).toEqual([])
    expect(r.valid).toBe(true)
  })

  it('достаём номер, сроки, доверителя с руководителем, представителя и полномочия', () => {
    const poa = parsePoa(enc(poaSampleXml()))
    expect(poa).toMatchObject({
      version: 'EMCHD_1',
      number: '4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
      internalNumber: 'МЧД-2026-000417',
      issuedAt: '2026-09-01',
      validTo: '2026-10-31',
      retrust: false,
    })
    expect(poa.principals).toEqual([
      expect.objectContaining({ kind: 'org', inn: ORG, kpp: '165001001', head: expect.objectContaining({ surname: 'Галиев', inn: SAMPLE_HEAD.inn, snils: '11223344595', position: 'Генеральный директор' }) }),
    ])
    expect(poa.representatives[0]).toMatchObject({ kind: 'person', person: { surname: 'Соколова', name: 'Марина', inn: SAMPLE_REP.inn, snils: '12345678964' } })
    expect(poa.powers.machine[0]!.name).toContain('транспортной накладной')
  })

  it('номер приводится к нижнему регистру, windows-1251 тоже читается', () => {
    const xml = poaSampleXml({ number: '4F1C2D3E-5A6B-4C7D-8E9F-0A1B2C3D4E5F' }).replace('encoding="UTF-8"', 'encoding="windows-1251"')
    expect(parsePoa(encode1251(xml)).number).toBe('4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f')
  })

  it('не МЧД, старый формат и битый XML — понятный отказ', () => {
    expect(() => parsePoa(enc('<Файл/>'))).toThrow(PoaFormatError)
    expect(() => parsePoa(enc(poaSampleXml().replace('ВерсФорм="EMCHD_1"', 'ВерсФорм="002"')))).toThrow(/формат 003/)
    expect(() => parsePoa(enc('<Доверенность'))).toThrow(PoaFormatError)
  })
})

describe('МЧД: проверка для компании и человека', () => {
  it('действующая доверенность своей компании на этого человека — всё зелёное', () => {
    const r = checkPoa(parsePoa(enc(poaSampleXml())), ctx)
    expect(failed(r)).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.daysLeft).toBe(32)
    expect(r.representative?.surname).toBe('Соколова')
    expect(r.checks.find((c) => c.name === 'powers')).toMatchObject({ ok: true, level: 'info' })
  })

  it('истёкшая, выданная задним числом и ещё не начавшаяся', () => {
    expect(failed(checkPoa(parsePoa(enc(poaSampleXml({ validTo: '2026-09-28' }))), ctx))).toEqual(['valid_to'])
    expect(failed(checkPoa(parsePoa(enc(poaSampleXml({ issuedAt: '2026-10-01' }))), ctx))).toEqual(['issued'])
  })

  it('последний день срока ещё годится, за 14 дней — предупреждение', () => {
    const last = checkPoa(parsePoa(enc(poaSampleXml({ validTo: '2026-09-29' }))), ctx)
    expect(last.ok).toBe(true)
    expect(last.checks.find((c) => c.name === 'valid_to')).toMatchObject({ level: 'warning' })
    expect(last.daysLeft).toBe(0)
  })

  it('чужая компания и чужой человек', () => {
    const other = checkPoa(parsePoa(enc(poaSampleXml({ orgInn: '1167049238', orgName: 'ООО «Волга»' }))), ctx)
    expect(failed(other)).toEqual(['principal'])
    expect(other.checks.find((c) => c.name === 'principal')!.message).toContain('ООО «Волга»')
    expect(failed(checkPoa(parsePoa(enc(poaSampleXml())), { ...ctx, personName: 'Олег Романов' }))).toEqual(['representative'])
  })

  it('представителя узнаём по ИНН или СНИЛС точнее, чем по имени', () => {
    const poa = parsePoa(enc(poaSampleXml()))
    expect(failed(checkPoa(poa, { ...ctx, personName: 'Марина', personInn: SAMPLE_REP.inn }))).toEqual([])
    expect(failed(checkPoa(poa, { ...ctx, personInn: '500100732259' }))).toEqual(['representative'])
    expect(samePerson(poa.representatives[0]!.person!, { name: 'соколова марина' })).toBe(true)
    expect(samePerson(poa.representatives[0]!.person!, { name: 'Марина Петрова' })).toBe(false)
  })

  it('полномочия без перевозочных документов — предупреждение, а не отказ', () => {
    const r = checkPoa(parsePoa(enc(poaSampleXml({ powerName: 'Представление налоговой отчётности' }))), ctx)
    expect(r.ok).toBe(true)
    expect(r.checks.find((c) => c.name === 'powers')).toMatchObject({ ok: true, level: 'warning' })
  })
})

const gost = await gostAvailable()

describe.skipIf(!gost)('МЧД: подпись руководителя под файлом', () => {
  let dir = ''
  let ca: DemoCa
  const org = { inn: ORG, name: 'ООО «Волжский завод моторных масел»' }
  const head = { surname: SAMPLE_HEAD.surname, givenName: SAMPLE_HEAD.name, inn: SAMPLE_HEAD.inn, snils: SAMPLE_HEAD.snils }
  const file = enc(poaSampleXml())
  const poa = parsePoa(file)

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nk-poa-'))
    ca = new DemoCa(dir)
  }, 60_000)
  afterAll(() => rm(dir, { recursive: true, force: true }))

  it('подписал руководитель своей УКЭП — подпись и «подписал руководитель» зелёные', async () => {
    const sig = await ca.sign(file, { ...org, head })
    const r = await verifyPoaSignature({ poa, file, sig, orgInn: ORG, pki: ca })
    expect(r.signature.checks.filter((c) => !c.ok)).toEqual([])
    expect(r.signerIsHead).toMatchObject({ ok: true })
    expect(r.ok).toBe(true)
    expect(r.signature.signer).toMatchObject({ snils: '11223344595', personInn: SAMPLE_HEAD.inn })
  }, 60_000)

  it('подписал другой человек той же компании — отказ', async () => {
    const other = { surname: 'Романов', givenName: 'Олег', inn: '165007654394', snils: '123-456-789 64' }
    const r = await verifyPoaSignature({ poa, file, sig: await ca.sign(file, { ...org, head: other }), orgInn: ORG, pki: ca })
    expect(r.signature.ok).toBe(true)
    expect(r.signerIsHead.ok).toBe(false)
    expect(r.ok).toBe(false)
  }, 60_000)

  it('файл поменяли после подписи — отказ по хешу', async () => {
    const sig = await ca.sign(file, { ...org, head })
    const changed = enc(poaSampleXml({ validTo: '2027-12-31' }))
    const r = await verifyPoaSignature({ poa: parsePoa(changed), file: changed, sig, orgInn: ORG, pki: ca })
    expect(r.signature.checks.find((c) => c.name === 'digest')!.ok).toBe(false)
    expect(r.ok).toBe(false)
  }, 60_000)
})
