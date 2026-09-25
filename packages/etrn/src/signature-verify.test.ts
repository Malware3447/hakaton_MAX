import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { gostAvailable } from './openssl.ts'
import { FilePkiStore, type Fetch } from './pki.ts'
import { gostDigest, peekSignature, verifyGoskeySignature, type GoskeyVerification, type VerifyInput } from './signature-verify.ts'
import { TestPki, type TestCert } from './testing/gost-pki.ts'

// Без движка gost (нет libengine-gost-openssl или OPENSSL_ENGINES) проверять нечем — тесты пропускаются.
const gost = await gostAvailable()

const SHIPPER_INN = '7707083893'
const OTHER_INN = '7736207543'
const doc = new TextEncoder().encode('<?xml version="1.0" encoding="windows-1251"?><Файл ИдФайл="ON_TRNACLGROT_test"/>')

const failed = (r: GoskeyVerification) => r.checks.filter((c) => !c.ok).map((c) => c.name)

describe.skipIf(!gost)('проверка подписи «Госключа»', () => {
  let dir: string
  let pki: TestPki
  let store: FilePkiStore
  let unepRoot: TestCert, unepCa: TestCert, ukepRoot: TestCert, ukepCa: TestCert, strangerRoot: TestCert
  let unepUser: TestCert, ukepUser: TestCert, ukepOther: TestCert, revokedUser: TestCert, strangerUser: TestCert, encryptOnly: TestCert
  const net = new Map<string, Uint8Array>()
  const fetched: string[] = []

  const input = (over: Partial<VerifyInput>): VerifyInput => ({ document: doc, sig: new Uint8Array(), expectedInn: SHIPPER_INN, pki: store, ...over })

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nk-pki-test-'))
    pki = new TestPki(join(dir, 'ca'))
    unepRoot = await pki.root('Тест СЦС')
    unepCa = await pki.intermediate('Тест Госуслуги НЭП', unepRoot)
    ukepRoot = await pki.root('Тест Минцифры')
    ukepCa = await pki.intermediate('Тест аккредитованный УЦ', ukepRoot)
    strangerRoot = await pki.root('Чужой УЦ')
    unepUser = await pki.person('unep', '/C=RU/SN=Антонов/GN=Егор Сергеевич/SNILS=12345678901/CN=Антонов Егор Сергеевич', unepCa)
    ukepUser = await pki.person('ukep', `/C=RU/O=ООО Завод/INNLE=${SHIPPER_INN}/OGRN=1027700132195/SNILS=12345678901/SN=Петров/GN=Пётр/CN=Петров Пётр`, ukepCa)
    ukepOther = await pki.person('ukep-other', `/C=RU/O=ООО Другой/INNLE=${OTHER_INN}/CN=Сидоров Сидор`, ukepCa)
    revokedUser = await pki.person('revoked', '/C=RU/CN=Отозванный', unepCa)
    strangerUser = await pki.person('stranger', '/C=RU/CN=Чужой', strangerRoot)
    encryptOnly = await pki.person('encrypt', '/C=RU/CN=Шифровальщик', unepCa, 'keyEncipherment')
    await pki.revoke(unepCa, revokedUser)

    // «сеть»: списки отзыва и сертификат промежуточного УЦ УКЭП по адресу из сертификата (AIA)
    net.set(unepRoot.crlUrl, await pki.crl(unepRoot))
    net.set(unepCa.crlUrl, await pki.crl(unepCa))
    net.set(ukepRoot.crlUrl, await pki.crl(ukepRoot))
    net.set(ukepCa.crlUrl, await pki.crl(ukepCa))
    net.set(ukepCa.caUrl, await pki.certDer(ukepCa))

    const certsDir = join(dir, 'certs')
    for (const [sub, t] of [['unep', unepRoot], ['ukep', ukepRoot], ['intermediate', unepCa]] as const) {
      await mkdir(join(certsDir, sub), { recursive: true })
      await writeFile(join(certsDir, sub, `${t.name}.pem`), await readFile(t.cert))
    }
    const fetch: Fetch = async (url) => {
      fetched.push(url)
      const b = net.get(url)
      if (!b) throw new Error('404')
      return b
    }
    store = new FilePkiStore({ certsDir, cacheDir: join(dir, 'cache'), fetch })
  }, 120_000)

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('УНЭП с введённым ИНН: все проверки пройдены', async () => {
    const sig = await pki.sign(doc, unepUser)
    const r = await verifyGoskeySignature(input({ sig, declaredInn: SHIPPER_INN, sentAt: new Date(Date.now() - 60_000) }))
    expect(failed(r)).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.level).toBe('unep')
    expect(r.signer).toMatchObject({ fullName: 'Антонов Егор Сергеевич', snils: '12345678901', inn: SHIPPER_INN, innSource: 'declared' })
    expect(r.checks.map((c) => c.name)).toHaveLength(10)
  })

  it('УНЭП без введённого ИНН — отказ', async () => {
    const r = await verifyGoskeySignature(input({ sig: await pki.sign(doc, unepUser) }))
    expect(failed(r)).toEqual(['inn'])
  })

  it('УНЭП: введён чужой или неверный ИНН — отказ', async () => {
    const sig = await pki.sign(doc, unepUser)
    expect(failed(await verifyGoskeySignature(input({ sig, declaredInn: OTHER_INN })))).toEqual(['inn'])
    expect(failed(await verifyGoskeySignature(input({ sig, declaredInn: '7707083894' })))).toEqual(['inn'])
  })

  it('УКЭП: ИНН берём из сертификата, вводить не нужно; промежуточный УЦ скачан по адресу из сертификата', async () => {
    const r = await verifyGoskeySignature(input({ sig: await pki.sign(doc, ukepUser) }))
    expect(failed(r)).toEqual([])
    expect(r.level).toBe('ukep')
    expect(r.signer).toMatchObject({ inn: SHIPPER_INN, innSource: 'certificate', organization: 'ООО Завод', ogrn: '1027700132195' })
    expect(fetched).toContain(ukepCa.caUrl)
  })

  it('УКЭП: введённый ИНН не подменяет ИНН из сертификата', async () => {
    const r = await verifyGoskeySignature(input({ sig: await pki.sign(doc, ukepOther), declaredInn: SHIPPER_INN }))
    expect(failed(r)).toEqual(['inn'])
    expect(r.checks.find((c) => c.name === 'inn')?.message).toContain(OTHER_INN)
  })

  it('подписан изменённый документ — отказ по хешу и подписи', async () => {
    const sig = await pki.sign(doc, unepUser)
    const changed = new Uint8Array(doc)
    changed[changed.length - 3]! ^= 1
    const r = await verifyGoskeySignature(input({ sig, document: changed, declaredInn: SHIPPER_INN }))
    expect(failed(r)).toEqual(['digest', 'signature'])
  })

  it('сертификат чужого УЦ — отказ по цепочке', async () => {
    const r = await verifyGoskeySignature(input({ sig: await pki.sign(doc, strangerUser), declaredInn: SHIPPER_INN }))
    expect(r.ok).toBe(false)
    expect(failed(r)).toContain('chain')
    expect(r.level).toBeNull()
  })

  it('отозванный сертификат — отказ', async () => {
    const r = await verifyGoskeySignature(input({ sig: await pki.sign(doc, revokedUser), declaredInn: SHIPPER_INN }))
    expect(failed(r)).toEqual(['revocation'])
    expect(r.checks.find((c) => c.name === 'revocation')?.message).toBe('сертификат отозван')
  })

  it('список отзыва недоступен — отказ, а не пропуск', async () => {
    const offline = new FilePkiStore({ certsDir: join(dir, 'certs'), cacheDir: join(dir, 'cache-offline'), fetch: async () => { throw new Error('нет сети') } })
    const r = await verifyGoskeySignature(input({ sig: await pki.sign(doc, unepUser), declaredInn: SHIPPER_INN, pki: offline }))
    expect(failed(r)).toEqual(['revocation'])
  })

  it('подпись сделана раньше, чем титул отправили — отказ', async () => {
    const r = await verifyGoskeySignature(input({ sig: await pki.sign(doc, unepUser), declaredInn: SHIPPER_INN, sentAt: new Date(Date.now() + 3_600_000) }))
    expect(failed(r)).toEqual(['signing_time'])
  })

  it('подпись в будущем по часам сервера — отказ', async () => {
    const r = await verifyGoskeySignature(input({ sig: await pki.sign(doc, unepUser), declaredInn: SHIPPER_INN, now: new Date(Date.now() - 3_600_000) }))
    expect(failed(r)).toContain('signing_time')
  })

  it('ключ не для подписи — отказ', async () => {
    const r = await verifyGoskeySignature(input({ sig: await pki.sign(doc, encryptOnly), declaredInn: SHIPPER_INN }))
    expect(failed(r)).toEqual(['key_usage'])
  })

  it('два подписанта — отказ', async () => {
    const r = await verifyGoskeySignature(input({ sig: await pki.sign(doc, unepUser, ukepUser), declaredInn: SHIPPER_INN }))
    expect(failed(r)).toEqual(['single_signer'])
  })

  it('не подпись вовсе — отказ по формату, остальное не проверялось', async () => {
    const r = await verifyGoskeySignature(input({ sig: new TextEncoder().encode('это не подпись') }))
    expect(r.ok).toBe(false)
    expect(failed(r)).toHaveLength(10)
    expect(r.checks[0]).toMatchObject({ name: 'format', ok: false })
  })

  it('по хешу из .sig находится подписанный титул', async () => {
    const sig = await pki.sign(doc, unepUser)
    expect(peekSignature(sig)?.messageDigest).toBe(await gostDigest(doc))
    expect(peekSignature(new Uint8Array([1, 2, 3]))).toBeNull()
  })
})

// Настоящая подпись «Госключа»: файлы с личными данными в репозиторий не кладём,
// путь задаётся переменными GOSKEY_SAMPLE_DOC, GOSKEY_SAMPLE_SIG и GOSKEY_SAMPLE_INN (ИНН, который «ввёл» подписант).
const sampleDoc = process.env.GOSKEY_SAMPLE_DOC
const sampleSig = process.env.GOSKEY_SAMPLE_SIG
describe.skipIf(!gost || !sampleDoc || !sampleSig || !existsSync(sampleDoc) || !existsSync(sampleSig))('настоящая подпись «Госключа»', () => {
  it('проходит все проверки с корнями из certs/goskey', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'nk-goskey-'))
    try {
      const inn = process.env.GOSKEY_SAMPLE_INN ?? SHIPPER_INN
      const r = await verifyGoskeySignature({
        document: readFileSync(sampleDoc!),
        sig: readFileSync(sampleSig!),
        expectedInn: inn,
        declaredInn: inn,
        pki: new FilePkiStore({ certsDir: new URL('../../../certs/goskey', import.meta.url).pathname, cacheDir }),
      })
      expect(r.checks.filter((c) => !c.ok)).toEqual([])
      expect(r.level).toBe('unep')
    } finally {
      await rm(cacheDir, { recursive: true, force: true })
    }
  }, 120_000)
})
