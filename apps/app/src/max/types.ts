// Обновления MAX Bot API — только поля, которые мы используем.
// Схема: github.com/max-messenger/api-schema (schema.yaml).

export interface MaxUser {
  user_id: number
  first_name: string
  last_name?: string | null
  username?: string | null
  is_bot: boolean
}

export interface MaxAttachment {
  type: string
  payload?: Record<string, unknown> & {
    vcf_info?: string | null
    hash?: string | null
    max_info?: MaxUser | null
    url?: string
  }
}

export interface MaxMessage {
  sender?: MaxUser
  recipient: { chat_id?: number | null; chat_type: string; user_id?: number | null }
  timestamp: number
  link?: { type: 'forward' | 'reply'; sender?: MaxUser; message?: { attachments?: MaxAttachment[] } } | null
  body: { mid: string; seq: number; text?: string | null; attachments?: MaxAttachment[] | null }
}

export type MaxUpdate =
  | { update_type: 'message_created'; timestamp: number; message: MaxMessage }
  | {
      update_type: 'message_callback'
      timestamp: number
      callback: { timestamp: number; callback_id: string; payload?: string; user: MaxUser }
      message?: MaxMessage
    }
  | { update_type: 'bot_started'; timestamp: number; chat_id: number; user: MaxUser; payload?: string | null }
  | { update_type: string; timestamp: number }

export interface NewMessageBody {
  text?: string | null
  attachments?: unknown[] | null
  notify?: boolean
  format?: 'markdown' | 'html' | null
}
