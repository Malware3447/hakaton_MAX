import { createHmac, timingSafeEqual } from 'node:crypto'

// Проверка стартовых данных мини-приложения (window.WebApp.initData).
// Алгоритм — dev.max.ru/docs/webapps/validation: пары key=value без hash, декодированные,
// по алфавиту через \n; secret = HMAC-SHA256(ключ "WebAppData", токен бота);
// подпись = hex(HMAC-SHA256(secret, строка)). auth_date годен час — так советует документация.

export interface InitUser {
  id: number
  firstName: string
  lastName: string | null
}

export interface InitData {
  user: InitUser
  authDate: Date
  /** payload из ссылки startapp или кнопки open_app; ни на какие права не влияет */
  startParam: string | null
}

export const INIT_DATA_MAX_AGE_S = 60 * 60

export function signInitData(params: Record<string, string>, botToken: string): string {
  const hash = createHmac('sha256', secretKey(botToken)).update(checkString(Object.entries(params))).digest('hex')
  return new URLSearchParams({ ...params, hash }).toString()
}

export function verifyInitData(raw: string, botToken: string, now = new Date(), maxAgeS = INIT_DATA_MAX_AGE_S): InitData | null {
  const pairs = [...new URLSearchParams(raw)]
  const keys = pairs.map(([k]) => k)
  if (new Set(keys).size !== keys.length) return null
  const hash = pairs.find(([k]) => k === 'hash')?.[1]
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null

  const expected = createHmac('sha256', secretKey(botToken))
    .update(checkString(pairs.filter(([k]) => k !== 'hash')))
    .digest()
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) return null

  const fields = Object.fromEntries(pairs)
  const authDate = Number(fields.auth_date)
  if (!Number.isInteger(authDate)) return null
  const ageS = now.getTime() / 1000 - authDate
  if (ageS > maxAgeS || ageS < -60) return null

  let user: { id?: unknown; first_name?: unknown; last_name?: unknown }
  try {
    user = JSON.parse(fields.user ?? '')
  } catch {
    return null
  }
  if (typeof user.id !== 'number' || !Number.isSafeInteger(user.id)) return null

  return {
    user: {
      id: user.id,
      firstName: typeof user.first_name === 'string' ? user.first_name : '',
      lastName: typeof user.last_name === 'string' && user.last_name ? user.last_name : null,
    },
    authDate: new Date(authDate * 1000),
    startParam: fields.start_param || null,
  }
}

function secretKey(botToken: string): Buffer {
  return createHmac('sha256', 'WebAppData').update(botToken).digest()
}

function checkString(pairs: [string, string][]): string {
  return [...pairs]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
}
