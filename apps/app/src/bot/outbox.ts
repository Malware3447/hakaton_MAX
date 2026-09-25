import type { OutMessage } from '@nk/domain'

/**
 * Исходящие сообщения тем, кто не нажимал кнопку: «ваш ход», приглашения, уведомления.
 * В работе — очередь заданий с повторами (jobs/jobs.ts), в тестах и без базы — прямая отправка.
 * Ответ тому, кто нажал, идёт мимо очереди: человек ждёт его сейчас.
 */
export interface Outbox {
  send(userId: number, message: OutMessage, meta?: { shipmentId?: string }): Promise<unknown>
}
