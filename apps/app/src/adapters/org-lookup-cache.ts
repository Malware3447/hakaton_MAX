import type { OrgRequisites } from '@nk/domain'
import type { Db } from '../db/client.ts'
import { orgLookupCache } from '../db/schema.ts'
import type { OrgLookupCache } from './dadata-directory.ts'
import { eq } from 'drizzle-orm'

/** Кэш ответов DaData в таблице org_lookup_cache. Сброс демо его не трогает: это данные ЕГРЮЛ, а не сценария. */
export class OrgLookupCacheDb implements OrgLookupCache {
  constructor(private readonly db: Db) {}

  async get(inn: string) {
    const [row] = await this.db.select().from(orgLookupCache).where(eq(orgLookupCache.inn, inn))
    return row ? { found: row.found as OrgRequisites | null, fetchedAt: row.fetchedAt } : null
  }

  async put(inn: string, found: OrgRequisites | null) {
    const value = { found: found as Record<string, unknown> | null, fetchedAt: new Date() }
    await this.db.insert(orgLookupCache).values({ inn, ...value }).onConflictDoUpdate({ target: orgLookupCache.inn, set: value })
  }
}
