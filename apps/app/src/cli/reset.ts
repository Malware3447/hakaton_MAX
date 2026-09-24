// Сброс демо одной командой: npm run db:reset
import { openDb, readSeed } from '../db/boot.ts'
import { resetDemo } from '../db/seed.ts'
import { loadEnv } from '../env.ts'

const env = loadEnv()
if (!env.DATABASE_URL) throw new Error('DATABASE_URL не задан')
const { db, pool } = await openDb(env.DATABASE_URL)
const result = await resetDemo(db, await readSeed())
console.log(`демо сброшено: организаций в справочнике ${result.orgs}, отгрузок в учётной системе ${result.shipments}`)
await pool.end()
