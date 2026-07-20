import { z } from 'zod'

const csv = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  )

export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  // Rôle applicatif UNIQUEMENT (soumis à la RLS). L'URL du rôle owner n'est
  // jamais chargée par le process API (elle sert aux scripts migration/provision).
  DATABASE_URL: z.url(),
  // Rôle worker de moindre privilège (D4/D5, plan 3.5, Task 3) — consommée
  // UNIQUEMENT par le bootstrap worker (worker-main.ts → WorkerModule →
  // DbModule.forRoot('DATABASE_URL_WORKER')). Optionnelle : le process API
  // n'a pas besoin du secret worker (`DbModule.forRoot` throw explicitement
  // si absente au bootstrap worker).
  DATABASE_URL_WORKER: z.url().optional(),
  CORS_ALLOWED_ORIGINS: csv,
  RATE_LIMIT_TTL: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_LIMIT: z.coerce.number().int().positive().default(120),
  // Nombre de proxys de confiance devant l'API (Express `trust proxy`).
  // 0 (défaut) = connexion directe, comportement actuel inchangé : `req.ip`
  // reste l'IP socket réelle. Ne JAMAIS positionner `true` (ferait confiance
  // à n'importe quel `X-Forwarded-For` fourni par le client — spoofable) ;
  // seul un entier ≥ 0 est accepté (nombre de sauts de proxy à faire
  // confiance, cf. doc Express `trust proxy`).
  TRUST_PROXY: z.coerce.number().int().nonnegative().default(0),
  // Durée de vie ABSOLUE de la session (aucun renouvellement glissant à la
  // lecture) : cf. session.service.ts / session.guard.ts.
  SESSION_TTL_HOURS: z.coerce.number().int().positive().max(720).default(12),
  // TTL DÉDIÉ de la session super admin (phase 5 it.2, dette 1.4 soldée) :
  // volontairement plus court que SESSION_TTL_HOURS (surface d'exposition
  // réduite d'un compte à privilèges élevés) — borne max 24h (vs 720h côté
  // marchand).
  ADMIN_SESSION_TTL_HOURS: z.coerce
    .number()
    .int()
    .positive()
    .max(24)
    .default(2),
  // Domaine du cookie de session (ex: `.factelec.fr` en prod, pour partager le
  // cookie entre le dashboard et l'API sur des sous-domaines). Absent en dev.
  SESSION_COOKIE_DOMAIN: z.string().optional(),
  // ── Redis / BullMQ (workers) ──────────────────────────────────────────────
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_DB: z.coerce.number().int().nonnegative().default(0),
  REDIS_PASSWORD: z.string().optional(),
  // TLS activé UNIQUEMENT sur "true"/"1" (managed Redis prod). z.coerce.boolean
  // est PROSCRIT ici : il transforme toute chaîne non vide (dont "false") en
  // true — piège classique. On parse explicitement.
  REDIS_TLS: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  // Nombre de tentatives d'un job de génération avant passage en `failed`.
  GENERATION_JOB_ATTEMPTS: z.coerce
    .number()
    .int()
    .positive()
    .max(10)
    .default(3),
  // Périodicité de la purge des sessions expirées (job répétable, Task 7).
  SESSION_PURGE_EVERY_MS: z.coerce.number().int().positive().default(3_600_000),
  // ── Réconciliation (Task 3, décision contrôleur — comble le trou "received"
  // orpheline documenté au commentaire InvoicesService.ingest) ─────────────
  // Ancienneté (ms) au-delà de laquelle une facture encore `received` est
  // considérée orpheline (enfilement Redis probablement en échec après la
  // persistance Postgres) et re-enfilée par le balayage périodique.
  RECONCILIATION_STALE_MS: z.coerce.number().int().positive().default(300_000),
  // Périodicité du balayage de réconciliation (job répétable, file `maintenance`).
  RECONCILIATION_SWEEP_EVERY_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60_000),
  // Ancienneté (ms) au-delà de laquelle une facture encore `generating` est
  // considérée bloquée (le worker a probablement crashé/été tué entre le
  // marquage `generating` et la complétion — cf. amendement A1, la fenêtre
  // entre les deux transactions — sans qu'aucun retry BullMQ ne la
  // rattrape : le job a pu être définitivement `failed` puis évincé de
  // Redis par `removeOnFail`, ou l'écriture finale du statut `failed` a pu
  // se perdre dans la course décrite au rapport Task 3). Seuil DÉLIBÉRÉMENT
  // plus large que `RECONCILIATION_STALE_MS` (`received`) : une génération
  // légitime (5 formats EN 16931) ne dure jamais 15 minutes — un seuil
  // court risquerait de balayer une génération simplement lente/en file
  // d'attente sous charge normale.
  RECONCILIATION_GENERATING_STALE_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(900_000),
  // ── Archivage à valeur probante (D5) ─────────────────────────────────────
  // 'local' = LocalFilesystemArchiveStore (write-once, dev/test) ; 's3' =
  // adaptateur object-lock Scaleway ACTIVÉ AU DÉPLOIEMENT (non fourni en 2.2).
  ARCHIVE_DRIVER: z.enum(['local', 's3']).default('local'),
  ARCHIVE_LOCAL_DIR: z.string().default('./var/archive'),
  // Cap de ré-enfilements par la réconciliation avant DLQ (facture poison).
  GENERATION_MAX_ATTEMPTS_CAP: z.coerce
    .number()
    .int()
    .positive()
    .max(50)
    .default(5),
  // Périodicité de la reprise d'archivage (archive_status='failed').
  ARCHIVE_RETRY_EVERY_MS: z.coerce.number().int().positive().default(300_000),
  // Périodicité de la reprise du routage destinataire (Task 3, plan 3.4) —
  // routing_status 'pending'/'unaddressable' (miroir ARCHIVE_RETRY_EVERY_MS).
  ROUTING_RETRY_EVERY_MS: z.coerce.number().int().positive().default(300_000),
  // ── e-reporting Flux 10 (D7/D11) ─────────────────────────────────────────
  // 'local' = LocalFilesystemTransmissionStore (write-once, dev/test) ;
  // sftp/as2/as4/api = adaptateurs réels (auth transport, D3/D7) ACTIVÉS AU
  // DÉPLOIEMENT (non fournis en 2.3).
  EREPORTING_TRANSMISSION_DRIVER: z
    .enum(['local', 'sftp', 'as2', 'as4', 'api'])
    .default('local'),
  EREPORTING_LOCAL_DIR: z.string().default('./var/ereporting'),
  EREPORTING_PA_ID: z.string().default('PA00'), // TT-8 (matricule émetteur PA)
  EREPORTING_PA_SCHEME_ID: z.string().default('0238'), // TT-7
  EREPORTING_PA_NAME: z.string().default('Factelec PA'), // TT-9
  EREPORTING_SWEEP_EVERY_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(3_600_000),
  // Nombre de tentatives d'un job de génération e-reporting (Task 8) avant
  // passage en `failed` — distingue une erreur OPÉRATIONNELLE (xmllint
  // absent, DB/port transitoire) d'un rejet sémantique REJ_SEMAN, qui ne
  // throw jamais et n'est donc jamais rejoué.
  EREPORTING_GENERATION_JOB_ATTEMPTS: z.coerce
    .number()
    .int()
    .positive()
    .max(10)
    .default(3),
  // Périodicité/fenêtre du slot `payments` (D7, Task 8) — motif nominal
  // EREPORTING_SWEEP_EVERY_MS/CDV_TRANSMISSION_LOOKBACK_MS. La passe payments
  // (EreportingSweepService.sweep()) tourne AUJOURD'HUI sur le MÊME
  // planificateur que les transactions (EREPORTING_SWEEP_EVERY_MS,
  // EreportingScheduler INCHANGÉ, hors périmètre Task 8) et sa fenêtre bornée
  // réelle est `computeDuePaymentPeriods`/`MAX_DUE_PERIODS` (period.ts, D7
  // couche 1) — PAS ce paramètre. `PAYMENTS_SWEEP_EVERY_MS`/
  // `PAYMENTS_LOOKBACK_MS` sont déclarés ici pour compléter le contrat env
  // (plan 3.2, Task 8 Step 1) mais restent NON CONSOMMÉS par cette tâche :
  // réservés à un futur planificateur payments dédié si l'exploitation
  // souhaite découpler les cadences (cf. task-8-report.md).
  PAYMENTS_SWEEP_EVERY_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(3_600_000),
  PAYMENTS_LOOKBACK_MS: z.coerce.number().int().positive().default(172_800_000),
  // ── Annuaire Flux 13/14 (D1/D7) ──────────────────────────────────────────
  // 'local' = LocalFilesystemAnnuaireStore (write-once, dev/test) ; api/edi =
  // adaptateurs réels (PISTE-OAuth2 / SFTP-AS2-AS4, D1/D7) ACTIVÉS AU
  // DÉPLOIEMENT (non fournis en 2.4).
  ANNUAIRE_DRIVER: z.enum(['local', 'api', 'edi']).default('local'),
  ANNUAIRE_LOCAL_DIR: z.string().default('./var/annuaire'),
  // Périodicité de l'ordonnanceur de synchronisation : différentiel
  // ~quotidien / complet ~hebdomadaire (borné, discipline de balayage 2.3).
  ANNUAIRE_SYNC_EVERY_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(86_400_000),
  ANNUAIRE_COMPLETE_EVERY_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(604_800_000),
  // Nombre de tentatives d'un job de la file `annuaire-sync` (Task 9 —
  // ingestion F14 ET reprise de draft figé, `annuaire-sync.job-options.ts`)
  // avant passage en `failed` (D13).
  ANNUAIRE_PUBLISH_JOB_ATTEMPTS: z.coerce.number().int().positive().default(3),
  // Périodicité du sweep de reprise des drafts figés (Task 9, injection
  // revue contrôleur STUCK-DRAFT RE-PUBLISH SWEEP) — même ordre de grandeur
  // que ARCHIVE_RETRY_EVERY_MS (sweep « rattrapage » sur une gate de
  // fraîcheur courte, 15 min côté SD find_stale_annuaire_drafts, migration
  // 0020).
  ANNUAIRE_REPUBLISH_SWEEP_EVERY_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(300_000),
  // ── Consentement annuaire — scellement de signature (D1/D3, plan 3.5) ────
  // 'local' = LocalFilesystemConsentStore (scellement STRUCTUREL write-once,
  // dev/test — AUCUNE vérification cryptographique) ; 'eidas' = fournisseur
  // de signature qualifiée réel ACTIVÉ AU DÉPLOIEMENT (non fourni en 3.5).
  CONSENT_DRIVER: z.enum(['local', 'eidas']).default('local'),
  CONSENT_LOCAL_DIR: z.string().default('./var/consent'),
  // ── CDV Flux 6 / CDAR — transmission (D1/D4/D7) ──────────────────────────
  // 'local' = LocalFilesystemCdvStore (write-once, dev/test) ;
  // sftp/as2/as4/as4-peppol/api = adaptateurs réels (auth transport, D1/D7)
  // ACTIVÉS AU DÉPLOIEMENT (non fournis en 3.1).
  CDV_TRANSMISSION_DRIVER: z
    .enum(['local', 'sftp', 'as2', 'as4', 'as4-peppol', 'api'])
    .default('local'),
  CDV_LOCAL_DIR: z.string().default('./var/cdv'),
  // Périodicité de l'ordonnanceur borné (discipline 24h, §3.6.6) — horaire,
  // très inférieur au délai réglementaire (Task 7).
  CDV_SWEEP_EVERY_MS: z.coerce.number().int().positive().default(3_600_000),
  // Fenêtre de rattrapage bornée du sweep (48h = 2× le SLA 24h, D8) — passée
  // à `find_cdv_transmissions_due(p_since)` (Task 4/7).
  CDV_TRANSMISSION_LOOKBACK_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(172_800_000),
  // Nombre de tentatives d'un job de transmission CDV (Task 7) avant passage
  // en `failed` — distingue une erreur OPÉRATIONNELLE (port transitoire)
  // d'un rejet fonctionnel (601 / F6 invalide), qui ne throw jamais et n'est
  // donc jamais rejoué.
  CDV_TRANSMISSION_JOB_ATTEMPTS: z.coerce
    .number()
    .int()
    .positive()
    .max(10)
    .default(3),
  // Périodicité de la reprise des transmissions `parked` (Task 7, miroir
  // ARCHIVE_RETRY_EVERY_MS / ANNUAIRE_REPUBLISH_SWEEP_EVERY_MS).
  CDV_STUCK_RETRY_EVERY_MS: z.coerce.number().int().positive().default(300_000),
  // Matricule ICD 0238 du PA émetteur (déploiement — miroir EREPORTING_PA_ID) :
  // identifie l'émetteur du F6 (`senderMatricule`, Task 2/6).
  CDV_PA_MATRICULE: z.string().default('0000'),
  // ── Billing Stripe (phase 5, spec 2026-07-19) ──────────────────────────
  // Driver 'none' par défaut : la plateforme reste 100 % fonctionnelle sans
  // compte Stripe (dev/CI). 'fake' = tests. 'stripe' = SDK réel (les 4 clés
  // STRIPE_* deviennent nécessaires — vérifié au câblage du module, throw
  // explicite, motif ConsentSignatureModule).
  BILLING_DRIVER: z.enum(['stripe', 'fake', 'none']).default('none'),
  // Enforcement découplé du driver : 'off' = le garde évalue et log sans
  // bloquer (activation explicite au go-live commercial). BILLING_DRIVER
  // 'none' neutralise le garde même à 'on' (sinon : blocage global).
  BILLING_ENFORCEMENT: z.enum(['on', 'off']).default('off'),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_BASE: z.string().optional(),
  STRIPE_PRICE_METERED: z.string().optional(),
  // success/cancel/return URLs des sessions hébergées Stripe.
  BILLING_DASHBOARD_URL: z.url().default('http://localhost:3001'),
  // Sweep horaire idempotent (report du jour J-1 UTC, sauté si déjà fait) —
  // même philosophie que les autres *_EVERY_MS.
  BILLING_USAGE_EVERY_MS: z.coerce.number().int().positive().default(3_600_000),
  // Fenêtre de rattrapage du sweep d'usage (revue finale I2) — motif
  // CDV_TRANSMISSION_LOOKBACK_MS ci-dessus : sans elle, un worker down >24h
  // qui franchit une frontière de jour UTC perd DÉFINITIVEMENT l'usage du
  // jour non balayé (recordUsage n'est appelé QUE pour J-1, jamais rejoué en
  // arrière) — sous-facturation silencieuse. Unité en JOURS (pas en ms,
  // contrairement à CDV_TRANSMISSION_LOOKBACK_MS) : le sweep opère au grain
  // jour (`countDocuments`/`recordUsage` sont journaliers), pas événement.
  // Défaut 3 j (couvre un week-end de panne) ; borne max 30 (défensive,
  // motif CDV_TRANSMISSION_JOB_ATTEMPTS) contre une mauvaise configuration
  // qui ferait rebalayer des mois d'historique à chaque tick horaire.
  BILLING_USAGE_LOOKBACK_DAYS: z.coerce
    .number()
    .int()
    .positive()
    .max(30)
    .default(3),
  // ── Observabilité Prometheus (phase 5 it.2) ──────────────────────────────
  // Bearer attendu sur `Authorization` pour le scrape `GET /metrics`.
  // Absente de l'env → l'endpoint répond 404 (opt-in explicite : pas de
  // métriques exposées tant qu'aucun token n'est configuré, motif absence
  // de secret par défaut plutôt qu'un défaut faible).
  METRICS_TOKEN: z.string().min(16).optional(),
})

export type EnvConfig = z.infer<typeof envSchema>

export function validateEnv(raw: Record<string, unknown>): EnvConfig {
  const parsed = envSchema.safeParse(raw)
  if (!parsed.success) {
    // On ne divulgue QUE les clés fautives, jamais les valeurs (secrets).
    const keys = [
      ...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(root)')),
    ]
    throw new Error(`Invalid environment configuration: ${keys.join(', ')}`)
  }
  return parsed.data
}
