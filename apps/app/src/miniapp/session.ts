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
