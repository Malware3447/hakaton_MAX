import { eq } from 'drizzle-orm'
import { OperatorBusy, type EpdOperator, type OperatorStatus, type TitleKind } from '@nk/domain'
import type { Db } from '../db/client.ts'
import { event, shipment, signature } from '../db/schema.ts'
import type { ExecResult, ShipmentService } from './shipments.ts'
import type { TitleService } from './titles.ts'

// Связь ядра с оператором ЭПД (HAKATON-39) через интерфейс EpdOperator: отправить подписанный титул,
// опрашивать статус до регистрации в ГИС ЭПД, доставить QR водителю. Оператор здесь любой —
// на хакатоне модель MockEpd, на пилоте Диадок или Такском. Все ответы оператора — отложенные шаги
// очереди: они переживают перезапуск, временная недоступность (OperatorBusy) — повтор позже.

/** Отложенные шаги: повтор отправки титула, опрос статуса, QR водителю. */
export type OperatorTask = 'operator.submit' | 'operator.poll' | 'operator.qr'

/** Как часто спрашивать статус, пока накладная регистрируется. */
const POLL_S = 2

/** У демо-подписи CMS нет — оператору уходит та же метка, что стоит в атрибуте ЭП титулов. */
const DEMO_SIGNATURE = Buffer.from('DEMO-SIGNATURE-MODEL')

export class OperatorLink {
  constructor(
    private readonly db: Db,
    private readonly operator: EpdOperator,
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
  ) {}

  /** Выполнить отложенный шаг. */
  run(task: OperatorTask | 'operator.register', shipmentId: string, arg?: string) {
    switch (task) {
      case 'operator.submit':
        return this.submit(shipmentId, arg as TitleKind)
      case 'operator.poll':
      case 'operator.register': // имя шага до HAKATON-39: такие задания могли остаться в очереди
        return this.poll(shipmentId)
      case 'operator.qr':
        return this.deliverQr(shipmentId)
    }
  }

  /** Отправить подписанный титул оператору (последствие submitTitle). Повтор — без последствий. */
  async submit(shipmentId: string, kind: TitleKind) {
    const [s] = await this.db.select().from(shipment).where(eq(shipment.id, shipmentId))
    const t = await this.titles.get(shipmentId, kind)
    if (!s || !t) return
    const sigs = await this.db.select().from(signature).where(eq(signature.titleId, t.id))

    let operatorDocId: string
    try {
      ;({ operatorDocId } = await this.operator.submit(
        s.operatorDocId,
        { kind, fileName: t.fileId, xml: t.bytes, sha256: t.sha256 },
        sigs.map((x) => new Uint8Array(x.cms ?? DEMO_SIGNATURE)),
      ))
    } catch (err) {
      if (err instanceof OperatorBusy) {
        // Как с настоящим оператором: титул уйдёт, когда он снова ответит
        await this.journal(shipmentId, 'operator.unavailable', { title: kind, retryInS: err.retryInS })
        await this.out.later('operator.submit', shipmentId, err.retryInS, kind)
        return
      }
      // Титул не принят: порядок или сцепка нарушены — ошибка нашего кода, а не демо-сбой.
      // Видна в журнале, сценарий не двигаем
      await this.journal(shipmentId, 'operator.error', { title: kind, message: (err as Error).message })
      return
    }
    if (!s.operatorDocId) await this.db.update(shipment).set({ operatorDocId }).where(eq(shipment.id, shipmentId))
    await this.poll(shipmentId)
  }

  /** Спросить статус: после Т1 — номер накладной, после Т2 — регистрация или отказ. Пока ждём — спросить позже. */
  async poll(shipmentId: string) {
    const [s] = await this.db.select().from(shipment).where(eq(shipment.id, shipmentId))
    if (!s?.operatorDocId) return

    let st: OperatorStatus
    try {
      st = await this.operator.status(s.operatorDocId)
    } catch (err) {
      if (!(err instanceof OperatorBusy)) throw err
      return this.out.later('operator.poll', shipmentId, err.retryInS)
    }

    const uid = st.kind === 'rejected' ? null : st.uid
    if (uid && !s.uid) {
      await this.db.update(shipment).set({ uid }).where(eq(shipment.id, shipmentId))
      await this.journal(shipmentId, 'operator.accepted', { uid })
    }

    if (s.state !== 'registering') {
      // Ждать нечего, кроме номера накладной после Т1
      if (!s.uid && !uid) await this.out.later('operator.poll', shipmentId, POLL_S)
      return
    }
    if (st.kind === 'sent') return this.out.later('operator.poll', shipmentId, POLL_S)

    const payload = { operatorDocId: s.operatorDocId }
    const res =
      st.kind === 'registered'
        ? await this.shipments.execute({ type: 'operator.registered', shipmentId, payload: { ...payload, uid: st.uid } }, { kind: 'operator' })
        : await this.shipments.execute({ type: 'operator.rejected', shipmentId, payload: { ...payload, code: st.code, message: st.message } }, { kind: 'operator' })
    if (res.ok) await this.out.onTransition(res, st.kind === 'rejected' ? this.rejectReason(st) : undefined)
  }

  // ---------- QR-код ----------

  /** Водителю нужен QR (последствие sendQrToDriver). Если оператор ещё не готов — повтор позже. */
  async deliverQr(shipmentId: string) {
    const [s] = await this.db.select().from(shipment).where(eq(shipment.id, shipmentId))
    if (!s?.operatorDocId) return
    let bytes: Uint8Array
    try {
      bytes = await this.operator.qr(s.operatorDocId)
    } catch (err) {
      if (!(err instanceof OperatorBusy)) throw err
      return this.out.later('operator.qr', shipmentId, err.retryInS)
    }
    await this.out.sendQr(shipmentId, { name: `QR-${s.erpRef}.gif`, bytes })
  }

  private rejectReason(st: Extract<OperatorStatus, { kind: 'rejected' }>) {
    const model = this.operator.isModel ? ' (модель)' : ''
    const who = st.by === 'gis' ? `ГИС ЭПД не зарегистрировала накладную${model}` : `Оператор ЭПД отклонил титул перевозчика${model}`
    return `${who}: ${st.message}, код ${st.code}`
  }

  private journal(shipmentId: string, type: string, payload: Record<string, unknown>) {
    return this.db.insert(event).values({ shipmentId, type, actorKind: 'operator', payload: { ...payload, model: this.operator.isModel } })
  }
}
