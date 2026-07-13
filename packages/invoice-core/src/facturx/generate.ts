import { createHash } from 'node:crypto'
import {
  AFRelationship,
  PDFDocument,
  PDFHexString,
  PDFName,
} from '@cantoo/pdf-lib'
import { generateCii } from '../cii/generate.js'
import type { Invoice } from '../model/schema.js'
import { addSrgbOutputIntent, facturXXmp } from './pdfa.js'

// Producteur DocInfo/XMP : identifie la bibliothèque, jamais une horloge ou un
// numéro de build volatile — condition de la reproductibilité byte-à-byte.
const PRODUCER = '@factelec/invoice-core'

// Factur-X profil EN 16931 : PDF/A-3 porteur (page minimale, sans glyphe → aucune
// fonte à embarquer) + factur-x.xml (CII D16B) en pièce jointe AFRelationship=Alternative.
// Rendu humainement lisible reporté à un plan ultérieur.
export async function generateFacturX(invoice: Invoice): Promise<Uint8Array> {
  const xml = generateCii(invoice)
  // updateMetadata: false — sinon @cantoo/pdf-lib fixe Producer/CreationDate/
  // ModDate dans le constructeur via `new Date()` (horloge système, non
  // déterministe). On pose nous-mêmes ces valeurs juste après, dérivées de la
  // facture (invoice.issueDate), pour rester reproductible.
  const doc = await PDFDocument.create({ updateMetadata: false })
  doc.addPage([595.28, 841.89]) // A4, sans contenu graphique
  await doc.attach(new TextEncoder().encode(xml), 'factur-x.xml', {
    mimeType: 'text/xml',
    description: 'Factur-X invoice',
    afRelationship: AFRelationship.Alternative, // profil EN 16931
  })
  addSrgbOutputIntent(doc)

  // DocInfo déterministe : minuit UTC de la date d'émission (BT-2). Le XMP
  // (ci-dessous) est dérivé de la même valeur pour rester synchronisé avec
  // DocInfo — PDF/A l'exige (ISO 19005-3 §6.7.3).
  const docDate = issueDateAtUtcMidnight(invoice.issueDate)
  doc.setCreationDate(docDate)
  doc.setModificationDate(docDate)
  doc.setProducer(PRODUCER)

  // XMP : flux de métadonnées PDF/A + Factur-X. PDF/A exige que ce flux ne soit
  // PAS filtré : context.stream() (par opposition à flateStream()) n'applique
  // aucune compression, donc aucune clé Filter n'est écrite.
  const xmp = facturXXmp(invoice.number, {
    producer: PRODUCER,
    createDate: toXmpDate(docDate),
    modifyDate: toXmpDate(docDate),
  })
  const meta = doc.context.stream(new TextEncoder().encode(xmp), {
    Type: 'Metadata',
    Subtype: 'XML',
  })
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(meta))

  // /ID de trailer, obligatoire (ISO 19005-3 §6.1.3). Déterministe : dérivé du
  // XML CII embarqué (contenu métier de la facture) via sha256, pas d'aléa ni
  // d'horloge — deux mêmes appels produisent le même identifiant.
  const idHex = createHash('sha256').update(xml).digest('hex')
  const id = PDFHexString.of(idHex)
  doc.context.trailerInfo.ID = doc.context.obj([id, id])

  return doc.save({ useObjectStreams: false }) // PDF/A n'aime pas les object streams
}

function issueDateAtUtcMidnight(issueDate: string): Date {
  const year = Number(issueDate.slice(0, 4))
  const month = Number(issueDate.slice(5, 7))
  const day = Number(issueDate.slice(8, 10))
  return new Date(Date.UTC(year, month - 1, day))
}

function toXmpDate(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`
}
