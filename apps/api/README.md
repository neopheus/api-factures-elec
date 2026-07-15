# `@factelec/api`

API REST NestJS d'ingestion et de lecture des factures électroniques
(phase **1.3**), étendue en **1.4** avec l'authentification utilisateur
(sessions httpOnly + CSRF), le signup self-service transactionnel, la
gestion des clés API par session et un super admin plateforme minimal, puis
en **2.1** avec des **workers BullMQ** (génération asynchrone des formats)
et le **cycle de vie des statuts CDV** (nomenclature DGFiP, machine à états,
journal d'événements append-only). Consomme `@factelec/invoice-core`
(validation, calculs, génération des formats du socle) et expose l'ensemble
derrière une couche d'authentification et d'isolation multi-tenant Postgres.

> **Dettes 1.3 soldées** (plan 1.4, task 1) : `createDb` (piège hors-tenant,
> jamais appelé en production) retiré de `src/db/client.ts` ; `DATABASE_URL`
> migré de `z.string().url()` (déprécié) vers `z.url()` (zod 4). Aucun
> changement de comportement — refactor mécanique couvert par la suite
> existante.
>
> **Dettes 1.3/1.4 soldées** (plan 2.1, task 7) : `last_used_at` (table
> `api_keys`) est désormais écrit à chaque authentification réussie, depuis
> `authenticate_api_key` (seule fonction `SECURITY DEFINER` exécutée avant le
> contexte tenant — cf. §Architecture workers/Sécurité) ; la purge des
> sessions expirées tourne en job BullMQ répétable côté worker
> (`SessionPurgeScheduler` → `purge_expired_sessions()`, également
> `SECURITY DEFINER`, table `sessions` deny-all pour `factelec_app`).

## Architecture & compromis

- **ESM pur + NestJS 11**, avec une chaîne de build volontairement scindée en
  trois outils :
  - **Émission JS** : [SWC](https://swc.rs/) (`.swcrc` — `legacyDecorator` +
    `decoratorMetadata`, cible `es2022`, module `es6`/NodeNext). SWC produit le
    JavaScript exécuté en dev (`pnpm dev`), en build (`pnpm build` → `dist/`)
    et transforme les tests.
  - **Typecheck** : `tsc --noEmit` via **tsgo 7.0.2** (paquet `typescript`
    racine, pin exact, partagé avec `invoice-core`), `experimentalDecorators`
    + `emitDecoratorMetadata` activés dans `apps/api/tsconfig.json`.
  - **Tests** : Vitest 4 via `unplugin-swc` (même moteur de transformation que
    le build, pas un second compilateur).
  - `reflect-metadata` est importé en tout premier dans `main.ts` et dans
    `tests/setup.ts` (requis par l'injection de dépendances par type de
    NestJS, `design:paramtypes`).
  - **Résultat réel du typecheck tsgo (point de risque n°1 du plan)** :
    **PASSÉ nativement, aucun repli nécessaire.** `tsc --noEmit` type-checke
    tous les décorateurs NestJS (`@Module`, `@Controller`, `@Injectable`,
    `@Get`/`@Post`, etc.) sans erreur sous tsgo 7.0.2, avec une exécution
    rapide (< 1 s sur le socle, pas de ralentissement notable observé sur
    l'ensemble du code livré). Vérifié empiriquement par injection volontaire
    d'une erreur de type (détectée puis revertie). Le repli documenté par le
    plan — pin `typescript@5.9.x` local à `apps/api` uniquement, sans toucher
    le pin racine `7.0.2` d'`invoice-core` — n'a **jamais été activé** et
    reste une option si une version future de tsgo régressait sur un
    décorateur NestJS particulier.
- **Génération asynchrone (2.1).** La génération des formats (UBL, CII,
  Factur-X, extraits de flux) est effectuée **par un worker BullMQ dédié**,
  hors de la requête HTTP d'ingestion — voir [§ Architecture
  workers](#architecture-workers) pour l'architecture complète (producteur/
  consommateur, idempotence, retries, réconciliation). **Écart assumé par
  rapport au plan initial (D2)** : le worker vit dans `apps/api`
  (`src/worker-main.ts`, second point d'entrée du même workspace, processus
  séparé au runtime) plutôt que dans un workspace `apps/worker` dédié —
  aucun bénéfice d'isolation supplémentaire à ce stade (même image de
  déploiement, mêmes dépendances), la séparation de workspace reste une
  option ouverte si le worker devait un jour diverger fortement de l'API en
  dépendances ou en cadence de déploiement.

## Architecture workers

**Producteur / consommateur**, séparés par une file BullMQ (Redis) :

- **Producteur** — le process API (`src/main.ts`). `POST /invoices` valide,
  persiste la facture (statut `received`) et **enfile** un job minimal sur la
  file `invoice-generation` via le port `InvoiceGenerationQueue`
  (`src/queue/invoice-generation.queue.ts`) — connexion BullMQ **paresseuse**
  côté producteur (`skipWaitingForReady`/`skipVersionCheck`, `QueueModule`) :
  aucune connexion Redis réelle n'est ouverte au montage du module, sauf
  usage effectif (enfilement, sonde readiness).
- **Consommateur** — `src/worker-main.ts`, **processus séparé** (`pnpm
  start:worker` en prod, `pnpm worker:dev` en watch mode), qui monte
  `WorkerModule` (jamais importé par l'API HTTP). Connexion BullMQ **eager**
  côté worker (`WorkerQueueModule` distinct de `QueueModule` — un worker doit
  échouer/crash-loop au démarrage si Redis est injoignable, pas tourner
  silencieusement sans consommer). `InvoiceGenerationProcessor`
  (`src/worker/invoice-generation.processor.ts`) charge la facture
  canonique, appelle `InvoiceFormatGenerator` (même port qu'en 1.3/1.4 —
  génération désormais exécutée **côté worker**, plus dans la requête HTTP),
  puis persiste les formats.

**Payload minimal (ids only).** Le job ne transporte que
`{ tenantId, invoiceId }` (`InvoiceGenerationJob`) — **aucun contenu de
facture ni format généré ne transite par Redis** ; le worker recharge la
facture canonique depuis Postgres avant de générer.

**Idempotence.** `jobId = invoiceId` : un ré-enfilement du même
`invoiceId` (retry BullMQ, réconciliation) ne crée jamais de doublon de job
en file. Côté persistance, `InvoicesRepository.completeGeneration` exécute
**delete + insert** des formats et le passage à `generated` dans **une seule
transaction tenant** : un retraitement complet (après crash, reconciliation)
remplace intégralement les formats précédents plutôt que de les dupliquer.

**Retries / backoff.** `GENERATION_JOB_ATTEMPTS` tentatives (défaut 3),
backoff exponentiel (1 s de base) — politique définie une seule fois
(`invoice-generation.job-options.ts`) et **partagée** entre le producteur
(enfilement initial) et le worker (re-enfilement par la réconciliation), pour
qu'un job rejoué hérite toujours de la même politique. `failed` n'est écrit
en base **qu'après épuisement** des tentatives (`OnWorkerEvent('failed')`,
compare `job.attemptsMade` à `job.opts.attempts`) — un retry en cours ne
repositionne jamais un statut `failed` prématuré.

**Rétention.** `removeOnComplete` (24 h / 1000 jobs), `removeOnFail` (7
jours) — les jobs terminés (succès ou échec définitif) ne s'accumulent pas
indéfiniment dans Redis.

**Réconciliation auto-cicatrisante** (`InvoiceReconciliationService`,
balayage périodique côté worker, file `maintenance`) : comble deux trous
structurels qu'aucun retry BullMQ ne couvre —
1. facture `received` **jamais enfilée** (l'enfilement Redis a pu échouer
   *après* le commit Postgres de l'ingestion — l'API n'a alors aucun moyen
   de le savoir de façon synchrone) : au-delà de `RECONCILIATION_STALE_MS`
   (défaut 5 min), la facture est considérée orpheline et re-enfilée ;
2. facture bloquée en `generating` (le worker a été tué — `SIGTERM`,
   OOM — exactement entre le marquage `generating` et la transaction
   `completeGeneration`, hors de toute couverture retry puisque le job
   BullMQ correspondant a pu être marqué `failed` et évincé de Redis par
   `removeOnFail`) : au-delà de `RECONCILIATION_GENERATING_STALE_MS`
   (défaut 15 min, délibérément plus large que le seuil `received` — une
   génération légitime ne dure jamais 15 minutes), re-enfilée à son tour.

Le balayage évince aussi les jobs `failed` déjà épuisés de la file avant
réenfilement (`getJobSchedulers`/eviction, cf. commentaires
`invoice-reconciliation.service.ts`). **Fenêtre résiduelle documentée, non
couverte** : un `SIGTERM` du worker frappant exactement entre le marquage
`generating` et `completeGeneration` laisse la facture bloquée jusqu'au
prochain balayage — bornée à `RECONCILIATION_GENERATING_STALE_MS` (~15 min
par défaut), jamais indéfiniment, mais pas instantanée. Aucune stratégie de
verrou distribué n'a été mise en place pour fermer cette fenêtre à zéro
(compromis assumé : complexité vs. gain sur un cas déjà borné et rare).

**Rôle Postgres du worker : `factelec_app`** (D6, comme l'API) — le worker
n'a besoin d'aucun privilège supplémentaire (mêmes tables, même RLS) ; il
partage `DATABASE_URL` avec le process API, jamais `factelec_owner`.

## Nouvelle sémantique `POST /invoices`

**Changement de contrat** vis-à-vis de 1.3/1.4 (assumé, D1) : `POST
/invoices` répond désormais `201 { id, status: 'received' }` — la génération
des formats n'est **plus** synchrone avec la réponse HTTP. Le suivi se fait
via `GET /invoices/:id` (`status` : `received → generating → generated`,
ou `failed` après épuisement des tentatives) ; les formats
(`GET /invoices/:id/formats/:format`) ne sont disponibles qu'une fois
`status = 'generated'` (404 sinon, comme pour une facture inconnue — aucune
distinction observable entre « pas encore généré » et « n'existe pas », par
cohérence avec le reste de l'API qui ne renvoie jamais d'état interne
explicite sur une ressource non accessible).

## Cycle de vie CDV

Deux axes de statut **distincts**, à ne jamais confondre :

- **`status`** (colonne `invoice_status`, décrit ci-dessus) : statut
  **technique** de génération des formats (`received`/`generating`/
  `generated`/`failed`), piloté par le worker, sans intervention humaine.
- **`lifecycle_status`** (colonne `invoice_lifecycle_status`) : statut
  **métier/réglementaire** du cycle de vie de la facture (CDV — Cadre de
  facturation électronique), piloté par des transitions explicites (API ou,
  plus tard, apposition automatique par la plateforme/le réseau Peppol).

**Nomenclature DGFiP** — 14 statuts (codes 200-213, source Dossier général
v3.2 §3.6.4 Tableau 8 + Annexe 7 règle G7.44 pour le socle obligatoire
`{200 Déposée, 210 Refusée, 212 Encaissée, 213 Rejetée}`) ; les 10 statuts
restants sont facultatifs (`emise`/`recue`/
`mise_a_disposition`/`prise_en_charge`/`approuvee`/
`approuvee_partiellement`/`en_litige`/`suspendue`/`completee`/
`paiement_transmis`). Chaque facture démarre à `deposee` (200, **obligatoire**)
à l'ingestion (événement initial inscrit dans le journal, cf. ci-dessous).

**Machine à états** (`src/invoices/lifecycle-status.ts`) — chronologie
monotone : une transition `from → to` n'est valide que si `to` a un code
strictement supérieur à `from`, et si `from` n'est pas terminal (`refusee`
210 et `rejetee` 213, exception l'un vers l'autre y compris) ; motif
(`reason`) **obligatoire** pour `refusee`/`suspendue` (règle G7.25).

> ⚠️ **Interprétation projet, à durcir avant mise en production.** La DGFiP
> ne publie, dans le Dossier général, aucune matrice de transitions
> autorisées (les figures 48/49 du circuit de transmission sont purement
> graphiques, non extractibles en règles machine) — seule la contrainte
> « respect de la chronologie » (G7.19/G7.25/G7.45) est documentée. La
> machine à états ci-dessus encode donc une interprétation **projet**
> (chronologie stricte du code numérique) qui doit être recoupée avec la
> norme **AFNOR XP Z12-012** (hors dépôt DGFiP, à se procurer) avant tout
> passage en production réelle. Cas notable resté ouvert : `212 Encaissée →
> 213 Rejetée` est autorisé par la règle monotone (une facture encaissée
> peut être ultérieurement rejetée pour anomalie détectée après paiement) ;
> AFNOR pourrait l'interdire — à réexaminer lors du durcissement.

**Endpoints** :

- `POST /invoices/:id/status` — transition (`{ toStatus, reason? }`), session
  **owner/admin/accountant** + CSRF (jamais clé API : l'apposition
  automatique par un connecteur/la plateforme est différée, phase 3).
  **CAS anti-race** : l'`UPDATE` conditionne sur le statut courant lu juste
  avant (`WHERE lifecycle_status = from`) — 0 ligne affectée ⇒ **409**
  (changement concurrent, à réessayer) plutôt qu'un écrasement silencieux.
  **422** si la transition est invalide (chronologie) ou si `reason` manque
  alors que requis.
- `GET /invoices/:id/status` — statut courant + historique complet, dual-auth
  (clé API ou session du même tenant, comme la lecture des factures).

**Journal `invoice_status_events`** — append-only : la table n'accorde que
`SELECT`/`INSERT` à `factelec_app` (aucun `UPDATE`/`DELETE` — immuabilité
garantie par les grants Postgres, pas seulement par convention applicative).
L'événement initial (`fromStatus: null → toStatus: 'deposee'`, `actor:
'platform'`) est inscrit à l'ingestion, dans la même transaction que
l'insertion de la facture (`InvoicesRepository.insertReceived`) ; chaque
transition ultérieure inscrit `{fromStatus, toStatus, actor, reason,
createdAt}` dans la **même transaction** que la mise à jour
`lifecycle_status` (`InvoicesRepository.recordTransition`). Ce journal est
le **substrat** du futur journal à valeur probante (scellement/archivage
WORM, différé **2.2**) — non scellé cryptographiquement à ce stade, seule
l'immuabilité par grants est garantie aujourd'hui.

## Sécurité / multi-tenant

Cette section documente les mécanismes de sécurité destinés à figurer au
dossier d'immatriculation DGFiP (PA/PDP).

### Rôles Postgres

Deux rôles, jamais confondus :

- **`factelec_owner`** — `BYPASSRLS`, `CREATEDB`. Utilisé **uniquement** par
  les migrations (`pnpm db:migrate`) et le provisioning CLI
  (`pnpm provision:tenant`). Propriétaire du schéma `public` et de la
  fonction `authenticate_api_key`. **Jamais utilisé par le process API.**
- **`factelec_app`** — `NOSUPERUSER NOBYPASSRLS NOCREATEDB`. Rôle applicatif
  (runtime), seul rôle dont dispose `DATABASE_URL` — **y compris pour le
  worker** (`src/worker-main.ts`, 2.1), qui partage exactement le même rôle
  et les mêmes politiques RLS que le process API (aucun privilège
  supplémentaire). N'a que `USAGE` sur le schéma, `SELECT/INSERT/UPDATE` sur
  les tables `tenants`/`api_keys`/`invoices`/`invoice_formats`, `SELECT/
  INSERT` **uniquement** (jamais `UPDATE`/`DELETE`) sur `invoice_status_events`
  (append-only, 2.1 — cf. § Cycle de vie CDV), et `EXECUTE` sur
  `authenticate_api_key`/`purge_expired_sessions` — jamais `BYPASSRLS`. (Les
  tables `users`/`sessions`/`platform_admins`, introduites en 1.4, ont leurs
  propres politiques RLS documentées dans `docs/superpowers/`.)

### Row-Level Security : `ENABLE` + `FORCE`

Les 4 tables (`tenants`, `api_keys`, `invoices`, `invoice_formats`) ont la RLS
**activée et forcée** (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY` **et**
`... FORCE ROW LEVEL SECURITY`, migration `0001_roles_rls.sql`) — la RLS
s'applique aussi au propriétaire de table s'il n'a pas `BYPASSRLS` (ici
`factelec_app` n'a jamais ce droit ; seul `factelec_owner`, qui ne fait aucune
requête applicative, l'a).

Chaque table porte une policy fail-closed :

```sql
CREATE POLICY tenant_isolation ON invoices
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
```

**Déviation vérifiée par rapport au plan initial** : le plan prévoyait un
cast nu `current_setting('app.tenant_id', true)::uuid`. En pratique, un GUC
custom (`app.*`) déjà positionné une fois dans une session (via
`set_config(..., true)`, donc en `SET LOCAL`) est remis à la **chaîne vide**
`''` — et non `NULL` — après la fin de la transaction qui l'a posé (quirk
documenté de Postgres pour les paramètres placeholder). Sans le `nullif(...,
'')`, `''::uuid` lève une exception au lieu de fermer proprement l'accès (0
ligne) hors contexte tenant. Le `nullif` restaure le comportement fail-closed
voulu dans tous les cas : GUC jamais posé (`NULL`), GUC réinitialisé après
transaction (`''`), ou GUC valide (UUID).

### Propagation du tenant : une transaction par requête

`runInTenant(pool, tenantId, work)` (`src/db/tenant-context.ts`) ouvre une
connexion dédiée du pool, exécute `BEGIN`, pose
`SELECT set_config('app.tenant_id', $1, true)` (`is_local = true`, donc
**`SET LOCAL`**, réinitialisé au `COMMIT`/`ROLLBACK`), exécute `work` avec un
client `drizzle` lié à cette connexion, puis `COMMIT`. Le `ROLLBACK` du
chemin d'erreur est protégé : si le `ROLLBACK` lui-même échoue (connexion
probablement corrompue), l'erreur d'origine (celle de `work`, jamais celle du
rollback) est tout de même celle propagée à l'appelant, et la connexion
défaillante est évincée du pool (`client.release(err)`) plutôt que remise en
circulation. **Aucune fuite de tenant entre requêtes** sur une connexion
mutualisée du pool : chaque requête HTTP obtient sa propre transaction et son
propre `SET LOCAL`.

### Authentification par clés API

- Format du token : `fk_<prefix>.<secret>`. Seul le `secret` est un secret ;
  le `prefix` sert de clé de recherche publique.
- Le `secret` est haché au repos avec **Argon2id** (`@node-rs/argon2`,
  paramètres OWASP : `memoryCost=19456`, `timeCost=2`, `parallelism=1`).
  **Jamais stocké ni loggé en clair** — seul `secretHash` est persisté ; le
  token complet n'est révélé qu'une fois, en sortie du script de
  provisioning.
- **Problème poule/œuf** : l'authentification doit lire `api_keys` **avant**
  que le tenant (et donc `app.tenant_id`) ne soit connu — mais `api_keys` est
  sous RLS. Résolu par une fonction Postgres **`SECURITY DEFINER`**
  (`authenticate_api_key(prefix)`, propriété de `factelec_owner`,
  `search_path` **épinglé** à `public` pour éviter tout détournement par
  substitution de schéma), qui ne renvoie que la ligne minimale nécessaire
  pour **un seul préfixe**. `factelec_app` n'a que `EXECUTE` sur cette
  fonction, jamais `BYPASSRLS`.
- **Timing-safe par construction** : quel que soit le cas d'échec (préfixe
  inconnu, clé révoquée, ou préfixe connu mais secret incorrect),
  `ApiKeyService.authenticate()` effectue **exactement un** appel
  `argon2.verify()` avec les mêmes paramètres de coût — soit contre le hash
  réel, soit contre un hash-leurre précalculé et mis en cache
  (`timingSafeReject`). Seul le cas structurellement distinct (token qui ne
  respecte même pas la syntaxe `fk_xxx.yyy`) court-circuite avant tout appel
  argon2 — ce cas ne renseigne l'attaquant sur rien (aucun préfixe candidat
  n'est même formé). Mesuré empiriquement : écart de moyenne ~0,2 ms entre le
  chemin « préfixe inconnu » et le chemin « préfixe connu, mauvais secret »
  (~1,8 %, dominé par le bruit de scheduling, largement sous le jitter
  réseau réel).
- `ApiKeyGuard` pose `req.tenantId`/`req.apiKeyId` sur succès ; échec → 401
  `application/problem+json` uniforme, sans distinction observable entre les
  causes.

### Sécurité transverse

- **helmet** (en-têtes de sécurité par défaut) et **CORS allowlist**
  (`CORS_ALLOWED_ORIGINS`, méthodes `GET`/`POST` uniquement,
  `credentials: false`).
- **Rate limiting** (`@nestjs/throttler`, `APP_GUARD` global) : par IP,
  fenêtre glissante configurable (`RATE_LIMIT_TTL`/`RATE_LIMIT_LIMIT`),
  appliqué **avant** la résolution du tenant. Dépassement → **429** réel
  (vérifié en e2e sur un endpoint réel).
- **Erreurs RFC 9457** (`application/problem+json`) sur toute la surface API
  via `ProblemDetailsFilter` : `type` (URN stable `urn:factelec:problem:*`),
  `title`, `status`, `detail`/`errors` bornés (jamais de stack, de requête
  SQL ni de détail interne). Isolation cross-tenant renvoie systématiquement
  **404** (jamais 403, jamais 200) — prouvé byte-identique à un vrai
  not-found en test e2e.
- **Logs pino masqués** : les en-têtes sensibles (`authorization`
  notamment) et tout corps de requête sont retirés du flux de logs
  structurés, vérifié à la fois unitairement et sur le pipeline HTTP réel
  (tentative d'authentification échouée et réussie, secret absent des deux).

## Variables d'environnement

Voir `.env.example` (aucun secret réel n'y figure). Table :

| Variable | Rôle | Défaut |
| --- | --- | --- |
| `NODE_ENV` | `development` \| `test` \| `production` | `development` |
| `PORT` | Port d'écoute HTTP | `3000` |
| `LOG_LEVEL` | Niveau pino (`fatal`…`silent`) | `info` |
| `DATABASE_URL` | URL Postgres du rôle **applicatif** (`factelec_app`, soumis à la RLS) | — (requis) |
| `DATABASE_OWNER_URL` | URL Postgres du rôle **owner** (`factelec_owner`, `BYPASSRLS`) | — (requis par les scripts uniquement) |
| `CORS_ALLOWED_ORIGINS` | Liste d'origines autorisées, séparées par virgule | `''` (aucune) |
| `RATE_LIMIT_TTL` | Fenêtre du rate limit (secondes) | `60` |
| `RATE_LIMIT_LIMIT` | Requêtes max par fenêtre et par IP | `120` |
| `TRUST_PROXY` | Nombre de proxys de confiance devant l'API (`app.set('trust proxy', n)`) | `0` (aucun) |
| `SESSION_TTL_HOURS` | Durée de vie **absolue** d'une session (utilisateur ou admin) — aucun renouvellement glissant (D1 amendé, plan 1.4) | `12` |
| `SESSION_COOKIE_DOMAIN` | Domaine des cookies `factelec_session`/`factelec_csrf` — requis en prod pour un partage same-site dashboard/API (ex. `.factelec.fr`) ; absent en dev (localhost) | — (absent = cookie scopé à l'hôte courant) |
| `REDIS_HOST` | Hôte Redis (BullMQ, workers) | `localhost` |
| `REDIS_PORT` | Port Redis | `6379` |
| `REDIS_DB` | Index de base logique Redis (`SELECT n`) | `0` |
| `REDIS_PASSWORD` | Mot de passe Redis (managed Redis en prod) | — (absent = aucune auth) |
| `REDIS_TLS` | TLS Redis — parsé explicitement (`"true"`/`"1"` uniquement ; **jamais** `z.coerce.boolean`, qui transformerait à tort `"false"` en `true`) | `false` |
| `GENERATION_JOB_ATTEMPTS` | Tentatives max d'un job de génération avant passage en `failed` (retries BullMQ, backoff exponentiel 1 s de base) | `3` |
| `SESSION_PURGE_EVERY_MS` | Périodicité (ms) du job répétable de purge des sessions expirées (worker, Task 7) | `3600000` (1 h) |
| `RECONCILIATION_STALE_MS` | Ancienneté (ms) au-delà de laquelle une facture `received` non enfilée est considérée orpheline et re-enfilée | `300000` (5 min) |
| `RECONCILIATION_SWEEP_EVERY_MS` | Périodicité (ms) du balayage de réconciliation | `60000` (1 min) |
| `RECONCILIATION_GENERATING_STALE_MS` | Ancienneté (ms) au-delà de laquelle une facture `generating` bloquée (worker tué en cours de génération) est re-enfilée | `900000` (15 min) |

**`DATABASE_OWNER_URL` n'est jamais lue par le process API** (absente du
schéma zod `envSchema`, `src/config/env.ts`) : elle n'est consommée que par
`scripts/migrate.ts`, `scripts/provision-tenant.ts` et
`scripts/provision-admin.ts`, tous trois exécutés hors du chemin de requête
HTTP.

**`TRUST_PROXY` — topologie réseau.** Le rate limiting par IP
(`ThrottlerGuard`) lit `req.ip`, qu'Express calcule à partir de
`X-Forwarded-For` **seulement** si `trust proxy` est activé. Déployée
directement (aucun load balancer / reverse-proxy devant elle), l'API doit
garder `TRUST_PROXY=0` (défaut) : tous les clients partagent alors
correctement leur vraie IP socket. **Derrière un LB/reverse-proxy**,
`TRUST_PROXY` doit être positionné au nombre exact de sauts de proxy pour que
le throttling par IP fonctionne (sinon tous les clients sont vus avec l'IP du
proxy et partagent le même seau). **Ne jamais positionner une valeur trop
haute** : un client pourrait alors forger son propre `X-Forwarded-For` pour
usurper une IP arbitraire et contourner le rate limiting d'un autre client
(risque de spoofing) — d'où le choix de n'accepter qu'un entier explicite
plutôt que `true` (qui ferait confiance à n'importe quelle chaîne de proxy
annoncée par le client).

## Développement

```sh
cd apps/api
docker compose up -d                         # Postgres ET Redis locaux + rôles (scripts/db-init)
DATABASE_OWNER_URL=... pnpm db:migrate        # applique 0000_init … 0009 (migrations séquentielles)
DATABASE_OWNER_URL=... pnpm provision:tenant "Ma boutique"   # → { tenantId, token } (token affiché 1 fois)
pnpm dev                                       # API : tsx watch
pnpm start:worker                              # worker (build requis, dist/worker-main.js) …
pnpm worker:dev                                # … ou tsx watch pour le worker, en développement
pnpm test                                      # Vitest + Testcontainers (Postgres + Redis, Docker requis)
```

L'API seule répond déjà (santé, ingestion, lecture) sans worker démarré —
mais les factures ingérées restent en `received` tant qu'aucun worker ne
tourne (aucune génération de formats ni transition de statut automatique).
En développement, lancer l'API **et** le worker dans deux terminaux séparés.

Depuis la racine du monorepo, `pnpm build` doit précéder `pnpm typecheck`
(`apps/api` résout `@factelec/invoice-core` via son `dist/`, pas ses
sources ; `pnpm build` compile aussi `src/worker-main.ts` via swc) : voir le
README racine.

## Endpoints

| Méthode & route | Description | Codes possibles |
| --- | --- | --- |
| `GET /health` | Liveness (aucune dépendance externe) | 200 |
| `GET /health/ready` | Readiness (ping Postgres **et Redis**, `@nestjs/terminus`, chacun borné 2 s) | 200, 503 |
| `POST /invoices` | Ingestion : validation `invoice-core`, persistance transactionnelle, **enfilement** du job de génération (asynchrone, 2.1 — voir § Nouvelle sémantique) | 201, 401, 409, 422 |
| `GET /invoices` | Liste paginée (keyset), tenant-scopée | 200, 401 |
| `GET /invoices/:id` | Métadonnées d'une facture (`status` de génération, `lifecycleStatus` CDV) + formats disponibles | 200, 401, 404 |
| `GET /invoices/:id/formats/:format` | Contenu d'un format (`ubl`, `cii`, `facturx`, `flux_base`, `flux_full`) avec le bon `Content-Type` (`application/xml` ou `application/pdf` pour `facturx`) — **404 tant que `status ≠ 'generated'`** | 200, 401, 404 |
| `POST /invoices/:id/status` | Transition de statut CDV (`{ toStatus, reason? }`) — session owner/admin/accountant + CSRF, CAS anti-race | 201, 401, 403, 404, 409, 422 |
| `GET /invoices/:id/status` | Statut CDV courant + historique complet (journal `invoice_status_events`) | 200, 401, 404 |
| `POST /auth/signup` | Inscription self-service : crée le tenant **et** l'utilisateur `owner` de façon atomique (fonction `SECURITY DEFINER` `signup_tenant`), ouvre une session | 201, 409, 422 |
| `POST /auth/login` | Authentification utilisateur (email + mot de passe Argon2id), ouvre une session | 200, 401, 422 |
| `POST /auth/logout` | Révoque la session courante (cookie `factelec_session`) | 204, 401 |
| `GET /auth/me` | Profil de l'utilisateur de la session courante | 200, 401 |
| `POST /api-keys` | Création d'une clé API pour le tenant de la session (rôles `owner`/`admin` uniquement) ; secret **affiché une seule fois** | 201, 401, 403, 422 |
| `GET /api-keys` | Liste des clés du tenant (préfixes uniquement, jamais le secret) — tout rôle utilisateur authentifié | 200, 401, 403 |
| `DELETE /api-keys/:id` | Révocation immédiate d'une clé (rôles `owner`/`admin` uniquement) | 204, 401, 403, 404 |
| `POST /admin/login` | Authentification super admin plateforme (`platform_admins`, Argon2id), ouvre une session admin | 200, 401, 422 |
| `POST /admin/logout` | Révoque la session admin courante | 204, 401, 403 |
| `GET /admin/tenants` | Liste de tous les tenants (vue plateforme : nombre d'utilisateurs, de factures) | 200, 401, 403 |

**Rate limiting global par IP** (`ThrottlerGuard`, `APP_GUARD`) : **toute
route ci-dessus peut renvoyer 429**, à l'exception de `/health`/`/health/ready`
(exemptées via `@SkipThrottle()` — jamais rate-limitées, interrogées à haute
fréquence par l'orchestrateur). Seuils renforcés (`@Throttle`, en plus du
défaut `RATE_LIMIT_TTL`/`RATE_LIMIT_LIMIT`) sur `POST /auth/signup` (5/h/IP),
`POST /auth/login` (10/15 min/IP) et `POST /admin/login` (10/15 min/IP) —
anti-brute-force/anti-abus, vérifiés en e2e (429 réel).

**Deux régimes d'authentification distincts, jamais interchangeables** :
- **`POST /invoices`** (ingestion) reste **exclusivement machine** :
  `Authorization: Bearer fk_<prefix>.<secret>`, sans repli possible.
- **`GET /invoices`, `GET /invoices/:id`, `GET /invoices/:id/formats/:format`,
  `GET /invoices/:id/status`** (lecture) acceptent **soit une clé API, soit
  une session utilisateur** du même tenant (`TenantAuthGuard`, dual-auth) —
  jamais une session **admin** plateforme, refusée par ce guard. Un en-tête
  `Authorization: Bearer` présent est **toujours** résolu en priorité (même
  invalide) : un client machine ne retombe jamais silencieusement sur un
  cookie de session qui traînerait dans la même requête.
- **`POST /invoices/:id/status`** (transition CDV) est une **mutation
  métier** : exclusivement session **owner/admin/accountant** + CSRF
  (`SessionGuard`/`RolesGuard`/`CsrfGuard`) — un `viewer` est refusé (403),
  une clé API n'ouvre pas cette route (`SessionGuard` → 401, pas de cookie).
  L'apposition automatique par un connecteur/le réseau Peppol est différée
  (phase 3).
- **`/auth/*`, `/api-keys/*`, `/admin/*`** sont exclusivement pilotés par
  **session serveur httpOnly** (cookie `factelec_session`) + **CSRF
  double-submit** (`X-CSRF-Token` face au cookie lisible `factelec_csrf`) sur
  toute mutation — jamais par clé API. Détail complet (Argon2id partagé,
  jetons opaques 256 bits hash-only, RLS `FORCE` sur `users`/`sessions`,
  `platform_admins` isolé des tenants) : voir `docs/superpowers/` (plan 1.4)
  et les commentaires des guards (`src/auth/session.guard.ts`,
  `src/auth/tenant-auth.guard.ts`, `src/admin/admin.guard.ts`).

## Provisioning

- **Tenants** : self-service via `POST /auth/signup` (transactionnel,
  fonction `SECURITY DEFINER` `signup_tenant`) **ou** CLI
  `pnpm provision:tenant "Nom"` (rôle owner, hors chemin de requête,
  conservé pour le provisioning hors self-service).
- **Super admins plateforme** : **CLI uniquement**, aucune inscription
  self-service : `DATABASE_OWNER_URL=... PROVISION_ADMIN_PASSWORD=... pnpm
  provision:admin <email>` (`scripts/provision-admin.ts`, rôle owner, insère
  dans `platform_admins`). Le mot de passe ne transite **jamais** par argv
  (visible via `ps`/l'historique du shell) : il est lu depuis
  `PROVISION_ADMIN_PASSWORD`, ou saisi de façon interactive sur stdin si la
  variable est absente. Un email déjà provisionné (23505) renvoie un message
  d'erreur clair, sans stack trace.

## Tests

- **Postgres réel** (Testcontainers, aucun mock de persistance) pour tous
  les tests e2e — RLS, transactions, contraintes d'unicité et curseur keyset
  sont exercés contre un vrai moteur, pas une simulation.
- **Isolation cross-tenant** vérifiée à deux niveaux : DB (policies RLS,
  `SET app.tenant_id` puis lecture/écriture croisée) et HTTP (`GET
  /invoices/:id` d'un autre tenant → 404 byte-identique à un vrai
  not-found).
- **Curseur de pagination micro-précis** : le curseur keyset transite par une
  représentation texte en microsecondes (`to_char(created_at AT TIME ZONE
  'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`) plutôt que par un `Date` JS
  (précision milliseconde), pour éviter la perte de lignes dont le timestamp
  partage la même milliseconde qu'une borne de page (cas réaliste en cas
  d'ingestion par lot).
- **Contrat volontaire d'un curseur malformé** : un `cursor` illisible (mal
  recollé par un client, tronqué, etc.) ne renvoie jamais une erreur 400 —
  `decodeCursor` renvoie `null`, silencieusement traité comme « pas de
  curseur » (redémarrage en première page).
- **Isolation admin↔tenant** vérifiée dans les deux sens (`admin.e2e.test.ts`) :
  une session admin plateforme ne peut ni lire `/api-keys` ni la lecture des
  factures (`TenantAuthGuard` la refuse explicitement) ; une session tenant
  ne peut pas accéder à `/admin/tenants` (403).
- **Redis réel** (Testcontainers, `@testcontainers/redis`) pour tous les
  tests e2e touchant à la file (`queue-readiness`, `async-generation`,
  `session-purge`) — aucun mock BullMQ/ioredis.
- **Worker bouclé en-process** (`tests/e2e/helpers/worker.ts#createTestWorker`)
  : le **vrai** `WorkerModule` est monté contre le Postgres/Redis de test
  (mêmes overrides que l'app HTTP de test), pas un double — les e2e
  `async-generation.e2e.test.ts` exercent la génération asynchrone de bout
  en bout (`received → generating → generated`), les retries/échec définitif
  (`failed` après épuisement, générateur stub qui throw), et la
  réconciliation (factures orphelines re-enfilées, jobs `failed` évincés).
- **Cycle de vie CDV** (`lifecycle-persistence.e2e.test.ts`,
  `lifecycle.e2e.test.ts`) : transitions valides/invalides (422), motif
  requis (`refusee`/`suspendue`), CAS anti-race (409 sur écriture
  concurrente simulée), historique ordonné, isolation cross-tenant (404),
  immuabilité du journal vérifiée au niveau grants (tentative `UPDATE`/
  `DELETE` par `factelec_app` rejetée par Postgres, pas seulement par le
  code applicatif).
- **Dette de test mineure documentée** : l'ordonnancement de certaines
  assertions e2e sur l'historique du journal CDV s'appuie sur l'ordre
  d'insertion plutôt que sur un critère explicite indépendant du timing —
  fragile en théorie si deux transitions successives partageaient un
  timestamp identique à la microseconde ; non observé en pratique (chaque
  transition est sa propre transaction), à muscler (tri secondaire explicite)
  si la suite devenait flaky.
- **Couverture ≥ 90 % bloquante** (lignes/fonctions/statements/branches,
  `vitest.config.ts`), exclusions limitées au bootstrap et au câblage DI pur
  (`main.ts`, `**/*.module.ts`, `src/db/migrations/**`). État actuel : 67
  fichiers, **335 tests**, couverture **98.02 / 94.64 / 95.91 / 98.53 %**
  (statements/branches/functions/lines).

```sh
pnpm test          # apps/api : Vitest + Testcontainers (Postgres + Redis, Docker requis)
```

## Limites v1 / TODO

- **Résolu en 2.1** : génération asynchrone par workers BullMQ (était
  synchrone en 1.3/1.4) ; `last_used_at` (table `api_keys`) écrit à chaque
  authentification réussie ; purge périodique des sessions expirées (job
  BullMQ répétable). Voir § Architecture workers pour le détail.
- **Fenêtre résiduelle de réconciliation** (2.1, documentée, non couverte
  par un verrou distribué) : un `SIGTERM` du worker frappant exactement
  entre le marquage `generating` et la transaction `completeGeneration`
  laisse la facture bloquée jusqu'au balayage suivant — bornée à
  `RECONCILIATION_GENERATING_STALE_MS` (~15 min par défaut), jamais
  indéfiniment. Voir § Architecture workers.
- **Machine à états CDV = interprétation projet** (2.1, chronologie
  monotone du code DGFiP) — **à durcir contre la norme AFNOR XP Z12-012**
  avant mise en production réelle ; aucune matrice de transitions formelle
  n'est publiée par la DGFiP dans le dépôt. Voir § Cycle de vie CDV.
- **`last_used_at` : contention potentielle sous forte concurrence** (2.1)
  — `authenticate_api_key` exécute désormais un `UPDATE ... RETURNING` à
  **chaque** authentification (verrou de ligne implicite sur la clé API
  concernée) ; un même client émettant un très fort volume de requêtes
  concurrentes avec la **même** clé API pourrait observer une légère
  sérialisation sur cette ligne. Non mesuré en charge réelle à ce jour — à
  surveiller si un tenant à très haut débit d'ingestion apparaît ; piste de
  correction si nécessaire : différer/regrouper l'écriture (throttling) au
  lieu d'un `UPDATE` synchrone par requête.
- **Rate limiting par IP uniquement**, pas encore par tenant/clé — non
  planifié à ce jour.
- **Expiration glissante des sessions** différée : seule l'expiration
  **absolue** (`SESSION_TTL_HOURS`) est implémentée (D1 amendé, plan 1.4) ;
  pas de renouvellement à l'usage.
- **Durcissement de la session admin** (TTL réduit spécifique, distinct de
  `SESSION_TTL_HOURS`) différé — la session super admin partage aujourd'hui
  la même durée de vie absolue que les sessions utilisateur.
- **`Content-Disposition`** absent sur les téléchargements de formats
  (`GET /invoices/:id/formats/:format`) : le fichier s'ouvre dans l'onglet
  plutôt que de déclencher un téléchargement nommé — raffinement différé.
- **Garde anti-double-clic** absente côté client sur les mutations
  (création de clé API, ingestion) — différée.
- Provisioning tenant : **self-service** via `POST /auth/signup` (plan 1.4)
  **et** CLI `pnpm provision:tenant` (conservé). Provisioning **super
  admin** : **CLI exclusivement** (`pnpm provision:admin`), aucune
  inscription self-service — décision assumée, pas une limitation à lever.

### Différé explicitement 2.2+ (hors périmètre 2.1)

- **E-reporting DGFiP** (Flux 10) et **annuaire central** (Flux 13/14) —
  aucune transmission ni consultation d'annuaire à ce jour.
- **Scellement / archivage à valeur probante** (WORM, 10 ans) — le journal
  `invoice_status_events` append-only (2.1) en est le **substrat direct**
  (immuabilité par grants Postgres) mais n'est **pas** scellé
  cryptographiquement ; à cette occasion, revoir le `ON DELETE CASCADE` de
  `invoice_status_events` vers `invoices` (`0007_invoice_lifecycle.sql`) —
  un journal à valeur probante ne devrait pas pouvoir disparaître avec la
  suppression de sa facture.
- **Transmission Peppol des statuts CDV** et **apposition automatique** des
  transitions par un connecteur/le réseau → **phase 3**. Les transitions
  2.1 sont exclusivement pilotées par session utilisateur.
- **Journal d'audit des authentifications** (connexions, échecs,
  révocations de session — distinct du journal CDV 2.1) → **horizon 2.x**.
- **Migration Factur-X D22B / 1.09** (héritée d'`invoice-core`, plan
  1.2bis) — différée dans l'attente d'un Schematron D22B publié par
  ConnectingEurope.
