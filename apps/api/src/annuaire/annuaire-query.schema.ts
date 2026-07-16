import { z } from 'zod'
import { DATE_RE, SIREN_RE, SIRET_RE } from './nomenclature.js'

// DTO de frontière HTTP pour les endpoints de consultation (Task 7, plan
// 2.4). Injections revue T2 #4/#5 + T5 #1 (BINDING, cf. message de tâche) :
//
// (1) `dateYmd` est validé ICI à la frontière avec le pattern XSD EXACT
//     (DATE_RE, nomenclature.ts — copié verbatim du xs:pattern DateType du
//     XSD commun annuaire) : largeur 8 chiffres, mois 01-12, jour 01-31.
//     Une date malformée (largeur incorrecte, séparateurs, mois/jour hors
//     bornes) échoue ICI en 422 — jamais transmise à `resolveRecipient`
//     (Task 2), qui suppose des dates déjà normalisées AAAAMMJJ.
//
// (2) Les identifiants de maille OPTIONNELS (`siret`, `routageId`,
//     `suffixe`) reçus en query string sont normalisés chaîne-vide → ABSENT
//     AVANT validation zod (`emptyToUndefined`) : un client qui envoie
//     `?siret=` (paramètre présent mais vide — cas réel d'un formulaire HTML
//     ou d'un client générant systématiquement toutes les clés) ne doit
//     JAMAIS atteindre le repository comme une chaîne vide littérale. Sans
//     cette normalisation, `''` serait traité comme une valeur de maille
//     PROPRE (`mailleKey`/`coversTarget`, ligne-adressage.ts, distinguent
//     `undefined` d'une chaîne vide) et pourrait, par accident, matcher la
//     convention `coalesce(colonne, '')` utilisée CÔTÉ PERSISTANCE
//     (annuaire.repository.ts upsertDirectoryEntries) — un piège de
//     collision entre « absent » et « vide » (le « coalesce('') latent
//     trap » nommé dans la revue).
// Exportée (Task 8) : `annuaire-publication.schema.ts` réutilise EXACTEMENT
// cette même normalisation pour les champs optionnels du BODY (siret/
// routageId/suffixe/dateFin/consentId, injection revue T5#1) plutôt que de
// redéfinir une seconde fonction subtilement différente.
export function emptyToUndefined(v: unknown): unknown {
  return v === '' ? undefined : v
}

// `routageId`/`suffixe` sont des `xs:token` SANS pattern dans
// Annuaire_Commun.xsd (IdCodesRoutageType / Suffixe) — aucune forme n'est
// imposée par la spec. La borne de longueur ci-dessous est une PROTECTION
// DÉFENSIVE contre l'abus (paramètre de requête arbitrairement long), PAS
// une contrainte réglementaire : ne jamais la confondre avec un pattern XSD.
const DEFENSIVE_MAX_LEN = 70

// Exportée (Task 8) : réutilisée par `annuaire-publication.schema.ts` pour
// les mêmes identifiants de maille optionnels, cette fois portés en BODY.
export function optionalToken(pattern?: RegExp, message?: string) {
  const base = pattern
    ? z.string().trim().min(1).max(DEFENSIVE_MAX_LEN).regex(pattern, message)
    : z.string().trim().min(1).max(DEFENSIVE_MAX_LEN)
  return z.preprocess(emptyToUndefined, base.optional())
}

export const lignesQuerySchema = z.object({
  siren: z.string().regex(SIREN_RE, 'siren must be exactly 9 digits'),
})
export type LignesQuery = z.infer<typeof lignesQuerySchema>

// Calque EXACT de `lignesQuerySchema` (Task 3, plan 3.3, D6) : même
// contrainte SIREN, même frontière — l'énumération des codes-routage
// publiés par le tenant (`GET /annuaire/codes-routage`) ne prend elle non
// plus qu'un seul paramètre de requête.
export const codesRoutageQuerySchema = z.object({
  siren: z.string().regex(SIREN_RE, 'siren must be exactly 9 digits'),
})
export type CodesRoutageQuery = z.infer<typeof codesRoutageQuerySchema>

export const resolutionQuerySchema = z.object({
  siren: z.string().regex(SIREN_RE, 'siren must be exactly 9 digits'),
  siret: optionalToken(SIRET_RE, 'siret must be exactly 14 digits'),
  routageId: optionalToken(),
  suffixe: optionalToken(),
  date: z
    .string()
    .regex(DATE_RE, 'date must be AAAAMMJJ (8 digits, valid month/day)'),
})
export type ResolutionQuery = z.infer<typeof resolutionQuerySchema>
