import type { Invoice } from '@factelec/invoice-core'
import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

// bytea : non natif dans drizzle-orm — type sur mesure pour les octets Factur-X.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
})

export const invoiceStatus = pgEnum('invoice_status', [
  'received',
  'generating',
  'generated',
  'failed',
])
export const formatKind = pgEnum('format_kind', [
  'ubl',
  'cii',
  'facturx',
  'flux_base',
  'flux_full',
])

// Cycle de vie CDV — nomenclature DGFiP (cf. src/invoices/lifecycle-status.ts,
// STATUS_META, source de vérité de l'ordre/labels/codes).
// Statut d'archivage probatoire (Task 6, 2.2) : `pending` tant que le job de
// génération n'a pas encore tenté l'archivage best-effort ; `archived` une
// fois le bundle écrit en WORM (Task 5) ; `failed` si l'écriture a échoué
// (ré-essayé par la réconciliation, Task 8 — jamais bloquant pour la
// génération, qui reste `generated`).
export const archiveStatus = pgEnum('archive_status', [
  'pending',
  'archived',
  'failed',
])

export const invoiceLifecycleStatus = pgEnum('invoice_lifecycle_status', [
  'deposee',
  'emise',
  'recue',
  'mise_a_disposition',
  'prise_en_charge',
  'approuvee',
  'approuvee_partiellement',
  'en_litige',
  'suspendue',
  'completee',
  'refusee',
  'paiement_transmis',
  'encaissee',
  'rejetee',
])

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  siren: text('siren'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    prefix: text('prefix').notNull(),
    secretHash: text('secret_hash').notNull(),
    label: text('label').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('api_keys_prefix_unique').on(t.prefix),
    index('api_keys_tenant_idx').on(t.tenantId),
  ],
)

export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    number: text('number').notNull(),
    typeCode: text('type_code').notNull(),
    issueDate: text('issue_date').notNull(),
    currency: text('currency').notNull(),
    status: invoiceStatus('status').notNull().default('received'),
    lifecycleStatus: invoiceLifecycleStatus('lifecycle_status')
      .notNull()
      .default('deposee'),
    // Archivage probatoire best-effort (Task 6) : découplé du statut de
    // génération ci-dessus — un archivage `failed` ne dégrade jamais une
    // génération `generated` (formats déjà servis).
    archiveStatus: archiveStatus('archive_status').notNull().default('pending'),
    archiveLocation: text('archive_location'),
    archiveHash: text('archive_hash'),
    // Compteur de ré-enfilements par la réconciliation (Task 8) : borne le
    // nombre de tentatives d'une facture bloquée avant neutralisation en DLQ
    // (facture « poison »). Jamais remis à 0 sur succès — sans impact (une
    // facture `generated` sort de find_stuck_* et n'est plus jamais re-swept).
    reconcileAttempts: integer('reconcile_attempts').notNull().default(0),
    canonical: jsonb('canonical').$type<Invoice>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('invoices_tenant_number_unique').on(t.tenantId, t.number),
    index('invoices_tenant_created_idx').on(t.tenantId, t.createdAt),
  ],
)

export const invoiceFormats = pgTable(
  'invoice_formats',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    kind: formatKind('kind').notNull(),
    contentType: text('content_type').notNull(),
    bodyText: text('body_text'),
    bodyBytes: bytea('body_bytes'),
    byteSize: integer('byte_size').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('invoice_formats_invoice_kind_unique').on(t.invoiceId, t.kind),
    index('invoice_formats_tenant_idx').on(t.tenantId),
  ],
)

// Journal d'événements du cycle de vie CDV : APPEND-ONLY (RLS + grants
// SELECT/INSERT seulement, cf. migration 0008) — substrat à valeur probante,
// scellement/WORM reporté 2.2.
export const invoiceStatusEvents = pgTable(
  'invoice_status_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      // Journal probatoire : une facture munie d'événements NE PEUT PLUS être
      // supprimée (le journal ne se supprime pas avec sa facture — dette 2.1,
      // D4). Corollaire : supprimer un TENANT possédant des événements scellés
      // est désormais BLOQUÉ (23503 via ce RESTRICT enfant) plutôt que
      // cascadé — plus protecteur. La FK tenant_id reste `cascade` (la
      // suppression d'un tenant relève d'une procédure RGPD dédiée, hors
      // périmètre 2.2).
      .references(() => invoices.id, { onDelete: 'restrict' }),
    // NULL pour l'événement initial (dépôt) ; sinon statut de départ.
    fromStatus: invoiceLifecycleStatus('from_status'),
    toStatus: invoiceLifecycleStatus('to_status').notNull(),
    // Acteur ayant apposé le statut : 'platform' | 'user:<uuid>' | 'apikey:<prefix>'.
    actor: text('actor').notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    // ── Scellement chaîné (imposé par le trigger seal_status_event, D1/D2) ──
    // Les défauts ci-dessous sont des PLACEHOLDERS : le trigger BEFORE INSERT
    // recalcule TOUJOURS seq/prev_hash/hash. Ils existent uniquement pour rendre
    // ces colonnes NOT NULL optionnelles à l'insert (repository inchangé).
    seq: bigint('seq', { mode: 'number' }).notNull().default(0),
    prevHash: bytea('prev_hash').notNull().default(sql`'\\x'::bytea`),
    hash: bytea('hash').notNull().default(sql`'\\x'::bytea`),
  },
  (t) => [
    index('invoice_status_events_invoice_idx').on(t.invoiceId, t.createdAt),
    index('invoice_status_events_tenant_idx').on(t.tenantId),
    unique('invoice_status_events_tenant_seq_unique').on(t.tenantId, t.seq),
    unique('invoice_status_events_tenant_hash_unique').on(t.tenantId, t.hash),
  ],
)

// DLQ des factures « poison » : génération en échec récurrent, neutralisées par
// la réconciliation (cap). Append-only (grants SELECT/INSERT, migration 0015).
export const invoiceDeadLetters = pgTable(
  'invoice_dead_letters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'restrict' }),
    reason: text('reason').notNull(),
    attempts: integer('attempts').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('invoice_dead_letters_tenant_idx').on(t.tenantId)],
)

// ── E-reporting Flux 10 (plan 2.3, Task 5) : déclarants, transmissions, ────
// journal du cycle de vie. Distinct du CDV facture (invoiceLifecycleStatus
// ci-dessus) — cf. ereporting/ereporting-lifecycle.ts (EREPORTING_STATUS_META).

// Régimes TVA pilotant la cadence de dépôt (D4/D11, cf. ereporting/nomenclature.ts VAT_REGIMES).
export const ereportingVatRegime = pgEnum('ereporting_vat_regime', [
  'reel_normal_mensuel',
  'reel_normal_trimestriel',
  'simplifie',
  'franchise',
])
// Rôle du déclarant (TT-15, cf. ereporting/nomenclature.ts ISSUER_ROLES) : acheteur/vendeur.
export const ereportingIssuerRole = pgEnum('ereporting_issuer_role', [
  'BY',
  'SE',
])
// Type de transmission (TT-4, cf. ereporting/nomenclature.ts TRANSMISSION_TYPES) : initiale/rectificatif.
export const ereportingTransmissionType = pgEnum(
  'ereporting_transmission_type',
  ['IN', 'RE'],
)
export const ereportingFluxKind = pgEnum('ereporting_flux_kind', [
  'transactions',
  'payments',
])
// Cycle de vie e-reporting (cf. ereporting/ereporting-lifecycle.ts EREPORTING_STATUS_META).
// 300/301 (Tableaux 5/6 DGFiP) = deposee/rejetee ; prepared/transmitted = états internes PA (A3).
export const ereportingStatus = pgEnum('ereporting_status', [
  'prepared',
  'transmitted',
  'deposee',
  'rejetee',
])
// Motifs de rejet PPF (Tableau 6, §3.7.10, cf. ereporting/nomenclature.ts REJECT_MOTIFS).
export const ereportingRejectMotif = pgEnum('ereporting_reject_motif', [
  'REJ_SEMAN',
  'REJ_UNI',
  'REJ_COH',
  'REJ_PER',
])

// Config par déclarant (D11) : maille SIREN × rôle, régime TVA (→ cadence, period.ts Task 7).
// Mutable par l'opérateur (grants SELECT/INSERT/UPDATE/DELETE, migration 0017).
export const ereportingDeclarants = pgTable(
  'ereporting_declarants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    siren: text('siren').notNull(),
    name: text('name').notNull(),
    role: ereportingIssuerRole('role').notNull(),
    vatRegime: ereportingVatRegime('vat_regime').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('ereporting_declarants_tenant_siren_role_unique').on(
      t.tenantId,
      t.siren,
      t.role,
    ),
    index('ereporting_declarants_tenant_idx').on(t.tenantId),
  ],
)

export const ereportingTransmissions = pgTable(
  'ereporting_transmissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    declarantId: uuid('declarant_id')
      .notNull()
      .references(() => ereportingDeclarants.id, { onDelete: 'restrict' }),
    transmissionRef: text('transmission_ref').notNull(), // TT-1
    type: ereportingTransmissionType('type').notNull(), // IN/RE
    fluxKind: ereportingFluxKind('flux_kind').notNull(),
    periodStart: text('period_start').notNull(), // AAAAMMJJ
    periodEnd: text('period_end').notNull(),
    status: ereportingStatus('status').notNull().default('prepared'),
    invoiceCount: integer('invoice_count').notNull().default(0),
    trackingId: text('tracking_id'),
    xml: text('xml'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('ereporting_transmissions_tenant_idx').on(t.tenantId, t.createdAt),
    index('ereporting_transmissions_declarant_period_idx').on(
      t.declarantId,
      t.periodStart,
    ),
    // Amendement A2 (revue plan, MUST-FIX, anti double-envoi) : UNE SEULE
    // transmission INITIALE (type='IN') par déclarant×flux×période. Sans
    // cette contrainte, un crash entre transmit() et markTransmitted()
    // (Task 8) laisserait une transmission `prepared`/`transmitted` orpheline
    // que le re-balayage regénèrerait en double auprès du PPF (le jobId
    // BullMQ ne suffit pas à travers la rétention). Les rectificatifs
    // (type='RE') restent LIBRES — plusieurs RE possibles sur la même
    // période, car `rejetee` est TERMINAL (Task 4) : un rectificatif est
    // TOUJOURS une nouvelle transmission, jamais une transition de l'ancienne.
    uniqueIndex('ereporting_transmissions_declarant_flux_period_in_unique')
      .on(t.declarantId, t.fluxKind, t.periodStart)
      .where(sql`${t.type} = 'IN'`),
  ],
)

// Journal APPEND-ONLY du cycle de vie e-reporting — NON scellé (D3/D5,
// transmission authentifiée au transport, contrairement au CDV facture) :
// PAS de trigger de hash-chain ici, contrairement à invoice_status_events.
export const ereportingStatusEvents = pgTable(
  'ereporting_status_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    transmissionId: uuid('transmission_id')
      .notNull()
      .references(() => ereportingTransmissions.id, { onDelete: 'restrict' }),
    fromStatus: ereportingStatus('from_status'), // NULL pour l'événement initial ('prepared')
    toStatus: ereportingStatus('to_status').notNull(),
    motif: ereportingRejectMotif('motif'), // requis ssi to_status='rejetee'
    actor: text('actor').notNull(), // 'platform' | 'ppf' | 'user:<uuid>'
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('ereporting_status_events_transmission_idx').on(
      t.transmissionId,
      t.createdAt,
    ),
  ],
)

// ── Annuaire Flux 13/14 (plan 2.4, Task 5) : consentements, lignes de ──────
// publication, journal, miroir de consultation. Idiomes calqués sur la
// section e-reporting ci-dessus (uuid pk, tenantId FK cascade, index tenant,
// createdAt tz). Cf. annuaire/{nomenclature,ligne-adressage,
// annuaire-lifecycle}.ts (Tasks 1/2/4) pour la sémantique métier.

// Nature de la ligne (D=Définition, M=Masquage — nomenclature.ts NATURES).
export const annuaireNature = pgEnum('annuaire_nature', ['D', 'M'])
// Cycle de vie de publication (cf. annuaire-lifecycle.ts ANNUAIRE_STATUS_META) :
// draft→published→{deposee,rejetee} ; deposee→masked (NON terminal, D6).
export const annuaireLigneStatus = pgEnum('annuaire_ligne_status', [
  'draft',
  'published',
  'deposee',
  'rejetee',
  'masked',
])

// Preuve de consentement (§3.5.5.5, D5) : portée = maille (siren, et
// optionnellement siret/routage/suffixe — plus la maille est renseignée
// précisément, plus étroite est sa couverture, cf. A-CONSENT/coversTarget).
// Révocation par `revokedAt` (pas de DELETE — grants migration 0019).
export const annuaireConsents = pgTable(
  'annuaire_consents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    siren: text('siren').notNull(),
    siret: text('siret'),
    routageId: text('routage_id'),
    suffixe: text('suffixe'),
    consentType: text('consent_type').notNull(),
    signerIdentity: text('signer_identity').notNull(),
    evidenceRef: text('evidence_ref').notNull(),
    obtainedAt: timestamp('obtained_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('annuaire_consents_tenant_siren_idx').on(t.tenantId, t.siren)],
)

// Lignes de publication (F13, D11 : une Définition par maille×date). Le
// consentement est OBLIGATOIRE (FK restrict — D5, gate de publication) :
// une ligne ne peut jamais perdre son unique preuve de consentement tant
// qu'elle existe.
export const annuaireLignes = pgTable(
  'annuaire_lignes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    siren: text('siren').notNull(),
    siret: text('siret'),
    routageId: text('routage_id'),
    suffixe: text('suffixe'),
    nature: annuaireNature('nature').notNull(),
    dateDebut: text('date_debut').notNull(), // AAAAMMJJ, inclus
    dateFin: text('date_fin'), // AAAAMMJJ, exclu
    plateforme: text('plateforme').notNull(), // matricule PPF (4 chiffres)
    status: annuaireLigneStatus('status').notNull().default('draft'),
    consentId: uuid('consent_id')
      .notNull()
      .references(() => annuaireConsents.id, { onDelete: 'restrict' }),
    trackingRef: text('tracking_ref'),
    rejectReason: text('reject_reason'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('annuaire_lignes_tenant_siren_idx').on(t.tenantId, t.siren),
    // Amendement A-DEADLOCK (HIGH, PRIME sur le plan qui écrivait seulement
    // `WHERE nature='D'` — insuffisant : une ligne rejetee/masked, TERMINALE
    // et de nature INCHANGÉE, occuperait le slot À VIE, rejouant le deadlock
    // A2 de 2.3). `status NOT IN ('rejetee','masked')` libère le slot dès
    // qu'une ligne atteint un état terminal : l'annuaire n'a PAS de concept
    // RE (contrairement à l'e-reporting) — la correction d'une ligne
    // rejetée/masquée est une NOUVELLE ligne draft (domaine-correct, cf.
    // annuaire-lifecycle.ts). Les statuts non-terminaux (draft/published/
    // deposee) restent indexés — la fenêtre de crash entre `transmit` et
    // markPublished (statut encore draft/published) reste anti-doublon.
    uniqueIndex('annuaire_lignes_maille_date_definition_unique')
      .on(
        t.tenantId,
        t.siren,
        sql`coalesce(${t.siret}, '')`,
        sql`coalesce(${t.routageId}, '')`,
        sql`coalesce(${t.suffixe}, '')`,
        t.dateDebut,
      )
      .where(
        sql`${t.nature} = 'D' AND ${t.status} NOT IN ('rejetee', 'masked')`,
      ),
  ],
)

// Journal APPEND-ONLY du cycle de vie annuaire — NON scellé (D6, motif
// libre : aucun code de rejet réglementaire annuaire, contrairement au
// REJ_* e-reporting) : pas de trigger de hash-chain, grants SELECT/INSERT
// seuls (migration 0019).
export const annuaireLigneEvents = pgTable(
  'annuaire_ligne_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    ligneId: uuid('ligne_id')
      .notNull()
      .references(() => annuaireLignes.id, { onDelete: 'restrict' }),
    fromStatus: annuaireLigneStatus('from_status'), // NULL pour l'événement genèse ('draft')
    toStatus: annuaireLigneStatus('to_status').notNull(),
    motif: text('motif'), // libre (D6), requis ssi to_status='rejetee' (motifRequired)
    actor: text('actor').notNull(), // 'platform' | 'ppf' | 'user:<uuid>'
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('annuaire_ligne_events_ligne_idx').on(t.ligneId, t.createdAt)],
)

// Miroir de consultation (F14, D9) : régénérable par la sync (grants
// SELECT/INSERT/UPDATE/DELETE, migration 0019) — backstop DB de l'upsert
// idempotent.
export const annuaireDirectoryEntries = pgTable(
  'annuaire_directory_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    idInstance: bigint('id_instance', { mode: 'number' }),
    siren: text('siren').notNull(),
    siret: text('siret'),
    routageId: text('routage_id'),
    suffixe: text('suffixe'),
    nature: annuaireNature('nature').notNull(),
    dateDebut: text('date_debut').notNull(),
    dateFin: text('date_fin'),
    plateforme: text('plateforme').notNull(),
    sourceHorodate: text('source_horodate'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('annuaire_directory_entries_tenant_siren_idx').on(
      t.tenantId,
      t.siren,
    ),
    // Amendement A-MIRROR-KEY (MED, PRIME sur le plan qui omettait `nature` —
    // une D et une M sur la même maille×dateDebut s'écraseraient mutuellement
    // à l'upsert, perdant soit le masquage soit la définition). `nature`
    // INCLUS dans la clé : upsert idempotent PAR nature, D et M coexistent.
    uniqueIndex('annuaire_directory_entries_maille_date_nature_unique').on(
      t.tenantId,
      t.siren,
      sql`coalesce(${t.siret}, '')`,
      sql`coalesce(${t.routageId}, '')`,
      sql`coalesce(${t.suffixe}, '')`,
      t.dateDebut,
      t.nature,
    ),
  ],
)

// ── Transmission des CDV (Flux 6 / CDAR, plan 3.1 Task 4) : suivi de ───────
// livraison + journal append-only NON scellé. Idiomes calqués sur les
// sections e-reporting/annuaire ci-dessus. `toStatus` réutilise l'enum
// invoiceLifecycleStatus (le statut CDV FACTURE transmis — 200/210/212/213,
// D7) : ce n'est PAS le statut de la machine de LIVRAISON elle-même (cf.
// cdv/cdv-transmission-lifecycle.ts, CDV_TRANSMISSION_STATUS_META, D4).

export const cdvTransmissionStatus = pgEnum('cdv_transmission_status', [
  'prepared',
  'transmitted',
  'parked',
  'acknowledged',
  'rejected',
])

// Cible de transmission (D7) : PPF (réglementaire, toujours adressable, sans
// résolution annuaire) ou plateforme de réception (résolue par l'annuaire
// 2.4, D6 — peut être non-adressable/ambiguë → `parked`).
export const cdvTarget = pgEnum('cdv_target', ['ppf', 'recipient'])

export const cdvTransmissions = pgTable(
  'cdv_transmissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      // Miroir invoice_status_events (2.2, dette 2.1/D4) : une facture munie
      // d'une transmission CDV ne peut plus être supprimée — le suivi de
      // livraison ne se supprime pas avec sa facture.
      .references(() => invoices.id, { onDelete: 'restrict' }),
    toStatus: invoiceLifecycleStatus('to_status').notNull(),
    target: cdvTarget('target').notNull(),
    status: cdvTransmissionStatus('status').notNull().default('prepared'),
    recipientMatricule: text('recipient_matricule'), // résolu annuaire, cible recipient seulement
    trackingRef: text('tracking_ref'),
    xml: text('xml'),
    rejectReason: text('reject_reason'), // MDT-126, requis ssi status='rejected' (code 601)
    statusHorodate: text('status_horodate').notNull(), // AAAAMMJJHHMMSS (échéance 24h, D7)
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('cdv_transmissions_tenant_idx').on(t.tenantId, t.createdAt),
    // Backstop anti-double-envoi (D8, 3e couche) : UNE ligne par (facture,
    // statut transmis, cible), qui PROGRESSE par états — couvre TOUS les
    // statuts, AUCUN filtre partiel (contraste
    // annuaire_lignes_maille_date_definition_unique) : un `rejected` occupe
    // légitimement le slot (D8 — un false-reject se corrige par reset manuel
    // hors-bande, runbook différé T9). Table NEUVE (migration 0021) → aucun
    // risque de backfill (contraste migration 0011/2.2-0011).
    uniqueIndex('cdv_transmissions_invoice_status_target_unique').on(
      t.invoiceId,
      t.toStatus,
      t.target,
    ),
  ],
)

// Journal APPEND-ONLY du cycle de vie de LIVRAISON — NON scellé (D4 : la
// transmission est authentifiée au niveau transport, comme
// ereporting_status_events et annuaire_ligne_events ; le scellement 2.2 ne
// s'applique qu'au journal CDV FACTURE invoice_status_events, jamais
// re-scellé ni re-validé ici).
export const cdvTransmissionEvents = pgTable(
  'cdv_transmission_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    transmissionId: uuid('transmission_id')
      .notNull()
      .references(() => cdvTransmissions.id, { onDelete: 'restrict' }),
    fromStatus: cdvTransmissionStatus('from_status'), // NULL pour l'événement genèse ('prepared')
    toStatus: cdvTransmissionStatus('to_status').notNull(),
    motif: text('motif'), // libre (MDT-126), requis ssi to_status='rejected'
    actor: text('actor').notNull(), // 'platform' | 'ppf' | 'recipient'
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('cdv_transmission_events_transmission_idx').on(
      t.transmissionId,
      t.createdAt,
    ),
  ],
)

// Capture EXPLICITE des encaissements (D5, plan 3.2 Task 4) : PAS d'auto-seed
// depuis le statut 212 « encaissée » du journal scellé 2.2 (ne porte ni
// montant, ni taux, ni date — un seeder fabriquerait la ventilation).
// Immutable après capture (grants SELECT,INSERT seulement — pas
// d'UPDATE/DELETE, migration 0025). FK invoice **restrict** (miroir
// cdvTransmissions/invoice_status_events, 2.2/3.1) : une facture munie d'un
// encaissement ne se supprime pas.
export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'restrict' }),
    paymentDate: text('payment_date').notNull(), // AAAAMMJJ (TT-92/TT-102)
    currency: text('currency').notNull().default('EUR'),
    reference: text('reference').notNull(), // référence client, porte l'idempotence de capture (D5)
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Idempotence de capture (D5, amendement binding) : UNE seule clé,
    // (invoice_id, reference) — portée ICI et par l'ON CONFLICT du
    // repository (payments.repository.ts), aucune divergence.
    uniqueIndex('payments_invoice_reference_unique').on(
      t.invoiceId,
      t.reference,
    ),
    index('payments_tenant_idx').on(t.tenantId, t.createdAt),
  ],
)

// Répartition par taux d'un encaissement (TG-36/TG-39, 1..n) — paiements
// partiels multiples par facture supportés (TVA à l'encaissement, D5).
// Montant en `text` (précédent DGFiP : aucun montant Flux 10 en colonne
// numérique, comme tous les montants du domaine e-reporting).
export const paymentSubtotals = pgTable(
  'payment_subtotals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id, { onDelete: 'restrict' }),
    taxPercent: text('tax_percent').notNull(), // TT-93/TT-97, POURCENTAGE 3.2
    amount: text('amount').notNull(), // TT-95/TT-99, MONTANT 19.6
  },
  (t) => [index('payment_subtotals_payment_idx').on(t.paymentId)],
)

export const userRole = pgEnum('user_role', [
  'owner',
  'admin',
  'accountant',
  'viewer',
])

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: userRole('role').notNull().default('owner'),
    emailVerified: boolean('email_verified').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('users_email_unique').on(sql`lower(${t.email})`),
    index('users_tenant_idx').on(t.tenantId),
  ],
)

export const platformAdmins = pgTable(
  'platform_admins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('platform_admins_email_unique').on(sql`lower(${t.email})`),
  ],
)

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    adminId: uuid('admin_id').references(() => platformAdmins.id, {
      onDelete: 'cascade',
    }),
    tenantId: uuid('tenant_id').references(() => tenants.id, {
      onDelete: 'cascade',
    }),
    tokenHash: text('token_hash').notNull(),
    csrfHash: text('csrf_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_unique').on(t.tokenHash),
    index('sessions_expires_idx').on(t.expiresAt),
    check(
      'sessions_subject_xor',
      sql`(${t.userId} IS NULL) <> (${t.adminId} IS NULL)`,
    ),
    check(
      'sessions_admin_no_tenant',
      sql`${t.adminId} IS NULL OR ${t.tenantId} IS NULL`,
    ),
  ],
)
