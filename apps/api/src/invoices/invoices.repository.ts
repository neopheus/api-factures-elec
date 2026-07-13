import type { Invoice } from '@factelec/invoice-core'
import { Injectable } from '@nestjs/common'
import { invoiceFormats, invoices } from '../db/schema.js'
// biome-ignore lint/style/useImportType: TenantContextService est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { TenantContextService } from '../db/tenant-context.service.js'
import type { GeneratedFormat } from './format-generator.port.js'

@Injectable()
export class InvoicesRepository {
  constructor(private readonly tenant: TenantContextService) {}

  // Persiste la facture + tous ses formats dans UNE transaction tenant (RLS).
  // Idempotence : PAS de existsByNumber ici (TOCTOU) — l'unicité repose sur la
  // contrainte unique(tenant_id, number) en base ; le service catche l'erreur
  // pg 23505 et la traduit en 409 (cf. InvoicesService.ingest). Cf. task-7-report.md (A3).
  async persist(
    tenantId: string,
    invoice: Invoice,
    formats: GeneratedFormat[],
  ): Promise<{ id: string }> {
    return this.tenant.run(tenantId, async (db) => {
      const [row] = await db
        .insert(invoices)
        .values({
          tenantId,
          number: invoice.number,
          typeCode: invoice.typeCode,
          issueDate: invoice.issueDate,
          currency: invoice.currency,
          status: 'generated',
          canonical: invoice,
        })
        .returning({ id: invoices.id })
      if (!row) {
        throw new Error('insert into invoices returned no row')
      }
      const invoiceId = row.id
      await db.insert(invoiceFormats).values(
        formats.map((f) => ({
          tenantId,
          invoiceId,
          kind: f.kind,
          contentType: f.contentType,
          bodyText: f.bodyText,
          bodyBytes: f.bodyBytes,
          byteSize: f.byteSize,
        })),
      )
      return { id: invoiceId }
    })
  }
}
