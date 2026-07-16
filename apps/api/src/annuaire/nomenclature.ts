// Codes réglementaires annuaire (ANNEXE 3 v1.8, sheets F13/F14 ; XSD
// Annuaire_Commun.xsd ; PDF spec v3.2 §3.5.3). Ce sont les identifiants
// NORMATIFS — ne jamais les altérer (audit d'immatriculation).

// Nature de la ligne d'annuaire (DT-7-2, ANNEXE 3 F13 row 21) :
// "D" Définition (créer/modifier une maille) ou "M" Masquage (rendre une
// maille non adressable).
export const NATURES = ['D', 'M'] as const
export type Nature = (typeof NATURES)[number]

// Niveaux de maille d'adressage possibles (InfoAdressage, ANNEXE 3 F13
// row 25, verbatim : "SIREN / SIREN_SIRET / SIREN_SIRET_Identifiant de
// routage / SIREN_Suffixe").
export const MAILLE_LEVELS = [
  'SIREN',
  'SIREN_SIRET',
  'SIREN_SIRET_ROUTAGE',
  'SIREN_SUFFIXE',
] as const
export type MailleLevel = (typeof MAILLE_LEVELS)[number]

// Qualifiants ISO 6523 (ICD) requis sur IdLinSIREN/IdLinSIRET (attribut
// @qualifiant, use="required", Annuaire_Commun.xsd IdSirenType/IdSiretType).
// SIREN : ANNEXE 3 F13 row 28 ("La seule valeur possible est 0002").
export const SCHEME_ID_SIREN = '0002' as const
// SIRET : ANNEXE 3 F13 row 30 ("La seule valeur possible est 0009").
export const SCHEME_ID_SIRET = '0009' as const

// Type de flux F14 (DT-2, ANNEXE 3 F14 row 6) : "C" Complet ou
// "D" Différentiel.
export const TYPE_FLUX = ['C', 'D'] as const
export type TypeFlux = (typeof TYPE_FLUX)[number]

// Motif de présence du bloc d'informations dans le flux F14 (DT-3-1/DT-4-1,
// ANNEXE 3 F14 rows 10/20) : "C" Vigueur en cours, "P" Prise d'effet,
// "S" Sortie d'effet.
export const MOTIF_PRESENCE = ['C', 'P', 'S'] as const
export type MotifPresence = (typeof MOTIF_PRESENCE)[number]

// Diffusibilité de l'unité légale/établissement (DT-3-6/DT-4-x, ANNEXE 3
// F14 row 16) : "O" diffusible, "P" partiellement diffusible,
// "M" refus de prospection.
export const DIFFUSIBLE = ['O', 'P', 'M'] as const
export type Diffusible = (typeof DIFFUSIBLE)[number]

// Plateforme fictive non-routante attribuée par défaut à toute entité
// nouvellement assujettie (PDF spec v3.2 §3.5.3, verbatim : "une ligne
// d'annuaire à la maille de l'entité légale (SIREN) est créée par défaut,
// et une plateforme « fictive » de matricule 9998 est attribuée à cette
// ligne").
export const FICTITIOUS_PLATFORM = '9998' as const

// Patterns copiés verbatim des xs:pattern du XSD commun
// (Annuaire_Commun.xsd) : SIREN [0-9]{9}, SIRET [0-9]{14}, matricule de
// plateforme [0-9]{4}, date AAAAMMJJ, horodate AAAAMMJJHHMMSS.
export const SIREN_RE = /^[0-9]{9}$/
export const SIRET_RE = /^[0-9]{14}$/
export const PLATFORM_MATRICULE_RE = /^[0-9]{4}$/
export const DATE_RE = /^\d{4}(0[1-9]|1[012])(0[1-9]|[12][0-9]|3[01])$/
export const HORODATE_RE =
  /^\d{4}(0[1-9]|1[012])(0[1-9]|[12][0-9]|3[01])(2[0-3]|[01][0-9])([0-5][0-9])([0-5][0-9])$/

export function isPlatformMatricule(value: string): boolean {
  return PLATFORM_MATRICULE_RE.test(value)
}

export interface MailleIdentifiers {
  siren: string
  siret?: string
  routageId?: string
  suffixe?: string
}

// Déduit le niveau de maille (F13 row 25) depuis les identifiants présents.
// Ordre de spécificité (routage/suffixe > SIRET > SIREN) : le routage et le
// suffixe sont mutuellement exclusifs dans le modèle F13 (un identifiant de
// routage qualifie une maille SIREN_SIRET_ROUTAGE ; un suffixe qualifie une
// maille SIREN_SUFFIXE indépendante de tout établissement).
export function mailleLevelOf(ids: MailleIdentifiers): MailleLevel {
  if (ids.routageId !== undefined) return 'SIREN_SIRET_ROUTAGE'
  if (ids.suffixe !== undefined) return 'SIREN_SUFFIXE'
  if (ids.siret !== undefined) return 'SIREN_SIRET'
  return 'SIREN'
}
