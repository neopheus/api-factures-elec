# Factelec

Plateforme agréée (PA/PDP) de facturation électronique française, spécialisée
e-commerce — SaaS multi-tenant visant l'immatriculation DGFiP courant 2027, pour
l'échéance TPE/PME de septembre 2027.

Périmètre cible : e-invoicing B2B domestique (formats du socle, cycle de vie des
statuts), e-reporting DGFiP, annuaire central, archivage à valeur probante 10 ans,
point d'accès Peppol interne. Connecteurs natifs PrestaShop, WooCommerce, Shopify et
API publique pour les systèmes custom.

> **État du projet (12/07/2026) : plan 1.1 terminé et mergé dans `main`.**
> Le package `invoice-core` (modèle EN 16931, calculs TVA, règles de cohérence,
> UBL 2.1 validé XSD OASIS) est livré : 36 tests, couverture 100 %, revue finale
> « prêt à merger » sans point critique. La conception complète est décrite dans
> [`docs/superpowers/specs/`](docs/superpowers/specs/).
>
> **Reprise des travaux — prochaine étape : rédiger puis exécuter le plan 1.2**
> (« Conformité EN 16931 et extraits de flux » : build + exports map du package,
> montants non négatifs + avoirs 381, exonérations BT-120/121, Schematron
> EN 16931 officiel en tests, émetteurs d'extraits F1 BASE/FULL, tests par
> propriétés). Le plan était en cours de rédaction au moment de la pause — le
> fichier `docs/superpowers/plans/2026-07-12-phase1-2-*.md` n'existe pas encore ;
> le relancer en premier. Factur-X/CII suivront (plan 1.2bis), puis l'API NestJS
> (plan 1.3). Journal de progression détaillé : `.superpowers/sdd/progress.md`
> (hors git, local).

## Structure du dépôt

```
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
  (BR-CO-*), signalés en `RuleViolation`.
- **Génération UBL 2.1** (en cours) : XML validé contre les XSD officiels DGFiP
  (`docs/reglementaire/specifications-externes-v3.2/3- XSD_v3.2/`).

La bibliothèque n'effectue aucun accès réseau, base de données ni système de
fichiers (hors tests).

## Développement

Prérequis : Node.js ≥ 22 (`.nvmrc`), pnpm 10, et `xmllint` (libxml2) pour la
validation XSD dans les tests.

```sh
pnpm install
pnpm lint        # Biome (lint + format check)
pnpm typecheck   # tsc --noEmit sur tous les packages
pnpm test        # Vitest avec couverture (seuil bloquant : 90 %)
```

Conventions du projet :

- TDD obligatoire : tout code est précédé d'un test vu échouer ; aucun merge si un
  test échoue.
- TypeScript `strict`, ESM uniquement.
- Montants représentés en chaînes décimales à 2 décimales exactement (ex.
  `"1000.00"`).
- Identifiants de code en anglais, messages de commit en français.
- CI GitHub Actions bloquante : lint, typecheck, tests.

## Documentation réglementaire

Les référentiels officiels (guide d'immatriculation PA, spécifications externes
v3.2 avec XSD et Schematron, onboarding Peppol) sont archivés dans
[`docs/reglementaire/`](docs/reglementaire/README.md). Les XSD et l'OpenAPI de
l'annuaire y font foi — ne pas en télécharger d'autres versions.

## Feuille de route (phase 1)

1. **1.1 — Socle monorepo + invoice-core** (en cours) : modèle canonique, calculs,
   UBL 2.1 validé XSD.
2. **1.2** — Factur-X/CII, validation Schematron, golden files étendus.
3. **1.3** — API NestJS, auth multi-tenant, ingestion.
4. **1.4** — Dashboard minimal.
