import type { ErpShipment, OrgDirectory } from '@nk/domain'
import type { FastifyBaseLogger } from 'fastify'
import { esc } from '../max/messenger.ts'
import type { MaxAttachment } from '../max/types.ts'
import type { MockErp } from '../adapters/mock-erp.ts'
import { ImportFileError, buildWorkbook, checkRows, readWorkbook, type ImportCheck, type ImportIssue } from '../core/erp-import.ts'
import { P, S, cb } from './screens.ts'
import type { Reply, Ui } from './shipment-flows.ts'
import type { BotStore, DialogState, PersonRow } from './store.ts'
import type { Messenger } from '@nk/domain'

// Новые отгрузки из Excel (HAKATON-46): шаблон → заполненный файл → «что понял» → «Загрузить».
// Отгрузки пишутся в модель учётной системы, дальше всё как с отгрузками из демо-данных.

const WAIT = 'import:wait'
const READY = 'import:ready'
const TEMPLATE_NAME = 'otgruzki-shablon.xlsx'
const SHOW = 10

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
const issue = (i: ImportIssue) => `• ${i.row ? `строка ${i.row}` : 'файл'}${i.ref ? `, ${esc(i.ref)}` : ''}: ${esc(i.text)}`
const cancelRow = [cb('Отмена', P.open('shipper'))]

export class ImportFlows {
  constructor(
    private readonly store: BotStore,
    private readonly erp: MockErp,
    private readonly directory: OrgDirectory,
    private readonly messenger: Messenger,
    private readonly ui: Ui,
    private readonly log: FastifyBaseLogger,
    private readonly fetchFn?: typeof fetch,
  ) {}

  async onButton(p: PersonRow, payload: string, to: Reply): Promise<boolean> {
    if (payload === S.importStart) return this.start(p, to).then(() => true)
    if (payload === S.importConfirm) return this.confirm(p, to).then(() => true)
    return false
  }

  private async shipperOrg(p: PersonRow) {
    return (await this.store.roles(p.id)).find((x) => x.role === 'shipper')?.org ?? null
  }

  private async start(p: PersonRow, to: Reply) {
    const o = await this.shipperOrg(p)
    if (!o) return this.ui.notify(to, 'Сначала подключите компанию-отправителя')
    await this.store.setDialog(p.id, { step: WAIT, context: {} })
    await this.ui.reply(to, {
      text: [
        '<b>Новые отгрузки из Excel</b> (модель учётной системы)',
        '',
        '1. Откройте шаблон ниже и заполните: одна строка — одна позиция груза, позиции одной отгрузки — с одинаковым номером.',
        '2. Дату, ИНН получателя и адреса достаточно указать в первой строке отгрузки. Название и адрес получателя найдём по ИНН.',
        '3. Пришлите заполненный файл сюда. Я покажу, что понял, и загружу только после вашего «Загрузить».',
      ].join('\n'),
      buttons: [cancelRow],
    })
    await this.messenger.send(p.maxUserId, { text: 'Шаблон отгрузок', file: { name: TEMPLATE_NAME, bytes: await buildWorkbook() } })
  }

  /** Файл пришёл, пока ждём таблицу. false — файл не наш, пусть разбирают другие. */
  async onFiles(p: PersonRow, d: DialogState, files: MaxAttachment[], to: Reply): Promise<boolean> {
    if (d.step !== WAIT && d.step !== READY) return false
    const o = await this.shipperOrg(p)
    if (!o) return false
    const file = files.find((f) => /\.xlsx$/i.test(f.filename ?? '')) ?? files[0]!
    if (file.filename && !/\.xlsx$/i.test(file.filename)) {
      await this.ui.reply(to, { text: `Файл «${esc(file.filename)}» — не таблица Excel. Нужен .xlsx: сохраните таблицу как «Книга Excel» и пришлите ещё раз.`, buttons: [cancelRow] })
      return true
    }

    let check: ImportCheck
    try {
      const rows = await readWorkbook(await this.download(file.payload!.url!))
      check = await checkRows(rows, {
        shipperInn: o.inn,
        defaultLoadingAddress: o.address,
        directory: this.directory,
        existing: (refs) => this.erp.existing(o.inn, refs),
      })
    } catch (err) {
      if (!(err instanceof ImportFileError)) this.log.warn({ err }, 'не удалось разобрать таблицу отгрузок')
      await this.store.setDialog(p.id, { step: WAIT, context: {} })
      await this.ui.reply(to, { text: err instanceof ImportFileError ? err.message : 'Не получилось прочитать файл. Попробуйте ещё раз или возьмите шаблон заново.', buttons: [[cb('Шаблон заново', S.importStart)], cancelRow] })
      return true
    }

    const lines: string[] = []
    const { shipments, errors, warnings } = check
    if (errors.length) {
      lines.push(`<b>В таблице ${errors.length} ${plural(errors.length, 'ошибка', 'ошибки', 'ошибок')}</b> — пока ничего не загрузил.`, '')
      lines.push(...errors.slice(0, 15).map(issue))
      if (errors.length > 15) lines.push(`• и ещё ${errors.length - 15}`)
      lines.push('', 'Исправьте и пришлите файл ещё раз.')
      await this.store.setDialog(p.id, { step: WAIT, context: {} })
      await this.ui.reply(to, { text: lines.join('\n'), buttons: [cancelRow] })
      return true
    }

    lines.push(`<b>Понял ${shipments.length} ${plural(shipments.length, 'отгрузку', 'отгрузки', 'отгрузок')}</b>, всего позиций: ${shipments.reduce((s, x) => s + x.lines.length, 0)}.`, '')
    for (const s of shipments.slice(0, SHOW))
      lines.push(`• <b>${esc(s.ref)}</b> · ${esc(s.consignee.name)}${s.consigneeChecked ? '' : ' (не проверено)'} · ${fmtDate(s.plannedLoadingAt)} · ${s.lines.length} поз., ${s.places} мест, ${fmtKg(s.grossKg)}`)
    if (shipments.length > SHOW) lines.push(`• и ещё ${shipments.length - SHOW}`)
    if (warnings.length) {
      lines.push('', '<b>Обратите внимание:</b>', ...warnings.slice(0, 10).map(issue))
      if (warnings.length > 10) lines.push(`• и ещё ${warnings.length - 10}`)
    }
    lines.push('', 'Загрузить в учётную систему?')
    const payload: ErpShipment[] = shipments.map(({ rows: _r, consigneeChecked: _c, ...s }) => s)
    await this.store.setDialog(p.id, { step: READY, context: { inn: o.inn, shipments: payload } })
    await this.ui.reply(to, { text: lines.join('\n'), buttons: [[cb(`Загрузить ${shipments.length}`, S.importConfirm)], cancelRow] })
    return true
  }

  private async confirm(p: PersonRow, to: Reply) {
    const d = await this.store.getDialog(p.id)
    const o = await this.shipperOrg(p)
    const ctx = d?.context as { inn?: string; shipments?: ErpShipment[] } | undefined
    if (d?.step !== READY || !o || ctx?.inn !== o.inn || !ctx.shipments?.length)
      return this.ui.reply(to, { text: 'Проверка устарела — пришлите файл ещё раз.', buttons: [[cb('Загрузить из Excel', S.importStart)], cancelRow] })
    let res: { added: number; replaced: number }
    try {
      res = await this.erp.importShipments(ctx.shipments)
    } catch (err) {
      this.log.warn({ err }, 'загрузка отгрузок не прошла')
      await this.store.setDialog(p.id, { step: WAIT, context: {} })
      return this.ui.reply(to, { text: 'Пока вы смотрели, часть отгрузок уже открыли в боте. Пришлите файл ещё раз — я проверю заново.', buttons: [cancelRow] })
    }
    await this.store.clearDialog(p.id)
    const parts = [res.added ? `новых — ${res.added}` : '', res.replaced ? `заменено — ${res.replaced}` : ''].filter(Boolean).join(', ')
    return this.ui.reply(to, {
      text: `✅ <b>Отгрузки загружены</b> в учётную систему (модель): ${parts}.\nОни уже в списке «Отгрузки» — откройте нужную и назначьте перевозчика.`,
      buttons: [[cb('Отгрузки', S.list(0))], [cb('В меню', P.open('shipper'))]],
    })
  }

  private async download(url: string): Promise<Uint8Array> {
    const res = await (this.fetchFn ?? fetch)(url, { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) throw new Error(`не скачать таблицу: ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }
}

function plural(n: number, one: string, few: string, many: string) {
  const a = n % 100
  const b = n % 10
  if (a >= 11 && a <= 14) return many
  return b === 1 ? one : b >= 2 && b <= 4 ? few : many
}
const fmtKg = (kg: number) => `${kg.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} кг`
