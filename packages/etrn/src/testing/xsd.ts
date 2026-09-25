import { readFileSync } from 'node:fs'
import { validateXML } from 'xmllint-wasm'
import { decode1251 } from '../format.ts'

// Проверка титула по официальной XSD ФНС (libxml2 в WebAssembly). Только для тестов:
// в сборку бота не попадает — сборщик покрыт тестами на каждую ветку.
// libxml2 в xmllint-wasm собран без iconv и не читает windows-1251, поэтому и титул, и схему
// перед проверкой перекодируем в UTF-8 с тем же содержимым. Проверяется структура и значения;
// сами байты в windows-1251 проверяет отдельный тест.

const toUtf8 = (bytes: Uint8Array) => decode1251(bytes).replace(/^<\?xml([^>]*)encoding="windows-1251"/i, '<?xml$1encoding="UTF-8"')

const XSD = {
  T1: 'ON_TRNACLGROT_1_973_01_05_01_01_v1.xsd',
  T2: 'ON_TRNACLPPRIN_1_973_02_05_01_01_v1.xsd',
  T3: 'ON_TRNACLGRPO_1_973_05_05_01_01_v1.xsd',
  T4: 'ON_TRNACLPVYN_1_973_06_05_01_01_v1.xsd',
} as const

export async function validateTitle(kind: keyof typeof XSD, bytes: Uint8Array) {
  const name = XSD[kind]
  const schema = readFileSync(new URL(`../../xsd/${name}`, import.meta.url))
  const res = await validateXML({ xml: [{ fileName: 'title.xml', contents: toUtf8(bytes) }], schema: [{ fileName: name, contents: toUtf8(new Uint8Array(schema)) }] })
  return { valid: res.valid, errors: res.errors.map((e) => e.message) }
}
