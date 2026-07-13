# @factelec/invoice-core

Bibliothèque pure (sans I/O) du modèle canonique de facture, alignée sur la
norme sémantique EN 16931 et les spécifications externes DGFiP v3.2.

## API publique

Tout ce qui suit est exporté depuis `src/index.ts`.

- `parseInvoiceInput(data: unknown): InvoiceInput` — valide une saisie de facture
  (zod, `invoiceInputSchema`).
- `buildInvoice(input: InvoiceInput): Invoice` — calcule montants de lignes,
  ventilation TVA (groupée par catégorie + taux) et totaux (arrondi demi-supérieur).
- `generateUbl(invoice: Invoice): string` — facture commerciale UBL 2.1 Invoice,
  validée dans les tests contre le XSD OASIS **et** le Schematron officiel EN 16931
  (`docs/reference/en16931-schematron/`, exécuté en Node pur via saxon-js). Lève
  `UnsupportedTypeCodeError` pour un avoir (typeCode 381 — génération CreditNote
  reportée au plan 1.2bis).
- `generateFluxExtractUbl(invoice: Invoice, profile: 'BASE' | 'FULL'): string` —
  extrait fiscal de flux DGFiP F1, validé contre les XSD réglementaires
  (`docs/reglementaire/…/F1_BASE_UBL_2.1`, `…/F1_FULL_UBL_2.1`). BASE = en-tête sans
  lignes ; FULL = lignes épurées (sans TVA par ligne). Sans noms de parties ni
  totaux TTC/à payer (restrictions fiscales de flux). Le `cbc:ProfileID` de
  l'extrait porte le cadre de facturation BT-23 (`invoice.businessProcessType`),
  nomenclature fermée de 13 codes imposée par la règle de gestion DGFiP G1.02
  (Annexe 7 v1.9) : B1, S1, M1, B2, S2, M2, B4, S4, M4, S5, S6, B7, S7. Ce champ
  est obligatoire pour cette fonction, qui lève `MissingBusinessProcessTypeError`
  en son absence.
- `validateBusinessRules(invoice: Invoice): RuleViolation[]` — sous-ensemble EN 16931 :
  BR-CO-10/13/14/15/17/25, BR-{S,Z,E,AE,IC,G,O,AF,AG}-08, et motifs d'exonération
  BR-{E,AE,IC,G,O}-10 (BT-120/121). Tableau vide = conforme.

Schémas zod et types associés, également exportés (`src/model/schema.ts`) :
`invoiceInputSchema` / `InvoiceInput`, `invoiceSchema` / `Invoice`,
`invoiceLineInputSchema` / `InvoiceLineInput`, `invoiceLineSchema` / `InvoiceLine`,
`partySchema` / `Party`, `postalAddressSchema` / `PostalAddress`,
`vatCategorySchema` / `VatCategory`, `vatBreakdownSchema` / `VatBreakdown`,
`totalsSchema` / `Totals`, `businessProcessTypeSchema` / `BusinessProcessType`
(BT-23, cadre de facturation). Erreurs et types dédiés également exportés :
`UnsupportedTypeCodeError`, `MissingBusinessProcessTypeError`, `FluxProfile`.

## Conventions

- Montants : chaînes à 2 décimales exactement (`"1000.00"`) ; quantités, prix
  unitaires et taux : jusqu'à 4 décimales. Calculs via big.js.
- Les golden files de `tests/golden/` sont la référence de non-régression :
  toute modification doit être relue et volontaire (`UPDATE_GOLDEN=1` ne crée
  que les fichiers absents).

## Motifs d'exonération (BT-120 / BT-121)

Les lignes des catégories exonérées (E, AE, K, G, O) portent un code VATEX
(`exemptionReasonCode`, BT-121) et/ou un texte (`exemptionReason`, BT-120),
propagés vers la ventilation TVA et l'UBL (`cac:TaxCategory`). Une ventilation
exonérée sans motif est refusée par les règles et par le Schematron officiel.

## Conformité vérifiée en tests

- **XSD OASIS UBL 2.1** (forme du document commercial) — xmllint.
- **Schematron EN 16931** officiel (`validation-1.3.16`, ConnectingEurope) — saxon-js,
  Node pur, aucune JVM ; toute `svrl:failed-assert` rend le test rouge.
- **XSD DGFiP F1 BASE/FULL** (extraits de flux) — xmllint.
- **Tests par propriétés** (fast-check, seedés) sur les invariants du moteur.
