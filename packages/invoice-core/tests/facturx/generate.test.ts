import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PDFDocument } from '@cantoo/pdf-lib'
import { describe, expect, it } from 'vitest'
import { generateCii } from '../../src/cii/generate.js'
import { generateFacturX } from '../../src/facturx/generate.js'
import { SRGB_ICC_BASE64 } from '../../src/facturx/srgb-icc.js'
import { buildInvoice } from '../../src/model/compute.js'
import { creditNoteInput, simpleInvoiceInput } from '../fixtures.js'
import { CII_SEF, validateAgainstSchematron } from '../helpers/schematron.js'

describe('generateFacturX (PDF/A-3 + embedded CII)', () => {
  it('returns bytes starting with the PDF magic header', async () => {
    const pdf = await generateFacturX(buildInvoice(simpleInvoiceInput))
    expect(pdf).toBeInstanceOf(Uint8Array)
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe('%PDF-')
  })

  it('embeds factur-x.xml equal to generateCii and passing the CII Schematron', async () => {
    const invoice = buildInvoice(simpleInvoiceInput)
    const pdf = await generateFacturX(invoice)
    const xml = await extractEmbeddedXml(pdf, 'factur-x.xml')
    expect(xml).toBe(generateCii(invoice))
    const r = validateAgainstSchematron(xml, CII_SEF)
    expect(r.valid).toBe(true)
  })

  it('embeds a CII with TypeCode 381 for a credit note', async () => {
    const invoice = buildInvoice(creditNoteInput)
    const pdf = await generateFacturX(invoice)
    const xml = await extractEmbeddedXml(pdf, 'factur-x.xml')
    expect(xml).toBe(generateCii(invoice))
    expect(xml).toContain('<ram:TypeCode>381</ram:TypeCode>')
    const r = validateAgainstSchematron(xml, CII_SEF)
    expect(r.valid).toBe(true)
  })

  it('declares AFRelationship Alternative and PDF/A + Factur-X XMP metadata', async () => {
    const pdf = await generateFacturX(buildInvoice(simpleInvoiceInput))
    const raw = new TextDecoder('latin1').decode(pdf)
    expect(raw).toContain('/AFRelationship /Alternative')
    expect(raw).toContain('pdfaid:part>3') // identification PDF/A-3
    expect(raw).toContain('urn:factur-x') // extension schema Factur-X (FNFE)
    expect(raw).toContain('EN 16931') // ConformanceLevel du profil
  })

  it('embeds the vendored sRGB profile as OutputIntent', async () => {
    const pdf = await generateFacturX(buildInvoice(simpleInvoiceInput))
    const raw = new TextDecoder('latin1').decode(pdf)
    expect(raw).toContain('/OutputIntent')
    expect(SRGB_ICC_BASE64.length).toBeGreaterThan(1000)
  })

  it('sets a trailer /ID, mandatory per ISO 19005-3 §6.1.3', async () => {
    const pdf = await generateFacturX(buildInvoice(simpleInvoiceInput))
    const raw = new TextDecoder('latin1').decode(pdf)
    expect(raw).toContain('/ID [')
  })

  it('mirrors DocInfo (CreationDate/ModDate/Producer) in the XMP packet, as PDF/A requires', async () => {
    const pdf = await generateFacturX(buildInvoice(simpleInvoiceInput))
    const raw = new TextDecoder('latin1').decode(pdf)
    expect(raw).toContain('xmp:CreateDate')
    expect(raw).toContain('xmp:ModifyDate')
    expect(raw).toContain('pdf:Producer')
    expect(raw).toContain('dc:format')
    expect(raw).toContain('application/pdf')
  })

  it('is deterministic: generating the same invoice twice yields identical bytes', async () => {
    const invoice = buildInvoice(simpleInvoiceInput)
    const pdf1 = await generateFacturX(invoice)
    const pdf2 = await generateFacturX(invoice)
    expect(Buffer.from(pdf1).equals(Buffer.from(pdf2))).toBe(true)
  })

  it('keeps the src ICC constant in sync with the vendored profile', () => {
    const vendored = readFileSync(
      resolve(
        import.meta.dirname,
        '../../../../docs/reference/icc/sRGB2014.icc',
      ),
    ).toString('base64')
    expect(SRGB_ICC_BASE64).toBe(vendored)
  })
})

// Helper de test : charge le PDF produit et relit la pièce jointe nommée via
// l'API publique doc.getAttachments() (catalog → Names → EmbeddedFiles → EF/F,
// déjà décodée par pdf-lib).
async function extractEmbeddedXml(
  pdf: Uint8Array,
  name: string,
): Promise<string> {
  const doc = await PDFDocument.load(pdf)
  const attachment = doc.getAttachments().find((a) => a.name === name)
  if (!attachment) throw new Error(`attachment ${name} not found`)
  return new TextDecoder().decode(attachment.data)
}
