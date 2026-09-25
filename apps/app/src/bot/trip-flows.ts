import { normalizePlate, type Command, type Messenger, type PepEvidence, type VehicleOwnership } from '@nk/domain'
import type { FastifyBaseLogger } from 'fastify'
import type { FleetService } from '../core/fleet.ts'
import { inviteLink, sha256 } from '../core/invites.ts'
import type { ShipmentService } from '../core/shipments.ts'
import { phoneFromVcf, verifyContactHash } from '../max/contact.ts'
import { esc } from '../max/messenger.ts'
import type { MaxAttachment } from '../max/types.ts'
import { S, cb } from './screens.ts'
import { shipmentList } from './cards.ts'
import type { Reply, ShipmentFlows, Ui } from './shipment-flows.ts'
import type { BotStore, DialogState, PersonRow } from './store.ts'

// Рейс: перевозчик назначает машину и водителя (HAKATON-29, HAKATON-44), водитель проходит
// погрузку и ставит простую подпись. Перед первой подписью — «Поделиться номером» (решение 24.09).

const OWNERSHIP: { code: VehicleOwnership; text: string }[] = [
  { code: 'own', text: 'Собственная' },
  { code: 'lease', text: 'Лизинг' },
  { code: 'rent', text: 'Аренда' },
]

type Ctx = Record<string, unknown>

export class TripFlows {
  constructor(
    private readonly store: BotStore,
    private readonly shipments: ShipmentService,
    private readonly fleet: FleetService,
    private readonly flows: ShipmentFlows,
    private readonly messenger: Messenger,
    private readonly ui: Ui,
    private readonly botToken: string,
    private readonly botUsername: string,
    private readonly log: FastifyBaseLogger,
  ) {}

  // ---------- кнопки ----------

  async onButton(p: PersonRow, payload: string, to: Reply): Promise<boolean> {
    const [kind, ...rest] = payload.split(':')
    const arg = rest.join(':')
    switch (kind) {
      case 'as':
        await this.askVehicle(p, arg, to)
        return true
      case 'avh':
        return this.withDialog(p, 'await:vehicle', to, (d) => this.askDriver(p, { ...d.context, vehicleId: arg }, to))
      case 'nvh':
        return this.withDialog(p, 'await:vehicle', to, (d) => this.step(p, 'await:vehicle_plate', d.context, to))
      case 'own':
        return this.withDialog(p, 'await:vehicle_ownership', to, async (d) => {
          const ctx = { ...d.context, ownership: arg }
          if (arg === 'own') return this.saveVehicle(p, ctx, null, to)
          return this.step(p, 'await:vehicle_owner', ctx, to)
        })
      case 'adr':
        return this.withDialog(p, 'await:driver', to, (d) => this.assign(p, d.context, { personId: arg }, to))
      case 'cl':
        await this.loadingButton(p, rest[0] === 'ok' ? 'ok' : 'remarks', rest[1]!, to)
        return true
      case 'fleet':
        await this.showFleet(p, to)
        return true
      case 'trip':
        await this.showTrip(p, to)
        return true
      case 'trips': {
        const list = await this.shipments.listFor(p.id, 'driver')
        await this.ui.reply(to, shipmentList('Мои рейсы', list, 'driver', 'Рейсов пока нет.'))
        return true
      }
    }
    return false
  }

  /** Кнопка из текущего шага ввода; если ввод уже ушёл дальше — просто показываем текущий шаг. */
  private async withDialog(p: PersonRow, step: string, to: Reply, fn: (d: DialogState) => Promise<unknown>): Promise<boolean> {
    const d = await this.store.getDialog(p.id)
    if (d?.step !== step) {
      await this.ui.notify(to, 'Этот шаг уже пройден')
      return true
    }
    await fn(d)
    return true
  }

  // ---------- текст и контакт в диалоге ----------

  async onText(p: PersonRow, d: DialogState, text: string, to: Reply): Promise<boolean> {
    switch (d.step) {
      case 'await:vehicle_plate': {
        const plate = normalizePlate(text)
        if (!plate) return this.step(p, d.step, d.context, to, 'Не похоже на госномер. Пример: А245КМ116').then(() => true)
        await this.step(p, 'await:vehicle_brand', { ...d.context, plate }, to)
        return true
      }
      case 'await:vehicle_brand':
        if (text.length < 2) return this.step(p, d.step, d.context, to, 'Слишком коротко.').then(() => true)
        await this.step(p, 'await:vehicle_ownership', { ...d.context, brand: text }, to)
        return true
      case 'await:vehicle_owner':
        if (text.length < 3) return this.step(p, d.step, d.context, to, 'Укажите владельца: название компании или ФИО.').then(() => true)
        await this.saveVehicle(p, d.context, text, to)
        return true
      case 'await:driver':
      case 'await:phone':
        await this.ui.reply(to, { text: d.step === 'await:driver' ? 'Нужен контакт водителя: скрепка → «Контакт». Или выберите кнопкой выше.' : 'Нажмите кнопку «Поделиться номером» выше.' })
        return true
      case 'await:loading_remarks':
        if (text.length < 3) {
          await this.ui.reply(to, { text: 'Опишите замечания подробнее: что не так с грузом.' })
          return true
        }
        await this.store.clearDialog(p.id)
        await this.confirmLoading(p, String(d.context.shipmentId), text, d.context.evidence as PepEvidence, to)
        return true
    }
    return false
  }

  async onContact(p: PersonRow, d: DialogState, a: MaxAttachment, to: Reply): Promise<boolean> {
    if (d.step === 'await:driver') {
      await this.driverContact(p, d, a, to)
      return true
    }
    if (d.step === 'await:phone') {
      await this.ownPhone(p, d, a, to)
      return true
    }
    return false
  }

  // ---------- машина ----------

  private async carrierOrg(p: PersonRow) {
    return (await this.store.roles(p.id)).find((r) => r.role === 'carrier')?.org ?? null
  }

  private async askVehicle(p: PersonRow, shipmentId: string, to: Reply) {
    const org = await this.carrierOrg(p)
    if (!org) return this.ui.notify(to, 'Сначала подключите компанию-перевозчика')
    const cars = await this.fleet.vehicles(org.id)
    await this.store.setDialog(p.id, { step: 'await:vehicle', context: { shipmentId } })
    await this.ui.reply(to, {
      text: ['<b>Машина на рейс</b>', '', cars.length ? 'Выберите машину или добавьте новую.' : 'Машин пока нет — добавьте первую.'].join('\n'),
      buttons: [
        ...cars.slice(0, 10).map((c) => [cb(`${c.brand} ${c.plate}`, `avh:${c.id}`)]),
        [cb('+ Новая машина', 'nvh')],
        [cb('Отмена', S.view(shipmentId))],
      ],
    })
  }

  private async step(p: PersonRow, step: string, ctx: Ctx, to: Reply, error?: string) {
    await this.store.setDialog(p.id, { step, context: ctx })
    const err = error ? `\n\n⚠️ ${error}` : ''
    const cancel = [cb('Отмена', S.view(String(ctx.shipmentId)))]
    const prompts: Record<string, { text: string; buttons: ReturnType<typeof cb>[][] }> = {
      'await:vehicle_plate': { text: 'Госномер машины, например А245КМ116:', buttons: [cancel] },
      'await:vehicle_brand': { text: `Госномер ${esc(String(ctx.plate))}. Марка и модель, например КАМАЗ 65115:`, buttons: [cancel] },
      'await:vehicle_ownership': { text: 'Машина собственная или взята в лизинг, аренду? Это указывается в накладной.', buttons: [OWNERSHIP.map((o) => cb(o.text, `own:${o.code}`)), cancel] },
      'await:vehicle_owner': { text: 'Кто владелец машины? Название компании или ФИО:', buttons: [cancel] },
    }
    const pr = prompts[step]!
    await this.ui.reply(to, { text: `<b>Новая машина</b>\n\n${pr.text}${err}`, buttons: pr.buttons })
  }

  private async saveVehicle(p: PersonRow, ctx: Ctx, ownerName: string | null, to: Reply) {
    const org = await this.carrierOrg(p)
    if (!org) return this.ui.notify(to, 'Сначала подключите компанию-перевозчика')
    const vehicleId = await this.fleet.upsertVehicle(org.id, {
      plate: String(ctx.plate),
      brand: String(ctx.brand),
      ownership: ctx.ownership as VehicleOwnership,
      ownerName,
    })
    await this.askDriver(p, { shipmentId: ctx.shipmentId, vehicleId }, to)
  }

  // ---------- водитель ----------

  private async askDriver(p: PersonRow, ctx: Ctx, to: Reply) {
    const org = await this.carrierOrg(p)
    const drivers = org ? await this.fleet.drivers(org.id) : []
    await this.store.setDialog(p.id, { step: 'await:driver', context: ctx })
    await this.ui.reply(to, {
      text: ['<b>Водитель на рейс</b>', '', 'Перешлите сюда контакт водителя: скрепка → «Контакт».', drivers.length ? 'Или выберите из своих водителей:' : ''].join('\n').trim(),
      buttons: [...drivers.slice(0, 10).map((d) => [cb(d.name, `adr:${d.personId}`)]), [cb('Отмена', S.view(String(ctx.shipmentId)))]],
    })
  }

  private async driverContact(p: PersonRow, d: DialogState, a: MaxAttachment, to: Reply) {
    const info = a.payload?.max_info
    if (!info) {
      await this.ui.reply(to, { text: 'У этого контакта нет аккаунта MAX — бот не сможет ему написать. Пришлите другой контакт.' })
      return
    }
    const name = [info.first_name, info.last_name].filter(Boolean).join(' ')
    const org = await this.carrierOrg(p)
    const found = await this.store.personByMaxUserId(info.user_id)
    if (found) {
      const role = (await this.store.roles(found.id)).find((r) => r.role === 'driver')
      if (role?.org && org && role.org.id !== org.id) {
        await this.ui.reply(to, { text: `${esc(name)} работает водителем у другого перевозчика: ${esc(role.org.name)}. Назначить его нельзя.` })
        return
      }
      if (role) {
        if (!role.org && org) await this.store.setRoleOrg(found.id, 'driver', org.id)
        return this.assign(p, d.context, { personId: found.id }, to)
      }
    }
    // Роли водителя нет или человека нет в боте — приглашение; по нему роль появится сама
    const phone = phoneFromVcf(a.payload?.vcf_info)
    await this.assign(p, d.context, { invite: { expectedMaxUserId: info.user_id, expectedPhoneSha256: phone ? sha256(phone) : null, displayName: name } }, to, found?.maxUserId ?? null, name)
  }

  private async assign(
    p: PersonRow,
    ctx: Ctx,
    driver: Extract<Command, { type: 'carrier.assign' }>['payload']['driver'],
    to: Reply,
    knownMaxUserId: number | null = null,
    inviteeName = '',
  ) {
    const shipmentId = String(ctx.shipmentId)
    const res = await this.shipments.execute(
      { type: 'carrier.assign', shipmentId, payload: { vehicleId: String(ctx.vehicleId), driver } },
      { kind: 'person', personId: p.id, role: 'carrier' },
    )
    if (!res.ok) {
      if (res.code === 'busy') return this.ui.reply(to, { text: `⚠️ ${res.message}. Выберите другую.`, buttons: [[cb('Выбрать заново', `as:${shipmentId}`)]] })
      return this.flows.failed(res, to)
    }
    await this.store.clearDialog(p.id)
    const invite = res.invites.find((i) => i.role === 'driver')
    let note = 'Машина и водитель назначены, водитель получил рейс.'
    if (invite) {
      const link = inviteLink(this.botUsername, invite.token)
      if (knownMaxUserId) {
        // Человек уже писал боту — отправляем приглашение ему напрямую
        const view = await this.shipments.view(shipmentId, 'carrier')
        await this.messenger
          .send(knownMaxUserId, {
            text: `🚚 ${esc(view?.carrier?.name ?? 'Перевозчик')} назначает вас водителем на рейс ${esc(view?.erpRef ?? '')}. Откройте, чтобы принять:`,
            buttons: [[{ text: 'Открыть рейс', kind: 'link', payload: link }]],
          })
          .catch((err) => this.log.warn({ err }, 'не удалось отправить приглашение водителю'))
        note = `${esc(inviteeName)} получил приглашение в боте.`
      } else {
        note = `${esc(inviteeName)} ещё не пользуется ботом. Перешлите ему приглашение:\n${link}`
      }
    }
    await this.flows.showCard(p, shipmentId, to, note)
    await this.flows.afterTransition(res, p.id)
  }

  // ---------- погрузка и простая подпись ----------

  private async loadingButton(p: PersonRow, choice: 'ok' | 'remarks', shipmentId: string, to: Reply) {
    if (to.kind !== 'callback') return
    const buttonText = choice === 'ok' ? 'Всё верно, груз принят' : 'Есть замечания'
    const pending = { shipmentId, choice, callbackId: to.callbackId, mid: to.mid ?? '', buttonText, at: new Date().toISOString() }
    if (!p.phoneSha256) return this.askPhone(p, pending, to)
    return this.continueLoading(p, pending, p.phoneSha256, p.maxUserId, to)
  }

  private async continueLoading(p: PersonRow, pending: Ctx, phoneSha256: string, maxUserId: number, to: Reply) {
    const evidence: PepEvidence = {
      maxUserId,
      phoneSha256,
      callbackId: String(pending.callbackId),
      messageMid: String(pending.mid),
      buttonText: String(pending.buttonText),
      at: String(pending.at),
    }
    const shipmentId = String(pending.shipmentId)
    if (pending.choice === 'ok') return this.confirmLoading(p, shipmentId, null, evidence, to)
    await this.store.setDialog(p.id, { step: 'await:loading_remarks', context: { shipmentId, evidence } })
    await this.ui.reply(to, {
      text: '<b>Замечания к грузу</b>\n\nОпишите, что не так: недостача, повреждения, не та упаковка. Отправитель увидит это до подписи.',
      buttons: [[cb('Отмена', S.view(shipmentId))]],
    })
  }

  private async confirmLoading(p: PersonRow, shipmentId: string, remarks: string | null, evidence: PepEvidence, to: Reply) {
    await this.flows.run(p, { type: 'driver.confirmLoading', shipmentId, payload: { remarks, evidence } }, to)
  }

  /** Перед первой подписью — номер телефона кнопкой request_contact, один раз на человека. */
  private async askPhone(p: PersonRow, pending: Ctx, to: Reply) {
    await this.store.setDialog(p.id, { step: 'await:phone', context: { pending } })
    await this.ui.reply(to, {
      text: [
        '<b>Подтвердите номер телефона</b>',
        '',
        'Это ваша первая подпись в боте. Номер, привязанный к MAX, — доказательство, что подписали именно вы. Спрашиваем один раз.',
        '',
        'Храним не сам номер, а его отпечаток. Передавая номер, вы соглашаетесь на его обработку для подписи документов перевозки.',
      ].join('\n'),
      buttons: [[{ text: 'Поделиться номером', kind: 'request_contact', payload: '' }], [cb('Отмена', S.view(String(pending.shipmentId)))]],
    })
  }

  private async ownPhone(p: PersonRow, d: DialogState, a: MaxAttachment, to: Reply) {
    const vcf = a.payload?.vcf_info ?? ''
    const hash = a.payload?.hash ?? ''
    const own = !a.payload?.max_info || a.payload.max_info.user_id === p.maxUserId
    const ok = Boolean(vcf && hash && own && verifyContactHash(this.botToken, vcf, hash))
    const phone = phoneFromVcf(vcf)
    this.log.info({ hasHash: Boolean(hash), own, verified: ok }, 'номер для подписи')
    if (!ok || !phone) {
      await this.ui.reply(to, {
        text: 'Не получилось подтвердить номер. Нажмите именно кнопку «Поделиться номером» выше — пересланный контакт не подходит.',
      })
      return
    }
    const phoneSha256 = sha256(phone)
    await this.store.savePhone(p.id, phoneSha256)
    await this.store.clearDialog(p.id)
    await this.ui.reply(to, { text: '✅ Номер подтверждён.' })
    await this.continueLoading(p, d.context.pending as Ctx, phoneSha256, p.maxUserId, to)
  }

  // ---------- экраны ----------

  private async showFleet(p: PersonRow, to: Reply) {
    const org = await this.carrierOrg(p)
    if (!org) return this.ui.notify(to, 'Сначала подключите компанию-перевозчика')
    const [cars, drivers] = await Promise.all([this.fleet.vehicles(org.id), this.fleet.drivers(org.id)])
    const own = Object.fromEntries(OWNERSHIP.map((o) => [o.code, o.text.toLowerCase()]))
    const lines = ['<b>Машины и водители</b>', '', '<b>Машины</b>']
    lines.push(...(cars.length ? cars.map((c) => `• ${esc(c.brand)} ${c.plate}, ${own[c.ownership] ?? ''}${c.ownerName ? `, владелец ${esc(c.ownerName)}` : ''}`) : ['пока нет — добавляются при назначении на рейс']))
    lines.push('', '<b>Водители</b>')
    lines.push(...(drivers.length ? drivers.map((d) => `• ${esc(d.name)}`) : ['пока нет — назначаются пересылкой контакта']))
    await this.ui.reply(to, { text: lines.join('\n'), buttons: [[cb('В меню', 'open:carrier')]] })
  }

  private async showTrip(p: PersonRow, to: Reply) {
    const active = (await this.shipments.listFor(p.id, 'driver')).find((s) => s.state !== 'closed' && s.state !== 'cancelled')
    if (!active) return this.ui.reply(to, { text: 'Активного рейса нет. Когда перевозчик назначит вас, рейс придёт сюда.', buttons: [[cb('В меню', 'open:driver')]] })
    await this.flows.showCard(p, active.shipmentId, to)
  }
}
