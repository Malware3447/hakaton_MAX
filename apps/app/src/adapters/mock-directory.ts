import { eq } from 'drizzle-orm'
import type { OrgDirectory, OrgRequisites } from '@nk/domain'
import type { Db } from '../db/client.ts'
import { mockOrgRegistry } from '../db/schema.ts'

/** Демо-данные завода (mock.org_registry): вымышленные ИНН сценария показа. В цепочке — первыми. */
export class MockDirectory implements OrgDirectory {
  constructor(private readonly db: Db) {}

  async findByInn(inn: string): Promise<OrgRequisites | null> {
    const [row] = await this.db.select().from(mockOrgRegistry).where(eq(mockOrgRegistry.inn, inn)).limit(1)
    return row ? { ...row, source: 'demo', status: 'active' } : null
  }
}
