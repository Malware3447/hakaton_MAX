import type { Messenger, OutMessage } from '@nk/domain'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MockDirectory } from '../adapters/mock-directory.ts'
import { openDb, readSeed } from '../db/boot.ts'
import { resetDemo } from '../db/seed.ts'
import type { MaxUpdate } from '../max/types.ts'
import { Bot } from './bot.ts'
import { BotStore } from './store.ts'

// Прогон меню ролей и анкет на настоящей базе. Нужна TEST_DATABASE_URL — база стирается.
const url = process.env.TEST_DATABASE_URL

class FakeMessenger implements Messenger {
  last: OutMessage | null = null
  lastNotification: string | null = null
  async send(_: number, m: OutMessage) {
    this.last = m
    return { mid: 'm' }
  }
  async edit(_: string, m: OutMessage) {
    this.last = m
  }
  async answerCallback(_: string, n: string | null, m?: OutMessage) {
    this.lastNotification = n
    if (m) this.last = m
  }
}

const user = (id: number) => ({ user_id: id, first_name: `Человек ${id}`, is_bot: false })
const text = (id: number, t: string): MaxUpdate => ({
  update_type: 'message_created',
  timestamp: 0,
  message: { sender: user(id), recipient: { chat_type: 'dialog', user_id: 1 }, timestamp: 0, body: { mid: 'x', seq: 0, text: t } },
})
const press = (id: number, payload: string): MaxUpdate => ({
  update_type: 'message_callback',
  timestamp: 0,
  callback: { timestamp: 0, callback_id: 'c', payload, user: user(id) },
})
const buttons = (m: OutMessage | null) => (m?.buttons ?? []).flat().map((b) => b.text)

describe.skipIf(!url)('бот: меню ролей и анкеты', () => {
  let conn: Awaited<ReturnType<typeof openDb>>
  let bot: Bot
  const out = new FakeMessenger()

  beforeAll(async () => {
    conn = await openDb(url!)
    await resetDemo(conn.db, await readSeed())
    bot = new Bot(new BotStore(conn.db), out, new MockDirectory(conn.db), pino({ level: 'silent' }))
  })
  afterAll(() => conn.pool.end())

  it('первый вход — приветствие и четыре роли', async () => {
    await bot.handle({ update_type: 'bot_started', timestamp: 0, chat_id: 1, user: user(1) })
    expect(buttons(out.last)).toEqual(['+ Отправитель', '+ Перевозчик', '+ Водитель', '+ Получатель', 'Помощь'])
  })

  it('отправитель: ИНН → подтверждение → доверенность позже → учётная система', async () => {
    await bot.handle(press(1, 'add:shipper'))
    expect(out.last?.text).toMatch(/ИНН/)
    await bot.handle(text(1, '9782242515'))
    expect(out.last?.text).toMatch(/контрольная цифра/)
    await bot.handle(text(1, '9782242514'))
    expect(out.last?.text).toMatch(/Волжский завод моторных масел/)
    await bot.handle(press(1, 'f:yes'))
    await bot.handle(press(1, 'f:later'))
    expect(out.last?.text).toMatch(/учётную систему/)
    await bot.handle(press(1, 'f:erp'))
    expect(out.last?.text).toMatch(/Отправитель · ООО «Волжский завод моторных масел»/)
    expect(buttons(out.last)).toContain('Отгрузки (17)')
  })

  it('«Назад» возвращает на шаг, «В меню» не оставляет следов', async () => {
    await bot.handle(press(1, 'add:carrier'))
    await bot.handle(text(1, '3603931407'))
    expect(out.last?.text).toMatch(/ГрузЛайн/)
    await bot.handle(press(1, 'f:back'))
    expect(out.last?.text).toMatch(/Пришлите ИНН/)
    await bot.handle(press(1, 'f:menu'))
    expect(buttons(out.last)).toContain('+ Перевозчик')
  })

  it('получатель без справочника: ручной ввод и подпись с доверенностью', async () => {
    await bot.handle(press(1, 'add:consignee'))
    await bot.handle(text(1, '7707083893'))
    expect(out.last?.text).toMatch(/нет в справочнике/)
    await bot.handle(text(1, 'ООО «Проверка»'))
    await bot.handle(text(1, '101000, г. Москва, ул. Тестовая, 1'))
    await bot.handle(press(1, 'f:accept_sign'))
    await bot.handle(text(1, 'МЧД-1'))
    await bot.handle(text(1, '01.01.2020'))
    expect(out.last?.text).toMatch(/истекла/)
    await bot.handle(text(1, '31.12.2027'))
    expect(out.last?.text).toMatch(/Получатель · ООО «Проверка»/)
    await bot.handle(press(1, 'company'))
    expect(out.last?.text).toMatch(/не проверены/)
  })

  it('водитель заводится одним нажатием, все роли остаются', async () => {
    await bot.handle(press(1, 'add:driver'))
    expect(out.last?.text).toMatch(/без перевозчика/)
    await bot.handle(text(1, '/menu'))
    expect(buttons(out.last)).toEqual([
      'Отправитель · ООО «Волжский завод моторных масел»',
      'Получатель · ООО «Проверка»',
      '✓ Водитель · без перевозчика',
      '+ Перевозчик',
      'Помощь',
    ])
  })

  it('второй человек не может занять ту же роль той же компании', async () => {
    await bot.handle(press(2, 'add:shipper'))
    await bot.handle(text(2, '9782242514'))
    expect(out.last?.text).toMatch(/уже подключена.*\n.*Человек 1/)
  })

  it('заглушки отвечают уведомлением', async () => {
    await bot.handle(press(1, 'stub:shipper.shipments'))
    expect(out.lastNotification).toMatch(/следующей версии/)
  })
})
