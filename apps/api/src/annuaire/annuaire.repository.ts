import { Injectable } from '@nestjs/common'
import { and, asc, desc, eq, isNull, notInArray, sql } from 'drizzle-orm'
import {
  annuaireConsents,
  annuaireDirectoryEntries,
  annuaireLigneEvents,
  annuaireLignes,
} from '../db/schema.js'
// biome-ignore lint/style/useImportType: TenantContextService est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { TenantContextService } from '../db/tenant-context.service.js'
import type { AnnuaireLigneStatus } from './annuaire-lifecycle.js'
import { assertTransition, motifRequired } from './annuaire-lifecycle.js'
import { coversTarget, type Maille } from './ligne-adressage.js'
import type { Nature } from './nomenclature.js'

export interface NewConsent {
  siren: string
  siret?: string
  routageId?: string
  suffixe?: string
  consentType: string
  signerIdentity: string
  evidenceRef: string
  obtainedAt: Date
}

export interface ConsentSummary {
  id: string
  siren: string
  siret: string | null
  routageId: string | null
  suffixe: string | null
  consentType: string
  signerIdentity: string
  evidenceRef: string
  obtainedAt: Date
  revokedAt: Date | null
  createdAt: Date
}

export interface NewLigne {
  siren: string
  siret?: string
  routageId?: string
  suffixe?: string
  nature: Nature
  dateDebut: string
  dateFin?: string
  plateforme: string
  // REQUIS (A-DEADLOCK/plan D5) : une ligne ne peut jamais exister sans sa
  // preuve de consentement (FK restrict, migration 0018).
  consentId: string
  // Rejet sémantique LOCAL pré-transmission (Task 8, injection revue
  // born-rejetee — miroir EreportingRepository.insertTransmission
  // /rejectMotif, 2.3-T8) : quand fourni, la ligne naît DIRECTEMENT
  // `rejetee` (événement de GENÈSE fromStatus=null → toStatus='rejetee',
  // actor='platform') — JAMAIS une transition draft→rejetee, INTERDITE par
  // la machine (Task 4, ALLOWED.draft = ['published'] seulement). Omis
  // (défaut) : comportement STRICTEMENT inchangé (statut initial 'draft').
  rejectMotif?: string
}

export interface LigneSummary {
  id: string
  siren: string
  siret: string | null
  routageId: string | null
  suffixe: string | null
  nature: Nature
  dateDebut: string
  dateFin: string | null
  plateforme: string
  status: AnnuaireLigneStatus
  consentId: string
  trackingRef: string | null
  rejectReason: string | null
  createdAt: Date
  updatedAt: Date
}

export interface LigneEventRow {
  fromStatus: AnnuaireLigneStatus | null
  toStatus: AnnuaireLigneStatus
  motif: string | null
  actor: string
  createdAt: Date
}

export interface NewDirectoryEntry {
  idInstance?: number
  siren: string
  siret?: string
  routageId?: string
  suffixe?: string
  nature: Nature
  dateDebut: string
  dateFin?: string
  plateforme: string
  sourceHorodate?: string
}

export interface DirectoryEntrySummary {
  id: string
  idInstance: number | null
  siren: string
  siret: string | null
  routageId: string | null
  suffixe: string | null
  nature: Nature
  dateDebut: string
  dateFin: string | null
  plateforme: string
  sourceHorodate: string | null
  createdAt: Date
  updatedAt: Date
}

// Amendement A-DEADLOCK point 3 (PRIME sur le plan — pas de
// onConflictDoNothing/reload) : la définition d'une ligne est USER-DRIVEN
// (pas un job worker idempotent, contrairement à insertTransmission 2.3) —
// insertLigne PROPAGE le conflit de slot en erreur TYPÉE, que Task 8 mappe
// en 409 (jamais un reload silencieux `created:false`).
export class LigneSlotConflictError extends Error {
  constructor(
    readonly siren: string,
    readonly dateDebut: string,
  ) {
    super(
      `annuaire ligne slot conflict: a Definition already occupies the (siren=${siren}, dateDebut=${dateDebut}) slot for this maille (active draft/published/deposee — cf. A-DEADLOCK)`,
    )
    this.name = 'LigneSlotConflictError'
  }
}

// drizzle-orm (>=0.36) enveloppe l'erreur pg dans une DrizzleQueryError et
// place l'erreur originale (celle qui porte le SQLSTATE `.code`) dans
// `.cause` — on remonte donc la chaîne de causes (bornée), miroir exact de
// InvoicesService.isUniqueViolation (invoices.service.ts). On exige EN PLUS
// `.constraint` === le nom exact de l'index partiel (migration 0018) pour
// ne jamais mapper à tort une AUTRE violation d'unicité 23505 (ex. futur
// index sur une autre colonne) en conflit de slot.
function isLigneSlotConflict(e: unknown): boolean {
  let current: unknown = e
  for (
    let depth = 0;
    depth < 5 && current !== null && current !== undefined;
    depth++
  ) {
    if (
      typeof current === 'object' &&
      (current as { code?: string }).code === '23505' &&
      (current as { constraint?: string }).constraint ===
        'annuaire_lignes_maille_date_definition_unique'
    ) {
      return true
    }
    current = (current as { cause?: unknown }).cause
  }
  return false
}

@Injectable()
export class AnnuaireRepository {
  constructor(private readonly tenant: TenantContextService) {}

  // Preuve de consentement (§3.5.5.5, D5) : INSERT seul, la révocation se
  // fait par `revokedAt` (pas de méthode de mutation ici — hors périmètre
  // Task 5). Task 8 (Produces/Endpoints) ne liste AUCUN endpoint/méthode de
  // révocation — DÉLIBÉRÉMENT DIFFÉRÉ (cf. rapport Task 8) : la colonne et
  // le grant UPDATE (migration 0019) existent déjà et permettent une
  // révocation par UPDATE direct (identique à
  // annuaire-persistence.e2e.test.ts) le jour où un endpoint/outillage
  // ops est spécifié.
  async insertConsent(
    tenantId: string,
    input: NewConsent,
  ): Promise<{ id: string }> {
    return this.tenant.run(tenantId, async (db) => {
      const [row] = await db
        .insert(annuaireConsents)
        .values({
          tenantId,
          siren: input.siren,
          siret: input.siret ?? null,
          routageId: input.routageId ?? null,
          suffixe: input.suffixe ?? null,
          consentType: input.consentType,
          signerIdentity: input.signerIdentity,
          evidenceRef: input.evidenceRef,
          obtainedAt: input.obtainedAt,
        })
        .returning({ id: annuaireConsents.id })
      if (!row) throw new Error('insertConsent returned no row')
      return { id: row.id }
    })
  }

  // Amendement A-CONSENT (HIGH) — gate de publication (D5) : un consentement
  // COUVRE `maille` ssi même SIREN ET non révoqué ET la maille du
  // consentement est ÉGALE OU PLUS LARGE que `maille` (réutilise
  // EXACTEMENT `coversTarget`, ligne-adressage.ts, Task 2 — même hiérarchie
  // SIREN < SIREN_SIRET < {SIREN_SIRET_ROUTAGE, SIREN_SUFFIXE} que la
  // résolution de routage). MARQUÉ INTERPRÉTATION go-live : le modèle de
  // preuve/portée du consentement n'est pas normé (§3.5.5.5). Renvoie le
  // premier consentement couvrant trouvé (existence, pas une élection —
  // aucune sémantique de « meilleur » consentement n'est requise ici).
  async findActiveConsent(
    tenantId: string,
    maille: Maille,
  ): Promise<ConsentSummary | null> {
    return this.tenant.run(tenantId, async (db) => {
      const rows = await db
        .select({
          id: annuaireConsents.id,
          siren: annuaireConsents.siren,
          siret: annuaireConsents.siret,
          routageId: annuaireConsents.routageId,
          suffixe: annuaireConsents.suffixe,
          consentType: annuaireConsents.consentType,
          signerIdentity: annuaireConsents.signerIdentity,
          evidenceRef: annuaireConsents.evidenceRef,
          obtainedAt: annuaireConsents.obtainedAt,
          revokedAt: annuaireConsents.revokedAt,
          createdAt: annuaireConsents.createdAt,
        })
        .from(annuaireConsents)
        .where(
          and(
            eq(annuaireConsents.siren, maille.siren),
            isNull(annuaireConsents.revokedAt),
          ),
        )
        .orderBy(asc(annuaireConsents.obtainedAt))
      for (const row of rows) {
        const consentMaille: Maille = {
          siren: row.siren,
          siret: row.siret ?? undefined,
          routageId: row.routageId ?? undefined,
          suffixe: row.suffixe ?? undefined,
        }
        if (coversTarget(maille, consentMaille)) return row
      }
      return null
    })
  }

  // Lecture RLS-scopée d'un consentement par id (Task 8 : chemin
  // `consentId` explicite du body `POST /annuaire/lignes` — l'appelant DOIT
  // encore vérifier `revokedAt`/couverture, cf. AnnuairePublicationService ;
  // cette méthode ne fait qu'exposer la ligne, elle n'arbitre rien).
  async findConsentById(
    tenantId: string,
    id: string,
  ): Promise<ConsentSummary | null> {
    return this.tenant.run(tenantId, async (db) => {
      const rows = await db
        .select({
          id: annuaireConsents.id,
          siren: annuaireConsents.siren,
          siret: annuaireConsents.siret,
          routageId: annuaireConsents.routageId,
          suffixe: annuaireConsents.suffixe,
          consentType: annuaireConsents.consentType,
          signerIdentity: annuaireConsents.signerIdentity,
          evidenceRef: annuaireConsents.evidenceRef,
          obtainedAt: annuaireConsents.obtainedAt,
          revokedAt: annuaireConsents.revokedAt,
          createdAt: annuaireConsents.createdAt,
        })
        .from(annuaireConsents)
        .where(eq(annuaireConsents.id, id))
        .limit(1)
      return rows[0] ?? null
    })
  }

  // INSERT (statut initial `draft`, consentId REQUIS) + événement genèse
  // `draft` (from=NULL, actor='platform') dans la MÊME transaction — miroir
  // d'InvoicesRepository.insertReceived / EreportingRepository
  // .insertTransmission. Amendement A-DEADLOCK : sur conflit d'index
  // partiel (23505), PROPAGE LigneSlotConflictError — PAS de
  // onConflictDoNothing/reload (publication USER-DRIVEN, pas un rejeu
  // worker idempotent).
  async insertLigne(
    tenantId: string,
    input: NewLigne,
  ): Promise<{ id: string }> {
    return this.tenant.run(tenantId, async (db) => {
      // Born-rejetee (Task 8) : statut initial 'rejetee' quand `rejectMotif`
      // est fourni — cette ligne n'occupe JAMAIS le slot d'adressage (l'index
      // partiel migration 0018 exclut `status IN ('rejetee','masked')`), donc
      // aucun risque de conflit 23505 même si une Définition active existe
      // déjà sur la même maille×date.
      const initialStatus: AnnuaireLigneStatus = input.rejectMotif
        ? 'rejetee'
        : 'draft'
      let inserted: { id: string }[]
      try {
        inserted = await db
          .insert(annuaireLignes)
          .values({
            tenantId,
            siren: input.siren,
            siret: input.siret ?? null,
            routageId: input.routageId ?? null,
            suffixe: input.suffixe ?? null,
            nature: input.nature,
            dateDebut: input.dateDebut,
            dateFin: input.dateFin ?? null,
            plateforme: input.plateforme,
            consentId: input.consentId,
            status: initialStatus,
            rejectReason: input.rejectMotif ?? null,
          })
          .returning({ id: annuaireLignes.id })
      } catch (err) {
        if (isLigneSlotConflict(err)) {
          throw new LigneSlotConflictError(input.siren, input.dateDebut)
        }
        throw err
      }
      const row = inserted[0]
      if (!row) throw new Error('insertLigne returned no row')
      await db.insert(annuaireLigneEvents).values({
        tenantId,
        ligneId: row.id,
        fromStatus: null,
        toStatus: initialStatus,
        motif: input.rejectMotif ?? null,
        actor: 'platform',
      })
      return { id: row.id }
    })
  }

  // 'draft' → 'published' (CAS anti-race, miroir EreportingRepository
  // .markTransmitted) + trackingRef + événement journal, en une transaction.
  async markPublished(
    tenantId: string,
    id: string,
    trackingRef: string,
  ): Promise<void> {
    assertTransition('draft', 'published')
    await this.tenant.run(tenantId, async (db) => {
      const updated = await db
        .update(annuaireLignes)
        .set({ status: 'published', trackingRef, updatedAt: new Date() })
        .where(
          and(eq(annuaireLignes.id, id), eq(annuaireLignes.status, 'draft')),
        )
        .returning({ id: annuaireLignes.id })
      if (updated.length === 0) {
        throw new Error(
          `markPublished: ligne ${id} is not in 'draft' status (concurrent transition or unknown id)`,
        )
      }
      await db.insert(annuaireLigneEvents).values({
        tenantId,
        ligneId: id,
        fromStatus: 'draft',
        toStatus: 'published',
        actor: 'platform',
      })
    })
  }

  // Transition générique du cycle de vie (Task 4 : `assertTransition` valide
  // le couple from→to, `motifRequired` impose un motif ssi to='rejetee').
  // CAS anti-race identique à markPublished. Sur `to==='rejetee'`, le motif
  // (libre, D6) est AUSSI reporté sur `rejectReason` de la ligne (miroir de
  // trackingRef sur markPublished) — l'événement journal en garde par
  // ailleurs la trace immuable.
  async appendLigneEvent(
    tenantId: string,
    id: string,
    from: AnnuaireLigneStatus,
    to: AnnuaireLigneStatus,
    actor: string,
    motif?: string,
  ): Promise<void> {
    assertTransition(from, to)
    if (motifRequired(to) && !motif) {
      throw new Error(
        `appendLigneEvent: motif is required for transition to '${to}'`,
      )
    }
    await this.tenant.run(tenantId, async (db) => {
      const updates: Partial<typeof annuaireLignes.$inferInsert> = {
        status: to,
        updatedAt: new Date(),
      }
      if (to === 'rejetee') updates.rejectReason = motif ?? null
      const updated = await db
        .update(annuaireLignes)
        .set(updates)
        .where(and(eq(annuaireLignes.id, id), eq(annuaireLignes.status, from)))
        .returning({ id: annuaireLignes.id })
      if (updated.length === 0) {
        throw new Error(
          `appendLigneEvent: ligne ${id} is not in '${from}' status (concurrent transition or unknown id)`,
        )
      }
      await db.insert(annuaireLigneEvents).values({
        tenantId,
        ligneId: id,
        fromStatus: from,
        toStatus: to,
        motif: motif ?? null,
        actor,
      })
    })
  }

  // Lecture RLS-scopée d'une ligne unique (Task 8 : existence/appartenance
  // tenant pour le 404 anti-fuite des endpoints PUT/DELETE, miroir
  // EreportingRepository.findTransmissionStatus — ici la ligne COMPLÈTE, pas
  // seulement le statut, car `endEffect` a aussi besoin de `dateDebut`).
  async findLigne(tenantId: string, id: string): Promise<LigneSummary | null> {
    return this.tenant.run(tenantId, async (db) => {
      const rows = await db
        .select({
          id: annuaireLignes.id,
          siren: annuaireLignes.siren,
          siret: annuaireLignes.siret,
          routageId: annuaireLignes.routageId,
          suffixe: annuaireLignes.suffixe,
          nature: annuaireLignes.nature,
          dateDebut: annuaireLignes.dateDebut,
          dateFin: annuaireLignes.dateFin,
          plateforme: annuaireLignes.plateforme,
          status: annuaireLignes.status,
          consentId: annuaireLignes.consentId,
          trackingRef: annuaireLignes.trackingRef,
          rejectReason: annuaireLignes.rejectReason,
          createdAt: annuaireLignes.createdAt,
          updatedAt: annuaireLignes.updatedAt,
        })
        .from(annuaireLignes)
        .where(eq(annuaireLignes.id, id))
        .limit(1)
      return rows[0] ?? null
    })
  }

  // "Fin d'effet" (Task 8, PUT /annuaire/lignes/:id) : positionne `dateFin`
  // SANS transiter le statut (ce n'est pas un changement de cycle de vie,
  // Task 4 — aucun événement journal n'est donc écrit ici). Exclut les
  // statuts TERMINAUX (`rejetee`/`masked`, annuaire-lifecycle.ts) : une ligne
  // déjà close ne peut plus voir sa période modifiée. Renvoie `false` si
  // aucune ligne n'a été affectée (id inconnu/hors tenant/déjà terminale) —
  // à l'appelant de distinguer 404 (existence, via `findLigne`) de 409
  // (statut terminal).
  async updateDateFin(
    tenantId: string,
    id: string,
    dateFin: string,
  ): Promise<boolean> {
    return this.tenant.run(tenantId, async (db) => {
      const updated = await db
        .update(annuaireLignes)
        .set({ dateFin, updatedAt: new Date() })
        .where(
          and(
            eq(annuaireLignes.id, id),
            notInArray(annuaireLignes.status, ['rejetee', 'masked']),
          ),
        )
        .returning({ id: annuaireLignes.id })
      return updated.length > 0
    })
  }

  async listLignes(tenantId: string): Promise<LigneSummary[]> {
    return this.tenant.run(tenantId, async (db) => {
      return db
        .select({
          id: annuaireLignes.id,
          siren: annuaireLignes.siren,
          siret: annuaireLignes.siret,
          routageId: annuaireLignes.routageId,
          suffixe: annuaireLignes.suffixe,
          nature: annuaireLignes.nature,
          dateDebut: annuaireLignes.dateDebut,
          dateFin: annuaireLignes.dateFin,
          plateforme: annuaireLignes.plateforme,
          status: annuaireLignes.status,
          consentId: annuaireLignes.consentId,
          trackingRef: annuaireLignes.trackingRef,
          rejectReason: annuaireLignes.rejectReason,
          createdAt: annuaireLignes.createdAt,
          updatedAt: annuaireLignes.updatedAt,
        })
        .from(annuaireLignes)
        .orderBy(desc(annuaireLignes.createdAt))
    })
  }

  async listLigneEvents(
    tenantId: string,
    ligneId: string,
  ): Promise<LigneEventRow[]> {
    return this.tenant.run(tenantId, async (db) => {
      return db
        .select({
          fromStatus: annuaireLigneEvents.fromStatus,
          toStatus: annuaireLigneEvents.toStatus,
          motif: annuaireLigneEvents.motif,
          actor: annuaireLigneEvents.actor,
          createdAt: annuaireLigneEvents.createdAt,
        })
        .from(annuaireLigneEvents)
        .where(eq(annuaireLigneEvents.ligneId, ligneId))
        .orderBy(asc(annuaireLigneEvents.createdAt))
    })
  }

  // Upsert IDEMPOTENT du miroir de consultation (backstop DB de la sync,
  // D9) sur la clé unique incluant `nature` (A-MIRROR-KEY). L'index cible
  // est une clé D'EXPRESSIONS (coalesce(...)) : drizzle-orm ne peut exprimer
  // `onConflictDoUpdate({ target })` que sur des colonnes nues (type
  // `IndexColumn`), pas sur des expressions — d'où le SQL brut. Le ciblage
  // se fait par LISTE D'EXPRESSIONS (`ON CONFLICT (coalesce(...), ...)`),
  // PAS par `ON CONFLICT ON CONSTRAINT <nom>` : ce dernier n'accepte que les
  // contraintes de `pg_constraint` (UNIQUE/EXCLUDE ajoutées via `ALTER TABLE
  // ADD CONSTRAINT`), alors que l'index unique généré par drizzle-kit
  // (migration 0018) est un `CREATE UNIQUE INDEX` — absent de
  // `pg_constraint` (42704 constaté à l'exécution). L'inférence d'arbitre de
  // Postgres sur `ON CONFLICT (<expressions>)` matche en revanche
  // n'importe quel index unique dont la définition correspond EXACTEMENT à
  // cette liste d'expressions, qu'il ait été créé via contrainte ou via
  // `CREATE INDEX` — cf. migration 0018 pour la définition exacte de
  // l'index visé ici.
  async upsertDirectoryEntries(
    tenantId: string,
    entries: NewDirectoryEntry[],
  ): Promise<void> {
    if (entries.length === 0) return
    await this.tenant.run(tenantId, async (db) => {
      for (const entry of entries) {
        await db.execute(sql`
          INSERT INTO annuaire_directory_entries
            (tenant_id, id_instance, siren, siret, routage_id, suffixe, nature, date_debut, date_fin, plateforme, source_horodate)
          VALUES (
            ${tenantId}, ${entry.idInstance ?? null}, ${entry.siren}, ${entry.siret ?? null},
            ${entry.routageId ?? null}, ${entry.suffixe ?? null}, ${entry.nature}, ${entry.dateDebut},
            ${entry.dateFin ?? null}, ${entry.plateforme}, ${entry.sourceHorodate ?? null}
          )
          ON CONFLICT (tenant_id, siren, coalesce(siret, ''), coalesce(routage_id, ''), coalesce(suffixe, ''), date_debut, nature)
          DO UPDATE SET
            id_instance = EXCLUDED.id_instance,
            date_fin = EXCLUDED.date_fin,
            plateforme = EXCLUDED.plateforme,
            source_horodate = EXCLUDED.source_horodate,
            updated_at = now()
        `)
      }
    })
  }

  async findDirectoryEntries(
    tenantId: string,
    siren: string,
  ): Promise<DirectoryEntrySummary[]> {
    return this.tenant.run(tenantId, async (db) => {
      return db
        .select({
          id: annuaireDirectoryEntries.id,
          idInstance: annuaireDirectoryEntries.idInstance,
          siren: annuaireDirectoryEntries.siren,
          siret: annuaireDirectoryEntries.siret,
          routageId: annuaireDirectoryEntries.routageId,
          suffixe: annuaireDirectoryEntries.suffixe,
          nature: annuaireDirectoryEntries.nature,
          dateDebut: annuaireDirectoryEntries.dateDebut,
          dateFin: annuaireDirectoryEntries.dateFin,
          plateforme: annuaireDirectoryEntries.plateforme,
          sourceHorodate: annuaireDirectoryEntries.sourceHorodate,
          createdAt: annuaireDirectoryEntries.createdAt,
          updatedAt: annuaireDirectoryEntries.updatedAt,
        })
        .from(annuaireDirectoryEntries)
        .where(eq(annuaireDirectoryEntries.siren, siren))
        .orderBy(asc(annuaireDirectoryEntries.dateDebut))
    })
  }
}
