import { Inject, Injectable, Logger } from '@nestjs/common'
import { ANNUAIRE_TRANSPORT, type AnnuairePort } from './annuaire.port.js'
// biome-ignore lint/style/useImportType: AnnuaireRepository est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import {
  AnnuaireRepository,
  type NewDirectoryEntry,
} from './annuaire.repository.js'
import {
  InvalidConsultationF14XmlError,
  parseConsultationF14,
  UnknownLigneNatureError,
  UnknownTypeFluxError,
} from './flux14-parse.js'
import type { LigneAdressage } from './ligne-adressage.js'
import type { TypeFlux } from './nomenclature.js'

// Ingestion Flux 14 (Task 9, plan 2.4 Step 1) : fetchConsultation (port,
// Task 6) → validation XSD + parse (Task 3, `parseConsultationF14` fait les
// DEUX) → upsert/remplacement du miroir tenant-scopé (Task 5/9). Miroir
// EreportingGenerationService (2.3) pour la distinction OPÉRATIONNEL vs
// SÉMANTIQUE (plan Step 1, verbatim) :
//  - outillage manquant (AnnuaireXsdToolingError) → PROPAGE (throw -> retry
//    BullMQ, `annuaireSyncJobOptions`) : un F14 par ailleurs valide ne doit
//    jamais être traité comme invalide parce que xmllint manque sur l'hôte ;
//  - F14 structurellement invalide OU Nature/TypeFlux hors nomenclature
//    (A-MIRROR-KEY, injection revue T3) → log + SKIP (jamais une corruption
//    du miroir, jamais un throw : le job complète normalement, un sweep
//    ultérieur récupérera un F14 corrigé le cas échéant).
@Injectable()
export class AnnuaireSyncService {
  private readonly logger = new Logger(AnnuaireSyncService.name)

  constructor(
    @Inject(ANNUAIRE_TRANSPORT) private readonly port: AnnuairePort,
    private readonly repo: AnnuaireRepository,
  ) {}

  // Renvoie le nombre d'entrées ingérées — 0 aussi bien pour un F14
  // authentiquement vide QUE pour un F14 rejeté (motif « à blanc »,
  // EreportingGenerationService) : le processeur/sweep ne distingue pas les
  // deux cas, un 0 n'est jamais une erreur.
  async sync(tenantId: string, typeFlux: TypeFlux): Promise<number> {
    const { xml } = await this.port.fetchConsultation(typeFlux)

    let parsed: { lignes: LigneAdressage[] }
    try {
      parsed = await parseConsultationF14(xml)
    } catch (err) {
      if (
        err instanceof InvalidConsultationF14XmlError ||
        err instanceof UnknownLigneNatureError ||
        err instanceof UnknownTypeFluxError
      ) {
        this.logger.warn(
          `annuaire sync (tenant=${tenantId}, typeFlux=${typeFlux}) : F14 rejeté — ${err.message}`,
        )
        return 0
      }
      throw err
    }

    const entries = parsed.lignes.map(toDirectoryEntry)
    // Flux vide (D8 : LocalFilesystemAnnuaireStore sert un F14 vide XSD-
    // valide TANT QU'aucun fixture n'a été déposé, cf. son
    // `emptyConsultationXml`) : jamais un signal légitime de vider le
    // miroir COMPLET (injection revue Task 9, « empty F14 → no-op »).
    // Court-circuite AVANT tout appel repository — garde redondante avec
    // celle du repository (défense en profondeur, cf.
    // `AnnuaireRepository.replaceDirectoryEntries`).
    if (entries.length === 0) return 0

    if (typeFlux === 'C') {
      // A-SYNC-RECONCILE (injection revue Task 9, MED) : le flux COMPLET
      // REMPLACE le miroir du tenant (delete des entrées absentes) — sinon
      // le miroir dérive vers des plateformes défuntes que le PPF a cessé
      // d'annoncer.
      await this.repo.replaceDirectoryEntries(tenantId, entries)
    } else {
      // Flux DIFFÉRENTIEL : upsert SEUL, jamais de suppression — un
      // différentiel ne porte qu'un sous-ensemble de mouvements récents,
      // le silence sur une maille ne signifie PAS sa disparition.
      await this.repo.upsertDirectoryEntries(tenantId, entries)
    }
    return entries.length
  }
}

// Fin EFFECTIVE (injection revue T3, MED) : min(dateFin, dateFinEffective)
// — une ligne close par anticipation (DateFinEffective < DateFin prévue,
// DT-7-3-3) ne doit jamais rester résolue au-delà de sa fin RÉELLE
// (sur-routage). Absence des deux → toujours en vigueur (undefined, cohérent
// avec `isInForce`, ligne-adressage.ts). Comparaison lexicographique
// AAAAMMJJ = comparaison chronologique (largeur fixe, motif OPEN_ENDED déjà
// établi Task 2/ligne-adressage.ts).
export function effectiveDateFin(ligne: LigneAdressage): string | undefined {
  if (ligne.dateFinEffective === undefined) return ligne.dateFin
  if (ligne.dateFin === undefined) return ligne.dateFinEffective
  return ligne.dateFin < ligne.dateFinEffective
    ? ligne.dateFin
    : ligne.dateFinEffective
}

// Projection LigneAdressage (modèle pur, Task 2/3) → NewDirectoryEntry
// (Task 5, forme de persistance du miroir) : A-MIRROR-KEY (`nature` propagée
// telle quelle, jamais durcie en 'D' — une ligne 'M' du F14 doit atteindre
// le miroir en tant que masquage, pas en tant que définition) + fin
// EFFECTIVE (jamais `dateFin` brute).
export function toDirectoryEntry(ligne: LigneAdressage): NewDirectoryEntry {
  return {
    siren: ligne.maille.siren,
    siret: ligne.maille.siret,
    routageId: ligne.maille.routageId,
    suffixe: ligne.maille.suffixe,
    nature: ligne.nature,
    dateDebut: ligne.dateDebut,
    dateFin: effectiveDateFin(ligne),
    plateforme: ligne.plateforme,
  }
}
