import { buildInvoice, type InvoiceInput } from '@factelec/invoice-core'
import { describe, expect, it } from 'vitest'
import type {
  FormatKind,
  GeneratedFormat,
} from '../../src/invoices/format-generator.port.js'
import { SynchronousFormatGenerator } from '../../src/invoices/synchronous-format-generator.js'

// noUncheckedIndexedAccess (tsconfig.base.json) : un lookup par index (objet ou
// tableau) type toujours `T | undefined`. `find` échoue fort (throw) plutôt que
// de propager `undefined` — équivalent runtime au `byKind.xxx` du brief, mais
// qui typecheck.
function find(formats: GeneratedFormat[], kind: FormatKind): GeneratedFormat {
  const found = formats.find((f) => f.kind === kind)
  if (!found) throw new Error(`format "${kind}" not found`)
  return found
}

const input: InvoiceInput = {
  number: 'FA-2026-100',
  issueDate: '2026-07-13',
  dueDate: '2026-08-12',
  typeCode: '380',
  currency: 'EUR',
  businessProcessType: 'S1',
  seller: { name: 'Vendeur', address: { countryCode: 'FR' } },
  buyer: { name: 'Acheteur', address: { countryCode: 'FR' } },
  lines: [
    {
      id: '1',
      name: 'Service',
      quantity: '1',
      unitCode: 'C62',
      unitPrice: '100.00',
      vatCategory: 'S',
      vatRate: '20.00',
    },
  ],
}

describe('SynchronousFormatGenerator', () => {
  it('produces UBL, CII, Factur-X and both flux extracts (businessProcessType present)', async () => {
    const out = await new SynchronousFormatGenerator().generate(
      buildInvoice(input),
    )
    expect(out.map((f) => f.kind).sort()).toEqual([
      'cii',
      'facturx',
      'flux_base',
      'flux_full',
      'ubl',
    ])
    const ubl = find(out, 'ubl')
    expect(ubl.contentType).toBe('application/xml')
    expect(ubl.bodyText).toContain('<Invoice')
    const facturx = find(out, 'facturx')
    expect(facturx.contentType).toBe('application/pdf')
    expect(facturx.bodyBytes?.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(facturx.byteSize).toBeGreaterThan(0)
  })

  it('omits flux extracts when businessProcessType is absent', async () => {
    const noProc = buildInvoice({ ...input, businessProcessType: undefined })
    const kinds = (await new SynchronousFormatGenerator().generate(noProc)).map(
      (f) => f.kind,
    )
    expect(kinds).toEqual(['ubl', 'cii', 'facturx'])
  })
})
