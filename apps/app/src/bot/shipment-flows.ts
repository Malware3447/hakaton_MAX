import { TRANSITIONS, type Command, type CommandType, type Messenger, type OutMessage, type Role } from '@nk/domain'
import type { FastifyBaseLogger } from 'fastify'
import type { ExecResult, ShipmentService } from '../core/shipments.ts'
import { inviteLink, sha256 } from '../core/invites.ts'
import { esc } from '../max/messenger.ts'
import type { MaxAttachment } from '../max/types.ts'
import { S, cb } from './screens.ts'
import { shipmentCard, shipmentList, shipperList, waitingList } from './cards.ts'
import type { BotStore, DialogState, PersonRow } from './store.ts'

// Действия с перевозками в чате: HAKATON-24 (ядро), HAKATON-29 (шаги), HAKATON-44 (назначение по контакту).

export type Reply = { kind: 'callback'; callbackId: string } | { kind: 'message'; userId: number }

export interface Ui {
  reply(to: Reply, msg: OutMessage, notification?: string | null): Promise<void>
  notify(to: Reply, text: string): Promise<void>
}

/** Команды без данных — выполняются прямо с кнопки. */
const ONE_TAP: CommandType[] = ['carrier.accept', 'driver.acceptTrip', 'driver.arrivedLoading', 'driver.arrivedUnloading']

const DECLINE_REASONS = ['Нет свободных машин', 'Не наш маршрут', 'Не устраивают сроки']

const FAIL_TEXT: Record<string, string> = {
  already_done: 'Уже сделано',
  wrong_state: 'Сейчас это действие недоступно',
  wrong_role: 'Это действие другой стороны',
  not_participant: 'Вы не участник этой перевозки в этой роли',
  not_found: 'Перевозка не найдена',
}

const byOf = (cmd: CommandType) => TRANSITIONS.find((t) => t.command === cmd)!.by as Role

function phoneFromVcf(vcf: string | null | undefined): string | null {
  const raw = /(?:^|\n)TEL[^:]*:([^\r\n]+)/.exec(vcf ?? '')?.[1]
  if (!raw) return null
  const d = raw.replace(/\D/g, '')
  const norm = d.length === 11 && (d.startsWith('7') || d.startsWith('8')) ? `+7${d.slice(1)}` : d.length === 10 ? `+7${d}` : `+${d}`
  return norm
}

export class ShipmentFlows {
  constructor(
    private readonly store: BotStore,
    private readonly shipments: ShipmentService,
    private readonly messenger: Messenger,
    private readonly ui: Ui,
    private readonly botUsername: string,
    private readonly log: FastifyBaseLogger,
  ) {}

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
        await this.store.setDialog(p.id, { step: 'await:decline_reason', context: { shipmentId: arg } })
        await this.ui.reply(to, {
          text: '<b>Отклонить заявку</b>\n\nВыберите причину или напишите свою — отправитель её увидит.',
          buttons: [...DECLINE_REASONS.map((r, i) => [cb(r, `dq:${i}`)]), [cb('Отмена', S.view(arg))]],
        })
        return true
      case 'dq': {
        const d = await this.store.getDialog(p.id)
        const reason = DECLINE_REASONS[Number(arg)]
        if (d?.step !== 'await:decline_reason' || !reason) return false
        await this.decline(p, d, reason, to)
        return true
      }
      case 'wl': {
        const role = arg as Role
        await this.ui.reply(to, waitingList(await this.shipments.waiting(p.id, role), role))
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
          '<i>Вход по приглашению появится в следующей версии.</i>',
        ].join('\n')
      : `Заявка отправлена: ${esc(name)}.`
    await this.showCard(p, shipmentId, to, note)
    await this.afterTransition(res, p.id)
    return true
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

  /** Карточка в роли, от которой человек сейчас работает; если он в перевозке в другой роли — в ней. */
  async showCard(p: PersonRow, shipmentId: string, to: Reply, note?: string) {
    const roles = await this.shipments.rolesIn(shipmentId, p.id)
    const role = roles.find((r) => r === p.activeRole) ?? roles[0]
    if (!role) return this.ui.notify(to, 'Вы не участник этой перевозки')
    const view = await this.shipments.view(shipmentId, role)
    if (!view) return this.ui.notify(to, 'Перевозка не найдена')
    if (p.activeRole !== role) await this.store.setActiveRole(p.id, role)
    await this.ui.reply(to, shipmentCard(view, note))
  }

  // ---------- выполнение ----------

  private async run(p: PersonRow, cmd: Command, to: Reply) {
    const res = await this.shipments.execute(cmd, { kind: 'person', personId: p.id, role: byOf(cmd.type) })
    if (!res.ok) return this.failed(res, to)
    await this.showCard(p, cmd.shipmentId, to)
    await this.afterTransition(res, p.id)
  }

  private async decline(p: PersonRow, d: DialogState, reason: string, to: Reply) {
    const shipmentId = String(d.context.shipmentId)
    const res = await this.shipments.execute(
      { type: 'carrier.decline', shipmentId, payload: { reason } },
      { kind: 'person', personId: p.id, role: 'carrier' },
    )
    await this.store.clearDialog(p.id)
    if (!res.ok) return this.failed(res, to)
    // Перевозчик больше не участник — карточку ему не показываем
    await this.ui.reply(to, { text: 'Заявка отклонена, отправитель получит причину.', buttons: [[cb('В меню', `open:carrier`)]] })
    await this.afterTransition(res, p.id, reason)
  }

  private async failed(res: Extract<ExecResult, { ok: false }>, to: Reply) {
    await this.ui.notify(to, FAIL_TEXT[res.code] ?? res.message)
  }

  /** «Ваш ход» тому, чья очередь теперь; живые карточки остальным — HAKATON-28. */
  private async afterTransition(res: Extract<ExecResult, { ok: true }>, actorPersonId: string, reason?: string) {
    const send = (userId: number, msg: OutMessage) =>
      this.messenger.send(userId, msg).catch((err) => this.log.warn({ err, shipmentId: res.shipmentId }, 'не удалось написать участнику'))

    // Отправителю — короткое «принято»: ход остаётся у перевозчика, а живых карточек пока нет
    if (res.to === 'carrier_accepted') {
      const shipper = await this.shipments.participantOf(res.shipmentId, 'shipper')
      const view = await this.shipments.view(res.shipmentId, 'shipper')
      if (shipper && view && shipper.personId !== actorPersonId)
        await send(shipper.maxUserId, { text: `✅ Перевозчик ${esc(view.carrier?.name ?? '')} принял заявку ${esc(view.erpRef)}.`, buttons: [[cb('Открыть', S.view(res.shipmentId))]] })
    }

    if (!res.turn) return
    const target = await this.shipments.participantOf(res.shipmentId, res.turn)
    if (!target || target.personId === actorPersonId) return
    const view = await this.shipments.view(res.shipmentId, res.turn)
    if (!view) return
    const note =
      res.to === 'offered'
        ? `📦 <b>Новая заявка</b> от ${esc(view.shipper.name)}`
        : res.to === 'draft' && reason
          ? `⚠️ Перевозчик отклонил заявку: ${esc(reason)}`
          : '🔔 <b>Сейчас ваш ход</b>'
    await send(target.maxUserId, shipmentCard(view, note))
  }
}
