# Plan 1.2bis — Formats du socle : CII, Factur-X et avoir UBL

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compléter les **formats du socle** de `@factelec/invoice-core` : payer la dette de dédoublonnage des générateurs UBL, livrer l'**avoir UBL 2.1 (CreditNote, typeCode 381)** commercial et en extrait de flux F1, générer le **CII commercial EN 16931 (UN/CEFACT D16B)**, puis le **Factur-X (PDF/A-3 + CII embarqué)** — le tout en restant une bibliothèque pure (bytes en mémoire, aucun I/O hors tests) et en soldant le backlog de revues (CIUS/CustomizationID, ProfileID commercial, appartenance VATEX).

**Architecture:** On conserve le pivot canonique (zod → calcul big.js → générateurs). On (1) extrait un module UBL partagé `src/ubl/common.ts` (dette actée en revue 1.2) ; (2) route `generateUbl` sur 380→Invoice / 381→CreditNote ; (3) étend `generateFluxExtractUbl` à l'avoir F1 ; (4) ajoute `generateCii` (CII D16B) validé XSD D16B + Schematron EN 16931 CII (saxon-js, Node pur) ; (5) ajoute `generateFacturX` (PDF/A-3 pur Node via pdf-lib, XML CII embarqué) avec vérifications structurelles en Node et conformité PDF/A déléguée à veraPDF en étape CI optionnelle ; (6) solde le backlog documentaire ; (7) doc + bump 0.3.0.

**Tech Stack:** Node ≥ 22, TypeScript 7.0.2 (ESM NodeNext), pnpm workspaces, Vitest v8, zod, big.js, xmlbuilder2, Biome, xmllint (libxml2), saxon-js + xslt3 (Schematron → SEF → SVRL), fast-check, **@cantoo/pdf-lib** (PDF/A-3, nouveau).

## Global Constraints

- **TDD obligatoire** : test écrit et vu échouer (RED) avant toute implémentation (GREEN) ; aucun merge si un test échoue (spec §7).
- **Couverture Vitest v8 bloquante à 90 %** sur les 4 métriques (lines/functions/statements/branches). État actuel : 100 %. Ne pas régresser (attention aux branches non exercées — cf. `computeVatBreakdown` : préférer des chemins tous couverts par les fixtures).
- **TypeScript `strict: true`, ESM (`"type": "module"`), Node ≥ 22.** `typescript` pinné **exactement** `7.0.2` (déjà en place, ne pas modifier). `noUncheckedIndexedAccess` est actif.
- `packages/invoice-core/src/` reste une **bibliothèque pure** : aucun I/O réseau/DB/fs hors des tests. **La génération PDF/A-3 reste pure** : `generateFacturX` renvoie des **bytes en mémoire** (`Uint8Array`), n'écrit rien sur disque.
- Montants : chaînes décimales à **2 décimales exactes** (`"1000.00"`) ; quantités/prix/taux jusqu'à 4 décimales. Arithmétique **big.js**, arrondi **roundHalfUp**.
- `docs/reference/` et `docs/reglementaire/` sont en **lecture seule** : on peut y **AJOUTER** des artefacts vendorisés avec un README de provenance (URL, version, **sha256**, licence), jamais modifier l'existant.
- **Golden files** : bootstrap `UPDATE_GOLDEN=1` **create-only** (ne réécrit jamais un fichier présent). Toute évolution d'un golden est explicite : supprimer puis régénérer, **relire intégralement**, committer.
- Identifiants de code en **anglais** ; messages de commit en **français**, **sans** trailer `Co-Authored-By: Claude` ni mention Claude. `pnpm format` avant chaque commit.
- Toute nouvelle dépendance est **pinnée exactement** (pas de `^`), avec justification + licence.
- Un commit minimum par tâche, à la fin de chaque tâche.

## Versions & artefacts à pinner (provenance vérifiée le 2026-07-13 par fetch des sources primaires)

> sha256 recalculés localement après téléchargement (identiques à ceux exposés par l'API GitHub). Chaque étape de vendoring **re-vérifie** le sha256 et le consigne dans le README de provenance — comme en 1.2. ⚠ = cadence de publication rapide, revérifier au pinning effectif.

- **Schematron EN 16931 — asset CII** : dépôt `ConnectingEurope/eInvoicing-EN16931`, **même release `validation-1.3.16`** (publiée **2026-04-13**, licence **EUPL 1.2**) que l'asset UBL déjà vendorisé. Asset : **`en16931-cii-1.3.16.zip`** (226 664 o), **sha256 `1cd53cb8a84d38aedc82c0caede217da983a7934dd663f793a092fd66443c561`**. XSLT auto-porteur utile : **`xslt/EN16931-CII-validation.xslt`** (725 518 o). *(Rappel : l'asset UBL `en16931-ubl-1.3.16.zip`, sha256 `bafada01…da85`, couvre déjà Invoice **et** CreditNote — un seul artefact, contexte `/ubl:Invoice | /cn:CreditNote` — vérifié.)*
- **XSD CII UN/CEFACT D16B** (cible de validation du CII **commercial** EN 16931). Les XSD CII présents dans `docs/reglementaire` sont du **D22B restreint flux F1** (`ram:IncludedSupplyChainTradeLineItem` commenté en BASE) — **inutilisables** pour un CII commercial complet. Source retenue (citable, versionnée EUPL, **même dépôt** que le Schematron) : `ConnectingEurope/eInvoicing-EN16931`, chemin `cii/schema/D16B SCRDM (Subset)/coupled clm/CII/uncefact/data/standard/CrossIndustryInvoice_100pD16B.xsd` (+ imports `ram`/`udt`/`qdt` D16B). **Licence UN/CEFACT permissive** (redistribution libre avec mention de copyright — texte en en-tête du XSD ; `Schema version: 100.D16B`, 10 oct. 2016).
- **`@cantoo/pdf-lib`** `2.7.2` (licence **MIT**, 100 % JavaScript, aucune dépendance native/Java) — **fork maintenu** de pdf-lib. Retenu comme socle PDF/A-3 : fork drop-in de l'API `pdf-lib`, `attach(bytes, name, { mimeType, afRelationship })`, accès bas-niveau `doc.context` pour l'`OutputIntent` (ICC sRGB) et le flux XMP `/Metadata`. **Motif du choix vs `pdf-lib` original** : `pdf-lib@1.17.1` (MIT) est **figé depuis nov. 2021** (issue « Is this thing still on? ») — incompatible avec l'exigence production/maintenance ; `@cantoo/pdf-lib` est activement maintenu. **Repli documenté** si `@cantoo` pose problème : `pdf-lib@1.17.1` (stable mais gelé). Le pattern OutputIntent/ICC/XMP est éprouvé en production par `node-zugferd` (à réutiliser, pas à dépendre). ⚠ 2.7.2 très récent (publié 2026-07-12) : confirmer la dernière stable au pinning.
- **Spécification Factur-X** : le projet vise le profil **EN 16931 (COMFORT)**. **Décision de syntaxe : cibler UN/CEFACT CII D16B** (Factur-X ≤ **1.07.3**), pour rester **cohérent avec le Schematron EN 16931 CII `validation-1.3.16` qui est D16B**. Factur-X **1.08** (04/12/2025) et **1.09** (10/06/2026) sont passés à **D22B** (annoncé rétrocompatible D16B par la FNFE‑MPE, non vérifié champ par champ) → migration reportée (cf. Points de risque). Valeurs normatives **vérifiées** :
  - `CustomizationID` (BT-24) profil **EN 16931** : **`urn:cen.eu:en16931:2017`** (**nu, sans suffixe Factur-X** — vérifié dans `cii/examples/CII_example4.xml` du dépôt ConnectingEurope et le code node-zugferd). *(Le suffixe `#compliant#urn:factur-x.eu:1p0:basic` est réservé au profil BASIC, pas EN 16931.)*
  - Nom du XML embarqué : **`factur-x.xml`**.
  - **`AFRelationship = Alternative`** pour le profil EN 16931 (le XML est une représentation *alternative* du PDF ; `node-zugferd` utilise `Alternative` pour tous les profils). ⚠ nuance connue : `Data` (MINIMUM/BASIC WL), `Source` (hors Allemagne si PDF dérivé du XML) — échantillons officiels historiquement incohérents ; `Alternative` est le choix par défaut le plus défendable pour EN 16931.
  - Namespace de l'extension schema XMP Factur-X : `urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#` (préfixe `fx`), profil **PDF/A-3B**.
- **Profil ICC sRGB** (OutputIntent PDF/A) : `sRGB2014.icc` (International Color Consortium, color.org — profil de référence à réutilisation libre). Vendorisé dans `docs/reference/icc/`. ⚠ confirmer conditions de réutilisation au vendoring.
- **Liste VATEX** (BT-121, appartenance) : **89 codes** (61 `VATEX-EU-*` + **28 `VATEX-FR-*`**). **Source pinnable retenue** : la liste blanche codée en dur dans l'assertion **BR-CL-22** de `en16931-cii-1.3.16.zip → schematron/codelist/EN16931-CII-codes.sch` (versionnée, traçable, extraite du zip pinné ci-dessus). Contre-référence : xlsx officiel CEF « VATEX v8 » (2025-10-23) et l'onglet « EN16931 Codelists » de l'Annexe 7 v1.9 DGFiP (qui liste les 89 codes, dont `VATEX-FR-CNWVAT` — lié à l'avoir par la règle G6.21).

## Découpage (7 tâches, ordre imposé par les dépendances)

1. **Dédoublonnage** : module UBL partagé `src/ubl/common.ts` (refactor pur, goldens inchangés au bit près).
2. **Avoir UBL commercial** : `generateUbl` route 380→Invoice / 381→CreditNote (XSD OASIS CreditNote + Schematron EN 16931 — déjà couvert par le XSLT UBL).
3. **Avoir en extrait de flux F1** : `generateFluxExtractUbl` gère 381 → extrait CreditNote BASE/FULL (XSD F1 CreditNote).
4. **CII commercial EN 16931 (D16B)** : `generateCii` + XSD D16B vendorisés + Schematron CII (saxon-js).
5. **Factur-X (PDF/A-3 + CII embarqué)** : `generateFacturX` (pdf-lib), vérifs structurelles Node + veraPDF en CI optionnelle.
6. **Backlog de revues** : CustomizationID/CIUS FR, ProfileID (BT-23) sur la facture commerciale, appartenance VATEX vs regex.
7. **README + version 0.3.0 + point de reprise** (suite : plan 1.3 API NestJS).

## Points de risque signalés d'emblée

1. **Conformité PDF/A-3 = point dur.** Aucun validateur PDF/A en JavaScript pur : la conformité stricte (XMP PDF/A + extension schema Factur-X, `OutputIntent` sRGB, fontes embarquées, structure `/AF`) n'est **vérifiable de façon probante que par veraPDF (Java)**. Décision : la **suite Node pur** vérifie la *structure* (magic bytes, pièce jointe `factur-x.xml` présente, `AFRelationship=Alternative`, XMP contenant l'identification PDF/A + le namespace Factur-X + le profil, et surtout que **le XML embarqué == `generateCii(invoice)` et passe le Schematron CII**) ; la **conformité PDF/A-3 formelle** est reléguée à une **étape CI optionnelle documentée** (`ci-pdfa.yml`, image veraPDF) qui **ne bloque pas** la suite locale. Limite assumée : un PDF structurellement correct côté Node peut encore échouer un point PDF/A fin (transparence, fontes) tant que veraPDF n'a pas tourné.
2. **Page visuelle minimale (v1).** Le Factur-X v1 produit un PDF/A-3 **porteur** avec une page quasi vide (aucun glyphe → **pas de fonte à embarquer**, on évite l'asset TTF et la règle « toutes fontes embarquées » de façon vacante). Le rendu humainement lisible de la facture (mise en page + fonte embarquée) est **reporté** à un plan ultérieur. À signaler dans le README.
3. **CII commerciale = D16B à vendoriser.** Le dossier réglementaire ne contient que du **CII D22B restreint flux** ; la cible de validation du CII commercial (D16B) est vendorisée séparément depuis le dépôt `ConnectingEurope/eInvoicing-EN16931` (source/licence confirmées). Sans elle, `generateCii` ne peut être validé XSD — la tâche 4 échoue à l'étape de vendoring si l'artefact n'est pas récupérable.
8. **D16B vs D22B (dette de version Factur-X).** Le socle cible **D16B** (aligné sur le Schematron EN 16931 CII `validation-1.3.16`, lui-même D16B). Mais Factur-X **1.08/1.09** (courant depuis déc. 2025) est en **D22B**. Choix assumé : livrer en D16B maintenant (cohérence XSD ⇄ Schematron), et **reporter** la migration D22B + Factur-X 1.09 à un plan ultérieur, lorsque ConnectingEurope publiera un Schematron D22B. La rétrocompatibilité D16B→D22B annoncée par la FNFE‑MPE n'a **pas** été vérifiée champ par champ.
9. **AFRelationship & fraîcheur des dépendances.** (a) `AFRelationship` n'a pas de valeur unique garantie « correcte » (profil + pays ; échantillons officiels incohérents) — on retient `Alternative` (EN 16931) et on le documente. (b) `@cantoo/pdf-lib@2.7.2` est publié la veille de la rédaction : confirmer la dernière version stable au pinning, repli `pdf-lib@1.17.1`. (c) `saxon-js` (déjà adopté en 1.2, test-only) porte une licence non‑SPDX « SEE LICENSE IN LICENSE.txt » — choix hérité, à confirmer avant tout usage en runtime de production (ici cantonné aux tests).
4. **Restriction « lignes » du F1 CreditNote BASE.** En F1 **Invoice** BASE, `InvoiceLine` est commenté (facture sans lignes). Pour le F1 **CreditNote** BASE, `cac:CreditNoteLine` apparaît `minOccurs="1"` dans le XSD : il faut **vérifier via xmllint** si BASE CreditNote exige ≥ 1 ligne (contrairement à BASE Invoice). La tâche 3 comporte une étape de découverte structurelle explicite (méthode identique à la tâche 5 du plan 1.2).
5. **`cbc:DueDate` absent du CreditNote.** Le `CreditNoteType` OASIS **n'a pas** `cbc:DueDate` au niveau document (séquence : …, `CreditNoteTypeCode`, `Note`, `DocumentCurrencyCode`, …). Le générateur CreditNote **n'émet pas** de date d'échéance (bien que la fixture en porte une, héritée de la facture) — sinon XSD invalide.
6. **CustomizationID / CIUS français non tranché documentairement.** Le dépouillement des annexes v3.2 (BT-24) n'a pas confirmé de CIUS‑FR spécifique pour les formats du socle. **Décision** : conserver `urn:cen.eu:en16931:2017` (nu) pour UBL/CII commercial (le Schematron officiel passe déjà avec cette valeur) ; le Factur-X porte la chaîne EN 16931 Factur-X. La tâche 6 inclut une étape de recherche dans l'Annexe 1 (BT-24) et, si une valeur FR est prescrite, l'ajuste — sinon le maintien est documenté comme choix explicite.
7. **`VATEX_CODES` transcrit.** La `src/` étant pure (pas de lecture de fichier), la liste VATEX est un littéral TS ; un **test de synchronisation** parse le genericode vendorisé et impose l'égalité stricte avec le littéral → interdit toute liste incomplète/dérivée.

## Structure des fichiers (vue d'ensemble)

- `packages/invoice-core/src/ubl/common.ts` *(nouveau)* — scaffolding UBL partagé : `NS_CAC/NS_CBC/NS_INVOICE/NS_CREDIT_NOTE`, `addAmount`, `appendTaxTotal`, puis `appendCommercialParty`, `appendLegalMonetaryTotal`, `appendItemAndPrice` (tâche 2).
- `packages/invoice-core/src/ubl/generate.ts` *(modifié)* — Invoice via helpers partagés ; `generateUbl` route 380/381.
- `packages/invoice-core/src/ubl/generate-credit-note.ts` *(nouveau)* — `generateCreditNote(invoice)`.
- `packages/invoice-core/src/flux/generate-extract.ts` *(modifié)* — extrait F1 Invoice **et** CreditNote.
- `packages/invoice-core/src/cii/generate.ts` *(nouveau)* — `generateCii(invoice)` (CII D16B).
- `packages/invoice-core/src/facturx/generate.ts` *(nouveau)* — `generateFacturX(invoice): Uint8Array`.
- `packages/invoice-core/src/facturx/pdfa.ts` *(nouveau)* — helpers PDF/A-3 (XMP, OutputIntent) bas-niveau pdf-lib.
- `packages/invoice-core/src/model/vatex.ts` *(nouveau)* — `VATEX_CODES` + `isVatexCode`.
- `packages/invoice-core/src/model/schema.ts` *(modifié)* — appartenance VATEX ; export ProfileID commercial inchangé.
- `packages/invoice-core/tests/helpers/schematron.ts` *(modifié)* — `validateAgainstSchematron(xml, sef?)` + `UBL_SEF`/`CII_SEF`.
- `packages/invoice-core/tests/helpers/xsd.ts` *(modifié)* — constantes CreditNote F1 + CII D16B.
- `packages/invoice-core/tests/setup/compile-schematron.ts` *(modifié)* — compile UBL **et** CII SEF.
- `docs/reference/en16931-schematron/1.3.16/xslt/EN16931-CII-validation.xslt` *(vendorisé)*.
- `docs/reference/cii-d16b/` *(vendorisé)* — XSD CII D16B + README.
- `docs/reference/icc/` *(vendorisé)* — `sRGB2014.icc` + README.
- `docs/reference/vatex/` *(vendorisé)* — genericode VATEX + README.

---

### Task 1 : Dédoublonnage — module UBL partagé `src/ubl/common.ts`

**Files:**
- Create: `packages/invoice-core/src/ubl/common.ts`
- Modify: `packages/invoice-core/src/ubl/generate.ts`
- Modify: `packages/invoice-core/src/flux/generate-extract.ts`

**Interfaces:**
- Consumes: `Invoice` (schema.ts).
- Produces (utilisé par les tâches 2, 3) :
  - `export const NS_CAC`, `NS_CBC`, `NS_INVOICE`, `NS_CREDIT_NOTE: string`.
  - `export function addAmount(parent: XMLBuilder, name: string, value: string, currency: string): void`.
  - `export function appendTaxTotal(parent: XMLBuilder, invoice: Invoice): void` — émet `cac:TaxTotal` (TaxAmount + boucle TaxSubtotal/TaxCategory avec motifs d'exonération). **Comportement identique** à l'existant, au caractère près.

> **Nature de la tâche : refactor pur.** Le filet TDD est la **conservation bit-à-bit** des golden files et le vert de toute la suite (XSD OASIS, Schematron, F1). Aucun nouveau comportement : on n'ajoute pas de test unitaire, on prouve l'invariance par les goldens et validations existants.

- [ ] **Step 1 : Baseline verte (avant refactor)**

Run: `pnpm --filter @factelec/invoice-core test`
Expected: PASS (98 tests, couverture 100 %). Noter le nombre de tests pour comparaison.

- [ ] **Step 2 : Créer le module partagé**

`packages/invoice-core/src/ubl/common.ts` :

```ts
import type { XMLBuilder } from 'xmlbuilder2/lib/interfaces.js'
import type { Invoice } from '../model/schema.js'

export const NS_INVOICE = 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2'
export const NS_CREDIT_NOTE =
  'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2'
export const NS_CAC =
  'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2'
export const NS_CBC =
  'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2'

export function addAmount(
  parent: XMLBuilder,
  name: string,
  value: string,
  currency: string,
): void {
  parent.ele(`cbc:${name}`).att('currencyID', currency).txt(value)
}

// cac:TaxTotal (BG-22/BG-23) : identique pour la facture commerciale et l'extrait
// de flux. TaxAmount global puis une ventilation par (catégorie, taux), avec les
// motifs d'exonération BT-120/121 entre cbc:Percent et cac:TaxScheme.
export function appendTaxTotal(parent: XMLBuilder, invoice: Invoice): void {
  const taxTotal = parent.ele('cac:TaxTotal')
  addAmount(taxTotal, 'TaxAmount', invoice.totals.taxAmount, invoice.currency)
  for (const b of invoice.vatBreakdown) {
    const sub = taxTotal.ele('cac:TaxSubtotal')
    addAmount(sub, 'TaxableAmount', b.taxableAmount, invoice.currency)
    addAmount(sub, 'TaxAmount', b.taxAmount, invoice.currency)
    const category = sub.ele('cac:TaxCategory')
    category.ele('cbc:ID').txt(b.category)
    category.ele('cbc:Percent').txt(b.rate)
    if (b.exemptionReasonCode)
      category.ele('cbc:TaxExemptionReasonCode').txt(b.exemptionReasonCode)
    if (b.exemptionReason)
      category.ele('cbc:TaxExemptionReason').txt(b.exemptionReason)
    category.ele('cac:TaxScheme').ele('cbc:ID').txt('VAT')
  }
}
```

- [ ] **Step 3 : Refactor `generate.ts`**

`packages/invoice-core/src/ubl/generate.ts` — remplacer les constantes de namespace, `addAmount` et le bloc `cac:TaxTotal` par des imports du module commun. En tête :

```ts
import { create } from 'xmlbuilder2'
import type { XMLBuilder } from 'xmlbuilder2/lib/interfaces.js'
import type { Invoice, Party } from '../model/schema.js'
import { addAmount, appendTaxTotal, NS_CAC, NS_CBC, NS_INVOICE } from './common.js'
import { UnsupportedTypeCodeError } from './errors.js'
```

Supprimer les définitions locales de `NS_INVOICE/NS_CAC/NS_CBC` et de `addAmount`. Dans `generateUbl`, remplacer les lignes 68‑82 (le bloc `const taxTotal = root.ele('cac:TaxTotal') … }`) par :

```ts
  appendTaxTotal(root, invoice)
```

Le reste (`addParty`, `LegalMonetaryTotal`, boucle `InvoiceLine`) est inchangé pour cette tâche.

- [ ] **Step 4 : Refactor `generate-extract.ts`**

`packages/invoice-core/src/flux/generate-extract.ts` — mêmes imports partagés :

```ts
import { create } from 'xmlbuilder2'
import type { XMLBuilder } from 'xmlbuilder2/lib/interfaces.js'
import type { Invoice, Party } from '../model/schema.js'
import { UnsupportedTypeCodeError } from '../ubl/errors.js'
import { addAmount, appendTaxTotal, NS_CAC, NS_CBC, NS_INVOICE } from '../ubl/common.js'
import { MissingBusinessProcessTypeError } from './errors.js'
```

Supprimer les `NS_*` et `addAmount` locaux. Remplacer le bloc `cac:TaxTotal` (lignes 81‑95) par `appendTaxTotal(root, invoice)`. `addFluxParty` et le `LegalMonetaryTotal` réduit restent locaux (spécifiques au flux).

- [ ] **Step 5 : Prouver l'invariance (goldens au bit près)**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm --filter @factelec/invoice-core test`
Expected: PASS, **même nombre de tests qu'au Step 1**, couverture 100 %. Les 4 goldens (`invoice-simple`, `invoice-multi-rate`, `flux-base-multi-rate`, `flux-full-multi-rate`) doivent rester **inchangés** :

```bash
git diff --stat packages/invoice-core/tests/golden/
```
Expected: **aucun** golden modifié (sortie vide). Si un golden diffère, le refactor a altéré la sortie → corriger jusqu'à diff nul (le refactor doit être transparent).

- [ ] **Step 6 : Commit**

```bash
git add -A
git commit -m "refactor(invoice-core): module UBL partagé (namespaces, addAmount, TaxTotal)"
```

---

### Task 2 : Avoir UBL 2.1 commercial (CreditNote, typeCode 381)

**Files:**
- Modify: `packages/invoice-core/src/ubl/common.ts` (helpers commerciaux partagés)
- Create: `packages/invoice-core/src/ubl/generate-credit-note.ts`
- Modify: `packages/invoice-core/src/ubl/generate.ts` (routage 380/381 ; Invoice via helpers partagés)
- Modify: `packages/invoice-core/tests/fixtures.ts` (avoir multi-lignes optionnel)
- Modify: `packages/invoice-core/tests/ubl/credit-note.test.ts` (remplacer les tests « throw » par des tests de génération)
- Create: `packages/invoice-core/tests/ubl/errors.test.ts` (couverture directe de `UnsupportedTypeCodeError`)
- Régénérer/Créer: `packages/invoice-core/tests/golden/credit-note-simple.ubl.xml`

**Différences Invoice → CreditNote (vérifiées sur `docs/reference/ubl-2.1/maindoc/UBL-CreditNote-2.1.xsd`)** : racine `<CreditNote>` (ns `…:CreditNote-2`) ; **pas de `cbc:DueDate`** au niveau document ; `cbc:CreditNoteTypeCode` (au lieu de `InvoiceTypeCode`) ; lignes `cac:CreditNoteLine` avec `cbc:CreditedQuantity` (au lieu de `InvoiceLine`/`InvoicedQuantity`). Parties, `cac:TaxTotal`, `cac:LegalMonetaryTotal`, `cac:Item`, `cac:Price` : **identiques**. Le XSLT Schematron UBL vendorisé traite déjà `/cn:CreditNote` (namespace `cn`, templates `/ubl:Invoice | /cn:CreditNote`) → **aucun nouvel artefact Schematron**.

**Interfaces:**
- Consumes: helpers de `common.ts` ; `Invoice`.
- Produces (utilisé par la tâche 5 indirectement) :
  - `export function generateCreditNote(invoice: Invoice): string`.
  - `generateUbl(invoice)` route : `381 → generateCreditNote`, `380 → Invoice`. (typeCode ∈ {380,381} par le schéma : routage exhaustif, sans branche morte.)
  - `common.ts` gagne : `appendCommercialParty`, `appendLegalMonetaryTotal`, `appendItemAndPrice` (partagés Invoice/CreditNote).

- [ ] **Step 1 : Écrire les tests qui échouent**

Remplacer `packages/invoice-core/tests/ubl/credit-note.test.ts` :

```ts
import { describe, expect, it } from 'vitest'
import { buildInvoice } from '../../src/model/compute.js'
import { generateUbl } from '../../src/ubl/generate.js'
import { validateAgainstSchematron } from '../helpers/schematron.js'
import { validateAgainstXsd, OASIS_UBL_CREDITNOTE_XSD } from '../helpers/xsd.js'
import { expectMatchesGolden } from '../helpers/golden.js'
import { creditNoteInput, simpleInvoiceInput } from '../fixtures.js'

describe('generateUbl routing (Invoice 380 / CreditNote 381)', () => {
  it('still generates a UBL Invoice for type code 380', () => {
    const out = generateUbl(buildInvoice(simpleInvoiceInput))
    expect(out).toContain('<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>')
    expect(out).toContain('<cac:InvoiceLine>')
  })

  it('generates a UBL CreditNote for type code 381', () => {
    const out = generateUbl(buildInvoice(creditNoteInput))
    expect(out).toContain(
      'xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"',
    )
    expect(out).toContain('<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>')
    expect(out).toContain('<cac:CreditNoteLine>')
    expect(out).toContain('<cbc:CreditedQuantity unitCode="C62">1</cbc:CreditedQuantity>')
    // pas de cbc:DueDate dans un CreditNote (absent du CreditNoteType OASIS)
    expect(out).not.toContain('<cbc:DueDate>')
    expect(out).not.toContain('<cbc:InvoiceTypeCode>')
  })

  it('produces a CreditNote valid against the OASIS CreditNote XSD', () => {
    const r = validateAgainstXsd(
      generateUbl(buildInvoice(creditNoteInput)),
      OASIS_UBL_CREDITNOTE_XSD,
    )
    expect(r.errors).toBe('')
    expect(r.valid).toBe(true)
  })

  it('produces a CreditNote passing the official EN 16931 Schematron', () => {
    const r = validateAgainstSchematron(generateUbl(buildInvoice(creditNoteInput)))
    expect(r.failedAsserts.map((f) => f.id)).toEqual([])
    expect(r.valid).toBe(true)
  })

  it('matches the credit note golden', () => {
    expectMatchesGolden(
      'credit-note-simple.ubl.xml',
      generateUbl(buildInvoice(creditNoteInput)),
    )
  })
})
```

Créer `packages/invoice-core/tests/ubl/errors.test.ts` (couvre le constructeur, conservé comme erreur publique pour la frontière API du plan 1.3) :

```ts
import { describe, expect, it } from 'vitest'
import { UnsupportedTypeCodeError } from '../../src/ubl/errors.js'

describe('UnsupportedTypeCodeError', () => {
  it('carries the offending type code and a message', () => {
    const err = new UnsupportedTypeCodeError('325')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('UnsupportedTypeCodeError')
    expect(err.typeCode).toBe('325')
    expect(err.message).toContain('325')
  })
})
```

- [ ] **Step 2 : Vérifier l'échec**

Run: `pnpm --filter @factelec/invoice-core test -- credit-note errors`
Expected: FAIL — `generateCreditNote` inexistant, `OASIS_UBL_CREDITNOTE_XSD` absent du helper, golden manquant.

- [ ] **Step 3 : Étendre `common.ts` avec les helpers commerciaux partagés**

Ajouter à `packages/invoice-core/src/ubl/common.ts` :

```ts
import type { Invoice, InvoiceLine, Party } from '../model/schema.js'

// Partie commerciale complète (cac:PartyName + cbc:RegistrationName), partagée
// entre la facture (Invoice) et l'avoir (CreditNote).
export function appendCommercialParty(
  parent: XMLBuilder,
  role: 'AccountingSupplierParty' | 'AccountingCustomerParty',
  party: Party,
): void {
  const p = parent.ele(`cac:${role}`).ele('cac:Party')
  p.ele('cac:PartyName').ele('cbc:Name').txt(party.name)
  const address = p.ele('cac:PostalAddress')
  if (party.address.streetName)
    address.ele('cbc:StreetName').txt(party.address.streetName)
  if (party.address.city) address.ele('cbc:CityName').txt(party.address.city)
  if (party.address.postalCode)
    address.ele('cbc:PostalZone').txt(party.address.postalCode)
  address.ele('cac:Country').ele('cbc:IdentificationCode').txt(party.address.countryCode)
  if (party.vatId) {
    const taxScheme = p.ele('cac:PartyTaxScheme')
    taxScheme.ele('cbc:CompanyID').txt(party.vatId)
    taxScheme.ele('cac:TaxScheme').ele('cbc:ID').txt('VAT')
  }
  const legal = p.ele('cac:PartyLegalEntity')
  legal.ele('cbc:RegistrationName').txt(party.name)
  if (party.siren) legal.ele('cbc:CompanyID').txt(party.siren)
}

// cac:LegalMonetaryTotal complet (BG-22), identique Invoice/CreditNote.
export function appendLegalMonetaryTotal(parent: XMLBuilder, invoice: Invoice): void {
  const totals = parent.ele('cac:LegalMonetaryTotal')
  addAmount(totals, 'LineExtensionAmount', invoice.totals.sumOfLines, invoice.currency)
  addAmount(totals, 'TaxExclusiveAmount', invoice.totals.taxExclusive, invoice.currency)
  addAmount(totals, 'TaxInclusiveAmount', invoice.totals.taxInclusive, invoice.currency)
  addAmount(totals, 'PayableAmount', invoice.totals.payable, invoice.currency)
}

// cac:Item (Name + ClassifiedTaxCategory) puis cac:Price : identiques par ligne.
export function appendItemAndPrice(
  line: XMLBuilder,
  invoiceLine: InvoiceLine,
  currency: string,
): void {
  const item = line.ele('cac:Item')
  item.ele('cbc:Name').txt(invoiceLine.name)
  const taxCategory = item.ele('cac:ClassifiedTaxCategory')
  taxCategory.ele('cbc:ID').txt(invoiceLine.vatCategory)
  taxCategory.ele('cbc:Percent').txt(invoiceLine.vatRate)
  taxCategory.ele('cac:TaxScheme').ele('cbc:ID').txt('VAT')
  const price = line.ele('cac:Price')
  addAmount(price, 'PriceAmount', invoiceLine.unitPrice, currency)
}
```

- [ ] **Step 4 : Créer `generate-credit-note.ts`**

`packages/invoice-core/src/ubl/generate-credit-note.ts` :

```ts
import { create } from 'xmlbuilder2'
import type { Invoice } from '../model/schema.js'
import {
  appendCommercialParty,
  appendItemAndPrice,
  appendLegalMonetaryTotal,
  appendTaxTotal,
  NS_CAC,
  NS_CBC,
  NS_CREDIT_NOTE,
} from './common.js'

// UBL 2.1 CreditNote (avoir, typeCode 381). Différences vs Invoice : racine et
// namespace CreditNote-2, cbc:CreditNoteTypeCode, cac:CreditNoteLine /
// cbc:CreditedQuantity, et PAS de cbc:DueDate (absent du CreditNoteType OASIS).
export function generateCreditNote(invoice: Invoice): string {
  const doc = create({ version: '1.0', encoding: 'UTF-8' })
  const root = doc
    .ele(NS_CREDIT_NOTE, 'CreditNote')
    .att('xmlns:cac', NS_CAC)
    .att('xmlns:cbc', NS_CBC)

  root.ele('cbc:CustomizationID').txt('urn:cen.eu:en16931:2017')
  root.ele('cbc:ID').txt(invoice.number)
  root.ele('cbc:IssueDate').txt(invoice.issueDate)
  root.ele('cbc:CreditNoteTypeCode').txt(invoice.typeCode)
  root.ele('cbc:DocumentCurrencyCode').txt(invoice.currency)

  appendCommercialParty(root, 'AccountingSupplierParty', invoice.seller)
  appendCommercialParty(root, 'AccountingCustomerParty', invoice.buyer)
  appendTaxTotal(root, invoice)
  appendLegalMonetaryTotal(root, invoice)

  for (const line of invoice.lines) {
    const l = root.ele('cac:CreditNoteLine')
    l.ele('cbc:ID').txt(line.id)
    l.ele('cbc:CreditedQuantity').att('unitCode', line.unitCode).txt(line.quantity)
    l.ele('cbc:LineExtensionAmount')
      .att('currencyID', invoice.currency)
      .txt(line.lineNetAmount)
    appendItemAndPrice(l, line, invoice.currency)
  }

  return doc.end({ prettyPrint: true })
}
```

- [ ] **Step 5 : Router `generateUbl` et migrer l'Invoice sur les helpers partagés**

`packages/invoice-core/src/ubl/generate.ts` — remplacer `addParty` local par `appendCommercialParty` (import), le `LegalMonetaryTotal` par `appendLegalMonetaryTotal`, et le corps `cac:Item`/`cac:Price` de la boucle `InvoiceLine` par `appendItemAndPrice`. En tête :

```ts
import { create } from 'xmlbuilder2'
import type { Invoice } from '../model/schema.js'
import {
  appendCommercialParty,
  appendItemAndPrice,
  appendLegalMonetaryTotal,
  appendTaxTotal,
  NS_CAC,
  NS_CBC,
  NS_INVOICE,
} from './common.js'
import { generateCreditNote } from './generate-credit-note.js'
```

`UnsupportedTypeCodeError` n'est plus importé ici (déplacé hors du chemin nominal ; conservé comme export public via `index.ts`). Corps :

```ts
export function generateUbl(invoice: Invoice): string {
  if (invoice.typeCode === '381') return generateCreditNote(invoice)

  const doc = create({ version: '1.0', encoding: 'UTF-8' })
  const root = doc
    .ele(NS_INVOICE, 'Invoice')
    .att('xmlns:cac', NS_CAC)
    .att('xmlns:cbc', NS_CBC)

  root.ele('cbc:CustomizationID').txt('urn:cen.eu:en16931:2017')
  root.ele('cbc:ID').txt(invoice.number)
  root.ele('cbc:IssueDate').txt(invoice.issueDate)
  if (invoice.dueDate) root.ele('cbc:DueDate').txt(invoice.dueDate)
  root.ele('cbc:InvoiceTypeCode').txt(invoice.typeCode)
  root.ele('cbc:DocumentCurrencyCode').txt(invoice.currency)

  appendCommercialParty(root, 'AccountingSupplierParty', invoice.seller)
  appendCommercialParty(root, 'AccountingCustomerParty', invoice.buyer)
  appendTaxTotal(root, invoice)
  appendLegalMonetaryTotal(root, invoice)

  for (const line of invoice.lines) {
    const l = root.ele('cac:InvoiceLine')
    l.ele('cbc:ID').txt(line.id)
    l.ele('cbc:InvoicedQuantity').att('unitCode', line.unitCode).txt(line.quantity)
    l.ele('cbc:LineExtensionAmount')
      .att('currencyID', invoice.currency)
      .txt(line.lineNetAmount)
    appendItemAndPrice(l, line, invoice.currency)
  }

  return doc.end({ prettyPrint: true })
}
```

Retirer l'export `generateCreditNote` de `index.ts` ? Non : ajouter `export { generateCreditNote } from './ubl/generate-credit-note.js'` à `src/index.ts` (API publique).

- [ ] **Step 6 : Ajouter la constante XSD CreditNote au helper**

`packages/invoice-core/tests/helpers/xsd.ts` — ajouter :

```ts
export const OASIS_UBL_CREDITNOTE_XSD = resolve(
  import.meta.dirname,
  '../../../../docs/reference/ubl-2.1/maindoc/UBL-CreditNote-2.1.xsd',
)
```

- [ ] **Step 7 : Vérifier les unités puis générer le golden CreditNote**

Run: `pnpm --filter @factelec/invoice-core test -- credit-note errors`
Expected: les assertions `toContain`, XSD et Schematron passent ; le test golden échoue (fichier manquant). Générer :

```bash
UPDATE_GOLDEN=1 pnpm --filter @factelec/invoice-core test -- credit-note
cat packages/invoice-core/tests/golden/credit-note-simple.ubl.xml
```
**Relire intégralement** : racine `<CreditNote xmlns="…CreditNote-2">`, pas de `DueDate`, `<cbc:CreditNoteTypeCode>381`, une `<cac:CreditNoteLine>` avec `<cbc:CreditedQuantity unitCode="C62">1`, montants 1000.00/200.00/1200.00 identiques à la facture simple.

- [ ] **Step 8 : Vérifier l'ensemble et committer**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm --filter @factelec/invoice-core test`
Expected: PASS ; les goldens **Invoice** existants restent **inchangés** (`git diff --stat` : seul `credit-note-simple.ubl.xml` est nouveau). Couverture ≥ 90 %.

```bash
git add -A
git commit -m "feat(invoice-core): génération UBL CreditNote 2.1 pour l'avoir (typeCode 381)"
```

---

### Task 3 : Avoir en extrait de flux F1 (CreditNote BASE/FULL)

**Files:**
- Modify: `packages/invoice-core/src/flux/generate-extract.ts` (branche CreditNote)
- Modify: `packages/invoice-core/tests/helpers/xsd.ts` (constantes F1 CreditNote)
- Modify: `packages/invoice-core/tests/flux/flux-extract.test.ts` (cas CreditNote)
- Créer: `packages/invoice-core/tests/golden/flux-base-credit-note.ubl.xml`, `packages/invoice-core/tests/golden/flux-full-credit-note.ubl.xml`

**Découverte structurelle requise (méthode identique à la tâche 5 du plan 1.2).** Les XSD F1 CreditNote existent : `…/F1_BASE_UBL_2.1/F1BASE_UBL-CreditNote-2.1.xsd` et `…/F1_FULL_UBL_2.1/F1FULL_UBL_CreditNote-2.1.xsd` (noms **asymétriques** — tiret en BASE, souligné en FULL — les recopier exactement). `CustomizationID`, `ProfileID` et `CreditNoteTypeCode` y sont `minOccurs="1"`. **Point à vérifier via xmllint (Step 2)** : en BASE Invoice, `InvoiceLine` est commenté (aucune ligne) ; en BASE CreditNote, `cac:CreditNoteLine` apparaît `minOccurs="1"` — déterminer si BASE CreditNote **exige** ≥ 1 ligne. Le générateur ci-dessous émet les lignes en FULL et, **par défaut, aucune ligne en BASE** ; si la validation BASE échoue faute de ligne, activer l'émission d'une ligne épurée en BASE CreditNote (variable `emitLinesInBase`) — trancher d'après xmllint et consigner le choix en commentaire.

**Interfaces:**
- Consumes: `Invoice`, helpers flux existants, `appendTaxTotal`.
- Produces :
  - `generateFluxExtractUbl(invoice, profile)` accepte désormais `typeCode` 380 **et** 381 ; 381 émet un extrait `CreditNote` (racine `…:CreditNote-2`, `cbc:CreditNoteTypeCode`, `cac:CreditNoteLine`/`cbc:CreditedQuantity`, pas de `DueDate`). `MissingBusinessProcessTypeError` inchangé (ProfileID obligatoire).
  - Helper : `F1_BASE_UBL_CREDITNOTE_XSD`, `F1_FULL_UBL_CREDITNOTE_XSD`.

- [ ] **Step 1 : Écrire les tests qui échouent**

Ajouter à `packages/invoice-core/tests/flux/flux-extract.test.ts` :

```ts
import {
  F1_BASE_UBL_CREDITNOTE_XSD,
  F1_FULL_UBL_CREDITNOTE_XSD,
} from '../helpers/xsd.js'
import { expectMatchesGolden } from '../helpers/golden.js'
import { creditNoteInput } from '../fixtures.js'

describe('generateFluxExtractUbl for a credit note (381)', () => {
  it('BASE validates against the F1 BASE CreditNote XSD', () => {
    const r = validateAgainstXsd(
      generateFluxExtractUbl(buildInvoice(creditNoteInput), 'BASE'),
      F1_BASE_UBL_CREDITNOTE_XSD,
    )
    expect(r.errors).toBe('')
    expect(r.valid).toBe(true)
  })

  it('FULL validates against the F1 FULL CreditNote XSD', () => {
    const r = validateAgainstXsd(
      generateFluxExtractUbl(buildInvoice(creditNoteInput), 'FULL'),
      F1_FULL_UBL_CREDITNOTE_XSD,
    )
    expect(r.errors).toBe('')
    expect(r.valid).toBe(true)
  })

  it('emits a CreditNote root with mandatory ProfileID and CreditNoteTypeCode', () => {
    const xml = generateFluxExtractUbl(buildInvoice(creditNoteInput), 'BASE')
    expect(xml).toContain('xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"')
    expect(xml).toContain('<cbc:ProfileID>')
    expect(xml).toContain('<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>')
    expect(xml).not.toContain('TaxInclusiveAmount')
  })

  it('matches the flux credit note goldens', () => {
    expectMatchesGolden('flux-base-credit-note.ubl.xml', generateFluxExtractUbl(buildInvoice(creditNoteInput), 'BASE'))
    expectMatchesGolden('flux-full-credit-note.ubl.xml', generateFluxExtractUbl(buildInvoice(creditNoteInput), 'FULL'))
  })
})
```

- [ ] **Step 2 : Découverte structurelle BASE/FULL CreditNote (xmllint)**

Run (déterminer si BASE CreditNote exige des lignes ; le strip enlève les `xsd:element ref` commentés) :
```bash
BASE="docs/reglementaire/specifications-externes-v3.2/3- XSD_v3.2/2 - E-invoicing/F1_BASE_UBL_2.1/F1BASE_UBL-CommonAggregateComponents-2.1.xsd"
grep -n 'CreditNoteLine' "$BASE" || echo 'CreditNoteLine absent des CAC BASE'
# Et tester empiriquement avec/sans ligne (voir Step 4).
```
Conclusion attendue : consigner en commentaire `// F1 BASE CreditNote : lignes {interdites|obligatoires} (vérifié xmllint le <date>)`.

- [ ] **Step 3 : Ajouter les constantes XSD**

`packages/invoice-core/tests/helpers/xsd.ts` :

```ts
export const F1_BASE_UBL_CREDITNOTE_XSD = resolve(
  import.meta.dirname,
  `${REG}/F1_BASE_UBL_2.1/F1BASE_UBL-CreditNote-2.1.xsd`,
)
export const F1_FULL_UBL_CREDITNOTE_XSD = resolve(
  import.meta.dirname,
  `${REG}/F1_FULL_UBL_2.1/F1FULL_UBL_CreditNote-2.1.xsd`,
)
```

- [ ] **Step 4 : Router `generateFluxExtractUbl` sur le type de document**

`packages/invoice-core/src/flux/generate-extract.ts` — remplacer la garde d'entrée `if (invoice.typeCode !== '380') throw …` par un routage, et paramétrer les noms d'éléments selon le type. Modèle :

```ts
export function generateFluxExtractUbl(invoice: Invoice, profile: FluxProfile): string {
  if (!invoice.businessProcessType) throw new MissingBusinessProcessTypeError()
  const isCredit = invoice.typeCode === '381'
  const rootNs = isCredit ? NS_CREDIT_NOTE : NS_INVOICE
  const rootName = isCredit ? 'CreditNote' : 'Invoice'
  const typeCodeEl = isCredit ? 'CreditNoteTypeCode' : 'InvoiceTypeCode'
  const lineEl = isCredit ? 'CreditNoteLine' : 'InvoiceLine'
  const qtyEl = isCredit ? 'CreditedQuantity' : 'InvoicedQuantity'

  const doc = create({ version: '1.0', encoding: 'UTF-8' })
  const root = doc.ele(rootNs, rootName).att('xmlns:cac', NS_CAC).att('xmlns:cbc', NS_CBC)

  root.ele('cbc:CustomizationID').txt('urn:cen.eu:en16931:2017')
  root.ele('cbc:ProfileID').txt(invoice.businessProcessType)
  root.ele('cbc:ID').txt(invoice.number)
  root.ele('cbc:IssueDate').txt(invoice.issueDate)
  // pas de DueDate : absent du CreditNote, et non requis par F1.
  if (!isCredit && invoice.dueDate) root.ele('cbc:DueDate').txt(invoice.dueDate)
  root.ele(`cbc:${typeCodeEl}`).txt(invoice.typeCode)
  root.ele('cbc:DocumentCurrencyCode').txt(invoice.currency)

  addFluxParty(root, 'AccountingSupplierParty', invoice.seller)
  addFluxParty(root, 'AccountingCustomerParty', invoice.buyer)
  appendTaxTotal(root, invoice)

  const total = root.ele('cac:LegalMonetaryTotal')
  addAmount(total, 'TaxExclusiveAmount', invoice.totals.taxExclusive, invoice.currency)

  // FULL : lignes épurées. BASE : aucune ligne (Invoice) — pour CreditNote, cf. Step 2.
  const emitLines = profile === 'FULL' || (isCredit && /* si BASE exige des lignes */ false)
  if (emitLines) {
    for (const line of invoice.lines) {
      const l = root.ele(`cac:${lineEl}`)
      l.ele(`cbc:${qtyEl}`).att('unitCode', line.unitCode).txt(line.quantity)
      l.ele('cac:Item').ele('cbc:Name').txt(line.name)
      const price = l.ele('cac:Price')
      addAmount(price, 'PriceAmount', line.unitPrice, invoice.currency)
    }
  }

  return doc.end({ prettyPrint: true })
}
```

Ajouter `NS_CREDIT_NOTE` à l'import depuis `../ubl/common.js`. **Note DueDate** : la facture flux Invoice conservait `DueDate` en 1.2 ? Vérifier le golden `flux-base-multi-rate.ubl.xml` — si `DueDate` y figurait, garder le comportement Invoice **inchangé** (les goldens Invoice flux ne doivent pas bouger) ; la condition `if (!isCredit && invoice.dueDate)` préserve exactement l'Invoice si elle émettait déjà `DueDate`, ou la retirer si l'Invoice ne l'émettait pas. **Impératif : `git diff --stat` sur les goldens flux Invoice doit rester vide.**

- [ ] **Step 5 : Vérifier, générer et relire les goldens**

Run: `pnpm --filter @factelec/invoice-core test -- flux-extract`
Expected: XSD/assertions CreditNote passent (ajuster `emitLines` selon Step 2 si BASE échoue). Puis :

```bash
UPDATE_GOLDEN=1 pnpm --filter @factelec/invoice-core test -- flux-extract
cat packages/invoice-core/tests/golden/flux-base-credit-note.ubl.xml
cat packages/invoice-core/tests/golden/flux-full-credit-note.ubl.xml
git diff --stat packages/invoice-core/tests/golden/   # seuls les 2 nouveaux fichiers
```
**Relire** : racine CreditNote, `ProfileID` = `S1` (businessProcessType de la fixture), `CreditNoteTypeCode` 381, `TaxExclusiveAmount` seul dans `LegalMonetaryTotal`, aucun nom de partie.

- [ ] **Step 6 : Vérifier l'ensemble et committer**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm --filter @factelec/invoice-core test`
Expected: PASS ; goldens Invoice (commerciaux et flux) inchangés.

```bash
git add -A
git commit -m "feat(invoice-core): extrait de flux F1 pour l'avoir (CreditNote BASE/FULL)"
```

---

### Task 4 : CII commercial EN 16931 (UN/CEFACT D16B)

**Files:**
- Vendoriser: `docs/reference/cii-d16b/` (XSD D16B + README), `docs/reference/en16931-schematron/1.3.16/xslt/EN16931-CII-validation.xslt` (+ MAJ README schematron)
- Create: `packages/invoice-core/src/cii/generate.ts`
- Modify: `packages/invoice-core/src/index.ts` (export `generateCii`)
- Modify: `packages/invoice-core/tests/setup/compile-schematron.ts` (compiler UBL **et** CII SEF)
- Modify: `packages/invoice-core/tests/helpers/schematron.ts` (SEF paramétrable)
- Modify: `packages/invoice-core/tests/helpers/xsd.ts` (constante CII D16B)
- Create: `packages/invoice-core/tests/cii/generate.test.ts`
- Créer: `packages/invoice-core/tests/golden/cii-simple.xml`, `packages/invoice-core/tests/golden/cii-multi-rate.xml`

**Interfaces:**
- Consumes: `Invoice`.
- Produces (utilisé par la tâche 5) :
  - `export function generateCii(invoice: Invoice): string` — CII D16B, profil EN 16931. Le `TypeCode` (BT-3) reprend `invoice.typeCode` (380/381) ; la même fonction sert facture et avoir (le CII ne change pas de racine pour un avoir).
  - `validateAgainstSchematron(xml, sef?)` + `export const UBL_SEF`, `CII_SEF`.

- [ ] **Step 1 : Vendoriser le Schematron CII + les XSD D16B (avec sha256)**

Run (sha256 attendu vérifié : `1cd53cb8a84d38aedc82c0caede217da983a7934dd663f793a092fd66443c561`) :
```bash
cd /tmp
gh release download validation-1.3.16 --repo ConnectingEurope/eInvoicing-EN16931 \
  --pattern 'en16931-cii-1.3.16.zip' --dir /tmp/en16931cii --clobber
shasum -a 256 /tmp/en16931cii/en16931-cii-1.3.16.zip
# Attendu : 1cd53cb8a84d38aedc82c0caede217da983a7934dd663f793a092fd66443c561
cd /Users/xavier/Sites/api-factures-elec
unzip -o /tmp/en16931cii/en16931-cii-1.3.16.zip \
  'xslt/EN16931-CII-validation.xslt' 'schematron/codelist/EN16931-CII-codes.sch' \
  -d docs/reference/en16931-schematron/1.3.16/
```
Vendoriser les **XSD CII D16B** dans `docs/reference/cii-d16b/` depuis le dépôt `ConnectingEurope/eInvoicing-EN16931`, chemin `cii/schema/D16B SCRDM (Subset)/coupled clm/CII/uncefact/data/standard/` (racine `CrossIndustryInvoice_100pD16B.xsd` + imports `ram`/`udt`/`qdt` D16B) :
```bash
gh api repos/ConnectingEurope/eInvoicing-EN16931/tarball/validation-1.3.16 > /tmp/en16931-src.tgz
# extraire le sous-arbre cii/schema/D16B\ SCRDM\ (Subset)/ vers docs/reference/cii-d16b/
```
Créer `docs/reference/cii-d16b/README.md` (URL du dépôt, tag `validation-1.3.16`, sha256 du tarball, **licence UN/CEFACT permissive** — copyright en en-tête du XSD) et **compléter** `docs/reference/en16931-schematron/README.md` avec l'entrée « asset CII » (release 1.3.16, sha256 `1cd53cb8…c561`, EUPL 1.2, XSLT + `EN16931-CII-codes.sch` pour la liste VATEX de la tâche 6).
Expected: `EN16931-CII-validation.xslt` + `EN16931-CII-codes.sch` présents ; XSD D16B présents ; deux README de provenance à jour.

- [ ] **Step 2 : Généraliser la compilation SEF (UBL + CII)**

`packages/invoice-core/tests/setup/compile-schematron.ts` — compiler une **liste** de paires (XSLT, SEF) :

```ts
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const ref = (p: string) => resolve(import.meta.dirname, '../../../../docs/reference/en16931-schematron/1.3.16/xslt', p)
const sef = (p: string) => resolve(import.meta.dirname, '../.sef', p)

const PAIRS: ReadonlyArray<{ xslt: string; sef: string }> = [
  { xslt: ref('EN16931-UBL-validation.xslt'), sef: sef('EN16931-UBL-validation.sef.json') },
  { xslt: ref('EN16931-CII-validation.xslt'), sef: sef('EN16931-CII-validation.sef.json') },
]

export default function setup(): void {
  const xslt3Bin = require.resolve('xslt3')
  for (const { xslt, sef: out } of PAIRS) {
    if (existsSync(out) && statSync(out).mtimeMs >= statSync(xslt).mtimeMs) continue
    mkdirSync(dirname(out), { recursive: true })
    execFileSync(process.execPath, [xslt3Bin, `-xsl:${xslt}`, `-export:${out}`, '-nogo'], { stdio: 'pipe' })
  }
}
```

- [ ] **Step 3 : Rendre le SEF paramétrable dans le helper**

`packages/invoice-core/tests/helpers/schematron.ts` — exporter les deux SEF et un 2e argument :

```ts
export const UBL_SEF = resolve(import.meta.dirname, '../.sef/EN16931-UBL-validation.sef.json')
export const CII_SEF = resolve(import.meta.dirname, '../.sef/EN16931-CII-validation.sef.json')

export function validateAgainstSchematron(
  xml: string,
  sef: string = UBL_SEF,
): { valid: boolean; failedAsserts: SchematronViolation[] } {
  const out = SaxonJS.transform(
    { stylesheetFileName: sef, sourceText: xml, destination: 'serialized' },
    'sync',
  ) as { principalResult: string }
  // ... (extraction SVRL inchangée)
}
```

(Le reste — regex SVRL — inchangé. Les appels existants sans 2e argument restent valides.)

- [ ] **Step 4 : Écrire le test CII qui échoue**

`packages/invoice-core/tests/cii/generate.test.ts` :

```ts
import { describe, expect, it } from 'vitest'
import { buildInvoice } from '../../src/model/compute.js'
import { generateCii } from '../../src/cii/generate.js'
import { expectMatchesGolden } from '../helpers/golden.js'
import { CII_D16B_XSD, validateAgainstXsd } from '../helpers/xsd.js'
import { CII_SEF, validateAgainstSchematron } from '../helpers/schematron.js'
import { multiRateInvoiceInput, simpleInvoiceInput } from '../fixtures.js'

describe('generateCii (CII D16B, EN 16931 profile)', () => {
  it('validates against the CII D16B XSD (simple and multi-rate)', () => {
    for (const input of [simpleInvoiceInput, multiRateInvoiceInput]) {
      const r = validateAgainstXsd(generateCii(buildInvoice(input)), CII_D16B_XSD)
      expect(r.errors).toBe('')
      expect(r.valid).toBe(true)
    }
  })

  it('passes the official EN 16931 CII Schematron', () => {
    for (const input of [simpleInvoiceInput, multiRateInvoiceInput]) {
      const r = validateAgainstSchematron(generateCii(buildInvoice(input)), CII_SEF)
      expect(r.failedAsserts.map((f) => f.id)).toEqual([])
      expect(r.valid).toBe(true)
    }
  })

  it('carries the EN 16931 guideline and the document type code', () => {
    const xml = generateCii(buildInvoice(simpleInvoiceInput))
    expect(xml).toContain('<ram:ID>urn:cen.eu:en16931:2017</ram:ID>')
    expect(xml).toContain('<ram:TypeCode>380</ram:TypeCode>')
  })

  it('matches the CII goldens', () => {
    expectMatchesGolden('cii-simple.xml', generateCii(buildInvoice(simpleInvoiceInput)))
    expectMatchesGolden('cii-multi-rate.xml', generateCii(buildInvoice(multiRateInvoiceInput)))
  })
})
```

Ajouter à `packages/invoice-core/tests/helpers/xsd.ts` :

```ts
export const CII_D16B_XSD = resolve(
  import.meta.dirname,
  '../../../../docs/reference/cii-d16b/CrossIndustryInvoice_100pD16B.xsd',
)
```
(⚠ adapter le nom du fichier racine réel après vendoring.)

- [ ] **Step 5 : Vérifier l'échec**

Run: `pnpm --filter @factelec/invoice-core test -- cii`
Expected: FAIL — `generateCii` inexistant.

- [ ] **Step 6 : Implémenter `generateCii`**

`packages/invoice-core/src/cii/generate.ts` (profil EN 16931, ordre des éléments conforme au D16B — **à vérifier/itérer** via xmllint + Schematron au Step 7) :

```ts
import { create } from 'xmlbuilder2'
import type { Invoice } from '../model/schema.js'

const NS_RSM = 'urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100'
const NS_RAM = 'urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100'
const NS_UDT = 'urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100'

// AAAAMMJJ (format 102 des DateTimeString CII).
const ciiDate = (iso: string): string => iso.replace(/-/g, '')

export function generateCii(invoice: Invoice): string {
  const doc = create({ version: '1.0', encoding: 'UTF-8' })
  const root = doc
    .ele(NS_RSM, 'rsm:CrossIndustryInvoice')
    .att('xmlns:ram', NS_RAM)
    .att('xmlns:udt', NS_UDT)

  // BG-2 : contexte (BT-23 process si présent, BT-24 guideline EN 16931)
  const ctx = root.ele('rsm:ExchangedDocumentContext')
  if (invoice.businessProcessType)
    ctx.ele('ram:BusinessProcessSpecifiedDocumentContextParameter')
      .ele('ram:ID').txt(invoice.businessProcessType)
  ctx.ele('ram:GuidelineSpecifiedDocumentContextParameter')
    .ele('ram:ID').txt('urn:cen.eu:en16931:2017')

  // BT-1/BT-3/BT-2
  const head = root.ele('rsm:ExchangedDocument')
  head.ele('ram:ID').txt(invoice.number)
  head.ele('ram:TypeCode').txt(invoice.typeCode)
  head.ele('ram:IssueDateTime')
    .ele('udt:DateTimeString').att('format', '102').txt(ciiDate(invoice.issueDate))

  const tx = root.ele('rsm:SupplyChainTradeTransaction')

  // BG-25 : lignes
  for (const line of invoice.lines) {
    const li = tx.ele('ram:IncludedSupplyChainTradeLineItem')
    li.ele('ram:AssociatedDocumentLineDocument').ele('ram:LineID').txt(line.id)
    li.ele('ram:SpecifiedTradeProduct').ele('ram:Name').txt(line.name)
    li.ele('ram:SpecifiedLineTradeAgreement')
      .ele('ram:NetPriceProductTradePrice')
      .ele('ram:ChargeAmount').txt(line.unitPrice)
    li.ele('ram:SpecifiedLineTradeDelivery')
      .ele('ram:BilledQuantity').att('unitCode', line.unitCode).txt(line.quantity)
    const lineSettle = li.ele('ram:SpecifiedLineTradeSettlement')
    const lineTax = lineSettle.ele('ram:ApplicableTradeTax')
    lineTax.ele('ram:TypeCode').txt('VAT')
    lineTax.ele('ram:CategoryCode').txt(line.vatCategory)
    lineTax.ele('ram:RateApplicablePercent').txt(line.vatRate)
    lineSettle.ele('ram:SpecifiedTradeSettlementLineMonetarySummation')
      .ele('ram:LineTotalAmount').txt(line.lineNetAmount)
  }

  // BG-4/BG-7
  const agreement = tx.ele('ram:ApplicableHeaderTradeAgreement')
  appendCiiParty(agreement, 'ram:SellerTradeParty', invoice.seller)
  appendCiiParty(agreement, 'ram:BuyerTradeParty', invoice.buyer)
  tx.ele('ram:ApplicableHeaderTradeDelivery')

  // BG-22/BG-23
  const settle = tx.ele('ram:ApplicableHeaderTradeSettlement')
  settle.ele('ram:InvoiceCurrencyCode').txt(invoice.currency)
  for (const b of invoice.vatBreakdown) {
    const tax = settle.ele('ram:ApplicableTradeTax')
    tax.ele('ram:CalculatedAmount').txt(b.taxAmount)
    tax.ele('ram:TypeCode').txt('VAT')
    if (b.exemptionReason) tax.ele('ram:ExemptionReason').txt(b.exemptionReason)
    tax.ele('ram:BasisAmount').txt(b.taxableAmount)
    tax.ele('ram:CategoryCode').txt(b.category)
    if (b.exemptionReasonCode)
      tax.ele('ram:ExemptionReasonCode').txt(b.exemptionReasonCode)
    tax.ele('ram:RateApplicablePercent').txt(b.rate)
  }
  const sum = settle.ele('ram:SpecifiedTradeSettlementHeaderMonetarySummation')
  sum.ele('ram:LineTotalAmount').txt(invoice.totals.sumOfLines)
  sum.ele('ram:TaxBasisTotalAmount').txt(invoice.totals.taxExclusive)
  sum.ele('ram:TaxTotalAmount').att('currencyID', invoice.currency).txt(invoice.totals.taxAmount)
  sum.ele('ram:GrandTotalAmount').txt(invoice.totals.taxInclusive)
  sum.ele('ram:DuePayableAmount').txt(invoice.totals.payable)

  return doc.end({ prettyPrint: true })
}

function appendCiiParty(
  parent: import('xmlbuilder2/lib/interfaces.js').XMLBuilder,
  role: string,
  party: Invoice['seller'],
): void {
  const p = parent.ele(role)
  p.ele('ram:Name').txt(party.name)
  if (party.siren)
    p.ele('ram:SpecifiedLegalOrganization').ele('ram:ID').txt(party.siren)
  const addr = p.ele('ram:PostalTradeAddress')
  if (party.address.postalCode) addr.ele('ram:PostcodeCode').txt(party.address.postalCode)
  if (party.address.streetName) addr.ele('ram:LineOne').txt(party.address.streetName)
  if (party.address.city) addr.ele('ram:CityName').txt(party.address.city)
  addr.ele('ram:CountryID').txt(party.address.countryCode)
  if (party.vatId) {
    const reg = p.ele('ram:SpecifiedTaxRegistration')
    reg.ele('ram:ID').att('schemeID', 'VA').txt(party.vatId)
  }
}
```

`src/index.ts` — ajouter `export { generateCii } from './cii/generate.js'`.

- [ ] **Step 7 : Itérer jusqu'à XSD + Schematron verts, puis générer les goldens**

Run: `pnpm --filter @factelec/invoice-core test -- cii`
Le premier passage peut échouer sur l'**ordre des éléments** (D16B est strict) ou une assertion Schematron (ex. `BR-CO-*`, cardinalités de parties). Corriger l'ordre/les champs d'après les messages `xmllint`/SVRL (les messages nomment l'élément fautif). Une fois XSD + Schematron verts pour `simple` **et** `multi-rate` :

```bash
UPDATE_GOLDEN=1 pnpm --filter @factelec/invoice-core test -- cii
```
**Relire** les 2 goldens CII (contexte EN 16931, TypeCode, ventilations avec `ExemptionReasonCode` sur la ligne E du multi-taux, sommation des totaux).

- [ ] **Step 8 : Vérifier l'ensemble et committer**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm --filter @factelec/invoice-core test`
Expected: PASS (le premier run recompile le SEF CII, ~10-20 s). Couverture ≥ 90 %.

```bash
git add -A
git commit -m "feat(invoice-core): génération CII D16B (EN 16931) validée XSD et Schematron"
```

---

### Task 5 : Factur-X (PDF/A-3 + XML CII embarqué)

**Files:**
- Vendoriser: `docs/reference/icc/sRGB2014.icc` + `docs/reference/icc/README.md`
- Modify: `packages/invoice-core/package.json` (`@cantoo/pdf-lib` en **dependencies**, pinné `2.7.2`)
- Create: `packages/invoice-core/src/facturx/pdfa.ts`, `packages/invoice-core/src/facturx/generate.ts`
- Modify: `packages/invoice-core/src/index.ts` (export `generateFacturX`)
- Create: `packages/invoice-core/tests/facturx/generate.test.ts`
- Create (optionnel, non bloquant): `.github/workflows/ci-pdfa.yml` (veraPDF)

**Décision bibliothèque (instruite, recherche du 2026-07-13).** `@cantoo/pdf-lib@2.7.2` (MIT, 100 % JS, aucune dépendance native/Java) — **fork maintenu** de pdf-lib — est le **socle retenu** : seule famille pure Node offrant l'attachement de fichiers avec `AFRelationship` **et** un accès bas-niveau (`doc.context`) pour injecter l'`OutputIntent` (ICC sRGB) et le flux XMP `/Metadata` requis par PDF/A. On préfère le fork `@cantoo` à `pdf-lib@1.17.1` (figé depuis nov. 2021 — incompatible « jamais de prototype »). Les libs dédiées (`node-zugferd`, `factur-x-kit`, `@e-invoice-eu/core`) s'appuient toutes sur pdf-lib et ajouteraient une dépendance transitive jeune/WIP pour un besoin qu'on maîtrise en direct ; on **réutilise leur pattern** (OutputIntent/ICC/XMP éprouvé par `node-zugferd`) sans en dépendre. **Point dur** : aucune de ces libs ne « certifie » PDF/A-3 ; la conformité fine est vérifiée hors bande par **veraPDF 1.30** (Java, GPLv3+/MPLv2+, étape CI optionnelle) — **aucun validateur PDF/A pur JS n'existe**.

**Ce qui est testé en Node pur** : magic bytes `%PDF-`, présence d'une pièce jointe nommée `factur-x.xml`, `AFRelationship = Alternative`, `/AF` au catalogue, `OutputIntent` présent, flux `/Metadata` contenant l'identification PDF/A (`pdfaid:part=3`), le namespace/extension Factur-X et le `DocumentType`/`DocumentFileName`, et surtout **le XML embarqué reconstruit == `generateCii(invoice)` et passe le Schematron CII**. **Non couvert en Node** : verdict PDF/A-3 formel (veraPDF).

**Interfaces:**
- Consumes: `generateCii` (tâche 4), l'ICC vendorisé (lu **en test** via fs et intégré au build ? non — voir Step 2 : l'ICC est chargé par la lib pure sans I/O).
- Produces : `export function generateFacturX(invoice: Invoice): Uint8Array` — PDF/A-3 en mémoire.

> **Pureté & asset ICC.** `src/` ne lit pas de fichier. L'octet‑array de l'ICC sRGB est donc **embarqué dans le source** sous forme d'un module généré `src/facturx/srgb-icc.ts` (constante `SRGB_ICC: Uint8Array` en base64). Un **test de synchronisation** compare cette constante au fichier `docs/reference/icc/sRGB2014.icc` (lu en test) → garantit l'intégrité et la provenance.

- [ ] **Step 1 : Installer pdf-lib (pinné) et vendoriser l'ICC**

Run:
```bash
pnpm --filter @factelec/invoice-core add @cantoo/pdf-lib@2.7.2
# Vendoriser le profil sRGB (⚠ confirmer réutilisation) :
mkdir -p docs/reference/icc
curl -fsSL -o docs/reference/icc/sRGB2014.icc https://www.color.org/profiles/sRGB2014.icc
shasum -a 256 docs/reference/icc/sRGB2014.icc   # consigner dans le README
```
Créer `docs/reference/icc/README.md` (source color.org, sha256, conditions de réutilisation). Générer le module source encodé :
```bash
node -e "const fs=require('fs');const b=fs.readFileSync('docs/reference/icc/sRGB2014.icc').toString('base64');fs.writeFileSync('packages/invoice-core/src/facturx/srgb-icc.ts','// Généré depuis docs/reference/icc/sRGB2014.icc — ne pas éditer à la main.\\nexport const SRGB_ICC_BASE64 =\\n  \\''+b+'\\'\\n')"
```
Expected: `@cantoo/pdf-lib` en `dependencies` exactement `2.7.2` ; ICC vendorisé + README ; `src/facturx/srgb-icc.ts` généré.

- [ ] **Step 2 : Écrire les tests qui échouent**

`packages/invoice-core/tests/facturx/generate.test.ts` :

```ts
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PDFDocument, PDFName } from '@cantoo/pdf-lib'
import { describe, expect, it } from 'vitest'
import { buildInvoice } from '../../src/model/compute.js'
import { generateCii } from '../../src/cii/generate.js'
import { generateFacturX } from '../../src/facturx/generate.js'
import { SRGB_ICC_BASE64 } from '../../src/facturx/srgb-icc.js'
import { CII_SEF, validateAgainstSchematron } from '../helpers/schematron.js'
import { simpleInvoiceInput } from '../fixtures.js'

describe('generateFacturX (PDF/A-3 + embedded CII)', () => {
  it('returns bytes starting with the PDF magic header', () => {
    const pdf = generateFacturX(buildInvoice(simpleInvoiceInput))
    expect(pdf).toBeInstanceOf(Uint8Array)
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe('%PDF-')
  })

  it('embeds factur-x.xml equal to generateCii and passing the CII Schematron', async () => {
    const invoice = buildInvoice(simpleInvoiceInput)
    const pdf = generateFacturX(invoice)
    const doc = await PDFDocument.load(pdf)
    // Retrouver le flux embarqué via /Names/EmbeddedFiles (helper de test ci-dessous).
    const xml = extractEmbeddedXml(doc, 'factur-x.xml')
    expect(xml).toBe(generateCii(invoice))
    const r = validateAgainstSchematron(xml, CII_SEF)
    expect(r.valid).toBe(true)
  })

  it('declares AFRelationship Alternative and PDF/A + Factur-X XMP metadata', () => {
    const pdf = generateFacturX(buildInvoice(simpleInvoiceInput))
    const raw = new TextDecoder('latin1').decode(pdf)
    expect(raw).toContain('/AFRelationship /Alternative')
    expect(raw).toContain('pdfaid:part>3')        // identification PDF/A-3
    expect(raw).toContain('urn:factur-x')         // extension schema Factur-X (FNFE)
    expect(raw).toContain('EN 16931')             // ConformanceLevel du profil
  })

  it('embeds the vendored sRGB profile as OutputIntent', () => {
    const pdf = generateFacturX(buildInvoice(simpleInvoiceInput))
    const raw = new TextDecoder('latin1').decode(pdf)
    expect(raw).toContain('/OutputIntent')
    expect(SRGB_ICC_BASE64.length).toBeGreaterThan(1000)
  })

  it('keeps the src ICC constant in sync with the vendored profile', () => {
    const vendored = readFileSync(
      resolve(import.meta.dirname, '../../../../docs/reference/icc/sRGB2014.icc'),
    ).toString('base64')
    expect(SRGB_ICC_BASE64).toBe(vendored)
  })
})

// Helper de test : lit le premier flux EmbeddedFile du catalogue et le décode.
function extractEmbeddedXml(doc: PDFDocument, _name: string): string {
  // Implémentation : parcourir doc.catalog Names → EmbeddedFiles → EF/F stream,
  // décompresser (pdf-lib decodeStream) et décoder UTF-8. Voir Step 4.
  throw new Error('à implémenter au Step 4')
}
```

- [ ] **Step 3 : Vérifier l'échec**

Run: `pnpm --filter @factelec/invoice-core test -- facturx`
Expected: FAIL — `generateFacturX` inexistant.

- [ ] **Step 4 : Implémenter les helpers PDF/A puis `generateFacturX`**

`packages/invoice-core/src/facturx/pdfa.ts` — construction du flux XMP (identification PDF/A-3 + extension schema Factur-X) et de l'`OutputIntent` sRGB :

```ts
import { PDFDocument, PDFName, PDFString } from '@cantoo/pdf-lib'
import { SRGB_ICC_BASE64 } from './srgb-icc.js'

// XMP minimal : identification PDF/A-3 + description Factur-X (profil EN 16931).
export function facturXXmp(invoiceNumber: string): string {
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
   <pdfaid:part>3</pdfaid:part>
   <pdfaid:conformance>B</pdfaid:conformance>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:fx="urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#">
   <fx:DocumentType>INVOICE</fx:DocumentType>
   <fx:DocumentFileName>factur-x.xml</fx:DocumentFileName>
   <fx:Version>1.0</fx:Version>
   <fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/"
    xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#"
    xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">
   <pdfaExtension:schemas><rdf:Bag><rdf:li rdf:parseType="Resource">
    <pdfaSchema:schema>Factur-X PDFA Extension Schema</pdfaSchema:schema>
    <pdfaSchema:namespaceURI>urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#</pdfaSchema:namespaceURI>
    <pdfaSchema:prefix>fx</pdfaSchema:prefix>
    <pdfaSchema:property><rdf:Seq>
     <rdf:li rdf:parseType="Resource"><pdfaProperty:name>DocumentFileName</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>name of the embedded XML</pdfaProperty:description></rdf:li>
     <rdf:li rdf:parseType="Resource"><pdfaProperty:name>DocumentType</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>INVOICE</pdfaProperty:description></rdf:li>
     <rdf:li rdf:parseType="Resource"><pdfaProperty:name>Version</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>version</pdfaProperty:description></rdf:li>
     <rdf:li rdf:parseType="Resource"><pdfaProperty:name>ConformanceLevel</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>conformance level</pdfaProperty:description></rdf:li>
    </rdf:Seq></pdfaSchema:property>
   </rdf:li></rdf:Bag></pdfaExtension:schemas>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`
}

// Injecte l'OutputIntent sRGB (ICC vendorisé) au catalogue.
export function addSrgbOutputIntent(doc: PDFDocument): void {
  const icc = Uint8Array.from(atob(SRGB_ICC_BASE64), (c) => c.charCodeAt(0))
  const iccStream = doc.context.stream(icc, { N: 3, Filter: PDFName.of('FlateDecode') })
  // Note : si non compressé, retirer Filter et compresser en amont selon pdf-lib.
  const iccRef = doc.context.register(iccStream)
  const oi = doc.context.obj({
    Type: 'OutputIntent',
    S: 'GTS_PDFA1',
    OutputConditionIdentifier: PDFString.of('sRGB'),
    Info: PDFString.of('sRGB IEC61966-2.1'),
    DestOutputProfile: iccRef,
  })
  doc.catalog.set(PDFName.of('OutputIntents'), doc.context.obj([oi]))
}
```

`packages/invoice-core/src/facturx/generate.ts` :

```ts
import { AFRelationship, PDFDocument, PDFName } from '@cantoo/pdf-lib'
import type { Invoice } from '../model/schema.js'
import { generateCii } from '../cii/generate.js'
import { addSrgbOutputIntent, facturXXmp } from './pdfa.js'

// Factur-X profil EN 16931 : PDF/A-3 porteur (page minimale, sans glyphe → aucune
// fonte à embarquer) + factur-x.xml (CII D16B) en pièce jointe AFRelationship=Alternative.
// Rendu humainement lisible reporté à un plan ultérieur.
export async function generateFacturXAsync(invoice: Invoice): Promise<Uint8Array> {
  const xml = generateCii(invoice)
  const doc = await PDFDocument.create()
  doc.addPage([595.28, 841.89]) // A4, sans contenu graphique
  await doc.attach(new TextEncoder().encode(xml), 'factur-x.xml', {
    mimeType: 'text/xml',
    description: 'Factur-X invoice',
    afRelationship: AFRelationship.Alternative, // profil EN 16931
  })
  addSrgbOutputIntent(doc)
  // XMP : remplace le flux de métadonnées par le paquet PDF/A + Factur-X.
  const xmp = facturXXmp(invoice.number)
  const meta = doc.context.stream(new TextEncoder().encode(xmp), {
    Type: 'Metadata',
    Subtype: 'XML',
  })
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(meta))
  return doc.save({ useObjectStreams: false }) // PDF/A n'aime pas les object streams
}

// API publique synchrone-friendly (retourne une Promise ; la lib reste pure).
export function generateFacturX(invoice: Invoice): Promise<Uint8Array> {
  return generateFacturXAsync(invoice)
}
```

> **Note d'API** : pdf-lib est asynchrone. `generateFacturX` renvoie donc une `Promise<Uint8Array>` (les tests l'`await`). Adapter les tests du Step 2 en `await` (le `it` doit être `async` et `generateFacturX` attendu). Mettre à jour l'assertion magic bytes en conséquence.

`src/index.ts` — ajouter `export { generateFacturX } from './facturx/generate.js'`.

- [ ] **Step 5 : Implémenter `extractEmbeddedXml` (test) et itérer**

Compléter le helper de test (parcours `catalog → Names → EmbeddedFiles → EF/F`, `stream.decode()` puis `TextDecoder`). Itérer jusqu'au vert. Ajuster les assertions `toContain` sur la sérialisation réelle (les chaînes `/AFRelationship /Alternative`, `pdfaid:part` peuvent apparaître compressées : si le flux XMP est compressé, désactiver la compression du flux `Metadata` — PDF/A exige d'ailleurs le XMP **non** filtré).

Run: `pnpm --filter @factelec/invoice-core test -- facturx`
Expected: PASS. (Pas de golden binaire : le PDF n'est pas déterministe au bit près — dates de création. On teste la **structure** et l'**égalité du XML embarqué**, pas un golden PDF.)

- [ ] **Step 6 : Étape CI optionnelle veraPDF (non bloquante, documentée)**

Créer `.github/workflows/ci-pdfa.yml` (job séparé, `continue-on-error: true`, déclenché manuellement / sur label) : génère un PDF de fixture via un petit script de test, puis lance l'image `verapdf/verapdf` (Java) avec le profil PDF/A-3B et publie le rapport en artefact. **Ne pas** l'ajouter à `ci.yml` (la suite locale/CI principale reste Node pur). Documenter dans le README que la conformité PDF/A-3 formelle est vérifiée par ce job.

- [ ] **Step 7 : Vérifier l'ensemble et committer**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm --filter @factelec/invoice-core test`
Expected: PASS ; couverture ≥ 90 % (le XMP/OutputIntent bas-niveau est exercé par les tests structurels).

```bash
git add -A
git commit -m "feat(invoice-core): génération Factur-X PDF/A-3 avec CII embarqué (pdf-lib)"
```

---

### Task 6 : Backlog de revues (CustomizationID/CIUS, ProfileID commercial, VATEX)

**Files:**
- Create: `docs/reference/vatex/README.md` (provenance : liste blanche BR-CL-22 de `EN16931-CII-codes.sch` déjà vendorisé en tâche 4 ; contre-référence CEF xlsx VATEX v8)
- Create: `packages/invoice-core/src/model/vatex.ts`
- Modify: `packages/invoice-core/src/model/schema.ts` (appartenance VATEX)
- Modify: `packages/invoice-core/src/ubl/generate.ts`, `generate-credit-note.ts` (ProfileID commercial)
- Modify: `packages/invoice-core/tests/model/schema.test.ts`, `packages/invoice-core/tests/model/vatex.test.ts` (nouveau)
- Régénérer: goldens commerciaux `invoice-simple`, `invoice-multi-rate`, `credit-note-simple` (ajout du ProfileID)

**Interfaces:**
- Produces : `export const VATEX_CODES: ReadonlySet<string>`, `export function isVatexCode(v: string): boolean`. Le schéma remplace la validation **regex seule** par une **appartenance** à `VATEX_CODES`. `generateUbl`/`generateCreditNote` émettent `cbc:ProfileID` (BT-23) si `businessProcessType` présent.

- [ ] **Step 1 : Décision CustomizationID/CIUS FR (recherche documentaire)**

Rechercher BT-24 dans l'Annexe 1 (Flux 1) et le dossier général :
```bash
F="docs/reglementaire/specifications-externes-v3.2/2- Annexes_v3.2/20260430_Annexe 1 - Format sémantique FE e-invoicing - Flux 1 - v1.2.xlsx"
unzip -p "$F" xl/sharedStrings.xml | grep -oi 'urn:[a-z0-9:.#-]*\|BT-24\|CIUS' | sort -u | head
```
**Décision par défaut** (si aucune valeur FR prescrite n'apparaît) : conserver `urn:cen.eu:en16931:2017` sur UBL/CII commercial (le Schematron officiel valide déjà cette valeur). **Consigner** la décision (commentaire + README) ; si une valeur CIUS‑FR est trouvée, l'appliquer aux trois générateurs commerciaux et régénérer les goldens concernés. Ce point est listé en « Points de risque n°6 ».

- [ ] **Step 2 : Documenter la provenance + écrire les tests qui échouent**

La source machine est la liste blanche **BR-CL-22** de `docs/reference/en16931-schematron/1.3.16/schematron/codelist/EN16931-CII-codes.sch` (déjà vendorisé en tâche 4 Step 1). Créer `docs/reference/vatex/README.md` (source : BR-CL-22 ; contre-référence CEF xlsx « VATEX v8 » 2025-10-23 ; **89 codes** dont 28 `VATEX-FR-*`). Écrire `packages/invoice-core/tests/model/vatex.test.ts` :

```ts
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { VATEX_CODES, isVatexCode } from '../../src/model/vatex.js'

const CODES_SCH = resolve(
  import.meta.dirname,
  '../../../../docs/reference/en16931-schematron/1.3.16/schematron/codelist/EN16931-CII-codes.sch',
)

describe('VATEX code membership', () => {
  it('accepts real VATEX codes (EU + FR) and rejects a well-formed but unknown one', () => {
    expect(isVatexCode('VATEX-EU-132-1I')).toBe(true)
    expect(isVatexCode('VATEX-EU-AE')).toBe(true)
    expect(isVatexCode('VATEX-FR-CNWVAT')).toBe(true) // avoir net de taxe (G6.21)
    expect(isVatexCode('VATEX-EU-ZZZ99')).toBe(false) // format valide, hors liste
  })

  it('stays in sync with the vendored BR-CL-22 whitelist (no missing/extra code)', () => {
    const sch = readFileSync(CODES_SCH, 'utf8')
    // Codes VATEX cités en dur dans l'assertion BR-CL-22 du Schematron CII.
    const codes = new Set([...sch.matchAll(/VATEX-[A-Z]{2}-[A-Za-z0-9-]+/g)].map((m) => m[0]))
    expect(codes.size).toBeGreaterThan(50)
    expect(codes).toEqual(VATEX_CODES)
  })
})
```
Ajouter à `schema.test.ts` un cas : un code VATEX hors liste (`VATEX-EU-ZZZ99`) sur une ligne exonérée doit faire échouer `parseInvoiceInput`.

- [ ] **Step 3 : Implémenter `vatex.ts` et brancher le schéma**

`packages/invoice-core/src/model/vatex.ts` — littéral **transcrit du genericode** (le test de synchro Step 2 impose l'exhaustivité) :

```ts
// Transcrit de la liste blanche BR-CL-22 de EN16931-CII-codes.sch (release 1.3.16,
// déjà vendorisée). Le test tests/model/vatex.test.ts impose l'égalité stricte avec
// les codes VATEX-XX-* cités dans ce Schematron (89 codes : 61 EU + 28 FR).
export const VATEX_CODES: ReadonlySet<string> = new Set([
  // EU (extrait — compléter d'après BR-CL-22 jusqu'au vert du test de synchro) :
  'VATEX-EU-79-C', 'VATEX-EU-132', 'VATEX-EU-132-1A', 'VATEX-EU-132-1I',
  'VATEX-EU-143', 'VATEX-EU-148', 'VATEX-EU-151', 'VATEX-EU-159',
  'VATEX-EU-309', 'VATEX-EU-AE', 'VATEX-EU-D', 'VATEX-EU-F', 'VATEX-EU-G',
  'VATEX-EU-I', 'VATEX-EU-IC', 'VATEX-EU-O', 'VATEX-EU-J',
  // FR (28 codes CGI — extrait) :
  'VATEX-FR-CGI261-1', 'VATEX-FR-CGI261-2', 'VATEX-FR-CGI261D-1BIS',
  'VATEX-FR-CGI261E-1', 'VATEX-FR-FRANCHISE', 'VATEX-FR-AE', 'VATEX-FR-CNWVAT',
  // … le test de synchro (Step 2) échoue tant que la liste n'est pas complète.
])

export function isVatexCode(value: string): boolean {
  return VATEX_CODES.has(value)
}
```

`packages/invoice-core/src/model/schema.ts` — remplacer `vatexCode` (regex) par une validation d'appartenance, en conservant un message clair :

```ts
import { isVatexCode } from './vatex.js'
const vatexCode = z
  .string()
  .refine(isVatexCode, 'unknown VATEX code (BT-121) — see docs/reference/vatex') // BT-121
```

- [ ] **Step 4 : Émettre `cbc:ProfileID` (BT-23) sur les documents commerciaux**

`generateUbl` (branche Invoice) et `generateCreditNote` — après `CustomizationID`, avant `cbc:ID` :

```ts
  if (invoice.businessProcessType)
    root.ele('cbc:ProfileID').txt(invoice.businessProcessType)
```

(Optionnel EN 16931 : BT-23 → `cbc:ProfileID`. Le Schematron reste vert.) Le CII émet déjà BT-23 (tâche 4).

- [ ] **Step 5 : Régénérer les goldens commerciaux impactés (create-only) et relire**

Le ProfileID modifie les 3 XML commerciaux (les fixtures portent `businessProcessType`).
```bash
rm packages/invoice-core/tests/golden/invoice-simple.ubl.xml \
   packages/invoice-core/tests/golden/invoice-multi-rate.ubl.xml \
   packages/invoice-core/tests/golden/credit-note-simple.ubl.xml
UPDATE_GOLDEN=1 pnpm --filter @factelec/invoice-core test -- generate multi-rate credit-note
```
**Relire** chaque golden : `<cbc:ProfileID>S1|M1</cbc:ProfileID>` inséré entre `CustomizationID` et `ID`. Les goldens **de flux** ne changent pas (ils émettaient déjà ProfileID). Les goldens **CII** ne changent pas.

- [ ] **Step 6 : Vérifier l'ensemble et committer**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm --filter @factelec/invoice-core test`
Expected: PASS ; Schematron toujours vert (ProfileID BT-23 accepté) ; couverture ≥ 90 %.

```bash
git add -A
git commit -m "feat(invoice-core): appartenance VATEX (BT-121) et ProfileID BT-23 sur les documents commerciaux"
```

---

### Task 7 : README + version 0.3.0 + point de reprise

**Files:**
- Modify: `packages/invoice-core/package.json` (`version` → `0.3.0`)
- Modify: `packages/invoice-core/README.md`
- Modify: `README.md` (racine)

**Interfaces:** Consomme tout ce qui précède ; produit la documentation à jour.

- [ ] **Step 1 : Bumper la version**

`packages/invoice-core/package.json` — `"version": "0.2.0"` → `"version": "0.3.0"`.

- [ ] **Step 2 : Mettre à jour le README du package**

`packages/invoice-core/README.md` — ajouter/ajuster l'API publique :

```markdown
- `generateUbl(invoice)` — route **380 → Invoice** / **381 → CreditNote** (UBL 2.1),
  validés XSD OASIS (Invoice **et** CreditNote) et Schematron officiel EN 16931.
- `generateCreditNote(invoice)` — avoir UBL 2.1 (exposé aussi via `generateUbl`).
- `generateFluxExtractUbl(invoice, 'BASE'|'FULL')` — extrait de flux F1 pour la
  facture **et** l'avoir (XSD F1 Invoice/CreditNote).
- `generateCii(invoice)` — CII UN/CEFACT **D16B**, profil EN 16931, validé XSD D16B
  et Schematron officiel EN 16931 CII (saxon-js, Node pur).
- `generateFacturX(invoice): Promise<Uint8Array>` — **Factur-X PDF/A-3** (pdf-lib)
  avec `factur-x.xml` (CII D16B) embarqué (`AFRelationship=Alternative`), XMP PDF/A + Factur-X,
  OutputIntent sRGB. Bytes en mémoire (bibliothèque pure). Page visuelle minimale en
  v1 (rendu lisible reporté). Conformité PDF/A-3 formelle vérifiée hors bande par
  veraPDF (`.github/workflows/ci-pdfa.yml`, non bloquant).
- `VATEX_CODES` / `isVatexCode` — appartenance BT-121 à la liste CEF vendorisée.
```

Section « Conformité vérifiée en tests » : ajouter XSD OASIS CreditNote, XSD F1 CreditNote, XSD CII D16B, Schematron CII, et la ligne « Factur-X : structure PDF/A + XML embarqué == generateCii (Schematron CII) ; conformité PDF/A-3 par veraPDF en CI optionnelle ». Documenter la **limite** (point de risque n°1/2).

- [ ] **Step 3 : Mettre à jour le README racine**

`README.md` (racine) — bloc « État du projet » :

```markdown
> **État du projet (13/07/2026) : plans 1.1, 1.2 et 1.2bis terminés et mergés.**
> `invoice-core` (v0.3.0) livre les **formats du socle** : UBL 2.1 Invoice **et**
> CreditNote (avoir), extraits de flux DGFiP F1 (facture et avoir), CII D16B et
> Factur-X PDF/A-3 (CII embarqué), tous validés XSD + Schematron officiel EN 16931
> (Node pur, saxon-js) ; motifs d'exonération BT-120/121 avec appartenance VATEX ;
> tests par propriétés fast-check. Couverture 100 %.
>
> **Reprise — prochaine étape : plan 1.3** (API NestJS, auth multi-tenant, ingestion).
> La conformité PDF/A-3 formelle (veraPDF, Java) tourne en CI optionnelle non bloquante.
```

Mettre à jour la section `@factelec/invoice-core` (ajouter CII, Factur-X, avoir) et la feuille de route (1.2bis terminé ; insérer 1.3).

- [ ] **Step 4 : Vérifier l'ensemble et committer**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm build && pnpm test`
Expected: PASS ; `package.json` en 0.3.0.

```bash
git add -A
git commit -m "docs(invoice-core): README à jour, version 0.3.0 et point de reprise plan 1.3"
```

---

## Auto-contrôle du plan (relecture périmètre → tâches)

- **Dédoublonnage UBL partagé** → Task 1 (common.ts : namespaces, addAmount, TaxTotal ; goldens au bit près). ✓
- **Avoir UBL commercial (381)** → Task 2 (generateUbl route 380/381 ; XSD OASIS CreditNote + Schematron — XSLT UBL couvre déjà `/cn:CreditNote`, vérifié). ✓
- **Avoir extrait de flux F1** → Task 3 (XSD F1 CreditNote BASE/FULL présents et pinnés ; découverte structurelle « lignes en BASE »). ✓
- **CII commercial D16B** → Task 4 (XSD D16B vendorisés — le D22B réglementaire est inadéquat ; Schematron CII 1.3.16 ; SEF CII). ✓
- **Factur-X PDF/A-3** → Task 5 (pdf-lib MIT ; structure Node pur + XML==CII ; veraPDF en CI optionnelle). ✓
- **Backlog** → Task 6 (CustomizationID/CIUS documenté ; ProfileID BT-23 commercial ; appartenance VATEX). ✓
- **README + version 0.3.0** → Task 7. ✓

**Cohérence des types entre tâches** : helpers `common.ts` (T1/T2) consommés par T2/T3 ; `generateCreditNote` (T2) exporté ; `generateCii` (T4) consommé par T5 ; `validateAgainstSchematron(xml, sef?)` + `CII_SEF` (T4) consommés par T4/T5 ; `VATEX_CODES`/`isVatexCode` (T6) consommés par `schema.ts`. Aucune référence à une fonction non définie.

## Provenance à consigner impérativement au vendoring (checklist)

- [ ] `en16931-cii-1.3.16.zip` : sha256 `1cd53cb8…c561` (revérifié) + entrée dans `docs/reference/en16931-schematron/README.md` (XSLT CII + `EN16931-CII-codes.sch`).
- [ ] XSD CII D16B : dépôt ConnectingEurope (tag `validation-1.3.16`), sha256 du tarball, licence UN/CEFACT → `docs/reference/cii-d16b/README.md`.
- [ ] `sRGB2014.icc` : source color.org, sha256, réutilisation → `docs/reference/icc/README.md`.
- [ ] VATEX : provenance BR-CL-22 (`EN16931-CII-codes.sch`) + CEF xlsx v8 → `docs/reference/vatex/README.md`.
- [ ] Toutes les dépendances nouvelles pinnées **exactement** : `@cantoo/pdf-lib@2.7.2` (MIT ; repli `pdf-lib@1.17.1`).
