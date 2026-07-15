# Plan 2.2 — Scellement & archivage à valeur probante du journal de statuts

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transformer le journal `invoice_status_events` livré en 2.1 (append-only, immuable par grants) en un **journal à valeur probante scellé** (spec §4.5) : chaînage cryptographique **SHA-256 par tenant** (numéro de séquence + `prev_hash` + `hash`, calculé et imposé **par la base** via un trigger `SECURITY DEFINER`, non contournable par l'application), **retrait de la FK `ON DELETE CASCADE`** (un journal probatoire ne se supprime pas avec sa facture — dette 2.1), **vérification d'intégrité** de la chaîne (recompute Node indépendant, détection d'altération), **export de la Piste d'Audit Fiable (PAF)** par tenant/facture, et **abstraction d'archivage WORM** (port `ArchiveStore` + implémentation locale write-once testable ; l'adaptateur S3 object-lock Scaleway est activé au déploiement, hors périmètre testable). Plus la **dette opérationnelle 2.1** soldée : **cap de réconciliation / DLQ** pour les factures « poison » (crash récurrent avant écriture `failed` → ré-enfilement indéfini). L'**e-reporting** (Flux 10), l'**annuaire** (Flux 13/14) et le **remplacement de la matrice de transitions CDV** (bloqueur phase 3, norme AFNOR XP Z12-012 hors dépôt) sont **explicitement reportés** (voir Périmètre).

**Architecture:** On **réutilise intégralement** le socle 1.3/2.1 (RLS Postgres `FORCE`, `runInTenant` + `SET LOCAL app.tenant_id`, rôle `factelec_app` sans `BYPASSRLS`/superuser, fonctions `SECURITY DEFINER` à `search_path` épinglé, filtre `problem+json`, guards session/clé API, workers BullMQ). Le scellement est **imposé côté base** : un trigger `BEFORE INSERT` (`SECURITY DEFINER`, propriété du rôle propriétaire, `search_path` figé) calcule pour chaque événement, sous **verrou consultatif par tenant** (`pg_advisory_xact_lock`), un `seq` monotone, le `prev_hash` (tête de chaîne du tenant, genesis dérivé du `tenant_id` pour le premier), et le `hash = SHA-256(prev_hash ‖ payload canonique)` via **`pgcrypto.digest`** — l'application n'a **que** `SELECT`/`INSERT` et **ne peut ni fournir ni modifier** ces colonnes (le trigger les écrase). Un module **TypeScript pur** re-canonicalise et recalcule la chaîne à l'identique (vecteurs de test déterministes), permettant une **vérification d'intégrité indépendante** (service `LedgerVerificationService` lisant sous RLS) qui détecte l'altération/suppression/insertion **partielle** d'événements faite hors application (accès propriétaire) — **pas** la troncature de la queue de chaîne ni une réécriture complète cohérente (genesis public, recalculable) ; ces deux modes, intrinsèques à tout hash-chain auto-contenu (≠ MAC), ne sont détectables que par l'**ancrage de tête** dans l'archive WORM externe (adaptateur S3 object-lock, activé au déploiement, D5). L'**archivage** passe par un **port** `ArchiveStore` (contrat `put`/`head`/`get`, sémantique **write-once**) : l'implémentation `LocalFilesystemArchiveStore` (write-once réel, permissions lecture seule, empreinte SHA-256) est **entièrement testable** ; l'adaptateur `S3ObjectLockArchiveStore` (object-lock COMPLIANCE Scaleway) est **spécifié** mais **activé au déploiement** (infra à la main de Xavier, non testable sans S3 réel — instruit honnêtement). Le **bundle d'archive** (facture canonique + 5 formats du socle + extrait scellé du journal + manifeste des empreintes) est assemblé après génération et déposé via le port. La **PAF** est un export structuré (JSON + CSV) reconstituant la chaîne d'événements, ses empreintes et l'état d'archivage.

**Tech Stack:** **Aucune nouvelle dépendance npm runtime.** Hash & empreintes : **`node:crypto`** natif (SHA-256) côté application et **extension `pgcrypto`** (`digest(..., 'sha256')`) côté base — pgcrypto est une extension contrib standard (créée par le rôle propriétaire dans une migration ; disponible sur PostgreSQL managé Scaleway, à confirmer au déploiement). Archivage local : **`node:fs`**/`node:path` natifs. Canonicalisation : **TypeScript pur** (encodage longueur-préfixée injection-proof, miroir exact du PL/pgSQL). DLQ/poison : **BullMQ 5.80.2** déjà présent. Aucun ajout à `apps/web`. `docker-compose` : Postgres 17-alpine (déjà là) fournit pgcrypto ; **rien à ajouter** au compose (l'archivage local écrit dans un répertoire monté/temporaire).

## Global Constraints

Reprises **verbatim** du socle 1.3/2.1 (non négociables) — chaque tâche en hérite implicitement :

- **TDD strict RED/GREEN** : test écrit et vu échouer avant toute implémentation ; aucun merge si un test échoue (spec §7). Un commit minimum par tâche, message en **français**, **sans** trailer `Co-Authored-By: Claude` ni mention Claude ; commits au seul nom de l'utilisateur. `pnpm format` avant chaque commit.
- **Couverture bloquante** : **≥ 90 %** (lines/functions/statements/branches) maintenue sur `apps/api` ; `packages/invoice-core` reste à **100 %** (ne pas y toucher). `apps/web` : seuil 90×4 maintenu (aucune modif web dans ce plan). Exclusions de couverture existantes conservées (`src/main.ts`, `src/worker-main.ts`, `**/*.module.ts`, `src/db/migrations/**`). **Tout code de scellement/hash est couvert par des vecteurs de test déterministes** (pas de valeur « magique » non recalculée par un test). L'adaptateur S3 (non testable sans infra) n'est **pas** écrit dans ce plan : seul son contrat est spécifié (aucune ligne à exclure de la couverture — voir D5).
- **e2e sur Postgres réel ET Redis réel (Testcontainers)** pour tout endpoint et tout flux worker ; **tests d'isolation multi-tenant explicites** (chaîne/événement/bundle d'un tenant jamais visible d'un autre). **Motifs de stabilité e2e OBLIGATOIRES** (acquis post-1.4 / 2.1) : `listenOnce` (serveur de test démarré **une seule fois** par fichier), `maxWorkers: 5`, `withStartupTimeout(120_000)`, `hookTimeout: 150_000`. Le scellement se prouve **au niveau base** (insertion sous rôle `factelec_app` réel → chaîne calculée par le trigger, tentative d'altération → `42501` ou mismatch de recompute).
- **Sécurité OWASP** : validation de toute entrée (zod), authz systématique. **Le scellement ne doit ouvrir aucun contournement de l'immuabilité** : le trigger est `SECURITY DEFINER` à `search_path` **épinglé** (`SET search_path = public`, convention projet — `factelec_app` n'a pas `CREATE` sur `public`, aucun shadowing possible), propriété du rôle propriétaire ; `factelec_app` conserve **`SELECT` + `INSERT` seulement** (jamais `UPDATE`/`DELETE`) et **ne possède pas** les colonnes de scellement (le trigger les impose). Aucune donnée sensible hors des frontières prévues : le **bundle d'archive** reste sous la frontière tenant (RLS) ; l'archive locale de test écrit dans un répertoire éphémère. Erreurs normalisées **RFC 9457 `application/problem+json`**.
- **Moindre privilège Postgres inchangé** : rôle `factelec_app` ≠ propriétaire, **sans `BYPASSRLS`, sans superuser** ; RLS **`ENABLE` + `FORCE`** sur toute table tenant (y compris colonnes/objets ajoutés) ; propagation du tenant par `SET LOCAL` via `runInTenant`. Le process API/worker ne connaît **que** `DATABASE_URL` (rôle app) — **jamais** `DATABASE_OWNER_URL`. `CREATE EXTENSION pgcrypto` et la création du trigger `SECURITY DEFINER` se font en **migration** (exécutée sous le rôle **propriétaire** par `db:migrate`), jamais depuis le process applicatif.
- **TypeScript `strict: true`, ESM (`"type": "module"`), NodeNext, Node ≥ 22.** `typescript` pinné **exactement `7.0.2`** (racine, tsgo). Repli local `typescript@5.9.x` **du seul workspace concerné** autorisé et documenté si un typecheck bute — sans toucher le pin racine.
- **Dépendances pinnées exactement** (pas de `^`/`~`), **dernière stable** vérifiée au registre, avec licence. **`pnpm run audit:ci` 0 vulnérabilité** (script maison `scripts/audit.mjs` sur l'endpoint bulk npm — l'ancien `pnpm audit` est retiré 410) et **`pnpm outdated -r` vierge** restent **bloquants** en CI. **Ce plan n'ajoute aucune dépendance** (crypto natif + pgcrypto) : l'objectif « outdated vierge / audit 0 » est mécaniquement tenu.
- **`@factelec/invoice-core` consommé via son exports map**, jamais par chemin relatif inter-packages. `docs/reference/` et `docs/reglementaire/` en **lecture seule** (tout ajout vendorisé porte sa provenance).
- Identifiants de code en **anglais** ; commentaires/commits/docs en **français**.

---

## Périmètre : retenu en 2.2 vs reporté en 2.3+

**Retenu (ce plan) — cœur « archivage à valeur probante » de la phase 2 (spec §4.5) :**
1. **Retrait de la FK cascade** : `invoice_status_events.invoice_id` passe de `ON DELETE CASCADE` à `ON DELETE RESTRICT` (un journal probatoire ne se supprime pas avec sa facture ; supprimer une facture munie d'un journal est **interdit** par la base). Dette 2.1 soldée.
2. **Scellement chaîné DB** : `pgcrypto` + colonnes `seq`/`prev_hash`/`hash` + trigger `BEFORE INSERT` `SECURITY DEFINER` calculant la chaîne SHA-256 par tenant sous verrou consultatif — immuabilité et scellement **imposés par la base**.
3. **Canonicalisation + hash TypeScript pur** (vecteurs déterministes) : miroir exact du PL/pgSQL, socle de la vérification indépendante.
4. **Vérification d'intégrité** : `LedgerVerificationService` (recompute la chaîne sous RLS, détecte séquence rompue / `prev_hash` incohérent / `hash` altéré) + endpoint `GET /invoices/:id/ledger`.
5. **Port d'archivage** `ArchiveStore` + **implémentation locale write-once** (WORM simulé, testable) ; contrat de l'adaptateur S3 object-lock **spécifié** (activé au déploiement).
6. **Bundle d'archive** (canonique + 5 formats + extrait scellé du journal + manifeste d'empreintes) assemblé après génération, déposé via le port ; statut d'archivage persisté.
7. **Export PAF** (Piste d'Audit Fiable) : endpoint `GET /invoices/:id/paf` (JSON + CSV) reconstituant chaîne d'événements, empreintes et état d'archivage.
8. **DLQ / cap de réconciliation** (dette opérationnelle 2.1) : borne le ré-enfilement des factures poison, garantit le passage `failed` même sur crash récurrent, trace en dead-letter.
9. **CI / docs / versions** : e2e Postgres+Redis en CI (inchangé sur le principe), README/OpenAPI mis à jour, provenance des sources §4.5, bump version.

**Reporté (2.3+), acté ici (justifié en D8) :**
- **E-reporting (Flux 10)** : sous-système complet (agrégation transactions B2C/internationales + données de paiement selon **Annexe 6 e-reporting v1.10**, format sémantique, validation, émission au concentrateur DGFiP). Large, indépendant, transport DGFiP différé (pas d'accès PDP en pré-immatriculation) → **plan 2.3** (génération + validation du flux, transport en port abstrait, comme le TransmissionProvider Peppol).
- **Annuaire (Flux 13/14)** : consultation SIREN→PA/routage (swagger `ppf-openapi-annuaire-api-public-1.11.0`, **Annexe 3**), client HTTP + cache, gestion des inscriptions PA de réception → **plan 2.4** (ou 2.3 si couplé au routage e-invoicing).
- **Remplacement de la matrice de transitions CDV** (BLOQUEUR phase 3) : exige la norme **AFNOR XP Z12-012** (payante, **hors dépôt**, non vendorisable). La matrice monotone 2.1 reste une **interprétation projet documentée** ; le remplacement reste **reporté à la phase 3** (sans impact tant que l'apposition machine/externe des statuts n'est pas activée). Voir D7.
- **Adaptateur S3 object-lock réel** (Scaleway Object Storage, COMPLIANCE mode, rétention 10 ans) : infra à la main de Xavier, non testable sans S3 réel ; **conçu** ici (contrat du port + skeleton documenté), **activé au déploiement** (voir D5).
- **Journal d'audit à valeur probante des authentifications** (horizon « 2.x ») : distinct du cycle de vie facture ; le socle de scellement de ce plan (chaînage SHA-256 réutilisable) lui servira quand il sera priorisé.

---

## Décisions structurantes (à lire avant d'exécuter)

### D1 — Scellement IMPOSÉ PAR LA BASE (trigger `SECURITY DEFINER`), pas par l'application

- La valeur probante exige que le scellement **ne soit pas contournable par la couche applicative** (audit d'immatriculation). Cohérent avec le socle (RLS `FORCE`, immuabilité par grants, SD à `search_path` épinglé, `42501` prouvé), on calcule la chaîne **dans un trigger `BEFORE INSERT`** `SECURITY DEFINER` (propriété du rôle **propriétaire**). **DÉCISION CONTRÔLEUR (amendement de revue) — défense en profondeur sur le `search_path`** : les fonctions SD de ce plan (`ledger_field`, `seal_status_event`, `find_failed_archives`) épinglent **`SET search_path = pg_catalog, pg_temp`** (et NON `public`) et **schéma-qualifient explicitement** `public.digest(...)` et `public.ledger_field(...)` ; les autres primitives (`octet_length`, `convert_to`, `date_trunc`, `extract`, `pg_advisory_xact_lock`, `hashtextextended`) sont dans `pg_catalog`. Motif : le propriétaire est `BYPASSRLS`, donc un éventuel shadowing serait une escalade — même si `factelec_app` n'a que `USAGE` sans `CREATE` sur `public` (aucun shadowing possible aujourd'hui), on ne dépend pas de cette propriété. Le trigger **écrase** tout `seq`/`prev_hash`/`hash` fourni par le client : `factelec_app` (grants `SELECT`+`INSERT` **seulement**, pas d'`UPDATE`/`DELETE`) ne peut **ni forger ni modifier** la chaîne. L'insertion applicative ne renseigne que les colonnes métier (`tenant_id, invoice_id, from_status, to_status, actor, reason`) — déjà le cas en 2.1.
- **Alternative écartée — hash calculé côté Node puis inséré** : place la canonicalisation en TS (unit-testable) mais rend le hash **fourni par l'application** (donc forgeable par la couche app) et impose une **sérialisation applicative des inserts** (verrou par tenant côté app) sujette aux races. Le trigger DB donne la sérialisation gratuitement (`pg_advisory_xact_lock(tenant)`) et une garantie **non contournable**. On **conserve néanmoins** un recompute TS **indépendant** (D3) pour la vérification — le meilleur des deux.

### D2 — Chaînage PAR TENANT, `seq` monotone, genesis dérivé du tenant, sérialisation par verrou consultatif

- **Une chaîne par tenant** (et non par facture) : la suppression/altération d'un événement **intermédiaire** (ni le premier ni le dernier) casse la chaîne à partir de ce point, détecté par `verifyTenantChain` — **tamper-evidence, pas inviolabilité** : la troncature du **dernier** maillon (les événements 1..n-1 restent une chaîne valide) et une réécriture complète cohérente de toute la chaîne (genesis dérivé du tenant, donc public et recalculable) échappent structurellement à ce mécanisme (hash-chain ≠ MAC) — seul l'**ancrage de tête** en archive WORM externe (D5) les couvre. `seq` est un entier **monotone par tenant** (1, 2, 3…). Le `prev_hash` de l'événement `seq=1` d'un tenant = **genesis dérivé** : `SHA-256('factelec:ledger:genesis:v1:' || tenant_id)` — lie la chaîne à l'identité du tenant (deux tenants n'ont pas la même origine).
- **Sérialisation** : dans le trigger, `pg_advisory_xact_lock(hashtextextended(tenant_id::text, 0))` sérialise les insertions **d'un même tenant** (évite le fork de chaîne sous insertions concurrentes) sans bloquer les autres tenants (clés de verrou distinctes). Le verrou est **transactionnel** (libéré au COMMIT/ROLLBACK).
- **Colonnes ajoutées** : `seq bigint NOT NULL`, `prev_hash bytea NOT NULL`, `hash bytea NOT NULL`, plus contraintes `UNIQUE(tenant_id, seq)` et `UNIQUE(tenant_id, hash)`. Elles sont **remplies par le trigger** ; côté Drizzle elles sont déclarées `NOT NULL` mais **jamais fournies par le repository** (le trigger précède l'insertion effective).

### D3 — Recompute TypeScript INDÉPENDANT + canonicalisation injection-proof + vecteurs déterministes

- Un module **pur** (`src/ledger/ledger-hash.ts`, aucun I/O) re-canonicalise un événement et recalcule `hash = SHA-256(prev_hash ‖ canonical)` **à l'octet près** comme le PL/pgSQL. Il alimente `LedgerVerificationService` (recompute la chaîne lue sous RLS et compare aux `hash` stockés → détecte l'altération/suppression/insertion **partielle** d'événements faite **hors application**, p. ex. via accès propriétaire — **ni** la troncature de queue **ni** une réécriture complète cohérente, cf. D2 et le README).
- **Canonicalisation longueur-préfixée (injection-proof)** : `canonical = Σ champ` où chaque champ est encodé `«-1|»` si NULL, sinon `octet_length(valeur)::text ‖ '|' ‖ valeur` (UTF-8). Le préfixe de longueur rend l'encodage **non ambigu** même si `reason` (texte libre) contient `|`, des chiffres ou des sauts de ligne. Ordre **figé** : `tenant_id, invoice_id, seq, from_status, to_status, actor, reason, created_at_ms`. `octet_length` (PG) = `Buffer.byteLength(v,'utf8')` (Node) → identiques en UTF-8.
- **Horodatage déterministe** : `created_at` est **tronqué à la milliseconde** (le trigger stocke `date_trunc('milliseconds', created_at)`), canonicalisé en **epoch-millisecondes** (`(extract(epoch from created_at)*1000)::bigint` ↔ `date.getTime()`). Postgres a une précision microseconde que `Date` JS ne représente pas ; la troncature ms garantit l'égalité PG↔Node. En production `created_at` = `now()` (horloge serveur) ; en test on fixe une valeur ms connue pour des **vecteurs de hash reproductibles**.
- **Vecteurs de test** : un vecteur **constant** (genesis + un événement entièrement spécifié → SHA-256 attendu hardcodé) verrouille la canonicalisation contre toute dérive ; un test **croisé** prouve `hash` stocké par le trigger == recompute TS pour le même événement (double preuve DB↔Node).

### D4 — Retrait de la FK `ON DELETE CASCADE` → `ON DELETE RESTRICT`

- Dette 2.1 : `invoice_status_events.invoice_id` était `ON DELETE CASCADE` — supprimer une facture effaçait son journal probatoire. On passe la FK à **`ON DELETE RESTRICT`** : une facture munie d'événements **ne peut plus être supprimée** (la base refuse — `23503`). C'est le comportement correct pour un journal à valeur probante (conservation 10 ans, spec §4.5). La FK `tenant_id → tenants` reste `ON DELETE CASCADE` inchangée (la suppression d'un tenant relève d'une procédure RGPD dédiée, hors périmètre ; notée en reprise). Migration : `DROP CONSTRAINT` de l'ancienne FK + `ADD CONSTRAINT ... ON DELETE RESTRICT`.

### D5 — Port d'archivage : contrat + implémentation LOCALE testable ; adaptateur S3 object-lock activé au déploiement (honnêteté)

- **Ce qui est testable sans S3** : le **port** `ArchiveStore` (interface abstraite) et l'implémentation **`LocalFilesystemArchiveStore`** — sémantique **write-once** (refus d'écrasement d'une clé existante → simule l'object-lock), permissions **lecture seule** (`chmod 0o444`) après écriture, empreinte SHA-256 vérifiée en lecture. Entièrement couverte par des tests d'intégration (répertoire temporaire). Le **bundle d'archive** (assemblage + manifeste) et le **service d'archivage** (dépôt via le port) sont testés contre l'implémentation locale.
- **Ce qui N'est PAS testable sans infra réelle** (instruit honnêtement) : l'adaptateur **`S3ObjectLockArchiveStore`** (Scaleway Object Storage, `ObjectLockConfiguration` mode **COMPLIANCE**, `RetainUntilDate` = +10 ans) exige un bucket S3 object-lock réel (à la main de Xavier). **Il n'est PAS écrit dans ce plan** — on **spécifie son contrat** (mêmes signatures que le port ; mapping des opérations vers `PutObject`/`HeadObject`/`GetObject` avec `x-amz-object-lock-*`) et on documente son activation par variable d'env (`ARCHIVE_DRIVER=s3` au déploiement, défaut `local`). Aucune ligne d'adaptateur S3 non testée n'entre dans le périmètre → couverture honnête (rien à exclure). L'implémentation S3 réelle est un **item de déploiement** (infra Terraform + secrets Scaleway), tracé en reprise.
- **Sélection par env** : `ARCHIVE_DRIVER` (`local` | `s3`, défaut `local`) + `ARCHIVE_LOCAL_DIR` (répertoire local). En 2.2 seul `local` est câblé ; `s3` lèvera une erreur explicite « adaptateur activé au déploiement » tant qu'il n'est pas fourni. Le module de sélection est un `provider` NestJS (factory) — sa branche `s3` est un `throw` documenté et **testé** (une ligne, couverte).

### D6 — Déclenchement de l'archivage : après génération réussie, dans le worker (idempotent)

- L'archivage d'une facture n'a de sens qu'une fois les **5 formats générés** (`status = 'generated'`). On **étend le processor de génération** (worker 2.1) : après la transaction `completeGeneration` (delete+insert des formats + `status='generated'`), le processor assemble le **bundle** (canonique + 5 formats rechargés + extrait scellé du journal à cet instant + manifeste) et le dépose via `ArchiveStore.put(key)`. **Idempotence** : la clé d'archive est déterministe (`{tenantId}/{invoiceId}/{contentHash}.bundle` ou `.../v1.bundle`) et le port est **write-once** (un rejeu de job retombe sur une clé existante → `head` détecte, on **n'écrase pas**, on marque `archived` sans réécrire). Un statut d'archivage est persisté sur `invoices` (`archive_status`: `pending | archived | failed`, + `archive_location`, `archive_hash`). Un **échec d'archivage n'échoue PAS la génération** (les formats restent disponibles) : `archive_status='failed'`, ré-essayé par un job de réconciliation (réutilise le balayage maintenance 2.1). Décision : **découpler** génération (déjà `generated`) et archivage (best-effort ré-essayé) pour ne pas régresser la disponibilité des formats.

### D7 — Matrice de transitions CDV : NON remplacée ici (reste interprétation projet), bloqueur phase 3

- Le remplacement de la matrice monotone 2.1 (elle rejette 207→205, 208→204, 206→205 et autorise 212→213 anormal) exige la norme **AFNOR XP Z12-012** (payante, absente du dépôt, non vendorisable). Sans elle, coder une nouvelle matrice serait **réinventer** une règle DGFiP non écrite — proscrit (règle projet « jamais de valeur de mémoire »). **Décision : reporter à la phase 3** (go-live PDP), où l'apposition machine/externe des statuts est activée et où l'obtention de la norme est un prérequis. La matrice actuelle reste **explicitement estampillée « interprétation projet »** (déjà le cas dans `lifecycle-status.ts`). Sans impact fonctionnel en 2.2 (les transitions restent pilotées par la session marchand, la chronologie monotone est un sur-ensemble sûr des flux réels de test).

### D8 — E-reporting & annuaire reportés : justification de découpage

- **Charge** : le cœur archivage (scellement DB + recompute + vérification + port + bundle + PAF + DLQ) remplit déjà 9 tâches. L'e-reporting (agrégation multi-régimes + format sémantique Annexe 6 + validation Flux 10 + transport concentrateur) est un **sous-système complet** justifiant son propre plan (≥ 7-10 tâches), tout comme l'annuaire (client HTTP + cache + inscriptions).
- **Dépendances / valeur** : l'archivage probatoire **prolonge directement** le journal 2.1 (substrat déjà livré) et **solde des dettes 2.1 tracées** (FK cascade, scellement/WORM, DLQ). Il est **entièrement testable hors infra externe** (crypto natif + archive locale). L'e-reporting comme l'annuaire ont un **transport externe différé** (pré-immatriculation) : les livrer maintenant laisserait leur maillon final non exerçable. On **priorise donc l'archivage** (valeur immédiate, testable, dettes soldées), e-reporting en 2.3, annuaire en 2.4.

---

## Versions & dépendances (registre npm vérifié le 2026-07-15)

> **Aucune dépendance npm ajoutée par ce plan.** Le scellement, les empreintes et l'archivage local reposent sur des primitives natives et une extension Postgres contrib :

| Brique | Fournisseur | Provenance / note |
|---|---|---|
| SHA-256 (application) | `node:crypto` (`createHash('sha256')`) | Cœur Node ≥ 22 — aucune dép. Déterministe. |
| SHA-256 (base) | extension **`pgcrypto`** (`digest(bytea,'sha256')`) | Contrib PostgreSQL standard. `CREATE EXTENSION IF NOT EXISTS pgcrypto` en migration (rôle propriétaire). Présente dans l'image `postgres:17-alpine` (dev/test) ; **à confirmer dans la liste des extensions autorisées Scaleway** au déploiement (⚠ risque #1). |
| Archivage local | `node:fs`/`node:path` | Cœur Node — write-once + `chmod 0o444`. |
| Canonicalisation / DLQ | TypeScript pur / **BullMQ 5.80.2** (déjà présent) | — |

> **Gate** : `pnpm run audit:ci` reste 0 et `pnpm outdated -r` **vierge** (aucune dep changée). Les overrides existants (`@esbuild-kit/core-utils>esbuild`, `postcss@8.5.19`) et `updateConfig.ignoreDependencies:["typescript"]` restent **inchangés**. Vérifier néanmoins la gate en fin de branche (Task 9) : une dep transitive peut avoir bougé indépendamment du plan.

---

## Points de risque signalés d'emblée

1. **Disponibilité de `pgcrypto` en production (Scaleway).** Le scellement DB en dépend. **Traité** : `CREATE EXTENSION IF NOT EXISTS pgcrypto` en migration (idempotent) ; pgcrypto est contrib standard, présent dans `postgres:17-alpine` (dev/test/CI). **À confirmer** dans la liste des extensions managées Scaleway avant déploiement (item déploiement, tracé). Repli documenté si indisponible : calculer le hash côté Node dans une fonction SD paramétrée (bascule D1 vers un compute app sérialisé) — non retenu par défaut, seulement si pgcrypto est refusé.
2. **Divergence de canonicalisation PL/pgSQL ↔ TypeScript.** Un octet de différence casse la vérification. **Traité** : encodage longueur-préfixée simple (`octet_length`/`Buffer.byteLength`, UTF-8 des deux côtés), horodatage tronqué **ms** canonicalisé en epoch-ms (entier, pas de format texte), **vecteur de test constant** + **test croisé DB↔Node** (D3). Toute dérive échoue un test déterministe.
3. **Fork de chaîne sous insertions concurrentes d'un même tenant.** Deux événements liraient la même tête. **Traité** : `pg_advisory_xact_lock` par tenant dans le trigger (D2) ; e2e de concurrence (N insertions parallèles → `seq` 1..N sans trou, chaîne valide).
4. **Régression de disponibilité si l'archivage échoue.** L'archivage ne doit pas bloquer la génération. **Traité** : archivage **découplé** best-effort (D6), `archive_status='failed'` ré-essayé par la réconciliation ; les formats restent servis dès `generated`. e2e : échec d'archive (port qui throw) → facture `generated` + `archive_status='failed'`, pas d'erreur remontée à l'ingestion.
5. **Contournement de l'immuabilité par le scellement.** Ajouter des colonnes ne doit pas rouvrir l'écriture. **Traité** : grants inchangés (`SELECT`+`INSERT`), trigger SD propriétaire à `search_path` épinglé qui **écrase** les colonnes de scellement ; e2e : `factelec_app` ne peut ni `UPDATE` ni `DELETE` (`42501`), ni fournir un `hash` arbitraire (le trigger le remplace — vérifié par recompute).
6. **Factures poison (dette 2.1).** Un job qui crashe **avant** d'écrire `failed` est ré-enfilé indéfiniment par la réconciliation. **Traité** (Task 8) : cap d'attempts au ré-enfilement (compteur/âge), passage forcé `failed` + dépôt en **dead-letter**, e2e reproduisant le crash récurrent.
7. **Write-once local vs WORM réel.** L'implémentation locale **simule** l'object-lock (refus d'écrasement + lecture seule) mais n'est **pas** un WORM matériel (un propriétaire du FS peut supprimer). **Traité/instruit** : honnêteté documentée (D5) — la garantie WORM réelle vient de l'object-lock S3 COMPLIANCE au déploiement ; le local sert au dev/test et prouve le **contrat** (write-once, empreinte). La vérification d'intégrité (D3) reste la garantie cryptographique portable.
8. **Numérotation des migrations.** Dernière migration existante = **0009** (`0009_last_used_and_purge`, `_journal.json` idx 9, `version "7"`). Les migrations de ce plan démarrent à **0010** ; les migrations manuelles (FK, RLS, trigger, grants) sont ajoutées à `meta/_journal.json` **à la main** (entrée `{ idx, version: "7", when: <epoch-ms arrondi>, tag: "00NN_...", breakpoints: true }`, **sans** snapshot — comme 0003/0005/0006/0008/0009). Les migrations générées par `drizzle-kit generate` (colonnes) écrivent leur propre entrée + snapshot.

---

## Sources réglementaires vérifiées (dossier `docs/reglementaire/specifications-externes-v3.2/`)

> Vérifiées in situ (pdftotext / décompression xlsx) — comme F1/G1.02/CDV Flux 6 l'ont été en 1.2/2.1. **Provenance tracée** pour chaque affirmation du plan.

**Archivage à valeur probante / PAF — CONSTAT MAJEUR (conditionne le périmètre 2.2) :** les spécifications externes v3.2 **ne définissent AUCUN format normalisé** de Piste d'Audit Fiable, de scellement ni d'archivage probatoire. Les termes « piste d'audit fiable », « valeur probante », « scellement », « cachet », « hash » sont **absents** des deux PDF (Dossier général v3.2, Chorus Pro v1.1) et des annexes (vérifié par `grep`). Ce qui existe : (a) obligation générique d'**intégrité/authenticité** des données (Dossier général §2.3.8, note 19) ; (b) « archive » au sens **conteneur de transport** `tar.gz` (§3, contrôle `IRR_EXTRAC`) — sans rapport avec l'archivage probatoire ; (c) **conservation 10 ans** mentionnée **uniquement pour Chorus Pro** (plateforme publique, Chorus Pro v1.1 §l.970), pas comme obligation de PAF côté PDP. **Conséquence** : le scellement/archivage de ce plan implémente la **spec projet §4.5** (conception maison) éclairée par le **CGI** (art. 289 bis, 289 E, 290, 290 A/B), et **non** un schéma DGFiP imposé. Le **format de la PAF est donc une conception projet** (latitude assumée), documentée comme telle — aucune énumération/XSD à respecter. Le chaînage SHA-256 est un choix d'implémentation de la garantie d'intégrité (§2.3.8), pas une prescription de format.

**E-reporting (Flux 10) — pour le report 2.3 :** XSD sous `3- XSD_v3.2/1 - E-reporting/` : `ereporting.xsd` (racine `Report`), `report.xsd` (TB-1 en-tête), `transaction.xsd` (TB-2, flux 10.1/10.3), `payment.xsd` (TB-3, flux 10.2/10.4), `parametre.xsd`. Format sémantique : `2- Annexes_v3.2/20260430_Annexe 6 - Format sémantique FE e-reporting - V1.10.xlsx` (V1.10, 30/04/2026). **4 blocs** (Dossier général §3.7.2) : 10.1 factures internationales, 10.2 paiements internationaux, 10.3 transactions **B2C** (agrégat jour×devise×type), 10.4 paiements B2C. Agrégation **par SIREN**, périodicité **selon régime TVA** (réel normal mensuel → par décades ; simplifié → mensuelle). Fondement CGI art. 290/290 A.

**Annuaire (Flux 13/14) — pour le report 2.4 :** swagger `4- Swagger_v3.2/ppf-openapi-annuaire-api-public-1.11.0-openapi.json` (OpenAPI 3.0.3, v1.11.0, serveur `aife.economie.gouv.fr/ppf/annuaire-public/v1`) ; format EDI `2- Annexes_v3.2/20260430_Annexe 3 - Format sémantique FE annuaire - V1.8.xlsx` (V1.8) ; XSD `3- XSD_v3.2/0 - Annuaire/` (F12-F13 actualisation, F14 consultation, commun). Ressources REST : Siren/Siret/Code-routage/Ligne-annuaire (recherche POST paginée + consultation GET) ; le routage SIREN→plateforme de réception passe par `ligneAnnuairePayloadHistoUleEtaRou`. F14 : export full hebdomadaire / différentiel 24h.

---

## Structure des fichiers (vue d'ensemble)

Ajouts/modifs `apps/api/` :

```
apps/api/
  src/
    config/env.ts                         # + ARCHIVE_DRIVER, ARCHIVE_LOCAL_DIR, GENERATION_MAX_ATTEMPTS_CAP, ARCHIVE_RETRY_EVERY_MS
    db/
      schema.ts                           # FK invoice_id → restrict ; + seq/prevHash/hash ; + invoices.archive*/reconcileAttempts ; + invoiceDeadLetters
      migrations/
        0010_ledger_fk_restrict.sql       # (drizzle+hand) FK cascade→restrict + CREATE EXTENSION pgcrypto (Task 1)
        0011_ledger_seal_columns.sql      # (drizzle) colonnes seq/prev_hash/hash + unique (tenant,seq)/(tenant,hash) (Task 2)
        0012_ledger_seal_trigger.sql      # (hand) ledger_field + seal_status_event() SD + trigger BEFORE INSERT (Task 2)
        0013_invoice_archive_status.sql   # (drizzle) enum archive_status + colonnes archive_* sur invoices (Task 6)
        0014_dead_letters.sql             # (drizzle) invoices.reconcile_attempts + table invoice_dead_letters (Task 8)
        0015_dead_letters_rls.sql         # (hand) RLS/grants DLQ + SD find_failed_archives (Task 8)
        meta/_journal.json                # + 0010..0015 (0012/0015 ajoutés manuellement)
    ledger/
      ledger-hash.ts                      # PUR : canonicalizeStatusEvent, computeEventHash, genesisHash (miroir PL/pgSQL) (Task 3)
      ledger-verification.service.ts      # recompute la chaîne sous RLS, détecte altération (Task 4)
      ledger.controller.ts                # GET /invoices/:id/ledger (Task 4) + GET /invoices/:id/paf (Task 7)
      paf.ts                              # PUR : renderPafCsv + types PafDocument/PafEvent (Task 7)
      paf.service.ts                      # buildPaf() : reconstitue chaîne + intégrité + archivage (Task 7)
      ledger.module.ts                    # câblage
    archive/
      archive-store.port.ts               # interface ArchiveStore + ARCHIVE_STORE token + erreurs (Task 5)
      local-filesystem-archive-store.ts   # implémentation write-once locale (testable) (Task 5)
      archive.module.ts                   # @Global : factory ARCHIVE_STORE selon ARCHIVE_DRIVER (throw documenté sur 's3') (Task 5)
      archive-bundle.ts                   # PUR : buildArchiveBundle (canonique + formats + journal scellé + manifeste) (Task 6)
      archive.service.ts                  # archiveInvoice() : assemble + dépose via le port + statut (Task 6)
    invoices/
      invoices.repository.ts              # + loadSealedEventsBy{Invoice,Tenant}, loadAllFormats, mark/findArchiveStatus, bumpReconcileAttempts, recordDeadLetter
      invoices.module.ts                  # exports: [InvoicesRepository] (pour LedgerModule)
    worker/
      invoice-generation.processor.ts     # + archivage best-effort après completeGeneration (Task 6)
      invoice-reconciliation.service.ts   # + cap → DLQ (failed + invoice_dead_letters) (Task 8)
      archive-retry.service.ts            # sweepFailedArchives() : rejoue archiveInvoice sur archive_status='failed' (Task 8)
      archive-retry.scheduler.ts          # job répétable ARCHIVE_RETRY_JOB (Task 8)
      maintenance.processor.ts            # + branche ARCHIVE_RETRY_JOB (Task 8)
      worker.module.ts                    # + ArchiveModule, ArchiveService, ArchiveRetryService/Scheduler
  tests/
    unit/
      ledger-hash.test.ts                 # vecteur canonique constant + genesis ancré + avalanche (Task 3)
      local-filesystem-archive-store.test.ts  # write-once, chmod, empreinte, traversée (Task 5)
      archive-bundle.test.ts              # manifeste déterministe, empreintes (Task 6)
      paf.test.ts                         # rendu CSV RFC 4180 (Task 7)
      env.test.ts                         # (MODIFIÉ) cas ARCHIVE_* (Task 5)
    e2e/
      ledger-sealing.e2e.test.ts          # FK restrict/pgcrypto (Task 1) ; chaîne seq/genesis/prev_hash/hash, concurrence, immuabilité (Task 2)
      ledger-verification.e2e.test.ts     # GET /ledger, altération owner-side détectée, DB↔Node (Task 4)
      archive-generation.e2e.test.ts      # generated → archived ; échec → archive_status failed ; idempotence (Task 6)
      paf-export.e2e.test.ts              # GET /paf JSON+CSV, isolation, intégrité (Task 7)
      poison-invoice.e2e.test.ts          # cap → failed + dead-letter, DLQ append-only (Task 8)
      helpers/worker.ts                   # (MODIFIÉ) option archiveStore (override ARCHIVE_STORE) (Task 6)
```

Fichiers hors `apps/api` :
- `.github/workflows/ci.yml` — inchangé (Docker natif couvre Postgres+Redis via Testcontainers).
- `README.md` racine + `apps/api/README.md` — scellement/archivage/PAF/DLQ, `ARCHIVE_*`, différés 2.3+ mis à jour.
- `pnpm-lock.yaml` — **inchangé** (aucune dépendance ajoutée).

---

### Task 1 : Retrait de la FK cascade + extension `pgcrypto`

**Files:**
- Modify: `apps/api/src/db/schema.ts` (FK `invoiceStatusEvents.invoiceId` : `cascade` → `restrict`)
- Create: `apps/api/src/db/migrations/0010_ledger_fk_restrict.sql` (drizzle + ajout manuel `pgcrypto`) + `meta/_journal.json` + snapshot
- Create: `apps/api/tests/e2e/ledger-sealing.e2e.test.ts` (partie FK/pgcrypto ; complétée en Task 2)

**Interfaces:**
- Consumes : schéma 2.1 (`invoiceStatusEvents`), `startTestDb` (helper e2e).
- Produces (utilisé par Task 2) : FK `invoice_id` en `ON DELETE RESTRICT` ; extension `pgcrypto` disponible (fonction `digest`).

- [ ] **Step 1 : Passer la FK en `restrict` (schéma)**

`apps/api/src/db/schema.ts` — dans la table `invoiceStatusEvents`, changer **uniquement** la FK `invoiceId` (laisser `tenantId` en `cascade`, cf. D4) :
```ts
    invoiceId: uuid('invoice_id')
      .notNull()
      // Journal probatoire : une facture munie d'événements NE PEUT PLUS être
      // supprimée (le journal ne se supprime pas avec sa facture — dette 2.1, D4).
      .references(() => invoices.id, { onDelete: 'restrict' }),
```

- [ ] **Step 2 : Générer la migration + injecter `pgcrypto`**

```bash
pnpm --filter @factelec/api db:generate     # → 0010_<slug>.sql + snapshot + entrée _journal
```
**Renommer** le fichier généré en `0010_ledger_fk_restrict.sql` et, dans `meta/_journal.json`, mettre le `tag` de l'entrée idx 10 à `"0010_ledger_fk_restrict"` (le migrator charge `<tag>.sql`). **Relire** : le fichier doit contenir le `DROP CONSTRAINT "invoice_status_events_invoice_id_invoices_id_fk"` puis `ADD CONSTRAINT ... ON DELETE restrict ON UPDATE no action`. **Ajouter en TÊTE du fichier** (pgcrypto n'est pas géré par drizzle, mais requis par le trigger de scellement de la Task 2) :
```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
```
> Le snapshot 0010 capture désormais la FK `restrict` : la génération de colonnes en Task 2 n'émettra donc **que** les colonnes (pas de ré-émission de la FK). `pgcrypto` (contrib standard) est présent dans `postgres:17-alpine` ; **à confirmer** dans les extensions managées Scaleway au déploiement (risque #1).

- [ ] **Step 3 : e2e RED→GREEN (FK restrict + pgcrypto)**

`apps/api/tests/e2e/ledger-sealing.e2e.test.ts` (première moitié ; la seconde arrive en Task 2) :
```ts
import { buildInvoice } from '@factelec/invoice-core'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { InvoicesRepository } from '../../src/invoices/invoices.repository.js'
import { TenantContextService } from '../../src/db/tenant-context.service.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'

const invoiceInput = {
  number: 'FA-SEAL-1', issueDate: '2026-07-14', dueDate: '2026-08-13',
  typeCode: '380', currency: 'EUR', businessProcessType: 'S1',
  seller: { name: 'Vendeur', address: { countryCode: 'FR' } },
  buyer: { name: 'Acheteur', address: { countryCode: 'FR' } },
  lines: [{ id: '1', name: 'S', quantity: '1', unitCode: 'C62', unitPrice: '100.00', vatCategory: 'S', vatRate: '20.00' }],
}

describe('invoice_status_events sealing (e2e)', () => {
  let db: TestDb
  let ownerPool: pg.Pool
  let appPool: pg.Pool
  let repo: InvoicesRepository
  let tenantA: string

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    appPool = new pg.Pool({ connectionString: db.appUrl })
    repo = new InvoicesRepository(new TenantContextService(appPool as never))
    const a = await ownerPool.query("INSERT INTO tenants (name) VALUES ('A') RETURNING id")
    tenantA = a.rows[0].id
  })
  afterAll(async () => {
    await appPool.end()
    await ownerPool.end()
    await db.stop()
  })

  it('has pgcrypto available (digest sha256)', async () => {
    const r = await ownerPool.query("SELECT encode(digest('abc','sha256'),'hex') AS h")
    expect(r.rows[0].h).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('forbids deleting an invoice that has a probative journal (23503)', async () => {
    const { id } = await repo.insertReceived(tenantA, buildInvoice(invoiceInput))
    // insertReceived a écrit l'événement initial `deposee` → la FK RESTRICT
    // bloque la suppression, même pour l'owner (BYPASSRLS n'exempte pas des FK).
    await expect(
      ownerPool.query('DELETE FROM invoices WHERE id = $1', [id]),
    ).rejects.toMatchObject({ code: '23503' })
  })
})
```
Run: `pnpm --filter @factelec/api test -- ledger-sealing` → PASS.

- [ ] **Step 4 : Gate + commit**

```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): journal probatoire — FK invoice_id en RESTRICT et extension pgcrypto"
```
Expected: PASS, couverture ≥ 90 % (migration exclue ; FK/pgcrypto prouvés en e2e).

---
### Task 2 : Scellement chaîné SHA-256 imposé par la base (colonnes + trigger `SECURITY DEFINER`)

**Files:**
- Modify: `apps/api/src/db/schema.ts` (colonnes `seq`/`prevHash`/`hash` + contraintes uniques)
- Create: `apps/api/src/db/migrations/0011_ledger_seal_columns.sql` (drizzle) + snapshot + `_journal`
- Create: `apps/api/src/db/migrations/0012_ledger_seal_trigger.sql` (hand : `ledger_field`, `seal_status_event`, trigger)
- Modify: `apps/api/tests/e2e/ledger-sealing.e2e.test.ts` (seconde moitié : chaîne, genesis, concurrence, immuabilité)

**Interfaces:**
- Consumes : Task 1 (pgcrypto, FK restrict), `insertReceived`/`recordTransition` (2.1, inchangés — n'écrivent PAS les colonnes de scellement).
- Produces (utilisé par Tasks 3-4-7) : chaque `invoice_status_events` porte `seq` (monotone/tenant), `prev_hash` (bytea 32), `hash` (bytea 32) **calculés par le trigger** ; genesis dérivé du tenant ; canonicalisation figée (miroir Task 3).

- [ ] **Step 1 : Colonnes de scellement (schéma)**

`apps/api/src/db/schema.ts` — imports : ajouter `bigint` et `unique` à l'import `drizzle-orm/pg-core`. Dans `invoiceStatusEvents`, ajouter après `createdAt` (défauts **placeholder TOUJOURS écrasés par le trigger** — ils rendent les colonnes optionnelles à l'insert Drizzle, donc `insertReceived`/`recordTransition` restent inchangés) :
```ts
    // ── Scellement chaîné (imposé par le trigger seal_status_event, D1/D2) ──
    // Les défauts ci-dessous sont des PLACEHOLDERS : le trigger BEFORE INSERT
    // recalcule TOUJOURS seq/prev_hash/hash. Ils existent uniquement pour rendre
    // ces colonnes NOT NULL optionnelles à l'insert (repository inchangé).
    seq: bigint('seq', { mode: 'number' }).notNull().default(0),
    prevHash: bytea('prev_hash').notNull().default(sql`'\\x'::bytea`),
    hash: bytea('hash').notNull().default(sql`'\\x'::bytea`),
```
et, dans le tableau des contraintes/index (2e argument), ajouter :
```ts
    unique('invoice_status_events_tenant_seq_unique').on(t.tenantId, t.seq),
    unique('invoice_status_events_tenant_hash_unique').on(t.tenantId, t.hash),
```
> `sql` est déjà importé de `drizzle-orm` dans `schema.ts` (utilisé ailleurs) ; sinon l'ajouter.

- [ ] **Step 2 : Migration de colonnes (drizzle)**

```bash
pnpm --filter @factelec/api db:generate     # → 0011_<slug>.sql + snapshot + entrée _journal
```
**Renommer** en `0011_ledger_seal_columns.sql`, mettre le `tag` idx 11 à `"0011_ledger_seal_columns"`. **Relire** : doit contenir `ADD COLUMN "seq" bigint DEFAULT 0 NOT NULL`, `ADD COLUMN "prev_hash" "bytea" DEFAULT '\x'::bytea NOT NULL`, `ADD COLUMN "hash" ...`, et les deux `ADD CONSTRAINT ... UNIQUE`. **Aucune** instruction de FK ne doit apparaître (déjà capturée par le snapshot 0010) — si drizzle en émet une, la **supprimer** (état déjà appliqué).

- [ ] **Step 3 : Trigger de scellement (migration manuelle 0012)**

`apps/api/src/db/migrations/0012_ledger_seal_trigger.sql` :
```sql
-- Scellement à valeur probante du journal invoice_status_events (spec §4.5,
-- intégrité CGI art. 289 bis/289 E). Le hash chaîné SHA-256 par tenant est
-- calculé PAR LA BASE (non contournable par l'application, D1) : trigger
-- BEFORE INSERT SECURITY DEFINER (propriété owner, search_path épinglé) qui
-- écrase tout seq/prev_hash/hash fourni par le client. factelec_app conserve
-- SELECT+INSERT seulement (aucun UPDATE/DELETE → immuabilité, migration 0008).
-- Hypothèse : encodage base de données = UTF8 (octet_length = octets UTF-8,
-- miroir de Buffer.byteLength côté Node — cf. src/ledger/ledger-hash.ts).

-- Encodage d'un champ, longueur-préfixé (injection-proof) : NULL → '-1|',
-- sinon octet_length||'|'||valeur. IMMUTABLE (pur).
CREATE OR REPLACE FUNCTION ledger_field(v text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN v IS NULL THEN '-1|'
    ELSE octet_length(v)::text || '|' || v
  END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION ledger_field(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ledger_field(text) TO factelec_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION seal_status_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  head_seq  bigint;
  head_hash bytea;
  ts_ms     bigint;
  canonical text;
BEGIN
  -- Sérialise les insertions du MÊME tenant (anti-fork) sans bloquer les autres.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text, 0));

  -- Horodatage tronqué ms (précision représentable par Date JS → égalité PG↔Node).
  NEW.created_at := date_trunc('milliseconds', COALESCE(NEW.created_at, now()));
  ts_ms := (extract(epoch FROM NEW.created_at) * 1000)::bigint;

  SELECT e.seq, e.hash INTO head_seq, head_hash
  FROM invoice_status_events e
  WHERE e.tenant_id = NEW.tenant_id
  ORDER BY e.seq DESC
  LIMIT 1;

  IF head_seq IS NULL THEN
    NEW.seq := 1;
    -- Genesis dérivé du tenant (origine liée à son identité).
    NEW.prev_hash := digest(
      convert_to('factelec:ledger:genesis:v1:' || NEW.tenant_id::text, 'UTF8'),
      'sha256'
    );
  ELSE
    NEW.seq := head_seq + 1;
    NEW.prev_hash := head_hash;
  END IF;

  -- Ordre FIGÉ, miroir exact de canonicalizeStatusEvent (Task 3).
  canonical :=
       ledger_field(NEW.tenant_id::text)
    || ledger_field(NEW.invoice_id::text)
    || ledger_field(NEW.seq::text)
    || ledger_field(NEW.from_status::text)
    || ledger_field(NEW.to_status::text)
    || ledger_field(NEW.actor)
    || ledger_field(NEW.reason)
    || ledger_field(ts_ms::text);

  NEW.hash := digest(NEW.prev_hash || convert_to(canonical, 'UTF8'), 'sha256');
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION seal_status_event() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION seal_status_event() TO factelec_app;
--> statement-breakpoint
CREATE TRIGGER trg_seal_status_event
  BEFORE INSERT ON invoice_status_events
  FOR EACH ROW
  EXECUTE FUNCTION seal_status_event();
```
Enregistrer 0012 dans `meta/_journal.json` : entrée idx 12 (`version: "7"`, `when` epoch-ms arrondi, `tag: "0012_ledger_seal_trigger"`, `breakpoints: true`, **sans** snapshot — geste manuel comme 0003/0006/0008/0009).

- [ ] **Step 4 : e2e chaîne + genesis + concurrence + immuabilité (compléter le fichier)**

Ajouter à `apps/api/tests/e2e/ledger-sealing.e2e.test.ts` (dans le même `describe`, en réutilisant `tenantA`) :
```ts
  it('seals the initial event: seq=1, genesis prev_hash, hash present', async () => {
    const t = (await ownerPool.query("INSERT INTO tenants (name) VALUES ('S1') RETURNING id")).rows[0].id
    const { id } = await repo.insertReceived(t, buildInvoice({ ...invoiceInput, number: 'FA-SEAL-S1' }))
    const ev = await ownerPool.query(
      "SELECT seq, encode(prev_hash,'hex') AS prev, encode(hash,'hex') AS h FROM invoice_status_events WHERE invoice_id = $1",
      [id],
    )
    expect(ev.rows).toHaveLength(1)
    expect(Number(ev.rows[0].seq)).toBe(1)
    // genesis = sha256('factelec:ledger:genesis:v1:' || tenantId)
    const genesis = (await ownerPool.query(
      "SELECT encode(digest('factelec:ledger:genesis:v1:' || $1, 'sha256'),'hex') AS g", [t],
    )).rows[0].g
    expect(ev.rows[0].prev).toBe(genesis)
    expect(ev.rows[0].h).toMatch(/^[0-9a-f]{64}$/)
  })

  it('chains events per tenant: seq monotone, prev_hash = previous hash', async () => {
    const t = (await ownerPool.query("INSERT INTO tenants (name) VALUES ('S2') RETURNING id")).rows[0].id
    const { id } = await repo.insertReceived(t, buildInvoice({ ...invoiceInput, number: 'FA-SEAL-S2' }))
    await repo.recordTransition(t, id, 'deposee', 'emise', 'platform', undefined)
    await repo.recordTransition(t, id, 'emise', 'encaissee', 'user:x', undefined)
    const rows = (await ownerPool.query(
      "SELECT seq, encode(prev_hash,'hex') AS prev, encode(hash,'hex') AS h FROM invoice_status_events WHERE tenant_id = $1 ORDER BY seq", [t],
    )).rows
    expect(rows.map((r) => Number(r.seq))).toEqual([1, 2, 3])
    expect(rows[1].prev).toBe(rows[0].h)     // maillon 2 → hash de 1
    expect(rows[2].prev).toBe(rows[1].h)     // maillon 3 → hash de 2
  })

  it('overrides any client-supplied seq/prev_hash/hash (non-forgeable)', async () => {
    const t = (await ownerPool.query("INSERT INTO tenants (name) VALUES ('S3') RETURNING id")).rows[0].id
    const inv = (await ownerPool.query(
      "INSERT INTO invoices (tenant_id, number, type_code, issue_date, currency, canonical) VALUES ($1,'FA-F','380','2026-07-14','EUR','{}'::jsonb) RETURNING id", [t],
    )).rows[0].id
    // Insertion directe (app pool) tentant de forger seq/hash → le trigger écrase.
    const client = await appPool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [t])
      await client.query(
        "INSERT INTO invoice_status_events (tenant_id, invoice_id, to_status, actor, seq, prev_hash, hash) VALUES ($1,$2,'deposee','platform', 999, '\\xdead'::bytea, '\\xbeef'::bytea)",
        [t, inv],
      )
      await client.query('COMMIT')
    } finally {
      client.release()
    }
    const r = (await ownerPool.query(
      "SELECT seq, encode(hash,'hex') AS h FROM invoice_status_events WHERE invoice_id = $1", [inv],
    )).rows[0]
    expect(Number(r.seq)).toBe(1)              // 999 écrasé
    expect(r.h).not.toBe('beef')               // hash forgé écrasé
    expect(r.h).toMatch(/^[0-9a-f]{64}$/)
  })

  it('serializes concurrent inserts of one tenant without forking the chain', async () => {
    const t = (await ownerPool.query("INSERT INTO tenants (name) VALUES ('S4') RETURNING id")).rows[0].id
    const ids = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        repo.insertReceived(t, buildInvoice({ ...invoiceInput, number: `FA-CONC-${i}` })),
      ),
    )
    expect(ids).toHaveLength(10)
    const seqs = (await ownerPool.query(
      'SELECT seq FROM invoice_status_events WHERE tenant_id = $1 ORDER BY seq', [t],
    )).rows.map((r) => Number(r.seq))
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) // aucun trou, aucun doublon
  })

  it('remains APPEND-ONLY under sealing: factelec_app cannot UPDATE/DELETE (42501)', async () => {
    const client = await appPool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA])
      await expect(
        client.query("UPDATE invoice_status_events SET hash = '\\x00'::bytea"),
      ).rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK')
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA])
      await expect(
        client.query('DELETE FROM invoice_status_events'),
      ).rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })
```
Run: `pnpm --filter @factelec/api test -- ledger-sealing` → PASS.

- [ ] **Step 5 : Gate + commit**

```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): scellement chaîné SHA-256 du journal (trigger SECURITY DEFINER, genesis par tenant)"
```
Expected: PASS, couverture ≥ 90 % (scellement prouvé au niveau base ; repository inchangé).

---
### Task 3 : Canonicalisation & hash TypeScript pur (miroir du PL/pgSQL, vecteurs déterministes)

**Files:**
- Create: `apps/api/src/ledger/ledger-hash.ts`
- Create: `apps/api/tests/unit/ledger-hash.test.ts`

**Interfaces:**
- Produces (utilisé par Tasks 4-6-7) :
  - `interface StatusEventForHash { tenantId; invoiceId; seq: number; fromStatus: string | null; toStatus: string; actor: string; reason: string | null; createdAtMs: number }`
  - `canonicalizeStatusEvent(e): string` (encodage longueur-préfixé, ordre figé — **miroir exact** de `ledger_field`/`seal_status_event`).
  - `genesisHash(tenantId): Buffer` (SHA-256 32 octets) ; `computeEventHash(prevHash: Buffer, e): Buffer`.

- [ ] **Step 1 : Tests (RED) — vecteur canonique constant + propriétés du hash**

`apps/api/tests/unit/ledger-hash.test.ts` :
```ts
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  canonicalizeStatusEvent,
  computeEventHash,
  genesisHash,
  type StatusEventForHash,
} from '../../src/ledger/ledger-hash.js'

const base: StatusEventForHash = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  invoiceId: '22222222-2222-2222-2222-222222222222',
  seq: 1,
  fromStatus: null,
  toStatus: 'deposee',
  actor: 'platform',
  reason: null,
  createdAtMs: 0,
}

describe('ledger-hash (canonicalisation & scellement)', () => {
  it('canonicalise avec un encodage longueur-préfixé figé (vecteur constant)', () => {
    // Vecteur calculé à la main : field(v)= v===null?'-1|':octetLen+'|'+v, ordre figé.
    expect(canonicalizeStatusEvent(base)).toBe(
      '36|11111111-1111-1111-1111-111111111111' +
        '36|22222222-2222-2222-2222-222222222222' +
        '1|1' +
        '-1|' +
        '7|deposee' +
        '8|platform' +
        '-1|' +
        '1|0',
    )
  })

  it('est injection-proof : un | dans reason ne casse pas le découpage', () => {
    const a = canonicalizeStatusEvent({ ...base, reason: 'a|b' })
    const b = canonicalizeStatusEvent({ ...base, reason: 'a', actor: 'platform|b' })
    expect(a).not.toBe(b) // la longueur préfixée dissocie les deux
    expect(a).toContain('3|a|b')
  })

  it('compte les octets UTF-8, pas les caractères', () => {
    // 'é' = 2 octets UTF-8 → préfixe 2, pas 1.
    expect(canonicalizeStatusEvent({ ...base, actor: 'é' })).toContain('2|é')
  })

  it('genesisHash : 32 octets, déterministe, distinct par tenant', () => {
    const g1 = genesisHash(base.tenantId)
    expect(g1).toHaveLength(32)
    expect(g1.equals(genesisHash(base.tenantId))).toBe(true)
    expect(g1.equals(genesisHash('33333333-3333-3333-3333-333333333333'))).toBe(false)
    // Ancre externe : genesis = sha256('factelec:ledger:genesis:v1:'||tenantId).
    expect(g1.toString('hex')).toBe(
      createHash('sha256')
        .update(`factelec:ledger:genesis:v1:${base.tenantId}`, 'utf8')
        .digest('hex'),
    )
  })

  it('computeEventHash : 32 octets, déterministe, avalanche sur tout champ', () => {
    const prev = genesisHash(base.tenantId)
    const h = computeEventHash(prev, base)
    expect(h).toHaveLength(32)
    expect(h.equals(computeEventHash(prev, base))).toBe(true)
    // Changer un seul champ change le hash.
    expect(h.equals(computeEventHash(prev, { ...base, actor: 'user:x' }))).toBe(false)
    expect(h.equals(computeEventHash(prev, { ...base, seq: 2 }))).toBe(false)
    expect(h.equals(computeEventHash(prev, { ...base, createdAtMs: 1 }))).toBe(false)
    // Changer le maillon précédent change le hash (chaînage réel).
    const prev2 = genesisHash('44444444-4444-4444-4444-444444444444')
    expect(h.equals(computeEventHash(prev2, base))).toBe(false)
  })
})
```
Run: `pnpm --filter @factelec/api test -- ledger-hash` → FAIL (module absent).

- [ ] **Step 2 : Implémentation (GREEN)**

`apps/api/src/ledger/ledger-hash.ts` :
```ts
import { createHash } from 'node:crypto'

// Événement de statut réduit aux champs SCELLÉS (miroir de seal_status_event,
// migration 0012). createdAtMs = created_at tronqué à la milliseconde (getTime()).
export interface StatusEventForHash {
  tenantId: string
  invoiceId: string
  seq: number
  fromStatus: string | null
  toStatus: string
  actor: string
  reason: string | null
  createdAtMs: number
}

// Encodage d'un champ, longueur-préfixé (injection-proof) : NULL → '-1|', sinon
// octet_length(UTF-8)||'|'||valeur. Identique à ledger_field(text) côté base.
function field(v: string | null): string {
  if (v === null) return '-1|'
  return `${Buffer.byteLength(v, 'utf8')}|${v}`
}

// Ordre FIGÉ — doit rester synchronisé avec seal_status_event (migration 0012).
export function canonicalizeStatusEvent(e: StatusEventForHash): string {
  return (
    field(e.tenantId) +
    field(e.invoiceId) +
    field(String(e.seq)) +
    field(e.fromStatus) +
    field(e.toStatus) +
    field(e.actor) +
    field(e.reason) +
    field(String(e.createdAtMs))
  )
}

// Genesis dérivé du tenant : sha256('factelec:ledger:genesis:v1:'||tenantId).
export function genesisHash(tenantId: string): Buffer {
  return createHash('sha256')
    .update(`factelec:ledger:genesis:v1:${tenantId}`, 'utf8')
    .digest()
}

// hash = sha256(prev_hash ‖ canonical) — concat d'octets, miroir du digest PG.
export function computeEventHash(prevHash: Buffer, e: StatusEventForHash): Buffer {
  return createHash('sha256')
    .update(prevHash)
    .update(canonicalizeStatusEvent(e), 'utf8')
    .digest()
}
```
Run: `pnpm --filter @factelec/api test -- ledger-hash` → PASS.

- [ ] **Step 3 : Gate + commit**

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): canonicalisation et hash de scellement TypeScript (vecteurs déterministes)"
```
Expected: PASS ; viser 100 % de `ledger-hash.ts` (module pur).

---
### Task 4 : Vérification d'intégrité de la chaîne + endpoint `GET /invoices/:id/ledger`

**Files:**
- Modify: `apps/api/src/invoices/invoices.repository.ts` (`loadSealedEventsByInvoice`, `loadSealedEventsByTenant`, type `SealedEvent`)
- Modify: `apps/api/src/invoices/invoices.module.ts` (`exports: [InvoicesRepository]`)
- Create: `apps/api/src/ledger/ledger-verification.service.ts`
- Create: `apps/api/src/ledger/ledger.controller.ts`
- Create: `apps/api/src/ledger/ledger.module.ts`
- Modify: `apps/api/src/app.module.ts` (import `LedgerModule`)
- Create: `apps/api/tests/e2e/ledger-verification.e2e.test.ts`

**Interfaces:**
- Consumes : `ledger-hash.ts` (Task 3), scellement DB (Task 2), `runInTenant`, `TenantAuthGuard`/`CurrentTenant` (2.1), `InvoicesRepository`.
- Produces (utilisé par Task 7) :
  - `interface SealedEvent { seq: number; invoiceId: string; fromStatus: string | null; toStatus: string; actor: string; reason: string | null; createdAt: Date; prevHash: Buffer; hash: Buffer }`
  - `LedgerVerificationService.verifyInvoiceEvents(tenantId, invoiceId): Promise<LedgerIntegrity>` (self-check par événement) ; `.verifyTenantChain(tenantId): Promise<LedgerIntegrity>` (chaîne complète : genesis + contiguïté + linkage + hash) ; `type LedgerIntegrity = { valid: true; length: number } | { valid: false; brokenAtSeq: number; reason: 'seq-gap' | 'prev-hash-mismatch' | 'hash-mismatch' }`.
  - `GET /invoices/:id/ledger` (dual-auth) : `{ invoiceId, events: SerializedEvent[], integrity }` ; `404` facture inconnue.

- [ ] **Step 1 : Méthodes repository (lecture des événements scellés)**

`apps/api/src/invoices/invoices.repository.ts` — imports : `invoiceStatusEvents` (déjà), `asc`, `eq` (déjà). Ajouter le type + deux méthodes (lecture sous RLS) :
```ts
export interface SealedEvent {
  seq: number
  invoiceId: string
  fromStatus: string | null
  toStatus: string
  actor: string
  reason: string | null
  createdAt: Date
  prevHash: Buffer
  hash: Buffer
}

  async loadSealedEventsByInvoice(
    tenantId: string,
    invoiceId: string,
  ): Promise<SealedEvent[]> {
    return this.tenant.run(tenantId, async (db) => {
      const rows = await db
        .select({
          seq: invoiceStatusEvents.seq,
          invoiceId: invoiceStatusEvents.invoiceId,
          fromStatus: invoiceStatusEvents.fromStatus,
          toStatus: invoiceStatusEvents.toStatus,
          actor: invoiceStatusEvents.actor,
          reason: invoiceStatusEvents.reason,
          createdAt: invoiceStatusEvents.createdAt,
          prevHash: invoiceStatusEvents.prevHash,
          hash: invoiceStatusEvents.hash,
        })
        .from(invoiceStatusEvents)
        .where(eq(invoiceStatusEvents.invoiceId, invoiceId))
        .orderBy(asc(invoiceStatusEvents.seq))
      return rows as SealedEvent[]
    })
  }

  async loadSealedEventsByTenant(tenantId: string): Promise<SealedEvent[]> {
    return this.tenant.run(tenantId, async (db) => {
      const rows = await db
        .select({
          seq: invoiceStatusEvents.seq,
          invoiceId: invoiceStatusEvents.invoiceId,
          fromStatus: invoiceStatusEvents.fromStatus,
          toStatus: invoiceStatusEvents.toStatus,
          actor: invoiceStatusEvents.actor,
          reason: invoiceStatusEvents.reason,
          createdAt: invoiceStatusEvents.createdAt,
          prevHash: invoiceStatusEvents.prevHash,
          hash: invoiceStatusEvents.hash,
        })
        .from(invoiceStatusEvents)
        .orderBy(asc(invoiceStatusEvents.seq))
      return rows as SealedEvent[]
    })
  }
```
> `prev_hash`/`hash` (bytea) reviennent en `Buffer` via `pg` (le customType `bytea` mappe `Buffer`). `seq` (bigint mode `number`) revient en `number`.

`apps/api/src/invoices/invoices.module.ts` — ajouter `InvoicesRepository` à `exports` (pour `LedgerModule`).

- [ ] **Step 2 : Service de vérification**

`apps/api/src/ledger/ledger-verification.service.ts` :
```ts
import { Injectable } from '@nestjs/common'
// biome-ignore lint/style/useImportType: InvoicesRepository résolu par Nest via design:paramtypes.
import { InvoicesRepository, type SealedEvent } from '../invoices/invoices.repository.js'
import {
  computeEventHash,
  genesisHash,
  type StatusEventForHash,
} from './ledger-hash.js'

export type LedgerIntegrity =
  | { valid: true; length: number }
  | {
      valid: false
      brokenAtSeq: number
      reason: 'seq-gap' | 'prev-hash-mismatch' | 'hash-mismatch'
    }

function toHashInput(tenantId: string, ev: SealedEvent): StatusEventForHash {
  return {
    tenantId,
    invoiceId: ev.invoiceId,
    seq: ev.seq,
    fromStatus: ev.fromStatus,
    toStatus: ev.toStatus,
    actor: ev.actor,
    reason: ev.reason,
    // Miroir de date_trunc('milliseconds', ...) côté base : getTime() = ms.
    createdAtMs: ev.createdAt.getTime(),
  }
}

@Injectable()
export class LedgerVerificationService {
  constructor(private readonly repo: InvoicesRepository) {}

  // Self-check par événement : le hash stocké doit égaler le recompute à partir
  // du prev_hash stocké + champs. Détecte l'altération d'un champ d'un événement.
  async verifyInvoiceEvents(
    tenantId: string,
    invoiceId: string,
  ): Promise<LedgerIntegrity> {
    const events = await this.repo.loadSealedEventsByInvoice(tenantId, invoiceId)
    for (const ev of events) {
      const expected = computeEventHash(ev.prevHash, toHashInput(tenantId, ev))
      if (!expected.equals(ev.hash)) {
        return { valid: false, brokenAtSeq: ev.seq, reason: 'hash-mismatch' }
      }
    }
    return { valid: true, length: events.length }
  }

  // Chaîne complète du tenant : genesis, contiguïté du seq, linkage prev_hash,
  // hash. Détecte suppression/insertion/altération sur tout le journal du tenant.
  async verifyTenantChain(tenantId: string): Promise<LedgerIntegrity> {
    const events = await this.repo.loadSealedEventsByTenant(tenantId)
    let expectedSeq = 1
    let prevHash: Buffer | null = null
    for (const ev of events) {
      if (ev.seq !== expectedSeq) {
        return { valid: false, brokenAtSeq: ev.seq, reason: 'seq-gap' }
      }
      const expectedPrev = prevHash ?? genesisHash(tenantId)
      if (!ev.prevHash.equals(expectedPrev)) {
        return { valid: false, brokenAtSeq: ev.seq, reason: 'prev-hash-mismatch' }
      }
      const expectedHash = computeEventHash(ev.prevHash, toHashInput(tenantId, ev))
      if (!expectedHash.equals(ev.hash)) {
        return { valid: false, brokenAtSeq: ev.seq, reason: 'hash-mismatch' }
      }
      prevHash = ev.hash
      expectedSeq += 1
    }
    return { valid: true, length: events.length }
  }
}
```

- [ ] **Step 3 : Contrôleur + module + câblage**

`apps/api/src/ledger/ledger.controller.ts` :
```ts
import { Controller, Get, NotFoundException, Param, UseGuards } from '@nestjs/common'
import { CurrentTenant } from '../auth/current-tenant.decorator.js'
import { ProblemType, problem } from '../common/problem.js'
import { TenantAuthGuard } from '../auth/tenant-auth.guard.js'
// biome-ignore lint/style/useImportType: résolus par Nest via design:paramtypes.
import { InvoicesRepository } from '../invoices/invoices.repository.js'
// biome-ignore lint/style/useImportType: résolus par Nest via design:paramtypes.
import { LedgerVerificationService } from './ledger-verification.service.js'

@Controller('invoices')
export class LedgerController {
  constructor(
    private readonly repo: InvoicesRepository,
    private readonly verification: LedgerVerificationService,
  ) {}

  @Get(':id/ledger')
  @UseGuards(TenantAuthGuard)
  async ledger(@CurrentTenant() tenantId: string, @Param('id') id: string) {
    // 404 anti-fuite si la facture n'existe pas dans ce tenant (RLS).
    const status = await this.repo.getLifecycleStatus(tenantId, id)
    if (status === null) {
      throw new NotFoundException(problem(404, ProblemType.notFound, 'Unknown invoice'))
    }
    const events = await this.repo.loadSealedEventsByInvoice(tenantId, id)
    const integrity = await this.verification.verifyInvoiceEvents(tenantId, id)
    return {
      invoiceId: id,
      events: events.map((e) => ({
        seq: e.seq,
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        actor: e.actor,
        reason: e.reason,
        createdAt: e.createdAt.toISOString(),
        prevHash: e.prevHash.toString('hex'),
        hash: e.hash.toString('hex'),
      })),
      integrity,
    }
  }
}
```
`apps/api/src/ledger/ledger.module.ts` :
```ts
import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module.js'
import { InvoicesModule } from '../invoices/invoices.module.js'
import { LedgerController } from './ledger.controller.js'
import { LedgerVerificationService } from './ledger-verification.service.js'

@Module({
  imports: [AuthModule, InvoicesModule],
  controllers: [LedgerController],
  providers: [LedgerVerificationService],
})
export class LedgerModule {}
```
`apps/api/src/app.module.ts` — ajouter `LedgerModule` à `imports`.
> **Note d'exécution** : `TenantAuthGuard`/`CurrentTenant` proviennent de `AuthModule` (comme pour `InvoicesController`) ; si `AuthModule` n'exporte pas le guard, calquer sur la façon dont `InvoicesModule` le rend disponible (import du même module). Vérifier au premier run que `GET /invoices/:id/ledger` avec clé API OU session renvoie 200.

- [ ] **Step 4 : e2e — chaîne valide, altération owner-side détectée, DB↔Node**

`apps/api/tests/e2e/ledger-verification.e2e.test.ts` (structure Postgres+Redis via `createTestApp`, seed via `seedTenantWithKey` + `seedGeneratedInvoice`) :
```ts
import type { INestApplication } from '@nestjs/common'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { startTestRedis, type TestRedis } from './helpers/redis.js'
import { seedTenantWithKey } from './helpers/seed.js'
import { seedGeneratedInvoice } from './helpers/seed-invoice.js'

const input = {
  number: 'FA-LV-1', issueDate: '2026-07-14', dueDate: '2026-08-13',
  typeCode: '380', currency: 'EUR', businessProcessType: 'S1',
  seller: { name: 'V', address: { countryCode: 'FR' } },
  buyer: { name: 'A', address: { countryCode: 'FR' } },
  lines: [{ id: '1', name: 'S', quantity: '1', unitCode: 'C62', unitPrice: '100.00', vatCategory: 'S', vatRate: '20.00' }],
}

describe('ledger verification (e2e)', () => {
  let db: TestDb
  let redis: TestRedis
  let app: INestApplication
  let ownerPool: pg.Pool
  let appPool: pg.Pool
  let tenantId: string
  let token: string
  let invoiceId: string

  beforeAll(async () => {
    ;[db, redis] = await Promise.all([startTestDb(), startTestRedis()])
    app = await createTestApp(db.appUrl, { host: redis.host, port: redis.port })
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    appPool = new pg.Pool({ connectionString: db.appUrl })
    ;({ tenantId, token } = await seedTenantWithKey(ownerPool, 'LV'))
    invoiceId = await seedGeneratedInvoice(appPool, tenantId, input)
  })
  afterAll(async () => {
    await appPool.end(); await ownerPool.end()
    await app.close(); await Promise.all([db.stop(), redis.stop()])
  })

  it('returns the sealed events with a valid integrity verdict', async () => {
    const res = await request(app.getHttpServer())
      .get(`/invoices/${invoiceId}/ledger`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(res.body.integrity.valid).toBe(true)
    expect(res.body.events.length).toBeGreaterThanOrEqual(1)
    expect(res.body.events[0]).toMatchObject({ seq: 1, toStatus: 'deposee' })
    expect(res.body.events[0].hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('cross-checks: the DB-sealed hash equals the TS recompute', async () => {
    // La vérif Node (verifyInvoiceEvents) recalcule le hash à partir du prev_hash
    // stocké ; integrity.valid=true prouve DB(pgcrypto) == Node(node:crypto).
    const res = await request(app.getHttpServer())
      .get(`/invoices/${invoiceId}/ledger`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(res.body.integrity).toEqual({ valid: true, length: res.body.events.length })
  })

  it('detects owner-side tampering of an event field (hash-mismatch)', async () => {
    // Altération HORS application (accès propriétaire) : le hash ne correspond plus.
    await ownerPool.query(
      "UPDATE invoice_status_events SET actor = 'tampered' WHERE invoice_id = $1 AND seq = 1",
      [invoiceId],
    )
    const res = await request(app.getHttpServer())
      .get(`/invoices/${invoiceId}/ledger`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(res.body.integrity).toMatchObject({ valid: false, brokenAtSeq: 1, reason: 'hash-mismatch' })
  })

  it('404 for an unknown invoice (anti-leak)', async () => {
    await request(app.getHttpServer())
      .get('/invoices/00000000-0000-0000-0000-000000000000/ledger')
      .set('Authorization', `Bearer ${token}`)
      .expect(404)
  })
})
```
> `seedGeneratedInvoice` produit l'événement `deposee` scellé (seq 1) ; la chaîne tenant multi-maillons est déjà couverte par `ledger-sealing.e2e` (Task 2). Le cross-check DB↔Node est ici prouvé par `integrity.valid === true` (la vérif Node recalcule à partir du `prev_hash` stocké par pgcrypto).

Run: `pnpm --filter @factelec/api test -- ledger-verification` → PASS.

- [ ] **Step 5 : Gate + commit**

```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): vérification d'intégrité du journal scellé et endpoint GET /invoices/:id/ledger"
```
Expected: PASS, couverture ≥ 90 % (vérif + endpoint couverts ; altération détectée prouvée).

---
### Task 5 : Port d'archivage `ArchiveStore` + implémentation locale write-once

**Files:**
- Create: `apps/api/src/archive/archive-store.port.ts`
- Create: `apps/api/src/archive/local-filesystem-archive-store.ts`
- Create: `apps/api/src/archive/archive.module.ts`
- Modify: `apps/api/src/config/env.ts` (+ `ARCHIVE_DRIVER`, `ARCHIVE_LOCAL_DIR`)
- Modify: `apps/api/tests/unit/env.test.ts` (cas archive)
- Create: `apps/api/tests/unit/local-filesystem-archive-store.test.ts`

**Interfaces:**
- Produces (utilisé par Task 6) :
  - `ARCHIVE_STORE` (Symbol) ; `interface ArchiveStore { put(key, content: Buffer): Promise<ArchivePutResult>; head(key): Promise<ArchiveHead>; get(key): Promise<Buffer> }`.
  - `interface ArchivePutResult { location: string; hash: string; bytes: number; alreadyExisted: boolean }` ; `interface ArchiveHead { exists: boolean; hash?: string; bytes?: number }`.
  - `class ArchiveObjectNotFoundError extends Error` ; `class InvalidArchiveKeyError extends Error`.
  - `LocalFilesystemArchiveStore` (write-once : refus d'écrasement + `chmod 0o444`) ; `ArchiveModule` fournissant/exportant `ARCHIVE_STORE` selon `ARCHIVE_DRIVER` (branche `s3` = throw documenté).

- [ ] **Step 1 : Env (RED puis GREEN)**

Ajouter à `apps/api/tests/unit/env.test.ts` :
```ts
  it('applies archive defaults', () => {
    const env = validateEnv({ DATABASE_URL: 'postgres://u:p@localhost:5432/db' })
    expect(env.ARCHIVE_DRIVER).toBe('local')
    expect(env.ARCHIVE_LOCAL_DIR).toBe('./var/archive')
  })
  it('rejects an unknown ARCHIVE_DRIVER', () => {
    expect(() =>
      validateEnv({ DATABASE_URL: 'postgres://u:p@localhost:5432/db', ARCHIVE_DRIVER: 'ftp' }),
    ).toThrow(/ARCHIVE_DRIVER/)
  })
```
`apps/api/src/config/env.ts` — ajouter à `envSchema` (après les variables de réconciliation) :
```ts
  // ── Archivage à valeur probante (D5) ─────────────────────────────────────
  // 'local' = LocalFilesystemArchiveStore (write-once, dev/test) ; 's3' =
  // adaptateur object-lock Scaleway ACTIVÉ AU DÉPLOIEMENT (non fourni en 2.2).
  ARCHIVE_DRIVER: z.enum(['local', 's3']).default('local'),
  ARCHIVE_LOCAL_DIR: z.string().default('./var/archive'),
```
Run: `pnpm --filter @factelec/api test -- env` → PASS.

- [ ] **Step 2 : Port + implémentation locale (test d'intégration RED)**

`apps/api/tests/unit/local-filesystem-archive-store.test.ts` :
```ts
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ArchiveObjectNotFoundError,
  InvalidArchiveKeyError,
} from '../../src/archive/archive-store.port.js'
import { LocalFilesystemArchiveStore } from '../../src/archive/local-filesystem-archive-store.js'

describe('LocalFilesystemArchiveStore (write-once)', () => {
  let dir: string
  let store: LocalFilesystemArchiveStore
  const key = 'tenant-1/invoice-1/v1.bundle.json'
  const body = Buffer.from('{"hello":"world"}', 'utf8')

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'factelec-archive-'))
    store = new LocalFilesystemArchiveStore(dir)
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('stores, sets read-only perms, and returns a sha256 fingerprint', async () => {
    const res = await store.put(key, body)
    expect(res.alreadyExisted).toBe(false)
    expect(res.bytes).toBe(body.byteLength)
    expect(res.hash).toMatch(/^[0-9a-f]{64}$/)
    const st = await stat(join(dir, key))
    expect(st.mode & 0o777).toBe(0o444) // lecture seule
  })

  it('is WRITE-ONCE: a second put on the same key does NOT overwrite', async () => {
    const res = await store.put(key, Buffer.from('DIFFERENT', 'utf8'))
    expect(res.alreadyExisted).toBe(true)
    // Contenu d'origine intact.
    expect((await store.get(key)).toString('utf8')).toBe('{"hello":"world"}')
  })

  it('head reports existence + fingerprint', async () => {
    expect(await store.head(key)).toMatchObject({ exists: true })
    expect(await store.head('tenant-1/absent')).toEqual({ exists: false })
  })

  it('get throws for an absent object', async () => {
    await expect(store.get('tenant-1/absent')).rejects.toBeInstanceOf(ArchiveObjectNotFoundError)
  })

  it('rejects path-traversal keys', async () => {
    await expect(store.put('../escape', body)).rejects.toBeInstanceOf(InvalidArchiveKeyError)
    await expect(store.put('/abs/olute', body)).rejects.toBeInstanceOf(InvalidArchiveKeyError)
  })
})
```
Run: `pnpm --filter @factelec/api test -- local-filesystem-archive-store` → FAIL (modules absents).

- [ ] **Step 3 : Implémentation (GREEN)**

`apps/api/src/archive/archive-store.port.ts` :
```ts
export const ARCHIVE_STORE = Symbol('ARCHIVE_STORE')

export interface ArchivePutResult {
  location: string
  hash: string // sha256 hex du contenu
  bytes: number
  alreadyExisted: boolean // write-once : true si la clé existait déjà (pas d'écrasement)
}

export interface ArchiveHead {
  exists: boolean
  hash?: string
  bytes?: number
}

// Contrat WORM : put est write-once (ne JAMAIS écraser une clé existante).
// Implémenté localement (dev/test) et — au déploiement — par un adaptateur S3
// object-lock COMPLIANCE (voir D5). Signatures identiques → substituable par env.
export interface ArchiveStore {
  put(key: string, content: Buffer): Promise<ArchivePutResult>
  head(key: string): Promise<ArchiveHead>
  get(key: string): Promise<Buffer>
}

export class ArchiveObjectNotFoundError extends Error {
  constructor(readonly key: string) {
    super(`archive object not found: ${key}`)
    this.name = 'ArchiveObjectNotFoundError'
  }
}
export class InvalidArchiveKeyError extends Error {
  constructor(readonly key: string) {
    super(`invalid archive key: ${key}`)
    this.name = 'InvalidArchiveKeyError'
  }
}
```
`apps/api/src/archive/local-filesystem-archive-store.ts` :
```ts
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, normalize } from 'node:path'
import {
  type ArchiveHead,
  type ArchivePutResult,
  type ArchiveStore,
  ArchiveObjectNotFoundError,
  InvalidArchiveKeyError,
} from './archive-store.port.js'

// Charset autorisé : uuid/hex + séparateurs sûrs (les clés sont construites à
// partir d'UUID et d'empreintes hex — cf. archive-bundle key).
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9/_.:-]*$/

function sha256Hex(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex')
}

export class LocalFilesystemArchiveStore implements ArchiveStore {
  constructor(private readonly baseDir: string) {}

  private resolve(key: string): string {
    // Rejette traversée et chemins absolus ; normalize ne doit rien changer.
    if (!SAFE_KEY.test(key) || normalize(key) !== key || key.includes('..')) {
      throw new InvalidArchiveKeyError(key)
    }
    return join(this.baseDir, key)
  }

  async put(key: string, content: Buffer): Promise<ArchivePutResult> {
    const path = this.resolve(key)
    const existing = await stat(path).catch(() => null)
    if (existing) {
      // WRITE-ONCE : ne pas écraser ; retourner l'empreinte existante.
      const cur = await readFile(path)
      return { location: path, hash: sha256Hex(cur), bytes: cur.byteLength, alreadyExisted: true }
    }
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, { flag: 'wx' }) // wx : échoue si la clé apparaît entre-temps
    await chmod(path, 0o444) // lecture seule (immuabilité locale, simulacre WORM)
    return { location: path, hash: sha256Hex(content), bytes: content.byteLength, alreadyExisted: false }
  }

  async head(key: string): Promise<ArchiveHead> {
    const path = this.resolve(key)
    const st = await stat(path).catch(() => null)
    if (!st) return { exists: false }
    const cur = await readFile(path)
    return { exists: true, hash: sha256Hex(cur), bytes: cur.byteLength }
  }

  async get(key: string): Promise<Buffer> {
    const path = this.resolve(key)
    const buf = await readFile(path).catch(() => null)
    if (!buf) throw new ArchiveObjectNotFoundError(key)
    return buf
  }
}
```
`apps/api/src/archive/archive.module.ts` :
```ts
import { Global, Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { EnvConfig } from '../config/env.js'
import { ARCHIVE_STORE, type ArchiveStore } from './archive-store.port.js'
import { LocalFilesystemArchiveStore } from './local-filesystem-archive-store.js'

// Sélection du driver d'archivage par env (D5). En 2.2 seul 'local' est câblé ;
// 's3' (object-lock Scaleway) est ACTIVÉ AU DÉPLOIEMENT → throw explicite tant
// que l'adaptateur n'est pas fourni (branche testée, une ligne).
@Global()
@Module({
  providers: [
    {
      provide: ARCHIVE_STORE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvConfig, true>): ArchiveStore => {
        const driver = config.get('ARCHIVE_DRIVER', { infer: true })
        if (driver === 's3') {
          throw new Error(
            "ARCHIVE_DRIVER='s3' : adaptateur S3 object-lock activé au déploiement (non fourni en 2.2)",
          )
        }
        return new LocalFilesystemArchiveStore(config.get('ARCHIVE_LOCAL_DIR', { infer: true }))
      },
    },
  ],
  exports: [ARCHIVE_STORE],
})
export class ArchiveModule {}
```
Run: `pnpm --filter @factelec/api test -- local-filesystem-archive-store` → PASS.
> **Couverture de la branche `s3`** : ajouter un test unitaire ciblé du factory (`archive.module.test.ts` ou dans le fichier ci-dessus) instanciant le provider avec un `ConfigService` stub renvoyant `ARCHIVE_DRIVER='s3'` et asservissant le `throw` — garde la branche à 100 % sans écrire d'adaptateur S3.

- [ ] **Step 4 : Gate + commit**

```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): port d'archivage ArchiveStore et implémentation locale write-once"
```
Expected: PASS, couverture ≥ 90 % (store + branche driver couverts ; adaptateur S3 non écrit → rien à exclure).

---
### Task 6 : Bundle d'archive + service d'archivage câblé au worker (best-effort, idempotent)

**Files:**
- Modify: `apps/api/src/db/schema.ts` (enum `archive_status` + colonnes `invoices.archive*`)
- Create: `apps/api/src/db/migrations/0013_invoice_archive_status.sql` (drizzle) + snapshot + `_journal`
- Create: `apps/api/src/archive/archive-bundle.ts`
- Create: `apps/api/tests/unit/archive-bundle.test.ts`
- Modify: `apps/api/src/invoices/invoices.repository.ts` (`loadAllFormats`, `markArchiveStatus`, `findArchiveState`)
- Create: `apps/api/src/archive/archive.service.ts`
- Modify: `apps/api/src/worker/worker.module.ts` (import `ArchiveModule`, provide `ArchiveService`)
- Modify: `apps/api/src/worker/invoice-generation.processor.ts` (archivage best-effort après `completeGeneration`)
- Modify: `apps/api/tests/e2e/helpers/worker.ts` (override `ARCHIVE_STORE` sur un répertoire temporaire)
- Create: `apps/api/tests/e2e/archive-generation.e2e.test.ts`

**Interfaces:**
- Consumes : `ArchiveStore`/`ARCHIVE_STORE` (Task 5), `SealedEvent`/`loadSealedEventsByInvoice` (Task 4), `loadCanonical` (2.1), processor de génération (2.1).
- Produces (utilisé par Tasks 7-8) :
  - `buildArchiveBundle(input): { key: string; content: Buffer; manifest: ArchiveManifest }` (déterministe).
  - Colonnes `invoices.archive_status` (`pending|archived|failed`, défaut `pending`), `archive_location`, `archive_hash`.
  - `InvoicesRepository.loadAllFormats`, `markArchiveStatus(tenantId, invoiceId, status, location?, hash?)`, `findArchiveState`.
  - `ArchiveService.archiveInvoice(tenantId, invoiceId): Promise<void>` (best-effort : marque `archived`/`failed`, ne relance jamais).

- [ ] **Step 1 : Schéma + migration (archive_status)**

`apps/api/src/db/schema.ts` — ajouter l'enum (après `invoiceLifecycleStatus`) :
```ts
export const archiveStatus = pgEnum('archive_status', ['pending', 'archived', 'failed'])
```
et à la table `invoices` (après `lifecycleStatus`) :
```ts
    archiveStatus: archiveStatus('archive_status').notNull().default('pending'),
    archiveLocation: text('archive_location'),
    archiveHash: text('archive_hash'),
```
Puis :
```bash
pnpm --filter @factelec/api db:generate     # → 0013_<slug>.sql + snapshot + _journal
```
**Renommer** en `0013_invoice_archive_status.sql`, `tag` idx 13 = `"0013_invoice_archive_status"`. Relire : `CREATE TYPE "archive_status"`, `ADD COLUMN "archive_status" ... DEFAULT 'pending'`, `ADD COLUMN "archive_location"`, `ADD COLUMN "archive_hash"`. `factelec_app` a déjà `UPDATE` sur `invoices` (0001) → aucun grant supplémentaire.

- [ ] **Step 2 : Bundle déterministe (pur) — test RED**

`apps/api/tests/unit/archive-bundle.test.ts` :
```ts
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildArchiveBundle, type ArchiveBundleInput } from '../../src/archive/archive-bundle.js'

const input: ArchiveBundleInput = {
  tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  invoiceId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  canonical: { number: 'FA-1', currency: 'EUR' },
  formats: [
    { kind: 'ubl', contentType: 'application/xml', bodyText: '<x/>', bodyBytes: null, byteSize: 4 },
    { kind: 'facturx', contentType: 'application/pdf', bodyText: null, bodyBytes: Buffer.from('PDF'), byteSize: 3 },
  ],
  events: [
    { seq: 1, fromStatus: null, toStatus: 'deposee', actor: 'platform', reason: null, createdAt: '2026-07-14T00:00:00.000Z', prevHash: 'aa', hash: 'bb' },
  ],
}

describe('buildArchiveBundle', () => {
  it('produit une clé déterministe tenant/invoice + empreinte de contenu', () => {
    const b = buildArchiveBundle(input)
    expect(b.key).toBe(
      `${input.tenantId}/${input.invoiceId}/v1.bundle.json`,
    )
    expect(b.manifest.contentHash).toBe(createHash('sha256').update(b.content).digest('hex'))
  })

  it('est déterministe (même entrée → mêmes octets)', () => {
    expect(buildArchiveBundle(input).content.equals(buildArchiveBundle(input).content)).toBe(true)
  })

  it('empreinte chaque format et référence la chaîne scellée', () => {
    const b = buildArchiveBundle(input)
    expect(b.manifest.formats).toHaveLength(2)
    expect(b.manifest.formats[0]).toMatchObject({ kind: 'ubl', byteSize: 4 })
    expect(b.manifest.formats[0].sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(b.manifest.ledger).toEqual([{ seq: 1, hash: 'bb', prevHash: 'aa' }])
  })
})
```
Run: `pnpm --filter @factelec/api test -- archive-bundle` → FAIL.

- [ ] **Step 3 : Bundle (GREEN)**

`apps/api/src/archive/archive-bundle.ts` :
```ts
import { createHash } from 'node:crypto'

export interface BundleFormat {
  kind: string
  contentType: string
  bodyText: string | null
  bodyBytes: Buffer | null
  byteSize: number
}
export interface BundleEvent {
  seq: number
  fromStatus: string | null
  toStatus: string
  actor: string
  reason: string | null
  createdAt: string // ISO
  prevHash: string // hex
  hash: string // hex
}
export interface ArchiveBundleInput {
  tenantId: string
  invoiceId: string
  canonical: unknown
  formats: BundleFormat[]
  events: BundleEvent[]
}
export interface ArchiveManifest {
  version: 'v1'
  tenantId: string
  invoiceId: string
  formats: { kind: string; contentType: string; byteSize: number; sha256: string }[]
  ledger: { seq: number; hash: string; prevHash: string }[]
  contentHash: string // sha256 des octets du bundle (renseigné après sérialisation)
}

function formatBytes(f: BundleFormat): Buffer {
  return f.bodyBytes ?? Buffer.from(f.bodyText ?? '', 'utf8')
}

// Bundle probatoire d'une facture : canonique + 5 formats (base64) + extrait
// scellé du journal + manifeste d'empreintes. Sérialisation à ordre de clés
// FIGÉ → octets déterministes (empreinte reproductible).
export function buildArchiveBundle(input: ArchiveBundleInput): {
  key: string
  content: Buffer
  manifest: ArchiveManifest
} {
  const formats = input.formats.map((f) => ({
    kind: f.kind,
    contentType: f.contentType,
    byteSize: f.byteSize,
    sha256: createHash('sha256').update(formatBytes(f)).digest('hex'),
    base64: formatBytes(f).toString('base64'),
  }))
  const document = {
    version: 'v1' as const,
    tenantId: input.tenantId,
    invoiceId: input.invoiceId,
    canonical: input.canonical,
    formats,
    ledger: input.events,
  }
  const content = Buffer.from(JSON.stringify(document), 'utf8')
  const manifest: ArchiveManifest = {
    version: 'v1',
    tenantId: input.tenantId,
    invoiceId: input.invoiceId,
    formats: formats.map(({ kind, contentType, byteSize, sha256 }) => ({
      kind,
      contentType,
      byteSize,
      sha256,
    })),
    ledger: input.events.map((e) => ({ seq: e.seq, hash: e.hash, prevHash: e.prevHash })),
    contentHash: createHash('sha256').update(content).digest('hex'),
  }
  return { key: `${input.tenantId}/${input.invoiceId}/v1.bundle.json`, content, manifest }
}
```
Run: `pnpm --filter @factelec/api test -- archive-bundle` → PASS.

- [ ] **Step 4 : Repository (formats + statut d'archivage)**

`apps/api/src/invoices/invoices.repository.ts` — ajouter (imports : `invoiceFormats` déjà présent) :
```ts
  async loadAllFormats(
    tenantId: string,
    invoiceId: string,
  ): Promise<
    { kind: string; contentType: string; bodyText: string | null; bodyBytes: Buffer | null; byteSize: number }[]
  > {
    return this.tenant.run(tenantId, async (db) => {
      return db
        .select({
          kind: invoiceFormats.kind,
          contentType: invoiceFormats.contentType,
          bodyText: invoiceFormats.bodyText,
          bodyBytes: invoiceFormats.bodyBytes,
          byteSize: invoiceFormats.byteSize,
        })
        .from(invoiceFormats)
        .where(eq(invoiceFormats.invoiceId, invoiceId))
    })
  }

  async markArchiveStatus(
    tenantId: string,
    invoiceId: string,
    status: 'pending' | 'archived' | 'failed',
    location?: string,
    hash?: string,
  ): Promise<void> {
    await this.tenant.run(tenantId, async (db) => {
      await db
        .update(invoices)
        .set({
          archiveStatus: status,
          archiveLocation: location ?? null,
          archiveHash: hash ?? null,
          updatedAt: new Date(),
        })
        .where(eq(invoices.id, invoiceId))
    })
  }

  async findArchiveState(
    tenantId: string,
    invoiceId: string,
  ): Promise<{ status: string; location: string | null; hash: string | null } | null> {
    return this.tenant.run(tenantId, async (db) => {
      const rows = await db
        .select({
          status: invoices.archiveStatus,
          location: invoices.archiveLocation,
          hash: invoices.archiveHash,
        })
        .from(invoices)
        .where(eq(invoices.id, invoiceId))
        .limit(1)
      return rows[0] ?? null
    })
  }
```

- [ ] **Step 5 : Service d'archivage (best-effort, idempotent)**

`apps/api/src/archive/archive.service.ts` :
```ts
import { Inject, Injectable, Logger } from '@nestjs/common'
// biome-ignore lint/style/useImportType: résolu par Nest via design:paramtypes.
import { InvoicesRepository } from '../invoices/invoices.repository.js'
import { ARCHIVE_STORE, type ArchiveStore } from './archive-store.port.js'
import { buildArchiveBundle, type BundleEvent } from './archive-bundle.js'

@Injectable()
export class ArchiveService {
  private readonly logger = new Logger(ArchiveService.name)

  constructor(
    private readonly repo: InvoicesRepository,
    @Inject(ARCHIVE_STORE) private readonly store: ArchiveStore,
  ) {}

  // Best-effort : n'échoue JAMAIS le flux appelant (génération). Idempotent :
  // write-once + head → un rejeu retombe sur la clé existante sans réécrire.
  async archiveInvoice(tenantId: string, invoiceId: string): Promise<void> {
    try {
      const canonical = await this.repo.loadCanonical(tenantId, invoiceId)
      if (!canonical) return // facture disparue : no-op
      const formats = await this.repo.loadAllFormats(tenantId, invoiceId)
      const sealed = await this.repo.loadSealedEventsByInvoice(tenantId, invoiceId)
      const events: BundleEvent[] = sealed.map((e) => ({
        seq: e.seq,
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        actor: e.actor,
        reason: e.reason,
        createdAt: e.createdAt.toISOString(),
        prevHash: e.prevHash.toString('hex'),
        hash: e.hash.toString('hex'),
      }))
      const bundle = buildArchiveBundle({ tenantId, invoiceId, canonical, formats, events })
      const head = await this.store.head(bundle.key)
      if (head.exists) {
        await this.repo.markArchiveStatus(tenantId, invoiceId, 'archived', bundle.key, head.hash)
        return
      }
      const put = await this.store.put(bundle.key, bundle.content)
      await this.repo.markArchiveStatus(tenantId, invoiceId, 'archived', put.location, put.hash)
    } catch (e) {
      this.logger.error(`archive failed for ${invoiceId}`, e as Error)
      await this.repo
        .markArchiveStatus(tenantId, invoiceId, 'failed')
        .catch((e2) => this.logger.error(`mark archive failed also failed for ${invoiceId}`, e2 as Error))
    }
  }
}
```

- [ ] **Step 6 : Câblage worker + processor**

`apps/api/src/worker/worker.module.ts` — ajouter `ArchiveModule` aux `imports` et `ArchiveService` aux `providers`.
`apps/api/src/worker/invoice-generation.processor.ts` — injecter `ArchiveService` et l'appeler **après** `completeGeneration** (best-effort, jamais bloquant) :
```ts
  constructor(
    private readonly repo: InvoicesRepository,
    @Inject(INVOICE_FORMAT_GENERATOR)
    private readonly generator: InvoiceFormatGenerator,
    private readonly archive: ArchiveService,
  ) {
    super()
  }
```
et à la fin de `process`, après `await this.repo.completeGeneration(tenantId, invoiceId, formats)` :
```ts
    // Archivage à valeur probante (best-effort, découplé de la génération, D6) :
    // les formats sont déjà `generated` et servis ; un échec d'archive laisse
    // archive_status='failed', ré-essayé par la réconciliation (Task 8).
    await this.archive.archiveInvoice(tenantId, invoiceId)
```
> `ArchiveService` a besoin de `InvoicesRepository` (déjà fourni au `WorkerModule` via l'import qui apporte le repo) et de `ARCHIVE_STORE` (`ArchiveModule`). Vérifier que `import { ArchiveService } from '../archive/archive.service.js'` (valeur, pas type-only) est présent pour la DI.

- [ ] **Step 7 : Helper worker + e2e (generated → archived ; échec → failed ; idempotence)**

`apps/api/tests/e2e/helpers/worker.ts` — permettre d'injecter un `ArchiveStore` de test (répertoire temporaire) OU un stub qui throw. Étendre `createTestWorker` avec une option `archiveStore?: ArchiveStore` overridant `ARCHIVE_STORE` :
```ts
  if (opts?.archiveStore) {
    builder.overrideProvider(ARCHIVE_STORE).useValue(opts.archiveStore)
  }
```
`apps/api/tests/e2e/archive-generation.e2e.test.ts` (structure Postgres+Redis+worker via `createTestWorker`, `waitFor`) :
```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { INestApplication, INestApplicationContext } from '@nestjs/common'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ArchiveService } from '../../src/archive/archive.service.js'
import type { ArchiveStore } from '../../src/archive/archive-store.port.js'
import { LocalFilesystemArchiveStore } from '../../src/archive/local-filesystem-archive-store.js'
import { TenantContextService } from '../../src/db/tenant-context.service.js'
import { InvoicesRepository } from '../../src/invoices/invoices.repository.js'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { startTestRedis, type TestRedis } from './helpers/redis.js'
import { seedTenantWithKey } from './helpers/seed.js'
import { createTestWorker, waitFor } from './helpers/worker.js'

const input = {
  number: 'FA-ARCH-1', issueDate: '2026-07-14', dueDate: '2026-08-13',
  typeCode: '380', currency: 'EUR', businessProcessType: 'S1',
  seller: { name: 'V', address: { countryCode: 'FR' } },
  buyer: { name: 'A', address: { countryCode: 'FR' } },
  lines: [{ id: '1', name: 'S', quantity: '1', unitCode: 'C62', unitPrice: '100.00', vatCategory: 'S', vatRate: '20.00' }],
}
// Store qui échoue à l'écriture (simule une indisponibilité d'archivage).
const failingStore: ArchiveStore = {
  put: async () => { throw new Error('archive down') },
  head: async () => ({ exists: false }),
  get: async () => Buffer.alloc(0),
}

async function postInvoice(app: INestApplication, token: string, number: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/invoices')
    .set('Authorization', `Bearer ${token}`)
    .send({ ...input, number })
    .expect(201)
  return res.body.id
}

describe('archive on generation (e2e)', () => {
  let db: TestDb
  let redis: TestRedis
  let app: INestApplication
  let ownerPool: pg.Pool
  let appPool: pg.Pool
  let repo: InvoicesRepository
  let dir: string
  let tenantId: string
  let token: string

  beforeAll(async () => {
    ;[db, redis] = await Promise.all([startTestDb(), startTestRedis()])
    dir = await mkdtemp(join(tmpdir(), 'factelec-arch-e2e-'))
    app = await createTestApp(db.appUrl, { host: redis.host, port: redis.port })
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    appPool = new pg.Pool({ connectionString: db.appUrl })
    repo = new InvoicesRepository(new TenantContextService(appPool as never))
    ;({ tenantId, token } = await seedTenantWithKey(ownerPool, 'ARCH'))
  })
  afterAll(async () => {
    await appPool.end()
    await ownerPool.end()
    await app.close()
    await rm(dir, { recursive: true, force: true })
    await Promise.all([db.stop(), redis.stop()])
  })

  it('archives the invoice after generation (archive_status=archived, bundle written)', async () => {
    const worker = await createTestWorker(db.appUrl, redis, {
      archiveStore: new LocalFilesystemArchiveStore(dir),
    })
    try {
      const id = await postInvoice(app, token, 'FA-ARCH-OK')
      await waitFor(
        async () => (await repo.findArchiveState(tenantId, id))?.status === 'archived',
        { timeoutMs: 20000, intervalMs: 200 },
      )
      const state = await repo.findArchiveState(tenantId, id)
      expect(state?.location).toContain(`${tenantId}/${id}/v1.bundle.json`)
      // Le bundle est réellement écrit et lisible.
      const buf = await new LocalFilesystemArchiveStore(dir).get(`${tenantId}/${id}/v1.bundle.json`)
      const doc = JSON.parse(buf.toString('utf8'))
      expect(doc.version).toBe('v1')
      expect(doc.formats).toHaveLength(5) // 5 formats du socle
      expect(doc.ledger[0]).toMatchObject({ seq: 1, toStatus: 'deposee' })
    } finally {
      await worker.close()
    }
  })

  it('marks archive_status=failed when the store throws, WITHOUT failing generation', async () => {
    const worker = await createTestWorker(db.appUrl, redis, { archiveStore: failingStore })
    try {
      const id = await postInvoice(app, token, 'FA-ARCH-KO')
      // La génération réussit (formats servis) même si l'archivage échoue.
      await waitFor(async () => {
        const r = await ownerPool.query('SELECT status FROM invoices WHERE id = $1', [id])
        return r.rows[0]?.status === 'generated'
      }, { timeoutMs: 20000, intervalMs: 200 })
      await waitFor(
        async () => (await repo.findArchiveState(tenantId, id))?.status === 'failed',
        { timeoutMs: 20000, intervalMs: 200 },
      )
    } finally {
      await worker.close()
    }
  })

  it('is idempotent: re-running archive lands on the existing bundle (no overwrite)', async () => {
    // Génère + archive une facture via un premier passage, puis rejoue le service
    // directement : le head détecte la clé, aucun écrasement, statut inchangé.
    const store = new LocalFilesystemArchiveStore(dir)
    const worker = await createTestWorker(db.appUrl, redis, { archiveStore: store })
    let id: string
    try {
      id = await postInvoice(app, token, 'FA-ARCH-IDEM')
      await waitFor(
        async () => (await repo.findArchiveState(tenantId, id))?.status === 'archived',
        { timeoutMs: 20000, intervalMs: 200 },
      )
    } finally {
      await worker.close()
    }
    const key = `${tenantId}/${id}/v1.bundle.json`
    const before = (await store.get(key)).toString('utf8')
    // Rejeu direct du service (real DB + real store).
    await new ArchiveService(repo, store).archiveInvoice(tenantId, id)
    expect((await store.get(key)).toString('utf8')).toBe(before) // aucun écrasement
    expect((await repo.findArchiveState(tenantId, id))?.status).toBe('archived')
  })
})
```
> `repo.get(tenantId, id)` renvoie le résumé (dont `status` de génération) ; si sa signature diffère, utiliser une requête directe `appPool` sous contexte tenant. Chaque test gère le cycle de vie de SON worker (`createTestWorker`/`worker.close()`) pour éviter la compétition de consommateurs sur la file partagée.

- [ ] **Step 8 : Gate + commit**

```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): bundle d'archive probatoire et archivage best-effort après génération"
```
Expected: PASS, couverture ≥ 90 % (bundle pur 100 % ; archivage + échec + idempotence prouvés).

---
### Task 7 : Export de la Piste d'Audit Fiable (PAF) — `GET /invoices/:id/paf` (JSON + CSV)

**Files:**
- Create: `apps/api/src/ledger/paf.ts` (rendu pur JSON→CSV)
- Create: `apps/api/src/ledger/paf.service.ts`
- Modify: `apps/api/src/ledger/ledger.controller.ts` (`GET /invoices/:id/paf`)
- Modify: `apps/api/src/ledger/ledger.module.ts` (provide `PafService`)
- Create: `apps/api/tests/unit/paf.test.ts`
- Create: `apps/api/tests/e2e/paf-export.e2e.test.ts`

> **Rappel de cadrage (source vérifiée)** : les spécifications externes v3.2 ne définissent **aucun** format normalisé de PAF (constat vérifié — cf. « Sources réglementaires vérifiées »). Le format ci-dessous est une **conception projet** répondant à la spec §4.5 et à l'obligation d'intégrité/authenticité du CGI (art. 289 bis/289 E) — documenté comme tel, sans prétendre à une conformité de schéma DGFiP.

**Interfaces:**
- Consumes : `LedgerVerificationService` (Task 4), `loadSealedEventsByInvoice`/`findArchiveState`/`getLifecycleStatus` (Tasks 4-6), `TenantAuthGuard`.
- Produces :
  - `interface PafDocument { invoiceId; lifecycleStatus: string; integrity: LedgerIntegrity; archive: { status: string; location: string | null; hash: string | null }; events: PafEvent[] }`.
  - `renderPafCsv(doc): string` (pur, RFC 4180 échappement).
  - `PafService.buildPaf(tenantId, invoiceId): Promise<PafDocument | null>` (null = facture inconnue → 404).
  - `GET /invoices/:id/paf?format=json|csv` (dual-auth) : JSON par défaut ; `format=csv` → `text/csv` + `Content-Disposition: attachment`.

- [ ] **Step 1 : Rendu CSV pur (RED)**

`apps/api/tests/unit/paf.test.ts` :
```ts
import { describe, expect, it } from 'vitest'
import { renderPafCsv, type PafDocument } from '../../src/ledger/paf.js'

const doc: PafDocument = {
  invoiceId: 'inv-1',
  lifecycleStatus: 'deposee',
  integrity: { valid: true, length: 1 },
  archive: { status: 'archived', location: 'k', hash: 'abc' },
  events: [
    { seq: 1, fromStatus: null, toStatus: 'deposee', actor: 'platform', reason: null, createdAt: '2026-07-14T00:00:00.000Z', prevHash: 'aa', hash: 'bb' },
    { seq: 2, fromStatus: 'deposee', toStatus: 'en_litige', actor: 'user:x', reason: 'motif; avec, virgule "et" guillemet', createdAt: '2026-07-14T01:00:00.000Z', prevHash: 'bb', hash: 'cc' },
  ],
}

describe('renderPafCsv', () => {
  it('émet un en-tête + une ligne par événement', () => {
    const csv = renderPafCsv(doc)
    const lines = csv.trimEnd().split('\n')
    expect(lines[0]).toBe('seq,from_status,to_status,actor,reason,created_at,prev_hash,hash')
    expect(lines).toHaveLength(3)
    expect(lines[1]).toBe('1,,deposee,platform,,2026-07-14T00:00:00.000Z,aa,bb')
  })

  it('échappe les champs contenant virgule/guillemet/point-virgule (RFC 4180)', () => {
    const csv = renderPafCsv(doc)
    // reason contient , et " → champ entre guillemets, " doublés.
    expect(csv).toContain('"motif; avec, virgule ""et"" guillemet"')
  })
})
```
Run: `pnpm --filter @factelec/api test -- paf` → FAIL.

- [ ] **Step 2 : Rendu CSV pur (GREEN)**

`apps/api/src/ledger/paf.ts` :
```ts
import type { LedgerIntegrity } from './ledger-verification.service.js'

export interface PafEvent {
  seq: number
  fromStatus: string | null
  toStatus: string
  actor: string
  reason: string | null
  createdAt: string
  prevHash: string
  hash: string
}
export interface PafDocument {
  invoiceId: string
  lifecycleStatus: string
  integrity: LedgerIntegrity
  archive: { status: string; location: string | null; hash: string | null }
  events: PafEvent[]
}

// Échappement RFC 4180 : guillemets si le champ contient , " CR ou LF ; " → "".
function csvField(v: string | null): string {
  const s = v ?? ''
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const HEADER = 'seq,from_status,to_status,actor,reason,created_at,prev_hash,hash'

export function renderPafCsv(doc: PafDocument): string {
  const rows = doc.events.map((e) =>
    [
      String(e.seq),
      csvField(e.fromStatus),
      csvField(e.toStatus),
      csvField(e.actor),
      csvField(e.reason),
      csvField(e.createdAt),
      csvField(e.prevHash),
      csvField(e.hash),
    ].join(','),
  )
  return `${[HEADER, ...rows].join('\n')}\n`
}
```
Run: `pnpm --filter @factelec/api test -- paf` → PASS.

- [ ] **Step 3 : Service PAF**

`apps/api/src/ledger/paf.service.ts` :
```ts
import { Injectable } from '@nestjs/common'
// biome-ignore lint/style/useImportType: résolus par Nest via design:paramtypes.
import { InvoicesRepository } from '../invoices/invoices.repository.js'
// biome-ignore lint/style/useImportType: résolus par Nest via design:paramtypes.
import { LedgerVerificationService } from './ledger-verification.service.js'
import type { PafDocument } from './paf.js'

@Injectable()
export class PafService {
  constructor(
    private readonly repo: InvoicesRepository,
    private readonly verification: LedgerVerificationService,
  ) {}

  async buildPaf(tenantId: string, invoiceId: string): Promise<PafDocument | null> {
    const lifecycleStatus = await this.repo.getLifecycleStatus(tenantId, invoiceId)
    if (lifecycleStatus === null) return null
    const [events, archive, integrity] = await Promise.all([
      this.repo.loadSealedEventsByInvoice(tenantId, invoiceId),
      this.repo.findArchiveState(tenantId, invoiceId),
      this.verification.verifyInvoiceEvents(tenantId, invoiceId),
    ])
    return {
      invoiceId,
      lifecycleStatus,
      integrity,
      archive: archive ?? { status: 'pending', location: null, hash: null },
      events: events.map((e) => ({
        seq: e.seq,
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        actor: e.actor,
        reason: e.reason,
        createdAt: e.createdAt.toISOString(),
        prevHash: e.prevHash.toString('hex'),
        hash: e.hash.toString('hex'),
      })),
    }
  }
}
```

- [ ] **Step 4 : Endpoint (contrôleur + module)**

`apps/api/src/ledger/ledger.controller.ts` — injecter `PafService` et ajouter la route (imports : `Query`, `Res`, `type Response` d'express) :
```ts
  @Get(':id/paf')
  @UseGuards(TenantAuthGuard)
  async paf(
    @CurrentTenant() tenantId: string,
    @Param('id') id: string,
    @Query('format') format: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const doc = await this.paf.buildPaf(tenantId, id)
    if (doc === null) {
      throw new NotFoundException(problem(404, ProblemType.notFound, 'Unknown invoice'))
    }
    if (format === 'csv') {
      res.type('text/csv')
      res.setHeader('Content-Disposition', `attachment; filename="paf-${id}.csv"`)
      res.send(renderPafCsv(doc))
      return
    }
    res.json(doc)
  }
```
Ajouter au constructeur du contrôleur `private readonly paf: PafService` et les imports `renderPafCsv` (`./paf.js`), `PafService` (`./paf.service.js`, valeur). `apps/api/src/ledger/ledger.module.ts` — ajouter `PafService` aux `providers`.
> `@Res()` court-circuite la sérialisation Nest (comme `getFormat` de `InvoicesController`) ; les exceptions lancées AVANT `res.send` restent captées par `ProblemDetailsFilter`.

- [ ] **Step 5 : e2e PAF (JSON + CSV, isolation, intégrité)**

`apps/api/tests/e2e/paf-export.e2e.test.ts` (Postgres+Redis ; `seedTenantWithKey` + `seedGeneratedInvoice`) :
```ts
import type { INestApplication } from '@nestjs/common'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { startTestRedis, type TestRedis } from './helpers/redis.js'
import { seedTenantWithKey } from './helpers/seed.js'
import { seedGeneratedInvoice } from './helpers/seed-invoice.js'

const input = {
  number: 'FA-PAF-1', issueDate: '2026-07-14', dueDate: '2026-08-13',
  typeCode: '380', currency: 'EUR', businessProcessType: 'S1',
  seller: { name: 'V', address: { countryCode: 'FR' } },
  buyer: { name: 'A', address: { countryCode: 'FR' } },
  lines: [{ id: '1', name: 'S', quantity: '1', unitCode: 'C62', unitPrice: '100.00', vatCategory: 'S', vatRate: '20.00' }],
}

describe('PAF export (e2e)', () => {
  let db: TestDb; let redis: TestRedis; let app: INestApplication
  let ownerPool: pg.Pool; let appPool: pg.Pool
  let tenantId: string; let token: string; let otherToken: string; let invoiceId: string

  beforeAll(async () => {
    ;[db, redis] = await Promise.all([startTestDb(), startTestRedis()])
    app = await createTestApp(db.appUrl, { host: redis.host, port: redis.port })
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    appPool = new pg.Pool({ connectionString: db.appUrl })
    ;({ tenantId, token } = await seedTenantWithKey(ownerPool, 'PAF'))
    ;({ token: otherToken } = await seedTenantWithKey(ownerPool, 'OTHER'))
    invoiceId = await seedGeneratedInvoice(appPool, tenantId, input)
  })
  afterAll(async () => {
    await appPool.end(); await ownerPool.end()
    await app.close(); await Promise.all([db.stop(), redis.stop()])
  })

  it('returns a JSON PAF with events, integrity and archive state', async () => {
    const res = await request(app.getHttpServer())
      .get(`/invoices/${invoiceId}/paf`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(res.body.invoiceId).toBe(invoiceId)
    expect(res.body.integrity.valid).toBe(true)
    expect(res.body.events[0]).toMatchObject({ seq: 1, toStatus: 'deposee' })
    expect(res.body.archive.status).toMatch(/pending|archived/)
  })

  it('returns a CSV PAF as an attachment', async () => {
    const res = await request(app.getHttpServer())
      .get(`/invoices/${invoiceId}/paf?format=csv`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.headers['content-disposition']).toContain('attachment')
    expect(res.text.split('\n')[0]).toBe('seq,from_status,to_status,actor,reason,created_at,prev_hash,hash')
  })

  it('isolates tenants: another tenant cannot read this PAF (404)', async () => {
    await request(app.getHttpServer())
      .get(`/invoices/${invoiceId}/paf`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404)
  })
})
```
Run: `pnpm --filter @factelec/api test -- paf-export` → PASS.

- [ ] **Step 6 : Gate + commit**

```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): export de la Piste d'Audit Fiable (PAF) JSON et CSV"
```
Expected: PASS, couverture ≥ 90 % (rendu CSV pur 100 % ; endpoint JSON/CSV + isolation prouvés).

---
### Task 8 : Cap de réconciliation / DLQ pour factures poison + reprise d'archivage

**Files:**
- Modify: `apps/api/src/config/env.ts` (+ `GENERATION_MAX_ATTEMPTS_CAP`, `ARCHIVE_RETRY_EVERY_MS`)
- Modify: `apps/api/src/db/schema.ts` (`invoices.reconcileAttempts` + table `invoiceDeadLetters`)
- Create: `apps/api/src/db/migrations/0014_dead_letters.sql` (drizzle) + snapshot + `_journal`
- Create: `apps/api/src/db/migrations/0015_dead_letters_rls.sql` (hand : RLS + grants + SD `find_failed_archives`)
- Modify: `apps/api/src/invoices/invoices.repository.ts` (`bumpReconcileAttempts`, `recordDeadLetter`)
- Modify: `apps/api/src/worker/invoice-reconciliation.service.ts` (cap → DLQ)
- Create: `apps/api/src/worker/archive-retry.service.ts` + `apps/api/src/queue/maintenance.job.ts` (`ARCHIVE_RETRY_JOB`) + `apps/api/src/worker/archive-retry.scheduler.ts`
- Modify: `apps/api/src/worker/maintenance.processor.ts` (branche `ARCHIVE_RETRY_JOB`) + `worker.module.ts`
- Create: `apps/api/tests/e2e/poison-invoice.e2e.test.ts`

**Interfaces:**
- Consumes : `InvoiceReconciliationService` (2.1), `InvoicesRepository`, `ArchiveService` (Task 6), `find_stuck_generation_invoices` (2.1), pattern SD/scheduler maintenance (2.1).
- Produces :
  - `invoices.reconcile_attempts` (int, défaut 0) ; table `invoice_dead_letters` (append-only, RLS, grants `SELECT`+`INSERT`).
  - `InvoicesRepository.bumpReconcileAttempts(tenantId, invoiceId): Promise<number>` ; `recordDeadLetter(tenantId, invoiceId, reason, attempts): Promise<void>`.
  - Sweep de réconciliation **borné** : au-delà de `GENERATION_MAX_ATTEMPTS_CAP` ré-enfilements, la facture passe `failed` + entrée DLQ, **plus jamais ré-enfilée** (poison neutralisé).
  - `ArchiveRetryService.sweepFailedArchives(): Promise<number>` (rejoue `archiveInvoice` sur les `archive_status='failed'`) + job répétable `ARCHIVE_RETRY_JOB`.

- [ ] **Step 1 : Env**

`apps/api/src/config/env.ts` — ajouter :
```ts
  // Cap de ré-enfilements par la réconciliation avant DLQ (facture poison).
  GENERATION_MAX_ATTEMPTS_CAP: z.coerce.number().int().positive().max(50).default(5),
  // Périodicité de la reprise d'archivage (archive_status='failed').
  ARCHIVE_RETRY_EVERY_MS: z.coerce.number().int().positive().default(300_000),
```
(tests d'env optionnels — reprendre le motif de la Task 5 si une couverture de branche l'exige.)

- [ ] **Step 2 : Schéma + migrations (colonne + table DLQ)**

`apps/api/src/db/schema.ts` — à `invoices` (après `archiveHash`) :
```ts
    reconcileAttempts: integer('reconcile_attempts').notNull().default(0),
```
et nouvelle table (après `invoiceStatusEvents`) :
```ts
// DLQ des factures « poison » : génération en échec récurrent, neutralisées par
// la réconciliation (cap). Append-only (grants SELECT/INSERT, migration 0015).
export const invoiceDeadLetters = pgTable(
  'invoice_dead_letters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id').notNull().references(() => invoices.id, { onDelete: 'restrict' }),
    reason: text('reason').notNull(),
    attempts: integer('attempts').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('invoice_dead_letters_tenant_idx').on(t.tenantId)],
)
```
```bash
pnpm --filter @factelec/api db:generate     # → 0014_<slug>.sql + snapshot + _journal
```
**Renommer** en `0014_dead_letters.sql`, `tag` idx 14 = `"0014_dead_letters"`. Relire : `ADD COLUMN "reconcile_attempts" integer DEFAULT 0 NOT NULL`, `CREATE TABLE "invoice_dead_letters"` + FKs (tenant cascade, invoice **restrict**) + index.

`apps/api/src/db/migrations/0015_dead_letters_rls.sql` (hand) :
```sql
-- DLQ tenant-scopée + append-only (SELECT/INSERT seulement, comme le journal).
ALTER TABLE invoice_dead_letters ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE invoice_dead_letters FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON invoice_dead_letters
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT ON invoice_dead_letters TO factelec_app;
--> statement-breakpoint
-- Balayage cross-tenant des archives en échec (reprise d'archivage). Même
-- triptyque SD que find_stuck_generation_invoices (migration 0006).
CREATE OR REPLACE FUNCTION find_failed_archives(p_limit integer)
RETURNS TABLE (tenant_id uuid, id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT tenant_id, id FROM invoices
  WHERE status = 'generated' AND archive_status = 'failed'
  ORDER BY updated_at
  LIMIT p_limit
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION find_failed_archives(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION find_failed_archives(integer) TO factelec_app;
```
Enregistrer 0015 dans `meta/_journal.json` (idx 15, `tag: "0015_dead_letters_rls"`, `breakpoints: true`, sans snapshot).

- [ ] **Step 3 : Repository (cap + DLQ)**

`apps/api/src/invoices/invoices.repository.ts` — ajouter (imports : `invoiceDeadLetters` depuis `../db/schema.js`) :
```ts
  async bumpReconcileAttempts(tenantId: string, invoiceId: string): Promise<number> {
    return this.tenant.run(tenantId, async (db) => {
      const rows = await db
        .update(invoices)
        .set({ reconcileAttempts: sql`${invoices.reconcileAttempts} + 1`, updatedAt: new Date() })
        .where(eq(invoices.id, invoiceId))
        .returning({ n: invoices.reconcileAttempts })
      return rows[0]?.n ?? 0
    })
  }

  async recordDeadLetter(
    tenantId: string,
    invoiceId: string,
    reason: string,
    attempts: number,
  ): Promise<void> {
    await this.tenant.run(tenantId, async (db) => {
      await db.insert(invoiceDeadLetters).values({ tenantId, invoiceId, reason, attempts })
    })
  }
```
> `sql` est importé de `drizzle-orm` (déjà utilisé dans le repository pour le curseur keyset).

- [ ] **Step 4 : Réconciliation bornée (cap → DLQ)**

`apps/api/src/worker/invoice-reconciliation.service.ts` — injecter `InvoicesRepository`, lire le cap, et neutraliser les factures poison. Constructeur :
```ts
  private readonly maxAttemptsCap: number
  constructor(
    @Inject(APP_POOL) private readonly pool: pg.Pool,
    private readonly queue: InvoiceGenerationQueue,
    private readonly repo: InvoicesRepository,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.staleMs = config.get('RECONCILIATION_STALE_MS', { infer: true })
    this.generatingStaleMs = config.get('RECONCILIATION_GENERATING_STALE_MS', { infer: true })
    this.maxAttemptsCap = config.get('GENERATION_MAX_ATTEMPTS_CAP', { infer: true })
  }
```
et la boucle de `sweepStuckGeneration` (le bump n'intervient QUE sur un vrai candidat au ré-enfilement — jamais quand un job vivant existe) :
```ts
    let reenqueued = 0
    let deadLettered = 0
    for (const row of rows) {
      const state = await this.queue.getJobState(row.id)
      if (state === 'failed') {
        await this.queue.removeJob(row.id)
      } else if (state !== undefined) {
        continue // job vivant : ni comptage ni ré-enfilement
      }
      // Candidat réel au ré-enfilement (orpheline ou job failed évincé).
      const attempts = await this.repo.bumpReconcileAttempts(row.tenant_id, row.id)
      if (attempts > this.maxAttemptsCap) {
        // Poison : neutraliser définitivement (find_stuck_* ne retourne plus
        // les `failed`) → plus jamais ré-enfilée.
        await this.repo.markGenerationStatus(row.tenant_id, row.id, 'failed')
        await this.repo.recordDeadLetter(
          row.tenant_id, row.id, 'generation attempts cap exceeded', attempts,
        )
        deadLettered++
        continue
      }
      await this.queue.enqueue(row.tenant_id, row.id)
      reenqueued++
    }
    if (reenqueued > 0 || deadLettered > 0) {
      this.logger.log(
        `reconciliation: ${reenqueued} re-enqueued, ${deadLettered} dead-lettered`,
      )
    }
    return reenqueued
```

- [ ] **Step 5 : Reprise d'archivage (service + job répétable)**

`apps/api/src/queue/maintenance.job.ts` — ajouter `export const ARCHIVE_RETRY_JOB = 'archive-retry'`.
`apps/api/src/worker/archive-retry.service.ts` :
```ts
import { Inject, Injectable, Logger } from '@nestjs/common'
import type pg from 'pg'
import { APP_POOL } from '../db/client.js'
// biome-ignore lint/style/useImportType: ArchiveService résolu par Nest via design:paramtypes.
import { ArchiveService } from '../archive/archive.service.js'

const RETRY_BATCH = 100

@Injectable()
export class ArchiveRetryService {
  private readonly logger = new Logger(ArchiveRetryService.name)
  constructor(
    @Inject(APP_POOL) private readonly pool: pg.Pool,
    private readonly archive: ArchiveService,
  ) {}

  // Rejoue l'archivage des factures generated dont l'archive a échoué. Best-effort
  // et idempotent (archiveInvoice : head write-once). Cross-tenant via SD.
  async sweepFailedArchives(): Promise<number> {
    const { rows } = await this.pool.query<{ tenant_id: string; id: string }>(
      'SELECT tenant_id, id FROM find_failed_archives($1)',
      [RETRY_BATCH],
    )
    for (const row of rows) {
      await this.archive.archiveInvoice(row.tenant_id, row.id)
    }
    if (rows.length > 0) this.logger.log(`archive retry: ${rows.length} invoice(s)`)
    return rows.length
  }
}
```
`apps/api/src/worker/archive-retry.scheduler.ts` — calquer `SessionPurgeScheduler` (2.1) : `@Injectable implements OnApplicationBootstrap`, `@InjectQueue(MAINTENANCE_QUEUE)`, lit `ARCHIVE_RETRY_EVERY_MS`, `upsertJobScheduler('archive-retry-scheduler', { every: this.everyMs }, { name: ARCHIVE_RETRY_JOB })`.
`apps/api/src/worker/maintenance.processor.ts` — injecter `ArchiveRetryService` et ajouter la branche (jamais un second `@Processor`) :
```ts
    if (job.name === ARCHIVE_RETRY_JOB) {
      const n = await this.archiveRetry.sweepFailedArchives()
      this.logger.log(`archive retry sweep: ${n} invoice(s)`)
      return
    }
```
`apps/api/src/worker/worker.module.ts` — ajouter `ArchiveRetryService` + `ArchiveRetryScheduler` aux `providers`.

- [ ] **Step 6 : e2e cap/DLQ (Postgres seul, réconciliation directe déterministe)**

`apps/api/tests/e2e/poison-invoice.e2e.test.ts` :
```ts
import { buildInvoice } from '@factelec/invoice-core'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { InvoiceReconciliationService } from '../../src/worker/invoice-reconciliation.service.js'
import { InvoicesRepository } from '../../src/invoices/invoices.repository.js'
import { TenantContextService } from '../../src/db/tenant-context.service.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'

const input = {
  number: 'FA-POISON-1', issueDate: '2026-07-14', dueDate: '2026-08-13',
  typeCode: '380', currency: 'EUR', businessProcessType: 'S1',
  seller: { name: 'V', address: { countryCode: 'FR' } },
  buyer: { name: 'A', address: { countryCode: 'FR' } },
  lines: [{ id: '1', name: 'S', quantity: '1', unitCode: 'C62', unitPrice: '100.00', vatCategory: 'S', vatRate: '20.00' }],
}
// Config stub : stale=0 (toute facture est « stuck »), cap=2.
const config = {
  get: (k: string) =>
    ({ RECONCILIATION_STALE_MS: 0, RECONCILIATION_GENERATING_STALE_MS: 0, GENERATION_MAX_ATTEMPTS_CAP: 2 })[k],
} as never
// Queue stub : aucune existence de job, capture des enfilements.
const enqueue = vi.fn(async () => {})
const queue = { getJobState: async () => undefined, removeJob: async () => {}, enqueue } as never

describe('poison invoice reconciliation cap → DLQ (e2e)', () => {
  let db: TestDb
  let ownerPool: pg.Pool
  let appPool: pg.Pool
  let repo: InvoicesRepository
  let svc: InvoiceReconciliationService
  let tenantId: string
  let invoiceId: string

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    appPool = new pg.Pool({ connectionString: db.appUrl })
    repo = new InvoicesRepository(new TenantContextService(appPool as never))
    svc = new InvoiceReconciliationService(appPool as never, queue, repo, config)
    tenantId = (await ownerPool.query("INSERT INTO tenants (name) VALUES ('POISON') RETURNING id")).rows[0].id
    // Facture 'received' (stuck) : insertReceived puis vieillissement du created_at.
    ;({ id: invoiceId } = await repo.insertReceived(tenantId, buildInvoice(input)))
    await ownerPool.query("UPDATE invoices SET created_at = now() - interval '1 hour' WHERE id = $1", [invoiceId])
  })
  afterAll(async () => {
    await appPool.end(); await ownerPool.end(); await db.stop()
  })

  it('re-enqueues up to the cap, then dead-letters the poison invoice', async () => {
    await svc.sweepStuckGeneration() // attempts 1 → enqueue
    await svc.sweepStuckGeneration() // attempts 2 → enqueue
    expect(enqueue).toHaveBeenCalledTimes(2)
    await svc.sweepStuckGeneration() // attempts 3 > cap 2 → DLQ, pas d'enqueue
    expect(enqueue).toHaveBeenCalledTimes(2) // inchangé
    // Facture neutralisée : failed + entrée DLQ, plus jamais ré-enfilée.
    const inv = await ownerPool.query('SELECT status FROM invoices WHERE id = $1', [invoiceId])
    expect(inv.rows[0].status).toBe('failed')
    const dl = await ownerPool.query('SELECT reason, attempts FROM invoice_dead_letters WHERE invoice_id = $1', [invoiceId])
    expect(dl.rows).toHaveLength(1)
    expect(dl.rows[0]).toMatchObject({ reason: 'generation attempts cap exceeded', attempts: 3 })
    // Un sweep de plus ne fait plus rien (find_stuck_* ignore les failed).
    await svc.sweepStuckGeneration()
    expect(enqueue).toHaveBeenCalledTimes(2)
  })

  it('keeps invoice_dead_letters APPEND-ONLY for factelec_app (42501)', async () => {
    const client = await appPool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId])
      await expect(
        client.query("UPDATE invoice_dead_letters SET reason = 'x'"),
      ).rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })
})
```
Run: `pnpm --filter @factelec/api test -- poison-invoice` → PASS.
> Vérifier au premier run l'ordre exact des paramètres du constructeur `InvoiceReconciliationService` (pool, queue, repo, config) après la modification du Step 4.

- [ ] **Step 7 : Gate + commit**

```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): cap de réconciliation/DLQ des factures poison et reprise d'archivage"
```
Expected: PASS, couverture ≥ 90 % (cap/DLQ prouvés déterministe ; reprise d'archivage couverte).

---
### Task 9 : CI, documentation, versions — clôture de branche

**Files:**
- Modify: `.github/workflows/ci.yml` (commentaire migrations pgcrypto — le cas échéant)
- Modify: `README.md` (racine) + `apps/api/README.md`
- Modify: `apps/api/package.json` (bump version)

**Interfaces:** Consumes : tout le livrable 2.2. Produces : documentation et CI à jour, gates finales vertes.

- [ ] **Step 1 : CI (aucun changement fonctionnel requis)**

Le runner GitHub a Docker natif ; l'image `postgres:17-alpine` embarque `pgcrypto` (créée par la migration 0010). **Aucun service ni configuration CI supplémentaire.** Mettre à jour, si présent, le commentaire de l'étape de test :
```yaml
      - run: pnpm test          # invoice-core + apps/api (Testcontainers Postgres[pgcrypto] + Redis) + apps/web (jsdom)
```

- [ ] **Step 2 : Vérifier audit + outdated (bloquants) — aucune dépendance ajoutée**

```bash
pnpm install
pnpm run audit:ci
pnpm outdated -r
```
Expected: `audit:ci` exit 0 ; `outdated` **vierge** (ce plan n'a ajouté aucune dépendance — scellement/archivage sur crypto natif + pgcrypto). Si une transitive a bougé indépendamment du plan → politique projet (override si patch, sinon documenter + arbitrer ; jamais de merge avec vuln exploitable).

- [ ] **Step 3 : README (racine + apps/api)**

`README.md` racine — dans l'encadré d'état, ajouter un paragraphe **2.2** (scellement chaîné SHA-256 imposé par la base, vérification d'intégrité, archivage WORM local + port S3 différé, PAF, DLQ) ; **mettre à jour la Feuille de route** — cocher/retirer de la dette différée les entrées **soldées** :
- Scellement/archivage à valeur probante (§4.5) → **résolu** (Tasks 1-7) ; noter honnêtement que le **WORM matériel** dépend de l'adaptateur S3 object-lock activé **au déploiement** (D5).
- Retrait FK cascade du journal (dette 2.1) → **résolu** (Task 1).
- Cap de réconciliation / DLQ factures poison (dette 2.1) → **résolu** (Task 8).
- Conserver/ajouter en différé explicite **2.3+** : **e-reporting Flux 10** (Annexe 6 v1.10 ; plan 2.3), **annuaire Flux 13/14** (swagger annuaire v1.11.0, Annexe 3 ; plan 2.4). **Phase 3** : transmission Peppol des CDV **et** remplacement de la matrice de transitions CDV contre **AFNOR XP Z12-012** (norme payante hors dépôt — BLOQUEUR go-live PDP, D7). **Déploiement** : `CREATE EXTENSION pgcrypto` à confirmer sur Postgres managé Scaleway ; adaptateur `S3ObjectLockArchiveStore` (COMPLIANCE, rétention 10 ans) à fournir + `ARCHIVE_DRIVER=s3`.
- Constat de provenance à consigner : les spécifications externes v3.2 **ne normalisent pas** la PAF/le scellement (relève du CGI) — le format PAF est une conception projet.

`apps/api/README.md` — documenter :
- **Scellement** : journal `invoice_status_events` scellé par la base (trigger `seal_status_event`, `SECURITY DEFINER`, `pg_advisory_xact_lock` par tenant) ; chaîne SHA-256 (`seq`/`prev_hash`/`hash`), genesis dérivé du tenant, `pgcrypto` ; canonicalisation longueur-préfixée (miroir `src/ledger/ledger-hash.ts`) ; immuabilité (grants `SELECT`+`INSERT`, `42501`).
- **Vérification d'intégrité** : `GET /invoices/:id/ledger` (dual-auth) → événements + verdict (`verifyInvoiceEvents`/`verifyTenantChain`) ; altération hors application détectée.
- **Archivage** : port `ArchiveStore` (write-once) ; `LocalFilesystemArchiveStore` (dev/test) ; `ARCHIVE_DRIVER`/`ARCHIVE_LOCAL_DIR` ; **adaptateur S3 object-lock activé au déploiement** (non fourni en 2.2) ; bundle probatoire (canonique + 5 formats + journal scellé + manifeste) archivé best-effort après génération (`archive_status`).
- **PAF** : `GET /invoices/:id/paf?format=json|csv` (conception projet, non normalisée DGFiP — cf. §4.5/CGI).
- **DLQ/poison** : cap `GENERATION_MAX_ATTEMPTS_CAP` → `invoice_dead_letters` (append-only) ; reprise d'archivage (`ARCHIVE_RETRY_EVERY_MS`).
- **Variables d'env** : table + `ARCHIVE_DRIVER`, `ARCHIVE_LOCAL_DIR`, `GENERATION_MAX_ATTEMPTS_CAP`, `ARCHIVE_RETRY_EVERY_MS`.
- **Endpoints** & **compteur de tests** mis à jour.

- [ ] **Step 4 : Bump version + gate finale + commit**

`apps/api/package.json` : `"version": "0.4.0"` (phase 2.2 : scellement + archivage probatoire).
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm test && pnpm run audit:ci && pnpm outdated -r
git add -A
git commit -m "docs(api): documentation scellement/archivage/PAF/DLQ et bump version 0.4.0"
```
Expected: tout vert ; couverture invoice-core 100 %, apps/api ≥ 90 %×4, apps/web ≥ 90 %×4 ; audit:ci 0 ; outdated vierge.

---

## Self-Review (relecture contre la spec §4.5 et le cadrage 2.2)

**1. Couverture de la spec / du cadrage :**
- Scellement (hash SHA-256 chaîné, spec §4.5) → Tasks 1-3 (trigger DB + canonicalisation + hash TS). ✅ (chaînage par tenant, D2 ; imposé par la base, D1)
- Retrait FK cascade (dette 2.1 tracée) → Task 1 (`restrict`). ✅
- Piste d'Audit Fiable exportable (§4.5) → Task 7 (`/paf` JSON+CSV) ; **format = conception projet** (spécs externes ne le normalisent pas — constat vérifié). ✅ (honnêteté documentée)
- Stockage WORM (§4.5) → Task 5-6 (port `ArchiveStore` + local write-once) ; **adaptateur S3 object-lock différé au déploiement** (D5, infra Scaleway). ✅ (testable sans S3 instruit honnêtement)
- Vérification d'intégrité indépendante → Task 4 (recompute Node, détection d'altération). ✅
- Immuabilité non contournée par le scellement (contrainte sécurité) → grants inchangés + trigger SD `search_path` épinglé ; `42501` re-prouvé (Task 2/8). ✅
- DLQ / cap de réconciliation factures poison (dette 2.1 tracée) → Task 8. ✅
- Tests déterministes pour le scellement/hash (vecteurs connus) → Task 3 (vecteur canonique constant + genesis ancré) + cross-check DB↔Node (Task 4). ✅
- RLS / moindre privilège inchangés → toutes tâches (RLS FORCE, `factelec_app` NOBYPASSRLS, SD `search_path=public`, `DATABASE_URL` seul côté app). ✅
- Aucune dépendance ajoutée / audit 0 / outdated vierge → crypto natif + pgcrypto ; Task 9. ✅
- E-reporting (Flux 10) / annuaire (Flux 13/14) → **reportés 2.3/2.4** (D8), sources vérifiées et citées. ✅
- Matrice de transitions CDV (AFNOR XP Z12-012) → **reportée phase 3** (norme hors dépôt, D7). ✅

**2. Placeholders :** aucun « TODO/à compléter » ; chaque étape porte du code réel (y compris les e2e complets d'archivage, PAF, poison). Les seules « notes d'exécution » (propagation d'override de provider `ARCHIVE_STORE`/`REDIS_CONNECTION`, ordre des paramètres du constructeur `InvoiceReconciliationService`, résolution de fonction dans le trigger SD) sont des **vérifications au premier run avec repli**, pas des trous.

**3. Cohérence des types :** `StatusEventForHash`/`SealedEvent`/`BundleEvent`/`PafEvent` partagent les mêmes champs sérialisés (`seq`, `fromStatus`, …, `prevHash`/`hash` en hex) ; `LedgerIntegrity` réutilisé par `LedgerVerificationService`, `PafService`, `PafDocument` ; `ArchiveStore`/`ARCHIVE_STORE`/`ArchivePutResult`/`ArchiveHead` cohérents port ↔ impl locale ↔ service ↔ helper de test ; migrations 0010→0015 séquentielles (0010 FK+pgcrypto, 0011 colonnes, 0012 trigger, 0013 archive_status, 0014 DLQ, 0015 RLS DLQ), chaque enum/table/fonction référencée existe ; canonicalisation PL/pgSQL (`ledger_field`/`seal_status_event`) et TS (`field`/`canonicalizeStatusEvent`) alignées champ par champ (ordre + encodage longueur-préfixé + horodatage ms).

**Écarts / conceptions projet assumés (récapitulatif) :** (a) format PAF = conception projet (aucune norme DGFiP externe, constat vérifié) ; (b) WORM matériel délégué à l'adaptateur S3 au déploiement (local = simulacre write-once testable) ; (c) matrice CDV inchangée (interprétation projet, remplacement AFNOR reporté phase 3) ; (d) archivage best-effort découplé de la génération (D6). Tous documentés et justifiés.

## Amendements possibles à l'exécution (à valider empiriquement)

- **A1** — Résolution de fonction dans le trigger SD : si `SET search_path = public` ne résout pas `digest`/`ledger_field` (selon le schéma d'installation de pgcrypto), schéma-qualifier (`public.digest`, `public.ledger_field`). Vérifier au premier run de `ledger-sealing.e2e`.
- **A2** — `octet_length` (PG) vs `Buffer.byteLength` (Node) : identiques **si** l'encodage base = UTF8 (défaut `postgres:17-alpine`). Le cross-check DB↔Node (Task 4) échoue si l'encodage diverge — sentinelle suffisante.
- **A3** — `overrideProvider(ARCHIVE_STORE)` doit se propager dans `WorkerModule` (helper `createTestWorker`, Task 6) — même mécanique que l'override `REDIS_CONNECTION` (2.1) ; repli : provider `useValue` explicite.
- **A4** — Ordre exact des paramètres du constructeur `InvoiceReconciliationService` après ajout de `repo` (Task 8, Step 4) : aligner l'instanciation directe du test poison.
- **A5** — `ALTER TABLE ... ADD COLUMN ... NOT NULL DEFAULT` (0011/0013/0014) : trivial sur tables vides (pré-production/tests) ; aucun backfill requis.
- **A6** — Les e2e lisent le `status` de génération via `ownerPool` (BYPASSRLS, pas de contexte tenant) plutôt qu'une méthode repository de résumé — indépendant de la signature exacte de `InvoicesService.get`.
- **A7** — Cap DLQ vs `attemptsMade` BullMQ : le cap 2.2 borne les **ré-enfilements par la réconciliation** (orphelines/poison), orthogonal aux `attempts` BullMQ intra-job (`onFailed` 2.1) ; les deux coexistent.

## Execution Handoff

Plan complet et sauvegardé dans `docs/superpowers/plans/2026-07-15-phase2-2-scellement-archivage-probatoire.md`. Deux options d'exécution :
1. **Subagent-Driven (recommandé)** — un subagent frais par tâche, revue Opus entre chaque, itération rapide (aligné sur les plans 1.x/2.1).
2. **Inline** — exécution par lots avec points de contrôle.
