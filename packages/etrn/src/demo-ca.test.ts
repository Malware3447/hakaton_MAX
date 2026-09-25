import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEMO_CA_NAME, DemoCa } from './demo-ca.ts'
import { gostAvailable } from './openssl.ts'
import { FilePkiStore } from './pki.ts'
import { verifyGoskeySignature } from './signature-verify.ts'

const gost = await gostAvailable()
const org = { inn: '9782242514', name: 'ООО «Пермский завод/смазок»' }
const doc = new TextEncoder().encode('<Файл ИдФайл="ON_TRNACLGROT_demo"/>')

describe.skipIf(!gost)('демо-УЦ (модель)', () => {
  let dir = ''
  let ca: DemoCa
  let sig: Uint8Array

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nk-demo-ca-'))
    ca = new DemoCa(dir)
    sig = await ca.sign(doc, org)
  }, 60_000)
  afterAll(() => rm(dir, { recursive: true, force: true }))

  it('подпись проходит нашу же проверку: все пункты, ИНН из сертификата', async () => {
    const res = await ca.verify({ document: doc, sig, expectedInn: org.inn })
    expect(res.checks.filter((c) => !c.ok)).toEqual([])
    expect(res.ok).toBe(true)
    expect(res.signer).toMatchObject({ inn: org.inn, innSource: 'certificate', organization: org.name, certIssuer: DEMO_CA_NAME })
    expect(res.checks.find((c) => c.name === 'chain')!.message).toContain(DEMO_CA_NAME)
  })

  it('чужой ИНН и изменённый документ — отказ', async () => {
    expect((await ca.verify({ document: doc, sig, expectedInn: '7707083893' })).checks.find((c) => c.name === 'inn')!.ok).toBe(false)
    const other = new TextEncoder().encode('<Файл ИдФайл="другой"/>')
    expect((await ca.verify({ document: other, sig, expectedInn: org.inn })).checks.find((c) => c.name === 'digest')!.ok).toBe(false)
  })

  it('ИП: ИНН из 12 цифр в поле ИНН сертификата', async () => {
    const ip = { inn: '500100732259', name: 'ИП Смирнов А. В.' }
    const res = await ca.verify({ document: doc, sig: await ca.sign(doc, ip), expectedInn: ip.inn })
    expect(res.ok).toBe(true)
    expect(res.signer?.inn).toBe(ip.inn)
  })

  it('корни «Госключа» демо-подпись не принимают', async () => {
    const certsDir = fileURLToPath(new URL('../../../certs/goskey', import.meta.url))
    const pki = new FilePkiStore({ certsDir, cacheDir: join(dir, 'cache'), fetch: async () => new Uint8Array() })
    const res = await verifyGoskeySignature({ document: doc, sig, expectedInn: org.inn, pki })
    expect(res.ok).toBe(false)
    expect(res.checks.find((c) => c.name === 'chain')!.ok).toBe(false)
  })

  it('ключи создаются один раз и закрыты от чужих глаз; второй экземпляр берёт тот же корень', async () => {
    expect((await stat(join(dir, 'root', 'key.pem'))).mode & 0o077).toBe(0)
    const again = new DemoCa(dir)
    expect(Buffer.from((await again.root()).der).equals(Buffer.from((await ca.root()).der))).toBe(true)
    expect((await again.verify({ document: doc, sig, expectedInn: org.inn })).ok).toBe(true)
  })
})
