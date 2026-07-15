import type { Invoice } from '@factelec/invoice-core'
import { Injectable } from '@nestjs/common'
import { and, asc, desc, eq, lt, or, sql } from 'drizzle-orm'
import {
  invoiceFormats,
  type invoiceStatus,
  invoiceStatusEvents,
  invoices,
} from '../db/schema.js'
// biome-ignore lint/style/useImportType: TenantContextService est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { TenantContextService } from '../db/tenant-context.service.js'
import { decodeCursor, encodeCursor } from './cursor.js'
import type { FormatKind, GeneratedFormat } from './format-generator.port.js'
import type { LifecycleStatus } from './lifecycle-status.js'

export type GenerationStatus = (typeof invoiceStatus.enumValues)[number]

export interface InvoiceSummary {
  id: string
  number: string
  typeCode: string
  issueDate: string
  currency: string
  status: string
  lifecycleStatus: string
  createdAt: Date
}

export interface StatusEvent {
  fromStatus: string | null
  toStatus: string
  actor: string
  reason: string | null
  createdAt: Date
}

// Événement SCELLÉ (Task 4) — miroir des colonnes de scellement chaîné
// (seal_status_event, migration 0012) : consommé par LedgerVerificationService
// pour recalculer/comparer la chaîne. Identité probative = (tenant_id, seq) ;
// `id` (PK surrogate) reste hors périmètre probatoire, volontairement absent
// d'ici (les appelants ne doivent jamais référencer un événement par `id`).
export interface SealedEvent {
  seq: number
  invoiceId: string
  fromStatus: string | null
  toStatus: string
  actor: string
  reason: string | null
  createdAt: Date
  prevHash: Buffer
  hash: Buffer
}

@Injectable()
export class InvoicesRepository {
  constructor(private readonly tenant: TenantContextService) {}

  // Persiste la SEULE ligne facture au statut de génération `received`.
  // Idempotence (tenant, number) portée par la contrainte unique → 23505 → 409.
  async insertReceived(
    tenantId: string,
    invoice: Invoice,
  ): Promise<{ id: string }> {
    return this.tenant.run(tenantId, async (db) => {
      const [row] = await db
        .insert(invoices)
        .values({
          tenantId,
          number: invoice.number,
          typeCode: invoice.typeCode,
          issueDate: invoice.issueDate,
          currency: invoice.currency,
          status: 'received',
          canonical: invoice,
          // lifecycle_status : défaut 'deposee' (colonne).
        })
        .returning({ id: invoices.id })
      if (!row) throw new Error('insert into invoices returned no row')
      // Journal append-only : événement initial de dépôt (Déposée / code 200).
      await db.insert(invoiceStatusEvents).values({
        tenantId,
        invoiceId: row.id,
        fromStatus: null,
        toStatus: 'deposee',
        actor: 'platform',
      })
      return { id: row.id }
    })
  }

  // Amendement A1 (plan 2.1, Task 3, décision contrôleur) : succès de
  // génération ATOMIQUE — delete+insert des formats ET passage du statut à
  // `generated` dans UNE SEULE transaction tenant (remplace l'ancien couple
  // saveFormats()+markGenerationStatus('generated') appelés séparément par le
  // processor). Un crash entre les deux anciennes étapes laissait une fenêtre
  // observable où les formats existaient déjà mais le statut restait
  // `generating` ; ici c'est tout ou rien (COMMIT unique). Rejeu sûr
  // identique à l'ex-saveFormats : delete puis insert, la contrainte
  // unique(invoice_id, kind) interdit les doublons — un retry (ou un rejeu
  // explicite de job) reconverge vers exactement le même état.
  async completeGeneration(
    tenantId: string,
    invoiceId: string,
    formats: GeneratedFormat[],
  ): Promise<void> {
    await this.tenant.run(tenantId, async (db) => {
      await db
        .delete(invoiceFormats)
        .where(eq(invoiceFormats.invoiceId, invoiceId))
      if (formats.length > 0) {
        await db.insert(invoiceFormats).values(
          formats.map((f) => ({
            tenantId,
            invoiceId,
            kind: f.kind,
            contentType: f.contentType,
            bodyText: f.bodyText,
            bodyBytes: f.bodyBytes,
            byteSize: f.byteSize,
          })),
        )
      }
      await db
        .update(invoices)
        .set({ status: 'generated', updatedAt: new Date() })
        .where(eq(invoices.id, invoiceId))
    })
  }

  async markGenerationStatus(
    tenantId: string,
    invoiceId: string,
    status: GenerationStatus,
  ): Promise<void> {
    await this.tenant.run(tenantId, async (db) => {
      await db
        .update(invoices)
        .set({ status, updatedAt: new Date() })
        .where(eq(invoices.id, invoiceId))
    })
  }

  // Recharge le canonical pour le worker (payload de job = ids only, cf.
  // invoice-generation.job.ts) — le contenu de la facture ne transite jamais
  // par Redis, seul ce chargement sous RLS y accède.
  async loadCanonical(
    tenantId: string,
    invoiceId: string,
  ): Promise<Invoice | null> {
    return this.tenant.run(tenantId, async (db) => {
      const rows = await db
        .select({ canonical: invoices.canonical })
        .from(invoices)
        .where(eq(invoices.id, invoiceId))
        .limit(1)
      return rows[0]?.canonical ?? null
    })
  }

  async findById(tenantId: string, id: string): Promise<InvoiceSummary | null> {
    return this.tenant.run(tenantId, async (db) => {
      const rows = await db
        .select({
          id: invoices.id,
          number: invoices.number,
          typeCode: invoices.typeCode,
          issueDate: invoices.issueDate,
          currency: invoices.currency,
          status: invoices.status,
          lifecycleStatus: invoices.lifecycleStatus,
          createdAt: invoices.createdAt,
        })
        .from(invoices)
        .where(eq(invoices.id, id))
        .limit(1)
      return rows[0] ?? null
    })
  }

  async getLifecycleStatus(
    tenantId: string,
    invoiceId: string,
  ): Promise<LifecycleStatus | null> {
    return this.tenant.run(tenantId, async (db) => {
      const rows = await db
        .select({ lifecycleStatus: invoices.lifecycleStatus })
        .from(invoices)
        .where(eq(invoices.id, invoiceId))
        .limit(1)
      return (rows[0]?.lifecycleStatus as LifecycleStatus | undefined) ?? null
    })
  }

  // Optimiste (anti-race) : n'écrit QUE si le statut courant est toujours
  // `from`. Retourne false si 0 ligne mise à jour (transition concurrente) →
  // le service traduit en 409. Événement inscrit dans la MÊME transaction.
  async recordTransition(
    tenantId: string,
    invoiceId: string,
    from: LifecycleStatus,
    to: LifecycleStatus,
    actor: string,
    reason: string | undefined,
  ): Promise<boolean> {
    return this.tenant.run(tenantId, async (db) => {
      const updated = await db
        .update(invoices)
        .set({ lifecycleStatus: to, updatedAt: new Date() })
        .where(
          and(eq(invoices.id, invoiceId), eq(invoices.lifecycleStatus, from)),
        )
        .returning({ id: invoices.id })
      if (updated.length === 0) return false
      await db.insert(invoiceStatusEvents).values({
        tenantId,
        invoiceId,
        fromStatus: from,
        toStatus: to,
        actor,
        reason: reason ?? null,
      })
      return true
    })
  }

  async listStatusEvents(
    tenantId: string,
    invoiceId: string,
  ): Promise<StatusEvent[]> {
    return this.tenant.run(tenantId, async (db) => {
      return db
        .select({
          fromStatus: invoiceStatusEvents.fromStatus,
          toStatus: invoiceStatusEvents.toStatus,
          actor: invoiceStatusEvents.actor,
          reason: invoiceStatusEvents.reason,
          createdAt: invoiceStatusEvents.createdAt,
        })
        .from(invoiceStatusEvents)
        .where(eq(invoiceStatusEvents.invoiceId, invoiceId))
        .orderBy(asc(invoiceStatusEvents.createdAt))
    })
  }

  // Lecture sous RLS des événements scellés d'UNE facture, triés par seq
  // croissant — support du self-check par-facture (LedgerVerificationService
  // .verifyInvoiceEvents). `prev_hash`/`hash` (bytea) reviennent en `Buffer`
  // via pg (customType `bytea`) ; `seq` (bigint mode `number`) revient en
  // `number`.
  async loadSealedEventsByInvoice(
    tenantId: string,
    invoiceId: string,
  ): Promise<SealedEvent[]> {
    return this.tenant.run(tenantId, async (db) => {
      const rows = await db
        .select({
          seq: invoiceStatusEvents.seq,
          invoiceId: invoiceStatusEvents.invoiceId,
          fromStatus: invoiceStatusEvents.fromStatus,
          toStatus: invoiceStatusEvents.toStatus,
          actor: invoiceStatusEvents.actor,
          reason: invoiceStatusEvents.reason,
          createdAt: invoiceStatusEvents.createdAt,
          prevHash: invoiceStatusEvents.prevHash,
          hash: invoiceStatusEvents.hash,
        })
        .from(invoiceStatusEvents)
        .where(eq(invoiceStatusEvents.invoiceId, invoiceId))
        .orderBy(asc(invoiceStatusEvents.seq))
      return rows as SealedEvent[]
    })
  }

  // Lecture sous RLS de TOUS les événements scellés du tenant, triés par seq
  // croissant — support de la vérification de chaîne complète
  // (LedgerVerificationService.verifyTenantChain : genesis, contiguïté,
  // linkage, hash). O(n) sur le nombre d'événements du tenant ; acceptable
  // pour un endpoint d'audit (pas un hot path) — une pagination/borne pourra
  // être ajoutée si un tenant devient très volumineux (différé).
  async loadSealedEventsByTenant(tenantId: string): Promise<SealedEvent[]> {
    return this.tenant.run(tenantId, async (db) => {
      const rows = await db
        .select({
          seq: invoiceStatusEvents.seq,
          invoiceId: invoiceStatusEvents.invoiceId,
          fromStatus: invoiceStatusEvents.fromStatus,
          toStatus: invoiceStatusEvents.toStatus,
          actor: invoiceStatusEvents.actor,
          reason: invoiceStatusEvents.reason,
          createdAt: invoiceStatusEvents.createdAt,
          prevHash: invoiceStatusEvents.prevHash,
          hash: invoiceStatusEvents.hash,
        })
        .from(invoiceStatusEvents)
        .orderBy(asc(invoiceStatusEvents.seq))
      return rows as SealedEvent[]
    })
  }

  async listFormatKinds(
    tenantId: string,
    invoiceId: string,
  ): Promise<FormatKind[]> {
    return this.tenant.run(tenantId, async (db) => {
      const rows = await db
        .select({ kind: invoiceFormats.kind })
        .from(invoiceFormats)
        .where(eq(invoiceFormats.invoiceId, invoiceId))
      return rows.map((r) => r.kind as FormatKind)
    })
  }

  // where(keyset) avec keyset = undefined (1re page) ne filtre rien — la RLS
  // reste le seul filtre tenant. eq(invoices.tenantId, …) est redondant (RLS)
  // ; on le laisse implicite pour ne pas dupliquer la garde.
  //
  // Précision du curseur (fix task-8) : `created_at` est un timestamptz
  // Postgres à précision MICROseconde (defaultNow()), mais le driver pg
  // matérialise cette colonne en Date JS, qui n'a qu'une précision
  // MILLIseconde. Construire le curseur/la borne keyset à partir de ce Date
  // tronque les microsecondes : deux lignes partageant la même milliseconde
  // mais avec des microsecondes différentes ne sont alors ni `<` ni `=` par
  // rapport à la borne tronquée → une ligne peut être silencieusement sautée
  // entre deux pages (déclencheur réaliste : ingestions en lot dans la même
  // ms). On sélectionne donc EN PLUS `createdAtRaw`, la représentation texte
  // exacte (microseconde, UTC, format déterministe indépendant du réglage de
  // TimeZone de la session) via `to_char(... AT TIME ZONE 'UTC', ...)`, et on
  // l'utilise pour encoder le curseur ET pour la comparaison SQL de la borne
  // (castée `::timestamptz`, jamais reconvertie en Date JS). `createdAt`
  // (Date, précision ms) reste inchangé côté API publique — seule la
  // mécanique interne du curseur est micro-précise.
  async list(
    tenantId: string,
    limit: number,
    cursor?: string,
  ): Promise<{ items: InvoiceSummary[]; nextCursor: string | null }> {
    return this.tenant.run(tenantId, async (db) => {
      const decoded = cursor ? decodeCursor(cursor) : null
      const boundary = decoded ? sql`${decoded.createdAt}::timestamptz` : null
      const keyset =
        decoded && boundary
          ? or(
              lt(invoices.createdAt, boundary),
              and(
                eq(invoices.createdAt, boundary),
                lt(invoices.id, decoded.id),
              ),
            )
          : undefined
      const createdAtRaw = sql<string>`to_char(${invoices.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
      const rows = await db
        .select({
          id: invoices.id,
          number: invoices.number,
          typeCode: invoices.typeCode,
          issueDate: invoices.issueDate,
          currency: invoices.currency,
          status: invoices.status,
          lifecycleStatus: invoices.lifecycleStatus,
          createdAt: invoices.createdAt,
          createdAtRaw,
        })
        .from(invoices)
        .where(keyset)
        .orderBy(desc(invoices.createdAt), desc(invoices.id))
        .limit(limit + 1)
      const hasMore = rows.length > limit
      const rowsInPage = hasMore ? rows.slice(0, limit) : rows
      const last = rowsInPage.at(-1)
      const nextCursor =
        hasMore && last ? encodeCursor(last.createdAtRaw, last.id) : null
      const items: InvoiceSummary[] = rowsInPage.map(
        ({ createdAtRaw: _createdAtRaw, ...rest }) => rest,
      )
      return { items, nextCursor }
    })
  }

  // Recharge les 5 formats persistés (Task 6, archivage) — support du bundle
  // probatoire (ArchiveService), qui embarque le contenu intégral de chaque
  // format généré.
  async loadAllFormats(
    tenantId: string,
    invoiceId: string,
  ): Promise<
    {
      kind: string
      contentType: string
      bodyText: string | null
      bodyBytes: Buffer | null
      byteSize: number
    }[]
  > {
    return this.tenant.run(tenantId, async (db) => {
      return db
        .select({
          kind: invoiceFormats.kind,
          contentType: invoiceFormats.contentType,
          bodyText: invoiceFormats.bodyText,
          bodyBytes: invoiceFormats.bodyBytes,
          byteSize: invoiceFormats.byteSize,
        })
        .from(invoiceFormats)
        .where(eq(invoiceFormats.invoiceId, invoiceId))
    })
  }

  // Marque le résultat de l'archivage best-effort (Task 6). `location`/`hash`
  // omis (ex. passage à `failed`) → effacés (pas d'empreinte stale d'une
  // tentative précédente).
  async markArchiveStatus(
    tenantId: string,
    invoiceId: string,
    status: 'pending' | 'archived' | 'failed',
    location?: string,
    hash?: string,
  ): Promise<void> {
    await this.tenant.run(tenantId, async (db) => {
      await db
        .update(invoices)
        .set({
          archiveStatus: status,
          archiveLocation: location ?? null,
          archiveHash: hash ?? null,
          updatedAt: new Date(),
        })
        .where(eq(invoices.id, invoiceId))
    })
  }

  async findArchiveState(
    tenantId: string,
    invoiceId: string,
  ): Promise<{
    status: string
    location: string | null
    hash: string | null
  } | null> {
    return this.tenant.run(tenantId, async (db) => {
      const rows = await db
        .select({
          status: invoices.archiveStatus,
          location: invoices.archiveLocation,
          hash: invoices.archiveHash,
        })
        .from(invoices)
        .where(eq(invoices.id, invoiceId))
        .limit(1)
      return rows[0] ?? null
    })
  }

  async findFormat(
    tenantId: string,
    invoiceId: string,
    kind: FormatKind,
  ): Promise<{
    contentType: string
    bodyText: string | null
    bodyBytes: Buffer | null
  } | null> {
    return this.tenant.run(tenantId, async (db) => {
      const rows = await db
        .select({
          contentType: invoiceFormats.contentType,
          bodyText: invoiceFormats.bodyText,
          bodyBytes: invoiceFormats.bodyBytes,
        })
        .from(invoiceFormats)
        .where(
          and(
            eq(invoiceFormats.invoiceId, invoiceId),
            eq(invoiceFormats.kind, kind),
          ),
        )
        .limit(1)
      return rows[0] ?? null
    })
  }
}
