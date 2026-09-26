import { eq } from 'drizzle-orm'
import type { Messenger, OutMessage } from '@nk/domain'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MockDirectory } from '../adapters/mock-directory.ts'
import { MockErp } from '../adapters/mock-erp.ts'
import { ShipmentService } from '../core/shipments.ts'
import { openDb, readSeed } from '../db/boot.ts'
import { event, membership, mockErpWriteback, org, person } from '../db/schema.ts'
import { resetDemo } from '../db/seed.ts'
import { MaxApiError } from '../max/api.ts'
import { Jobs } from './jobs.ts'
import { CardStore } from '../bot/card-store.ts'

// Очередь на настоящей базе. Нужна TEST_DATABASE_URL.
const url = process.env.TEST_DATABASE_URL

class RecordingMessenger implements Messenger {
  sent: { userId: number; m: OutMessage }[] = []
  async send(userId: number, m: OutMessage) {
    if (userId === 404) throw new MaxApiError(404, 'dialog.not.found', 'Dialog not found')
    this.sent.push({ userId, m })
    return { mid: 'm' }
  }
  async edit() {}
  deleted: string[] = []
  async delete(mid: string) {
    this.deleted.push(mid)
  }
  async answerCallback() {}
}

async function until<T>(fn: () => Promise<T | undefined | null | false>, ms = 8000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('не дождались')
    await new Promise((r) => setTimeout(r, 200))
  }
}

describe.skipIf(!url)('очередь заданий', () => {
  let conn: Awaited<ReturnType<typeof openDb>>
  let jobs: Jobs
  const messenger = new RecordingMessenger()

  beforeAll(async () => {
    conn = await openDb(url!)
    await resetDemo(conn.db, await readSeed())
    jobs = new Jobs(Jobs.create(url!), conn.db, messenger, new MockErp(conn.db), new CardStore(conn.db), pino({ level: 'silent' }))
    await jobs.start()
  }, 30_000)
  afterAll(async () => {
    await jobs.stop()
    await conn.pool.end()
  })

  it('уведомление доходит до человека', async () => {
    await jobs.send(42, { text: 'Сейчас ваш ход' })
    const got = await until(async () => messenger.sent.find((s) => s.userId === 42))
    expect(got.m.text).toBe('Сейчас ваш ход')
  })

  it('отмена перевозки: статус с причиной уходит в учётную систему через очередь', async () => {
    const db = conn.db
    const [so] = await db.insert(org).values({ inn: '9782242514', name: 'Завод', address: 'Елабуга' }).returning()
    const [p] = await db.insert(person).values({ maxUserId: 1, name: 'Марина' }).returning()
    await db.insert(membership).values({ personId: p!.id, role: 'shipper', orgId: so!.id, isAdmin: true })
    const svc = new ShipmentService(db, new MockErp(db), new MockDirectory(db), jobs)
    const id = await svc.openFromErp({ shipperOrgId: so!.id, shipperInn: '9782242514', erpRef: 'ОТГ-2026-1040', personId: p!.id })
    const res = await svc.execute({ type: 'shipper.cancel', shipmentId: id, payload: { reason: 'Перенос отгрузки' } }, { kind: 'person', personId: p!.id, role: 'shipper' })
    expect(res).toMatchObject({ ok: true, to: 'cancelled' })

    const row = await until(async () => (await db.select().from(mockErpWriteback).where(eq(mockErpWriteback.ref, 'ОТГ-2026-1040')))[0])
    expect(row.status).toEqual({ kind: 'cancelled', reason: 'Перенос отгрузки' })
  })

  it('недоступному человеку не повторяем, а отмечаем в журнале', async () => {
    const [s] = await conn.db.select().from(event).limit(1)
    await jobs.send(404, { text: 'не дойдёт' }, { shipmentId: s!.shipmentId! })
    const failed = await until(async () => (await conn.db.select().from(event).where(eq(event.type, 'notify.failed')))[0])
    expect(failed.payload).toEqual({ code: 'dialog.not.found' })
  })

  it('не дошло до участника — предупреждение получает ответственный', async () => {
    await jobs.send(404, { text: 'ваш ход' }, { escalate: { userId: 77, text: 'Не можем написать водителю' } })
    const warn = await until(async () => messenger.sent.find((s) => s.userId === 77))
    expect(warn.m.text).toBe('Не можем написать водителю')
  })
})
