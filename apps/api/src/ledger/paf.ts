import type { LedgerIntegrity } from './ledger-verification.service.js'

// Piste d'Audit Fiable (PAF) — export de conformité (spec §4.5 ; obligation
// d'intégrité/authenticité CGI art. 289 bis/289 E). CADRAGE HONNÊTE : les
// spécifications externes v3.2 ne définissent AUCUN format PAF normalisé
// (constat vérifié) — le format ci-dessous est une CONCEPTION PROJET, sans
// prétendre à une conformité de schéma DGFiP.
//
// Identité probatoire = (tenant_id, seq) : PafEvent référence chaque
// événement par seq/hash/prevHash, JAMAIS le PK surrogate `id`.
export interface PafEvent {
  seq: number
  fromStatus: string | null
  toStatus: string
  actor: string
  reason: string | null
  createdAt: string
  prevHash: string
  hash: string
}

export interface PafDocument {
  invoiceId: string
  lifecycleStatus: string
  // Self-check par-facture (Task 4, LedgerVerificationService.verifyInvoiceEvents).
  integrity: LedgerIntegrity
  // Amendement A-IMPORTANT (revue plan) : vérification de la chaîne COMPLÈTE
  // du tenant (verifyTenantChain) — seule à détecter une suppression
  // owner-side de maillon, invisible au self-check par-facture ci-dessus.
  chainIntegrity: LedgerIntegrity
  archive: { status: string; location: string | null; hash: string | null }
  events: PafEvent[]
}

// Échappement RFC 4180 : guillemets si le champ contient , " CR ou LF ; " → "".
function csvField(v: string | null): string {
  const s = v ?? ''
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const HEADER =
  'seq,from_status,to_status,actor,reason,created_at,prev_hash,hash'

// Rendu PUR : la table CSV expose UNIQUEMENT les événements — integrity et
// chainIntegrity sont des métadonnées niveau-document, portées par le JSON,
// jamais injectées dans les lignes CSV.
export function renderPafCsv(doc: PafDocument): string {
  const rows = doc.events.map((e) =>
    [
      String(e.seq),
      csvField(e.fromStatus),
      csvField(e.toStatus),
      csvField(e.actor),
      csvField(e.reason),
      csvField(e.createdAt),
      csvField(e.prevHash),
      csvField(e.hash),
    ].join(','),
  )
  return `${[HEADER, ...rows].join('\n')}\n`
}
