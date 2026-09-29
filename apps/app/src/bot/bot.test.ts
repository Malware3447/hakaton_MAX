import type { Messenger, OutMessage } from '@nk/domain'
import { createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MockDirectory } from '../adapters/mock-directory.ts'
import { ChainDirectory } from '../adapters/dadata-directory.ts'
import { openDb, readSeed } from '../db/boot.ts'
import { resetDemo } from '../db/seed.ts'
import { buildWorkbook } from '../core/erp-import.ts'
import { OrgInviteService } from '../core/org-invites.ts'
import { sampleRows, sampleRowsWithErrors } from '../db/erp-sample.ts'
import { event, membership, mockEpdTitle, participant, person, shipment, signature, vehicle } from '../db/schema.ts'
import type { MaxUpdate } from '../max/types.ts'
import { MockErp } from '../adapters/mock-erp.ts'
import { ShipmentService } from '../core/shipments.ts'
import { InviteService } from '../core/invite-service.ts'
import { FleetService } from '../core/fleet.ts'
import { CardStore } from './card-store.ts'
import { TitleService } from '../core/titles.ts'
import { DEFAULT_FAULTS, MockEpd } from '../adapters/mock-epd.ts'
import { OperatorLink, type OperatorTask } from '../core/operator-link.ts'
import { SignatureService, type SignatureVerification } from '../core/signatures.ts'
import { DemoCaSigner } from '../core/demo-signer.ts'
import { DemoCa, decode1251 } from '@nk/etrn'
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
  deleted: string[] = []
  async delete(mid: string) {
    this.deleted.push(mid)
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
  for (let page = 0; page < 10; page++) {
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
  let caDir = ''
  let demoCa: DemoCa
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
  /** Последнее уведомление «🔔/ℹ️ …» человеку → «Открыть» → его карточка (решение 26.09). */
  const openLast = async (u: number) => {
    const notice = [...(out.inbox.get(u) ?? [])].reverse().find((m) => (m.buttons ?? []).flat().some((b) => b.text === 'Открыть'))
    if (!notice) throw new Error(`у ${u} нет уведомления с «Открыть»`)
    await act(pressIn(u, payloadOf(notice, 'Открыть'), `notice-${u}`))
    return out.last!
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
    svc = new ShipmentService(conn.db, new MockErp(conn.db), directory)
    const titles = new TitleService(conn.db)
    const signatures = new SignatureService(conn.db)
    // Демо-подпись настоящая: свой УЦ ГОСТ во временной папке
    caDir = await mkdtemp(join(tmpdir(), 'nk-bot-demo-ca-'))
    demoCa = new DemoCa(caDir)
    const demo = new DemoCaSigner(conn.db, demoCa, svc, titles, signatures)
    bot = new Bot(new BotStore(conn.db), out, directory, svc, new InviteService(conn.db), new FleetService(conn.db), out, new CardStore(conn.db), { titles, signatures, verifier, demo }, 'test-token', 'test_bot', pino({ level: 'silent' }), new MockErp(conn.db), new OrgInviteService(conn.db))
  })
  afterAll(async () => {
    await conn.pool.end()
    await rm(caDir, { recursive: true, force: true })
  })

  it('первый вход — приветствие и четыре роли', async () => {
    await act({ update_type: 'bot_started', timestamp: 0, chat_id: 1, user: user(1) })
    expect(buttons(out.last)).toEqual(['+ Отправитель', '+ Перевозчик', '+ Водитель', '+ Получатель', 'Помощь'])
  })

  it('отправитель: ИНН → подтверждение → «руководитель» без доверенности → учётная система', async () => {
    await act(press(1, 'add:shipper'))
    expect(out.last?.text).toMatch(/ИНН/)
    await act(text(1, '9782242515'))
    expect(out.last?.text).toMatch(/контрольная цифра/)
    await act(text(1, '9782242514'))
    expect(out.last?.text).toMatch(/Волжский завод моторных масел/)
    await act(press(1, 'f:yes'))
    expect(out.last?.text).toMatch(/Кто подписывает документы за компанию/)
    await act(press(1, 'f:signer_head'))
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
    await act(press(1, 'f:signer_employee'))
    // роль заведена, и бот сразу просит доверенность сотрудника (HAKATON-49)
    expect(out.last?.text).toMatch(/Пришлите сюда файл доверенности/)
    await act(press(1, 'pa:manual'))
    await act(text(1, 'МЧД-1'))
    expect(out.last?.text).toMatch(/выглядит так/)
    await act(text(1, '4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f'))
    await act(text(1, '01.01.2020'))
    await act(text(1, '01.06.2020'))
    expect(out.last?.text).toMatch(/истекла/)
    await act(text(1, '4F1C2D3E-5A6B-4C7D-8E9F-0A1B2C3D4E5F'))
    await act(text(1, '01.09.2026'))
    await act(text(1, '31.12.2027'))
    expect(out.last?.text).toMatch(/Доверенность принята.*4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f.*31\.12\.2027/s)
    expect(out.last?.text).toMatch(/введена вручную/)
    expect(out.last?.text).toMatch(/сверка с реестром выключена/)
    await act(press(1, 'company'))
    expect(out.last?.text).toMatch(/не проверены/)
    expect(out.last?.text).toMatch(/4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f/)
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
      await act(press(3, 'f:signer_head'))
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
      // Решение 26.09: тому, чей ход, — короткая инструкция и «Открыть», а не карточка целиком
      const notice = out.inbox.get(3)!.at(-1)!
      expect(notice.text).toMatch(/🔔 <b>Перевозка ОТГ-2026-1040<\/b>\n.*Волжский.*предлагает перевезти груз/)
      expect(buttons(notice)).toEqual(['Открыть'])
      const offer = await openLast(3)
      expect(offer.text).toMatch(/Что сделать:.*примите заявку/)
      expect(buttons(offer)).toEqual(['Принять заявку', 'Отклонить', 'Обновить', 'В меню'])
      await act(press(3, 'open:carrier'))
      expect(buttons(out.last)).toContain('Ждут меня (1)')
      expect(buttons(out.last)).toContain('Новые заявки (1)')
    })

    it('перевозчик принимает — отправителю приходит «принял», двойное нажатие безвредно', async () => {
      const offer = await openLast(3)
      await act(pressIn(3, payloadOf(offer, 'Принять')))
      // Решение 25.09: телефон перевозчика нужен уже в Т1 — спрашиваем при первом «Принять заявку»
      expect(out.last?.text).toMatch(/Подтвердите номер телефона[\s\S]*записывается в транспортную накладную/)
      await act(ownPhone(3, '79170001122'))
      expect(out.last?.text).toMatch(/перевозчик назначает машину и водителя/)
      expect(out.inbox.get(1)!.at(-1)!.text).toMatch(/ℹ️ <b>Перевозка ОТГ-2026-1040<\/b>\nПеревозчик .* принял заявку/)
      expect(out.last?.text).toMatch(/✅ Заявка принята/)
      await act(press(3, payloadOf(offer, 'Принять')))
      expect(out.lastNotification).toBe('Уже сделано')
    })

    it('отказ с причиной: отправителю приходит причина и снова его ход', async () => {
      await act(press(1, 'sl:0'))
      await act(press(1, payloadOf(out.last, '1041')))
      await act(press(1, payloadOf(out.last, 'Назначить перевозчика')))
      await act(contact(1, { user_id: 3, first_name: 'Олег' }))
      const offer = await openLast(3)
      await act(press(3, payloadOf(offer, 'Отклонить')))
      await act(text(3, 'Машина в ремонте'))
      expect(out.last?.text).toMatch(/Заявка отклонена/)
      expect(out.inbox.get(1)!.at(-1)!.text).toMatch(/Перевозчик отклонил заявку: Машина в ремонте\. Назначьте другого/)
      const back = await openLast(1)
      expect(back.text).toMatch(/ждёт назначения перевозчика/)
      expect(buttons(back)).toContain('Назначить перевозчика')
    })

    it('незнакомому в боте перевозчику — приглашение по ссылке', async () => {
      await act(press(1, 'sl:0'))
      await act(press(1, payloadOf(out.last, '1043')))
      await act(press(1, payloadOf(out.last, 'Назначить перевозчика')))
      await act(contact(1, { user_id: 999, first_name: 'Новенький' }))
      expect(out.last?.text).toMatch(/Новенький ещё не пользуется ботом[\s\S]*https:\/\/max\.ru\/test_bot\?start=inv_/)
      // отправитель открыл свою ссылку для перевозчика — не становится перевозчиком
      await act(started(1, `inv_${tokenIn(out.last)}`))
      expect(out.last?.text).toMatch(/приглашение для роли «перевозчик»[\s\S]*Вы сами его отправили/)
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
      await act(press(500, 'f:signer_head'))
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
      expect(out.inbox.get(4)!.at(-1)!.text).toMatch(/Вам назначен рейс от ООО «ГрузЛайн-Казань»\. Примите его/)
      const trip = await openLast(4)
      expect(buttons(trip)).toEqual(['Принять рейс', 'Отказаться от рейса', 'Обновить', 'В меню'])
    })

    it('водитель: принять рейс → на погрузке → всё верно → номер один раз → ход отправителя', async () => {
      await act(press(4, 'trip'))
      await act(press(4, payloadOf(out.last, 'Принять рейс')))
      expect(out.last?.text).toMatch(/✅ Рейс принят[\s\S]*Что сделать:.*«Я на погрузке»/)
      // Остальным, кого шаг касается, — что произошло, с «Открыть» (решение 26.09)
      const info = out.inbox.get(3)!.at(-1)!
      expect(info.text).toMatch(/ℹ️ <b>Перевозка ОТГ-2026-1040<\/b>\nВодитель Человек 4 принял рейс/)
      expect(buttons(info)).toEqual(['Открыть'])
      await act(press(4, payloadOf(out.last, 'Я на погрузке')))
      await act(pressIn(4, payloadOf(out.last, 'Всё верно')))
      expect(out.last?.text).toMatch(/Подтвердите номер телефона/)
      expect((out.last?.buttons ?? []).flat()[0]).toMatchObject({ kind: 'request_contact' })

      await act(ownPhone(4, '79170001122', 'wrong-token'))
      expect(out.last?.text).toMatch(/Не получилось подтвердить номер/)
      await act(ownPhone(4, '79170001122'))
      expect(out.last?.text).toMatch(/груз у водителя, нужна подпись отправителя/)
      expect(out.last?.text).toMatch(/✅ Приём груза подтверждён вашей подписью/)
      expect(out.inbox.get(1)!.at(-1)!.text).toMatch(/Водитель принял груз без замечаний\. Подпишите накладную/)
      expect(buttons(await openLast(1))).toContain('Подписать накладную')
    })

    it('одна машина и один водитель везут несколько рейсов за раз (решение 26.09)', async () => {
      // ОТГ-1045 перевозчик принимает для следующего теста; второй рейс водителю 4 — ОТГ-1042
      await openCarrierTrip('ОТГ-2026-1045')
      await act(press(3, payloadOf(out.last, 'Принять заявку')))
      await openRef(act, out, '1042')
      await act(press(1, payloadOf(out.last, 'Назначить перевозчика')))
      await act(contact(1, { user_id: 3, first_name: 'Олег' }))
      await act(press(3, payloadOf(await openLast(3), 'Принять заявку')))
      await act(press(3, payloadOf(out.last, 'Назначить машину')))
      await act(press(3, payloadOf(out.last, 'КАМАЗ 65115')))
      await act(press(3, payloadOf(out.last, 'Человек 4')))
      expect(out.last?.text).toMatch(/Машина и водитель назначены[\s\S]*КАМАЗ 65115 А245КМ116, водитель: Человек 4/)

      await act(press(4, 'open:driver'))
      expect(out.last?.text).toMatch(/Рейсов в работе: 2/)
      expect(out.last?.text).toMatch(/ОТГ-2026-1040/)
      expect(out.last?.text).toMatch(/ОТГ-2026-1042 <\/b>|<b>ОТГ-2026-1042<\/b> — ждём, что водитель примет рейс/)
      await act(press(4, payloadOf(out.last, 'Открыть рейсы')))
      expect(buttons(out.last)).toEqual(expect.arrayContaining([expect.stringMatching(/ОТГ-2026-1040/), expect.stringMatching(/ОТГ-2026-1042/)]))
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
      await act(press(3, payloadOf(await openLast(3), 'Принять заявку')))
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
      await act(press(3, payloadOf(await openLast(3), 'Принять заявку')))
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

      expect(out.inbox.get(3)!.at(-1)!.text).toMatch(/предлагает перевезти груз/)
      await act(pressIn(3, payloadOf(await openLast(3), 'Принять заявку'), 'notice-3'))
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
      await act(pressIn(500, payloadOf(await openLast(500), 'Принять рейс'), 'notice-500'))
      expect(buttons(out.last)).toContain('Я на погрузке')

      // и меню водителя показывает этот рейс, а не «рейсов нет»
      await act(press(500, 'open:driver'))
      expect(out.last?.text).toMatch(/Рейс в работе:\n• <b>ОТГ-2026-1044<\/b> — водитель едет на погрузку[\s\S]*Ждут вашего действия: 1/)
      await act(text(500, '/menu'))
      expect(buttons(out.last)).toContain('✓ Водитель · ООО «Челны-Транс»')
    })

    it('водитель другого перевозчика назначает себя — теперь он водитель у обоих', async () => {
      // 600 — водитель ГрузЛайна (вошёл по приглашению); заводит роль перевозчика от ИП Хабибуллина
      await act(press(600, 'add:carrier'))
      await act(text(600, '165595589478'))
      await act(press(600, 'f:yes'))
      await act(press(600, 'f:signer_head'))
      await openRef(act, out, '1050')
      await act(press(1, payloadOf(out.last, 'Назначить перевозчика')))
      await act(contact(1, { user_id: 600, first_name: 'Пётр' }))
      await act(press(600, payloadOf(await openLast(600), 'Принять заявку')))
      await act(press(600, payloadOf(out.last, 'Назначить машину')))
      await act(press(600, 'nvh'))
      await act(text(600, 'Т555ТТ116'))
      await act(text(600, 'Scania R'))
      await act(press(600, 'vb:0'))
      await act(text(600, '15'))
      await act(text(600, '30'))
      await act(press(600, 'own:own'))
      const before = out.inbox.get(600)!.length
      await act(press(600, 'adr:self'))
      // Решение 26.09: водитель может работать на нескольких перевозчиков — назначаем, а не отказываем.
      // Он сам себе водитель: кроме ответа ему приходит и «Вам назначен рейс»
      const mine = out.inbox.get(600)!.slice(before).map((m) => m.text)
      expect(mine.some((x) => /Вам назначен рейс/.test(x))).toBe(true)
      await act(text(600, '/menu'))
      expect(buttons(out.last)).toEqual(expect.arrayContaining([expect.stringMatching(/Водитель · ООО «ГрузЛайн-Казань», ИП Хабибуллин Р\. Ф\./)]))
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
      await act(press(3, payloadOf(await openLast(3), 'Принять заявку')))
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
      // ссылка текстом, без кнопки: по кнопке её легко открыть самому (решение 29.09)
      expect(toDriver.text).toMatch(/Ссылка для приёмщика ООО «Волга»[\s\S]*Сами не открывайте[\s\S]*start=inv_/)
      expect(toDriver.buttons ?? []).toEqual([])
      expect(tokenIn(toDriver)).toBe(tokenIn(toShipper))

      const token = tokenIn(toShipper)
      // свою ссылку не принять: ни отправителю, ни водителю этой перевозки
      await act(started(1, `inv_${token}`))
      expect(out.last?.text).toMatch(/его должен открыть другой человек[\s\S]*Вы сами его отправили/)
      await act(started(800, `inv_${token}`))
      expect(out.last?.text).toMatch(/Вы уже в этой перевозке как водитель/)
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
      expect(out.inbox.get(900)!.at(-1)!.text).toMatch(/🔔[\s\S]*Груз у вас\. Проверьте его и отметьте приёмку/)
      const turn = await openLast(900)
      expect(buttons(turn)).toEqual(['Принято без расхождений', 'Принято частично', 'Отказ от груза', 'Обновить', 'В меню'])
    })

    it('получатель: «Принято частично» → номер → расхождения → в карточке и дальше подпись', async () => {
      const turn = await openLast(900)
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
      await act(press(3, payloadOf(await openLast(3), 'Принять заявку')))
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
      expect(out.last?.text).toMatch(/✅ <b>Подпись «Госключа» проверена<\/b> \(Соколова Марина, УНЭП\)\. ✅ Накладная подписана[\s\S]*нужна подпись перевозчика/)
      expect(out.inbox.get(3)!.at(-1)!.text).toMatch(/Отправитель подписал накладную\. Подпишите её со своей стороны/)
    })

    it('перевозчик: без номера накладной от оператора Т2 не собрать; оператор выдал — XML Т2 по схеме, демо-подпись', async () => {
      await act(press(3, `sg:T2:${id}`))
      expect(out.last?.text).toMatch(/оператор ЭПД ещё не выдал номер накладной \(модель\)/)
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
      expect(out.last?.text).toMatch(/регистрируется в ГИС ЭПД \(модель\)/)
      expect(out.last?.text).toMatch(/Ждём регистрации в ГИС ЭПД \(модель\) — водитель получит QR-код/)
      expect(out.inbox.get(1)!.at(-1)!.text).toMatch(/Перевозчик подписал накладную\. Ждём регистрации в ГИС ЭПД \(модель\)\./)
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
      expect(out.inbox.get(1)!.at(-1)!.text).toMatch(/Накладная зарегистрирована в ГИС ЭПД \(модель\), машина в пути/)

      // QR — последствие sendQrToDriver; с ручкой задержки оператор отвечает «не готов», повтор отложенным шагом
      await operator.deliverQr(id)
      expect(pending).toEqual([['operator.qr', id, undefined]])
      expect(out.inbox.get(801)!.slice(before).some((m) => m.file)).toBe(false)
      await drain()
      const toDriver = out.inbox.get(801)!.slice(before)
      expect(toDriver.some((m) => /Накладная зарегистрирована в ГИС ЭПД \(модель\), можно ехать/.test(m.text) && buttons(m).includes('Открыть'))).toBe(true)
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
      expect(out.inbox.get(902)!.at(-1)!.text).toMatch(/Груз у вас/)
      const turn = await openLast(902)

      await act(pressIn(902, payloadOf(turn, 'Принято частично')))
      await act(ownPhone(902, '79270009020'))
      await act(text(902, 'Не хватает 1 бочки 10W-40'))
      expect(buttons(out.last)).toContain('Подписать накладную')

      // Приёмщик пришёл по ссылке: кто он для компании, бот ещё не знает — спрашивает перед подписью (HAKATON-49)
      await act(pressIn(902, `sg:T3:${id}`))
      expect(out.last?.text).toMatch(/руководитель или сотрудник по доверенности/)
      expect(out.sentLog.filter((s) => s.userId === 902 && s.m.file?.name.startsWith('ON_TRNACLGRPO_'))).toEqual([])
      await act(pressIn(902, payloadOf(out.last!, 'Я руководитель или ИП')))
      const t3 = out.sentLog.filter((s) => s.userId === 902 && s.m.file).at(-1)!.m.file!
      expect(t3.name).toMatch(/^ON_TRNACLGRPO_/)
      expect((await validateTitle('T3', t3.bytes)).errors).toEqual([])
      expect(decode1251(t3.bytes)).toMatch(/СодОпПр="Груз принят частично"[\s\S]*ОбщСвСост="Расхождения: Не хватает 1 бочки 10W-40"/)
      // Демо-подпись перевозчика под Т2 настоящая: CMS проходит проверку демо-УЦ, её base64 — в атрибуте ЭП Т3
      const ep = /ИдФайлИнфПрвПрием="[^"]*"[^>]*\sЭП="([^"]*)"/.exec(decode1251(t3.bytes))![1]!
      const t2sig = (await conn.db.select().from(signature).where(eq(signature.shipmentId, id))).find((x) => x.cms && Buffer.from(x.cms).toString('base64') === ep)!
      expect(t2sig).toMatchObject({ kind: 'demo_ca', titleKind: 'T2', role: 'carrier', verified: true })
      const t2bytes = (await new TitleService(conn.db).get(id, 'T2'))!.bytes
      const carrierInn = (await svc.view(id, 'carrier'))!.carrier!.inn
      const check = await demoCa.verify({ document: t2bytes, sig: new Uint8Array(t2sig.cms!), expectedInn: carrierInn })
      expect(check.checks.filter((c) => !c.ok)).toEqual([])
      await act(press(902, `sgd:T3:${id}`))
      expect(out.last?.text).toMatch(/✅ <b>Демо-подпись принята<\/b> \(модель\)\. ✅ Накладная подписана/)
      expect(out.inbox.get(3)!.at(-1)!.text).toMatch(/Подпишите накладную — это закроет перевозку/)

      await act(press(3, `sg:T4:${id}`))
      const t4 = out.sentLog.filter((s) => s.userId === 3 && s.m.file).at(-1)!.m.file!
      expect(t4.name).toMatch(/^ON_TRNACLPVYN_/)
      expect((await validateTitle('T4', t4.bytes)).errors).toEqual([])
      expect(decode1251(t4.bytes)).toContain(`ИдФайлИнфГП="${t3.name.replace(/\.xml$/, '')}"`)
      const before = new Map([801, 902, 1].map((u) => [u, out.inbox.get(u)!.length]))
      await act(press(3, `sgd:T4:${id}`))
      expect(out.last?.text).toMatch(/Статус: закрыта/)
      // Находка 26.09: о закрытии сообщаем всем, кроме закрывшего — ход больше ни у кого
      for (const u of [801, 902, 1]) {
        const got = out.inbox.get(u)!.slice(before.get(u))
        expect(got.some((m) => /Накладная закрыта[\s\S]*Статус: закрыта/.test(m.text)), `участник ${u}`).toBe(true)
      }
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

  describe('из карточки в меню', () => {
    it('«В меню» в карточке удаляет карточку и присылает меню новым сообщением', async () => {
      await act(press(3, 'tl:carrier'))
      await act(pressIn(3, payloadOf(out.last, 'ОТГ-2026-1040'), 'card-to-menu'))
      expect(out.last?.text).toMatch(/Перевозка ОТГ-2026-1040/)
      const sentBefore = out.inbox.get(3)!.length
      await act(pressIn(3, payloadOf(out.last, 'В меню'), 'card-to-menu'))
      expect(out.deleted).toContain('card-to-menu')
      expect(out.inbox.get(3)!.length).toBe(sentBefore + 1)
      expect(out.last?.text).toMatch(/Перевозчик · ООО «ГрузЛайн-Казань»/)
    })

    it('«В меню» не из карточки (из списка) — ничего не удаляет, меню на месте', async () => {
      await act(press(3, 'tl:carrier'))
      const deleted = out.deleted.length
      await act(pressIn(3, payloadOf(out.last, 'В меню'), 'list-msg'))
      expect(out.deleted.length).toBe(deleted)
      expect(out.last?.text).toMatch(/Перевозчик · ООО «ГрузЛайн-Казань»/)
    })
  })

  describe('новые отгрузки из Excel (HAKATON-46)', () => {
    const serve = (bytes: Uint8Array) => vi.stubGlobal('fetch', async () => new Response(bytes))

    it('«Загрузить из Excel» в списке → шаблон файлом', async () => {
      await act(press(1, 'sl:0'))
      await act(press(1, payloadOf(out.last, 'Загрузить из Excel')))
      // инструкция — на месте списка, шаблон — следом отдельным сообщением с файлом
      const tpl = out.last!.file!
      expect(tpl.name).toBe('otgruzki-shablon.xlsx')
      expect(tpl.bytes.byteLength).toBeGreaterThan(1000)
    })

    it('таблица с ошибками: бот перечисляет их по строкам и ничего не грузит', async () => {
      serve(await buildWorkbook(sampleRowsWithErrors(await readSeed())))
      await act(fileMsg(1, 'otgruzki.xlsx', 'https://files.test/bad'))
      expect(out.last?.text).toMatch(/В таблице 5 ошибок/)
      expect(out.last?.text).toMatch(/строка 2, ОТГ-2026-2040: ИНН получателя «1167049239» с ошибкой/)
      expect(buttons(out.last)).toEqual(['Отмена'])
    })

    it('не таблица — просим .xlsx', async () => {
      await act(fileMsg(1, 'otgruzki.pdf', 'https://files.test/pdf'))
      expect(out.last?.text).toMatch(/не таблица Excel/)
    })

    it('исправленная таблица: сводка → «Загрузить 17» → отгрузки в списке', async () => {
      serve(await buildWorkbook(sampleRows(await readSeed())))
      await act(fileMsg(1, 'otgruzki.xlsx', 'https://files.test/ok'))
      expect(out.last?.text).toMatch(/Понял 17 отгрузок/)
      expect(out.last?.text).toMatch(/ОТГ-2026-2040<\/b> · ООО «Волга» · 30\.09, 11:00 · 3 поз\., 86 мест/)
      await act(press(1, payloadOf(out.last, 'Загрузить 17')))
      expect(out.last?.text).toMatch(/Отгрузки загружены[\s\S]*новых — 17/)
      await act(press(1, 'sl:0'))
      expect(out.last?.text).toMatch(/Всего 34/)
      await openRef(act, out, '2040')
      expect(out.last?.text).toMatch(/Перевозка ОТГ-2026-2040/)
      vi.unstubAllGlobals()
    })

    it('ту же таблицу ещё раз: открытую в боте отгрузку заменить нельзя', async () => {
      serve(await buildWorkbook(sampleRows(await readSeed())))
      await act(press(1, 'xi'))
      await act(fileMsg(1, 'otgruzki.xlsx', 'https://files.test/ok'))
      expect(out.last?.text).toMatch(/ОТГ-2026-2040: эта отгрузка уже открыта в боте/)
      vi.unstubAllGlobals()
    })

    it('другая компания грузит ту же таблицу — номера у компаний независимы (решение 29.09)', async () => {
      await act(press(8800, 'add:shipper'))
      await act(text(8800, '7725000018'))
      await act(press(8800, 'f:yes'))
      await act(press(8800, 'f:signer_head'))
      await act(press(8800, 'f:erp'))
      await act(press(8800, 'xi'))
      serve(await buildWorkbook(sampleRows(await readSeed())))
      await act(fileMsg(8800, 'otgruzki.xlsx', 'https://files.test/ok'))
      expect(out.last?.text).toMatch(/Понял 17 отгрузок/)
      expect(out.last?.text).not.toMatch(/занят|другой компании/)
      await act(press(8800, payloadOf(out.last, 'Загрузить 17')))
      expect(out.last?.text).toMatch(/новых — 17/)
      // у каждой своя ОТГ-2026-2040: открываются разные перевозки
      await act(press(8800, 'sl:0'))
      expect(out.last?.text).toMatch(/Всего 17/)
      vi.unstubAllGlobals()
      const both = await conn.db.select().from(shipment).where(eq(shipment.erpRef, 'ОТГ-2026-2040'))
      expect(both).toHaveLength(1) // открыта пока только у завода
      await act(press(8800, payloadOf(out.last, '2040')))
      expect(out.last?.text).toMatch(/Перевозка ОТГ-2026-2040[\s\S]*ООО «Настоящая»/)
      expect(await conn.db.select().from(shipment).where(eq(shipment.erpRef, 'ОТГ-2026-2040'))).toHaveLength(2)
    })

    it('«Загрузить» без свежей проверки — просим файл заново', async () => {
      await act(press(1, 'xc'))
      expect(out.last?.text).toMatch(/Проверка устарела/)
    })
  })

  describe('водитель отказался от первого рейса у перевозчика (находка 27.09)', () => {
    it('по ссылке открыл рейс и отказался — роли водителя у этого перевозчика не остаётся', async () => {
      await openRef(act, out, '1053')
      await act(press(1, payloadOf(out.last, 'Назначить перевозчика')))
      await act(contact(1, { user_id: 3, first_name: 'Олег' }))
      await act(press(3, payloadOf(await openLast(3), 'Принять заявку')))
      await act(press(3, payloadOf(out.last, 'Назначить машину')))
      await act(press(3, payloadOf(out.last, 'КАМАЗ 65115')))
      await act(contact(3, { user_id: 610, first_name: 'Семён' }))
      const link = tokenIn(out.last)
      expect(link).not.toBe('')

      await act(started(610, `inv_${link}`))
      expect(buttons(out.last)).toContain('Отказаться от рейса')
      await act(press(610, payloadOf(out.last, 'Отказаться от рейса')))
      await act(press(610, payloadOf(out.last, 'Машина неисправна')))
      const [p610] = await conn.db.select().from(person).where(eq(person.maxUserId, 610))
      expect(await conn.db.select().from(membership).where(eq(membership.personId, p610!.id))).toEqual([])
      await act(press(610, 'root'))
      expect(buttons(out.last)).toContain('+ Водитель')
      await act(press(3, 'fleet'))
      expect(out.last?.text).not.toMatch(/Человек 610/)
    })

    it('водитель, уже работавший у перевозчика, после отказа остаётся его водителем', async () => {
      const [p4] = await conn.db.select().from(person).where(eq(person.maxUserId, 4))
      const before = await conn.db.select().from(membership).where(eq(membership.personId, p4!.id))
      await act(press(3, 'open:carrier'))
      await act(press(3, 'tl:carrier'))
      await act(press(3, payloadOf(out.last, 'ОТГ-2026-1053')))
      await act(press(3, payloadOf(out.last, 'Назначить машину')))
      await act(press(3, payloadOf(out.last, 'КАМАЗ 65115')))
      await act(press(3, payloadOf(out.last, 'Человек 4')))
      await act(press(4, payloadOf(await openLast(4), 'Отказаться от рейса')))
      await act(press(4, payloadOf(out.last, 'Заболел')))
      expect((await conn.db.select().from(membership).where(eq(membership.personId, p4!.id))).map((m) => m.orgId)).toEqual(before.map((m) => m.orgId))
    })
  })

  describe('люди компании (HAKATON-48)', () => {
    it('администратор видит сотрудников и кнопку «Добавить сотрудника»', async () => {
      await act(press(1, 'open:shipper'))
      await act(press(1, 'company'))
      expect(out.last?.text).toMatch(/Сотрудники<\/b> \(1\)\n• Человек 1 \(вы\) — администратор, подписывает/)
      expect(buttons(out.last)).toEqual(['Добавить сотрудника', 'Выйти из компании', 'Назад'])
    })

    it('контакт того, кого нет в боте, — ссылка; по ней он входит в компанию, администратору — «вошёл»', async () => {
      await act(press(1, 'pa'))
      expect(out.last?.text).toMatch(/Перешлите сюда контакт сотрудника/)
      await act(contact(1, { user_id: 7700, first_name: 'Ольга' }))
      expect(out.last?.text).toMatch(/Ольга ещё не пользуется ботом[\s\S]*start=org_/)
      const token = /start=org_([\w-]+)/.exec(out.last!.text)![1]!
      // администратор открыл свою же ссылку — не тратим её (решение 29.09)
      await act(started(1, `org_${token}`))
      expect(out.last?.text).toMatch(/Это ваша ссылка для нового сотрудника/)
      await act(started(7700, `org_${token}`))
      expect(out.last?.text).toMatch(/Вы в компании ООО «Волжский завод моторных масел»/)
      expect(out.inbox.get(1)!.at(-1)!.text).toMatch(/Человек 7700 вошёл в компанию по ссылке, роль «отправитель»/)
      await act(press(7700, 'company'))
      expect(out.last?.text).toMatch(/Сотрудники<\/b> \(2\)/)
      expect(out.last?.text).toMatch(/Добавить сотрудника может администратор/)
      expect(buttons(out.last)).toEqual(['Выйти из компании', 'Назад'])
      // по той же ссылке второй раз не войти
      await act(started(7701, `org_${token}`))
      expect(out.last?.text).toMatch(/уже вошёл другой человек/)
    })

    it('контакт того, кто уже в боте, — добавляется сразу и получает сообщение', async () => {
      await act(press(1, 'pa'))
      await act(contact(1, { user_id: 610, first_name: 'Семён' }))
      expect(out.last?.text).toMatch(/✅ Человек 610 добавлен в компанию/)
      expect(out.inbox.get(610)!.at(-1)!.text).toMatch(/Вас добавили в компанию ООО «Волжский завод моторных масел» в роли «отправитель»/)
    })

    it('ИНН уже подключён — «Попросить доступ»: администратор добавляет одной кнопкой', async () => {
      await act(press(7720, 'add:shipper'))
      await act(text(7720, '9782242514'))
      expect(out.last?.text).toMatch(/уже подключена[\s\S]*Попросить доступ/)
      await act(press(7720, payloadOf(out.last, 'Попросить доступ')))
      expect(out.last?.text).toMatch(/Попросил администратора Человек 1/)
      const ask = out.inbox.get(1)!.at(-1)!
      expect(ask.text).toMatch(/Человек 7720 просит доступ к компании/)
      await act(press(1, payloadOf(ask, 'Добавить')))
      expect(out.last?.text).toMatch(/✅ Человек 7720 добавлен в компанию/)
      expect(out.inbox.get(7720)!.at(-1)!.text).toMatch(/Вас добавили в компанию/)
      // повторное нажатие — уже решено
      await act(press(1, payloadOf(ask, 'Добавить')))
      expect(out.last?.text).toMatch(/уже решили/)
    })

    it('отказ в доступе — просившему приходит сообщение, роли нет', async () => {
      await act(press(7721, 'add:shipper'))
      await act(text(7721, '9782242514'))
      await act(press(7721, payloadOf(out.last, 'Попросить доступ')))
      await act(press(1, payloadOf(out.inbox.get(1)!.at(-1)!, 'Отказать')))
      expect(out.inbox.get(7721)!.at(-1)!.text).toMatch(/не добавил вас в компанию/)
      await act(press(7721, 'root'))
      expect(buttons(out.last)).toContain('+ Отправитель')
    })

    it('сотрудник другой компании в той же роли добавиться не может', async () => {
      await act(press(3, 'open:carrier'))
      await act(press(3, 'company'))
      await act(press(3, 'pa'))
      await act(contact(3, { user_id: 7700, first_name: 'Ольга' }))
      // Ольга — отправитель, роль перевозчика у неё свободна: добавится
      expect(out.last?.text).toMatch(/✅ Человек 7700 добавлен в компанию/)
      await act(press(1, 'open:shipper'))
      await act(press(1, 'pa'))
      await act(contact(1, { user_id: 7700, first_name: 'Ольга' }))
      expect(out.last?.text).toMatch(/Человек 7700 уже в компании/)
    })
  })

  describe('повторная подпись того же титула (находка 29.09)', () => {
    // Вторая подпись титула той же стороной ломала сцепку: следующий титул брал последнюю подпись,
    // а оператору уже ушла первая — модель оператора отклоняла Т2, перевозка навсегда «регистрируется»
    const shipmentOf = async (ref: string) => (await conn.db.select().from(shipment).where(eq(shipment.erpRef, ref)))[0]!.id
    const stateOf = async (id: string) => (await conn.db.select().from(shipment).where(eq(shipment.id, id)))[0]!.state
    /** Подписи стороны под титулом (без простых подписей водителя и получателя). */
    const sigsOf = async (id: string, kind: 'T1' | 'T2', role: 'shipper' | 'carrier') =>
      conn.db.select().from(signature).where(and(eq(signature.shipmentId, id), eq(signature.titleKind, kind), eq(signature.role, role)))
    const pending: [OperatorTask, string, string | undefined][] = []
    const delays: number[] = []
    let clock = new Date('2026-09-29T10:00:00Z')
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
    beforeAll(async () => {
      epd = new MockEpd(conn.db, () => clock)
      await epd.setFaults(DEFAULT_FAULTS)
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

    it('отправитель жмёт «Демо-подпись» ещё раз после отправки оператору — подпись одна, ответ «Уже подписано»', async () => {
      // ОТГ-1045: водитель 600 принял груз с замечаниями, ход отправителя
      id = await shipmentOf('ОТГ-2026-1045')
      expect(await stateOf(id)).toBe('loaded')
      await act(pressIn(1, `sgd:T1:${id}`))
      expect(out.last?.text).toMatch(/Демо-подпись принята/)
      // Т1 с подписью уходит оператору (в работе — очередь по submitTitle), в ответ — номер накладной
      await operator.submit(id, 'T1')
      await drain()

      await act(pressIn(1, `sgd:T1:${id}`))
      expect(out.lastNotification).toBe('Уже подписано')
      expect(await sigsOf(id, 'T1', 'shipper')).toHaveLength(1)
      expect(await stateOf(id)).toBe('t1_signed')
    })

    it('перевозчик жмёт «Демо-подпись» дважды одновременно — подпись одна, накладная регистрируется', async () => {
      await Promise.all([act(pressIn(3, `sgd:T2:${id}`, 'sign-a')), act(pressIn(3, `sgd:T2:${id}`, 'sign-b'))])
      expect(await sigsOf(id, 'T2', 'carrier')).toHaveLength(1)
      expect(await stateOf(id)).toBe('registering')

      await operator.submit(id, 'T2')
      await drain()
      expect(await stateOf(id)).toBe('in_transit')
      const errors = (await conn.db.select().from(event).where(eq(event.shipmentId, id))).filter((e) => e.type === 'operator.error')
      expect(errors).toEqual([])
      // в Т2 — та самая подпись Т1, что ушла оператору
      const [t1sig] = await sigsOf(id, 'T1', 'shipper')
      const t2 = (await new TitleService(conn.db).get(id, 'T2'))!
      expect(decode1251(t2.bytes)).toContain(`ЭП="${Buffer.from(t1sig!.cms!).toString('base64')}"`)
      // позже — снова старая кнопка: уже подписано, перевозка в пути
      await act(pressIn(3, `sgd:T2:${id}`))
      expect(out.lastNotification).toBe('Уже подписано')
      expect(await sigsOf(id, 'T2', 'carrier')).toHaveLength(1)
    })

    it('«Госключ»: ответ переслали дважды одновременно — подпись одна; прислали снова позже — «Уже подписано»', async () => {
      // ОТГ-1044: перевозчик 500 сам за рулём, рейс принят; погрузку отмечаем прямо через ядро
      const id2 = await shipmentOf('ОТГ-2026-1044')
      const [driver] = await conn.db.select().from(person).where(eq(person.maxUserId, 500))
      const asDriver = { kind: 'person' as const, personId: driver!.id, role: 'driver' as const }
      const evidence = { maxUserId: 500, phoneSha256: 'ab'.repeat(32), callbackId: 'c', messageMid: 'm', buttonText: 'тест', at: new Date().toISOString() }
      expect((await svc.execute({ type: 'driver.arrivedLoading', shipmentId: id2, payload: {} }, asDriver)).ok).toBe(true)
      expect((await svc.execute({ type: 'driver.confirmLoading', shipmentId: id2, payload: { remarks: null, evidence } }, asDriver)).ok).toBe(true)

      await act(pressIn(1, `sg:T1:${id2}`))
      expect(out.last?.text).toMatch(/Подпишите накладную ОТГ-2026-1044/)
      verifier.next = { ok: true, level: 'ukep', signer: { fullName: 'Соколова Марина', inn: '9782242514', snils: null, certificate: 'MII' }, checks: [{ name: 'signature', ok: true, message: '' }] }
      vi.stubGlobal('fetch', async () => new Response(new Uint8Array([4, 5, 6])))
      try {
        await Promise.all([act(fileMsg(1, 'doc.xml.sig', 'https://files.test/sig-1', true)), act(fileMsg(1, 'doc.xml.sig', 'https://files.test/sig-2', true))])
        expect(await sigsOf(id2, 'T1', 'shipper')).toHaveLength(1)
        expect(await stateOf(id2)).toBe('t1_signed')

        // Снова «Подписать накладную» со старой карточки и тот же ответ «Госключа»
        await act(pressIn(1, `sg:T1:${id2}`))
        await act(fileMsg(1, 'doc.xml.sig', 'https://files.test/sig-1', true))
        expect(out.last?.text).toMatch(/Уже подписано/)
        expect(await sigsOf(id2, 'T1', 'shipper')).toHaveLength(1)
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('две записи одной подписи одновременно в обход бота — одна строка, обе вернули её id', async () => {
      // ОТГ-1044 ждёт подписи перевозчика; номер накладной для Т2 — от модели оператора
      const id2 = await shipmentOf('ОТГ-2026-1044')
      await operator.submit(id2, 'T1')
      await drain()
      const t2 = await new TitleService(conn.db).ensure(id2, 'T2')
      const [carrier] = await conn.db.select().from(person).where(eq(person.maxUserId, 500))
      const input = { shipmentId: id2, titleId: t2.id, titleKind: 'T2' as const, role: 'carrier' as const, kind: 'demo_ca' as const, personId: carrier!.id, cms: new Uint8Array([7, 7, 7]), signerName: null, signerSnils: null, verified: true, verifyResult: 'тест' }
      const signatures = new SignatureService(conn.db)
      const [a, b] = await Promise.all([signatures.record(input), signatures.record(input)])
      expect(a).toBe(b)
      expect(await sigsOf(id2, 'T2', 'carrier')).toHaveLength(1)
    })
  })

  describe('выход из компании (HAKATON-51)', () => {
    it('сотрудник выходит: роль пропадает, администратору — сообщение', async () => {
      await act(press(7720, 'open:shipper'))
      await act(press(7720, 'company'))
      await act(press(7720, payloadOf(out.last, 'Выйти из компании')))
      expect(out.last?.text).toMatch(/Выйти из компании ООО «Волжский завод моторных масел»\?[\s\S]*Роль «отправитель» у вас пропадёт/)
      await act(press(7720, payloadOf(out.last, 'Да, выйти')))
      expect(out.last?.text).toMatch(/✅ Вы вышли из компании ООО «Волжский завод моторных масел»/)
      expect(buttons(out.last)).toContain('+ Отправитель')
      expect(out.inbox.get(1)!.at(-1)!.text).toMatch(/Человек 7720 вышел из компании/)
    })

    it('последний администратор выходит: права и перевозки в работе переходят сотруднику', async () => {
      const [p1] = await conn.db.select().from(person).where(eq(person.maxUserId, 1))
      const [p7700] = await conn.db.select().from(person).where(eq(person.maxUserId, 7700))
      const mine = await conn.db.select().from(participant).where(and(eq(participant.personId, p1!.id), eq(participant.role, 'shipper')))
      expect(mine.length).toBeGreaterThan(0)
      await act(press(1, 'open:shipper'))
      await act(press(1, 'company'))
      await act(press(1, payloadOf(out.last, 'Выйти из компании')))
      expect(out.last?.text).toMatch(/Администратором станет Человек 7700[\s\S]*Перевозки в работе \(\d+: ОТГ-2026-[^)]*и другие\) перейдут к сотруднику Человек 7700/)
      await act(press(1, payloadOf(out.last, 'Да, выйти')))
      expect(out.last?.text).toMatch(/Перевозки в работе переданы: Человек 7700/)
      const got = out.inbox.get(7700)!.slice(-2).map((m) => m.text).join('\n')
      expect(got).toMatch(/Теперь администратор — вы/)
      expect(got).toMatch(/Его перевозки в работе теперь ведёте вы/)
      const [m7700] = await conn.db.select().from(membership).where(and(eq(membership.personId, p7700!.id), eq(membership.role, 'shipper')))
      expect(m7700!.isAdmin).toBe(true)
      expect(await conn.db.select().from(membership).where(and(eq(membership.personId, p1!.id), eq(membership.role, 'shipper')))).toEqual([])
      const moved = await conn.db.select().from(participant).where(and(eq(participant.personId, p7700!.id), eq(participant.role, 'shipper')))
      expect(moved.length).toBeGreaterThan(0)
    })
  })
})
