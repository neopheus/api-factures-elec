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
  // Nombre de tentatives d'un job de publication annuaire (Task 8) avant
  // passage en `failed` (D13).
  ANNUAIRE_PUBLISH_JOB_ATTEMPTS: z.coerce.number().int().positive().default(3),
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
