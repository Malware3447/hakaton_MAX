import { TRANSITIONS, type Command, type CommandType, type Messenger, type OutMessage, type Role } from '@nk/domain'
import type { FastifyBaseLogger } from 'fastify'
import type { ExecResult, ShipmentService } from '../core/shipments.ts'
import type { InviteService } from '../core/invite-service.ts'
import { inviteLink, sha256 } from '../core/invites.ts'
import { esc } from '../max/messenger.ts'
import { phoneFromVcf } from '../max/contact.ts'
import type { MaxAttachment } from '../max/types.ts'
import type { Outbox } from './outbox.ts'
import { S, cb } from './screens.ts'
import { invitePreview, shipmentCard, shipmentList, shipperList, waitingList } from './cards.ts'
import { ROLE_TITLE } from './screens.ts'
import QRCode from 'qrcode'
import { MOVED_CARD, renderHash, type CardStore } from './card-store.ts'
import type { BotStore, DialogState, PersonRow } from './store.ts'

// Действия с перевозками в чате: HAKATON-24 (ядро), HAKATON-29 (шаги), HAKATON-44 (назначение по контакту).

/** Куда отвечать. У нажатия — его callback_id и mid сообщения с кнопкой: это доказательства простой подписи. */
export type Reply = { kind: 'callback'; callbackId: string; mid: string | null; userId: number } | { kind: 'message'; userId: number }

export interface Ui {
  reply(to: Reply, msg: OutMessage, notification?: string | null): Promise<string | null>
  notify(to: Reply, text: string): Promise<void>
  /** начать анкету роли; после неё бот вызовет acceptAfterForm с invite */
  startForm(p: PersonRow, role: Role, to: Reply, opts: { invite: string; intro: string }): Promise<unknown>
}

/** Команды без данных — выполняются прямо с кнопки. */
const ONE_TAP: CommandType[] = ['carrier.accept', 'driver.acceptTrip', 'driver.arrivedLoading', 'driver.arrivedUnloading']

const DECLINE_REASONS: Record<'carrier.decline' | 'driver.declineTrip', string[]> = {
  'carrier.decline': ['Нет свободных машин', 'Не наш маршрут', 'Не устраивают сроки'],
  'driver.declineTrip': ['Машина неисправна', 'Не успеваю к погрузке', 'Заболел'],
}

const CANCEL_REASONS = ['Заказ отменён покупателем', 'Перенос отгрузки', 'Ошибка в отгрузке']

const FAIL_TEXT: Record<string, string> = {
  already_done: 'Уже сделано',
  wrong_state: 'Сейчас это действие недоступно',
  wrong_role: 'Это действие другой стороны',
  not_participant: 'Вы не участник этой перевозки в этой роли',
  not_found: 'Перевозка не найдена',
}

const byOf = (cmd: CommandType) => TRANSITIONS.find((t) => t.command === cmd)!.by as Role

export class ShipmentFlows {
  constructor(
    private readonly store: BotStore,
    private readonly shipments: ShipmentService,
    private readonly invites: InviteService,
    private readonly messenger: Outbox,
    private readonly cards: CardStore,
    private readonly ui: Ui,
    private readonly botUsername: string,
    private readonly log: FastifyBaseLogger,
  ) {}

  /** Текущий рейс водителя — для шапки его меню. */
  async activeTrip(personId: string) {
    const list = await this.shipments.listFor(personId, 'driver')
    return list.find((s) => s.state !== 'closed' && s.state !== 'cancelled') ?? null
  }

  /** Счётчики для шапки меню роли. */
  async counts(personId: string, role: Role) {
    const waiting = (await this.shipments.waiting(personId, role)).length
    const offers = role === 'carrier' ? (await this.shipments.listFor(personId, 'carrier', ['offered'])).length : undefined
    return { waiting, offers }
  }

  // ---------- кнопки ----------

  /** true — нажатие наше и обработано. */
  async onButton(p: PersonRow, payload: string, to: Reply): Promise<boolean> {
    const [kind, ...rest] = payload.split(':')
    const arg = rest.join(':')
    switch (kind) {
      case 'sl':
        await this.showShipperList(p, Number(arg) || 0, to)
        return true
      case 'se':
        await this.openErp(p, arg, to)
        return true
      case 'v':
        await this.showCard(p, arg, to)
        return true
      case 'x': {
        const [cmd, id] = [rest[0] as CommandType, rest[1]!]
        if (!ONE_TAP.includes(cmd)) return false
        await this.run(p, { type: cmd, shipmentId: id, payload: {} } as Command, to)
        return true
      }
      case 'ac':
        await this.store.setDialog(p.id, { step: 'await:carrier_contact', context: { shipmentId: arg } })
        await this.ui.reply(to, {
          text: [
            '<b>Назначить перевозчика</b>',
            '',
            'Перешлите сюда контакт диспетчера перевозчика: скрепка → «Контакт».',
            'Бот найдёт его по аккаунту MAX и отправит заявку.',
          ].join('\n'),
          buttons: [[cb('Отмена', S.view(arg))]],
        })
        return true
      case 'dc':
      case 'dt': {
        const cmd = kind === 'dc' ? 'carrier.decline' : 'driver.declineTrip'
        await this.store.setDialog(p.id, { step: 'await:decline_reason', context: { shipmentId: arg, cmd } })
        await this.ui.reply(to, {
          text:
            cmd === 'carrier.decline'
              ? '<b>Отклонить заявку</b>\n\nВыберите причину или напишите свою — отправитель её увидит.'
              : '<b>Отказаться от рейса</b>\n\nВыберите причину или напишите свою — перевозчик её увидит и назначит другого водителя.',
          buttons: [...DECLINE_REASONS[cmd].map((r, i) => [cb(r, `dq:${i}`)]), [cb('Отмена', S.view(arg))]],
        })
        return true
      }
      case 'dq': {
        const d = await this.store.getDialog(p.id)
        const cmd = d?.context.cmd as keyof typeof DECLINE_REASONS | undefined
        const reason = cmd ? DECLINE_REASONS[cmd][Number(arg)] : undefined
        if (d?.step !== 'await:decline_reason' || !reason) return false
        await this.decline(p, d, reason, to)
        return true
      }
      case 'rq':
        await this.requestNewLink(p, arg, to)
        return true
      case 'ri': {
        const [id, role] = [rest[0]!, rest[1] as Role]
        const token = await this.invites.reissue(id, role, p.id)
        if (!token) {
          await this.ui.notify(to, 'По этому приглашению уже вошли, или оно не ваше')
          return true
        }
        await this.ui.reply(to, {
          text: `Новая ссылка для роли «${ROLE_TITLE[role].toLowerCase()}». Перешлите её человеку, она действует 7 дней:\n${inviteLink(this.botUsername, token)}`,
          buttons: [[cb('Открыть перевозку', S.view(id))]],
        })
        return true
      }
      case 'cx': {
        const view = await this.shipments.view(arg, 'shipper')
        if (!view) return this.ui.notify(to, 'Перевозка не найдена').then(() => true)
        await this.ui.reply(to, {
          text: [
            `<b>Отменить перевозку ${esc(view.erpRef)}?</b>`,
            '',
            'Вернуть её будет нельзя.',
            view.carrier ? 'Перевозчик и водитель получат уведомление, машина и водитель освободятся.' : '',
          ].join('\n').trim(),
          buttons: [[cb('Да, отменить', `cy:${arg}`)], [cb('Нет', S.view(arg))]],
        })
        return true
      }
      case 'cy':
        await this.store.setDialog(p.id, { step: 'await:cancel_reason', context: { shipmentId: arg } })
        await this.ui.reply(to, {
          text: '<b>Причина отмены</b>\n\nВыберите или напишите свою — участники её увидят.',
          buttons: [...CANCEL_REASONS.map((r, i) => [cb(r, `cr:${i}`)]), [cb('Не отменять', S.view(arg))]],
        })
        return true
      case 'cr': {
        const d = await this.store.getDialog(p.id)
        const reason = CANCEL_REASONS[Number(arg)]
        if (d?.step !== 'await:cancel_reason' || !reason) return false
        await this.cancel(p, String(d.context.shipmentId), reason, to)
        return true
      }
      case 'wl': {
        const role = arg as Role
        await this.ui.reply(to, waitingList(await this.shipments.waiting(p.id, role), role))
        return true
      }
      case 'ci': {
        const list = (await this.shipments.listFor(p.id, 'consignee')).filter((s) => s.state !== 'closed' && s.state !== 'cancelled')
        await this.ui.reply(to, shipmentList('Ко мне едут', list, 'consignee', 'Сейчас к вам ничего не едет.'))
        return true
      }
      case 'ol':
        await this.ui.reply(to, shipmentList('Новые заявки', await this.shipments.listFor(p.id, 'carrier', ['offered']), 'carrier', 'Новых заявок нет.'))
        return true
      case 'tl': {
        const role = arg as Role
        const title = role === 'carrier' ? 'Мои рейсы' : 'Мои перевозки'
        await this.ui.reply(to, shipmentList(title, await this.shipments.listFor(p.id, role), role, 'Пока пусто.'))
        return true
      }
    }
    return false
  }

  // ---------- ввод в диалоге ----------

  async onText(p: PersonRow, d: DialogState, text: string, to: Reply): Promise<boolean> {
    if (d.step === 'await:decline_reason') {
      if (text.length < 3) {
        await this.ui.reply(to, { text: 'Причина слишком короткая. Напишите подробнее или выберите кнопкой выше.' })
        return true
      }
      await this.decline(p, d, text, to)
      return true
    }
    if (d.step === 'await:cancel_reason') {
      if (text.length < 3) {
        await this.ui.reply(to, { text: 'Причина слишком короткая. Напишите подробнее или выберите кнопкой выше.' })
        return true
      }
      await this.cancel(p, String(d.context.shipmentId), text, to)
      return true
    }
    if (d.step === 'await:carrier_contact') {
      await this.ui.reply(to, { text: 'Нужен именно контакт: скрепка → «Контакт». Или нажмите «Отмена» выше.' })
      return true
    }
    return false
  }

  async onContact(p: PersonRow, d: DialogState, a: MaxAttachment, to: Reply): Promise<boolean> {
    if (d.step !== 'await:carrier_contact') return false
    const shipmentId = String(d.context.shipmentId)
    const info = a.payload?.max_info
    if (!info) {
      await this.ui.reply(to, { text: 'У этого контакта нет аккаунта MAX — бот не сможет ему написать. Попросите установить MAX или пришлите другой контакт.' })
      return true
    }
    const name = [info.first_name, info.last_name].filter(Boolean).join(' ')
    const found = await this.store.personByMaxUserId(info.user_id)
    let carrierRef: Extract<Command, { type: 'shipper.offerCarrier' }>['payload']
    if (found) {
      const carrierRole = (await this.store.roles(found.id)).find((r) => r.role === 'carrier' && r.org)
      if (!carrierRole) {
        await this.ui.reply(to, {
          text: `У ${esc(name)} в боте нет роли перевозчика. Попросите его открыть бота и добавить роль «Перевозчик», потом пришлите контакт снова.`,
        })
        return true
      }
      carrierRef = { carrier: { personId: found.id }, carrierOrgId: carrierRole.org!.id }
    } else {
      const phone = phoneFromVcf(a.payload?.vcf_info)
      carrierRef = {
        carrier: { invite: { expectedMaxUserId: info.user_id, expectedPhoneSha256: phone ? sha256(phone) : null, displayName: name } },
        carrierOrgId: null,
      }
    }
    const res = await this.shipments.execute({ type: 'shipper.offerCarrier', shipmentId, payload: carrierRef }, { kind: 'person', personId: p.id, role: 'shipper' })
    if (!res.ok) return this.failed(res, to).then(() => true)
    await this.store.clearDialog(p.id)
    const invite = res.invites.find((i) => i.role === 'carrier')
    const note = invite
      ? [
          `${esc(name)} ещё не пользуется ботом. Перешлите ему приглашение:`,
          inviteLink(this.botUsername, invite.token),
        ].join('\n')
      : `Заявка отправлена: ${esc(name)}.`
    await this.showCard(p, shipmentId, to, note)
    await this.afterTransition(res, { personId: p.id, role: 'shipper' })
    return true
  }

  // ---------- вход по приглашению (HAKATON-27) ----------

  /** Человек открыл ссылку https://max.ru/<бот>?start=inv_<токен>. */
  async onInvite(p: PersonRow, token: string, to: Reply) {
    const found = await this.invites.lookup(token)
    const menu = [[cb('В меню', 'root')]]
    if (found.kind === 'not_found') {
      return this.ui.reply(to, { text: 'Приглашение не найдено. Попросите того, кто вас звал, прислать ссылку ещё раз.', buttons: menu })
    }
    if (found.kind === 'taken') {
      if (found.invite.personId === p.id) return this.showCard(p, found.invite.shipmentId, to)
      return this.ui.reply(to, { text: 'По этому приглашению уже вошёл другой человек. Если это ошибка, попросите новое приглашение.', buttons: menu })
    }
    if (found.kind === 'expired') {
      return this.ui.reply(to, {
        text: 'Срок приглашения истёк: ссылка действует 7 дней.',
        buttons: [[cb('Попросить новую ссылку', `rq:${found.invite.id}`)], ...menu],
      })
    }

    const { invite, shipment } = found
    const role = invite.role
    const roles = await this.store.roles(p.id)
    const mine = roles.find((r) => r.role === role)
    const conflict = () =>
      this.ui.reply(to, {
        text: `Вы уже работаете в роли «${ROLE_TITLE[role].toLowerCase()}» от другой компании: ${esc(mine?.org?.name ?? '')}. Одна роль — одна компания, поэтому принять это приглашение нельзя.`,
        buttons: menu,
      })

    switch (role) {
      case 'carrier': {
        if (mine?.org) return this.acceptInvite(p, invite.id, mine.org.id, to)
        const view = await this.shipments.view(shipment.id, role)
        return this.ui.startForm(p, 'carrier', to, {
          invite: invite.id,
          intro: `${view ? invitePreview(view, role) : ''}\n\nЧтобы ответить, подключите вашу компанию — это один раз.`,
        })
      }
      case 'consignee':
        if (mine && mine.org?.id !== shipment.consigneeOrgId) return conflict()
        if (!mine) await this.store.addRoleForOrg(p.id, 'consignee', shipment.consigneeOrgId, false)
        return this.acceptInvite(p, invite.id, shipment.consigneeOrgId, to)
      case 'driver':
        if (mine?.org && shipment.carrierOrgId && mine.org.id !== shipment.carrierOrgId) return conflict()
        if (!mine && shipment.carrierOrgId) await this.store.addRoleForOrg(p.id, 'driver', shipment.carrierOrgId, false)
        else if (mine && !mine.org && shipment.carrierOrgId) await this.store.setRoleOrg(p.id, 'driver', shipment.carrierOrgId)
        return this.acceptInvite(p, invite.id, shipment.carrierOrgId, to)
      default:
        return this.ui.reply(to, { text: 'Такие приглашения пока не поддерживаются.', buttons: menu })
    }
  }

  /** Анкета перевозчика по приглашению пройдена — принимаем приглашение от его компании. */
  async acceptAfterForm(p: PersonRow, participantId: string, to: Reply) {
    const r = (await this.store.roles(p.id)).find((x) => x.role === 'carrier')
    if (!r?.org) return this.ui.notify(to, 'Не удалось подключить компанию')
    return this.acceptInvite(p, participantId, r.org.id, to)
  }

  private async acceptInvite(p: PersonRow, participantId: string, orgId: string | null, to: Reply) {
    const res = await this.invites.accept(participantId, p.id, orgId)
    if (!res.ok) {
      const text = {
        taken: 'По этому приглашению уже вошёл другой человек.',
        expired: 'Срок приглашения истёк — попросите новую ссылку.',
        not_found: 'Приглашение не найдено.',
        org_conflict: 'Приглашение от другой компании, чем та, в которой вы работаете в этой роли.',
      }[res.reason]
      return this.ui.reply(to, { text, buttons: [[cb('В меню', 'root')]] })
    }
    await this.store.setActiveRole(p.id, res.role)
    await this.showCard({ ...p, activeRole: res.role }, res.shipmentId, to, `Вы в перевозке как ${ROLE_TITLE[res.role].toLowerCase()}.`)
    await this.refreshCards(res.shipmentId, new Set([p.id]))

    if (res.inviter) {
      const view = await this.shipments.view(res.shipmentId, 'shipper')
      const lines = [`✅ ${esc(p.name)} принял приглашение в перевозку ${esc(view?.erpRef ?? '')} как ${ROLE_TITLE[res.role].toLowerCase()}.`]
      if (res.mismatch) lines.push('', `⚠️ Это не тот человек, чей контакт вы присылали. Если его не ждали — напишите нам, отвяжем.`)
      await this.messenger
        .send(res.inviter.maxUserId, { text: lines.join('\n'), buttons: [[cb('Открыть', S.view(res.shipmentId))]] })
        .catch((err) => this.log.warn({ err }, 'не удалось написать пригласившему'))
    }
  }

  private async requestNewLink(p: PersonRow, participantId: string, to: Reply) {
    const inv = await this.invites.inviterOf(participantId)
    if (!inv) return this.ui.notify(to, 'Не нашли, кто вас приглашал')
    await this.messenger
      .send(inv.maxUserId, {
        text: `${esc(p.name)} просит новую ссылку на перевозку ${esc(inv.erpRef)}: старая истекла.`,
        buttons: [[cb('Выдать новую ссылку', `ri:${inv.shipmentId}:${inv.role}`)]],
      })
      .catch((err) => this.log.warn({ err }, 'не удалось написать пригласившему'))
    return this.ui.reply(to, { text: 'Попросили новую ссылку у того, кто вас приглашал. Когда он её пришлёт — откройте.', buttons: [[cb('В меню', 'root')]] })
  }

  // ---------- QR-код водителю (модель ГИС ЭПД) ----------

  /** После регистрации накладной: QR-код для проверки на дороге — водителю файлом в чат. */
  async sendQrToDriver(shipmentId: string) {
    const view = await this.shipments.view(shipmentId, 'driver')
    const driver = await this.shipments.participantOf(shipmentId, 'driver')
    if (!view?.uid || !driver) return
    const png = await QRCode.toBuffer(JSON.stringify({ uid: view.uid, number: view.erpRef, model: true }), { type: 'png', width: 512, margin: 2 })
    await this.messenger
      .send(
        driver.maxUserId,
        {
          text: `QR-код накладной ${esc(view.erpRef)}. Покажите его на проверке на дороге — файл открывается без сети. <i>Модель ГИС ЭПД.</i>`,
          file: { name: `QR-${view.erpRef}.png`, bytes: new Uint8Array(png) },
        },
        { shipmentId },
      )
      .catch((err) => this.log.warn({ err }, 'не удалось отправить QR водителю'))
  }

  // ---------- получатель, когда машина выехала ----------

  /**
   * Позвать получателя (последствие inviteConsignee после регистрации накладной).
   * Уже участник — карточка «к вам едет груз»; в компании-получателе есть приёмщик в боте —
   * назначаем его; иначе приглашение: отправителю переслать получателю, водителю — показать на складе.
   */
  async consigneeArrival(shipmentId: string) {
    const view = await this.shipments.view(shipmentId, 'consignee')
    if (!view) return
    const card = async (userId: number, personId: string) => {
      const msg = shipmentCard(view, `🚚 <b>К вам едет груз</b> от ${esc(view.shipper.name)}. Когда машина приедет, водитель отметит выгрузку — и начнётся приёмка.`)
      const sent = await this.messenger.send(userId, msg, { shipmentId, card: { personId, hash: renderHash(msg) } }).catch((err) => this.log.warn({ err }, 'не удалось написать получателю'))
      if (sent && 'mid' in sent) await this.rememberCard(shipmentId, personId, sent.mid, renderHash(msg))
    }

    const joined = await this.shipments.participantOf(shipmentId, 'consignee')
    if (joined) return card(joined.maxUserId, joined.personId)

    const [known] = await this.store.orgMembers(view.consignee.id, 'consignee')
    if (known) {
      await this.shipments.assignParticipant(shipmentId, 'consignee', known.personId)
      return card(known.maxUserId, known.personId)
    }

    const shipper = await this.shipments.participantOf(shipmentId, 'shipper')
    const token = await this.shipments.inviteRole(shipmentId, 'consignee', shipper?.personId ?? null)
    const link = inviteLink(this.botUsername, token)
    if (shipper) {
      await this.messenger
        .send(shipper.maxUserId, {
          text: `🚚 Машина по перевозке ${esc(view.erpRef)} выехала. Перешлите приглашение приёмщику ${esc(view.consignee.name)} — по нему он примет груз и подпишет накладную без кабинета и своего ЭДО:\n${link}`,
        }, { shipmentId })
        .catch((err) => this.log.warn({ err }, 'не удалось написать отправителю'))
    }
    const driver = await this.shipments.participantOf(shipmentId, 'driver')
    if (driver) {
      await this.messenger
        .send(driver.maxUserId, {
          text: `Ссылка для приёмщика ${esc(view.consignee.name)}: если на складе его ещё нет в боте, покажите или перешлите ему.`,
          buttons: [[{ text: 'Приглашение приёмщику', kind: 'link', payload: link }]],
        }, { shipmentId })
        .catch((err) => this.log.warn({ err }, 'не удалось написать водителю'))
    }
  }

  // ---------- экраны ----------

  private async showShipperList(p: PersonRow, page: number, to: Reply) {
    const r = (await this.store.roles(p.id)).find((x) => x.role === 'shipper')
    if (!r?.org) return this.ui.notify(to, 'Сначала подключите компанию-отправителя')
    await this.ui.reply(to, shipperList(await this.shipments.shipperList(r.org.id, r.org.inn), page))
  }

  private async openErp(p: PersonRow, erpRef: string, to: Reply) {
    const r = (await this.store.roles(p.id)).find((x) => x.role === 'shipper')
    if (!r?.org) return this.ui.notify(to, 'Сначала подключите компанию-отправителя')
    const id = await this.shipments.openFromErp({ shipperOrgId: r.org.id, shipperInn: r.org.inn, erpRef, personId: p.id })
    await this.showCard(p, id, to)
  }

  /**
   * Карточка перевозки для человека. Роль: явно заданная (тот, кто нажал), иначе та, чей сейчас ход,
   * если она у человека есть, иначе текущая, иначе первая. Так у человека в двух ролях
   * (перевозчик и сам водитель) в карточке всегда кнопки того шага, который ждёт его.
   */
  async showCard(p: PersonRow, shipmentId: string, to: Reply, note?: string, prefer?: Role) {
    const roles = await this.shipments.rolesIn(shipmentId, p.id)
    const turn = (await this.shipments.view(shipmentId, 'shipper'))?.turn ?? null
    const role =
      (prefer && roles.includes(prefer) ? prefer : undefined) ??
      (turn && roles.includes(turn) ? turn : undefined) ??
      roles.find((r) => r === p.activeRole) ??
      roles[0]
    if (!role) return this.ui.notify(to, 'Вы не участник этой перевозки')
    const view = await this.shipments.view(shipmentId, role)
    if (!view) return this.ui.notify(to, 'Перевозка не найдена')
    if (p.activeRole !== role) await this.store.setActiveRole(p.id, role)
    const msg = shipmentCard(view, note)
    const mid = await this.ui.reply(to, msg)
    if (mid) await this.rememberCard(shipmentId, p.id, mid, renderHash(msg))
  }

  // ---------- живые карточки (HAKATON-28) ----------

  /** Это сообщение теперь живая карточка человека; прежнюю — погасить. */
  private async rememberCard(shipmentId: string, personId: string, mid: string, hash: string) {
    const old = await this.cards.record(shipmentId, personId, mid, hash)
    if (old) await this.messenger.edit(old, MOVED_CARD).catch((err) => this.log.warn({ err }, 'не удалось погасить старую карточку'))
  }

  /**
   * Перерисовать живые карточки участников, кроме skip. Каждому — в роли, чей сейчас ход,
   * если она у него есть. Одинаковый отпечаток — не трогаем: бережём лимиты MAX.
   */
  async refreshCards(shipmentId: string, skip: Set<string>) {
    const all = await this.shipments.participants(shipmentId)
    const byPerson = new Map<string, Role[]>()
    for (const x of all) byPerson.set(x.personId, [...(byPerson.get(x.personId) ?? []), x.role])
    const head = await this.shipments.view(shipmentId, 'shipper')
    for (const [personId, roles] of byPerson) {
      if (skip.has(personId)) continue
      const current = await this.cards.get(shipmentId, personId)
      if (!current) continue
      const role = head?.turn && roles.includes(head.turn) ? head.turn : roles[0]!
      const view = await this.shipments.view(shipmentId, role)
      if (!view) continue
      const msg = shipmentCard(view)
      const hash = renderHash(msg)
      if (hash === current.renderHash) continue
      await this.messenger.edit(current.mid, msg).catch((err) => this.log.warn({ err }, 'не удалось перерисовать карточку'))
      await this.cards.setHash(shipmentId, personId, hash)
    }
  }

  /** Кого предупредить, если участнику не написать: за водителя отвечает перевозчик, за остальных — отправитель. */
  private async escalation(shipmentId: string, role: Role, erpRef: string) {
    const fallback: Record<Role, Role | null> = { driver: 'carrier', carrier: 'shipper', consignee: 'shipper', shipper: null }
    const to = fallback[role] ? await this.shipments.participantOf(shipmentId, fallback[role]!) : null
    if (!to) return undefined
    return {
      userId: to.maxUserId,
      text: `⚠️ Не можем написать участнику «${ROLE_TITLE[role].toLowerCase()}» по перевозке ${erpRef}: он остановил бота или ни разу его не открывал. Свяжитесь с ним напрямую.`,
    }
  }

  // ---------- выполнение ----------

  async run(p: PersonRow, cmd: Command, to: Reply) {
    const res = await this.shipments.execute(cmd, { kind: 'person', personId: p.id, role: byOf(cmd.type) })
    if (!res.ok) return this.failed(res, to)
    // Карточку показываем в роли, которая нажала, а если ход остался за этим же человеком в другой роли — в ней
    const next = res.turn && (await this.shipments.rolesIn(cmd.shipmentId, p.id)).includes(res.turn) ? res.turn : byOf(cmd.type)
    await this.showCard(p, cmd.shipmentId, to, undefined, next)
    await this.afterTransition(res, { personId: p.id, role: byOf(cmd.type) })
  }

  private async decline(p: PersonRow, d: DialogState, reason: string, to: Reply) {
    const shipmentId = String(d.context.shipmentId)
    const cmd = (d.context.cmd as 'carrier.decline' | 'driver.declineTrip' | undefined) ?? 'carrier.decline'
    const role: Role = cmd === 'carrier.decline' ? 'carrier' : 'driver'
    const res = await this.shipments.execute({ type: cmd, shipmentId, payload: { reason } }, { kind: 'person', personId: p.id, role })
    await this.store.clearDialog(p.id)
    if (!res.ok) return this.failed(res, to)
    // Отказавшийся больше не участник — карточку ему не показываем
    const text = role === 'carrier' ? 'Заявка отклонена, отправитель получит причину.' : 'Вы отказались от рейса, перевозчик получит причину.'
    await this.ui.reply(to, { text, buttons: [[cb('В меню', `open:${role}`)]] })
    await this.afterTransition(res, { personId: p.id, role }, reason)
  }

  /** Отмена до подписи Т1: участникам — уведомление с причиной; статус в учётку уходит через очередь. */
  private async cancel(p: PersonRow, shipmentId: string, reason: string, to: Reply) {
    await this.store.clearDialog(p.id)
    const res = await this.shipments.execute({ type: 'shipper.cancel', shipmentId, payload: { reason } }, { kind: 'person', personId: p.id, role: 'shipper' })
    if (!res.ok) return this.failed(res, to)
    await this.showCard(p, shipmentId, to, `Перевозка отменена: ${esc(reason)}.`)

    const view = await this.shipments.view(shipmentId, 'shipper')
    const notified = new Set<string>([p.id])
    for (const role of ['carrier', 'driver', 'consignee'] as const) {
      const who = await this.shipments.participantOf(shipmentId, role)
      if (!who || notified.has(who.personId)) continue
      notified.add(who.personId)
      await this.messenger
        .send(who.maxUserId, { text: `❌ Перевозка ${esc(view?.erpRef ?? '')} отменена отправителем: ${esc(reason)}.`, buttons: [[cb('В меню', 'root')]] }, { shipmentId })
        .catch((err) => this.log.warn({ err }, 'не удалось уведомить об отмене'))
    }
    await this.refreshCards(shipmentId, new Set([p.id]))
  }

  async failed(res: Extract<ExecResult, { ok: false }>, to: Reply) {
    await this.ui.notify(to, FAIL_TEXT[res.code] ?? res.message)
  }

  /**
   * «Ваш ход» тому, чья очередь теперь; живые карточки остальным — HAKATON-28.
   * Один человек бывает в перевозке в двух ролях (отправитель и водитель): молчим, только если
   * ход остался у той же роли, что нажала кнопку.
   */
  async afterTransition(res: Extract<ExecResult, { ok: true }>, actor: { personId: string; role: Role }, reason?: string) {
    await this.notifyTurn(res, actor, reason)
    const target = res.turn ? await this.shipments.participantOf(res.shipmentId, res.turn) : null
    // Нажавшему карточку уже перерисовал ответ, тому, чей ход, пришла новая — остальным правим на месте
    await this.refreshCards(res.shipmentId, new Set([actor.personId, ...(target && !(target.personId === actor.personId && res.turn === actor.role) ? [target.personId] : [])]))
  }

  private async notifyTurn(res: Extract<ExecResult, { ok: true }>, actor: { personId: string; role: Role }, reason?: string) {
    const send = (userId: number, msg: OutMessage) =>
      this.messenger.send(userId, msg).catch((err) => this.log.warn({ err, shipmentId: res.shipmentId }, 'не удалось написать участнику'))

    // Отправителю — короткое «принято»: ход остаётся у перевозчика, а живых карточек пока нет
    if (res.to === 'carrier_accepted' && res.from === 'offered') {
      const shipper = await this.shipments.participantOf(res.shipmentId, 'shipper')
      const view = await this.shipments.view(res.shipmentId, 'shipper')
      if (shipper && view)
        await send(shipper.maxUserId, { text: `✅ Перевозчик ${esc(view.carrier?.name ?? '')} принял заявку ${esc(view.erpRef)}.`, buttons: [[cb('Открыть', S.view(res.shipmentId))]] })
    }

    if (!res.turn) return
    const target = await this.shipments.participantOf(res.shipmentId, res.turn)
    if (!target || (target.personId === actor.personId && res.turn === actor.role)) return
    const view = await this.shipments.view(res.shipmentId, res.turn)
    if (!view) return
    const note =
      res.to === 'offered'
        ? `📦 <b>Новая заявка</b> от ${esc(view.shipper.name)}`
        : res.to === 'draft' && reason
          ? `⚠️ Перевозчик отклонил заявку: ${esc(reason)}`
          : res.to === 'carrier_accepted' && reason
            ? `⚠️ Водитель отказался от рейса: ${esc(reason)}. Назначьте другого.`
            : res.to === 'assigned'
              ? `🚚 <b>Вам назначен рейс</b> от ${esc(view.carrier?.name ?? 'перевозчика')}`
              : res.to === 'loaded'
                ? `🔔 <b>Сейчас ваш ход:</b> водитель принял груз${view.loadingRemarks ? ` с замечаниями: ${esc(view.loadingRemarks)}` : ' без замечаний'}. Подпишите накладную.`
                : '🔔 <b>Сейчас ваш ход</b>'
    const msg = shipmentCard(view, note)
    const sent = await this.messenger
      .send(target.maxUserId, msg, {
        shipmentId: res.shipmentId,
        card: { personId: target.personId, hash: renderHash(msg) },
        escalate: await this.escalation(res.shipmentId, res.turn, view.erpRef),
      })
      .catch((err) => this.log.warn({ err, shipmentId: res.shipmentId }, 'не удалось написать участнику'))
    // Прямая отправка вернула mid — запоминаем карточку сами; очередь делает это после доставки
    if (sent && 'mid' in sent) await this.rememberCard(res.shipmentId, target.personId, sent.mid, renderHash(msg))
  }
}
