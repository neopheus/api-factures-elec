# Plan 3.4 — Reprise & retransmission

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Livrer **tout ce qui REJOUE ou RÉPARE** ce que 2.3–3.3 ont posé, sur **trois axes**, avec pour la première fois de la phase 3 une **extraction réglementaire primaire** (le chemin RE, §3.7.7 p.68-69, notes 127/131, déjà réalisée par le contrôleur et consignée au ledger — voir Sources) :

1. **Chemin RE (retransmission e-reporting Flux 10)** — le type `'RE'` est en nomenclature et l'index unique partiel `WHERE type='IN'` est **conçu depuis 2.3** pour laisser coexister plusieurs RE par slot, mais **aucun chemin ne crée jamais un `'RE'`** (le sweep hardcode `type='IN'`, `ereporting-sweep.service.ts:41`). On ajoute un **endpoint opérateur dual-auth** (`POST /ereporting/retransmissions`) qui, sur **jugement humain** (spec : « **peut** transmettre un flux rectificatif », déclenchement **facultatif**, **jamais** un automatisme post-301 qui fabriquerait une décision), **régénère la période COMPLÈTE** (`annule-et-remplace L'ENSEMBLE`, note 127 — regénération, jamais un diff) depuis les **données source ACTUELLES** via le **pipeline existant** (`EreportingGenerationService.generate`, type=`'RE'`). Le RE est **retriable-idempotent** par une défense en profondeur à 3 couches (miroir exact de l'IN) et **débloque le deadlock du slot IN né-`rejetee`** hérité de 2.3 (runbook mis à jour).
2. **Sweep de reprise du routage destinataire** — le **seul best-effort du projet sans reprise** (AMENDEMENT M1/3.3, BINDING : `resolveAndRecord` laisse `routing_status='pending'` sur panne opérationnelle, `recipient-routing.service.ts:106-113`, et rien ne le rejoue). On ajoute un `RecipientRoutingRetryService` **miroir exact d'`ArchiveRetryService.sweepFailedArchives`** (SD cross-tenant borné, cadence dédiée), qui rejoue `resolveAndRecord` sur `'pending'` **ET** `'unaddressable'` (retriable par nature), **jamais** `'ambiguous'` (nettoyage opérateur requis).
3. **Filtre de liste par `routing_status`** — `GET /invoices?routingStatus=` (zod, curseur keyset existant **intact**), qui **expose enfin** `routingStatus`/`recipientPlatform` dans le DTO de liste et **solde le trou d'observabilité** documenté en 3.3 (M1 : le runbook SQL devient inutile).

**Architecture :** On **réutilise le socle 1.x/2.x/3.x** exactement comme les plans précédents. Tout vit **entièrement dans `apps/api`** ; **`packages/invoice-core` n'est PAS touché**. Le chemin RE **réutilise verbatim** `EreportingGenerationService.generate` (dispatch `fluxKind`, `buildTransmissionRef`, `persistAndTransmit`, `insertTransmission`) : la **seule** modification du pipeline est un **discriminant `reSeq` additif** pour rendre le `transmission_ref` du RE unique par émission (le store local est **write-once par ref**, `flux10-transmission.port`), plus une **branche d'arbitrage de conflit par `type`** dans `insertTransmission` (l'index partiel IN reste **byte-identique**, un **nouvel index partiel RE** apporte la retry-idempotence). Le producteur `ereporting-generation` **côté HTTP** est enregistré dans `QueueModule` (l'API devient producteur, **exactement** comme pour `invoice-generation` via l'ingestion — aujourd'hui la file n'est enregistrée que dans `WorkerQueueModule`). Le sweep routage **calque** `ArchiveRetryService` + son SD `find_failed_archives` (0015) + son planificateur + sa branche `MaintenanceProcessor`. Le filtre de liste **étend** la requête keyset existante sans la casser.

**Tech Stack :** **Aucune dépendance runtime ajoutée.** Pipeline : `EreportingGenerationService` + `EreportingRepository` (déjà présents). File HTTP : **BullMQ 5.80.x** (déjà présent — aucune nouvelle file, on ajoute un **producteur** à une file existante). Persistance : drizzle + `pg` (déjà présents) — **deux migrations index/SD seules, aucune table, aucune colonne, aucune RLS/grant nouvelle**. HTTP : `zod` inline (déjà présent). Tests : **Vitest 4.1.10** (déjà présent — split `heavy`/`light` de 3.3 respecté ; nouvelles suites worker ajoutées à `HEAVY_TESTS`). `docker-compose` inchangé.

## Global Constraints

Reprises **verbatim** du socle 1.x/2.x/3.x (non négociables) — chaque tâche en hérite implicitement :

- **TDD strict RED/GREEN** : test écrit et vu échouer avant toute implémentation ; aucun merge si un test échoue. Un commit minimum par tâche, message en **français**, **sans** trailer `Co-Authored-By: Claude` ni mention Claude ; commits au seul nom de l'utilisateur. `pnpm format` avant chaque commit.
- **Couverture bloquante** : **≥ 90 %** (lines/functions/statements/branches) maintenue en **agrégat heavy+light** sur `apps/api` et `apps/web`. **`packages/invoice-core` N'EST PAS touché** ce plan (il se tient à **100 %×4** ; ne pas régresser — aucune modification attendue). Exclusions de couverture `apps/api` conservées (`src/main.ts`, `src/worker-main.ts`, `**/*.module.ts`, `src/db/migrations/**`). **Tout module pur** (helper `buildTransmissionRef`, service de routage/sweep testé en isolation) visé **100 %** par des tests déterministes (**aucun `Date.now()` dans la logique pure** ; `now`/`reSeq`/seuils injectés).
- **e2e sur Postgres réel (Testcontainers)** pour toute table/endpoint ; **Redis réel** pour tout flux worker/scheduler ; **tests d'isolation multi-tenant explicites**. **Motifs de stabilité e2e OBLIGATOIRES** (1.4/2.x/3.x) : `listenOnce`, `maxWorkers`/projet dédié borné, `withStartupTimeout(120_000)`, `hookTimeout(150_000)`, polling `waitFor` borné (jamais de sleep fixe), aucun affaiblissement de l'hermétisme (chaque fichier garde ses conteneurs + ses ports en mémoire). **VERROU D'ARCHITECTURE (3.3 T7 NIT-1, BINDING)** : toute nouvelle suite e2e démarrant un Worker BullMQ (`createTestWorker(`) **DOIT** être ajoutée à `HEAVY_TESTS` (`vitest.config.ts`) — sinon `tests/unit/heavy-suites.arch.test.ts` échoue (invariant `{ suites createTestWorker } ≡ HEAVY_TESTS`, égalité stricte).
- **Sécurité OWASP** : validation de toute entrée (zod), authz systématique (**dual-auth** sur l'endpoint RE : `TenantAuthGuard` + `RolesGuard` + `CsrfGuard`, motif `PaymentsController.capture`). **Aucune donnée sensible hors des frontières tenant** : toute lecture/écriture métier sous RLS ; les balayages cross-tenant passent par des **SD `SECURITY DEFINER` read-only** (motif `find_failed_archives`). Erreurs normalisées **RFC 9457 `application/problem+json`**. **404 anti-fuite byte-identique** : déclarant inconnu / cross-tenant indiscernables (motif `EreportingController.notFound`).
- **Moindre privilège Postgres inchangé** : rôle `factelec_app` ≠ propriétaire, **sans `BYPASSRLS`, sans superuser**. **Aucune nouvelle table** (D9). Migration **0027** = **un index partiel unique** additif sur `ereporting_transmissions` (déjà `ENABLE`+`FORCE`, grants déjà accordés) ; migration **0028** = **une fonction SD read-only** (`find_pending_routing_invoices`, miroir exact `find_failed_archives` : `LANGUAGE sql`, `SECURITY DEFINER`, `SET search_path = pg_catalog, pg_temp`, `STABLE`, un seul `SELECT` borné, `REVOKE ALL FROM PUBLIC` + `GRANT EXECUTE TO factelec_app`). **Aucune nouvelle policy RLS/grant de table.**
- **TypeScript `strict: true`, ESM, NodeNext, Node ≥ 22.** `typescript` pinné **exactement `7.0.2`** (racine, tsgo). Repli local `typescript@5.9.x` du seul workspace concerné autorisé et documenté si un typecheck bute — sans toucher le pin racine.
- **Dépendances pinnées exactement, dernière stable, licence.** **`pnpm run audit:ci` 0 vulnérabilité** et **`pnpm outdated -r` vierge** restent **bloquants** en CI. **Aucune dépendance ajoutée** → objectif mécaniquement tenu (vérifier néanmoins à **chaque** tâche — un patch amont peut sortir en cours de plan).
- **`@factelec/invoice-core` consommé via son exports map** (barrel `.` unique), jamais par chemin relatif. `docs/reference/` et `docs/reglementaire/` en **lecture seule** (aucun XSD copié/modifié). **`apps/api/src/ereporting/nomenclature.ts`** (normatif Annexe 6, `TRANSMISSION_TYPES=['IN','RE']`) **en lecture seule** — jamais altéré.
- Identifiants de code en **anglais** ; commentaires/commits/docs en **français**.
- **Oracles de test indépendants (anti-tautologie)** : ne jamais asserter un comportement en le comparant à sa propre implémentation ; les vecteurs viennent d'une source distincte du code testé (ex. seed d'un IN à `transmission_ref` connu → le RE porte un ref discriminé DIFFÉRENT calculé indépendamment ; seed d'une ligne d'annuaire à plateforme connue → `recipient_platform` == cette plateforme après sweep).

---

## Périmètre : retenu en 3.4 vs reporté

**Retenu (ce plan) :**
1. **Pipeline RE retriable-idempotent** : `buildTransmissionRef` gagne un discriminant `reSeq` (RE seulement, IN byte-identique) ; `EreportingGenerationJob` gagne `reSeq?` ; `insertTransmission` arbitre le conflit **par `type`** (index IN inchangé + nouvel index partiel RE) ; repo `countRetransmissions`/`findInitialTransmission` ; migration **0027** (index partiel RE). e2e worker (régénération RE + retry-idempotence) → `HEAVY_TESTS` (**Task 1**, D3/D5).
2. **Endpoint RE opérateur** : `EREPORTING_GENERATION_QUEUE` enregistrée **producteur côté API** (`QueueModule`) + wrapper `EreportingGenerationQueue` ; `EreportingRetransmissionService` (garde-fous D4) ; `POST /ereporting/retransmissions` dual-auth (zod) ; e2e enqueue (LIGHT — **nit revue : ce fichier ne DOIT PAS importer `createTestWorker`**, il vérifie l'enfilement/garde-fous côté HTTP seulement ; le verrou heavy-suites.arch échouerait sinon) + garde-fous + régénération bout-en-bout (HEAVY, DANS `HEAVY_TESTS`) (**Task 2**, D1/D2/D4/D5). **Nit 404** : si le contrôleur ereporting réutilise sa fabrique `notFound()` (« Unknown transmission ») pour le 404 déclarant, garder UN SEUL corps 404 pour tout le contrôleur (anti-fuite byte-identique prime sur la précision du wording — documenter ce choix en commentaire).
3. **Sweep de reprise du routage** : migration **0028** (SD `find_pending_routing_invoices`) ; `RecipientRoutingRetryService` (worker) ; `ROUTING_RETRY_JOB` + `RoutingRetryScheduler` + branche `MaintenanceProcessor` ; env `ROUTING_RETRY_EVERY_MS` ; e2e worker → `HEAVY_TESTS` (**Task 3**, D7/D9).
4. **Filtre de liste `routing_status`** + exposition du routage dans le DTO de liste : `GET /invoices?routingStatus=` (zod, keyset intact), `InvoiceSummary` enrichi (**Task 4**, D8).
5. **Docs / runbook (déblocage deadlock RE) / OpenAPI / README / bump `0.10.0`** (**Task 5**).

**Reporté (acté ici, justifié en D\*) — différés 3.5+ :**
- **E-signature du consentement annuaire** : décisions cryptographiques + probable fournisseur externe (item Xavier). Champs de preuve modélisés/persistés sous RLS depuis 2.4 ; aucune vérification/révocation/endpoint livré. Différé.
- **Worker-role split** : séparation des privilèges du process worker (déploiement). Différé.
- **Transition `emise` (201) sur transport réel** : la mutation légitime du cycle de vie CDV vers `emise`/`recue` survient à l'**émission réelle** (adaptateurs SFTP/AS2/AS4/API — items Xavier), qui consommera `recipient_platform`. Différé (héritage 3.3, inchangé).
- **RE automatique post-301** : **REFUSÉ** (D1) — la spec dit « **peut** » (facultatif), le déclenchement est un **jugement opérateur** après correction des données source ; un automatisme fabriquerait une décision. Réexaminable seulement si la DGFiP prescrit un rejeu automatique.
- **Filtre de liste par `recipient_platform`** : le filtre `routing_status` (Task 4) couvre le besoin d'observabilité 3.3 ; un filtre par plateforme résolue est un raffinement sans demande métier. Différé.
- **Colonnes de backoff/plafond pour le sweep routage** (`routing_attempts`/`routing_next_retry_at`) : la rotation équitable par `updated_at` (D7) suffit et reste bornée ; un backoff persistant (nouvelle colonne + migration) n'est justifié que si l'exploitation observe une churn réelle sur des factures durablement `unaddressable`. Différé, documenté.
- **Découplage des cadences RE / planificateur RE** : le RE est **déclenché à la demande** (opérateur), pas planifié — aucun scheduler RE n'est requis ni souhaitable (un RE planifié serait un automatisme, cf. refus ci-dessus).

---

## Décisions structurantes (à lire avant d'exécuter)

### D1 — Chemin RE = endpoint opérateur dual-auth → régénération COMPLÈTE via le pipeline existant ; PAS d'automatisme post-301
- **Extraction réglementaire primaire BINDING** (ledger, §3.7.7 p.68-69, notes 127/131, Figure 58) : « la plateforme agréée **PEUT** transmettre un flux rectificatif (type RE) … qui **ANNULE ET REMPLACE L'ENSEMBLE** des données agrégées et précédemment transmises au titre de cette période ». Trois conséquences **fermes** : (a) un RE est une **REGÉNÉRATION COMPLÈTE** de la période (par `flux_kind` × déclarant/rôle), **jamais un diff** ; (b) le déclencheur est « **erreur sur des données TRANSMISES** », **facultatif** — donc un **jugement OPÉRATEUR** (les données source ont été corrigées d'abord), **PAS** un automatisme post-301 (qui **fabriquerait** une décision — anti-pattern « aucune fabrication ») ; (c) le RE suit le **même cycle 300/301** (§3.7.9) et porte un **NOUVEAU** `transmission_ref` (note 131 : unicité PPF `(numéro, SIREN, période)`).
- **Retenu** : `POST /ereporting/retransmissions` (dual-auth `TenantAuthGuard` + `RolesGuard` + `CsrfGuard`, `@Roles('owner','admin','accountant')`, **motif exact `PaymentsController.capture:64-66`** — 1ᵉ précédent de mutation dual-auth du projet), body zod `{ declarantId, fluxKind, periodStart }`. L'endpoint **valide les garde-fous** (D4), calcule le discriminant `reSeq` (D3), **enfile** un `EREPORTING_GENERATE_JOB` avec `type='RE'` sur la file `ereporting-generation`, et renvoie **202 Accepted** `{ jobId, transmissionRef }`. Le worker existant (`EreportingGenerationProcessor` → `EreportingGenerationService.generate`) **régénère depuis les données source ACTUELLES** (`invoicesForPeriod`/`listPaymentsForPeriod` lues à l'exécution — la fraîcheur est intrinsèque au pipeline) : **aucune** logique de diff, **aucun** nouveau pipeline. Le `type='RE'` traverse `buildDocument`/`persistAndTransmit`/`insertTransmission` déjà écrits pour les deux types.
- **Réponse async** : comme toute génération e-reporting, le RE est asynchrone (BullMQ). L'endpoint ne renvoie **pas** le résultat de transmission (202, pas 200/201) ; l'opérateur **observe** le RE via `GET /ereporting/transmissions` (déjà livré 2.3, expose `type`/`status`/`transmissionRef`).

### D2 — L'API devient PRODUCTEUR de `ereporting-generation` (enregistrement dans `QueueModule`)
- **État vérifié** : `EREPORTING_GENERATION_QUEUE` n'est enregistrée que dans **`WorkerQueueModule`** (worker-queue.module.ts:66-72) — le process worker est **à la fois producteur** (sweep) **et consommateur** (processor). Le process **HTTP** (`QueueModule`, queue.module.ts) n'enregistre que `invoice-generation` (producteur d'ingestion) + `maintenance`.
- **Retenu** : enregistrer `EREPORTING_GENERATION_QUEUE` **aussi dans `QueueModule`** (via `BullModule.registerQueueAsync` + `ereportingGenerationJobOptions`, **exactement** comme `invoice-generation` y est enregistrée) → l'API devient **producteur** de cette file, **strict miroir** de la façon dont l'ingestion produit `invoice-generation` **et** la réconciliation la reproduit côté worker. Les flags `skipWaitingForReady`/`skipVersionCheck` du `forRootAsync` **producteur HTTP** (queue.module.ts:66-67, documentés « useful when adding jobs via HTTP endpoints ») s'appliquent **exactement** à ce cas. Ajouter un **wrapper `EreportingGenerationQueue`** (motif `InvoiceGenerationQueue` : `@InjectQueue` + `enqueueRetransmission(...)`), fourni **et exporté** par `QueueModule`. `EreportingModule` importe `QueueModule` (motif `InvoicesModule`) pour injecter le wrapper.
- **Cohérence contrat** : le contrat inscrit dans queue.module.ts:20-33 (« ne JAMAIS réutiliser tel quel le `forRootAsync` producteur pour le Worker ») **reste respecté** — on ajoute une file au **producteur HTTP** existant, on ne touche pas au `forRootAsync` du worker.

### D3 — Ref RE discriminé (`reSeq`) + idempotence RE en 3 couches (miroir EXACT de la défense IN)
- **Le piège vérifié in situ** : (1) `transmission_ref` **n'a AUCUNE contrainte d'unicité** (schema.ts / migration 0016 — seul l'index partiel `WHERE type='IN'` existe) ; (2) `buildTransmissionRef` est **déterministe** `ER-${id8}-${periodStart}-${type}` (ereporting-generation.service.ts:49-55) → **tout** RE d'un slot donné porterait le **même** ref `…-RE` ; (3) le store local est **write-once par ref** (`LocalFilesystemTransmissionStore`) → un 2ᵉ RE sur la même période **collisionnerait** ; (4) `insertTransmission` n'est idempotent **que pour `type='IN'`** (onConflictDoNothing `WHERE type='IN'`, ereporting.repository.ts:198-205) → un RE **rejoué par BullMQ** (throw `port.transmit` après insert, `attempts=3`) **DUPLIQUERAIT** la ligne. **« Plusieurs RE possibles » (cadrage, note 127) est donc IMPOSSIBLE en l'état.**
- **Retenu — défense en profondeur à 3 couches, calquée sur celle de l'IN (`ereporting-sweep.service.ts:56-78`)** :
  - **Couche 1 (déterminisme du discriminant)** : `reSeq` = **nombre de RE déjà committés** pour `(declarantId, fluxKind, periodStart)`, lu à l'**enfilement** (repo `countRetransmissions`). Deux déclenchements concurrents lisent le **même** `reSeq` → collapse voulu (anti-double-clic) ; un RE délibéré **ultérieur** lit `reSeq` incrémenté → émission **distincte**. Pas d'horloge, testable.
  - **Couche 2 (`jobId` déterministe)** : `${declarantId}-${fluxKind}-${periodStart}-RE-${reSeq}` — **AMENDEMENT NIT-2 revue T1 (BINDING)** : séparateur `-` OBLIGATOIRE (leçon 2.4-T9) — la forme initiale à 5 segments `:` ferait LEVER bullmq 5.80.7 (`Custom Id cannot contain :` hors exactement 3 segments ; vérifié au code bullmq par la revue T1). BullMQ déduplique les ré-enfilements tant que le job existe (anti-double-clic dans la fenêtre de rétention).
  - **Couche 3 (backstop DB)** : **nouvel index partiel unique** `(declarant_id, flux_kind, period_start, transmission_ref) WHERE type='RE'` (migration 0027). `buildTransmissionRef` gagne un **paramètre optionnel `reSeq`** — pour `type='RE'` : `ER-${id8}-${periodStart}-RE-${reSeq}` (borne : 3+8+1+8+3+1+≤4 = **≤ 28 chars < 50**) ; **IN inchangé** (reSeq `undefined` → `…-IN` **byte-identique**). `EreportingGenerationJob` gagne `reSeq?: number` (payload minimal préservé, IN l'omet). `insertTransmission` **arbitre le conflit PAR `type`** : `IN` → cible `(declarant_id, flux_kind, period_start) WHERE type='IN'` (**byte-identique**, sweep backstop intact) ; `RE` → cible le nouvel index RE. Un RE rejoué → conflit → `created:false` → `findTransmissionStatus` → **reprise verbatim** (`persistAndTransmit:345-353`, la logique de reprise IN **inchangée**). **Résultat : le RE hérite de la MÊME retry-idempotence que l'IN**, sans aucune duplication.
- **Anti-double-clic — sort explicite** : deux POST identiques quasi-simultanés lisent `reSeq=0` → `jobId` identique → **un seul** RE#0 (BullMQ dédup + index RE). Un 2ᵉ RE **délibéré** ultérieur (données re-corrigées) lit `reSeq=1` → `jobId`/ref/clé-store **distincts** → RE#1. Deux 2ᵉ-RE délibérés concurrents (rarissime) collapsent en un RE#1 (le second opérateur re-déclenche après clôture → RE#2). **Comportement honnête, documenté (Task 5).**
- **Aucune fabrication d'unicité fausse** : l'index RE **inclut `declarant_id` + `flux_kind`** car `transmission_ref` **n'encode PAS `fluxKind`** (le même ref `…-IN` sert transactions ET payments — vérifié) et `id8` peut collisionner entre déclarants ; le tuple complet est la **seule** clé d'idempotence sûre.

### D4 — Garde-fous RE : déclarant existant (RLS, 404 anti-fuite) + une transmission IN préalable (409) ; `active` NON exigé
- **Déclarant** : `findDeclarant(tenantId, declarantId)` (RLS) → `null` ⇒ **404 byte-identique** (déclarant inconnu **ou** cross-tenant indiscernables — anti-fuite, motif `EreportingController.notFound:126-130`). `declarantId` **malformé** (non-UUID) → **422** par `z.uuid()` (motif `PaymentsController` body-validation — cohérent avec le codebase : la garde 404-byte-identique de D7/3.3 visait les **params de chemin** bruts vers SQL, pas les corps zod-validés).
- **Existence d'un IN préalable** : la spec dit « erreur sur des données **TRANSMISES** » ⇒ un IN existe **par définition**. On l'**EXIGE** : `findInitialTransmission(tenantId, declarantId, fluxKind, periodStart)` (repo, RLS) → `null` ⇒ **409** (« aucune transmission initiale à rectifier pour cette période »). Cette exigence est **peu coûteuse et honnête** (rectifier une période jamais transmise n'a aucun sens) et **implique la période échue** (un IN n'existe que si le sweep a tourné sur une période due — pas de garde « période échue » séparée). L'IN est accepté **quel que soit son statut** (`prepared`/`transmitted`/`deposee`/`rejetee`) : cela couvre **à la fois** le cas normal (rectifier un `deposee`/`transmitted`) **et** le **deadlock 2.3** (IN né-`rejetee` REJ_SEMAN — le RE est LA sortie, D6). L'IN fournit **aussi** `periodEnd` (recopié dans le payload — **jamais** fait confiance au client pour la borne de période).
- **`active` NON exigé** (décision tranchée) : rectifier des **données passées** d'un déclarant devenu inactif est **légitime** (l'erreur portait sur des données transmises quand il était actif). Exiger `active=true` **bloquerait** une correction valide. On exige donc **existence + IN préalable**, pas l'activité. Rationale documenté (Task 5).

### D5 — Le RE n'efface JAMAIS l'IN ; supersession = sémantique PPF ; journal append-only
- Le RE **ajoute** une ligne `type='RE'` ; il **ne supprime/ne mute PAS** la ligne IN (ni son journal). La supersession « annule-et-remplace » est une **sémantique côté PPF** (le PPF traite le rectificatif) ; **notre** modèle garde l'IN comme **enregistrement historique** et le RE comme transmission corrigée — `ereporting_status_events` reste **append-only** (schema.ts : « journal APPEND-ONLY … PAS de trigger de hash-chain »). **Aucune fabrication, aucune suppression d'enregistrement probatoire.**
- **Cycle de vie inchangé** : le RE naît `prepared` (ou `rejetee` si REJ_SEMAN local — même chemin que l'IN via `insertTransmission` + `rejectMotif`), transite `transmitted` (`markTransmitted`), puis `deposee`/`rejetee` via `recordPpfStatus` (ereporting-status.service.ts — **inchangé**, opère sur **n'importe quelle** transmission par id). **Observabilité** : le RE apparaît dans `GET /ereporting/transmissions` (le champ `type` est déjà projeté, ereporting.controller.ts:72). **Aucun changement au status service ni au contrôleur de consultation.**

### D6 — Runbook : le RE débloque le slot IN né-`rejetee` (deadlock 2.3)
- **État hérité (README, runbook 2.3)** : « une transmission IN née `rejetee` (rejet local `REJ_SEMAN`) occupe **définitivement** le slot unique (déclarant × flux × période) » — après correction des données source, la période **ne repart PAS** automatiquement ; procédure manuelle « en attente d'un chantier RE ».
- **Retenu** : le chantier RE **EST** la sortie. Le runbook (Task 5) documente la procédure **réelle** : (1) corriger les données source (facture(s)/encaissement(s)) ; (2) `POST /ereporting/retransmissions` `{declarantId, fluxKind, periodStart}` → un RE régénère la période **valide** cette fois, avec un `transmission_ref` **distinct** (`…-RE-0`) qui **passe** l'index (RE libre) et le store write-once. L'IN `rejetee` reste en base (historique), mais la période est **de facto** re-déclarée — sans jamais toucher l'index partiel IN (le slot IN reste occupé par la ligne `rejetee`, c'est voulu : le RE ne prétend pas être un IN).

> **AMENDEMENT M-D4-1 (revue du plan, BINDING — requalification du claim)** : « le deadlock 2.3 est levé » est **CONDITIONNEL**, pas un fait. Le statut `rejetee` recouvre DEUX réalités distinctes : (a) **301 PPF** — l'IN a été TRANSMIS puis rejeté par le PPF : le RE correspond exactement à la lettre de la spec (« données précédemment transmises ») ; (b) **born-rejetee local** (REJ_SEMAN XSD, port JAMAIS appelé — persistAndTransmit) : le PPF n'a RIEN vu de cette période, et l'extraction primaire (§3.7.7 p.68-69) est SILENCIEUSE sur l'admission d'un RE sans IN transmis préalable. **INTERPRÉTATION FLAGGÉE go-live** : le RE sur slot born-rejetee est PERMIS par le code (débloque le deadlock de manière pragmatique) mais documenté comme interprétation à VALIDER en pilote PPF — le runbook (Task 5) DISTINGUE explicitement les deux cas de `rejetee` et cite la réserve. **DÉCISION CONTRÔLEUR (cas `prepared`)** : un RE est REFUSÉ (409, même corps que « IN absent ») tant que l'IN de la période est en statut `prepared` — cet IN est en cours de reprise automatique par le sweep backstop (resume), autoriser un RE créerait un aléa d'ordre RE-avant-IN au PPF. Le garde D4 devient donc : IN existe ET IN.status ≠ 'prepared' → RE admissible ; sinon 409.

### D7 — Sweep routage : miroir `ArchiveRetryService` ; statuts `pending`+`unaddressable` ; `ambiguous` EXCLU ; rotation équitable par `updated_at`
- **État vérifié (M1/3.3 BINDING)** : `resolveAndRecord` laisse `routing_status='pending'` **INCHANGÉ** sur erreur opérationnelle (recipient-routing.service.ts:106-113) et **rien ne le rejoue** — `sweepStuckGeneration` ne balaie que `received`/`generating`, **jamais** une facture `generated` au routage `pending`. C'est le **seul** best-effort du projet **sans reprise**.
- **Retenu — miroir EXACT `ArchiveRetryService.sweepFailedArchives` (archive-retry.service.ts:22-42) + son SD `find_failed_archives` (0015)** :
  - **SD `find_pending_routing_invoices(p_limit)`** (migration 0028, `SECURITY DEFINER` read-only, cross-tenant) : `SELECT tenant_id, id FROM public.invoices WHERE status='generated' AND routing_status IN ('pending','unaddressable') AND updated_at < now() - interval '15 minutes' ORDER BY updated_at LIMIT p_limit`. **Gate de fraîcheur 15 min** (miroir `find_failed_archives` : ne pas concurrencer une génération/résolution fraîche). **Borné** par `p_limit` (batch, miroir `RETRY_BATCH=100`).
  - **`RecipientRoutingRetryService.sweepPendingRouting()`** (worker/) : `pool.query('SELECT … FROM find_pending_routing_invoices($1)', [BATCH])` **hors contexte tenant**, boucle sur les lignes, `loadCanonical(tenant_id, id)` (invoices.repository.ts:157) puis `routing.resolveAndRecord(tenant_id, id, invoice)` — **best-effort strict** (resolveAndRecord ne throw jamais, D2/3.3). Log + retour du compte. **Aucun enfilement** (rejeu direct, motif `ArchiveRetryService`/`CdvStuckRetryService` — la résolution est idempotente par construction).
  - **Câblage** : `ROUTING_RETRY_JOB='routing-retry'` (maintenance.job.ts) ; `RoutingRetryScheduler` (miroir `ArchiveRetryScheduler` : `upsertJobScheduler('routing-retry-scheduler', {every: ROUTING_RETRY_EVERY_MS}, {name: ROUTING_RETRY_JOB})`) ; branche `MaintenanceProcessor` (dispatch par `job.name`, **jamais** un 2ᵉ `@Processor`) ; env `ROUTING_RETRY_EVERY_MS` (défaut `300_000`, miroir `ARCHIVE_RETRY_EVERY_MS`). Providers `RecipientRoutingRetryService`+`RoutingRetryScheduler` ajoutés à `WorkerModule` (deps `APP_POOL`/`RecipientRoutingService`/`InvoicesRepository` **déjà fournies**).
- **`ambiguous` EXCLU** (décision) : `ambiguous` = ambiguïté **structurelle** de l'annuaire nécessitant un **nettoyage opérateur** (recipient-routing.service.ts:34-36) — re-résoudre sans nettoyage re-échouerait à l'identique. Seuls `pending` (opérationnel, transitoire) et `unaddressable` (retriable : une ligne d'annuaire peut **entrer en vigueur** plus tard via la sync) sont balayés.
- **Anti-churn / anti-starvation** : `ORDER BY updated_at` + `markRoutingStatus` **bumpe `updated_at`** à **chaque** écriture (invoices.repository.ts:483, même statut inchangé) → une facture re-résolue-mais-toujours-`unaddressable` **repart en fin de file** ⇒ rotation équitable, batch **borné** par cycle. Un `unaddressable` durable est re-tenté périodiquement (écrasement déterministe idempotent) sans jamais constituer un backlog. Backoff persistant **différé** (colonnes) tant qu'aucune churn réelle n'est observée.

> **AMENDEMENT M-D7-1 (revue du plan, BINDING — la rotation n'était PAS complète)** : le chemin d'erreur **OPÉRATIONNELLE** de `resolveAndRecord` (le SEUL générateur de `pending` durable) n'écrit RIEN (recipient-routing.service.ts:106-113) → `updated_at` non bumpé → un `pending` dont la résolution échoue opérationnellement À CHAQUE passage resterait EN TÊTE de file et hot-looperait (famine des suivants), divergence avec le miroir archive (qui écrit `failed` → bump). **DÉCISION CONTRÔLEUR (option bump, sans colonne)** : `RecipientRoutingRetryService`, APRÈS `resolveAndRecord`, relit l'état (`findRoutingState`) ; si le statut est resté `pending`, il appelle `markRoutingStatus(tenantId, id, 'pending')` — un « touch » explicite de rotation (écrasement même-valeur, bump `updated_at`, gate de fraîcheur 15 min = espacement naturel des retentatives). Commentaire dédié sur ce touch (ce n'est PAS un changement d'état, c'est l'anti-famine) + test unitaire : facture dont la résolution échoue opérationnellement deux fois → les DEUX passages la voient mais elle ne bloque pas le batch (rotation prouvée avec une 2ᵉ facture derrière elle).

### D8 — Filtre de liste `routing_status` + exposition dans le DTO de liste (revert justifié de D3/3.3)
- **État** : `GET /invoices` (invoices.controller.ts:58-70) n'a que `limit`/`cursor` ; le keyset micro-précis (invoices.repository.ts:345-390, `to_char … US` + comparaison `::timestamptz`) est **intact** ; `InvoiceSummary` **n'expose PAS** le routage (D3/3.3 : « on ne widen pas le DTO de liste » — faute de consommateur).
- **Retenu** : (a) **filtre** `GET /invoices?routingStatus=` — param query **optionnel** validé par un `z.enum(['pending','resolved','unaddressable','ambiguous'])` (source unique `routingStatus.enumValues`, invoices.repository.ts:19) → **422** si invalide ; absent ⇒ aucun filtre (comportement inchangé). Combiné au keyset via `and(keyset, statusFilter)` (drizzle ignore les `undefined`) — **le curseur reste intact**. (b) **exposition** : ajouter `routingStatus` + `recipientPlatform` à `InvoiceSummary` et au `select` de `list()`. **Revert justifié de D3/3.3** : la restriction « ne pas widen » était motivée par l'**absence de consommateur** ; le filtre **EST** ce consommateur, et l'exposition **solde le trou d'observabilité M1** (le runbook SQL `SELECT id,number … WHERE routing_status IN (…)` devient **inutile** — on filtre ET on voit l'état). Réconcilier `InvoiceDetail extends InvoiceSummary` (ses champs `routingStatus`/`recipientPlatform` deviennent hérités — les **retirer** de `InvoiceDetail` qui devient un alias sémantique de `InvoiceSummary`, ou les conserver typés `string`/`RoutingStatus` au plus juste ; **gate : `GET /invoices/:id` inchangé**).
- **Anti-fuite / RLS** : le filtre s'applique **sous RLS** (aucune fuite cross-tenant) ; un `routingStatus` valide sans résultat ⇒ page vide (jamais 404 — c'est une liste).

### D9 — Deux migrations index/SD seules ; aucune table, colonne, RLS/grant nouvelle
- **0027** (`db:generate` depuis le schéma) : `CREATE UNIQUE INDEX ereporting_transmissions_declarant_flux_period_re_ref_unique ON ereporting_transmissions (declarant_id, flux_kind, period_start, transmission_ref) WHERE type='RE'`. Additif, sur table déjà `ENABLE`+`FORCE` + grants. Idx 27, `_journal` `version:"7"`, `when` ~+100000 après 0026.
- **0028** (migration **custom** SQL, motif 0015/0020 — **non** dérivée du schéma) : `find_pending_routing_invoices(p_limit)` (SD read-only) + `REVOKE ALL FROM PUBLIC` + `GRANT EXECUTE TO factelec_app`. Idx 28, `when` ~+100000 après 0027.
- **`reSeq` n'est PAS une colonne** : dérivé au vol (`countRetransmissions`) et encodé dans le `transmission_ref`. **Aucune** colonne ajoutée sur aucune table. **Aucune** nouvelle policy RLS ni grant de table (les deux tables concernées sont déjà `FORCE` + grants). **Aucune** nouvelle table.
- **Note de vérification** : la migration max avant ce plan est **0026** ; `db:generate` doit produire **0027** (relire le SQL : **seulement** le `CREATE UNIQUE INDEX … WHERE type='RE'`, aucun autre DDL parasite).

### D10 — Rappel des différés (voir Périmètre) & posture « aucune fabrication »
- E-signature consentement, worker-role split, transition `emise`/transport réel, RE automatique post-301 (**refusé**), filtre liste par plateforme, backoff persistant du sweep routage, scheduler RE : **tous différés/refusés** avec rationale au Périmètre. La posture reste : **rejouer/réparer** l'existant sans **fabriquer** d'affirmation (pas d'émission spéculative, pas de décision automatique, pas de suppression d'enregistrement probatoire).

---

## Versions & dépendances (registre npm — à re-vérifier à chaque tâche)

| Brique | Fournisseur | Provenance / note |
|---|---|---|
| Régénération RE | `EreportingGenerationService` + `EreportingRepository` (déjà `apps/api`) | **Aucun ajout.** Pipeline réutilisé verbatim ; `reSeq` additif. |
| File HTTP RE | **BullMQ 5.80.x** (déjà présent) | **Aucune nouvelle file** — `ereporting-generation` gagne un **producteur** côté `QueueModule`. |
| Sweep routage | `pg` (`pool.query`) + SD (drizzle custom) | Miroir `ArchiveRetryService`/`find_failed_archives`. **Aucun ajout.** |
| Persistance | drizzle + `pg` (déjà présents) | Migrations **0027** (index partiel RE, généré) + **0028** (SD custom). Aucune table/colonne/RLS/grant. |
| Endpoints / validation | `zod` inline + `@nestjs/common` (déjà présents) | **Aucun ajout.** |
| Tests | **Vitest 4.1.10** (déjà présent) | Split `heavy`/`light` de 3.3 respecté ; 2 suites worker ajoutées à `HEAVY_TESTS`. |

> **Gate** : `pnpm run audit:ci` = 0 et `pnpm outdated -r` **vierge**. Vérifier à **chaque** tâche (patch amont possible). Bump **`apps/api` 0.9.0 → 0.10.0** (Task 5) ; `invoice-core` **reste 0.4.0** (non touché).

---

## Points de risque signalés d'emblée

1. **Duplication de transmission RE au retry.** **Traité** : D3 — `transmission_ref` non-unique + store write-once ⇒ défense 3 couches (reSeq → jobId → **index partiel RE 0027**) ; `insertTransmission` arbitre le conflit par `type`, l'IN reste byte-identique, le RE hérite de la reprise verbatim (`created:false` → resume). e2e retry-idempotence.
2. **Régression du pipeline e-reporting existant.** **Traité** : D3 — `buildTransmissionRef` IN **byte-identique** (reSeq `undefined`), `EreportingGenerationJob.reSeq` optionnel omis par le sweep, arbitrage IN inchangé (sweep backstop intact). Gate : e2e `ereporting-generation`/`ereporting-sweep`/`ereporting-payments` **verts**.
3. **RE fabriqué / automatisme post-301.** **Traité** : D1 — déclenchement opérateur **manuel** seul ; aucun automatisme ; régénération complète (jamais un diff) ; l'IN n'est jamais effacé (D5, journal append-only).
4. **Fuite d'existence de déclarant (RE).** **Traité** : D4 — 404 byte-identique (inconnu/cross-tenant indiscernables) ; malformé → 422 zod (motif corps `PaymentsController`).
5. **API productrice indûment couplée au worker.** **Traité** : D2 — enregistrement dans le `forRootAsync` **producteur HTTP** existant (flags skip*), contrat worker (eager, sans skip*) **inchangé** — strict miroir `invoice-generation`.
6. **Backlog / churn / famine du sweep routage.** **Traité** : D7 — SD borné (batch + gate 15 min), `ORDER BY updated_at` + bump `updated_at` ⇒ rotation équitable ; `ambiguous` exclu ; best-effort strict (jamais throw).
7. **Rupture du curseur de liste par le filtre.** **Traité** : D8 — `and(keyset, statusFilter)` (drizzle ignore `undefined`), keyset micro-précis **inchangé** ; e2e « filtre + pagination cohérente ».
8. **Perte d'hermétisme / verrou heavy-suites.** **Traité** : les 2 suites worker (RE régénération, routing-sweep) entrent dans `HEAVY_TESTS` — sinon `heavy-suites.arch` échoue (invariant strict `createTestWorker ≡ HEAVY_TESTS`).
9. **Migration parasite au `db:generate`.** **Traité** : D9 — relire 0027 (SEUL le `CREATE UNIQUE INDEX … WHERE type='RE'`), 0028 custom (SD seule) ; idx 27/28 contigus après 0026.
10. **Sur-affirmation d'unicité RE.** **Traité** : D3 — l'index RE inclut `declarant_id`+`flux_kind` (le ref n'encode pas `fluxKind`, `id8` peut collisionner) — clé d'idempotence **sûre**.

---

## Sources vérifiées in situ (lecture seule — extraction réglementaire RE consignée au ledger)

Faits vérifiés dans le code à `main` (HEAD `de70efd`, apps/api 0.9.0), non paraphrasés :
- **Chemin RE** : `TRANSMISSION_TYPES=['IN','RE']` (`nomenclature.ts`, normatif, R/O) ; `buildTransmissionRef` déterministe (`ereporting-generation.service.ts:49-55`) ; `type='IN'` **hardcodé** au sweep (`ereporting-sweep.service.ts:41`, jobs enfilés l.102-135) ; `generate` dispatche `fluxKind` puis `persistAndTransmit` (l.106-373) ; `insertTransmission` idempotent **`WHERE type='IN'` seul** (`ereporting.repository.ts:176-242`), reprise `created:false`→`prepared`→transmit (`persistAndTransmit:345-353`) ; `transmission_ref` **sans unicité** (schema.ts `ereportingTransmissions`, migration 0016 — seul index partiel IN) ; `recordPpfStatus` opère par id, inchangé (`ereporting-status.service.ts`) ; `GET /ereporting/transmissions` projette déjà `type` (`ereporting.controller.ts:72`). Extraction primaire §3.7.7 p.68-69 / notes 127/131 : ledger `.superpowers/sdd/progress.md` (« EXTRACTION PRIMAIRE RE PAR LE CONTRÔLEUR »).
- **File producteur** : `EREPORTING_GENERATION_QUEUE` enregistrée **uniquement** dans `WorkerQueueModule` (`worker-queue.module.ts:66-72`) ; `QueueModule` (producteur HTTP) n'a que `invoice-generation`+`maintenance` (`queue.module.ts`, flags skip* l.66-67) ; wrapper précédent `InvoiceGenerationQueue` (`invoice-generation.queue.ts`) ; `InvoicesModule` importe `QueueModule` (`invoices.module.ts`).
- **Sweep routage** : `resolveAndRecord` laisse `pending` sur erreur opérationnelle (`recipient-routing.service.ts:106-113`), `unaddressable`/`ambiguous` typés (l.74-105) ; `markRoutingStatus` bumpe `updated_at` (`invoices.repository.ts:471-487`) ; `loadCanonical` (l.157) ; gabarit `ArchiveRetryService` (`archive-retry.service.ts:22-42`) + SD `find_failed_archives` (`0015_dead_letters_rls.sql:33-50`) + `ArchiveRetryScheduler` + branche `MaintenanceProcessor` (`maintenance.processor.ts:56-103`, jobs `maintenance.job.ts`) ; env miroir `ARCHIVE_RETRY_EVERY_MS` (`config/env.ts:102`).
- **Filtre liste** : `list()` keyset micro-précis intact (`invoices.repository.ts:326-390`) ; `InvoiceSummary` sans routage (l.21-38) ; `RoutingStatus`/`routingStatus.enumValues` (l.19, schema.ts:61) ; `GET /invoices` `limit`/`cursor` seuls (`invoices.controller.ts:58-70`).
- **Verrou/split** : `HEAVY_TESTS` (`vitest.config.ts:12-22`), invariant `heavy-suites.arch.test.ts` ; dual-auth précédent `PaymentsController.capture` (`payments.controller.ts:64-66`) ; migration max **0026** (`meta/_journal.json`).

---

## Structure des fichiers (vue d'ensemble)

```
apps/api/
  package.json                                   # version 0.9.0 → 0.10.0 (Task 5)
  src/db/
    schema.ts                                    # + index partiel unique RE sur ereportingTransmissions (Task 1)
    migrations/0027_ereporting_re_idempotency.sql # (drizzle) CREATE UNIQUE INDEX … WHERE type='RE' (Task 1)
    migrations/0028_routing_retry_sweep.sql       # (custom) SD find_pending_routing_invoices (Task 3)
    migrations/meta/_journal.json                 # + 0027, 0028
  src/ereporting/
    ereporting-generation.service.ts             # buildTransmissionRef(+reSeq) ; generate{Transactions,Payments} passent job.reSeq (Task 1)
    ereporting.repository.ts                      # insertTransmission arbitre par type ; + countRetransmissions/findInitialTransmission (Task 1)
    ereporting-retransmission.service.ts          # garde-fous D4 + enfilement RE (Task 2)
    ereporting.controller.ts                      # + POST /retransmissions dual-auth (Task 2)
    ereporting.module.ts                          # + import QueueModule ; + RolesGuard/CsrfGuard/EreportingRetransmissionService (Task 2)
  src/queue/
    ereporting-generation.job.ts                 # EreportingGenerationJob + reSeq? (Task 1)
    ereporting-generation.queue.ts               # NOUVEAU wrapper producteur (Task 2)
    queue.module.ts                              # + registerQueueAsync(EREPORTING_GENERATION_QUEUE) + EreportingGenerationQueue (Task 2)
    maintenance.job.ts                           # + ROUTING_RETRY_JOB (Task 3)
  src/invoices/
    invoices.repository.ts                       # InvoiceSummary + routingStatus/recipientPlatform ; list() enrichi + filtre (Task 4)
    invoices.service.ts / invoices.controller.ts # list(tenant, limit, cursor, routingStatus?) + zod (Task 4)
  src/worker/
    recipient-routing-retry.service.ts           # NOUVEAU sweep (miroir ArchiveRetryService) (Task 3)
    routing-retry.scheduler.ts                   # NOUVEAU (miroir ArchiveRetryScheduler) (Task 3)
    maintenance.processor.ts                     # + branche ROUTING_RETRY_JOB (Task 3)
    worker.module.ts                             # + RecipientRoutingRetryService + RoutingRetryScheduler (Task 3)
  src/config/env.ts                              # + ROUTING_RETRY_EVERY_MS (Task 3)
  vitest.config.ts                               # HEAVY_TESTS += ereporting-retransmission, routing-retry (Tasks 2/3)
  tests/
    unit/
      build-transmission-ref.test.ts             # ref RE discriminé vs IN byte-identique (Task 1)
      ereporting-retransmission.service.test.ts  # garde-fous D4 (oracle indépendant) (Task 2)
      recipient-routing-retry.service.test.ts    # sweep : pending+unaddressable, ambiguous exclu (Task 3)
    e2e/
      ereporting-retransmission.e2e.test.ts      # RE régénère (données actuelles) + retry-idempotent (Task 1) ; endpoint bout-en-bout (Task 2) → HEAVY
      routing-retry.e2e.test.ts                  # sweep résout un 'pending'/'unaddressable' (Task 3) → HEAVY
      invoice-routing-filter.e2e.test.ts         # GET /invoices?routingStatus= + keyset intact + RLS (Task 4) → LIGHT
```

Fichiers hors code : `README.md` racine + `apps/api/README.md` (runbook déblocage RE, Task 5).

---

### Task 1 : Pipeline RE retriable-idempotent (ref discriminé + index partiel RE + repo)

**Files:**
- Modify: `apps/api/src/db/schema.ts` ; Create: `apps/api/src/db/migrations/0027_ereporting_re_idempotency.sql` (drizzle) + snapshot + `_journal`
- Modify: `apps/api/src/ereporting/ereporting-generation.service.ts`, `apps/api/src/ereporting/ereporting.repository.ts`, `apps/api/src/queue/ereporting-generation.job.ts`
- Create: `apps/api/tests/unit/build-transmission-ref.test.ts`, `apps/api/tests/e2e/ereporting-retransmission.e2e.test.ts` (branche worker RE) ; Modify: `apps/api/vitest.config.ts` (`HEAVY_TESTS`)

**Interfaces:**
- Consumes : `EreportingGenerationService.generate`, `insertTransmission`, index partiel IN.
- Produces (Task 2) : `buildTransmissionRef(declarantId, periodStart, type, reSeq?)` ; `EreportingGenerationJob.reSeq?` ; `EreportingRepository.countRetransmissions(tenantId, declarantId, fluxKind, periodStart)`, `findInitialTransmission(tenantId, declarantId, fluxKind, periodStart)` ; RE retry-idempotent.

> **D3/D5** : IN **byte-identique** (reSeq `undefined`) ; RE = `…-RE-${reSeq}` ; `insertTransmission` arbitre le conflit **par `type`** (index IN inchangé + nouvel index RE) ; l'IN n'est **jamais** effacé.

- [ ] **Step 1 : Schéma + migration (index partiel RE)** — `schema.ts` : ajouter à `ereportingTransmissions` un `uniqueIndex('ereporting_transmissions_declarant_flux_period_re_ref_unique').on(t.declarantId, t.fluxKind, t.periodStart, t.transmissionRef).where(sql\`${t.type} = 'RE'\`)` (commentaire : idempotence RE, miroir de la partielle IN — le RE reste libre de coexister, seul un **rejeu du même job** conflicte). `db:generate` → renommer `0027_ereporting_re_idempotency.sql`, idx 27 (`_journal`, `version:"7"`, `when` ~+100000 après 0026). **Relire** : SEUL le `CREATE UNIQUE INDEX … WHERE "type" = 'RE'`, aucune RLS/grant, aucun autre DDL.

- [ ] **Step 2 : Tests unit `buildTransmissionRef` (RED)** — `build-transmission-ref.test.ts` (vecteurs fixes, oracle indépendant) :
```ts
it('IN sans reSeq → ER-${id8}-${period}-IN (byte-identique à l’existant)')
it('RE avec reSeq=0 → ER-${id8}-${period}-RE-0')
it('RE avec reSeq=3 → …-RE-3 (≤ 50 chars)')
it('IN ignore reSeq (défense : reSeq fourni mais type=IN → pas de suffixe)')
```
Run → **RED** (signature à 3 args).

- [ ] **Step 3 : Implémentation (GREEN)** — `buildTransmissionRef(declarantId, periodStart, type, reSeq?)` : base `ER-${id8}-${periodStart}-${type}` ; **si `type==='RE' && reSeq!==undefined`** → `\`${base}-${reSeq}\``, sinon base (IN inchangé). `EreportingGenerationJob` : `+ reSeq?: number` (commentaire : RE seulement, IN l'omet — payload minimal préservé). `generateTransactions`/`generatePayments` : passer `job.reSeq` à `buildTransmissionRef`. `insertTransmission` : **arbitrer le conflit par `row.type`** — `IN` → `onConflictDoNothing({target:[declarantId,fluxKind,periodStart], where: sql\`… type='IN'\`})` (**inchangé**) + recharge `(…, type='IN')` ; `RE` → `onConflictDoNothing({target:[declarantId,fluxKind,periodStart,transmissionRef], where: sql\`… type='RE'\`})` + recharge `(…, type='RE', transmissionRef=row.transmissionRef)`. `persistAndTransmit` **inchangé** (la reprise `created:false`→`prepared`→transmit couvre le RE nativement). Ajouter `countRetransmissions`/`findInitialTransmission` (RLS `tenant.run`).

- [ ] **Step 4 : e2e worker RE (RED→GREEN)** — `ereporting-retransmission.e2e.test.ts` (helper `createTestWorker`, motif `ereporting-generation`) + ajouter le fichier à `HEAVY_TESTS` :
```ts
it('un job type=RE régénère la période COMPLÈTE depuis les données source ACTUELLES (transmission RE créée, ref …-RE-0)')
it('modifier une facture puis re-RE (reSeq=1) → nouvelle transmission …-RE-1 distincte, l’IN et le RE-0 subsistent (journal append-only)')
it('retry-idempotence : rejouer le MÊME job RE (reSeq fixe) → created:false, reprise, AUCUNE ligne dupliquée')
it('l’IN du slot n’est jamais effacé ni muté par un RE')
```
Run → **RED** puis **GREEN**.

- [ ] **Step 5 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): pipeline de retransmission RE idempotent (ref discriminé, index partiel RE, arbitrage de conflit par type)"
```
Expected: PASS ; IN byte-identique (suites ereporting vertes) ; RE retry-idempotent.

---

### Task 2 : Endpoint RE opérateur (producteur file HTTP + garde-fous + POST dual-auth)

**Files:**
- Modify: `apps/api/src/queue/queue.module.ts` ; Create: `apps/api/src/queue/ereporting-generation.queue.ts`
- Create: `apps/api/src/ereporting/ereporting-retransmission.service.ts` ; Modify: `apps/api/src/ereporting/ereporting.controller.ts`, `apps/api/src/ereporting/ereporting.module.ts`
- Create: `apps/api/tests/unit/ereporting-retransmission.service.test.ts` ; Modify: `apps/api/tests/e2e/ereporting-retransmission.e2e.test.ts` (branche endpoint)

**Interfaces:**
- Consumes : Task 1 (`countRetransmissions`/`findInitialTransmission`/`reSeq`), `findDeclarant`, `EREPORTING_GENERATE_JOB`, `TenantAuthGuard`/`RolesGuard`/`CsrfGuard`, `parseBody`.
- Produces : `EreportingGenerationQueue.enqueueRetransmission(...)` ; `POST /ereporting/retransmissions` → 202 `{ jobId, transmissionRef }`.

> **D1/D2/D4/D5** : dual-auth (motif `PaymentsController.capture`) ; garde-fous = déclarant existant (404 anti-fuite) + IN préalable (409), `active` non exigé ; l'API devient producteur (`QueueModule`).

- [ ] **Step 1 : Producteur file HTTP** — `queue.module.ts` : `BullModule.registerQueueAsync({ name: EREPORTING_GENERATION_QUEUE, useFactory: (config) => ({ defaultJobOptions: ereportingGenerationJobOptions(config) }) })` (motif `invoice-generation`, sous le `forRootAsync` skip* HTTP existant) ; provider+export `EreportingGenerationQueue`. `ereporting-generation.queue.ts` (miroir `InvoiceGenerationQueue`) : `enqueueRetransmission({tenantId,declarantId,siren,role,fluxKind,periodStart,periodEnd,reSeq})` → `queue.add(EREPORTING_GENERATE_JOB, {…, type:'RE', reSeq}, { jobId: \`${declarantId}-${fluxKind}-${periodStart}-RE-${reSeq}\` })` (**séparateur `-`, AMENDEMENT NIT-2 revue T1** — 5 segments `:` crasheraient bullmq 5.80.7). Gate intermédiaire : `pnpm build && pnpm typecheck` vert.

- [ ] **Step 2 : Tests service garde-fous (RED)** — `ereporting-retransmission.service.test.ts` (mocks repo+queue, oracle indépendant) :
```ts
it('déclarant inconnu → NotFoundException (404), aucune enfilée')
it('aucun IN préalable pour (déclarant,flux,période) → ConflictException (409), aucune enfilée')
it('nominal → reSeq=count(RE), enqueueRetransmission avec periodEnd repris de l’IN (jamais du client), type=RE')
it('déclarant inactif MAIS IN préalable existe → autorisé (active non exigé)')
it('anti-double-clic : deux appels concurrents (même reSeq) → même jobId (dédup au niveau file)')
```
Run → **RED** (service absent).

- [ ] **Step 3 : Implémentation (GREEN)** — `ereporting-retransmission.service.ts` : `retransmit(tenantId, {declarantId, fluxKind, periodStart})` → `findDeclarant` (null → 404 `problem` motif `EreportingController.notFound`) ; `findInitialTransmission` (null → 409 `problem`) ; `reSeq = countRetransmissions(...)` ; `enqueueRetransmission({… siren/role de findDeclarant, periodEnd de l’IN, reSeq})` ; retour `{ jobId, transmissionRef: buildTransmissionRef(declarantId, periodStart, 'RE', reSeq) }`. `ereporting.controller.ts` : `@Post('retransmissions') @HttpCode(202) @UseGuards(TenantAuthGuard, RolesGuard, CsrfGuard) @Roles('owner','admin','accountant')` + `parseBody(retransmissionSchema, body)` (`declarantId: z.uuid()`, `fluxKind: z.enum(['transactions','payments'])`, `periodStart: z.string().regex(PERIOD_RE)`). `ereporting.module.ts` : `imports += QueueModule` ; `providers += EreportingRetransmissionService, RolesGuard, CsrfGuard` (deps dual-auth, motif `PaymentsModule`/`InvoicesModule`). Commentaire de décision : RE automatique post-301 refusé (jugement opérateur).

- [ ] **Step 4 : e2e endpoint (RED→GREEN)** — dans `ereporting-retransmission.e2e.test.ts` :
```ts
it('POST /ereporting/retransmissions (clé API OU session) → 202 {jobId, transmissionRef}, le worker produit la transmission RE')
it('déclarant d’un autre tenant → 404 byte-identique (anti-fuite)')
it('période sans IN → 409')
it('sans dual-auth (session sans CSRF / rôle viewer) → 403/401 (motif payments)')
it('declarantId malformé → 422 (zod)')
```

- [ ] **Step 5 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): endpoint opérateur dual-auth de retransmission RE (déclenchement manuel, garde-fous déclarant/IN préalable)"
```
Expected: PASS ; le chemin RE est fermé bout-en-bout ; deadlock 2.3 déblocable.

---

### Task 3 : Sweep de reprise du routage destinataire (miroir `ArchiveRetryService`)

**Files:**
- Create: `apps/api/src/db/migrations/0028_routing_retry_sweep.sql` (custom SD) + `_journal`
- Create: `apps/api/src/worker/recipient-routing-retry.service.ts`, `apps/api/src/worker/routing-retry.scheduler.ts`
- Modify: `apps/api/src/worker/maintenance.processor.ts`, `apps/api/src/worker/worker.module.ts`, `apps/api/src/queue/maintenance.job.ts`, `apps/api/src/config/env.ts`
- Create: `apps/api/tests/unit/recipient-routing-retry.service.test.ts`, `apps/api/tests/e2e/routing-retry.e2e.test.ts` ; Modify: `apps/api/vitest.config.ts` (`HEAVY_TESTS`)

**Interfaces:**
- Consumes : SD `find_pending_routing_invoices`, `InvoicesRepository.loadCanonical`, `RecipientRoutingService.resolveAndRecord`, `MAINTENANCE_QUEUE`.
- Produces : `RecipientRoutingRetryService.sweepPendingRouting()` ; `ROUTING_RETRY_JOB` ; cadence dédiée.

> **D7/D9** : SD read-only miroir `find_failed_archives` ; balaye `pending`+`unaddressable` (gate 15 min, batch borné, `ORDER BY updated_at`), **exclut `ambiguous`** ; rejeu direct best-effort (jamais throw) ; aucune table/colonne.

- [ ] **Step 1 : Migration SD (custom)** — `0028_routing_retry_sweep.sql` (miroir **EXACT** `0015`/`0020`) : `CREATE OR REPLACE FUNCTION find_pending_routing_invoices(p_limit integer) RETURNS TABLE(tenant_id uuid, id uuid) LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp STABLE AS $$ SELECT tenant_id, id FROM public.invoices WHERE status='generated' AND routing_status IN ('pending','unaddressable') AND updated_at < now() - interval '15 minutes' ORDER BY updated_at LIMIT p_limit $$;` + `REVOKE ALL … FROM PUBLIC` + `GRANT EXECUTE … TO factelec_app`. `_journal` idx 28. Commentaire : gate 15 min (ne pas concurrencer une résolution fraîche) ; `ambiguous` exclu (nettoyage opérateur) ; rotation équitable via bump `updated_at`.

- [ ] **Step 2 : Tests service (RED)** — `recipient-routing-retry.service.test.ts` (mock pool+repo+routing, oracle indépendant) :
```ts
it('boucle sur les lignes du SD et rejoue resolveAndRecord (loadCanonical → resolve) par ligne')
it('best-effort : une résolution qui échoue n’interrompt pas la boucle (resolveAndRecord ne throw jamais)')
it('retourne le compte traité et log si > 0')
```
Run → **RED** (service absent).

- [ ] **Step 3 : Implémentation (GREEN)** — `recipient-routing-retry.service.ts` (miroir `ArchiveRetryService`) : `RETRY_BATCH=100` ; `sweepPendingRouting()` → `pool.query('SELECT tenant_id, id FROM find_pending_routing_invoices($1)', [RETRY_BATCH])` ; par ligne : `const inv = await this.invoicesRepo.loadCanonical(row.tenant_id, row.id); if (inv) await this.routing.resolveAndRecord(row.tenant_id, row.id, inv)` ; log + retour compte. `maintenance.job.ts` : `+ ROUTING_RETRY_JOB='routing-retry'` (commentaire miroir `ARCHIVE_RETRY_JOB`). `routing-retry.scheduler.ts` (miroir `ArchiveRetryScheduler`) : `upsertJobScheduler('routing-retry-scheduler', {every: ROUTING_RETRY_EVERY_MS}, {name: ROUTING_RETRY_JOB})`. `maintenance.processor.ts` : `+ if (job.name===ROUTING_RETRY_JOB) { const n = await this.routingRetry.sweepPendingRouting(); … }` + injecter `RecipientRoutingRetryService`. `env.ts` : `+ ROUTING_RETRY_EVERY_MS: z.coerce.number().int().positive().default(300_000)` (commentaire miroir `ARCHIVE_RETRY_EVERY_MS`). `worker.module.ts` : `+ RecipientRoutingRetryService, RoutingRetryScheduler` (deps déjà fournies).

- [ ] **Step 4 : e2e worker (RED→GREEN)** — `routing-retry.e2e.test.ts` (helper `createTestWorker`, motif `archive-generation`) + ajouter à `HEAVY_TESTS` :
```ts
it('facture generated routing_status=pending → après sweep + seed annuaire couvrant → resolved + recipient_platform')
it('unaddressable → resolved si une ligne d’annuaire est entrée en vigueur entre-temps')
it('ambiguous → JAMAIS balayé (reste ambiguous)')
it('borne : gate 15 min respectée (une facture fraîche < 15 min n’est pas reprise)')
it('isolation multi-tenant : le sweep cross-tenant écrit chaque résolution sous le bon tenant')
```
Run → **RED** puis **GREEN**.

- [ ] **Step 5 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): sweep de reprise du routage destinataire (pending/unaddressable, miroir de la reprise d'archivage)"
```
Expected: PASS ; le trou de reprise M1/3.3 est comblé.

---

### Task 4 : Filtre de liste `GET /invoices?routingStatus=` + exposition du routage

**Files:**
- Modify: `apps/api/src/invoices/invoices.repository.ts`, `apps/api/src/invoices/invoices.service.ts`, `apps/api/src/invoices/invoices.controller.ts`
- Create: `apps/api/tests/e2e/invoice-routing-filter.e2e.test.ts` (LIGHT)

**Interfaces:**
- Consumes : `list()` keyset, `routingStatus.enumValues`.
- Produces : `list(tenantId, limit, cursor?, routingStatus?)` filtré ; `InvoiceSummary` + `routingStatus`/`recipientPlatform`.

> **D8** : keyset **intact** (`and(keyset, statusFilter)`) ; exposition = revert justifié de D3/3.3 (solde le trou M1) ; zod enum → 422 ; sous RLS.

- [ ] **Step 1 : Tests e2e (RED)** — `invoice-routing-filter.e2e.test.ts` :
```ts
it('GET /invoices?routingStatus=unaddressable ne renvoie que les factures unaddressable (sous RLS)')
it('la liste expose désormais routingStatus et recipientPlatform')
it('pagination cohérente AVEC filtre : le curseur enchaîne sans saut ni doublon (keyset intact)')
it('routingStatus invalide → 422')
it('sans routingStatus → comportement inchangé (toutes les factures)')
```
Run → **RED**.

- [ ] **Step 2 : Implémentation (GREEN)** — `invoices.repository.ts` : `InvoiceSummary += routingStatus: string; recipientPlatform: string|null` ; `list()` : `select` ajoute `routingStatus`/`recipientPlatform` ; signature `list(tenantId, limit, cursor?, routingStatus?: RoutingStatus)` ; `where(and(keyset, routingStatus ? eq(invoices.routingStatus, routingStatus) : undefined))`. Réconcilier `InvoiceDetail` (les champs deviennent hérités — le réduire à un alias de `InvoiceSummary` ou retirer la redondance ; **gate : `GET /invoices/:id` inchangé**). `invoices.service.ts` : `list(tenantId, limit, cursor?, routingStatus?)` propage. `invoices.controller.ts` : `@Query('routingStatus') routingStatus?: string` → valider par `z.enum(routingStatus.enumValues).optional()` (inline, `parseQuery` ou refine) → 422 si invalide.

- [ ] **Step 3 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): filtre de liste par routing_status et exposition du routage dans le DTO de liste"
```

---

### Task 5 : Docs / runbook (déblocage RE) / OpenAPI / bump `0.10.0` — clôture

**Files:**
- Modify: `README.md` racine, `apps/api/README.md`
- Modify: OpenAPI/Swagger si présent (`POST /ereporting/retransmissions`, `GET /invoices?routingStatus=`)
- Modify: `apps/api/package.json` (`version` → `0.10.0`) ; vérifier `packages/invoice-core` = `0.4.0` **non touché**

- [ ] **Step 1 : Documentation honnête** — décrire :
  - **Chemin RE** (D1-D5) : endpoint opérateur **manuel** dual-auth ; régénération **complète** (annule-et-remplace, jamais un diff) depuis les données **actuelles** ; `reSeq` + index partiel RE = **retry-idempotence** (défense 3 couches) ; l'IN n'est **jamais** effacé (journal append-only) ; RE automatique post-301 **refusé** (jugement opérateur).
  - **Runbook déblocage deadlock 2.3** (D6) : IN né-`rejetee` (REJ_SEMAN) → corriger la source → `POST /ereporting/retransmissions` → RE régénère la période valide (ref `…-RE-0` distinct, passe l'index/le store) — le slot IN reste occupé (voulu), la période est de facto re-déclarée. **Remplace** la procédure « en attente d'un chantier RE ».
  - **Sweep routage** (D7) : reprise `pending`+`unaddressable` (miroir archivage), `ambiguous` exclu (nettoyage opérateur), rotation équitable, cadence `ROUTING_RETRY_EVERY_MS`. **Le runbook SQL M1/3.3 est retiré** au profit du filtre de liste.
  - **Filtre liste** (D8) : `GET /invoices?routingStatus=` + exposition ; observabilité soldée.
  - **Différés 3.5+** : e-signature consentement, worker-role split, transition `emise`/transport réel, RE auto post-301 (refusé), filtre par plateforme, backoff persistant du sweep, scheduler RE.

- [ ] **Step 2 : Bump + gate finale + commit**
```bash
# apps/api/package.json : "version": "0.10.0" (phase 3.4 : reprise & retransmission)
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm test && pnpm run audit:ci && pnpm outdated -r
git add -A
git commit -m "docs: reprise & retransmission (chemin RE, sweep routage, filtre liste), bump version 0.10.0"
```
Expected: tout vert ; **invoice-core 100 %×4 non touché**, apps/api ≥ 90 %×4 (agrégat heavy+light), apps/web ≥ 90 %×4 ; audit:ci 0 ; outdated vierge.

---

## Self-Review (contre research 3.4 / le cadrage contrôleur)

**1. Couverture du cadrage :**
- **Chemin RE** : endpoint dual-auth manuel, régénération complète via le pipeline existant (type='RE', ref `-RE` discriminé), même 300/301, garde-fous, deadlock IN né-`rejetee` débloqué → Tasks 1/2 (D1-D6). ✅
- **Sweep routage** (miroir du service de reprise d'archivage RÉEL `ArchiveRetryService`, `pending`+`unaddressable`, borné) → Task 3 (D7). ✅
- **Filtre liste** `routing_status` (zod, curseur intact, exposition assumée) → Task 4 (D8). ✅
- **Anti-double-clic / idempotence RE** tranchés (reSeq + jobId + index partiel RE) → Task 1 (D3). ✅
- **Slot IN né-rejetee** = sortie du deadlock (runbook) → Task 5 (D6). ✅
- **Garde-fous RE** tranchés (IN préalable exigé, `active` non exigé, période via l'IN) → Task 2 (D4). ✅
- **HORS PÉRIMÈTRE respecté** : e-signature / worker-role split / transport réel → **Différés** documentés ; RE auto post-301 **refusé**. ✅
- **Contraintes** : TDD RED-first ; invoice-core **non touché** ; aucune dépendance ajoutée ; **aucune nouvelle table** (0027 index + 0028 SD read-only, aucune RLS/grant de table) ; dual-auth motif existant ; 404 byte-identique ; oracles indépendants ; verrou heavy respecté (2 suites worker → `HEAVY_TESTS`) ; commits FR sans trailer ; docs R/O intacts ; tâches homogènes Sonnet + revue Opus ; dernière tâche = docs/runbook/bump 0.10.0. ✅

**2. Non-régression & non-fabrication :** IN **byte-identique** (reSeq `undefined`, arbitrage IN inchangé) ; RE **retriable-idempotent** (index partiel RE + reprise verbatim) ; l'IN **jamais** effacé (journal append-only) ; RE **jamais** automatique (jugement opérateur) ; sweep **best-effort strict** (jamais throw) ; keyset de liste **intact**.

**3. Interprétations marquées go-live :** unicité PPF du `transmission_ref` (note 131) traitée par discriminant `reSeq` **côté store/index** — la soumission PPF réelle (transport différé, items Xavier) consommera ces refs distincts ; garde `active` non exigée (rectification de données passées légitime) ; churn `unaddressable` bornée par rotation `updated_at` (backoff persistant différé).

**4. Cohérence types & migrations :** `reSeq` partagé job/ref/index (Task 1) ; `EreportingGenerationQueue` producteur HTTP miroir `InvoiceGenerationQueue` (Task 2) ; `RoutingRetryService`/`Scheduler`/`ROUTING_RETRY_JOB` miroir archivage (Task 3) ; `InvoiceSummary`/`InvoiceDetail` réconciliés (Task 4) ; **migrations 0027/0028 contiguës** après 0026, aucune nouvelle table, aucun enum touché (`nomenclature.ts` R/O).

## Recommandations fermes de périmètre (le contrôleur ratifie — aucune question ouverte)

- **R1 — Chemin RE = endpoint opérateur MANUEL** régénérant la période complète via le pipeline existant (type='RE') ; **pas d'automatisme post-301**. Retenu (D1).
- **R2 — API productrice de `ereporting-generation`** (`QueueModule` + wrapper), miroir `invoice-generation`. Retenu (D2).
- **R3 — Idempotence RE en 3 couches** (reSeq → jobId → index partiel RE 0027) ; `insertTransmission` arbitre par `type`, IN byte-identique. Retenu (D3).
- **R4 — Garde-fous RE** : déclarant existant (404 anti-fuite) + IN préalable (409) ; **`active` non exigé** ; periodEnd repris de l'IN. Retenu (D4).
- **R5 — L'IN n'est jamais effacé** ; supersession = sémantique PPF ; journal append-only ; RE observable via `GET /ereporting/transmissions`. Retenu (D5).
- **R6 — Le RE débloque le deadlock IN né-`rejetee`** (runbook). Retenu (D6).
- **R7 — Sweep routage** miroir `ArchiveRetryService` : `pending`+`unaddressable`, `ambiguous` exclu, borné, rotation équitable ; SD read-only 0028. Retenu (D7).
- **R8 — Filtre liste `routingStatus`** + **exposition** dans le DTO de liste (revert justifié de D3/3.3, solde M1) ; keyset intact. Retenu (D8).
- **R9 — Aucune table** ; migrations 0027 (index RE) + 0028 (SD) seules. Retenu (D9).
- **R10 — Bump `apps/api` 0.10.0 ; `invoice-core` reste 0.4.0** (non touché). Retenu.

## Execution Handoff

Plan complet, sauvegardé dans `docs/superpowers/plans/2026-07-17-phase3-4-reprise-retransmission.md`. Branche : `feat/phase3-4-reprise-retransmission`. Deux options :
1. **Subagent-Driven (recommandé)** — un subagent frais par tâche, revue Opus entre chaque (aligné 1.x/2.x/3.x). Ordre : T1 (pipeline RE) → T2 (endpoint RE) → T3 (sweep routage) → T4 (filtre liste) → T5 (docs/bump).
2. **Inline** — exécution par lots avec points de contrôle.
