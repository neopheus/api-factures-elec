import { Injectable } from '@nestjs/common'
import { and, asc, desc, eq } from 'drizzle-orm'
import { CasStaleError } from '../common/cas-error.js'
import { cdvTransmissionEvents, cdvTransmissions } from '../db/schema.js'
// biome-ignore lint/style/useImportType: TenantContextService est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { TenantContextService } from '../db/tenant-context.service.js'
import type { LifecycleStatus } from '../invoices/lifecycle-status.js'
import type { CdvTransmissionStatus } from './cdv-transmission-lifecycle.js'
import {
  assertTransition,
  isTerminal,
  motifRequired,
} from './cdv-transmission-lifecycle.js'

export type CdvTarget = 'ppf' | 'recipient'

export interface NewCdvTransmission {
  invoiceId: string
  // Statut CDV FACTURE transmis (200/210/212/213) — PAS le statut de la
  // machine de livraison (cf. schema.ts, bannière ligne 553).
  toStatus: LifecycleStatus
  target: CdvTarget
  statusHorodate: string // AAAAMMJJHHMMSS (échéance 24h, D7)
  xml?: string | null
  recipientMatricule?: string | null // résolu annuaire, cible recipient seulement
}

export interface CdvTransmissionRow {
  id: string
  invoiceId: string
  toStatus: LifecycleStatus
  target: CdvTarget
  status: CdvTransmissionStatus
  recipientMatricule: string | null
  trackingRef: string | null
  xml: string | null
  rejectReason: string | null
  statusHorodate: string
  createdAt: Date
  updatedAt: Date
}

export interface CdvTransmissionEventRow {
  fromStatus: CdvTransmissionStatus | null
  toStatus: CdvTransmissionStatus
  motif: string | null
  actor: string
  createdAt: Date
}

// Résultat d'une recherche de reprise (Task 6, consommé sur `created:false`
// d'insertTransmission — miroir 2.3/2.4) : `resumable` dérive TOUJOURS de
// `isTerminal()` (cdv-transmission-lifecycle.ts, Task 3), JAMAIS d'une liste
// d'états terminaux recopiée à la main ici (revue T3, binding) — un futur
// changement de la machine de livraison (nouveaux états, table AFNOR) reste
// automatiquement pris en compte sans toucher au repository.
export interface ResumableTransmission {
  id: string
  status: CdvTransmissionStatus
  resumable: boolean
}

const TRANSMISSION_COLUMNS = {
  id: cdvTransmissions.id,
  invoiceId: cdvTransmissions.invoiceId,
  toStatus: cdvTransmissions.toStatus,
  target: cdvTransmissions.target,
  status: cdvTransmissions.status,
  recipientMatricule: cdvTransmissions.recipientMatricule,
  trackingRef: cdvTransmissions.trackingRef,
  xml: cdvTransmissions.xml,
  rejectReason: cdvTransmissions.rejectReason,
  statusHorodate: cdvTransmissions.statusHorodate,
  createdAt: cdvTransmissions.createdAt,
  updatedAt: cdvTransmissions.updatedAt,
} as const

@Injectable()
export class CdvTransmissionRepository {
  constructor(private readonly tenant: TenantContextService) {}

  // Backstop anti-double-envoi (D8, 3e couche) : idempotent via l'index
  // unique (invoice_id, to_status, target) — miroir
  // EreportingRepository.insertTransmission (2.3). Sur INSERT réel, écrit
  // AUSSI l'événement journal genèse `prepared` (from=NULL, actor='platform')
  // dans la MÊME transaction. Sur conflit (`created:false`), recharge la
  // ligne existante — le VRAI statut à consulter pour décider resume/skip
  // reste `findResumable` (JAMAIS le retour du port, qui ne distingue pas
  // frais/rejeu).
  async insertTransmission(
    tenantId: string,
    row: NewCdvTransmission,
  ): Promise<{ id: string; created: boolean }> {
    return this.tenant.run(tenantId, async (db) => {
      const inserted = await db
        .insert(cdvTransmissions)
        .values({
          tenantId,
          invoiceId: row.invoiceId,
          toStatus: row.toStatus,
          target: row.target,
          statusHorodate: row.statusHorodate,
          xml: row.xml ?? null,
          recipientMatricule: row.recipientMatricule ?? null,
        })
        .onConflictDoNothing({
          target: [
            cdvTransmissions.invoiceId,
            cdvTransmissions.toStatus,
            cdvTransmissions.target,
          ],
        })
        .returning({ id: cdvTransmissions.id })

      const createdRow = inserted[0]
      if (createdRow) {
        await db.insert(cdvTransmissionEvents).values({
          tenantId,
          transmissionId: createdRow.id,
          fromStatus: null,
          toStatus: 'prepared',
          actor: 'platform',
        })
        return { id: createdRow.id, created: true }
      }

      // Conflit : une ligne existe déjà pour (facture, statut, cible) — la
      // recharger plutôt que d'en émettre une seconde (slot unique, D8).
      const existing = await db
        .select({ id: cdvTransmissions.id })
        .from(cdvTransmissions)
        .where(
          and(
            eq(cdvTransmissions.invoiceId, row.invoiceId),
            eq(cdvTransmissions.toStatus, row.toStatus),
            eq(cdvTransmissions.target, row.target),
          ),
        )
        .limit(1)
      const existingRow = existing[0]
      if (!existingRow) {
        throw new Error(
          'insertTransmission: conflict detected but no existing row found',
        )
      }
      return { id: existingRow.id, created: false }
    })
  }

  // CAS anti-race : `prepared`→`transmitted` (envoi initial) OU
  // `parked`→`transmitted` (reprise T7, résolution annuaire aboutie) — les
  // DEUX sources sont autorisées par la machine de livraison (Task 3). On
  // tente les deux issues dans l'ordre, dans la MÊME transaction
  // (`tenant.run`) : la première UPDATE qui touche une ligne détermine le
  // `fromStatus` réel du journal, sans fenêtre de course avec un SELECT
  // préalable.
  //
  // `extra` (injection revue T6, finding F1/F2 — BINDING, plan-3-1-review.md
  // relayé au brief Task 7) : sur une REPRISE (`parked`→`transmitted`), le
  // second appel à `insertTransmission` (Task 6, `CdvTransmissionService.
  // transmitStatus`) est un NO-OP côté colonnes — `onConflictDoNothing`
  // recharge la ligne existante SANS jamais réécrire `xml`/
  // `recipientMatricule` avec les valeurs fraîchement générées/résolues au
  // moment de la reprise. Sans ce paramètre, une reprise réussie laisserait
  // `xml=NULL` (perte de fidélité d'audit — le XML réellement transmis au
  // port ne serait jamais persisté) et `recipient_matricule=NULL` (perte du
  // destinataire résolu) alors même que la transmission est bien
  // `transmitted`. `extra` est TOUJOURS fourni par l'appelant (Task 7) —
  // `undefined` par champ (jamais `null`) signifie « ne pas toucher cette
  // colonne » (cible `ppf` : `recipientMatricule` reste `undefined`, la
  // colonne garde sa valeur `NULL` d'origine, JAMAIS écrasée à tort).
  async markTransmitted(
    tenantId: string,
    id: string,
    trackingRef: string,
    extra?: { xml?: string; recipientMatricule?: string },
  ): Promise<void> {
    await this.tenant.run(tenantId, async (db) => {
      const candidates: CdvTransmissionStatus[] = ['prepared', 'parked']
      for (const from of candidates) {
        assertTransition(from, 'transmitted')
        const updated = await db
          .update(cdvTransmissions)
          .set({
            status: 'transmitted',
            trackingRef,
            updatedAt: new Date(),
            ...(extra?.xml !== undefined ? { xml: extra.xml } : {}),
            ...(extra?.recipientMatricule !== undefined
              ? { recipientMatricule: extra.recipientMatricule }
              : {}),
          })
          .where(
            and(eq(cdvTransmissions.id, id), eq(cdvTransmissions.status, from)),
          )
          .returning({ id: cdvTransmissions.id })
        if (updated.length > 0) {
          await db.insert(cdvTransmissionEvents).values({
            tenantId,
            transmissionId: id,
            fromStatus: from,
            toStatus: 'transmitted',
            actor: 'platform',
          })
          return
        }
      }
      throw new CasStaleError({
        entity: 'transmission',
        id,
        expectedStatus: candidates.join(' or '),
        message: `markTransmitted: transmission ${id} is not in 'prepared' or 'parked' status (concurrent transition or unknown id)`,
      })
    })
  }

  // CAS : `prepared`→`parked` UNIQUEMENT (destinataire non adressable/ambigu
  // à la résolution annuaire, D6) — un `parked` ne se re-« parke » jamais
  // (hors ALLOWED de la machine, Task 3) ; la reprise en place se fait via
  // markTransmitted/appendStatusEvent, jamais via un second markParked.
  async markParked(
    tenantId: string,
    id: string,
    motif?: string,
  ): Promise<void> {
    assertTransition('prepared', 'parked')
    await this.tenant.run(tenantId, async (db) => {
      const updated = await db
        .update(cdvTransmissions)
        .set({ status: 'parked', updatedAt: new Date() })
        .where(
          and(
            eq(cdvTransmissions.id, id),
            eq(cdvTransmissions.status, 'prepared'),
          ),
        )
        .returning({ id: cdvTransmissions.id })
      if (updated.length === 0) {
        throw new CasStaleError({
          entity: 'transmission',
          id,
          expectedStatus: 'prepared',
          message: `markParked: transmission ${id} is not in 'prepared' status (concurrent transition or unknown id)`,
        })
      }
      await db.insert(cdvTransmissionEvents).values({
        tenantId,
        transmissionId: id,
        fromStatus: 'prepared',
        toStatus: 'parked',
        motif: motif ?? null,
        actor: 'platform',
      })
    })
  }

  // Transition GÉNÉRIQUE du cycle de vie (Task 8 : acquittement PPF/réseau
  // 601/implicite ; born-rejet local, Task 6). `assertTransition` valide le
  // couple from→to, `motifRequired` impose un motif ssi to='rejected' —
  // miroir EreportingRepository.appendStatusEvent (2.3) / annuaire (2.4). Sur
  // `rejected`, le motif (MDT-126) est AUSSI reporté sur la colonne
  // `reject_reason` de la ligne (D4 — code 601 réel, motif chaîne libre).
  async appendStatusEvent(
    tenantId: string,
    id: string,
    from: CdvTransmissionStatus,
    to: CdvTransmissionStatus,
    actor: string,
    motif?: string,
  ): Promise<void> {
    assertTransition(from, to)
    if (motifRequired(to) && !motif) {
      throw new Error(
        `appendStatusEvent: motif is required for transition to '${to}'`,
      )
    }
    await this.tenant.run(tenantId, async (db) => {
      const updated = await db
        .update(cdvTransmissions)
        .set({
          status: to,
          updatedAt: new Date(),
          ...(to === 'rejected' ? { rejectReason: motif ?? null } : {}),
        })
        .where(
          and(eq(cdvTransmissions.id, id), eq(cdvTransmissions.status, from)),
        )
        .returning({ id: cdvTransmissions.id })
      if (updated.length === 0) {
        throw new CasStaleError({
          entity: 'transmission',
          id,
          expectedStatus: from,
          message: `appendStatusEvent: transmission ${id} is not in '${from}' status (concurrent transition or unknown id)`,
        })
      }
      await db.insert(cdvTransmissionEvents).values({
        tenantId,
        transmissionId: id,
        fromStatus: from,
        toStatus: to,
        motif: motif ?? null,
        actor,
      })
    })
  }

  async findTransmission(
    tenantId: string,
    id: string,
  ): Promise<CdvTransmissionRow | null> {
    return this.tenant.run(tenantId, async (db) => {
      const rows = await db
        .select(TRANSMISSION_COLUMNS)
        .from(cdvTransmissions)
        .where(eq(cdvTransmissions.id, id))
        .limit(1)
      return rows[0] ?? null
    })
  }

  // Support de la décision resume/skip du service (Task 6) sur
  // `created:false` d'insertTransmission — `resumable` dérive de
  // `isTerminal()` (Task 3), jamais d'une liste recopiée ici (binding revue
  // T3, cf. bannière ResumableTransmission ci-dessus).
  async findResumable(
    tenantId: string,
    invoiceId: string,
    toStatus: LifecycleStatus,
    target: CdvTarget,
  ): Promise<ResumableTransmission | null> {
    return this.tenant.run(tenantId, async (db) => {
      const rows = await db
        .select({ id: cdvTransmissions.id, status: cdvTransmissions.status })
        .from(cdvTransmissions)
        .where(
          and(
            eq(cdvTransmissions.invoiceId, invoiceId),
            eq(cdvTransmissions.toStatus, toStatus),
            eq(cdvTransmissions.target, target),
          ),
        )
        .limit(1)
      const row = rows[0]
      if (!row) return null
      return {
        id: row.id,
        status: row.status,
        resumable: !isTerminal(row.status),
      }
    })
  }

  // Filtrée par facture (Task 8, `GET /cdv/transmissions?invoiceId=…`) : pas
  // de variante non filtrée — YAGNI, aucun appelant du plan n'énumère les
  // transmissions tous invoiceId confondus.
  async listTransmissions(
    tenantId: string,
    invoiceId: string,
  ): Promise<CdvTransmissionRow[]> {
    return this.tenant.run(tenantId, async (db) => {
      return db
        .select(TRANSMISSION_COLUMNS)
        .from(cdvTransmissions)
        .where(eq(cdvTransmissions.invoiceId, invoiceId))
        .orderBy(desc(cdvTransmissions.createdAt))
    })
  }

  async listStatusEvents(
    tenantId: string,
    transmissionId: string,
  ): Promise<CdvTransmissionEventRow[]> {
    return this.tenant.run(tenantId, async (db) => {
      return db
        .select({
          fromStatus: cdvTransmissionEvents.fromStatus,
          toStatus: cdvTransmissionEvents.toStatus,
          motif: cdvTransmissionEvents.motif,
          actor: cdvTransmissionEvents.actor,
          createdAt: cdvTransmissionEvents.createdAt,
        })
        .from(cdvTransmissionEvents)
        .where(eq(cdvTransmissionEvents.transmissionId, transmissionId))
        .orderBy(asc(cdvTransmissionEvents.createdAt))
    })
  }
}
