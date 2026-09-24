import { timingSafeEqual } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { DOMAIN_VERSION } from '@nk/domain'
import type { Env } from './env.ts'

function safeEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export function buildApp(env: Env): FastifyInstance {
  const app = Fastify({
    bodyLimit: 1024 * 1024,
    logger: {
      level: env.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers["x-max-bot-api-secret"]'],
    },
  })

  app.get('/healthz', async () => ({ ok: true, maxMode: env.MAX_MODE, domain: DOMAIN_VERSION }))

  // Вебхук MAX. Сейчас только проверяет секрет и отвечает 200.
  // Запись в inbox и обработка — HAKATON-25.
  app.post('/bot/webhook', async (req, reply) => {
    if (env.MAX_MODE !== 'webhook') return reply.code(404).send()
    const secret = req.headers['x-max-bot-api-secret']
    if (!safeEqual(typeof secret === 'string' ? secret : undefined, env.MAX_WEBHOOK_SECRET)) {
      return reply.code(401).send()
    }
    return reply.code(200).send('ok')
  })

  app.get('/api/ping', async () => ({ pong: true }))

  return app
}
