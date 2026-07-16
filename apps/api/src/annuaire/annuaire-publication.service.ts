import { Inject, Injectable } from '@nestjs/common'
import { ANNUAIRE_TRANSPORT, type AnnuairePort } from './annuaire.port.js'
// biome-ignore lint/style/useImportType: AnnuaireRepository est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { AnnuaireRepository, type LigneSummary } from './annuaire.repository.js'
import {
  type AnnuaireLigneStatus,
  motifRequired,
} from './annuaire-lifecycle.js'
import { validateAnnuaireActualisationXml } from './annuaire-xsd-validator.js'
import { generateActualisationXml } from './flux13-xml.js'
import {
  coversTarget,
  type LigneAdressage,
  type Maille,
  mailleKey,
} from './ligne-adressage.js'
import type { Nature } from './nomenclature.js'

// Publication consent-gated + émission Flux 13 + acquittements PPF (Task 8,
// plan 2.4) — miroir EreportingGenerationService (génération/transmission)
// + EreportingStatusService (acquittements) FUSIONNÉS en un seul service,
// exactement comme le nomme le plan (Produces : publishLigne/recordAck/
// maskLigne). Erreurs : classes de domaine PURES (pas de HttpException ici,
// contrairement à EreportingStatusService) — cohérence avec
// annuaire-consultation.service.ts/ligne-adressage.ts déjà utilisés dans LE
// MÊME contrôleur (RecipientUnaddressableError/AmbiguousResolutionError) :
// c'est `AnnuaireController` qui mappe, un seul endroit pour toute la
// traduction domaine → HTTP de ce module.

const REJECT_MOTIF_XSD_INVALID = 'xsd-invalide'
const CAS_STALE_RE = /is not in '.*' status/

export class ConsentRequiredError extends Error {
  constructor(readonly maille: Maille) {
    super(
      `consentement actif requis pour publier sur la maille ${mailleKey(maille)} (D5, §3.5.5.5)`,
    )
    this.name = 'ConsentRequiredError'
  }
}

export class InvalidLignePeriodError extends Error {
  constructor(
    readonly dateDebut: string,
    readonly dateFin: string,
  ) {
    super(
      `dateFin (${dateFin}) doit être strictement postérieure à dateDebut (${dateDebut}) — intervalle semi-ouvert [début, fin)`,
    )
    this.name = 'InvalidLignePeriodError'
  }
}

export class MotifRequiredError extends Error {
  constructor(readonly outcome: string) {
    super(`un motif est requis pour l'issue '${outcome}'`)
    this.name = 'MotifRequiredError'
  }
}

// CAS périmé/inconnu (Task 4 `appendLigneEvent`/T5 `updateDateFin`) : couvre
// à la fois une transition dont le statut COURANT ne correspond plus à celui
// attendu ET un id inconnu/hors tenant (RLS) — les deux sont indiscernables
// depuis le message générique du repository, miroir exact de
// EreportingStatusService.CAS_STALE_RE (l'isolation cross-tenant y renvoie
// aussi ce même 409, jamais un 404 — ereporting-status.e2e.test.ts).
export class StaleLigneTransitionError extends Error {
  constructor(readonly ligneId: string) {
    super(
      `ligne ${ligneId} : transition refusée (statut courant différent de celui attendu, id inconnu ou hors tenant)`,
    )
    this.name = 'StaleLigneTransitionError'
  }
}

export interface ConsentProofInput {
  consentType: string
  signerIdentity: string
  evidenceRef: string
  obtainedAt: Date
}

export interface PublishLigneInput {
  siren: string
  siret?: string
  routageId?: string
  suffixe?: string
  nature: Nature
  dateDebut: string
  dateFin?: string
  plateforme: string
  consentId?: string
  proof?: ConsentProofInput
}

export interface PublishLigneResult {
  id: string
  status: AnnuaireLigneStatus
  trackingRef: string | null
  rejectReason: string | null
}

function toMaille(input: {
  siren: string
  siret?: string | null
  routageId?: string | null
  suffixe?: string | null
}): Maille {
  return {
    siren: input.siren,
    siret: input.siret ?? undefined,
    routageId: input.routageId ?? undefined,
    suffixe: input.suffixe ?? undefined,
  }
}

@Injectable()
export class AnnuairePublicationService {
  constructor(
    private readonly repo: AnnuaireRepository,
    @Inject(ANNUAIRE_TRANSPORT) private readonly port: AnnuairePort,
  ) {}

  // Gate consentement (D5, A-CONSENT, INTERPRÉTATION Task 8 — "consentId ou
  // preuve" n'est pas normé par la spec) :
  //  - `consentId` fourni : référence un consentement DÉJÀ obtenu — le
  //    service vérifie LUI-MÊME couverture (`coversTarget`, Task 2) et
  //    non-révocation (jamais une confiance aveugle en l'id du client) ;
  //  - `proof` fourni (et pas de `consentId`) : crée un NOUVEAU consentement
  //    (append, D5 — versionnement par ajout, jamais par mutation) puis
  //    retombe sur la découverte automatique ;
  //  - ni l'un ni l'autre : une publication PRÉCÉDENTE a déjà déposé un
  //    consentement couvrant cette maille — `findActiveConsent` le retrouve.
  // Dans TOUS les cas, la garde finale reste `findActiveConsent`/couverture
  // explicite — jamais la seule présence d'un identifiant fourni par le
  // client : c'est l'invariant de sécurité de la gate D5.
  private async resolveConsent(
    tenantId: string,
    maille: Maille,
    input: PublishLigneInput,
  ): Promise<{ id: string }> {
    if (input.consentId) {
      const consent = await this.repo.findConsentById(tenantId, input.consentId)
      if (!consent || consent.revokedAt !== null) {
        throw new ConsentRequiredError(maille)
      }
      const consentMaille: Maille = {
        siren: consent.siren,
        siret: consent.siret ?? undefined,
        routageId: consent.routageId ?? undefined,
        suffixe: consent.suffixe ?? undefined,
      }
      if (!coversTarget(maille, consentMaille)) {
        throw new ConsentRequiredError(maille)
      }
      return { id: consent.id }
    }

    if (input.proof) {
      await this.repo.insertConsent(tenantId, { ...maille, ...input.proof })
    }

    const consent = await this.repo.findActiveConsent(tenantId, maille)
    if (!consent) throw new ConsentRequiredError(maille)
    return { id: consent.id }
  }

  async publishLigne(
    tenantId: string,
    input: PublishLigneInput,
  ): Promise<PublishLigneResult> {
    const maille = toMaille(input)

    // 1. Gate consentement — AVANT toute écriture de ligne (D5, A-CONSENT).
    const consent = await this.resolveConsent(tenantId, maille, input)

    const candidate: LigneAdressage = {
      maille,
      nature: input.nature,
      dateDebut: input.dateDebut,
      dateFin: input.dateFin,
      plateforme: input.plateforme,
    }

    // 2. Génère PUIS valide le F13 AVANT tout INSERT (T4-F1, injection revue
    // born-rejetee) : un F13 localement invalide devient une ligne rejetee
    // DIRECTE (insertLigne avec rejectMotif) — JAMAIS une transition
    // draft→rejetee, interdite par la machine (Task 4, ALLOWED.draft =
    // ['published'] seulement). Une erreur d'OUTILLAGE (xmllint absent,
    // AnnuaireXsdToolingError) n'est PAS interceptée ici : elle remonte telle
    // quelle (500/retry, jamais un rejet — cf. annuaire-xsd-validator.ts).
    const xml = generateActualisationXml({
      codesRoutage: [],
      lignes: [candidate],
    })
    const validation = await validateAnnuaireActualisationXml(xml)

    const baseNewLigne = {
      siren: input.siren,
      siret: input.siret,
      routageId: input.routageId,
      suffixe: input.suffixe,
      nature: input.nature,
      dateDebut: input.dateDebut,
      dateFin: input.dateFin,
      plateforme: input.plateforme,
      consentId: consent.id,
    }

    if (!validation.valid) {
      const { id } = await this.repo.insertLigne(tenantId, {
        ...baseNewLigne,
        rejectMotif: REJECT_MOTIF_XSD_INVALID,
      })
      return {
        id,
        status: 'rejetee',
        trackingRef: null,
        rejectReason: REJECT_MOTIF_XSD_INVALID,
      }
    }

    // 3. INSERT draft (peut lever LigneSlotConflictError — A-DEADLOCK,
    // propagée telle quelle, c'est `AnnuaireController` qui la mappe en 409).
    const { id } = await this.repo.insertLigne(tenantId, baseNewLigne)

    // 4. Transmission via le port puis draft→published (Task 6/T5).
    const result = await this.port.publish({
      tenantId,
      publicationRef: id,
      xml,
    })
    await this.repo.markPublished(tenantId, id, result.trackingRef)
    return {
      id,
      status: 'published',
      trackingRef: result.trackingRef,
      rejectReason: null,
    }
  }

  // Acquittement PPF (Task 8/D13, miroir EreportingStatusService
  // .recordPpfStatus) — frontière D7 : la SOURCE réelle (push PPF) est
  // différée ; cette méthode est exercée DIRECTEMENT par les e2e (aucune
  // route HTTP ne l'invoque dans cette tâche, motif EreportingStatusService).
  async recordAck(
    tenantId: string,
    ligneId: string,
    outcome: 'deposee' | 'rejetee',
    motif?: string,
  ): Promise<void> {
    if (motifRequired(outcome) && !motif) throw new MotifRequiredError(outcome)
    try {
      await this.repo.appendLigneEvent(
        tenantId,
        ligneId,
        'published',
        outcome,
        'ppf',
        motif,
      )
    } catch (err) {
      if (err instanceof Error && CAS_STALE_RE.test(err.message)) {
        throw new StaleLigneTransitionError(ligneId)
      }
      throw err
    }
  }

  // Masquage (Task 8, DELETE /annuaire/lignes/:id) : deposee→masked
  // uniquement (A-DEADLOCK, immédiat-terminal, D6) — actor='platform' (geste
  // du tenant via notre plateforme, pas un acquittement PPF).
  async maskLigne(tenantId: string, ligneId: string): Promise<void> {
    try {
      await this.repo.appendLigneEvent(
        tenantId,
        ligneId,
        'deposee',
        'masked',
        'platform',
      )
    } catch (err) {
      if (err instanceof Error && CAS_STALE_RE.test(err.message)) {
        throw new StaleLigneTransitionError(ligneId)
      }
      throw err
    }
  }

  // "Fin d'effet" (Task 8, PUT /annuaire/lignes/:id) : positionne `dateFin`
  // sans transition de statut. Re-lit la ligne pour comparer à sa
  // `dateDebut` (zod ne peut pas valider cette contrainte croisée à la
  // frontière — elle ne connaît que le corps de la requête, pas l'état
  // existant) ; `updateDateFin` exclut déjà les statuts terminaux
  // (rejetee/masked) côté repository.
  async endEffect(
    tenantId: string,
    ligneId: string,
    dateFin: string,
  ): Promise<void> {
    const ligne = await this.repo.findLigne(tenantId, ligneId)
    if (!ligne) throw new StaleLigneTransitionError(ligneId)
    if (dateFin <= ligne.dateDebut) {
      throw new InvalidLignePeriodError(ligne.dateDebut, dateFin)
    }
    const updated = await this.repo.updateDateFin(tenantId, ligneId, dateFin)
    if (!updated) throw new StaleLigneTransitionError(ligneId)
  }

  // Passthrough RLS-scopé (Task 8) : `AnnuaireController` s'en sert pour le
  // 404 anti-fuite des endpoints PUT/DELETE — le contrôleur ne parle JAMAIS
  // directement au repository (cf. annuaire.controller.ts existant, qui ne
  // connaît que les services).
  async getLigne(tenantId: string, id: string): Promise<LigneSummary | null> {
    return this.repo.findLigne(tenantId, id)
  }

  // STUCK-DRAFT RE-PUBLISH SWEEP (Task 9, injection revue contrôleur — fix
  // du défaut T8 F1) : un crash entre `port.publish` et `markPublished`
  // laisse une ligne en 'draft' avec le F13 déjà émis auprès du port — rien
  // ne la fait progresser et elle occupe indéfiniment le slot d'adressage
  // (A-DEADLOCK, index partiel migration 0018). Rejoue EXACTEMENT le
  // pipeline de `publishLigne` étapes 2-4 (generate→validate→port.publish→
  // markPublished) à partir de l'état PERSISTÉ de la ligne — jamais un
  // nouvel insertLigne (la ligne existe déjà).
  //
  // Idempotent PAR CONSTRUCTION, sans code supplémentaire ici :
  //  - `port.publish` est write-once par clé `publicationRef` (=id de la
  //    ligne, LocalFilesystemAnnuaireStore/Task 6) : si le crash original a
  //    eu lieu APRÈS l'écriture du F13, ce second appel retrouve la clé déjà
  //    prise et renvoie le trackingRef D'ORIGINE — jamais un second écrit ;
  //  - `markPublished` est un CAS (`WHERE status = 'draft'`, Task 5) : si la
  //    ligne a entre-temps été publiée par un AUTRE passage du sweep (course
  //    entre deux sweeps concurrents, ou le job crashé original qui a fini
  //    par committer après tout), le CAS échoue avec le message générique
  //    `is not in 'draft' status` — traité ICI comme une résolution
  //    concurrente bénigne ('skipped'), jamais une erreur : le résultat final
  //    (ligne publiée) est le même quel que soit le passage qui l'a obtenu.
  //
  // Appelé par `AnnuaireSyncProcessor` (Task 9) sur un job `annuaire-
  // republish` posé par `AnnuaireSweepService.sweepStuckDrafts` — jamais par
  // une route HTTP (motif `recordAck`, D7).
  async republishDraft(
    tenantId: string,
    ligneId: string,
  ): Promise<'republished' | 'skipped'> {
    const ligne = await this.repo.findLigne(tenantId, ligneId)
    // id inconnu/hors tenant (RLS) OU déjà résolue par un autre chemin
    // (publiée/rejetée/masquée entre le SD et ce traitement) : rien à faire,
    // ce n'est PAS une anomalie — le sweep suivant ne la reverra plus de
    // toute façon puisque `find_stale_annuaire_drafts` ne renvoie que les
    // lignes encore 'draft'.
    if (ligne?.status !== 'draft') return 'skipped'

    const candidate: LigneAdressage = {
      maille: toMaille(ligne),
      nature: ligne.nature,
      dateDebut: ligne.dateDebut,
      dateFin: ligne.dateFin ?? undefined,
      plateforme: ligne.plateforme,
    }
    const xml = generateActualisationXml({
      codesRoutage: [],
      lignes: [candidate],
    })
    const validation = await validateAnnuaireActualisationXml(xml)
    if (!validation.valid) {
      // La ligne avait DÉJÀ validé XSD à l'insertion initiale (publishLigne
      // étape 2, born-rejetee) — une donnée persistée immuable régénérant un
      // F13 XSD-invalide est une ANOMALIE inattendue (régression du
      // générateur/validateur, jamais un cas nominal) : erreur OPÉRATIONNELLE
      // qui remonte telle quelle (throw -> retry BullMQ, politique de la file
      // `annuaire-sync` — jamais un rejet silencieux/born-rejetee ici, la
      // machine n'autorise pas draft→rejetee hors genèse, Task 4).
      throw new Error(
        `republishDraft: F13 régénéré XSD-invalide pour la ligne ${ligneId} (anomalie inattendue — ${validation.errors})`,
      )
    }

    const result = await this.port.publish({
      tenantId,
      publicationRef: ligneId,
      xml,
    })
    try {
      await this.repo.markPublished(tenantId, ligneId, result.trackingRef)
    } catch (err) {
      if (err instanceof Error && CAS_STALE_RE.test(err.message))
        return 'skipped'
      throw err
    }
    return 'republished'
  }
}
