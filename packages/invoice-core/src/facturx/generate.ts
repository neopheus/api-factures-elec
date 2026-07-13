import { AFRelationship, PDFDocument, PDFName } from '@cantoo/pdf-lib'
import { generateCii } from '../cii/generate.js'
import type { Invoice } from '../model/schema.js'
import { addSrgbOutputIntent, facturXXmp } from './pdfa.js'

// Factur-X profil EN 16931 : PDF/A-3 porteur (page minimale, sans glyphe → aucune
// fonte à embarquer) + factur-x.xml (CII D16B) en pièce jointe AFRelationship=Alternative.
// Rendu humainement lisible reporté à un plan ultérieur.
export async function generateFacturX(invoice: Invoice): Promise<Uint8Array> {
  const xml = generateCii(invoice)
  const doc = await PDFDocument.create()
  doc.addPage([595.28, 841.89]) // A4, sans contenu graphique
  await doc.attach(new TextEncoder().encode(xml), 'factur-x.xml', {
    mimeType: 'text/xml',
    description: 'Factur-X invoice',
    afRelationship: AFRelationship.Alternative, // profil EN 16931
  })
  addSrgbOutputIntent(doc)
  // XMP : flux de métadonnées PDF/A + Factur-X. PDF/A exige que ce flux ne soit
  // PAS filtré : context.stream() (par opposition à flateStream()) n'applique
  // aucune compression, donc aucune clé Filter n'est écrite.
  const xmp = facturXXmp(invoice.number)
  const meta = doc.context.stream(new TextEncoder().encode(xmp), {
    Type: 'Metadata',
    Subtype: 'XML',
  })
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(meta))
  return doc.save({ useObjectStreams: false }) // PDF/A n'aime pas les object streams
}
