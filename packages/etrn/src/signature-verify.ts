// Проверка подписи «Госключа» (УНЭП или УКЭП) под титулом: .sig — отсоединённая CMS,
// документ — наш XML титула байт в байт. Документ от подписанта не берём: подписать могли изменённый.
//
// Проверяем все пункты и отказываем при любом провале:
// формат, один подписант, хеш документа, подпись, цепочка до наших корней, отзыв,
// срок сертификата на момент подписи, время подписи, назначение ключа, ИНН.
// ИНН: у УКЭП — из сертификата; у УНЭП в сертификате ИНН нет, его вводит подписант.

import { isValidInn, normalizeInn } from '@nk/domain'
import { DIGESTS, OID, hex, readSignedData, signerCertificate, toPem, type CertInfo, type SignedData } from './cms.ts'
import { gostAvailable, openssl, opensslReason, withTempDir } from './openssl.ts'
import { PkiError, type PkiStore } from './pki.ts'

export const CHECKS = [
  'format',
  'single_signer',
  'digest',
  'signature',
  'chain',
  'revocation',
  'validity',
  'signing_time',
  'key_usage',
  'inn',
] as const
export type CheckName = (typeof CHECKS)[number]

export interface Check {
  name: CheckName
  ok: boolean
  /** причина по-русски, её можно показать человеку */
  message: string
}

export type SignatureLevel = 'unep' | 'ukep'

export interface Signer {
  fullName: string | null
  surname: string | null
  givenName: string | null
  snils: string | null
  organization: string | null
  /** ИНН, который сверяли с грузоотправителем */
  inn: string | null
  /** certificate — из сертификата (УКЭП), declared — ввёл подписант (УНЭП) */
  innSource: 'certificate' | 'declared' | null
  ogrn: string | null
  certSerial: string
  certIssuer: string | null
  certNotBefore: string
  certNotAfter: string
  /** сертификат подписанта в base64 — сохранить вместе с подписью */
  certificate: string
}

export interface GoskeyVerification {
  ok: boolean
  level: SignatureLevel | null
  signer: Signer | null
  signingTime: string | null
  /** хеш документа из подписи (hex): по нему ищем, какой титул подписали */
  messageDigest: string | null
  checks: Check[]
}

export interface VerifyInput {
  /** наш XML титула, ровно те байты, что отправили подписанту */
  document: Uint8Array
  /** присланный .sig */
  sig: Uint8Array
  /** ИНН грузоотправителя (или того, кто подписывает титул) из титула */
  expectedInn: string
  /** ИНН, который ввёл подписант; нужен только для УНЭП */
  declaredInn?: string | null
  /** когда титул отправили на подпись: подпись раньше этого момента — чужая */
  sentAt?: Date | null
  now?: Date
  pki: PkiStore
}

/** Допуск на расхождение часов телефона и сервера. */
const CLOCK_SKEW_MS = 5 * 60_000

/** ИНН из сертификата УКЭП: юрлица — 10 цифр (у старых сертификатов 00 + 10), ИП — 12. */
export function certificateInn(cert: CertInfo): string | null {
  const le = cert.subject[OID.innLe]
  if (le) return normalizeInn(le)
  const inn = cert.subject[OID.inn]
  if (!inn) return null
  const s = normalizeInn(inn)
  return s?.startsWith('00') ? s.slice(2) : s
}

/** Хеш документа и сведения о подписанте без проверки: чтобы найти, к какому титулу пришёл .sig. */
export function peekSignature(sig: Uint8Array): { messageDigest: string; digestAlgorithm: string } | null {
  try {
    const s = readSignedData(sig).signers[0]
    return s?.messageDigest ? { messageDigest: hex(s.messageDigest), digestAlgorithm: s.digestAlgorithm } : null
  } catch {
    return null
  }
}

/** Хеш документа тем же алгоритмом, что в подписи (ГОСТ 34.11-2012). */
export async function gostDigest(document: Uint8Array, digestAlgorithm: string = OID.gost2012_256): Promise<string> {
  const md = DIGESTS[digestAlgorithm]
  if (!md) throw new Error(`неизвестный алгоритм хеша ${digestAlgorithm}`)
  return withTempDir(async (put) => {
    const r = await openssl(['dgst', '-engine', 'gost', `-${md}`, '-binary', await put('doc', document)])
    if (!r.ok) throw new Error(opensslReason(r))
    return hex(r.stdout)
  })
}

/** Цепочка от сертификата подписанта вверх до самоподписанного корня. */
async function buildChain(leaf: CertInfo, pki: PkiStore): Promise<{ chain: CertInfo[]; extra: CertInfo[] }> {
  const chain = [leaf]
  const extra: CertInfo[] = []
  let cur = leaf
  for (let depth = 0; depth < 6 && !cur.selfIssued; depth++) {
    const issuers = await pki.issuersOf(cur)
    if (!issuers.length) break
    // несколько кандидатов — отдаём все openssl, он выберет по подписи
    extra.push(...issuers.slice(1))
    cur = issuers[0]!
    chain.push(cur)
  }
  return { chain, extra }
}

const sameCert = (a: CertInfo, b: CertInfo) => a.der.length === b.der.length && a.der.every((x, i) => x === b.der[i])

const iso = (d: Date) => d.toISOString()

export async function verifyGoskeySignature(input: VerifyInput): Promise<GoskeyVerification> {
  const now = input.now ?? new Date()
  const checks: Check[] = []
  const add = (name: CheckName, ok: boolean, message: string) => checks.push({ name, ok, message })
  const result = (level: SignatureLevel | null, signer: Signer | null, signingTime: Date | null, digest: Uint8Array | null): GoskeyVerification => {
    // проверки, до которых не дошли, считаем проваленными: отказ должен быть видно
    for (const name of CHECKS) if (!checks.some((c) => c.name === name)) add(name, false, 'не проверялось: предыдущая проверка не прошла')
    checks.sort((a, b) => CHECKS.indexOf(a.name) - CHECKS.indexOf(b.name))
    return {
      ok: checks.every((c) => c.ok),
      level,
      signer,
      signingTime: signingTime ? iso(signingTime) : null,
      messageDigest: digest ? hex(digest) : null,
      checks,
    }
  }

  if (!(await gostAvailable())) {
    add('format', false, 'на сервере нет движка ГОСТ для openssl (пакет libengine-gost-openssl)')
    return result(null, null, null, null)
  }

  // 1. Формат
  let sd: SignedData
  try {
    sd = readSignedData(input.sig)
  } catch (e) {
    add('format', false, `файл не похож на подпись CMS: ${(e as Error).message}`)
    return result(null, null, null, null)
  }
  const signerInfo = sd.signers[0]
  const cert = signerInfo ? signerCertificate(sd, signerInfo) : null
  const md = signerInfo ? DIGESTS[signerInfo.digestAlgorithm] : undefined
  if (!signerInfo || !cert || !md || !sd.detached || !signerInfo.messageDigest) {
    const why = !signerInfo
      ? 'в подписи нет подписанта'
      : !cert
        ? 'в подписи нет сертификата подписанта'
        : !md
          ? `хеш не ГОСТ 34.11-2012 (${signerInfo.digestAlgorithm})`
          : !sd.detached
            ? 'подпись присоединённая, а ждём отсоединённую .sig'
            : 'в подписи нет хеша документа'
    add('format', false, why)
    return result(null, null, signerInfo?.signingTime ?? null, signerInfo?.messageDigest ?? null)
  }
  add('format', true, 'отсоединённая подпись CMS, хеш ГОСТ 34.11-2012')

  // 2. Один подписант
  add('single_signer', sd.signers.length === 1, sd.signers.length === 1 ? 'один подписант' : `подписантов ${sd.signers.length}, ждём одного`)

  const signingTime = signerInfo.signingTime
  const digest = signerInfo.messageDigest

  await withTempDir(async (put) => {
    const docPath = await put('doc', input.document)
    const sigPath = await put('doc.sig', input.sig)

    // 3. Хеш документа
    const d = await openssl(['dgst', '-engine', 'gost', `-${md}`, '-binary', docPath])
    const docDigest = d.ok ? hex(d.stdout) : null
    const same = docDigest === hex(digest)
    add('digest', same, same ? 'подписан именно этот титул' : docDigest ? 'подписан другой документ: хеш не совпадает с нашим титулом' : `не удалось посчитать хеш: ${opensslReason(d)}`)

    // 4. Подпись (математика): без проверки цепочки
    const v = await openssl(['cms', '-verify', '-engine', 'gost', '-binary', '-inform', 'DER', '-in', sigPath, '-content', docPath, '-noverify', '-out', '/dev/null'])
    add('signature', v.ok, v.ok ? 'подпись верна' : `подпись неверна: ${opensslReason(v)}`)
  })

  // 5–6. Цепочка и отзыв
  const anchors = await input.pki.anchors()
  const { chain, extra } = await buildChain(cert, input.pki)
  const top = chain[chain.length - 1]!
  const level: SignatureLevel | null = anchors.ukep.some((a) => sameCert(a, top)) ? 'ukep' : anchors.unep.some((a) => sameCert(a, top)) ? 'unep' : null
  if (!level) {
    add('chain', false, `сертификат выдан не «Госключом» и не аккредитованным УЦ: цепочка обрывается на «${top.subject[OID.commonName] ?? '?'}»`)
  } else {
    const trusted = level === 'ukep' ? anchors.ukep : anchors.unep
    await withTempDir(async (put) => {
      const leafPath = await put('leaf.pem', toPem(cert.der, 'CERTIFICATE'))
      const caPath = await put('ca.pem', trusted.map((c) => toPem(c.der, 'CERTIFICATE')).join(''))
      const untrusted = [...chain.slice(1, -1), ...extra].map((c) => toPem(c.der, 'CERTIFICATE')).join('')
      const base = ['verify', '-engine', 'gost', '-CAfile', caPath, '-purpose', 'any']
      if (untrusted) base.push('-untrusted', await put('untrusted.pem', untrusted))
      const c = await openssl([...base, leafPath])
      add('chain', c.ok, c.ok ? `цепочка до корня ${level === 'ukep' ? 'Минцифры (УКЭП)' : '«Госключа» (УНЭП)'}` : `цепочка не сходится: ${opensslReason(c)}`)
      if (!c.ok) return

      let crls: Uint8Array[]
      try {
        // список отзыва нужен для каждого сертификата, кроме корня
        crls = await Promise.all(chain.slice(0, -1).map((x) => input.pki.crlFor(x)))
      } catch (e) {
        add('revocation', false, e instanceof PkiError ? e.message : `список отзыва: ${(e as Error).message}`)
        return
      }
      const crlPath = await put('crl.pem', crls.map((x) => toPem(x, 'X509 CRL')).join(''))
      const r = await openssl([...base, '-crl_check_all', '-CRLfile', crlPath, leafPath])
      add('revocation', r.ok, r.ok ? 'сертификат не отозван' : /revoked/i.test(r.stderr) ? 'сертификат отозван' : `отзыв не проверен: ${opensslReason(r)}`)
    })
  }

  // 7. Срок сертификата на момент подписи
  if (!signingTime) add('validity', false, 'в подписи нет времени подписания')
  else {
    const ok = signingTime >= cert.notBefore && signingTime <= cert.notAfter
    add('validity', ok, ok ? 'сертификат действовал в момент подписи' : `в момент подписи сертификат не действовал (срок ${iso(cert.notBefore)} — ${iso(cert.notAfter)})`)
  }

  // 8. Время подписи: после отправки титула и не в будущем
  if (!signingTime) add('signing_time', false, 'в подписи нет времени подписания')
  else if (signingTime.getTime() > now.getTime() + CLOCK_SKEW_MS) add('signing_time', false, 'время подписи в будущем')
  else if (input.sentAt && signingTime.getTime() < input.sentAt.getTime() - CLOCK_SKEW_MS) add('signing_time', false, 'подпись сделана раньше, чем мы отправили титул')
  else add('signing_time', true, 'время подписи сходится')

  // 9. Назначение ключа
  const ku = cert.keyUsage
  const kuOk = !ku || ku.has(0) || ku.has(1)
  add('key_usage', kuOk, kuOk ? 'ключ предназначен для подписи' : 'ключ сертификата не предназначен для подписи')

  // 10. ИНН
  const expected = normalizeInn(input.expectedInn)
  let inn: string | null = null
  let innSource: Signer['innSource'] = null
  if (!expected) add('inn', false, 'в титуле нет ИНН, с которым сверять')
  else if (level === 'ukep') {
    inn = certificateInn(cert)
    innSource = 'certificate'
    add('inn', inn === expected, !inn ? 'в сертификате УКЭП нет ИНН' : inn === expected ? 'ИНН из сертификата совпадает' : `ИНН в сертификате ${inn}, а в титуле ${expected}`)
  } else {
    inn = input.declaredInn ? normalizeInn(input.declaredInn) : null
    innSource = inn ? 'declared' : null
    if (!input.declaredInn) add('inn', false, 'подпись УНЭП: подписант должен ввести ИНН')
    else if (!inn || !isValidInn(inn)) add('inn', false, 'введённый ИНН с ошибкой')
    else add('inn', inn === expected, inn === expected ? 'введённый ИНН совпадает' : `введён ИНН ${inn}, а в титуле ${expected}`)
  }

  const signer: Signer = {
    fullName: cert.subject[OID.commonName] ?? null,
    surname: cert.subject[OID.surname] ?? null,
    givenName: cert.subject[OID.givenName] ?? null,
    snils: cert.subject[OID.snils] ?? null,
    organization: cert.subject[OID.organization] ?? null,
    inn,
    innSource,
    ogrn: cert.subject[OID.ogrn] ?? cert.subject[OID.ogrnip] ?? null,
    certSerial: cert.serial,
    certIssuer: cert.issuer[OID.commonName] ?? null,
    certNotBefore: iso(cert.notBefore),
    certNotAfter: iso(cert.notAfter),
    certificate: Buffer.from(cert.der).toString('base64'),
  }
  return result(level, signer, signingTime, digest)
}
