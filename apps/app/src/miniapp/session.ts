import { createHmac, timingSafeEqual } from 'node:crypto'

// Сессия мини-приложения: после проверки initData сервер выдаёт подписанный токен на 8 часов.
// Токен идёт в заголовке Authorization: Bearer, а не в cookie — в web.max.ru приложение
// открывается во фрейме с чужого домена, и сторонние cookie браузер может не пустить.

export const SESSION_TTL_S = 8 * 60 * 60

export interface Session {
  personId: string
  maxUserId: number
  exp: number
}

export class SessionSigner {
  private readonly key: Buffer

  constructor(botToken: string) {
    // отдельный ключ, чтобы подпись сессии нельзя было выдать ни за что другое
    this.key = createHmac('sha256', 'nk-miniapp-session').update(botToken).digest()
  }

  issue(personId: string, maxUserId: number, now = new Date()): { token: string; expiresAt: Date } {
    const exp = Math.floor(now.getTime() / 1000) + SESSION_TTL_S
    const body = Buffer.from(JSON.stringify({ personId, maxUserId, exp } satisfies Session)).toString('base64url')
    return { token: `${body}.${this.sign(body)}`, expiresAt: new Date(exp * 1000) }
  }

  verify(token: string, now = new Date()): Session | null {
    const [body, sig, extra] = token.split('.')
    if (!body || !sig || extra !== undefined) return null
    const expected = Buffer.from(this.sign(body))
    const got = Buffer.from(sig)
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null
    let s: Partial<Session>
    try {
      s = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    } catch {
      return null
    }
    if (typeof s.personId !== 'string' || typeof s.maxUserId !== 'number' || typeof s.exp !== 'number') return null
    if (s.exp * 1000 <= now.getTime()) return null
    return { personId: s.personId, maxUserId: s.maxUserId, exp: s.exp }
  }

  private sign(body: string): string {
    return createHmac('sha256', this.key).update(body).digest('base64url')
  }
}

/** Файл накладной по ссылке: что отдать и под каким именем. */
export interface FileRef {
  shipmentId: string
  kind: 'title' | 'signature'
  id: string
  name: string
}

/**
 * Ссылка на файл для WebApp.downloadFile: MAX скачивает файл сам, без заголовка сессии,
 * поэтому право на файл — в подписи ссылки. Живёт 10 минут и ведёт ровно на один файл.
 */
export class FileSigner {
  private readonly key: Buffer

  constructor(botToken: string) {
    this.key = createHmac('sha256', 'nk-miniapp-file').update(botToken).digest()
  }

  issue(ref: FileRef, now = new Date(), ttlS = 600): string {
    const body = Buffer.from(JSON.stringify({ ...ref, exp: Math.floor(now.getTime() / 1000) + ttlS })).toString('base64url')
    return `${body}.${this.sign(body)}`
  }

  verify(token: string, now = new Date()): FileRef | null {
    const [body, sig, extra] = token.split('.')
    if (!body || !sig || extra !== undefined) return null
    const expected = Buffer.from(this.sign(body))
    const got = Buffer.from(sig)
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null
    try {
      const f = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<FileRef & { exp: number }>
      if (typeof f.exp !== 'number' || f.exp * 1000 <= now.getTime()) return null
      if (typeof f.shipmentId !== 'string' || typeof f.id !== 'string' || typeof f.name !== 'string' || (f.kind !== 'title' && f.kind !== 'signature')) return null
      return { shipmentId: f.shipmentId, kind: f.kind, id: f.id, name: f.name }
    } catch {
      return null
    }
  }

  private sign(body: string): string {
    return createHmac('sha256', this.key).update(body).digest('base64url')
  }
}
