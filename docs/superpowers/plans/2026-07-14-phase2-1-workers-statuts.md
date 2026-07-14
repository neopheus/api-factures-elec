# Plan 2.1 — Workers BullMQ (génération asynchrone) & cycle de vie des statuts

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ouvrir la **phase 2 (Cœur réglementaire)** en livrant deux briques : (1) l'**infrastructure de workers** — Redis + BullMQ, un adaptateur `QueuedFormatGenerator` qui **remplace la génération synchrone** derrière le port `InvoiceFormatGenerator` existant, un **processus worker séparé** (second point d'entrée NestJS dans `apps/api`, mêmes modules, exécuté en processus distinct), l'**idempotence** des jobs, **retries/backoff**, et un **statut de génération** persisté (`received → generating → generated | failed`) ; (2) le **cycle de vie réglementaire des statuts de facture** (statuts CDV DGFiP du Flux 2 / Flux 6) — modèle de données à deux axes (statut de **génération** technique vs statut **métier CDV**), **machine à états** pure (transitions valides), **journal d'événements append-only** (immuable, substrat du futur journal à valeur probante), endpoints REST et RLS. Plus deux **dettes 1.3/1.4** soldées : `last_used_at` des clés API (écrit désormais) et **purge des sessions expirées** (job répétable BullMQ). L'e-reporting, l'annuaire, le scellement/archivage à valeur probante et la transmission Peppol des CDV sont **explicitement reportés** (voir Périmètre).

**Architecture:** On **réutilise intégralement** le socle 1.3/1.4 (RLS Postgres `FORCE`, `runInTenant` + `SET LOCAL app.tenant_id`, rôle `factelec_app` sans `BYPASSRLS`, fonctions `SECURITY DEFINER`, filtre `problem+json`, guards). Le flux central de la spec (§3.2) devient réel : `POST /invoices` **valide** (zod + règles EN 16931, synchrone → 422 immédiat), **persiste** la facture au statut de génération `received` (idempotence `(tenant, number)` → 409 synchrone) puis **enfile** un job minimal `{ tenantId, invoiceId }` et répond `201 { id, status: 'received' }`. Un **worker** (processus séparé, mêmes modules NestJS via `NestFactory.createApplicationContext`) consomme la file `invoice-generation`, **recharge** la facture canonique depuis Postgres **sous RLS**, génère les 5 formats du socle (logique de génération inchangée, relocalisée dans un service injectable), les persiste, et fait passer le statut à `generated` (ou `failed` après épuisement des retries). Le port `InvoiceFormatGenerator` (contrat de génération pure) est conservé et devient l'outil du worker ; l'ingestion parle désormais à un port d'**enfilement** (`InvoiceGenerationQueue`). Le **cycle de vie CDV** est un axe distinct : la facture porte un `lifecycle_status` réglementaire (initialisé à *Déposée* à l'ingestion), avancé via une **machine à états** vérifiée, chaque transition inscrite dans une table `invoice_status_events` **append-only** (grants `SELECT`/`INSERT` seulement → immuabilité par construction). Aucune connaissance du transport (Peppol = phase 3) : les transitions sont pilotées en 2.1 par l'API (actions du marchand) et par la plateforme (Déposée) ; la réception de CDV externes réutilisera le même service de transition en phase 3.

**Tech Stack:** Ajouts `apps/api` : **BullMQ 5.80.2** (files/jobs Redis) + **@nestjs/bullmq 11.0.4** (intégration DI idiomatique : `BullModule.registerQueue`, `@Processor`, `WorkerHost`, `InjectQueue`) ; **@testcontainers/redis 12.0.4** (dev/test : Redis réel en e2e). La connexion Redis passe par les **`ConnectionOptions` de BullMQ** (host/port/db/password/tls tirés de l'env) — **pas de dépendance `ioredis` directe** (BullMQ embarque et gère son propre client ; la sonde de readiness ping via `queue.client`). Machine à états et modèle CDV en **TypeScript pur** (aucune lib). docker-compose dev : service **Redis** ajouté.

## Global Constraints

Reprises **verbatim** du socle 1.3/1.4 (non négociables) — chaque tâche en hérite implicitement :

- **TDD strict RED/GREEN** : test écrit et vu échouer avant toute implémentation ; aucun merge si un test échoue (spec §7). Un commit minimum par tâche, message en **français**, **sans** trailer `Co-Authored-By: Claude` ni mention Claude ; commits au seul nom de l'utilisateur. `pnpm format` avant chaque commit.
- **Couverture bloquante** : **≥ 90 %** (lines/functions/statements/branches) maintenue sur `apps/api` ; `packages/invoice-core` reste à **100 %** (ne pas y toucher). `apps/web` : seuil 90×4 maintenu (aucune modif web dans ce plan sauf mention explicite). Exclusions de couverture existantes conservées (`src/main.ts`, `**/*.module.ts`, `src/db/migrations/**`) ; le **nouveau point d'entrée worker** (`src/worker-main.ts`) est ajouté aux exclusions bootstrap (même statut que `main.ts` : pur câblage, aucune logique testable hors e2e).
- **e2e sur Postgres réel ET Redis réel (Testcontainers)** pour tout nouvel endpoint et tout flux worker ; **tests d'isolation multi-tenant explicites** (une facture/un statut/un événement d'un tenant n'est jamais visible d'un autre). **Motifs de stabilité e2e OBLIGATOIRES** (acquis post-1.4, cf. `helpers/app.ts`, `helpers/postgres.ts`, `vitest.config.ts`) : `listenOnce` (serveur de test démarré **une seule fois** par fichier), `maxWorkers: 5`, `withStartupTimeout(120_000)`, `hookTimeout: 150_000`. Tout nouveau fichier e2e démarrant un conteneur Redis DOIT appliquer les mêmes timeouts et démarrer/arrêter proprement le conteneur dans `beforeAll`/`afterAll`.
- **Sécurité OWASP** : validation de toute entrée (zod), authz systématique. **Aucune donnée sensible (contenu de facture, secrets, PII) dans les payloads Redis** : le job ne transporte **que** des identifiants (`tenantId`, `invoiceId` — UUID internes non sensibles) ; le worker recharge le contenu depuis Postgres sous RLS. **Aucun secret côté client / logs** (redaction pino conservée). Erreurs normalisées **RFC 9457 `application/problem+json`** (anti-fuite conservé).
- **Moindre privilège Postgres inchangé** : rôle applicatif `factelec_app` ≠ propriétaire, **sans `BYPASSRLS`, sans superuser** ; RLS **`ENABLE` + `FORCE`** sur toute table tenant (y compris les nouvelles tables de ce plan) ; propagation du tenant par `SET LOCAL` transactionnel via `runInTenant`. Le **worker réutilise `factelec_app`** (décision D6 — pas de rôle dédié : ses opérations sont un sous-ensemble strict de celles de l'API, un rôle distinct n'ôterait aucun privilège et alourdirait l'exploitation). Le process API/worker ne connaît **que** `DATABASE_URL` (rôle app) — **jamais** `DATABASE_OWNER_URL`.
- **TypeScript `strict: true`, ESM (`"type": "module"`), NodeNext, Node ≥ 22.** `typescript` pinné **exactement `7.0.2`** (racine, tsgo). Repli local `typescript@5.9.x` **du seul workspace concerné** autorisé et documenté si un typecheck bute (comme 1.3/1.4) — sans toucher le pin racine.
- **Dépendances pinnées exactement** (pas de `^`/`~`), **dernière stable** vérifiée au registre, avec licence. **`pnpm audit` 0 vulnérabilité** et **`pnpm outdated -r` vierge** restent **bloquants** en CI. Politique transitive : override `pnpm.overrides` si correctif dispo ; sinon documenter + arbitrer (jamais de merge avec vuln exploitable).
- **`@factelec/invoice-core` consommé via son exports map**, jamais par chemin relatif inter-packages. `docs/reference/` et `docs/reglementaire/` en **lecture seule** (tout ajout vendorisé porte sa provenance).
- Identifiants de code en **anglais** ; commentaires/commits/docs en **français**.

---

## Périmètre : retenu en 2.1 vs reporté en 2.2+

**Retenu (ce plan) :**
1. **Infrastructure workers** : Redis + BullMQ, connexion, module de file, sonde de readiness Redis, docker-compose dev.
2. **Génération asynchrone** : `QueuedFormatGenerator` (enfile) derrière le port existant ; statut de génération `received/generating/generated/failed` ; worker séparé + processor idempotent, retries/backoff.
3. **Cycle de vie CDV (socle)** : nomenclature DGFiP des statuts métier (Flux 2 / Flux 6), machine à états pure, colonne `lifecycle_status`, journal `invoice_status_events` append-only, endpoints de transition + historique, RLS + rôles.
4. **Dettes 1.3/1.4** : `last_used_at` des clés API écrit à l'authentification ; **purge des sessions expirées** (job répétable BullMQ).
5. **CI/docs** : Testcontainers Redis en CI, README mis à jour, versions pinnées + provenance.

**Reporté (2.2+), acté ici :**
- **E-reporting** (Flux 10 — `docs/reglementaire/.../3- XSD_v3.2/1 - E-reporting/*.xsd`, Annexe 6 v1.10) : sous-système complet (agrégation B2C/international + paiements, transmission concentrateur DGFiP) → **plan 2.2**.
- **Annuaire** (Flux 13/14 — Swagger `ppf-openapi-annuaire-api-public-1.11.0`, Annexe 3) : consultation/routage SIREN→PA, inscriptions → **plan 2.2/2.3**.
- **Scellement & archivage à valeur probante** (spec §4.5 : hash SHA-256 chaîné, horodatage, S3 object-lock WORM 10 ans, PAF exportable) : le **journal d'événements append-only** de ce plan en est le **substrat**, mais le scellement cryptographique et le stockage WORM sont couplés à l'archivage → **plan 2.2**.
- **Transmission Peppol des messages CDV** (émission/réception AS4 des statuts entre PA) → **phase 3** ; en 2.1 les statuts sont pilotés par l'API et la plateforme, transport-agnostiques.
- **Journal d'audit à valeur probante des authentifications** (connexions/échecs/révocations, horizon « 2.x » du README) : distinct du cycle de vie facture ; non inclus (voir D7 pour la justification du découpage).
- **Migration Factur-X D22B / F1 CII D22B** : les XSD F1 de v3.2 sont désormais **CII D22B** (`F1_BASE_CII_D22B`, `F1_FULL_CII_D22B`), alors qu'`invoice-core` cible D16B (cohérence Schematron EN 16931 `validation-1.3.16`). Migration inchangée (héritée 1.2bis) — hors périmètre workers/statuts.

---

## Décisions structurantes (à lire avant d'exécuter)

### D1 — Génération asynchrone : l'ingestion CHANGE de sémantique (assumé), le port de génération est CONSERVÉ

- La note 1.3/1.4 « workers BullMQ sans toucher l'ingestion » était optimiste : rendre la génération réellement asynchrone **change le contrat de réponse** de `POST /invoices` (`status: 'generated'` synchrone → `status: 'received'`, la génération se terminant hors-bande). C'est **assumé et documenté** : le projet est pré-production (pré-immatriculation), le champ `status` existait précisément pour cet usage, et la spec §3.2 prescrit `ingestion → file BullMQ → workers`. **Le test `ingestion.e2e.test.ts` sera mis à jour** (Task 2 : `received` + facture persistée sans formats ; Task 3 : flux complet asynchrone jusqu'à `generated`).
- **Port conservé, rôle déplacé.** `InvoiceFormatGenerator.generate(invoice): Promise<GeneratedFormat[]>` (contrat de **génération pure**) reste inchangé et devient l'outil **du worker** (l'implémentation `SynchronousFormatGenerator` est renommée `FormatGenerationService`, même code, injectable, consommée par le processor). L'ingestion parle à un **nouveau port d'enfilement** `InvoiceGenerationQueue.enqueue(tenantId, invoiceId): Promise<void>`. On **ne jette rien** : la logique de génération testée en 1.3 est réutilisée telle quelle.
- **Deux axes de statut, non fusionnés.** `invoices.status` (enum `invoice_status`, déjà existant) = **statut de génération technique** (`received → generating → generated | failed`) ; on ajoute `generating`. `invoices.lifecycle_status` (nouvel enum) = **statut métier CDV DGFiP**. Le dashboard 1.4 lit `status` (inchangé). La distinction est explicite partout (nommage `generationStatus` en surface API si besoin, colonne `status` conservée pour compat).

### D2 — Architecture worker : second point d'entrée dans `apps/api`, PAS un workspace `apps/worker` séparé en 2.1

- La spec §3.1 liste `apps/worker/ → mêmes modules NestJS exécutés en processus séparé (BullMQ)`. La **propriété structurante** est « **mêmes modules NestJS** » + « **processus séparé** ». Un **second point d'entrée** `src/worker-main.ts` dans `apps/api`, bootant un **contexte applicatif** (`NestFactory.createApplicationContext(WorkerModule)`) qui **provisionne le `@Processor`**, satisfait exactement cette intention : c'est le **même** graphe de modules NestJS (DB, RLS, génération), dans un **processus/conteneur OS distinct** (script `start:worker`), sans dupliquer un workspace ni transformer `apps/api` (une **app**) en bibliothèque importable.
- **Écart justifié vs le dossier littéral `apps/worker/`** : créer un workspace séparé imposerait de re-packager les modules NestJS en lib partagée, un second `package.json`/`tsconfig`/pipeline CI, pour **zéro bénéfice** en 2.1 (un seul consommateur, une seule file). YAGNI. La **promotion** vers `apps/worker` deviendra pertinente en **phase 3** (workers Peppol de transmission qui prolifèrent) ; le découplage est déjà propre (`WorkerModule` isolé), donc l'extraction future est mécanique. Décision consignée au point de reprise.
- **Séparation producteur/consommateur** : le `@Processor` (qui crée un `Worker` BullMQ dès qu'il est instancié) vit dans `WorkerModule`, **importé uniquement** par `worker-main.ts` — **jamais** par `AppModule` (l'API). L'API importe `QueueModule` (connexion + `registerQueue` → producteur `InjectQueue`) sans processor : elle **enfile**, elle ne **consomme pas**. Sans cette séparation, le process API se mettrait à consommer les jobs (indésirable).

### D3 — Connexion Redis : `ConnectionOptions` BullMQ, aucune dépendance `ioredis` directe

- BullMQ **embarque** ioredis (dépendance épinglée exacte `ioredis@5.10.1` dans `bullmq@5.80.2`) et **crée/possède** ses clients à partir d'un objet d'options. On passe donc `connection: { host, port, db, password?, tls? }` (tiré de l'env validé zod) — **pas** d'instance ioredis fabriquée par nous → **aucune dépendance `ioredis` directe** à déclarer, **aucun risque de double-copie** ioredis (instance étrangère à celle de BullMQ), et la gate `outdated` reste vierge (ioredis reste une transitive non déclarée, non signalée par `pnpm outdated -r`). BullMQ applique lui-même `maxRetriesPerRequest: null` sur la connexion **bloquante** du worker.
- **Readiness Redis** : la sonde `/health/ready` ping via le client de la file (`await (await queue.client).ping()` → `'PONG'`), sans ouvrir de connexion supplémentaire ni importer ioredis.
- **Alternative écartée** : instance `IORedis` partagée fabriquée manuellement (recommandée par BullMQ pour plafonner le nombre de connexions à grande échelle) → ajoute une dépendance directe + le risque de double-copie + un override pour unifier la version. Inutile à l'échelle 2.1 (une file, faible débit). À réévaluer si le nombre de connexions Redis devient un facteur (phase 5, montée en charge) — noté au reprise.

### D4 — Idempotence, retries/backoff, rejeu sûr

- **Idempotence d'enfilement** : `jobId = invoiceId` (UUID unique par facture). BullMQ **déduplique** : ré-enfiler la même facture (rejeu d'ingestion, at-least-once) n'ajoute pas de doublon tant que le job existe.
- **Idempotence de traitement (rejeu)** : le processor est **rejouable** — dans **une** transaction tenant, il **supprime** les formats existants de la facture puis **réinsère** les 5 formats et repositionne le statut. La contrainte `unique(invoice_id, kind)` interdit les doublons ; le delete+insert garantit qu'un rejeu (retry après crash partiel) converge vers le même état. Aucune écriture partielle visible (transaction).
- **Retries/backoff** : `attempts: 3`, `backoff: { type: 'exponential', delay: 1000 }` (défaut de file). Une exception dans le processor déclenche un retry BullMQ. **Après épuisement** des tentatives, le statut de génération passe à `failed` (via le hook `@OnWorkerEvent('failed')` en vérifiant `job.attemptsMade >= attempts`, ou via un traitement explicite du dernier échec) — la facture reste **consultable** (`GET /invoices/:id` → `status: 'failed'`), non silencieusement perdue.
- **Rétention** : `removeOnComplete: { age: 86400, count: 1000 }`, `removeOnFail: { age: 604800 }` (7 j) — traçabilité des échecs sans faire enfler Redis. Valeurs documentées, ajustables.

### D5 — Cycle de vie CDV : source réglementaire, machine à états, journal append-only

- **Source faisant foi** : `docs/reglementaire/specifications-externes-v3.2/2- Annexes_v3.2/20260430_Annexe 2 - Format sémantique FE CDV - Flux 6 - V2.3.xlsx` (feuille « Statuts » : nomenclature des codes par flux ; feuille « CDV FE - CI ARM » : format du message) + `Annexe 7 - Règles de gestion - V1.9` (règles de transition) + `Dossier de spécifications externes FE - Dossier général_v3.2.pdf`. La liste des statuts, leurs **codes numériques exacts**, la classification **Obligatoire/Recommandé/Libre** et les **transitions autorisées** sont extraits VERBATIM de ces sources (Task 4 en dépend — voir le tableau de nomenclature). Règle projet : **jamais de valeur de mémoire** ; chaque code est tracé à sa cellule/section source (comme les 13 codes BT-23 G1.02 et les 88 codes VATEX).
- **Machine à états PURE** (`src/invoices/lifecycle-status.ts`, aucun I/O) : liste des statuts, `INITIAL_STATUS`, table `ALLOWED_TRANSITIONS`, statuts terminaux, `canTransition(from, to)`, `assertTransition(from, to)`. Testée à part (RED/GREEN rapide, sans conteneur) — c'est le cœur vérifiable du modèle réglementaire.
- **Journal append-only** : table `invoice_status_events` (id, tenant_id, invoice_id, from_status, to_status, actor, reason, created_at). Grants `factelec_app` = **`SELECT` + `INSERT` uniquement** (pas d'`UPDATE`/`DELETE`) → **immuabilité imposée par la base**, vérifiée en e2e (tentative d'`UPDATE`/`DELETE` → `42501`). C'est le **substrat** du futur journal à valeur probante (scellement en 2.2) sans en implémenter encore le hash chaîné/WORM.
- **Pilotage 2.1** : la plateforme pose *Déposée* à l'ingestion ; le marchand fait avancer le statut via `POST /invoices/:id/status` (actions métier réelles : approbation, litige, encaissement…). La **réception de CDV externes** (autres PA) réutilisera le **même** `LifecycleService.transition(...)` en phase 3 — transport-agnostique (spec §3.2).

### D6 — Rôle Postgres du worker : `factelec_app` réutilisé (moindre privilège inchangé)

- Le worker lit la facture canonique, écrit `invoice_formats`, met à jour `invoices.status` — **strictement les mêmes opérations** que l'API 1.3, sur les **mêmes tables**, sous **la même RLS** (`runInTenant`). Un rôle Postgres dédié n'**ôterait aucun privilège** (le sous-ensemble est déjà minimal) et ajouterait un secret/URL supplémentaire à gérer. **Décision : réutiliser `factelec_app`.** La moindre privilège est déjà garantie par la RLS `FORCE` et l'absence de `BYPASSRLS`. (Un rôle distinct ne se justifierait que si le worker accédait à des tables ou opérations que l'API ne doit pas — ce n'est pas le cas en 2.1.)

### D7 — Journal d'audit à valeur probante des authentifications : NON inclus (2.2), justifié

- Le README liste, en prérequis pré-DGFiP, un « journal d'audit des authentifications » (horizon 2.x). Ce plan livre le **journal d'événements du cycle de vie facture** (append-only, immuable) — pas le journal d'**authentification** (connexions/échecs/révocations de session admin/user). Raison du découpage : (a) charge — workers + statuts remplissent déjà 8 tâches ; (b) cohérence — le journal d'auth relève de la **sécurité/traçabilité transverse**, pas du cœur facturation ; (c) le **scellement à valeur probante** (hash chaîné, WORM) est commun aux deux journaux et sera conçu **une fois** en 2.2 (archivage §4.5), puis appliqué aux deux. Inclure l'auth ici dupliquerait ce socle. Reporté explicitement, sans régression (le rate-limit strict 1.4 reste la compensation provisoire).

### D8 — Dettes 1.3/1.4 traitées : `last_used_at` (écrit) + purge sessions (job répétable)

- **`last_used_at`** (colonne présente depuis 1.3, jamais écrite) : **décision — l'écrire**, depuis la fonction `SECURITY DEFINER` `authenticate_api_key` (seule exécutée avant le contexte tenant, donc seul endroit possible sans casser la RLS). Un `UPDATE api_keys SET last_used_at = now()` sur la clé résolue, dans la fonction. Coût négligeable, valeur opérationnelle réelle (détection de clés dormantes, futur affichage dashboard). Alternative (retirer la colonne) écartée : l'info est utile et la colonne existe déjà.
- **Purge des sessions expirées** (différée en 1.4) : maintenant qu'on a BullMQ, un **job répétable** (`repeat: { every: … }`) sur une file `maintenance` supprime périodiquement les sessions dont `expires_at < now()`, via une fonction `SECURITY DEFINER` `purge_expired_sessions()` (les sessions sont en `FORCE`/deny-all pour `factelec_app` — accès uniquement par fonction SD, comme 1.4). Le worker porte ce job. Empêche l'enflure de la table `sessions`.

---

## Versions & dépendances à pinner (registre npm vérifié le 2026-07-14)

> Versions relevées via `npm view <pkg> version|license` le 2026-07-14. Toutes pinnées **exactes**. ⚠ = revérifier au moment du `pnpm add` (cadence rapide).

**Ajouts `apps/api` — `dependencies`**

| Paquet | Version | Licence | Rôle |
|---|---|---|---|
| `bullmq` | `5.80.2` | MIT | Files/jobs Redis (génération asynchrone, jobs répétables de maintenance). Embarque `ioredis@5.10.1` (transitive, non déclarée). `engines.node >= 12.22` (OK, ≥ 22). |
| `@nestjs/bullmq` | `11.0.4` | MIT | Intégration NestJS de BullMQ (`BullModule`, `@Processor`, `WorkerHost`, `InjectQueue`). Peers : `@nestjs/common`/`@nestjs/core` `^11` (OK, 11.1.28) ; `bullmq` `^5` (OK). Tire `@nestjs/bull-shared@^11.0.4` + `tslib@2.8.1` (transitives). |

**Ajouts `apps/api` — `devDependencies`**

| Paquet | Version | Licence | Rôle |
|---|---|---|---|
| `@testcontainers/redis` | `12.0.4` | MIT | Conteneur Redis réel pour les e2e workers/purge (aligné sur `@testcontainers/postgresql@12.0.4` déjà présent). |

> **`ioredis` volontairement NON déclaré** (D3) : BullMQ possède son client ; la connexion se configure par options, la readiness ping via `queue.client`. **Aucun nouvel `override`** attendu : `ioredis@5.10.1` (transitive de bullmq) n'est pas signalé par `pnpm outdated -r` (seules les deps directes le sont), et n'est pas concerné par les overrides existants (`esbuild`, `postcss`). Si `pnpm audit` remonte une vuln transitive (ioredis/bullmq), appliquer la politique D7 socle : override si patch dispo, sinon documenter + arbitrer. Les overrides existants (`@esbuild-kit/core-utils>esbuild`, `postcss@8.5.19`) et `updateConfig.ignoreDependencies:["typescript"]` restent inchangés.

---

## Points de risque signalés d'emblée

1. **Changement de contrat `POST /invoices` (synchrone→asynchrone, D1).** `status: 'generated'` → `'received'`. Impact : `ingestion.e2e.test.ts` (asserte `generated` + 5 formats immédiats) **doit** évoluer. **Traité** : Task 2 met à jour l'e2e (`received`, pas de formats synchrones, 409 préservé) ; Task 3 ajoute le flux complet asynchrone (poll jusqu'à `generated`). Le README/OpenAPI documentent la nouvelle sémantique.
2. **Double-consommation des jobs (D2).** Si `AppModule` importait le `@Processor`, le process API consommerait la file. **Traité** : `@Processor` isolé dans `WorkerModule`, importé **uniquement** par `worker-main.ts`. Un test vérifie que l'API seule n'a **pas** de worker (le job reste `waiting` sans worker).
3. **Worker en e2e (Redis + Postgres réels).** Le flux asynchrone exige un worker **vivant** consommant la file pendant le test. **Traité** : helper `createTestWorker` bootant le processor en-process contre le Redis Testcontainers, arrêté au teardown ; polling borné (`waitFor` avec timeout) au lieu de `sleep` fixe. Respect strict de `listenOnce`/timeouts.
4. **Perte silencieuse sur échec de génération (D4).** Un job qui échoue définitivement ne doit pas laisser la facture en `received` éternel. **Traité** : passage à `failed` après épuisement des retries, facture consultable, e2e dédié (injection d'un canonical corrompu / stub de génération qui throw).
5. **Nomenclature CDV inexacte (D5).** Coder des statuts/codes de mémoire = non conforme. **Traité** : extraction VERBATIM depuis Annexe 2 (feuilles « Statuts » et « CDV FE - CI ARM »), Annexe 7, Dossier général ; tableau de nomenclature tracé cellule par cellule ; machine à états dérivée de ces règles. Voir Task 4.
6. **Immuabilité du journal (D5).** Un journal d'audit modifiable n'a aucune valeur probante. **Traité** : grants `SELECT`+`INSERT` seulement sur `invoice_status_events` (pas d'`UPDATE`/`DELETE`) → immuabilité par la base, vérifiée en e2e (`42501`).
7. **`pnpm audit`/`outdated` sous BullMQ.** Surface transitive (ioredis, msgpackr, etc.). **Traité** : politique override→arbitrage documentée (D7 socle) ; versions pinnées dernière stable ce jour ; jamais de merge avec vuln exploitable.
8. **Testcontainers Redis en CI.** Le runner GitHub a Docker natif (déjà utilisé pour Postgres). Redis démarre vite (< 2 s) : la contention est bien moindre que Postgres, mais on applique les **mêmes** timeouts prudents et `maxWorkers: 5`. Aucune image Java/JVM (contrairement à veraPDF) — CI standard.
9. **`createApplicationContext` et hooks d'arrêt.** Le worker doit fermer proprement la file + le pool Postgres à l'arrêt (SIGTERM/SIGINT) pour ne pas laisser de jobs en cours ni de connexions fuites. **Traité** : `enableShutdownHooks()` sur le contexte + `OnModuleDestroy` fermant la `Queue`/`Worker` (déjà géré par `@nestjs/bullmq`) et le pool (déjà géré par `DbModule`).

---

## Structure des fichiers (vue d'ensemble)

Ajouts/modifs `apps/api/` :

```
apps/api/
  docker-compose.yml                    # + service redis (dev)
  package.json                          # + bullmq, @nestjs/bullmq, @testcontainers/redis ; scripts start:worker, worker:dev
  src/
    config/env.ts                       # + REDIS_HOST/PORT/DB/PASSWORD/TLS, GENERATION_JOB_ATTEMPTS, SESSION_PURGE_EVERY_MS
    queue/
      queue.constants.ts                # noms de files (INVOICE_GENERATION_QUEUE, MAINTENANCE_QUEUE)
      redis-connection.module.ts        # token REDIS_CONNECTION (ConnectionOptions BullMQ, lazyConnect), global + overridable en test
      queue.module.ts                   # BullModule.forRootAsync (connexion env) + registerQueue(Async) (producteur, importé par l'API)
      invoice-generation.queue.ts       # InvoiceGenerationQueue.enqueue(tenantId, invoiceId) (port d'enfilement, @InjectQueue)
      invoice-generation.job.ts         # payload { tenantId, invoiceId } + GENERATE_JOB
      maintenance.job.ts                # PURGE_SESSIONS_JOB (Task 7)
    worker/
      worker.module.ts                  # WorkerModule : QueueModule + processors (importé UNIQUEMENT par worker-main)
      invoice-generation.processor.ts   # @Processor : recharge canonical, génère, persiste, statut (idempotent, retries)
      maintenance.processor.ts          # @Processor maintenance : purge sessions expirées (Task 7)
      session-maintenance.service.ts    # purgeExpiredSessions() via fonction SD (Task 7)
      maintenance.scheduler.ts          # upsertJobScheduler du job répétable au bootstrap (Task 7)
    worker-main.ts                      # point d'entrée worker (createApplicationContext(WorkerModule), shutdown hooks)
    invoices/
      format-generator.port.ts          # inchangé (contrat de génération pure)
      format-generation.service.ts      # ex-SynchronousFormatGenerator (renommé, même code, utilisé par le processor)
      synchronous-format-generator.ts   # SUPPRIMÉ (relocalisé)
      invoices.service.ts               # ingest : persiste 'received' + enqueue ; expose lifecycle_status ; +transition
      invoices.repository.ts            # insertReceived / saveFormats / markGenerationStatus / loadCanonical ; +lifecycle
      invoices.controller.ts            # + POST /invoices/:id/status, GET /invoices/:id/status
      invoices.module.ts                # importe QueueModule ; provide LifecycleService (FormatGenerationService → worker)
      lifecycle-status.ts               # machine à états PURE (nomenclature CDV, transitions)
      lifecycle.service.ts              # transition(...) + history(...) (RLS, validation machine à états)
    db/
      schema.ts                         # + invoice_status 'generating' ; + invoices.lifecycleStatus ; enum lifecycle ; + invoiceStatusEvents
      migrations/
        0004_generation_status.sql             # (drizzle) ALTER TYPE invoice_status ADD VALUE 'generating'         (Task 2)
        0005_invoice_lifecycle.sql             # (drizzle) enum lifecycle, colonne lifecycle_status, table status_events (Task 5)
        0006_lifecycle_rls.sql                 # (hand) RLS + grants SELECT/INSERT immuables sur status_events        (Task 5)
        0007_last_used_and_purge.sql           # (hand) last_used_at dans authenticate_api_key + purge_expired_sessions() (Task 7)
        meta/_journal.json                       # + 0004..0007 (0006/0007 ajoutés manuellement comme 0001/0003)
    health/
      health.controller.ts              # + check Redis (ping via queue.client, inline comme le check DB)
      health.module.ts                  # + import QueueModule
  tests/
    e2e/
      helpers/redis.ts                  # startTestRedis() (RedisContainer, timeouts alignés)
      helpers/worker.ts                 # createTestWorker(...) : boote le processor contre le Redis de test
      helpers/seed-invoice.ts           # seedGeneratedInvoice(...) : facture complète en base (tests de lecture, sans Redis)
      helpers/postgres.ts               # (inchangé) — migrations couvrent 0004..0007 automatiquement
      async-generation.e2e.test.ts      # ingest → worker → generated ; échec → failed ; idempotence rejeu
      queue-readiness.e2e.test.ts       # /health/ready avec Redis up/down ; API seule n'a pas de worker
      lifecycle.e2e.test.ts             # transitions valides/invalides, historique, RLS/immuabilité, rôles
      session-purge.e2e.test.ts         # job de purge supprime les sessions expirées
      api-key-last-used.e2e.test.ts     # authenticate_api_key écrit last_used_at
      ingestion.e2e.test.ts             # MODIFIÉ : status 'received', pas de formats synchrones
    unit/
      lifecycle-status.test.ts          # machine à états pure (transitions, terminaux)
      invoice-generation.queue.test.ts  # enqueue appelle queue.add avec jobId=invoiceId, payload minimal
      invoices.service.test.ts          # MODIFIÉ : ingest enfile + persiste 'received'
```

Fichiers hors `apps/api` :
- `.github/workflows/ci.yml` — inchangé sur le principe (Docker natif du runner couvre Redis via Testcontainers) ; commentaire mis à jour (Postgres **+ Redis**).
- `README.md` racine + `apps/api/README.md` — workers, ingestion asynchrone, statuts CDV, Redis, `start:worker`, compteurs de tests, différés mis à jour.
- `pnpm-lock.yaml` — nouvelles deps.

---

## Nomenclature CDV faisant foi (extraite des sources primaires — pour Tasks 4-6)

> **Source** : `docs/reglementaire/.../0- Dossier de specifications externes FE - Dossier général_v3.2.pdf` **§3.6.4, Tableau 8 « Les statuts d'une facture » (p. 58-59)** — libellés & « Caractère » VERBATIM ; recoupé avec `.../2- Annexes_v3.2/20260430_Annexe 2 - ... CDV - Flux 6 - V2.3.xlsx` (onglet « Statuts », col. B/C = les 4 obligatoires) et `Annexe 7 - Règles de gestion - V1.9` (règle **G7.44** = liste du socle obligatoire, verbatim). Le statut est porté par le champ **MDT-105 `ram:ProcessConditionCode`** (CODE longueur 3). **Aucune énumération XSD** ne contraint ces codes (CODE(3) libre validé par règles de gestion).

**14 statuts du cycle de vie de la facture** (identifiant de code interne = slug ; code réglementaire = numéro ; `obligatoire` = socle G7.44) :

| Code | Slug (identifiant TS) | Libellé (verbatim) | Caractère | Acteur qui appose |
|---|---|---|---|---|
| 200 | `deposee` | Déposée | **Obligatoire** | PAE |
| 201 | `emise` | Emise par la plateforme | Facultatif | PAE |
| 202 | `recue` | Reçue par la plateforme | Facultatif | PAR |
| 203 | `mise_a_disposition` | Mise à disposition | Facultatif | PAR |
| 204 | `prise_en_charge` | Prise en charge | Facultatif | Destinataire |
| 205 | `approuvee` | Approuvée | Facultatif | Destinataire |
| 206 | `approuvee_partiellement` | Approuvée partiellement | Facultatif | Destinataire |
| 207 | `en_litige` | En litige | Facultatif | Destinataire |
| 208 | `suspendue` | Suspendue | Facultatif | Destinataire |
| 209 | `completee` | Complétée | Facultatif | Fournisseur |
| 210 | `refusee` | Refusée | **Obligatoire** | Destinataire |
| 211 | `paiement_transmis` | Paiement transmis | Facultatif | Destinataire ou Fournisseur |
| 212 | `encaissee` | Encaissée | **Obligatoire** | Fournisseur |
| 213 | `rejetee` | Rejetée | **Obligatoire** | PAE/PAR (contrôle) |

**Règles de gestion exploitables (Annexe 7)** : **G7.44** — socle obligatoire = {200, 210, 212, 213}, un CDV transmis au PPF référençant un statut non obligatoire est rejeté ; **G7.25** — statuts 210 (Refusée) et 208 (Suspendue) ⇒ **commentaire de motif obligatoire** (MDT-126) ; **G7.45** — statut 212 (Encaissée) ⇒ montant réparti par taux de TVA ; **G7.19** — le PPF rejette pour « incohérence des statuts du CDV » (REJ_INC) ou « statut inexistant » (REJ_INEX).

**⚠ Caveat inscrit dans la source** : le Dossier se déclare lui-même « liste **non exhaustive**, voir norme **AFNOR XP Z12-012** » (norme **absente du dépôt**). Les 14 codes du Tableau 8 sont l'exhaustif **disponible**. Surtout : **aucune matrice de transitions autorisées n'est énumérée** dans les documents fournis (les « Figures 48/49 – cycle de vie nominal » sont des **images non extractibles** ; le PDF `circuit-de-transmission-...` est purement graphique). Conséquence pour Task 4 (impérative) : la machine à états encode une **chronologie nominale interprétée** (ordre croissant des codes + statuts terminaux 210/213 + règles G7.19/G7.25/G7.45), explicitement **marquée comme interprétation projet** à re-vérifier contre AFNOR XP Z12-012 avant production — **on N'INVENTE PAS** de règle DGFiP non écrite, on documente l'hypothèse.

---
### Task 1 : Infrastructure Redis + BullMQ + sonde de readiness

**Files:**
- Modify: `apps/api/package.json` (dépendances + scripts worker)
- Modify: `apps/api/src/config/env.ts` (variables Redis + job)
- Modify: `apps/api/tests/unit/env.test.ts` (cas Redis)
- Create: `apps/api/src/queue/queue.constants.ts`
- Create: `apps/api/src/queue/redis-connection.module.ts`
- Create: `apps/api/src/queue/queue.module.ts`
- Modify: `apps/api/src/health/health.controller.ts` (check Redis) + `apps/api/src/health/health.module.ts` (import QueueModule)
- Modify: `apps/api/src/app.module.ts` (import QueueModule)
- Modify: `apps/api/tests/e2e/helpers/app.ts` (override de la connexion Redis en test)
- Create: `apps/api/tests/e2e/helpers/redis.ts` (`startTestRedis`)
- Modify: `apps/api/docker-compose.yml` (service redis)
- Create: `apps/api/tests/e2e/queue-readiness.e2e.test.ts`

**Interfaces:**
- Consumes: `ConfigService<EnvConfig, true>` (1.3), `HealthCheckService` (terminus, 1.3), motif d'override de provider en test (`createTestApp`, 1.4).
- Produces (utilisé par Tasks 2-3-7) :
  - `queue.constants.ts` : `INVOICE_GENERATION_QUEUE = 'invoice-generation'`, `MAINTENANCE_QUEUE = 'maintenance'`.
  - `redis-connection.module.ts` : token `REDIS_CONNECTION` (Symbol) fournissant un `ConnectionOptions` BullMQ, **global** et **overridable en test**.
  - `queue.module.ts` : `QueueModule` — `BullModule.forRootAsync` (connexion via `REDIS_CONNECTION`) + `registerQueue` des deux files ; exporte `BullModule` (pour `@InjectQueue`).
  - `env.ts` : `REDIS_HOST/REDIS_PORT/REDIS_DB/REDIS_PASSWORD/REDIS_TLS`, `GENERATION_JOB_ATTEMPTS`, `SESSION_PURGE_EVERY_MS`.
  - `startTestRedis(): Promise<{ host, port, stop() }>`.

- [ ] **Step 1 : Ajouter les dépendances (dernière stable, pinnées exactes)**

```bash
cd apps/api
pnpm add bullmq@5.80.2 @nestjs/bullmq@11.0.4
pnpm add -D @testcontainers/redis@12.0.4
cd ../.. && pnpm install
pnpm approve-builds   # si demandé : autoriser les build scripts natifs éventuels (cf. note 1.3 @swc/@node-rs)
```
Vérifier que `apps/api/package.json` porte bien `"bullmq": "5.80.2"`, `"@nestjs/bullmq": "11.0.4"` en `dependencies` et `"@testcontainers/redis": "12.0.4"` en `devDependencies` (pas de `^`). Ajouter les scripts worker dans `apps/api/package.json` :
```jsonc
    "start:worker": "node dist/worker-main.js",
    "worker:dev": "node --import tsx --watch src/worker-main.ts",
```
Run: `pnpm audit && pnpm outdated -r`
Expected: `audit` 0 vulnérabilité ; `outdated` vierge (bullmq/@nestjs/bullmq/@testcontainers/redis à la dernière stable). Si une vuln transitive apparaît → politique D7 (override si patch, sinon arbitrage). `ioredis` (transitive de bullmq) n'est **pas** listé par `outdated` (dep indirecte).

- [ ] **Step 2 : Étendre l'environnement (RED)**

Ajouter à `apps/api/tests/unit/env.test.ts` (à la suite des cas existants) :
```ts
  it('applies Redis defaults and coerces port', () => {
    const env = validateEnv({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    })
    expect(env.REDIS_HOST).toBe('localhost')
    expect(env.REDIS_PORT).toBe(6379)
    expect(env.REDIS_DB).toBe(0)
    expect(env.REDIS_TLS).toBe(false)
    expect(env.GENERATION_JOB_ATTEMPTS).toBe(3)
  })

  it('parses REDIS_TLS strictly (only "true"/"1" enable TLS)', () => {
    const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' }
    expect(validateEnv({ ...base, REDIS_TLS: 'true' }).REDIS_TLS).toBe(true)
    expect(validateEnv({ ...base, REDIS_TLS: '1' }).REDIS_TLS).toBe(true)
    // Piège z.coerce.boolean (toute chaîne non vide → true) NEUTRALISÉ :
    expect(validateEnv({ ...base, REDIS_TLS: 'false' }).REDIS_TLS).toBe(false)
    expect(validateEnv({ ...base, REDIS_TLS: 'no' }).REDIS_TLS).toBe(false)
  })

  it('rejects a non-numeric REDIS_PORT', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        REDIS_PORT: 'abc',
      }),
    ).toThrow(/REDIS_PORT/)
  })
```
Run: `pnpm --filter @factelec/api test -- env`
Expected: FAIL (clés Redis inconnues → `undefined`).

- [ ] **Step 3 : Implémenter les variables d'env**

Dans `apps/api/src/config/env.ts`, ajouter à l'objet `envSchema` (après `SESSION_COOKIE_DOMAIN`) :
```ts
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
  GENERATION_JOB_ATTEMPTS: z.coerce.number().int().positive().max(10).default(3),
  // Périodicité de la purge des sessions expirées (job répétable, Task 7).
  SESSION_PURGE_EVERY_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(3_600_000),
```
Run: `pnpm --filter @factelec/api test -- env`
Expected: PASS.

- [ ] **Step 4 : Files & connexion Redis**

`apps/api/src/queue/queue.constants.ts` :
```ts
// Noms des files BullMQ (partagés producteur ↔ worker).
export const INVOICE_GENERATION_QUEUE = 'invoice-generation'
export const MAINTENANCE_QUEUE = 'maintenance'
```

`apps/api/src/queue/redis-connection.module.ts` :
```ts
import type { ConnectionOptions } from 'bullmq'
import { ConfigService } from '@nestjs/config'
import { Global, Module } from '@nestjs/common'
import type { EnvConfig } from '../config/env.js'

// Token de la connexion Redis (ConnectionOptions BullMQ). GLOBAL et fourni par
// factory depuis l'env validé, pour être OVERRIDABLE en test (Testcontainers
// Redis à port dynamique) — même stratégie que l'override du provider APP_POOL
// en 1.4 (le port du conteneur n'est pas connu au chargement eager du Config).
export const REDIS_CONNECTION = Symbol('REDIS_CONNECTION')

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CONNECTION,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvConfig, true>): ConnectionOptions => ({
        host: config.get('REDIS_HOST', { infer: true }),
        port: config.get('REDIS_PORT', { infer: true }),
        db: config.get('REDIS_DB', { infer: true }),
        password: config.get('REDIS_PASSWORD', { infer: true }),
        tls: config.get('REDIS_TLS', { infer: true }) ? {} : undefined,
        // lazyConnect : ne PAS ouvrir la connexion tant qu'aucune commande
        // n'est émise. CRITIQUE pour les tests : dès que QueueModule entre dans
        // AppModule, TOUT test qui monte l'app instancie les files — sans
        // lazyConnect, BullMQ tenterait de joindre un Redis inexistant (retries
        // + erreurs). Avec lazyConnect, seuls les tests qui enfilent/pingent
        // (readiness, ingestion, worker) ouvrent réellement une connexion ; les
        // autres (auth, admin, api-keys, lecture par seed direct) n'y touchent
        // jamais. En prod, la 1re commande (enfilement/ping) connecte — inerte.
        lazyConnect: true,
      }),
    },
  ],
  exports: [REDIS_CONNECTION],
})
export class RedisConnectionModule {}
```

`apps/api/src/queue/queue.module.ts` :
```ts
import type { ConnectionOptions } from 'bullmq'
import { BullModule } from '@nestjs/bullmq'
import { Module } from '@nestjs/common'
import {
  INVOICE_GENERATION_QUEUE,
  MAINTENANCE_QUEUE,
} from './queue.constants.js'
import { RedisConnectionModule, REDIS_CONNECTION } from './redis-connection.module.js'

// Côté PRODUCTEUR : connexion partagée + files enregistrées. Importé par l'API
// (enfilement via @InjectQueue) ET par le WorkerModule (consommation). NE
// FOURNIT AUCUN @Processor → l'importer seul ne fait tourner aucun worker.
@Module({
  imports: [
    RedisConnectionModule,
    BullModule.forRootAsync({
      inject: [REDIS_CONNECTION],
      useFactory: (connection: ConnectionOptions) => ({ connection }),
    }),
    BullModule.registerQueue(
      { name: INVOICE_GENERATION_QUEUE },
      { name: MAINTENANCE_QUEUE },
    ),
  ],
  exports: [BullModule],
})
export class QueueModule {}
```

- [ ] **Step 5 : Sonde de readiness Redis + câblage modules**

`apps/api/src/health/health.controller.ts` — injecter la file de génération et ajouter un check Redis (miroir du check DB) :
```ts
import { Controller, Get, Inject } from '@nestjs/common'
import { InjectQueue } from '@nestjs/bullmq'
import type { Queue } from 'bullmq'
// biome-ignore lint/style/useImportType: HealthCheckService résolu par Nest via design:paramtypes.
import { HealthCheck, HealthCheckService } from '@nestjs/terminus'
import { SkipThrottle } from '@nestjs/throttler'
import type pg from 'pg'
import { APP_POOL } from '../db/client.js'
import { INVOICE_GENERATION_QUEUE } from '../queue/queue.constants.js'

@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    @Inject(APP_POOL) private readonly pool: pg.Pool,
    @InjectQueue(INVOICE_GENERATION_QUEUE) private readonly queue: Queue,
  ) {}

  @Get()
  liveness(): { status: 'ok' } {
    return { status: 'ok' }
  }

  @Get('ready')
  @HealthCheck()
  readiness() {
    return this.health.check([
      async () => {
        await this.pool.query('SELECT 1')
        return { database: { status: 'up' } }
      },
      async () => {
        // queue.client est une Promise<RedisClient> (ioredis interne de
        // BullMQ) ; ping échoue → terminus marque `redis` down → 503.
        const client = await this.queue.client
        const pong = await client.ping()
        if (pong !== 'PONG') throw new Error('unexpected redis ping response')
        return { redis: { status: 'up' } }
      },
    ])
  }
}
```
`apps/api/src/health/health.module.ts` :
```ts
import { Module } from '@nestjs/common'
import { TerminusModule } from '@nestjs/terminus'
import { QueueModule } from '../queue/queue.module.js'
import { HealthController } from './health.controller.js'

@Module({
  imports: [TerminusModule, QueueModule],
  controllers: [HealthController],
})
export class HealthModule {}
```
`apps/api/src/app.module.ts` — ajouter `QueueModule` à `imports` (après `DbModule`) : l'API dispose ainsi du producteur pour Task 2.

- [ ] **Step 6 : Helper Redis de test + override de connexion**

`apps/api/tests/e2e/helpers/redis.ts` :
```ts
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'

export interface TestRedis {
  container: StartedRedisContainer
  host: string
  port: number
  stop(): Promise<void>
}

export async function startTestRedis(): Promise<TestRedis> {
  // Timeout aligné sur Postgres (helpers/postgres.ts) : absorbe la lenteur de
  // démarrage sous forte charge Docker concurrente (maxWorkers 5).
  const container = await new RedisContainer('redis:7-alpine')
    .withStartupTimeout(120_000)
    .start()
  return {
    container,
    host: container.getHost(),
    port: container.getFirstMappedPort(),
    stop: () => container.stop().then(() => undefined),
  }
}
```
`apps/api/tests/e2e/helpers/app.ts` — étendre `createTestApp` pour pointer BullMQ sur le Redis de test en overridant `REDIS_CONNECTION` :
```ts
import { REDIS_CONNECTION } from '../../../src/queue/redis-connection.module.js'
// ...
export async function createTestApp(
  appUrl: string,
  redis?: { host: string; port: number },
): Promise<INestApplication> {
  process.env.DATABASE_URL = appUrl
  process.env.LOG_LEVEL = 'silent'
  const builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_POOL)
    .useFactory({ factory: () => createPool(appUrl) })
  if (redis) {
    builder.overrideProvider(REDIS_CONNECTION).useValue({
      host: redis.host,
      port: redis.port,
      lazyConnect: true,
    })
  }
  const moduleRef = await builder.compile()
  const app = moduleRef.createNestApplication({ bufferLogs: true })
  app.use(helmet())
  app.use(cookieParser())
  app.useGlobalFilters(new ProblemDetailsFilter())
  app.enableShutdownHooks()
  await app.init()
  await listenOnce(app)
  return app
}
```
> **Note d'exécution (⚠ à valider au premier run)** : `overrideProvider(REDIS_CONNECTION)` doit se propager dans la factory de `BullModule.forRootAsync` (injection par token, container-wide). C'est le comportement attendu de Nest (override par token dans le container compilé, `REDIS_CONNECTION` étant `@Global()`). Si — contre attente — l'override ne se propageait pas, repli documenté : exposer une `QueueModule.forRoot(connection)` statique et l'injecter en test. À trancher empiriquement au Step 7.

- [ ] **Step 7 : e2e readiness (RED→GREEN) + docker-compose + commit**

`apps/api/docker-compose.yml` — ajouter le service Redis (dev) :
```yaml
  redis:
    image: redis:7-alpine
    ports:
      - '6379:6379'
```
`apps/api/tests/e2e/queue-readiness.e2e.test.ts` :
```ts
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { startTestRedis, type TestRedis } from './helpers/redis.js'

describe('/health/ready with Redis (e2e)', () => {
  let db: TestDb
  let redis: TestRedis
  let app: INestApplication

  beforeAll(async () => {
    ;[db, redis] = await Promise.all([startTestDb(), startTestRedis()])
    app = await createTestApp(db.appUrl, { host: redis.host, port: redis.port })
  })
  afterAll(async () => {
    await app.close()
    await Promise.all([db.stop(), redis.stop()])
  })

  it('reports database AND redis up', async () => {
    const res = await request(app.getHttpServer()).get('/health/ready').expect(200)
    expect(res.body.status).toBe('ok')
    expect(res.body.info.database.status).toBe('up')
    expect(res.body.info.redis.status).toBe('up')
  })

  it('liveness stays trivial (no dependency)', async () => {
    await request(app.getHttpServer()).get('/health').expect(200)
  })
})
```
Run: `pnpm --filter @factelec/api test -- queue-readiness`
Expected: PASS (Postgres + Redis réels ; readiness voit les deux `up`).

**Mettre à jour `apps/api/tests/e2e/health.e2e.test.ts`** (readiness inclut désormais Redis) : démarrer un Redis de test et le passer à `createTestApp`, sinon `/health/ready` renvoie 503 (ping Redis en échec). Ajouter `import { startTestRedis, type TestRedis } from './helpers/redis.js'`, un `redis` au `beforeAll` (`;[db, redis] = await Promise.all([startTestDb(), startTestRedis()])`), `app = await createTestApp(db.appUrl, { host: redis.host, port: redis.port })`, l'arrêt du conteneur au `afterAll`, et l'assertion `res.body.info.redis.status === 'up'` sur le test readiness existant. **Les autres tests full-app (`auth`, `admin`, `api-keys`, `users-auth`, `auth-rate-limit`, `admin-rate-limit`, `rate-limit`, `cors`, `security-headers`, `tenant-context`) restent inchangés** : ils montent l'app mais ne pingent pas Redis et n'enfilent rien → grâce à `lazyConnect`, aucune connexion Redis n'est ouverte (aucune dépendance de conteneur ajoutée).

Puis gate complète + commit :
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): infrastructure Redis/BullMQ et sonde de readiness Redis"
```
Expected: PASS, couverture apps/api ≥ 90 % (modules = câblage exclu ; readiness Redis couvert par l'e2e).

---
### Task 2 : Génération asynchrone — statut `received`, enfilement, relocalisation de la génération

**Files:**
- Rename: `apps/api/src/invoices/synchronous-format-generator.ts` → `apps/api/src/invoices/format-generation.service.ts` (classe `FormatGenerationService`)
- Rename: `apps/api/tests/unit/format-generator.test.ts` (import + nom de classe mis à jour)
- Create: `apps/api/src/queue/invoice-generation.job.ts`
- Create: `apps/api/src/queue/invoice-generation.queue.ts`
- Create: `apps/api/tests/unit/invoice-generation.queue.test.ts`
- Modify: `apps/api/src/db/schema.ts` (enum `invoice_status` + `'generating'`)
- Create: `apps/api/src/db/migrations/0004_generation_status.sql` (drizzle) + `meta/_journal.json`
- Modify: `apps/api/src/invoices/invoices.repository.ts` (`persist` → `insertReceived` + `saveFormats` + `markGenerationStatus`)
- Modify: `apps/api/src/invoices/invoices.service.ts` (ingest asynchrone)
- Modify: `apps/api/tests/unit/invoices.service.test.ts` (mock queue au lieu de generator)
- Modify: `apps/api/src/invoices/invoices.module.ts` (importe QueueModule ; retire le provider generator)
- Create: `apps/api/tests/e2e/helpers/seed-invoice.ts` (`seedGeneratedInvoice` — seed direct sans Redis)
- Modify: `apps/api/tests/e2e/{read,invoices-session-read,tenant-isolation}.e2e.test.ts` (seed direct au lieu de POST HTTP)
- Modify: `apps/api/tests/e2e/ingestion.e2e.test.ts` (status `received`, Redis réel, pas de formats synchrones)

**Interfaces:**
- Consumes: `QueueModule` (Task 1), `InvoicesRepository`, `INVOICE_FORMAT_GENERATOR`/`InvoiceFormatGenerator` (port inchangé).
- Produces (utilisé par Task 3 et les tests) :
  - `invoice-generation.job.ts` : `GENERATE_JOB = 'generate'` ; `interface InvoiceGenerationJob { tenantId: string; invoiceId: string }`.
  - `invoice-generation.queue.ts` : `InvoiceGenerationQueue.enqueue(tenantId, invoiceId): Promise<void>` (jobId = invoiceId, payload minimal).
  - `FormatGenerationService.generate(invoice): Promise<GeneratedFormat[]>` (ex-`SynchronousFormatGenerator`, code identique).
  - `InvoicesRepository.insertReceived` / `saveFormats` (delete+insert, rejeu sûr) / `markGenerationStatus` ; type `GenerationStatus`.
  - `InvoicesService.ingest(...)` renvoie `{ id, status: 'received' }`.
  - `seedGeneratedInvoice(pool, tenantId, input): Promise<string>` (helper de test : facture complète en base, sans file).

- [ ] **Step 1 : Relocaliser la génération (rename, refactor pur)**

`git mv apps/api/src/invoices/synchronous-format-generator.ts apps/api/src/invoices/format-generation.service.ts`. Dans le fichier, renommer la classe `SynchronousFormatGenerator` → `FormatGenerationService` (contenu **identique** : `@Injectable()`, `implements InvoiceFormatGenerator`, même corps `generate`). `git mv apps/api/tests/unit/format-generator.test.ts` inchangé de nom mais mettre à jour l'import et les `new SynchronousFormatGenerator()` → `new FormatGenerationService()` (import depuis `../../src/invoices/format-generation.service.js`) ; le titre du `describe` devient `'FormatGenerationService'`.
Run: `pnpm --filter @factelec/api test -- format-generator`
Expected: PASS (comportement inchangé, juste renommé).

- [ ] **Step 2 : Port d'enfilement (RED→GREEN)**

`apps/api/tests/unit/invoice-generation.queue.test.ts` :
```ts
import { describe, expect, it, vi } from 'vitest'
import { InvoiceGenerationQueue } from '../../src/queue/invoice-generation.queue.js'
import { GENERATE_JOB } from '../../src/queue/invoice-generation.job.js'

describe('InvoiceGenerationQueue.enqueue', () => {
  it('adds a job with jobId = invoiceId and a minimal id-only payload', async () => {
    const add = vi.fn().mockResolvedValue(undefined)
    const q = new InvoiceGenerationQueue({ add } as never)
    await q.enqueue('tenant-1', 'invoice-9')
    expect(add).toHaveBeenCalledWith(
      GENERATE_JOB,
      { tenantId: 'tenant-1', invoiceId: 'invoice-9' },
      { jobId: 'invoice-9' },
    )
  })

  it('never puts invoice content in the payload (ids only)', async () => {
    const add = vi.fn().mockResolvedValue(undefined)
    await new InvoiceGenerationQueue({ add } as never).enqueue('t', 'i')
    const payload = add.mock.calls[0]?.[1] as Record<string, unknown>
    expect(Object.keys(payload).sort()).toEqual(['invoiceId', 'tenantId'])
  })
})
```
Run: `pnpm --filter @factelec/api test -- invoice-generation.queue` → FAIL (modules absents).

`apps/api/src/queue/invoice-generation.job.ts` :
```ts
export const GENERATE_JOB = 'generate'

// Payload MINIMAL : uniquement des identifiants internes (aucun contenu de
// facture, aucun secret) — le worker recharge le canonical depuis Postgres
// sous RLS. Contrainte sécurité : rien de sensible ne transite par Redis.
export interface InvoiceGenerationJob {
  tenantId: string
  invoiceId: string
}
```
`apps/api/src/queue/invoice-generation.queue.ts` :
```ts
import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import type { Queue } from 'bullmq'
import { GENERATE_JOB, type InvoiceGenerationJob } from './invoice-generation.job.js'
import { INVOICE_GENERATION_QUEUE } from './queue.constants.js'

// Port d'enfilement (producteur). Idempotence : jobId = invoiceId → BullMQ
// déduplique les ré-enfilements (at-least-once) tant que le job existe.
@Injectable()
export class InvoiceGenerationQueue {
  constructor(
    @InjectQueue(INVOICE_GENERATION_QUEUE)
    private readonly queue: Queue<InvoiceGenerationJob>,
  ) {}

  async enqueue(tenantId: string, invoiceId: string): Promise<void> {
    await this.queue.add(
      GENERATE_JOB,
      { tenantId, invoiceId },
      { jobId: invoiceId },
    )
  }
}
```
Ajouter `InvoiceGenerationQueue` aux `providers` **et** `exports` de `QueueModule` (Task 1) pour qu'il soit injectable dans `InvoicesModule`.
Run: `pnpm --filter @factelec/api test -- invoice-generation.queue` → PASS.

- [ ] **Step 3 : Statut de génération `generating` (schéma + migration)**

`apps/api/src/db/schema.ts` — étendre l'enum :
```ts
export const invoiceStatus = pgEnum('invoice_status', [
  'received',
  'generating',
  'generated',
  'failed',
])
```
```bash
cd apps/api && pnpm --filter @factelec/api db:generate   # → 0004_*.sql (ALTER TYPE ADD VALUE)
```
Renommer le fichier en `0004_generation_status.sql`. **Relire** : il doit contenir `ALTER TYPE "public"."invoice_status" ADD VALUE 'generating'` (drizzle le place après `'received'` ; ordre indifférent au comportement). Ajouter l'entrée `0004_generation_status` à `meta/_journal.json` (drizzle-kit le fait automatiquement pour une migration générée). PG 17 : `ADD VALUE` s'exécute dans la transaction du migrator sans usage de la valeur dans la même migration → OK.

- [ ] **Step 4 : Repository — `insertReceived` + `saveFormats` + `markGenerationStatus`**

Dans `apps/api/src/invoices/invoices.repository.ts`, **remplacer** `persist(...)` par `insertReceived(...)` et ajouter les deux méthodes d'écriture hors-bande (utilisées dès maintenant par le seed direct des tests de lecture, Step 6bis, et par le worker en Task 3). Imports : ajouter `invoiceStatus` depuis `../db/schema.js` ; `GeneratedFormat` reste importé.
```ts
export type GenerationStatus = (typeof invoiceStatus.enumValues)[number]

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
        })
        .returning({ id: invoices.id })
      if (!row) throw new Error('insert into invoices returned no row')
      return { id: row.id }
    })
  }

  // Rejeu sûr : delete puis insert dans UNE transaction tenant. La contrainte
  // unique(invoice_id, kind) interdit les doublons ; delete+insert fait qu'un
  // retry après crash partiel converge vers exactement le même état.
  async saveFormats(
    tenantId: string,
    invoiceId: string,
    formats: GeneratedFormat[],
  ): Promise<void> {
    await this.tenant.run(tenantId, async (db) => {
      await db.delete(invoiceFormats).where(eq(invoiceFormats.invoiceId, invoiceId))
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
```
Les méthodes de lecture (`findById`, `list`, `findFormat`, `listFormatKinds`) restent inchangées.

- [ ] **Step 5 : `InvoicesService.ingest` asynchrone (RED→GREEN)**

Remplacer les cas concernés de `apps/api/tests/unit/invoices.service.test.ts` — le service ne prend plus de générateur mais une file. Nouveau harnais + cas de succès/409 :
```ts
function fakeRepo() {
  return { insertReceived: vi.fn() }
}
function fakeQueue() {
  return { enqueue: vi.fn().mockResolvedValue(undefined) }
}
// ... (les cas validation zod / business-rule / rethrow restent, en passant
// `fakeQueue()` en 2e argument du constructeur à la place du générateur)

it('persists as received then enqueues, returning { id, status: received }', async () => {
  const invoice = { number: 'FA-1' }
  vi.mocked(parseInvoiceInput).mockReturnValue({} as never)
  vi.mocked(buildInvoice).mockReturnValue(invoice as never)
  vi.mocked(validateBusinessRules).mockReturnValue([])
  const repo = fakeRepo()
  repo.insertReceived.mockResolvedValue({ id: 'invoice-1' })
  const queue = fakeQueue()
  const service = new InvoicesService(repo as never, queue as never)

  const result = await service.ingest('tenant-1', { number: 'FA-1' })

  expect(repo.insertReceived).toHaveBeenCalledWith('tenant-1', invoice)
  expect(queue.enqueue).toHaveBeenCalledWith('tenant-1', 'invoice-1')
  expect(result).toEqual({ id: 'invoice-1', status: 'received' })
})

it('does NOT enqueue when insert fails with a duplicate (409)', async () => {
  vi.mocked(parseInvoiceInput).mockReturnValue({} as never)
  vi.mocked(buildInvoice).mockReturnValue({ number: 'FA-DUP' } as never)
  vi.mocked(validateBusinessRules).mockReturnValue([])
  const repo = fakeRepo()
  repo.insertReceived.mockRejectedValue({
    code: '23505',
    constraint: 'invoices_tenant_number_unique',
  })
  const queue = fakeQueue()
  const service = new InvoicesService(repo as never, queue as never)
  await expect(service.ingest('tenant-1', {})).rejects.toMatchObject(
    new ConflictException(
      expect.objectContaining({ status: 409, type: 'urn:factelec:problem:conflict' }),
    ),
  )
  expect(queue.enqueue).not.toHaveBeenCalled()
})
```
> Adapter les autres cas existants (`insertReceived` à la place de `persist` ; 2e arg constructeur = `fakeQueue()`). Les cas 23505-mauvaise-contrainte / cause-chain / non-unique restent valides sur `insertReceived`.

Modifier `apps/api/src/invoices/invoices.service.ts` :
```ts
// imports : retirer INVOICE_FORMAT_GENERATOR / InvoiceFormatGenerator ; ajouter :
// biome-ignore lint/style/useImportType: InvoiceGenerationQueue résolu par Nest via design:paramtypes.
import { InvoiceGenerationQueue } from '../queue/invoice-generation.queue.js'
// ...
@Injectable()
export class InvoicesService {
  constructor(
    private readonly repo: InvoicesRepository,
    private readonly queue: InvoiceGenerationQueue,
  ) {}

  async ingest(
    tenantId: string,
    payload: unknown,
  ): Promise<{ id: string; status: string }> {
    // 1) Validation structurelle (zod) → 422 (inchangé).
    // 2) Calcul canonique + règles EN 16931 → 422 (inchangé).
    // ... (blocs 1 et 2 identiques à l'existant) ...

    // 3) Persistance immédiate au statut `received` (idempotence 23505 → 409).
    let id: string
    try {
      ;({ id } = await this.repo.insertReceived(tenantId, invoice))
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException(
          problem(409, ProblemType.conflict, 'Invoice already exists', {
            detail: `An invoice with number "${invoice.number}" already exists for this tenant`,
          }),
        )
      }
      throw e
    }

    // 4) Enfilement de la génération (hors-bande). Payload minimal (ids only).
    // Si Redis est indisponible, l'appel échoue (500) mais la facture reste
    // persistée en `received` et re-traitable (réconciliation différée, notée
    // au reprise) ; la readiness Redis prévient ce cas en amont.
    await this.queue.enqueue(tenantId, id)
    return { id, status: 'received' }
  }
```
Run: `pnpm --filter @factelec/api test -- invoices.service` → PASS.

- [ ] **Step 6 : Câblage module**

`apps/api/src/invoices/invoices.module.ts` — importer `QueueModule`, retirer le provider `INVOICE_FORMAT_GENERATOR`/`SynchronousFormatGenerator` (déplacé au worker en Task 3) :
```ts
import { QueueModule } from '../queue/queue.module.js'
// ...
@Module({
  imports: [AuthModule, UsersModule, QueueModule],
  controllers: [InvoicesController],
  providers: [InvoicesService, InvoicesRepository, TenantAuthGuard],
})
export class InvoicesModule {}
```

- [ ] **Step 7 : Seed direct + migration des tests de lecture (sans Redis ni worker)**

Le passage à l'asynchrone casse les tests qui **postaient** des factures via HTTP puis lisaient leurs formats (`read.e2e`, `invoices-session-read.e2e`, `tenant-isolation.e2e`) : sans worker, la génération n'aboutit pas. Solution : ces tests **de lecture/isolation** ne testent pas le pipeline de génération → on les **découple** de l'enfilement en semant une facture **déjà générée directement en base** (sans HTTP, sans Redis). Grâce à `lazyConnect` (Task 1), l'app montée par ces tests n'ouvre alors **aucune** connexion Redis.

`apps/api/tests/e2e/helpers/seed-invoice.ts` :
```ts
import { buildInvoice, type InvoiceInput } from '@factelec/invoice-core'
import type pg from 'pg'
import { TenantContextService } from '../../../src/db/tenant-context.service.js'
import { FormatGenerationService } from '../../../src/invoices/format-generation.service.js'
import { InvoicesRepository } from '../../../src/invoices/invoices.repository.js'

// Sème une facture COMPLÈTE (formats + statut `generated`) directement en base,
// en réutilisant la vraie logique de génération — équivalent au worker, sans
// file ni HTTP. Pour les tests de LECTURE/ISOLATION qui ont besoin de factures
// prêtes sans exercer le pipeline asynchrone.
export async function seedGeneratedInvoice(
  pool: pg.Pool,
  tenantId: string,
  input: InvoiceInput,
): Promise<string> {
  const repo = new InvoicesRepository(new TenantContextService(pool as never))
  const invoice = buildInvoice(input)
  const { id } = await repo.insertReceived(tenantId, invoice)
  const formats = await new FormatGenerationService().generate(invoice)
  await repo.saveFormats(tenantId, id, formats)
  await repo.markGenerationStatus(tenantId, id, 'generated')
  return id
}
```
Migrer `read.e2e.test.ts`, `invoices-session-read.e2e.test.ts`, `tenant-isolation.e2e.test.ts` :
- **Remplacer** chaque séquence « `POST /invoices` (puis attente/lecture) » par un `await seedGeneratedInvoice(ownerPool, tenantId, input)` en `beforeAll` (le seed passe par le pool owner ou app selon le contexte RLS du test) — plus aucun `POST /invoices` HTTP dans ces fichiers de lecture.
- **Ne pas** passer de `redis` à `createTestApp` (l'app ne touche pas la file → `lazyConnect` évite toute connexion). Retirer tout import Redis éventuel.
- Les assertions de lecture (formats, `status: 'generated'`) restent valides (la facture semée est complète). Ajouter `lifecycleStatus: 'deposee'` si une assertion exacte de forme l'exige (voir aussi Task 6, A5).
- `tenant-isolation.e2e` : semer une facture par tenant via `seedGeneratedInvoice`, conserver les assertions d'isolation (404/0 ligne cross-tenant).
Run: `pnpm --filter @factelec/api test -- read invoices-session-read tenant-isolation` → PASS (aucun conteneur Redis requis).

- [ ] **Step 8 : e2e ingestion asynchrone (Redis réel) + gate + commit**

`apps/api/tests/e2e/ingestion.e2e.test.ts` — teste le **contrat d'ingestion** (pas la génération) : ajouter `startTestRedis` et `createTestApp(db.appUrl, { host: redis.host, port: redis.port })` (l'enfilement exige Redis) ; adapter le cas de succès :
```ts
  it('ingests a valid invoice → 201 received, no formats yet (async)', async () => {
    const res = await request(app.getHttpServer())
      .post('/invoices').set('Authorization', auth()).send(valid).expect(201)
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(res.body.status).toBe('received')
    const inv = await ownerPool.query('SELECT status FROM invoices WHERE id = $1', [res.body.id])
    expect(inv.rows[0].status).toBe('received')
    const n = await ownerPool.query(
      'SELECT count(*)::int AS n FROM invoice_formats WHERE invoice_id = $1', [res.body.id])
    expect(n.rows[0].n).toBe(0) // génération déférée au worker (aucun worker ici)
  })
```
Les cas 422 (validation, business-rule), 409 (idempotence), scoping per-tenant et « no CSRF on machine path » restent (succès = 201 `received`). Le `afterAll` ferme aussi le conteneur Redis.
Run: `pnpm --filter @factelec/api test -- ingestion` → PASS.

Gate + commit :
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): ingestion asynchrone (statut received + enfilement génération)"
```
Expected: PASS, couverture ≥ 90 % (`insertReceived`/`saveFormats`/`markGenerationStatus` couverts par le seed direct + ingestion ; les tests full-app non-ingérants restent sans Redis via `lazyConnect`).

---
### Task 3 : Processus worker + processor de génération (idempotent, retries/backoff)

**Files:**
- Modify: `apps/api/src/queue/queue.module.ts` (`registerQueueAsync` pour `invoice-generation` : `defaultJobOptions` depuis l'env)
- Modify: `apps/api/src/invoices/invoices.repository.ts` (`loadCanonical` — `saveFormats`/`markGenerationStatus` déjà en Task 2)
- Create: `apps/api/src/worker/invoice-generation.processor.ts`
- Create: `apps/api/src/worker/worker.module.ts`
- Create: `apps/api/src/worker-main.ts`
- Modify: `apps/api/vitest.config.ts` (exclure `src/worker-main.ts` de la couverture)
- Create: `apps/api/tests/e2e/helpers/worker.ts` (`createTestWorker`, `waitFor`)
- Create: `apps/api/tests/e2e/async-generation.e2e.test.ts`

**Interfaces:**
- Consumes: `InvoicesRepository`, `FormatGenerationService` (via `INVOICE_FORMAT_GENERATOR`), `QueueModule`, `DbModule`, `AppConfigModule`.
- Produces :
  - `InvoicesRepository.loadCanonical(tenantId, invoiceId): Promise<Invoice | null>` (`saveFormats`/`markGenerationStatus` livrés en Task 2).
  - `InvoiceGenerationProcessor` (`@Processor('invoice-generation')`) : recharge, génère, persiste, statut ; `failed` → `failed` après épuisement.
  - `WorkerModule` (importé **uniquement** par `worker-main.ts`).
  - `createTestWorker(appUrl, redis, opts?): Promise<INestApplicationContext>` ; `waitFor(fn, opts?): Promise<void>`.

- [ ] **Step 1 : Options de job centralisées (retries/backoff/rétention)**

`apps/api/src/queue/queue.module.ts` — remplacer l'enregistrement statique d'`invoice-generation` par un enregistrement asynchrone tirant `GENERATION_JOB_ATTEMPTS` de l'env (la file `maintenance` reste statique) :
```ts
import { ConfigService } from '@nestjs/config'
import type { EnvConfig } from '../config/env.js'
// ...
  imports: [
    RedisConnectionModule,
    BullModule.forRootAsync({
      inject: [REDIS_CONNECTION],
      useFactory: (connection: ConnectionOptions) => ({ connection }),
    }),
    BullModule.registerQueueAsync({
      name: INVOICE_GENERATION_QUEUE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvConfig, true>) => ({
        defaultJobOptions: {
          attempts: config.get('GENERATION_JOB_ATTEMPTS', { infer: true }),
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: { age: 86_400, count: 1000 },
          removeOnFail: { age: 604_800 },
        },
      }),
    }),
    BullModule.registerQueue({ name: MAINTENANCE_QUEUE }),
  ],
```
> `InvoiceGenerationQueue.enqueue` (Task 2) ne passe **que** `{ jobId }` : la politique de retry/rétention est une responsabilité de la file, pas de l'appelant. Aucun changement au test unitaire de la file.

- [ ] **Step 2 : Repository — chargement du canonical pour le worker**

`saveFormats` et `markGenerationStatus` existent déjà (Task 2). Ajouter la seule méthode de lecture nécessaire au worker à `apps/api/src/invoices/invoices.repository.ts` :
```ts
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
```

- [ ] **Step 3 : Processor de génération**

`apps/api/src/worker/invoice-generation.processor.ts` :
```ts
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject, Logger } from '@nestjs/common'
import type { Job } from 'bullmq'
import {
  INVOICE_FORMAT_GENERATOR,
  type InvoiceFormatGenerator,
} from '../invoices/format-generator.port.js'
// biome-ignore lint/style/useImportType: InvoicesRepository résolu par Nest via design:paramtypes.
import { InvoicesRepository } from '../invoices/invoices.repository.js'
import type { InvoiceGenerationJob } from '../queue/invoice-generation.job.js'
import { INVOICE_GENERATION_QUEUE } from '../queue/queue.constants.js'

@Processor(INVOICE_GENERATION_QUEUE)
export class InvoiceGenerationProcessor extends WorkerHost {
  private readonly logger = new Logger(InvoiceGenerationProcessor.name)

  constructor(
    private readonly repo: InvoicesRepository,
    @Inject(INVOICE_FORMAT_GENERATOR)
    private readonly generator: InvoiceFormatGenerator,
  ) {
    super()
  }

  async process(job: Job<InvoiceGenerationJob>): Promise<void> {
    const { tenantId, invoiceId } = job.data
    const invoice = await this.repo.loadCanonical(tenantId, invoiceId)
    if (!invoice) {
      // Facture supprimée entre l'enfilement et le traitement : no-op idempotent.
      this.logger.warn(`invoice ${invoiceId} vanished before generation`)
      return
    }
    await this.repo.markGenerationStatus(tenantId, invoiceId, 'generating')
    const formats = await this.generator.generate(invoice)
    await this.repo.saveFormats(tenantId, invoiceId, formats)
    await this.repo.markGenerationStatus(tenantId, invoiceId, 'generated')
  }

  // `failed` est émis à CHAQUE tentative échouée ; on ne bascule en `failed`
  // définitif qu'après épuisement des tentatives (sinon un retry en cours
  // repositionnerait un statut erroné).
  @OnWorkerEvent('failed')
  async onFailed(job: Job<InvoiceGenerationJob>): Promise<void> {
    const maxAttempts = job.opts.attempts ?? 1
    if (job.attemptsMade < maxAttempts) return
    const { tenantId, invoiceId } = job.data
    await this.repo
      .markGenerationStatus(tenantId, invoiceId, 'failed')
      .catch((e) => this.logger.error(`failed to mark ${invoiceId} failed`, e))
  }
}
```

- [ ] **Step 4 : WorkerModule + point d'entrée**

`apps/api/src/worker/worker.module.ts` :
```ts
import { Module } from '@nestjs/common'
import { AppConfigModule } from '../config/config.module.js'
import { DbModule } from '../db/db.module.js'
import { FormatGenerationService } from '../invoices/format-generation.service.js'
import { INVOICE_FORMAT_GENERATOR } from '../invoices/format-generator.port.js'
import { InvoicesRepository } from '../invoices/invoices.repository.js'
import { QueueModule } from '../queue/queue.module.js'
import { InvoiceGenerationProcessor } from './invoice-generation.processor.js'

// Côté CONSOMMATEUR : fournit le @Processor → un Worker BullMQ démarre. Importé
// UNIQUEMENT par worker-main.ts (JAMAIS par AppModule) → l'API n'a pas de worker.
@Module({
  imports: [AppConfigModule, DbModule, QueueModule],
  providers: [
    InvoicesRepository,
    { provide: INVOICE_FORMAT_GENERATOR, useClass: FormatGenerationService },
    InvoiceGenerationProcessor,
  ],
})
export class WorkerModule {}
```
`apps/api/src/worker-main.ts` :
```ts
import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { WorkerModule } from './worker/worker.module.js'

// Processus worker séparé (mêmes modules NestJS, contexte applicatif sans HTTP).
// Les Workers BullMQ démarrent à onApplicationBootstrap et consomment tant que
// le process vit. enableShutdownHooks : SIGTERM/SIGINT → fermeture propre des
// files (@nestjs/bullmq) et du pool Postgres (DbModule.onModuleDestroy).
async function bootstrap(): Promise<void> {
  const ctx = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  })
  ctx.enableShutdownHooks()
}
void bootstrap()
```
`apps/api/vitest.config.ts` — ajouter `src/worker-main.ts` aux exclusions de couverture (bootstrap non testable hors e2e) :
```ts
      exclude: ['src/main.ts', 'src/worker-main.ts', '**/*.module.ts', 'src/db/migrations/**'],
```

- [ ] **Step 5 : Helpers de test worker (worker en-process + polling borné)**

`apps/api/tests/e2e/helpers/worker.ts` :
```ts
import type { INestApplicationContext } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { APP_POOL, createPool } from '../../../src/db/client.js'
import {
  INVOICE_FORMAT_GENERATOR,
  type InvoiceFormatGenerator,
} from '../../../src/invoices/format-generator.port.js'
import { REDIS_CONNECTION } from '../../../src/queue/redis-connection.module.js'
import { WorkerModule } from '../../../src/worker/worker.module.js'

// Boote le VRAI WorkerModule en-process contre le Postgres + Redis de test
// (overrides du pool applicatif et de la connexion Redis, comme createTestApp).
// opts.generator : stub de génération (ex. qui throw) pour tester les échecs.
export async function createTestWorker(
  appUrl: string,
  redis: { host: string; port: number },
  opts?: { generator?: InvoiceFormatGenerator },
): Promise<INestApplicationContext> {
  process.env.DATABASE_URL = appUrl
  process.env.LOG_LEVEL = 'silent'
  const builder = Test.createTestingModule({ imports: [WorkerModule] })
    .overrideProvider(APP_POOL)
    .useFactory({ factory: () => createPool(appUrl) })
    .overrideProvider(REDIS_CONNECTION)
    .useValue({ host: redis.host, port: redis.port })
  if (opts?.generator) {
    builder.overrideProvider(INVOICE_FORMAT_GENERATOR).useValue(opts.generator)
  }
  const moduleRef = await builder.compile()
  const ctx = moduleRef.createNestApplicationContext()
  ctx.enableShutdownHooks()
  await ctx.init() // déclenche onApplicationBootstrap → démarre les Workers BullMQ
  return ctx
}

// Polling borné (JAMAIS de sleep fixe) : résout dès que `predicate()` est vrai,
// rejette après `timeoutMs`. Intervalle court pour un test réactif.
export async function waitFor(
  predicate: () => Promise<boolean>,
  { timeoutMs = 20_000, intervalMs = 100 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`waitFor: predicate not satisfied within ${timeoutMs}ms`)
}
```
> **Note d'exécution (⚠)** : `moduleRef.createNestApplicationContext()` + `await ctx.init()` est l'API attendue pour exécuter le cycle de vie applicatif (dont `onApplicationBootstrap` qui démarre les Workers BullMQ) depuis un `TestingModule`. Si l'API diffère selon la version de `@nestjs/testing`, repli documenté : `const ctx = await moduleRef.createNestApplicationContext()` (sans `init` séparé si la méthode initialise déjà) — à ajuster au premier run. Le teardown appelle **toujours** `await ctx.close()`.

- [ ] **Step 6 : e2e asynchrone complet (RED→GREEN)**

`apps/api/tests/e2e/async-generation.e2e.test.ts` :
```ts
import type { INestApplication, INestApplicationContext } from '@nestjs/common'
import { Queue } from 'bullmq'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { INVOICE_GENERATION_QUEUE } from '../../src/queue/queue.constants.js'
import { GENERATE_JOB } from '../../src/queue/invoice-generation.job.js'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { startTestRedis, type TestRedis } from './helpers/redis.js'
import { createTestWorker, waitFor } from './helpers/worker.js'
import { seedTenantWithKey } from './helpers/seed.js'

const valid = {
  number: 'FA-ASYNC-1', issueDate: '2026-07-13', dueDate: '2026-08-12',
  typeCode: '380', currency: 'EUR', businessProcessType: 'S1',
  seller: { name: 'Vendeur', address: { countryCode: 'FR' } },
  buyer: { name: 'Acheteur', address: { countryCode: 'FR' } },
  lines: [{ id: '1', name: 'Service', quantity: '1', unitCode: 'C62', unitPrice: '100.00', vatCategory: 'S', vatRate: '20.00' }],
}

describe('asynchronous generation (e2e)', () => {
  let db: TestDb
  let redis: TestRedis
  let app: INestApplication
  let ownerPool: pg.Pool
  let token: string
  const auth = () => `Bearer ${token}`

  beforeAll(async () => {
    ;[db, redis] = await Promise.all([startTestDb(), startTestRedis()])
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    ;({ token } = await seedTenantWithKey(ownerPool))
    app = await createTestApp(db.appUrl, { host: redis.host, port: redis.port })
  })
  afterAll(async () => {
    await app.close()
    await ownerPool.end()
    await Promise.all([db.stop(), redis.stop()])
  })

  it('API enqueues but does NOT process without a worker; a worker then generates the 5 formats', async () => {
    const res = await request(app.getHttpServer())
      .post('/invoices').set('Authorization', auth()).send(valid).expect(201)
    const id = res.body.id
    expect(res.body.status).toBe('received')

    // (a) Sans worker : le job attend, la facture reste `received` (preuve
    // déterministe que l'API ne consomme pas — pas de double-consommation).
    const inspect = new Queue(INVOICE_GENERATION_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    try {
      const counts = await inspect.getJobCounts('waiting', 'active', 'completed')
      expect(counts.waiting + counts.active).toBeGreaterThanOrEqual(1)
      const still = await ownerPool.query('SELECT status FROM invoices WHERE id = $1', [id])
      expect(still.rows[0].status).toBe('received')

      // (b) On démarre le worker → génération → statut `generated`.
      const worker = await createTestWorker(db.appUrl, redis)
      try {
        await waitFor(async () => {
          const r = await request(app.getHttpServer())
            .get(`/invoices/${id}`).set('Authorization', auth())
          return r.body.status === 'generated'
        })
        const detail = await request(app.getHttpServer())
          .get(`/invoices/${id}`).set('Authorization', auth()).expect(200)
        expect([...detail.body.availableFormats].sort()).toEqual([
          'cii', 'facturx', 'flux_base', 'flux_full', 'ubl',
        ])
        const n = await ownerPool.query(
          'SELECT count(*)::int AS n FROM invoice_formats WHERE invoice_id = $1', [id])
        expect(n.rows[0].n).toBe(5)
      } finally {
        await worker.close()
      }
    } finally {
      await inspect.close()
    }
  })

  it('replaying a generation job is idempotent (still exactly 5 formats)', async () => {
    const res = await request(app.getHttpServer())
      .post('/invoices').set('Authorization', auth())
      .send({ ...valid, number: 'FA-ASYNC-REPLAY' }).expect(201)
    const id = res.body.id
    const worker = await createTestWorker(db.appUrl, redis)
    const replayQueue = new Queue(INVOICE_GENERATION_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    try {
      await waitFor(async () => {
        const r = await request(app.getHttpServer())
          .get(`/invoices/${id}`).set('Authorization', auth())
        return r.body.status === 'generated'
      })
      // Rejeu explicite (jobId distinct → non dédupliqué) : delete+insert.
      const tenantRow = await ownerPool.query('SELECT tenant_id FROM invoices WHERE id = $1', [id])
      await replayQueue.add(
        GENERATE_JOB,
        { tenantId: tenantRow.rows[0].tenant_id, invoiceId: id },
        { jobId: `${id}-replay` },
      )
      await waitFor(async () => {
        const n = await ownerPool.query(
          "SELECT count(*)::int AS n FROM invoice_formats WHERE invoice_id = $1", [id])
        // reste exactement 5 après rejeu (jamais 10)
        return n.rows[0].n === 5
      })
      const n = await ownerPool.query(
        'SELECT count(*)::int AS n FROM invoice_formats WHERE invoice_id = $1', [id])
      expect(n.rows[0].n).toBe(5)
    } finally {
      await replayQueue.close()
      await worker.close()
    }
  })

  it('exhausted retries mark the invoice generation as failed', async () => {
    const res = await request(app.getHttpServer())
      .post('/invoices').set('Authorization', auth())
      .send({ ...valid, number: 'FA-ASYNC-FAIL' }).expect(201)
    const id = res.body.id
    // Worker dont le générateur échoue systématiquement → après épuisement
    // des tentatives (GENERATION_JOB_ATTEMPTS, défaut 3, backoff exp) → failed.
    const worker = await createTestWorker(db.appUrl, redis, {
      generator: { generate: () => Promise.reject(new Error('boom')) },
    })
    try {
      await waitFor(
        async () => {
          const r = await ownerPool.query('SELECT status FROM invoices WHERE id = $1', [id])
          return r.rows[0].status === 'failed'
        },
        { timeoutMs: 30_000 },
      )
      const r = await ownerPool.query('SELECT status FROM invoices WHERE id = $1', [id])
      expect(r.rows[0].status).toBe('failed')
    } finally {
      await worker.close()
    }
  })
})
```
> Les trois `it` partagent l'app mais chacun démarre/arrête **son** worker (isolation ; un seul worker actif à la fois évite les courses sur la même file). Respect de `listenOnce` (via `createTestApp`), timeouts e2e hérités de `vitest.config.ts`.

Run: `pnpm --filter @factelec/api test -- async-generation`
Expected: PASS (génération, rejeu idempotent, échec→failed). Si le 3e cas dépasse le temps : vérifier `GENERATION_JOB_ATTEMPTS` (défaut 3) et le backoff — augmenter `timeoutMs` avant de suspecter un bug.

- [ ] **Step 7 : Gate + commit**

Run: `pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test`
Expected: PASS, couverture ≥ 90 % (processor couvert par les e2e succès/échec ; `worker-main.ts` exclu ; repo methods couvertes).
```bash
git add -A
git commit -m "feat(api): worker de génération BullMQ (processor idempotent, retries/backoff)"
```

---
### Task 4 : Machine à états du cycle de vie CDV (pure, nomenclature DGFiP)

**Files:**
- Create: `apps/api/src/invoices/lifecycle-status.ts`
- Create: `apps/api/tests/unit/lifecycle-status.test.ts`

**Interfaces:**
- Produces (utilisé par Tasks 5-6) :
  - `type LifecycleStatus` (union des 14 slugs) ; `LIFECYCLE_STATUSES: readonly LifecycleStatus[]` ; `STATUS_META: Record<LifecycleStatus, { code: number; label: string; mandatory: boolean }>`.
  - `INITIAL_STATUS = 'deposee'` ; `TERMINAL_STATUSES: Set<LifecycleStatus>` ({refusee, rejetee}).
  - `canTransition(from, to): boolean` ; `assertTransition(from, to): void` (jette `InvalidLifecycleTransitionError`) ; `isTerminal(s)` ; `requiresReason(s): boolean` (G7.25 : refusée, suspendue) ; `statusByCode(code): LifecycleStatus | null` ; `isLifecycleStatus(v): v is LifecycleStatus`.

> **Modèle assumé (voir Nomenclature CDV ci-dessus)** : aucune matrice de transitions n'étant énumérée par la DGFiP dans le dépôt, la machine encode une règle **chronologique monotone documentée** — une transition n'est valide **que** vers un statut de **code strictement supérieur** (les statuts facultatifs sont donc *sautables*, la chronologie ne *régresse* jamais), sauf depuis un statut **terminal** (210 Refusée, 213 Rejetée : aucune sortie, cf. « avoir interne » du Tableau 8). C'est une **interprétation projet** explicitement marquée, à durcir contre AFNOR XP Z12-012 (hors dépôt) avant production — on **n'invente pas** de règle non écrite, on applique la seule contrainte documentée (« respect de la chronologie » + terminaux d'exception).

- [ ] **Step 1 : Tests de la machine à états (RED)**

`apps/api/tests/unit/lifecycle-status.test.ts` :
```ts
import { describe, expect, it } from 'vitest'
import {
  INITIAL_STATUS,
  InvalidLifecycleTransitionError,
  LIFECYCLE_STATUSES,
  STATUS_META,
  assertTransition,
  canTransition,
  isLifecycleStatus,
  isTerminal,
  requiresReason,
  statusByCode,
} from '../../src/invoices/lifecycle-status.js'

describe('lifecycle-status (CDV state machine)', () => {
  it('exposes the 14 DGFiP statuses with codes 200..213', () => {
    expect(LIFECYCLE_STATUSES).toHaveLength(14)
    expect(STATUS_META.deposee).toEqual({ code: 200, label: 'Déposée', mandatory: true })
    expect(STATUS_META.refusee.code).toBe(210)
    expect(STATUS_META.encaissee).toEqual({ code: 212, label: 'Encaissée', mandatory: true })
    expect(STATUS_META.rejetee.code).toBe(213)
    // Socle obligatoire G7.44 = {200, 210, 212, 213}
    const mandatory = LIFECYCLE_STATUSES.filter((s) => STATUS_META[s].mandatory)
      .map((s) => STATUS_META[s].code).sort((a, b) => a - b)
    expect(mandatory).toEqual([200, 210, 212, 213])
  })

  it('starts at Déposée (200)', () => {
    expect(INITIAL_STATUS).toBe('deposee')
    expect(STATUS_META[INITIAL_STATUS].code).toBe(200)
  })

  it('allows forward (strictly increasing code) transitions, skipping optionals', () => {
    expect(canTransition('deposee', 'emise')).toBe(true) // 200 → 201
    expect(canTransition('deposee', 'encaissee')).toBe(true) // 200 → 212 (saut d'optionnels)
    expect(canTransition('prise_en_charge', 'approuvee')).toBe(true) // 204 → 205
  })

  it('forbids backward and self transitions', () => {
    expect(canTransition('encaissee', 'deposee')).toBe(false) // 212 → 200
    expect(canTransition('approuvee', 'approuvee')).toBe(false) // self
    expect(canTransition('mise_a_disposition', 'emise')).toBe(false) // 203 → 201
  })

  it('treats Refusée and Rejetée as terminal (no outgoing transition)', () => {
    expect(isTerminal('refusee')).toBe(true)
    expect(isTerminal('rejetee')).toBe(true)
    expect(canTransition('refusee', 'rejetee')).toBe(false) // terminal, malgré 210<213
    expect(canTransition('rejetee', 'refusee')).toBe(false)
    expect(canTransition('encaissee', 'refusee')).toBe(false) // 212 → 210 (régression)
  })

  it('reaches the mandatory terminals from earlier statuses', () => {
    expect(canTransition('prise_en_charge', 'refusee')).toBe(true) // 204 → 210
    expect(canTransition('deposee', 'rejetee')).toBe(true) // 200 → 213
  })

  it('flags statuses requiring a reason comment (G7.25: refusée, suspendue)', () => {
    expect(requiresReason('refusee')).toBe(true)
    expect(requiresReason('suspendue')).toBe(true)
    expect(requiresReason('approuvee')).toBe(false)
  })

  it('assertTransition throws a typed error on an invalid transition', () => {
    expect(() => assertTransition('encaissee', 'deposee')).toThrow(
      InvalidLifecycleTransitionError,
    )
    expect(() => assertTransition('deposee', 'emise')).not.toThrow()
  })

  it('maps codes to slugs and guards unknown values', () => {
    expect(statusByCode(200)).toBe('deposee')
    expect(statusByCode(999)).toBeNull()
    expect(isLifecycleStatus('deposee')).toBe(true)
    expect(isLifecycleStatus('nope')).toBe(false)
  })
})
```
Run: `pnpm --filter @factelec/api test -- lifecycle-status` → FAIL (module absent).

- [ ] **Step 2 : Implémenter la machine à états (GREEN)**

`apps/api/src/invoices/lifecycle-status.ts` :
```ts
// Cycle de vie CDV de la facture — nomenclature DGFiP (Dossier général v3.2
// §3.6.4, Tableau 8 ; socle obligatoire G7.44 = {200,210,212,213}). Le code
// numérique est l'identifiant réglementaire (champ MDT-105 ProcessConditionCode).
// ⚠ Transitions : interprétation projet chronologique (code strictement
// croissant, terminaux 210/213), à durcir contre AFNOR XP Z12-012 (hors dépôt).

export const STATUS_META = {
  deposee: { code: 200, label: 'Déposée', mandatory: true },
  emise: { code: 201, label: 'Emise par la plateforme', mandatory: false },
  recue: { code: 202, label: 'Reçue par la plateforme', mandatory: false },
  mise_a_disposition: { code: 203, label: 'Mise à disposition', mandatory: false },
  prise_en_charge: { code: 204, label: 'Prise en charge', mandatory: false },
  approuvee: { code: 205, label: 'Approuvée', mandatory: false },
  approuvee_partiellement: { code: 206, label: 'Approuvée partiellement', mandatory: false },
  en_litige: { code: 207, label: 'En litige', mandatory: false },
  suspendue: { code: 208, label: 'Suspendue', mandatory: false },
  completee: { code: 209, label: 'Complétée', mandatory: false },
  refusee: { code: 210, label: 'Refusée', mandatory: true },
  paiement_transmis: { code: 211, label: 'Paiement transmis', mandatory: false },
  encaissee: { code: 212, label: 'Encaissée', mandatory: true },
  rejetee: { code: 213, label: 'Rejetée', mandatory: true },
} as const

export type LifecycleStatus = keyof typeof STATUS_META

export const LIFECYCLE_STATUSES = Object.keys(STATUS_META) as LifecycleStatus[]

export const INITIAL_STATUS: LifecycleStatus = 'deposee'

// 210 Refusée & 213 Rejetée : statuts terminaux d'exception (Tableau 8 : mènent
// à une annulation comptable / avoir interne) — aucune transition sortante.
export const TERMINAL_STATUSES = new Set<LifecycleStatus>(['refusee', 'rejetee'])

// G7.25 : un passage en Refusée (210) ou Suspendue (208) exige un motif (MDT-126).
const REASON_REQUIRED = new Set<LifecycleStatus>(['refusee', 'suspendue'])

export function isLifecycleStatus(v: unknown): v is LifecycleStatus {
  return typeof v === 'string' && v in STATUS_META
}

export function isTerminal(s: LifecycleStatus): boolean {
  return TERMINAL_STATUSES.has(s)
}

export function requiresReason(s: LifecycleStatus): boolean {
  return REASON_REQUIRED.has(s)
}

export function statusByCode(code: number): LifecycleStatus | null {
  return (
    (LIFECYCLE_STATUSES.find((s) => STATUS_META[s].code === code) as
      | LifecycleStatus
      | undefined) ?? null
  )
}

// Chronologie monotone : transition valide ⇔ from non terminal ET code(to) > code(from).
export function canTransition(from: LifecycleStatus, to: LifecycleStatus): boolean {
  if (isTerminal(from)) return false
  return STATUS_META[to].code > STATUS_META[from].code
}

export class InvalidLifecycleTransitionError extends Error {
  constructor(
    readonly from: LifecycleStatus,
    readonly to: LifecycleStatus,
  ) {
    super(`invalid lifecycle transition: ${from} → ${to}`)
    this.name = 'InvalidLifecycleTransitionError'
  }
}

export function assertTransition(from: LifecycleStatus, to: LifecycleStatus): void {
  if (!canTransition(from, to)) throw new InvalidLifecycleTransitionError(from, to)
}
```
Run: `pnpm --filter @factelec/api test -- lifecycle-status` → PASS.

- [ ] **Step 3 : Gate + commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm --filter @factelec/api test`
Expected: PASS, couverture ≥ 90 % (module pur, entièrement couvert par le test — viser 100 % de ce fichier).
```bash
git add -A
git commit -m "feat(api): machine à états du cycle de vie CDV (nomenclature DGFiP, transitions)"
```

---
### Task 5 : Persistance du cycle de vie — colonne + journal append-only + RLS/immuabilité

**Files:**
- Modify: `apps/api/src/db/schema.ts` (enum `invoice_lifecycle_status`, colonne `invoices.lifecycleStatus`, table `invoiceStatusEvents`)
- Create: `apps/api/src/db/migrations/0005_invoice_lifecycle.sql` (drizzle) + `meta/_journal.json`
- Create: `apps/api/src/db/migrations/0006_lifecycle_rls.sql` (hand : RLS + grants immuables)
- Modify: `apps/api/src/invoices/invoices.repository.ts` (`insertReceived` insère l'événement initial *Déposée*)
- Create: `apps/api/tests/e2e/lifecycle-persistence.e2e.test.ts`

**Interfaces:**
- Consumes: `lifecycle-status.ts` (Task 4), `TenantContextService`, `runInTenant`.
- Produces (utilisé par Task 6) :
  - Colonne `invoices.lifecycle_status` (enum, défaut `deposee`) ; table `invoice_status_events` (append-only : `id, tenant_id, invoice_id, from_status, to_status, actor, reason, created_at`), RLS `FORCE` tenant-scopée, grants `SELECT`+`INSERT` **seulement**.
  - `InvoicesRepository.insertReceived` insère désormais l'**événement initial** (`from=NULL → deposee`, `actor='platform'`) dans la même transaction tenant.

- [ ] **Step 1 : Schéma Drizzle (enum, colonne, table)**

`apps/api/src/db/schema.ts` — ajouter l'enum (après `formatKind`) :
```ts
export const invoiceLifecycleStatus = pgEnum('invoice_lifecycle_status', [
  'deposee', 'emise', 'recue', 'mise_a_disposition', 'prise_en_charge',
  'approuvee', 'approuvee_partiellement', 'en_litige', 'suspendue', 'completee',
  'refusee', 'paiement_transmis', 'encaissee', 'rejetee',
])
```
Ajouter la colonne à la table `invoices` (après `status`) :
```ts
    lifecycleStatus: invoiceLifecycleStatus('lifecycle_status')
      .notNull()
      .default('deposee'),
```
Ajouter la table (après `invoiceFormats`) :
```ts
export const invoiceStatusEvents = pgTable(
  'invoice_status_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    // NULL pour l'événement initial (dépôt) ; sinon statut de départ.
    fromStatus: invoiceLifecycleStatus('from_status'),
    toStatus: invoiceLifecycleStatus('to_status').notNull(),
    // Acteur ayant apposé le statut : 'platform' | 'user:<uuid>' | 'apikey:<prefix>'.
    actor: text('actor').notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('invoice_status_events_invoice_idx').on(t.invoiceId, t.createdAt),
    index('invoice_status_events_tenant_idx').on(t.tenantId),
  ],
)
```

- [ ] **Step 2 : Migrations (0005 drizzle + 0006 RLS immuable)**

```bash
cd apps/api && pnpm --filter @factelec/api db:generate   # → 0005_*.sql
```
Renommer en `0005_invoice_lifecycle.sql`. **Relire** : doit contenir `CREATE TYPE "public"."invoice_lifecycle_status"`, `ALTER TABLE "invoices" ADD COLUMN "lifecycle_status" ... DEFAULT 'deposee'`, `CREATE TABLE "invoice_status_events"` + les deux index. drizzle-kit met à jour `meta/_journal.json` pour 0005.

`apps/api/src/db/migrations/0006_lifecycle_rls.sql` (hand-written) :
```sql
-- Journal d'événements de statut CDV : tenant-scopé (gabarit tenant_isolation)
-- et IMMUABLE (grants SELECT + INSERT seulement → aucune modification/suppression
-- possible par factelec_app : substrat à valeur probante, scellement en 2.2).
ALTER TABLE invoice_status_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE invoice_status_events FORCE  ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON invoice_status_events
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT ON invoice_status_events TO factelec_app;
```
Enregistrer 0006 dans `meta/_journal.json` : ajouter une entrée après 0005 (même forme : `idx` incrémenté, `version: "7"`, `when` epoch ms, `tag: "0006_lifecycle_rls"`, `breakpoints: true`) — geste manuel identique à 0001/0003 (drizzle-kit ne génère pas les migrations custom).
> La colonne `invoices.lifecycle_status` est portée par la table `invoices`, **déjà** en RLS `FORCE` et déjà dotée du grant `UPDATE` pour `factelec_app` (0001) — aucun grant supplémentaire nécessaire pour avancer le statut.

- [ ] **Step 3 : Événement initial à l'ingestion**

Modifier `insertReceived` dans `apps/api/src/invoices/invoices.repository.ts` (import : ajouter `invoiceStatusEvents` depuis `../db/schema.js`) pour inscrire l'événement de dépôt **dans la même transaction** :
```ts
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
```

- [ ] **Step 4 : e2e RLS + immuabilité + événement initial (RED→GREEN)**

`apps/api/tests/e2e/lifecycle-persistence.e2e.test.ts` :
```ts
import { buildInvoice } from '@factelec/invoice-core'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { InvoicesRepository } from '../../src/invoices/invoices.repository.js'
import { TenantContextService } from '../../src/db/tenant-context.service.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'

const invoiceInput = {
  number: 'FA-LC-1', issueDate: '2026-07-13', dueDate: '2026-08-12',
  typeCode: '380', currency: 'EUR', businessProcessType: 'S1',
  seller: { name: 'Vendeur', address: { countryCode: 'FR' } },
  buyer: { name: 'Acheteur', address: { countryCode: 'FR' } },
  lines: [{ id: '1', name: 'S', quantity: '1', unitCode: 'C62', unitPrice: '100.00', vatCategory: 'S', vatRate: '20.00' }],
}

describe('invoice_status_events persistence (e2e)', () => {
  let db: TestDb
  let ownerPool: pg.Pool
  let appPool: pg.Pool
  let repo: InvoicesRepository
  let tenantA: string
  let tenantB: string

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    appPool = new pg.Pool({ connectionString: db.appUrl })
    repo = new InvoicesRepository(new TenantContextService(appPool as never))
    const a = await ownerPool.query("INSERT INTO tenants (name) VALUES ('A') RETURNING id")
    tenantA = a.rows[0].id
    const b = await ownerPool.query("INSERT INTO tenants (name) VALUES ('B') RETURNING id")
    tenantB = b.rows[0].id
  })
  afterAll(async () => {
    await appPool.end()
    await ownerPool.end()
    await db.stop()
  })

  it('insertReceived writes the invoice at lifecycle deposee + an initial event', async () => {
    const { id } = await repo.insertReceived(tenantA, buildInvoice(invoiceInput))
    const inv = await ownerPool.query('SELECT lifecycle_status FROM invoices WHERE id = $1', [id])
    expect(inv.rows[0].lifecycle_status).toBe('deposee')
    const ev = await ownerPool.query(
      'SELECT from_status, to_status, actor FROM invoice_status_events WHERE invoice_id = $1', [id])
    expect(ev.rows).toHaveLength(1)
    expect(ev.rows[0]).toMatchObject({ from_status: null, to_status: 'deposee', actor: 'platform' })
  })

  it('isolates events per tenant (RLS)', async () => {
    const { id } = await repo.insertReceived(tenantB, buildInvoice({ ...invoiceInput, number: 'FA-LC-B' }))
    const client = await appPool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA])
      const foreign = await client.query('SELECT id FROM invoice_status_events WHERE invoice_id = $1', [id])
      expect(foreign.rowCount).toBe(0) // événement de B invisible sous contexte A
      await client.query('COMMIT')
    } finally {
      client.release()
    }
  })

  it('is APPEND-ONLY: factelec_app cannot UPDATE or DELETE events (42501)', async () => {
    const client = await appPool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA])
      await expect(
        client.query("UPDATE invoice_status_events SET actor = 'tampered'"),
      ).rejects.toMatchObject({ code: '42501' })
      await expect(
        client.query('DELETE FROM invoice_status_events'),
      ).rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  it('keeps factelec_app NOBYPASSRLS / NOSUPERUSER', async () => {
    const r = await appPool.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')
    expect(r.rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false })
  })
})
```
Run: `pnpm --filter @factelec/api test -- lifecycle-persistence` → PASS.

- [ ] **Step 5 : Gate + commit**

Run: `pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test`
Expected: PASS, couverture ≥ 90 % (insertReceived + événement initial couverts ; RLS/immuabilité prouvées au niveau DB).
```bash
git add -A
git commit -m "feat(api): journal append-only du cycle de vie facture (RLS, immuabilité, événement de dépôt)"
```

---
### Task 6 : Endpoints de transition de statut + service + rôles

**Files:**
- Modify: `apps/api/src/common/problem.ts` (type `invalidTransition`)
- Modify: `apps/api/src/invoices/invoices.repository.ts` (`getLifecycleStatus`, `recordTransition`, `listStatusEvents` ; `lifecycleStatus` dans `InvoiceSummary`)
- Create: `apps/api/src/invoices/lifecycle.service.ts`
- Modify: `apps/api/src/invoices/invoices.controller.ts` (`POST`/`GET /invoices/:id/status`)
- Modify: `apps/api/src/invoices/invoices.module.ts` (provide `LifecycleService`)
- Modify: `apps/api/tests/e2e/read.e2e.test.ts` (ajouter `lifecycleStatus` aux assertions exactes, si présentes)
- Create: `apps/api/tests/e2e/lifecycle.e2e.test.ts`

**Interfaces:**
- Consumes: `lifecycle-status.ts` (Task 4), `InvoicesRepository` (Task 5), `SessionGuard`/`RolesGuard`/`CsrfGuard`/`TenantAuthGuard` (1.4), `@CurrentUser`.
- Produces :
  - `POST /invoices/:id/status` (session owner/admin/accountant + CSRF) : enregistre une transition → `201 { status }` ; `422` transition invalide / motif manquant ; `409` transition concurrente ; `404` facture inconnue.
  - `GET /invoices/:id/status` (dual-auth clé API ou session) : `{ current, events[] }`.
  - `InvoicesRepository.getLifecycleStatus`, `recordTransition` (optimiste, anti-race), `listStatusEvents` ; `InvoiceSummary.lifecycleStatus`.

- [ ] **Step 1 : Type d'erreur + méthodes repository**

`apps/api/src/common/problem.ts` — ajouter à `ProblemType` :
```ts
  invalidTransition: `${BASE}:invalid-status-transition`,
```
`apps/api/src/invoices/invoices.repository.ts` — imports : ajouter `and` (déjà présent), `asc` (nouveau) depuis `drizzle-orm` ; `invoiceStatusEvents` (Task 5) et le type `LifecycleStatus` depuis `./lifecycle-status.js`. Ajouter `lifecycleStatus` à l'interface + aux `select` de `findById` et `list` :
```ts
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
```
Dans `findById` et `list`, ajouter au `.select({...})` : `lifecycleStatus: invoices.lifecycleStatus,`. Puis ajouter les méthodes :
```ts
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
        .where(and(eq(invoices.id, invoiceId), eq(invoices.lifecycleStatus, from)))
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
```
> Si `read.e2e.test.ts` / `keyset-cursor-precision.e2e.test.ts` asserte la forme EXACTE des items (`toEqual`), ajouter `lifecycleStatus: 'deposee'` aux objets attendus. Une assertion `toMatchObject` n'est pas impactée.

- [ ] **Step 2 : LifecycleService**

`apps/api/src/invoices/lifecycle.service.ts` :
```ts
import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common'
import { ProblemType, problem } from '../common/problem.js'
import { isUuid } from './format-kind.js'
// biome-ignore lint/style/useImportType: InvoicesRepository résolu par Nest via design:paramtypes.
import { InvoicesRepository } from './invoices.repository.js'
import {
  type LifecycleStatus,
  canTransition,
  requiresReason,
} from './lifecycle-status.js'

@Injectable()
export class LifecycleService {
  constructor(private readonly repo: InvoicesRepository) {}

  async transition(
    tenantId: string,
    invoiceId: string,
    toStatus: LifecycleStatus,
    actor: string,
    reason: string | undefined,
  ): Promise<{ status: LifecycleStatus }> {
    if (!isUuid(invoiceId)) throw this.notFound()
    const current = await this.repo.getLifecycleStatus(tenantId, invoiceId)
    if (!current) throw this.notFound()
    if (!canTransition(current, toStatus)) {
      throw new UnprocessableEntityException(
        problem(422, ProblemType.invalidTransition, 'Invalid status transition', {
          detail: `Transition ${current} → ${toStatus} is not allowed`,
        }),
      )
    }
    if (requiresReason(toStatus) && (!reason || reason.trim() === '')) {
      throw new UnprocessableEntityException(
        problem(422, ProblemType.validation, 'A reason is required', {
          errors: [{ path: 'reason', message: `reason required for status ${toStatus}` }],
        }),
      )
    }
    const ok = await this.repo.recordTransition(tenantId, invoiceId, current, toStatus, actor, reason)
    if (!ok) {
      throw new ConflictException(
        problem(409, ProblemType.conflict, 'Concurrent status change', {
          detail: 'The invoice status changed concurrently; retry',
        }),
      )
    }
    return { status: toStatus }
  }

  async history(
    tenantId: string,
    invoiceId: string,
  ): Promise<{ current: LifecycleStatus; events: unknown[] }> {
    if (!isUuid(invoiceId)) throw this.notFound()
    const current = await this.repo.getLifecycleStatus(tenantId, invoiceId)
    if (!current) throw this.notFound()
    const events = await this.repo.listStatusEvents(tenantId, invoiceId)
    return { current, events }
  }

  private notFound(): NotFoundException {
    return new NotFoundException(problem(404, ProblemType.notFound, 'Invoice not found'))
  }
}
```

- [ ] **Step 3 : Endpoints dans le contrôleur**

`apps/api/src/invoices/invoices.controller.ts` — ajouter les imports (`z`, `SessionGuard`, `RolesGuard`, `Roles`, `CsrfGuard`, `CurrentUser`, `parseBody`, `LifecycleService`, `isLifecycleStatus`, `LifecycleStatus`, `AuthenticatedUser`) et les deux routes. Injecter `LifecycleService` :
```ts
const transitionSchema = z.object({
  toStatus: z.string().refine(isLifecycleStatus, 'unknown lifecycle status'),
  reason: z.string().min(1).max(1000).optional(),
})

// dans le constructeur :
//   constructor(
//     private readonly invoices: InvoicesService,
//     private readonly lifecycle: LifecycleService,
//   ) {}

  // Mutation métier : session (owner/admin/accountant) + CSRF. Un viewer est
  // refusé (403) ; une clé API n'ouvre pas cette route (SessionGuard → 401,
  // pas de cookie). L' apposition machine (connecteurs) est différée (phase 4).
  @Post(':id/status')
  @HttpCode(201)
  @UseGuards(SessionGuard, RolesGuard, CsrfGuard)
  @Roles('owner', 'admin', 'accountant')
  recordStatus(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ status: LifecycleStatus }> {
    const { toStatus, reason } = parseBody(transitionSchema, body)
    return this.lifecycle.transition(
      tenantId,
      id,
      toStatus as LifecycleStatus,
      `user:${user.userId}`,
      reason,
    )
  }

  @Get(':id/status')
  @UseGuards(TenantAuthGuard)
  getStatus(@CurrentTenant() tenantId: string, @Param('id') id: string) {
    return this.lifecycle.history(tenantId, id)
  }
```
`apps/api/src/invoices/invoices.module.ts` — ajouter `LifecycleService` aux `providers`.

- [ ] **Step 4 : e2e des transitions (RED→GREEN)**

`apps/api/tests/e2e/lifecycle.e2e.test.ts` :
```ts
import { buildInvoice } from '@factelec/invoice-core'
import type { INestApplication } from '@nestjs/common'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashPassword } from '../../src/auth/password.js'
import { InvoicesRepository } from '../../src/invoices/invoices.repository.js'
import { TenantContextService } from '../../src/db/tenant-context.service.js'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { startTestRedis, type TestRedis } from './helpers/redis.js'
import { extractCookie } from './helpers/session.js'

const invoiceInput = {
  number: 'FA-EP-1', issueDate: '2026-07-13', dueDate: '2026-08-12',
  typeCode: '380', currency: 'EUR', businessProcessType: 'S1',
  seller: { name: 'V', address: { countryCode: 'FR' } },
  buyer: { name: 'A', address: { countryCode: 'FR' } },
  lines: [{ id: '1', name: 'S', quantity: '1', unitCode: 'C62', unitPrice: '100.00', vatCategory: 'S', vatRate: '20.00' }],
}

describe('invoice lifecycle transitions (e2e)', () => {
  let db: TestDb
  let redis: TestRedis
  let app: INestApplication
  let ownerPool: pg.Pool
  let repo: InvoicesRepository
  let tenantId: string
  let cookie: string[]
  let csrf: string
  let invoiceId: string

  async function signup(email: string, organizationName: string) {
    const res = await request(app.getHttpServer())
      .post('/auth/signup')
      .send({ email, password: 'a-strong-password-1', organizationName })
      .expect(201)
    const set = res.headers['set-cookie'] as unknown as string[]
    return { tenantId: res.body.user.tenantId as string, cookie: set, csrf: extractCookie(set, 'factelec_csrf') }
  }

  beforeAll(async () => {
    ;[db, redis] = await Promise.all([startTestDb(), startTestRedis()])
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    repo = new InvoicesRepository(new TenantContextService(ownerPool as never))
    app = await createTestApp(db.appUrl, { host: redis.host, port: redis.port })
    ;({ tenantId, cookie, csrf } = await signup('owner@ex.com', 'Org A'))
    // Facture posée directement dans le tenant du user (statut initial deposee).
    ;({ id: invoiceId } = await repo.insertReceived(tenantId, buildInvoice(invoiceInput)))
  })
  afterAll(async () => {
    await app.close()
    await ownerPool.end()
    await Promise.all([db.stop(), redis.stop()])
  })

  const post = (id: string, body: object) =>
    request(app.getHttpServer())
      .post(`/invoices/${id}/status`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).send(body)

  it('records a valid forward transition (deposee → approuvee)', async () => {
    const res = await post(invoiceId, { toStatus: 'approuvee' }).expect(201)
    expect(res.body.status).toBe('approuvee')
    const hist = await request(app.getHttpServer())
      .get(`/invoices/${invoiceId}/status`).set('Cookie', cookie).expect(200)
    expect(hist.body.current).toBe('approuvee')
    expect(hist.body.events.map((e: { toStatus: string }) => e.toStatus)).toEqual(['deposee', 'approuvee'])
  })

  it('rejects a backward transition (approuvee → deposee) → 422', async () => {
    const res = await post(invoiceId, { toStatus: 'deposee' }).expect(422)
    expect(res.body.type).toBe('urn:factelec:problem:invalid-status-transition')
  })

  it('requires a reason for refusee (G7.25) → 422 without, 201 with', async () => {
    const { id } = await repo.insertReceived(tenantId, buildInvoice({ ...invoiceInput, number: 'FA-EP-REF' }))
    await post(id, { toStatus: 'refusee' }).expect(422)
    const ok = await post(id, { toStatus: 'refusee', reason: 'destinataire inconnu' }).expect(201)
    expect(ok.body.status).toBe('refusee')
    // terminal : plus aucune transition
    await post(id, { toStatus: 'rejetee' }).expect(422)
  })

  it('rejects an unknown status → 422 validation', async () => {
    const res = await post(invoiceId, { toStatus: 'pas-un-statut' }).expect(422)
    expect(res.body.type).toBe('urn:factelec:problem:validation-error')
  })

  it('forbids a viewer from recording a transition → 403', async () => {
    // Seed d'un viewer dans le même tenant + login.
    await ownerPool.query(
      "INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1, 'viewer@ex.com', $2, 'viewer')",
      [tenantId, await hashPassword('a-strong-password-1')],
    )
    const login = await request(app.getHttpServer())
      .post('/auth/login').send({ email: 'viewer@ex.com', password: 'a-strong-password-1' }).expect(200)
    const vset = login.headers['set-cookie'] as unknown as string[]
    const { id } = await repo.insertReceived(tenantId, buildInvoice({ ...invoiceInput, number: 'FA-EP-V' }))
    await request(app.getHttpServer())
      .post(`/invoices/${id}/status`)
      .set('Cookie', vset).set('X-CSRF-Token', extractCookie(vset, 'factelec_csrf'))
      .send({ toStatus: 'approuvee' }).expect(403)
  })

  it('does not leak another tenant’s invoice → 404', async () => {
    const other = await signup('owner2@ex.com', 'Org B')
    const res = await request(app.getHttpServer())
      .post(`/invoices/${invoiceId}/status`)
      .set('Cookie', other.cookie).set('X-CSRF-Token', other.csrf)
      .send({ toStatus: 'approuvee' }).expect(404)
    expect(res.body.type).toBe('urn:factelec:problem:not-found')
  })

  it('rejects a session mutation without the CSRF header → 403', async () => {
    await request(app.getHttpServer())
      .post(`/invoices/${invoiceId}/status`).set('Cookie', cookie)
      .send({ toStatus: 'encaissee' }).expect(403)
  })
})
```
> `repo` est construit sur `ownerPool` **uniquement pour le seed** (BYPASSRLS) — les assertions d'isolation passent par l'app (RLS réelle via session). Le seed d'un viewer via `ownerPool` évite un flux d'invitation (différé).

Run: `pnpm --filter @factelec/api test -- lifecycle` → PASS (transitions, motif, rôles, isolation, CSRF).

- [ ] **Step 5 : Gate + commit**

Run: `pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test`
Expected: PASS, couverture ≥ 90 %.
```bash
git add -A
git commit -m "feat(api): endpoints de transition et historique du cycle de vie CDV (rôles, RLS, anti-race)"
```

---
### Task 7 : Dettes 1.3/1.4 — `last_used_at` écrit + purge des sessions expirées (job répétable)

**Files:**
- Create: `apps/api/src/db/migrations/0007_last_used_and_purge.sql` (hand) + `meta/_journal.json`
- Create: `apps/api/src/queue/maintenance.job.ts` (nom de job)
- Create: `apps/api/src/worker/session-maintenance.service.ts`
- Create: `apps/api/src/worker/maintenance.processor.ts`
- Create: `apps/api/src/worker/maintenance.scheduler.ts`
- Modify: `apps/api/src/worker/worker.module.ts` (provider des 3 ci-dessus)
- Create: `apps/api/tests/e2e/api-key-last-used.e2e.test.ts`
- Create: `apps/api/tests/e2e/session-purge.e2e.test.ts`

**Interfaces:**
- Consumes: `authenticate_api_key` (0001), `sessions`/fonctions SD (1.4), `MAINTENANCE_QUEUE` (Task 1), `APP_POOL`.
- Produces :
  - `authenticate_api_key(prefix)` **écrit `last_used_at = now()`** (plpgsql VOLATILE, signature inchangée).
  - `purge_expired_sessions() → integer` (SECURITY DEFINER, `EXECUTE` à `factelec_app`).
  - `maintenance.job.ts` : `PURGE_SESSIONS_JOB = 'purge-sessions'`.
  - `SessionMaintenanceService.purgeExpiredSessions(): Promise<number>` ; `MaintenanceProcessor` (`@Processor('maintenance')`) ; `MaintenanceScheduler` (upsert du job répétable au bootstrap).

- [ ] **Step 1 : Migration (last_used_at + purge)**

`apps/api/src/db/migrations/0007_last_used_and_purge.sql` :
```sql
-- Dette 1.3 : écrire last_used_at à l'authentification par clé API. La fonction
-- authenticate_api_key (0001) est la SEULE exécutée avant le contexte tenant
-- (poule/œuf), donc le seul endroit où poser last_used_at sans casser la RLS.
-- Elle devient plpgsql VOLATILE avec UPDATE ... RETURNING (SECURITY DEFINER
-- owner → bypass RLS ; SIGNATURE INCHANGÉE : impératif pour CREATE OR REPLACE).
-- ⚠ last_used_at est posé sur simple correspondance de PRÉFIXE (avant la
-- vérification du secret, impossible ici) ; le préfixe faisant 96 bits (12 o),
-- une correspondance ≈ usage de la vraie clé — sémantique « dernière
-- présentation de la clé » assumée et documentée.
CREATE OR REPLACE FUNCTION authenticate_api_key(p_prefix text)
RETURNS TABLE (api_key_id uuid, tenant_id uuid, secret_hash text, revoked_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE api_keys
     SET last_used_at = now()
   WHERE prefix = p_prefix
  RETURNING id, tenant_id, secret_hash, revoked_at;
END;
$$;
--> statement-breakpoint
-- Dette 1.4 : purge des sessions expirées (job répétable, Task 7). sessions est
-- deny-all pour factelec_app (accès uniquement via fonctions SD) → SECURITY
-- DEFINER. Retourne le nombre de lignes supprimées (observabilité).
CREATE OR REPLACE FUNCTION purge_expired_sessions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE deleted integer;
BEGIN
  DELETE FROM sessions WHERE expires_at < now();
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION purge_expired_sessions() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION purge_expired_sessions() TO factelec_app;
```
Enregistrer 0007 dans `meta/_journal.json` (entrée après 0006, même forme, `tag: "0007_last_used_and_purge"`).

- [ ] **Step 2 : Service + processor + scheduler de maintenance**

`apps/api/src/queue/maintenance.job.ts` :
```ts
export const PURGE_SESSIONS_JOB = 'purge-sessions'
```
`apps/api/src/worker/session-maintenance.service.ts` :
```ts
import { Inject, Injectable } from '@nestjs/common'
import type pg from 'pg'
import { APP_POOL } from '../db/client.js'

@Injectable()
export class SessionMaintenanceService {
  constructor(@Inject(APP_POOL) private readonly pool: pg.Pool) {}

  // Appelle la fonction SECURITY DEFINER (sessions = deny-all pour app).
  async purgeExpiredSessions(): Promise<number> {
    const r = await this.pool.query<{ n: number }>('SELECT purge_expired_sessions() AS n')
    return r.rows[0]?.n ?? 0
  }
}
```
`apps/api/src/worker/maintenance.processor.ts` :
```ts
import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Logger } from '@nestjs/common'
import type { Job } from 'bullmq'
import { PURGE_SESSIONS_JOB } from '../queue/maintenance.job.js'
import { MAINTENANCE_QUEUE } from '../queue/queue.constants.js'
// biome-ignore lint/style/useImportType: SessionMaintenanceService résolu par Nest via design:paramtypes.
import { SessionMaintenanceService } from './session-maintenance.service.js'

@Processor(MAINTENANCE_QUEUE)
export class MaintenanceProcessor extends WorkerHost {
  private readonly logger = new Logger(MaintenanceProcessor.name)
  constructor(private readonly maintenance: SessionMaintenanceService) {
    super()
  }

  async process(job: Job): Promise<void> {
    if (job.name === PURGE_SESSIONS_JOB) {
      const n = await this.maintenance.purgeExpiredSessions()
      this.logger.log(`purged ${n} expired session(s)`)
    }
  }
}
```
`apps/api/src/worker/maintenance.scheduler.ts` :
```ts
import { InjectQueue } from '@nestjs/bullmq'
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Queue } from 'bullmq'
import type { EnvConfig } from '../config/env.js'
import { PURGE_SESSIONS_JOB } from '../queue/maintenance.job.js'
import { MAINTENANCE_QUEUE } from '../queue/queue.constants.js'

// upsertJobScheduler : idempotent (ré-exécuter le bootstrap ne duplique pas le
// planificateur). Un seul planificateur 'session-purge' émet le job périodique.
@Injectable()
export class MaintenanceScheduler implements OnApplicationBootstrap {
  private readonly everyMs: number
  constructor(
    @InjectQueue(MAINTENANCE_QUEUE) private readonly queue: Queue,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.everyMs = config.get('SESSION_PURGE_EVERY_MS', { infer: true })
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'session-purge',
      { every: this.everyMs },
      { name: PURGE_SESSIONS_JOB },
    )
  }
}
```
`apps/api/src/worker/worker.module.ts` — ajouter aux `providers` : `SessionMaintenanceService`, `MaintenanceProcessor`, `MaintenanceScheduler`.

- [ ] **Step 3 : e2e `last_used_at` (RED→GREEN)**

`apps/api/tests/e2e/api-key-last-used.e2e.test.ts` :
```ts
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseApiKeyToken } from '../../src/auth/api-key.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { seedTenantWithKey } from './helpers/seed.js'

describe('authenticate_api_key writes last_used_at (e2e)', () => {
  let db: TestDb
  let ownerPool: pg.Pool
  let appPool: pg.Pool
  let token: string

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    appPool = new pg.Pool({ connectionString: db.appUrl })
    ;({ token } = await seedTenantWithKey(ownerPool))
  })
  afterAll(async () => {
    await appPool.end()
    await ownerPool.end()
    await db.stop()
  })

  it('sets last_used_at on prefix match (was null after seeding)', async () => {
    const prefix = parseApiKeyToken(token)?.prefix
    const before = await ownerPool.query('SELECT last_used_at FROM api_keys WHERE prefix = $1', [prefix])
    expect(before.rows[0].last_used_at).toBeNull()

    const auth = await appPool.query('SELECT api_key_id, tenant_id FROM authenticate_api_key($1)', [prefix])
    expect(auth.rows).toHaveLength(1)

    const after = await ownerPool.query('SELECT last_used_at FROM api_keys WHERE prefix = $1', [prefix])
    expect(after.rows[0].last_used_at).not.toBeNull()
  })

  it('returns no row for an unknown prefix (and writes nothing)', async () => {
    const r = await appPool.query('SELECT api_key_id FROM authenticate_api_key($1)', ['deadbeefdeadbeefdeadbeef'])
    expect(r.rowCount).toBe(0)
  })
})
```
Run: `pnpm --filter @factelec/api test -- api-key-last-used` → PASS.

- [ ] **Step 4 : e2e purge des sessions (RED→GREEN)**

`apps/api/tests/e2e/session-purge.e2e.test.ts` :
```ts
import { Queue } from 'bullmq'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PURGE_SESSIONS_JOB } from '../../src/queue/maintenance.job.js'
import { MAINTENANCE_QUEUE } from '../../src/queue/queue.constants.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { startTestRedis, type TestRedis } from './helpers/redis.js'
import { createTestWorker, waitFor } from './helpers/worker.js'

describe('expired session purge (e2e)', () => {
  let db: TestDb
  let redis: TestRedis
  let ownerPool: pg.Pool
  let tenantId: string
  let userId: string

  async function seedSession(tokenHash: string, expiresAt: string) {
    await ownerPool.query(
      `INSERT INTO sessions (user_id, tenant_id, token_hash, csrf_hash, expires_at)
       VALUES ($1, $2, $3, 'csrf', $4)`,
      [userId, tenantId, tokenHash, expiresAt],
    )
  }

  beforeAll(async () => {
    ;[db, redis] = await Promise.all([startTestDb(), startTestRedis()])
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    const t = await ownerPool.query("INSERT INTO tenants (name) VALUES ('T') RETURNING id")
    tenantId = t.rows[0].id
    const u = await ownerPool.query(
      "INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1, 'u@ex.com', 'x', 'owner') RETURNING id",
      [tenantId],
    )
    userId = u.rows[0].id
    await seedSession('expired-hash', new Date(Date.now() - 3_600_000).toISOString())
    await seedSession('valid-hash', new Date(Date.now() + 3_600_000).toISOString())
  })
  afterAll(async () => {
    await ownerPool.end()
    await Promise.all([db.stop(), redis.stop()])
  })

  it('the maintenance worker deletes expired sessions but keeps valid ones', async () => {
    const worker = await createTestWorker(db.appUrl, redis)
    const queue = new Queue(MAINTENANCE_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    try {
      // Le scheduler a enregistré le planificateur périodique (idempotent).
      const schedulers = await queue.getJobSchedulers()
      expect(schedulers.some((s) => s.key === 'session-purge' || s.name === PURGE_SESSIONS_JOB)).toBe(true)

      // Déclenchement immédiat (job ponctuel, sans attendre l'intervalle).
      await queue.add(PURGE_SESSIONS_JOB, {})
      await waitFor(async () => {
        const r = await ownerPool.query("SELECT count(*)::int AS n FROM sessions WHERE token_hash = 'expired-hash'")
        return r.rows[0].n === 0
      })
      const valid = await ownerPool.query("SELECT count(*)::int AS n FROM sessions WHERE token_hash = 'valid-hash'")
      expect(valid.rows[0].n).toBe(1)
    } finally {
      await queue.close()
      await worker.close()
    }
  })
})
```
> `getJobSchedulers()` : l'assertion tolère les deux formes de clé selon la version de BullMQ (`key` vs `name`) — ajuster au premier run si nécessaire.
Run: `pnpm --filter @factelec/api test -- session-purge` → PASS.

- [ ] **Step 5 : Gate + commit**

Run: `pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test`
Expected: PASS, couverture ≥ 90 %.
```bash
git add -A
git commit -m "feat(api): last_used_at des clés API et purge répétable des sessions expirées (dettes 1.3/1.4)"
```

---
### Task 8 : CI, documentation, versions — clôture de branche

**Files:**
- Modify: `.github/workflows/ci.yml` (commentaire Postgres **+ Redis**)
- Modify: `README.md` (racine) + `apps/api/README.md`
- Modify: `apps/api/package.json` (bump version)

**Interfaces:**
- Consumes: tout le livrable 2.1. Produces : documentation et CI à jour, gates finales vertes.

- [ ] **Step 1 : CI**

`.github/workflows/ci.yml` — le runner GitHub a Docker natif (déjà utilisé pour Postgres) : Testcontainers **Redis** démarre sans configuration supplémentaire. Mettre à jour le commentaire de l'étape `pnpm test` :
```yaml
      - run: pnpm test          # invoice-core + apps/api (Testcontainers Postgres + Redis) + apps/web (jsdom)
```
> Aucun service `redis:` de job GitHub n'est requis (Testcontainers gère le cycle de vie du conteneur, comme Postgres). Le worker n'est **pas** démarré en CI : les e2e le bootent en-process (`createTestWorker`). `pnpm build` compile déjà `src/worker-main.ts` (swc) ; `pnpm typecheck` le couvre.

- [ ] **Step 2 : Vérifier audit + outdated (bloquants)**

Run:
```bash
pnpm install
pnpm audit
pnpm outdated -r
pnpm why ioredis -r    # doit montrer une SEULE copie (transitive de bullmq), non déclarée
```
Expected: `audit` 0 vulnérabilité ; `outdated` vierge (bullmq 5.80.2, @nestjs/bullmq 11.0.4, @testcontainers/redis 12.0.4 = dernières stables ce jour) ; `ioredis` unique, non listé par `outdated` (dépendance indirecte). Si une vuln transitive apparaît (chaîne bullmq/ioredis/msgpackr) → politique D7 (override si patch, sinon documenter + arbitrer avec Xavier ; jamais de merge avec vuln exploitable).

- [ ] **Step 3 : README (racine + apps/api)**

`README.md` racine — dans l'encadré d'état, ajouter un paragraphe **2.1** (workers BullMQ, ingestion asynchrone `received → generating → generated|failed`, statuts CDV, Redis) ; **mettre à jour la Feuille de route** : cocher les points 2.1 livrés et **retirer de la dette différée** les entrées désormais soldées :
- `last_used_at` des clés API → **résolu** (écrit à l'authentification, Task 7).
- Purge des sessions expirées → **résolu** (job répétable BullMQ, Task 7).
- Workers BullMQ (génération asynchrone) → **résolu** (Tasks 1-3).
- Ajouter, en différé explicite **2.2+** : e-reporting (Flux 10), annuaire (Flux 13/14), **scellement/archivage à valeur probante** (le journal append-only 2.1 en est le substrat) ; **phase 3** : transmission Peppol des CDV ; **horizon 2.x** : journal d'audit des **authentifications** (distinct, cf. D7). Conserver la note migration Factur-X D22B / F1 CII D22B (héritée).

`apps/api/README.md` — documenter :
- **Architecture workers** : producteur (API, `POST /invoices` enfile) / consommateur (`apps/api/src/worker-main.ts`, processus séparé, `pnpm start:worker`) ; port `InvoiceGenerationQueue` (enfilement) + `InvoiceFormatGenerator` (génération, désormais côté worker) ; idempotence (jobId=invoiceId, processor delete+insert), retries/backoff (`GENERATION_JOB_ATTEMPTS`), rétention ; **payload minimal** (ids only, aucun contenu de facture dans Redis) ; rôle worker = `factelec_app` (D6).
- **Nouvelle sémantique `POST /invoices`** : `201 { status: 'received' }` (génération asynchrone) ; suivi via `GET /invoices/:id` (`status` de génération) ; formats disponibles une fois `generated`.
- **Cycle de vie CDV** : deux axes (`status` génération vs `lifecycle_status` métier) ; nomenclature DGFiP (14 statuts, socle obligatoire {200,210,212,213}, source Dossier §3.6.4 / G7.44) ; machine à états (chronologie monotone, terminaux 210/213) **interprétation projet à durcir contre AFNOR XP Z12-012** ; endpoints `POST /invoices/:id/status` (session owner/admin/accountant + CSRF), `GET /invoices/:id/status` ; **journal `invoice_status_events` append-only** (immuable par grants, substrat du futur journal à valeur probante 2.2).
- **Variables d'env** : `REDIS_HOST/PORT/DB/PASSWORD/TLS`, `GENERATION_JOB_ATTEMPTS`, `SESSION_PURGE_EVERY_MS` (table d'env).
- **Dev** : `cd apps/api && docker compose up -d` démarre Postgres **+ Redis** ; lancer l'API puis `pnpm --filter @factelec/api start:worker` (ou `worker:dev`).
- **Endpoints** : table mise à jour (nouveaux endpoints statut, sémantique 201 received, readiness Redis).
- **Compteur de tests** mis à jour (nouveaux fichiers e2e + unitaires).

- [ ] **Step 4 : Bump version + gate finale + commit**

`apps/api/package.json` : `"version": "0.3.0"` (phase 2.1 : workers + cycle de vie).
Run: `pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm test && pnpm audit && pnpm outdated -r`
Expected: tout vert ; couverture invoice-core 100 %, apps/api ≥ 90 %×4, apps/web ≥ 90 %×4 ; audit 0 ; outdated vierge.
```bash
git add -A
git commit -m "docs(api): documentation workers/statuts CDV, CI Redis et bump version 0.3.0"
```

---

## Self-Review (relecture contre la spec §8 et le cadrage 2.1)

**1. Couverture de la spec / du cadrage :**
- Workers BullMQ (spec §3.1/§3.2 « ingestion → file BullMQ → workers ») → Tasks 1-3. ✅
- `QueuedFormatGenerator` derrière le port existant → Task 2 (enfilement) + Task 3 (génération relocalisée côté worker). ✅ (écart de contrat assumé D1)
- Worker en processus séparé (§3.1 `apps/worker`) → Task 3 (`worker-main.ts` dans apps/api, écart justifié D2). ✅
- Idempotence / retries / backoff / statut de génération → Tasks 2-3 (D4). ✅
- Cycle de vie des statuts (§4.2 « déposée, rejetée, refusée, encaissée… ») → Tasks 4-6, nomenclature DGFiP sourcée (Dossier §3.6.4, G7.44). ✅
- Machine à états + transitions valides + RLS + endpoints → Tasks 4-6. ✅
- Journal d'événements append-only (substrat valeur probante §4.5) → Task 5 ; scellement/WORM **reporté 2.2** (D7, acté). ✅
- Redis en docker-compose + CI Testcontainers → Tasks 1, 8. ✅
- Rôle Postgres du worker tranché (§6 moindre privilège) → D6 (`factelec_app`). ✅
- Aucune donnée sensible dans les jobs → payload ids only (D3, contrainte). ✅
- Dettes 1.3/1.4 (`last_used_at`, purge sessions) → Task 7. ✅
- E-reporting / annuaire → **reportés 2.2+** (acté). ✅
- Journal d'audit des authentifications (« 2.x ») → **reporté**, justifié D7. ✅

**2. Placeholders :** aucun « TODO/à compléter » ; chaque étape porte du code réel. La seule valeur « à trancher empiriquement » est l'API `createNestApplicationContext`/`init` et la forme de clé `getJobSchedulers` — signalées comme **notes d'exécution avec repli**, pas des trous.

**3. Cohérence des types :** `FormatKind`/`GeneratedFormat` (port inchangé) ; `InvoiceGenerationJob {tenantId, invoiceId}` cohérent enqueue↔processor ; `LifecycleStatus` (slugs) partagé machine à états ↔ repo ↔ service ↔ controller ; `InvoiceSummary.lifecycleStatus` ajouté aux selects `findById`/`list` ; `GenerationStatus` = `invoiceStatus.enumValues[number]` ; migrations 0004→0007 séquentielles, chaque enum/table/fonction référencée existe.

**Écarts spec assumés (récapitulatif) :** (a) `POST /invoices` synchrone→asynchrone (D1) ; (b) worker dans apps/api plutôt que workspace apps/worker (D2) ; (c) transitions de statut pilotées par session uniquement, apposition machine différée (Task 6) ; (d) machine à états = interprétation chronologique (aucune matrice DGFiP formelle, D5). Tous documentés et justifiés.

## Amendements possibles à l'exécution (à valider empiriquement)

- **A1** — `overrideProvider(REDIS_CONNECTION)` doit se propager dans `BullModule.forRootAsync` (Task 1, Step 6) ; repli : `QueueModule.forRoot(connection)` statique injecté en test.
- **A2** — `TestingModule.createNestApplicationContext()` + `await ctx.init()` pour démarrer les Workers BullMQ (Task 3, Step 5) ; repli : ajuster selon la version `@nestjs/testing`.
- **A3** — `ALTER TYPE ... ADD VALUE 'generating'` sous le migrator drizzle (Task 2) : PG 17 l'accepte en transaction ; si un environnement plus ancien bloquait, sortir l'ADD VALUE dans une migration isolée.
- **A4** — Forme de clé de `queue.getJobSchedulers()` (Task 7, `key` vs `name`) selon la version bullmq.
- **A5** — `read.e2e`/`keyset-cursor-precision.e2e` : ajouter `lifecycleStatus` aux assertions exactes (Task 6) si `toEqual` est utilisé.
- **A6** — Repli local `typescript@5.9.x` pour apps/api **non attendu** (tsgo type-check déjà NestJS en 1.3) ; conserver la vigilance si les types `bullmq`/`@nestjs/bullmq` posaient problème au tsgo.

## Execution Handoff

Plan complet et sauvegardé. Deux options d'exécution :
1. **Subagent-Driven (recommandé)** — un subagent frais par tâche, revue Opus entre chaque, itération rapide (aligné sur les plans 1.x).
2. **Inline** — exécution par lots avec points de contrôle.

