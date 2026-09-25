import type { Command, Messenger, Role, SignatureProvider, TitleKind } from '@nk/domain'
import type { FastifyBaseLogger } from 'fastify'
import { DemoSignError } from '../core/demo-signer.ts'
import type { ShipmentService } from '../core/shipments.ts'
import type { SignatureService, SignatureVerifier } from '../core/signatures.ts'
import { TitleError, type TitleService } from '../core/titles.ts'
import { esc } from '../max/messenger.ts'
import type { MaxAttachment } from '../max/types.ts'
import { S, cb } from './screens.ts'
import type { Reply, ShipmentFlows, Ui } from './shipment-flows.ts'
import type { BotStore, DialogState, PersonRow } from './store.ts'

// Подпись титула в чате (HAKATON-36, HAKATON-41):
// «Подписать накладную» → бот присылает XML титула → человек пересылает его в @goskey_bot,
// подписывает в «Госключе» и пересылает ответ боту → бот отдаёт файл подписи на проверку
// вместе с байтами титула и ИНН компании → проверено — подпись записана, перевозка идёт дальше.
// Пока проверка «Госключа» не подключена или у проверяющего нет «Госключа» — демо-подпись (модель).

export const SIGN: Partial<Record<TitleKind, { role: Role; command: Command['type']; who: string }>> = {
  T1: { role: 'shipper', command: 'shipper.signT1', who: 'отправителя' },
  T2: { role: 'carrier', command: 'carrier.signT2', who: 'перевозчика' },
  T3: { role: 'consignee', command: 'consignee.signT3', who: 'получателя' },
  T4: { role: 'carrier', command: 'carrier.signT4', who: 'перевозчика о выдаче груза' },
}

const GOSKEY_BOT = 'https://max.ru/goskey_bot'

/** Вложения-файлы сообщения: свои и пересланные (ответ @goskey_bot обычно пересылают). */
export function fileAttachments(message: { body: { attachments?: MaxAttachment[] | null }; link?: { message?: { attachments?: MaxAttachment[] } } | null }) {
  return [...(message.body.attachments ?? []), ...(message.link?.message?.attachments ?? [])].filter((a) => a.type === 'file' && a.payload?.url)
}

export class SignFlows {
  constructor(
    private readonly store: BotStore,
    private readonly shipments: ShipmentService,
    private readonly titles: TitleService,
    private readonly signatures: SignatureService,
    private readonly verifier: SignatureVerifier | null,
    /** демо-подпись организации (модель); null — на сервере нет движка ГОСТ */
    private readonly demoSigner: SignatureProvider | null,
    private readonly messenger: Messenger,
    private readonly flows: ShipmentFlows,
    private readonly ui: Ui,
    private readonly askPhone: (p: PersonRow, pending: Record<string, unknown>, to: Reply) => Promise<void>,
    private readonly log: FastifyBaseLogger,
    private readonly fetchFn?: typeof fetch,
  ) {}

  async onButton(p: PersonRow, payload: string, to: Reply): Promise<boolean> {
    const [kind, titleKind, shipmentId] = payload.split(':') as [string, TitleKind, string]
    if (kind === 'sg') await this.start(p, titleKind, shipmentId, to)
    else if (kind === 'sgd') await this.demo(p, titleKind, shipmentId, to)
    else return false
    return true
  }

  /** Отправить титул на подпись. */
  async start(p: PersonRow, kind: TitleKind, shipmentId: string, to: Reply) {
    const spec = SIGN[kind]
    if (!spec) return this.ui.notify(to, 'Этот титул пока подписывается позже')
    if (!(await this.shipments.rolesIn(shipmentId, p.id)).includes(spec.role)) return this.ui.notify(to, 'Подписывает другая сторона')
    // Номер подписанта идёт в накладную и в доказательства — сначала он
    if (!p.phone) return this.askPhone(p, { kind: 'sign', title: kind, shipmentId }, to)

    let t
    try {
      t = await this.titles.ensure(shipmentId, kind)
    } catch (err) {
      if (err instanceof TitleError) return this.ui.reply(to, { text: `Накладную пока не собрать: ${esc(err.message)}.`, buttons: [[cb('К перевозке', S.view(shipmentId))]] })
      throw err
    }
    const view = await this.shipments.view(shipmentId, spec.role)
    await this.messenger.send(p.maxUserId, { text: `Накладная ${esc(view?.erpRef ?? '')}, титул ${spec.who}`, file: { name: `${t.fileId}.xml`, bytes: t.bytes } })
    await this.store.setDialog(p.id, { step: 'await:sig', context: { shipmentId, kind, titleId: t.id, sentAt: new Date().toISOString() } })
    await this.ui.reply(to, {
      text: [
        `<b>Подпишите накладную ${esc(view?.erpRef ?? '')}</b>`,
        '',
        '1. Перешлите файл выше в бот «Госключа».',
        '2. Выберите подпись и подтвердите её в приложении «Госключ».',
        '3. Перешлите сюда ответ «Госключа» с файлом подписи.',
        '',
        'Проверим подпись и сверим ИНН компании. <i>Нет «Госключа»? Для проверки есть демо-подпись — она помечена как модель.</i>',
      ].join('\n'),
      buttons: [
        [{ text: 'Открыть «Госключ» в MAX', kind: 'link', payload: GOSKEY_BOT }],
        [cb('Демо-подпись (модель)', `sgd:${kind}:${shipmentId}`)],
        [cb('Отмена', S.view(shipmentId))],
      ],
    })
  }

  /** Пришёл файл, пока ждём подпись. */
  async onFiles(p: PersonRow, d: DialogState, files: MaxAttachment[], to: Reply): Promise<boolean> {
    if (d.step !== 'await:sig') return false
    const { shipmentId, kind, sentAt } = d.context as { shipmentId: string; kind: TitleKind; sentAt: string }
    const spec = SIGN[kind]!
    const t = await this.titles.get(shipmentId, kind)
    if (!t) return this.ui.reply(to, { text: 'Титул не найден — начните подпись заново.' }).then(() => true)

    // Файл подписи: .sig или .p7s; если имени нет — любой файл, кроме нашего XML
    const pick = files.find((f) => /\.(sig|p7s)$/i.test(f.filename ?? '')) ?? files.find((f) => !/\.xml$/i.test(f.filename ?? ''))
    if (!pick) return this.ui.reply(to, { text: 'Это наш файл накладной, а нужен файл подписи из «Госключа» (.sig). Перешлите ответ «Госключа» целиком.' }).then(() => true)
    if (!this.verifier) {
      await this.ui.reply(to, {
        text: 'Проверка подписи «Госключа» подключается. Пока подпишите демо-подписью — она помечена как модель.',
        buttons: [[cb('Демо-подпись (модель)', `sgd:${kind}:${shipmentId}`)]],
      })
      return true
    }

    const sig = await this.download(pick.payload!.url!)
    const org = (await this.store.roles(p.id)).find((r) => r.role === spec.role)?.org
    const view = await this.shipments.view(shipmentId, spec.role)
    const expectedInn = ({ shipper: view?.shipper.inn, carrier: view?.carrier?.inn, consignee: view?.consignee.inn, driver: undefined })[spec.role] ?? org?.inn ?? ''
    const res = await this.verifier.verify({ document: t.bytes, sig, expectedInn, declaredInn: org?.inn ?? null, sentAt: new Date(sentAt) })
    if (!res.ok) {
      const why = res.checks.filter((c) => !c.ok).map((c) => `• ${esc(c.message)}`)
      await this.ui.reply(to, {
        text: ['<b>Подпись не прошла проверку</b>', '', ...why, '', 'Подпишите файл накладной из этого чата ещё раз и перешлите ответ «Госключа».'].join('\n'),
        buttons: [[cb('Прислать файл заново', `sg:${kind}:${shipmentId}`)]],
      })
      return true
    }

    const signatureId = await this.signatures.record({
      shipmentId,
      titleId: t.id,
      titleKind: kind,
      role: spec.role,
      kind: 'goskey',
      personId: p.id,
      cms: sig,
      signerName: res.signer?.fullName ?? null,
      signerSnils: res.signer?.snils ?? null,
      verified: true,
      verifyResult: `«Госключ», ${res.level === 'ukep' ? 'УКЭП' : 'УНЭП'}: ${res.checks.map((c) => `${c.name} ok`).join(', ')}`,
    })
    await this.store.clearDialog(p.id)
    await this.flows.run(p, { type: spec.command, shipmentId, payload: { signatureId } } as Command, to)
    return true
  }

  /** Демо-подпись: для проверяющих без «Госключа». Помечена как модель в подписи и в журнале. */
  private async demo(p: PersonRow, kind: TitleKind, shipmentId: string, to: Reply) {
    const spec = SIGN[kind]
    if (!spec) return this.ui.notify(to, 'Этот титул пока подписывается позже')
    if (!(await this.shipments.rolesIn(shipmentId, p.id)).includes(spec.role)) return this.ui.notify(to, 'Подписывает другая сторона')
    if (!this.demoSigner) return this.ui.notify(to, 'Демо-подпись недоступна: на сервере нет движка ГОСТ')
    let signatureId: string
    try {
      const req = await this.demoSigner.request(shipmentId, kind, p.id, spec.role)
      signatureId = (await this.demoSigner.accept(req.titleId, p.id, spec.role, null)).id
    } catch (err) {
      if (err instanceof TitleError) return this.ui.notify(to, `Накладную пока не собрать: ${err.message}`)
      if (err instanceof DemoSignError) return this.ui.notify(to, `Не удалось подписать: ${err.message}`)
      throw err
    }
    await this.store.clearDialog(p.id)
    await this.flows.run(p, { type: spec.command, shipmentId, payload: { signatureId } } as Command, to)
  }

  private async download(url: string): Promise<Uint8Array> {
    const res = await (this.fetchFn ?? fetch)(url, { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) throw new Error(`не скачать файл подписи: ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }
}
