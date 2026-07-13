# Factelec

Plateforme agréée (PA/PDP) de facturation électronique française, spécialisée
e-commerce — SaaS multi-tenant visant l'immatriculation DGFiP courant 2027, pour
l'échéance TPE/PME de septembre 2027.

Périmètre cible : e-invoicing B2B domestique (formats du socle, cycle de vie des
statuts), e-reporting DGFiP, annuaire central, archivage à valeur probante 10 ans,
point d'accès Peppol interne. Connecteurs natifs PrestaShop, WooCommerce, Shopify et
API publique pour les systèmes custom.

> **État du projet (13/07/2026) : plans 1.1, 1.2 et 1.2bis terminés et mergés.**
> `invoice-core` (v0.3.0) livre les **formats du socle** : UBL 2.1 Invoice **et**
> CreditNote (avoir), extraits de flux DGFiP F1 (facture et avoir), CII D16B et
> Factur-X PDF/A-3 (CII embarqué), tous validés XSD + Schematron officiel EN 16931
> (Node pur, saxon-js) ; motifs d'exonération BT-120/121 avec appartenance VATEX ;
> tests par propriétés fast-check. Couverture 100 %.
>
> **Reprise — prochaine étape : plan 1.3** (API NestJS, auth multi-tenant, ingestion).
> La conformité PDF/A-3 formelle (veraPDF, Java) tourne en CI optionnelle non bloquante.
> Journal détaillé : `.superpowers/sdd/progress.md` (hors git, local).

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
  D16B (profil EN 16931) pour la facture et l'avoir, validé XSD D16B vendorisé
  et Schematron officiel EN 16931 CII (Node pur, saxon-js).
- **Factur-X PDF/A-3** (`src/facturx/generate.ts`) : `generateFacturX` produit
  un PDF/A-3 porteur avec le CII (`generateCii`) embarqué en pièce jointe
  (`AFRelationship=Alternative`), XMP PDF/A-3 + Factur-X et `OutputIntent` sRGB.
  Page visuelle minimale en v1 (rendu lisible reporté) ; conformité PDF/A-3
  formelle vérifiée hors bande par veraPDF en CI optionnelle non bloquante
  (`.github/workflows/ci-pdfa.yml`).

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
3. **1.2bis — Formats du socle : CII D16B, Factur-X, avoir** (terminé) : UBL
   CreditNote pour l'avoir 381 (commercial et extrait de flux F1), CII D16B
   (facture et avoir), Factur-X PDF/A-3 (CII embarqué), appartenance VATEX
   (BT-121) et ProfileID BT-23 sur les documents commerciaux.
4. **1.3** — API NestJS, auth multi-tenant, ingestion.
5. **1.4** — Dashboard minimal.
