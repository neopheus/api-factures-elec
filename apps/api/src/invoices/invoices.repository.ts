import type { Invoice } from '@factelec/invoice-core'
import { Injectable } from '@nestjs/common'
import { and, desc, eq, lt, or } from 'drizzle-orm'
import { invoiceFormats, invoices } from '../db/schema.js'
// biome-ignore lint/style/useImportType: TenantContextService est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { TenantContextService } from '../db/tenant-context.service.js'
import { decodeCursor, encodeCursor } from './cursor.js'
import type { FormatKind, GeneratedFormat } from './format-generator.port.js'

export interface InvoiceSummary {
  id: string
  number: string
  typeCode: string
  issueDate: string
  currency: string
  status: string
  createdAt: Date
}

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

  async findById(tenantId: string, id: string): Promise<InvoiceSummary | null> {
    return this.tenant.run(tenantId, async (db) => {
      const rows = await db
        .select({
          id: invoices.id,
          number: invoices.number,
          typeCode: invoices.typeCode,
          issueDate: invoices.issueDate,
          currency: invoices.currency,
          status: invoices.status,
          createdAt: invoices.createdAt,
        })
        .from(invoices)
        .where(eq(invoices.id, id))
        .limit(1)
      return rows[0] ?? null
    })
  }

  async listFormatKinds(
    tenantId: string,
    invoiceId: string,
  ): Promise<FormatKind[]> {
    return this.tenant.run(tenantId, async (db) => {
      const rows = await db
        .select({ kind: invoiceFormats.kind })
        .from(invoiceFormats)
        .where(eq(invoiceFormats.invoiceId, invoiceId))
      return rows.map((r) => r.kind as FormatKind)
    })
  }

  // where(keyset) avec keyset = undefined (1re page) ne filtre rien — la RLS
  // reste le seul filtre tenant. eq(invoices.tenantId, …) est redondant (RLS)
  // ; on le laisse implicite pour ne pas dupliquer la garde.
  async list(
    tenantId: string,
    limit: number,
    cursor?: string,
  ): Promise<{ items: InvoiceSummary[]; nextCursor: string | null }> {
    return this.tenant.run(tenantId, async (db) => {
      const decoded = cursor ? decodeCursor(cursor) : null
      const keyset = decoded
        ? or(
            lt(invoices.createdAt, new Date(decoded.createdAt)),
            and(
              eq(invoices.createdAt, new Date(decoded.createdAt)),
              lt(invoices.id, decoded.id),
            ),
          )
        : undefined
      const rows = await db
        .select({
          id: invoices.id,
          number: invoices.number,
          typeCode: invoices.typeCode,
          issueDate: invoices.issueDate,
          currency: invoices.currency,
          status: invoices.status,
          createdAt: invoices.createdAt,
        })
        .from(invoices)
        .where(keyset)
        .orderBy(desc(invoices.createdAt), desc(invoices.id))
        .limit(limit + 1)
      const hasMore = rows.length > limit
      const items = hasMore ? rows.slice(0, limit) : rows
      const last = items.at(-1)
      const nextCursor =
        hasMore && last ? encodeCursor(last.createdAt, last.id) : null
      return { items, nextCursor }
    })
  }

  async findFormat(
    tenantId: string,
    invoiceId: string,
    kind: FormatKind,
  ): Promise<{
    contentType: string
    bodyText: string | null
    bodyBytes: Buffer | null
  } | null> {
    return this.tenant.run(tenantId, async (db) => {
      const rows = await db
        .select({
          contentType: invoiceFormats.contentType,
          bodyText: invoiceFormats.bodyText,
          bodyBytes: invoiceFormats.bodyBytes,
        })
        .from(invoiceFormats)
        .where(
          and(
            eq(invoiceFormats.invoiceId, invoiceId),
            eq(invoiceFormats.kind, kind),
          ),
        )
        .limit(1)
      return rows[0] ?? null
    })
  }
}
