# Plan 3.6 — Révocation de consentement

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Livrer le **chemin d'écriture manquant** de la révocation de consentement annuaire (2.4). La colonne `annuaire_consents.revoked_at` est **opérationnelle côté BD** (champ `0018_annuaire_tables.sql`, grant `UPDATE` `0019_annuaire_rls.sql:14`) et le **gate de publication la respecte déjà** (`resolveConsent` refuse un `consentId` révoqué `annuaire-publication.service.ts:167` et `findActiveConsent` filtre `revokedAt IS NULL` `annuaire.repository.ts:255`) — **seul l'endpoint qui ÉCRIT `revoked_at` manque**. On ajoute cet **endpoint opérateur dual-auth** (mutation, verrou de composition M1 **binding**), avec une **idempotence write-once** (déjà-révoqué → no-op monotone) et un **404 anti-fuite**. **La décision de conception centrale** — que faire des **lignes publiées** qui dépendent d'un consentement révoqué — est tranchée en **D2** (ancrée aux sources primaires 2.4 §3.5.3/§3.5.5 et à la sémantique RÉELLE de `maskLigne`), avec sa **posture d'honnêteté** : la révocation **ne prétend jamais** un adressage adossé à un consentement qui n'existe plus, et **ne fabrique jamais** une rétractation qui n'a pas eu lieu.

**Architecture :** On **réutilise le socle 1.x/2.x/3.x** exactement comme les plans précédents. Tout vit **entièrement dans `apps/api/src/annuaire`** ; **`packages/invoice-core` n'est PAS touché**. L'endpoint **calque verbatim** le stack dual-auth des **6 mutations existantes** (`TenantAuthGuard, RolesGuard, CsrfGuard` + `@Roles('owner','admin','accountant')`, motif `AnnuaireController.mask`/`PaymentsController.capture`) et **n'ajoute ni poseur ni lecteur** de `req.apiKeyId` (verrou 3.3-T6 vert sans modification). Le writer est un **CAS write-once** (`UPDATE … WHERE revoked_at IS NULL`, motif `markPublished`) suivi d'un ré-lecture RLS-scopée pour distinguer déjà-révoqué (idempotent 200) d'inconnu/cross-tenant (404 byte-identique). **Aucune cascade automatique sur les lignes** (D2) : le gate de publication existant EST la garantie « jamais prétendre à neuf », la rétractation des lignes déjà publiées suit la **procédure opérateur documentée** (motif réglementaire §3.5.5.5 note 85), et la réponse **rapporte honnêtement** le nombre de lignes actives encore adossées à retirer (anti-silence, **jamais** une rétractation silencieuse).

**Tech Stack :** **Aucune dépendance runtime ajoutée.** Persistance : drizzle + `pg` (déjà présents) — `UPDATE` sur `annuaire_consents` (grant existant). HTTP : `zod` inline + `@nestjs/common` (déjà présents). Tests : **Vitest 4.1.10** (déjà présent — split `heavy`/`light` de 3.3 respecté ; les nouvelles suites e2e sont **LIGHT**, aucun Worker BullMQ). **Aucune migration, table, colonne, policy ou enum** (D4). `docker-compose`/`scripts/db-init` : **inchangés**.

## Global Constraints

Reprises **verbatim** du socle 1.x/2.x/3.x (non négociables) — chaque tâche en hérite implicitement :

- **TDD strict RED/GREEN** : test écrit et vu échouer avant toute implémentation ; aucun merge si un test échoue. Un commit minimum par tâche, message en **français**, **sans** trailer `Co-Authored-By: Claude` ni mention Claude ; commits au seul nom de l'utilisateur. `pnpm format` avant chaque commit.
- **Couverture bloquante** : **≥ 90 %** (lines/functions/statements/branches) maintenue en **agrégat heavy+light** sur `apps/api` et `apps/web`. **`packages/invoice-core` N'EST PAS touché** ce plan (il se tient à **100 %×4** ; ne pas régresser). Exclusions de couverture `apps/api` conservées (`src/main.ts`, `src/worker-main.ts`, `**/*.module.ts`, `src/db/migrations/**`). **Tout module pur** visé **100 %** par des tests déterministes (**aucun `Date.now()` dans la logique pure** ; l'horodatage de révocation est une **écriture de persistance** — motif `updatedAt: new Date()` / `markPublished`, `annuaire.repository.ts`, PAS de la logique pure).
- **e2e sur Postgres réel (Testcontainers)** pour toute écriture/endpoint DB ; **tests d'isolation multi-tenant explicites**. **Motifs de stabilité e2e OBLIGATOIRES** (1.4/2.x/3.x) : `listenOnce`, `maxWorkers`/projet dédié borné, `withStartupTimeout(120_000)`, `hookTimeout(150_000)`, polling `waitFor` borné (jamais de sleep fixe), aucun affaiblissement de l'hermétisme. **VERROU D'ARCHITECTURE (3.3 T7 NIT-1, BINDING)** : toute nouvelle suite e2e démarrant un Worker BullMQ (`createTestWorker(`) **DOIT** être ajoutée à `HEAVY_TESTS` (`vitest.config.ts`). **Ce plan n'ajoute AUCUNE suite worker** (la révocation est HTTP pur, appel direct) ⇒ **aucun impact `HEAVY_TESTS`**, `heavy-suites.arch.test.ts` reste vert sans modification.
- **VERROU D'ARCHITECTURE apiKeyId (3.3 T6, BINDING)** : `tests/unit/*apikey*.arch.test.ts` verrouille les **poseurs/lecteurs** de `req.apiKeyId`. Le nouvel endpoint dual-auth **n'ajoute ni poseur ni lecteur** (il **consomme** les gardes existants) — l'invariant reste vert **sans modification**.
- **VERROU D'ARCHITECTURE composition dual-auth M1 (3.5 T4, BINDING)** : `tests/unit/dual-auth-composition.arch.test.ts` asserte que **TOUTE** route de mutation (`@Post/@Put/@Delete`) composant `TenantAuthGuard` compose **AUSSI** `RolesGuard` ET `CsrfGuard`, `TenantAuthGuard` en tête. L'endpoint de révocation est une **`@Post` de mutation** ⇒ il **DOIT** porter le triple garde **sans exclusion**. **Le test énumère explicitement les routes conformes** (`dual-auth-composition.arch.test.ts:146-160` — liste de **6** aujourd'hui) : ajouter cette 7e route **exige** d'étendre l'énumération attendue à **7** (D5), sinon le test `it('le scan repère les … routes CONFORMES')` casse. **AUCUNE** entrée dans `KNOWN_PRE_EXISTING_GAPS` (reste `Set()` vide).
- **Sécurité OWASP** : validation de toute entrée (`:id` UUID, `zod`), authz systématique (**dual-auth** : `TenantAuthGuard` + `RolesGuard` + `CsrfGuard`). **Aucune donnée sensible hors des frontières tenant** : lecture/écriture sous RLS (`tenant.run`). Erreurs normalisées **RFC 9457 `application/problem+json`** (`problem()`, `ProblemType`). **404 anti-fuite byte-identique** : consentement inconnu / cross-tenant / `:id` malformé **indiscernables** (motif `AnnuaireController.notFound`/`resolution`).
- **Moindre privilège Postgres — inchangé** : la révocation est **HTTP** (process API = `factelec_app`, qui **détient** `UPDATE ON annuaire_consents`, `0019:14`). Le rôle `factelec_worker` **n'a AUCUN accès** à `annuaire_consents` (refus `42501` **déjà prouvé** en 3.5 — `worker-role-least-privilege.e2e.test.ts` : « INSERT annuaire_consents » `42501`) : la révocation **ne peut jamais** être exécutée par le worker. **Aucun grant nouveau, aucun rate-limit inventé.**
- **TypeScript `strict: true`, ESM, NodeNext, Node ≥ 22.** `typescript` pinné **exactement `7.0.2`** (racine, tsgo).
- **Dépendances pinnées exactement, dernière stable, licence.** **`pnpm run audit:ci` 0 vulnérabilité** et **`pnpm outdated -r` vierge** restent **bloquants** en CI. **Aucune dépendance ajoutée** → objectif mécaniquement tenu (vérifier néanmoins à **chaque** tâche).
- **`@factelec/invoice-core` consommé via son exports map** (barrel `.` unique), jamais par chemin relatif. `docs/reference/` et `docs/reglementaire/` en **lecture seule** (aucun XSD/PDF copié/modifié — les sources primaires 2.4 sont **ré-extraites**, jamais transcrites de seconde main, leçon B1). **Nomenclatures normatives en lecture seule.**
- Identifiants de code en **anglais** ; commentaires/commits/docs en **français**.
- **Oracles de test indépendants (anti-tautologie)** : ne jamais asserter un comportement en le comparant à sa propre implémentation. La monotonie d'idempotence est prouvée par un **oracle temporel indépendant** (le `revoked_at` du 2e appel === celui du 1er, jamais réécrit) ; le refus de publication sous consentement révoqué est prouvé **de bout en bout** (e2e réel, pas mock du gate) ; le refus worker `42501` est **déjà prouvé** (3.5, non ré-implémenté).

---

## Périmètre : retenu en 3.6 vs reporté

**Retenu (ce plan) :**
1. **Endpoint opérateur de révocation** : `POST /annuaire/consents/:id/revoke`, **dual-auth triple garde** (M1 binding), `@HttpCode(200)`, `:id` UUID-validé (sinon 404), **idempotent write-once** (CAS `WHERE revoked_at IS NULL`), **404 anti-fuite byte-identique** (inconnu/cross-tenant/malformé). Réponse **honnête** : `{ consentId, revokedAt, dependentActiveLignes }` (**Task 1**, D2/D3).
2. **Effets sur les lignes — TRANCHÉ (D2)** : **AUCUNE cascade automatique**. Le gate de publication existant est la garantie « jamais prétendre à neuf » (prouvée par **non-régression e2e**) ; la rétractation des lignes déjà publiées suit la **procédure opérateur documentée** (§3.5.5.5 note 85) ; la réponse **rapporte** le nombre de lignes actives encore adossées (anti-silence). (**Task 1/2**, D2).
3. **Non-régression du gate + verrou M1** : e2e prouvant qu'un consentement révoqué **bloque** toute nouvelle publication (chemins `consentId` **et** auto-découverte) ; extension de l'énumération M1 (6→7 routes conformes) (**Task 2**, D2/D5).
4. **Docs / runbook (procédure de rétractation opérateur, honnêteté sur les différés) / OpenAPI / README / bump `0.12.0`** (**Task 3**).

**Reporté (acté ici, justifié en D\*) — différés :**
- **Cascade RÉELLE de rétractation vers le PPF (Flux 13 « masquage » + clôture + ligne fallback plateforme fictive 9998)** : exige l'**émission Flux 13** (transport réel = item Xavier, différé depuis 2.4/3.1) et la propagation au **miroir de consultation**. `maskLigne` **NE TRANSMET PAS** (transition locale, D2) — une auto-cascade serait une rétractation **fabriquée**. Différé, documenté (D2/D6).
- **Auto-cascade côté registre (perte d'assujetti / perte d'immatriculation)** : c'est un comportement **PPF-side** (§3.5.5.2/3/4), pas PA-side — hors de notre rôle. Différé.
- **Raison/motif de révocation stocké** : **AUCUNE colonne** n'existe (`annuaire_consents` : pas de `revoke_reason`). Prétendre stocker une raison serait une fabrication (D4). Différé (l'ajouter exigerait une migration justifiée par un besoin métier réel).
- **Blocage dur de la révocation tant que des lignes actives dépendent (« gate bloquante » stricte)** : **REFUSÉ** (D2) — les lignes `published` ne peuvent PAS être masquées (machine : `published→deposee|rejetee` seulement) et l'acquittement PPF (`published→deposee`) est **différé** (push PPF réel absent) ⇒ un blocage dur serait **insatisfaisable** (deadlock). Remplacé par le rapport honnête `dependentActiveLignes`.
- **Endpoints hérités inchangés** : e-signature eIDAS réelle, transport réel/`emise`, backoff persistant sweep, POST codes-routage autonome, garde composé `DualAuthMutationGuard` (refusé 3.5-D7, condition 4e+ route non atteinte).

---

## Décisions structurantes (à lire avant d'exécuter)

### D1 — Cadrage : le writer manquant de `revoked_at` ; posture « jamais prétendre, jamais fabriquer »
- **Cadrage contrôleur BINDING (ledger, RESEARCH 3.6 / CADRAGE pour l'architecte)** : « la révocation ne doit JAMAIS laisser le système **prétendre** un adressage adossé à un consentement qui n'existe plus » ; l'architecte tranche **cascade-auto** vs **blocage/procédure-opérateur** en **s'ancrant aux références primaires 2.4** (§3.5.3-3.5.7) et à la **sémantique réelle de `maskLigne` (transmission ?)** ; posture : « une cascade déclenchée par l'acte **EXPLICITE** de l'opérateur n'est pas une fabrication, une décision **silencieuse** l'est ».
- **État vérifié in situ** : `revoked_at` est un champ **opérationnel mais sans writer HTTP** — la colonne existe (`0018`), le grant `UPDATE` existe (`0019:14`), le gate **lit** déjà `revokedAt` (chemin `consentId` : `annuaire-publication.service.ts:167` ; auto-découverte : `annuaire.repository.ts:255` `isNull(revokedAt)`). **Aucun** code n'écrit `revoked_at` (`insertConsent` ne le pose jamais ; commentaire repo `annuaire.repository.ts:191-198` : révocation « DÉLIBÉRÉMENT DIFFÉRÉE … le jour où un endpoint/outillage ops est spécifié »). **Ce plan spécifie cet endpoint.**

### D2 — DÉCISION CENTRALE : révocation-seule + gate existant + procédure opérateur documentée (PAS de cascade auto) — ancrage primaire
**Tranché : option (b).** La révocation **écrit `revoked_at`** ; elle **ne cascade AUCUN masquage automatique** sur les lignes. Ancrage (sources primaires **ré-extraites**, `docs/reglementaire/specifications-externes-v3.2/0- Dossier de specifications externes FE - Dossier général_v3.2.pdf`, lecture seule) :

- **§3.5.3 « L'initialisation de l'annuaire » (p. 40) + note de bas de page 79 (p. 41)** : la nature « masquage » sert à *« annuler la prise d'effet d'une ligne d'annuaire, telle qu'elle a été définie au préalable »*. Les **évènements exogènes** (*« la perte du caractère assujetti d'une entreprise, la perte d'immatriculation d'une PA »*, note 79) **raccourcissent** la période d'une ligne **en vigueur** via une **« date de fin effective »** — PAS via un masquage. Le masquage vise spécifiquement les lignes **pas encore entrées en vigueur**.
- **§3.5.5.2 / §3.5.5.3 / §3.5.5.4 (p. 45-47)** : l'**actualisation automatique** sur évènement de registre est décrite **côté PPF** : *« une date de fin effective est attribuée automatiquement à chaque ligne d'annuaire en cours de vigueur »* **et** *« une ligne d'annuaire de type "masquage" est générée automatiquement pour chaque ligne d'annuaire dont la date de début d'effet est postérieure [à l'évènement] »*. C'est le **PPF** qui cascade sur les registres — **pas la PA**.
- **§3.5.5.5 « L'actualisation de l'annuaire par les plateformes agréées (PA) » (p. 48-50) + note de bas de page 85 (p. 50)** — **l'analogue EXACT de la révocation de consentement** (rupture du lien assujetti↔PA) : *« en cas d'une rupture précipitée de contrat entre un client et sa PA. Il est alors **conseillé à la PA** de clôturer les lignes d'annuaire en vigueur qui lui sont attribuées pour ce client (et le cas échéant, de **masquer** les lignes d'annuaire dont la date d'entrée en vigueur n'était pas encore échue), puis de **créer une ligne d'annuaire** pour ce client, à la maille SIREN, attribué au matricule de la **plateforme fictive** »*. C'est une **actualisation OPÉRATEUR, ligne par ligne, nuancée par l'état** (clôturer les en-vigueur ≠ masquer les futures ≠ créer un fallback), transmise par **Flux 13/API** — **jamais** une cascade automatique uniforme côté PA.

- **Sémantique RÉELLE de `maskLigne` (vérifiée dans le code — la question « (transmission ?) » du cadrage) :**
  - `AnnuairePublicationService.maskLigne` (`annuaire-publication.service.ts:318-333`) appelle **uniquement** `repo.appendLigneEvent(tenantId, ligneId, 'deposee', 'masked', 'platform')`.
  - `appendLigneEvent` (`annuaire.repository.ts:401-443`) fait un **UPDATE de statut local + un événement journal**, sous CAS `WHERE status = from`. **Aucun `port.publish`, aucune émission Flux 13, aucune écriture du miroir `annuaire_directory_entries`.**
  - La machine (`annuaire-lifecycle.ts:37-43`) n'autorise `→ masked` **que** depuis `deposee`. Les lignes `draft` et `published` **ne peuvent PAS être masquées**.
  - Le **routage réel** (`AnnuaireConsultationService.resolveRecipient` `annuaire-consultation.service.ts:100-109`) lit **exclusivement** le miroir `annuaire_directory_entries` (Flux 14, **non adossé au consentement**), **jamais** `annuaire_lignes`.

- **CONCLUSION (rejet motivé de la cascade-auto, option a)** : une cascade « masquage automatique via le `maskLigne` existant » serait **triplement défaillante** — (1) **incomplète** : elle ne peut toucher que les lignes `deposee`, laissant `draft`/`published` debout ; (2) **non-propagée** : `maskLigne` ne transmet rien au PPF ni au miroir, donc l'adressage réel (que `resolveRecipient` lit dans le miroir) **resterait inchangé** — la cascade **ne rétracterait rien** de la vérité de routage ; (3) **infidèle au modèle** : la spec distingue **clôturer** (en vigueur) de **masquer** (futures) de **créer un fallback** — un masquage uniforme les confond. Une telle cascade **fabriquerait** l'apparence d'une rétractation qui **n'a pas eu lieu** — exactement la fabrication interdite. Le parenthétique du cadrage « (transmission ?) » **tranche** : `maskLigne` **ne transmet pas** ⇒ la cascade ne peut **pas** honnêtement rétracter ⇒ **option (b)**.

- **Ce que (b) garantit RÉELLEMENT (le mandat « jamais prétendre ») :**
  1. **Aucune publication NEUVE** ne peut s'adosser à un consentement révoqué : `resolveConsent` refuse le chemin `consentId` (`revokedAt !== null` → `ConsentRequiredError`, 422) **et** le chemin auto-découverte (`findActiveConsent` filtre `isNull(revokedAt)`). Invariant **déjà en place** — **prouvé par non-régression e2e** (Task 2), jamais affaibli.
  2. Le **routage** (`resolveRecipient`) lit le miroir Flux 14 — **jamais** adossé à notre consentement : la révocation ne peut pas le « faire prétendre » (hors périmètre du consentement PA).
  3. Les lignes `annuaire_lignes` déjà publiées sont des **assertions historiques** portant `consent_id` ; la révocation est **horodatée** (`revoked_at`) — le système peut les rapporter **véridiquement** (« publiée sous le consentement X, révoqué le T »), ce **n'est pas** prétendre.
- **Anti-silence (le cœur de la posture, non-fabrication)** : pour que la révocation **ne soit pas une décision silencieuse** sur les lignes debout, la réponse **rapporte** `dependentActiveLignes` = le nombre de lignes `annuaire_lignes` dépendant de ce consentement **encore actives** (`status IN ('draft','published','deposee')`, hors terminaux `rejetee`/`masked`) : l'opérateur est **explicitement** informé de ce qu'il doit retirer (procédure §3.5.5.5 note 85 : clôturer via `PUT /annuaire/lignes/:id`, masquer les `deposee` futures via `DELETE /annuaire/lignes/:id`), la rétractation **réelle** vers le PPF (Flux 13 + fallback) restant **honnêtement différée** (transport = item Xavier). **Aucune** valeur fabriquée, **aucune** rétractation silencieuse, **aucune** cascade trompeuse.

### D3 — Endpoint dual-auth + idempotence CAS write-once + 404 anti-fuite
- **Route** : `@Post('consents/:id/revoke')` sur `AnnuaireController` (le consentement annuaire vit dans ce module ; `AnnuairePublicationService` porte déjà `insertConsent`/le gate — la révocation y est cohérente). `@HttpCode(200)` (mutation **synchrone** directe, pas d'enfilement — motif `InvoicesController.resolveRouting`). **Dual-auth triple garde** `@UseGuards(TenantAuthGuard, RolesGuard, CsrfGuard)` + `@Roles('owner','admin','accountant')` (motif **EXACT** des 6 mutations, `annuaire.controller.ts:162-164`).
- **404 anti-fuite** : `if (!isUuid(id)) throw this.notFoundConsent()` (motif `endEffect`/`mask` `annuaire.controller.ts:189/215`) ; un consentement inconnu **ou** cross-tenant (RLS) donne le **même** 404 byte-identique (`problem(404, ProblemType.notFound, 'Unknown consent')`). Nouvelle erreur de domaine `ConsentNotFoundError` (classe pure, motif `StaleLigneTransitionError`) levée par le service, mappée en 404 par le contrôleur (catch ciblé, motif `mapPublicationError`).
- **Idempotence write-once (CAS, motif `markPublished` `annuaire.repository.ts:363-393`)** : repo `revokeConsent(tenantId, id)` sous `tenant.run` :
  1. `UPDATE annuaire_consents SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING revoked_at` — **1 ligne** ⇒ fraîchement révoqué.
  2. **0 ligne** ⇒ ambigu : ré-lecture `SELECT revoked_at WHERE id = $1 LIMIT 1` (RLS) — `null` ⇒ inconnu/cross-tenant (→ `ConsentNotFoundError` → 404) ; **trouvé + `revoked_at` non nul** ⇒ **déjà révoqué**, idempotent (renvoie le `revoked_at` **d'origine**, **jamais réécrit** — monotonie).
  - Horodatage : `now()` SQL (temps de transaction) **ou** `new Date()` (motif `updatedAt`) — écriture de **persistance**, PAS de la logique pure (aucune horloge à injecter). **Oracle indépendant** : le test prouve `revoked_2 === revoked_1` (write-once) sans relire l'impl.
- **Service** `AnnuairePublicationService.revokeConsent(tenantId, id): Promise<{ consentId, revokedAt, dependentActiveLignes }>` : appelle le repo (→ `ConsentNotFoundError` si `null`), puis `repo.countActiveLignesForConsent(tenantId, id)` (COUNT RLS-scopé sur `annuaire_lignes` `WHERE consent_id = $1 AND status NOT IN ('rejetee','masked')`), retour `{ consentId: id, revokedAt: <ISO>, dependentActiveLignes: <n> }`.

### D4 — Aucune migration/table/colonne/policy ; grant `UPDATE` existant ; worker exclu (inchangé)
- **Migration max = 0028** en base fonctionnelle, **0029** (grants worker, 3.5) déjà présente : **ce plan n'ajoute AUCUNE migration.** `revoked_at` **existe** (`0018`), `GRANT … UPDATE ON annuaire_consents TO factelec_app` **existe** (`0019:14`). Le writer est un `UPDATE` — **rien à migrer**.
- **Aucune colonne `revoke_reason`** n'existe et **aucune n'est ajoutée** (D2 différés) — le corps de requête est **vide** (ou ignoré) ; prétendre stocker une raison serait une fabrication.
- **Worker** : `factelec_worker` **n'a aucun accès** à `annuaire_consents` (refus `42501` **déjà prouvé** 3.5) ; la révocation est HTTP (`factelec_app`) — **inchangé**, aucun grant nouveau.

### D5 — Verrou M1 : la 7e route dual-auth ; énumération étendue 6→7 ; triple garde sans exclusion
- `dual-auth-composition.arch.test.ts` (BINDING 3.5) **scanne textuellement** tous les contrôleurs et asserte que toute mutation composant `TenantAuthGuard` compose aussi `RolesGuard`+`CsrfGuard`, `TenantAuthGuard` en tête. Le test **énumère** les routes conformes attendues (`:146-160`, **6** aujourd'hui). L'endpoint de révocation est la **7e** ⇒ **Task 2 étend cette liste à 7** (`annuaire/annuaire.controller.ts#revokeConsent`), sinon `it('le scan repère les … routes CONFORMES')` casse (RED **attendu** avant l'ajout du garde — preuve que le verrou mord). L'`it('… compose AUSSI RolesGuard ET CsrfGuard …')` **passe** dès que le triple garde est posé. `KNOWN_PRE_EXISTING_GAPS` **reste vide**.
- **RED de morsure documenté** : écrire d'abord l'endpoint avec `@UseGuards(TenantAuthGuard)` **seul** → le test `offenders` casse (fail-CLOSED, preuve) → compléter au triple garde → vert. (Alternativement, poser le triple garde d'emblée et étendre l'énumération : le RED provient alors de l'énumération 6≠7.)

### D6 — Rappel des différés & posture « aucune fabrication »
- Cascade réelle vers le PPF (Flux 13 masquage + clôture + ligne fallback plateforme fictive 9998, §3.5.5.5 note 85), auto-cascade registre (PPF-side §3.5.5.2/3/4), raison de révocation stockée, blocage dur (deadlock `published`), e-signature eIDAS réelle, transport réel/`emise`, garde composé (refusé 3.5-D7) : **tous différés/refusés** avec rationale (Périmètre + D\*). Posture : **livrer le writer honnête** (révocation horodatée + gate binding + rapport anti-silence) sans **fabriquer** une rétractation d'adressage qui n'a pas atteint le PPF.

---

## Versions & dépendances (registre npm — à re-vérifier à chaque tâche)

| Brique | Fournisseur | Provenance / note |
|---|---|---|
| Writer révocation | drizzle + `pg` (déjà présents) | **Aucun ajout.** `UPDATE` CAS write-once, grant existant `0019:14`. |
| Endpoint dual-auth | `zod` inline + `@nestjs/common` (déjà présents) | **Aucun ajout.** Triple garde existant, motif des 6 mutations. |
| Tests | **Vitest 4.1.10** (déjà présent) | Split `heavy`/`light` de 3.3 respecté ; **aucune** nouvelle suite HEAVY (la nouvelle e2e est LIGHT). |

> **Gate** : `pnpm run audit:ci` = 0 et `pnpm outdated -r` **vierge**. Vérifier à **chaque** tâche. Bump **`apps/api` 0.11.0 → 0.12.0** (Task 3) ; `invoice-core` **reste 0.4.0** (non touché).

---

## Points de risque signalés d'emblée

1. **Cascade fabriquée sur les lignes.** **Traité** : D2 — `maskLigne` ne transmet pas (local, `deposee`-only) ⇒ auto-cascade REJETÉE ; révocation-seule + gate binding + rapport anti-silence + procédure opérateur documentée ; rétractation réelle Flux 13 **différée**.
2. **Le système « prétend » un adressage après révocation.** **Traité** : D2 — le gate existant bloque toute publication neuve (non-régression e2e, 2 chemins) ; le routage lit le miroir (hors consentement) ; les lignes debout sont des faits historiques horodatés, rapportées via `dependentActiveLignes`.
3. **Blocage dur insatisfaisable (deadlock `published`).** **Traité** : D2 différés — pas de gate bloquante stricte ; les lignes `published` ne peuvent être masquées (machine) et l'ack PPF est différé.
4. **Idempotence : double révocation réécrit l'horodatage / masque une 2e révocation.** **Traité** : D3 — CAS `WHERE revoked_at IS NULL` write-once ; déjà-révoqué → renvoie le `revoked_at` **d'origine** (monotone), oracle indépendant.
5. **Fuite d'existence de consentement.** **Traité** : D3 — 404 byte-identique (inconnu/cross-tenant/`:id` malformé indiscernables, RLS via `findConsentById`→null).
6. **Verrou M1 cassé / route sans triple garde.** **Traité** : D5 — la 7e route composée au triple garde ; énumération étendue 6→7 ; RED de morsure documenté ; `KNOWN_PRE_EXISTING_GAPS` vide.
7. **Régression du gate de publication.** **Traité** : Task 2 — e2e de non-régression exécutant les 2 chemins (`consentId` révoqué → 422 ; auto-découverte après révocation → 422) ; suites annuaire existantes rejouées vertes.
8. **Régression verrous heavy/apiKeyId.** **Traité** : la nouvelle e2e est **LIGHT** (aucun `createTestWorker`) ⇒ `heavy-suites.arch` inchangé ; l'endpoint **n'ajoute ni poseur ni lecteur** `apiKeyId` ⇒ `apikeyid-setters.arch` vert sans modification.
9. **Migration/colonne injustifiée.** **Traité** : D4 — aucune migration/table/colonne/policy ; `revoked_at`+grant existent ; pas de `revoke_reason` (fabrication évitée).

---

## Sources vérifiées in situ (lecture seule)

Faits vérifiés dans le code à `main` (HEAD `d8842c7`, apps/api 0.11.0) et dans les sources primaires 2.4 (**ré-extraites**, jamais transcrites de seconde main — leçon B1), non paraphrasés :
- **Cycle consentement** : `annuaire_consents` (`0018` : `revoked_at` nullable ; grant `SELECT/INSERT/UPDATE`, **pas DELETE** `0019:14`) ; `insertConsent` **n'écrit jamais** `revoked_at` (`annuaire.repository.ts:199-221`, commentaire `:191-198` « révocation DÉLIBÉRÉMENT DIFFÉRÉE ») ; gate `resolveConsent` **lit** `revokedAt` (chemin `consentId` `:167` ; auto-découverte `findActiveConsent` `isNull(revokedAt)` `:255`).
- **Sémantique masquage (décisive)** : `maskLigne` = `appendLigneEvent(deposee→masked, 'platform')` **seul** (`annuaire-publication.service.ts:318-333`) — **transition locale**, `assertTransition`+CAS `WHERE status='deposee'`, **aucun** `port.publish`/Flux 13/écriture miroir (`annuaire.repository.ts:401-443`) ; machine `→masked` **uniquement** depuis `deposee` (`annuaire-lifecycle.ts:40`) ; `resolveRecipient` lit **exclusivement** `annuaire_directory_entries` (miroir Flux 14, `annuaire-consultation.service.ts:100-109`), **jamais** `annuaire_lignes`.
- **FK** : `annuaire_lignes.consent_id → annuaire_consents.id ON DELETE restrict` (`0018`) — une ligne dépend d'exactement un consentement ; la révocation est un **UPDATE**, pas un DELETE.
- **Sources primaires 2.4** (`docs/reglementaire/specifications-externes-v3.2/0- Dossier de specifications externes FE - Dossier général_v3.2.pdf`) : §3.5.3 p.40 + note 79 p.41 (masquage = « annuler la prise d'effet » ; « date de fin effective » sur évènement exogène) ; §3.5.5.2/3/4 p.45-47 (auto-cascade **PPF-side** : date de fin effective + masquage auto des lignes futures) ; **§3.5.5.5 p.48-50 + note 85 p.50** (rupture PA↔client : **conseil opérateur** de clôturer/masquer/créer fallback plateforme fictive — **par ligne, via Flux 13**) ; §3.5.7 Tableau 6 p.54 (statuts ligne d'annuaire **400 Acceptée / 401 Rejetée**).
- **Dual-auth & verrous** : 6 mutations triple-gardées (`annuaire.controller.ts:162/181/207`, `payments`/`ereporting`/`invoices`) ; `Roles = owner/admin/accountant/viewer` (`auth.types.ts:3`) ; `dual-auth-composition.arch.test.ts` énumère **6** routes conformes (`:146-160`) ; `apikeyid-setters.arch.test.ts` (poseurs/lecteurs) ; `HEAVY_TESTS`/`heavy-suites.arch.test.ts` ; migration max **0029** (grants worker).

> **INTERPRÉTATION FLAGGÉE go-live** : (a) les lignes `annuaire_lignes` déjà publiées survivent à la révocation (rétractation réelle Flux 13 différée) — rapportées via `dependentActiveLignes`, retirées par procédure opérateur (§3.5.5.5 note 85) ; (b) **hors périmètre observé** : le commentaire `annuaire-lifecycle.ts:9-14` affirme « aucun code officiel DGFiP … pour la publication annuaire » alors que §3.5.7 Tableau 6 documente **400/401** — divergence PRÉ-EXISTANTE **non traitée ici** (aucun lien avec la révocation), à noter au backlog.

---

## Structure des fichiers (vue d'ensemble)

```
apps/api/
  package.json                                     # version 0.11.0 → 0.12.0 (Task 3)
  src/annuaire/
    annuaire.repository.ts                         # + revokeConsent (CAS write-once) + countActiveLignesForConsent (Task 1)
    annuaire-publication.service.ts                # + revokeConsent (service) + ConsentNotFoundError (Task 1)
    annuaire.controller.ts                         # + POST consents/:id/revoke (triple garde) + notFoundConsent + catch (Task 1)
  tests/
    unit/
      annuaire-revoke.service.test.ts              # idempotence write-once, 404, dependentActiveLignes (oracle indép.) (Task 1)
      dual-auth-composition.arch.test.ts           # énumération 6→7 (revokeConsent) (Task 2)
    e2e/
      annuaire-consent-revoke.e2e.test.ts          # 200/404/dual-auth + NON-RÉGRESSION gate (2 chemins) (LIGHT) (Task 2)
```

Fichiers hors code : `README.md` racine + `apps/api/README.md` (procédure de rétractation opérateur + différés honnêtes, Task 3). OpenAPI/Swagger si présent (`POST /annuaire/consents/:id/revoke`).

---

### Task 1 : Writer de révocation (repo CAS write-once + service + endpoint dual-auth + 404 anti-fuite)

> **AMENDEMENT B1 (revue du plan, BLOCKER corrigé — BINDING, précédent 3.1-A1 « bloqueur-de-gate »)** : l'extension de l'énumération du verrou M1 (`dual-auth-composition.arch.test.ts:146-160`, `expect(compliant).toEqual([…6…])` + libellé du `it`) passe de la Task 2 à CETTE tâche, DANS LE MÊME COMMIT que la route — sinon la gate de Task 1 (le projet light exécute le verrou) est structurellement ROUGE dès la 7e route posée (7≠6) et la tâche ne peut pas passer son propre gate. Le RED de morsure se constate naturellement : poser la route d'abord, voir le verrou échouer en la nommant, PUIS étendre l'énumération 6→7 (preuve documentée au rapport). Task 2 ne garde que les e2e.

**Files:**
- Modify: `apps/api/src/annuaire/annuaire.repository.ts`, `apps/api/src/annuaire/annuaire-publication.service.ts`, `apps/api/src/annuaire/annuaire.controller.ts`
- Create: `apps/api/tests/unit/annuaire-revoke.service.test.ts`

**Interfaces:**
- Consumes : `tenant.run`/RLS, `annuaireConsents`/`annuaireLignes` (drizzle), CAS motif `markPublished`, dual-auth (`TenantAuthGuard`/`RolesGuard`/`CsrfGuard`), `problem()`/`ProblemType`, `isUuid`.
- Produces : `POST /annuaire/consents/:id/revoke` → 200 `{ consentId, revokedAt, dependentActiveLignes }` ; `revoked_at` écrit write-once ; 404 anti-fuite.

> **D2/D3/D4** : révocation-seule (aucune cascade) ; CAS write-once idempotent ; 404 byte-identique ; **aucune migration/colonne** ; `revoked_at`+grant existent.

- [ ] **Step 1 : Tests service (RED)** — `annuaire-revoke.service.test.ts` (mock repo, **oracle indépendant** : l'horodatage vient du repo mocké, la monotonie est asservie par la valeur, pas par l'impl) :
```ts
it('révocation fraîche : repo.revokeConsent renvoie revoked_at, service retourne { consentId, revokedAt: ISO, dependentActiveLignes }')
it('idempotence : 2e révocation → MÊME revoked_at (repo renvoie l’original, jamais réécrit)')
it('consentement inconnu/cross-tenant (repo → null) → ConsentNotFoundError')
it('dependentActiveLignes = countActiveLignesForConsent (statuts non terminaux uniquement)')
```
Run → **RED** (méthode/erreur absentes).

- [ ] **Step 2 : Implémentation repo (GREEN)** — `annuaire.repository.ts` : `revokeConsent(tenantId, id): Promise<{ revokedAt: Date } | null>` sous `tenant.run` — CAS `UPDATE annuaireConsents SET revokedAt = <now> WHERE eq(id) AND isNull(revokedAt) RETURNING { revokedAt }` ; si **0 ligne**, ré-lecture `SELECT revokedAt WHERE eq(id) LIMIT 1` → `null` ⇒ retour `null` (inconnu/cross-tenant), sinon retour `{ revokedAt }` **d'origine** (déjà révoqué, idempotent — jamais réécrit). `countActiveLignesForConsent(tenantId, consentId): Promise<number>` — `SELECT count(*) FROM annuaireLignes WHERE eq(consentId) AND notInArray(status, ['rejetee','masked'])` sous RLS. Horodatage = écriture de persistance (`new Date()` / `sql\`now()\``), **pas** de logique pure.

- [ ] **Step 3 : Implémentation service + contrôleur (GREEN)** — `annuaire-publication.service.ts` : `class ConsentNotFoundError extends Error` (pure, motif `StaleLigneTransitionError`, `super`+`this.name`, **sans** `Object.setPrototypeOf`) ; `async revokeConsent(tenantId, id)` → `const res = await this.repo.revokeConsent(...)` ; `if (!res) throw new ConsentNotFoundError(id)` ; `const n = await this.repo.countActiveLignesForConsent(tenantId, id)` ; retour `{ consentId: id, revokedAt: res.revokedAt.toISOString(), dependentActiveLignes: n }`. `annuaire.controller.ts` : 
```ts
@Post('consents/:id/revoke')
@HttpCode(200)
@UseGuards(TenantAuthGuard, RolesGuard, CsrfGuard)
@Roles('owner', 'admin', 'accountant')
async revokeConsent(@CurrentTenant() tenantId: string, @Param('id') id: string) {
  if (!isUuid(id)) throw this.notFoundConsent()
  try { return await this.publication.revokeConsent(tenantId, id) }
  catch (err) { if (err instanceof ConsentNotFoundError) throw this.notFoundConsent(); throw err }
}
```
+ `private notFoundConsent() { return new NotFoundException(problem(404, ProblemType.notFound, 'Unknown consent')) }` ; importer `ConsentNotFoundError`. **GARDE** : `pnpm build && pnpm typecheck` verts ; ré-exécuter les e2e annuaire existants → **verts**.

- [ ] **Step 4 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): endpoint opérateur de révocation de consentement (writer revoked_at CAS write-once idempotent, dual-auth triple garde, 404 anti-fuite, rapport des lignes actives adossées)"
```
Expected: PASS ; révocation écrite write-once ; aucune cascade ; 404 byte-identique.

---

### Task 2 : e2e LIGHT + non-régression du gate (l'énumération M1 6→7 est FAITE en Task 1 — amendement B1)

**Files:**
- Modify: `apps/api/tests/unit/dual-auth-composition.arch.test.ts` (énumération 6→7)
- Create: `apps/api/tests/e2e/annuaire-consent-revoke.e2e.test.ts` (LIGHT)

**Interfaces:**
- Consumes : Task 1 (endpoint), harnais e2e annuaire existant (`annuaire-consent-seal.e2e.test.ts`/`annuaire-publication.e2e.test.ts`/`annuaire-mutation-guards.e2e.test.ts` comme modèles), `createTestApp` (`factelec_app`).
- Produces : preuve e2e 200/404/dual-auth + **non-régression du gate** (révocation → publication refusée, 2 chemins) ; M1 étendu à 7 routes.

> **D2/D5** : le gate existant EST la garantie « jamais prétendre » — prouvée de bout en bout ; la 7e route dual-auth est verrouillée par M1.

- [ ] **Step 1 : Étendre M1 (RED→GREEN)** — `dual-auth-composition.arch.test.ts:146-160` : ajouter `'annuaire/annuaire.controller.ts#revokeConsent'` à la liste attendue (6→7). Si l'endpoint Task 1 porte déjà le triple garde, l'`it('… compose AUSSI …')` est déjà vert ; l'`it('le scan repère …')` passe de RED (7 trouvés ≠ 6 attendus) à GREEN. Documenter la **morsure** : retirer temporairement `CsrfGuard` de `revokeConsent` → l'`it('offenders')` casse (fail-CLOSED, preuve), puis restaurer.

- [ ] **Step 2 : e2e révocation + non-régression (RED→GREEN)** — `annuaire-consent-revoke.e2e.test.ts` (Postgres réel, `createTestApp`/`factelec_app`, **aucun worker** → LIGHT) :
```ts
it('POST /annuaire/consents/:id/revoke (clé API OU session+CSRF, rôle owner/admin/accountant) → 200 { consentId, revokedAt, dependentActiveLignes }, revoked_at persisté')
it('idempotence : 2e révocation → 200, MÊME revoked_at (write-once, non réécrit)')
it('consentement d’un AUTRE tenant → 404 byte-identique ; id inconnu → 404 byte-identique ; :id malformé → 404')
it('sans dual-auth (session sans CSRF / rôle viewer) → 403/401 ; clé API → OK')
it('NON-RÉGRESSION gate — chemin consentId : publier avec le consentId RÉVOQUÉ → 422 (ConsentRequired)')
it('NON-RÉGRESSION gate — auto-découverte : après révocation du SEUL consentement couvrant, publier la même maille sans consentId/proof → 422')
it('dependentActiveLignes reflète les lignes non terminales dépendantes (une ligne published/deposee comptée, une masked/rejetee non)')
it('isolation multi-tenant : la révocation d’un tenant n’affecte pas le consentement homonyme d’un autre (RLS)')
```
Run → **RED** puis **GREEN**. **GARDE** : aucune suite ajoutée à `HEAVY_TESTS` (LIGHT, pas de `createTestWorker`) ; vérifier `heavy-suites.arch` + `apikeyid-setters.arch` verts sans modification.

- [ ] **Step 3 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "test(api): e2e de révocation de consentement (200/404/dual-auth, idempotence write-once, non-régression du gate sur les 2 chemins) et extension du verrou de composition M1 à la 7e route"
```
Expected: PASS ; gate binding prouvé de bout en bout ; M1 couvre `revokeConsent` ; verrous heavy/apiKeyId inchangés.

---

### Task 3 : Docs / runbook / OpenAPI / bump `0.12.0` — clôture

> **AMENDEMENT M1-DOC (revue du plan, BINDING — honnêteté sans euphémisme)** : la doc DOIT dire explicitement qu'après révocation, le miroir de consultation CONTINUE DE ROUTER les tiers vers la plateforme pour les mailles déjà consolidées, jusqu'à l'actualisation opérateur (procédure note 85 : clôturer/masquer/fallback) dont la transmission F13 réelle est DIFFÉRÉE. La révocation bloque le NEUF, elle ne rétracte PAS l'existant ; `dependentActiveLignes` + la procédure runbook = l'honnêteté intérimaire. Aucune formulation qui laisserait croire à une rétractation effective.

> **AMENDEMENT doc (BINDING honnêteté)** : documenter **exactement** ce que la révocation fait et **ne fait pas** — elle écrit `revoked_at` et bloque toute publication neuve ; elle **ne rétracte PAS** automatiquement les lignes déjà publiées vers le PPF (Flux 13 réel différé). La procédure opérateur (§3.5.5.5 note 85) et le champ `dependentActiveLignes` sont l'anti-silence ; **aucune** promesse de rétractation automatique.

**Files:**
- Modify: `README.md` racine, `apps/api/README.md`
- Modify: OpenAPI/Swagger si présent (`POST /annuaire/consents/:id/revoke`)
- Modify: `apps/api/package.json` (`version` → `0.12.0`) ; vérifier `packages/invoice-core` = `0.4.0` **non touché**

- [ ] **Step 1 : Documentation honnête** — décrire :
  - **Révocation de consentement** (D2/D3) : `POST /annuaire/consents/:id/revoke` (opérateur dual-auth) écrit `revoked_at` **write-once** (idempotent, monotone) ; le **gate de publication existant** refuse dès lors **toute nouvelle publication** adossée à ce consentement (chemins `consentId` **et** auto-découverte) — c'est la garantie « le système ne prétend jamais un adressage adossé à un consentement révoqué ».
  - **Effets sur les lignes déjà publiées — HONNÊTE (D2)** : la révocation **ne masque PAS** automatiquement les lignes déjà publiées. Raison (ancrage §3.5.3/§3.5.5.5 note 85 + sémantique `maskLigne`) : le masquage local **ne transmet rien** au PPF/miroir, ne peut toucher que les lignes `deposee`, et la spec distingue **clôturer** (lignes en vigueur) de **masquer** (lignes futures) de **créer une ligne fallback** (plateforme fictive) — une cascade uniforme serait une rétractation fabriquée. **Procédure opérateur** (§3.5.5.5 note 85) : clôturer les lignes en vigueur (`PUT /annuaire/lignes/:id`), masquer les lignes `deposee` non encore échues (`DELETE /annuaire/lignes/:id`), puis (rétractation réelle vers le PPF) créer un Flux 13 de masquage + ligne fallback — **cette dernière étape (transport Flux 13 réel) est DIFFÉRÉE (item Xavier)**. La réponse `dependentActiveLignes` **rapporte** le nombre de lignes encore actives à retirer.
  - **Différés 3.6+** : cascade réelle Flux 13 (masquage + clôture + fallback plateforme fictive 9998), auto-cascade registre (PPF-side), raison de révocation stockée (aucune colonne — fabrication évitée), e-signature eIDAS réelle, transport réel/`emise`, POST codes-routage autonome, garde composé (refusé 3.5-D7).

- [ ] **Step 2 : Bump + gate finale + commit**
```bash
# apps/api/package.json : "version": "0.12.0" (phase 3.6 : révocation de consentement)
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm test && pnpm run audit:ci && pnpm outdated -r
git add -A
git commit -m "docs: révocation de consentement (writer honnête, procédure de rétractation opérateur, différés Flux 13), bump version 0.12.0"
```
Expected: tout vert ; **invoice-core 100 %×4 non touché**, apps/api ≥ 90 %×4 (agrégat heavy+light), apps/web ≥ 90 %×4 ; audit:ci 0 ; outdated vierge.

---

## Self-Review (contre research 3.6 / le cadrage contrôleur)

**1. Couverture du cadrage :**
- **DÉCISION CENTRALE tranchée (D2)** : révocation-seule + gate existant binding + procédure opérateur documentée + rapport anti-silence `dependentActiveLignes` — **cascade-auto REJETÉE**, ancrage primaire (§3.5.3/note 79, §3.5.5.2-4, **§3.5.5.5/note 85**) + sémantique réelle `maskLigne` (transition **locale**, `deposee`-only, **ne transmet pas** — le « (transmission ?) » du cadrage tranché). ✅
- **Endpoint opérateur dual-auth** : `POST /annuaire/consents/:id/revoke`, triple garde M1 **binding sans exclusion**, motif exact des 6 mutations. ✅
- **Idempotence/CAS tranchée (D3)** : write-once `WHERE revoked_at IS NULL` ; déjà-révoqué → **idempotent 200**, `revoked_at` d'origine (monotone, jamais réécrit). ✅
- **404 anti-fuite** : byte-identique inconnu/cross-tenant/malformé (RLS). ✅
- **Aucune table/colonne** (D4) : `revoked_at`+grant existent ; **aucune migration** ; pas de `revoke_reason` (fabrication évitée). ✅
- **e2e LIGHT** + non-régression du gate (2 chemins) + M1 (6→7). ✅
- **Docs/runbook/bump 0.12.0 en dernière tâche.** ✅

**2. Non-régression & non-fabrication :** gate de publication **inchangé** (le plan le **prouve** binding, ne l'affaiblit pas) ; `resolveRecipient`/miroir **inchangés** ; la révocation **ne fabrique aucune** rétractation d'adressage (aucune cascade trompeuse — `maskLigne` ne transmet pas) ; **aucune** raison inventée ; les lignes debout sont rapportées **explicitement** (anti-silence), jamais masquées en douce.

**3. Interprétations marquées go-live :** (a) les lignes déjà publiées survivent à la révocation — rétractation réelle Flux 13 **différée**, rapportée via `dependentActiveLignes` + procédure §3.5.5.5 note 85 ; (b) divergence **pré-existante** `annuaire-lifecycle.ts` (codes 400/401 §3.5.7 vs `code: null`) **non traitée** (hors périmètre révocation) — notée au backlog.

**4. Cohérence types & migrations :** `revokeConsent`/`countActiveLignesForConsent` (repo) → service → contrôleur, chaîne typée ; `ConsentNotFoundError` pure mappée 404 ; **aucune** migration/table/colonne/policy/enum ; `nomenclature.ts` R/O.

## Recommandations fermes de périmètre (le contrôleur ratifie — aucune question ouverte)

- **R1 — Révocation-seule (D2, option b)** : writer `revoked_at` ; **aucune cascade auto** (masquage local ne transmet pas — rétractation fabriquée évitée) ; gate existant binding + procédure opérateur (§3.5.5.5 note 85) + rapport `dependentActiveLignes`. Retenu.
- **R2 — Endpoint dual-auth triple garde (M1 binding)** : `POST /annuaire/consents/:id/revoke`, 7e route, énumération M1 étendue 6→7, sans exclusion. Retenu (D3/D5).
- **R3 — Idempotence write-once (CAS)** : déjà-révoqué → 200 idempotent, `revoked_at` d'origine (monotone). Retenu (D3).
- **R4 — 404 anti-fuite byte-identique** (inconnu/cross-tenant/malformé). Retenu (D3).
- **R5 — Aucune migration/table/colonne** : `revoked_at`+grant existent ; worker exclu 42501 (inchangé) ; pas de `revoke_reason`. Retenu (D4).
- **R6 — Cascade réelle Flux 13 (masquage/clôture/fallback), auto-cascade registre, raison stockée, blocage dur : DIFFÉRÉS/REFUSÉS** avec rationale. Retenu (D2/D6).
- **R7 — Bump `apps/api` 0.12.0 ; `invoice-core` reste 0.4.0** (non touché). Retenu.

## Execution Handoff

Plan complet, sauvegardé dans `docs/superpowers/plans/2026-07-18-phase3-6-revocation-consentement.md`. Branche : `feat/phase3-6-revocation-consentement`. Deux options :
1. **Subagent-Driven (recommandé)** — un subagent frais par tâche, revue Opus entre chaque (aligné 1.x/2.x/3.x). Ordre : T1 (writer + endpoint) → T2 (e2e + non-régression gate + M1) → T3 (docs/bump). T2 dépend de T1 ; T3 dépend de T1/T2.
2. **Inline** — exécution par lots avec points de contrôle.
