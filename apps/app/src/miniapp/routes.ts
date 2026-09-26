import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { ROLES, type Role, type WaitingItem } from '@nk/domain'
import { ROLE_TITLE } from '../bot/screens.ts'
import type { RoleInfo } from '../bot/store.ts'
import { verifyInitData } from './init-data.ts'
import { SessionSigner, type Session } from './session.ts'

// API мини-приложения (HAKATON-42, план — docs/mini-prilozhenie.md, раздел 4).
// Человек — это его user_id в MAX из проверенного initData; initDataUnsafe сервер не читает.

export interface MiniAppPeople {
  personByMaxUserId(maxUserId: number): Promise<{ id: string; name: string; activeRole: Role | null } | null>
  roles(personId: string): Promise<RoleInfo[]>
  setActiveRole(personId: string, role: Role | null): Promise<void>
}

export interface MiniAppDeps {
  botToken: string
  people: MiniAppPeople
  waiting(personId: string): Promise<WaitingItem[]>
}

export interface MeResponse {
  person: { name: string }
  activeRole: Role | null
  roles: { role: Role; title: string; orgName: string | null; waiting: number }[]
}

declare module 'fastify' {
  interface FastifyRequest {
    session: Session | null
  }
}

const SessionBody = z.object({ initData: z.string().min(1).max(8192) })
const RoleBody = z.object({ role: z.enum(ROLES) })

export function registerMiniAppApi(app: FastifyInstance, deps: MiniAppDeps) {
  const signer = new SessionSigner(deps.botToken)

  app.decorateRequest('session', null)
  app.addHook('onRequest', async (req) => {
    const auth = req.headers.authorization
    if (auth?.startsWith('Bearer ')) req.session = signer.verify(auth.slice(7))
  })

  const need = (req: FastifyRequest) => {
    if (!req.session) throw Object.assign(new Error('нужна сессия'), { statusCode: 401 })
    return req.session
  }

  app.post('/api/session', async (req, reply) => {
    const body = SessionBody.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'bad_request' })
    const init = verifyInitData(body.data.initData, deps.botToken)
    if (!init) return reply.code(401).send({ error: 'bad_init_data' })
    const person = await deps.people.personByMaxUserId(init.user.id)
    // Кто ещё не запускал бота, тот сначала подключается в чате: роли и организации заводятся там
    if (!person) return { registered: false, startParam: init.startParam }
    const { token, expiresAt } = signer.issue(person.id, init.user.id)
    return { registered: true, token, expiresAt: expiresAt.toISOString(), startParam: init.startParam, me: await describe(deps, person) }
  })

  app.get('/api/me', async (req, reply) => {
    const s = need(req)
    const person = await deps.people.personByMaxUserId(s.maxUserId)
    if (!person || person.id !== s.personId) return reply.code(401).send({ error: 'unknown_person' })
    return describe(deps, person)
  })

  // Текущая роль общая с ботом: та же запись person.active_role
  app.put('/api/me/role', async (req, reply) => {
    const s = need(req)
    const body = RoleBody.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'bad_request' })
    const roles = await deps.people.roles(s.personId)
    if (!roles.some((r) => r.role === body.data.role)) return reply.code(403).send({ error: 'no_such_role' })
    await deps.people.setActiveRole(s.personId, body.data.role)
    const person = await deps.people.personByMaxUserId(s.maxUserId)
    return describe(deps, person!)
  })
}

async function describe(deps: MiniAppDeps, person: { id: string; name: string; activeRole: Role | null }): Promise<MeResponse> {
  const [roles, waiting] = await Promise.all([deps.people.roles(person.id), deps.waiting(person.id)])
  return {
    person: { name: person.name },
    activeRole: person.activeRole,
    roles: roles.map((r) => ({
      role: r.role,
      title: ROLE_TITLE[r.role],
      orgName: r.org?.name ?? null,
      waiting: waiting.filter((w) => w.role === r.role).length,
    })),
  }
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
