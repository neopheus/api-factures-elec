# Factelec

Plateforme agréée (PA/PDP) de facturation électronique française, spécialisée
e-commerce — SaaS multi-tenant visant l'immatriculation DGFiP courant 2027, pour
l'échéance TPE/PME de septembre 2027.

Périmètre cible : e-invoicing B2B domestique (formats du socle, cycle de vie des
statuts), e-reporting DGFiP, annuaire central, archivage à valeur probante 10 ans,
point d'accès Peppol interne. Connecteurs natifs PrestaShop, WooCommerce, Shopify et
API publique pour les systèmes custom.

> **État du projet (14/07/2026) : plans 1.1, 1.2, 1.2bis, 1.3 et 1.4 terminés
> et mergés ; dettes héritées soldées avant chaque plan suivant.**
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
> **Reprise — prochaine étape : phase 2** (Cœur réglementaire — cycle de
> vie des statuts, scellement/archivage à valeur probante, e-reporting
> DGFiP, adaptateur `QueuedFormatGenerator` derrière le port BullMQ). Les
> reports explicites de 1.4 (Stripe, vérification email, memberships M:N,
> Playwright e2e, super admin complet MFA/impersonation → **phase 5** ;
> BullMQ → **phase 2**) sont détaillés en Feuille de route ci-dessous.
> La conformité PDF/A-3 formelle (veraPDF, Java) tourne en CI optionnelle non bloquante.
> Journal détaillé : `.superpowers/sdd/progress.md` (hors git, local).

## Structure du dépôt

```
apps/
  api/              API REST NestJS (ingestion/lecture des factures, auth utilisateur
                    + clés API + super admin, phases 1.3/1.4) : multi-tenant Postgres
                    RLS, sessions httpOnly + CSRF, génération synchrone des formats
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

API REST NestJS 11 (ESM), phases **1.3 + 1.4** : ingestion et lecture des
factures (consommant `@factelec/invoice-core`), authentification utilisateur
(sessions httpOnly + CSRF), signup self-service transactionnel, gestion des
clés API par session et super admin plateforme minimal. Multi-tenant Postgres
avec Row-Level Security **`ENABLE` + `FORCE`**, double régime d'auth (clés API
Argon2id pour l'ingestion machine, sessions Argon2id pour le dashboard —
lecture des factures acceptant l'un ou l'autre du même tenant), génération
**synchrone** des formats du socle (UBL, CII, Factur-X, extraits de flux)
derrière un port dédié (`InvoiceFormatGenerator`, remplaçable par des workers
BullMQ en **phase 2** sans toucher l'ingestion). Documentation complète —
architecture & compromis (ESM + typecheck tsgo + émission SWC), sécurité
multi-tenant et auth détaillées, variables d'environnement, endpoints, tests,
limites v1 — dans [`apps/api/README.md`](apps/api/README.md).

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

Prérequis : Node.js ≥ 22 (`.nvmrc`), pnpm 10, `xmllint` (libxml2) pour la
validation XSD dans les tests, et Docker (Postgres de dev/tests `apps/api`,
via Testcontainers pour les e2e — **non requis** pour `apps/web`, dont les
tests tournent en jsdom pur). Le Schematron EN 16931 officiel s'exécute en
**Node pur** (saxon-js, `xslt3`), sans JVM ; le premier `pnpm test` compile le
SEF (~10-20 s), mis en cache ensuite (répertoire git-ignoré).

```sh
pnpm install
pnpm lint        # Biome (lint + format check) — scaffolding Next (.next/, next-env.d.ts) exclu
pnpm build       # Compilation — DOIT précéder typecheck : invoice-core (tsc) → apps/api
                 # (swc, résout @factelec/invoice-core via son dist/) → apps/web (next build,
                 # génère next-env.d.ts requis par son propre typecheck)
pnpm typecheck   # tsc --noEmit sur tous les packages (invoice-core + apps/api : tsgo ; apps/web :
                 # repli typescript@5.9.x local, cf. apps/web/README.md — verdict D6)
pnpm test        # Vitest avec couverture (seuil bloquant : 90 %) — invoice-core + apps/api
                 # (Testcontainers, Docker requis) + apps/web (jsdom, sans Docker)
```

Base de données locale d'`apps/api` (Postgres + rôles + RLS) :

```sh
cd apps/api && docker compose up -d
```

Dashboard en développement (après l'API) :

```sh
pnpm --filter @factelec/web dev   # http://localhost:3001
```

Voir [`apps/api/README.md`](apps/api/README.md) pour les migrations, le
provisioning (tenant self-service ou CLI, super admin CLI uniquement) et le
détail des variables d'environnement ; [`apps/web/README.md`](apps/web/README.md)
pour le modèle d'auth et la stack du dashboard.

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
  Testcontainers Postgres, Docker natif du runner) + `apps/web` (jsdom, sans
  Docker), les trois balayés par `pnpm -r`.

## Documentation réglementaire

Les référentiels officiels (guide d'immatriculation PA, spécifications externes
v3.2 avec XSD et Schematron, onboarding Peppol) sont archivés dans
[`docs/reglementaire/`](docs/reglementaire/README.md). Les XSD et l'OpenAPI de
l'annuaire y font foi — ne pas en télécharger d'autres versions.

## Feuille de route (phase 1)

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
      Argon2id, `POST /invoices` (génération synchrone), lecture paginée,
      isolation cross-tenant testée. Détail : `apps/api/README.md`.
- [x] **1.4 — Auth utilisateur, self-service, dashboard** (terminé) :
      users tenant-scopés + sessions serveur httpOnly + CSRF double-submit
      (expiration absolue), signup self-service transactionnel, gestion des
      clés API par session, super admin plateforme minimal, lecture des
      factures en dual-auth (clé API ou session), dashboard Next.js 16.
      Détail : `apps/api/README.md`, `apps/web/README.md`.

> **Point de reprise → phase 2** (Cœur réglementaire) : cycle de vie des
> statuts (accusés de réception, transmission), scellement/archivage à
> valeur probante, e-reporting DGFiP — ainsi que l'adaptateur
> `QueuedFormatGenerator` (BullMQ) derrière le port `InvoiceFormatGenerator`
> existant, sans changement du contrat `POST /invoices`. Puis **3.x** :
> point d'accès Peppol interne.

### Prérequis pré-production / pré-DGFiP

Liste compacte consolidant des points déjà détaillés ci-dessous (dette
reportée) ou dans `apps/api/README.md` : aucun ne bloque le passage en
phase 2, mais **tous** doivent être traités avant une exposition réelle
(immatriculation DGFiP, onboarding de tenants en production) :

- **Journal d'audit des authentifications** (connexions, échecs, révocations
  de session) — absent à ce jour, prévu horizon **2.x**.
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
- **`last_used_at` des clés API** — colonne présente, jamais mise à jour ;
  décision à trancher en **phase 2** : l'écrire depuis la fonction
  `SECURITY DEFINER` `authenticate_api_key` (seule exécutée avant le contexte
  tenant) ou retirer la colonne.

Dette explicitement reportée (aucune ne bloque le passage en phase 2) :

- **Workers BullMQ** (génération asynchrone des formats) — actuellement
  synchrone, derrière le port `InvoiceFormatGenerator` (`apps/api`) →
  **phase 2** ; aucune transmission/cycle de vie en 1.4, donc aucune file
  n'était nécessaire à ce stade.
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
- **`last_used_at`** des clés API non mis à jour (`apps/api`) — décision à
  trancher (écrire ou retirer la colonne).
- **Horizon 2.x** : journal d'audit persistant à valeur probante (rappel
  1.3, toujours hors périmètre).
- **Migration Factur-X D22B / 1.09** (héritée d'`invoice-core`, plan
  1.2bis) : le socle cible D16B (Factur-X ≤ 1.07.3) par cohérence avec le
  Schematron EN 16931 CII `validation-1.3.16`, lui-même D16B ; Factur-X
  1.08/1.09 sont passés à D22B. Migration différée dans l'attente d'un
  Schematron D22B publié par ConnectingEurope.
