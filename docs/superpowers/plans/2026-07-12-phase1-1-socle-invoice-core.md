# Plan 1.1 — Socle monorepo + invoice-core (UBL validé XSD DGFiP)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Poser le socle du monorepo et livrer `@factelec/invoice-core` : modèle canonique EN 16931, calculs TVA/totaux, génération UBL 2.1 validée contre les XSD officiels DGFiP (spécifications externes v3.2).

**Architecture:** Monorepo pnpm ; `invoice-core` est une bibliothèque pure (aucune I/O réseau/DB) : schémas zod → modèle canonique → moteur de calcul (big.js, arrondi demi-supérieur) → générateur UBL (xmlbuilder2). La validation XSD s'exécute dans les tests via `xmllint` contre `docs/reglementaire/specifications-externes-v3.2/3- XSD_v3.2/`.

**Tech Stack:** Node.js ≥ 22, TypeScript strict (ESM), pnpm workspaces, Vitest, zod, big.js, xmlbuilder2, Biome (lint/format), GitHub Actions, xmllint (libxml2).

**Découpage de la phase 1** (un plan par sous-ensemble, celui-ci est le premier) :
1.1 ce plan · 1.2 Factur-X/CII + Schematron + golden files étendus · 1.3 API NestJS + auth multi-tenant + ingestion · 1.4 dashboard minimal.

## Global Constraints

- TDD obligatoire : test écrit et vu échouer avant toute implémentation ; aucun merge si un test échoue (spec §7).
- TypeScript `strict: true`, ESM (`"type": "module"`), Node ≥ 22.
- `invoice-core` reste une bibliothèque pure : pas d'accès réseau, DB ni système hors tests (spec §3.1).
- Montants : chaînes décimales à 2 décimales exactement (ex. `"1000.00"`) ; calculs via big.js, arrondi demi-supérieur (round half up).
- Les XSD de référence sont ceux du dépôt : `docs/reglementaire/specifications-externes-v3.2/3- XSD_v3.2/` — ne jamais en télécharger d'autres.
- Identifiants de code en anglais ; messages de commit en français, sans trailer Claude.
- Commits fréquents : un commit par tâche minimum, à la fin de chaque tâche.

---

### Task 1: Socle monorepo + CI

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `biome.json`, `.gitignore`, `.nvmrc`
- Create: `packages/invoice-core/package.json`, `packages/invoice-core/tsconfig.json`, `packages/invoice-core/vitest.config.ts`, `packages/invoice-core/src/index.ts`
- Create: `.github/workflows/ci.yml`
- Test: `packages/invoice-core/tests/index.test.ts`

**Interfaces:**
- Consumes: rien (démarrage du repo).
- Produces: workspace pnpm fonctionnel ; package `@factelec/invoice-core` avec export `PACKAGE_NAME: string` ; scripts racine `pnpm lint`, `pnpm typecheck`, `pnpm test` ; CI GitHub Actions exécutant ces trois scripts.

- [ ] **Step 1: Créer les fichiers du workspace**

`package.json` (racine) :

```json
{
  "name": "factelec",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "packageManager": "pnpm@10.12.1",
  "scripts": {
    "lint": "biome check .",
    "format": "biome format --write .",
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test"
  },
  "devDependencies": {}
}
```

`pnpm-workspace.yaml` :

```yaml
packages:
  - "packages/*"
  - "apps/*"
```

`tsconfig.base.json` :

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

`biome.json` :

```json
{
  "files": { "ignore": ["docs/**", "**/dist/**", "**/coverage/**"] },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2 },
  "linter": { "enabled": true, "rules": { "recommended": true } },
  "javascript": { "formatter": { "quoteStyle": "single", "semicolons": "asNeeded" } }
}
```

`.gitignore` :

```
node_modules/
dist/
coverage/
*.log
.DS_Store
.env
.env.*
```

`.nvmrc` :

```
22
```

Note : si la version de Biome installée refuse cette config (le format a changé entre versions majeures, ex. `files.ignore` → `files.includes`), lancer `pnpm exec biome migrate --write` et committer la config migrée.

- [ ] **Step 2: Créer le package invoice-core**

`packages/invoice-core/package.json` :

```json
{
  "name": "@factelec/invoice-core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "test": "vitest run --coverage",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  }
}
```

`packages/invoice-core/tsconfig.json` :

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": ".", "noEmit": true },
  "include": ["src/**/*", "tests/**/*", "vitest.config.ts"]
}
```

`packages/invoice-core/vitest.config.ts` :

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      thresholds: { lines: 90, functions: 90, statements: 90, branches: 90 },
    },
  },
})
```

La couverture est bloquante (exigence projet : > 90 %) : le script `test` du package exécute `vitest run --coverage` et la CI échoue sous les seuils.

- [ ] **Step 3: Installer les dépendances**

Run:
```bash
pnpm add -D -w @biomejs/biome typescript
pnpm --filter @factelec/invoice-core add -D vitest @vitest/coverage-v8
pnpm install
```
Expected: lockfile `pnpm-lock.yaml` créé, aucune erreur.

- [ ] **Step 4: Écrire le test qui échoue**

`packages/invoice-core/tests/index.test.ts` :

```ts
import { describe, expect, it } from 'vitest'
import { PACKAGE_NAME } from '../src/index.js'

describe('invoice-core package', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@factelec/invoice-core')
  })
})
```

- [ ] **Step 5: Vérifier que le test échoue**

Run: `pnpm --filter @factelec/invoice-core test`
Expected: FAIL — `Cannot find module '../src/index.js'` (ou export manquant).

- [ ] **Step 6: Implémenter le minimum**

`packages/invoice-core/src/index.ts` :

```ts
export const PACKAGE_NAME = '@factelec/invoice-core'
```

- [ ] **Step 7: Vérifier que tout passe**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS partout (1 test vert). Si Biome signale du formatage, lancer `pnpm format` puis relancer.

- [ ] **Step 8: Créer la CI**

`.github/workflows/ci.yml` :

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
```

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: socle monorepo pnpm + package invoice-core + CI"
```

---

### Task 2: Modèle canonique EN 16931 (types + schémas zod)

**Files:**
- Create: `packages/invoice-core/src/model/schema.ts`
- Modify: `packages/invoice-core/src/index.ts`
- Test: `packages/invoice-core/tests/model/schema.test.ts`, `packages/invoice-core/tests/fixtures.ts`

**Interfaces:**
- Consumes: rien.
- Produces (utilisés par les tâches 3 et 4) :
  - Types : `PostalAddress`, `Party`, `VatCategory`, `InvoiceLineInput`, `InvoiceInput`, `InvoiceLine`, `VatBreakdown`, `Totals`, `Invoice`.
  - Schémas zod : `invoiceInputSchema`, `invoiceSchema`.
  - `parseInvoiceInput(data: unknown): InvoiceInput` (lève `ZodError` si invalide).
  - Fixtures de test : `simpleInvoiceInput`, `multiRateInvoiceInput` (exportées de `tests/fixtures.ts`).

- [ ] **Step 1: Écrire les tests qui échouent**

`packages/invoice-core/tests/fixtures.ts` :

```ts
import type { InvoiceInput } from '../src/model/schema.js'

export const simpleInvoiceInput: InvoiceInput = {
  number: 'FA-2026-001',
  issueDate: '2026-07-12',
  dueDate: '2026-08-11',
  typeCode: '380',
  currency: 'EUR',
  seller: {
    name: 'AV Digital',
    siren: '123456789',
    vatId: 'FR32123456789',
    address: { streetName: '1 rue de la Paix', city: 'Paris', postalCode: '75002', countryCode: 'FR' },
  },
  buyer: {
    name: 'Client SARL',
    siren: '987654321',
    vatId: 'FR40987654321',
    address: { streetName: '5 avenue des Champs', city: 'Lyon', postalCode: '69001', countryCode: 'FR' },
  },
  lines: [
    {
      id: '1',
      name: 'Prestation de développement',
      quantity: '1',
      unitCode: 'C62',
      unitPrice: '1000.00',
      vatCategory: 'S',
      vatRate: '20.00',
    },
  ],
}

export const multiRateInvoiceInput: InvoiceInput = {
  ...simpleInvoiceInput,
  number: 'FA-2026-002',
  lines: [
    { id: '1', name: 'Livre', quantity: '3', unitCode: 'C62', unitPrice: '19.99', vatCategory: 'S', vatRate: '5.50' },
    { id: '2', name: 'Abonnement SaaS', quantity: '1', unitCode: 'C62', unitPrice: '49.90', vatCategory: 'S', vatRate: '20.00' },
    { id: '3', name: 'Formation exonérée', quantity: '2', unitCode: 'C62', unitPrice: '150.00', vatCategory: 'E', vatRate: '0.00' },
  ],
}
```

`packages/invoice-core/tests/model/schema.test.ts` :

```ts
import { describe, expect, it } from 'vitest'
import { parseInvoiceInput } from '../../src/model/schema.js'
import { multiRateInvoiceInput, simpleInvoiceInput } from '../fixtures.js'

describe('parseInvoiceInput', () => {
  it('accepts a valid simple invoice input', () => {
    expect(parseInvoiceInput(simpleInvoiceInput)).toEqual(simpleInvoiceInput)
  })

  it('accepts a valid multi-rate invoice input', () => {
    expect(parseInvoiceInput(multiRateInvoiceInput)).toEqual(multiRateInvoiceInput)
  })

  it('rejects an invalid currency code', () => {
    expect(() => parseInvoiceInput({ ...simpleInvoiceInput, currency: 'euro' })).toThrow()
  })

  it('rejects an invalid SIREN', () => {
    const bad = { ...simpleInvoiceInput, seller: { ...simpleInvoiceInput.seller, siren: '12AB' } }
    expect(() => parseInvoiceInput(bad)).toThrow()
  })

  it('rejects an invoice without lines', () => {
    expect(() => parseInvoiceInput({ ...simpleInvoiceInput, lines: [] })).toThrow()
  })

  it('rejects a malformed issue date', () => {
    expect(() => parseInvoiceInput({ ...simpleInvoiceInput, issueDate: '12/07/2026' })).toThrow()
  })

  it('rejects a unit price with more than 4 decimals', () => {
    const bad = {
      ...simpleInvoiceInput,
      lines: [{ ...simpleInvoiceInput.lines[0], unitPrice: '10.00001' }],
    }
    expect(() => parseInvoiceInput(bad)).toThrow()
  })

  it('rejects an unknown VAT category', () => {
    const bad = {
      ...simpleInvoiceInput,
      lines: [{ ...simpleInvoiceInput.lines[0], vatCategory: 'X' }],
    }
    expect(() => parseInvoiceInput(bad)).toThrow()
  })
})
```

- [ ] **Step 2: Vérifier que les tests échouent**

Run: `pnpm --filter @factelec/invoice-core test`
Expected: FAIL — `Cannot find module '../../src/model/schema.js'`.

- [ ] **Step 3: Installer zod puis implémenter le schéma**

Run: `pnpm --filter @factelec/invoice-core add zod`

`packages/invoice-core/src/model/schema.ts` :

```ts
import { z } from 'zod'

// Références BT-x / BG-x : modèle sémantique EN 16931
// (annexe 1 « Format sémantique FE e-invoicing », docs/reglementaire/).

const amount2 = z.string().regex(/^-?\d+\.\d{2}$/, 'amount must have exactly 2 decimals')
const decimal4 = z.string().regex(/^-?\d+(\.\d{1,4})?$/, 'decimal with up to 4 decimals')
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => !Number.isNaN(Date.parse(s)), 'invalid calendar date')

export const vatCategorySchema = z.enum(['S', 'Z', 'E', 'AE', 'K', 'G', 'O', 'L', 'M']) // BT-151/BT-118

export const postalAddressSchema = z.object({
  streetName: z.string().min(1).optional(), // BT-35/BT-50
  city: z.string().min(1).optional(), // BT-37/BT-52
  postalCode: z.string().min(1).optional(), // BT-38/BT-53
  countryCode: z.string().regex(/^[A-Z]{2}$/), // BT-40/BT-55
})

export const partySchema = z.object({
  name: z.string().min(1), // BT-27/BT-44
  siren: z
    .string()
    .regex(/^\d{9}$|^\d{14}$/)
    .optional(), // BT-30/BT-47 (SIREN ou SIRET)
  vatId: z
    .string()
    .regex(/^[A-Z]{2}[0-9A-Z]{2,12}$/)
    .optional(), // BT-31/BT-48
  address: postalAddressSchema, // BG-5/BG-8
})

export const invoiceLineInputSchema = z.object({
  id: z.string().min(1), // BT-126
  name: z.string().min(1), // BT-153
  quantity: decimal4, // BT-129
  unitCode: z.string().min(2).max(3), // BT-130 (UN/ECE rec 20, ex. C62)
  unitPrice: decimal4, // BT-146
  vatCategory: vatCategorySchema, // BT-151
  vatRate: decimal4, // BT-152 (pourcentage)
})

export const invoiceInputSchema = z.object({
  number: z.string().min(1), // BT-1
  issueDate: isoDate, // BT-2
  dueDate: isoDate.optional(), // BT-9
  typeCode: z.enum(['380', '381']), // BT-3 (facture / avoir)
  currency: z.string().regex(/^[A-Z]{3}$/), // BT-5
  seller: partySchema, // BG-4
  buyer: partySchema, // BG-7
  lines: z.array(invoiceLineInputSchema).min(1), // BG-25
})

export const invoiceLineSchema = invoiceLineInputSchema.extend({
  lineNetAmount: amount2, // BT-131
})

export const vatBreakdownSchema = z.object({
  category: vatCategorySchema, // BT-118
  rate: decimal4, // BT-119
  taxableAmount: amount2, // BT-116
  taxAmount: amount2, // BT-117
})

export const totalsSchema = z.object({
  sumOfLines: amount2, // BT-106
  taxExclusive: amount2, // BT-109
  taxAmount: amount2, // BT-110
  taxInclusive: amount2, // BT-112
  payable: amount2, // BT-115
})

export const invoiceSchema = invoiceInputSchema.extend({
  lines: z.array(invoiceLineSchema).min(1),
  vatBreakdown: z.array(vatBreakdownSchema).min(1), // BG-23
  totals: totalsSchema, // BG-22
})

export type VatCategory = z.infer<typeof vatCategorySchema>
export type PostalAddress = z.infer<typeof postalAddressSchema>
export type Party = z.infer<typeof partySchema>
export type InvoiceLineInput = z.infer<typeof invoiceLineInputSchema>
export type InvoiceInput = z.infer<typeof invoiceInputSchema>
export type InvoiceLine = z.infer<typeof invoiceLineSchema>
export type VatBreakdown = z.infer<typeof vatBreakdownSchema>
export type Totals = z.infer<typeof totalsSchema>
export type Invoice = z.infer<typeof invoiceSchema>

export function parseInvoiceInput(data: unknown): InvoiceInput {
  return invoiceInputSchema.parse(data)
}

export function parseInvoice(data: unknown): Invoice {
  return invoiceSchema.parse(data)
}
```

Note : si TypeScript signale `simpleInvoiceInput.lines[0]` comme possiblement `undefined` dans les tests (`noUncheckedIndexedAccess`), utiliser `simpleInvoiceInput.lines[0]!` dans les fixtures de test uniquement.

- [ ] **Step 4: Vérifier que les tests passent**

Run: `pnpm --filter @factelec/invoice-core test`
Expected: PASS (9 tests verts au total).

- [ ] **Step 5: Exporter depuis l'index et vérifier l'ensemble**

`packages/invoice-core/src/index.ts` :

```ts
export const PACKAGE_NAME = '@factelec/invoice-core'
export * from './model/schema.js'
```

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(invoice-core): modèle canonique EN 16931 avec schémas zod"
```

---

### Task 3: Moteur de calcul (montants, TVA, totaux) + règles de cohérence

**Files:**
- Create: `packages/invoice-core/src/model/money.ts`, `packages/invoice-core/src/model/compute.ts`, `packages/invoice-core/src/model/rules.ts`
- Modify: `packages/invoice-core/src/index.ts`
- Test: `packages/invoice-core/tests/model/money.test.ts`, `packages/invoice-core/tests/model/compute.test.ts`, `packages/invoice-core/tests/model/rules.test.ts`

**Interfaces:**
- Consumes: types et schémas de la tâche 2.
- Produces (utilisés par les tâches 4, 5, 6) :
  - `round2(value: Big): string` et `big(value: string): Big` (money.ts).
  - `buildInvoice(input: InvoiceInput): Invoice` — calcule `lineNetAmount`, `vatBreakdown`, `totals`.
  - `validateBusinessRules(invoice: Invoice): RuleViolation[]` avec `type RuleViolation = { rule: string; message: string }` (tableau vide = conforme).

- [ ] **Step 1: Écrire les tests money qui échouent**

`packages/invoice-core/tests/model/money.test.ts` :

```ts
import { describe, expect, it } from 'vitest'
import { big, round2 } from '../../src/model/money.js'

describe('round2', () => {
  it('rounds half up to 2 decimals', () => {
    expect(round2(big('1.005'))).toBe('1.01')
    expect(round2(big('1.004'))).toBe('1.00')
    expect(round2(big('2.675'))).toBe('2.68')
  })

  it('formats integers with 2 decimals', () => {
    expect(round2(big('1000'))).toBe('1000.00')
  })

  it('multiplies without float drift', () => {
    expect(round2(big('3').times(big('19.99')))).toBe('59.97')
  })
})
```

- [ ] **Step 2: Vérifier l'échec**

Run: `pnpm --filter @factelec/invoice-core test -- money`
Expected: FAIL — module `money.js` introuvable.

- [ ] **Step 3: Implémenter money.ts**

Run: `pnpm --filter @factelec/invoice-core add big.js && pnpm --filter @factelec/invoice-core add -D @types/big.js`

`packages/invoice-core/src/model/money.ts` :

```ts
import Big from 'big.js'

export function big(value: string): Big {
  return new Big(value)
}

export function round2(value: Big): string {
  return value.round(2, Big.roundHalfUp).toFixed(2)
}
```

Run: `pnpm --filter @factelec/invoice-core test -- money`
Expected: PASS.

- [ ] **Step 4: Écrire les tests compute qui échouent**

`packages/invoice-core/tests/model/compute.test.ts` :

```ts
import { describe, expect, it } from 'vitest'
import { buildInvoice } from '../../src/model/compute.js'
import { multiRateInvoiceInput, simpleInvoiceInput } from '../fixtures.js'

describe('buildInvoice', () => {
  it('computes line net amounts, VAT breakdown and totals for a simple invoice', () => {
    const invoice = buildInvoice(simpleInvoiceInput)
    expect(invoice.lines[0]!.lineNetAmount).toBe('1000.00')
    expect(invoice.vatBreakdown).toEqual([
      { category: 'S', rate: '20.00', taxableAmount: '1000.00', taxAmount: '200.00' },
    ])
    expect(invoice.totals).toEqual({
      sumOfLines: '1000.00',
      taxExclusive: '1000.00',
      taxAmount: '200.00',
      taxInclusive: '1200.00',
      payable: '1200.00',
    })
  })

  it('groups the VAT breakdown by category and rate', () => {
    const invoice = buildInvoice(multiRateInvoiceInput)
    // 3 × 19.99 = 59.97 (S 5.50) ; 49.90 (S 20.00) ; 2 × 150.00 = 300.00 (E 0.00)
    expect(invoice.vatBreakdown).toEqual([
      { category: 'S', rate: '5.50', taxableAmount: '59.97', taxAmount: '3.30' },
      { category: 'S', rate: '20.00', taxableAmount: '49.90', taxAmount: '9.98' },
      { category: 'E', rate: '0.00', taxableAmount: '300.00', taxAmount: '0.00' },
    ])
    expect(invoice.totals).toEqual({
      sumOfLines: '409.87',
      taxExclusive: '409.87',
      taxAmount: '13.28',
      taxInclusive: '423.15',
      payable: '423.15',
    })
  })

  it('returns an invoice that satisfies the full invoice schema', () => {
    const invoice = buildInvoice(simpleInvoiceInput)
    expect(invoice.number).toBe('FA-2026-001')
    expect(invoice.seller.name).toBe('AV Digital')
  })
})
```

- [ ] **Step 5: Vérifier l'échec**

Run: `pnpm --filter @factelec/invoice-core test -- compute`
Expected: FAIL — module `compute.js` introuvable.

- [ ] **Step 6: Implémenter compute.ts**

`packages/invoice-core/src/model/compute.ts` :

```ts
import Big from 'big.js'
import { big, round2 } from './money.js'
import {
  type Invoice,
  type InvoiceInput,
  type InvoiceLine,
  type Totals,
  type VatBreakdown,
  invoiceSchema,
} from './schema.js'

function computeLines(input: InvoiceInput): InvoiceLine[] {
  return input.lines.map((line) => ({
    ...line,
    lineNetAmount: round2(big(line.quantity).times(line.unitPrice)),
  }))
}

function computeVatBreakdown(lines: InvoiceLine[]): VatBreakdown[] {
  const groups = new Map<string, { category: VatBreakdown['category']; rate: string; taxable: Big }>()
  for (const line of lines) {
    const key = `${line.vatCategory}|${line.vatRate}`
    const group = groups.get(key)
    if (group) {
      group.taxable = group.taxable.plus(line.lineNetAmount)
    } else {
      groups.set(key, { category: line.vatCategory, rate: line.vatRate, taxable: big(line.lineNetAmount) })
    }
  }
  return [...groups.values()].map((g) => ({
    category: g.category,
    rate: g.rate,
    taxableAmount: round2(g.taxable),
    // BR-CO-17 : TVA de catégorie = assiette × taux, arrondie à 2 décimales
    taxAmount: round2(g.taxable.times(g.rate).div(100)),
  }))
}

function computeTotals(lines: InvoiceLine[], breakdown: VatBreakdown[]): Totals {
  const sumOfLines = lines.reduce((acc, l) => acc.plus(l.lineNetAmount), big('0'))
  const taxAmount = breakdown.reduce((acc, b) => acc.plus(b.taxAmount), big('0'))
  const taxInclusive = sumOfLines.plus(taxAmount)
  return {
    sumOfLines: round2(sumOfLines),
    taxExclusive: round2(sumOfLines), // pas de remises/charges de pied de facture en v1
    taxAmount: round2(taxAmount),
    taxInclusive: round2(taxInclusive),
    payable: round2(taxInclusive), // pas d'acompte en v1
  }
}

export function buildInvoice(input: InvoiceInput): Invoice {
  const lines = computeLines(input)
  const vatBreakdown = computeVatBreakdown(lines)
  const totals = computeTotals(lines, vatBreakdown)
  return invoiceSchema.parse({ ...input, lines, vatBreakdown, totals })
}
```

Run: `pnpm --filter @factelec/invoice-core test -- compute`
Expected: PASS.

- [ ] **Step 7: Écrire les tests rules qui échouent**

`packages/invoice-core/tests/model/rules.test.ts` :

```ts
import { describe, expect, it } from 'vitest'
import { buildInvoice } from '../../src/model/compute.js'
import { validateBusinessRules } from '../../src/model/rules.js'
import { multiRateInvoiceInput, simpleInvoiceInput } from '../fixtures.js'

describe('validateBusinessRules', () => {
  it('returns no violation for computed invoices', () => {
    expect(validateBusinessRules(buildInvoice(simpleInvoiceInput))).toEqual([])
    expect(validateBusinessRules(buildInvoice(multiRateInvoiceInput))).toEqual([])
  })

  it('detects a tampered sum of lines (BR-CO-10)', () => {
    const invoice = buildInvoice(simpleInvoiceInput)
    const tampered = { ...invoice, totals: { ...invoice.totals, sumOfLines: '999.00' } }
    const rules = validateBusinessRules(tampered).map((v) => v.rule)
    expect(rules).toContain('BR-CO-10')
  })

  it('detects a wrong tax inclusive amount (BR-CO-15)', () => {
    const invoice = buildInvoice(simpleInvoiceInput)
    const tampered = { ...invoice, totals: { ...invoice.totals, taxInclusive: '1100.00' } }
    const rules = validateBusinessRules(tampered).map((v) => v.rule)
    expect(rules).toContain('BR-CO-15')
  })

  it('detects a VAT breakdown not matching the lines (BR-S-08)', () => {
    const invoice = buildInvoice(simpleInvoiceInput)
    const tampered = {
      ...invoice,
      vatBreakdown: [{ ...invoice.vatBreakdown[0]!, taxableAmount: '500.00' }],
    }
    const rules = validateBusinessRules(tampered).map((v) => v.rule)
    expect(rules).toContain('BR-S-08')
  })
})
```

- [ ] **Step 8: Vérifier l'échec**

Run: `pnpm --filter @factelec/invoice-core test -- rules`
Expected: FAIL — module `rules.js` introuvable.

- [ ] **Step 9: Implémenter rules.ts**

`packages/invoice-core/src/model/rules.ts` :

```ts
import { big, round2 } from './money.js'
import type { Invoice } from './schema.js'

export type RuleViolation = { rule: string; message: string }

// Sous-ensemble des règles métier EN 16931 (BR-CO-*, BR-S-*) pertinentes
// pour le périmètre v1 (pas de remises document ni d'acompte).
export function validateBusinessRules(invoice: Invoice): RuleViolation[] {
  const violations: RuleViolation[] = []
  const push = (rule: string, message: string) => violations.push({ rule, message })

  const sumOfLines = round2(invoice.lines.reduce((acc, l) => acc.plus(l.lineNetAmount), big('0')))
  if (sumOfLines !== invoice.totals.sumOfLines)
    push('BR-CO-10', `sumOfLines ${invoice.totals.sumOfLines} != somme des lignes ${sumOfLines}`)

  if (invoice.totals.taxExclusive !== invoice.totals.sumOfLines)
    push('BR-CO-13', `taxExclusive ${invoice.totals.taxExclusive} != sumOfLines ${invoice.totals.sumOfLines}`)

  const taxAmount = round2(invoice.vatBreakdown.reduce((acc, b) => acc.plus(b.taxAmount), big('0')))
  if (taxAmount !== invoice.totals.taxAmount)
    push('BR-CO-14', `taxAmount ${invoice.totals.taxAmount} != somme des TVA ${taxAmount}`)

  const taxInclusive = round2(big(invoice.totals.taxExclusive).plus(invoice.totals.taxAmount))
  if (taxInclusive !== invoice.totals.taxInclusive)
    push('BR-CO-15', `taxInclusive ${invoice.totals.taxInclusive} != HT + TVA ${taxInclusive}`)

  if (invoice.totals.payable !== invoice.totals.taxInclusive)
    push('BR-CO-25', `payable ${invoice.totals.payable} != taxInclusive ${invoice.totals.taxInclusive}`)

  for (const b of invoice.vatBreakdown) {
    const expected = round2(
      invoice.lines
        .filter((l) => l.vatCategory === b.category && l.vatRate === b.rate)
        .reduce((acc, l) => acc.plus(l.lineNetAmount), big('0')),
    )
    if (expected !== b.taxableAmount)
      push('BR-S-08', `assiette ${b.taxableAmount} (${b.category} ${b.rate}%) != somme des lignes ${expected}`)
    const expectedTax = round2(big(b.taxableAmount).times(b.rate).div(100))
    if (expectedTax !== b.taxAmount)
      push('BR-CO-17', `TVA ${b.taxAmount} (${b.category} ${b.rate}%) != assiette × taux ${expectedTax}`)
  }

  return violations
}
```

- [ ] **Step 10: Vérifier que tout passe et exporter**

`packages/invoice-core/src/index.ts` — remplacer le contenu par :

```ts
export const PACKAGE_NAME = '@factelec/invoice-core'
export * from './model/schema.js'
export * from './model/money.js'
export { buildInvoice } from './model/compute.js'
export { validateBusinessRules, type RuleViolation } from './model/rules.js'
```

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS (tous les tests verts).

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat(invoice-core): moteur de calcul TVA/totaux et règles de cohérence EN 16931"
```

---

### Task 4: Génération UBL 2.1

**Files:**
- Create: `packages/invoice-core/src/ubl/generate.ts`
- Modify: `packages/invoice-core/src/index.ts`
- Test: `packages/invoice-core/tests/ubl/generate.test.ts`

**Interfaces:**
- Consumes: `Invoice`, `buildInvoice`, fixtures (tâches 2-3).
- Produces: `generateUbl(invoice: Invoice): string` — document XML UBL 2.1 Invoice, prettifié, encodé UTF-8, utilisé par les tâches 5 et 6.

- [ ] **Step 1: Écrire le test qui échoue**

`packages/invoice-core/tests/ubl/generate.test.ts` :

```ts
import { describe, expect, it } from 'vitest'
import { buildInvoice } from '../../src/model/compute.js'
import { generateUbl } from '../../src/ubl/generate.js'
import { simpleInvoiceInput } from '../fixtures.js'

describe('generateUbl', () => {
  const xml = () => generateUbl(buildInvoice(simpleInvoiceInput))

  it('produces a UBL Invoice document with the EN 16931 customization', () => {
    const out = xml()
    expect(out).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(out).toContain('urn:oasis:names:specification:ubl:schema:xsd:Invoice-2')
    expect(out).toContain('<cbc:CustomizationID>urn:cen.eu:en16931:2017</cbc:CustomizationID>')
    expect(out).toContain('<cbc:ID>FA-2026-001</cbc:ID>')
  })

  it('carries the amounts with currency attributes', () => {
    const out = xml()
    expect(out).toContain('<cbc:TaxAmount currencyID="EUR">200.00</cbc:TaxAmount>')
    expect(out).toContain('<cbc:PayableAmount currencyID="EUR">1200.00</cbc:PayableAmount>')
    expect(out).toContain('<cbc:InvoicedQuantity unitCode="C62">1</cbc:InvoicedQuantity>')
  })

  it('includes seller and buyer parties', () => {
    const out = xml()
    expect(out).toContain('<cbc:RegistrationName>AV Digital</cbc:RegistrationName>')
    expect(out).toContain('<cbc:CompanyID>FR32123456789</cbc:CompanyID>')
    expect(out).toContain('<cbc:RegistrationName>Client SARL</cbc:RegistrationName>')
  })
})
```

- [ ] **Step 2: Vérifier l'échec**

Run: `pnpm --filter @factelec/invoice-core test -- generate`
Expected: FAIL — module `generate.js` introuvable.

- [ ] **Step 3: Implémenter le générateur**

Run: `pnpm --filter @factelec/invoice-core add xmlbuilder2`

`packages/invoice-core/src/ubl/generate.ts` :

```ts
import { create } from 'xmlbuilder2'
import type { XMLBuilder } from 'xmlbuilder2/lib/interfaces.js'
import type { Invoice, Party } from '../model/schema.js'

const NS_INVOICE = 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2'
const NS_CAC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2'
const NS_CBC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2'

function addAmount(parent: XMLBuilder, name: string, value: string, currency: string): void {
  parent.ele(`cbc:${name}`).att('currencyID', currency).txt(value)
}

function addParty(parent: XMLBuilder, role: 'AccountingSupplierParty' | 'AccountingCustomerParty', party: Party): void {
  const p = parent.ele(`cac:${role}`).ele('cac:Party')
  p.ele('cac:PartyName').ele('cbc:Name').txt(party.name)
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
  const legal = p.ele('cac:PartyLegalEntity')
  legal.ele('cbc:RegistrationName').txt(party.name)
  if (party.siren) legal.ele('cbc:CompanyID').txt(party.siren)
}

export function generateUbl(invoice: Invoice): string {
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

  addParty(root, 'AccountingSupplierParty', invoice.seller)
  addParty(root, 'AccountingCustomerParty', invoice.buyer)

  const taxTotal = root.ele('cac:TaxTotal')
  addAmount(taxTotal, 'TaxAmount', invoice.totals.taxAmount, invoice.currency)
  for (const b of invoice.vatBreakdown) {
    const sub = taxTotal.ele('cac:TaxSubtotal')
    addAmount(sub, 'TaxableAmount', b.taxableAmount, invoice.currency)
    addAmount(sub, 'TaxAmount', b.taxAmount, invoice.currency)
    const category = sub.ele('cac:TaxCategory')
    category.ele('cbc:ID').txt(b.category)
    category.ele('cbc:Percent').txt(b.rate)
    category.ele('cac:TaxScheme').ele('cbc:ID').txt('VAT')
  }

  const totals = root.ele('cac:LegalMonetaryTotal')
  addAmount(totals, 'LineExtensionAmount', invoice.totals.sumOfLines, invoice.currency)
  addAmount(totals, 'TaxExclusiveAmount', invoice.totals.taxExclusive, invoice.currency)
  addAmount(totals, 'TaxInclusiveAmount', invoice.totals.taxInclusive, invoice.currency)
  addAmount(totals, 'PayableAmount', invoice.totals.payable, invoice.currency)

  for (const line of invoice.lines) {
    const l = root.ele('cac:InvoiceLine')
    l.ele('cbc:ID').txt(line.id)
    l.ele('cbc:InvoicedQuantity').att('unitCode', line.unitCode).txt(line.quantity)
    addAmount(l, 'LineExtensionAmount', line.lineNetAmount, invoice.currency)
    const item = l.ele('cac:Item')
    item.ele('cbc:Name').txt(line.name)
    const taxCategory = item.ele('cac:ClassifiedTaxCategory')
    taxCategory.ele('cbc:ID').txt(line.vatCategory)
    taxCategory.ele('cbc:Percent').txt(line.vatRate)
    taxCategory.ele('cac:TaxScheme').ele('cbc:ID').txt('VAT')
    const price = l.ele('cac:Price')
    addAmount(price, 'PriceAmount', line.unitPrice, invoice.currency)
  }

  return doc.end({ prettyPrint: true })
}
```

- [ ] **Step 4: Vérifier que les tests passent et exporter**

Ajouter à `packages/invoice-core/src/index.ts` :

```ts
export { generateUbl } from './ubl/generate.js'
```

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(invoice-core): génération UBL 2.1 depuis le modèle canonique"
```

---

### Task 5: Validation contre les XSD officiels DGFiP + golden file

**Files:**
- Create: `packages/invoice-core/tests/helpers/xsd.ts`, `packages/invoice-core/tests/helpers/golden.ts`
- Create: `packages/invoice-core/tests/golden/invoice-simple.ubl.xml` (générée puis figée à l'étape 4)
- Modify: `.github/workflows/ci.yml`
- Test: `packages/invoice-core/tests/ubl/xsd.test.ts`

**Interfaces:**
- Consumes: `generateUbl`, `buildInvoice`, fixtures.
- Produces (utilisés par la tâche 6) :
  - `validateAgainstXsd(xml: string): { valid: boolean; errors: string }` — exécute `xmllint --schema` contre `F1BASE_UBL-invoice-2.1.xsd`.
  - `expectMatchesGolden(fileName: string, actual: string): void` — compare au fichier de `tests/golden/` ; le crée s'il n'existe pas encore et si `UPDATE_GOLDEN=1`.

- [ ] **Step 1: Vérifier la présence de xmllint et du XSD**

Run:
```bash
xmllint --version
ls "docs/reglementaire/specifications-externes-v3.2/3- XSD_v3.2/2 - E-invoicing/F1_BASE_UBL_2.1/F1BASE_UBL-invoice-2.1.xsd"
```
Expected: version libxml2 affichée (préinstallé sur macOS) ; fichier XSD listé.

- [ ] **Step 2: Écrire les helpers**

`packages/invoice-core/tests/helpers/xsd.ts` :

```ts
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const XSD_PATH = resolve(
  import.meta.dirname,
  '../../../../docs/reglementaire/specifications-externes-v3.2/3- XSD_v3.2/2 - E-invoicing/F1_BASE_UBL_2.1/F1BASE_UBL-invoice-2.1.xsd',
)

export function validateAgainstXsd(xml: string): { valid: boolean; errors: string } {
  const dir = mkdtempSync(join(tmpdir(), 'factelec-xsd-'))
  const xmlPath = join(dir, 'invoice.xml')
  writeFileSync(xmlPath, xml, 'utf8')
  try {
    execFileSync('xmllint', ['--noout', '--schema', XSD_PATH, xmlPath], { stdio: 'pipe' })
    return { valid: true, errors: '' }
  } catch (error) {
    const e = error as { stderr?: Buffer }
    return { valid: false, errors: e.stderr?.toString() ?? String(error) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
```

`packages/invoice-core/tests/helpers/golden.ts` :

```ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect } from 'vitest'

const GOLDEN_DIR = resolve(import.meta.dirname, '../golden')

export function expectMatchesGolden(fileName: string, actual: string): void {
  const path = resolve(GOLDEN_DIR, fileName)
  if (!existsSync(path)) {
    if (process.env.UPDATE_GOLDEN === '1') {
      writeFileSync(path, actual, 'utf8')
      return
    }
    throw new Error(`Golden file manquant : ${fileName}. Lancer avec UPDATE_GOLDEN=1 pour le créer, puis le relire et le committer.`)
  }
  expect(actual).toBe(readFileSync(path, 'utf8'))
}
```

- [ ] **Step 3: Écrire le test qui échoue**

`packages/invoice-core/tests/ubl/xsd.test.ts` :

```ts
import { describe, expect, it } from 'vitest'
import { buildInvoice } from '../../src/model/compute.js'
import { generateUbl } from '../../src/ubl/generate.js'
import { expectMatchesGolden } from '../helpers/golden.js'
import { validateAgainstXsd } from '../helpers/xsd.js'
import { simpleInvoiceInput } from '../fixtures.js'

describe('UBL output against official DGFiP XSD (F1 BASE)', () => {
  it('validates the simple invoice against F1BASE_UBL-invoice-2.1.xsd', () => {
    const result = validateAgainstXsd(generateUbl(buildInvoice(simpleInvoiceInput)))
    expect(result.errors).toBe('')
    expect(result.valid).toBe(true)
  })

  it('matches the frozen golden file', () => {
    expectMatchesGolden('invoice-simple.ubl.xml', generateUbl(buildInvoice(simpleInvoiceInput)))
  })
})
```

Run: `pnpm --filter @factelec/invoice-core test -- xsd`
Expected: FAIL — au minimum le golden file est manquant. Si la validation XSD échoue aussi, lire attentivement `result.errors` : le profil F1 BASE est une restriction de l'UBL standard, et un écart (élément manquant/interdit ou mal ordonné) doit être corrigé dans `src/ubl/generate.ts` — jamais en modifiant le XSD. Itérer jusqu'à `valid: true`.

- [ ] **Step 4: Créer le golden file puis le figer**

Run:
```bash
mkdir -p packages/invoice-core/tests/golden
UPDATE_GOLDEN=1 pnpm --filter @factelec/invoice-core test -- xsd
cat packages/invoice-core/tests/golden/invoice-simple.ubl.xml
```
Expected: le fichier est créé. **Relire le XML intégralement** (en-têtes, parties, TVA 200.00, total 1200.00) avant de le committer — c'est désormais la référence.

- [ ] **Step 5: Vérifier que tout passe**

Run: `pnpm --filter @factelec/invoice-core test`
Expected: PASS, y compris les deux tests XSD/golden.

- [ ] **Step 6: Ajouter xmllint à la CI**

Dans `.github/workflows/ci.yml`, ajouter juste après l'étape `actions/setup-node@v4` :

```yaml
      - run: sudo apt-get update && sudo apt-get install -y libxml2-utils
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "test(invoice-core): validation XSD DGFiP (F1 BASE UBL) et golden file de référence"
```

---

### Task 6: Scénario multi-taux + API publique documentée

**Files:**
- Create: `packages/invoice-core/tests/golden/invoice-multi-rate.ubl.xml` (générée puis figée)
- Create: `packages/invoice-core/README.md`
- Test: `packages/invoice-core/tests/ubl/multi-rate.test.ts`

**Interfaces:**
- Consumes: tout ce qui précède.
- Produces: couverture du cas multi-taux (5,5 % / 20 % / exonéré) validé XSD ; README décrivant l'API publique du package.

- [ ] **Step 1: Écrire le test qui échoue**

`packages/invoice-core/tests/ubl/multi-rate.test.ts` :

```ts
import { describe, expect, it } from 'vitest'
import { buildInvoice } from '../../src/model/compute.js'
import { validateBusinessRules } from '../../src/model/rules.js'
import { generateUbl } from '../../src/ubl/generate.js'
import { expectMatchesGolden } from '../helpers/golden.js'
import { validateAgainstXsd } from '../helpers/xsd.js'
import { multiRateInvoiceInput } from '../fixtures.js'

describe('multi-rate invoice end to end', () => {
  const invoice = buildInvoice(multiRateInvoiceInput)

  it('satisfies every business rule', () => {
    expect(validateBusinessRules(invoice)).toEqual([])
  })

  it('validates against the official XSD', () => {
    const result = validateAgainstXsd(generateUbl(invoice))
    expect(result.errors).toBe('')
    expect(result.valid).toBe(true)
  })

  it('matches the frozen golden file', () => {
    expectMatchesGolden('invoice-multi-rate.ubl.xml', generateUbl(invoice))
  })
})
```

Run: `pnpm --filter @factelec/invoice-core test -- multi-rate`
Expected: FAIL — golden file manquant.

- [ ] **Step 2: Créer le golden file, relire, vérifier**

Run:
```bash
UPDATE_GOLDEN=1 pnpm --filter @factelec/invoice-core test -- multi-rate
cat packages/invoice-core/tests/golden/invoice-multi-rate.ubl.xml
pnpm --filter @factelec/invoice-core test
```
Expected: golden créé ; **relire le XML** (3 TaxSubtotal : 59.97/3.30 à 5,50 %, 49.90/9.98 à 20 %, 300.00/0.00 en E ; total TTC 423.15) ; toute la suite PASS.

- [ ] **Step 3: Écrire le README du package**

`packages/invoice-core/README.md` :

```markdown
# @factelec/invoice-core

Bibliothèque pure (sans I/O) du modèle canonique de facture, alignée sur la
norme sémantique EN 16931 et les spécifications externes DGFiP v3.2.

## API publique

- `parseInvoiceInput(data: unknown): InvoiceInput` — valide une saisie de facture (zod).
- `buildInvoice(input: InvoiceInput): Invoice` — calcule montants de lignes,
  ventilation TVA (groupée par catégorie + taux) et totaux (arrondi demi-supérieur).
- `validateBusinessRules(invoice: Invoice): RuleViolation[]` — sous-ensemble des
  règles EN 16931 (BR-CO-10/13/14/15/17/25, BR-S-08) ; tableau vide = conforme.
- `generateUbl(invoice: Invoice): string` — document UBL 2.1 Invoice validé
  contre le XSD officiel F1 BASE (tests `tests/ubl/`).

## Conventions

- Montants : chaînes à 2 décimales exactement (`"1000.00"`) ; quantités, prix
  unitaires et taux : jusqu'à 4 décimales. Calculs via big.js.
- Les golden files de `tests/golden/` sont la référence de non-régression :
  toute modification doit être relue et volontaire (`UPDATE_GOLDEN=1` ne crée
  que les fichiers absents).

## Hors périmètre v1 (plans suivants)

Factur-X (PDF/A-3 + CII), CII seul, Schematron EN 16931, remises/charges de
pied de facture, acomptes, lecture de factures entrantes.
```

- [ ] **Step 4: Vérification finale complète**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS — l'intégralité de la suite (schéma, money, compute, rules, generate, xsd, multi-rate).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(invoice-core): scénario multi-taux validé XSD et documentation de l'API"
```
