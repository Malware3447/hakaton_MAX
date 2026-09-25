// Тестовый удостоверяющий центр на ГОСТ 34.10-2012: корни, промежуточные, сертификаты подписантов,
// списки отзыва и подписи. Только для тестов: настоящие .sig с личными данными в публичный репозиторий не кладём.

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openssl, opensslReason } from '../openssl.ts'

export interface TestCert {
  name: string
  dir: string
  key: string
  cert: string
  crlUrl: string
  caUrl: string
}

async function run(args: string[]) {
  const r = await openssl(args)
  if (!r.ok) throw new Error(`openssl ${args[0]}: ${opensslReason(r)}`)
  return r
}

const config = (dir: string) => `
oid_section = oids
[oids]
INNLE = 1.2.643.100.4
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
default_crl_days = 1
certificate = ${dir}/cert.pem
private_key = ${dir}/key.pem
`

export class TestPki {
  private seq = 0

  constructor(private readonly baseDir: string) {}

  private async make(name: string, subject: string, ext: string, issuer: TestCert | null): Promise<TestCert> {
    // в адресах внутри сертификата только латиница (IA5String)
    const id = `ca${++this.seq}`
    const dir = join(this.baseDir, id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'index.txt'), '')
    await writeFile(join(dir, 'crlnumber'), '01\n')
    await writeFile(join(dir, 'openssl.cnf'), config(dir))
    const t: TestCert = {
      name,
      dir,
      key: join(dir, 'key.pem'),
      cert: join(dir, 'cert.pem'),
      crlUrl: `http://test.local/crl/${id}.crl`,
      caUrl: `http://test.local/ca/${id}.cer`,
    }
    await run(['genpkey', '-engine', 'gost', '-algorithm', 'gost2012_256', '-pkeyopt', 'paramset:A', '-out', t.key])
    const cnf = join(dir, 'openssl.cnf')
    const extFile = join(dir, 'ext.cnf')
    const chainExt = issuer ? `\ncrlDistributionPoints=URI:${issuer.crlUrl}\nauthorityInfoAccess=caIssuers;URI:${issuer.caUrl}\nauthorityKeyIdentifier=keyid` : ''
    await writeFile(extFile, `subjectKeyIdentifier=hash\n${ext}${chainExt}\n`)
    const csr = join(dir, 'req.csr')
    await run(['req', '-engine', 'gost', '-config', cnf, '-utf8', '-new', '-key', t.key, '-subj', subject, '-out', csr])
    // корень подписывает сам себя; расширения из файла, поэтому x509 -req, а не req -x509
    const signBy = issuer ? ['-CA', issuer.cert, '-CAkey', issuer.key, '-set_serial', `0x${randomBytes(8).toString('hex')}`] : ['-signkey', t.key]
    await run(['x509', '-engine', 'gost', '-req', '-in', csr, ...signBy, '-days', issuer ? '365' : '3650', '-extfile', extFile, '-out', t.cert])
    return t
  }

  root(name: string) {
    return this.make(name, `/C=RU/CN=${name}`, 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign', null)
  }

  intermediate(name: string, issuer: TestCert) {
    return this.make(name, `/C=RU/CN=${name}`, 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign', issuer)
  }

  /** subject в синтаксисе openssl: /C=RU/SN=.../SNILS=.../INNLE=.../CN=... */
  person(name: string, subject: string, issuer: TestCert, keyUsage = 'digitalSignature,nonRepudiation') {
    return this.make(name, subject, `basicConstraints=CA:FALSE\nkeyUsage=critical,${keyUsage}`, issuer)
  }

  async revoke(ca: TestCert, cert: TestCert) {
    await run(['ca', '-engine', 'gost', '-config', join(ca.dir, 'openssl.cnf'), '-revoke', cert.cert])
  }

  /** список отзыва от имени ca в DER */
  async crl(ca: TestCert): Promise<Uint8Array> {
    const pem = join(ca.dir, 'crl.pem')
    await run(['ca', '-engine', 'gost', '-config', join(ca.dir, 'openssl.cnf'), '-gencrl', '-out', pem])
    const r = await run(['crl', '-in', pem, '-outform', 'DER'])
    return new Uint8Array(r.stdout)
  }

  async certDer(t: TestCert): Promise<Uint8Array> {
    return new Uint8Array((await run(['x509', '-in', t.cert, '-outform', 'DER'])).stdout)
  }

  async certPem(t: TestCert): Promise<string> {
    return readFile(t.cert, 'utf8')
  }

  /** отсоединённая подпись CMS в DER, как у «Госключа» */
  async sign(document: Uint8Array, ...signers: TestCert[]): Promise<Uint8Array> {
    const doc = join(this.baseDir, `doc-${Date.now()}-${Math.random()}`)
    await writeFile(doc, document)
    const args = ['cms', '-sign', '-engine', 'gost', '-binary', '-in', doc, '-md', 'md_gost12_256', '-outform', 'DER']
    for (const s of signers) args.push('-signer', s.cert, '-inkey', s.key)
    return new Uint8Array((await run(args)).stdout)
  }
}
