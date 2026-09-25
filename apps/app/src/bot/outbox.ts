import type { OutMessage } from '@nk/domain'

/** Что сделать вокруг отправки: записать живую карточку, предупредить ответственного, если не дошло. */
export interface NotifyMeta {
  shipmentId?: string
  /** это сообщение — новая живая карточка человека в перевозке */
  card?: { personId: string; hash: string }
  /** если человеку не написать (остановил бота, не запускал) — кому и что сообщить */
  escalate?: { userId: number; text: string }
}

/**
 * Исходящие сообщения тем, кто не нажимал кнопку: «ваш ход», приглашения, уведомления,
 * перерисовка живых карточек. В работе — очередь заданий с повторами (jobs/jobs.ts);
 * в тестах и без базы — прямая отправка. Ответ нажавшему идёт мимо: человек ждёт его сейчас.
 * send возвращает mid, если отправка прямая; очередь запишет карточку сама после доставки.
 */
export interface Outbox {
  send(userId: number, message: OutMessage, meta?: NotifyMeta): Promise<{ mid: string } | void>
  edit(mid: string, message: OutMessage): Promise<unknown>
}
