export const GENERATE_JOB = 'generate'

// Payload MINIMAL : uniquement des identifiants internes (aucun contenu de
// facture, aucun secret) — le worker recharge le canonical depuis Postgres
// sous RLS. Contrainte sécurité : rien de sensible ne transite par Redis.
export interface InvoiceGenerationJob {
  tenantId: string
  invoiceId: string
}
