import { eq } from 'drizzle-orm'
import type { OrgDirectory, OrgRequisites } from '@nk/domain'
import type { Db } from '../db/client.ts'
import { mockOrgRegistry } from '../db/schema.ts'

/** Справочник организаций — модель на таблице mock.org_registry. Доводит Егор в HAKATON-38. */
export class MockDirectory implements OrgDirectory {
  constructor(private readonly db: Db) {}

  async findByInn(inn: string): Promise<OrgRequisites | null> {
    const [row] = await this.db.select().from(mockOrgRegistry).where(eq(mockOrgRegistry.inn, inn)).limit(1)
    return row ?? null
  }
}
