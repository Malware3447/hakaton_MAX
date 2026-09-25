// Минимальный разбор DER: ровно столько, сколько нужно, чтобы прочитать CMS-подпись,
// сертификат и список отзыва. Криптографию делает openssl, здесь только структура.

export interface Asn1 {
  /** номер тега без класса: 0x10 SEQUENCE, 0x06 OID, для [0] — 0 */
  tag: number
  cls: 'universal' | 'application' | 'context' | 'private'
  constructed: boolean
  /** весь элемент: заголовок и содержимое */
  der: Uint8Array
  content: Uint8Array
}

const CLASSES = ['universal', 'application', 'context', 'private'] as const

export class Asn1Error extends Error {}

export function readAsn1(buf: Uint8Array, offset = 0): Asn1 {
  let p = offset
  const need = (n: number) => {
    if (p + n > buf.length) throw new Asn1Error('обрезанные данные')
  }
  need(2)
  const first = buf[p++]!
  let tag = first & 0x1f
  if (tag === 0x1f) {
    tag = 0
    for (;;) {
      need(1)
      const b = buf[p++]!
      tag = (tag << 7) | (b & 0x7f)
      if (!(b & 0x80)) break
    }
  }
  need(1)
  let len = buf[p++]!
  if (len === 0x80) throw new Asn1Error('неопределённая длина не поддерживается, ждём DER')
  if (len & 0x80) {
    const n = len & 0x7f
    if (n > 4) throw new Asn1Error('слишком длинный элемент')
    need(n)
    len = 0
    for (let i = 0; i < n; i++) len = len * 256 + buf[p++]!
  }
  need(len)
  return {
    tag,
    cls: CLASSES[first >> 6]!,
    constructed: (first & 0x20) !== 0,
    der: buf.subarray(offset, p + len),
    content: buf.subarray(p, p + len),
  }
}

/** Дочерние элементы SEQUENCE, SET или явного [n]. */
export function children(node: Asn1): Asn1[] {
  if (!node.constructed) throw new Asn1Error('ожидали составной элемент')
  const out: Asn1[] = []
  let p = 0
  while (p < node.content.length) {
    const child = readAsn1(node.content, p)
    out.push(child)
    p += child.der.length
  }
  return out
}

export const isContext = (node: Asn1 | undefined, n: number): node is Asn1 => node?.cls === 'context' && node.tag === n

export function oid(node: Asn1): string {
  if (node.tag !== 0x06) throw new Asn1Error('ожидали OID')
  const b = node.content
  const parts: number[] = []
  let v = 0
  for (const x of b) {
    v = v * 128 + (x & 0x7f)
    if (!(x & 0x80)) {
      if (parts.length === 0) parts.push(v < 80 ? Math.floor(v / 40) : 2, v < 80 ? v % 40 : v - 80)
      else parts.push(v)
      v = 0
    }
  }
  return parts.join('.')
}

export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex').toUpperCase()
}

/** INTEGER как шестнадцатеричная строка без ведущих нулей: так пишут серийные номера. */
export function integerHex(node: Asn1): string {
  if (node.tag !== 0x02) throw new Asn1Error('ожидали INTEGER')
  return hex(node.content).replace(/^(00)+(?=.)/, '')
}

export function time(node: Asn1): Date {
  const s = Buffer.from(node.content).toString('latin1')
  // UTCTime: ГГММДДччммссZ; GeneralizedTime: ГГГГММДДччммссZ
  const m = node.tag === 0x17 ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s) : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s)
  if (!m || (node.tag !== 0x17 && node.tag !== 0x18)) throw new Asn1Error(`непонятное время: ${s}`)
  let year = Number(m[1])
  if (node.tag === 0x17) year += year < 50 ? 2000 : 1900
  return new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])))
}

/** Строковые типы, которые встречаются в именах сертификатов. */
export function text(node: Asn1): string {
  switch (node.tag) {
    case 0x0c: // UTF8String
      return Buffer.from(node.content).toString('utf8')
    case 0x1e: {
      // BMPString, UTF-16BE
      const b = Buffer.from(node.content)
      return b.swap16().toString('utf16le')
    }
    case 0x12: // NumericString
    case 0x13: // PrintableString
    case 0x14: // TeletexString
    case 0x16: // IA5String
      return Buffer.from(node.content).toString('latin1')
    default:
      throw new Asn1Error(`неизвестный строковый тип ${node.tag}`)
  }
}
