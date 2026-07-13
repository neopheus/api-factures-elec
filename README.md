# Factelec

Plateforme agréée (PA/PDP) de facturation électronique française, spécialisée
e-commerce — SaaS multi-tenant visant l'immatriculation DGFiP courant 2027, pour
l'échéance TPE/PME de septembre 2027.

Périmètre cible : e-invoicing B2B domestique (formats du socle, cycle de vie des
statuts), e-reporting DGFiP, annuaire central, archivage à valeur probante 10 ans,
point d'accès Peppol interne. Connecteurs natifs PrestaShop, WooCommerce, Shopify et
API publique pour les systèmes custom.

> **État du projet (13/07/2026) : plans 1.1 et 1.2 terminés et mergés dans `main`.**
> `invoice-core` (v0.2.0) livre : modèle EN 16931, calculs TVA, règles de cohérence
> et d'exonération (BT-120/121), UBL 2.1 validé XSD OASIS **et** Schematron officiel
> EN 16931 (Node pur, saxon-js), extraits de flux DGFiP F1 BASE/FULL validés XSD,
> build `dist/` + `exports` map, tests par propriétés fast-check. Couverture 100 %.
>
> **Reprise des travaux — prochaine étape : plan 1.2bis** (Factur-X PDF/A-3 + CII,
> CII seul, génération UBL CreditNote pour l'avoir 381), puis le plan 1.3 (API
> NestJS, auth multi-tenant, ingestion). Journal détaillé : `.superpowers/sdd/progress.md`
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
  (BR-CO-*) et motifs d'exonération BT-120/121 (BR-{E,AE,IC,G,O}-10), signalés en
  `RuleViolation`.
- **Génération UBL 2.1** : XML validé dans les tests contre le XSD standard
  OASIS **et** le Schematron officiel EN 16931 (`validation-1.3.16`, exécuté en
  Node pur via saxon-js, sans JVM). Lève `UnsupportedTypeCodeError` pour un avoir
  (typeCode 381 — génération CreditNote reportée au plan 1.2bis).
- **Extraits de flux DGFiP F1** (`src/flux/generate-extract.ts`) : profils BASE
  (en-tête sans lignes) et FULL (lignes épurées), validés contre les XSD
  réglementaires (`docs/reglementaire/specifications-externes-v3.2/3- XSD_v3.2/`).
  Le `cbc:ProfileID` de l'extrait porte le cadre de facturation BT-23 (règle de
  gestion DGFiP G1.02, nomenclature fermée de 13 codes) ; `generateFluxExtractUbl`
  lève `MissingBusinessProcessTypeError` si `businessProcessType` n'est pas
  renseigné sur la facture.

La bibliothèque n'effectue aucun accès réseau, base de données ni système de
fichiers (hors tests).

## Développement

Prérequis : Node.js ≥ 22 (`.nvmrc`), pnpm 10, et `xmllint` (libxml2) pour la
validation XSD dans les tests. Le Schematron EN 16931 officiel s'exécute en
**Node pur** (saxon-js, `xslt3`), sans JVM ; le premier `pnpm test` compile le
SEF (~10-20 s), mis en cache ensuite (répertoire git-ignoré).

```sh
pnpm install
pnpm lint        # Biome (lint + format check)
pnpm typecheck   # tsc --noEmit sur tous les packages
pnpm build       # Compilation dist/ (tsc -p tsconfig.build.json)
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

1. **1.1 — Socle monorepo + invoice-core** (terminé) : modèle canonique, calculs,
   UBL 2.1 validé XSD.
2. **1.2 — Conformité EN 16931 + extraits de flux** (terminé) : montants non
   négatifs et refus de l'avoir 381, exonérations BT-120/121, Schematron EN 16931
   officiel, extraits de flux DGFiP F1 BASE/FULL, tests par propriétés.
3. **1.2bis** — Factur-X (PDF/A-3 + CII), CII seul, génération UBL CreditNote
   pour l'avoir 381.
4. **1.3** — API NestJS, auth multi-tenant, ingestion.
5. **1.4** — Dashboard minimal.
