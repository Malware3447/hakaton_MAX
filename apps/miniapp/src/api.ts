import { closeApp, webApp } from './bridge.ts'
import { listView } from './list.ts'
import type {
  ChatStep,
  Command,
  Company,
  DataSource,
  Driver,
  FileLink,
  ListQuery,
  Me,
  Notice,
  OrgBrief,
  Role,
  ShipEvent,
  Shipment,
  Vehicle,
  VehicleInput,
} from './model.ts'

// Источник данных в MAX: API сервера (apps/app/src/miniapp/routes.ts). Сессия — токен в памяти вкладки:
// живёт 8 часов, а если сервер ответил 401 (перезапуск, истёк срок), берём новую по тому же initData.
// Каждый запрос экрана несёт текущую роль — сервер отдаёт данные только организации человека в ней.

export type { Role } from './model.ts'

/** Человек с сервера: роли может ещё не быть — тогда приложение просит завести её в чате. */
export type MeView = Omit<Me, 'activeRole'> & { activeRole: Role | null }

export type SessionResult =
  | { registered: true; token: string; expiresAt: string; startParam: string | null; me: MeView }
  | { registered: false; startParam: string | null }

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

let token: string | null = null

async function raw<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, 'offline', 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.')
  }
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string; message?: string }
    throw new ApiError(res.status, err.error ?? 'error', err.message ?? 'Сервер не ответил. Попробуйте ещё раз.')
  }
  return (await res.json()) as T
}

export async function startSession(): Promise<SessionResult> {
  if (!webApp) throw new ApiError(0, 'outside_max', 'Откройте приложение из MAX')
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

/** Сменить роль до того, как открыт главный экран (startapp=r_<роль>). */
export const setRole = (role: Role) => call<MeView>('PUT', '/me/role', { role })

const asMe = (m: MeView): Me => {
  if (!m.activeRole) throw new ApiError(0, 'no_roles', 'Ролей пока нет: заведите роль в чате с ботом')
  return { ...m, activeRole: m.activeRole }
}

/** Как часто спрашивать сервер, что изменилось у других, пока приложение на экране. */
const PULSE_MS = 4000

export class ApiData implements DataSource {
  // Приглашение сотрудника, фото повреждений и водитель вне рейса пока делаются только в чате
  readonly features = { invite: false, photos: false, addDriver: false }
  private role: Role
  private listeners = new Set<(e: ShipEvent | null) => void>()
  private timer: ReturnType<typeof setInterval> | null = null
  private lastNow: string | null = null
  private seen = new Set<string>()

  constructor(me: Me) {
    this.role = me.activeRole
  }

  /** Путь с текущей ролью: сервер проверит её и отдаст только свою организацию. */
  private r(path: string) {
    return `${path}${path.includes('?') ? '&' : '?'}role=${this.role}`
  }

  async me(): Promise<Me> {
    const m = asMe(await call<MeView>('GET', '/me'))
    this.role = m.activeRole
    return m
  }

  async setRole(role: Role): Promise<Me> {
    const m = asMe(await setRole(role))
    this.role = m.activeRole
    this.emit(null)
    return m
  }

  async list(q: ListQuery) {
    const role = this.role
    return listView(await call<Shipment[]>('GET', this.r('/shipments')), role, q)
  }

  shipment(id: string) {
    return call<Shipment>('GET', this.r(`/shipments/${encodeURIComponent(id)}`))
  }

  async execute(id: string, cmd: Command): Promise<Shipment | null> {
    const res = await call<{ chat: boolean; shipment: Shipment | null }>('POST', this.r(`/shipments/${encodeURIComponent(id)}/commands`), { command: cmd })
    // Шаг ушёл в чат (например, сначала подтвердить номер): бот уже прислал сообщение
    if (res.chat) closeApp()
    this.emit(null)
    return res.shipment
  }

  async toChat(step: ChatStep): Promise<void> {
    await call('POST', this.r(`/shipments/${encodeURIComponent(step.shipmentId)}/handoff`), { handoff: step.handoff })
    closeApp()
  }

  carriers() {
    return call<OrgBrief[]>('GET', this.r('/carriers'))
  }

  vehicles() {
    return call<Vehicle[]>('GET', '/fleet/vehicles')
  }

  async saveVehicle(v: VehicleInput) {
    const list = await call<Vehicle[]>('POST', '/fleet/vehicles', { vehicle: v })
    this.emit(null)
    return list
  }

  drivers() {
    return call<Driver[]>('GET', '/fleet/drivers')
  }

  company() {
    return call<Company>('GET', this.r('/company'))
  }

  saveCompany(patch: { name?: string; address?: string; poa?: { number: string; validTo: string } }) {
    return call<Company>('PUT', this.r('/company'), patch)
  }

  async invite(): Promise<string> {
    throw new ApiError(0, 'not_supported', 'Приглашение сотрудника пока недоступно')
  }

  notices() {
    return call<Notice[]>('GET', this.r('/notices'))
  }

  async markRead() {
    await call('POST', this.r('/notices/read'))
    this.emit(null)
  }

  /** Картинка QR-кода от оператора ЭПД (модель): запрос с сессией, в img — адрес blob. */
  async qr(id: string): Promise<string> {
    const get = () => fetch(`/api${this.r(`/shipments/${encodeURIComponent(id)}/qr`)}`, { headers: token ? { authorization: `Bearer ${token}` } : {} })
    let res = await get()
    if (res.status === 401 && webApp) {
      await startSession()
      res = await get()
    }
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string; message?: string }
      throw new ApiError(res.status, err.error ?? 'error', err.message ?? 'QR-кода пока нет')
    }
    return URL.createObjectURL(await res.blob())
  }

  async files(id: string): Promise<FileLink[]> {
    const list = await call<FileLink[]>('GET', this.r(`/shipments/${encodeURIComponent(id)}/files`))
    // MAX скачивает файл сам — ему нужен полный адрес
    return list.map((f) => ({ ...f, url: new URL(f.url, location.origin).toString() }))
  }

  /** Что изменилось у других в текущей роли — опросом, пока приложение на экране. Своё обновляет emit после шага. */
  subscribe(cb: (e: ShipEvent | null) => void) {
    this.listeners.add(cb)
    if (!this.timer) {
      void this.pulse()
      this.timer = setInterval(() => {
        if (document.visibilityState === 'visible') void this.pulse()
      }, PULSE_MS)
      document.addEventListener('visibilitychange', this.onVisible)
    }
    return () => {
      this.listeners.delete(cb)
      if (!this.listeners.size && this.timer) {
        clearInterval(this.timer)
        this.timer = null
        document.removeEventListener('visibilitychange', this.onVisible)
      }
    }
  }

  private onVisible = () => {
    if (document.visibilityState === 'visible') void this.pulse()
  }

  private async pulse() {
    try {
      // С запасом назад: запись журнала могла закоммититься чуть позже своего времени; повторы отсекаем по id
      const since = this.lastNow ? new Date(Date.parse(this.lastNow) - 10_000).toISOString() : null
      const res = await call<{ now: string; events: ShipEvent[] }>('GET', this.r(since ? `/pulse?since=${encodeURIComponent(since)}` : '/pulse'))
      this.lastNow = res.now
      const fresh = res.events.filter((e) => !this.seen.has(e.id))
      for (const e of fresh) this.seen.add(e.id)
      // Новые сверху: всплывашка о последнем, экраны перечитают всё
      if (fresh.length) this.emit(fresh[0]!)
    } catch {
      // Нет сети — спросим в следующий раз
    }
  }

  private emit(e: ShipEvent | null) {
    for (const cb of this.listeners) cb(e)
  }
}
