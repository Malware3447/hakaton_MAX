// Чтение отсоединённой CMS-подписи (.sig «Госключа»), сертификата и списка отзыва.
// Только разбор структуры; подпись и цепочку проверяет openssl (signature-verify.ts).

import { Asn1Error, children, hex, integerHex, isContext, oid, readAsn1, text, time, type Asn1 } from './asn1.ts'

export const OID = {
  signedData: '1.2.840.113549.1.7.2',
  data: '1.2.840.113549.1.7.1',
  signingTime: '1.2.840.113549.1.9.5',
  messageDigest: '1.2.840.113549.1.9.4',
  gost2012_256: '1.2.643.7.1.1.2.2',
  gost2012_512: '1.2.643.7.1.1.2.3',
  keyUsage: '2.5.29.15',
  subjectKeyId: '2.5.29.14',
  authorityKeyId: '2.5.29.35',
  basicConstraints: '2.5.29.19',
  crlDistributionPoints: '2.5.29.31',
  authorityInfoAccess: '1.3.6.1.5.5.7.1.1',
  caIssuers: '1.3.6.1.5.5.7.48.2',
  // поля имени
  commonName: '2.5.4.3',
  surname: '2.5.4.4',
  givenName: '2.5.4.42',
  organization: '2.5.4.10',
  title: '2.5.4.12',
  snils: '1.2.643.100.3',
  innLe: '1.2.643.100.4', // ИНН юрлица, 10 цифр
  inn: '1.2.643.3.131.1.1', // ИНН физлица или ИП, 12 цифр (у старых сертификатов юрлиц — 00 + 10 цифр)
  ogrn: '1.2.643.100.1',
  ogrnip: '1.2.643.100.5',
} as const

/** Алгоритм хеша → имя для openssl dgst с движком gost. */
export const DIGESTS: Record<string, string> = {
  [OID.gost2012_256]: 'md_gost12_256',
  [OID.gost2012_512]: 'md_gost12_512',
}

export interface CertInfo {
  der: Uint8Array
  serial: string
  issuerDer: Uint8Array
  subjectDer: Uint8Array
  /** OID поля имени → значение */
  subject: Record<string, string>
  issuer: Record<string, string>
  notBefore: Date
  notAfter: Date
  isCa: boolean
  /** биты keyUsage по номерам: 0 digitalSignature, 1 nonRepudiation; null — расширения нет */
  keyUsage: Set<number> | null
  crlUrls: string[]
  caIssuerUrls: string[]
  selfIssued: boolean
  /** идентификатор своего ключа (SKI) */
  keyId: string | null
  /** ссылка на ключ издателя (AKI): по идентификатору ключа или по номеру сертификата издателя */
  authorityKeyId: string | null
  authoritySerial: string | null
}

export interface SignerInfo {
  issuerDer: Uint8Array
  serial: string
  digestAlgorithm: string
  signingTime: Date | null
  messageDigest: Uint8Array | null
}

export interface SignedData {
  /** внутри .sig нет самого документа */
  detached: boolean
  certificates: CertInfo[]
  signers: SignerInfo[]
}

const seq = (node: Asn1 | undefined, what: string): Asn1[] => {
  if (!node || node.tag !== 0x10 || !node.constructed) throw new Asn1Error(`ожидали SEQUENCE: ${what}`)
  return children(node)
}

const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])

function readName(node: Asn1): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rdn of children(node)) {
    for (const atv of children(rdn)) {
      const [type, value] = children(atv)
      if (!type || !value) continue
      try {
        out[oid(type)] = text(value)
      } catch {
        // нестроковое значение в имени нам не нужно
      }
    }
  }
  return out
}

/** URI из GeneralNames (тег [6]). */
function uris(node: Asn1): string[] {
  const out: string[] = []
  const walk = (n: Asn1) => {
    if (n.cls === 'context' && n.tag === 6 && !n.constructed) out.push(Buffer.from(n.content).toString('latin1'))
    else if (n.constructed) children(n).forEach(walk)
  }
  walk(node)
  return out
}

export function readCertificate(der: Uint8Array): CertInfo {
  const cert = readAsn1(der)
  const [tbs] = seq(cert, 'сертификат')
  const f = seq(tbs, 'tbsCertificate')
  let i = isContext(f[0], 0) ? 1 : 0
  const serial = integerHex(f[i++]!)
  i++ // алгоритм подписи
  const issuer = f[i++]!
  const [nb, na] = seq(f[i++], 'validity')
  const subject = f[i++]!
  i++ // открытый ключ
  const info: CertInfo = {
    der: cert.der,
    serial,
    issuerDer: issuer.der,
    subjectDer: subject.der,
    subject: readName(subject),
    issuer: readName(issuer),
    notBefore: time(nb!),
    notAfter: time(na!),
    isCa: false,
    keyUsage: null,
    crlUrls: [],
    caIssuerUrls: [],
    selfIssued: eq(issuer.der, subject.der),
    keyId: null,
    authorityKeyId: null,
    authoritySerial: null,
  }
  const extWrap = f.slice(i).find((n) => isContext(n, 3))
  if (!extWrap) return info
  for (const ext of seq(children(extWrap)[0], 'extensions')) {
    const parts = children(ext)
    const id = oid(parts[0]!)
    const value = readAsn1(parts[parts.length - 1]!.content)
    if (id === OID.keyUsage) {
      // BIT STRING: первый байт — число неиспользуемых бит
      const bits = new Set<number>()
      value.content.subarray(1).forEach((byte, k) => {
        for (let b = 0; b < 8; b++) if (byte & (0x80 >> b)) bits.add(k * 8 + b)
      })
      info.keyUsage = bits
    } else if (id === OID.basicConstraints) {
      const c = children(value)
      info.isCa = c[0]?.tag === 0x01 && c[0].content[0] !== 0
    } else if (id === OID.subjectKeyId) {
      info.keyId = hex(value.content)
    } else if (id === OID.authorityKeyId) {
      for (const n of children(value)) {
        if (isContext(n, 0)) info.authorityKeyId = hex(n.content)
        if (isContext(n, 2)) info.authoritySerial = hex(n.content).replace(/^(00)+(?=.)/, '')
      }
    } else if (id === OID.crlDistributionPoints) {
      info.crlUrls = uris(value)
    } else if (id === OID.authorityInfoAccess) {
      for (const ad of children(value)) {
        const [method, location] = children(ad)
        if (method && location && oid(method) === OID.caIssuers) info.caIssuerUrls.push(...uris(ad))
      }
    }
  }
  return info
}

export function readSignedData(der: Uint8Array): SignedData {
  const ci = readAsn1(der)
  if (ci.der.length !== der.length) throw new Asn1Error('после подписи лишние байты')
  const [type, wrapped] = seq(ci, 'ContentInfo')
  if (!type || oid(type) !== OID.signedData || !isContext(wrapped, 0)) throw new Asn1Error('это не подписанные данные CMS')
  const sd = seq(children(wrapped)[0], 'SignedData')
  const encap = seq(sd[2], 'encapContentInfo')
  const detached = !encap.some((n) => isContext(n, 0))
  const certificates: CertInfo[] = []
  let signerSet: Asn1 | undefined
  for (const n of sd.slice(3)) {
    if (isContext(n, 0)) for (const c of children(n)) if (c.tag === 0x10) certificates.push(readCertificate(c.der))
    if (n.cls === 'universal' && n.tag === 0x11) signerSet = n
  }
  if (!signerSet) throw new Asn1Error('в подписи нет подписантов')
  const signers = children(signerSet).map((si): SignerInfo => {
    const f = seq(si, 'SignerInfo')
    const sid = f[1]!
    if (sid.tag !== 0x10) throw new Asn1Error('подписант указан не по издателю и номеру сертификата')
    const [issuer, serial] = children(sid)
    const digestAlgorithm = oid(seq(f[2], 'digestAlgorithm')[0]!)
    let signingTime: Date | null = null
    let messageDigest: Uint8Array | null = null
    if (isContext(f[3], 0)) {
      for (const attr of children(f[3])) {
        const [t, values] = children(attr)
        const v = children(values!)[0]
        if (!t || !v) continue
        const id = oid(t)
        if (id === OID.signingTime) signingTime = time(v)
        if (id === OID.messageDigest) messageDigest = v.content
      }
    }
    return { issuerDer: issuer!.der, serial: integerHex(serial!), digestAlgorithm, signingTime, messageDigest }
  })
  return { detached, certificates, signers }
}

export function signerCertificate(sd: SignedData, signer: SignerInfo): CertInfo | null {
  return sd.certificates.find((c) => c.serial === signer.serial && eq(c.issuerDer, signer.issuerDer)) ?? null
}

/** Следующее обновление списка отзыва; null — не указано. */
export function crlNextUpdate(der: Uint8Array): Date | null {
  const [tbs] = seq(readAsn1(der), 'CertificateList')
  const f = seq(tbs, 'tbsCertList')
  let i = f[0]?.tag === 0x02 ? 1 : 0
  i += 3 // алгоритм, издатель, thisUpdate
  const n = f[i]
  return n && (n.tag === 0x17 || n.tag === 0x18) ? time(n) : null
}

export function toPem(der: Uint8Array, label: 'CERTIFICATE' | 'X509 CRL'): string {
  const b64 = Buffer.from(der).toString('base64').replace(/.{64}/g, '$&\n')
  return `-----BEGIN ${label}-----\n${b64.replace(/\n$/, '')}\n-----END ${label}-----\n`
}

export function fromPem(pem: string): Uint8Array[] {
  return [...pem.matchAll(/-----BEGIN [A-Z0-9 ]+-----([\s\S]*?)-----END [A-Z0-9 ]+-----/g)].map((m) => new Uint8Array(Buffer.from(m[1]!.replace(/\s+/g, ''), 'base64')))
}

export { hex }
