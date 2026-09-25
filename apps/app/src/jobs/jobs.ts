import { eq } from 'drizzle-orm'
import type { Effect, ErpAdapter, Messenger, OutMessage } from '@nk/domain'
import type { FastifyBaseLogger } from 'fastify'
import { PgBoss } from 'pg-boss'
import type { Outbox } from '../bot/outbox.ts'
import type { EffectSink } from '../core/shipments.ts'
import type { Db } from '../db/client.ts'
import { event, shipment } from '../db/schema.ts'
import type { MaxApi } from '../max/api.ts'
import { MaxApiError } from '../max/api.ts'

// Очередь заданий на pg-boss в той же базе (HAKATON-26):
// notify — сообщения участникам с повторами и лимитами MAX;
// effect — последствия переходов, которые требуют внешних систем (учётка, оператор, QR);
// subscription-check — самопроверка вебхука раз в 10 минут.

export const Q = { notify: 'notify', effect: 'effect', subscription: 'subscription-check' } as const

interface NotifyJob {
  userId: number
  text: string
  buttons?: OutMessage['buttons']
  file?: { name: string; base64: string }
  shipmentId?: string
}

interface EffectJob {
  shipmentId: string
  effect: Effect
}

export class Jobs implements Outbox, EffectSink {
  constructor(
    private readonly boss: PgBoss,
    private readonly db: Db,
    private readonly messenger: Messenger,
    private readonly erp: ErpAdapter,
    private readonly log: FastifyBaseLogger,
  ) {}

  static create(url: string) {
    return new PgBoss({ connectionString: url, schema: 'pgboss' })
  }

  async start(opts: { webhook?: { api: MaxApi; url: string; secret: string } } = {}) {
    this.boss.on('error', (err) => this.log.error({ err }, 'pg-boss'))
    await this.boss.start()
    await this.boss.createQueue(Q.notify, { retryLimit: 5, retryDelay: 2, retryBackoff: true })
    await this.boss.createQueue(Q.effect, { retryLimit: 10, retryDelay: 5, retryBackoff: true })
    await this.boss.work<NotifyJob>(Q.notify, { pollingIntervalSeconds: 0.5 }, async (jobs) => {
      for (const j of jobs) await this.runNotify(j.data)
    })
    await this.boss.work<EffectJob>(Q.effect, { pollingIntervalSeconds: 0.5 }, async (jobs) => {
      for (const j of jobs) await this.runEffect(j.data)
    })
    if (opts.webhook) {
      const wh = opts.webhook
      await this.boss.createQueue(Q.subscription)
      await this.boss.work(Q.subscription, async () => this.checkSubscription(wh))
      await this.boss.schedule(Q.subscription, '*/10 * * * *')
      await this.checkSubscription(wh)
    }
  }

  stop() {
    return this.boss.stop({ graceful: true, timeout: 5000 })
  }

  // ---------- постановка ----------

  async send(userId: number, message: OutMessage, meta: { shipmentId?: string } = {}) {
    const job: NotifyJob = { userId, text: message.text, buttons: message.buttons, shipmentId: meta.shipmentId }
    if (message.file) job.file = { name: message.file.name, base64: Buffer.from(message.file.bytes).toString('base64') }
    await this.boss.send(Q.notify, job)
  }

  async enqueue(shipmentId: string, effects: Effect[]) {
    for (const effect of effects) await this.boss.send(Q.effect, { shipmentId, effect } satisfies EffectJob)
  }

  // ---------- выполнение ----------

  private async runNotify(j: NotifyJob) {
    const message: OutMessage = { text: j.text, buttons: j.buttons }
    if (j.file) message.file = { name: j.file.name, bytes: Buffer.from(j.file.base64, 'base64') }
    try {
      await this.messenger.send(j.userId, message)
    } catch (err) {
      // Остановил бота или ни разу его не запускал — повторять бессмысленно, отмечаем в журнале
      if (err instanceof MaxApiError && err.unreachable) {
        this.log.warn({ userId: j.userId, code: err.code }, 'участник недоступен в MAX')
        if (j.shipmentId) {
          await this.db.insert(event).values({ shipmentId: j.shipmentId, type: 'notify.failed', actorKind: 'system', payload: { code: err.code ?? String(err.status) } })
        }
        return
      }
      throw err
    }
  }

  private async runEffect({ shipmentId, effect }: EffectJob) {
    const [s] = await this.db.select().from(shipment).where(eq(shipment.id, shipmentId))
    if (!s) return
    switch (effect.kind) {
      case 'erpWriteBack': {
        await this.erp.writeBack(
          s.erpRef,
          effect.status === 'closed'
            ? { kind: 'closed', uid: s.uid ?? '', closedAt: s.updatedAt.toISOString() }
            : { kind: 'cancelled', reason: await this.cancelReason(shipmentId) },
        )
        return
      }
      default:
        // submitTitle, sendQrToDriver, inviteConsignee — подключаются с оператором и накладной (HAKATON-35, 39)
        this.log.info({ shipmentId, effect: effect.kind }, 'последствие ждёт реализации')
    }
  }

  private async cancelReason(shipmentId: string): Promise<string | null> {
    const rows = await this.db.select({ type: event.type, payload: event.payload }).from(event).where(eq(event.shipmentId, shipmentId))
    const cancel = rows.find((r) => r.type === 'shipper.cancel')
    return (cancel?.payload.reason as string | null | undefined) ?? null
  }

  /** Вебхук на месте? Нашего адреса нет — подписываемся; чужие адреса снимаем. */
  private async checkSubscription(wh: { api: MaxApi; url: string; secret: string }) {
    const { subscriptions } = await wh.api.getSubscriptions()
    for (const s of subscriptions) if (s.url !== wh.url) await wh.api.unsubscribe(s.url)
    if (!subscriptions.some((s) => s.url === wh.url)) {
      await wh.api.subscribe(wh.url, wh.secret, ['message_created', 'message_callback', 'bot_started'])
      this.log.warn({ url: wh.url }, 'подписка вебхука восстановлена')
    }
  }
}
