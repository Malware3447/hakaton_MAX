import type { Button, Messenger, OutMessage } from '@nk/domain'
import type { MaxApi } from './api.ts'
import type { NewMessageBody } from './types.ts'

// Messenger поверх MAX. Тексты — HTML (<b>, <i>); всё, что ввёл человек, экранируем через esc().

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function toMaxButton(b: Button) {
  if (b.kind === 'link') return { type: 'link', text: b.text, url: b.payload }
  if (b.kind === 'request_contact') return { type: 'request_contact', text: b.text }
  return { type: 'callback', text: b.text, payload: b.payload }
}

export function toBody(m: OutMessage): NewMessageBody {
  const attachments = m.buttons?.length
    ? [{ type: 'inline_keyboard', payload: { buttons: m.buttons.map((row) => row.map(toMaxButton)) } }]
    : []
  return { text: m.text, format: 'html', attachments }
}

export class MaxMessenger implements Messenger {
  constructor(private readonly api: MaxApi) {}

  async send(maxUserId: number, message: OutMessage) {
    return { mid: await this.api.sendToUser(maxUserId, toBody(message)) }
  }

  async edit(mid: string, message: OutMessage) {
    await this.api.editMessage(mid, toBody(message))
  }

  async answerCallback(callbackId: string, notification: string | null, message?: OutMessage) {
    await this.api.answerCallback(callbackId, {
      ...(notification ? { notification } : {}),
      ...(message ? { message: toBody(message) } : {}),
    })
  }
}
