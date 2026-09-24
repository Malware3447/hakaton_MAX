import { buildApp } from './app.ts'
import { loadEnv } from './env.ts'

const env = loadEnv()
const app = buildApp(env)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'остановка')
    app.close().then(() => process.exit(0), () => process.exit(1))
  })
}

await app.listen({ host: '0.0.0.0', port: env.PORT })
