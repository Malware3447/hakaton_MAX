import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { OutMessage } from '@nk/domain'
import type { Db } from '../db/client.ts'
import { card } from '../db/schema.ts'

// Живая карточка (HAKATON-28): у каждого человека в перевозке одно сообщение с её состоянием.
// Храним mid и отпечаток того, что нарисовано: перерисовываем, только если отпечаток изменился.

export const renderHash = (m: OutMessage) => createHash('sha256').update(JSON.stringify({ t: m.text, b: m.buttons ?? [] })).digest('hex')

/** Во что превращается прежняя карточка, когда актуальная приходит новым сообщением. */
export const MOVED_CARD: OutMessage = { text: '⤵️ Карточка перевозки обновилась — актуальная ниже.' }

export class CardStore {
  constructor(private readonly db: Db) {}

  async get(shipmentId: string, personId: string) {
    const [row] = await this.db.select().from(card).where(and(eq(card.shipmentId, shipmentId), eq(card.personId, personId)))
    return row ?? null
  }

  /** Запомнить сообщение как живую карточку. Возвращает mid прежней, если она была другим сообщением. */
  async record(shipmentId: string, personId: string, mid: string, hash: string): Promise<string | null> {
    const old = await this.get(shipmentId, personId)
    await this.db
      .insert(card)
      .values({ shipmentId, personId, mid, renderHash: hash })
      .onConflictDoUpdate({ target: [card.shipmentId, card.personId], set: { mid, renderHash: hash, updatedAt: new Date() } })
    return old && old.mid !== mid ? old.mid : null
  }

  /** Человек ушёл из карточки в меню: карточка удаляется — забыть её. Вернёт true, если это была карточка. */
  async forget(personId: string, mid: string): Promise<boolean> {
    const gone = await this.db.delete(card).where(and(eq(card.personId, personId), eq(card.mid, mid))).returning({ mid: card.mid })
    return gone.length > 0
  }

  async setHash(shipmentId: string, personId: string, hash: string) {
    await this.db
      .update(card)
      .set({ renderHash: hash, updatedAt: new Date() })
      .where(and(eq(card.shipmentId, shipmentId), eq(card.personId, personId)))
  }
}
