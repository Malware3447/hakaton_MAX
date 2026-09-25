import { eq } from 'drizzle-orm'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDb, readSeed } from '../db/boot.ts'
import { inbox } from '../db/schema.ts'
import { resetDemo } from '../db/seed.ts'
import type { MaxUpdate } from '../max/types.ts'
import { Inbox, inboxKey } from './inbox.ts'

const url = process.env.TEST_DATABASE_URL

const press = (id: string): MaxUpdate => ({
  update_type: 'message_callback',
  timestamp: 1,
  callback: { timestamp: 1, callback_id: id, payload: 'root', user: { user_id: 1, first_name: 'А', is_bot: false } },
})

describe('ключ обновления', () => {
  it('нажатие — callback_id, сообщение — mid, вход — пользователь и время', () => {
    expect(inboxKey(press('abc'))).toBe('cb:abc')
    expect(inboxKey({ update_type: 'message_created', timestamp: 5, message: { recipient: { chat_type: 'dialog' }, timestamp: 5, body: { mid: 'M1', seq: 1 } } })).toBe('mid:M1')
    expect(inboxKey({ update_type: 'bot_started', timestamp: 7, chat_id: 1, user: { user_id: 9, first_name: 'Б', is_bot: false } })).toBe('start:9:7')
  })
})

describe.skipIf(!url)('inbox на базе', () => {
  let conn: Awaited<ReturnType<typeof openDb>>
  beforeAll(async () => {
    conn = await openDb(url!)
    await resetDemo(conn.db, await readSeed())
  })
  afterAll(() => conn.pool.end())

  it('повтор той же доставки не обрабатывается второй раз', async () => {
    let calls = 0
    const ib = new Inbox(conn.db, async () => void calls++, pino({ level: 'silent' }))
    await ib.ingest(press('dup-1'))
    await ib.ingest(press('dup-1'))
    await Promise.all([ib.ingest(press('dup-2')), ib.ingest(press('dup-2')), ib.ingest(press('dup-2'))])
    expect(calls).toBe(2)
    const [row] = await conn.db.select().from(inbox).where(eq(inbox.key, 'cb:dup-1'))
    expect(row?.processedAt).not.toBeNull()
  })

  it('упавшая обработка записывает ошибку и повторяется, пока не пройдёт', async () => {
    let fail = true
    let calls = 0
    const ib = new Inbox(
      conn.db,
      async () => {
        calls++
        if (fail) throw new Error('база недоступна')
      },
      pino({ level: 'silent' }),
    )
    await ib.ingest(press('flaky'))
    let [row] = await conn.db.select().from(inbox).where(eq(inbox.key, 'cb:flaky'))
    expect(row).toMatchObject({ attempts: 1, error: 'база недоступна', processedAt: null })

    fail = false
    expect(await ib.retryPending()).toBe(1)
    ;[row] = await conn.db.select().from(inbox).where(eq(inbox.key, 'cb:flaky'))
    expect(row?.processedAt).not.toBeNull()
    expect(calls).toBe(2)
    expect(await ib.retryPending()).toBe(0)
  })

  it('после трёх неудач больше не повторяем', async () => {
    const ib = new Inbox(conn.db, async () => { throw new Error('всегда') }, pino({ level: 'silent' }))
    await ib.ingest(press('dead'))
    await ib.retryPending()
    await ib.retryPending()
    expect(await ib.retryPending()).toBe(0)
    const [row] = await conn.db.select().from(inbox).where(eq(inbox.key, 'cb:dead'))
    expect(row?.attempts).toBe(3)
  })
})
