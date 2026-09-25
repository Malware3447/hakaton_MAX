// Демо-удостоверяющий центр (HAKATON-36) — модель: подпись организации для тех, у кого нет «Госключа».
// Свой корень ГОСТ 34.10-2012 и по сертификату на организацию с её ИНН; подпись — отсоединённая CMS,
// как у «Госключа», и проверяется тем же verifyGoskeySignature, но с доверием только к демо-корню.
// Корни «Госключа» и демо-корень не смешиваем: демо-подпись не должна сойти за настоящую.
// Ключи создаются при первом запуске в dir и в репозиторий не попадают.

import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { crlNextUpdate, type CertInfo } from './cms.ts'
import { openssl, opensslReason, withTempDir } from './openssl.ts'
import { isIssuer, readCertFile, type PkiStore, type TrustAnchors } from './pki.ts'
import { verifyGoskeySignature, type GoskeyVerification } from './signature-verify.ts'

export const DEMO_CA_NAME = 'Демо-УЦ «Накладная в кармане» (модель)'

export interface DemoOrg {
  inn: string
  name: string
}

async function run(args: string[]) {
  const r = await openssl(args)
  if (!r.ok) throw new Error(`openssl ${args[0]}: ${opensslReason(r)}`)
  return r
}

/** Значение для -subj: косая черта и плюс разделяют поля, их экранируем. */
const subj = (s: string) => s.replace(/[\\/+=]/g, (c) => `\\${c}`)

const config = (dir: string) => `
oid_section = oids
[oids]
INNLE = 1.2.643.100.4
# ИНН (1.2.643.3.131.1.1) openssl уже знает под именем INN
[req]
distinguished_name = dn
string_mask = utf8only
[dn]
[ca]
default_ca = own
[own]
database = ${dir}/index.txt
crlnumber = ${dir}/crlnumber
default_md = md_gost12_256
default_crl_days = 2
certificate = ${dir}/cert.pem
private_key = ${dir}/key.pem
`

export class DemoCa implements PkiStore {
  private rootReady: Promise<CertInfo> | null = null
  private readonly orgs = new Map<string, Promise<{ key: string; cert: string }>>()
  private crl: { der: Uint8Array; nextUpdate: Date } | null = null

  constructor(
    private readonly dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private get rootDir() {
    return join(this.dir, 'root')
  }

  /** Корень: создаётся один раз и дальше читается из dir. */
  root(): Promise<CertInfo> {
    this.rootReady ??= (async () => {
      const d = this.rootDir
      const cert = join(d, 'cert.pem')
      if (!existsSync(cert)) {
        await mkdir(d, { recursive: true, mode: 0o700 })
        await writeFile(join(d, 'index.txt'), '')
        await writeFile(join(d, 'crlnumber'), '01\n')
        await writeFile(join(d, 'openssl.cnf'), config(d))
        await this.issue(d, `/C=RU/O=${subj(DEMO_CA_NAME)}/CN=${subj(DEMO_CA_NAME)}`, 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign', null)
      }
      return readCertFile(await readFile(cert))[0]!
    })()
    this.rootReady.catch(() => (this.rootReady = null))
    return this.rootReady
  }

  /** Сертификат организации: ИНН юрлица — в INNLE, ИП (12 цифр) — в ИНН; как у УКЭП. */
  private org(o: DemoOrg) {
    let p = this.orgs.get(o.inn)
    if (!p) {
      p = (async () => {
        await this.root()
        const d = join(this.dir, `org-${o.inn.replace(/\D/g, '')}`)
        const files = { key: join(d, 'key.pem'), cert: join(d, 'cert.pem') }
        if (!existsSync(files.cert)) {
          await mkdir(d, { recursive: true, mode: 0o700 })
          const inn = o.inn.length === 12 ? `INN=${o.inn}` : `INNLE=${o.inn}`
          const name = subj(o.name)
          await this.issue(d, `/C=RU/O=${name}/${inn}/CN=${name}`, 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,nonRepudiation', this.rootDir)
        }
        return files
      })()
      p.catch(() => this.orgs.delete(o.inn))
      this.orgs.set(o.inn, p)
    }
    return p
  }

  private async issue(d: string, subject: string, ext: string, issuerDir: string | null) {
    const key = join(d, 'key.pem')
    await run(['genpkey', '-engine', 'gost', '-algorithm', 'gost2012_256', '-pkeyopt', 'paramset:A', '-out', key])
    await chmod(key, 0o600)
    const extFile = join(d, 'ext.cnf')
    await writeFile(extFile, `subjectKeyIdentifier=hash\n${ext}${issuerDir ? '\nauthorityKeyIdentifier=keyid' : ''}\n`)
    const csr = join(d, 'req.csr')
    const cnf = issuerDir ? join(issuerDir, 'openssl.cnf') : join(d, 'openssl.cnf')
    await run(['req', '-engine', 'gost', '-config', cnf, '-utf8', '-new', '-key', key, '-subj', subject, '-out', csr])
    const signBy = issuerDir
      ? ['-CA', join(issuerDir, 'cert.pem'), '-CAkey', join(issuerDir, 'key.pem'), '-set_serial', `0x${randomBytes(8).toString('hex')}`]
      : ['-signkey', key]
    await run(['x509', '-engine', 'gost', '-req', '-in', csr, ...signBy, '-days', issuerDir ? '365' : '3650', '-extfile', extFile, '-out', join(d, 'cert.pem')])
  }

  /** Отсоединённая подпись CMS (DER) от имени организации — ровно над этими байтами титула. */
  async sign(document: Uint8Array, o: DemoOrg): Promise<Uint8Array> {
    const { key, cert } = await this.org(o)
    return withTempDir(async (put) => {
      const doc = await put('doc', document)
      const r = await run(['cms', '-sign', '-engine', 'gost', '-binary', '-in', doc, '-md', 'md_gost12_256', '-outform', 'DER', '-signer', cert, '-inkey', key])
      return new Uint8Array(r.stdout)
    })
  }

  /** Проверка той же функцией, что и «Госключ», но доверяем только демо-корню. */
  verify(input: { document: Uint8Array; sig: Uint8Array; expectedInn: string; sentAt?: Date | null }): Promise<GoskeyVerification> {
    return verifyGoskeySignature({ ...input, now: this.now(), pki: this, anchorName: DEMO_CA_NAME })
  }

  // ---------- PkiStore: только демо-корень ----------

  async anchors(): Promise<TrustAnchors> {
    return { unep: [], ukep: [await this.root()] }
  }

  async issuersOf(cert: CertInfo): Promise<CertInfo[]> {
    const root = await this.root()
    return isIssuer(root, cert) ? [root] : []
  }

  /** Отзывать некого: пустой список отзыва от корня, обновляется до истечения. */
  async crlFor(): Promise<Uint8Array> {
    if (this.crl && this.crl.nextUpdate.getTime() - this.now().getTime() > 60 * 60_000) return this.crl.der
    await this.root()
    const pem = join(this.rootDir, 'crl.pem')
    await run(['ca', '-engine', 'gost', '-config', join(this.rootDir, 'openssl.cnf'), '-gencrl', '-out', pem])
    const der = new Uint8Array((await run(['crl', '-in', pem, '-outform', 'DER'])).stdout)
    this.crl = { der, nextUpdate: crlNextUpdate(der) ?? new Date(this.now().getTime() + 24 * 60 * 60_000) }
    return der
  }
}
