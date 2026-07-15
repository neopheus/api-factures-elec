import { buildInvoice, type InvoiceInput } from '@factelec/invoice-core'
import type pg from 'pg'
import { TenantContextService } from '../../../src/db/tenant-context.service.js'
import { FormatGenerationService } from '../../../src/invoices/format-generation.service.js'
import { InvoicesRepository } from '../../../src/invoices/invoices.repository.js'

// Sème une facture COMPLÈTE (formats + statut `generated`) directement en base,
// en réutilisant la vraie logique de génération — équivalent au worker, sans
// file ni HTTP. Pour les tests de LECTURE/ISOLATION qui ont besoin de factures
// prêtes sans exercer le pipeline asynchrone.
export async function seedGeneratedInvoice(
  pool: pg.Pool,
  tenantId: string,
  input: InvoiceInput,
): Promise<string> {
  const repo = new InvoicesRepository(new TenantContextService(pool as never))
  const invoice = buildInvoice(input)
  const { id } = await repo.insertReceived(tenantId, invoice)
  const formats = await new FormatGenerationService().generate(invoice)
  await repo.completeGeneration(tenantId, id, formats)
  return id
}
