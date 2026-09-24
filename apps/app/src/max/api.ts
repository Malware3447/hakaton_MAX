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
}

export class MaxApi {
  constructor(
    private readonly token: string,
    private readonly base = 'https://platform-api2.max.ru',
  ) {}

  private async call<T>(method: string, path: string, query: Record<string, string | number | undefined> = {}, body?: unknown): Promise<T> {
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

  getUpdates(marker: number | undefined, timeoutSec = 30) {
    return this.call<{ updates: MaxUpdate[]; marker?: number }>('GET', '/updates', {
      marker,
      timeout: timeoutSec,
      limit: 100,
      types: 'message_created,message_callback,bot_started',
    })
  }

  async sendToUser(userId: number, body: NewMessageBody): Promise<string> {
    const res = await this.call<{ message: { body: { mid: string } } }>('POST', '/messages', { user_id: userId }, body)
    return res.message.body.mid
  }

  editMessage(mid: string, body: NewMessageBody) {
    return this.call<{ success: boolean }>('PUT', '/messages', { message_id: mid }, body)
  }

  answerCallback(callbackId: string, answer: { message?: NewMessageBody; notification?: string }) {
    return this.call<{ success: boolean }>('POST', '/answers', { callback_id: callbackId }, answer)
  }

  setCommands(commands: { name: string; description: string }[]) {
    return this.call('PATCH', '/me/commands', {}, { commands })
  }
}
