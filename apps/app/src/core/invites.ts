import { createHash, randomBytes } from 'node:crypto'

// Ссылка-приглашение: https://max.ru/<бот>?start=<payload>, payload до 128 символов.
// Токен 128 бит, в базе только sha256 (docs/model-i-sostoyaniya.md, раздел 9).

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export function newInviteToken(): { token: string; sha256: string } {
  const token = randomBytes(16).toString('base64url')
  return { token, sha256: sha256(token) }
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export const inviteLink = (botUsername: string, token: string) => `https://max.ru/${botUsername}?start=inv_${token}`
