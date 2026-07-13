# Codes VATEX (motifs d'exonération de TVA, BT-121)

Source machine : la liste blanche **BR-CL-22** du Schematron EN 16931 CII,
vendorisée en tâche 4 —
`docs/reference/en16931-schematron/1.3.16/schematron/codelist/EN16931-CII-codes.sch`
(release `validation-1.3.16`, CEN/TC 434, licence EUPL 1.2 — voir le README du
dossier parent). C'est cette assertion qui fait foi pour la validation
Schematron officielle ; `packages/invoice-core/src/model/vatex.ts` en est une
transcription exhaustive, imposée par égalité stricte dans
`packages/invoice-core/tests/model/vatex.test.ts` (le test relit le `.sch` avec
la regex `/VATEX-[A-Z]{2}-[A-Za-z0-9-]+/g` et échoue au moindre écart).

**Contre-référence documentaire** : liste CEF « VATEX v8 » (2025-10-23,
[ConnectingEurope/eInvoicing-EN16931](https://github.com/ConnectingEurope/eInvoicing-EN16931),
genericode `VATEX-VAT-Exemption-Reason-Code.gc`), qui est la source d'origine
du code-list embarqué dans le Schematron.

## Volumétrie réelle

Le plan de tâche 6 annonçait « 89 codes (61 EU + 28 FR) ». L'extraction
effective de la ligne `BR-CL-22` du `.sch` vendoré (même regex que le test de
synchro, appliquée en Python et en Node pour vérification croisée) donne
**88 codes uniques : 62 `VATEX-EU-*` + 26 `VATEX-FR-*`**. Aucun doublon,
aucune capture parasite (les codes sont séparés par des espaces simples dans
la chaîne XPath de l'assertion, sans tiret de fin ni segment en minuscule) —
la regex n'a donc pas eu besoin d'ajustement. C'est ce compte de 88 qui fait
foi et que `VATEX_CODES` doit égaler.

## Utilisation

`packages/invoice-core/src/model/schema.ts` valide `exemptionReasonCode`
(BT-121, sur `InvoiceLine`/`VatBreakdown`) par appartenance à `VATEX_CODES`
via `isVatexCode()`, et non plus par simple forme regex — un code bien formé
mais absent de la liste (ex. `VATEX-EU-ZZZ99`) est rejeté par
`parseInvoiceInput`.
