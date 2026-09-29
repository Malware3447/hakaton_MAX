import type { TitleKind } from '@nk/domain'
import type { FastifyBaseLogger } from 'fastify'
import type { AddResult, PoaService } from '../core/poa.ts'
import { esc } from '../max/messenger.ts'
import type { MaxAttachment } from '../max/types.ts'
import { cb } from './screens.ts'
import type { Reply, Ui } from './shipment-flows.ts'
import type { BotStore, DialogState, PersonRow } from './store.ts'

// МЧД в чате (HAKATON-49): «кто подписывает за компанию» и доверенность сотрудника.
// Спрашиваем после анкеты роли и перед подписью, если доверенности нет или она кончилась.
// Способы: прислать файл МЧД (XML из реестра ФНС, можно вместе с .sig руководителя) или номер и две даты.

export const PA = {
  head: (m: string) => `pa:h:${m}`,
  employee: (m: string) => `pa:e:${m}`,
  later: 'pa:later',
  manual: 'pa:manual',
} as const

/** Что сделать, когда доверенность добавлена или выбран «руководитель»: продолжить подпись. */
export interface PoaThen {
  kind: 'sign'
  title: TitleKind
  shipmentId: string
}

interface Ctx {
  membershipId: string
  then?: PoaThen | null
  number?: string
  issuedAt?: string
}

const STEP = { wait: 'poa:wait', number: 'poa:number', issued: 'poa:issued', valid: 'poa:valid' } as const

const HOW = [
  'Пришлите сюда файл доверенности — XML из реестра ФНС (m4d.nalog.gov.ru или ваша система ЭДО). Можно вместе с файлом подписи руководителя (.sig) — тогда проверим и её.',
  '',
  'Нет файла под рукой — нажмите «Ввести номер» и укажите номер доверенности и две даты.',
].join('\n')

export class PoaFlows {
  constructor(
    private readonly store: BotStore,
    private readonly poas: PoaService,
    private readonly ui: Ui,
    private readonly resume: (p: PersonRow, then: PoaThen, to: Reply) => Promise<unknown>,
    private readonly log: FastifyBaseLogger,
    private readonly fetchFn?: typeof fetch,
  ) {}

  /** Спросить, кто подписывает за компанию: руководитель (или ИП) без доверенности или сотрудник по МЧД. */
  async askKind(p: PersonRow, membershipId: string, text: string, then: PoaThen | null, to: Reply) {
    await this.store.setDialog(p.id, { step: STEP.wait, context: { membershipId, then } })
    return this.ui.reply(to, {
      text: [
        text,
        '',
        'Руководитель компании или ИП подписывает сам. Сотрудник — только по машиночитаемой доверенности (МЧД) от компании: одной подписи мало.',
      ].join('\n'),
      buttons: [[cb('Я руководитель или ИП', PA.head(membershipId))], [cb('Я сотрудник, по доверенности', PA.employee(membershipId))]],
    })
  }

  /** Попросить доверенность. then — продолжить подпись, когда доверенность примем. */
  async ask(p: PersonRow, membershipId: string, then: PoaThen | null, to: Reply, reason?: string) {
    await this.store.setDialog(p.id, { step: STEP.wait, context: { membershipId, then } })
    return this.ui.reply(to, {
      text: [reason ? `<b>${esc(reason)}</b>` : '<b>Машиночитаемая доверенность</b>', '', HOW].join('\n'),
      buttons: [[cb('Ввести номер', PA.manual)], ...(then ? [] : [[cb('Позже — спросите перед подписью', PA.later)]])],
    })
  }

  async onButton(p: PersonRow, payload: string, to: Reply): Promise<boolean> {
    if (!payload.startsWith('pa:')) return false
    const d = await this.store.getDialog(p.id)
    const ctx = (d?.step.startsWith('poa:') ? d.context : null) as Ctx | null
    const [, kind, membershipId] = payload.split(':')
    if (kind === 'h' || kind === 'e') {
      // membershipId из кнопки: роль известна и без диалога (кнопка могла остаться в старом сообщении)
      await this.poas.setSignerKind(membershipId!, kind === 'h' ? 'head' : 'employee')
      if (kind === 'h') {
        await this.store.clearDialog(p.id)
        await this.ui.reply(to, { text: 'Записали: вы подписываете за компанию сами, доверенность не нужна.' })
        if (ctx?.then) await this.resume(p, ctx.then, { kind: 'message', userId: p.maxUserId })
        return true
      }
      const cur = await this.poas.current(membershipId!)
      if (cur && cur.validTo.getTime() >= Date.now() - 86_400_000) {
        await this.store.clearDialog(p.id)
        await this.ui.reply(to, { text: `Записали: вы подписываете по доверенности ${esc(cur.number)} до ${cur.validTo.toLocaleDateString('ru-RU')}.` })
        if (ctx?.then) await this.resume(p, ctx.then, { kind: 'message', userId: p.maxUserId })
        return true
      }
      await this.ask(p, membershipId!, ctx?.then ?? null, to)
      return true
    }
    if (!ctx) {
      await this.ui.notify(to, 'Это сообщение устарело')
      return true
    }
    if (kind === 'later') {
      await this.store.clearDialog(p.id)
      await this.ui.reply(to, { text: 'Хорошо. Перед первой подписью за компанию попросим доверенность снова.' })
      return true
    }
    if (kind === 'manual') {
      await this.store.setDialog(p.id, { step: STEP.number, context: { ...ctx } })
      await this.ui.reply(to, { text: 'Номер доверенности из реестра ФНС — вида 4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f.' })
      return true
    }
    return false
  }

  async onText(p: PersonRow, d: DialogState, text: string, to: Reply): Promise<boolean> {
    if (!d.step.startsWith('poa:')) return false
    const ctx = d.context as unknown as Ctx
    if (d.step === STEP.wait) {
      // Прислали номер текстом, не нажимая «Ввести номер» — тоже годится
      if (/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(text)) return this.gotNumber(p, ctx, text, to)
      await this.ui.reply(to, { text: 'Жду файл доверенности (XML) или её номер.', buttons: [[cb('Ввести номер', PA.manual)]] })
      return true
    }
    if (d.step === STEP.number) return this.gotNumber(p, ctx, text, to)
    const date = parseRuDate(text)
    if (!date) {
      await this.ui.reply(to, { text: 'Такой даты нет — формат ДД.ММ.ГГГГ, например 01.09.2026.' })
      return true
    }
    if (d.step === STEP.issued) {
      await this.store.setDialog(p.id, { step: STEP.valid, context: { ...ctx, issuedAt: date.toISOString() } })
      await this.ui.reply(to, { text: 'До какого числа действует доверенность? Например, 31.10.2026' })
      return true
    }
    // STEP.valid
    const res = await this.poas.addManual({ membershipId: ctx.membershipId, number: ctx.number!, issuedAt: new Date(ctx.issuedAt!), validTo: date })
    return this.done(p, ctx, res, to)
  }

  async onFiles(p: PersonRow, d: DialogState, files: MaxAttachment[], to: Reply): Promise<boolean> {
    if (!d.step.startsWith('poa:')) return false
    const ctx = d.context as unknown as Ctx
    const xml = files.find((f) => /\.xml$/i.test(f.filename ?? '')) ?? files.find((f) => !/\.(sig|p7s)$/i.test(f.filename ?? ''))
    const sigFile = files.find((f) => /\.(sig|p7s)$/i.test(f.filename ?? ''))
    if (!xml) {
      await this.ui.reply(to, { text: 'Это файл подписи. Пришлите сам файл доверенности (XML) — можно вместе с подписью, одним сообщением.' })
      return true
    }
    let file: Uint8Array
    let sig: Uint8Array | null = null
    try {
      file = await this.download(xml.payload!.url!)
      if (sigFile) sig = await this.download(sigFile.payload!.url!)
    } catch (err) {
      this.log.warn({ err }, 'не скачать файл доверенности')
      await this.ui.reply(to, { text: 'Не удалось скачать файл. Пришлите его ещё раз.' })
      return true
    }
    const res = await this.poas.addFromFile({ membershipId: ctx.membershipId, file, sig })
    return this.done(p, ctx, res, to)
  }

  private async gotNumber(p: PersonRow, ctx: Ctx, text: string, to: Reply) {
    const number = text.trim().toLowerCase()
    if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/.test(number)) {
      await this.ui.reply(to, { text: 'Номер доверенности из реестра ФНС выглядит так: 4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f. Он есть в самой доверенности и в личном кабинете, где её выпускали.' })
      return true
    }
    await this.store.setDialog(p.id, { step: STEP.issued, context: { ...ctx, number } })
    await this.ui.reply(to, { text: 'Дата выдачи доверенности? Например, 01.09.2026' })
    return true
  }

  private async done(p: PersonRow, ctx: Ctx, res: AddResult, to: Reply) {
    const notes = res.checks.filter((c) => c.level === 'warning').map((c) => `• ${esc(c.message)}`)
    if (!res.ok) {
      const bad = res.checks.filter((c) => !c.ok).map((c) => `• ${esc(c.message)}`)
      await this.store.setDialog(p.id, { step: STEP.wait, context: { membershipId: ctx.membershipId, then: ctx.then ?? null } })
      await this.ui.reply(to, {
        text: ['<b>Доверенность не принята</b>', '', ...bad, '', 'Пришлите другую доверенность или исправьте данные.'].join('\n'),
        buttons: [[cb('Ввести номер', PA.manual)]],
      })
      return true
    }
    const poa = res.poa!
    await this.store.clearDialog(p.id)
    const how = poa.source === 'file' ? (poa.signatureOk ? 'файл и подпись руководителя проверены' : 'файл проверен, подпись руководителя не присылали') : 'введена вручную'
    await this.ui.reply(to, {
      text: [
        `✅ <b>Доверенность принята</b>: ${esc(poa.number)}, действует до ${poa.validTo.toLocaleDateString('ru-RU')} (${how}).`,
        ...(notes.length ? ['', ...notes] : []),
        '',
        '<i>Статус в реестре ФНС не проверен: реестр недоступен с нашего сервера (модель).</i>',
      ].join('\n'),
    })
    if (ctx.then) await this.resume(p, ctx.then, { kind: 'message', userId: p.maxUserId })
    return true
  }

  private async download(url: string): Promise<Uint8Array> {
    const res = await (this.fetchFn ?? fetch)(url, { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) throw new Error(`не скачать файл: ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }
}

/** ДД.ММ.ГГГГ → полдень UTC этого дня (дата не съезжает при переводе в Москву). */
function parseRuDate(s: string): Date | null {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s.trim())
  if (!m) return null
  const d = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 12))
  return d.getUTCDate() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 ? d : null
}

