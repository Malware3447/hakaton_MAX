import { MockDirectory } from './adapters/mock-directory.ts'
import { ChainDirectory, DadataDirectory } from './adapters/dadata-directory.ts'
import { MockErp } from './adapters/mock-erp.ts'
import { buildApp, type AppDeps } from './app.ts'
import { Bot } from './bot/bot.ts'
import { BotStore } from './bot/store.ts'
import { CardStore } from './bot/card-store.ts'
import { FleetService } from './core/fleet.ts'
import { InviteService } from './core/invite-service.ts'
import { ShipmentService } from './core/shipments.ts'
import { TitleService } from './core/titles.ts'
import { SignatureService } from './core/signatures.ts'
import { openDb, readSeed } from './db/boot.ts'
import { seedIfEmpty } from './db/seed.ts'
import { loadEnv } from './env.ts'
import { Jobs } from './jobs/jobs.ts'
import { MaxApi } from './max/api.ts'
import { MaxMessenger } from './max/messenger.ts'
import { startPolling } from './max/polling.ts'
import { Inbox } from './bot/inbox.ts'

const env = loadEnv()
const deps: AppDeps = {}
const app = buildApp(env, deps)

const stops: (() => unknown)[] = []

if (env.DATABASE_URL) {
  const { db, pool } = await openDb(env.DATABASE_URL)
  if (await seedIfEmpty(db, await readSeed())) app.log.info('база пустая — модели заполнены из сида')
  stops.push(() => pool.end())

  if (env.MAX_MODE !== 'off' && env.MAX_BOT_TOKEN) {
    const api = new MaxApi(env.MAX_BOT_TOKEN)
    const messenger = new MaxMessenger(api)
    const me = await api.getMe()
    // Справочник организаций: сначала демо-данные сценария, потом ЕГРЮЛ через DaData (если есть ключ)
    const directory = env.DADATA_API_KEY
      ? new ChainDirectory([new MockDirectory(db), new DadataDirectory(env.DADATA_API_KEY, app.log)])
      : new MockDirectory(db)
    if (!env.DADATA_API_KEY) app.log.warn('DADATA_API_KEY не задан — справочник знает только демо-организации')
    const erp = new MockErp(db)

    // Очередь заданий: уведомления участникам и последствия переходов (учётка, оператор, QR)
    const cards = new CardStore(db)
    const jobs = new Jobs(Jobs.create(env.DATABASE_URL), db, messenger, erp, cards, app.log)
    const webhook =
      env.MAX_MODE === 'webhook' && env.PUBLIC_URL && env.MAX_WEBHOOK_SECRET
        ? { api, url: new URL('/bot/webhook', env.PUBLIC_URL).toString(), secret: env.MAX_WEBHOOK_SECRET }
        : undefined

    const shipments = new ShipmentService(db, erp, directory, jobs)
    const bot = new Bot(
      new BotStore(db),
      messenger,
      directory,
      shipments,
      new InviteService(db),
      new FleetService(db),
      jobs,
      cards,
      // Проверка подписи «Госключа» — модуль Егора (HAKATON-41); до слияния — только демо-подпись
      { titles: new TitleService(db), signatures: new SignatureService(db), verifier: null },
      env.MAX_BOT_TOKEN,
      me.username,
      app.log,
    )
    await api
      .setCommands([
        { name: 'menu', description: 'Меню ролей' },
        { name: 'start', description: 'Начать сначала' },
        { name: 'help', description: 'Как пользоваться' },
      ])
      .catch((err) => app.log.warn({ err }, 'не удалось задать команды бота'))

    jobs.onEffect('inviteConsignee', (id) => bot.consigneeArrival(id))

    // Все обновления — через inbox: повторы MAX отсекаются, упавшие повторяются раз в минуту
    const inbox = new Inbox(db, (u) => bot.handle(u), app.log)
    await jobs.start({ webhook, inboxRetry: () => inbox.retryPending() })
    stops.unshift(() => jobs.stop())

    if (env.MAX_MODE === 'polling') {
      stops.unshift(startPolling(api, (u) => inbox.ingest(u), app.log))
      app.log.info('бот слушает MAX в режиме polling')
    } else {
      deps.onUpdate = (u) => inbox.ingest(u)
    }
  }
} else {
  app.log.warn('DATABASE_URL не задан — работаю без базы')
}

app.addHook('onClose', async () => {
  for (const stop of stops) await stop()
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'остановка')
    app.close().then(() => process.exit(0), () => process.exit(1))
  })
}

await app.listen({ host: '0.0.0.0', port: env.PORT })
