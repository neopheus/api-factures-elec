# Factelec

Plateforme agréée (PA/PDP) de facturation électronique française, spécialisée
e-commerce — SaaS multi-tenant visant l'immatriculation DGFiP courant 2027, pour
l'échéance TPE/PME de septembre 2027.

Périmètre cible : e-invoicing B2B domestique (formats du socle, cycle de vie des
statuts), e-reporting DGFiP, annuaire central, archivage à valeur probante 10 ans,
point d'accès Peppol interne. Connecteurs natifs PrestaShop, WooCommerce, Shopify et
API publique pour les systèmes custom.

> **État du projet (13/07/2026) : plans 1.1, 1.2, 1.2bis et 1.3 terminés et
> mergés ; dettes héritées soldées avant le début de 1.3.**
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
> (fail-fast), logs pino redactés, helmet/CORS allowlist ; **Postgres
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
> limiting par IP (429 réel, vérifié en e2e). 111 tests, ~98-99 % de
> couverture (seuil 90 % bloquant). Détail complet, y compris les compromis
> d'architecture (ESM + tsgo + SWC) : `apps/api/README.md`.
>
> **Reprise — prochaine étape : plan 1.4** (dashboard Next.js, self-service
> tenants/clés). Aucune dette héritée hors périmètre 1.3 n'est identifiée à ce
> jour (BT-9 et le canari Schematron CII, seules dettes invoice-core
> recensées, sont soldés ci-dessus) ; la dette propre à `apps/api` (génération
> asynchrone, throttle par tenant, `last_used_at`) est reportée explicitement
> — voir Feuille de route.
> La conformité PDF/A-3 formelle (veraPDF, Java) tourne en CI optionnelle non bloquante.
> Journal détaillé : `.superpowers/sdd/progress.md` (hors git, local).

## Structure du dépôt

```
apps/
  api/              API REST NestJS (ingestion/lecture des factures, phase 1.3) :
                    auth multi-tenant, Postgres RLS, génération synchrone des formats
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

API REST NestJS 11 (ESM), phase **1.3** : ingestion et lecture des factures,
consommant `@factelec/invoice-core`. Multi-tenant Postgres avec Row-Level
Security **`ENABLE` + `FORCE`**, authentification par clés API Argon2id,
génération **synchrone** des formats du socle (UBL, CII, Factur-X, extraits de
flux) derrière un port dédié (`InvoiceFormatGenerator`, remplaçable par des
workers BullMQ en 1.4/2.x sans toucher l'ingestion). Documentation complète —
architecture & compromis (ESM + typecheck tsgo + émission SWC), sécurité
multi-tenant détaillée, variables d'environnement, endpoints, tests,
limites v1 — dans [`apps/api/README.md`](apps/api/README.md).

## Développement

Prérequis : Node.js ≥ 22 (`.nvmrc`), pnpm 10, `xmllint` (libxml2) pour la
validation XSD dans les tests, et Docker (Postgres de dev/tests `apps/api`,
via Testcontainers pour les e2e). Le Schematron EN 16931 officiel s'exécute en
**Node pur** (saxon-js, `xslt3`), sans JVM ; le premier `pnpm test` compile le
SEF (~10-20 s), mis en cache ensuite (répertoire git-ignoré).

```sh
pnpm install
pnpm lint        # Biome (lint + format check)
pnpm build       # Compilation dist/ — DOIT précéder typecheck (apps/api résout
                 # @factelec/invoice-core via son dist/, pas ses sources)
pnpm typecheck   # tsc --noEmit sur tous les packages (invoice-core : tsc ; apps/api : tsgo)
pnpm test        # Vitest avec couverture (seuil bloquant : 90 %)
```

Base de données locale d'`apps/api` (Postgres + rôles + RLS) :

```sh
cd apps/api && docker compose up -d
```

Voir [`apps/api/README.md`](apps/api/README.md) pour les migrations, le
provisioning de tenant et le détail des variables d'environnement.

Conventions du projet :

- TDD obligatoire : tout code est précédé d'un test vu échouer ; aucun merge si un
  test échoue.
- TypeScript `strict`, ESM uniquement.
- Montants représentés en chaînes décimales à 2 décimales exactement (ex.
  `"1000.00"`).
- Identifiants de code en anglais, messages de commit en français.
- **Dépendances toujours en dernière version stable, 0 vulnérabilité** :
  `pnpm outdated -r` doit rester vierge et `pnpm audit` ne doit remonter
  **aucune** vulnérabilité (toutes sévérités) — les deux sont des étapes
  **bloquantes** de la CI (`.github/workflows/ci.yml`), au même titre que
  lint/build/typecheck/test. Le seul override toléré à ce jour :
  `@esbuild-kit/core-utils>esbuild` épinglé à `^0.25.0` (`pnpm.overrides`
  racine), nécessaire à la chaîne de dépendances de `drizzle-kit`.
- CI GitHub Actions bloquante : `pnpm audit`, `pnpm outdated -r`, lint, build,
  typecheck, tests (invoice-core + `apps/api`, ce dernier via Testcontainers
  Postgres — Docker natif du runner, aucun service container additionnel).

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

> **Point de reprise → plan 1.4** : dashboard Next.js + **self-service**
> tenants/clés (remplace le provisioning CLI comme seul chemin de
> création). Puis **2.x** : cycle de vie des statuts (accusés de réception,
> scellement/archivage à valeur probante), e-reporting DGFiP. Puis **3.x** :
> point d'accès Peppol interne.

Dette explicitement reportée (aucune ne bloque 1.4) :

- **Workers BullMQ** (génération asynchrone des formats) — actuellement
  synchrone, derrière le port `InvoiceFormatGenerator` (`apps/api`).
- **Throttle par tenant** (rate limiting actuellement par IP uniquement,
  `apps/api`).
- **`last_used_at`** des clés API non mis à jour (`apps/api`).
- **Migration Factur-X D22B / 1.09** (héritée d'`invoice-core`, plan
  1.2bis) : le socle cible D16B (Factur-X ≤ 1.07.3) par cohérence avec le
  Schematron EN 16931 CII `validation-1.3.16`, lui-même D16B ; Factur-X
  1.08/1.09 sont passés à D22B. Migration différée dans l'attente d'un
  Schematron D22B publié par ConnectingEurope.
