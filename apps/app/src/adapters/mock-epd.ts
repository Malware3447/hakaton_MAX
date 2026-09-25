import { randomUUID } from 'node:crypto'
import { asc, eq } from 'drizzle-orm'
import { OperatorBusy, TITLE_KINDS, type EpdOperator, type OperatorStatus, type TitleFile, type TitleKind } from '@nk/domain'
import { decode1251 } from '@nk/etrn'
import type { Db } from '../db/client.ts'
import { mockEpdDocument, mockEpdSettings, mockEpdTitle, shipment } from '../db/schema.ts'
import { qrGif } from '../core/qr-gif.ts'

// Модель оператора ЭПД и ГИС ЭПД (HAKATON-39) на таблицах mock.epd_*, везде помечена «модель».
// Реализует EpdOperator так же, как его реализовал бы настоящий оператор: принимает титулы,
// проверяет порядок и сцепку, отвечает на запрос статуса. Номер накладной (УИД) выдаёт после Т1 —
// по схемам ФНС он нужен уже в Т2; через registerDelayS после Т2 — регистрация в ГИС ЭПД и QR.
// Сбои включаются ручками в mock.epd_settings (демо-пульт, HAKATON-32) без перезапуска.

/** Ручки сбоев модели. Отказы срабатывают один раз и сами выключаются. */
export interface OperatorFaults {
  /** оператор недоступен до этого момента (ISO): на любой запрос — OperatorBusy */
  unavailableUntil: string | null
  /** отказ оператора в Т2 — перевозчику нужно подписать Т2 заново */
  rejectT2: { code: string; message: string } | null
  /** ошибка ГИС ЭПД при регистрации — тоже возврат к подписи Т2 */
  gisError: { code: string; message: string } | null
  /** через сколько секунд после Т2 приходит регистрация */
  registerDelayS: number
  /** через сколько секунд после регистрации готов QR */
  qrDelayS: number
}

export const DEFAULT_FAULTS: OperatorFaults = { unavailableUntil: null, rejectT2: null, gisError: null, registerDelayS: 3, qrDelayS: 0 }

const FAULTS_KEY = 'faults'

/** В каком атрибуте титул ссылается на ИдФайл предыдущего (формат ФНС 5.01). */
const PREV_FILE_ATTR: Record<Exclude<TitleKind, 'T1'>, string> = { T2: 'ИдФайлИнфГО', T3: 'ИдФайлИнфПрвПрием', T4: 'ИдФайлИнфГП' }

const prevKind = (kind: TitleKind): TitleKind | undefined => TITLE_KINDS[TITLE_KINDS.indexOf(kind) - 1]

export class MockEpd implements EpdOperator {
  readonly isModel = true

  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

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

  // ---------- EpdOperator ----------

  async submit(operatorDocId: string | null, title: TitleFile, signatures: Uint8Array[]): Promise<{ operatorDocId: string }> {
    await this.ensureAvailable()
    const doc = operatorDocId ? await this.document(operatorDocId) : null
    if (operatorDocId && !doc) throw new Error(`документа ${operatorDocId} у оператора нет`)
    const received = doc ? await this.received(doc.operatorDocId) : []

    // Повтор уже принятого титула — без последствий. Т2 после отказа принимаем заново
    if (doc && received.some((r) => r.kind === title.kind) && !(title.kind === 'T2' && doc.status === 'rejected')) {
      return { operatorDocId: doc.operatorDocId }
    }

    const problem = this.checkOrder(title.kind, received, doc?.status ?? null) ?? this.checkChain(title, received)
    if (problem) throw new Error(problem)

    const docId = doc?.operatorDocId ?? `op-${randomUUID()}`
    if (!doc) await this.db.insert(mockEpdDocument).values({ operatorDocId: docId, status: 'sent', uid: randomUUID() })
    await this.db.insert(mockEpdTitle).values({
      operatorDocId: docId,
      kind: title.kind,
      fileName: title.fileName,
      xml: Buffer.from(title.xml),
      signatures: signatures.map((s) => Buffer.from(s).toString('base64')),
      receivedAt: this.now(),
    })
    if (title.kind === 'T2') {
      await this.db.update(mockEpdDocument).set({ status: 'sent', rejectCode: null, rejectMessage: null }).where(eq(mockEpdDocument.operatorDocId, docId))
    }
    return { operatorDocId: docId }
  }

  /** Статус документа. Регистрация и сбои Т2 происходят здесь, когда после Т2 прошло registerDelayS. */
  async status(operatorDocId: string): Promise<OperatorStatus> {
    await this.ensureAvailable()
    const doc = await this.document(operatorDocId)
    if (!doc) throw new Error(`документа ${operatorDocId} у оператора нет`)
    if (doc.status === 'registered') return { kind: 'registered', uid: doc.uid! }
    // Кто отказал, в таблице не хранится: в демо коды ошибок ГИС начинаются с GIS
    if (doc.status === 'rejected') return { kind: 'rejected', by: doc.rejectCode?.startsWith('GIS') ? 'gis' : 'operator', code: doc.rejectCode!, message: doc.rejectMessage! }

    const t2 = (await this.received(operatorDocId)).filter((t) => t.kind === 'T2').at(-1)
    const faults = await this.faults()
    if (!t2 || this.now().getTime() < t2.receivedAt.getTime() + faults.registerDelayS * 1000) return { kind: 'sent', uid: doc.uid }

    const fail = faults.rejectT2
      ? { by: 'operator' as const, ...faults.rejectT2, off: { rejectT2: null } }
      : faults.gisError
        ? { by: 'gis' as const, ...faults.gisError, off: { gisError: null } }
        : null
    if (fail) {
      // Сбой одноразовый: следующая подпись Т2 пройдёт
      await this.setFaults(fail.off)
      await this.db.update(mockEpdDocument).set({ status: 'rejected', rejectCode: fail.code, rejectMessage: fail.message }).where(eq(mockEpdDocument.operatorDocId, operatorDocId))
      return { kind: 'rejected', by: fail.by, code: fail.code, message: fail.message }
    }

    await this.db.update(mockEpdDocument).set({ status: 'registered', registeredAt: this.now() }).where(eq(mockEpdDocument.operatorDocId, operatorDocId))
    return { kind: 'registered', uid: doc.uid! }
  }

  /** Анимированный GIF QR-кода; готов через qrDelayS после регистрации. */
  async qr(operatorDocId: string): Promise<Uint8Array> {
    await this.ensureAvailable()
    const doc = await this.document(operatorDocId)
    if (doc?.status !== 'registered' || !doc.uid || !doc.registeredAt) throw new Error('накладная не зарегистрирована — QR-кода нет')
    const readyInMs = doc.registeredAt.getTime() + (await this.faults()).qrDelayS * 1000 - this.now().getTime()
    if (readyInMs > 0) throw new OperatorBusy('QR-код ещё готовится (модель)', Math.ceil(readyInMs / 1000))
    // Номер отгрузки на картинке — только для демо: настоящий оператор знает лишь УИД
    const [s] = await this.db.select({ erpRef: shipment.erpRef }).from(shipment).where(eq(shipment.operatorDocId, operatorDocId))
    return qrGif({ uid: doc.uid, number: s?.erpRef ?? null, model: true })
  }

  // ---------- проверки ----------

  private async ensureAvailable() {
    const { unavailableUntil } = await this.faults()
    const downMs = unavailableUntil ? new Date(unavailableUntil).getTime() - this.now().getTime() : 0
    if (downMs > 0) throw new OperatorBusy('оператор ЭПД недоступен (модель)', Math.ceil(downMs / 1000) + 1)
  }

  /** Титулы идут по порядку: Т2 после Т1, Т3 — только после регистрации, Т4 после Т3. */
  private checkOrder(kind: TitleKind, received: { kind: TitleKind }[], status: string | null): string | null {
    const prev = prevKind(kind)
    if (prev && !received.some((r) => r.kind === prev)) return `${kind} пришёл раньше ${prev}`
    if (kind === 'T3' && status !== 'registered') return 'Т3 до регистрации накладной в ГИС ЭПД'
    return null
  }

  /** Сцепка: титул ссылается на ИдФайл предыдущего и несёт одну из его подписей в атрибуте ЭП. */
  private checkChain(title: TitleFile, received: { kind: TitleKind; fileName: string; signatures: string[] }[]): string | null {
    const prevK = prevKind(title.kind)
    if (!prevK) return null
    const prev = received.filter((r) => r.kind === prevK).at(-1)!
    const attr = PREV_FILE_ATTR[title.kind as Exclude<TitleKind, 'T1'>]
    const ref = new RegExp(`${attr}="([^"]*)"[^>]*\\sЭП="([^"]*)"`).exec(decode1251(title.xml))
    if (!ref) return `в ${title.kind} нет ссылки на ${prevK}`
    if (ref[1] !== prev.fileName) return `${title.kind} ссылается на чужой ${prevK}`
    if (!prev.signatures.includes(ref[2]!)) return `подпись ${prevK} в ${title.kind} не совпадает с присланной оператору`
    return null
  }

  private async document(operatorDocId: string) {
    const [d] = await this.db.select().from(mockEpdDocument).where(eq(mockEpdDocument.operatorDocId, operatorDocId))
    return d ?? null
  }

  private received(operatorDocId: string) {
    return this.db.select().from(mockEpdTitle).where(eq(mockEpdTitle.operatorDocId, operatorDocId)).orderBy(asc(mockEpdTitle.receivedAt))
  }
}
