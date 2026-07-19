import type pg from 'pg'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminSupervisionRepository } from '../../src/admin/admin-supervision.repository.js'
import type { TenantContextService } from '../../src/db/tenant-context.service.js'

// Task 6 (spec §3) : `anomalies`/`anomaliesForTenant` — mapping snake_case
// → camelCase et forme des requêtes SQL (SD 2 find_admin_anomalies), sur un
// pool `pg` mocké. Contrairement à `tenantStats`/`tenantDetail`/`suspend`/
// `unsuspend` (jamais unit-testés avec un pool mocké, motif
// admin.service.test.ts : couverts par tests/e2e/admin-supervision.e2e.test.ts
// contre un vrai Postgres, car ils passent par `tenant.run`/RLS), ces 2
// méthodes n'utilisent QUE le pool applicatif direct (SD SECURITY DEFINER,
// cross-tenant par nature) — un mock suffit à couvrir le mapping et la
// forme de la requête, la SD elle-même (borne/tri/union) restant vérifiée
// par l'e2e contre un vrai Postgres.
describe('AdminSupervisionRepository — anomalies (Task 6)', () => {
  let query: ReturnType<typeof vi.fn>
  let repo: AdminSupervisionRepository

  beforeEach(() => {
    query = vi.fn()
    repo = new AdminSupervisionRepository(
      { query } as unknown as pg.Pool,
      {} as unknown as TenantContextService, // non utilisé : ni méthode n'appelle tenant.run
    )
  })

  describe('anomalies', () => {
    it('calls find_admin_anomalies($1) with the given limit and maps rows camelCase', async () => {
      query.mockResolvedValue({
        rows: [
          {
            kind: 'dead_letter',
            tenant_id: 't1',
            ref_id: 'dl1',
            detail: 'poison invoice',
            created_at: new Date('2026-07-19T10:00:00Z'),
          },
          {
            kind: 'cdv_parked',
            tenant_id: 't2',
            ref_id: 'tr1',
            detail: 'parked',
            created_at: new Date('2026-07-18T10:00:00Z'),
          },
        ],
      })

      const result = await repo.anomalies(50)

      expect(query.mock.calls[0]![0]).toContain('find_admin_anomalies($1)')
      expect(query.mock.calls[0]![1]).toEqual([50])
      expect(result).toEqual([
        {
          kind: 'dead_letter',
          tenantId: 't1',
          refId: 'dl1',
          detail: 'poison invoice',
          createdAt: new Date('2026-07-19T10:00:00Z'),
        },
        {
          kind: 'cdv_parked',
          tenantId: 't2',
          refId: 'tr1',
          detail: 'parked',
          createdAt: new Date('2026-07-18T10:00:00Z'),
        },
      ])
    })

    it('returns an empty array when the SD yields no row', async () => {
      query.mockResolvedValue({ rows: [] })

      const result = await repo.anomalies(50)

      expect(result).toEqual([])
    })
  })

  // Couture différée de la Task 3 (Task 6, spec §3) : borne à 20 + filtre
  // per-tenant posés EN SQL, sur la SD appelée avec la borne haute 200
  // (même plafond public que GET /admin/anomalies) — cf. commentaire
  // `anomaliesForTenant` (repository) pour la limite acceptée documentée.
  describe('anomaliesForTenant', () => {
    it('calls find_admin_anomalies with the 200 SD ceiling, filters by tenant_id and caps to 20 — all posed in SQL', async () => {
      query.mockResolvedValue({ rows: [] })

      await repo.anomaliesForTenant('t1')

      const [sql, params] = query.mock.calls[0]!
      expect(sql).toContain('find_admin_anomalies($1)')
      expect(sql).toContain('WHERE a.tenant_id = $2')
      expect(sql).toContain('LIMIT $3')
      expect(params).toEqual([200, 't1', 20])
    })

    it('maps rows camelCase, same shape as anomalies()', async () => {
      query.mockResolvedValue({
        rows: [
          {
            kind: 'ereporting_failed',
            tenant_id: 't1',
            ref_id: 'er1',
            detail: 'rejetee',
            created_at: new Date('2026-07-19T09:00:00Z'),
          },
        ],
      })

      const result = await repo.anomaliesForTenant('t1')

      expect(result).toEqual([
        {
          kind: 'ereporting_failed',
          tenantId: 't1',
          refId: 'er1',
          detail: 'rejetee',
          createdAt: new Date('2026-07-19T09:00:00Z'),
        },
      ])
    })
  })
})
