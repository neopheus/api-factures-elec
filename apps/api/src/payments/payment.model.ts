import { z } from 'zod'

// Sous-total d'un encaissement (TG-36/TG-39 : taxPercent=TT-93/97,
// amount=TT-95/99 — MONTANT 19.6 au XSD, stocké `text` comme tous les
// montants Flux 10, D5). Forme STRUCTURELLE minimale (chaînes non vides) :
// la validation stricte (DECIMAL_RE/AMOUNT_RE, sous-ensemble de la
// ventilation facture, anti-sur-encaissement) est du ressort de l'endpoint
// dual-auth (Task 5) — ce module reste PUR (aucune dépendance NestJS/DB),
// consommé par le repository (Task 4) ET par le endpoint (Task 5).
export const paymentSubtotalCaptureSchema = z.object({
  taxPercent: z.string().min(1),
  amount: z.string().min(1),
})
export type PaymentSubtotalCapture = z.infer<
  typeof paymentSubtotalCaptureSchema
>

// Capture d'un encaissement (D5) : date + devise + référence client
// (idempotence de capture, clé UNIQUE (invoice_id, reference)) + sous-totaux
// par taux (paiements partiels multiples supportés, TVA à l'encaissement).
// `currency` optionnel : la colonne DB porte le défaut `'EUR'` (schema.ts).
export const paymentCaptureSchema = z.object({
  invoiceId: z.uuid(),
  paymentDate: z.string().min(1), // AAAAMMJJ
  currency: z.string().min(1).optional(),
  reference: z.string().min(1),
  subtotals: z.array(paymentSubtotalCaptureSchema).min(1),
})
export type PaymentCapture = z.infer<typeof paymentCaptureSchema>
