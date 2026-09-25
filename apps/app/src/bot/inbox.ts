import { createHash } from 'node:crypto'
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import type { Db } from '../db/client.ts'
import { inbox } from '../db/schema.ts'
import type { MaxUpdate } from '../max/types.ts'

// Входящие обновления MAX (HAKATON-25). MAX повторяет доставку до 10 раз, polling после
// перезапуска тоже может прислать старое — поэтому каждое обновление сначала записываем
// с ключом и обрабатываем только первое. Упавшие повторяем заданием раз в минуту.

const MAX_ATTEMPTS = 3
/** Старше — не повторяем: человек уже ушёл, а callback_id нажатия всё равно истёк. */
const RETRY_WINDOW = '10 minutes'

/** Ключ обновления: нажатие — callback_id, сообщение — mid, вход — пользователь и время. */
export function inboxKey(u: MaxUpdate): string {
  if (u.update_type === 'message_callback' && 'callback' in u) return `cb:${u.callback.callback_id}`
  if (u.update_type === 'message_created' && 'message' in u) return `mid:${u.message.body.mid}`
  if (u.update_type === 'bot_started' && 'user' in u) return `start:${u.user.user_id}:${u.timestamp}`
  return `${u.update_type}:${createHash('sha256').update(JSON.stringify(u)).digest('hex').slice(0, 32)}`
}

export class Inbox {
  constructor(
    private readonly db: Db,
    private readonly handle: (u: MaxUpdate) => Promise<void>,
    private readonly log: FastifyBaseLogger,
  ) {}

  /** Принять обновление: записать, и если оно новое — обработать. */
  async ingest(u: MaxUpdate): Promise<void> {
    const key = inboxKey(u)
    const fresh = await this.db.insert(inbox).values({ key, payload: u }).onConflictDoNothing().returning({ key: inbox.key })
    if (!fresh.length) {
      this.log.info({ key }, 'повтор обновления — пропускаем')
      return
    }
    await this.process(key, u)
  }

  private async process(key: string, u: MaxUpdate) {
    try {
      await this.handle(u)
      await this.db.update(inbox).set({ processedAt: sql`now()`, error: null }).where(eq(inbox.key, key))
    } catch (err) {
      this.log.error({ err, key }, 'ошибка обработки обновления')
      await this.db
        .update(inbox)
        .set({ attempts: sql`${inbox.attempts} + 1`, error: String((err as Error).message ?? err).slice(0, 500) })
        .where(eq(inbox.key, key))
    }
  }

  /** Повторить упавшие: свежие, не обработанные, попыток меньше предела. */
  async retryPending(): Promise<number> {
    const rows = await this.db
      .select()
      .from(inbox)
      .where(
        and(
          isNull(inbox.processedAt),
          gt(inbox.attempts, 0),
          lt(inbox.attempts, MAX_ATTEMPTS),
          gt(inbox.receivedAt, sql`now() - ${RETRY_WINDOW}::interval`),
        ),
      )
      .orderBy(inbox.receivedAt)
      .limit(50)
    for (const r of rows) await this.process(r.key, r.payload as MaxUpdate)
    return rows.length
  }
}
