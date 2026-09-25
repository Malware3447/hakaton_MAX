import type { Messenger, OutMessage } from '@nk/domain'
import { eq } from 'drizzle-orm'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MockDirectory } from '../adapters/mock-directory.ts'
import { openDb, readSeed } from '../db/boot.ts'
import { resetDemo } from '../db/seed.ts'
import { participant } from '../db/schema.ts'
import type { MaxUpdate } from '../max/types.ts'
import { MockErp } from '../adapters/mock-erp.ts'
import { ShipmentService } from '../core/shipments.ts'
import { InviteService } from '../core/invite-service.ts'
import { Bot } from './bot.ts'
import { BotStore } from './store.ts'

// Прогон меню ролей и анкет на настоящей базе. Нужна TEST_DATABASE_URL — база стирается.
const url = process.env.TEST_DATABASE_URL

class FakeMessenger implements Messenger {
  last: OutMessage | null = null
  lastNotification: string | null = null
  /** что ушло людям новыми сообщениями, по user_id */
  inbox = new Map<number, OutMessage[]>()
  /** кто сейчас действует: last — ответ именно ему, уведомления другим туда не попадают */
  current = 0
  async send(userId: number, m: OutMessage) {
    if (userId === this.current) this.last = m
    this.inbox.set(userId, [...(this.inbox.get(userId) ?? []), m])
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
const contact = (id: number, of: { user_id: number; first_name: string } | null): MaxUpdate => ({
  update_type: 'message_created',
  timestamp: 0,
  message: {
    sender: user(id),
    recipient: { chat_type: 'dialog', user_id: 1 },
    timestamp: 0,
    body: { mid: 'x', seq: 0, attachments: [{ type: 'contact', payload: { vcf_info: 'BEGIN:VCARD\nFN:Кто-то\nTEL:+79170001122\nEND:VCARD', max_info: of ? { ...of, is_bot: false } : null } }] },
  },
})
const started = (id: number, payload: string): MaxUpdate => ({ update_type: 'bot_started', timestamp: 0, chat_id: 1, user: user(id), payload })
const tokenIn = (m: OutMessage | null) => /start=inv_([\w-]+)/.exec(m?.text ?? '')?.[1] ?? ''
/** Открыть отгрузку по номеру, пролистав список отправителя. */
async function openRef(act: (u: MaxUpdate) => Promise<void>, out: { last: OutMessage | null }, ref: string) {
  for (let page = 0; page < 5; page++) {
    await act(press(1, `sl:${page}`))
    const b = (out.last?.buttons ?? []).flat().find((x) => x.text.startsWith(ref))
    if (b) return act(press(1, b.payload))
  }
  throw new Error(`отгрузки ${ref} нет в списке`)
}
const payloadOf = (m: OutMessage | null, text: string) => (m?.buttons ?? []).flat().find((b) => b.text.startsWith(text))?.payload ?? ''
const actorOf = (u: MaxUpdate) =>
  'callback' in u ? u.callback.user.user_id : 'message' in u ? u.message.sender!.user_id : 'user' in u ? u.user.user_id : 0
const buttons = (m: OutMessage | null) => (m?.buttons ?? []).flat().map((b) => b.text)

describe.skipIf(!url)('бот: меню ролей и анкеты', () => {
  let conn: Awaited<ReturnType<typeof openDb>>
  let bot: Bot
  const out = new FakeMessenger()
  const act = (u: MaxUpdate) => {
    out.current = actorOf(u)
    return bot.handle(u)
  }

  beforeAll(async () => {
    conn = await openDb(url!)
    await resetDemo(conn.db, await readSeed())
    const directory = new MockDirectory(conn.db)
    bot = new Bot(new BotStore(conn.db), out, directory, new ShipmentService(conn.db, new MockErp(conn.db), directory), new InviteService(conn.db), 'test_bot', pino({ level: 'silent' }))
  })
  afterAll(() => conn.pool.end())

  it('первый вход — приветствие и четыре роли', async () => {
    await act({ update_type: 'bot_started', timestamp: 0, chat_id: 1, user: user(1) })
    expect(buttons(out.last)).toEqual(['+ Отправитель', '+ Перевозчик', '+ Водитель', '+ Получатель', 'Помощь'])
  })

  it('отправитель: ИНН → подтверждение → доверенность позже → учётная система', async () => {
    await act(press(1, 'add:shipper'))
    expect(out.last?.text).toMatch(/ИНН/)
    await act(text(1, '9782242515'))
    expect(out.last?.text).toMatch(/контрольная цифра/)
    await act(text(1, '9782242514'))
    expect(out.last?.text).toMatch(/Волжский завод моторных масел/)
    await act(press(1, 'f:yes'))
    await act(press(1, 'f:later'))
    expect(out.last?.text).toMatch(/учётную систему/)
    await act(press(1, 'f:erp'))
    expect(out.last?.text).toMatch(/Отправитель · ООО «Волжский завод моторных масел»/)
    expect(buttons(out.last)).toContain('Отгрузки (17)')
  })

  it('«Назад» возвращает на шаг, «В меню» не оставляет следов', async () => {
    await act(press(1, 'add:carrier'))
    await act(text(1, '3603931407'))
    expect(out.last?.text).toMatch(/ГрузЛайн/)
    await act(press(1, 'f:back'))
    expect(out.last?.text).toMatch(/Пришлите ИНН/)
    await act(press(1, 'f:menu'))
    expect(buttons(out.last)).toContain('+ Перевозчик')
  })

  it('получатель без справочника: ручной ввод и подпись с доверенностью', async () => {
    await act(press(1, 'add:consignee'))
    await act(text(1, '7707083893'))
    expect(out.last?.text).toMatch(/нет в справочнике/)
    await act(text(1, 'ООО «Проверка»'))
    await act(text(1, '101000, г. Москва, ул. Тестовая, 1'))
    await act(press(1, 'f:accept_sign'))
    await act(text(1, 'МЧД-1'))
    await act(text(1, '01.01.2020'))
    expect(out.last?.text).toMatch(/истекла/)
    await act(text(1, '31.12.2027'))
    expect(out.last?.text).toMatch(/Получатель · ООО «Проверка»/)
    await act(press(1, 'company'))
    expect(out.last?.text).toMatch(/не проверены/)
  })

  it('водитель заводится одним нажатием, все роли остаются', async () => {
    await act(press(1, 'add:driver'))
    expect(out.last?.text).toMatch(/без перевозчика/)
    await act(text(1, '/menu'))
    expect(buttons(out.last)).toEqual([
      'Отправитель · ООО «Волжский завод моторных масел»',
      'Получатель · ООО «Проверка»',
      '✓ Водитель · без перевозчика',
      '+ Перевозчик',
      'Помощь',
    ])
  })

  it('второй человек не может занять ту же роль той же компании', async () => {
    await act(press(2, 'add:shipper'))
    await act(text(2, '9782242514'))
    expect(out.last?.text).toMatch(/уже подключена.*\n.*Человек 1/)
  })

  it('заглушки отвечают уведомлением', async () => {
    await act(press(1, 'stub:carrier.fleet'))
    expect(out.lastNotification).toMatch(/следующей версии/)
  })

  describe('перевозка: отгрузка → назначение перевозчика контактом → принять или отклонить', () => {
    it('перевозчик заводит роль (человек 3)', async () => {
      await act(press(3, 'add:carrier'))
      await act(text(3, '3603931407'))
      await act(press(3, 'f:yes'))
      await act(press(3, 'f:later'))
      expect(out.last?.text).toMatch(/Перевозчик · ООО «ГрузЛайн-Казань»/)
    })

    it('отправитель видит 17 отгрузок и открывает ОТГ-2026-1040', async () => {
      await act(press(1, 'open:shipper'))
      await act(press(1, payloadOf(out.last, 'Отгрузки')))
      expect(out.last?.text).toMatch(/Всего 17/)
      await act(press(1, payloadOf(out.last, '1040')))
      expect(out.last?.text).toMatch(/Перевозка ОТГ-2026-1040[\s\S]*ждёт назначения перевозчика[\s\S]*86 мест, 2730 кг/)
      expect(buttons(out.last)).toContain('Назначить перевозчика')
    })

    it('контакт без MAX и контакт не перевозчика не назначаются', async () => {
      await act(press(1, payloadOf(out.last, 'Назначить перевозчика')))
      await act(contact(1, null))
      expect(out.last?.text).toMatch(/нет аккаунта MAX/)
      await act(contact(1, { user_id: 2, first_name: 'Человек' }))
      expect(out.last?.text).toMatch(/нет роли перевозчика/)
    })

    it('контакт перевозчика — заявка уходит ему, у него «ждут меня: 1»', async () => {
      await act(contact(1, { user_id: 3, first_name: 'Олег' }))
      expect(out.last?.text).toMatch(/Заявка отправлена: Олег[\s\S]*заявка у перевозчика/)
      const offer = out.inbox.get(3)!.at(-1)!
      expect(offer.text).toMatch(/Новая заявка.*Волжский/)
      expect(buttons(offer)).toEqual(['Принять заявку', 'Отклонить', 'Обновить', 'В меню'])
      await act(press(3, 'open:carrier'))
      expect(buttons(out.last)).toContain('Ждут меня (1)')
      expect(buttons(out.last)).toContain('Новые заявки (1)')
    })

    it('перевозчик принимает — отправителю приходит «принял», двойное нажатие безвредно', async () => {
      const offer = out.inbox.get(3)!.at(-1)!
      await act(press(3, payloadOf(offer, 'Принять')))
      expect(out.last?.text).toMatch(/перевозчик назначает машину и водителя/)
      expect(out.inbox.get(1)!.at(-1)!.text).toMatch(/принял заявку ОТГ-2026-1040/)
      await act(press(3, payloadOf(offer, 'Принять')))
      expect(out.lastNotification).toBe('Уже сделано')
    })

    it('отказ с причиной: отправителю приходит причина и снова его ход', async () => {
      await act(press(1, 'sl:0'))
      await act(press(1, payloadOf(out.last, '1041')))
      await act(press(1, payloadOf(out.last, 'Назначить перевозчика')))
      await act(contact(1, { user_id: 3, first_name: 'Олег' }))
      const offer = out.inbox.get(3)!.at(-1)!
      await act(press(3, payloadOf(offer, 'Отклонить')))
      await act(text(3, 'Машина в ремонте'))
      expect(out.last?.text).toMatch(/Заявка отклонена/)
      const back = out.inbox.get(1)!.at(-1)!
      expect(back.text).toMatch(/отклонил заявку: Машина в ремонте[\s\S]*ждёт назначения перевозчика/)
      expect(buttons(back)).toContain('Назначить перевозчика')
    })

    it('незнакомому в боте перевозчику — приглашение по ссылке', async () => {
      await act(press(1, 'sl:0'))
      await act(press(1, payloadOf(out.last, '1043')))
      await act(press(1, payloadOf(out.last, 'Назначить перевозчика')))
      await act(contact(1, { user_id: 999, first_name: 'Новенький' }))
      expect(out.last?.text).toMatch(/Новенький ещё не пользуется ботом[\s\S]*https:\/\/max\.ru\/test_bot\?start=inv_/)
    })
  })

  describe('вход по приглашению', () => {
    let link = ''

    it('новичок по ссылке сразу видит перевозку, подключает компанию и получает заявку', async () => {
      await openRef(act, out, '1044')
      await act(press(1, payloadOf(out.last, 'Назначить перевозчика')))
      await act(contact(1, { user_id: 500, first_name: 'Ринат' }))
      link = tokenIn(out.last)
      expect(link).not.toBe('')

      await act(started(500, `inv_${link}`))
      expect(out.last?.text).toMatch(/Вам предлагают перевезти груз[\s\S]*ОТГ-2026-1044[\s\S]*Пришлите ИНН/)
      await act(text(500, '8390825665'))
      await act(press(500, 'f:yes'))
      await act(press(500, 'f:later'))
      expect(out.last?.text).toMatch(/Вы в перевозке как перевозчик[\s\S]*заявка у перевозчика[\s\S]*Челны-Транс/)
      expect(buttons(out.last)).toContain('Принять заявку')
      const note = out.inbox.get(1)!.at(-1)!.text
      expect(note).toMatch(/принял приглашение в перевозку ОТГ-2026-1044 как перевозчик/)
      expect(note).not.toMatch(/не тот человек/)
    })

    it('повторно по той же ссылке: себе — карточка, другому — отказ', async () => {
      await act(started(500, `inv_${link}`))
      expect(out.last?.text).toMatch(/Перевозка ОТГ-2026-1044/)
      await act(started(501, `inv_${link}`))
      expect(out.last?.text).toMatch(/уже вошёл другой человек/)
    })

    it('пришёл не тот, чей контакт присылали: пускаем, отправителю — предупреждение', async () => {
      await openRef(act, out, '1045')
      await act(press(1, payloadOf(out.last, 'Назначить перевозчика')))
      await act(contact(1, { user_id: 777, first_name: 'Ожидаемый' }))
      const t2 = tokenIn(out.last)
      await act(started(3, `inv_${t2}`))
      expect(out.last?.text).toMatch(/Вы в перевозке как перевозчик[\s\S]*ГрузЛайн/)
      expect(out.inbox.get(1)!.at(-1)!.text).toMatch(/не тот человек/)
    })

    it('истёкшая ссылка: «попросить новую» → отправитель выдаёт новую → по ней можно войти', async () => {
      await openRef(act, out, '1046')
      await act(press(1, payloadOf(out.last, 'Назначить перевозчика')))
      await act(contact(1, { user_id: 888, first_name: 'Опоздавший' }))
      const old = tokenIn(out.last)
      await conn.db.update(participant).set({ inviteExpiresAt: new Date(Date.now() - 1000) }).where(eq(participant.expectedMaxUserId, 888))

      await act(started(888, `inv_${old}`))
      expect(out.last?.text).toMatch(/Срок приглашения истёк/)
      await act(press(888, payloadOf(out.last, 'Попросить новую')))
      const ask = out.inbox.get(1)!.at(-1)!
      expect(ask.text).toMatch(/Человек 888 просит новую ссылку/)

      await act(press(1, payloadOf(ask, 'Выдать новую')))
      const fresh = tokenIn(out.last)
      expect(fresh).not.toBe(old)
      await act(started(888, `inv_${fresh}`))
      expect(out.last?.text).toMatch(/Вам предлагают перевезти груз/)
    })
  })
})
