import type { BusinessProcessType } from '@factelec/invoice-core'

// Codes réglementaires Flux 10 (Annexe 6 v1.10 ; spec §3.7). Ce sont les
// identifiants NORMATIFS — ne jamais les altérer (audit d'immatriculation).

export const TRANSMISSION_TYPES = ['IN', 'RE'] as const // TT-4 (initial / rectificatif)
export type TransmissionType = (typeof TRANSMISSION_TYPES)[number]

export const SENDER_ROLE_PA = 'WK' as const // TT-10, UNCL 3035 (workflow manager = PA)
export const ISSUER_ROLES = ['BY', 'SE'] as const // TT-15 (acheteur / vendeur)
export type IssuerRole = (typeof ISSUER_ROLES)[number]

export const SCHEME_ID_PA = '0238' as const // TT-7 (ICD plateforme agréée)
export const SCHEME_ID_SIREN = '0002' as const // TT-12/33-1 (SIREN)

// Régimes TVA pilotant la cadence (D4/D11) ; le mapping cadence vit dans period.ts.
export const VAT_REGIMES = [
  'reel_normal_mensuel',
  'reel_normal_trimestriel',
  'simplifie',
  'franchise',
] as const
export type VatRegime = (typeof VAT_REGIMES)[number]

// Motifs de rejet PPF (Tableau 6, §3.7.10).
export const REJECT_MOTIFS = [
  'REJ_SEMAN',
  'REJ_UNI',
  'REJ_COH',
  'REJ_PER',
] as const
export type RejectMotif = (typeof REJECT_MOTIFS)[number]

// Catégories de transactions B2C 10.3 (TT-81) — SOUS-ENSEMBLE 10.3 de la
// nomenclature TT-81, PAS la liste TT-81 exhaustive (il manque notamment
// TNT1/TMA1, hors périmètre 10.3). Ne pas traiter FLUX10_CATEGORIES comme
// une énumération complète de TT-81 lors de la sérialisation.
export const FLUX10_CATEGORIES = ['TLB1', 'TPS1'] as const // livraisons biens / prestations services
export type Flux10Category = (typeof FLUX10_CATEGORIES)[number]

// Correspondance cadre de facturation (BT-23, Flux 9) → catégorie(s) 10.3
// (feuille « E-REPORTING - Correspondance », Annexe 6 v1.10). Les cadres mixtes
// (M*) portent les DEUX catégories : l'opérateur distingue LB et PS en lignes.
const CADRE_TO_CATEGORIES: Record<BusinessProcessType, Flux10Category[]> = {
  B1: ['TLB1'],
  S1: ['TPS1'],
  M1: ['TLB1', 'TPS1'],
  B2: ['TLB1'],
  S2: ['TPS1'],
  M2: ['TLB1', 'TPS1'],
  B4: ['TLB1'],
  S4: ['TPS1'],
  M4: ['TLB1', 'TPS1'],
  S5: ['TPS1'],
  S6: ['TPS1'],
  B7: ['TLB1'],
  S7: ['TPS1'],
}

export function mapCadreToCategories(
  cadre: BusinessProcessType,
): Flux10Category[] {
  return CADRE_TO_CATEGORIES[cadre]
}
