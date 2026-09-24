import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import * as schema from './schema.ts'

export type Db = ReturnType<typeof createDb>['db']

export function createDb(url: string) {
  const pool = new pg.Pool({ connectionString: url, max: 10 })
  const db = drizzle(pool, { schema })
  return { pool, db }
}

export async function runMigrations(db: Db, migrationsFolder: string): Promise<void> {
  await migrate(db, { migrationsFolder })
}
