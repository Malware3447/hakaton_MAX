import { describe, expect, it } from 'vitest'
import { buildApp } from './app.ts'
import { loadEnv } from './env.ts'

describe('каркас приложения', () => {
  it('отвечает на /healthz без .env', async () => {
    const app = buildApp(loadEnv({ LOG_LEVEL: 'silent' }))
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, maxMode: 'off' })
  })

  it('вебхук пускает только с верным секретом', async () => {
    const env = loadEnv({ MAX_MODE: 'webhook', MAX_BOT_TOKEN: 't', MAX_WEBHOOK_SECRET: 's3cret', LOG_LEVEL: 'silent' })
    const app = buildApp(env)
    const wrong = await app.inject({ method: 'POST', url: '/bot/webhook', headers: { 'x-max-bot-api-secret': 'nope' }, payload: {} })
    const right = await app.inject({ method: 'POST', url: '/bot/webhook', headers: { 'x-max-bot-api-secret': 's3cret' }, payload: {} })
    expect(wrong.statusCode).toBe(401)
    expect(right.statusCode).toBe(200)
  })

  it('без токена в режиме webhook не стартует', () => {
    expect(() => loadEnv({ MAX_MODE: 'webhook' })).toThrow()
  })
})
