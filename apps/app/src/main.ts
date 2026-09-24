import { buildApp } from './app.ts'
import { openDb, readSeed } from './db/boot.ts'
import { seedIfEmpty } from './db/seed.ts'
import { loadEnv } from './env.ts'

const env = loadEnv()
const app = buildApp(env)

if (env.DATABASE_URL) {
  const { db, pool } = await openDb(env.DATABASE_URL)
  if (await seedIfEmpty(db, await readSeed())) app.log.info('база пустая — модели заполнены из сида')
  app.addHook('onClose', () => pool.end())
} else {
  app.log.warn('DATABASE_URL не задан — работаю без базы')
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'остановка')
    app.close().then(() => process.exit(0), () => process.exit(1))
  })
}

await app.listen({ host: '0.0.0.0', port: env.PORT })
