import { ROLES, isValidInn, normalizeInn, type Messenger, type OrgDirectory, type OrgRequisites, type OutMessage, type Role, type SignatureProvider } from '@nk/domain'
import type { FastifyBaseLogger } from 'fastify'
import { esc } from '../max/messenger.ts'
import type { MaxAttachment, MaxUpdate, MaxUser } from '../max/types.ts'
import { P, ROLE_TITLE, cb, companyScreen, helpScreen, roleMenu, rootMenu } from './screens.ts'
import { STATE_TEXT } from './cards.ts'
import type { BotStore, DialogState, PersonRow } from './store.ts'
import type { ExecResult, ShipmentService } from '../core/shipments.ts'
import type { InviteService } from '../core/invite-service.ts'
import { ShipmentFlows, type Reply } from './shipment-flows.ts'
import { TripFlows } from './trip-flows.ts'
import { SignFlows, fileAttachments } from './sign-flows.ts'
import type { TitleService } from '../core/titles.ts'
import type { SignatureService, SignatureVerifier } from '../core/signatures.ts'
import type { Outbox } from './outbox.ts'
import type { CardStore } from './card-store.ts'
import type { FleetService } from '../core/fleet.ts'

// Бот: меню ролей и анкеты (HAKATON-43). Действия с перевозками пока заглушки.
// Спецификация — docs/roli-i-menyu.md.

type Step = 'inn' | 'confirm' | 'taken' | 'manual_name' | 'manual_address' | 'sign_mode' | 'poa_number' | 'poa_date' | 'erp'

interface FormCtx {
  role: Role
  history: Step[]
  inn?: string
  req?: { inn: string; kpp: string | null; name: string; address: string; source: 'demo' | 'dadata' | 'manual'; ogrn: string | null; status?: OrgRequisites['status'] }
  verified?: boolean
  takenBy?: string
  canSign?: boolean
  poaNumber?: string | null
  poaValidTo?: string | null
  /** анкета начата по приглашению: после неё принимаем приглашение */
  invite?: string
  /** что показать над первым шагом: превью перевозки из приглашения */
  intro?: string
}


const FORM = 'form'
const STATUS_TEXT: Record<NonNullable<OrgRequisites['status']>, string> = {
  active: 'действует',
  liquidating: 'в процессе ликвидации',
  liquidated: 'ликвидирована',
  bankrupt: 'в процедуре банкротства',
  reorganizing: 'в процессе реорганизации',
}
const TEXT_STEPS: Step[] = ['inn', 'manual_name', 'manual_address', 'poa_number', 'poa_date']
const nav = [cb('Назад', P.back), cb('В меню', P.toMenu)]

const fullName = (u: MaxUser) => [u.first_name, u.last_name].filter(Boolean).join(' ')

/** ДД.ММ.ГГГГ строго: 11.20.2027 или 31.02.2027 — не дата, а не «перенос» на другой месяц. */
export function parseRuDate(s: string): Date | null {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s.trim())
  if (!m) return null
  const [day, month, year] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (month < 1 || month > 12 || day < 1 || year < 2000 || year > 2100) return null
  const d = new Date(Date.UTC(year, month - 1, day, 20, 59, 59)) // конец дня по Москве
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? d : null
}

export class Bot {
  private readonly flows: ShipmentFlows
  private readonly trips: TripFlows
  private readonly sign: SignFlows

  constructor(
    private readonly store: BotStore,
    private readonly messenger: Messenger,
    private readonly directory: OrgDirectory,
    shipments: ShipmentService,
    invites: InviteService,
    fleet: FleetService,
    outbox: Outbox,
    cards: CardStore,
    signing: { titles: TitleService; signatures: SignatureService; verifier: SignatureVerifier | null; demo: SignatureProvider | null },
    botToken: string,
    botUsername: string,
    private readonly log: FastifyBaseLogger,
  ) {
    this.flows = new ShipmentFlows(
      store,
      shipments,
      invites,
      outbox,
      cards,
      {
        reply: (to, m, n) => this.reply(to, m, n),
        notify: (to, t) => this.notify(to, t),
        startForm: (p, role, to, opts) => this.startForm(p, role, to, opts),
      },
      botUsername,
      log,
    )
    const ui = {
      reply: (to: Reply, m: OutMessage, n?: string | null) => this.reply(to, m, n),
      notify: (to: Reply, text: string) => this.notify(to, text),
      startForm: (p: PersonRow, role: Role, to: Reply, opts: { invite: string; intro: string }) => this.startForm(p, role, to, opts),
    }
    this.trips = new TripFlows(store, shipments, fleet, this.flows, outbox, ui, botToken, botUsername, log)
    this.sign = new SignFlows(store, shipments, signing.titles, signing.signatures, signing.verifier, signing.demo, messenger, this.flows, ui, (p, pending, to) => this.trips.askPhone(p, pending, to), log)
    // После «Поделиться номером» подпись продолжается сама
    this.trips.onPhone('sign', (p, pending, to) => this.sign.start(p, pending.title as 'T1' | 'T2', String(pending.shipmentId), to))
  }

  /** Последствие inviteConsignee из очереди: позвать получателя, когда машина выехала. */
  consigneeArrival(shipmentId: string) {
    return this.flows.consigneeArrival(shipmentId)
  }

  /** QR-код от оператора водителю после регистрации накладной (последствие sendQrToDriver). */
  sendQrToDriver(shipmentId: string, file: { name: string; bytes: Uint8Array }) {
    return this.flows.sendQrToDriver(shipmentId, file)
  }

  /** Переход по ответу системы (оператор): уведомить того, чей ход, и перерисовать карточки; reason — причина отказа. */
  afterSystemTransition(res: Extract<ExecResult, { ok: true }>, reason?: string) {
    return this.flows.afterTransition(res, { personId: '', role: 'shipper' }, reason)
  }

  async handle(u: MaxUpdate): Promise<void> {
    await this.route(u)
  }

  private async route(u: MaxUpdate): Promise<unknown> {
    if (u.update_type === 'bot_started' && 'user' in u) {
      const p = await this.store.upsertPerson(u.user.user_id, fullName(u.user))
      await this.store.clearDialog(p.id)
      const to: Reply = { kind: 'message', userId: u.user.user_id }
      if (u.payload?.startsWith('inv_')) return this.flows.onInvite(p, u.payload.slice(4), to)
      return this.showStart(p, to)
    }
    if (u.update_type === 'message_created' && 'message' in u) {
      const m = u.message
      if (!m.sender || m.sender.is_bot || m.recipient.chat_type !== 'dialog') return
      const p = await this.store.upsertPerson(m.sender.user_id, fullName(m.sender))
      const reply: Reply = { kind: 'message', userId: m.sender.user_id }
      const files = fileAttachments(m)
      if (files.length) {
        const d = await this.store.getDialog(p.id)
        if (d && (await this.sign.onFiles(p, d, files, reply))) return
        return this.reply(reply, { text: 'Файл получил, но сейчас его некуда приложить. Если это подпись — сначала нажмите «Подписать накладную» в карточке.', buttons: [[cb('Меню ролей', P.root)]] })
      }
      const contact = m.body.attachments?.find((a) => a.type === 'contact')
      if (contact) {
        const d = await this.store.getDialog(p.id)
        if (d && ((await this.flows.onContact(p, d, contact, reply)) || (await this.trips.onContact(p, d, contact, reply)))) return
        return this.onContact(contact, reply)
      }
      return this.onText(p, (m.body.text ?? '').trim(), reply)
    }
    if (u.update_type === 'message_callback' && 'callback' in u) {
      const c = u.callback
      const p = await this.store.upsertPerson(c.user.user_id, fullName(c.user))
      return this.onButton(p, c.payload ?? '', { kind: 'callback', callbackId: c.callback_id, mid: u.message?.body.mid ?? null, userId: c.user.user_id })
    }
  }

  // ---------- ответы ----------

  /** Ответить тому, кто нажал или написал. Возвращает mid сообщения, где теперь стоит ответ. */
  private async reply(to: Reply, msg: OutMessage, notification: string | null = null): Promise<string | null> {
    if (to.kind === 'callback') {
      await this.messenger.answerCallback(to.callbackId, notification, msg)
      return to.mid
    }
    return (await this.messenger.send(to.userId, msg)).mid
  }

  private async notify(to: Reply, text: string) {
    if (to.kind === 'callback') return this.messenger.answerCallback(to.callbackId, text)
    await this.messenger.send(to.userId, { text })
  }

  // ---------- меню ----------

  private async showStart(p: PersonRow, to: Reply) {
    const roles = await this.store.roles(p.id)
    const active = roles.find((r) => r.role === p.activeRole)
    if (active) return this.showRole(p, active.role, to)
    return this.reply(to, rootMenu(roles, null))
  }

  private async showRoot(p: PersonRow, to: Reply, note?: string) {
    await this.store.clearDialog(p.id)
    return this.reply(to, rootMenu(await this.store.roles(p.id), p.activeRole, note))
  }

  private async showRole(p: PersonRow, role: Role, to: Reply, note?: string) {
    const r = (await this.store.roles(p.id)).find((x) => x.role === role)
    if (!r) return this.showRoot(p, to)
    if (p.activeRole !== role) await this.store.setActiveRole(p.id, role)
    const erpShipments = r.role === 'shipper' && r.org ? await this.store.erpShipmentCount(r.org.inn) : undefined
    const counts = await this.flows.counts(p.id, role)
    let trip: { erpRef: string; stateText: string; yourTurn: boolean } | null = null
    if (role === 'driver') {
      const t = await this.flows.activeTrip(p.id)
      if (t) trip = { erpRef: t.erpRef, stateText: STATE_TEXT[t.state], yourTurn: counts.waiting > 0 }
    }
    return this.reply(to, roleMenu(r, { erpShipments, note, trip, ...counts }))
  }

  // ---------- входящие ----------

  private async onText(p: PersonRow, text: string, to: Reply) {
    if (text === '/start' || text.startsWith('/start ')) {
      await this.store.clearDialog(p.id)
      const arg = text.slice('/start'.length).trim()
      if (arg.startsWith('inv_')) return this.flows.onInvite(p, arg.slice(4), to)
      return this.showStart(p, to)
    }
    if (text === '/menu') return this.showRoot(p, to)
    if (text === '/help') return this.reply(to, helpScreen)

    const d = await this.store.getDialog(p.id)
    if (d?.step.startsWith(`${FORM}:`)) return this.formText(p, d, text, to)
    if (d && ((await this.flows.onText(p, d, text, to)) || (await this.trips.onText(p, d, text, to)))) return
    return this.reply(to, { text: 'Я понимаю кнопки и команды. Откройте меню:', buttons: [[cb('Меню ролей', P.root)]] })
  }

  private async onButton(p: PersonRow, payload: string, to: Reply) {
    // Нажатие вне текущего ввода отменяет ожидание: контакт, присланный потом, не назначит случайно
    const inDialog = ['f:', 'dq:', 'cr:', 'avh:', 'nvh', 'own:', 'adr:', 'vb:'].some((x) => payload.startsWith(x))
    if (!inDialog) await this.store.clearDialog(p.id)
    if (await this.flows.onButton(p, payload, to)) return
    if (await this.trips.onButton(p, payload, to)) return
    if (await this.sign.onButton(p, payload, to)) return
    if (payload === P.root) return this.showRoot(p, to)
    if (payload === P.help) return this.reply(to, helpScreen)
    if (payload === P.company) {
      const r = (await this.store.roles(p.id)).find((x) => x.role === p.activeRole)
      return r ? this.reply(to, companyScreen(r)) : this.showRoot(p, to)
    }
    if (payload.startsWith('stub:')) return this.notify(to, 'Этот раздел появится в следующей версии')

    const [kind, arg] = payload.split(':') as [string, string | undefined]
    const role = ROLES.find((r) => r === arg)
    if (kind === 'open' && role) {
      await this.store.clearDialog(p.id)
      return this.showRole(p, role, to)
    }
    if (kind === 'add' && role) return this.startForm(p, role, to)
    if (kind === 'f') {
      const d = await this.store.getDialog(p.id)
      if (!d?.step.startsWith(`${FORM}:`)) return this.showRoot(p, to, 'Анкета устарела — начните заново.')
      return this.formButton(p, d, payload, to)
    }
    this.log.warn({ payload }, 'неизвестная кнопка')
    return this.showRoot(p, to)
  }

  /** Пересланный контакт. Назначение по контакту — HAKATON-44; пока показываем, что пришло. */
  private async onContact(a: MaxAttachment, to: Reply) {
    const info = a.payload?.max_info
    const vcfName = /(?:^|\n)FN:(.*)/.exec(a.payload?.vcf_info ?? '')?.[1]?.trim()
    this.log.info({ contactUserId: info?.user_id ?? null, hasVcf: Boolean(a.payload?.vcf_info), hasHash: Boolean(a.payload?.hash) }, 'получен контакт')
    const name = info ? fullName(info) : vcfName ?? 'без имени'
    return this.reply(to, {
      text: [
        `Контакт: <b>${esc(name)}</b>`,
        info ? 'Есть аккаунт MAX — бот сможет его найти.' : 'Аккаунта MAX у контакта нет — бот не сможет ему написать.',
        '',
        '<i>Назначение людей по контакту появится в следующей версии.</i>',
      ].join('\n'),
      buttons: [[cb('В меню', P.root)]],
    })
  }

  // ---------- анкета роли ----------

  private async startForm(p: PersonRow, role: Role, to: Reply, opts?: { invite: string; intro: string }) {
    if (opts) return this.goto(p, { role, history: [], invite: opts.invite, intro: opts.intro }, 'inn', to, null)
    const roles = await this.store.roles(p.id)
    if (roles.some((r) => r.role === role)) return this.showRole(p, role, to)
    if (role === 'driver') {
      // Решение 24.09: водитель заводит роль одним нажатием, организацию задаёт перевозчик
      await this.store.addRole({ personId: p.id, role, org: null, canSign: false, poaNumber: null, poaValidTo: null })
      return this.showRole({ ...p, activeRole: role }, role, to, 'Роль водителя добавлена.')
    }
    return this.goto(p, { role, history: [] }, 'inn', to, null)
  }

  private async goto(p: PersonRow, ctx: FormCtx, step: Step, to: Reply, from: Step | null, error?: string) {
    const next: FormCtx = { ...ctx, history: from ? [...ctx.history, from] : ctx.history }
    await this.store.setDialog(p.id, { step: `${FORM}:${step}`, context: next as unknown as Record<string, unknown> })
    return this.reply(to, this.prompt(step, next, error))
  }

  private prompt(step: Step, ctx: FormCtx, error?: string): OutMessage {
    const title = `<b>${ROLE_TITLE[ctx.role]}: подключение</b>`
    const err = error ? `\n\n⚠️ ${error}` : ''
    const t = (...lines: string[]) => [title, '', ...lines].join('\n') + err
    switch (step) {
      case 'inn':
        return {
          text: (ctx.intro && ctx.history.length === 0 ? `${ctx.intro}\n\n` : '') + t('Пришлите ИНН вашей компании — 10 цифр, у ИП 12.'),
          buttons: [nav],
        }
      case 'confirm': {
        const r = ctx.req!
        const from = r.source === 'dadata' ? 'Нашли в ЕГРЮЛ (через DaData):' : r.source === 'demo' ? 'Нашли в демо-данных (модель):' : 'Нашли у нас:'
        const warn = r.status && r.status !== 'active' ? ['', `⚠️ По данным ЕГРЮЛ компания ${STATUS_TEXT[r.status]}.`] : []
        return {
          text: t(from, '', `<b>${esc(r.name)}</b>`, `ИНН ${r.inn}${r.kpp ? `, КПП ${r.kpp}` : ''}${r.ogrn ? `, ОГРН ${r.ogrn}` : ''}`, esc(r.address || 'адрес не указан'), ...warn, '', 'Это вы?'),
          buttons: [[cb('Да, это мы', P.yes), cb('Нет', P.no)], nav],
        }
      }
      case 'taken':
        return {
          text: t(
            `Компания с ИНН ${ctx.inn} уже подключена в роли «${ROLE_TITLE[ctx.role].toLowerCase()}».`,
            `Попросите приглашение у ${esc(ctx.takenBy ?? 'её администратора')}.`,
          ),
          buttons: [[cb('Ввести другой ИНН', P.otherInn)], [cb('В меню', P.toMenu)]],
        }
      case 'manual_name':
        return { text: t(`ИНН ${ctx.inn} нет в справочнике. Введите реквизиты вручную — отметим их как непроверенные.`, '', 'Название компании:'), buttons: [nav] }
      case 'manual_address':
        return { text: t('Юридический адрес с индексом:'), buttons: [nav] }
      case 'sign_mode':
        return {
          text: t('Вы только принимаете груз или ещё подписываете документы за компанию?'),
          buttons: [[cb('Только принимаю', P.acceptOnly)], [cb('Принимаю и подписываю', P.acceptSign)], nav],
        }
      case 'poa_number':
        return {
          text: t('Номер машиночитаемой доверенности, по которой вы подписываете документы за компанию.', 'Можно указать позже — спросим перед первой подписью.'),
          buttons: [[cb('Укажу позже', P.later)], nav],
        }
      case 'poa_date':
        return { text: t(`Доверенность ${esc(ctx.poaNumber ?? '')}. До какого числа действует? Например, 31.10.2026`), buttons: [nav] }
      case 'erp':
        return {
          text: t('Подключить учётную систему? Тогда отгрузки будут приходить сюда сами.', '', '<i>В этой версии учётная система — модель на демо-данных завода.</i>'),
          buttons: [[cb('Подключить', P.erp)], [cb('Позже', P.later)], nav],
        }
    }
  }

  private afterOrg(ctx: FormCtx): { step: Step; ctx: FormCtx } {
    if (ctx.role === 'consignee') return { step: 'sign_mode', ctx }
    return { step: 'poa_number', ctx: { ...ctx, canSign: true } }
  }

  private async afterPoa(p: PersonRow, ctx: FormCtx, from: Step, to: Reply) {
    if (ctx.role === 'shipper') return this.goto(p, ctx, 'erp', to, from)
    return this.finish(p, ctx, false, to)
  }

  private async finish(p: PersonRow, ctx: FormCtx, erpLinked: boolean, to: Reply) {
    const req = ctx.req!
    await this.store.addRole({
      personId: p.id,
      role: ctx.role,
      org: { inn: req.inn, kpp: req.kpp, name: req.name, address: req.address, verified: ctx.verified ?? true, erpLinked, source: req.source, ogrn: req.ogrn },
      canSign: ctx.canSign ?? false,
      poaNumber: ctx.poaNumber ?? null,
      poaValidTo: ctx.poaValidTo ? new Date(ctx.poaValidTo) : null,
    })
    await this.store.clearDialog(p.id)
    if (ctx.invite) return this.flows.acceptAfterForm({ ...p, activeRole: ctx.role }, ctx.invite, to)
    return this.showRole({ ...p, activeRole: ctx.role }, ctx.role, to, `Готово: роль «${ROLE_TITLE[ctx.role].toLowerCase()}» добавлена.`)
  }

  private async formText(p: PersonRow, d: DialogState, text: string, to: Reply) {
    const step = d.step.slice(FORM.length + 1) as Step
    const ctx = d.context as unknown as FormCtx
    if (!TEXT_STEPS.includes(step)) return this.reply(to, this.prompt(step, ctx, 'Выберите вариант кнопкой.'))

    switch (step) {
      case 'inn': {
        const inn = normalizeInn(text)
        if (!inn) return this.goto(p, ctx, 'inn', to, null, 'Нужно 10 или 12 цифр.')
        if (!isValidInn(inn)) return this.goto(p, ctx, 'inn', to, null, 'Такого ИНН не бывает: не сходится контрольная цифра.')
        const existing = await this.store.orgByInn(inn)
        const holder = existing ? await this.store.roleHolder(existing.id, ctx.role) : null
        if (holder) return this.goto(p, { ...ctx, inn, takenBy: holder }, 'taken', to, 'inn')
        if (existing) {
          const req = { inn, kpp: existing.kpp, name: existing.name, address: existing.address, source: existing.requisitesSource ?? 'demo', ogrn: existing.ogrn }
          return this.goto(p, { ...ctx, inn, req, verified: existing.verified }, 'confirm', to, 'inn')
        }
        const found = await this.directory.findByInn(inn)
        if (found?.status === 'liquidated') return this.goto(p, ctx, 'inn', to, null, `Компания с ИНН ${inn} ликвидирована по данным ЕГРЮЛ — подключить её нельзя.`)
        if (found) {
          const req = { inn, kpp: found.kpp, name: found.name, address: found.address, source: found.source ?? 'demo', ogrn: found.ogrn ?? null, status: found.status }
          return this.goto(p, { ...ctx, inn, req, verified: true }, 'confirm', to, 'inn')
        }
        return this.goto(p, { ...ctx, inn }, 'manual_name', to, 'inn')
      }
      case 'manual_name':
        if (text.length < 3) return this.goto(p, ctx, step, to, null, 'Слишком коротко.')
        return this.goto(p, { ...ctx, req: { inn: ctx.inn!, kpp: null, name: text, address: '', source: 'manual', ogrn: null } }, 'manual_address', to, step)
      case 'manual_address': {
        if (text.length < 10) return this.goto(p, ctx, step, to, null, 'Нужен полный адрес с индексом.')
        const next = this.afterOrg({ ...ctx, req: { ...ctx.req!, address: text }, verified: false })
        return this.goto(p, next.ctx, next.step, to, step)
      }
      case 'poa_number':
        if (text.length < 3) return this.goto(p, ctx, step, to, null, 'Слишком коротко.')
        return this.goto(p, { ...ctx, poaNumber: text }, 'poa_date', to, step)
      case 'poa_date': {
        const date = parseRuDate(text)
        if (!date) return this.goto(p, ctx, step, to, null, 'Такой даты нет — проверьте день и месяц. Формат ДД.ММ.ГГГГ, например 31.10.2026.')
        if (date.getTime() < Date.now()) return this.goto(p, ctx, step, to, null, 'Доверенность уже истекла — укажите действующую.')
        return this.afterPoa(p, { ...ctx, poaValidTo: date.toISOString() }, step, to)
      }
    }
  }

  private async formButton(p: PersonRow, d: DialogState, payload: string, to: Reply) {
    const step = d.step.slice(FORM.length + 1) as Step
    const ctx = d.context as unknown as FormCtx
    switch (payload) {
      case P.toMenu:
        return this.showRoot(p, to)
      case P.back: {
        const prev = ctx.history.at(-1)
        if (!prev) return this.showRoot(p, to)
        return this.goto(p, { ...ctx, history: ctx.history.slice(0, -1) }, prev, to, null)
      }
      case P.yes:
        if (step === 'confirm') {
          const next = this.afterOrg(ctx)
          return this.goto(p, next.ctx, next.step, to, step)
        }
        break
      case P.no:
      case P.otherInn:
        if (step === 'confirm' || step === 'taken') return this.goto(p, { role: ctx.role, history: [], invite: ctx.invite }, 'inn', to, null)
        break
      case P.later:
        if (step === 'poa_number') return this.afterPoa(p, { ...ctx, poaNumber: null, poaValidTo: null }, step, to)
        if (step === 'erp') return this.finish(p, ctx, false, to)
        break
      case P.erp:
        if (step === 'erp') return this.finish(p, ctx, true, to)
        break
      case P.acceptOnly:
        if (step === 'sign_mode') return this.finish(p, { ...ctx, canSign: false }, false, to)
        break
      case P.acceptSign:
        if (step === 'sign_mode') return this.goto(p, { ...ctx, canSign: true }, 'poa_number', to, step)
        break
    }
    // Нажата кнопка со старого шага — показываем текущий
    return this.reply(to, this.prompt(step, ctx))
  }
}
