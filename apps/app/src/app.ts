import { timingSafeEqual } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { DOMAIN_VERSION } from '@nk/domain'
import type { Env } from './env.ts'
import type { MaxUpdate } from './max/types.ts'

function safeEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export interface AppDeps {
  /** обработчик обновлений MAX для режима webhook */
  onUpdate?: (update: MaxUpdate) => Promise<void>
}

export function buildApp(env: Env, deps: AppDeps = {}): FastifyInstance {
  const app = Fastify({
    bodyLimit: 1024 * 1024,
    logger: {
      level: env.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers["x-max-bot-api-secret"]'],
    },
  })

  app.get('/healthz', async () => ({ ok: true, maxMode: env.MAX_MODE, domain: DOMAIN_VERSION }))

  // Вебхук MAX: проверяем секрет, отвечаем 200 сразу, обрабатываем после.
  // Запись в inbox с дедупликацией и повторами — HAKATON-25.
  app.post('/bot/webhook', async (req, reply) => {
    if (env.MAX_MODE !== 'webhook') return reply.code(404).send()
    const secret = req.headers['x-max-bot-api-secret']
    if (!safeEqual(typeof secret === 'string' ? secret : undefined, env.MAX_WEBHOOK_SECRET)) {
      return reply.code(401).send()
    }
    await reply.code(200).send('ok')
    const update = req.body as MaxUpdate
    if (deps.onUpdate) {
      setImmediate(() => deps.onUpdate!(update).catch((err) => req.log.error({ err }, 'ошибка обработки обновления')))
    }
  })

  app.get('/api/ping', async () => ({ pong: true }))

  return app
}
