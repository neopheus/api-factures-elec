import type { Invoice } from '@factelec/invoice-core'
import { Injectable } from '@nestjs/common'
import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm'
import {
  ereportingDeclarants,
  ereportingStatusEvents,
  ereportingTransmissions,
  invoices,
} from '../db/schema.js'
// biome-ignore lint/style/useImportType: TenantContextService est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { TenantContextService } from '../db/tenant-context.service.js'
import type { EreportingStatus } from './ereporting-lifecycle.js'
import { assertTransition, motifRequired } from './ereporting-lifecycle.js'
import type {
  IssuerRole,
  RejectMotif,
  TransmissionType,
  VatRegime,
} from './nomenclature.js'

export type FluxKind = 'transactions' | 'payments'

export interface DeclarantInput {
  siren: string
  name: string
  role: IssuerRole
  vatRegime: VatRegime
  active?: boolean
}

export interface DeclarantSummary {
  id: string
  siren: string
  name: string
  role: IssuerRole
  vatRegime: VatRegime
  active: boolean
  createdAt: Date
}

export interface NewTransmission {
  declarantId: string
  transmissionRef: string
  type: TransmissionType
  fluxKind: FluxKind
  periodStart: string
  periodEnd: string
  invoiceCount: number
  xml: string | null
  // Rejet sémantique LOCAL pré-transmission (Task 8, injection revue #6 —
  // XML XSD-invalide, motif REJ_SEMAN). Quand fourni, la ligne naît
  // DIRECTEMENT `rejetee` (fromStatus=null -> toStatus='rejetee') AU LIEU de
  // `prepared` — PAS une transition `prepared`→`rejetee` (assertTransition,
  // Task 4, l'interdit délibérément : seul le PPF, via `transmitted`→
  // `rejetee`, porte un 301 officiel, Task 9). L'événement GENÈSE
  // (fromStatus=null) échappe à assertTransition ici comme pour 'prepared'
  // ci-dessous (c'est une création, pas une transition). Omis (défaut) :
  // comportement STRICTEMENT inchangé (statut initial 'prepared').
  rejectMotif?: RejectMotif
}

export interface TransmissionSummary {
  id: string
  declarantId: string
  transmissionRef: string
  type: TransmissionType
  fluxKind: FluxKind
  periodStart: string
  periodEnd: string
  status: EreportingStatus
  invoiceCount: number
  trackingId: string | null
  createdAt: Date
  updatedAt: Date
}

export interface EreportingStatusEventRow {
  fromStatus: EreportingStatus | null
  toStatus: EreportingStatus
  motif: RejectMotif | null
  actor: string
  createdAt: Date
}

@Injectable()
export class EreportingRepository {
  constructor(private readonly tenant: TenantContextService) {}

  // Config déclarant (D11, maille SIREN×rôle) : mutable par l'opérateur —
  // unique(tenant, siren, role) porte l'idempotence (migration 0016).
  async upsertDeclarant(
    tenantId: string,
    input: DeclarantInput,
  ): Promise<{ id: string }> {
    return this.tenant.run(tenantId, async (db) => {
      const active = input.active ?? true
      const [row] = await db
        .insert(ereportingDeclarants)
        .values({
          tenantId,
          siren: input.siren,
          name: input.name,
          role: input.role,
          vatRegime: input.vatRegime,
          active,
        })
        .onConflictDoUpdate({
          target: [
            ereportingDeclarants.tenantId,
            ereportingDeclarants.siren,
            ereportingDeclarants.role,
          ],
          set: { name: input.name, vatRegime: input.vatRegime, active },
        })
        .returning({ id: ereportingDeclarants.id })
      if (!row) throw new Error('upsertDeclarant returned no row')
      return { id: row.id }
    })
  }

  // Lecture RLS-scopée d'un déclarant unique (Task 8 : la raison sociale,
  // TT-14/Issuer.Name, n'est PAS portée par EreportingGenerationJob — payload
  // minimal, motif 2.1 — le worker la recharge ICI depuis Postgres). `null`
  // si le déclarant a disparu entre l'enfilement et le traitement (mêmes
  // moindre-privilège que listDeclarantsByTenant, une seule ligne).
  async findDeclarant(
    tenantId: string,
    id: string,
  ): Promise<DeclarantSummary | null> {
    return this.tenant.run(tenantId, async (db) => {
      const rows = await db
        .select({
          id: ereportingDeclarants.id,
          siren: ereportingDeclarants.siren,
          name: ereportingDeclarants.name,
          role: ereportingDeclarants.role,
          vatRegime: ereportingDeclarants.vatRegime,
          active: ereportingDeclarants.active,
          createdAt: ereportingDeclarants.createdAt,
        })
        .from(ereportingDeclarants)
        .where(eq(ereportingDeclarants.id, id))
        .limit(1)
      return rows[0] ?? null
    })
  }

  async listDeclarantsByTenant(tenantId: string): Promise<DeclarantSummary[]> {
    return this.tenant.run(tenantId, async (db) => {
      return db
        .select({
          id: ereportingDeclarants.id,
          siren: ereportingDeclarants.siren,
          name: ereportingDeclarants.name,
          role: ereportingDeclarants.role,
          vatRegime: ereportingDeclarants.vatRegime,
          active: ereportingDeclarants.active,
          createdAt: ereportingDeclarants.createdAt,
        })
        .from(ereportingDeclarants)
        .orderBy(asc(ereportingDeclarants.createdAt))
    })
  }

  // Amendement A2 (MUST-FIX, anti double-envoi) : IDEMPOTENT pour type='IN' —
  // l'index unique partiel (migration 0016) arbitre le conflit
  // (declarant_id, flux_kind, period_start) UNIQUEMENT pour les lignes
  // type='IN' ; un 'RE' n'entre jamais en conflit (rectificatifs libres,
  // `rejetee` étant TERMINAL — Task 4). Sur conflit : recharge la ligne
  // existante et renvoie `created: false` — le worker (Task 8) s'en sert pour
  // sauter une période déjà transmise au lieu de la ré-émettre au PPF.
  // Écrit AUSSI l'événement journal initial `prepared` (from=NULL,
  // actor='platform') dans la MÊME transaction — miroir de
  // InvoicesRepository.insertReceived (2.1).
  async insertTransmission(
    tenantId: string,
    row: NewTransmission,
  ): Promise<{ id: string; created: boolean }> {
    return this.tenant.run(tenantId, async (db) => {
      const initialStatus: EreportingStatus = row.rejectMotif
        ? 'rejetee'
        : 'prepared'
      const inserted = await db
        .insert(ereportingTransmissions)
        .values({
          tenantId,
          declarantId: row.declarantId,
          transmissionRef: row.transmissionRef,
          type: row.type,
          fluxKind: row.fluxKind,
          periodStart: row.periodStart,
          periodEnd: row.periodEnd,
          invoiceCount: row.invoiceCount,
          xml: row.xml,
          status: initialStatus,
        })
        .onConflictDoNothing({
          target: [
            ereportingTransmissions.declarantId,
            ereportingTransmissions.fluxKind,
            ereportingTransmissions.periodStart,
          ],
          where: sql`${ereportingTransmissions.type} = 'IN'`,
        })
        .returning({ id: ereportingTransmissions.id })

      const createdRow = inserted[0]
      if (createdRow) {
        await db.insert(ereportingStatusEvents).values({
          tenantId,
          transmissionId: createdRow.id,
          fromStatus: null,
          toStatus: initialStatus,
          motif: row.rejectMotif ?? null,
          actor: 'platform',
        })
        return { id: createdRow.id, created: true }
      }

      // Conflit : une transmission 'IN' existe déjà pour (déclarant, flux,
      // période) — la recharger plutôt que d'en émettre une seconde.
      const existing = await db
        .select({ id: ereportingTransmissions.id })
        .from(ereportingTransmissions)
        .where(
          and(
            eq(ereportingTransmissions.declarantId, row.declarantId),
            eq(ereportingTransmissions.fluxKind, row.fluxKind),
            eq(ereportingTransmissions.periodStart, row.periodStart),
            eq(ereportingTransmissions.type, 'IN'),
          ),
        )
        .limit(1)
      const existingRow = existing[0]
      if (!existingRow)
        throw new Error(
          'insertTransmission: conflict detected but no existing row found',
        )
      return { id: existingRow.id, created: false }
    })
  }

  // 'prepared' → 'transmitted' (CAS anti-race, miroir InvoicesRepository
  // .recordTransition) + trackingId + événement journal, en une transaction.
  async markTransmitted(
    tenantId: string,
    id: string,
    trackingId: string,
  ): Promise<void> {
    assertTransition('prepared', 'transmitted')
    await this.tenant.run(tenantId, async (db) => {
      const updated = await db
        .update(ereportingTransmissions)
        .set({ status: 'transmitted', trackingId, updatedAt: new Date() })
        .where(
          and(
            eq(ereportingTransmissions.id, id),
            eq(ereportingTransmissions.status, 'prepared'),
          ),
        )
        .returning({ id: ereportingTransmissions.id })
      if (updated.length === 0) {
        throw new Error(
          `markTransmitted: transmission ${id} is not in 'prepared' status (concurrent transition or unknown id)`,
        )
      }
      await db.insert(ereportingStatusEvents).values({
        tenantId,
        transmissionId: id,
        fromStatus: 'prepared',
        toStatus: 'transmitted',
        actor: 'platform',
      })
    })
  }

  // Transition générique du cycle de vie (Task 4 : `assertTransition` valide
  // le couple from→to, `motifRequired` impose un motif ssi to='rejetee'). CAS
  // anti-race identique à markTransmitted. Utilisée pour l'acquittement PPF
  // (300 déposée / 301 rejetée, Task 9).
  async appendStatusEvent(
    tenantId: string,
    id: string,
    from: EreportingStatus,
    to: EreportingStatus,
    actor: string,
    motif?: RejectMotif,
  ): Promise<void> {
    assertTransition(from, to)
    if (motifRequired(to) && !motif) {
      throw new Error(
        `appendStatusEvent: motif is required for transition to '${to}'`,
      )
    }
    await this.tenant.run(tenantId, async (db) => {
      const updated = await db
        .update(ereportingTransmissions)
        .set({ status: to, updatedAt: new Date() })
        .where(
          and(
            eq(ereportingTransmissions.id, id),
            eq(ereportingTransmissions.status, from),
          ),
        )
        .returning({ id: ereportingTransmissions.id })
      if (updated.length === 0) {
        throw new Error(
          `appendStatusEvent: transmission ${id} is not in '${from}' status (concurrent transition or unknown id)`,
        )
      }
      await db.insert(ereportingStatusEvents).values({
        tenantId,
        transmissionId: id,
        fromStatus: from,
        toStatus: to,
        motif: motif ?? null,
        actor,
      })
    })
  }

  async listTransmissions(tenantId: string): Promise<TransmissionSummary[]> {
    return this.tenant.run(tenantId, async (db) => {
      return db
        .select({
          id: ereportingTransmissions.id,
          declarantId: ereportingTransmissions.declarantId,
          transmissionRef: ereportingTransmissions.transmissionRef,
          type: ereportingTransmissions.type,
          fluxKind: ereportingTransmissions.fluxKind,
          periodStart: ereportingTransmissions.periodStart,
          periodEnd: ereportingTransmissions.periodEnd,
          status: ereportingTransmissions.status,
          invoiceCount: ereportingTransmissions.invoiceCount,
          trackingId: ereportingTransmissions.trackingId,
          createdAt: ereportingTransmissions.createdAt,
          updatedAt: ereportingTransmissions.updatedAt,
        })
        .from(ereportingTransmissions)
        .orderBy(desc(ereportingTransmissions.createdAt))
    })
  }

  async loadTransmissionXml(
    tenantId: string,
    id: string,
  ): Promise<string | null> {
    return this.tenant.run(tenantId, async (db) => {
      const rows = await db
        .select({ xml: ereportingTransmissions.xml })
        .from(ereportingTransmissions)
        .where(eq(ereportingTransmissions.id, id))
        .limit(1)
      return rows[0]?.xml ?? null
    })
  }

  // Statut courant d'une transmission (Task 8, injection revue #4 —
  // idempotence & reprise) : sur `created:false` (conflit insertTransmission,
  // rejeu), la VÉRITÉ à consulter pour décider reprise/skip est TOUJOURS en
  // base (jamais le retour du port, qui ne distingue pas frais/rejeu). `null`
  // si l'id est inconnu (ne devrait pas arriver juste après un
  // insertTransmission réussi, mais reste défensif).
  async findTransmissionStatus(
    tenantId: string,
    id: string,
  ): Promise<EreportingStatus | null> {
    return this.tenant.run(tenantId, async (db) => {
      const rows = await db
        .select({ status: ereportingTransmissions.status })
        .from(ereportingTransmissions)
        .where(eq(ereportingTransmissions.id, id))
        .limit(1)
      return rows[0]?.status ?? null
    })
  }

  async listStatusEvents(
    tenantId: string,
    id: string,
  ): Promise<EreportingStatusEventRow[]> {
    return this.tenant.run(tenantId, async (db) => {
      return db
        .select({
          fromStatus: ereportingStatusEvents.fromStatus,
          toStatus: ereportingStatusEvents.toStatus,
          motif: ereportingStatusEvents.motif,
          actor: ereportingStatusEvents.actor,
          createdAt: ereportingStatusEvents.createdAt,
        })
        .from(ereportingStatusEvents)
        .where(eq(ereportingStatusEvents.transmissionId, id))
        .orderBy(asc(ereportingStatusEvents.createdAt))
    })
  }

  // Amendement plan A4 : factures d'un déclarant émises dans [startIso,
  // endIso] (issue_date texte AAAA-MM-JJ, comparaison lexicographique valide
  // — largeur fixe), lues SOUS RLS (tenant courant). rôle SE → siren vendeur,
  // BY → siren acheteur (BT-30/47 sur la partie canonique JSONB). Filtre SQL
  // simple : volumes de test faibles, pas de sur-ingénierie d'index (Task 8).
  async invoicesForPeriod(
    tenantId: string,
    siren: string,
    role: IssuerRole,
    startIso: string,
    endIso: string,
  ): Promise<Invoice[]> {
    return this.tenant.run(tenantId, async (db) => {
      const partySiren =
        role === 'SE'
          ? sql`${invoices.canonical}->'seller'->>'siren'`
          : sql`${invoices.canonical}->'buyer'->>'siren'`
      const rows = await db
        .select({ canonical: invoices.canonical })
        .from(invoices)
        .where(
          and(
            gte(invoices.issueDate, startIso),
            lte(invoices.issueDate, endIso),
            eq(partySiren, siren),
          ),
        )
      return rows.map((r) => r.canonical)
    })
  }
}
