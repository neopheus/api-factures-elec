# Plan 1.2 — Conformité EN 16931 et extraits de flux DGFiP

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Durcir `@factelec/invoice-core` jusqu'à la conformité EN 16931 vérifiée par le Schematron officiel, livrer un build `dist/` consommable, et produire les extraits fiscaux de flux DGFiP (F1 BASE/FULL) validés XSD — le tout sans quitter le périmètre « bibliothèque pure ».

**Architecture:** On garde le pivot canonique de 1.1 (zod → calcul big.js → générateurs XML). On ajoute : (1) une sortie compilée `dist/` avec `exports` map ; (2) un verrou de signe et le type d'avoir (381) ; (3) la propagation des motifs d'exonération BT-120/121 ; (4) une passe Schematron EN 16931 exécutée **en Node pur** (saxon-js, aucune JVM) sur les golden files ; (5) un émetteur d'extraits de flux `generateFluxExtractUbl` validé contre les XSD DGFiP F1 ; (6) des tests par propriétés fast-check ; (7) la doc et le bump 0.2.0.

**Tech Stack:** Node ≥ 22, TypeScript 7.0.2 (ESM NodeNext), pnpm workspaces, Vitest v8, zod, big.js, xmlbuilder2, Biome, xmllint (libxml2), **saxon-js + xslt3** (Schematron → SEF → SVRL), **fast-check** (property-based).

## Global Constraints

- **TDD obligatoire** : test écrit et vu échouer (RED) avant toute implémentation (GREEN) ; aucun merge si un test échoue (spec §7).
- **Couverture Vitest v8 bloquante à 90 %** sur les 4 métriques (lines/functions/statements/branches). État actuel : 100 %. Ne pas régresser.
- **TypeScript `strict: true`, ESM (`"type": "module"`), Node ≥ 22.** `typescript` pinné **exactement** `7.0.2` (déjà en place, ne pas modifier).
- `packages/invoice-core/src/` reste une **bibliothèque pure** : aucun I/O réseau/DB/fs hors des tests (spec §3.1).
- Montants : chaînes décimales à **2 décimales exactes** (`"1000.00"`) ; quantités/prix/taux jusqu'à 4 décimales. Arithmétique **big.js**, arrondi **roundHalfUp = demi-loin-de-zéro** (`-1.005 → -1.01`, `-1.004 → -1.00`, vérifié le 2026-07-13).
- `docs/reference/` et `docs/reglementaire/` sont en **lecture seule** : on peut y **AJOUTER** des artefacts vendorisés accompagnés d'un README de provenance, jamais modifier l'existant.
- **Golden files** : bootstrap `UPDATE_GOLDEN=1` **create-only** (ne réécrit jamais un fichier présent). Toute évolution d'un golden est explicite : supprimer puis régénérer, relire, committer.
- Identifiants de code en **anglais** ; messages de commit en **français**, **sans** trailer `Co-Authored-By: Claude` ni mention Claude (préférence Xavier).
- Un commit minimum par tâche, à la fin de chaque tâche.

## Versions pinnées (provenance vérifiée le 2026-07-13)

- **Schematron EN 16931** : dépôt `ConnectingEurope/eInvoicing-EN16931`, release **`validation-1.3.16`** (publiée 2026-04-13, licence **EUPL 1.2**). Asset UBL : `en16931-ubl-1.3.16.zip`, **sha256 `bafada015efbc5248bf5e05ad2191e1d9833ef96e9dd5f4bce420a747342da85`**. Fichier utile : `xslt/EN16931-UBL-validation.xslt` (XSLT 2.0 auto-porteur, aucun `xsl:import`).
- **saxon-js `2.7.0`**, **xslt3 `2.7.0`** (le paquet `xslt3` embarque le compilateur SaxonJS ; 100 % JavaScript, **aucune dépendance Java**).
- **fast-check `4.9.0`**.
- **Codes VATEX** (liste CEF, alignée EN 16931) utilisés dans les fixtures/tests : `VATEX-EU-132-1I` (exonération art. 132 §1 i — enseignement/formation, catégorie E), `VATEX-EU-AE` (autoliquidation, AE), `VATEX-EU-IC` (livraison intracommunautaire, K), `VATEX-EU-G` (export hors UE, G), `VATEX-EU-O` (non soumis à TVA, O).
- **Règles EN 16931 d'exonération** (vérifiées 2026-07-13) : `BR-E-10` (E), `BR-AE-10` (AE), `BR-IC-10` (K), `BR-G-10` (G), `BR-O-10` (O) — chacune : « la ventilation TVA (BG-23) de cette catégorie **doit** porter un code de motif (BT-121) **ou** un texte de motif (BT-120) ».

## Découpage (7 tâches, ordre imposé)

1. Build `dist/` + `exports` map + étape CI.
2. Verrou de signe (montants ≥ 0) + type d'avoir 381 (génération UBL rejetée).
3. Motifs d'exonération BT-120/121 (modèle, calcul, règles BR-*-10, UBL).
4. Passe Schematron EN 16931 officielle (saxon-js) sur les golden files.
5. Émetteur d'extraits de flux DGFiP F1 BASE/FULL (validés XSD).
6. Tests par propriétés (fast-check).
7. README + bump 0.2.0 + point de reprise.

## Point de risque signalé d'emblée

**Le golden multi-taux actuel n'est PAS conforme EN 16931.** Vérifié le 2026-07-13 en exécutant le Schematron 1.3.16 : `invoice-simple.ubl.xml` passe (0 assertion en échec) mais `invoice-multi-rate.ubl.xml` **échoue sur `BR-E-10`** (la ligne « Formation exonérée », catégorie E, n'a pas de motif d'exonération). C'est pourquoi la **tâche 3 précède la tâche 4** : la tâche 3 ajoute le motif et **régénère** le golden multi-taux ; la tâche 4 ne peut verrouiller le Schematron qu'une fois ce golden rendu conforme.

## Structure des fichiers (vue d'ensemble)

- `packages/invoice-core/tsconfig.build.json` *(nouveau)* — configuration d'émission `src/ → dist/` (déclarations + maps), isolée du typecheck des tests.
- `packages/invoice-core/src/model/schema.ts` *(modifié)* — montants non négatifs, motifs d'exonération BT-120/121.
- `packages/invoice-core/src/model/compute.ts` *(modifié)* — propagation des motifs dans la ventilation TVA.
- `packages/invoice-core/src/model/rules.ts` *(modifié)* — règles BR-E/AE/IC/G/O-10.
- `packages/invoice-core/src/ubl/generate.ts` *(modifié)* — émission des motifs d'exonération ; `UnsupportedTypeCodeError` pour 381.
- `packages/invoice-core/src/ubl/errors.ts` *(nouveau)* — erreurs typées de génération.
- `packages/invoice-core/src/flux/generate-extract.ts` *(nouveau)* — `generateFluxExtractUbl(invoice, profile)`.
- `packages/invoice-core/tests/helpers/schematron.ts` *(nouveau)* — passe SVRL via saxon-js.
- `packages/invoice-core/tests/helpers/xsd.ts` *(modifié)* — validation paramétrable par XSD cible (OASIS + F1 BASE/FULL).
- `packages/invoice-core/tests/setup/compile-schematron.ts` *(nouveau)* — `globalSetup` Vitest compilant le XSLT → SEF une fois.
- `docs/reference/en16931-schematron/1.3.16/` *(nouveau, vendorisé)* — artefacts Schematron + README de provenance.

---

### Task 1 : Build `dist/` + `exports` map + CI

**Files:**
- Create: `packages/invoice-core/tsconfig.build.json`
- Create: `packages/invoice-core/tests/build/dist.test.ts`
- Modify: `packages/invoice-core/package.json` (script `build`, `exports`, `main`, `types`, `files`)
- Modify: `package.json` (racine — script `build`)
- Modify: `.github/workflows/ci.yml` (étape `pnpm build`)

**Interfaces:**
- Consumes: l'API publique déjà exportée par `src/index.ts` (`buildInvoice`, `generateUbl`, `validateBusinessRules`, types, etc.).
- Produces (utilisé par les futurs consommateurs NestJS du plan 1.3) :
  - `dist/index.js` + `dist/index.d.ts` + `dist/index.d.ts.map` (rootDir `src`, outDir `dist`).
  - `package.json` `exports["."] = { types: "./dist/index.d.ts", import: "./dist/index.js" }`.
  - Scripts : `pnpm --filter @factelec/invoice-core build` et `pnpm build` (racine, récursif).

- [ ] **Step 1 : Écrire le test de build qui échoue**

`packages/invoice-core/tests/build/dist.test.ts` :

```ts
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const pkgRoot = resolve(import.meta.dirname, '../..')
const tsc = resolve(pkgRoot, '../../node_modules/.bin/tsc')
let outDir: string

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), 'factelec-dist-'))
  // Compile vers un répertoire temporaire : le test est hermétique
  // (il ne dépend pas d'un `pnpm build` préalable).
  execFileSync(tsc, ['-p', resolve(pkgRoot, 'tsconfig.build.json'), '--outDir', outDir], {
    cwd: pkgRoot,
    stdio: 'pipe',
  })
}, 60_000)

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true })
})

describe('build dist', () => {
  it('emits the entrypoint, its declaration and declaration map', () => {
    expect(existsSync(join(outDir, 'index.js'))).toBe(true)
    expect(existsSync(join(outDir, 'index.d.ts'))).toBe(true)
    expect(existsSync(join(outDir, 'index.d.ts.map'))).toBe(true)
  })

  it('exposes the public API from the compiled entrypoint', async () => {
    const mod = await import(pathToFileURL(join(outDir, 'index.js')).href)
    expect(typeof mod.buildInvoice).toBe('function')
    expect(typeof mod.generateUbl).toBe('function')
    expect(typeof mod.validateBusinessRules).toBe('function')
  })

  it('declares a clean exports map pointing at dist', () => {
    const pkg = JSON.parse(readFileSync(resolve(pkgRoot, 'package.json'), 'utf8'))
    expect(pkg.exports['.'].types).toBe('./dist/index.d.ts')
    expect(pkg.exports['.'].import).toBe('./dist/index.js')
    expect(pkg.main).toBe('./dist/index.js')
    expect(pkg.types).toBe('./dist/index.d.ts')
  })
})
```

- [ ] **Step 2 : Vérifier l'échec**

Run: `pnpm --filter @factelec/invoice-core test -- build`
Expected: FAIL — `tsconfig.build.json` introuvable (ou `exports` absent de package.json).

- [ ] **Step 3 : Créer la config de build**

`packages/invoice-core/tsconfig.build.json` :

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist",
    "noEmit": false,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"]
}
```

Note : `tsconfig.base.json` porte déjà `declaration` et `sourceMap` ; on ajoute `declarationMap` et surtout on **désactive** `noEmit` (le `tsconfig.json` de typecheck le laisse actif et inclut les tests — la config de build, elle, ne compile que `src`).

- [ ] **Step 4 : Déclarer le build et l'`exports` map dans le package**

`packages/invoice-core/package.json` — remplacer `main`/`types` et ajouter `exports`, `files`, script `build` :

```json
{
  "name": "@factelec/invoice-core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "test": "vitest run --coverage",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/big.js": "^7.0.0",
    "@vitest/coverage-v8": "^4.1.10",
    "vitest": "^4.1.10"
  },
  "dependencies": {
    "big.js": "^7.0.1",
    "xmlbuilder2": "^4.0.3",
    "zod": "^4.4.3"
  }
}
```

Important : les **tests continuent d'importer les sources** via des chemins relatifs (`../../src/...js`), jamais le nom du package — changer `main`/`exports` vers `dist/` n'affecte donc pas l'exécution de la suite. Le script `typecheck` (`tsc --noEmit`, config `tsconfig.json` qui inclut `src` + `tests`) reste inchangé.

- [ ] **Step 5 : Vérifier que le test de build passe**

Run: `pnpm --filter @factelec/invoice-core test -- build`
Expected: PASS (3 tests verts). Le répertoire `dist/` réel n'est pas requis ici (le test compile en tmp), mais le vrai build est vérifié à l'étape suivante.

- [ ] **Step 6 : Ajouter le script `build` racine et l'étape CI**

`package.json` (racine) — ajouter dans `scripts` :

```json
    "build": "pnpm -r build",
```

`.github/workflows/ci.yml` — insérer une étape `build` **après** `typecheck` (le build doit précéder les consommateurs ; les tests tournent sur les sources, l'ordre build/test est donc libre, mais on prouve que le paquet compile) :

```yaml
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm build
      - run: pnpm test
```

`.gitignore` racine ignore déjà `dist/` (aucune modification). Biome ignore déjà `**/dist` (aucune modification).

- [ ] **Step 7 : Vérifier l'ensemble et committer**

Run:
```bash
pnpm build && ls packages/invoice-core/dist/index.js packages/invoice-core/dist/index.d.ts
pnpm lint && pnpm typecheck && pnpm test
```
Expected: `dist/` produit ; toute la suite verte.

```bash
git add -A
git commit -m "build(invoice-core): compilation dist avec exports map et étape CI"
```

---

### Task 2 : Verrou de signe (montants ≥ 0) + type d'avoir 381

**Files:**
- Create: `packages/invoice-core/src/ubl/errors.ts`
- Modify: `packages/invoice-core/src/model/schema.ts` (montants non négatifs)
- Modify: `packages/invoice-core/src/ubl/generate.ts` (garde 381)
- Modify: `packages/invoice-core/src/index.ts` (export de l'erreur)
- Modify: `packages/invoice-core/tests/fixtures.ts` (fixture `creditNoteInput`)
- Modify: `packages/invoice-core/tests/model/schema.test.ts`, `packages/invoice-core/tests/model/money.test.ts`
- Test: `packages/invoice-core/tests/ubl/credit-note.test.ts`

**Interfaces:**
- Consumes: modèle et générateur de 1.1.
- Produces (utilisé par les tâches 3, 5, 6) :
  - Schéma refusant tout montant/quantité/prix/taux **négatif** (facture 380 comme avoir 381 : convention EN 16931 « montants positifs, le sens est porté par le typeCode »).
  - `class UnsupportedTypeCodeError extends Error` (exportée) ; `generateUbl` la lève pour `typeCode === '381'`.
  - Fixture `creditNoteInput: InvoiceInput` (typeCode 381, montants positifs).

- [ ] **Step 1 : Écrire les tests qui échouent**

Ajouter à `packages/invoice-core/tests/model/schema.test.ts` (dans le `describe('parseInvoiceInput')`) :

```ts
  it('rejects a negative quantity', () => {
    const bad = {
      ...simpleInvoiceInput,
      lines: [{ ...simpleInvoiceInput.lines[0]!, quantity: '-1' }],
    }
    expect(() => parseInvoiceInput(bad)).toThrow()
  })

  it('rejects a negative unit price', () => {
    const bad = {
      ...simpleInvoiceInput,
      lines: [{ ...simpleInvoiceInput.lines[0]!, unitPrice: '-10.00' }],
    }
    expect(() => parseInvoiceInput(bad)).toThrow()
  })

  it('rejects a negative VAT rate', () => {
    const bad = {
      ...simpleInvoiceInput,
      lines: [{ ...simpleInvoiceInput.lines[0]!, vatRate: '-20.00' }],
    }
    expect(() => parseInvoiceInput(bad)).toThrow()
  })

  it('accepts a credit note type code (381)', () => {
    expect(parseInvoiceInput({ ...simpleInvoiceInput, typeCode: '381' }).typeCode).toBe('381')
  })
```

Ajouter à `packages/invoice-core/tests/model/money.test.ts` (nouveau `describe`) :

```ts
describe('round2 on negative values (half away from zero)', () => {
  it('rounds -1.005 to -1.01 and -1.004 to -1.00', () => {
    expect(round2(big('-1.005'))).toBe('-1.01')
    expect(round2(big('-1.004'))).toBe('-1.00')
  })

  it('rounds -2.675 to -2.68', () => {
    expect(round2(big('-2.675'))).toBe('-2.68')
  })
})
```

Créer `packages/invoice-core/tests/ubl/credit-note.test.ts` :

```ts
import { describe, expect, it } from 'vitest'
import { buildInvoice } from '../../src/model/compute.js'
import { UnsupportedTypeCodeError } from '../../src/ubl/errors.js'
import { generateUbl } from '../../src/ubl/generate.js'
import { creditNoteInput, simpleInvoiceInput } from '../fixtures.js'

describe('generateUbl and the credit note type code', () => {
  it('still generates a UBL Invoice for type code 380', () => {
    const out = generateUbl(buildInvoice(simpleInvoiceInput))
    expect(out).toContain('<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>')
  })

  it('throws UnsupportedTypeCodeError for a credit note (381)', () => {
    const creditNote = buildInvoice(creditNoteInput)
    expect(() => generateUbl(creditNote)).toThrow(UnsupportedTypeCodeError)
  })

  it('still computes totals for a credit note (only UBL emission is deferred)', () => {
    const creditNote = buildInvoice(creditNoteInput)
    expect(creditNote.totals.taxInclusive).toBe('1200.00')
  })
})
```

Ajouter la fixture dans `packages/invoice-core/tests/fixtures.ts` :

```ts
export const creditNoteInput: InvoiceInput = {
  ...simpleInvoiceInput,
  number: 'AV-2026-001',
  typeCode: '381',
}
```

- [ ] **Step 2 : Vérifier l'échec**

Run: `pnpm --filter @factelec/invoice-core test -- schema money credit-note`
Expected: FAIL — le module `../../src/ubl/errors.js` est introuvable ; les tests de signe négatif échouent (le schéma actuel accepte `-?`).

- [ ] **Step 3 : Rendre les montants non négatifs**

`packages/invoice-core/src/model/schema.ts` — remplacer les deux regex (retirer le `-?` de tête) :

```ts
const amount2 = z
  .string()
  .regex(/^\d+\.\d{2}$/, 'amount must be non-negative with exactly 2 decimals')
const decimal4 = z
  .string()
  .regex(/^\d+(\.\d{1,4})?$/, 'non-negative decimal with up to 4 decimals')
```

Justification : le périmètre v1 n'a ni remise ni charge de pied de facture (seuls contextes EN 16931 d'un montant négatif). Facture (380) et avoir (381) portent des **montants positifs** — le sens « crédit » est véhiculé par le `typeCode`, pas par le signe. `round2`/`big` (money.ts) restent inchangés : l'arrondi demi-loin-de-zéro sur négatifs demeure testé au niveau arithmétique interne.

- [ ] **Step 4 : Créer l'erreur typée et la garde 381**

`packages/invoice-core/src/ubl/errors.ts` :

```ts
// La génération UBL CreditNote (typeCode 381) est livrée au plan 1.2bis.
// D'ici là, toute tentative d'émettre un avoir échoue de façon explicite
// plutôt que de produire un document UBL Invoice sémantiquement faux.
export class UnsupportedTypeCodeError extends Error {
  readonly typeCode: string
  constructor(typeCode: string) {
    super(
      `Génération UBL non supportée pour le typeCode ${typeCode} ` +
        '(seule la facture 380 est émise en 1.2 ; l\'avoir 381 arrive au plan 1.2bis).',
    )
    this.name = 'UnsupportedTypeCodeError'
    this.typeCode = typeCode
  }
}
```

`packages/invoice-core/src/ubl/generate.ts` — importer l'erreur et garder l'entrée de `generateUbl` :

```ts
import { UnsupportedTypeCodeError } from './errors.js'
```

Puis, tout début du corps de `generateUbl` (avant la construction du document) :

```ts
export function generateUbl(invoice: Invoice): string {
  if (invoice.typeCode !== '380') {
    throw new UnsupportedTypeCodeError(invoice.typeCode)
  }
  const doc = create({ version: '1.0', encoding: 'UTF-8' })
  // ... (inchangé)
```

- [ ] **Step 5 : Exporter l'erreur**

`packages/invoice-core/src/index.ts` — ajouter :

```ts
export { UnsupportedTypeCodeError } from './ubl/errors.js'
```

- [ ] **Step 6 : Vérifier que tout passe**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS. Les golden files existants (380, montants positifs) restent valides et inchangés.

- [ ] **Step 7 : Commit**

```bash
git add -A
git commit -m "feat(invoice-core): montants non négatifs et refus explicite de l'avoir 381 à la génération"
```

---

### Task 3 : Motifs d'exonération BT-120/121

**Files:**
- Modify: `packages/invoice-core/src/model/schema.ts` (champs d'exonération)
- Modify: `packages/invoice-core/src/model/compute.ts` (propagation dans la ventilation)
- Modify: `packages/invoice-core/src/model/rules.ts` (règles BR-*-10)
- Modify: `packages/invoice-core/src/ubl/generate.ts` (émission UBL)
- Modify: `packages/invoice-core/tests/fixtures.ts` (motif sur la ligne exonérée)
- Modify: `packages/invoice-core/tests/model/schema.test.ts`, `.../compute.test.ts`, `.../rules.test.ts`
- Régénérer: `packages/invoice-core/tests/golden/invoice-multi-rate.ubl.xml`

**Interfaces:**
- Consumes: modèle, calcul et règles de 1.1 + tâche 2.
- Produces (utilisé par les tâches 4, 5, 6) :
  - `InvoiceLineInput` et `VatBreakdown` portent `exemptionReasonCode?` (BT-121) et `exemptionReason?` (BT-120).
  - `buildInvoice` propage le motif de la **première ligne** du groupe (catégorie, taux) vers la ligne de ventilation.
  - `validateBusinessRules` signale `BR-E-10` / `BR-AE-10` / `BR-IC-10` / `BR-G-10` / `BR-O-10` quand une ventilation exonérée n'a ni code ni texte.
  - `generateUbl` émet `cbc:TaxExemptionReasonCode` et/ou `cbc:TaxExemptionReason` dans `cac:TaxCategory` (après `cbc:Percent`, avant `cac:TaxScheme` — ordre imposé par le XSD OASIS `TaxCategoryType`, vérifié le 2026-07-13).

- [ ] **Step 1 : Écrire les tests qui échouent**

Ajouter à `packages/invoice-core/tests/model/schema.test.ts` :

```ts
  it('accepts an exemption reason code and text on a line', () => {
    const withReason = {
      ...simpleInvoiceInput,
      lines: [
        {
          ...simpleInvoiceInput.lines[0]!,
          vatCategory: 'E',
          vatRate: '0.00',
          exemptionReasonCode: 'VATEX-EU-132-1I',
          exemptionReason: 'Formation professionnelle exonérée',
        },
      ],
    }
    const parsed = parseInvoiceInput(withReason)
    expect(parsed.lines[0]!.exemptionReasonCode).toBe('VATEX-EU-132-1I')
    expect(parsed.lines[0]!.exemptionReason).toBe('Formation professionnelle exonérée')
  })
```

Ajouter à `packages/invoice-core/tests/model/compute.test.ts` :

```ts
  it('propagates the exemption reason from the line to the VAT breakdown', () => {
    const invoice = buildInvoice(multiRateInvoiceInput)
    const exempt = invoice.vatBreakdown.find((b) => b.category === 'E')
    expect(exempt?.exemptionReasonCode).toBe('VATEX-EU-132-1I')
  })

  it('leaves standard-rate breakdowns without an exemption reason', () => {
    const invoice = buildInvoice(multiRateInvoiceInput)
    const standard = invoice.vatBreakdown.find((b) => b.category === 'S')
    expect(standard?.exemptionReasonCode).toBeUndefined()
    expect(standard?.exemptionReason).toBeUndefined()
  })
```

Ajouter à `packages/invoice-core/tests/model/rules.test.ts` (le helper construit une ventilation exonérée sans motif ; on cible chaque code de règle) :

```ts
import type { VatCategory } from '../../src/model/schema.js'

const exemptionCases: ReadonlyArray<[VatCategory, string]> = [
  ['E', 'BR-E-10'],
  ['AE', 'BR-AE-10'],
  ['K', 'BR-IC-10'],
  ['G', 'BR-G-10'],
  ['O', 'BR-O-10'],
]

describe('exemption reason rules (BR-*-10)', () => {
  for (const [category, rule] of exemptionCases) {
    it(`flags ${rule} when a ${category} breakdown has no exemption reason`, () => {
      const base = buildInvoice(simpleInvoiceInput)
      const invoice = {
        ...base,
        lines: [{ ...base.lines[0]!, vatCategory: category, vatRate: '0.00' }],
        vatBreakdown: [
          {
            category,
            rate: '0.00',
            taxableAmount: base.lines[0]!.lineNetAmount,
            taxAmount: '0.00',
          },
        ],
        totals: { ...base.totals, taxAmount: '0.00', taxInclusive: base.totals.taxExclusive, payable: base.totals.taxExclusive },
      }
      const rules = validateBusinessRules(invoice).map((v) => v.rule)
      expect(rules).toContain(rule)
    })
  }

  it('does not flag BR-E-10 when the exemption reason code is present', () => {
    const invoice = buildInvoice(multiRateInvoiceInput) // ligne E porte VATEX-EU-132-1I
    expect(validateBusinessRules(invoice).map((v) => v.rule)).not.toContain('BR-E-10')
  })
})
```

Mettre à jour la fixture `packages/invoice-core/tests/fixtures.ts` — ajouter le motif sur la ligne « Formation exonérée » (id 3) :

```ts
    {
      id: '3',
      name: 'Formation exonérée',
      quantity: '2',
      unitCode: 'C62',
      unitPrice: '150.00',
      vatCategory: 'E',
      vatRate: '0.00',
      exemptionReasonCode: 'VATEX-EU-132-1I',
    },
```

- [ ] **Step 2 : Vérifier l'échec**

Run: `pnpm --filter @factelec/invoice-core test -- schema compute rules`
Expected: FAIL — champs `exemptionReasonCode`/`exemptionReason` inconnus du schéma ; règles BR-*-10 absentes.

- [ ] **Step 3 : Ajouter les champs au schéma**

`packages/invoice-core/src/model/schema.ts` — étendre la ligne et la ventilation. `exemptionReasonCode` (BT-121) accepte un identifiant VATEX (préfixe `VATEX-`), `exemptionReason` (BT-120) est libre :

```ts
const vatexCode = z.string().regex(/^VATEX-[A-Z]{2}(-[A-Za-z0-9]+)+$/, 'invalid VATEX code') // BT-121

export const invoiceLineInputSchema = z.object({
  id: z.string().min(1), // BT-126
  name: z.string().min(1), // BT-153
  quantity: decimal4, // BT-129
  unitCode: z.string().min(2).max(3), // BT-130
  unitPrice: decimal4, // BT-146
  vatCategory: vatCategorySchema, // BT-151
  vatRate: decimal4, // BT-152
  exemptionReasonCode: vatexCode.optional(), // BT-121 (VATEX)
  exemptionReason: z.string().min(1).optional(), // BT-120 (texte libre)
})
```

Et sur la ventilation :

```ts
export const vatBreakdownSchema = z.object({
  category: vatCategorySchema, // BT-118
  rate: decimal4, // BT-119
  taxableAmount: amount2, // BT-116
  taxAmount: amount2, // BT-117
  exemptionReasonCode: vatexCode.optional(), // BT-121
  exemptionReason: z.string().min(1).optional(), // BT-120
})
```

(Les types inférés `InvoiceLineInput`, `VatBreakdown` se mettent à jour automatiquement.)

- [ ] **Step 4 : Propager le motif dans la ventilation**

`packages/invoice-core/src/model/compute.ts` — dans `computeVatBreakdown`, reprendre le motif de la **première ligne du groupe qui en porte un** :

```ts
  return pairs.map(({ category, rate }) => {
    const groupLines = lines.filter((line) => vatKey(line) === `${category}|${rate}`)
    const taxable = groupLines.reduce((acc, line) => acc.plus(line.lineNetAmount), big('0'))
    const withReason = groupLines.find(
      (line) => line.exemptionReasonCode || line.exemptionReason,
    )
    return {
      category,
      rate,
      taxableAmount: round2(taxable),
      // BR-CO-17 : TVA de catégorie = assiette × taux, arrondie à 2 décimales
      taxAmount: round2(taxable.times(rate).div(100)),
      ...(withReason?.exemptionReasonCode
        ? { exemptionReasonCode: withReason.exemptionReasonCode }
        : {}),
      ...(withReason?.exemptionReason
        ? { exemptionReason: withReason.exemptionReason }
        : {}),
    }
  })
```

- [ ] **Step 5 : Ajouter les règles BR-*-10**

`packages/invoice-core/src/model/rules.ts` — table catégorie → code de règle, puis contrôle dans la boucle sur les ventilations :

```ts
// EN 16931 : une ventilation TVA (BG-23) d'une catégorie exonérée doit porter
// un code de motif (BT-121) OU un texte de motif (BT-120). Le code de règle
// dépend de la catégorie.
const exemptionReasonRuleByCategory: Partial<Record<VatCategory, string>> = {
  E: 'BR-E-10',
  AE: 'BR-AE-10',
  K: 'BR-IC-10',
  G: 'BR-G-10',
  O: 'BR-O-10',
}
```

Dans la boucle `for (const b of invoice.vatBreakdown)`, ajouter en tête :

```ts
    const exemptionRule = exemptionReasonRuleByCategory[b.category]
    if (exemptionRule && !b.exemptionReasonCode && !b.exemptionReason)
      push(
        exemptionRule,
        `ventilation ${b.category} sans motif d'exonération (BT-120/BT-121 requis)`,
      )
```

- [ ] **Step 6 : Émettre le motif dans l'UBL**

`packages/invoice-core/src/ubl/generate.ts` — dans la boucle `for (const b of invoice.vatBreakdown)`, entre `cbc:Percent` et `cac:TaxScheme` de `cac:TaxCategory` :

```ts
    const category = sub.ele('cac:TaxCategory')
    category.ele('cbc:ID').txt(b.category)
    category.ele('cbc:Percent').txt(b.rate)
    if (b.exemptionReasonCode)
      category.ele('cbc:TaxExemptionReasonCode').txt(b.exemptionReasonCode)
    if (b.exemptionReason)
      category.ele('cbc:TaxExemptionReason').txt(b.exemptionReason)
    category.ele('cac:TaxScheme').ele('cbc:ID').txt('VAT')
```

(On n'émet le motif qu'au niveau de la ventilation — BG-23 — comme l'exige BR-E-10 ; la `cac:ClassifiedTaxCategory` de la ligne reste ID/Percent/TaxScheme.)

- [ ] **Step 7 : Vérifier les tests unitaires**

Run: `pnpm --filter @factelec/invoice-core test -- schema compute rules generate`
Expected: PASS pour ces suites. La suite `xsd`/`multi-rate` va en revanche échouer au golden : c'est attendu, on le régénère à l'étape suivante.

- [ ] **Step 8 : Régénérer le golden multi-taux (create-only) puis relire**

Le motif d'exonération modifie le XML : il faut **supprimer** puis recréer le golden (le bootstrap est create-only).

Run:
```bash
rm packages/invoice-core/tests/golden/invoice-multi-rate.ubl.xml
UPDATE_GOLDEN=1 pnpm --filter @factelec/invoice-core test -- multi-rate
cat packages/invoice-core/tests/golden/invoice-multi-rate.ubl.xml
```
Expected: le golden est recréé. **Relire intégralement** : la `cac:TaxCategory` de la ventilation E doit désormais contenir
`<cbc:TaxExemptionReasonCode>VATEX-EU-132-1I</cbc:TaxExemptionReasonCode>` entre `<cbc:Percent>0.00</cbc:Percent>` et `<cac:TaxScheme>`. Les montants (59.97/3.30, 49.90/9.98, 300.00/0.00, TTC 423.15) sont inchangés.

- [ ] **Step 9 : Vérifier XSD + suite complète**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS — la validation OASIS UBL 2.1 (xmllint) reste verte avec les nouveaux éléments (position conforme au `TaxCategoryType`).

- [ ] **Step 10 : Commit**

```bash
git add -A
git commit -m "feat(invoice-core): motifs d'exonération TVA BT-120/121 et règles BR-*-10"
```

---

### Task 4 : Passe Schematron EN 16931 officielle (Node pur)

**Files:**
- Create (vendorisé): `docs/reference/en16931-schematron/1.3.16/` (artefacts + `README.md` de provenance)
- Create: `packages/invoice-core/tests/setup/compile-schematron.ts` (globalSetup Vitest)
- Create: `packages/invoice-core/tests/helpers/schematron.ts`
- Create: `packages/invoice-core/tests/ubl/schematron.test.ts`
- Modify: `packages/invoice-core/vitest.config.ts` (globalSetup)
- Modify: `packages/invoice-core/package.json` (devDeps saxon-js + xslt3)
- Modify: `.gitignore` (cache SEF)

**Interfaces:**
- Consumes: `generateUbl`, `buildInvoice`, fixtures ; golden files (dont le multi-taux rendu conforme en tâche 3).
- Produces (utilisé par les tâches 5, 6) :
  - `validateAgainstSchematron(xml: string): { valid: boolean; failedAsserts: SchematronViolation[] }` avec `type SchematronViolation = { id: string; flag: string; text: string; location: string }`.
  - Exécution **100 % Node** (saxon-js), aucune JVM, aucun binaire système supplémentaire.

- [ ] **Step 1 : Vendoriser l'artefact Schematron + README de provenance**

Le zip officiel ne se stocke pas tel quel : on vendorise son contenu utile (sources Schematron + XSLT pré-compilé), avec un README de provenance et le sha256 du zip d'origine.

Run:
```bash
mkdir -p docs/reference/en16931-schematron/1.3.16
cd /tmp
gh release download validation-1.3.16 --repo ConnectingEurope/eInvoicing-EN16931 \
  --pattern 'en16931-ubl-1.3.16.zip' --dir /tmp/en16931 --clobber
shasum -a 256 /tmp/en16931/en16931-ubl-1.3.16.zip
# Attendu : bafada015efbc5248bf5e05ad2191e1d9833ef96e9dd5f4bce420a747342da85
cd /Users/xavier/Sites/api-factures-elec
unzip -o /tmp/en16931/en16931-ubl-1.3.16.zip 'xslt/*' 'schematron/*' \
  -d docs/reference/en16931-schematron/1.3.16/
```
Expected : le sha256 correspond exactement ; l'arborescence `docs/reference/en16931-schematron/1.3.16/xslt/EN16931-UBL-validation.xslt` et `.../schematron/...` est présente. **On ne vendorise pas** le dossier `examples/`.

Créer `docs/reference/en16931-schematron/README.md` :

```markdown
# Schematron EN 16931 (validation métier officielle)

Artefacts de validation Schematron pour la norme EN 16931, dépôt officiel
CEN/TC 434 : https://github.com/ConnectingEurope/eInvoicing-EN16931

- Release : `validation-1.3.16` (publiée 2026-04-13).
- Asset : `en16931-ubl-1.3.16.zip`.
- sha256 : `bafada015efbc5248bf5e05ad2191e1d9833ef96e9dd5f4bce420a747342da85`.
- Licence : EUPL 1.2.

`1.3.16/xslt/EN16931-UBL-validation.xslt` est le Schematron pré-compilé en XSLT 2.0
(auto-porteur). Il est compilé en SEF (saxon-js) au lancement des tests puis exécuté
en Node pur (aucune JVM) pour produire un rapport SVRL. Toute assertion en échec
(`svrl:failed-assert`) rend le test rouge. Ne jamais modifier ces fichiers ; pour
changer de version, ajouter un nouveau sous-dossier `<version>/` et son entrée ici.
```

- [ ] **Step 2 : Installer les dépendances de compilation Schematron**

Run:
```bash
pnpm --filter @factelec/invoice-core add -D saxon-js@2.7.0 xslt3@2.7.0
```
Expected : `saxon-js` et `xslt3` en devDependencies (exactement 2.7.0). Pur JavaScript, aucune dépendance Java.

- [ ] **Step 3 : Ignorer le cache SEF**

`.gitignore` racine — ajouter :

```
*.sef.json
```

Le SEF (~6,8 Mo) est un artefact de build reproductible : on ne le versionne pas, on le (re)compile au besoin.

- [ ] **Step 4 : Écrire le globalSetup qui compile le XSLT en SEF**

`packages/invoice-core/tests/setup/compile-schematron.ts` :

```ts
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

const require = createRequire(import.meta.url)

const XSLT = resolve(
  import.meta.dirname,
  '../../../../docs/reference/en16931-schematron/1.3.16/xslt/EN16931-UBL-validation.xslt',
)
export const SEF = resolve(import.meta.dirname, '../.sef/EN16931-UBL-validation.sef.json')

// Compile une seule fois le Schematron (XSLT 2.0) en SEF SaxonJS, si absent ou périmé.
export default function setup(): void {
  if (existsSync(SEF) && statSync(SEF).mtimeMs >= statSync(XSLT).mtimeMs) return
  mkdirSync(dirname(SEF), { recursive: true })
  const xslt3Bin = require.resolve('xslt3')
  execFileSync(process.execPath, [xslt3Bin, `-xsl:${XSLT}`, `-export:${SEF}`, '-nogo'], {
    stdio: 'pipe',
  })
}
```

- [ ] **Step 5 : Brancher le globalSetup dans Vitest**

`packages/invoice-core/vitest.config.ts` — ajouter `globalSetup` :

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/setup/compile-schematron.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      thresholds: { lines: 90, functions: 90, statements: 90, branches: 90 },
    },
  },
})
```

- [ ] **Step 6 : Écrire le helper Schematron**

`packages/invoice-core/tests/helpers/schematron.ts` :

```ts
import { resolve } from 'node:path'
// saxon-js n'a pas de types ; import CommonJS via l'interop ESM.
import SaxonJS from 'saxon-js'

const SEF = resolve(import.meta.dirname, '../.sef/EN16931-UBL-validation.sef.json')

export type SchematronViolation = {
  id: string
  flag: string
  text: string
  location: string
}

// Exécute le Schematron EN 16931 (SEF SaxonJS) sur un document UBL et renvoie
// les assertions en échec extraites du rapport SVRL. 100 % Node, aucune JVM.
// Forme d'appel vérifiée le 2026-07-13 : stylesheetFileName (SEF) + sourceText.
export function validateAgainstSchematron(xml: string): {
  valid: boolean
  failedAsserts: SchematronViolation[]
} {
  const out = SaxonJS.transform(
    { stylesheetFileName: SEF, sourceText: xml, destination: 'serialized' },
    'sync',
  ) as { principalResult: string }
  const svrl = out.principalResult
  const failedAsserts: SchematronViolation[] = []
  const re = /<svrl:failed-assert\b([^>]*)>([\s\S]*?)<\/svrl:failed-assert>/g
  for (const m of svrl.matchAll(re)) {
    const attrs = m[1] ?? ''
    const body = m[2] ?? ''
    const attr = (name: string) =>
      new RegExp(`${name}="([^"]*)"`).exec(attrs)?.[1] ?? ''
    const textMatch = /<svrl:text>([\s\S]*?)<\/svrl:text>/.exec(body)
    failedAsserts.push({
      id: attr('id'),
      flag: attr('flag'),
      location: attr('location'),
      text: (textMatch?.[1] ?? '').replace(/\s+/g, ' ').trim(),
    })
  }
  return { valid: failedAsserts.length === 0, failedAsserts }
}
```

Note : `saxon-js` n'expose pas de déclarations de types. Si `tsc` bloque sur l'import, ajouter `packages/invoice-core/tests/saxon-js.d.ts` avec `declare module 'saxon-js'` exposant `transform(options: unknown, mode: 'sync'): { principalResult: string }`.

- [ ] **Step 7 : Écrire le test Schematron qui échoue**

`packages/invoice-core/tests/ubl/schematron.test.ts` :

```ts
import { describe, expect, it } from 'vitest'
import { buildInvoice } from '../../src/model/compute.js'
import { generateUbl } from '../../src/ubl/generate.js'
import { validateAgainstSchematron } from '../helpers/schematron.js'
import { multiRateInvoiceInput, simpleInvoiceInput } from '../fixtures.js'

describe('EN 16931 Schematron (official) on generated UBL', () => {
  it('passes for the simple invoice', () => {
    const result = validateAgainstSchematron(generateUbl(buildInvoice(simpleInvoiceInput)))
    expect(result.failedAsserts).toEqual([])
    expect(result.valid).toBe(true)
  })

  it('passes for the multi-rate invoice (exemption reason now present)', () => {
    const result = validateAgainstSchematron(generateUbl(buildInvoice(multiRateInvoiceInput)))
    expect(result.failedAsserts.map((f) => f.id)).toEqual([])
    expect(result.valid).toBe(true)
  })

  it('detects BR-E-10 when the exemption reason is stripped', () => {
    const invoice = buildInvoice(multiRateInvoiceInput)
    const withoutReason = {
      ...invoice,
      vatBreakdown: invoice.vatBreakdown.map((b) =>
        b.category === 'E'
          ? { category: b.category, rate: b.rate, taxableAmount: b.taxableAmount, taxAmount: b.taxAmount }
          : b,
      ),
    }
    const result = validateAgainstSchematron(generateUbl(withoutReason))
    expect(result.valid).toBe(false)
    expect(result.failedAsserts.map((f) => f.id)).toContain('BR-E-10')
  })
})
```

- [ ] **Step 8 : Vérifier l'échec puis l'implémentation**

Run: `pnpm --filter @factelec/invoice-core test -- schematron`
Expected: d'abord FAIL — helper/SEF absents. Après les étapes 1-6, le globalSetup compile le SEF (~10-20 s au premier lancement) et les 3 tests passent. Vérifié le 2026-07-13 : `invoice-simple` → 0 assertion, `invoice-multi-rate` avec motif → 0 assertion, sans motif → `BR-E-10`.

- [ ] **Step 9 : Vérifier l'ensemble et committer**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS. La CI n'a **pas** besoin d'étape système supplémentaire (saxon-js est pur Node).

```bash
git add -A
git commit -m "test(invoice-core): passe Schematron EN 16931 officielle en Node pur (saxon-js)"
```

---

### Task 5 : Émetteur d'extraits de flux DGFiP F1 BASE/FULL

**Files:**
- Create: `packages/invoice-core/src/flux/generate-extract.ts`
- Modify: `packages/invoice-core/src/index.ts` (export)
- Modify: `packages/invoice-core/tests/helpers/xsd.ts` (XSD cible paramétrable)
- Create: `packages/invoice-core/tests/flux/flux-extract.test.ts`
- Régénérer: `packages/invoice-core/tests/golden/flux-base-multi-rate.ubl.xml`, `packages/invoice-core/tests/golden/flux-full-multi-rate.ubl.xml`

**Découverte structurante (vérifiée xmllint le 2026-07-13)** : les profils F1 ne restreignent pas par `maxOccurs="0"` mais en **commentant les `xsd:element ref`** interdits dans les `complexType`. Un ref commenté = élément **absent du modèle** → rejeté. Conclusions communes BASE **et** FULL : `cac:PartyName` interdit ; `cbc:RegistrationName` interdit (`PartyLegalEntity` = `cbc:CompanyID` seul, obligatoire) ; `LegalMonetaryTotal` réduit au **seul** `cbc:TaxExclusiveAmount` (`LineExtensionAmount`, `TaxInclusiveAmount`, `PayableAmount` interdits) ; **`cbc:ProfileID` obligatoire** (à ajouter, absent du UBL commercial). Spécifique BASE : `cac:InvoiceLine` **interdit** (facture sans lignes). Spécifique FULL : lignes conservées mais épurées — pas de `cbc:ID` de ligne, pas de `cbc:LineExtensionAmount` de ligne, `ItemType` réduit à `cbc:Name` seul (**`cac:ClassifiedTaxCategory` interdit**) ; `cac:Country` et son `cbc:IdentificationCode` obligatoires. Les deux profils passent `VALID` après ces transformations (confirmé sur les golden simple et multi-taux).

**Interfaces:**
- Consumes: `Invoice`, `buildInvoice`, motifs d'exonération (tâche 3), `UnsupportedTypeCodeError` (tâche 2), fixtures.
- Produces :
  - `type FluxProfile = 'BASE' | 'FULL'`.
  - `generateFluxExtractUbl(invoice: Invoice, profile: FluxProfile): string` — extrait fiscal UBL 2.1 validé contre le XSD DGFiP F1 correspondant (lève `UnsupportedTypeCodeError` pour un typeCode ≠ 380).
  - Helper de test étendu : `validateAgainstXsd(xml, xsdPath?)` + constantes `OASIS_UBL_INVOICE_XSD`, `F1_BASE_UBL_INVOICE_XSD`, `F1_FULL_UBL_INVOICE_XSD`.

- [ ] **Step 1 : Rendre le helper XSD paramétrable (rétrocompatible)**

`packages/invoice-core/tests/helpers/xsd.ts` — remplacer intégralement :

```ts
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REG = '../../../../docs/reglementaire/specifications-externes-v3.2/3- XSD_v3.2/2 - E-invoicing'

export const OASIS_UBL_INVOICE_XSD = resolve(
  import.meta.dirname,
  '../../../../docs/reference/ubl-2.1/maindoc/UBL-Invoice-2.1.xsd',
)
export const F1_BASE_UBL_INVOICE_XSD = resolve(
  import.meta.dirname,
  `${REG}/F1_BASE_UBL_2.1/F1BASE_UBL-invoice-2.1.xsd`,
)
export const F1_FULL_UBL_INVOICE_XSD = resolve(
  import.meta.dirname,
  `${REG}/F1_FULL_UBL_2.1/F1FULL_UBL_invoice-2.1.xsd`,
)

// xsdPath par défaut = XSD commercial OASIS (compatibilité avec les tests existants).
export function validateAgainstXsd(
  xml: string,
  xsdPath: string = OASIS_UBL_INVOICE_XSD,
): { valid: boolean; errors: string } {
  const dir = mkdtempSync(join(tmpdir(), 'factelec-xsd-'))
  const xmlPath = join(dir, 'invoice.xml')
  writeFileSync(xmlPath, xml, 'utf8')
  try {
    execFileSync('xmllint', ['--noout', '--schema', xsdPath, xmlPath], { stdio: 'pipe' })
    return { valid: true, errors: '' }
  } catch (error) {
    const e = error as { stderr?: Buffer }
    return { valid: false, errors: e.stderr?.toString() ?? String(error) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
```

Note : les XSD F1 émettent des *warnings* d'import en double sur stderr mais **exit 0** → `valid: true`. Les tests existants (`xsd.test.ts`, `multi-rate.test.ts`) appellent `validateAgainstXsd(xml)` sans second argument : inchangés.

- [ ] **Step 2 : Écrire le test qui échoue**

`packages/invoice-core/tests/flux/flux-extract.test.ts` :

```ts
import { describe, expect, it } from 'vitest'
import { buildInvoice } from '../../src/model/compute.js'
import { generateFluxExtractUbl } from '../../src/flux/generate-extract.js'
import { expectMatchesGolden } from '../helpers/golden.js'
import {
  F1_BASE_UBL_INVOICE_XSD,
  F1_FULL_UBL_INVOICE_XSD,
  validateAgainstXsd,
} from '../helpers/xsd.js'
import { multiRateInvoiceInput, simpleInvoiceInput } from '../fixtures.js'

describe('generateFluxExtractUbl', () => {
  it('BASE validates against the DGFiP F1 BASE XSD (simple and multi-rate)', () => {
    for (const input of [simpleInvoiceInput, multiRateInvoiceInput]) {
      const r = validateAgainstXsd(generateFluxExtractUbl(buildInvoice(input), 'BASE'), F1_BASE_UBL_INVOICE_XSD)
      expect(r.errors).toBe('')
      expect(r.valid).toBe(true)
    }
  })

  it('FULL validates against the DGFiP F1 FULL XSD (simple and multi-rate)', () => {
    for (const input of [simpleInvoiceInput, multiRateInvoiceInput]) {
      const r = validateAgainstXsd(generateFluxExtractUbl(buildInvoice(input), 'FULL'), F1_FULL_UBL_INVOICE_XSD)
      expect(r.errors).toBe('')
      expect(r.valid).toBe(true)
    }
  })

  it('emits the mandatory ProfileID and drops the forbidden monetary totals', () => {
    const xml = generateFluxExtractUbl(buildInvoice(multiRateInvoiceInput), 'BASE')
    expect(xml).toContain('<cbc:ProfileID>')
    expect(xml).not.toContain('TaxInclusiveAmount')
    expect(xml).not.toContain('PayableAmount')
    expect(xml).toContain('<cbc:TaxExclusiveAmount currencyID="EUR">409.87</cbc:TaxExclusiveAmount>')
  })

  it('BASE carries no invoice lines', () => {
    const xml = generateFluxExtractUbl(buildInvoice(multiRateInvoiceInput), 'BASE')
    expect(xml).not.toContain('<cac:InvoiceLine>')
  })

  it('FULL keeps epured lines (no line id, no line net amount, no per-line VAT)', () => {
    const xml = generateFluxExtractUbl(buildInvoice(multiRateInvoiceInput), 'FULL')
    expect(xml).toContain('<cac:InvoiceLine>')
    expect(xml).not.toContain('<cac:ClassifiedTaxCategory>')
    expect(xml).toContain('<cbc:Name>Livre</cbc:Name>')
  })

  it('neither profile carries party names or registration names', () => {
    for (const profile of ['BASE', 'FULL'] as const) {
      const xml = generateFluxExtractUbl(buildInvoice(simpleInvoiceInput), profile)
      expect(xml).not.toContain('<cac:PartyName>')
      expect(xml).not.toContain('<cbc:RegistrationName>')
    }
  })

  it('rejects a credit note (381)', () => {
    const creditNote = { ...buildInvoice(simpleInvoiceInput), typeCode: '381' as const }
    expect(() => generateFluxExtractUbl(creditNote, 'BASE')).toThrow()
  })

  it('matches the frozen BASE golden (multi-rate)', () => {
    expectMatchesGolden('flux-base-multi-rate.ubl.xml', generateFluxExtractUbl(buildInvoice(multiRateInvoiceInput), 'BASE'))
  })

  it('matches the frozen FULL golden (multi-rate)', () => {
    expectMatchesGolden('flux-full-multi-rate.ubl.xml', generateFluxExtractUbl(buildInvoice(multiRateInvoiceInput), 'FULL'))
  })
})
```

Run: `pnpm --filter @factelec/invoice-core test -- flux`
Expected: FAIL — module `../../src/flux/generate-extract.js` introuvable.

- [ ] **Step 3 : Implémenter l'émetteur d'extraits**

`packages/invoice-core/src/flux/generate-extract.ts` :

```ts
import { create } from 'xmlbuilder2'
import type { XMLBuilder } from 'xmlbuilder2/lib/interfaces.js'
import type { Invoice, Party } from '../model/schema.js'
import { UnsupportedTypeCodeError } from '../ubl/errors.js'

export type FluxProfile = 'BASE' | 'FULL'

const NS_INVOICE = 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2'
const NS_CAC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2'
const NS_CBC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2'

// cbc:ProfileID est structurellement OBLIGATOIRE dans les XSD F1 (aucune énumération,
// toute chaîne non vide valide). La valeur sémantique DGFiP exacte (identifiant de
// processus du flux 1) reste à confirmer contre le dossier de spécifications externes
// v3.2 — cf. point de risque du plan. Valeur provisoire, isolée dans une constante.
const FLUX_PROFILE_ID = 'DGFIP:CTC:FLUX1:1.0'

function addAmount(parent: XMLBuilder, name: string, value: string, currency: string): void {
  parent.ele(`cbc:${name}`).att('currencyID', currency).txt(value)
}

// Partie « fiscale » : ni cac:PartyName ni cbc:RegistrationName (interdits F1).
// PartyLegalEntity = cbc:CompanyID seul, omis si le SIREN est absent (sinon bloc vide invalide).
function addFluxParty(
  parent: XMLBuilder,
  role: 'AccountingSupplierParty' | 'AccountingCustomerParty',
  party: Party,
): void {
  const p = parent.ele(`cac:${role}`).ele('cac:Party')
  const address = p.ele('cac:PostalAddress')
  if (party.address.streetName) address.ele('cbc:StreetName').txt(party.address.streetName)
  if (party.address.city) address.ele('cbc:CityName').txt(party.address.city)
  if (party.address.postalCode) address.ele('cbc:PostalZone').txt(party.address.postalCode)
  address.ele('cac:Country').ele('cbc:IdentificationCode').txt(party.address.countryCode)
  if (party.vatId) {
    const taxScheme = p.ele('cac:PartyTaxScheme')
    taxScheme.ele('cbc:CompanyID').txt(party.vatId)
    taxScheme.ele('cac:TaxScheme').ele('cbc:ID').txt('VAT')
  }
  if (party.siren) {
    p.ele('cac:PartyLegalEntity').ele('cbc:CompanyID').txt(party.siren)
  }
}

export function generateFluxExtractUbl(invoice: Invoice, profile: FluxProfile): string {
  if (invoice.typeCode !== '380') {
    throw new UnsupportedTypeCodeError(invoice.typeCode)
  }
  const doc = create({ version: '1.0', encoding: 'UTF-8' })
  const root = doc.ele(NS_INVOICE, 'Invoice').att('xmlns:cac', NS_CAC).att('xmlns:cbc', NS_CBC)

  root.ele('cbc:CustomizationID').txt('urn:cen.eu:en16931:2017')
  root.ele('cbc:ProfileID').txt(FLUX_PROFILE_ID) // obligatoire F1
  root.ele('cbc:ID').txt(invoice.number)
  root.ele('cbc:IssueDate').txt(invoice.issueDate)
  if (invoice.dueDate) root.ele('cbc:DueDate').txt(invoice.dueDate)
  root.ele('cbc:InvoiceTypeCode').txt(invoice.typeCode)
  root.ele('cbc:DocumentCurrencyCode').txt(invoice.currency)

  addFluxParty(root, 'AccountingSupplierParty', invoice.seller)
  addFluxParty(root, 'AccountingCustomerParty', invoice.buyer)

  const taxTotal = root.ele('cac:TaxTotal')
  addAmount(taxTotal, 'TaxAmount', invoice.totals.taxAmount, invoice.currency)
  for (const b of invoice.vatBreakdown) {
    const sub = taxTotal.ele('cac:TaxSubtotal')
    addAmount(sub, 'TaxableAmount', b.taxableAmount, invoice.currency)
    addAmount(sub, 'TaxAmount', b.taxAmount, invoice.currency)
    const category = sub.ele('cac:TaxCategory')
    category.ele('cbc:ID').txt(b.category)
    category.ele('cbc:Percent').txt(b.rate)
    if (b.exemptionReasonCode) category.ele('cbc:TaxExemptionReasonCode').txt(b.exemptionReasonCode)
    if (b.exemptionReason) category.ele('cbc:TaxExemptionReason').txt(b.exemptionReason)
    category.ele('cac:TaxScheme').ele('cbc:ID').txt('VAT')
  }

  // LegalMonetaryTotal réduit au SEUL TaxExclusiveAmount (F1).
  const total = root.ele('cac:LegalMonetaryTotal')
  addAmount(total, 'TaxExclusiveAmount', invoice.totals.taxExclusive, invoice.currency)

  // BASE : aucune ligne. FULL : lignes épurées (pas d'ID, pas de montant net, pas de TVA/ligne).
  if (profile === 'FULL') {
    for (const line of invoice.lines) {
      const l = root.ele('cac:InvoiceLine')
      l.ele('cbc:InvoicedQuantity').att('unitCode', line.unitCode).txt(line.quantity)
      l.ele('cac:Item').ele('cbc:Name').txt(line.name)
      const price = l.ele('cac:Price')
      addAmount(price, 'PriceAmount', line.unitPrice, invoice.currency)
    }
  }

  return doc.end({ prettyPrint: true })
}
```

- [ ] **Step 4 : Exporter l'API**

`packages/invoice-core/src/index.ts` — ajouter :

```ts
export { generateFluxExtractUbl, type FluxProfile } from './flux/generate-extract.js'
```

- [ ] **Step 5 : Vérifier la validation XSD puis figer les golden**

Run: `pnpm --filter @factelec/invoice-core test -- flux`
Expected: les tests de validation XSD F1 passent ; les deux tests golden échouent (fichiers absents). Créer les golden (create-only), **relire**, puis rejouer :

```bash
UPDATE_GOLDEN=1 pnpm --filter @factelec/invoice-core test -- flux
cat packages/invoice-core/tests/golden/flux-base-multi-rate.ubl.xml
cat packages/invoice-core/tests/golden/flux-full-multi-rate.ubl.xml
pnpm --filter @factelec/invoice-core test -- flux
```
Expected (relecture BASE) : `cbc:ProfileID` présent, aucun `cac:InvoiceLine`, `LegalMonetaryTotal` ne contenant que `TaxExclusiveAmount` (409.87), 3 `TaxSubtotal` dont E avec `TaxExemptionReasonCode`. Expected (relecture FULL) : 3 `cac:InvoiceLine` réduites à `InvoicedQuantity` + `Item/Name` + `Price/PriceAmount`, aucun `ClassifiedTaxCategory`. Toute la suite `flux` verte.

- [ ] **Step 6 : Vérifier l'ensemble et committer**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS (suite complète, dont XSD OASIS, Schematron et XSD F1 BASE/FULL).

```bash
git add -A
git commit -m "feat(invoice-core): émetteur d'extraits de flux DGFiP F1 BASE/FULL validés XSD"
```

---

### Task 6 : Tests par propriétés (fast-check)

**Files:**
- Create: `packages/invoice-core/tests/model/properties.test.ts`
- Modify: `packages/invoice-core/package.json` (devDep `fast-check`)

**Interfaces:**
- Consumes: `parseInvoiceInput`, `buildInvoice`, `validateBusinessRules`, `big`, `round2`, fixtures.
- Produces : invariants du moteur vérifiés sur des entrées générées, **seedés et reproductibles**.

- [ ] **Step 1 : Installer fast-check**

Run:
```bash
pnpm --filter @factelec/invoice-core add -D fast-check@4.9.0
```

- [ ] **Step 2 : Écrire les tests de propriétés qui échouent**

`packages/invoice-core/tests/model/properties.test.ts` :

```ts
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { buildInvoice } from '../../src/model/compute.js'
import { big, round2 } from '../../src/model/money.js'
import { validateBusinessRules } from '../../src/model/rules.js'
import { parseInvoiceInput } from '../../src/model/schema.js'
import { simpleInvoiceInput } from '../fixtures.js'

// Générateurs seedés d'entrées VALIDES (montants positifs à 2 décimales, taux réels).
const amount2 = fc
  .tuple(fc.integer({ min: 0, max: 9999 }), fc.integer({ min: 0, max: 99 }))
  .map(([euros, cents]) => `${euros}.${String(cents).padStart(2, '0')}`)
  .filter((a) => a !== '0.00')

const quantity = fc.integer({ min: 1, max: 100 }).map(String)

const taxedCategory = fc.constantFrom(
  { vatCategory: 'S' as const, vatRate: '20.00' },
  { vatCategory: 'S' as const, vatRate: '10.00' },
  { vatCategory: 'S' as const, vatRate: '5.50' },
  { vatCategory: 'Z' as const, vatRate: '0.00' },
)

const taxedInvoice = fc
  .array(fc.record({ quantity, unitPrice: amount2, cat: taxedCategory }), { minLength: 1, maxLength: 8 })
  .map((rows) => ({
    ...simpleInvoiceInput,
    lines: rows.map((r, i) => ({
      id: String(i + 1),
      name: `Ligne ${i + 1}`,
      quantity: r.quantity,
      unitCode: 'C62',
      unitPrice: r.unitPrice,
      vatCategory: r.cat.vatCategory,
      vatRate: r.cat.vatRate,
    })),
  }))

const exemptInvoice = fc
  .array(fc.record({ quantity, unitPrice: amount2 }), { minLength: 1, maxLength: 5 })
  .map((rows) => ({
    ...simpleInvoiceInput,
    lines: rows.map((r, i) => ({
      id: String(i + 1),
      name: `Exonéré ${i + 1}`,
      quantity: r.quantity,
      unitCode: 'C62',
      unitPrice: r.unitPrice,
      vatCategory: 'E' as const,
      vatRate: '0.00',
      exemptionReasonCode: 'VATEX-EU-132-1I',
    })),
  }))

describe('invoice engine invariants (property-based, seeded)', () => {
  it('reconciles totals and satisfies every business rule', () => {
    fc.assert(
      fc.property(taxedInvoice, (input) => {
        const inv = buildInvoice(parseInvoiceInput(input))
        // arrondis : tous les montants sont formatés à 2 décimales exactes
        expect(inv.totals.sumOfLines).toMatch(/^\d+\.\d{2}$/)
        // BR-CO-10 / BR-CO-13 : somme des lignes = HT = taxExclusive
        const sum = round2(inv.lines.reduce((a, l) => a.plus(l.lineNetAmount), big('0')))
        expect(sum).toBe(inv.totals.sumOfLines)
        expect(inv.totals.taxExclusive).toBe(inv.totals.sumOfLines)
        // BR-CO-14 : TVA totale = somme des TVA de ventilation
        const tax = round2(inv.vatBreakdown.reduce((a, b) => a.plus(b.taxAmount), big('0')))
        expect(tax).toBe(inv.totals.taxAmount)
        // BR-CO-15 : TTC = HT + TVA
        expect(round2(big(inv.totals.taxExclusive).plus(inv.totals.taxAmount))).toBe(inv.totals.taxInclusive)
        // round-trip build → rules : aucune violation
        expect(validateBusinessRules(inv)).toEqual([])
      }),
      { seed: 20260713, numRuns: 300 },
    )
  })

  it('groups the VAT breakdown so that taxable amounts reconcile per (category, rate)', () => {
    fc.assert(
      fc.property(taxedInvoice, (input) => {
        const inv = buildInvoice(parseInvoiceInput(input))
        for (const b of inv.vatBreakdown) {
          const expected = round2(
            inv.lines
              .filter((l) => l.vatCategory === b.category && l.vatRate === b.rate)
              .reduce((a, l) => a.plus(l.lineNetAmount), big('0')),
          )
          expect(b.taxableAmount).toBe(expected)
        }
      }),
      { seed: 424242, numRuns: 300 },
    )
  })

  it('never flags BR-E-10 when exempt lines carry a VATEX code', () => {
    fc.assert(
      fc.property(exemptInvoice, (input) => {
        const inv = buildInvoice(parseInvoiceInput(input))
        expect(validateBusinessRules(inv).map((v) => v.rule)).not.toContain('BR-E-10')
      }),
      { seed: 7, numRuns: 100 },
    )
  })

  it('is deterministic: building twice yields identical totals', () => {
    fc.assert(
      fc.property(taxedInvoice, (input) => {
        const parsed = parseInvoiceInput(input)
        expect(buildInvoice(parsed).totals).toEqual(buildInvoice(parsed).totals)
      }),
      { seed: 1, numRuns: 100 },
    )
  })
})
```

- [ ] **Step 3 : Vérifier**

Run: `pnpm --filter @factelec/invoice-core test -- properties`
Expected: PASS (les invariants tiennent par construction ; les tests servent de garde de non-régression contre les dérives d'arrondi et de regroupement). En cas d'échec, fast-check imprime le contre-exemple **et le seed** pour rejouer à l'identique.

- [ ] **Step 4 : Vérifier l'ensemble et committer**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS ; couverture toujours ≥ 90 %.

```bash
git add -A
git commit -m "test(invoice-core): tests par propriétés fast-check sur les invariants du moteur"
```

---

### Task 7 : README + version 0.2.0 + point de reprise

**Files:**
- Modify: `packages/invoice-core/package.json` (`version` → `0.2.0`)
- Modify: `packages/invoice-core/README.md`
- Modify: `README.md` (racine — API, prérequis, feuille de route, point de reprise)

**Interfaces:**
- Consumes: tout ce qui précède.
- Produces : documentation à jour ; version bumpée.

- [ ] **Step 1 : Bumper la version du package**

`packages/invoice-core/package.json` — `"version": "0.1.0"` → `"version": "0.2.0"`.

- [ ] **Step 2 : Mettre à jour le README du package**

`packages/invoice-core/README.md` — remplacer la liste d'API et les sections « Validation XSD » / « Hors périmètre » par :

```markdown
- `generateUbl(invoice: Invoice): string` — facture commerciale UBL 2.1 Invoice,
  validée dans les tests contre le XSD OASIS **et** le Schematron officiel EN 16931
  (`docs/reference/en16931-schematron/`, exécuté en Node pur via saxon-js). Lève
  `UnsupportedTypeCodeError` pour un avoir (typeCode 381 — génération CreditNote
  reportée au plan 1.2bis).
- `generateFluxExtractUbl(invoice: Invoice, profile: 'BASE' | 'FULL'): string` —
  extrait fiscal de flux DGFiP F1, validé contre les XSD réglementaires
  (`docs/reglementaire/…/F1_BASE_UBL_2.1`, `…/F1_FULL_UBL_2.1`). BASE = en-tête sans
  lignes ; FULL = lignes épurées (sans TVA par ligne). Sans noms de parties ni
  totaux TTC/à payer (restrictions fiscales de flux).
- `validateBusinessRules(invoice: Invoice): RuleViolation[]` — sous-ensemble EN 16931 :
  BR-CO-10/13/14/15/17/25, BR-{S,Z,E,AE,IC,G,O,AF,AG}-08, et motifs d'exonération
  BR-{E,AE,IC,G,O}-10 (BT-120/121). Tableau vide = conforme.

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
```

Conserver la section « Conventions » et la liste des schémas/types exportés (y
ajouter `UnsupportedTypeCodeError`, `FluxProfile`).

- [ ] **Step 3 : Mettre à jour le README racine**

`README.md` (racine) :

- Bloc « État du projet » — remplacer par :

```markdown
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
```

- Section « `@factelec/invoice-core` » — passer la génération UBL de « (en cours) » à
  livrée, et ajouter le Schematron et les extraits de flux F1.
- Section « Développement / Prérequis » — préciser que le Schematron s'exécute en
  **Node pur** (saxon-js, `xslt3`), sans JVM ; le premier `pnpm test` compile le SEF.
  Ajouter `pnpm build` à la liste des scripts.
- Feuille de route — marquer 1.1 et 1.2 terminés ; rencommer l'entrée 1.2 en
  « Conformité EN 16931 + extraits de flux » et insérer « 1.2bis — Factur-X/CII ».

- [ ] **Step 4 : Vérifier l'ensemble et committer**

Run: `pnpm lint && pnpm typecheck && pnpm build && pnpm test`
Expected: PASS ; `packages/invoice-core/package.json` en 0.2.0.

```bash
git add -A
git commit -m "docs(invoice-core): README à jour, version 0.2.0 et point de reprise plan 1.2bis"
```

---

## Auto-contrôle du plan (relecture spec → tâches)

- **Build + exports map** → Task 1 (tsconfig.build.json, `exports`, `pnpm build`, étape CI). ✓
- **Montants non négatifs + avoir 381** → Task 2 (regex non signées, `UnsupportedTypeCodeError`, arrondi négatif testé au niveau money). ✓
- **Exonérations BT-120/121 + BR-*-10** → Task 3 (modèle, propagation, règles, UBL, golden régénéré). Numéros de règles vérifiés (BR-E-10/AE-10/IC-10/G-10/O-10). ✓
- **Schematron EN 16931 officiel** → Task 4 (release `validation-1.3.16` pinnée + sha256, saxon-js/xslt3 Node pur, SVRL sur golden). ✓
- **Émetteurs d'extraits F1** → Task 5 (`generateFluxExtractUbl`, XSD BASE/FULL, strips vérifiés xmllint). ✓
- **Tests par propriétés** → Task 6 (fast-check seedé, invariants totaux/ventilation/round-trip/arrondi). ✓
- **README + version** → Task 7 (bump 0.2.0, READMEs, reprise 1.2bis). ✓

**Cohérence des types entre tâches** : `exemptionReasonCode`/`exemptionReason` (T3) consommés par T5 (émission flux) et T6 ; `UnsupportedTypeCodeError` (T2) réutilisé par T5 ; `FluxProfile` (T5) exporté. Aucune référence à une fonction non définie.

## Points de risque signalés dans le plan

1. **Golden multi-taux non conforme EN 16931** (BR-E-10) : impose l'ordre T3 → T4 et la régénération du golden avant le verrou Schematron. *(Vérifié.)*
2. **Valeur sémantique de `cbc:ProfileID`** des extraits F1 : structurellement toute chaîne valide le XSD, mais l'identifiant de processus DGFiP exact doit être confirmé contre le dossier de spécifications externes v3.2 (constante isolée `FLUX_PROFILE_ID`).
3. **`PartyLegalEntity/CompanyID`** obligatoire en F1 (RegistrationName interdit) : l'émetteur omet le bloc si le SIREN manque, pour ne pas produire un `PartyLegalEntity` vide invalide.
4. **Coût du premier run de tests** : compilation du SEF Schematron (~6,8 Mo, ~10-20 s) au premier `pnpm test` ; mise en cache par `globalSetup` (git-ignorée) ensuite.
5. **Types manquants pour `saxon-js`** : prévoir un `declare module 'saxon-js'` si `tsc` bloque l'import.

