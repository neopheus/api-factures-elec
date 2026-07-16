import { z } from 'zod'
import { isVatexCode } from './vatex.js'

// Références BT-x / BG-x : modèle sémantique EN 16931
// (annexe 1 « Format sémantique FE e-invoicing », docs/reglementaire/).

const amount2 = z
  .string()
  .regex(/^\d+\.\d{2}$/, 'amount must be non-negative with exactly 2 decimals')
const decimal4 = z
  .string()
  .regex(/^\d+(\.\d{1,4})?$/, 'non-negative decimal with up to 4 decimals')
// BT-121 : appartenance à la liste blanche BR-CL-22 (docs/reference/vatex), pas
// simple forme — un code bien formé mais absent de la liste (ex. VATEX-EU-ZZZ99)
// doit être rejeté.
const vatexCode = z
  .string()
  .refine(isVatexCode, 'unknown VATEX code (BT-121) — see docs/reference/vatex')
function isExistingCalendarDate(value: string): boolean {
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(5, 7))
  const day = Number(value.slice(8, 10))
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isExistingCalendarDate, 'invalid calendar date')

export const vatCategorySchema = z.enum([
  'S',
  'Z',
  'E',
  'AE',
  'K',
  'G',
  'O',
  'L',
  'M',
]) // BT-151/BT-118

// EN 16931 : catégories de TVA « exonérées » sur lesquelles un motif d'exonération
// (BT-120/BT-121) est autorisé — et même requis (BR-E/AE/IC/G/O-10, cf. rules.ts,
// exemptionReasonRuleByCategory). Sur toute autre catégorie (S, Z, L, M) le motif
// est interdit (BR-S/Z/AF/AG-10) : le moteur de calcul (compute.ts) s'appuie sur
// cet ensemble pour ne jamais propager un motif porté par erreur sur ces lignes.
export const EXEMPT_VAT_CATEGORIES = new Set<VatCategory>([
  'E',
  'AE',
  'K',
  'G',
  'O',
])

// BT-23 « Cadre de Facturation » (cbc:ProfileID des extraits de flux F1) : nomenclature
// fermée de 13 codes prescrite par la règle de gestion DGFiP G1.02 (Annexe 7 v1.9,
// spécifications externes v3.2). Aucune valeur hors liste n'est acceptée.
export const businessProcessTypeSchema = z.enum([
  'B1',
  'S1',
  'M1',
  'B2',
  'S2',
  'M2',
  'B4',
  'S4',
  'M4',
  'S5',
  'S6',
  'B7',
  'S7',
])

export const postalAddressSchema = z.object({
  streetName: z.string().min(1).optional(), // BT-35/BT-50
  city: z.string().min(1).optional(), // BT-37/BT-52
  postalCode: z.string().min(1).optional(), // BT-38/BT-53
  countryCode: z.string().regex(/^[A-Z]{2}$/), // BT-40/BT-55
})

export const partySchema = z.object({
  name: z.string().min(1), // BT-27/BT-44
  siren: z
    .string()
    .regex(/^\d{9}$|^\d{14}$/)
    .optional(), // BT-30/BT-47 (SIREN ou SIRET)
  vatId: z
    .string()
    .regex(/^[A-Z]{2}[0-9A-Z]{2,12}$/)
    .optional(), // BT-31/BT-48
  address: postalAddressSchema, // BG-5/BG-8
})

// Discriminant biens/services de ligne (plan 3.2, décision D1) — extension interne
// (hors EN 16931/BT-x), miroir du template `businessProcessTypeSchema` : enum fermé
// + `.optional()`. `goods` → TLB1 (livraisons de biens), `services` → TPS1
// (prestations de services) — Annexe 6 « Correspondance ». Consommé en aval par
// `computeVatBreakdownByNature` et par l'agrégation e-reporting (`apps/api`) ; le
// mapping nature→catégorie Flux 10 reste hors invoice-core (séparation des
// responsabilités, D1).
export const invoiceLineNatureSchema = z.enum(['goods', 'services'])

export const invoiceLineInputSchema = z.object({
  id: z.string().min(1), // BT-126
  name: z.string().min(1), // BT-153
  quantity: decimal4, // BT-129
  unitCode: z.string().min(2).max(3), // BT-130 (UN/ECE rec 20, ex. C62)
  unitPrice: decimal4, // BT-146
  vatCategory: vatCategorySchema, // BT-151
  vatRate: decimal4, // BT-152 (pourcentage)
  exemptionReasonCode: vatexCode.optional(), // BT-121 (VATEX)
  exemptionReason: z.string().min(1).optional(), // BT-120 (texte libre)
  // OPTIONNEL : une facture canonique historique (JSONB, sans ce champ) reste
  // valide sans migration DB (rétro-compat D1, plan 3.2).
  nature: invoiceLineNatureSchema.optional(),
})

export const invoiceInputSchema = z.object({
  number: z.string().min(1), // BT-1
  issueDate: isoDate, // BT-2
  dueDate: isoDate.optional(), // BT-9
  typeCode: z.enum(['380', '381']), // BT-3 (facture / avoir)
  currency: z.string().regex(/^[A-Z]{3}$/), // BT-5
  seller: partySchema, // BG-4
  buyer: partySchema, // BG-7
  lines: z.array(invoiceLineInputSchema).min(1), // BG-25
  businessProcessType: businessProcessTypeSchema.optional(), // BT-23 (règle G1.02)
})

export const invoiceLineSchema = invoiceLineInputSchema.extend({
  lineNetAmount: amount2, // BT-131
})

export const vatBreakdownSchema = z.object({
  category: vatCategorySchema, // BT-118
  rate: decimal4, // BT-119
  taxableAmount: amount2, // BT-116
  taxAmount: amount2, // BT-117
  exemptionReasonCode: vatexCode.optional(), // BT-121
  exemptionReason: z.string().min(1).optional(), // BT-120
})

export const totalsSchema = z.object({
  sumOfLines: amount2, // BT-106
  taxExclusive: amount2, // BT-109
  taxAmount: amount2, // BT-110
  taxInclusive: amount2, // BT-112
  payable: amount2, // BT-115
})

export const invoiceSchema = invoiceInputSchema.extend({
  lines: z.array(invoiceLineSchema).min(1),
  vatBreakdown: z.array(vatBreakdownSchema).min(1), // BG-23
  totals: totalsSchema, // BG-22
})

export type VatCategory = z.infer<typeof vatCategorySchema>
export type BusinessProcessType = z.infer<typeof businessProcessTypeSchema>
export type InvoiceLineNature = z.infer<typeof invoiceLineNatureSchema>
export type PostalAddress = z.infer<typeof postalAddressSchema>
export type Party = z.infer<typeof partySchema>
export type InvoiceLineInput = z.infer<typeof invoiceLineInputSchema>
export type InvoiceInput = z.infer<typeof invoiceInputSchema>
export type InvoiceLine = z.infer<typeof invoiceLineSchema>
export type VatBreakdown = z.infer<typeof vatBreakdownSchema>
export type Totals = z.infer<typeof totalsSchema>
export type Invoice = z.infer<typeof invoiceSchema>

export function parseInvoiceInput(data: unknown): InvoiceInput {
  return invoiceInputSchema.parse(data)
}
