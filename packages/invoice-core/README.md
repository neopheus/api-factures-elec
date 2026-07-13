# @factelec/invoice-core

Bibliothèque pure (sans I/O) du modèle canonique de facture, alignée sur la
norme sémantique EN 16931 et les spécifications externes DGFiP v3.2.

## API publique

Tout ce qui suit est exporté depuis `src/index.ts`.

- `parseInvoiceInput(data: unknown): InvoiceInput` — valide une saisie de facture
  (zod, `invoiceInputSchema`).
- `buildInvoice(input: InvoiceInput): Invoice` — calcule montants de lignes,
  ventilation TVA (groupée par catégorie + taux) et totaux (arrondi demi-supérieur).
- `generateUbl(invoice: Invoice): string` — route **380 → Invoice** / **381 →
  CreditNote** (UBL 2.1), validés dans les tests contre le XSD OASIS (Invoice
  **et** CreditNote) et le Schematron officiel EN 16931
  (`docs/reference/en16931-schematron/`, exécuté en Node pur via saxon-js).
- `generateCreditNote(invoice: Invoice): string` — avoir UBL 2.1 (exposé aussi
  via `generateUbl` pour typeCode 381).
- `generateFluxExtractUbl(invoice: Invoice, profile: 'BASE' | 'FULL'): string` —
  extrait fiscal de flux DGFiP F1 pour la facture **et** l'avoir, validé contre
  les XSD réglementaires (`docs/reglementaire/…/F1_BASE_UBL_2.1`,
  `…/F1_FULL_UBL_2.1`, Invoice et CreditNote). BASE = en-tête sans lignes ; FULL
  = lignes épurées (sans TVA par ligne) — symétrique entre facture et avoir. Sans
  noms de parties ni totaux TTC/à payer (restrictions fiscales de flux). Le
  `cbc:ProfileID` de l'extrait porte le cadre de facturation BT-23
  (`invoice.businessProcessType`), nomenclature fermée de 13 codes imposée par la
  règle de gestion DGFiP G1.02 (Annexe 7 v1.9) : B1, S1, M1, B2, S2, M2, B4, S4,
  M4, S5, S6, B7, S7. Ce champ est obligatoire pour cette fonction, qui lève
  `MissingBusinessProcessTypeError` en son absence.
- `generateCii(invoice: Invoice): string` — CII UN/CEFACT **D16B**, profil
  EN 16931, validé dans les tests contre le XSD D16B vendorisé
  (`docs/reference/cii-d16b/`) et le Schematron officiel EN 16931 CII (SEF
  saxon-js, Node pur). Sert la facture (380) et l'avoir (381).
- `generateFacturX(invoice: Invoice): Promise<Uint8Array>` — **Factur-X
  PDF/A-3** (`@cantoo/pdf-lib`) avec `factur-x.xml` (CII D16B, sortie de
  `generateCii`) embarqué (`AFRelationship=Alternative`), XMP PDF/A-3 +
  Factur-X, `OutputIntent` sRGB. Bytes en mémoire (bibliothèque pure),
  asynchrone (API `@cantoo/pdf-lib`). Couvre la facture (380) et l'avoir (381).
  Page visuelle minimale en v1 (rendu lisible reporté). Conformité PDF/A-3
  formelle vérifiée hors bande par veraPDF
  (`.github/workflows/ci-pdfa.yml`, non bloquant) — voir « Conformité vérifiée
  en tests ».
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
`UnsupportedTypeCodeError` (réservée à la frontière API du plan 1.3 — n'est
plus levée par les générateurs, qui prennent tous en charge 380 et 381),
`MissingBusinessProcessTypeError`, `FluxProfile`.

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
L'appartenance du code est vérifiée (et non sa simple forme) par `isVatexCode()`
contre `VATEX_CODES` (`src/model/vatex.ts` — interne, utilisée par
`invoiceLineInputSchema`/`vatBreakdownSchema`, **non exportée** depuis
`src/index.ts`) : **88 codes** (62 `VATEX-EU-*` + 26 `VATEX-FR-*`), transcrits
de la liste blanche BR-CL-22 du Schematron EN 16931 CII et synchronisés par
test avec le fichier vendorisé (provenance : `docs/reference/vatex/README.md`).

## Conformité vérifiée en tests

- **XSD OASIS UBL 2.1** (Invoice **et** CreditNote, document commercial) — xmllint.
- **Schematron EN 16931** officiel, UBL **et** CII (`validation-1.3.16`,
  ConnectingEurope) — saxon-js, Node pur, aucune JVM ; toute
  `svrl:failed-assert` rend le test rouge.
- **XSD DGFiP F1 BASE/FULL** (extraits de flux, Invoice **et** CreditNote) — xmllint.
- **XSD CII D16B** (`docs/reference/cii-d16b/`, vendorisé — le CII D22B du
  dossier réglementaire DGFiP, restreint au flux, est inadéquat pour valider le
  CII commercial) — xmllint.
- **Tests par propriétés** (fast-check, seedés) sur les invariants du moteur.
- **Factur-X** (`generateFacturX`) — vérifié en Node pur : structure PDF/A-3
  (magic bytes, `OutputIntent`, XMP `pdfaid`/`fx`, trailer `/ID`, XMP miroir de
  DocInfo — `xmp:CreateDate`/`ModifyDate`, `pdf:Producer`, `dc:format`), et
  surtout **le XML embarqué == `generateCii(invoice)` et passe le Schematron
  CII** (helper `doc.getAttachments()` de `@cantoo/pdf-lib`). Génération
  déterministe (DocInfo dérivé de `invoice.issueDate`, `/ID` dérivé d'un sha256
  du XML embarqué) : deux appels sur la même facture produisent des octets
  identiques. Deux limites assumées en v1, toutes deux documentées : **(1)** la
  **conformité PDF/A-3 formelle** (structure complète ISO 19005-3) n'est
  **pas** vérifiable en JS pur ; elle est déléguée à un job CI non bloquant
  (`.github/workflows/ci-pdfa.yml`, déclenché manuellement
  `workflow_dispatch` et automatiquement sur push touchant
  `src/facturx/`/`src/cii/`) qui exécute **veraPDF** (Java) sur un PDF de
  fixture et publie le rapport en artefact. Exécuté manuellement en local sur
  ce fixture (profil PDF/A-3b, veraPDF 1.30.2) : **conforme** — 146/146 règles
  et 258/258 contrôles passés, 0 échec ; le job restant non bloquant, une
  régression future n'empêchera pas la CI principale de passer mais sera
  visible dans le rapport artefact. **(2)** la **page visuelle est minimale**
  (aucun glyphe, donc aucune fonte à embarquer) — le rendu humainement lisible
  de la facture est reporté à un plan ultérieur.
