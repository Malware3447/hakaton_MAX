import { webApp } from './bridge.ts'

// Клиент API мини-приложения. Сессия — токен в памяти вкладки: живёт 8 часов, а если сервер
// ответил 401 (перезапуск, истёк срок), берём новую по тому же initData.

export type Role = 'shipper' | 'carrier' | 'driver' | 'consignee'

export interface RoleSummary {
  role: Role
  title: string
  orgName: string | null
  waiting: number
}

export interface Me {
  person: { name: string }
  activeRole: Role | null
  roles: RoleSummary[]
}

export type SessionResult =
  | { registered: true; token: string; expiresAt: string; startParam: string | null; me: Me }
  | { registered: false; startParam: string | null }

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`${status} ${code}`)
  }
}

let token: string | null = null

async function raw<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new ApiError(res.status, err.error ?? 'error')
  }
  return (await res.json()) as T
}

export async function startSession(): Promise<SessionResult> {
  if (!webApp) throw new ApiError(0, 'outside_max')
  const s = await raw<SessionResult>('POST', '/session', { initData: webApp.initData })
  token = s.registered ? s.token : null
  return s
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  try {
    return await raw<T>(method, path, body)
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 401 || !webApp) throw e
    await startSession()
    return raw<T>(method, path, body)
  }
}

export const api = {
  me: () => call<Me>('GET', '/me'),
  setRole: (role: Role) => call<Me>('PUT', '/me/role', { role }),
}
