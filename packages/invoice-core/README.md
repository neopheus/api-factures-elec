# @factelec/invoice-core

Bibliothèque pure (sans I/O) du modèle canonique de facture, alignée sur la
norme sémantique EN 16931 et les spécifications externes DGFiP v3.2.

## API publique

Tout ce qui suit est exporté depuis `src/index.ts`.

- `parseInvoiceInput(data: unknown): InvoiceInput` — valide une saisie de facture
  (zod, `invoiceInputSchema`).
- `buildInvoice(input: InvoiceInput): Invoice` — calcule montants de lignes,
  ventilation TVA (groupée par catégorie + taux) et totaux (arrondi demi-supérieur).
- `validateBusinessRules(invoice: Invoice): RuleViolation[]` — sous-ensemble des
  règles EN 16931 (BR-CO-10/13/14/15/17/25, BR-S-08) ; tableau vide = conforme.
- `generateUbl(invoice: Invoice): string` — document UBL 2.1 Invoice, validé dans
  les tests (`tests/ubl/`) contre le XSD standard OASIS UBL 2.1
  (`docs/reference/ubl-2.1/`).

Schémas zod et types associés, également exportés (`src/model/schema.ts`) :
`invoiceInputSchema` / `InvoiceInput`, `invoiceSchema` / `Invoice`,
`invoiceLineInputSchema` / `InvoiceLineInput`, `invoiceLineSchema` / `InvoiceLine`,
`partySchema` / `Party`, `postalAddressSchema` / `PostalAddress`,
`vatCategorySchema` / `VatCategory`, `vatBreakdownSchema` / `VatBreakdown`,
`totalsSchema` / `Totals`.

## Conventions

- Montants : chaînes à 2 décimales exactement (`"1000.00"`) ; quantités, prix
  unitaires et taux : jusqu'à 4 décimales. Calculs via big.js.
- Les golden files de `tests/golden/` sont la référence de non-régression :
  toute modification doit être relue et volontaire (`UPDATE_GOLDEN=1` ne crée
  que les fichiers absents).

## Validation XSD

Le XML généré par `generateUbl` est validé dans les tests contre le XSD standard
OASIS UBL 2.1 vendorisé (`docs/reference/ubl-2.1/maindoc/UBL-Invoice-2.1.xsd`) :
c'est une validation de forme du document UBL, pas des contraintes DGFiP
spécifiques au flux F1. Les émetteurs de flux DGFiP (extraits fiscaux F1),
validés contre les XSD réglementaires
(`docs/reglementaire/specifications-externes-v3.2/3- XSD_v3.2/`), sont hors
périmètre v1 — voir ci-dessous.

## Hors périmètre v1 (plans suivants)

Émetteurs de flux DGFiP F1 (extraits fiscaux), Factur-X (PDF/A-3 + CII), CII
seul, Schematron EN 16931, remises/charges de pied de facture, acomptes,
lecture de factures entrantes.
