# Factelec

Plateforme agréée (PA/PDP) de facturation électronique française, spécialisée
e-commerce — SaaS multi-tenant visant l'immatriculation DGFiP courant 2027, pour
l'échéance TPE/PME de septembre 2027.

Périmètre cible : e-invoicing B2B domestique (formats du socle, cycle de vie des
statuts), e-reporting DGFiP, annuaire central, archivage à valeur probante 10 ans,
point d'accès Peppol interne. Connecteurs natifs PrestaShop, WooCommerce, Shopify et
API publique pour les systèmes custom.

> **État du projet (15/07/2026) : plans 1.1, 1.2, 1.2bis, 1.3, 1.4, 2.1 et 2.2
> terminés et mergés ; dettes héritées soldées avant chaque plan suivant.**
> `invoice-core` (v0.3.1 — patch BT-9) livre les **formats du socle** : UBL 2.1
> Invoice **et** CreditNote (avoir), extraits de flux DGFiP F1 (facture et
> avoir), CII D16B (avec échéance de paiement BT-9) et Factur-X PDF/A-3 (CII
> embarqué), tous validés XSD + Schematron officiel EN 16931 (Node pur,
> saxon-js — un test canari prouve que le Schematron CII rejette bien un
> document non conforme) ; motifs d'exonération BT-120/121 avec appartenance
> VATEX (décision : liste interne, non exposée par l'API 1.3 — voir
> `packages/invoice-core/README.md`) ; tests par propriétés fast-check.
> Couverture 100 %.
>
> **1.3 — `apps/api` (NestJS 11 ESM)** livre l'**ingestion et la lecture des
> factures** : santé (`/health`, `/health/ready`), config validée zod
> (fail-fast), logs pino masqués, helmet/CORS allowlist ; **Postgres
> multi-tenant** avec RLS **`ENABLE` + `FORCE`** sur les 4 tables (policies
> fail-closed, rôle applicatif `factelec_app` **sans** `BYPASSRLS`) ; **auth
> par clés API Argon2id** (`fk_<prefix>.<secret>`, lookup via fonction
> `SECURITY DEFINER` pour résoudre l'ordre poule/œuf auth-avant-tenant) ;
> `POST /invoices` (validation `invoice-core`, génération **synchrone** des 5
> formats du socle, persistance transactionnelle, idempotence par
> `(tenant_id, number)`) ; lecture tenant-scopée (`GET /invoices`, pagination
> keyset micro-précise, `GET /invoices/:id`, `GET
> /invoices/:id/formats/:format` aux bons `Content-Type`) ; erreurs RFC 9457 ;
> **isolation cross-tenant testée** (DB et HTTP, 404 byte-identique) ; rate
> limiting par IP (429 réel, vérifié en e2e). Dettes 1.3 soldées en tout
> début de plan 1.4 : `createDb` (piège hors-tenant) retiré, `z.url()` (zod
> 4) remplace `z.string().url()` déprécié.
>
> **1.4 — authentification utilisateur, self-service et dashboard**
> livre : **users tenant-scopés** (email global unique, rôles
> `owner`/`admin`/`accountant`/`viewer`) et **sessions serveur httpOnly**
> (jetons opaques 256 bits hash-only, RLS `FORCE` deny-all, expiration
> **absolue** uniquement — pas de renouvellement glissant) avec **CSRF
> double-submit** ; `POST /auth/signup` **self-service transactionnel**
> (fonction `SECURITY DEFINER` unique, création tenant + owner atomique) ;
> `POST/GET /auth/login|me`, `POST /auth/logout` ; **gestion des clés API
> par session** (`POST/GET/DELETE /api-keys`, secret affiché une seule
> fois, révocation immédiate) ; **super admin plateforme minimal**
> (`POST /admin/login`, `GET /admin/tenants`, provisioning **CLI
> uniquement** `pnpm provision:admin`, isolation admin↔tenant prouvée dans
> les deux sens) ; **lecture des factures en dual-auth** (`GET /invoices*`
> accepte clé API **ou** session utilisateur du même tenant — l'ingestion
> `POST /invoices` reste exclusivement clé API) ; **`apps/web`** (Next.js
> 16 App Router, SPA authentifiée par cookie httpOnly, dashboard
> factures/clés API + espace super admin). **414 tests** au total
> (`invoice-core` 129 100 % · `apps/api` 237 ≥ 90 % · `apps/web` 48
> ≥ 90 % sur les 4 métriques). Détail complet : `apps/api/README.md`,
> `apps/web/README.md`.
>
> **2.1 — Workers BullMQ et cycle de vie des statuts (CDV)** livre : **infra
> Redis/BullMQ** (`QueueModule` producteur, connexion paresseuse ; sonde de
> readiness Redis bornée 2 s, `HealthCheckError` propre) ; **ingestion
> asynchrone** — **changement de contrat** vis-à-vis de 1.x :
> `POST /invoices` répond désormais **`201 { status: 'received' }`**
> (enfilement d'un job minimal `{tenantId, invoiceId}`, `jobId = invoiceId`
> pour l'idempotence — **aucun contenu de facture ne transite par Redis**),
> génération **asynchrone** des 5 formats du socle par un **worker BullMQ**
> séparé (`apps/api/src/worker-main.ts`, processus dédié `pnpm start:worker`,
> retries/backoff configurables, statut `generating → generated|failed`) ;
> **réconciliation auto-cicatrisante** (balayage périodique des factures
> `received`/`generating` orphelines, éviction des jobs `failed` épuisés) —
> une fenêtre résiduelle bornée (~15 min, `RECONCILIATION_GENERATING_STALE_MS`)
> subsiste en cas de `SIGTERM` du worker exactement entre marquage
> `generating` et complétion, rattrapée par le balayage suivant ; **cycle de
> vie des statuts CDV** — nomenclature DGFiP 14 statuts (200-213, socle
> obligatoire {200,210,212,213}), machine à états à chronologie monotone
> (**interprétation projet, à durcir contre la norme AFNOR XP Z12-012**,
> aucune matrice de transitions n'étant publiée par la DGFiP), motif
> obligatoire pour `refusee`/`suspendue`, endpoints
> `POST/GET /invoices/:id/status` (rôles `owner`/`admin`/`accountant` + CSRF,
> CAS anti-race → 409 sur changement concurrent, 422 transition invalide) et
> **journal `invoice_status_events` append-only** (immuable par grants
> Postgres — substrat du futur journal à valeur probante, 2.2). Dettes 1.4
> soldées : `last_used_at` des clés API (écrit à l'authentification) et
> purge des sessions expirées (job BullMQ répétable). **512 tests** au total
> (`invoice-core` 129 100 % · `apps/api` 335 à 98.02/94.64/95.91/98.53 %
> (statements/branches/fonctions/lignes) · `apps/web` 48 à
> 100/96.66/100/100 %). Détail complet : `apps/api/README.md`.
>
> **2.2 — Scellement et archivage à valeur probante du journal CDV** livre :
> chaîne SHA-256 **par tenant**, calculée et **imposée par la base** (trigger
> `SECURITY DEFINER`, verrou consultatif par tenant, genesis dérivé du
> tenant, `pgcrypto`) sur le journal `invoice_status_events` (append-only
> depuis 2.1) ; **vérification d'intégrité** indépendante (recompute
> TypeScript pur, miroir exact du PL/pgSQL, endpoint `GET
> /invoices/:id/ledger`) ; **archivage WORM** — port `ArchiveStore`
> write-once + implémentation locale testable (`chmod 0o444`), adaptateur S3
> object-lock **différé à l'activation au déploiement** ; export de la
> **Piste d'Audit Fiable** (`GET /invoices/:id/paf`, JSON/CSV, **conception
> projet non normalisée DGFiP** — aucune spec externe v3.2 ne normalise ce
> format) ; **DLQ** des factures poison (cap de réconciliation
> `GENERATION_MAX_ATTEMPTS_CAP`, `invoice_dead_letters` append-only).
> Dettes soldées : retrait de la FK cascade du journal (`ON DELETE
> RESTRICT`, dette 2.1) et cap de réconciliation/DLQ (dette opérationnelle
> 2.1). **Honnêteté probatoire (limite intrinsèque, non résolue par ce
> plan)** : le scellement est une tamper-evidence contre l'édition/
> suppression/insertion **partielle** d'événements — ce n'est **pas** une
> inviolabilité de la chaîne live : un accès propriétaire peut **tronquer**
> la queue de chaîne (supprimer le dernier maillon laisse `1..n-1` valide)
> ou la **réécrire intégralement de façon cohérente** (genesis dérivé
> publiquement du tenant, donc recalculable) — deux modes intrinsèques à
> tout hash-chain auto-contenu (≠ MAC), détectables uniquement par
> l'**ancrage de tête** dans l'archive WORM externe, effectif seulement une
> fois l'adaptateur S3 object-lock **activé au déploiement**. **617 tests**
> au total (`invoice-core` 129 100 % · `apps/api` 440 à
> 98.11/95.1/96.09/98.48 % (statements/branches/fonctions/lignes) ·
> `apps/web` 48 à 100/96.66/100/100 %). Détail complet : `apps/api/README.md`.
>
> **2.3 — E-reporting DGFiP (Flux 10)** livre : le Flux 10 = transmission au
> PPF de **données d'opérations** (agrégats), **distinct** de l'e-invoicing
> (Flux 1-9) qui transmet des factures. **RÉSOLU de bout en bout : le
> sous-flux 10.3 (B2C domestique)**, transactions agrégées — classification
> par facture (`classifyEreportingOperation`), agrégation BT→TT (date ‖
> devise ‖ catégorie TLB1/TPS1), génération XML XSD-valide (`xmllint`),
> machine à états **300/301** distincte du CDV (statuts internes
> `prepared`/`transmitted` sans code DGFiP → `deposee`=300/`rejetee`=301),
> transmission à blanc optionnelle, cadence par régime TVA (Tableau 13),
> ordonnanceur BullMQ idempotent, acquittements PPF et endpoints de
> consultation dual-auth. **DIFFÉRÉS EXPLICITES (à ne pas surpromettre
> « B2B international livré »)** : 10.1/10.2 B2Bi (classifiées mais non
> émises), TB-3 paiements (10.2/10.4, aucun modèle de capture des
> encaissements), cadres de facturation **mixtes M1/M2/M4** (le modèle
> `Invoice` n'a aucun discriminant biens/services par ligne — une
> ventilation forcée aurait doublé la base/TVA déclarées, donc différée
> plutôt que fabriquée), adaptateurs de transport réels (sftp/as2/as4/api →
> lèvent une erreur explicite, activés au déploiement), push/acquittement
> PPF réel (le service `recordPpfStatus` est la **frontière** applicable,
> exercée directement par les e2e faute de webhook PPF), schematron/contrôles
> sémantiques Annexe 7, chemin RE/rectificatif. **Aucun scellement/signature
> au niveau message** (auth au niveau transport, responsabilité PA — le
> PAF/scellement 2.2 ne s'applique pas ici ; journal e-reporting append-only
> **non scellé**, comportement correct). Validation **XSD structurelle
> uniquement** dans le worker — XSD-valide ≠ conformité sémantique PPF (un
> flux structurellement valide peut être rejeté 301 par le PPF).
> **Interprétations projet résiduelles à confirmer au go-live** : échéances
> « 8h00 » du Tableau 13 modélisées en **UTC** (côté sûr vs heure de Paris),
> fenêtre de rattrapage bornée (`MAX_DUE_PERIODS=2`, un rattrapage plus long
> est un processus d'exploitation manuel), heuristique d'assujettissement de
> l'acheteur (présence SIREN/TVA, faute de champ dédié dans le modèle),
> TT-77 = date d'émission de la facture, SIREN/SIRET sous `schemeId 0002`,
> catégorie par défaut TLB1 si le cadre BT-23 est absent, modèle binaire du
> cycle de vie (Figure 59 DGFiP non extractible). **745 tests** au total
> (`invoice-core` 129 100 % · `apps/api` 568 à 97.87/94.25/95.73/98.31 %
> (statements/branches/fonctions/lignes) · `apps/web` 48 à
> 100/96.66/100/100 %). Détail complet, runbook opérationnel (dont le point
> d'attention slot A2 ci-dessous) et variables d'environnement
> `EREPORTING_*` : `apps/api/README.md`.
>
> **Reprise — prochaine étape : phase 2.4** : annuaire central (Flux 13/14).
> Puis **phase 3** : transmission Peppol des statuts CDV, point d'accès
> Peppol interne, remplacement de la matrice de transitions CDV contre la
> norme AFNOR XP Z12-012 (bloqueur go-live PDP) — **ce même bloqueur
> s'applique à l'immatriculation PDP côté e-reporting** (Peppol + matrice
> CDV AFNOR restent la dépendance de mise en production réelle). **Horizon
> 2.x** : journal d'audit des authentifications (distinct du journal CDV).
> **Déploiement** : confirmer `CREATE EXTENSION pgcrypto` sur le Postgres
> managé Scaleway, fournir l'adaptateur `S3ObjectLockArchiveStore`, adaptateurs
> de transmission e-reporting réels (sftp/as2/as4/api), et **`libxml2`/
> `xmllint` sur l'hôte du worker** (NOUVEAU, validation XSD runtime du Flux
> 10 — à ajouter aux prérequis existants pgcrypto/S3/`TRUST_PROXY`). Reports
> explicites détaillés en Feuille de route ci-dessous.
> La conformité PDF/A-3 formelle (veraPDF, Java) tourne en CI optionnelle non bloquante.
> Journal détaillé : `.superpowers/sdd/progress.md` (hors git, local).

## Structure du dépôt

```
apps/
  api/              API REST NestJS (ingestion/lecture des factures, auth utilisateur
                    + clés API + super admin, phases 1.3/1.4) : multi-tenant Postgres
                    RLS, sessions httpOnly + CSRF ; workers BullMQ (génération
                    asynchrone) + cycle de vie des statuts CDV (phase 2.1)
  web/              Dashboard Next.js 16 (phase 1.4) : SPA authentifiée par session
                    serveur, factures/clés API, espace super admin minimal
packages/
  invoice-core/     Bibliothèque pure (sans I/O) : modèle canonique EN 16931,
                    calculs TVA/totaux, règles de cohérence, génération UBL 2.1
docs/
  reglementaire/    Documents officiels DGFiP/Peppol + spécifications externes v3.2
                    (XSD, formats sémantiques, OpenAPI annuaire)
  superpowers/      Spec de conception et plans d'implémentation
```

L'architecture cible est un monolithe modulaire TypeScript (API NestJS, worker
BullMQ, dashboard Next.js) avec un point d'accès Peppol AS4 auto-hébergé
(phase4/phoss SMP). Voir la spec de conception pour le détail.

## `@factelec/invoice-core`

Cœur métier de la facturation, aligné sur le modèle sémantique EN 16931 :

- **Schémas zod** (`src/model/schema.ts`) : modèle canonique de facture, validation
  structurelle stricte (dates calendaires réelles, montants décimaux à 2 décimales).
- **Monnaie** (`src/model/money.ts`) : arithmétique décimale exacte via big.js,
  arrondi demi-supérieur (round half up).
- **Moteur de calcul** (`src/model/compute.ts`) : `buildInvoice` calcule la
  ventilation TVA et les totaux à partir des lignes.
- **Règles de gestion** (`src/model/rules.ts`) : contrôles de cohérence EN 16931
  (BR-CO-*) et motifs d'exonération BT-120/121 (BR-{E,AE,IC,G,O}-10), signalés en
  `RuleViolation`.
- **Génération UBL 2.1** : `generateUbl` route la facture (380 → Invoice) **et**
  l'avoir (381 → `generateCreditNote`, CreditNote), XML validé dans les tests
  contre le XSD standard OASIS (Invoice **et** CreditNote) **et** le Schematron
  officiel EN 16931 (`validation-1.3.16`, exécuté en Node pur via saxon-js, sans
  JVM).
- **Extraits de flux DGFiP F1** (`src/flux/generate-extract.ts`) : profils BASE
  (en-tête sans lignes) et FULL (lignes épurées), pour la facture **et** l'avoir,
  validés contre les XSD réglementaires
  (`docs/reglementaire/specifications-externes-v3.2/3- XSD_v3.2/`). Le
  `cbc:ProfileID` de l'extrait porte le cadre de facturation BT-23 (règle de
  gestion DGFiP G1.02, nomenclature fermée de 13 codes) ; `generateFluxExtractUbl`
  lève `MissingBusinessProcessTypeError` si `businessProcessType` n'est pas
  renseigné sur la facture.
- **CII D16B** (`src/cii/generate.ts`) : `generateCii` émet le CII UN/CEFACT
  D16B (profil EN 16931) pour la facture et l'avoir, y compris l'échéance de
  paiement BT-9 (`ram:SpecifiedTradePaymentTerms/ram:DueDateDateTime`) quand
  `dueDate` est renseigné, validé XSD D16B vendorisé et Schematron officiel
  EN 16931 CII (Node pur, saxon-js).
- **Factur-X PDF/A-3** (`src/facturx/generate.ts`) : `generateFacturX` produit
  un PDF/A-3 porteur avec le CII (`generateCii`) embarqué en pièce jointe
  (`AFRelationship=Alternative`), XMP PDF/A-3 + Factur-X et `OutputIntent` sRGB.
  Page visuelle minimale en v1 (rendu lisible reporté) ; conformité PDF/A-3
  formelle vérifiée hors bande par veraPDF en CI optionnelle non bloquante
  (`.github/workflows/ci-pdfa.yml`).

La bibliothèque n'effectue aucun accès réseau, base de données ni système de
fichiers (hors tests).

## `@factelec/api`

API REST NestJS 11 (ESM), phases **1.3 + 1.4 + 2.1 + 2.2 + 2.3** : ingestion et
lecture des factures (consommant `@factelec/invoice-core`), authentification
utilisateur (sessions httpOnly + CSRF), signup self-service transactionnel,
gestion des clés API par session, super admin plateforme minimal, **workers
BullMQ de génération asynchrone**, **cycle de vie des statuts CDV** et
**e-reporting DGFiP Flux 10** (10.3 B2C bout-en-bout, machine à états 300/301
distincte, cadence par régime TVA, transmission différée au déploiement).
Multi-tenant Postgres avec Row-Level Security **`ENABLE` + `FORCE`**, double
régime d'auth (clés API Argon2id pour l'ingestion machine, sessions Argon2id
pour le dashboard — lecture des factures acceptant l'un ou l'autre du même
tenant). Génération **asynchrone** des formats du socle (UBL, CII, Factur-X,
extraits de flux) : `POST /invoices` enfile un job minimal (ids only) derrière
le port `InvoiceFormatGenerator` et répond `201 { status: 'received' }` ;
un **worker** (processus séparé, `apps/api/src/worker-main.ts`) le consomme,
génère les formats et persiste, avec retries/backoff et réconciliation
auto-cicatrisante des orphelins (désormais **bornée**, cap + DLQ des
factures poison). Cycle de vie métier CDV (nomenclature DGFiP 14 statuts,
machine à états, journal append-only) distinct du statut de génération ; ce
journal est désormais **scellé** (chaîne SHA-256 par tenant imposée par la
base) et **archivé** (port WORM), avec export PAF — tamper-evidence contre
l'altération/suppression/insertion **partielle**, **pas** une inviolabilité
totale de la chaîne live (troncature de queue et réécriture complète
cohérente hors périmètre du hash-chain seul, cf. `apps/api/README.md`).
Documentation complète — architecture & compromis (ESM +
typecheck tsgo + émission SWC), workers, sécurité multi-tenant et auth,
scellement/archivage/PAF/DLQ détaillés, **e-reporting Flux 10 (périmètre,
runbook opérationnel, différés)**, variables d'environnement,
endpoints, tests, limites — dans
[`apps/api/README.md`](apps/api/README.md).

## `@factelec/web`

Dashboard Next.js 16 (App Router, ESM), phase **1.4** : SPA authentifiée par
session serveur httpOnly (cookie posé par `apps/api`, CSRF double-submit),
consommant `@factelec/api`. Pages factures (pagination keyset, détail,
téléchargement des formats), gestion des clés API (secret affiché une seule
fois), espace super admin minimal (liste des tenants). Aucun SSR/RSC des
données métier, aucune création de facture via l'UI (ingestion = API, clé
API uniquement). Stack pinnée, modèle d'auth, tests & couverture, verdict
tsgo/Next — dans [`apps/web/README.md`](apps/web/README.md).

## Développement

Prérequis : Node.js ≥ 22 (`.nvmrc`), pnpm 10, `xmllint` (libxml2) et Docker
(Postgres **et Redis** de dev/tests `apps/api`, via Testcontainers pour les
e2e — **non requis** pour `apps/web`, dont les tests tournent en jsdom pur).
`xmllint` est requis à **deux titres distincts** : validation XSD
`invoice-core` **en tests uniquement**, et validation XSD e-reporting Flux 10
(`apps/api`) **en runtime** — le worker de génération e-reporting (2.3)
l'invoque à chaque transmission (`ereporting-xsd-validator.ts`, `execFile`),
pas seulement en test. **`libxml2`/`xmllint` est donc désormais un prérequis
de l'hôte de déploiement du worker**, pas seulement de la CI/du poste de dev
(voir « Prérequis pré-production » ci-dessous et `apps/api/README.md`). Le
Schematron EN 16931 officiel s'exécute en **Node pur** (saxon-js, `xslt3`),
sans JVM ; le premier `pnpm test` compile le SEF (~10-20 s), mis en cache
ensuite (répertoire git-ignoré).

```sh
pnpm install
pnpm lint        # Biome (lint + format check) — scaffolding Next (.next/, next-env.d.ts) exclu
pnpm build       # Compilation — DOIT précéder typecheck : invoice-core (tsc) → apps/api
                 # (swc, résout @factelec/invoice-core via son dist/, compile aussi
                 # worker-main.ts) → apps/web (next build, génère next-env.d.ts requis
                 # par son propre typecheck)
pnpm typecheck   # tsc --noEmit sur tous les packages (invoice-core + apps/api : tsgo ; apps/web :
                 # repli typescript@5.9.x local, cf. apps/web/README.md — verdict D6)
pnpm test        # Vitest avec couverture (seuil bloquant : 90 %) — invoice-core + apps/api
                 # (Testcontainers Postgres + Redis, Docker requis, worker bouclé en
                 # process via createTestWorker) + apps/web (jsdom, sans Docker)
```

Base de données **et file** locales d'`apps/api` (Postgres + rôles + RLS,
Redis) :

```sh
cd apps/api && docker compose up -d   # démarre Postgres ET Redis
```

Worker de génération (processus séparé, après l'API — cf.
[`apps/api/README.md`](apps/api/README.md) pour l'architecture producteur/consommateur) :

```sh
pnpm --filter @factelec/api start:worker   # build, ou worker:dev pour le watch mode
```

Dashboard en développement (après l'API) :

```sh
pnpm --filter @factelec/web dev   # http://localhost:3001
```

Voir [`apps/api/README.md`](apps/api/README.md) pour les migrations, le
provisioning (tenant self-service ou CLI, super admin CLI uniquement), les
workers BullMQ et le détail des variables d'environnement ;
[`apps/web/README.md`](apps/web/README.md) pour le modèle d'auth et la stack
du dashboard.

Conventions du projet :

- TDD obligatoire : tout code est précédé d'un test vu échouer ; aucun merge si un
  test échoue.
- TypeScript `strict`, ESM uniquement.
- Montants représentés en chaînes décimales à 2 décimales exactement (ex.
  `"1000.00"`).
- Identifiants de code en anglais, messages de commit en français.
- **Dépendances toujours en dernière version stable, 0 vulnérabilité** :
  `pnpm outdated -r` doit rester vierge et `pnpm run audit:ci` ne doit
  remonter **aucune** vulnérabilité applicable (toutes sévérités) — les deux
  sont des étapes **bloquantes** de la CI (`.github/workflows/ci.yml`), au
  même titre que lint/build/typecheck/test. `audit:ci` (`scripts/audit.mjs`)
  remplace `pnpm audit` : ce dernier interroge l'ancien endpoint npm
  `/-/npm/v1/security/audits`, **retiré** par npm (l'outil est cassé, pas nos
  dépendances) — sur pnpm 10.12.1 comme sur pnpm 11.x. Le script interroge
  directement le nouvel endpoint officiel `POST
  /-/npm/v1/security/advisories/bulk` sur l'arbre de dépendances résolu
  (`pnpm ls -r --depth Infinity --json`, transitives comprises), donc les
  overrides `pnpm.overrides` ci-dessous sont naturellement pris en compte.
  Deux overrides tolérés à ce jour
  (`pnpm.overrides` racine) : `@esbuild-kit/core-utils>esbuild` épinglé à
  `^0.25.0`, nécessaire à la chaîne de dépendances de `drizzle-kit` ; et
  `postcss` épinglé à `8.5.19` (CVE-2026-41305, `next@16.2.10` épingle en
  interne une version vulnérable de `postcss`) — **provisoire**, à retirer
  dès qu'une release de `next` absorbe nativement le correctif (vérifier via
  `pnpm why postcss -r` après tout bump de `next`). Un faux-positif de
  `pnpm outdated -r` sur le repli `typescript@5.9.x` volontaire d'`apps/web`
  (verdict D6, cf. `apps/web/README.md`) est neutralisé par
  `pnpm.updateConfig.ignoreDependencies: ["typescript"]` — le pin racine
  `typescript@7.0.2` (tsgo) n'est, lui, jamais ignoré.
- CI GitHub Actions bloquante : `pnpm run audit:ci`, `pnpm outdated -r`, lint,
  build, typecheck, tests — `invoice-core` + `apps/api` (ce dernier via
  Testcontainers Postgres **et Redis**, Docker natif du runner, aucun service
  `redis:`/`postgres:` de job requis) + `apps/web` (jsdom, sans Docker), les
  trois balayés par `pnpm -r`.

## Documentation réglementaire

Les référentiels officiels (guide d'immatriculation PA, spécifications externes
v3.2 avec XSD et Schematron, onboarding Peppol) sont archivés dans
[`docs/reglementaire/`](docs/reglementaire/README.md). Les XSD et l'OpenAPI de
l'annuaire y font foi — ne pas en télécharger d'autres versions.

## Feuille de route

- [x] **1.1 — Socle monorepo + invoice-core** (terminé) : modèle canonique,
      calculs, UBL 2.1 validé XSD.
- [x] **1.2 — Conformité EN 16931 + extraits de flux** (terminé) : montants
      non négatifs et refus de l'avoir 381, exonérations BT-120/121,
      Schematron EN 16931 officiel, extraits de flux DGFiP F1 BASE/FULL,
      tests par propriétés.
- [x] **1.2bis — Formats du socle : CII D16B, Factur-X, avoir** (terminé) :
      UBL CreditNote pour l'avoir 381 (commercial et extrait de flux F1), CII
      D16B (facture et avoir), Factur-X PDF/A-3 (CII embarqué), appartenance
      VATEX (BT-121) et ProfileID BT-23 sur les documents commerciaux.
- [x] **1.3 — API NestJS, auth multi-tenant, ingestion** (terminé) : socle
      NestJS 11 ESM, Postgres multi-tenant RLS `FORCE`, auth clés API
      Argon2id, `POST /invoices` (génération synchrone — **remplacée en
      2.1**), lecture paginée, isolation cross-tenant testée. Détail :
      `apps/api/README.md`.
- [x] **1.4 — Auth utilisateur, self-service, dashboard** (terminé) :
      users tenant-scopés + sessions serveur httpOnly + CSRF double-submit
      (expiration absolue), signup self-service transactionnel, gestion des
      clés API par session, super admin plateforme minimal, lecture des
      factures en dual-auth (clé API ou session), dashboard Next.js 16.
      Détail : `apps/api/README.md`, `apps/web/README.md`.
- [x] **2.1 — Workers BullMQ, ingestion asynchrone, cycle de vie CDV**
      (terminé) : infra Redis/BullMQ, ingestion asynchrone (`POST /invoices`
      → `201 { status: 'received' }`, **changement de contrat** vs 1.x),
      worker de génération dédié (idempotence, retries/backoff,
      réconciliation auto-cicatrisante), machine à états du cycle de vie CDV
      (nomenclature DGFiP 14 statuts, interprétation projet à durcir contre
      AFNOR XP Z12-012), endpoints de transition/historique, journal
      `invoice_status_events` append-only (substrat valeur probante),
      dettes 1.3/1.4 soldées (`last_used_at`, purge des sessions expirées).
      Détail : `apps/api/README.md`.
- [x] **2.2 — Scellement et archivage à valeur probante du journal CDV**
      (terminé) : chaîne SHA-256 **par tenant** imposée par la base (trigger
      `SECURITY DEFINER`, genesis dérivé du tenant, `pgcrypto`) sur le
      journal `invoice_status_events` ; vérification d'intégrité
      indépendante (recompute TypeScript pur, `GET /invoices/:id/ledger`) ;
      archivage WORM (port `ArchiveStore` + implémentation locale
      write-once testable, adaptateur S3 object-lock différé au
      déploiement) ; export de la Piste d'Audit Fiable (`GET
      /invoices/:id/paf`, JSON/CSV, conception projet non normalisée
      DGFiP) ; DLQ des factures poison (cap de réconciliation borné,
      `invoice_dead_letters`) ; retrait de la FK cascade du journal (dette
      2.1). **Limite intrinsèque documentée, non résolue** : le hash-chain
      auto-contenu ne détecte pas la troncature de la queue de chaîne ni une
      réécriture complète cohérente par accès propriétaire — seul l'ancrage
      de tête dans l'archive WORM externe (S3 object-lock, activé au
      déploiement) couvre ces deux modes. Détail : `apps/api/README.md`.
- [x] **2.3 — E-reporting DGFiP (Flux 10)** (terminé) : **RÉSOLU** de bout en
      bout pour le sous-flux **10.3 (B2C domestique)** — classification par
      facture, agrégation des transactions (BT→TT), génération XML XSD-valide
      (`xmllint`), machine à états **300/301** distincte du CDV, cadence par
      régime TVA (Tableau 13 §3.7.7 verbatim), ordonnanceur BullMQ idempotent
      (fenêtre bornée `MAX_DUE_PERIODS=2`), transmission à blanc optionnelle,
      port de transmission (implémentation locale write-once testable),
      acquittements PPF et endpoints de consultation dual-auth. **Différés
      explicites** : 10.1/10.2 B2Bi, TB-3 paiements, cadres mixtes M1/M2/M4,
      adaptateurs de transport réels, push PPF réel, schematron Annexe 7,
      chemin RE. **Aucun scellement message** (auth transport, D3). **Runbook
      opérationnel nouveau** : procédure de déblocage du slot A2 (transmission
      IN rejetée localement qui occupe définitivement son slot), prérequis
      `libxml2`/`xmllint` sur l'hôte du worker, dette de durcissement du rôle
      SD cross-tenant. Détail complet : `apps/api/README.md`.

> **Point de reprise → phase 2.4** : annuaire central (Flux 13/14). Puis
> **phase 3** : transmission Peppol des statuts CDV, point d'accès Peppol
> interne, remplacement de la matrice de transitions CDV contre la norme
> AFNOR XP Z12-012 (bloqueur go-live PDP, s'applique aussi à l'immatriculation
> PDP côté e-reporting).

### Prérequis pré-production / pré-DGFiP

Liste compacte consolidant des points déjà détaillés ci-dessous (dette
reportée) ou dans `apps/api/README.md` : aucun ne bloque le passage en
phase 2.4, mais **tous** doivent être traités avant une exposition réelle
(immatriculation DGFiP, onboarding de tenants en production) :

- **Journal d'audit des authentifications** (connexions, échecs, révocations
  de session — distinct du journal CDV livré en 2.1) — absent à ce jour,
  prévu horizon **2.x**.
- **Vérification email** avant tout onboarding réel — colonne
  `email_verified` prête en base, non contraignante aujourd'hui (rate
  limiting strict sur `/auth/signup` en compensation provisoire).
- **`TRUST_PROXY` + `SESSION_COOKIE_DOMAIN`** à configurer selon la topologie
  réelle de déploiement (load balancer/reverse-proxy devant l'API, partage de
  cookies cross-subdomain dashboard/API) — les défauts conviennent au dev
  local uniquement.
- **Durcissement de la session super admin** (MFA TOTP, allowlist IP, TTL
  dédié réduit) — la session admin 1.4 réutilise le régime standard
  (Argon2id, TTL absolu générique), sans contrôle additionnel → **phase 5**.
- **Validation et unicité du SIREN (KYB)** — seul le format est vérifié (9
  chiffres) ; ni la clé de contrôle (Luhn), ni l'existence, ni l'unicité
  réelle de l'entreprise ne sont vérifiées à ce jour.
- **Machine à états CDV = interprétation projet** (2.1) — à durcir contre la
  norme AFNOR XP Z12-012 avant mise en production réelle (aucune matrice de
  transitions formelle publiée par la DGFiP dans le dépôt). Détail :
  `apps/api/README.md`.
- **Ancrage de tête WORM non effectif** (2.2) — le scellement du journal ne
  détecte pas la troncature de queue ni une réécriture complète cohérente
  par accès propriétaire (limite intrinsèque du hash-chain) ; seul
  l'ancrage de tête dans l'archive WORM **externe** couvre ces deux modes,
  effectif uniquement une fois l'adaptateur S3 object-lock **activé au
  déploiement**. Détail : `apps/api/README.md`.
- **`CREATE EXTENSION pgcrypto`** (2.2) — à confirmer sur le Postgres managé
  Scaleway visé en production (vérifiée uniquement sur `postgres:17-alpine`
  dev/CI à ce jour).
- **`libxml2`/`xmllint` = prérequis de l'hôte du worker** (2.3, **NOUVEAU**) —
  la validation XSD du Flux 10 s'exécute en **runtime** (`execFile`) à chaque
  transmission, pas seulement en test/CI ; à ajouter à côté de
  pgcrypto/S3/`TRUST_PROXY` sur toute image/hôte exécutant le worker. Détail :
  `apps/api/README.md`.
- **Deadlock du slot A2** (2.3, MEDIUM, fail-safe) — une transmission IN née
  `rejetee` (rejet local `REJ_SEMAN`) occupe **définitivement** le slot unique
  (déclarant × flux × période) : après correction des données source, la
  période ne repart pas automatiquement. Procédure manuelle documentée
  (runbook) dans `apps/api/README.md`, en attendant un chantier
  RE/rectificatif ou de libération de slot.
- **Durcissement du rôle SD e-reporting** (2.3) — `find_ereporting_declarants_due`
  expose `(tenant_id, siren, name)` **cross-tenant** au rôle applicatif (comme
  le pool worker=app aujourd'hui) ; à durcir en retirant l'`EXECUTE` au rôle
  HTTP lors du split du rôle worker au déploiement.

Dette explicitement reportée (aucune ne bloque le passage en phase 2.4) :

- **Stripe / abonnements** (modèle commercial self-service, spec §2/§8) →
  **phase 5** (Commercialisation).
- **Vérification email** différée : fournisseur transactionnel non
  provisionné ; colonne `email_verified` prête en base, non contraignante
  aujourd'hui — rate limiting strict sur `/auth/signup` en compensation.
- **Invitation de membres + appartenance multi-tenant** (table `memberships`
  M:N) différées : les users sont mono-tenant en 1.4 (un `owner` par
  signup).
- **Playwright (e2e navigateur)** → **phase 5** (coût CI).
- **Super admin complet** (impersonation tracée, feature flags, MFA TOTP +
  allowlist IP, supervision des files/transmissions) → **phase 5** (spec
  §6/§8) ; le super admin livré en 1.4 est volontairement minimal (login +
  liste des tenants).
- **Pré-prod** : configurer `SESSION_COOKIE_DOMAIN` + `TRUST_PROXY` selon la
  topologie réelle (load balancer / reverse-proxy) ; vérifier `SameSite` et
  le partage de cookies cross-subdomain dashboard/API.
- **Throttle par tenant** (rate limiting actuellement par IP uniquement,
  `apps/api`) — non planifié à ce jour.
- **E-reporting DGFiP (Flux 10) au-delà du 10.3** (2.3) : 10.1/10.2 B2Bi
  (classifiées mais non émises), TB-3 paiements (10.2/10.4, aucune source de
  capture des encaissements), cadres de facturation **mixtes M1/M2/M4**
  (aucun discriminant biens/services par ligne dans le modèle `Invoice` — une
  ventilation forcée aurait doublé la base/TVA déclarées), adaptateurs de
  transport réels (sftp/as2/as4/api), push/acquittement PPF réel (webhook),
  schematron/contrôles sémantiques Annexe 7, chemin RE/rectificatif — tous
  différés, aucun n'est fabriqué. Détail : `apps/api/README.md`.
- **Annuaire central** (Flux 13/14) → **phase 2.4** — aucune consultation
  d'annuaire à ce jour.
- **Adaptateur S3 object-lock réel** (`S3ObjectLockArchiveStore`, Scaleway,
  mode `COMPLIANCE`, rétention 10 ans) → **déploiement** — spécifié (2.2,
  même contrat que `ArchiveStore`) mais non écrit (infra à la main de
  Xavier, non testable sans bucket S3 réel) ; tant qu'il n'est pas fourni,
  l'ancrage de tête (seul rempart contre la troncature/réécriture du
  journal scellé, cf. `apps/api/README.md`) n'est pas effectif.
- **Transmission Peppol des statuts CDV** et apposition automatique des
  transitions par un connecteur/le réseau → **phase 3** (les transitions
  2.1 sont exclusivement pilotées par session utilisateur).
- **Remplacement de la matrice de transitions CDV** contre la norme AFNOR XP
  Z12-012 (payante, hors dépôt) → **phase 3**, **bloqueur go-live PDP** — la
  matrice monotone 2.1 reste une interprétation projet documentée.
- **Horizon 2.x** : journal d'audit persistant des **authentifications**
  (distinct du journal CDV à valeur probante, livré en substrat par 2.1).
- **Migration Factur-X D22B / 1.09** (héritée d'`invoice-core`, plan
  1.2bis) : le socle cible D16B (Factur-X ≤ 1.07.3) par cohérence avec le
  Schematron EN 16931 CII `validation-1.3.16`, lui-même D16B ; Factur-X
  1.08/1.09 sont passés à D22B. Migration différée dans l'attente d'un
  Schematron D22B publié par ConnectingEurope.
