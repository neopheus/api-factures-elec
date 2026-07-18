# Plan 3.5 — Consentement probant & séparation des rôles

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Durcir **la preuve du consentement** et **la séparation des privilèges**, sur **trois axes** internes au code (aucune extraction réglementaire nouvelle — le consentement 2.4 a déjà ses références) :

1. **E-signature du consentement annuaire (5e instance du MOTIF PORT)** — le consentement annuaire (table `annuaire_consents`, 2.4) porte `signer_identity`/`evidence_ref`/`obtained_at` **en placeholder** : aucune crypto, aucune vérification, aucune révocation active. On ajoute un **contrat de vérification/scellement de signature** (`ConsentSignaturePort`, réplique EXACTE du squelette port 1→4) + une **impl locale** qui réalise un **scellement STRUCTUREL** (hash SHA-256 + horodatage + write-once, motif du scellement 2.2) + une **factory `@Global` env-switchable** dont le driver « eIDAS réel » **throw** (testé, item Xavier). La vérification s'**insère au gate de consentement existant** (là où le code exige déjà le consentement avant de publier une ligne). **Posture ferme : AUCUNE prétention juridique fabriquée** — la doc dit **exactement** ce que le scellement fait (intégrité + horodatage + non-réécriture), **jamais** « valeur probante » sans qualification.
2. **Worker-role split côté code** — aujourd'hui **un seul** rôle `factelec_app` et **un seul** `DATABASE_URL` sont partagés par le process **API** et le process **worker**. On dérive, d'un **inventaire RÉEL** des accès des process worker (table par table), un rôle DB **`factelec_worker`** de **moindre privilège** : migration de GRANTs restreints + câblage d'un **pool/env dédié** (`DATABASE_URL_WORKER`). Le **moindre privilège est PROUVÉ par test** (`42501` sur ce que le worker ne doit **pas** pouvoir faire — p.ex. écrire les tables d'authentification). Le **déploiement effectif** (provisioning des secrets, création du rôle en prod) reste **item Xavier** — documenté.
3. **Endpoint de re-résolution manuelle d'`ambiguous`** (solde F-2/3.4) — une facture au routage `ambiguous` n'a **aucun chemin de sortie automatique** (limite héritée 3.3, explicitée 3.4). On ajoute un **endpoint opérateur dual-auth**, **miroir exact** du précédent `POST /ereporting/retransmissions` (la mutation dual-auth la plus récente), qui **réutilise `resolveAndRecord` tel quel** (idempotent par construction) après **nettoyage opérateur de l'annuaire**. Garde : la facture **doit** être `ambiguous`.

**Architecture :** On **réutilise le socle 1.x/2.x/3.x** exactement comme les plans précédents. Tout vit **entièrement dans `apps/api`** ; **`packages/invoice-core` n'est PAS touché**. Le `ConsentSignaturePort` **réplique le squelette port** (contrat → impl locale write-once → module `@Global` env-switchable) des 4 instances existantes (Archive 2.2, Flux10 2.3, Annuaire 2.4, CDV 3.1) et **branche sa vérification au gate de consentement réel** sans dupliquer de logique. Le rôle worker **calque** la mécanique de moindre privilège de `factelec_app` (rôle ≠ propriétaire, `NOBYPASSRLS`, `NOSUPERUSER`) restreinte à l'inventaire. L'endpoint de re-résolution **calque verbatim** le stack dual-auth de `EreportingController` (`TenantAuthGuard` + `RolesGuard` + `CsrfGuard`, motif `PaymentsController.capture`) et **réutilise `resolveAndRecord`**.

**Tech Stack :** **Aucune dépendance runtime ajoutée.** Crypto : `node:crypto` (`createHash('sha256')`, déjà utilisé par les 4 stores locaux et le scellement 2.2 — **aucun** `sign`/`verify` réel : la vérification qualifiée eIDAS est un **driver différé**). Persistance : drizzle + `pg` (déjà présents). HTTP : `zod` inline + `@nestjs/common` (déjà présents). File/worker : **BullMQ 5.80.x** (déjà présent — inchangé). Tests : **Vitest 4.1.10** (déjà présent — split `heavy`/`light` de 3.3 respecté). `docker-compose`/`scripts/db-init` : **une entrée de rôle worker ajoutée** (création du rôle en dev — miroir de `factelec_app`).

## Global Constraints

Reprises **verbatim** du socle 1.x/2.x/3.x (non négociables) — chaque tâche en hérite implicitement :

- **TDD strict RED/GREEN** : test écrit et vu échouer avant toute implémentation ; aucun merge si un test échoue. Un commit minimum par tâche, message en **français**, **sans** trailer `Co-Authored-By: Claude` ni mention Claude ; commits au seul nom de l'utilisateur. `pnpm format` avant chaque commit.
- **Couverture bloquante** : **≥ 90 %** (lines/functions/statements/branches) maintenue en **agrégat heavy+light** sur `apps/api` et `apps/web`. **`packages/invoice-core` N'EST PAS touché** ce plan (il se tient à **100 %×4** ; ne pas régresser). Exclusions de couverture `apps/api` conservées (`src/main.ts`, `src/worker-main.ts`, `**/*.module.ts`, `src/db/migrations/**`). **Tout module pur** (scellement/vérification de signature, garde de re-résolution) visé **100 %** par des tests déterministes (**aucun `Date.now()` dans la logique pure** ; `now`/`hash` injectés ou vérifiés par oracle indépendant).
- **e2e sur Postgres réel (Testcontainers)** pour toute table/endpoint/rôle DB ; **Redis réel** pour tout flux worker/scheduler ; **tests d'isolation multi-tenant explicites**. **Motifs de stabilité e2e OBLIGATOIRES** (1.4/2.x/3.x) : `listenOnce`, `maxWorkers`/projet dédié borné, `withStartupTimeout(120_000)`, `hookTimeout(150_000)`, polling `waitFor` borné (jamais de sleep fixe), aucun affaiblissement de l'hermétisme. **VERROU D'ARCHITECTURE (3.3 T7 NIT-1, BINDING)** : toute nouvelle suite e2e démarrant un Worker BullMQ (`createTestWorker(`) **DOIT** être ajoutée à `HEAVY_TESTS` (`vitest.config.ts`) — sinon `tests/unit/heavy-suites.arch.test.ts` échoue (invariant `{ suites createTestWorker } ≡ HEAVY_TESTS`, égalité stricte).
- **VERROU D'ARCHITECTURE apiKeyId (3.3 T6, BINDING)** : `tests/unit/*apikey*.arch.test.ts` verrouille les **poseurs/lecteurs** de `req.apiKeyId` (2 poseurs `api-key.guard`/`tenant-auth.guard`, 2 lecteurs `roles.guard`/`csrf.guard`, liste blanche, morsure prouvée). Un nouvel endpoint dual-auth **n'ajoute ni poseur ni lecteur** (il **consomme** les gardes existants) — l'invariant reste vert **sans modification**. Le garde composé `DualAuthMutationGuard` **reste différé** (D-décision dédiée ci-dessous).
- **Sécurité OWASP** : validation de toute entrée (zod), authz systématique (**dual-auth** sur l'endpoint de re-résolution : `TenantAuthGuard` + `RolesGuard` + `CsrfGuard`, motif `PaymentsController.capture`/`EreportingController`). **Aucune donnée sensible hors des frontières tenant** : toute lecture/écriture métier sous RLS. Erreurs normalisées **RFC 9457 `application/problem+json`**. **404 anti-fuite byte-identique** : facture inconnue / cross-tenant indiscernables (motif `EreportingController.notFound`).
- **Moindre privilège Postgres — étendu ce plan** : `factelec_app` ≠ propriétaire, **sans `BYPASSRLS`, sans superuser** (**inchangé**). **NOUVEAU** rôle `factelec_worker` **également** ≠ propriétaire, `NOBYPASSRLS`, `NOSUPERUSER`, **GRANTs restreints à l'inventaire réel des accès worker** (moindre privilège **prouvé** par `42501` sur les tables interdites). **Aucun rate-limit inventé** (aucun motif projet — dette listée si utile).
- **TypeScript `strict: true`, ESM, NodeNext, Node ≥ 22.** `typescript` pinné **exactement `7.0.2`** (racine, tsgo). Repli local `typescript@5.9.x` du seul workspace concerné autorisé et documenté si un typecheck bute — sans toucher le pin racine.
- **Dépendances pinnées exactement, dernière stable, licence.** **`pnpm run audit:ci` 0 vulnérabilité** et **`pnpm outdated -r` vierge** restent **bloquants** en CI. **Aucune dépendance ajoutée** → objectif mécaniquement tenu (vérifier néanmoins à **chaque** tâche).
- **`@factelec/invoice-core` consommé via son exports map** (barrel `.` unique), jamais par chemin relatif. `docs/reference/` et `docs/reglementaire/` en **lecture seule** (aucun XSD copié/modifié). **Nomenclatures normatives en lecture seule** (jamais altérées).
- Identifiants de code en **anglais** ; commentaires/commits/docs en **français**.
- **Oracles de test indépendants (anti-tautologie)** : ne jamais asserter un comportement en le comparant à sa propre implémentation ; les vecteurs viennent d'une source distincte du code testé (ex. hash de scellement recalculé par un `createHash` **du test** sur des octets connus, pas relu de l'impl ; `42501` prouvé en rôle worker RÉEL, pas mocké).

---

## Périmètre : retenu en 3.5 vs reporté

**Retenu (ce plan) :**
1. **`ConsentSignaturePort` — 5e instance du motif port** : contrat (`seal`/`verify`) + impl locale (scellement structurel write-once : `sha256` d'une forme canonique injection-proof + horodatage + `flag:'wx'` + `chmod 0o444`, motif exact des 4 stores locaux + `ledger-hash.ts`) + factory `@Global` env-switchable (`CONSENT_DRIVER` allowlist `local`, **throw** testé sur tout driver eIDAS réel) ; branchée au **gate de consentement réel** (création de consentement, `annuaire-publication.service.ts`). Persistance : `evidence_ref` devient le **sceau** (référence vérifiable), aucune nouvelle table/colonne (**Tasks 1/2**, D2/D3).
2. **Worker-role split** : rôle `factelec_worker` moindre-privilège dérivé de l'**inventaire réel** des accès worker ; GRANTs restreints (migration) + pool/env dédié (`DATABASE_URL_WORKER`) ; moindre privilège **prouvé** par `42501` (**Task 3**, D4/D5).
3. **Endpoint de re-résolution `ambiguous`** : `POST` opérateur dual-auth, miroir `POST /ereporting/retransmissions`, réutilise `resolveAndRecord` ; garde `ambiguous`-only (**Task 4**, D6).
4. **Docs / runbook (e-signature honnête + procédure de nettoyage annuaire→re-résolution + note déploiement rôle worker) / OpenAPI / README / bump `0.11.0`** (**Task 5**).

**Reporté (acté ici, justifié en D\*) — différés 3.6+ :**
- **Fournisseurs de signature qualifiée eIDAS réels** (drivers `CONSENT_DRIVER` non-`local`) : décisions crypto + fournisseur externe (item Xavier). Le contrat + le throw testé posent la couture ; aucune vérification cryptographique réelle livrée. Différé.
- **Déploiement effectif du rôle worker** : provisioning des secrets, création du rôle `factelec_worker` en prod, rotation. Le code (grants + pool/env + preuve) est livré ; le déploiement reste **item Xavier**. Différé, documenté.
- **Révocation de consentement (endpoint / service)** : la colonne `revoked_at` existe (grant UPDATE présent) et le gate la respecte déjà (`revoked_at IS NULL`) ; aucun chemin applicatif ne révoque encore. Hors périmètre 3.5 (le plan livre la **preuve** à la création, pas la gestion du cycle de révocation). Différé.
- **Garde composé `DualAuthMutationGuard`** : **REFUSÉ ce plan** (D7) — son unique rationale (footgun `apiKeyId`) est **déjà purgé** par le test d'architecture 3.3-T6 (poseurs/lecteurs asservis, morsure prouvée) ; la 2e route dual-auth réelle (3.4 `retransmissions`) a déjà retenu le triple manuel `@UseGuards(TenantAuthGuard, RolesGuard, CsrfGuard)`. Réexaminable si une 4e+ route dual-auth rend la duplication coûteuse.
- **Transition `emise`/transport réel**, **backoff persistant du sweep routage**, **POST codes-routage** : inchangés (différés hérités 2.3/3.3/3.4).

---

## Décisions structurantes (à lire avant d'exécuter)

### D1 — Trois axes internes, aucune extraction réglementaire nouvelle ; posture « aucune fabrication »
- **Cadrage contrôleur BINDING (ledger, DÉCISION PÉRIMÈTRE 3.5)** : « consentement probant & séparation des rôles » = (1) e-signature du consentement en **motif port établi**, (2) worker-role split **côté code**, (3) endpoint de re-résolution `ambiguous` (solde F-2/3.4). Le consentement 2.4 a **déjà** ses références réglementaires (Flux 13 §3.5.5.5) — **aucune** extraction primaire nouvelle.
- **Posture (arbitrages contrôleur 3.5, BINDING)** : (a) e-signature = **AUCUNE prétention juridique fabriquée** — l'impl locale fait du **scellement STRUCTUREL** (intégrité + horodatage + non-réécriture), le **contrat** porte la vérification, les fournisseurs eIDAS réels sont des **drivers différés** (throw testé) ; la doc dit **exactement** ce que ça fait, **jamais** « valeur probante » sans qualification. (b) Rôle worker = permissions dérivées de l'**inventaire RÉEL** table par table, moindre privilège **prouvé** (`42501`). (c) **AUCUN rate-limit inventé** (aucun motif projet). (d) Re-résolution = **miroir** du `POST /ereporting/retransmissions` (mutation dual-auth la plus récente).

### D2 — `ConsentSignaturePort` = 5e instance du motif port (contrat + impl locale write-once + factory @Global throw)
- **État vérifié in situ** : le motif port est répliqué **4 fois à l'identique** (Archive 2.2 `ARCHIVE_STORE`, Flux10 2.3 `FLUX10_TRANSMISSION`, Annuaire 2.4 `ANNUAIRE_TRANSPORT`, CDV 3.1 `CDV_TRANSMISSION`). Chaque instance = **3 fichiers** (`*.port.ts` contrat + token `Symbol`, `local-filesystem-*-store.ts` impl write-once, `*.module.ts` `@Global` factory env-switchable) + **2 lignes env** + **1 test de branche throw**. Le consentement porte **aujourd'hui zéro crypto** (les champs `signer_identity`/`evidence_ref`/`obtained_at` sont écrits **verbatim** depuis le client par `insertConsent`, `annuaire.repository.ts:199-221` — placeholder confirmé).
- **Retenu — réplique EXACTE du squelette (modèle le plus récent : CDV 3.1)** :
  - **Contrat** `apps/api/src/annuaire/consent-signature.port.ts` : `export const CONSENT_SIGNATURE = Symbol('CONSENT_SIGNATURE')` ; interface `ConsentSignaturePort { seal(payload: ConsentSealPayload): Promise<ConsentSealResult>; verify(sealRef: string): Promise<ConsentSealStatus> }` (miroir `transmit`/`status`). `ConsentSealPayload = { tenantId, siren, siret?, routageId?, suffixe?, consentType, signerIdentity, evidenceRef, obtainedAt }` (la maille + la preuve déclarée). `ConsentSealResult = { sealRef: string; location: string; sealedAt: string; alreadyExisted: boolean }`. `ConsentSealStatus = { sealRef: string; outcome: 'sealed' }`. Erreur custom `ConsentSignatureRejectedError(readonly reason: string)` `extends Error` (`super`, `this.name`, **sans** `Object.setPrototypeOf`, motif exact des 4 ports).
  - **Impl locale** `apps/api/src/annuaire/local-filesystem-consent-store.ts` (`LocalFilesystemConsentStore implements ConsentSignaturePort`, `constructor(private readonly baseDir: string)`) : `SAFE_KEY` regex + `resolve()` (rejette traversal → `InvalidConsentKeyError` déclarée dans l'impl, motif `InvalidTransmissionKeyError`), **forme canonique injection-proof** des champs de preuve (encodage longueur-préfixé `` `${Buffer.byteLength(v,'utf8')}|${v}` ``, ordre FIGÉ, motif `ledger-hash.ts:33-50`) + **horodatage** `sealedAt` (format `AAAAMMJJHHMMSS` UTC, motif `horodateNow()`, **injecté** en test — pas de `Date.now()` dans la logique pure), `sealRef = sha256Hex(canonical)` ; **write-once** : `stat`→`existingResult` / `mkdir` / `writeFile(path, canonical, {flag:'wx', encoding:'utf8'})` / `catch EEXIST`→`existingResult` (idempotence : renvoie le sceau **gagnant**) / `chmod 0o444`. `verify(sealRef)` relit le fichier, **recalcule** `sha256Hex` et **confirme `=== sealRef`** (contrôle d'intégrité réel) → `{ sealRef, outcome:'sealed' }`.
  - **Module `@Global`** `apps/api/src/annuaire/consent-signature.module.ts` : factory `inject:[ConfigService]`, `driver = config.get('CONSENT_DRIVER', {infer:true})` ; **`if (driver==='local') return new LocalFilesystemConsentStore(config.get('CONSENT_LOCAL_DIR'…)); throw new Error(\`fournisseur de signature de consentement '${driver}' activé au déploiement (non fourni en 3.5)\`)`** (forme allowlist-local, la plus robuste). Provider `{ provide: CONSENT_SIGNATURE, useFactory, inject }`, `exports:[CONSENT_SIGNATURE]`. **Importé par `AnnuaireModule`** (motif `AnnuaireModule` → `AnnuaireTransportModule`, `annuaire.module.ts:22`) — HTTP seul (la création de consentement est HTTP, `POST /annuaire/lignes`) ⇒ **aucun** worker, **aucun** impact `HEAVY_TESTS`.
  - **Env** `apps/api/src/config/env.ts` : `CONSENT_DRIVER: z.enum(['local','eidas']).default('local')` + `CONSENT_LOCAL_DIR: z.string().default('./var/consent')` (2 lignes, motif bloc CDV `env.ts:185-188`). `eidas` = placeholder du/des driver(s) réel(s) différé(s).
  - **Test throw** `apps/api/tests/unit/consent-signature.module.test.ts` : extraction de la factory via `Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ConsentSignatureModule)` + `fakeConfig` (motif `cdv-transmission.module.test.ts`) ; `local` → `toBeInstanceOf(LocalFilesystemConsentStore)` ; `it.each(['eidas'])` → `toThrow(/activé au déploiement \(non fourni en 3\.5\)/)`.

### D3 — Point d'insertion : scellement à la CRÉATION du consentement (gate 422) ; `evidence_ref` = sceau ; AUCUNE prétention juridique
- **État vérifié in situ (séquence réelle)** : `POST /annuaire/lignes` → `AnnuairePublicationService.publishLigne` (`annuaire-publication.service.ts:172`) → **gate** `resolveConsent(tenantId, maille, input)` (l.179). La branche `proof` (l.163-165) est l'**UNIQUE** point où `signerIdentity`/`evidenceRef`/`obtainedAt` franchissent la frontière client→DB, via `repo.insertConsent` (l.199-221, écriture **verbatim, sans vérification**). Les chemins `consentId` (l.146-161) et auto-découverte (l.167) consomment un consentement **déjà persisté** : aucune `proof` fraîche, rien à vérifier — seulement couverture (`coversTarget`) + non-révocation (`revokedAt IS NULL`). Le canal d'échec est `ConsentRequiredError` (l.37-44) → **422** (`annuaire.controller.ts:216-223`).
- **Retenu** : la vérification/scellement s'insère **à la création du consentement**, dans la branche `proof` de `resolveConsent`, **avant** `insertConsent`. Séquence : `const seal = await this.consentSignature.seal({ ...maille, ...input.proof })` → si le driver **throw** (`ConsentSignatureRejectedError` ou throw factory des drivers réels) la publication **échoue** (la ligne n'est **pas** créée) via une **erreur sœur `ConsentSignatureError` mappée au MÊME 422** que `ConsentRequiredError` (`annuaire.controller.ts:mapPublicationError`) ; sinon `insertConsent(tenantId, { ...maille, consentType, signerIdentity, obtainedAt, evidenceRef: seal.sealRef })` — **`evidence_ref` stocke désormais le SCEAU** (référence `sha256` vérifiable de la preuve canonique write-once), pas la chaîne client brute non vérifiée. **Aucune nouvelle table ni colonne** : `evidence_ref` (déjà `notNull text`, jamais lu par aucune logique — placeholder) est **repurposé** en pointeur de sceau ; `obtained_at` reste l'horodatage de signature déclaré ; `created_at` ≈ `sealedAt` (horodatage de scellement, aussi gravé dans le fichier WORM). L'`evidenceRef` client d'origine est **conservé dans le contenu scellé** (WORM), donc non perdu.
- **Justification du point (contre le cycle réel)** : (1) vérifier **une seule fois**, au franchissement de frontière, empêche qu'un consentement à preuve non scellée devienne ensuite « couvrant » et trompe `findActiveConsent` ; (2) les chemins `consentId`/auto-découverte **héritent** d'une preuve déjà scellée sans re-crypto par publication (le gate reste un simple contrôle couverture/révocation — **inchangé**) ; (3) si un endpoint autonome de création de consentement est ajouté plus tard (absent aujourd'hui), la vérification s'y déplacerait naturellement sans toucher le gate. La création étant **fusionnée** dans `publishLigne`, une preuve non scellable = **échec de publication** (422), sémantique cohérente avec le gate existant.
- **Posture d'honnêteté (BINDING)** : le driver `local` **ne vérifie AUCUNE signature cryptographique** — il **scelle** la preuve déclarée (intégrité `sha256` + horodatage + non-réécriture WORM) et en atteste l'immutabilité. La doc (Task 5) et les commentaires disent **exactement** cela ; **jamais** « valeur probante », « signature qualifiée » ni « eIDAS » côté `local`. La vérification cryptographique qualifiée est le rôle **explicite** des drivers réels différés (throw testé). **Oracle indépendant** : le test recalcule `sha256` sur les octets canoniques **connus** (pas relu de l'impl) et prouve l'idempotence write-once (2e `seal` de la même preuve → `alreadyExisted:true`, même `sealRef`).

### D4 — Rôle `factelec_worker` moindre-privilège dérivé de l'inventaire RÉEL ; policies RLS déjà `TO PUBLIC` (aucune policy nouvelle)
- **Inventaire vérifié in situ (le worker bootstrape `WorkerModule`, jamais `AppModule` — `worker-main.ts:10`)** — matrice d'accès table-par-table des 5 processors + sweeps/services câblés dans `WorkerModule` :

  | Table | Accès worker RÉEL | GRANT `factelec_worker` |
  |---|---|---|
  | `invoices` | SELECT (`loadCanonical`/`findRoutingState`/`invoicesForPeriod`), UPDATE (`markGenerationStatus`/`completeGeneration`/`bumpReconcileAttempts`/`markArchiveStatus`/`markRoutingStatus`) — **jamais INSERT/DELETE** | **SELECT, UPDATE** |
  | `invoice_formats` | SELECT + DELETE+INSERT (`completeGeneration`) | **SELECT, INSERT, DELETE** |
  | `invoice_status_events` | **SELECT seul** (`loadSealedEventsByInvoice`) — n'INSÈRE jamais ⇒ le trigger `seal_status_event` **ne s'exécute jamais** côté worker | **SELECT** |
  | `invoice_dead_letters` | INSERT seul (`recordDeadLetter`) | **INSERT** |
  | `ereporting_declarants` | SELECT seul (`findDeclarant`) | **SELECT** |
  | `ereporting_transmissions` | SELECT+INSERT+UPDATE | **SELECT, INSERT, UPDATE** |
  | `ereporting_status_events` | INSERT seul | **INSERT** |
  | `annuaire_lignes` | SELECT+UPDATE (`republishDraft`) — jamais INSERT | **SELECT, UPDATE** |
  | `annuaire_ligne_events` | INSERT seul | **INSERT** |
  | `annuaire_directory_entries` | SELECT+INSERT+UPDATE+DELETE (sync) | **SELECT, INSERT, UPDATE, DELETE** |
  | `cdv_transmissions` | SELECT+INSERT+UPDATE | **SELECT, INSERT, UPDATE** |
  | `cdv_transmission_events` | INSERT seul | **INSERT** |
  | `payments` | SELECT seul (`listPaymentsForPeriod`) | **SELECT** |
  | `payment_subtotals` | SELECT seul (`attachSubtotals`) | **SELECT** |
  | `tenants`, `api_keys`, `users`, `platform_admins`, `sessions`, `annuaire_consents` | **AUCUN accès table** (contexte RLS via GUC seulement ; `sessions` purgées via SD) | **AUCUN (refus explicite prouvé `42501`)** |

- **Fonctions SD** : `factelec_worker` reçoit `GRANT EXECUTE` sur les **9 seules** SD réellement appelées par le worker : `find_stuck_generation_invoices`, `purge_expired_sessions`, `find_failed_archives`, `find_ereporting_declarants_due`, `find_annuaire_sync_targets`, `find_stale_annuaire_drafts`, `find_cdv_transmissions_due`, `find_parked_cdv_transmissions`, `find_pending_routing_invoices`. **JAMAIS** les 8 SD d'auth/session/admin (`authenticate_api_key`/`authenticate_user`/`authenticate_platform_admin`/`signup_tenant`/`create_session`/`find_session`/`revoke_session`/`list_tenants_for_admin`) ni `find_stuck_received_invoices` (superseded, jamais appelée). Refus `EXECUTE authenticate_api_key` **prouvé `42501`**.
- **RLS déjà couverte (vérifié)** : toutes les policies `tenant_isolation`/`tenant_self` sont créées **SANS clause `TO`** (`0001_roles_rls.sql:26-41`, idem 0003/0008/0015/0017/0019/…) ⇒ elles s'appliquent à **PUBLIC**, donc à `factelec_worker` **automatiquement**. `factelec_worker` est `NOBYPASSRLS` (comme `factelec_app`) ⇒ soumis à `FORCE ROW LEVEL SECURITY`. **AUCUNE nouvelle policy n'est requise** — le split est **purement GRANTs**. Les sweeps cross-tenant restent servis par les SD `SECURITY DEFINER` (owner, `BYPASSRLS`), inchangées.
- **Retenu** : création du rôle dans `apps/api/scripts/db-init/00-roles.sql` (motif EXACT `factelec_app` : `DO $$ IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='factelec_worker') THEN CREATE ROLE factelec_worker LOGIN PASSWORD 'worker_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB; END IF; END $$;` — dev/test) ; **migration 0029** (hand-written, motif 0001/0019, `_journal` idx 29, **aucun** snapshot schéma — grants seuls) : `GRANT USAGE ON SCHEMA public TO factelec_worker` + les GRANTs table de la matrice + `GRANT EXECUTE` sur les 9 SD. La migration **assume l'existence** du rôle (motif 0001 pour `factelec_app` : rôle créé par `db-init` en dev/test, par le provisioning en prod). **Aucune** nouvelle table, colonne, policy.

### D5 — Split pool/env (`DbModule.forRoot` + `DATABASE_URL_WORKER`) ; moindre privilège PROUVÉ (`42501` + suites worker sous le rôle) ; déploiement différé
- **État vérifié** : **UN SEUL** `DATABASE_URL` (`env.ts:23`, `z.url()`) et **UN SEUL** pool `APP_POOL` (`DbModule` `@Global`, `client.ts:8-9`, `max:10`) sont partagés par l'API (`AppModule`) **et** le worker (`WorkerModule`) — donc **le même rôle `factelec_app`**. Aucune notion de pool/rôle worker aujourd'hui.
- **Retenu — split par le point de bootstrap (les deux process sont disjoints)** : `DbModule` gagne un `static forRoot(urlEnvKey: 'DATABASE_URL' | 'DATABASE_URL_WORKER')` (`@Global`) qui fournit `APP_POOL` depuis la clé env choisie + `TenantContextService` (inchangé). `AppModule` importe `DbModule.forRoot('DATABASE_URL')` (API = `factelec_app`, **inchangé**) ; `WorkerModule` importe `DbModule.forRoot('DATABASE_URL_WORKER')` (worker = `factelec_worker`). **Aucun conflit runtime** : `main.ts` bootstrape l'arbre `AppModule`, `worker-main.ts` l'arbre `WorkerModule` — jamais les deux dans un même process ⇒ **un seul pool/rôle par process**. `env.ts` : `DATABASE_URL_WORKER: z.url()` (nouvelle var). **GARDE** : vérifier qu'aucun feature module ne réimporte `DbModule` avec l'ancienne signature (repli sur l'export `@Global` — inchangé).
- **Moindre privilège PROUVÉ (double preuve, oracles indépendants)** :
  - **Minimalité** — test e2e dédié `worker-role-least-privilege.e2e.test.ts` (Postgres réel, **LIGHT** — aucun Worker BullMQ, pool `pg` brut connecté **en `factelec_worker`**) : contrôles **positifs** (`SELECT`/`UPDATE invoices` OK, `EXECUTE find_pending_routing_invoices` OK) **et** contrôles **négatifs `42501`** (`INSERT api_keys`, `UPDATE users`, `SELECT sessions`, `INSERT annuaire_consents`, `SELECT tenants`, `EXECUTE authenticate_api_key`). Oracle indépendant : les vecteurs interdits viennent de la **matrice d'inventaire** (D4), pas du code de grant.
  - **Suffisance** — **toutes les suites e2e worker existantes** (HEAVY : `ereporting-generation`, `ereporting-payments`, `ereporting-sweep`, `ereporting-retransmission`, `annuaire-sync`, `cdv-transmission-sweep`, `async-generation`, `archive-generation`, `routing-retry`, `invoice-routing` (**amendement N1** : oubliée de l'énumération initiale — elle bootstrape aussi un worker), + `session-purge`) tournent désormais **sous `factelec_worker`** (leur `createTestWorker` bootstrape `WorkerModule` → `DATABASE_URL_WORKER`) : si un GRANT manque, elles **échouent `42501`** ⇒ la suite verte **prouve** que le jeu de grants est **suffisant**. Le harnais de test (`createTestWorker` / env e2e) doit **poser `DATABASE_URL_WORKER`** vers `factelec_worker`. **Aucune nouvelle suite HEAVY** n'est ajoutée (le verrou `heavy-suites.arch` reste vert).

> **AMENDEMENT B1 (revue du plan, BLOCKER corrigé — BINDING)** : la prémisse initiale « les conteneurs appliquent déjà 00-roles.sql » est **FAUSSE** en e2e : `tests/e2e/helpers/postgres.ts` crée les rôles INLINE (owner + app SEULEMENT) puis `migrate()` applique TOUTES les migrations — la 0029 (`GRANT … TO factelec_worker`) échouerait dans CHAQUE e2e. Correctif OBLIGATOIRE (Task 3, AVANT la migration) : (a) créer `factelec_worker` inline dans `postgres.ts` (même DO $$ IF NOT EXISTS, AVANT `migrate()`) ; (b) exposer `workerUrl` sur `TestDb` ; (c) brancher `createTestWorker` sur `workerUrl` (il hardcode aujourd'hui `appUrl`) ; (d) `createTestApp` RESTE sur `appUrl`/factelec_app (les seeds échoueraient 42501 sous le rôle worker).
- **Déploiement différé (item Xavier, documenté)** : provisioning du rôle `factelec_worker` en prod (création + mot de passe/secret + `DATABASE_URL_WORKER`), rotation. Le **code** (grants + `forRoot` + preuve) est livré ; la création du rôle en prod **précède** la migration 0029 (motif `factelec_app`). Runbook Task 5.

### D6 — Endpoint de re-résolution `ambiguous` : miroir `POST /ereporting/retransmissions`, dual-auth, `ambiguous`-only, `resolveAndRecord` réutilisé, 200 synchrone
- **État vérifié in situ** : `resolveAndRecord(tenantId, invoiceId, invoice): Promise<void>` (`recipient-routing.service.ts:55-113`) est **best-effort STRICT** (try/catch total, **ne relève JAMAIS**, miroir `ArchiveService.archiveInvoice`), **relit l'annuaire à CHAQUE appel** (l.63-67) et écrit via `markRoutingStatus` **sans CAS ni condition de statut** (`invoices.repository.ts:487-503`) → **sûr à rappeler sur n'importe quel statut** (« idempotent par construction » à annuaire constant). Le **sweep 3.4** balaie **déjà** `pending`+`unaddressable` et **EXCLUT délibérément `ambiguous`** (`recipient-routing-retry.service.ts:23-24`, SD `find_pending_routing_invoices` 0028) — car `ambiguous` = ambiguïté **structurelle** de l'annuaire exigeant un **nettoyage opérateur** (`recipient-routing.service.ts:34-36`). `findRoutingState(tenantId, invoiceId)` (`invoices.repository.ts:505-523`) relit `{status, platform}` sous RLS (`null` si inconnue/cross-tenant). `loadCanonical` (l.160-172) recharge le canonical.
- **Retenu — garde `ambiguous`-only (miroir exact du 404/409 de `retransmit`)** : nouvel endpoint `@Post('invoices/:id/routing/resolve')` sur `InvoicesController` (le routage est une **métadonnée de facture** `invoices.routing_status`, pas une entité e-reporting — l'action cible un `:id` d'invoice, `resolveAndRecord`/`loadCanonical`/`findRoutingState` sont **tous** côté invoices). Logique (dans `InvoicesService.resolveRouting(tenantId, id)`, motif service→garde) : (1) `if (!isUuid(id)) throw notFound()` (404 anti-fuite, motif `invoices.service.ts:143`) ; (2) `state = findRoutingState(...)` → `null` ⇒ **404 byte-identique** (inconnue/cross-tenant indiscernables) ; (3) `state.status !== 'ambiguous'` ⇒ **409** (« routing not in ambiguous state » — miroir exact du 409 `noRectifiableInitialTransmission` de `retransmit`, restreint l'admission comme le 409 sur `status==='prepared'`) ; (4) `invoice = loadCanonical(...)` → `null` ⇒ 404 (défensif) ; (5) `await routing.resolveAndRecord(tenantId, id, invoice)` **verbatim** ; (6) `next = findRoutingState(...)` → retour `{ invoiceId: id, routingStatus: next.status, recipientPlatform: next.platform }`.
- **Dual-auth (motif exact `EreportingController.retransmit` / `PaymentsController.capture`)** : `@UseGuards(TenantAuthGuard, RolesGuard, CsrfGuard)` + `@Roles('owner','admin','accountant')`. `TenantAuthGuard` accepte **clé API OU session** ; `RolesGuard`/`CsrfGuard` **bypassent sur `req.apiKeyId`** (clé API) et n'imposent rôle/CSRF qu'en session. **N'ajoute NI poseur NI lecteur de `apiKeyId`** ⇒ verrou d'archi 3.3-T6 **vert sans modification**.
- **200 SYNCHRONE (divergence justifiée du miroir 202)** : `retransmit` renvoie **202** car il **enfile** une génération lourde (BullMQ) ; la re-résolution est un **appel DIRECT léger** (une lecture annuaire + un `UPDATE`), **best-effort**, sans file — donc **`@HttpCode(200)`** et retour **synchrone** de l'état résultant. Comme `resolveAndRecord` ne relève jamais, l'endpoint **rapporte honnêtement** le statut obtenu : `resolved` (nettoyage réussi), ou encore `ambiguous`/`unaddressable` si l'annuaire n'a pas été (suffisamment) nettoyé — **aucune promesse fabriquée** de succès.
- **Câblage (état vérifié — coût à prévoir)** : `RecipientRoutingService` (+ sa dépendance `AnnuaireConsultationService`) et `CsrfGuard` **ne sont PAS** dans `InvoicesModule` aujourd'hui (`invoices.module.ts:13-21` : `RecipientRoutingService` vit dans `worker.module.ts:74`) ; `TenantAuthGuard`/`RolesGuard`/`InvoicesRepository` y **sont déjà**. **Retenu** : fournir `RecipientRoutingService` + `CsrfGuard` dans `InvoicesModule`, importer `AnnuaireModule` pour `AnnuaireConsultationService` — **GARDE anti-cycle** : vérifier qu'`AnnuaireModule` **exporte** `AnnuaireConsultationService` et **n'importe pas** `InvoicesModule` (sinon `forwardRef` ou petit module de routage partagé). L'e2e de l'endpoint **ne démarre PAS de Worker** (appel direct) ⇒ suite **LIGHT** (aucun impact `HEAVY_TESTS`).

### D7 — Garde composé `DualAuthMutationGuard` : REFUSÉ ce plan (rationale)
- **Historique vérifié (ledger + code)** : la note « garde composé OU test d'archi sur les poseurs d'`apiKeyId` » naît en **3.2** (revue finale, footgun : le bypass `if (req.apiKeyId) return true` est un invariant **implicite** partagé par `RolesGuard`/`CsrfGuard`). **3.3-D9/T6** a **choisi le test d'architecture** (`apikeyid-setters.arch.test.ts` : 2 poseurs `api-key.guard`/`tenant-auth.guard`, 2 lecteurs `roles.guard`/`csrf.guard`, liste blanche, **morsure reproduite** par le relecteur). **3.4** a ajouté la **2e route dual-auth réelle** (`POST /ereporting/retransmissions`) en retenant le **triple manuel** `@UseGuards(TenantAuthGuard, RolesGuard, CsrfGuard)` — **sans** construire le garde composé. Le ledger le liste **DIFFÉRÉ** pour 3.5 (« garde composé DualAuthMutationGuard à la 2e route »).
- **Jugement (BINDING, tranché par l'architecte)** : **REFUSÉ ce plan.** Rationale : (1) l'**unique** rationale du garde composé — le footgun `apiKeyId` — est **déjà purgé** par le test d'archi 3.3-T6 (invariant **structurel** prouvé), donc le garde composé n'apporte **aucune** sécurité supplémentaire ; (2) le nouvel endpoint (D6) **réutilise verbatim** le triple déjà éprouvé sur `payments` + `ereporting` (3 routes cohérentes, motif idiomatique NestJS) et **n'ajoute ni poseur ni lecteur** d'`apiKeyId` ⇒ le verrou reste vert **sans toucher au code d'auth** ; (3) composer les 3 gardes en un seul introduirait de la **complexité DI** (instanciation/ordre) et un **churn de revue** sur du code d'auth **déjà mergé et audité**, pour un gain purement **DRY** et **zéro capacité nouvelle** — contraire à la posture « surface minimale, aucune fabrication » ; (4) la **condition déclenchante** invoquée (« 2e route ») a déjà été **franchie et déclinée** en 3.4. **Réexaminable** seulement si une **4e+** route dual-auth rend la répétition du triple réellement coûteuse. **Dette listée** aux différés.

> **AMENDEMENT M1 (revue du plan, BINDING — ratification du refus AMENDÉE en voie médiane)** : le point (1) de la rationale ci-dessus SUR-AFFIRME — le verrou 3.3-T6 se déclare LUI-MÊME « ralentisseur, pas asservissement » et n'asserte RIEN sur la COMPOSITION des guards d'une route. Le résidu bénin (mésordre → fail-CLOSED 403) est acceptable ; le résidu GRAVE ne l'est pas : une future route dual-auth session qui OMET CsrfGuard = fail-OPEN CSRF silencieux. Le refus du garde composé est RATIFIÉ (triple verbatim, 0 poseur/lecteur ajouté), MAIS la Task 4 DOIT étendre le test d'architecture : un nouveau describe (même fichier apikeyid-setters.arch.test.ts ou fichier frère) qui scanne les contrôleurs et asserte que TOUTE route composant `TenantAuthGuard` avec un décorateur de MUTATION (@Post/@Put/@Delete) compose AUSSI `RolesGuard` ET `CsrfGuard`, TenantAuthGuard en tête. Ralentisseur honnête (commentaire M3-style), matché sur les formes @UseGuards réelles du projet. La rationale « footgun purgé » est REQUALIFIÉE : « footgun ralenti, résidu de composition couvert par l'extension M1 ».

### D8 — Une migration (grants worker) seule ; aucune table, colonne, policy, enum ; bump `0.11.0`
- **0029** (`0029_worker_role_grants.sql`, **hand-written**, motif 0001/0019 — **PAS** dérivée du schéma, `db:generate` **non utilisé** ce plan) : `GRANT USAGE ON SCHEMA public TO factelec_worker` + les GRANTs table de la matrice D4 + `GRANT EXECUTE` sur les 9 SD worker. `_journal` idx 29 (`when` ~+100000 après 0028) ; **aucun** snapshot schéma (grants n'altèrent pas le schéma drizzle). **Relire** : SEULEMENT des `GRANT`, aucun `CREATE TABLE`/`ALTER TABLE`/`CREATE POLICY`.
- **Aucune nouvelle table/colonne** : l'e-signature **repurpose** `annuaire_consents.evidence_ref` (D3) ; le worker-split est **grants seuls** (D4) ; l'endpoint de re-résolution **réutilise** `invoices.routing_status` (D6). **Aucun** `nomenclature.ts`/enum touché.
- **Migration max avant ce plan = 0028** ; ce plan produit **uniquement 0029**. Le rôle `factelec_worker` est créé dans `scripts/db-init/00-roles.sql` (dev/test) — **pas** une migration.
- **Bump `apps/api` 0.10.0 → 0.11.0** (Task 5) ; `invoice-core` **reste 0.4.0** (non touché).

### D9 — Rappel des différés & posture « aucune fabrication »
- Fournisseurs eIDAS réels (drivers `CONSENT_DRIVER`), déploiement du rôle worker (provisioning prod), révocation de consentement (endpoint/service), garde composé `DualAuthMutationGuard` (**refusé** D7), transition `emise`/transport réel, backoff persistant du sweep routage, POST codes-routage : **tous différés/refusés** avec rationale (Périmètre + D\*). Posture : **durcir la preuve et les privilèges** de l'existant sans **fabriquer** d'affirmation — **aucune** prétention juridique (scellement **structurel** seul), **aucun** privilège worker au-delà de l'inventaire réel, **aucun** rate-limit inventé, **aucun** automatisme de re-résolution (jugement opérateur après nettoyage annuaire).

---

## Versions & dépendances (registre npm — à re-vérifier à chaque tâche)

| Brique | Fournisseur | Provenance / note |
|---|---|---|
| Scellement e-signature | `node:crypto` (`createHash('sha256')`) déjà présent | **Aucun ajout.** Motif des 4 stores locaux + `ledger-hash.ts` ; **aucun** `sign`/`verify` (qualifié = driver différé). |
| Motif port (5e instance) | `@nestjs/common` (déjà présent) | **Aucun ajout.** Contrat + impl locale + module `@Global`, réplique CDV 3.1. |
| Rôle/pool worker | `pg` (`pg.Pool`) + drizzle (déjà présents) | **Aucun ajout.** Migration **0029** (grants) + `00-roles.sql` (rôle dev/test) + `DbModule.forRoot`. |
| Endpoint re-résolution | `zod` inline + `@nestjs/common` (déjà présents) | **Aucun ajout.** Réutilise `resolveAndRecord`. |
| Tests | **Vitest 4.1.10** (déjà présent) | Split `heavy`/`light` de 3.3 respecté ; **aucune** nouvelle suite HEAVY (les 3 nouvelles e2e sont LIGHT). |

> **Gate** : `pnpm run audit:ci` = 0 et `pnpm outdated -r` **vierge**. Vérifier à **chaque** tâche (patch amont possible). Bump **`apps/api` 0.10.0 → 0.11.0** (Task 5) ; `invoice-core` **reste 0.4.0**.

---

## Points de risque signalés d'emblée

1. **Prétention juridique fabriquée sur l'e-signature.** **Traité** : D3 — driver `local` = scellement **structurel** seul (intégrité+horodatage+WORM), doc/commentaires disent **exactement** cela, **jamais** « valeur probante »/« qualifiée » ; vérification cryptographique = driver réel **différé** (throw testé).
2. **`factelec_worker` sous-privilégié (worker cassé) OU sur-privilégié.** **Traité** : D4/D5 — grants **dérivés de l'inventaire réel** ; **suffisance** prouvée par les suites e2e worker sous le rôle (échec `42501` si un grant manque), **minimalité** prouvée par le test `42501` dédié. Itérer les grants jusqu'au vert des suites worker.
3. **`factelec_worker` hors policy RLS → tout refusé.** **Traité** : D4 — policies créées **sans `TO`** (⇒ `PUBLIC`), s'appliquent au nouveau rôle **automatiquement** ; aucune policy nouvelle. `NOBYPASSRLS` conservé.
4. **Split pool casse l'API ou le worker.** **Traité** : D5 — `DbModule.forRoot(urlEnvKey)`, deux bootstraps **disjoints** (API=`DATABASE_URL`/`factelec_app` inchangé, worker=`DATABASE_URL_WORKER`/`factelec_worker`) ; `DATABASE_URL_WORKER` **optionnelle**, forRoot **throw** si absente au bootstrap worker (l'env API n'a pas besoin du secret worker).
5. **Migration 0029 échoue (rôle absent).** **Traité** : D4/D8 — rôle créé par `00-roles.sql` (dev/test) **avant** migrations (motif `factelec_app`) ; prod = provisioning **précède** la migration (item Xavier, runbook Task 5).
6. **Point d'insertion e-signature erroné.** **Traité** : D3 — vérifié in situ : **unique** franchissement de frontière = branche `proof` de `resolveConsent` (création) ; les chemins `consentId`/auto-découverte consomment une preuve **déjà scellée** (gate = couverture/révocation, **inchangé**).
7. **Re-résolution rejoue un statut déjà automatisé / fabrique un succès.** **Traité** : D6 — garde `ambiguous`-**only** (409 sinon), `pending`/`unaddressable` déjà repris par le sweep 3.4 ; 200 **rapporte** le statut obtenu (jamais une promesse de `resolved`).
8. **Cycle de dépendance `InvoicesModule` ↔ `AnnuaireModule`.** **Traité** : D6 — garde explicite (vérifier l'export `AnnuaireConsultationService` + absence d'import inverse ; `forRoot`/module de routage partagé sinon).
9. **Fuite d'existence de facture (re-résolution).** **Traité** : D6 — 404 byte-identique (inconnue/cross-tenant/`:id` malformé indiscernables, motif `invoices.service.notFound`).
10. **Régression du verrou heavy-suites / apiKeyId.** **Traité** : les 3 nouvelles e2e sont **LIGHT** (aucun `createTestWorker`) ⇒ `heavy-suites.arch` **inchangé** ; l'endpoint dual-auth **n'ajoute ni poseur ni lecteur** d'`apiKeyId` ⇒ `apikeyid-setters.arch` **vert sans modification**.

---

## Sources vérifiées in situ (lecture seule — aucune extraction réglementaire nouvelle)

Faits vérifiés dans le code à `main` (HEAD `029b2d3`, apps/api 0.10.0), non paraphrasés :
- **Motif port** : 4 instances identiques — tokens `Symbol` (`ARCHIVE_STORE`/`FLUX10_TRANSMISSION`/`ANNUAIRE_TRANSPORT`/`CDV_TRANSMISSION`), impl write-once (`stat`→existing / `writeFile{flag:'wx'}` / `catch EEXIST` / `chmod 0o444` / `sha256Hex`), module `@Global` factory allowlist-`local`/throw (ex. `cdv-transmission.module.ts:31-33`, message « …activé au déploiement (non fourni en 3.1) »), env 2 lignes (`env.ts:185-188` bloc CDV), test throw via `Reflect.getMetadata(MODULE_METADATA.PROVIDERS…)` (`cdv-transmission.module.test.ts`). Scellement 2.2 : `ledger-hash.ts:33-68` (canonical longueur-préfixé, ordre figé, `sha256(prev‖canonical)`, horodatage `createdAtMs`).
- **Cycle consentement** : `annuaire_consents` (`schema.ts:427-448`, `signer_identity`/`evidence_ref`/`obtained_at` notNull, `revoked_at` nullable ; grants SELECT/INSERT/UPDATE, **pas DELETE** `0019:14`) ; `insertConsent` écrit **verbatim sans crypto** (`annuaire.repository.ts:199-221`) ; branche `proof` unique franchissement (`annuaire-publication.service.ts:163-165`) ; gate `ConsentRequiredError`→422 (`:37-44`, `annuaire.controller.ts:216-223`) ; `coversTarget`/`revokedAt IS NULL` (gate couverture/révocation) ; **aucun** endpoint de création de consentement isolé.
- **Inventaire worker** : `worker-main.ts:10` bootstrape `WorkerModule` ; 5 processors + sweeps ; matrice d'accès D4 (tracée repo par repo) ; 9 SD worker vs 8 SD auth/API ; `DATABASE_URL` unique (`env.ts:23`) + `APP_POOL` unique (`client.ts:8-9`) partagés ; `00-roles.sql` (`DO $$ IF NOT EXISTS … CREATE ROLE`) ; grants `factelec_app` (0001/0003/0005/0008/0015/0017/0019/0022/0025) ; **policies RLS sans clause `TO`** (⇒ PUBLIC).
- **Endpoint miroir** : `POST /ereporting/retransmissions` (`ereporting.controller.ts:94-104`, `@HttpCode(202)`, dual-auth, `parseBody(retransmissionSchema)`, `z.uuid()`) ; 404 `ereportingNotFound()` (`ereporting-errors.ts:11-15`) ; garde-fous service `findDeclarant`→404 / `findInitialTransmission`→409 (`ereporting-retransmission.service.ts:55-69`) ; `resolveAndRecord(...):Promise<void>` best-effort strict (`recipient-routing.service.ts:55-113`) ; `findRoutingState`/`loadCanonical`/`markRoutingStatus` (`invoices.repository.ts:505-523/160-172/487-503`) ; dual-auth `PaymentsController.capture` (`payments.controller.ts:64-66`) ; bypass `apiKeyId` (`roles.guard.ts:37`, `csrf.guard.ts:26`) ; rôles `owner/admin/accountant/viewer` (`auth.types.ts:3`).
- **Verrous** : `HEAVY_TESTS` 11 suites (`vitest.config.ts`), invariant `heavy-suites.arch.test.ts` (`createTestWorker ≡ HEAVY_TESTS`) ; `apikeyid-setters.arch.test.ts` (2 poseurs/2 lecteurs, morsure) ; migration max **0028** (`meta/_journal.json`).

---

## Structure des fichiers (vue d'ensemble)

```
apps/api/
  package.json                                    # version 0.10.0 → 0.11.0 (Task 5)
  scripts/db-init/00-roles.sql                    # + CREATE ROLE factelec_worker (dev/test) (Task 3)
  src/config/env.ts                               # + CONSENT_DRIVER/CONSENT_LOCAL_DIR (Task 1) ; + DATABASE_URL_WORKER (Task 3)
  src/db/
    db.module.ts                                  # DbModule.forRoot(urlEnvKey) — split pool/rôle (Task 3)
    client.ts                                     # (inchangé — createPool réutilisé)
    migrations/0029_worker_role_grants.sql        # (hand) GRANTs factelec_worker (Task 3)
    migrations/meta/_journal.json                 # + 0029
  src/annuaire/
    consent-signature.port.ts                     # NOUVEAU contrat + token CONSENT_SIGNATURE + erreurs (Task 1)
    local-filesystem-consent-store.ts             # NOUVEAU impl write-once (scellement structurel) (Task 1)
    consent-signature.module.ts                   # NOUVEAU @Global factory env-switchable + throw (Task 1)
    annuaire-publication.service.ts               # seal() à la création (branche proof) + evidence_ref=sealRef (Task 2)
    annuaire.controller.ts                        # ConsentSignatureError → 422 (mapPublicationError) (Task 2)
    annuaire.module.ts                            # + import ConsentSignatureModule + inject port (Task 2)
  src/invoices/
    invoices.controller.ts                        # + POST :id/routing/resolve dual-auth (Task 4)
    invoices.service.ts                           # + resolveRouting (garde ambiguous-only) (Task 4)
    invoices.module.ts                            # + RecipientRoutingService + CsrfGuard + import AnnuaireModule (Task 4)
  src/app.module.ts                               # DbModule.forRoot('DATABASE_URL') (Task 3)
  src/worker/worker.module.ts                     # DbModule.forRoot('DATABASE_URL_WORKER') (Task 3)
  tests/
    unit/
      local-filesystem-consent-store.test.ts      # write-once + sceau (oracle indépendant) (Task 1)
      consent-signature.module.test.ts            # factory local vs throw eidas (Task 1)
      annuaire-publication.consent-seal.test.ts   # seal à la création, invalide→422, evidence_ref=sealRef (Task 2)
      invoices-resolve-routing.service.test.ts    # ambiguous→resolve, non-ambiguous→409, inconnue→404 (Task 4)
    e2e/
      annuaire-consent-seal.e2e.test.ts           # POST /annuaire/lignes proof → consentement scellé (LIGHT) (Task 2)
      worker-role-least-privilege.e2e.test.ts     # factelec_worker : positifs + 42501 (LIGHT) (Task 3)
      invoice-routing-resolve.e2e.test.ts         # POST re-résolution : 200/404/409/403 (LIGHT) (Task 4)
```

Fichiers hors code : `README.md` racine + `apps/api/README.md` (e-signature honnête, runbook worker-role + provisioning prod, procédure nettoyage annuaire→re-résolution, Task 5).

---

### Task 1 : `ConsentSignaturePort` — 5e instance du motif port (contrat + impl locale write-once + module @Global + throw testé)

**Files:**
- Create: `apps/api/src/annuaire/consent-signature.port.ts`, `apps/api/src/annuaire/local-filesystem-consent-store.ts`, `apps/api/src/annuaire/consent-signature.module.ts`
- Modify: `apps/api/src/config/env.ts`
- Create: `apps/api/tests/unit/local-filesystem-consent-store.test.ts`, `apps/api/tests/unit/consent-signature.module.test.ts`

**Interfaces:**
- Consumes : `node:crypto` (`createHash`), `ConfigService<EnvConfig, true>`, motif CDV 3.1 (`cdv-transmission.*`).
- Produces (Task 2) : token `CONSENT_SIGNATURE` ; `ConsentSignaturePort.seal(payload)`/`verify(sealRef)` ; `LocalFilesystemConsentStore` ; `ConsentSignatureModule` (@Global).

> **D2/D3** : réplique EXACTE du squelette (contrat→impl write-once→module @Global throw) ; scellement **structurel** seul (hash+horodatage+WORM), **aucune** prétention juridique ; `sealedAt` **injecté** (pas de `Date.now()` dans la logique pure).

- [ ] **Step 1 : Contrat + token + erreurs** — `consent-signature.port.ts` : `export const CONSENT_SIGNATURE = Symbol('CONSENT_SIGNATURE')` ; `ConsentSealPayload = { tenantId, siren, siret?, routageId?, suffixe?, consentType, signerIdentity, evidenceRef, obtainedAt }` ; `ConsentSealResult = { sealRef, location, sealedAt, alreadyExisted }` ; `ConsentSealStatus = { sealRef, outcome: 'sealed' }` ; `interface ConsentSignaturePort { seal(p: ConsentSealPayload): Promise<ConsentSealResult>; verify(sealRef: string): Promise<ConsentSealStatus> }` ; `class ConsentSignatureRejectedError extends Error` (`super`, `this.name`, `readonly reason`, **sans** `Object.setPrototypeOf`, motif `TransmissionRejectedError`).

- [ ] **Step 2 : Tests unit impl locale (RED)** — `local-filesystem-consent-store.test.ts` (tmpdir, `sealedAt` injecté, **oracle indépendant** : le test recalcule `sha256` sur les octets canoniques connus) :
```ts
it('seal → sealRef = sha256(forme canonique) recalculé indépendamment, location écrite, alreadyExisted:false')
it('write-once : 2e seal de la MÊME preuve → alreadyExisted:true, MÊME sealRef, fichier non réécrit (chmod 0o444)')
it('deux preuves DIFFÉRENTES (un champ change) → sealRef distincts (encodage longueur-préfixé injection-proof)')
it('verify(sealRef) relit, recalcule sha256 et confirme l’intégrité → outcome:"sealed"')
it('clé de traversée (.. / absolu) → InvalidConsentKeyError')
```
Run → **RED** (impl absente).

- [ ] **Step 3 : Implémentation impl locale (GREEN)** — `local-filesystem-consent-store.ts` (`implements ConsentSignaturePort`, `constructor(private readonly baseDir: string)`) : `SAFE_KEY` + `resolve()` (rejette traversal → `InvalidConsentKeyError` déclarée ici) ; **forme canonique** = `field()` longueur-préfixé (`` `${Buffer.byteLength(v,'utf8')}|${v}` ``, `'-1|'` si absent) dans un **ordre FIGÉ** (tenantId, siren, siret, routageId, suffixe, consentType, signerIdentity, evidenceRef, obtainedAt, sealedAt), motif `ledger-hash.ts:33-50` ; `sealRef = createHash('sha256').update(canonical,'utf8').digest('hex')` ; clé fichier = `${tenantId}/${sealRef}.seal` ; **write-once** (`stat`→`existingResult` / `mkdir` / `writeFile{flag:'wx',encoding:'utf8'}` / `catch EEXIST`→`existingResult` / `chmod 0o444`) ; `verify` relit + recompute + `=== sealRef`. `sealedAt` : paramètre injecté (signature `seal(payload, sealedAt: string)` **ou** horloge injectée au constructeur — pas de `Date.now()` dans la logique pure ; l'appelant Task 2 fournit `horodateNow()`).

- [ ] **Step 4 : Module @Global + env + test throw (RED→GREEN)** — `consent-signature.module.ts` (`@Global()`, provider `{ provide: CONSENT_SIGNATURE, inject:[ConfigService], useFactory }`, `exports:[CONSENT_SIGNATURE]`) : `if (driver==='local') return new LocalFilesystemConsentStore(config.get('CONSENT_LOCAL_DIR',{infer:true})); throw new Error(\`fournisseur de signature de consentement '${driver}' activé au déploiement (non fourni en 3.5)\`)`. `env.ts` : `CONSENT_DRIVER: z.enum(['local','eidas']).default('local')` + `CONSENT_LOCAL_DIR: z.string().default('./var/consent')`. `consent-signature.module.test.ts` (motif `cdv-transmission.module.test.ts`, extraction via `Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ConsentSignatureModule)` + `fakeConfig`) : `local`→`toBeInstanceOf(LocalFilesystemConsentStore)` ; `it.each(['eidas'])`→`toThrow(/activé au déploiement \(non fourni en 3\.5\)/)`. Run → **RED** puis **GREEN**.

- [ ] **Step 5 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): port de scellement de signature du consentement (contrat, impl locale write-once, factory env-switchable, driver eIDAS différé)"
```
Expected: PASS ; scellement structurel testé (write-once idempotent, intégrité), throw driver réel testé.

---

### Task 2 : Vérification/scellement branché au gate de consentement (création) + 422

**Files:**
- Modify: `apps/api/src/annuaire/annuaire-publication.service.ts`, `apps/api/src/annuaire/annuaire.controller.ts`, `apps/api/src/annuaire/annuaire.module.ts`
- Create: `apps/api/tests/unit/annuaire-publication.consent-seal.test.ts`, `apps/api/tests/e2e/annuaire-consent-seal.e2e.test.ts` (LIGHT)

**Interfaces:**
- Consumes : Task 1 (`CONSENT_SIGNATURE`/`seal`), `resolveConsent` branche `proof`, `insertConsent`, `mapPublicationError`.
- Produces : consentement **scellé** à la création ; `evidence_ref` = `sealRef` ; preuve non scellable → **422**.

> **D3** : scellement à la CRÉATION (branche `proof`), **unique** franchissement de frontière ; `evidence_ref` repurposé en sceau (aucune colonne) ; chemins `consentId`/auto-découverte **inchangés** ; erreur → **même 422** que `ConsentRequiredError`.

- [ ] **Step 1 : Tests service (RED)** — `annuaire-publication.consent-seal.test.ts` (mock repo + `CONSENT_SIGNATURE`, oracle indépendant) :
```ts
it('branche proof : seal() appelé AVANT insertConsent, avec la maille + la preuve déclarée')
it('insertConsent reçoit evidence_ref = seal.sealRef (PAS la chaîne evidenceRef client brute)')
it('seal throw (ConsentSignatureRejectedError) → publication échoue, insertConsent JAMAIS appelé')
it('chemin consentId (preuve déjà persistée) : seal() JAMAIS appelé (gate = couverture/révocation inchangé)')
it('chemin auto-découverte : seal() JAMAIS appelé')
```
Run → **RED**.

- [ ] **Step 2 : Implémentation (GREEN)** — `annuaire-publication.service.ts` : injecter `@Inject(CONSENT_SIGNATURE) private readonly consentSignature: ConsentSignaturePort` ; dans la branche `proof` de `resolveConsent` (l.163-165), **avant** `insertConsent` : `const seal = await this.consentSignature.seal({ ...maille, consentType, signerIdentity, evidenceRef, obtainedAt }, horodateNow())` (try/catch → `throw new ConsentSignatureError(reason)` sœur de `ConsentRequiredError`) puis `insertConsent(tenantId, { ...maille, consentType, signerIdentity, obtainedAt, evidenceRef: seal.sealRef })`. `annuaire.controller.ts` : `mapPublicationError` mappe `ConsentSignatureError` au **MÊME** `problem(422, businessRule, …)` (corps distinct autorisé : « Consent signature rejected » — ce n'est pas un 404 anti-fuite). `annuaire.module.ts` : `imports += ConsentSignatureModule` (motif `AnnuaireModule → AnnuaireTransportModule`). **GARDE** : ré-exécuter les e2e annuaire existants (publication/consultation/sync) → **verts** (chemins `consentId`/auto-découverte inchangés).

- [ ] **Step 3 : e2e création scellée (RED→GREEN)** — `annuaire-consent-seal.e2e.test.ts` (Postgres réel, `CONSENT_DRIVER=local`, **aucun worker** → LIGHT) :
```ts
it('POST /annuaire/lignes avec proof → 201, annuaire_consents.evidence_ref est un sha256 (64 hex), fichier de sceau écrit write-once')
it('re-publier la MÊME preuve (même maille) → sceau idempotent (alreadyExisted), evidence_ref identique')
it('publier avec consentId d’un consentement déjà scellé → 201 sans nouveau scellement (gate couverture/révocation)')
it('isolation multi-tenant : le sceau et le consentement restent sous le bon tenant (RLS)')
```
Run → **RED** puis **GREEN**.

- [ ] **Step 4 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): scellement structurel du consentement à la création (evidence_ref = sceau vérifiable, preuve non scellable rejetée en 422)"
```
Expected: PASS ; consentement scellé à la création ; gate de publication inchangé.

---

### Task 3 : Worker-role split (`factelec_worker` moindre-privilège + pool/env dédié + preuve 42501)

**Files:**
- Modify: `apps/api/scripts/db-init/00-roles.sql` ; Create: `apps/api/src/db/migrations/0029_worker_role_grants.sql` (hand) + `_journal`
- Modify: `apps/api/src/db/db.module.ts` (`forRoot`), `apps/api/src/config/env.ts` (`DATABASE_URL_WORKER`), `apps/api/src/app.module.ts`, `apps/api/src/worker/worker.module.ts`
- Modify: le harnais e2e worker (`createTestWorker` / setup env) pour poser `DATABASE_URL_WORKER`=`factelec_worker`
- Create: `apps/api/tests/e2e/worker-role-least-privilege.e2e.test.ts` (LIGHT)

**Interfaces:**
- Consumes : inventaire D4, `00-roles.sql` (motif `factelec_app`), `DbModule`/`APP_POOL`.
- Produces : rôle `factelec_worker` + grants 0029 ; `DbModule.forRoot(urlEnvKey)` ; le worker se connecte en moindre-privilège.

> **D4/D5** : grants **dérivés de l'inventaire réel** ; policies RLS déjà `TO PUBLIC` (aucune policy nouvelle) ; split par bootstrap disjoint ; **suffisance** prouvée par les suites worker sous le rôle, **minimalité** par `42501` dédié.

- [ ] **Step 1 : Rôle + migration grants** — `00-roles.sql` : ajouter le bloc `DO $$ IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='factelec_worker') THEN CREATE ROLE factelec_worker LOGIN PASSWORD 'worker_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB; END IF; END $$;` (motif exact `factelec_app`). `0029_worker_role_grants.sql` (hand, statement-breakpoints, `_journal` idx 29, **aucun** snapshot) : `GRANT USAGE ON SCHEMA public TO factelec_worker;` + les GRANTs table de la **matrice D4** (verbatim) + `GRANT EXECUTE` sur les **9 SD worker** seulement. **Relire** : SEULEMENT des `GRANT` (aucun `CREATE TABLE`/`ALTER`/`CREATE POLICY`). **AUCUN** grant sur `tenants`/`api_keys`/`users`/`platform_admins`/`sessions`/`annuaire_consents`, **AUCUN** EXECUTE sur les 8 SD auth/API.

- [ ] **Step 2 : Split pool/env** — `env.ts` : `DATABASE_URL_WORKER: z.url().optional()` (l'env API n'a pas besoin du secret worker). `db.module.ts` : `static forRoot(urlEnvKey: 'DATABASE_URL' | 'DATABASE_URL_WORKER'): DynamicModule` (`@Global`) — factory `APP_POOL` = `createPool(config.get(urlEnvKey, {infer:true}) ?? throw new Error('DATABASE_URL_WORKER requis pour le process worker'))` ; `TenantContextService` inchangé. `app.module.ts` : `DbModule.forRoot('DATABASE_URL')`. `worker.module.ts` : `DbModule.forRoot('DATABASE_URL_WORKER')`. **GARDE** : `grep` — aucun autre `imports:[…DbModule…]` avec l'ancienne forme ; le harnais e2e worker pose `DATABASE_URL_WORKER` (même hôte/port/db, user `factelec_worker`). Gate intermédiaire : `pnpm build && pnpm typecheck` vert.

- [ ] **Step 3 : Test moindre-privilège (RED→GREEN)** — `worker-role-least-privilege.e2e.test.ts` (Postgres réel, pool `pg` brut en `factelec_worker`, **aucun Worker BullMQ** → LIGHT ; oracle indépendant : vecteurs de la matrice D4) :
```ts
it('positif : SELECT et UPDATE invoices réussissent (sous contexte tenant)')
it('positif : EXECUTE find_pending_routing_invoices($1) réussit')
it('négatif 42501 : INSERT api_keys, UPDATE users, SELECT sessions, INSERT annuaire_consents, SELECT tenants')
it('négatif 42501 : EXECUTE authenticate_api_key(text) (SD auth non accordée au worker)')
```
Run → **RED** (rôle/grants absents) puis **GREEN**.

- [ ] **Step 4 : Preuve de suffisance (suites worker sous le rôle)** — exécuter **toute** la suite e2e worker (désormais bootstrapée sous `factelec_worker`) : si un GRANT manque, une suite échoue `42501` → **ajouter le grant manquant à 0029** et recommencer jusqu'au vert. **Aucune** suite ajoutée à `HEAVY_TESTS` (le verrou `heavy-suites.arch` reste vert : `worker-role-least-privilege` n'utilise pas `createTestWorker`). Documenter tout grant ajouté au-delà de la matrice initiale (angle mort de l'inventaire → corrigé, preuve empirique).

- [ ] **Step 5 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): rôle worker de moindre privilège (grants dérivés de l'inventaire réel, pool/env dédié, refus 42501 prouvé)"
```
Expected: PASS ; worker en moindre-privilège prouvé (suffisant + minimal) ; API inchangée (`factelec_app`).

---

### Task 4 : Endpoint opérateur de re-résolution `ambiguous` (dual-auth, miroir retransmission)

> **AMENDEMENTS revue du plan (BINDING)** : (M1) cette tâche AJOUTE l'extension du test d'architecture — toute route composant `TenantAuthGuard` sur une mutation (@Post/@Put/@Delete) compose AUSSI `RolesGuard` ET `CsrfGuard`, TenantAuthGuard en tête (cf. bannière D7 ; RED d'abord en retirant temporairement un guard d'une route témoin, preuve de morsure documentée puis restaurée). (N2) préférer FOURNIR `RecipientRoutingService`+`AnnuaireConsultationService` comme providers locaux d'`InvoicesModule` (avec leurs deps) PLUTÔT qu'importer AnnuaireModule entier, si l'import crée le moindre risque de cycle — trancher sur pièces au moment du câblage, documenter.

**Files:**
- Modify: `apps/api/src/invoices/invoices.controller.ts`, `apps/api/src/invoices/invoices.service.ts`, `apps/api/src/invoices/invoices.module.ts`
- Create: `apps/api/tests/unit/invoices-resolve-routing.service.test.ts`, `apps/api/tests/e2e/invoice-routing-resolve.e2e.test.ts` (LIGHT)

**Interfaces:**
- Consumes : `resolveAndRecord` (verbatim), `findRoutingState`/`loadCanonical`, dual-auth (`TenantAuthGuard`/`RolesGuard`/`CsrfGuard`), `RecipientRoutingService`/`AnnuaireConsultationService`.
- Produces : `POST /invoices/:id/routing/resolve` → 200 `{ invoiceId, routingStatus, recipientPlatform }`.

> **D6** : miroir dual-auth `retransmit` ; garde `ambiguous`-only (404 anti-fuite / 409) ; 200 **synchrone** (appel direct best-effort, pas d'enfilement) ; `resolveAndRecord` réutilisé ; **aucun** poseur/lecteur `apiKeyId` ajouté.

- [ ] **Step 1 : Tests service (RED)** — `invoices-resolve-routing.service.test.ts` (mock repo + routing, oracle indépendant) :
```ts
it('routing_status=ambiguous → resolveAndRecord appelé, retourne le NOUVEL état relu (findRoutingState)')
it('routing_status ≠ ambiguous (resolved/pending/unaddressable) → ConflictException 409, resolveAndRecord JAMAIS appelé')
it('findRoutingState → null (inconnue/cross-tenant) → NotFoundException 404 byte-identique')
it(':id malformé (non-UUID) → 404 byte-identique (motif invoices.service.notFound)')
```
Run → **RED** (méthode absente).

- [ ] **Step 2 : Implémentation (GREEN)** — `invoices.service.ts` : `resolveRouting(tenantId, id)` → `if (!isUuid(id)) throw this.notFound()` ; `state = repo.findRoutingState(...)` → `null` ⇒ `notFound()` (404) ; `state.status !== 'ambiguous'` ⇒ `throw new ConflictException(problem(409, conflict, 'Routing not in ambiguous state'))` ; `inv = repo.loadCanonical(...)` → `null` ⇒ `notFound()` ; `await this.routing.resolveAndRecord(tenantId, id, inv)` ; `next = repo.findRoutingState(...)` ; retour `{ invoiceId: id, routingStatus: next.status, recipientPlatform: next.platform }`. `invoices.controller.ts` : `@Post(':id/routing/resolve') @HttpCode(200) @UseGuards(TenantAuthGuard, RolesGuard, CsrfGuard) @Roles('owner','admin','accountant')` → `return this.invoices.resolveRouting(tenantId, id)`. `invoices.module.ts` : `providers += RecipientRoutingService, CsrfGuard` ; `imports += AnnuaireModule` (pour `AnnuaireConsultationService`). **GARDE anti-cycle** : vérifier qu'`AnnuaireModule` **exporte** `AnnuaireConsultationService` et **n'importe pas** `InvoicesModule` (sinon `forwardRef` ou petit module de routage partagé exporté aux deux) ; injecter `RecipientRoutingService` dans `InvoicesService`.

- [ ] **Step 3 : e2e endpoint (RED→GREEN)** — `invoice-routing-resolve.e2e.test.ts` (Postgres réel, annuaire réel, **aucun worker** → LIGHT) :
```ts
it('facture ambiguous + annuaire nettoyé (une seule ligne couvrante) → POST → 200 {routingStatus:"resolved", recipientPlatform}')
it('facture ambiguous SANS nettoyage (toujours ambiguë) → POST → 200 {routingStatus:"ambiguous"} (aucune promesse fabriquée)')
it('facture resolved/pending/unaddressable → 409')
it('facture d’un autre tenant → 404 byte-identique (anti-fuite)')
it('sans dual-auth (session sans CSRF / rôle viewer) → 403/401 ; clé API → OK')
it(':id malformé → 404')
```
Run → **RED** puis **GREEN**.

- [ ] **Step 4 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): endpoint opérateur de re-résolution du routage ambiguous (dual-auth, réutilisation de resolveAndRecord après nettoyage annuaire)"
```
Expected: PASS ; F-2/3.4 soldé (sortie d'`ambiguous` disponible) ; verrous apiKeyId/heavy inchangés.

---

### Task 5 : Docs / runbook / OpenAPI / bump `0.11.0` — clôture

> **AMENDEMENTS revue du plan (L1/L2, BINDING doc)** : (L1) runbook re-résolution : un 200 dont le corps reste `ambiguous` est INDISTINCT entre « annuaire toujours pas nettoyé » et « panne opérationnelle pendant la re-résolution » (best-effort) — le documenter honnêtement (l'opérateur re-tente ou consulte les logs). (L2) documenter que les consents créés AVANT 3.5 portent un `evidence_ref` libre NON scellé (aucune migration rétroactive — honnêteté sur le stock).

**Files:**
- Modify: `README.md` racine, `apps/api/README.md`
- Modify: OpenAPI/Swagger si présent (`POST /invoices/:id/routing/resolve`)
- Modify: `apps/api/package.json` (`version` → `0.11.0`) ; vérifier `packages/invoice-core` = `0.4.0` **non touché**

- [ ] **Step 1 : Documentation honnête** — décrire :
  - **E-signature du consentement** (D2/D3) : `ConsentSignaturePort` (5e instance) ; le driver `local` fait un **scellement STRUCTUREL** (intégrité `sha256` + horodatage + write-once WORM) — **PAS** de vérification cryptographique, **PAS** de « valeur probante »/« signature qualifiée » ; les fournisseurs **eIDAS réels** sont des **drivers différés** (throw testé, item Xavier) ; `evidence_ref` est désormais un **sceau vérifiable** ; le scellement s'opère **à la création** du consentement, une preuve non scellable = **422**.
  - **Worker-role split** (D4/D5) : rôle `factelec_worker` de moindre privilège (grants dérivés de l'inventaire réel), pool/env dédié `DATABASE_URL_WORKER` ; **runbook déploiement (item Xavier)** : provisionner `factelec_worker` (création + secret + `DATABASE_URL_WORKER`) **avant** la migration 0029, motif `factelec_app` ; la RLS s'applique au rôle via les policies `PUBLIC` existantes.
  - **Re-résolution `ambiguous`** (D6) : `POST /invoices/:id/routing/resolve` (opérateur dual-auth) — **procédure** : (1) nettoyer l'annuaire (lever l'ambiguïté structurelle) ; (2) appeler l'endpoint → re-résolution synchrone `resolveAndRecord` ; l'état retourné rapporte le résultat (`resolved`/`ambiguous`/`unaddressable`). `pending`/`unaddressable` restent couverts par le **sweep automatique** 3.4 ; seul `ambiguous` exige l'endpoint. **Remplace** la limite « aucune sortie d'ambiguous » (F-2/3.4).
  - **Différés 3.6+** : fournisseurs eIDAS réels, déploiement du rôle worker, révocation de consentement, garde composé `DualAuthMutationGuard` (**refusé**, rationale D7), transition `emise`/transport réel, backoff persistant du sweep, POST codes-routage.

- [ ] **Step 2 : Bump + gate finale + commit**
```bash
# apps/api/package.json : "version": "0.11.0" (phase 3.5 : consentement probant & séparation des rôles)
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm test && pnpm run audit:ci && pnpm outdated -r
git add -A
git commit -m "docs: consentement scellé, rôle worker de moindre privilège, re-résolution ambiguous, bump version 0.11.0"
```
Expected: tout vert ; **invoice-core 100 %×4 non touché**, apps/api ≥ 90 %×4 (agrégat heavy+light), apps/web ≥ 90 %×4 ; audit:ci 0 ; outdated vierge.

---

## Self-Review (contre research 3.5 / les arbitrages contrôleur)

**1. Couverture du cadrage :**
- **E-signature (5e instance du motif port)** : contrat de vérification/scellement + impl locale (scellement **structurel** hash+horodatage+write-once, motif 2.2) + factory `@Global` env-switchable avec driver eIDAS réel → **throw testé** → Tasks 1/2 (D2/D3). ✅
- **Point d'insertion tranché** : vérification/scellement **à la CRÉATION** du consentement (branche `proof` de `resolveConsent`, unique franchissement de frontière), rationale contre le cycle réel du code (chemins `consentId`/auto-découverte inchangés) → D3. ✅
- **Worker-role split** : **inventaire réel d'abord** (matrice table-par-table), puis migration grants + env/pool dédié (`DATABASE_URL_WORKER`), moindre privilège **prouvé** `42501` (écriture des tables d'auth interdite) → Task 3 (D4/D5). ✅
- **Endpoint re-résolution ambiguous** (solde F-2/3.4) : miroir `POST /ereporting/retransmissions` (dual-auth le plus récent), garde `ambiguous`-only jugé (pending/unaddressable déjà repris par le sweep 3.4), `resolveAndRecord` réutilisé → Task 4 (D6). ✅
- **Garde composé `DualAuthMutationGuard`** : condition déclenchante **jugée** → **REFUSÉ ce plan** (footgun déjà purgé par le test d'archi 3.3-T6, 3.4 a déjà décliné, gain purement DRY) → D7. ✅
- **HORS PÉRIMÈTRE / DIFFÉRÉS** respectés : fournisseurs eIDAS réels, transport réel/`emise`, backoff persistant, POST codes-routage, déploiement du rôle worker, révocation de consentement → **Différés** documentés. ✅
- **Contraintes** : TDD RED-first ; invoice-core **non touché** ; aucune dépendance ajoutée ; **aucune nouvelle table/colonne/policy** (0029 grants seuls ; RLS `PUBLIC` couvre le nouveau rôle) ; dual-auth motif existant ; 404 byte-identique ; oracles indépendants ; **verrous heavy/apiKeyId inchangés** (3 nouvelles e2e LIGHT, aucun poseur/lecteur `apiKeyId` ajouté) ; SD épinglées `pg_catalog,pg_temp` (aucune SD nouvelle ce plan) ; commits FR sans trailer ; docs `reglementaire`/`reference` R/O ; tâches homogènes Sonnet + revue Opus ; dernière tâche = docs/bump 0.11.0. ✅

**2. Non-régression & non-fabrication :** API **inchangée** (`factelec_app`, `DATABASE_URL`) ; gate de consentement **inchangé** (couverture/révocation) ; `resolveAndRecord` **réutilisé verbatim** ; le scellement **n'invente aucune** valeur juridique (structurel seul) ; le worker n'obtient **aucun** privilège au-delà de l'inventaire (suffisance ET minimalité prouvées) ; la re-résolution **ne fabrique aucun** succès (rapporte le statut réel).

**3. Interprétations marquées go-live :** (a) `evidence_ref` repurposé en sceau — un consommateur PPF réel de la preuve (transport différé) consommera ce sceau vérifiable ; (b) le driver `local` atteste intégrité/horodatage/immutabilité **sans** qualification eIDAS (la doc le dit exactement) ; (c) la matrice de grants worker est un **point de départ vérifié** — la preuve empirique (suites worker sous le rôle) corrige tout angle mort d'inventaire, documenté.

**4. Cohérence types & migrations :** `ConsentSignaturePort` partagé port/impl/module (Task 1) ; `DbModule.forRoot` deux bootstraps disjoints (Task 3) ; `resolveRouting` réutilise `RecipientRoutingService` (Task 4) ; **migration unique 0029** contiguë après 0028, **aucune** table/colonne/policy/enum, `nomenclature.ts` R/O.

## Recommandations fermes de périmètre (le contrôleur ratifie — aucune question ouverte)

- **R1 — E-signature = `ConsentSignaturePort` (5e instance)** : contrat + impl locale write-once (scellement **structurel**) + factory `@Global` throw sur driver eIDAS réel. Retenu (D2).
- **R2 — Scellement à la CRÉATION** du consentement (branche `proof`) ; `evidence_ref` = sceau ; gate de publication inchangé ; preuve non scellable → 422. Retenu (D3).
- **R3 — AUCUNE prétention juridique** : doc/commentaires disent exactement ce que fait le scellement ; qualification eIDAS = drivers différés (throw testé). Retenu (D3).
- **R4 — `factelec_worker` moindre-privilège** dérivé de l'inventaire réel ; policies RLS `PUBLIC` déjà appliquées ; migration 0029 (grants seuls, aucune table/policy). Retenu (D4).
- **R5 — Split pool/env** (`DbModule.forRoot` + `DATABASE_URL_WORKER`, bootstraps disjoints) ; minimalité `42501` + suffisance par les suites worker sous le rôle ; déploiement du rôle = item Xavier. Retenu (D5).
- **R6 — Endpoint re-résolution `ambiguous`-only** (dual-auth miroir `retransmit`, 200 synchrone, `resolveAndRecord` réutilisé) ; solde F-2/3.4. Retenu (D6).
- **R7 — Garde composé `DualAuthMutationGuard` REFUSÉ ce plan** (footgun déjà purgé par le test d'archi 3.3-T6 ; réexaminable à la 4e+ route). Retenu (D7).
- **R8 — Une migration (0029 grants) seule** ; aucune table/colonne/policy/enum. Retenu (D8).
- **R9 — Bump `apps/api` 0.11.0 ; `invoice-core` reste 0.4.0** (non touché). Retenu.

## Execution Handoff

Plan complet, sauvegardé dans `docs/superpowers/plans/2026-07-18-phase3-5-consentement-roles.md`. Branche : `feat/phase3-5-consentement-roles`. Deux options :
1. **Subagent-Driven (recommandé)** — un subagent frais par tâche, revue Opus entre chaque (aligné 1.x/2.x/3.x). Ordre : T1 (port e-signature) → T2 (branchement gate/422) → T3 (worker-role split) → T4 (endpoint re-résolution) → T5 (docs/bump). T3/T4 sont indépendants de T1/T2 et l'un de l'autre (parallélisables si besoin).
2. **Inline** — exécution par lots avec points de contrôle.

