import { ROLES, type Button, type OutMessage, type Role } from '@nk/domain'
import { esc } from '../max/messenger.ts'
import type { RoleInfo } from './store.ts'

// Экраны бота. Спецификация — docs/roli-i-menyu.md, разделы 3 и 6.
// Тексты без слов «титул», «УИД», «эмулятор» (критерий из docs/scenariy-demo.md).

export const ROLE_TITLE: Record<Role, string> = {
  shipper: 'Отправитель',
  carrier: 'Перевозчик',
  driver: 'Водитель',
  consignee: 'Получатель',
}

/** Коды нажатий. Кнопка несёт только код и параметр — права проверяем по тому, кто нажал. */
export const P = {
  root: 'root',
  help: 'help',
  open: (r: Role) => `open:${r}`,
  add: (r: Role) => `add:${r}`,
  company: 'company',
  stub: (code: string) => `stub:${code}`,
  back: 'f:back',
  toMenu: 'f:menu',
  yes: 'f:yes',
  no: 'f:no',
  later: 'f:later',
  erp: 'f:erp',
  acceptOnly: 'f:accept_only',
  acceptSign: 'f:accept_sign',
  otherInn: 'f:other_inn',
} as const

export const cb = (text: string, payload: string): Button => ({ text, kind: 'callback', payload })

export const roleLabel = (r: RoleInfo) =>
  r.role === 'driver' && !r.org ? `${ROLE_TITLE.driver} · без перевозчика` : `${ROLE_TITLE[r.role]}${r.org ? ` · ${r.org.name}` : ''}`

export function rootMenu(roles: RoleInfo[], active: Role | null, note?: string): OutMessage {
  const lines = ['<b>Накладная в кармане</b>']
  if (note) lines.push('', note)
  const missing = ROLES.filter((r) => !roles.some((x) => x.role === r))
  const buttons: Button[][] = []
  if (roles.length) {
    lines.push('', 'Выберите, от лица какой роли работать сейчас.')
    for (const r of roles) buttons.push([cb(`${r.role === active ? '✓ ' : ''}${roleLabel(r)}`, P.open(r.role))])
  } else {
    lines.push(
      '',
      'Бот ведёт электронную транспортную накладную от отгрузки до приёмки груза.',
      'Кто вы в перевозке? Роль можно добавить потом, прежние роли не пропадут.',
    )
  }
  if (missing.length) {
    if (roles.length) lines.push('', 'Добавить роль:')
    for (let i = 0; i < missing.length; i += 2) buttons.push(missing.slice(i, i + 2).map((r) => cb(`+ ${ROLE_TITLE[r]}`, P.add(r))))
  }
  buttons.push([cb('Помощь', P.help)])
  return { text: lines.join('\n'), buttons }
}

const switchRole = [cb('Сменить роль', P.root)]

export function roleMenu(r: RoleInfo, extra: { erpShipments?: number; note?: string } = {}): OutMessage {
  const head = [`<b>${esc(roleLabel(r))}</b>`]
  if (extra.note) head.push('', extra.note)
  const stub = (text: string, code: string) => [cb(text, P.stub(code))]
  switch (r.role) {
    case 'shipper':
      return {
        text: [...head, '', 'Ждут вас: 0'].join('\n'),
        buttons: [
          stub('Ждут меня', 'shipper.waiting'),
          stub(`Отгрузки${extra.erpShipments ? ` (${extra.erpShipments})` : ''}`, 'shipper.shipments'),
          stub('В пути', 'shipper.transit'),
          [cb('Компания', P.company)],
          switchRole,
        ],
      }
    case 'carrier':
      return {
        text: [...head, '', 'Ждут вас: 0'].join('\n'),
        buttons: [
          stub('Ждут меня', 'carrier.waiting'),
          stub('Новые заявки', 'carrier.offers'),
          stub('Мои рейсы', 'carrier.trips'),
          stub('Машины и водители', 'carrier.fleet'),
          [cb('Компания', P.company)],
          switchRole,
        ],
      }
    case 'driver':
      return {
        text: [
          ...head,
          '',
          r.org
            ? 'Рейсов пока нет.'
            : 'Чтобы получить рейс, попросите диспетчера перевозчика назначить вас: он перешлёт боту ваш контакт.',
        ].join('\n'),
        buttons: [stub('Открыть рейс', 'driver.trip'), stub('QR-код', 'driver.qr'), stub('Мои рейсы', 'driver.trips'), switchRole],
      }
    case 'consignee':
      return {
        text: [...head, '', 'Ждут вас: 0'].join('\n'),
        buttons: [stub('Ко мне едут', 'consignee.incoming'), stub('Приёмка', 'consignee.receiving'), [cb('Компания', P.company)], switchRole],
      }
  }
}

const fmtDate = (d: Date) => d.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' })

export function companyScreen(r: RoleInfo): OutMessage {
  const o = r.org
  const lines = [`<b>${esc(roleLabel(r))}</b>`, '']
  if (o) {
    lines.push(esc(o.name), `ИНН ${o.inn}${o.kpp ? `, КПП ${o.kpp}` : ''}`, esc(o.address))
    if (!o.verified) lines.push('<i>Реквизиты введены вручную и не проверены по справочнику.</i>')
    if (r.role === 'shipper') lines.push('', `Учётная система: ${o.erpKind ? 'подключена (модель)' : 'не подключена'}`)
  }
  lines.push('', r.isAdmin ? 'Вы администратор компании в этой роли.' : 'Вы сотрудник компании в этой роли.')
  if (r.role !== 'driver') {
    lines.push(
      r.canSign
        ? r.poaNumber
          ? `Доверенность ${esc(r.poaNumber)}${r.poaValidTo ? ` до ${fmtDate(r.poaValidTo)}` : ''}.`
          : 'Доверенность не указана — спросим перед первой подписью.'
        : 'Вы принимаете груз, подписывает другой сотрудник.',
    )
  }
  return { text: lines.join('\n'), buttons: [[cb('Назад', P.open(r.role))]] }
}

export const helpScreen: OutMessage = {
  text: [
    '<b>Как пользоваться</b>',
    '',
    'Бот ведёт одну перевозку от отгрузки до приёмки: каждый получает свой шаг в этом чате.',
    '',
    '• Меню ролей — команда /menu или кнопка «Сменить роль».',
    '• Одному человеку можно завести несколько ролей: у каждой своя компания.',
    '• Когда подходит ваш ход, бот пришлёт сообщение, какая бы роль ни была выбрана.',
    '',
    '<i>Оператор ЭПД, ГИС ЭПД и справочник организаций в этой версии — модели.</i>',
  ].join('\n'),
  buttons: [[cb('В меню', P.root)]],
}
