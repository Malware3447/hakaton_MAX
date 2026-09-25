// Вызов openssl с движком gost. В образе движок ставит пакет libengine-gost-openssl;
// на машине разработчика путь к gost.so можно задать через OPENSSL_ENGINES.

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface OpensslResult {
  ok: boolean
  stdout: Buffer
  stderr: string
}

export function openssl(args: string[]): Promise<OpensslResult> {
  return new Promise((resolve) => {
    execFile('openssl', args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout, stderr: stderr.toString('utf8') })
    })
  })
}

/** Последняя содержательная строка ошибки openssl: её и показываем в причине отказа. */
export function opensslReason(r: OpensslResult): string {
  const lines = r.stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('Engine "gost" set'))
  const verify = lines.find((l) => /verify error|error \d+ at \d+ depth/i.test(l))
  return (verify ?? lines[lines.length - 1] ?? 'openssl завершился с ошибкой').slice(0, 300)
}

let gostChecked: Promise<boolean> | null = null

/** Есть ли движок gost. Без него проверить подпись ГОСТ нельзя. */
export function gostAvailable(): Promise<boolean> {
  gostChecked ??= openssl(['engine', 'gost']).then((r) => r.ok)
  return gostChecked
}

/** Временная папка для файлов одного вызова; удаляется после. */
export async function withTempDir<T>(fn: (put: (name: string, data: Uint8Array | string) => Promise<string>) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'nk-sig-'))
  try {
    return await fn(async (name, data) => {
      const path = join(dir, name)
      await writeFile(path, data)
      return path
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
