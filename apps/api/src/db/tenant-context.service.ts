import { Inject, Injectable } from '@nestjs/common'
import type pg from 'pg'
import { APP_POOL, type Db } from './client.js'
import { runInTenant } from './tenant-context.js'

@Injectable()
export class TenantContextService {
  constructor(@Inject(APP_POOL) private readonly pool: pg.Pool) {}

  run<T>(tenantId: string, work: (db: Db) => Promise<T>): Promise<T> {
    return runInTenant(this.pool, tenantId, work)
  }
}
