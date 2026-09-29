import type { Messenger, Role } from '@nk/domain'
import type { FastifyBaseLogger } from 'fastify'
import { esc } from '../max/messenger.ts'
import type { MaxAttachment } from '../max/types.ts'
import { orgInviteLink, type JoinResult, type OrgInviteService } from '../core/org-invites.ts'
import { P, ROLE_TITLE, cb, companyScreen, rootMenu } from './screens.ts'
import type { Reply, Ui } from './shipment-flows.ts'
import type { BotStore, DialogState, PersonRow, RoleInfo } from './store.ts'

// Люди компании (HAKATON-48): список сотрудников в «Компании», добавление пересланным контактом
// или ссылкой, просьба о доступе от того, чей ИНН уже подключён. Водителей добавляет перевозчик
// в «Машины и водители» — здесь только отправитель, перевозчик и получатель.

const WAIT_CONTACT = 'staff:contact'
const role = (r: Role) => ROLE_TITLE[r].toLowerCase()

export const SP = {
  add: 'pa',
  link: 'pl',
  request: 'pq',
  approve: (id: string) => `py:${id}`,
  reject: (id: string) => `pn:${id}`,
  signs: (yes: boolean) => `ps:${yes ? 1 : 0}`,
  leave: 'px',
  leaveYes: 'pxy',
}

export class StaffFlows {
  constructor(
    private readonly store: BotStore,
    private readonly invites: OrgInviteService,
    private readonly messenger: Messenger,
    private readonly ui: Ui & { showRole(p: PersonRow, role: Role, to: Reply, note?: string): Promise<unknown> },
    private readonly botUsername: string,
    private readonly log: FastifyBaseLogger,
  ) {}

  private async active(p: PersonRow): Promise<RoleInfo | null> {
    return (await this.store.roles(p.id)).find((x) => x.role === p.activeRole) ?? null
  }

  /** Экран «Компания»: реквизиты, сотрудники, «Добавить сотрудника» для администратора. */
  async showCompany(p: PersonRow, to: Reply, note?: string) {
    const r = await this.active(p)
    if (!r) return this.ui.reply(to, { text: 'Сначала выберите роль.', buttons: [[cb('Меню ролей', P.root)]] })
    const screen = companyScreen(r)
    if (!r.org || r.role === 'driver') return this.ui.reply(to, screen)
    const staff = await this.invites.staff(r.org.id, r.role)
    const lines = [screen.text, '', `<b>Сотрудники</b> (${staff.length})`]
    for (const s of staff) {
      const what = [s.isAdmin ? 'администратор' : '', s.canSign ? 'подписывает' : 'принимает груз'].filter(Boolean).join(', ')
      lines.push(`• ${esc(s.name)}${s.personId === p.id ? ' (вы)' : ''} — ${what}`)
    }
    if (!r.isAdmin) lines.push('', '<i>Добавить сотрудника может администратор компании.</i>')
    if (note) lines.push('', note)
    const buttons = [...(r.isAdmin ? [[cb('Добавить сотрудника', SP.add)]] : []), [cb('Выйти из компании', SP.leave)], ...screen.buttons!]
    return this.ui.reply(to, { text: lines.join('\n'), buttons })
  }

  async onButton(p: PersonRow, payload: string, to: Reply): Promise<boolean> {
    const [kind, arg] = payload.split(':') as [string, string | undefined]
    switch (kind) {
      case 'pa':
        await this.startAdd(p, to)
        return true
      case 'pl':
        await this.link(p, to)
        return true
      case 'pq':
        await this.requestAccess(p, to)
        return true
      case 'py':
      case 'pn':
        await this.decide(p, arg ?? '', kind === 'py', to)
        return true
      case 'ps':
        await this.setSigns(p, arg === '1', to)
        return true
      case 'px':
        await this.askLeave(p, to)
        return true
      case 'pxy':
        await this.leave(p, to)
        return true
      default:
        return false
    }
  }

  private async adminRole(p: PersonRow, to: Reply): Promise<(RoleInfo & { org: NonNullable<RoleInfo['org']> }) | null> {
    const r = await this.active(p)
    if (!r?.org || r.role === 'driver') {
      await this.ui.notify(to, 'Откройте компанию в роли отправителя, перевозчика или получателя')
      return null
    }
    if (!r.isAdmin) {
      await this.ui.notify(to, 'Добавлять сотрудников может только администратор компании')
      return null
    }
    return r as RoleInfo & { org: NonNullable<RoleInfo['org']> }
  }

  private async startAdd(p: PersonRow, to: Reply) {
    const r = await this.adminRole(p, to)
    if (!r) return
    await this.store.setDialog(p.id, { step: WAIT_CONTACT, context: { orgId: r.org.id, role: r.role } })
    await this.ui.reply(to, {
      text: [
        `<b>Новый сотрудник</b> · ${esc(r.org.name)}, роль «${role(r.role)}»`,
        '',
        'Перешлите сюда контакт сотрудника из MAX: откройте его профиль → «Поделиться контактом» → этот чат.',
        'Если он уже пользуется ботом — добавлю сразу. Если нет — дам ссылку, которую нужно ему переслать.',
      ].join('\n'),
      buttons: [[cb('Лучше ссылку', SP.link)], [cb('Отмена', P.company)]],
    })
  }

  private async link(p: PersonRow, to: Reply) {
    const r = await this.adminRole(p, to)
    if (!r) return
    await this.store.clearDialog(p.id)
    const token = await this.invites.create(r.org.id, r.role, p.id)
    await this.ui.reply(to, {
      text: [
        `Ссылка для сотрудника ${esc(r.org.name)} в роли «${role(r.role)}». Перешлите её человеку — войдёт один, ссылка действует 7 дней:`,
        orgInviteLink(this.botUsername, token),
      ].join('\n'),
      buttons: [[cb('К компании', P.company)]],
    })
  }

  async onContact(p: PersonRow, d: DialogState, a: MaxAttachment, to: Reply): Promise<boolean> {
    if (d.step !== WAIT_CONTACT) return false
    const { orgId, role: r } = d.context as { orgId: string; role: Role }
    const info = a.payload?.max_info
    if (!info) {
      await this.ui.reply(to, { text: 'У этого контакта нет аккаунта MAX — бот не сможет ему написать. Пришлите другой контакт или возьмите ссылку.', buttons: [[cb('Лучше ссылку', SP.link)], [cb('Отмена', P.company)]] })
      return true
    }
    if (!(await this.invites.isAdmin(p.id, orgId, r))) {
      await this.store.clearDialog(p.id)
      await this.ui.notify(to, 'Добавлять сотрудников может только администратор компании')
      return true
    }
    const name = [info.first_name, info.last_name].filter(Boolean).join(' ')
    await this.store.clearDialog(p.id)
    const found = await this.store.personByMaxUserId(info.user_id)
    if (!found) {
      const token = await this.invites.create(orgId, r, p.id, info.user_id)
      await this.ui.reply(to, {
        text: [`${esc(name)} ещё не пользуется ботом. Перешлите ему приглашение — оно действует 7 дней:`, orgInviteLink(this.botUsername, token)].join('\n'),
        buttons: [[cb('К компании', P.company)]],
      })
      return true
    }
    const res = await this.invites.addDirect(orgId, r, found.id, p.id)
    if (!res.ok) {
      await this.showCompany(p, to, failText(res, esc(found.name)))
      return true
    }
    await this.welcome(found, res)
    await this.showCompany(p, to, `✅ ${esc(found.name)} добавлен в компанию. Я ему написал.`)
    return true
  }

  /** Ссылка https://max.ru/<бот>?start=org_<токен>. */
  async onInvite(p: PersonRow, token: string, to: Reply) {
    const found = await this.invites.lookup(token)
    const menu = [[cb('В меню', P.root)]]
    if (found.kind === 'not_found') return this.ui.reply(to, { text: 'Приглашение не найдено. Попросите администратора компании прислать ссылку ещё раз.', buttons: menu })
    if (found.kind === 'expired') return this.ui.reply(to, { text: 'Срок приглашения истёк: ссылка действует 7 дней. Попросите у администратора новую.', buttons: menu })
    if (found.kind === 'declined') return this.ui.reply(to, { text: 'Это приглашение отменено.', buttons: menu })
    if (found.kind === 'taken') {
      if (found.invite.acceptedPersonId === p.id) return this.ui.showRole(p, found.invite.role, to)
      return this.ui.reply(to, { text: 'По этому приглашению уже вошёл другой человек. Попросите у администратора новую ссылку.', buttons: menu })
    }
    if (found.kind !== 'open') return this.ui.reply(to, { text: 'Приглашение не найдено.', buttons: menu })
    if (found.invite.invitedByPersonId === p.id)
      return this.ui.reply(to, { text: 'Это ваша ссылка для нового сотрудника — сами её не открывайте, перешлите ему. Войдёт он, а не вы.', buttons: [[cb('К компании', P.company)], ...menu] })
    const res = await this.invites.join(found.invite.id, p.id)
    if (!res.ok) {
      if (res.reason === 'already') return this.ui.showRole(p, found.invite.role, to, 'Вы уже в этой компании.')
      return this.ui.reply(to, { text: failText(res, 'Вы'), buttons: menu })
    }
    const mismatch = found.invite.expectedMaxUserId != null && found.invite.expectedMaxUserId !== p.maxUserId
    await this.tellAdmins(res, `✅ ${esc(p.name)} вошёл в компанию по ссылке, роль «${role(res.role)}».${mismatch ? '\n⚠️ Это не тот человек, чей контакт вы присылали. Если его не ждали — напишите нам.' : ''}`, p.id)
    await this.greet({ ...p, activeRole: res.role }, res, to)
  }

  /** Анкета: ИНН уже подключён — попросить доступ у администратора. */
  private async requestAccess(p: PersonRow, to: Reply) {
    const d = await this.store.getDialog(p.id)
    const ctx = d?.context as { role?: Role; inn?: string } | undefined
    const o = ctx?.inn ? await this.store.orgByInn(ctx.inn) : null
    if (!ctx?.role || !o) return this.ui.reply(to, { text: 'Анкета устарела — начните заново.', buttons: [[cb('Меню ролей', P.root)]] })
    await this.store.clearDialog(p.id)
    const { id, admins } = await this.invites.request(o.id, ctx.role, p.id)
    for (const a of admins) {
      await this.messenger
        .send(a.maxUserId, {
          text: `🔔 ${esc(p.name)} просит доступ к компании ${esc(o.name)} в роли «${role(ctx.role)}».`,
          buttons: [[cb('Добавить', SP.approve(id)), cb('Отказать', SP.reject(id))]],
        })
        .catch((err) => this.log.warn({ err }, 'не удалось написать администратору'))
    }
    return this.ui.reply(to, {
      text: `Попросил администратора ${esc(admins.map((a) => a.name).join(', ') || 'компании')}. Как только он добавит вас, я напишу.`,
      buttons: [[cb('В меню', P.root)]],
    })
  }

  private async decide(p: PersonRow, id: string, approve: boolean, to: Reply) {
    const row = await this.invites.get(id)
    if (!row?.i.requestedByPersonId) return this.ui.notify(to, 'Просьба не найдена')
    if (!(await this.invites.isAdmin(p.id, row.i.orgId, row.i.role))) return this.ui.notify(to, 'Решать может администратор компании')
    const who = await this.store.personById(row.i.requestedByPersonId)
    if (!who) return this.ui.notify(to, 'Просьба не найдена')
    if (!approve) {
      const done = await this.invites.decline(id)
      if (done)
        await this.messenger
          .send(who.maxUserId, { text: `Администратор ${esc(row.name)} не добавил вас в компанию. Если это ошибка — свяжитесь с ним.`, buttons: [[cb('В меню', P.root)]] })
          .catch((err) => this.log.warn({ err }, 'не удалось написать просившему'))
      return this.ui.reply(to, { text: done ? `Отказали: ${esc(who.name)} не добавлен.` : 'По этой просьбе уже решили.', buttons: [[cb('К компании', P.company)]] })
    }
    const res = await this.invites.join(id, who.id)
    if (!res.ok) return this.ui.reply(to, { text: res.reason === 'already' || res.reason === 'taken' ? 'По этой просьбе уже решили.' : failText(res, esc(who.name)), buttons: [[cb('К компании', P.company)]] })
    await this.welcome(who, res)
    await this.tellAdmins(res, `✅ ${esc(p.name)} добавил в компанию ${esc(who.name)}, роль «${role(res.role)}».`, p.id)
    return this.ui.reply(to, { text: `✅ ${esc(who.name)} добавлен в компанию. Я ему написал.`, buttons: [[cb('К компании', P.company)]] })
  }

  /** Сообщение добавленному: куда его добавили и что дальше. */
  private async welcome(who: PersonRow, res: Extract<JoinResult, { ok: true }>) {
    await this.messenger
      .send(who.maxUserId, {
        text: `🔔 Вас добавили в компанию ${esc(res.orgName)} в роли «${role(res.role)}».${res.role === 'consignee' ? '\n\nВы подписываете документы за компанию или только принимаете груз?' : ''}`,
        buttons: res.role === 'consignee' ? signButtons : [[cb('Открыть', P.open(res.role))]],
      })
      .catch((err) => this.log.warn({ err }, 'не удалось написать новому сотруднику'))
  }

  private async greet(p: PersonRow, res: Extract<JoinResult, { ok: true }>, to: Reply) {
    if (res.role === 'consignee')
      return this.ui.reply(to, { text: `✅ Вы в компании ${esc(res.orgName)} в роли «${role(res.role)}».\n\nВы подписываете документы за компанию или только принимаете груз?`, buttons: signButtons })
    return this.ui.showRole(p, res.role, to, `✅ Вы в компании ${esc(res.orgName)}. Доверенность спросим перед первой подписью.`)
  }

  private async setSigns(p: PersonRow, yes: boolean, to: Reply) {
    const r = (await this.store.roles(p.id)).find((x) => x.role === 'consignee')
    if (!r?.org) return this.ui.notify(to, 'Роль получателя не найдена')
    await this.invites.setCanSign(p.id, r.org.id, 'consignee', yes)
    await this.store.setActiveRole(p.id, 'consignee')
    return this.ui.showRole({ ...p, activeRole: 'consignee' }, 'consignee', to, yes ? 'Готово: вы подписываете приёмку. Доверенность спросим перед первой подписью.' : 'Готово: вы принимаете груз, подписывает другой сотрудник.')
  }

  // ---------- выход из компании (HAKATON-51) ----------

  private async askLeave(p: PersonRow, to: Reply) {
    const r = await this.active(p)
    if (!r?.org || r.role === 'driver') return this.ui.notify(to, 'Откройте компанию в роли отправителя, перевозчика или получателя')
    const plan = await this.invites.leavePlan(p.id, r.org.id, r.role)
    const lines = [`<b>Выйти из компании ${esc(r.org.name)}?</b>`, '', `Роль «${role(r.role)}» у вас пропадёт. Вернуться можно только по приглашению администратора.`]
    if (plan.newAdmin) lines.push(`Администратором станет ${esc(plan.newAdmin.name)}.`)
    if (plan.active.length && plan.heir)
      lines.push(`Перевозки в работе (${plan.active.length}: ${plan.active.slice(0, 5).map((s) => esc(s.erpRef)).join(', ')}${plan.active.length > 5 ? ' и другие' : ''}) перейдут к сотруднику ${esc(plan.heir.name)}.`)
    if (plan.active.length && !plan.heir) {
      lines.push('', `⚠️ У вас ${plan.active.length} ${plan.active.length === 1 ? 'перевозка' : 'перевозки'} в работе, а других сотрудников в компании нет — передать их некому. Сначала добавьте сотрудника или завершите перевозки.`)
      return this.ui.reply(to, { text: lines.join('\n'), buttons: [[cb('Добавить сотрудника', SP.add)], [cb('Назад', P.company)]] })
    }
    if (!plan.others.length) lines.push('Вы последний сотрудник: компания останется в системе, первый подключивший её ИНН станет администратором.')
    return this.ui.reply(to, { text: lines.join('\n'), buttons: [[cb('Да, выйти', SP.leaveYes)], [cb('Отмена', P.company)]] })
  }

  private async leave(p: PersonRow, to: Reply) {
    const r = await this.active(p)
    if (!r?.org || r.role === 'driver') return this.ui.notify(to, 'Откройте компанию в роли отправителя, перевозчика или получателя')
    const res = await this.invites.leave(p.id, r.org.id, r.role)
    if (!res.ok) return this.askLeave(p, to)
    const { plan } = res
    const orgName = esc(r.org.name)
    if (plan.newAdmin)
      await this.messenger
        .send(plan.newAdmin.maxUserId, { text: `🔔 ${esc(p.name)} вышел из компании ${orgName}. Теперь администратор — вы: добавляете и принимаете новых сотрудников.`, buttons: [[cb('Открыть', P.open(r.role))]] })
        .catch((err) => this.log.warn({ err }, 'не удалось написать новому администратору'))
    if (plan.heir && plan.active.length)
      await this.messenger
        .send(plan.heir.maxUserId, {
          text: `🔔 ${esc(p.name)} вышел из компании ${orgName}. Его перевозки в работе теперь ведёте вы:`,
          buttons: plan.active.slice(0, 8).map((s) => [cb(s.erpRef, `v:${s.id}`)]),
        })
        .catch((err) => this.log.warn({ err }, 'не удалось написать преемнику'))
    const told = new Set([plan.newAdmin?.personId, plan.active.length ? plan.heir?.personId : undefined])
    for (const a of plan.others.filter((o) => o.isAdmin && !told.has(o.personId)))
      await this.messenger.send(a.maxUserId, { text: `ℹ️ ${esc(p.name)} вышел из компании ${orgName}.` }).catch((err) => this.log.warn({ err }, 'не удалось написать администратору'))
    const moved = plan.active.length && plan.heir ? ` Перевозки в работе переданы: ${esc(plan.heir.name)}.` : ''
    return this.ui.reply(to, rootMenu(await this.store.roles(p.id), null, `✅ Вы вышли из компании ${orgName}.${moved}`))
  }

  private async tellAdmins(res: Extract<JoinResult, { ok: true }>, text: string, except: string) {
    const ids = new Set(res.admins.filter((a) => a.personId !== except).map((a) => a.maxUserId))
    for (const id of ids) await this.messenger.send(id, { text, buttons: [[cb('Компания', P.company)]] }).catch((err) => this.log.warn({ err }, 'не удалось написать администратору'))
  }
}

const signButtons = [[cb('Принимаю и подписываю', SP.signs(true))], [cb('Только принимаю', SP.signs(false))]]

function failText(res: Extract<JoinResult, { ok: false }>, who: string): string {
  switch (res.reason) {
    case 'other_org':
      return `${who} уже ${who === 'Вы' ? 'работаете' : 'работает'} в этой роли в другой компании: ${esc(res.otherOrg ?? '')}. Одна роль — одна компания.`
    case 'already':
      return `${who} уже в компании.`
    case 'expired':
      return 'Срок приглашения истёк — попросите новую ссылку.'
    case 'declined':
      return 'Это приглашение отменено.'
    default:
      return 'Приглашение не найдено.'
  }
}
