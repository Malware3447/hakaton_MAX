import { createHmac, timingSafeEqual } from 'node:crypto'

// Номер из кнопки request_contact. MAX подписывает vcf_info: hash = HMAC-SHA256(токен бота, vcf_info).
// У контакта, пересланного через скрепку или из книги, hash нет — номер им не подтвердить.
// dev.max.ru/docs-api/use-cases/sending-messages/keyboard

function same(a: string, b: string) {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export function verifyContactHash(botToken: string, vcfInfo: string, hash: string): boolean {
  // Документация просит превратить «\r\n» в настоящие переводы строк; после JSON они обычно уже настоящие
  const variants = new Set([vcfInfo, vcfInfo.replace(/\\r\\n/g, '\r\n').replace(/\\n/g, '\n')])
  for (const v of variants) {
    const mac = createHmac('sha256', botToken).update(v, 'utf8').digest()
    if (same(mac.toString('hex'), hash.toLowerCase()) || same(mac.toString('base64'), hash) || same(mac.toString('base64url'), hash)) return true
  }
  return false
}

/** Телефон из vCard в виде +7XXXXXXXXXX. */
export function phoneFromVcf(vcf: string | null | undefined): string | null {
  const raw = /(?:^|[\r\n])TEL[^:]*:([^\r\n]+)/.exec(vcf ?? '')?.[1]
  if (!raw) return null
  const d = raw.replace(/\D/g, '')
  if (d.length === 11 && (d.startsWith('7') || d.startsWith('8'))) return `+7${d.slice(1)}`
  if (d.length === 10) return `+7${d}`
  return d ? `+${d}` : null
}
