import type { Invoice } from '@factelec/invoice-core'

export type FormatKind = 'ubl' | 'cii' | 'facturx' | 'flux_base' | 'flux_full'

export interface GeneratedFormat {
  kind: FormatKind
  contentType: string
  bodyText: string | null
  bodyBytes: Buffer | null
  byteSize: number
}

// Port : la génération est synchrone en 1.3 (FormatGenerationService) ; un
// adaptateur BullMQ pourra l'implémenter en 1.4/2.x sans toucher l'ingestion.
export interface InvoiceFormatGenerator {
  generate(invoice: Invoice): Promise<GeneratedFormat[]>
}

export const INVOICE_FORMAT_GENERATOR = Symbol('INVOICE_FORMAT_GENERATOR')
