import type { Messenger, OutMessage } from '@nk/domain'
import { createHmac } from 'node:crypto'
import { eq } from 'drizzle-orm'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MockDirectory } from '../adapters/mock-directory.ts'
import { ChainDirectory } from '../adapters/dadata-directory.ts'
import { openDb, readSeed } from '../db/boot.ts'
import { resetDemo } from '../db/seed.ts'
import { event, mockEpdTitle, participant, person, shipment, vehicle } from '../db/schema.ts'
import type { MaxUpdate } from '../max/types.ts'
import { MockErp } from '../adapters/mock-erp.ts'
import { ShipmentService } from '../core/shipments.ts'
import { InviteService } from '../core/invite-service.ts'
import { FleetService } from '../core/fleet.ts'
import { CardStore } from './card-store.ts'
import { TitleService } from '../core/titles.ts'
import { MockEpd } from '../adapters/mock-epd.ts'
import { OperatorLink, type OperatorTask } from '../core/operator-link.ts'
import { SignatureService, type SignatureVerification } from '../core/signatures.ts'
import { decode1251 } from '@nk/etrn'
import { validateTitle } from '../../../../packages/etrn/src/testing/xsd.ts'
import { Bot } from './bot.ts'
import { BotStore } from './store.ts'

// Прогон меню ролей и анкет на настоящей базе. Нужна TEST_DATABASE_URL — база стирается.
const url = process.env.TEST_DATABASE_URL

class FakeMessenger implements Messenger {
  last: OutMessage | null = null
  lastNotification: string | null = null
  /** что ушло людям новыми сообщениями, по user_id */
  inbox = new Map<number, OutMessage[]>()
  /** правки сообщений: mid → последнее содержимое */
  edits = new Map<string, OutMessage>()
  private n = 0
  /** кто сейчас действует: last — ответ именно ему, уведомления другим туда не попадают */
  current = 0
  /** все отправленные сообщения с их mid */
  sentLog: { userId: number; mid: string; m: OutMessage }[] = []
  async send(userId: number, m: OutMessage) {
    if (userId === this.current) this.last = m
    this.inbox.set(userId, [...(this.inbox.get(userId) ?? []), m])
    const mid = `m${++this.n}`
    this.sentLog.push({ userId, mid, m })
    return { mid }
  }
  async edit(mid: string, m: OutMessage) {
    this.edits.set(mid, m)
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
/** Свой номер из кнопки «Поделиться номером»: hash = HMAC-SHA256(токен, vcf_info). */
const ownPhone = (id: number, phone: string, token = 'test-token'): MaxUpdate => {
  const vcf = `BEGIN:VCARD\r\nVERSION:3.0\r\nTEL;TYPE=cell:${phone}\r\nFN:Человек ${id}\r\nEND:VCARD\r\n`
  const hash = createHmac('sha256', token).update(vcf).digest('hex')
  return {
    update_type: 'message_created',
    timestamp: 0,
    message: {
      sender: user(id),
      recipient: { chat_type: 'dialog', user_id: 1 },
      timestamp: 0,
      body: { mid: 'x', seq: 0, attachments: [{ type: 'contact', payload: { vcf_info: vcf, hash, max_info: { ...user(id) } } }] },
    },
  }
}
const pressIn = (id: number, payload: string, mid = 'card-mid'): MaxUpdate => ({
  update_type: 'message_callback',
  timestamp: 0,
  callback: { timestamp: 0, callback_id: `cb-${payload}`, payload, user: user(id) },
  message: { recipient: { chat_type: 'dialog' }, timestamp: 0, body: { mid, seq: 0 } },
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
/** Сообщение с файлом: своим или пересланным (ответ «Госключа» пересылают). */
const fileMsg = (id: number, filename: string, url: string, forwarded = false): MaxUpdate => {
  const att = [{ type: 'file', filename, payload: { url, token: 't' } }]
  return {
    update_type: 'message_created',
    timestamp: 0,
    message: {
      sender: user(id),
      recipient: { chat_type: 'dialog', user_id: 1 },
      timestamp: 0,
      body: { mid: `f-${filename}`, seq: 0, attachments: forwarded ? [] : att },
      link: forwarded ? { type: 'forward', message: { attachments: att } } : null,
    },
  }
}
const payloadOf = (m: OutMessage | null, text: string) => (m?.buttons ?? []).flat().find((b) => b.text.startsWith(text))?.payload ?? ''
const actorOf = (u: MaxUpdate) =>
  'callback' in u ? u.callback.user.user_id : 'message' in u ? u.message.sender!.user_id : 'user' in u ? u.user.user_id : 0
const buttons = (m: OutMessage | null) => (m?.buttons ?? []).flat().map((b) => b.text)

describe.skipIf(!url)('бот: меню ролей и анкеты', () => {
  let conn: Awaited<ReturnType<typeof openDb>>
  let bot: Bot
  let svc: ShipmentService
  const out = new FakeMessenger()
  /** проверка подписи «Госключа»: что вернуть и с чем её вызывали */
  const verifier = {
    next: null as SignatureVerification | null,
    calls: [] as { document: Uint8Array; sig: Uint8Array; expectedInn: string }[],
    async verify(i: { document: Uint8Array; sig: Uint8Array; expectedInn: string }) {
      this.calls.push(i)
      return this.next!
    },
  }
  const act = (u: MaxUpdate) => {
    out.current = actorOf(u)
    return bot.handle(u)
  }

  beforeAll(async () => {
    conn = await openDb(url!)
    await resetDemo(conn.db, await readSeed())
    // Справочник как в работе: демо-данные, потом «DaData» (здесь подделка на двух ИНН)
    const directory = new ChainDirectory([
      new MockDirectory(conn.db),
      {
        async findByInn(inn: string) {
          if (inn === '7725000018') return { inn, kpp: '772501001', name: 'ООО «Настоящая»', address: '115000, г Москва, ул Реальная, д 1', source: 'dadata' as const, ogrn: '1027700000001', status: 'active' as const }
          if (inn === '5002000020') return { inn, kpp: null, name: 'ООО «Закрытая»', address: '', source: 'dadata' as const, ogrn: null, status: 'liquidated' as const }
          return null
        },
      },
    ])
    bot = new Bot(new BotStore(conn.db), out, directory, (svc = new ShipmentService(conn.db, new MockErp(conn.db), directory)), new InviteService(conn.db), new FleetService(conn.db), out, new CardStore(conn.db), { titles: new TitleService(conn.db), signatures: new SignatureService(conn.db), verifier }, 'test-token', 'test_bot', pino({ level: 'silent' }))
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
      await act(pressIn(3, payloadOf(offer, 'Принять')))
      // Решение 25.09: телефон перевозчика нужен уже в Т1 — спрашиваем при первом «Принять заявку»
      expect(out.last?.text).toMatch(/Подтвердите номер телефона[\s\S]*записывается в транспортную накладную/)
      await act(ownPhone(3, '79170001122'))
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

  describe('рейс: машина, водитель, погрузка', () => {
    const openCarrierTrip = async (ref: string) => {
      await act(press(3, 'open:carrier'))
      await act(press(3, 'tl:carrier'))
      await act(press(3, payloadOf(out.last, ref)))
    }

    it('перевозчик вводит новую машину и назначает водителя контактом', async () => {
      await act(press(4, 'add:driver'))
      await openCarrierTrip('ОТГ-2026-1040')
      await act(press(3, payloadOf(out.last, 'Назначить машину')))
      expect(out.last?.text).toMatch(/Машин пока нет/)
      await act(press(3, 'nvh'))
      await act(text(3, 'КАМАЗ'))
      expect(out.last?.text).toMatch(/Не похоже на госномер/)
      await act(text(3, 'a245km116'))
      await act(text(3, 'КАМАЗ 65115'))
      await act(press(3, 'vb:0'))
      await act(text(3, '15'))
      await act(text(3, '30'))
      await act(press(3, 'own:own'))
      expect(out.last?.text).toMatch(/Водитель на рейс/)
      await act(contact(3, { user_id: 4, first_name: 'Иван' }))
      expect(out.last?.text).toMatch(/Машина и водитель назначены[\s\S]*КАМАЗ 65115 А245КМ116, водитель: Человек 4/)
      const trip = out.inbox.get(4)!.at(-1)!
      expect(trip.text).toMatch(/Вам назначен рейс/)
      expect(buttons(trip)).toEqual(['Принять рейс', 'Отказаться от рейса', 'Обновить', 'В меню'])
    })

    it('водитель: принять рейс → на погрузке → всё верно → номер один раз → ход отправителя', async () => {
      await act(press(4, 'trip'))
      await act(press(4, payloadOf(out.last, 'Принять рейс')))
      await act(press(4, payloadOf(out.last, 'Я на погрузке')))
      await act(pressIn(4, payloadOf(out.last, 'Всё верно')))
      expect(out.last?.text).toMatch(/Подтвердите номер телефона/)
      expect((out.last?.buttons ?? []).flat()[0]).toMatchObject({ kind: 'request_contact' })

      await act(ownPhone(4, '79170001122', 'wrong-token'))
      expect(out.last?.text).toMatch(/Не получилось подтвердить номер/)
      await act(ownPhone(4, '79170001122'))
      expect(out.last?.text).toMatch(/груз у водителя, нужна подпись отправителя/)
      const shipperNote = out.inbox.get(1)!.at(-1)!
      expect(shipperNote.text).toMatch(/водитель принял груз без замечаний/)
      expect(buttons(shipperNote)).toContain('Подписать накладную')
    })

    it('машина уже в другом рейсе — назначить нельзя', async () => {
      await openCarrierTrip('ОТГ-2026-1045')
      await act(press(3, payloadOf(out.last, 'Принять заявку')))
      await act(press(3, payloadOf(out.last, 'Назначить машину')))
      await act(press(3, payloadOf(out.last, 'КАМАЗ 65115')))
      await act(press(3, payloadOf(out.last, 'Человек 4')))
      expect(out.last?.text).toMatch(/Эта машина уже в другой перевозке/)
    })

    it('незнакомому водителю — приглашение; по ссылке он сразу в рейсе, замечания уходят отправителю', async () => {
      await openCarrierTrip('ОТГ-2026-1045')
      await act(press(3, payloadOf(out.last, 'Назначить машину')))
      await act(press(3, 'nvh'))
      await act(text(3, 'В123ОР116'))
      await act(text(3, 'МАЗ 5440'))
      await act(press(3, 'vb:0'))
      await act(text(3, '15'))
      await act(text(3, '30'))
      await act(press(3, 'own:lease'))
      await act(text(3, 'ООО «Лизинг-Центр»'))
      await act(contact(3, { user_id: 600, first_name: 'Пётр' }))
      expect(out.last?.text).toMatch(/Пётр ещё не пользуется ботом[\s\S]*start=inv_/)
      const link = tokenIn(out.last)

      await act(started(600, `inv_${link}`))
      expect(out.last?.text).toMatch(/Вы в перевозке как водитель[\s\S]*ждём, что водитель примет рейс/)
      await act(press(600, payloadOf(out.last, 'Принять рейс')))
      await act(press(600, payloadOf(out.last, 'Я на погрузке')))
      await act(pressIn(600, payloadOf(out.last, 'Есть замечания')))
      await act(ownPhone(600, '+7 917 555-66-77'))
      expect(out.last?.text).toMatch(/Замечания к грузу/)
      await act(text(600, 'Недостача 2 канистры'))
      expect(out.last?.text).toMatch(/Замечания при погрузке: Недостача 2 канистры/)
      expect(out.inbox.get(1)!.at(-1)!.text).toMatch(/с замечаниями: Недостача 2 канистры/)
    })

    it('в «Машины и водители» — обе машины и оба водителя', async () => {
      await act(press(3, 'fleet'))
      expect(out.last?.text).toMatch(/КАМАЗ 65115 А245КМ116, собственная[\s\S]*МАЗ 5440 В123ОР116, лизинг, владелец ООО «Лизинг-Центр»[\s\S]*Человек 4[\s\S]*Человек 600/)
    })
  })

  describe('один человек в двух ролях', () => {
    it('перевозчик назначает водителем себя — «Вам назначен рейс» приходит ему же как водителю', async () => {
      await act(press(3, 'add:driver'))
      await openRef(act, out, '1047')
      await act(press(1, payloadOf(out.last, 'Назначить перевозчика')))
      await act(contact(1, { user_id: 3, first_name: 'Олег' }))
      await act(press(3, payloadOf(out.inbox.get(3)!.at(-1)!, 'Принять заявку')))
      await act(press(3, payloadOf(out.last, 'Назначить машину')))
      await act(press(3, 'nvh'))
      await act(text(3, 'Е777КХ116'))
      await act(text(3, 'ГАЗон Next'))
      await act(press(3, 'vb:0'))
      await act(text(3, '15'))
      await act(text(3, '30'))
      await act(press(3, 'own:own'))
      const before = out.inbox.get(3)!.length
      await act(contact(3, { user_id: 3, first_name: 'Олег' }))
      const mine = out.inbox.get(3)!.slice(before)
      expect(mine.some((m) => /Вам назначен рейс/.test(m.text))).toBe(true)
    })
  })

  describe('отмена перевозки', () => {
    it('отправитель отменяет с подтверждением и причиной, перевозчик и водитель узнают один раз', async () => {
      await openRef(act, out, '1047')
      await act(press(1, payloadOf(out.last, 'Отменить перевозку')))
      expect(out.last?.text).toMatch(/Отменить перевозку ОТГ-2026-1047\?[\s\S]*освободятся/)
      await act(press(1, payloadOf(out.last, 'Да, отменить')))
      const before = out.inbox.get(3)!.length
      await act(press(1, payloadOf(out.last, 'Перенос отгрузки')))
      expect(out.last?.text).toMatch(/Перевозка отменена: Перенос отгрузки[\s\S]*Статус: отменена/)
      const toCarrier = out.inbox.get(3)!.slice(before)
      expect(toCarrier).toHaveLength(1)
      expect(toCarrier[0]!.text).toMatch(/ОТГ-2026-1047 отменена отправителем: Перенос отгрузки/)
    })

    it('после отмены кнопки участников не работают, а машина и водитель свободны', async () => {
      await act(press(3, 'tl:carrier'))
      await act(press(3, payloadOf(out.last, 'ОТГ-2026-1047')))
      expect(buttons(out.last)).toEqual(['Обновить', 'В меню'])

      await openRef(act, out, '1048')
      await act(press(1, payloadOf(out.last, 'Назначить перевозчика')))
      await act(contact(1, { user_id: 3, first_name: 'Олег' }))
      await act(press(3, payloadOf(out.inbox.get(3)!.at(-1)!, 'Принять заявку')))
      await act(press(3, payloadOf(out.last, 'Назначить машину')))
      await act(press(3, payloadOf(out.last, 'ГАЗон Next')))
      const before = out.inbox.get(3)!.length
      await act(contact(3, { user_id: 3, first_name: 'Олег' }))
      // перевозчик здесь сам себе водитель: ему приходят и ответ, и «Вам назначен рейс»
      const texts = out.inbox.get(3)!.slice(before).map((m) => m.text)
      expect(texts.some((x) => /Машина и водитель назначены/.test(x))).toBe(true)
      expect(texts.some((x) => /Вам назначен рейс/.test(x))).toBe(true)
    })

    it('после погрузки, но до подписи Т1 отменить ещё можно (запрет после Т1 — в тестах домена)', async () => {
      await act(press(1, 'sl:0'))
      await act(press(1, payloadOf(out.last, '1040')))
      expect(out.last?.text).toMatch(/груз у водителя/)
      expect(buttons(out.last)).toEqual(['Подписать накладную', 'Отменить перевозку', 'Обновить', 'В меню'])
    })
  })

  describe('живые карточки', () => {
    it('перевозчик принял заявку — карточка отправителя перерисована на месте, старая погашена', async () => {
      await act(press(1, 'open:shipper'))
      let erp: { payload: string } | undefined
      for (let page = 0; !erp && page < 5; page++) {
        await act(press(1, `sl:${page}`))
        erp = (out.last?.buttons ?? []).flat().find((b) => b.text.startsWith('1049'))
      }
      await act(pressIn(1, erp!.payload, 'S-first'))
      expect(out.last?.text).toMatch(/Перевозка ОТГ-2026-1049/)

      await act(pressIn(1, payloadOf(out.last, 'Назначить перевозчика'), 'S-first'))
      await act(contact(1, { user_id: 3, first_name: 'Олег' }))
      const shipperCard = out.sentLog.filter((s) => s.userId === 1 && /Перевозка ОТГ-2026-1049/.test(s.m.text)).at(-1)!
      expect(out.edits.get('S-first')?.text).toMatch(/актуальная ниже/)

      const offer = out.sentLog.filter((s) => s.userId === 3).at(-1)!
      expect(offer.m.text).toMatch(/Новая заявка/)
      await act(pressIn(3, payloadOf(offer.m, 'Принять заявку'), offer.mid))
      expect(out.edits.get(shipperCard.mid)?.text).toMatch(/Перевозка ОТГ-2026-1049[\s\S]*перевозчик назначает машину и водителя/)
    })

    it('повторная перерисовка без изменений не трогает сообщение', async () => {
      const before = out.edits.size
      const editsBefore = new Map(out.edits)
      await act(press(3, 'tl:carrier'))
      expect(out.edits.size).toBe(before)
      expect([...out.edits.entries()]).toEqual([...editsBefore.entries()])
    })
  })

  describe('перевозчик сам за рулём', () => {
    it('без роли водителя: «Я сам за рулём» заводит роль в его компании и назначает на рейс', async () => {
      await act(press(500, 'open:carrier'))
      await act(press(500, 'tl:carrier'))
      await act(press(500, payloadOf(out.last, 'ОТГ-2026-1044')))
      await act(pressIn(500, payloadOf(out.last, 'Принять заявку')))
      await act(ownPhone(500, '79170005000'))
      await act(press(500, payloadOf(out.last, 'Назначить машину')))
      await act(press(500, 'nvh'))
      await act(text(500, 'К001КК116'))
      await act(text(500, 'Volvo FH'))
      await act(press(500, 'vb:0'))
      await act(text(500, '15'))
      await act(text(500, '30'))
      await act(press(500, 'own:rent'))
      await act(text(500, 'ИП Сидоров'))
      expect(buttons(out.last)[0]).toBe('Я сам за рулём')
      const before = out.inbox.get(500)?.length ?? 0
      await act(press(500, 'adr:self'))
      const texts = (out.inbox.get(500) ?? []).slice(before).map((m) => m.text)
      expect(texts.some((x) => /Вам назначен рейс/.test(x))).toBe(true)

      // Находка 25.09: после «Принять рейс» карточка должна остаться водительской, с «Я на погрузке»,
      // хотя текущей ролью у человека был перевозчик
      const trip = out.sentLog.filter((s) => s.userId === 500 && /Вам назначен рейс/.test(s.m.text)).at(-1)!
      await act(pressIn(500, payloadOf(trip.m, 'Принять рейс'), trip.mid))
      expect(buttons(out.last)).toContain('Я на погрузке')

      // и меню водителя показывает этот рейс, а не «рейсов нет»
      await act(press(500, 'open:driver'))
      expect(out.last?.text).toMatch(/Текущий рейс: <b>ОТГ-2026-1044<\/b> — водитель едет на погрузку[\s\S]*Сейчас ваш ход/)
      await act(text(500, '/menu'))
      expect(buttons(out.last)).toContain('✓ Водитель · ООО «Челны-Транс»')
    })

    it('водитель другого перевозчика не может назначить себя', async () => {
      // 600 — водитель ГрузЛайна (вошёл по приглашению); заводит роль перевозчика от ИП Хабибуллина
      await act(press(600, 'add:carrier'))
      await act(text(600, '165595589478'))
      await act(press(600, 'f:yes'))
      await act(press(600, 'f:later'))
      await openRef(act, out, '1050')
      await act(press(1, payloadOf(out.last, 'Назначить перевозчика')))
      await act(contact(1, { user_id: 600, first_name: 'Пётр' }))
      await act(press(600, payloadOf(out.inbox.get(600)!.at(-1)!, 'Принять заявку')))
      await act(press(600, payloadOf(out.last, 'Назначить машину')))
      await act(press(600, 'nvh'))
      await act(text(600, 'Т555ТТ116'))
      await act(text(600, 'Scania R'))
      await act(press(600, 'vb:0'))
      await act(text(600, '15'))
      await act(text(600, '30'))
      await act(press(600, 'own:own'))
      await act(press(600, 'adr:self'))
      expect(out.last?.text).toMatch(/Вы уже водитель другого перевозчика: ООО «ГрузЛайн-Казань»/)
    })
  })

  describe('справочник: демо-данные и DaData', () => {
    it('реальная компания находится через DaData, источник виден и в карточке компании', async () => {
      await act(press(700, 'add:consignee'))
      await act(text(700, '7725000018'))
      expect(out.last?.text).toMatch(/Нашли в ЕГРЮЛ \(через DaData\)[\s\S]*ООО «Настоящая»[\s\S]*ОГРН 1027700000001/)
      await act(press(700, 'f:yes'))
      await act(press(700, 'f:accept_only'))
      await act(press(700, 'company'))
      expect(out.last?.text).toMatch(/ОГРН 1027700000001[\s\S]*по данным ЕГРЮЛ \(через DaData\)/)
    })

    it('демо-организация помечена как модель', async () => {
      await act(press(1, 'open:shipper'))
      await act(press(1, 'company'))
      expect(out.last?.text).toMatch(/Демо-организация: реквизиты вымышленные \(модель\)/)
    })

    it('ликвидированную компанию подключить нельзя', async () => {
      await act(press(701, 'add:carrier'))
      await act(text(701, '5002000020'))
      expect(out.last?.text).toMatch(/ликвидирована по данным ЕГРЮЛ — подключить её нельзя/)
    })
  })

  describe('после выезда: выгрузка, получатель, приёмка', () => {
    const personId = async (maxUserId: number) => (await conn.db.select().from(person).where(eq(person.maxUserId, maxUserId)))[0]!.id
    const shipmentOf = async (ref: string) => (await conn.db.select().from(shipment).where(eq(shipment.erpRef, ref)))[0]!.id
    const ev = (maxUserId: number) => ({ maxUserId, phoneSha256: 'ab'.repeat(32), callbackId: 'c', messageMid: 'm', buttonText: 'тест', at: new Date().toISOString() })

    /** Подписи и регистрация — задачи Егора; здесь проводим перевозку до выезда прямо через ядро. */
    async function driveToTransit(id: string, driverMax: number) {
      const as = async (role: 'shipper' | 'carrier' | 'driver', max: number) => ({ kind: 'person' as const, personId: await personId(max), role })
      const steps: [Parameters<typeof svc.execute>[0], Parameters<typeof svc.execute>[1]][] = []
      const s = (await conn.db.select().from(shipment).where(eq(shipment.id, id)))[0]!
      if (s.state === 'assigned') steps.push([{ type: 'driver.acceptTrip', shipmentId: id, payload: {} }, await as('driver', driverMax)])
      if (['assigned', 'trip_accepted'].includes(s.state)) steps.push([{ type: 'driver.arrivedLoading', shipmentId: id, payload: {} }, await as('driver', driverMax)])
      if (['assigned', 'trip_accepted', 'loading'].includes(s.state))
        steps.push([{ type: 'driver.confirmLoading', shipmentId: id, payload: { remarks: null, evidence: ev(driverMax) } }, await as('driver', driverMax)])
      steps.push([{ type: 'shipper.signT1', shipmentId: id, payload: { signatureId: 'demo-t1' } }, await as('shipper', 1)])
      steps.push([{ type: 'carrier.signT2', shipmentId: id, payload: { signatureId: 'demo-t2' } }, await as('carrier', 3)])
      steps.push([{ type: 'operator.registered', shipmentId: id, payload: { operatorDocId: `op-${id}`, uid: `UID-${id.slice(0, 4)}` } }, { kind: 'operator' }])
      for (const [c, a] of steps) {
        const r = await svc.execute(c, a)
        if (!r.ok) throw new Error(`${c.type}: ${r.message}`)
      }
    }

    it('ОТГ-1056: машина выехала — получателя ещё нет в боте, ссылка у отправителя и у водителя', async () => {
      await act(press(800, 'add:driver'))
      await openRef(act, out, '1056')
      await act(press(1, payloadOf(out.last, 'Назначить перевозчика')))
      await act(contact(1, { user_id: 3, first_name: 'Олег' }))
      await act(press(3, payloadOf(out.inbox.get(3)!.at(-1)!, 'Принять заявку')))
      await act(press(3, payloadOf(out.last, 'Назначить машину')))
      await act(press(3, 'nvh'))
      await act(text(3, 'Н001НН116'))
      await act(text(3, 'ГАЗ Валдай'))
      await act(press(3, 'vb:0'))
      await act(text(3, '15'))
      await act(text(3, '30'))
      await act(press(3, 'own:own'))
      await act(contact(3, { user_id: 800, first_name: 'Семён' }))
      const id = await shipmentOf('ОТГ-2026-1056')
      await driveToTransit(id, 800)

      await bot.consigneeArrival(id)
      const toShipper = out.inbox.get(1)!.at(-1)!
      expect(toShipper.text).toMatch(/Машина по перевозке ОТГ-2026-1056 выехала[\s\S]*приёмщику ООО «Волга»[\s\S]*start=inv_/)
      const toDriver = out.inbox.get(800)!.at(-1)!
      expect(toDriver.buttons?.flat()[0]).toMatchObject({ kind: 'link', text: 'Приглашение приёмщику' })

      const token = tokenIn(toShipper)
      await act(started(900, `inv_${token}`))
      expect(out.last?.text).toMatch(/Вы в перевозке как получатель[\s\S]*в пути/)
    })

    it('водитель: «Я на выгрузке» → «Груз сдан» с номером → у получателя приёмка', async () => {
      await act(press(800, 'trip'))
      await act(press(800, payloadOf(out.last, 'Я на выгрузке')))
      expect(out.last?.text).toMatch(/машина на выгрузке/)
      await act(pressIn(800, payloadOf(out.last, 'Груз сдан')))
      expect(out.last?.text).toMatch(/Подтвердите номер телефона/)
      await act(ownPhone(800, '79170008000'))
      expect(out.last?.text).toMatch(/груз сдан, идёт приёмка/)
      const turn = out.inbox.get(900)!.at(-1)!
      expect(turn.text).toMatch(/Сейчас ваш ход/)
      expect(buttons(turn)).toEqual(['Принято без расхождений', 'Принято частично', 'Отказ от груза', 'Обновить', 'В меню'])
    })

    it('получатель: «Принято частично» → номер → расхождения → в карточке и дальше подпись', async () => {
      const turn = out.inbox.get(900)!.at(-1)!
      await act(pressIn(900, payloadOf(turn, 'Принято частично')))
      await act(ownPhone(900, '79270009000'))
      expect(out.last?.text).toMatch(/Расхождения при приёмке/)
      await act(text(900, 'Не хватает 2 канистр 5W-40'))
      expect(out.last?.text).toMatch(/нужна подпись получателя[\s\S]*Приёмка: принято частично — Не хватает 2 канистр 5W-40/)
      expect(buttons(out.last)).toContain('Подписать накладную')
      await act(press(900, 'open:consignee'))
      expect(buttons(out.last)).toContain('Приёмка (1)')
    })

    it('ОТГ-1040 того же получателя: приёмщик уже в боте — карточка сразу ему, без ссылок', async () => {
      const id = await shipmentOf('ОТГ-2026-1040')
      await driveToTransit(id, 4)
      const before = out.inbox.get(1)!.length
      await bot.consigneeArrival(id)
      const arrival = out.inbox.get(900)!.at(-1)!.text
      expect(arrival).toMatch(/Перевозка ОТГ-2026-1040/)
      expect(arrival).toMatch(/К вам едет груз/)
      expect(out.inbox.get(1)!.length).toBe(before)
      await act(press(900, 'ci'))
      expect(buttons(out.last)).toEqual(expect.arrayContaining([expect.stringMatching(/ОТГ-2026-1040 · в пути/), expect.stringMatching(/ОТГ-2026-1056/)]))
    })
  })

  describe('данные для накладной', () => {
    it('подтверждённый номер хранится целиком — он идёт в Т1', async () => {
      const [p] = await conn.db.select().from(person).where(eq(person.maxUserId, 3))
      expect(p?.phone).toBe('+79170001122')
      expect(p?.phoneSha256).toMatch(/^[0-9a-f]{64}$/)
    })

    it('грузоподъёмность вне разумных пределов не принимается', async () => {
      await openRef(act, out, '1057')
      await act(press(1, payloadOf(out.last, 'Назначить перевозчика')))
      await act(contact(1, { user_id: 3, first_name: 'Олег' }))
      await act(press(3, payloadOf(out.inbox.get(3)!.at(-1)!, 'Принять заявку')))
      await act(press(3, payloadOf(out.last, 'Назначить машину')))
      await act(press(3, 'nvh'))
      await act(text(3, 'О777ОО116'))
      await act(text(3, 'Hino 500'))
      expect(out.last?.text).toMatch(/Тип кузова/)
      await act(press(3, 'vb:3'))
      await act(text(3, '100'))
      expect(out.last?.text).toMatch(/от 0,5 до 60/)
      await act(text(3, '7,5'))
      await act(text(3, '40'))
      await act(press(3, 'own:own'))
      const [car] = await conn.db.select().from(vehicle).where(eq(vehicle.plate, 'О777ОО116'))
      expect(car).toMatchObject({ bodyType: 'Рефрижератор', capacityT: 7.5, volumeM3: 40 })
    })

    it('машина без параметров (заведена раньше) — при выборе дозапрашиваем один раз', async () => {
      await conn.db.update(vehicle).set({ bodyType: null, capacityT: null, volumeM3: null }).where(eq(vehicle.plate, 'О777ОО116'))
      await act(press(3, 'tl:carrier'))
      await act(press(3, payloadOf(out.last, 'ОТГ-2026-1057')))
      await act(press(3, payloadOf(out.last, 'Назначить машину')))
      await act(press(3, payloadOf(out.last, 'Hino 500')))
      expect(out.last?.text).toMatch(/Машина: данные для накладной[\s\S]*Тип кузова/)
      await act(press(3, 'vb:0'))
      await act(text(3, '8'))
      await act(text(3, '36'))
      expect(out.last?.text).toMatch(/Водитель на рейс/)
      const [car] = await conn.db.select().from(vehicle).where(eq(vehicle.plate, 'О777ОО116'))
      expect(car).toMatchObject({ bodyType: 'Бортовой', capacityT: 8, volumeM3: 36, ownership: 'own' })
    })
  })

  describe('подпись накладной', () => {
    const shipmentOf = async (ref: string) => (await conn.db.select().from(shipment).where(eq(shipment.erpRef, ref)))[0]!.id
    // Модель оператора: отложенные шаги копятся в pending, drain() выполняет их по очереди и двигает часы на их задержку
    const pending: [OperatorTask, string, string | undefined][] = []
    const delays: number[] = []
    let clock = new Date('2026-09-26T10:00:00Z')
    let epd: MockEpd
    let operator: OperatorLink
    const drain = async () => {
      for (let n = 0; pending.length; n++) {
        if (n > 50) throw new Error('отложенные шаги не кончаются')
        const [task, sid, arg] = pending.shift()!
        clock = new Date(clock.getTime() + delays.shift()! * 1000)
        await operator.run(task, sid, arg)
      }
    }
    beforeAll(() => {
      epd = new MockEpd(conn.db, () => clock)
      operator = new OperatorLink(conn.db, epd, svc, new TitleService(conn.db), {
        onTransition: (res, reason) => bot.afterSystemTransition(res, reason),
        later: async (task, sid, delay, arg) => {
          pending.push([task, sid, arg])
          delays.push(delay)
        },
        sendQr: (sid, file) => bot.sendQrToDriver(sid, file),
      })
    })
    let id = ''

    it('ОТГ-1057 доходит до «груз у водителя»: водитель по приглашению, номер, погрузка', async () => {
      await act(press(3, 'tl:carrier'))
      await act(press(3, payloadOf(out.last, 'ОТГ-2026-1057')))
      await act(press(3, payloadOf(out.last, 'Назначить машину')))
      await act(press(3, payloadOf(out.last, 'Hino 500')))
      await act(contact(3, { user_id: 801, first_name: 'Андрей' }))
      await act(started(801, `inv_${tokenIn(out.last)}`))
      await act(press(801, payloadOf(out.last, 'Принять рейс')))
      await act(press(801, payloadOf(out.last, 'Я на погрузке')))
      await act(pressIn(801, payloadOf(out.last, 'Всё верно')))
      await act(ownPhone(801, '79170008010'))
      expect(out.last?.text).toMatch(/груз у водителя, нужна подпись отправителя/)
      id = await shipmentOf('ОТГ-2026-1057')
    })

    it('отправитель: номер один раз → бот присылает XML Т1, он проходит схему ФНС', async () => {
      await act(pressIn(1, `sg:T1:${id}`))
      expect(out.last?.text).toMatch(/записывается в транспортную накладную/)
      await act(ownPhone(1, '79172000001'))
      const fileMsgOut = out.sentLog.filter((s) => s.userId === 1 && s.m.file).at(-1)!
      expect(fileMsgOut.m.file!.name).toMatch(/^ON_TRNACLGROT_2DM-DEMO-OPER_2DM-9782242514_\d{8}_[0-9a-f-]{36}\.xml$/)
      const xml = fileMsgOut.m.file!.bytes
      expect((await validateTitle('T1', xml)).errors).toEqual([])
      expect(decode1251(xml)).toMatch(/РегНомер="О777ОО116"[\s\S]*Тип="Грузовой бортовой" Марка="Hino 500" Грузопод="8.00" Вместим="36.00"/)
      expect(out.last?.text).toMatch(/Подпишите накладную ОТГ-2026-1057[\s\S]*«Госключ»/)
      expect(buttons(out.last)).toEqual(['Открыть «Госключ» в MAX', 'Демо-подпись (модель)', 'Отмена'])
    })

    it('прислали наш же XML — просим файл подписи', async () => {
      await act(fileMsg(1, 'накладная.xml', 'https://files.test/xml'))
      expect(out.last?.text).toMatch(/нужен файл подписи из «Госключа»/)
    })

    it('подпись не прошла проверку — человек видит причины', async () => {
      vi.stubGlobal('fetch', async () => new Response(new Uint8Array([1, 2, 3])))
      verifier.next = { ok: false, level: 'unep', signer: null, checks: [{ name: 'inn', ok: false, message: 'ИНН в подписи не совпадает с ИНН отправителя' }] }
      await act(fileMsg(1, 'doc.xml.sig', 'https://files.test/sig', true))
      expect(out.last?.text).toMatch(/Подпись не прошла проверку[\s\S]*ИНН в подписи не совпадает/)
      const call = verifier.calls.at(-1)!
      expect(call.expectedInn).toBe('9782242514')
      const t1 = out.sentLog.filter((s) => s.userId === 1 && s.m.file).at(-1)!.m.file!.bytes
      expect(Buffer.from(call.document).equals(Buffer.from(t1))).toBe(true)
    })

    it('подпись прошла — Т1 подписан, ход перевозчика', async () => {
      verifier.next = {
        ok: true,
        level: 'unep',
        signer: { fullName: 'Соколова Марина', inn: '9782242514', snils: '000-000-000 00', certificate: 'MII' },
        checks: [{ name: 'signature', ok: true, message: '' }],
      }
      await act(fileMsg(1, 'doc.xml.sig', 'https://files.test/sig', true))
      vi.unstubAllGlobals()
      expect(out.last?.text).toMatch(/нужна подпись перевозчика/)
      expect(out.inbox.get(3)!.at(-1)!.text).toMatch(/Сейчас ваш ход/)
    })

    it('перевозчик: без номера накладной от оператора Т2 не собрать; оператор выдал — XML Т2 по схеме, демо-подпись', async () => {
      await act(press(3, `sg:T2:${id}`))
      expect(out.last?.text).toMatch(/оператор ещё не выдал номер накладной/)
      // Оператор недоступен минуту: титул примется, когда он «вернётся», без перезапуска
      await epd.setUnavailable(60)
      await operator.submit(id, 'T1')
      expect((await conn.db.select().from(shipment).where(eq(shipment.id, id)))[0]!.uid).toBeNull()
      expect(pending).toEqual([['operator.submit', id, 'T1']])
      expect(delays).toEqual([61])
      // Модель оператора: в ответ на Т1 — номер накладной (в работе это делает очередь по submitTitle)
      await drain()
      const [s] = await conn.db.select().from(shipment).where(eq(shipment.id, id))
      expect(s!.uid).toMatch(/^[0-9a-f-]{36}$/)
      const events = await conn.db.select().from(event).where(eq(event.shipmentId, id))
      expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['operator.unavailable', 'operator.accepted']))
      await act(press(3, `sg:T2:${id}`))
      const t2 = out.sentLog.filter((s) => s.userId === 3 && s.m.file).at(-1)!.m.file!
      expect((await validateTitle('T2', t2.bytes)).errors).toEqual([])
      // В Т2 — подпись Т1 целиком (тот .sig, что прислал отправитель)
      expect(decode1251(t2.bytes)).toContain(`ЭП="${Buffer.from([1, 2, 3]).toString('base64')}"`)
      await act(press(3, `sgd:T2:${id}`))
      expect(out.last?.text).toMatch(/регистрируется в ГИС ЭПД/)
    })

    it('оператор отклонил Т2, потом ошибка ГИС: перевозчик видит причину и подписывает заново', async () => {
      const state = async () => (await conn.db.select().from(shipment).where(eq(shipment.id, id)))[0]!.state
      await epd.setFaults({ rejectT2: { code: 'E-T2-17', message: 'не заполнен вес брутто' }, gisError: { code: 'GIS-503', message: 'сервис временно недоступен' } })

      await operator.submit(id, 'T2')
      await drain()
      expect(await state()).toBe('t1_signed')
      expect(out.inbox.get(3)!.at(-1)!.text).toMatch(/отклонил титул перевозчика \(модель\): не заполнен вес брутто, код E-T2-17[\s\S]*Подпишите накладную ещё раз/)
      // Повтор того же задания очереди после отказа ничего не ломает
      await operator.submit(id, 'T1')

      await act(press(3, `sgd:T2:${id}`))
      await operator.submit(id, 'T2')
      await drain()
      expect(await state()).toBe('t1_signed')
      expect(out.inbox.get(3)!.at(-1)!.text).toMatch(/ГИС ЭПД не зарегистрировала накладную \(модель\): сервис временно недоступен, код GIS-503/)

      // Сбои одноразовые: третья подпись проходит
      expect(await epd.faults()).toMatchObject({ rejectT2: null, gisError: null })
      await act(press(3, `sgd:T2:${id}`))
      expect(await state()).toBe('registering')
    })

    it('Т2 у оператора: регистрация в ГИС ЭПД → «в пути», водителю «ваш ход» и анимированный QR после задержки', async () => {
      const before = out.inbox.get(801)!.length
      await epd.setFaults({ qrDelayS: 30 })
      await operator.submit(id, 'T2')
      await operator.submit(id, 'T2') // повтор из очереди — титул у оператора один, регистрация одна
      expect(pending.map(([task]) => task)).toEqual(['operator.poll', 'operator.poll'])
      await drain()
      const [s] = await conn.db.select().from(shipment).where(eq(shipment.id, id))
      expect(s!.state).toBe('in_transit')

      // QR — последствие sendQrToDriver; с ручкой задержки оператор отвечает «не готов», повтор отложенным шагом
      await operator.deliverQr(id)
      expect(pending).toEqual([['operator.qr', id, undefined]])
      expect(out.inbox.get(801)!.slice(before).some((m) => m.file)).toBe(false)
      await drain()
      const toDriver = out.inbox.get(801)!.slice(before)
      expect(toDriver.some((m) => /Сейчас ваш ход/.test(m.text) && buttons(m).includes('Я на выгрузке'))).toBe(true)
      const qr = toDriver.find((m) => m.file)!
      expect(qr.file!.name).toBe('QR-ОТГ-2026-1057.gif')
      const gif = Buffer.from(qr.file!.bytes)
      expect(gif.subarray(0, 6).toString()).toBe('GIF89a')
      expect(gif.includes('NETSCAPE2.0')).toBe(true) // зацикленная анимация
      expect(qr.text).toMatch(/Модель ГИС ЭПД/)
      await epd.setFaults({ qrDelayS: 0 })
    })

    it('до закрытия: выгрузка → получатель по ссылке → приёмка частично → Т3 и Т4 по схемам → «закрыта»', async () => {
      // Получатель ОТГ-1057 («Прикамье») ещё не в боте — приглашение отправителю
      await bot.consigneeArrival(id)
      await act(started(902, `inv_${tokenIn(out.inbox.get(1)!.at(-1)!)}`))
      expect(out.last?.text).toMatch(/Вы в перевозке как получатель/)

      await act(press(801, 'trip'))
      await act(press(801, payloadOf(out.last, 'Я на выгрузке')))
      await act(pressIn(801, payloadOf(out.last, 'Груз сдан')))
      const turn = out.inbox.get(902)!.at(-1)!
      expect(turn.text).toMatch(/Сейчас ваш ход/)

      await act(pressIn(902, payloadOf(turn, 'Принято частично')))
      await act(ownPhone(902, '79270009020'))
      await act(text(902, 'Не хватает 1 бочки 10W-40'))
      expect(buttons(out.last)).toContain('Подписать накладную')

      await act(pressIn(902, `sg:T3:${id}`))
      const t3 = out.sentLog.filter((s) => s.userId === 902 && s.m.file).at(-1)!.m.file!
      expect(t3.name).toMatch(/^ON_TRNACLGRPO_/)
      expect((await validateTitle('T3', t3.bytes)).errors).toEqual([])
      expect(decode1251(t3.bytes)).toMatch(/СодОпПр="Груз принят частично"[\s\S]*ОбщСвСост="Расхождения: Не хватает 1 бочки 10W-40"/)
      await act(press(902, `sgd:T3:${id}`))
      expect(out.inbox.get(3)!.at(-1)!.text).toMatch(/Сейчас ваш ход/)

      await act(press(3, `sg:T4:${id}`))
      const t4 = out.sentLog.filter((s) => s.userId === 3 && s.m.file).at(-1)!.m.file!
      expect(t4.name).toMatch(/^ON_TRNACLPVYN_/)
      expect((await validateTitle('T4', t4.bytes)).errors).toEqual([])
      expect(decode1251(t4.bytes)).toContain(`ИдФайлИнфГП="${t3.name.replace(/\.xml$/, '')}"`)
      await act(press(3, `sgd:T4:${id}`))
      expect(out.last?.text).toMatch(/Статус: закрыта/)
      const [s] = await conn.db.select().from(shipment).where(eq(shipment.id, id))
      expect(s!.state).toBe('closed')

      // Т3 и Т4 у оператора: порядок и сцепка подписей сходятся, ошибок в журнале нет
      await operator.submit(id, 'T3')
      await operator.submit(id, 'T4')
      const kinds = (await conn.db.select().from(mockEpdTitle).where(eq(mockEpdTitle.operatorDocId, s!.operatorDocId!))).map((t) => t.kind)
      expect(kinds).toEqual(['T1', 'T2', 'T2', 'T2', 'T3', 'T4'])
      const errors = (await conn.db.select().from(event).where(eq(event.shipmentId, id))).filter((e) => e.type === 'operator.error')
      expect(errors).toEqual([])
    })
  })
})
