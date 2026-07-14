# `@factelec/api`

API REST NestJS d'ingestion et de lecture des factures électroniques
(phase **1.3**), étendue en **1.4** avec l'authentification utilisateur
(sessions httpOnly + CSRF), le signup self-service transactionnel, la
gestion des clés API par session et un super admin plateforme minimal.
Consomme `@factelec/invoice-core` (validation, calculs, génération des
formats du socle) et expose l'ensemble derrière une couche d'authentification
et d'isolation multi-tenant Postgres.

> **Dettes 1.3 soldées** (plan 1.4, task 1) : `createDb` (piège hors-tenant,
> jamais appelé en production) retiré de `src/db/client.ts` ; `DATABASE_URL`
> migré de `z.string().url()` (déprécié) vers `z.url()` (zod 4). Aucun
> changement de comportement — refactor mécanique couvert par la suite
> existante.

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
- **Génération synchrone.** La génération des formats (UBL, CII, Factur-X,
  extraits de flux) est effectuée **de façon synchrone**, dans la même
  transaction que la persistance de la facture, derrière un port
  `InvoiceFormatGenerator` (`src/invoices/format-generator.port.ts`) dont
  l'unique implémentation actuelle est `SynchronousFormatGenerator`
  (appelle directement `@factelec/invoice-core`). **Aucune file d'attente,
  aucun worker.** Le passage à des workers BullMQ (génération asynchrone,
  statut `pending` → `generated`/`failed`) est prévu en **1.4/2.x** ; il
  s'implémente comme un second adaptateur du même port
  (`QueuedFormatGenerator`), **sans modifier l'ingestion** ni le contrat
  `POST /invoices` (point de risque n°4 du plan).

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
  (runtime), seul rôle dont dispose `DATABASE_URL`. N'a que `USAGE` sur le
  schéma, `SELECT/INSERT/UPDATE` sur les 4 tables, et `EXECUTE` sur
  `authenticate_api_key` — jamais `BYPASSRLS`.

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
docker compose up -d                         # Postgres local + rôles (scripts/db-init)
DATABASE_OWNER_URL=... pnpm db:migrate        # applique 0000_init + 0001_roles_rls
DATABASE_OWNER_URL=... pnpm provision:tenant "Ma boutique"   # → { tenantId, token } (token affiché 1 fois)
pnpm dev                                       # tsx watch
pnpm test                                      # Vitest + Testcontainers (Docker requis)
```

Depuis la racine du monorepo, `pnpm build` doit précéder `pnpm typecheck`
(`apps/api` résout `@factelec/invoice-core` via son `dist/`, pas ses
sources) : voir le README racine.

## Endpoints

| Méthode & route | Description | Codes possibles |
| --- | --- | --- |
| `GET /health` | Liveness (aucune dépendance externe) | 200 |
| `GET /health/ready` | Readiness (ping Postgres via `@nestjs/terminus`) | 200, 503 |
| `POST /invoices` | Ingestion : validation `invoice-core`, génération synchrone des 5 formats, persistance transactionnelle | 201, 401, 409, 422 |
| `GET /invoices` | Liste paginée (keyset), tenant-scopée | 200, 401 |
| `GET /invoices/:id` | Métadonnées d'une facture + formats disponibles | 200, 401, 404 |
| `GET /invoices/:id/formats/:format` | Contenu d'un format (`ubl`, `cii`, `facturx`, `flux_base`, `flux_full`) avec le bon `Content-Type` (`application/xml` ou `application/pdf` pour `facturx`) | 200, 401, 404 |
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
- **`GET /invoices`, `GET /invoices/:id`, `GET /invoices/:id/formats/:format`**
  (lecture) acceptent **soit une clé API, soit une session utilisateur** du
  même tenant (`TenantAuthGuard`, dual-auth) — jamais une session **admin**
  plateforme, refusée par ce guard. Un en-tête `Authorization: Bearer`
  présent est **toujours** résolu en priorité (même invalide) : un client
  machine ne retombe jamais silencieusement sur un cookie de session qui
  traînerait dans la même requête.
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
- **Couverture ≥ 90 % bloquante** (lignes/fonctions/statements/branches,
  `vitest.config.ts`), exclusions limitées au bootstrap et au câblage DI pur
  (`main.ts`, `**/*.module.ts`, `src/db/migrations/**`). État actuel : 50
  fichiers, **237 tests**, couverture **98.31 / 97.07 / 97.14 / 98.64 %**
  (statements/branches/functions/lines).

```sh
pnpm test          # apps/api : Vitest + Testcontainers (Docker requis)
```

## Limites v1 / TODO

- **Génération synchrone** — pas de file d'attente ; passage à des workers
  BullMQ prévu en **phase 2** (Cœur réglementaire — cycle de vie/transmission)
  derrière le port `InvoiceFormatGenerator` existant, sans changement du
  contrat `POST /invoices`. Aucune transmission/cycle de vie en 1.4, donc
  aucune file n'est nécessaire à ce stade.
- **`last_used_at`** (table `api_keys`) demeure une colonne morte, jamais
  écrite (reporté — décision à trancher : l'alimenter à chaque
  authentification ou la retirer).
- **Rate limiting par IP uniquement**, pas encore par tenant/clé — non
  planifié à ce jour.
- **Expiration glissante des sessions** différée : seule l'expiration
  **absolue** (`SESSION_TTL_HOURS`) est implémentée (D1 amendé, plan 1.4) ;
  pas de renouvellement à l'usage.
- **Purge périodique des sessions expirées** différée (pas de job de
  ménage ; les lignes expirées restent en base, simplement inertes côté
  authentification).
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
