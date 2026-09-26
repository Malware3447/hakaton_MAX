import { RateLimiter } from './limiter.ts'
import type { MaxUpdate, NewMessageBody } from './types.ts'

// Тонкий клиент MAX Bot API. Токен — в заголовке Authorization.
// Очередь исходящих с лимитами (2 сообщения в секунду на диалог, 30 запросов в секунду)
// и повторы на attachment.not.ready — HAKATON-26; здесь только повтор на 429 и 5xx.

export class MaxApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message)
  }

  /**
   * Человеку не написать и повторять бессмысленно: остановил бота (403) или ни разу его
   * не запускал (404 dialog.not.found, проверено 25.09).
   */
  get unreachable(): boolean {
    return this.status === 403 || (this.status === 404 && (this.code === 'dialog.not.found' || this.code === 'chat.not.found'))
  }
}

export class MaxApi {
  constructor(
    private readonly token: string,
    private readonly base = 'https://platform-api2.max.ru',
    private readonly limiter = new RateLimiter(),
  ) {}

  private async call<T>(method: string, path: string, query: Record<string, string | number | undefined> = {}, body?: unknown, dialogKey?: string): Promise<T> {
    await this.limiter.acquire(dialogKey)
    const url = new URL(path, this.base)
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v))
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(url, {
        method,
        headers: { Authorization: this.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(45_000),
      })
      if (res.ok) return (await res.json()) as T
      const retryable = res.status === 429 || res.status >= 500
      if (retryable && attempt < 3) {
        await new Promise((r) => setTimeout(r, attempt * 1000))
        continue
      }
      const err = (await res.json().catch(() => ({}))) as { code?: string; message?: string }
      throw new MaxApiError(res.status, err.code, `${method} ${path}: ${res.status} ${err.code ?? ''} ${err.message ?? ''}`.trim())
    }
  }

  getMe() {
    return this.call<{ user_id: number; username: string; name: string }>('GET', '/me')
  }

  getUpdates(marker: number | undefined, timeoutSec = 30) {
    return this.call<{ updates: MaxUpdate[]; marker?: number }>('GET', '/updates', {
      marker,
      timeout: timeoutSec,
      limit: 100,
      types: 'message_created,message_callback,bot_started',
    })
  }

  async sendToUser(userId: number, body: NewMessageBody): Promise<string> {
    // Файл сразу после загрузки бывает не готов: attachment.not.ready — ждём и повторяем
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await this.call<{ message: { body: { mid: string } } }>('POST', '/messages', { user_id: userId }, body, `u${userId}`)
        return res.message.body.mid
      } catch (err) {
        if (err instanceof MaxApiError && err.code === 'attachment.not.ready' && attempt < 6) {
          await new Promise((r) => setTimeout(r, attempt * 700))
          continue
        }
        throw err
      }
    }
  }

  editMessage(mid: string, body: NewMessageBody) {
    return this.call<{ success: boolean }>('PUT', '/messages', { message_id: mid }, body)
  }

  /**
   * Загрузить вложение: POST /uploads?type=… даёт адрес, туда multipart с полем data; в ответ токен вложения.
   * Для file токен лежит в корне ответа, для image — в photos[<id>].token. GIF как image приходит в чат картинкой.
   */
  async upload(type: 'file' | 'image', name: string, bytes: Uint8Array): Promise<string> {
    const ep = await this.call<{ url: string; token?: string }>('POST', '/uploads', { type })
    const form = new FormData()
    form.append('data', new Blob([bytes]), name)
    const res = await fetch(ep.url, { method: 'POST', headers: { Authorization: this.token }, body: form, signal: AbortSignal.timeout(60_000) })
    if (!res.ok) throw new MaxApiError(res.status, undefined, `загрузка ${type}: ${res.status}`)
    const info = (await res.json().catch(() => ({}))) as { token?: string; photos?: Record<string, { token?: string }> }
    const token = info.token ?? Object.values(info.photos ?? {})[0]?.token ?? ep.token
    if (!token) throw new MaxApiError(500, undefined, `загрузка ${type}: нет токена вложения`)
    return token
  }

  getSubscriptions() {
    return this.call<{ subscriptions: { url: string; time: number; update_types?: string[] }[] }>('GET', '/subscriptions')
  }

  subscribe(url: string, secret: string, updateTypes: string[]) {
    return this.call<{ success: boolean }>('POST', '/subscriptions', {}, { url, secret, update_types: updateTypes })
  }

  unsubscribe(url: string) {
    return this.call<{ success: boolean }>('DELETE', '/subscriptions', { url })
  }

  answerCallback(callbackId: string, answer: { message?: NewMessageBody; notification?: string }) {
    return this.call<{ success: boolean }>('POST', '/answers', { callback_id: callbackId }, answer)
  }

  setCommands(commands: { name: string; description: string }[]) {
    return this.call('PATCH', '/me/commands', {}, { commands })
  }
}
