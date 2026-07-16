# Plan 3.3 — Couture annuaire → facturation & durcissements transverses

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Boucler le **trou fonctionnel PDP** hérité de 2.4 — *l'annuaire sait résoudre le destinataire d'une facture, mais l'émetteur ne l'appelle jamais* — puis solder une dette transverse de durcissements 100 % code-interne (aucune extraction réglementaire nouvelle). Trois axes :

1. **Câblage `resolveRecipient` dans l'émission de factures** — brancher la résolution du destinataire (annuaire 2.4) sur le **pipeline de génération asynchrone** (le point de couture retenu, D1), en **réutilisant à l'identique** les précédents `ArchiveService` (best-effort strict post-génération) et `CdvTransmissionService` (construction de maille depuis l'acheteur + sémantique d'erreurs typées). Le résultat de résolution devient une **métadonnée de routage mutable** sur la facture (colonnes additives, migration 0026), **sans jamais muter le cycle de vie CDV scellé** (résolution ≠ émission ≠ transmission — honnêteté, D2). Exposé en lecture sur `GET /invoices/:id`.
2. **Endpoints codes-routage** — exposer la **gestion HTTP manquante** : un `GET /annuaire/codes-routage` énumérant les codes-routage **publiés par le tenant** (aucun endpoint n'expose aujourd'hui `annuaire_lignes` — seul le miroir de consultation l'est), dual-auth, zod inline, non-fuite par RLS. Refus ferme d'un POST « create » autonome (D6).
3. **Durcissements** : (a) **harmonisation de la validation UUID** des params `:id` sur `cdv`/`ereporting`/`annuaire`/`ledger` (4 contrôleurs, 8 routes) — comportement cible aligné sur `invoices` : **404 anti-fuite byte-identique, jamais un 500** (D7) ; (b) **clôture du footgun `apiKeyId`** — test d'architecture qui **asservit les poseurs** + unification de la déclaration de type (D9, recommandé vs garde composé) ; (c) **erreurs CAS typées** — remplacer les **trois** `CAS_STALE_RE` divergents par une erreur typée `CasStaleError` levée à la source (D8) ; (d) **teardown idempotent** du pool (`db.module`, garde + écouteur `error`, D10) ; (e) **stabilisation e2e** — split Vitest en projets *heavy*/*light* pour borner la contention testcontainers **sans refonte du harnais ni affaiblissement de l'hermétisme** (D11).

**Architecture :** On **réutilise le socle 1.x/2.x/3.x** exactement comme les plans précédents. La couture vit **entièrement dans `apps/api`** : un `RecipientRoutingService` (émission) appelé par `InvoiceGenerationProcessor` (déjà câblé au `WorkerModule` qui **fournit déjà** `AnnuaireConsultationService`, `AnnuaireRepository`, `InvoicesRepository`). Les helpers purs *Party → Maille* (`buildMailleFromBuyer`, `isoDateToYmd`, `normalizeToUndefined`, `BuyerIdentifierMissingError`), aujourd'hui dans `cdv-transmission.service.ts`, sont **extraits** vers `annuaire/maille-from-buyer.ts` (DRY + séparation de domaine : émission/cdv → annuaire, **jamais** émission → cdv). La persistance du routage **calque `markArchiveStatus`/`findArchiveState`** : colonnes additives sur `invoices` (déjà RLS FORCE + grant UPDATE), **migration 0026 seule** (aucune nouvelle table, aucune nouvelle RLS/grant, aucune SD). **`packages/invoice-core` n'est PAS touché** (le périmètre ne l'exige pas).

**Tech Stack :** **Aucune dépendance runtime ajoutée.** Résolution : `AnnuaireConsultationService` + `ligne-adressage.ts` (déjà présents). Persistance : drizzle + `pg` (déjà présents). HTTP : `zod` inline (déjà présent). Files/scheduler : **BullMQ 5.80.x** (déjà présent — aucune nouvelle file, aucun nouveau slot). Tests : **Vitest 4.1.10** (déjà présent — split par `test.projects`, natif). `docker-compose` inchangé.

## Global Constraints

Reprises **verbatim** du socle 1.x/2.x/3.x (non négociables) — chaque tâche en hérite implicitement :

- **TDD strict RED/GREEN** : test écrit et vu échouer avant toute implémentation ; aucun merge si un test échoue. Un commit minimum par tâche, message en **français**, **sans** trailer `Co-Authored-By: Claude` ni mention Claude ; commits au seul nom de l'utilisateur. `pnpm format` avant chaque commit.
- **Couverture bloquante** : **≥ 90 %** (lines/functions/statements/branches) maintenue sur `apps/api` et `apps/web`. **`packages/invoice-core` N'EST PAS touché** ce plan (il se tient à 100 %×4 ; ne pas régresser — aucune modification attendue). Exclusions de couverture `apps/api` conservées (`src/main.ts`, `src/worker-main.ts`, `**/*.module.ts`, `src/db/migrations/**`). **Tout module pur** (helper maille, routing service testé en isolation) visé **100 %** par des tests déterministes (**aucun `Date.now()` dans la logique pure** ; `now`/`issueDate` injectés).
- **e2e sur Postgres réel (Testcontainers)** pour toute table/endpoint ; **Redis réel** pour tout flux worker/scheduler ; **tests d'isolation multi-tenant explicites**. **Motifs de stabilité e2e OBLIGATOIRES** (1.4/2.x/3.x) : `listenOnce`, `maxWorkers` (ou projet dédié) borné, `withStartupTimeout(120_000)`, `hookTimeout(150_000)`, polling `waitFor` borné (jamais de sleep fixe), aucun affaiblissement de l'hermétisme (chaque fichier garde ses conteneurs + ses ports en mémoire).
- **Sécurité OWASP** : validation de toute entrée (zod), authz systématique (dual-auth sur les endpoints ; CSRF sur les mutations de session). **Aucune donnée sensible hors des frontières tenant** : toute lecture sous RLS. Erreurs normalisées **RFC 9457 `application/problem+json`**. **404 anti-fuite byte-identique** : inconnu / hors-période / cross-tenant / **param malformé** indiscernables côté HTTP.
- **Moindre privilège Postgres inchangé** : rôle `factelec_app` ≠ propriétaire, **sans `BYPASSRLS`, sans superuser**. **Aucune nouvelle table** attendue → aucune nouvelle policy RLS/grant. La migration 0026 n'ajoute que des **colonnes additives** sur `invoices` (déjà `ENABLE`+`FORCE`, grant `UPDATE` déjà accordé — utilisé par `markGenerationStatus`/`markArchiveStatus`/`recordTransition`). **Aucune nouvelle fonction SD.**
- **TypeScript `strict: true`, ESM, NodeNext, Node ≥ 22.** `typescript` pinné **exactement `7.0.2`** (racine, tsgo). Repli local `typescript@5.9.x` du seul workspace concerné autorisé et documenté si un typecheck bute — sans toucher le pin racine.
- **Dépendances pinnées exactement, dernière stable, licence.** **`pnpm run audit:ci` 0 vulnérabilité** et **`pnpm outdated -r` vierge** restent **bloquants** en CI. **Aucune dépendance ajoutée** → objectif mécaniquement tenu (vérifier néanmoins à **chaque** tâche — un patch amont peut sortir en cours de plan, drift @cantoo/pdf-lib 3.2-T3).
- **`@factelec/invoice-core` consommé via son exports map** (barrel `.` unique), jamais par chemin relatif. `docs/reference/` et `docs/reglementaire/` en **lecture seule** (aucun XSD copié/modifié).
- Identifiants de code en **anglais** ; commentaires/commits/docs en **français**.
- **Oracles de test indépendants (anti-tautologie)** : ne jamais asserter un comportement en le comparant à sa propre implémentation ; les vecteurs viennent d'une source distincte du code testé.

---

## Périmètre : retenu en 3.3 vs reporté

**Retenu (ce plan) :**
1. **Persistance du routage** (migration 0026, colonnes additives `invoices`) + repo `markRoutingStatus`/`findRoutingState` + enrichissement `findById`/`GET /invoices/:id` (Task 1, D3).
2. **Extraction du helper *Party → Maille*** vers `annuaire/maille-from-buyer.ts` + **`RecipientRoutingService`** (best-effort strict) + **couture dans `InvoiceGenerationProcessor`** + câblage `WorkerModule` (Task 2, D1/D2/D4/D5) — **le cœur du plan**.
3. **Endpoints codes-routage** : `GET /annuaire/codes-routage?siren=` (énumération des lignes/codes publiés par le tenant), dual-auth, zod, RLS (Task 3, D6).
4. **Harmonisation validation UUID** des params `:id` (extraction `common/uuid.ts` + 8 routes sur 4 contrôleurs) → 404 byte-identique, jamais 500 (Task 4, D7).
5. **Erreurs CAS typées** : `CasStaleError` (commune) levée aux 7 sites CAS des repos ; les 3 services catchent le type, suppression des 3 `CAS_STALE_RE` (Task 5, D8).
6. **Footgun `apiKeyId`** : test d'architecture (poseurs asservis) + unification de la déclaration de type (Task 6, D9).
7. **Stabilisation e2e** : teardown idempotent (`db.module`) + écouteur `error` sur le pool app + split Vitest *heavy*/*light* (Task 7, D10/D11).
8. **Docs / OpenAPI / README / bump `0.9.0`** (Task 8).

**Reporté (acté ici, justifié en D\*) — différés 3.4+ :**
- **Chemin RE (retransmission Flux 10 / rectificatif)** : exige une **ré-extraction réglementaire primaire** (leçon B1 — un cycle dédié avec sa propre recherche). Hors périmètre (binding). Le type `'RE'` + l'index partiel `WHERE type='IN'` sont déjà prêts ; le runbook de déblocage de slot `IN` né-`rejetee` reste manuel (hérité 2.3).
- **E-signature du consentement annuaire** : décisions cryptographiques + probable fournisseur externe (item Xavier). Les champs de preuve (`consentType`/`signerIdentity`/`evidenceRef`/`obtainedAt`) sont modélisés et persistés sous RLS ; aucune vérification/révocation/endpoint n'est livré. Différé.
- **Worker-role split** : lié au déploiement (séparation des privilèges du process worker). Différé.
- **Sweep de reprise du routage** (rejeu automatique d'un `routing_status='pending'` sur panne annuaire opérationnelle) : le routage best-effort-strict est re-résolu à toute re-génération (réconciliation existante) ; un sweep dédié (miroir `ArchiveRetryService`) est différé — documenté en D4.
- **Garde composé dual-auth dédié** : alternative plus lourde au test d'architecture (D9) — différée tant qu'une seconde route dual-auth n'apparaît pas.
- **POST `/annuaire/codes-routage` autonome** : refusé (D6) — les codes-routage ne sont pas des entités indépendantes ; créés via `POST /annuaire/lignes`. Réexaminable en 3.4+ (exigerait sa propre table + ancrage réglementaire).
- **Transition `emise` (201) sur transport réel** : la mutation légitime du cycle de vie CDV vers `emise`/`recue` survient à l'**émission réelle** (adaptateurs de transport SFTP/AS2/AS4/API — items Xavier), qui consommera `recipient_platform`. Différé.

---

## Décisions structurantes (à lire avant d'exécuter)

### D1 — Point de couture = `InvoiceGenerationProcessor` (candidat 3), PAS `ingest`/`controller`/`lifecycle`
Quatre candidats étaient au dossier (research §Item 1). **Retenu : le worker de génération** (`apps/api/src/worker/invoice-generation.processor.ts`, `process()`), la résolution étant un **pas d'émission best-effort AJOUTÉ après `completeGeneration`** (à côté de `archive.archiveInvoice`). Rationale ferme, sur les trois critères imposés (sémantique d'erreurs / idempotence / non-régression) :

- **Non-régression (décisif).** `ingest()` (candidat 1) validerait→persisterait→enfilerait comme aujourd'hui, mais y **coupler une lecture annuaire synchrone** régresse le chemin chaud HTTP : soit on **rejette une facture parfaitement valide** simplement non-routable *pour l'instant* (une ligne d'annuaire peut entrer en vigueur plus tard — F13 row 24 concerne l'**adressabilité**, pas l'**acceptation**), soit on retourne une info molle sans effet persistant. Le worker, lui, résout **après** que la génération a réussi : les formats sont produits **exactement comme avant**, la résolution est un rider additif qui **ne peut pas** faire échouer l'émission (D2). `invoices.controller` (candidat 2) n'est qu'une couche HTTP (pas un vrai seam). `lifecycle.service.transition()` (candidat 4) est déclenché par des acteurs externes (apposition de statut) — mauvais déclencheur pour une résolution d'émission.
- **Sémantique d'erreurs.** Le worker est **asynchrone** : les erreurs typées de résolution ne produisent **aucun code HTTP** (l'invoice a été validement ingérée — une non-adressabilité n'est pas une erreur client). Elles produisent un **statut de routage observable** (D4), surfacé en lecture par `GET /invoices/:id`. C'est exactement la posture `ArchiveService` (best-effort, jamais d'échec du flux appelant).
- **Idempotence.** Le rejeu du job (retry BullMQ ou réconciliation) re-résout et **écrase** un résultat déterministe (comme `markArchiveStatus`) — aucun double-effet, aucune implication du journal scellé (le routage est une métadonnée **mutable**, pas un événement probatoire).
- **Réutilisation.** Le `WorkerModule` **fournit déjà** `AnnuaireConsultationService`, `AnnuaireRepository` et `InvoicesRepository` (vérifié in situ) → **aucun nouveau câblage de module**. Le processor injecte simplement le nouveau `RecipientRoutingService`.

### D2 — La résolution est best-effort STRICT (jamais throw) ; elle ne MUTE PAS le cycle de vie CDV scellé
- **Best-effort strict**, calqué **mot pour mot** sur `ArchiveService.archiveInvoice` : `RecipientRoutingService.resolveAndRecord(...)` **encapsule un try/catch total** et **ne relève jamais** — garantie de non-régression la plus forte (une panne annuaire ne fera **jamais** échouer un job de génération réussi, contrairement à `CdvTransmissionService` où la transmission EST le job).
- **PAS de transition du cycle de vie CDV.** Résoudre un destinataire **≠** émettre **≠** transmettre. Écrire `emise` (201, « Émise par la plateforme ») sur une simple résolution **fabriquerait** une affirmation d'émission alors que les adaptateurs de transport sont différés (items Xavier) — anti-pattern « aucune fabrication » / « documentation honnête ». Le journal `invoice_status_events` est **append-only et probatoire** ; y écrire un événement d'émission spéculatif est proscrit. Le routage vit donc dans des **colonnes métadonnées mutables** (D3), orthogonales au cycle de vie. La mutation légitime vers `emise` surviendra à l'émission réelle (transport, 3.4+), qui **consommera** `recipient_platform`.
- **Réponse explicite au cadrage** (« RecipientUnaddressable/Ambiguous → quel statut CDV / quel code HTTP / quel différé ») : **statut CDV = aucun** (justifié ci-dessus) ; **code HTTP = aucun** (async, non-bloquant ; surfacé en lecture 200) ; **différé = statut de routage retriable** + log (D4).

### D3 — Persistance du routage = 2 colonnes additives sur `invoices`, miroir `archiveStatus` ; migration 0026 seule
- **Modèle** (calque exact de `archive_status`/`archive_location`/`archive_hash`) : `routing_status` (**pgEnum** `['pending','resolved','unaddressable','ambiguous']`, `NOT NULL DEFAULT 'pending'`) + `recipient_platform` (`text` **nullable** — le matricule de plateforme résolu, `null` tant que non-résolu). Un `ADD COLUMN ... NOT NULL DEFAULT 'pending'` remplit les lignes existantes sans collision (aucune contrainte unique ajoutée — contrairement au piège 0011 du scellement) : les factures antérieures obtiennent `'pending'` (honnête : elles précèdent la fonctionnalité).
- **Migration 0026 (drizzle) seule** : `CREATE TYPE routing_status` + `ALTER TABLE invoices ADD COLUMN` ×2 + snapshot + `meta/_journal.json` idx 26 (`version:"7"`, `when` epoch-ms ~+100000 après 0025). **Aucune migration RLS/grant** : `invoices` est déjà `ENABLE`+`FORCE`, le grant `UPDATE` est déjà accordé à `factelec_app`. Migration la plus haute vérifiée in situ = **0025**.
- **Repo** (miroir `markArchiveStatus`/`findArchiveState`) : `markRoutingStatus(tenantId, invoiceId, status, platform?)` (écrit `routing_status` + `recipient_platform` ; `platform` omis → `null`), `findRoutingState(tenantId, invoiceId)`. `findById` (et `InvoiceSummary`) **enrichis** de `recipientPlatform`/`routingStatus` → `GET /invoices/:id` les expose (pas la liste — on ne widen pas le DTO de liste).

### D4 — Sémantique d'erreur du routage : typé → statut ; opérationnel → 'pending' + log ; jamais throw
Dans `resolveAndRecord(tenantId, invoiceId, invoice)` :
- **Succès** → `markRoutingStatus(..., 'resolved', plateforme)`.
- **`RecipientUnaddressableError`** → `markRoutingStatus(..., 'unaddressable')` + `logger.warn` (retriable : la ligne d'annuaire peut entrer en vigueur plus tard).
- **`AmbiguousResolutionError`** → `markRoutingStatus(..., 'ambiguous')` + `logger.warn` (nécessite un nettoyage de l'annuaire par l'opérateur).
- **`BuyerIdentifierMissingError`** (acheteur sans SIREN/SIRET — défensif, `partySchema.siren` est `.optional()`) → traité comme `'unaddressable'` + log (maille non constructible).
- **Erreur opérationnelle** (annuaire/DB indisponible) → `logger.error` + **on laisse `routing_status` inchangé (`'pending'`)** + **on ne relève JAMAIS** (non-régression : le job de génération reste un succès). Un sweep de reprise dédié est **différé** (3.4+, miroir `ArchiveRetryService`).

> **AMENDEMENT M1 (revue du plan, BINDING)** : la version initiale de ce Dx affirmait « re-résolu à toute re-génération (réconciliation existante) » — c'est **FAUX** : `sweepStuckGeneration` ne balaie QUE `received`/`generating` ; une facture `generated` au routage `'pending'` opérationnel n'est **JAMAIS reprise automatiquement** (le job a réussi, aucun retry BullMQ). En 3.3, le routage est donc le **seul** best-effort du projet **sans mécanisme de reprise** : un `'pending'` persiste jusqu'au sweep 3.4 ou à un re-enfilement manuel. Conséquences BINDING : (a) Task 2 et Task 8 documentent ce trou EXPLICITEMENT (aucune promesse de réconciliation) ; (b) **observabilité** : `'pending'`/`'unaddressable'` sont invisibles hors `GET /invoices/:id` (aucun filtre de liste) — Task 8 documente la requête SQL opérateur (`SELECT id, number FROM invoices WHERE routing_status IN ('pending','unaddressable','ambiguous')`) dans le runbook, en nommant le trou (filtre de liste = 3.4+).
- **Idempotence** : ré-exécution = écrasement déterministe. Aucun CAS, aucun journal.
- **Test d'oracle** : la résolution attendue est calculée **indépendamment** (seed d'une ligne d'annuaire à plateforme connue → `recipient_platform` == cette plateforme ; pas de ligne → `'unaddressable'`).

### D5 — Extraction du helper *Party → Maille* vers `annuaire/maille-from-buyer.ts` (DRY + couches)
- `buildMailleFromBuyer`, `isoDateToYmd`, `normalizeToUndefined`, `BuyerIdentifierMissingError` vivent aujourd'hui dans `cdv-transmission.service.ts` (fonctions pures exportées). Les **déplacer** vers `apps/api/src/annuaire/maille-from-buyer.ts` (pur ; dépend seulement de `ligne-adressage.Maille` + `invoice-core.Party`). Motif : **séparation de domaine** — l'émission (`invoices`/`worker`) doit dépendre de l'**annuaire** (le répertoire), **jamais du domaine CDV** (consommateur aval du cycle de vie, pas fournisseur de primitives d'émission ; la séparation est explicitement documentée dans `cdv-transmission.service.ts`). Extraction **strictement comportement-préservant** (déplacement + ré-export depuis `cdv-transmission.service.ts` si des tests l'importent par ce chemin ; les tests unitaires des helpers migrent vers `maille-from-buyer.test.ts`). **Gate : les tests CDV restent verts** (aucun changement de comportement).
- `RecipientRoutingService` et `CdvTransmissionService` importent tous deux depuis `maille-from-buyer.ts` (une seule définition).

### D6 — Endpoints codes-routage = GET énumération (lignes publiées du tenant) ; POST autonome REFUSÉ
- **Le vrai trou de « gestion HTTP »** : `GET /annuaire/lignes` lit le **miroir de consultation** (`annuaire_directory_entries`, ce que le tenant peut *chercher*) ; **aucun endpoint** n'expose `annuaire_lignes` (les lignes que le tenant a lui-même **publiées**). `listLignes` existe au repo mais **n'a aucune route**. Le PA gère ses lignes (POST/PUT/DELETE) sans pouvoir **lister ses codes-routage**.
- **Retenu** : `GET /annuaire/codes-routage?siren=` (dual-auth `TenantAuthGuard`, zod query calquée `lignesQuerySchema`, RLS) → `{ codes: [{ routageId, siret, plateforme, status, dateDebut, dateFin }] }` : les codes-routage **publiés par le tenant** (`annuaire_lignes` du tenant, `siren = …` ET `routageId IS NOT NULL`), projetés avec leur `status` (vue de gestion honnête — **amendement m4** : l'enum a **5** valeurs, `draft/published/deposee/rejetee/masked` — ne pas oublier `deposee`, vérifier l'enum réel du schéma au moment d'implémenter). **Tableau vide** si aucun (énumération — **pas** 404). **Non-fuite par RLS** : un SIREN cross-tenant renvoie un tableau vide (aucune fuite d'existence, exactement comme `GET /annuaire/lignes` aujourd'hui). Nouvelle méthode repo `listRoutingCodes(tenantId, siren)`.
- **Refus ferme d'un POST create autonome** : un code-routage n'est **pas** une entité indépendante — il est un composant de maille (`SIREN_SIRET_ROUTAGE`) créé via `POST /annuaire/lignes`. Un POST « create code » **fabriquerait** une entité absente du modèle et **dupliquerait** le cycle de vie des lignes (aucune nouvelle table — contrainte). Décision documentée (miroir du refus d'auto-seed 212 en 3.2-D5, et du non-mapping `MotifRequiredError` sans route en 2.4). Réexaminable en 3.4+ si un besoin métier autonome émerge.

### D7 — Harmonisation UUID : `isUuid` au point de production du 404, byte-identique, jamais 500
- **État** : `isUuid` (`invoices/format-kind.ts:18`, regex `^[0-9a-f]{8}-…-…12$/i`) est appliqué en couche **service** pour `invoices`/`lifecycle`/`api-keys` (404 **avant** toute requête SQL). **Non appliqué** sur 4 contrôleurs (8 routes) qui passent `:id` brut à `eq(table.id, id)` (colonne `uuid`) → cast Postgres échoue → **500** :
  - `cdv.controller` : `GET transmissions/:id/xml`, `GET transmissions/:id/events` (→ `repo.findTransmission`).
  - `ereporting.controller` : `GET transmissions/:id/xml`, `GET transmissions/:id/events` (→ `repo.findTransmissionStatus`).
  - `annuaire.controller` : `PUT lignes/:id`, `DELETE lignes/:id` (→ `getLigne`).
  - `ledger.controller` : `GET :id/ledger`, `GET :id/paf` (→ `repo.getLifecycleStatus` / `pafService.buildPaf`).
- **Cible** : ajouter `if (!isUuid(id)) throw <le notFound EXISTANT de ce contrôleur>` **au point exact où chaque contrôleur produit déjà son 404** (avant l'appel repo/service), réutilisant la **même** fabrique 404 → **404 byte-identique** (un `:id` malformé et un `:id` inconnu/cross-tenant sont indiscernables : anti-fuite préservée). `invoices`/`lifecycle`/`api-keys` restent inchangés (déjà conformes). **Amendement m5** : `ledger.controller` n'a **PAS** de fabrique `notFound()` réutilisable (son 404 est dupliqué inline) — l'EXTRAIRE d'abord en fabrique locale (comportement-préservant, corps byte-identique), puis y brancher `isUuid`.
- **`isUuid` extrait** vers `apps/api/src/common/uuid.ts` (source unique, importée par les 4 contrôleurs + les 3 importeurs existants) ; `format-kind.ts` se recentre sur le parsing de format. Extraction comportement-préservante.

### D8 — Erreurs CAS typées : `CasStaleError` commune remplace les 3 `CAS_STALE_RE` divergents
- **État (fragilité réelle)** : **trois** déclarations distinctes de `CAS_STALE_RE`, **aux regex divergentes** — `/is not in 'transmitted' status/` (`cdv-status.service:21`, `ereporting-status.service:18`) vs `/is not in '.*' status/` (`annuaire-publication.service:31`) — chacune faisant `.test(err.message)` sur une `Error` **générique** dont le message est produit par 7 sites CAS des repos (`throw new Error("... is not in '...' status ...")`). Couplage service↔wording du repo, explicitement assumé mais fragile ; **aucune** classe de base d'erreur commune n'existe.
- **Cible** : introduire `CasStaleError` (commune, `apps/api/src/common/cas-error.ts` — `extends Error`, champs `readonly { entity, id, expectedStatus }`, `this.name='CasStaleError'`, motif des ~23 erreurs typées existantes). Les **7 sites CAS des repos** (cdv ×3, annuaire ×2, ereporting ×2 : `markTransmitted`/`markParked`/`appendStatusEvent`/`markPublished`/`appendLigneEvent`/`recordTransition`-like) lèvent `CasStaleError` au lieu du `throw new Error(...)` textuel. Les **3 services** catchent `err instanceof CasStaleError` au lieu de la regex, et **suppriment** les `CAS_STALE_RE`. **Comportement HTTP inchangé** (409 / `'skipped'` selon le site — mappings préservés, y compris la conflation voulue « stale / id inconnu / cross-tenant » qui reste indiscernable). Les tests assertant aujourd'hui le message textuel assertent désormais le **type**.
- **Anti-régression** : le message des repos peut être **conservé** dans le `super(...)` de `CasStaleError` (utile aux logs) — seul le mécanisme de détection passe du texte au type. Les branches sont déjà exercées (tests existants) → couverture préservée.

> **AMENDEMENT M2 (revue du plan, BINDING)** : « 409 / 'skipped' » sous-décrivait les sorties. `annuaire-publication.service` a **TROIS** blocs catch aux sorties **DISTINCTES**, pas un. L'inventaire EXHAUSTIF des **5 catch** à préserver un par un (Task 5) :
> 1. `cdv-status.service` → **409** ; 2. `ereporting-status.service` → **409** ;
> 3. `annuaire-publication.service` / `recordAck` → **`throw StaleLigneTransitionError`** ; 4. idem / `maskLigne` → **`throw StaleLigneTransitionError`** ; 5. idem / `republishDraft` → **`return 'skipped'`**.
> Chaque site garde EXACTEMENT sa sortie actuelle (409 vs StaleLigneTransitionError vs 'skipped') — seule la DÉTECTION passe de la regex au `instanceof CasStaleError`. Un e2e/unit témoin par sortie (3 familles) prouve la non-régression de contrat.

### D9 — Footgun `apiKeyId` : test d'architecture (poseurs asservis) + unification de type — RECOMMANDÉ vs garde composé
- **Le footgun** : `req.apiKeyId` est **posé** par exactement deux guards (`api-key.guard:47`, `tenant-auth.guard:46`) et **lu pour bypass** par `csrf.guard:26` et `roles.guard:37` (`if (req.apiKeyId) return true`). Une seule route l'expose (`POST /payments` = `TenantAuthGuard, RolesGuard, CsrfGuard`). Le danger : un **nouveau** code posant `apiKeyId` (ou une composition de guards mal ordonnée) court-circuiterait silencieusement un contrôle de rôle/CSRF attendu. Le type `apiKeyId?` est **dupliqué** dans deux interfaces locales (`TenantRequest`, `SessionRequest`).
- **RECOMMANDÉ (retenu) : test d'architecture qui asservit les poseurs.** Un test Vitest structurel (lecture des sources des guards) asserte : (1) **seuls** `api-key.guard.ts` et `tenant-auth.guard.ts` contiennent `req.apiKeyId =` (les poseurs autorisés) ; (2) **seuls** `roles.guard.ts` et `csrf.guard.ts` contiennent le bypass `req.apiKeyId` en lecture. **+ unification** de la déclaration de type `apiKeyId?: string` en **une source unique** (augmentation partagée réutilisée par `TenantRequest`/`SessionRequest`). Justification du choix : (a) le test cible **exactement** la racine du risque (un futur poseur) — c'est littéralement « asservir les poseurs » ; (b) **zéro changement de comportement, zéro risque de régression** sur l'unique route dual-auth existante ; (c) coût minimal, aligné sur la revue finale 3.2 qui accepte l'un OU l'autre.
- **Alternative plus lourde (différée)** : un garde composé `DualAuthMutationGuard` encapsulant « clé API OU session ; si session → rôle ∈ X ET CSRF ». Écarté ici : friction NestJS-idiomatique (guards s'appelant / duplication du reflector), touche la route qui marche, gain marginal pour **une seule** route. À reconsidérer dès qu'une **seconde** route dual-auth apparaît.

> **AMENDEMENT M3 (revue du plan, BINDING)** : un grep sur la seule forme `req.apiKeyId =` est **trivialement contournable** (`req['apiKeyId'] =`, alias, `(req as any)`, helper). Le test d'architecture est un **RALENTISSEUR honnête**, pas un « asservissement » : (a) le qualifier ainsi dans son commentaire ET dans la doc Task 8 (le garde composé reste LA vraie barrière, différée à la 2ᵉ route dual-auth) ; (b) matcher PLUSIEURS formes d'écriture (`.apiKeyId =`, `['apiKeyId'] =`, `["apiKeyId"] =` au minimum) sur TOUT `apps/api/src` (pas seulement les guards) ; (c) l'unification de type NE DOIT PAS être une augmentation globale `declare module 'express'` (élargirait `apiKeyId` à TOUTE Request du projet — l'inverse de l'objectif) : garder un type de requête ÉTROIT (interface partagée importée explicitement par les seuls guards concernés).

### D10 — Teardown idempotent du pool (`db.module`)
- **État** : `DbModule.onModuleDestroy` fait `await this.pool.end()` **sans garde**. `pg-pool` rejette « Called end on pool more than once » si `end()` est appelé deux fois (flag interne `this.ending`). Aucun `pool.on('error', …)` sur le pool app → un `57P01` (admin shutdown) au teardown peut émettre un `error` non géré (bruit récurrent noté depuis phase 1).
- **Cible** : (1) garde d'idempotence dans `onModuleDestroy` (booléen `private ended = false ; if (this.ended) return ; this.ended = true ; await this.pool.end()`) → double-destroy = no-op ; (2) écouteur `error` sur le pool app (dans `createPool` : `pool.on('error', …)` qui **avale/journalise** le bruit `57P01` de teardown, jamais un throw). Test unitaire : `onModuleDestroy` appelé deux fois → `pool.end` invoqué **une** seule fois.

### D11 — Stabilisation e2e : split Vitest *heavy*/*light*, sans refonte ni perte d'hermétisme
- **État** : `vitest@4.1.10`, seule maîtrise = `maxWorkers: 5`. 47 fichiers e2e ; **14** démarrent Redis, dont **8 « lourds »** démarrent **aussi** des Workers BullMQ (chacun : conteneur PG + Redis + Workers) : `ereporting-generation`, `ereporting-payments`, `annuaire-sync`, `cdv-transmission-sweep`, `async-generation`, `archive-generation`, `ereporting-sweep`, `session-purge`. La flakiness (6+ occurrences, dette 3.2) vient de la **contention testcontainers** quand plusieurs suites lourdes démarrent simultanément (timeouts de démarrage, bruit teardown, redis ping timeout).
- **Cible (mesure minimale efficace)** : passer en **`test.projects`** (natif Vitest 4) — deux projets partageant `setupFiles`/coverage/timeouts :
  - **`heavy`** : glob les **8 suites BullMQ+Redis** avec **`fileParallelism: false`** (exécution **série** — au plus un jeu de conteneurs lourds à la fois, ce qui élimine la source dominante de contention).
  - **`light`** : glob **tout le reste** avec `maxWorkers: 5` (parallélisme préservé pour les suites Postgres-seul/légères).
  - Les seuils de couverture restent **définis une fois** à la racine et **fusionnés** ; l'hermétisme est **intact** (chaque fichier garde ses conteneurs + ports en mémoire — on ne partage rien). La nouvelle e2e de la couture (Task 2, worker) tombe dans `heavy` par glob.
- **Sans retry** : on **n'ajoute pas** de `retry` ciblé — masquerait de vrais défauts et affaiblirait le signal (la contention est traitée à la racine, pas cachée). Le teardown idempotent (D10) réduit en plus le bruit résiduel. Fallback documenté si insuffisant : abaisser `maxWorkers` du projet `heavy` / global.

---

## Versions & dépendances (registre npm — à re-vérifier à chaque tâche)

| Brique | Fournisseur | Provenance / note |
|---|---|---|
| Résolution destinataire | `AnnuaireConsultationService` + `ligne-adressage.ts` (déjà `apps/api`) | **Aucun ajout.** |
| Persistance routage | drizzle + `pg` (déjà présents) | Migration **0026 (drizzle)** seule ; aucune RLS/grant. |
| Endpoints / validation | `zod` inline + `@nestjs/common` (déjà présents) | **Aucun ajout.** |
| Split e2e | **Vitest 4.1.10** (déjà présent) | `test.projects` natif — **aucun ajout**. |

> **Gate** : `pnpm run audit:ci` = 0 et `pnpm outdated -r` **vierge**. Vérifier à **chaque** tâche (patch amont possible — drift @cantoo/pdf-lib attrapé en 3.2). Bump **`apps/api` 0.8.0 → 0.9.0** (Task 8) ; `invoice-core` **reste 0.4.0** (non touché).

---

## Points de risque signalés d'emblée

1. **Régression du pipeline d'émission.** **Traité** : D1/D2 — couture après `completeGeneration`, best-effort STRICT (jamais throw), calqué `ArchiveService` ; la génération réussit exactement comme avant. e2e de non-régression (async-generation intact).
2. **Sur-affirmation d'émission (mutation CDV).** **Traité** : D2 — aucune transition du journal scellé ; métadonnée mutable seule ; `emise` reste pour le transport réel (3.4+).
3. **Couplage de domaine émission → cdv.** **Traité** : D5 — helper *Party→Maille* extrait vers `annuaire/`, consommé par cdv ET émission ; les tests CDV restent verts.
4. **Migration additive sur table peuplée.** **Traité** : D3 — `ADD COLUMN NOT NULL DEFAULT 'pending'` sans contrainte unique → aucune collision (contrairement au piège 0011) ; anciennes factures = `'pending'` (honnête).
5. **404 anti-fuite affaibli par la validation UUID.** **Traité** : D7 — 404 byte-identique (même fabrique notFound), malformé indiscernable d'inconnu/cross-tenant.
6. **Régression comportementale des mappings CAS.** **Traité** : D8 — même sortie HTTP (409/`skipped`), seul le mécanisme passe du texte au type ; branches déjà couvertes.
7. **Affaiblissement de l'authz (footgun apiKeyId).** **Traité** : D9 — test d'archi qui **verrouille** les poseurs + unification de type, zéro régression ; garde composé différé justifié.
8. **Perte d'hermétisme / de parallélisme e2e.** **Traité** : D11 — split *heavy*/*light*, conteneurs par fichier inchangés, seuils fusionnés, pas de retry.
9. **Bruit/erreur de teardown pool.** **Traité** : D10 — garde idempotente + écouteur `error`.
10. **Endpoints codes-routage fabriqués.** **Traité** : D6 — GET énumération sur données réelles (`annuaire_lignes`), POST autonome refusé (aucune fabrication, aucune nouvelle table).

---

## Sources vérifiées in situ (lecture seule — AUCUNE extraction réglementaire nouvelle)

Ce plan est **100 % code-interne** (décision contrôleur, ledger 3.3). Faits vérifiés dans le code à `main` (HEAD 711a194), non paraphrasés :
- **Couture** : `resolveRecipient` défini `annuaire/ligne-adressage.ts` ; exposé par `AnnuaireConsultationService.resolveRecipient` (`annuaire-consultation.service.ts:100-109`, lit `annuaire_directory_entries` sous RLS) ; consommé **uniquement** par `annuaire.controller` (GET /resolution) et `cdv-transmission.service.ts:184-205` ; **jamais** par `invoices.service`/`invoice-generation.processor`. Helpers *Party→Maille* dans `cdv-transmission.service.ts:47-125`. Précédent best-effort = `archive.service.ts:26-82` (try/catch total, `markArchiveStatus('failed')`, jamais throw) + `worker/archive-retry.service.ts`. Colonnes archive sur `invoices` (schema.ts:118-125) = gabarit de `markArchiveStatus`/`findArchiveState` (`invoices.repository.ts:412-452`). `WorkerModule` fournit déjà `AnnuaireConsultationService`+`AnnuaireRepository`+`InvoicesRepository`. Migration max = **0025**.
- **Codes-routage** : `annuaire_lignes.routageId` nullable ; `listLignes` (repo) **sans route** ; `GET /annuaire/lignes` lit le miroir `annuaire_directory_entries` (pas `annuaire_lignes`). Zod de frontière : `annuaire-query.schema.ts` (`lignesQuerySchema`, `emptyToUndefined`, `optionalToken`).
- **UUID** : `isUuid` (`format-kind.ts:18`) en couche service pour invoices/lifecycle/api-keys ; absent sur cdv/ereporting/annuaire/ledger (8 routes `:id`), toutes colonnes `id` en `uuid` → 500 non gardé.
- **CAS** : 3× `CAS_STALE_RE` divergents (`cdv-status.service:21`, `annuaire-publication.service:31`, `ereporting-status.service:18`) ; 7 sites repo `throw new Error(... is not in '...' status ...)` ; aucune classe d'erreur de base.
- **apiKeyId** : posé `api-key.guard:47` / `tenant-auth.guard:46` ; bypass `csrf.guard:26` / `roles.guard:37` ; unique route dual-auth `payments.controller:65` ; type dupliqué (`api-key.guard:12-15`, `auth.types:17-22`) ; aucun test d'archi.
- **Teardown** : `db.module.ts` `onModuleDestroy` `pool.end()` sans garde ; `client.ts` `createPool` sans écouteur `error` ; erreur pg-pool « Called end on pool more than once » (flag `ending`).
- **e2e** : `vitest@4.1.10`, `maxWorkers:5` seul ; 8 suites lourdes BullMQ+Redis identifiées ; motifs `listenOnce`/`withStartupTimeout(120s)`/`hookTimeout(150s)`/`waitFor` en place.

---

## Structure des fichiers (vue d'ensemble)

```
apps/api/
  package.json                              # version 0.8.0 → 0.9.0 (Task 8)
  src/common/
    uuid.ts                                 # isUuid (extrait de format-kind) (Task 4)
    cas-error.ts                            # CasStaleError commune (Task 5)
  src/db/
    db.module.ts                            # teardown idempotent (garde `ended`) (Task 7)
    client.ts                               # createPool + pool.on('error') (Task 7)
    schema.ts                               # + routingStatus (pgEnum) + recipientPlatform sur invoices (Task 1)
    migrations/0026_invoice_routing.sql     # (drizzle) CREATE TYPE + ADD COLUMN ×2 (Task 1)
    migrations/meta/_journal.json           # + 0026
  src/invoices/
    format-kind.ts                          # isUuid retiré → ré-export/back-compat (Task 4)
    invoices.repository.ts                  # + markRoutingStatus/findRoutingState ; findById enrichi (Task 1)
    invoices.service.ts                     # get() renvoie routingStatus/recipientPlatform (Task 1)
    recipient-routing.service.ts            # PUR-ish : resolveAndRecord (best-effort strict) (Task 2)
  src/annuaire/
    maille-from-buyer.ts                    # helpers Party→Maille extraits (Task 2)
    annuaire.controller.ts                  # + GET codes-routage ; + isUuid PUT/DELETE (Tasks 3/4)
    annuaire.repository.ts                  # + listRoutingCodes ; CAS → CasStaleError (Tasks 3/5)
    annuaire-publication.service.ts         # catch CasStaleError (drop CAS_STALE_RE) (Task 5)
    annuaire-query.schema.ts                # + codesRoutageQuerySchema (Task 3)
  src/cdv/
    cdv-transmission.service.ts             # import helpers depuis annuaire/maille-from-buyer (Task 2)
    cdv-transmission.repository.ts          # CAS → CasStaleError (Task 5)
    cdv-status.service.ts                   # catch CasStaleError (drop CAS_STALE_RE) (Task 5)
    cdv.controller.ts                       # + isUuid sur 2 GET :id (Task 4)
  src/ereporting/
    ereporting.repository.ts                # CAS → CasStaleError (Task 5)
    ereporting-status.service.ts            # catch CasStaleError (drop CAS_STALE_RE) (Task 5)
    ereporting.controller.ts                # + isUuid sur 2 GET :id (Task 4)
  src/ledger/ledger.controller.ts           # + isUuid sur :id/ledger et :id/paf (Task 4)
  src/auth/
    auth.types.ts                           # apiKeyId : source de type unique (Task 6)
    api-key.guard.ts                        # TenantRequest réutilise l'augmentation (Task 6)
  src/worker/
    invoice-generation.processor.ts         # + resolveAndRecord après completeGeneration (Task 2)
    worker.module.ts                        # + RecipientRoutingService (Task 2)
  vitest.config.ts                          # test.projects heavy/light (Task 7)
  tests/
    unit/
      maille-from-buyer.test.ts             # helpers extraits (Task 2)
      recipient-routing.service.test.ts     # résolu/unaddressable/ambiguous/opérationnel (Task 2)
      cas-error.test.ts / *guards*.test.ts  # CasStaleError ; archi apiKeyId (Tasks 5/6)
      db-module.test.ts                     # teardown idempotent (Task 7)
    e2e/
      invoice-routing.e2e.test.ts           # persistance + GET expose routing (Task 1) ; worker résout (Task 2)
      annuaire-codes-routage.e2e.test.ts    # GET codes-routage dual-auth/RLS (Task 3)
      uuid-params.e2e.test.ts               # 404 byte-identique (jamais 500) (Task 4)
```

Fichiers hors code : `README.md` racine + `apps/api/README.md` (Task 8).

---

### Task 1 : Persistance du routage (migration 0026, colonnes additives) + exposition GET

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/src/db/migrations/0026_invoice_routing.sql` (drizzle) + snapshot + `_journal`
- Modify: `apps/api/src/invoices/invoices.repository.ts`, `apps/api/src/invoices/invoices.service.ts`
- Create: `apps/api/tests/e2e/invoice-routing.e2e.test.ts`

**Interfaces:**
- Consumes : `TenantContextService` (`runInTenant`), `invoices` table.
- Produces (Task 2) : colonnes `routing_status`/`recipient_platform` ; repo `markRoutingStatus(tenantId, invoiceId, status, platform?)`, `findRoutingState(tenantId, invoiceId)` ; `InvoiceSummary` + `findById` enrichis (`routingStatus`, `recipientPlatform`).

- [ ] **Step 1 : Schéma + migration** — `schema.ts` : `routingStatus = pgEnum('routing_status', ['pending','resolved','unaddressable','ambiguous'])` ; sur `invoices` : `routingStatus: routingStatus('routing_status').notNull().default('pending')`, `recipientPlatform: text('recipient_platform')`. `db:generate` → renommer `0026_invoice_routing.sql`, idx 26 (`_journal`, `version:"7"`, `when` ~+100000 après 0025). Relire : `CREATE TYPE` + `ALTER TABLE invoices ADD COLUMN` ×2, **aucune** RLS/grant (colonnes sur table déjà RLS FORCE + grant UPDATE).

- [ ] **Step 2 : Tests e2e (RED)** — `invoice-routing.e2e.test.ts` (motif ingestion.e2e, Postgres réel) :
```ts
it('une facture ingérée a routing_status="pending" et recipient_platform=null par défaut')
it('GET /invoices/:id expose routingStatus et recipientPlatform')
it('markRoutingStatus("resolved", plateforme) puis findRoutingState reflète l’écriture (RLS)')
it('isole le routage par tenant (RLS FORCE) : A invisible sous B')
```
Run → **RED** (colonnes/méthodes absentes).

- [ ] **Step 3 : Implémentation (GREEN)** — `invoices.repository.ts` : `markRoutingStatus` (miroir `markArchiveStatus` : `update(invoices).set({ routingStatus: status, recipientPlatform: platform ?? null, updatedAt: new Date() })`), `findRoutingState` (miroir `findArchiveState`) ; `findById` + `InvoiceSummary` gagnent `routingStatus`/`recipientPlatform`. `invoices.service.get` propage les deux champs (déjà `...invoice` + availableFormats).

- [ ] **Step 4 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): persistance du routage destinataire sur la facture (colonnes additives, exposition GET)"
```
Expected: PASS, module invoices ≥90 %×4, colonnes visibles en lecture.

---

### Task 2 : Couture `resolveRecipient` dans l'émission (helper extrait + RecipientRoutingService + processor)

**Files:**
- Create: `apps/api/src/annuaire/maille-from-buyer.ts`, `apps/api/src/invoices/recipient-routing.service.ts`
- Modify: `apps/api/src/cdv/cdv-transmission.service.ts` (import depuis maille-from-buyer), `apps/api/src/worker/invoice-generation.processor.ts`, `apps/api/src/worker/worker.module.ts`
- Create: `apps/api/tests/unit/maille-from-buyer.test.ts`, `apps/api/tests/unit/recipient-routing.service.test.ts`
- Modify: `apps/api/tests/e2e/invoice-routing.e2e.test.ts` (branche worker)

**Interfaces:**
- Consumes : Task 1 (`markRoutingStatus`), `AnnuaireConsultationService.resolveRecipient`, `buildMailleFromBuyer`/`isoDateToYmd`, erreurs typées (`RecipientUnaddressableError`/`AmbiguousResolutionError`/`BuyerIdentifierMissingError`).
- Produces : `RecipientRoutingService.resolveAndRecord(tenantId, invoiceId, invoice)` ; couture active dans le worker.

> **D5 (extraction)** : déplacer les helpers *Party→Maille* de `cdv-transmission.service.ts` vers `annuaire/maille-from-buyer.ts` **sans changement de comportement** (ré-export depuis cdv si des tests l'importent par ce chemin ; tests des helpers migrés). **Les tests CDV DOIVENT rester verts.** **D2 (best-effort strict)** : `resolveAndRecord` **ne relève jamais** (miroir `ArchiveService`).

- [ ] **Step 1 : Extraction (refactor comportement-préservant)** — créer `annuaire/maille-from-buyer.ts` avec `buildMailleFromBuyer`/`isoDateToYmd`/`normalizeToUndefined`/`BuyerIdentifierMissingError` (déplacés depuis cdv) ; `cdv-transmission.service.ts` les importe. Migrer les tests unitaires correspondants vers `maille-from-buyer.test.ts`. Gate intermédiaire : `pnpm --filter @factelec/api test` **vert** (CDV inchangé).

- [ ] **Step 2 : Tests RoutingService (RED)** — `recipient-routing.service.test.ts` (service mocké annuaire+repo, oracle indépendant) :
```ts
it('résout → markRoutingStatus("resolved", plateforme)')
it('RecipientUnaddressable → markRoutingStatus("unaddressable"), pas de throw')
it('Ambiguous → markRoutingStatus("ambiguous"), pas de throw')
it('BuyerIdentifierMissing → "unaddressable", pas de throw')
it('erreur opérationnelle (annuaire lève une erreur non typée) → log, PAS de markRoutingStatus resolved, PAS de throw')
it('idempotent : deux appels → même écriture déterministe')
```
Run → **RED** (service absent).

- [ ] **Step 3 : Implémentation (GREEN)** — `recipient-routing.service.ts` : `resolveAndRecord` try/catch **total** (miroir `archiveInvoice`) : `buildMailleFromBuyer(invoice.buyer)` + `isoDateToYmd(invoice.issueDate)` → `annuaire.resolveRecipient(...)` → `markRoutingStatus('resolved', plateforme)` ; catch typé (Unaddressable/Ambiguous/BuyerMissing) → `markRoutingStatus(status)` + `logger.warn` ; catch opérationnel → `logger.error`, **aucune** écriture 'resolved', **jamais** de throw. `invoice-generation.processor.ts` : `await this.routing.resolveAndRecord(tenantId, invoiceId, invoice)` **après** `this.archive.archiveInvoice(...)` (dernier pas d'émission, best-effort). `worker.module.ts` : ajouter `RecipientRoutingService` aux providers (deps déjà fournies).

- [ ] **Step 4 : e2e worker (RED→GREEN)** — dans `invoice-routing.e2e.test.ts` (helper `createTestWorker`, motif archive-generation) :
```ts
it('résout le destinataire à la génération : seed ligne annuaire → routing_status="resolved" + recipient_platform')
it('sans ligne d’annuaire couvrante → routing_status="unaddressable" (génération réussie quand même)')
it('non-régression : les formats sont générés et servis indépendamment du routage')
```

- [ ] **Step 5 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): résolution du destinataire à l'émission de facture (couture annuaire, best-effort strict)"
```
Expected: PASS ; le trou fonctionnel PDP est fermé ; CDV intact.

---

### Task 3 : Endpoints codes-routage (GET énumération des lignes publiées)

**Files:**
- Modify: `apps/api/src/annuaire/annuaire.controller.ts`, `apps/api/src/annuaire/annuaire.repository.ts`, `apps/api/src/annuaire/annuaire-query.schema.ts`
- Create: `apps/api/tests/e2e/annuaire-codes-routage.e2e.test.ts`

**Interfaces:**
- Consumes : `AnnuaireConsultationService` (ou `AnnuairePublicationService` — au plus près de `annuaire_lignes`), `TenantAuthGuard`, `parseQuery`.
- Produces : `GET /annuaire/codes-routage?siren=` → `{ codes: [...] }` ; repo `listRoutingCodes(tenantId, siren)`.

> **D6** : énumération des codes-routage **publiés par le tenant** (`annuaire_lignes`, `routageId IS NOT NULL`) — le vrai trou (aucun GET n'expose les lignes propres). **Tableau vide, pas 404** (énumération) ; non-fuite par RLS. **POST create autonome REFUSÉ** (documenté).

- [ ] **Step 1 : Tests e2e (RED)** — `annuaire-codes-routage.e2e.test.ts` :
```ts
it('liste les codes-routage publiés par le tenant pour un SIREN (routageId non-null, avec status)')
it('renvoie un tableau VIDE (pas 404) si aucun code pour ce SIREN')
it('non-fuite RLS : un SIREN d’un autre tenant renvoie un tableau vide')
it('dual-auth : clé API ET session acceptées ; sans auth → 401')
it('valide le SIREN (zod, 9 chiffres) → 422 si malformé')
```
Run → **RED** (route/méthode absentes).

- [ ] **Step 2 : Implémentation (GREEN)** — `annuaire-query.schema.ts` : `codesRoutageQuerySchema` (calque `lignesQuerySchema` : `siren` `SIREN_RE`). `annuaire.repository.ts` : `listRoutingCodes(tenantId, siren)` (select sur `annuaire_lignes` où `siren = …` ET `routageId IS NOT NULL`, projeté `{ routageId, siret, plateforme, status, dateDebut, dateFin }`, sous RLS). Service (miroir `listDirectoryEntries`) → contrôleur `@Get('codes-routage') @UseGuards(TenantAuthGuard)` renvoyant `{ codes }`. Commentaire de décision : POST autonome refusé (codes-routage créés via POST /lignes).

- [ ] **Step 3 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): endpoint dual-auth d'énumération des codes-routage publiés par le tenant"
```

---

### Task 4 : Harmonisation de la validation UUID des params `:id` (404 byte-identique, jamais 500)

**Files:**
- Create: `apps/api/src/common/uuid.ts` ; Modify: `apps/api/src/invoices/format-kind.ts` (+ ses importeurs invoices/lifecycle/api-keys)
- Modify: `apps/api/src/cdv/cdv.controller.ts`, `apps/api/src/ereporting/ereporting.controller.ts`, `apps/api/src/annuaire/annuaire.controller.ts`, `apps/api/src/ledger/ledger.controller.ts`
- Create: `apps/api/tests/e2e/uuid-params.e2e.test.ts`

**Interfaces:**
- Consumes : `isUuid` (déplacé en `common/uuid.ts`).
- Produces : garde `isUuid` au point de production du 404 sur 8 routes.

> **D7** : réutiliser la **même fabrique 404** de chaque contrôleur → **404 byte-identique** (malformé indiscernable d'inconnu/cross-tenant). `invoices`/`lifecycle`/`api-keys` inchangés (déjà conformes).

- [ ] **Step 1 : Tests e2e (RED)** — `uuid-params.e2e.test.ts` : pour **chacune** des 8 routes (cdv ×2, ereporting ×2, annuaire PUT/DELETE, ledger ×2) :
```ts
it('GET/PUT/DELETE <route> avec :id NON-UUID → 404 (pas 500), corps byte-identique au 404 “inconnu”')
```
(Comparer le corps `toEqual` entre `:id` malformé et un UUID inconnu.) Run → **RED** (aujourd'hui 500).

- [ ] **Step 2 : Implémentation (GREEN)** — déplacer `isUuid` (+ regex) vers `common/uuid.ts` ; `format-kind.ts` le ré-exporte (back-compat) OU mettre à jour les 3 importeurs. Dans chaque contrôleur cible, `if (!isUuid(id)) throw <notFound existant>` **avant** l'appel repo/service (cdv/ereporting : dans le handler avant `repo.find…` ; annuaire : avant `getLigne` ; ledger : avant `getLifecycleStatus`/`buildPaf`, 404 inline réutilisé).

- [ ] **Step 3 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "fix(api): validation UUID harmonisée des params :id (404 anti-fuite byte-identique, plus de 500)"
```

---

### Task 5 : Erreurs CAS typées (`CasStaleError` remplace les 3 `CAS_STALE_RE`)

**Files:**
- Create: `apps/api/src/common/cas-error.ts`
- Modify (repos, 7 sites CAS) : `apps/api/src/cdv/cdv-transmission.repository.ts`, `apps/api/src/annuaire/annuaire.repository.ts`, `apps/api/src/ereporting/ereporting.repository.ts`
- Modify (services, catch) : `apps/api/src/cdv/cdv-status.service.ts`, `apps/api/src/annuaire/annuaire-publication.service.ts`, `apps/api/src/ereporting/ereporting-status.service.ts`
- Modify/Create tests unitaires correspondants (`cas-error.test.ts` + tests services existants)

**Interfaces:**
- Consumes : —
- Produces : `CasStaleError` (`extends Error`, `readonly { entity, id, expectedStatus }`, `name`).

> **D8** : les repos lèvent `CasStaleError` (au lieu de `throw new Error("... is not in '...' status ...")`) ; les services catchent `instanceof CasStaleError` (suppression des 3 regex). **Sortie HTTP inchangée** (409 / `'skipped'`), conflation stale/inconnu/cross-tenant préservée. Message conservé dans le `super(...)` (logs).

- [ ] **Step 1 : Tests (RED)** — asserter que chaque site CAS lève désormais `CasStaleError` (repo) et que chaque service produit **exactement** la même réponse HTTP qu'avant en catchant le type (unit ; conserver un test e2e témoin par domaine : 409 sur transition périmée). Run → **RED** (type absent, services encore sur regex).

- [ ] **Step 2 : Implémentation (GREEN)** — `common/cas-error.ts` (`CasStaleError`). Remplacer les 7 `throw new Error(...is not in...status...)` par `throw new CasStaleError({ entity, id, expectedStatus })` (message identique en `super`). Dans les 3 services : `if (err instanceof CasStaleError) …` (409 / `return 'skipped'`), **supprimer** `CAS_STALE_RE`.

- [ ] **Step 3 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "refactor(api): erreur CAS typée (CasStaleError) en remplacement des CAS_STALE_RE textuels divergents"
```

---

### Task 6 : Clôture du footgun `apiKeyId` (test d'architecture + unification de type)

**Files:**
- Modify: `apps/api/src/auth/auth.types.ts` (source de type unique `apiKeyId`), `apps/api/src/auth/api-key.guard.ts` (réutilise l'augmentation)
- Create: `apps/api/tests/unit/apikeyid-setters.arch.test.ts`

**Interfaces:**
- Consumes : sources des guards.
- Produces : invariant testé (poseurs/lecteurs d'`apiKeyId` figés) + type unifié.

> **D9** : test d'archi **recommandé** (vs garde composé, différé). Zéro changement de comportement.

- [ ] **Step 1 : Test d'architecture (RED d'abord si l'unification n'est pas faite ; sinon vert-témoin)** — `apikeyid-setters.arch.test.ts` (lecture des sources) :
```ts
it('SEULS api-key.guard.ts et tenant-auth.guard.ts écrivent req.apiKeyId')  // grep `apiKeyId =`
it('SEULS roles.guard.ts et csrf.guard.ts lisent req.apiKeyId pour bypass') // grep `if (req.apiKeyId)`
```
(Le test échoue si un futur fichier pose/lit `apiKeyId` hors liste blanche.)

- [ ] **Step 2 : Unification du type (GREEN)** — déclarer `apiKeyId?: string` en **une** source (ex. augmentation partagée dans `auth.types.ts`) réutilisée par `SessionRequest` et `TenantRequest` (supprimer la duplication). Aucun changement de comportement runtime. Commentaire figeant le contrat (bypass = clé API seulement, posé après vérif crypto).

- [ ] **Step 3 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "test(api): verrou d'architecture sur les poseurs/lecteurs d'apiKeyId + unification du type (clôture footgun 3.2)"
```

---

### Task 7 : Stabilisation e2e (teardown idempotent + split Vitest heavy/light)

**Files:**
- Modify: `apps/api/src/db/db.module.ts`, `apps/api/src/db/client.ts`, `apps/api/vitest.config.ts`
- Create: `apps/api/tests/unit/db-module.test.ts`

**Interfaces:**
- Consumes : `APP_POOL`, Vitest 4 `test.projects`.
- Produces : teardown idempotent + écouteur `error` ; projets `heavy`/`light`.

> **D10/D11** : garde d'idempotence + écouteur `error` ; split *heavy* (8 suites BullMQ+Redis, `fileParallelism:false`) / *light* (reste, `maxWorkers:5`). Hermétisme intact, seuils fusionnés, **sans retry**.

- [ ] **Step 1 : Teardown (RED→GREEN)** — `db-module.test.ts` : `onModuleDestroy` appelé deux fois → `pool.end` invoqué **une** fois. Implémenter la garde `ended` dans `DbModule.onModuleDestroy` ; `createPool` (client.ts) ajoute `pool.on('error', (e) => logger/console noise)` (avale `57P01` teardown, jamais throw).

- [ ] **Step 2 : Split Vitest** — `vitest.config.ts` : `test.projects` = `heavy` (glob des 8 suites : ereporting-generation/ereporting-payments/annuaire-sync/cdv-transmission-sweep/async-generation/archive-generation/ereporting-sweep/session-purge + **invoice-routing** de Task 2, `fileParallelism:false`) et `light` (glob du reste, `maxWorkers:5`). Coverage + seuils **définis une fois** à la racine, fusionnés. Vérifier que `pnpm --filter @factelec/api test` exécute les deux projets et agrège la couverture. **Amendement m6 (BINDING)** : en `test.projects`, `setupFiles`/`hookTimeout`/`testTimeout` ne **cascadent PAS** depuis la racine — les REDÉCLARER dans CHAQUE projet (sinon perte silencieuse de `tests/setup.ts` = rupture d'hermétisme ; le vérifier par un test qui échouerait sans setup).

- [ ] **Step 3 : Vérification empirique** — exécuter la suite api **isolée** plusieurs fois (≥3 batteries) pour confirmer l'absence de flake HTTP/contention ; documenter le résultat. **Ne pas** ajouter de retry. **Amendement m7 (BINDING)** : les flakes observés en 3.2 (health-Redis, paf-export, annuaire-consultation, invoices-repository) sont surtout des suites **LIGHT** qui resteront parallèles — les 3 batteries doivent SURVEILLER NOMMÉMENT ces 4 fichiers ; si l'un d'eux re-flake, abaisser `maxWorkers` du projet light (fallback BINDING, documenté) plutôt que conclure « vert ».

- [ ] **Step 4 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test && pnpm run audit:ci && pnpm outdated -r
git add -A
git commit -m "test(api): teardown de pool idempotent et sérialisation des suites e2e lourdes (stabilisation de la contention testcontainers)"
```

---

### Task 8 : Docs / OpenAPI / README / bump `0.9.0` — clôture

**Files:**
- Modify: `README.md` racine, `apps/api/README.md`
- Modify: OpenAPI/Swagger si présent (endpoints `annuaire/codes-routage`, champs routing de `GET /invoices/:id`)
- Modify: `apps/api/package.json` (`version` → `0.9.0`) ; vérifier `packages/invoice-core` = `0.4.0` **non touché**

- [ ] **Step 1 : Documentation honnête** — décrire :
  - **Couture émission** (D1/D2/D4) : résolution du destinataire au worker de génération, **best-effort strict** (jamais d'échec du job) ; **métadonnée de routage mutable** (`routing_status`/`recipient_platform`), **PAS de mutation du cycle de vie CDV scellé** ; `emise`/transport = 3.4+ (items Xavier). Différé de reprise (sweep routage) noté.
  - **Codes-routage** (D6) : GET énumération des lignes publiées ; POST autonome **refusé** (justifié).
  - **Durcissements** (D7/D8/D9/D10) : UUID params (404 byte-identique) ; `CasStaleError` ; verrou d'archi apiKeyId (+ garde composé différé) ; teardown idempotent.
  - **Stabilisation e2e** (D11) : split heavy/light, hermétisme intact.
  - **Différés 3.4+** : chemin RE (ré-extraction réglementaire), e-signature consentement, worker-role split, sweep routage, garde composé, POST codes-routage, transition `emise`/transport.

- [ ] **Step 2 : Bump + gate finale + commit**
```bash
# apps/api/package.json : "version": "0.9.0" (phase 3.3 : couture annuaire + durcissements)
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm test && pnpm run audit:ci && pnpm outdated -r
git add -A
git commit -m "docs: couture annuaire à l'émission et durcissements transverses, bump version 0.9.0"
```
Expected: tout vert ; **invoice-core 100 %×4 non touché**, apps/api ≥ 90 %×4, apps/web ≥ 90 %×4 ; audit:ci 0 ; outdated vierge.

---

## Self-Review (contre research 3.3 / le cadrage contrôleur)

**1. Couverture du cadrage :**
- Câblage `resolveRecipient` à l'émission, **point de couture tranché** (worker de génération) avec rationale ferme (non-régression/erreurs/idempotence) → Tasks 1/2 (D1-D5). ✅
- Endpoints codes-routage (dual-auth, 404-anti-fuite/zod, motifs 2.4/3.2) → Task 3 (D6). ✅
- Durcissement UUID (:id → 404 byte-identique, jamais 500 ; `isUuid` de format-kind) → Task 4 (D7). ✅
- Footgun apiKeyId **tranché** (test d'archi recommandé + justifié vs garde composé) → Task 6 (D9). ✅
- Erreurs CAS typées (CAS_STALE_RE généralisé) → Task 5 (D8). ✅
- Teardown « Called end on pool more than once » (garde idempotente) → Task 7 (D10). ✅
- Stabilisation e2e (mesure minimale : split projets, sans refonte ni perte d'hermétisme) → Task 7 (D11). ✅
- **HORS PÉRIMÈTRE respecté** : chemin RE / e-signature / worker-role split → **Différés** documentés. ✅
- **Contraintes** : TDD RED-first ; invoice-core **non touché** (couture 100 % apps/api) ; aucune dépendance ajoutée (audit/outdated mécaniquement verts) ; **aucune nouvelle table** (migration 0026 = colonnes additives, aucune RLS/grant/SD) ; dual-auth + 404 byte-identique ; oracles indépendants ; commits FR sans trailer ; docs/reglementaire & docs/reference intacts ; tâches homogènes exécutables par subagents Sonnet + revue Opus ; dernière tâche = docs/bump 0.9.0. ✅

**2. Non-régression & non-fabrication :** couture best-effort STRICT (jamais throw, calquée `ArchiveService`) → génération inchangée ; **aucune mutation du journal scellé** (résolution ≠ émission) ; codes-routage sur données réelles (aucun POST fabriqué) ; CAS/UUID/apiKeyId = mêmes sorties HTTP, seul le mécanisme change.

**3. Interprétations marquées go-live :** frontière `routing_status` vs cycle de vie CDV (émission réelle = transport, 3.4+) ; heuristique de maille depuis l'acheteur (limitation SIREN/SIREN_SIRET, héritée cdv/2.4) ; sweep de reprise routage différé.

**4. Cohérence types & migrations :** `routing_status`/`recipient_platform` partagés Tasks 1-2 ; helper *Party→Maille* partagé cdv/émission (Task 2) ; `CasStaleError`/`isUuid`/type `apiKeyId` centralisés (`common/`, `auth.types`) ; **migration 0026 contiguë** après 0025 ; aucune nouvelle SD ; aucun enum de flux/transmission touché.

## Recommandations fermes de périmètre (le contrôleur ratifie — aucune question ouverte)

- **R1 — Point de couture = worker de génération** (best-effort strict, après `completeGeneration`), PAS l'ingestion synchrone. Retenu (D1/D2).
- **R2 — Résolution = métadonnée de routage mutable** (colonnes 0026), **sans muter le cycle de vie CDV scellé** ; `emise`/transport différés. Retenu (D2/D3/D4).
- **R3 — Helper *Party→Maille* extrait** vers `annuaire/` (DRY + séparation de domaine émission↛cdv). Retenu (D5).
- **R4 — Codes-routage = GET énumération** des lignes publiées ; **POST autonome refusé** (aucune fabrication, aucune nouvelle table). Retenu (D6).
- **R5 — UUID params : `isUuid` au point de 404, byte-identique, jamais 500.** Retenu (D7).
- **R6 — CAS typé (`CasStaleError`)** remplace les 3 `CAS_STALE_RE` divergents, sortie HTTP inchangée. Retenu (D8).
- **R7 — Footgun apiKeyId : test d'architecture (poseurs asservis) + unification de type ; garde composé différé.** Retenu (D9).
- **R8 — Teardown idempotent + écouteur `error` ; split Vitest heavy/light sans retry.** Retenu (D10/D11).
- **R9 — Bump `apps/api` 0.9.0 ; `invoice-core` reste 0.4.0 (non touché).** Retenu.

## Execution Handoff

Plan complet, sauvegardé dans `docs/superpowers/plans/2026-07-17-phase3-3-couture-annuaire-durcissements.md`. Branche : `feat/phase3-3-couture-annuaire-durcissements`. Deux options :
1. **Subagent-Driven (recommandé)** — un subagent frais par tâche, revue Opus entre chaque (aligné 1.x/2.x/3.x).
2. **Inline** — exécution par lots avec points de contrôle.
