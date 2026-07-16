import { Injectable } from '@nestjs/common'
// biome-ignore lint/style/useImportType: AnnuaireRepository est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import {
  AnnuaireRepository,
  type DirectoryEntrySummary,
} from './annuaire.repository.js'
import {
  type LigneAdressage,
  type Maille,
  resolveRecipient as resolveRoutage,
} from './ligne-adressage.js'
import type { Nature } from './nomenclature.js'

// Vue publique d'une entrée du miroir de consultation — recherche `GET
// /annuaire/lignes` (Task 7, plan 2.4). Miroir 1:1 de `DirectoryEntrySummary`
// (annuaire.repository.ts, Task 5) : aucune donnée hors tenant n'est
// exposée ici, `findDirectoryEntries` filtre déjà sous RLS.
export interface DirectoryEntryView {
  id: string
  siren: string
  siret: string | null
  routageId: string | null
  suffixe: string | null
  nature: Nature
  dateDebut: string
  dateFin: string | null
  plateforme: string
  sourceHorodate: string | null
}

function toView(entry: DirectoryEntrySummary): DirectoryEntryView {
  return {
    id: entry.id,
    siren: entry.siren,
    siret: entry.siret,
    routageId: entry.routageId,
    suffixe: entry.suffixe,
    nature: entry.nature,
    dateDebut: entry.dateDebut,
    dateFin: entry.dateFin,
    plateforme: entry.plateforme,
    sourceHorodate: entry.sourceHorodate,
  }
}

// Adapte une ligne du miroir de persistance (colonnes nullables) vers le
// modèle pur `LigneAdressage` (Task 2 : `siret`/`routageId`/`suffixe`/
// `dateFin` ABSENTS plutôt que `null` — cf. `coversTarget`/`mailleKey`, qui
// distinguent explicitement absence et chaîne vide).
function toLigneAdressage(entry: DirectoryEntrySummary): LigneAdressage {
  return {
    maille: {
      siren: entry.siren,
      siret: entry.siret ?? undefined,
      routageId: entry.routageId ?? undefined,
      suffixe: entry.suffixe ?? undefined,
    },
    nature: entry.nature,
    dateDebut: entry.dateDebut,
    dateFin: entry.dateFin ?? undefined,
    plateforme: entry.plateforme,
  }
}

// Service de consultation + résolution de routage (Task 7, plan 2.4) — la
// brique que le futur routage d'émission consommera (câblage différé,
// périmètre). Lit le miroir tenant-scopé SOUS RLS (`findDirectoryEntries`,
// Task 5) puis délègue la résolution proprement dite à `resolveRecipient`
// (Task 2, ligne-adressage.ts) : ce service n'implémente AUCUNE logique de
// spécificité/masquage/départage lui-même — il adapte seulement le miroir
// persisté vers le modèle pur.
//
// ORDRE-INDÉPENDANCE (injection revue T2 nits, pinnée à CETTE couche de
// consommation) : `resolveRecipient` départage par `reduce` sur
// `dateDebut`/rang de spécificité (ligne-adressage.ts, `pickMaxByDateDebut`/
// `pickMaxByRank`) — jamais par « premier trouvé » — le résultat est donc
// insensible à l'ordre du tableau `entries` renvoyé par le repository,
// quel que soit l'ordre de tri SQL ou d'insertion. Prouvé explicitement à
// cette couche par `annuaire-consultation.service.test.ts` (tableau
// d'entrées permuté → même plateforme résolue) et par
// `annuaire-consultation.e2e.test.ts` (deux tenants, ordres d'insertion
// inversés → même résolution).
@Injectable()
export class AnnuaireConsultationService {
  constructor(private readonly repo: AnnuaireRepository) {}

  async listDirectoryEntries(
    tenantId: string,
    siren: string,
  ): Promise<DirectoryEntryView[]> {
    const entries = await this.repo.findDirectoryEntries(tenantId, siren)
    return entries.map(toView)
  }

  // Résout le matricule de plateforme destinataire pour `maille` à
  // `dateYmd`. Propage TEL QUEL `RecipientUnaddressableError`/
  // `AmbiguousResolutionError` (Task 2) — c'est au contrôleur HTTP de les
  // mapper en réponses anti-fuite (404/409, cf. annuaire.controller.ts) ;
  // ce service reste une couche de domaine, sans connaissance HTTP.
  async resolveRecipient(
    tenantId: string,
    maille: Maille,
    dateYmd: string,
  ): Promise<{ plateforme: string }> {
    const entries = await this.repo.findDirectoryEntries(tenantId, maille.siren)
    const lignes = entries.map(toLigneAdressage)
    const plateforme = resolveRoutage(lignes, maille, dateYmd)
    return { plateforme }
  }
}
