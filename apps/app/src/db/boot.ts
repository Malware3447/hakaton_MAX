import { readFile } from 'node:fs/promises'
import { MIGRATIONS_DIR, SEED_PATH } from '../paths.ts'
import { createDb, runMigrations } from './client.ts'
import type { PlantSeed } from './seed.ts'

export async function readSeed(path = SEED_PATH): Promise<PlantSeed> {
  return JSON.parse(await readFile(path, 'utf8')) as PlantSeed
}

/** Подключиться к базе и накатить миграции. */
export async function openDb(url: string) {
  const conn = createDb(url)
  await runMigrations(conn.db, MIGRATIONS_DIR)
  return conn
}
