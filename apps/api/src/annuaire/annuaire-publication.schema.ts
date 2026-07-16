import { z } from 'zod'
import { emptyToUndefined, optionalToken } from './annuaire-query.schema.js'
import {
  DATE_RE,
  NATURES,
  PLATFORM_MATRICULE_RE,
  SIREN_RE,
  SIRET_RE,
} from './nomenclature.js'

// DTO de frontière HTTP pour les endpoints de publication (Task 8, plan
// 2.4). Injection revue T5#1 (BINDING, cf. message de tâche) : les
// identifiants de maille optionnels reçus en BODY (`siret`/`routageId`/
// `suffixe`) sont normalisés chaîne-vide → ABSENT AVANT validation zod
// (`emptyToUndefined`, annuaire-query.schema.ts) — même piège de collision
// « absent vs vide » qu'à la frontière query (Task 7), même remède
// réutilisé tel quel plutôt que redéfini.

// Preuve de consentement (§3.5.5.5, D5) portée INLINE dans le body — permet
// de créer le consentement ET la ligne en un seul appel quand le tenant n'a
// PAS encore de consentement couvrant la maille (AnnuairePublicationService
// insère la preuve avant de re-vérifier la gate via `findActiveConsent`).
const proofSchema = z.object({
  consentType: z.string().trim().min(1).max(70),
  signerIdentity: z.string().trim().min(1).max(200),
  evidenceRef: z.string().trim().min(1).max(200),
  obtainedAt: z.coerce.date(),
})

export const publishLigneBodySchema = z
  .object({
    siren: z.string().regex(SIREN_RE, 'siren must be exactly 9 digits'),
    siret: optionalToken(SIRET_RE, 'siret must be exactly 14 digits'),
    routageId: optionalToken(),
    suffixe: optionalToken(),
    nature: z.enum(NATURES),
    dateDebut: z
      .string()
      .regex(DATE_RE, 'dateDebut must be AAAAMMJJ (8 digits, valid month/day)'),
    dateFin: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .regex(DATE_RE, 'dateFin must be AAAAMMJJ (8 digits, valid month/day)')
        .optional(),
    ),
    plateforme: z
      .string()
      .regex(PLATFORM_MATRICULE_RE, 'plateforme must be exactly 4 digits'),
    // Gate consentement (D5, INTERPRÉTATION Task 8 — la spec ne précise pas
    // le mécanisme exact de "consentId ou preuve") : `consentId` référence un
    // consentement DÉJÀ obtenu (vérifié couverture+non-révocation par le
    // service, jamais une simple confiance en l'id) ; `proof` en crée un
    // NOUVEAU (append, D5) ; NI L'UN NI L'AUTRE reste valide si une
    // publication PRÉCÉDENTE a déjà déposé un consentement couvrant cette
    // maille (auto-découverte par `findActiveConsent`, la garde ultime dans
    // tous les cas).
    consentId: optionalToken(),
    proof: proofSchema.optional(),
  })
  .refine((b) => b.dateFin === undefined || b.dateFin > b.dateDebut, {
    message: 'dateFin must be strictly after dateDebut (semi-open interval)',
    path: ['dateFin'],
  })
export type PublishLigneBody = z.infer<typeof publishLigneBodySchema>

// PUT /annuaire/lignes/:id (fin d'effet) : positionne uniquement `dateFin` —
// la comparaison à `dateDebut` (existant en base, inconnu de ce schéma)
// relève du service (InvalidLignePeriodError), pas de zod ici.
export const endEffectBodySchema = z.object({
  dateFin: z
    .string()
    .regex(DATE_RE, 'dateFin must be AAAAMMJJ (8 digits, valid month/day)'),
})
export type EndEffectBody = z.infer<typeof endEffectBodySchema>
