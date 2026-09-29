import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { ROLES, type Role } from '@nk/domain'
import type { RoleInfo } from '../bot/store.ts'
import type { MiniAppActions } from './actions.ts'
import type { Scope } from './access.ts'
import { verifyInitData } from './init-data.ts'
import { ERP_PREFIX, type MeView, type MiniAppReader } from './reader.ts'
import { FileSigner, SessionSigner, type Session } from './session.ts'
import type { Command, Handoff } from './view.ts'

// API мини-приложения (HAKATON-42, план — docs/mini-prilozhenie.md, раздел 4).
// Человек — это его user_id в MAX из проверенного initData; initDataUnsafe сервер не читает.
// Каждый запрос экрана несёт роль (?role=): сервер проверяет, что она у человека есть, и отдаёт
// только данные его организации в этой роли (access.ts). Чужая перевозка — 404, как несуществующая.

export interface MiniAppPeople {
  personByMaxUserId(maxUserId: number): Promise<{ id: string; name: string; activeRole: Role | null } | null>
  roles(personId: string): Promise<RoleInfo[]>
  setActiveRole(personId: string, role: Role | null): Promise<void>
}

/** Чтение для экранов; без базы (тесты входа) хватает me и scope. */
export type MiniAppRead = Pick<MiniAppReader, 'me' | 'scope'> & Partial<Omit<MiniAppReader, 'me' | 'scope'>>

export interface MiniAppDeps {
  botToken: string
  people: MiniAppPeople
  read: MiniAppRead
  /** шаги и сообщения в чат — когда запущен бот; без него приложение только показывает */
  actions?: () => MiniAppActions | null
}

declare module 'fastify' {
  interface FastifyRequest {
    session: Session | null
  }
}

const SessionBody = z.object({ initData: z.string().min(1).max(8192) })
const RoleBody = z.object({ role: z.enum(ROLES) })
const RoleQuery = z.object({ role: z.enum(ROLES) })

const LineCheckBody = z.object({
  sku: z.string().max(100),
  qty: z.number(),
  grossKg: z.number(),
  reason: z.enum(['shortage', 'damage', 'mismatch', 'surplus']).nullable(),
  photos: z.array(z.string().max(2000)).max(20).optional(),
})
const ChecksBody = z.object({ lines: z.array(LineCheckBody).max(300), comment: z.string().max(2000).nullable() })

const CommandBody = z.object({
  command: z.discriminatedUnion('type', [
    z.object({ type: z.literal('carrier.accept') }),
    z.object({ type: z.literal('carrier.decline'), reason: z.string().max(1000) }),
    z.object({ type: z.literal('carrier.assign'), vehicleId: z.string().max(64), driverId: z.string().max(64) }),
    z.object({ type: z.literal('driver.acceptTrip') }),
    z.object({ type: z.literal('driver.arrivedLoading') }),
    z.object({ type: z.literal('driver.arrivedUnloading') }),
  ]),
})

const HandoffBody = z.object({
  handoff: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('card') }),
    z.object({ kind: z.literal('remarks'), remarks: ChecksBody }),
    z.object({ kind: z.literal('acceptance'), acceptance: ChecksBody.extend({ result: z.enum(['full', 'partial', 'refused']) }) }),
    z.object({ kind: z.literal('driverContact'), vehicleId: z.string().max(64).nullable() }),
  ]),
})

const VehicleBody = z.object({
  vehicle: z.object({
    id: z.string().max(64).optional(),
    plate: z.string().max(20),
    brand: z.string().max(100),
    ownership: z.enum(['own', 'lease', 'rent', 'other']),
    ownerName: z.string().max(200).nullable().optional(),
    bodyType: z.string().max(50).nullable(),
    capacityT: z.number().nullable(),
    volumeM3: z.number().nullable(),
  }),
})

const CompanyBody = z.object({
  name: z.string().max(300).optional(),
  address: z.string().max(500).optional(),
  poa: z.object({ number: z.string().max(100), validTo: z.string().max(40) }).optional(),
})

const NO_BOT = { error: 'bot_off', message: 'Бот сейчас не запущен: шаги и документы недоступны, можно только смотреть' }

export function registerMiniAppApi(app: FastifyInstance, deps: MiniAppDeps) {
  const signer = new SessionSigner(deps.botToken)
  const files = new FileSigner(deps.botToken)
  const actions = () => deps.actions?.() ?? null

  app.decorateRequest('session', null)
  app.addHook('onRequest', async (req) => {
    const auth = req.headers.authorization
    if (auth?.startsWith('Bearer ')) req.session = signer.verify(auth.slice(7))
  })

  const need = (req: FastifyRequest) => {
    if (!req.session) throw Object.assign(new Error('нужна сессия'), { statusCode: 401 })
    return req.session
  }

  /** Роль из ?role= и организации человека в ней. Нет такой роли — 403, ответ уже отправлен. */
  const scoped = async (req: FastifyRequest, reply: FastifyReply, fixed?: Role): Promise<Scope | null> => {
    const s = need(req)
    const q = RoleQuery.safeParse(fixed ? { role: fixed } : req.query)
    if (!q.success) {
      await reply.code(400).send({ error: 'bad_request', message: 'не указана роль' })
      return null
    }
    const scope = await deps.read.scope(s.personId, q.data.role)
    if (!scope) {
      await reply.code(403).send({ error: 'no_such_role', message: 'У вас нет этой роли' })
      return null
    }
    return scope
  }

  const reader = <K extends keyof MiniAppReader>(k: K): MiniAppReader[K] => {
    const fn = deps.read[k]
    if (!fn) throw Object.assign(new Error(`нет чтения ${String(k)}`), { statusCode: 503 })
    return (fn as (...a: unknown[]) => unknown).bind(deps.read) as MiniAppReader[K]
  }

  // ---------- вход и роль ----------

  app.post('/api/session', async (req, reply) => {
    const body = SessionBody.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'bad_request' })
    const init = verifyInitData(body.data.initData, deps.botToken)
    if (!init) return reply.code(401).send({ error: 'bad_init_data' })
    const person = await deps.people.personByMaxUserId(init.user.id)
    // Кто ещё не запускал бота, тот сначала подключается в чате: роли и организации заводятся там
    if (!person) return { registered: false, startParam: init.startParam }
    const { token, expiresAt } = signer.issue(person.id, init.user.id)
    return { registered: true, token, expiresAt: expiresAt.toISOString(), startParam: init.startParam, me: await deps.read.me(person.id) }
  })

  app.get('/api/me', async (req, reply) => {
    const s = need(req)
    const person = await deps.people.personByMaxUserId(s.maxUserId)
    if (!person || person.id !== s.personId) return reply.code(401).send({ error: 'unknown_person' })
    return (await deps.read.me(person.id)) satisfies MeView | null
  })

  // Текущая роль общая с ботом: та же запись person.active_role
  app.put('/api/me/role', async (req, reply) => {
    const s = need(req)
    const body = RoleBody.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'bad_request' })
    const roles = await deps.people.roles(s.personId)
    if (!roles.some((r) => r.role === body.data.role)) return reply.code(403).send({ error: 'no_such_role' })
    await deps.people.setActiveRole(s.personId, body.data.role)
    return deps.read.me(s.personId)
  })

  // ---------- перевозки ----------

  app.get('/api/shipments', async (req, reply) => {
    const scope = await scoped(req, reply)
    if (!scope) return reply
    return reader('list')(scope)
  })

  app.get('/api/shipments/:id', async (req, reply) => {
    const scope = await scoped(req, reply)
    if (!scope) return reply
    const id = decodeURIComponent((req.params as { id: string }).id)
    if (id.startsWith(ERP_PREFIX)) {
      // Отгрузка учётной системы: открыть её — то же, что нажать в списке бота; без бота — только посмотреть
      const ref = id.slice(ERP_PREFIX.length)
      const opened = await actions()?.openErp(scope, ref)
      const shipment = opened ? await reader('shipment')(scope, opened) : await reader('erpDraft')(scope, ref)
      return shipment ?? reply.code(404).send({ error: 'not_found', message: 'Перевозка не найдена' })
    }
    const shipment = await reader('shipment')(scope, id)
    return shipment ?? reply.code(404).send({ error: 'not_found', message: 'Перевозка не найдена' })
  })

  app.post('/api/shipments/:id/commands', async (req, reply) => {
    const scope = await scoped(req, reply)
    if (!scope) return reply
    const act = actions()
    if (!act) return reply.code(503).send(NO_BOT)
    const type = (req.body as { command?: { type?: unknown } } | null)?.command?.type
    if (typeof type === 'string' && !CommandBody.shape.command.options.some((o) => o.shape.type.value === type)) {
      return reply.code(400).send({ error: 'chat_only', message: 'Этот шаг делается кнопкой в чате с ботом' })
    }
    const body = CommandBody.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'bad_request', message: 'Неверный запрос' })
    const id = (req.params as { id: string }).id
    const res = await act.command(scope, id, body.data.command as Command)
    if (!res.ok) return reply.code(res.status).send({ error: res.error, message: res.message })
    // После отказа перевозчик перевозку уже не видит — тогда null
    return { chat: Boolean(res.chat), shipment: res.chat ? null : await reader('shipment')(scope, id) }
  })

  app.post('/api/shipments/:id/handoff', async (req, reply) => {
    const scope = await scoped(req, reply)
    if (!scope) return reply
    const act = actions()
    if (!act) return reply.code(503).send(NO_BOT)
    const body = HandoffBody.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'bad_request', message: 'Неверный запрос' })
    const res = await act.handoff(scope, (req.params as { id: string }).id, body.data.handoff as Handoff)
    if (!res.ok) return reply.code(res.status).send({ error: res.error, message: res.message })
    return { chat: true }
  })

  app.get('/api/shipments/:id/qr', async (req, reply) => {
    const scope = await scoped(req, reply)
    if (!scope) return reply
    const act = actions()
    if (!act) return reply.code(503).send(NO_BOT)
    const gif = await act.qr(scope, (req.params as { id: string }).id)
    if (!gif) return reply.code(404).send({ error: 'not_found', message: 'QR-кода пока нет: он появится после регистрации накладной в ГИС ЭПД (модель)' })
    return reply.header('content-type', 'image/gif').header('cache-control', 'no-store').send(Buffer.from(gif))
  })

  app.get('/api/shipments/:id/files', async (req, reply) => {
    const scope = await scoped(req, reply)
    if (!scope) return reply
    const shipmentId = (req.params as { id: string }).id
    const list = await reader('files')(scope, shipmentId)
    // Подпись — в параметре запроса: в пути Fastify не пускает параметры длиннее 100 символов
    return list.map((f) => ({ label: f.label, name: f.name, url: `/api/files?t=${files.issue({ shipmentId, kind: f.kind, id: f.id, name: f.name })}` }))
  })

  // Скачивание по подписанной ссылке: MAX (WebApp.downloadFile) приходит без заголовка сессии
  app.get('/api/files', async (req, reply) => {
    const ref = files.verify(String((req.query as { t?: string }).t ?? ''))
    if (!ref) return reply.code(404).send({ error: 'not_found', message: 'Ссылка устарела — откройте документы заново' })
    const file = await reader('fileBytes')(ref.shipmentId, ref.kind, ref.id)
    if (!file) return reply.code(404).send({ error: 'not_found' })
    return reply
      .header('content-type', file.type)
      .header('content-disposition', `attachment; filename="${ref.name.replace(/[^\w.-]/g, '_')}"`)
      .header('cache-control', 'no-store')
      .send(Buffer.from(file.bytes))
  })

  app.get('/api/carriers', async (req, reply) => {
    const scope = await scoped(req, reply)
    if (!scope) return reply
    return reader('carriers')(scope)
  })

  // ---------- перевозчик: машины и водители ----------

  app.get('/api/fleet/vehicles', async (req, reply) => {
    const scope = await scoped(req, reply, 'carrier')
    if (!scope) return reply
    return reader('vehicles')(scope)
  })

  app.post('/api/fleet/vehicles', async (req, reply) => {
    const scope = await scoped(req, reply, 'carrier')
    if (!scope) return reply
    const act = actions()
    if (!act) return reply.code(503).send(NO_BOT)
    const body = VehicleBody.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'bad_request', message: 'Неверный запрос' })
    const res = await act.saveVehicle(scope, { ...body.data.vehicle, ownerName: body.data.vehicle.ownerName ?? null })
    if (!res.ok) return reply.code(res.status).send({ error: res.error, message: res.message })
    return reader('vehicles')(scope)
  })

  app.get('/api/fleet/drivers', async (req, reply) => {
    const scope = await scoped(req, reply, 'carrier')
    if (!scope) return reply
    return reader('drivers')(scope)
  })

  // ---------- компания ----------

  app.get('/api/company', async (req, reply) => {
    const scope = await scoped(req, reply)
    if (!scope) return reply
    const company = await reader('company')(scope)
    return company ?? reply.code(404).send({ error: 'not_found', message: 'Компания не подключена' })
  })

  app.put('/api/company', async (req, reply) => {
    const scope = await scoped(req, reply)
    if (!scope) return reply
    const act = actions()
    if (!act) return reply.code(503).send(NO_BOT)
    const body = CompanyBody.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'bad_request', message: 'Неверный запрос' })
    const res = await act.saveCompany(scope, body.data)
    if (!res.ok) return reply.code(res.status).send({ error: res.error, message: res.message })
    return reader('company')(scope)
  })

  // ---------- раздел событий и живое обновление (у каждой роли свои) ----------

  app.get('/api/notices', async (req, reply) => {
    const scope = await scoped(req, reply)
    if (!scope) return reply
    return reader('notices')(scope)
  })

  app.post('/api/notices/read', async (req, reply) => {
    const scope = await scoped(req, reply)
    if (!scope) return reply
    await reader('markRead')(scope)
    return { ok: true }
  })

  // Опрос раз в несколько секунд: что случилось у других с прошлого раза
  app.get('/api/pulse', async (req, reply) => {
    const scope = await scoped(req, reply)
    if (!scope) return reply
    const now = new Date()
    const since = Date.parse(String((req.query as { since?: string }).since ?? ''))
    if (Number.isNaN(since)) return { now: now.toISOString(), events: [] }
    return { now: now.toISOString(), events: await reader('pulse')(scope, new Date(since)) }
  })
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
}

/**
 * Сборка мини-приложения по /app. Файлы из assets/ с хешем в имени кэшируются надолго,
 * index.html — никогда, чтобы новая выкладка подхватывалась сразу. Неизвестный путь — index.html
 * (маршруты внутри приложения).
 */
export function registerMiniAppStatic(app: FastifyInstance, dir: string) {
  const root = normalize(dir + sep)
  const indexHtml = async () => readFile(join(root, 'index.html')).catch(() => null)

  app.get('/app', (_req, reply) => reply.redirect('/app/'))
  app.get('/app/*', async (req, reply) => {
    const rel = decodeURIComponent((req.params as { '*': string })['*'] ?? '')
    const path = normalize(join(root, rel))
    if (path.startsWith(root) && rel && (await stat(path).then((s) => s.isFile(), () => false))) {
      const type = TYPES[extname(path)] ?? 'application/octet-stream'
      const immutable = rel.startsWith('assets/')
      return reply
        .header('content-type', type)
        .header('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache')
        .send(await readFile(path))
    }
    if (extname(rel)) return reply.code(404).send()
    const html = await indexHtml()
    if (!html) return reply.code(503).type('text/plain; charset=utf-8').send('Мини-приложение не собрано: npm run build -w @nk/miniapp')
    return reply.header('content-type', TYPES['.html']!).header('cache-control', 'no-cache').send(html)
  })
}
