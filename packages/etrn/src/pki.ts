// Откуда берутся сертификаты удостоверяющих центров и списки отзыва.
// Доверяем только корням из репозитория (certs/goskey/unep и certs/goskey/ukep).
// Промежуточные сертификаты — из certs/goskey/intermediate или по адресу из самого сертификата (AIA);
// скачанный промежуточный сертификат доверия не добавляет: цепочку всё равно проверяет openssl до наших корней.

import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { crlNextUpdate, fromPem, readCertificate, type CertInfo } from './cms.ts'

export interface TrustAnchors {
  /** корни УНЭП «Госключа»: «Специализированный центр сертификации» */
  unep: CertInfo[]
  /** корни УКЭП: головной УЦ Минцифры */
  ukep: CertInfo[]
}

export interface PkiStore {
  anchors(): Promise<TrustAnchors>
  /** возможные издатели сертификата; пусто — не нашли ни у себя, ни по адресу из сертификата */
  issuersOf(cert: CertInfo): Promise<CertInfo[]>
  /** действующий (nextUpdate в будущем) список отзыва, в который попал бы cert; бросает PkiError */
  crlFor(cert: CertInfo): Promise<Uint8Array>
}

export class PkiError extends Error {}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])

/** Подходит ли issuer как издатель cert: имя совпадает, а ключ — по AKI, если он есть. */
export function isIssuer(issuer: CertInfo, cert: CertInfo): boolean {
  if (!sameBytes(issuer.subjectDer, cert.issuerDer)) return false
  if (cert.authorityKeyId && issuer.keyId) return cert.authorityKeyId === issuer.keyId
  if (cert.authoritySerial) return cert.authoritySerial === issuer.serial
  return true
}

/** Сертификаты из файла: DER или PEM (в PEM может быть несколько). */
export function readCertFile(bytes: Uint8Array): CertInfo[] {
  const s = Buffer.from(bytes).toString('latin1')
  return s.includes('-----BEGIN') ? fromPem(s).map(readCertificate) : [readCertificate(bytes)]
}

async function readDir(dir: string): Promise<CertInfo[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const out: CertInfo[] = []
  for (const n of names.sort()) if (/\.(pem|cer|crt)$/i.test(n)) out.push(...readCertFile(await readFile(join(dir, n))))
  return out
}

export type Fetch = (url: string) => Promise<Uint8Array>

const httpFetch: Fetch = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

const key = (url: string) => createHash('sha256').update(url).digest('hex').slice(0, 32)

export interface FilePkiOptions {
  /** папка с unep/, ukep/, intermediate/ */
  certsDir: string
  /** куда складывать скачанные сертификаты и списки отзыва */
  cacheDir: string
  fetch?: Fetch
  now?: () => Date
}

export class FilePkiStore implements PkiStore {
  private loaded: Promise<{ anchors: TrustAnchors; known: CertInfo[] }> | null = null
  private readonly fetch: Fetch
  private readonly now: () => Date

  constructor(private readonly opts: FilePkiOptions) {
    this.fetch = opts.fetch ?? httpFetch
    this.now = opts.now ?? (() => new Date())
  }

  private load() {
    this.loaded ??= (async () => {
      const anchors = { unep: await readDir(join(this.opts.certsDir, 'unep')), ukep: await readDir(join(this.opts.certsDir, 'ukep')) }
      const known = [
        ...anchors.unep,
        ...anchors.ukep,
        ...(await readDir(join(this.opts.certsDir, 'intermediate'))),
        ...(await readDir(join(this.opts.cacheDir, 'ca'))),
      ]
      return { anchors, known }
    })()
    return this.loaded
  }

  async anchors() {
    return (await this.load()).anchors
  }

  async issuersOf(cert: CertInfo): Promise<CertInfo[]> {
    const { known } = await this.load()
    const found = known.filter((c) => isIssuer(c, cert))
    if (found.length) return found
    for (const url of cert.caIssuerUrls) {
      try {
        const bytes = await this.fetch(url)
        const certs = readCertFile(bytes).filter((c) => isIssuer(c, cert))
        if (!certs.length) continue
        await mkdir(join(this.opts.cacheDir, 'ca'), { recursive: true })
        await writeFile(join(this.opts.cacheDir, 'ca', `${key(url)}.cer`), bytes)
        known.push(...certs)
        return certs
      } catch {
        // пробуем следующий адрес
      }
    }
    return []
  }

  async crlFor(cert: CertInfo): Promise<Uint8Array> {
    if (!cert.crlUrls.length) throw new PkiError('в сертификате нет адреса списка отзыва')
    const dir = join(this.opts.cacheDir, 'crl')
    const fresh = (der: Uint8Array) => {
      const next = crlNextUpdate(der)
      return next !== null && next > this.now()
    }
    for (const url of cert.crlUrls) {
      try {
        const cached = new Uint8Array(await readFile(join(dir, `${key(url)}.crl`)))
        if (fresh(cached)) return cached
      } catch {
        // в кэше нет — скачаем
      }
    }
    const errors: string[] = []
    for (const url of cert.crlUrls) {
      try {
        const der = await this.fetch(url)
        if (!fresh(der)) {
          errors.push(`${url}: список устарел`)
          continue
        }
        await mkdir(dir, { recursive: true })
        await writeFile(join(dir, `${key(url)}.crl`), der)
        return der
      } catch (e) {
        errors.push(`${url}: ${(e as Error).message}`)
      }
    }
    throw new PkiError(`не удалось получить действующий список отзыва (${errors.join('; ')})`)
  }
}
