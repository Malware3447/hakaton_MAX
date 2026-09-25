import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { TitleKind } from '@nk/domain'
import type { Db } from '../db/client.ts'
import { event, mockEpdDocument, mockEpdTitle, shipment, signature } from '../db/schema.ts'
import type { ExecResult, ShipmentService } from './shipments.ts'
import type { TitleService } from './titles.ts'

// Модель оператора ЭПД и ГИС ЭПД (HAKATON-39) — минимум для сквозного пути, помечена «модель».
// Порядок подтверждён схемами ФНС: номер накладной (УИД) нужен уже в Т2, поэтому оператор
// выдаёт его в ответ на Т1; после Т2 — регистрация в ГИС ЭПД и данные для QR-кода.
// Полная модель с ручками сбоев — HAKATON-39.

export class MockOperator {
  constructor(
    private readonly db: Db,
    private readonly shipments: ShipmentService,
    private readonly titles: TitleService,
    /** что сделать после перехода по ответу оператора: уведомления, карточки */
    private readonly onTransition: (res: Extract<ExecResult, { ok: true }>) => Promise<unknown>,
    /** задержка регистрации после Т2 — похоже на настоящего оператора */
    private readonly registerDelayMs = 3000,
  ) {}

  /** Принять подписанный титул. */
  async submit(shipmentId: string, kind: TitleKind) {
    const [s] = await this.db.select().from(shipment).where(eq(shipment.id, shipmentId))
    const t = await this.titles.get(shipmentId, kind)
    if (!s || !t) return

    let docId = s.operatorDocId
    if (!docId) {
      docId = `op-${randomUUID()}`
      const uid = randomUUID()
      await this.db.insert(mockEpdDocument).values({ operatorDocId: docId, status: 'sent', uid })
      await this.db.update(shipment).set({ operatorDocId: docId, uid }).where(eq(shipment.id, shipmentId))
      await this.db.insert(event).values({ shipmentId, type: 'operator.accepted', actorKind: 'operator', payload: { uid, model: true } })
    }
    const sigs = await this.db.select().from(signature).where(eq(signature.titleId, t.id))
    await this.db.insert(mockEpdTitle).values({
      operatorDocId: docId,
      kind,
      fileName: t.fileId,
      xml: Buffer.from(t.bytes),
      signatures: sigs.map((x) => (x.cms ? Buffer.from(x.cms).toString('base64') : 'DEMO')),
    })

    if (kind === 'T2') {
      await new Promise((r) => setTimeout(r, this.registerDelayMs))
      const [doc] = await this.db.select().from(mockEpdDocument).where(eq(mockEpdDocument.operatorDocId, docId))
      await this.db.update(mockEpdDocument).set({ status: 'registered', registeredAt: new Date() }).where(eq(mockEpdDocument.operatorDocId, docId))
      const res = await this.shipments.execute({ type: 'operator.registered', shipmentId, payload: { operatorDocId: docId, uid: doc!.uid! } }, { kind: 'operator' })
      if (res.ok) await this.onTransition(res)
    }
  }
}
