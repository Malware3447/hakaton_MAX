import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { TITLE_KINDS, type TitleKind } from '@nk/domain'
import { decode1251 } from '@nk/etrn'
import type { Db } from '../db/client.ts'
import { event, mockEpdDocument, mockEpdSettings, mockEpdTitle, shipment, signature } from '../db/schema.ts'
import { qrGif } from './qr-gif.ts'
import type { ExecResult, ShipmentService } from './shipments.ts'
import type { TitleService } from './titles.ts'

// Модель оператора ЭПД и ГИС ЭПД (HAKATON-39), везде помечена «модель».
// Порядок подтверждён схемами ФНС: номер накладной (УИД) нужен уже в Т2, поэтому оператор
// выдаёт его в ответ на Т1; после Т2 — регистрация в ГИС ЭПД и QR-код водителю.
// Ответы не мгновенные: регистрация и QR — отложенные шаги очереди, они переживают перезапуск.
// Сбои включаются ручками в mock.epd_settings (демо-пульт, HAKATON-32) без перезапуска,
// и после любого из них сценарий продолжается.

/** Ручки сбоев модели. Отказы срабатывают один раз и сами выключаются. */
export interface OperatorFaults {
  /** оператор недоступен до этого момента (ISO): титулы примутся, когда он «вернётся» */
  unavailableUntil: string | null
  /** отказ оператора в Т2 — перевозчику нужно подписать Т2 заново */
  rejectT2: { code: string; message: string } | null
  /** ошибка ГИС ЭПД при регистрации — тоже возврат к подписи Т2 */
  gisError: { code: string; message: string } | null
  /** через сколько секунд после Т2 приходит регистрация */
  registerDelayS: number
  /** через сколько секунд после регистрации водитель получает QR */
  qrDelayS: number
}

export const DEFAULT_FAULTS: OperatorFaults = { unavailableUntil: null, rejectT2: null, gisError: null, registerDelayS: 3, qrDelayS: 0 }

const FAULTS_KEY = 'faults'

/** Отложенные шаги модели: регистрация Т2, QR водителю, повтор приёма титула после недоступности. */
export type OperatorTask = 'operator.register' | 'operator.qr' | 'operator.submit'

/** У демо-подписи CMS нет — в хранилище оператора та же метка, что уходит в атрибут ЭП титулов. */
const DEMO_SIGNATURE = Buffer.from('DEMO-SIGNATURE-MODEL')

/** В каком атрибуте титул ссылается на ИдФайл предыдущего (формат ФНС 5.01). */
const PREV_FILE_ATTR: Record<Exclude<TitleKind, 'T1'>, string> = { T2: 'ИдФайлИнфГО', T3: 'ИдФайлИнфПрвПрием', T4: 'ИдФайлИнфГП' }

const prevKind = (kind: TitleKind): TitleKind | undefined => TITLE_KINDS[TITLE_KINDS.indexOf(kind) - 1]

export class MockOperator {
  constructor(
    private readonly db: Db,
    private readonly shipments: ShipmentService,
    private readonly titles: TitleService,
    private readonly out: {
      /** что сделать после перехода по ответу оператора: уведомления, карточки; reason — причина отказа */
      onTransition: (res: Extract<ExecResult, { ok: true }>, reason?: string) => Promise<unknown>
      /** отложить шаг (очередь later); в тестах можно выполнять сразу */
      later: (task: OperatorTask, shipmentId: string, delaySeconds: number, arg?: string) => Promise<unknown>
      /** отправить водителю файл QR-кода */
      sendQr: (shipmentId: string, file: { name: string; bytes: Uint8Array }) => Promise<unknown>
    },
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Выполнить отложенный шаг. */
  run(task: OperatorTask, shipmentId: string, arg?: string) {
    switch (task) {
      case 'operator.register':
        return this.register(shipmentId)
      case 'operator.qr':
        return this.deliverQr(shipmentId)
      case 'operator.submit':
        return this.submit(shipmentId, arg as TitleKind)
    }
  }

  // ---------- ручки сбоев ----------

  async faults(): Promise<OperatorFaults> {
    const [row] = await this.db.select().from(mockEpdSettings).where(eq(mockEpdSettings.key, FAULTS_KEY))
    return { ...DEFAULT_FAULTS, ...(row?.value as Partial<OperatorFaults> | undefined) }
  }

  async setFaults(patch: Partial<OperatorFaults>): Promise<OperatorFaults> {
    const value = { ...(await this.faults()), ...patch }
    await this.db.insert(mockEpdSettings).values({ key: FAULTS_KEY, value }).onConflictDoUpdate({ target: mockEpdSettings.key, set: { value } })
    return value
  }

  /** Оператор недоступен seconds секунд; 0 — снова доступен. */
  setUnavailable(seconds: number) {
    return this.setFaults({ unavailableUntil: seconds > 0 ? new Date(this.now().getTime() + seconds * 1000).toISOString() : null })
  }

  // ---------- приём титулов ----------

  /** Принять подписанный титул (последствие submitTitle). Повтор того же титула — без последствий. */
  async submit(shipmentId: string, kind: TitleKind) {
    const faults = await this.faults()
    const downMs = faults.unavailableUntil ? new Date(faults.unavailableUntil).getTime() - this.now().getTime() : 0
    if (downMs > 0) {
      // Как у настоящего оператора: титул уйдёт, когда он снова ответит
      const retryS = Math.ceil(downMs / 1000) + 1
      await this.journal(shipmentId, 'operator.unavailable', { title: kind, retryInS: retryS })
      await this.out.later('operator.submit', shipmentId, retryS, kind)
      return
    }

    const [s] = await this.db.select().from(shipment).where(eq(shipment.id, shipmentId))
    const t = await this.titles.get(shipmentId, kind)
    if (!s || !t) return

    let docId = s.operatorDocId
    const doc = docId ? await this.document(docId) : null
    const received = docId ? await this.db.select().from(mockEpdTitle).where(eq(mockEpdTitle.operatorDocId, docId)) : []

    // Повтор из очереди или двойное нажатие: титул уже у оператора. Т2 после отказа принимаем заново
    if (received.some((r) => r.kind === kind) && !(kind === 'T2' && doc?.status === 'rejected')) return

    const problem = this.checkOrder(kind, received, doc?.status ?? null) ?? this.checkChain(kind, t.bytes, received)
    if (problem) {
      // Это ошибка нашего же кода, а не демо-сбой: видна в журнале, сценарий не двигаем
      await this.journal(shipmentId, 'operator.error', { title: kind, message: problem })
      return
    }

    if (!docId) {
      docId = `op-${randomUUID()}`
      const uid = randomUUID()
      await this.db.insert(mockEpdDocument).values({ operatorDocId: docId, status: 'sent', uid })
      await this.db.update(shipment).set({ operatorDocId: docId, uid }).where(eq(shipment.id, shipmentId))
      await this.journal(shipmentId, 'operator.accepted', { uid })
    }
    const sigs = await this.db.select().from(signature).where(eq(signature.titleId, t.id))
    await this.db.insert(mockEpdTitle).values({
      operatorDocId: docId,
      kind,
      fileName: t.fileId,
      xml: Buffer.from(t.bytes),
      signatures: sigs.map((x) => Buffer.from(x.cms ?? DEMO_SIGNATURE).toString('base64')),
    })

    if (kind === 'T2') {
      await this.db.update(mockEpdDocument).set({ status: 'sent', rejectCode: null, rejectMessage: null }).where(eq(mockEpdDocument.operatorDocId, docId))
      await this.out.later('operator.register', shipmentId, faults.registerDelayS)
    }
  }

  /** Регистрация в ГИС ЭПД после Т2 (отложенный шаг). Здесь срабатывают отказ в Т2 и ошибка ГИС. */
  async register(shipmentId: string) {
    const [s] = await this.db.select().from(shipment).where(eq(shipment.id, shipmentId))
    if (!s?.operatorDocId || s.state !== 'registering') return
    const doc = await this.document(s.operatorDocId)
    if (!doc || doc.status !== 'sent') return

    const faults = await this.faults()
    const fail = faults.rejectT2
      ? { ...faults.rejectT2, off: { rejectT2: null }, reason: `Оператор ЭПД отклонил титул перевозчика (модель): ${faults.rejectT2.message}, код ${faults.rejectT2.code}` }
      : faults.gisError
        ? { ...faults.gisError, off: { gisError: null }, reason: `ГИС ЭПД не зарегистрировала накладную (модель): ${faults.gisError.message}, код ${faults.gisError.code}` }
        : null

    if (fail) {
      // Сбой одноразовый: следующая подпись Т2 пройдёт
      await this.setFaults(fail.off)
      await this.db
        .update(mockEpdDocument)
        .set({ status: 'rejected', rejectCode: fail.code, rejectMessage: fail.message })
        .where(eq(mockEpdDocument.operatorDocId, doc.operatorDocId))
      const res = await this.shipments.execute(
        { type: 'operator.rejected', shipmentId, payload: { operatorDocId: doc.operatorDocId, code: fail.code, message: fail.message } },
        { kind: 'operator' },
      )
      if (res.ok) await this.out.onTransition(res, fail.reason)
      return
    }

    await this.db.update(mockEpdDocument).set({ status: 'registered', registeredAt: this.now() }).where(eq(mockEpdDocument.operatorDocId, doc.operatorDocId))
    const res = await this.shipments.execute({ type: 'operator.registered', shipmentId, payload: { operatorDocId: doc.operatorDocId, uid: doc.uid! } }, { kind: 'operator' })
    if (res.ok) await this.out.onTransition(res)
  }

  // ---------- QR-код ----------

  /** Водителю нужен QR (последствие sendQrToDriver): сразу или с задержкой из ручки. */
  async qrRequested(shipmentId: string) {
    const { qrDelayS } = await this.faults()
    if (qrDelayS > 0) return this.out.later('operator.qr', shipmentId, qrDelayS)
    return this.deliverQr(shipmentId)
  }

  async deliverQr(shipmentId: string) {
    const [s] = await this.db.select().from(shipment).where(eq(shipment.id, shipmentId))
    if (!s?.operatorDocId) return
    await this.out.sendQr(shipmentId, { name: `QR-${s.erpRef}.gif`, bytes: await this.qr(s.operatorDocId) })
  }

  /** Анимированный GIF QR-кода; есть только после регистрации. */
  async qr(operatorDocId: string): Promise<Uint8Array> {
    const doc = await this.document(operatorDocId)
    if (doc?.status !== 'registered' || !doc.uid) throw new Error('накладная не зарегистрирована — QR-кода нет')
    const [s] = await this.db.select({ erpRef: shipment.erpRef }).from(shipment).where(eq(shipment.operatorDocId, operatorDocId))
    return qrGif({ uid: doc.uid, number: s?.erpRef ?? null, model: true })
  }

  // ---------- проверки ----------

  /** Титулы идут по порядку: Т2 после Т1, Т3 — только после регистрации, Т4 после Т3. */
  private checkOrder(kind: TitleKind, received: { kind: TitleKind }[], status: string | null): string | null {
    const prev = prevKind(kind)
    if (prev && !received.some((r) => r.kind === prev)) return `${kind} пришёл раньше ${prev}`
    if (kind === 'T3' && status !== 'registered') return 'Т3 до регистрации накладной в ГИС ЭПД'
    return null
  }

  /** Сцепка: титул ссылается на ИдФайл предыдущего и несёт одну из его подписей в атрибуте ЭП. */
  private checkChain(kind: TitleKind, xml: Uint8Array, received: { kind: TitleKind; fileName: string; signatures: string[] }[]): string | null {
    const prevK = prevKind(kind)
    if (!prevK) return null
    const prev = received.filter((r) => r.kind === prevK).at(-1)!
    const attr = PREV_FILE_ATTR[kind as Exclude<TitleKind, 'T1'>]
    const ref = new RegExp(`${attr}="([^"]*)"[^>]*\\sЭП="([^"]*)"`).exec(decode1251(xml))
    if (!ref) return `в ${kind} нет ссылки на ${prevK}`
    if (ref[1] !== prev.fileName) return `${kind} ссылается на чужой ${prevK}`
    if (!prev.signatures.includes(ref[2]!)) return `подпись ${prevK} в ${kind} не совпадает с присланной оператору`
    return null
  }

  private async document(operatorDocId: string) {
    const [d] = await this.db.select().from(mockEpdDocument).where(eq(mockEpdDocument.operatorDocId, operatorDocId))
    return d ?? null
  }

  private journal(shipmentId: string, type: string, payload: Record<string, unknown>) {
    return this.db.insert(event).values({ shipmentId, type, actorKind: 'operator', payload: { ...payload, model: true } })
  }
}
