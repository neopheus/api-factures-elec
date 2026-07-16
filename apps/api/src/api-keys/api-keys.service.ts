import { Injectable, NotFoundException } from '@nestjs/common'
import { desc, eq } from 'drizzle-orm'
import { generateApiKey } from '../auth/api-key.js'
import { ProblemType, problem } from '../common/problem.js'
import { isUuid } from '../common/uuid.js'
import { apiKeys } from '../db/schema.js'
// biome-ignore lint/style/useImportType: TenantContextService est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { TenantContextService } from '../db/tenant-context.service.js'

export interface ApiKeyView {
  id: string
  prefix: string
  label: string
  createdAt: Date
  lastUsedAt: Date | null
  revokedAt: Date | null
}

const VIEW = {
  id: apiKeys.id,
  prefix: apiKeys.prefix,
  label: apiKeys.label,
  createdAt: apiKeys.createdAt,
  lastUsedAt: apiKeys.lastUsedAt,
  revokedAt: apiKeys.revokedAt,
} as const

@Injectable()
export class ApiKeysService {
  constructor(private readonly tenant: TenantContextService) {}

  async create(
    tenantId: string,
    label: string,
  ): Promise<ApiKeyView & { token: string }> {
    const key = await generateApiKey()
    return this.tenant.run(tenantId, async (db) => {
      const [row] = await db
        .insert(apiKeys)
        .values({
          tenantId,
          prefix: key.prefix,
          secretHash: key.secretHash,
          label,
        })
        .returning(VIEW)
      return { ...(row as ApiKeyView), token: key.token }
    })
  }

  list(tenantId: string): Promise<ApiKeyView[]> {
    return this.tenant.run(tenantId, (db) =>
      db.select(VIEW).from(apiKeys).orderBy(desc(apiKeys.createdAt)),
    ) as Promise<ApiKeyView[]>
  }

  async revoke(tenantId: string, id: string): Promise<void> {
    if (!isUuid(id)) throw this.notFound()
    const revoked = await this.tenant.run(tenantId, (db) =>
      db
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(eq(apiKeys.id, id))
        .returning({ id: apiKeys.id }),
    )
    if (revoked.length === 0) throw this.notFound() // RLS : clé d'un autre tenant → 0 ligne → 404
  }

  private notFound(): NotFoundException {
    return new NotFoundException(
      problem(404, ProblemType.notFound, 'Not Found', {
        detail: 'API key not found',
      }),
    )
  }
}
