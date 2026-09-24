import { MockDirectory } from './adapters/mock-directory.ts'
import { MockErp } from './adapters/mock-erp.ts'
import { ShipmentService } from './core/shipments.ts'
import { buildApp, type AppDeps } from './app.ts'
import { Bot } from './bot/bot.ts'
import { BotStore } from './bot/store.ts'
import { openDb, readSeed } from './db/boot.ts'
import { seedIfEmpty } from './db/seed.ts'
import { loadEnv } from './env.ts'
import { MaxApi } from './max/api.ts'
import { MaxMessenger } from './max/messenger.ts'
import { startPolling } from './max/polling.ts'

const env = loadEnv()
const deps: AppDeps = {}
const app = buildApp(env, deps)

let stopPolling: (() => void) | undefined

if (env.DATABASE_URL) {
  const { db, pool } = await openDb(env.DATABASE_URL)
  if (await seedIfEmpty(db, await readSeed())) app.log.info('база пустая — модели заполнены из сида')
  app.addHook('onClose', () => pool.end())

  if (env.MAX_MODE !== 'off' && env.MAX_BOT_TOKEN) {
    const api = new MaxApi(env.MAX_BOT_TOKEN)
    const me = await api.getMe()
    const directory = new MockDirectory(db)
    const shipments = new ShipmentService(db, new MockErp(db), directory)
    const bot = new Bot(new BotStore(db), new MaxMessenger(api), directory, shipments, me.username, app.log)
    await api
      .setCommands([
        { name: 'menu', description: 'Меню ролей' },
        { name: 'start', description: 'Начать сначала' },
        { name: 'help', description: 'Как пользоваться' },
      ])
      .catch((err) => app.log.warn({ err }, 'не удалось задать команды бота'))
    if (env.MAX_MODE === 'polling') {
      stopPolling = startPolling(api, (u) => bot.handle(u), app.log)
      app.log.info('бот слушает MAX в режиме polling')
    } else {
      deps.onUpdate = (u) => bot.handle(u)
    }
  }
} else {
  app.log.warn('DATABASE_URL не задан — работаю без базы')
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'остановка')
    stopPolling?.()
    app.close().then(() => process.exit(0), () => process.exit(1))
  })
}

await app.listen({ host: '0.0.0.0', port: env.PORT })
