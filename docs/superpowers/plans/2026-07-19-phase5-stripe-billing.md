# Intégration Stripe (phase 5, itération 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Abonnement Stripe (1 plan + volume métré) avec miroir local piloté par webhooks, garde d'émission 402 et page dashboard — spec `docs/superpowers/specs/2026-07-19-stripe-billing-phase5-design.md`.

**Architecture:** Module NestJS `billing` dans `apps/api` : `BillingPort` (6e port du projet, drivers `stripe`/`fake`/`none`), miroir `tenant_billing` mis à jour par webhooks signés (anti-réordonnancement par `last_event_created`), `BillingGuard` (402) sur les mutations d'émission, job worker d'agrégation d'usage quotidien (idempotent par `(tenant, day)`), page « Abonnement » Next.js 100 % hébergé Stripe (Checkout + Portal).

**Tech Stack:** NestJS 11 ESM, Drizzle + Postgres (RLS FORCE), BullMQ, zod env, SDK `stripe` (dernière stable), Next.js 16 (apps/web), Vitest + Testcontainers.

## Global Constraints

- Qualité : TDD strict (test vu échouer d'abord), couverture >90 %, `pnpm audit` 0 vulnérabilité, `pnpm -r outdated` vierge.
- Style : Biome (repo config), imports ESM avec suffixe `.js`, commentaires en français expliquant le POURQUOI (densité des modules voisins).
- Verrous d'architecture actifs : **heavy-suites** (tout nouveau test e2e démarrant les workers BullMQ DOIT être ajouté à `HEAVY_TESTS` dans `apps/api/vitest.config.ts` DANS LE MÊME COMMIT) ; **dual-auth-composition** (interdiction de toucher aux 7 mutations dual-auth — billing est session-only, aucun contact) ; **apikeyid-setters** (non concerné).
- Montants/IDs Stripe JAMAIS en dur dans le code : uniquement des IDs via env.
- `BILLING_DRIVER=none` (défaut) : plateforme intégralement fonctionnelle sans Stripe ; `BILLING_DRIVER=none` neutralise le garde MÊME SI `BILLING_ENFORCEMENT=on`.
- Statuts Stripe → énum locale : `incomplete_expired`→`canceled`, `paused`→`unpaid`, autres identiques ; autorisés par le garde : `active|trialing|past_due`.
- Jour d'usage : **date UTC** (frontière 00:00 UTC).
- Migration suivante disponible : **0030** (0029 = worker_role_grants, déjà pris).
- Branche de travail : `feat/phase5-stripe-billing` depuis `main`.

---

### Task 1: Env + dépendance stripe

**Files:**
- Modify: `apps/api/src/config/env.ts` (ajout de 8 clés dans `envSchema`)
- Modify: `apps/api/.env.example`
- Modify: `apps/api/package.json` (dépendance `stripe`)
- Test: `apps/api/tests/unit/config-env.test.ts` (fichier existant si présent — sinon vérifier `git grep -l "envSchema" apps/api/tests` et compléter le fichier de test d'env existant ; s'il n'y en a aucun, créer `apps/api/tests/unit/billing-env.test.ts` avec le contenu du Step 1)

**Interfaces:**
- Produces: clés d'env typées `BILLING_DRIVER: 'stripe'|'fake'|'none'`, `BILLING_ENFORCEMENT: 'on'|'off'`, `STRIPE_SECRET_KEY?: string`, `STRIPE_WEBHOOK_SECRET?: string`, `STRIPE_PRICE_BASE?: string`, `STRIPE_PRICE_METERED?: string`, `BILLING_DASHBOARD_URL: string`, `BILLING_USAGE_EVERY_MS: number` — consommées par toutes les tâches suivantes via `ConfigService<EnvConfig, true>`.

- [ ] **Step 1: Écrire le test qui échoue** (dans le fichier de test d'env repéré ci-dessus)

```ts
import { describe, expect, it } from 'vitest'
import { envSchema } from '../../src/config/env.js'

describe('env billing (phase 5)', () => {
  const BASE = {
    DATABASE_URL: 'postgres://u:p@h:5432/db',
    DATABASE_OWNER_URL: 'postgres://o:p@h:5432/db',
    SESSION_SECRET: 'x'.repeat(64),
  } as const

  it('défauts sûrs : driver none, enforcement off, usage horaire', () => {
    const parsed = envSchema.parse(BASE)
    expect(parsed.BILLING_DRIVER).toBe('none')
    expect(parsed.BILLING_ENFORCEMENT).toBe('off')
    expect(parsed.BILLING_DASHBOARD_URL).toBe('http://localhost:3001')
    expect(parsed.BILLING_USAGE_EVERY_MS).toBe(3_600_000)
  })

  it('rejette un driver inconnu', () => {
    expect(() =>
      envSchema.parse({ ...BASE, BILLING_DRIVER: 'paypal' }),
    ).toThrow()
  })

  it('accepte la configuration stripe complète', () => {
    const parsed = envSchema.parse({
      ...BASE,
      BILLING_DRIVER: 'stripe',
      STRIPE_SECRET_KEY: 'sk_test_123',
      STRIPE_WEBHOOK_SECRET: 'whsec_123',
      STRIPE_PRICE_BASE: 'price_base',
      STRIPE_PRICE_METERED: 'price_metered',
    })
    expect(parsed.BILLING_DRIVER).toBe('stripe')
    expect(parsed.STRIPE_SECRET_KEY).toBe('sk_test_123')
  })
})
```

Nota : adapter `BASE` aux clés réellement requises par `envSchema` (regarder les clés sans `.default()`/`.optional()` dans `apps/api/src/config/env.ts` — le test doit parser avec le minimum requis existant).

- [ ] **Step 2: Vérifier l'échec**

Run: `cd apps/api && pnpm exec vitest run tests/unit/<fichier-env>.test.ts`
Expected: FAIL (`BILLING_DRIVER` absent du schéma → `parsed.BILLING_DRIVER` undefined).

- [ ] **Step 3: Ajouter les clés au schéma** (`apps/api/src/config/env.ts`, à la fin de l'objet `envSchema`, avant la fermeture)

```ts
  // ── Billing Stripe (phase 5, spec 2026-07-19) ──────────────────────────
  // Driver 'none' par défaut : la plateforme reste 100 % fonctionnelle sans
  // compte Stripe (dev/CI). 'fake' = tests. 'stripe' = SDK réel (les 4 clés
  // STRIPE_* deviennent nécessaires — vérifié au câblage du module, throw
  // explicite, motif ConsentSignatureModule).
  BILLING_DRIVER: z.enum(['stripe', 'fake', 'none']).default('none'),
  // Enforcement découplé du driver : 'off' = le garde évalue et log sans
  // bloquer (activation explicite au go-live commercial). BILLING_DRIVER
  // 'none' neutralise le garde même à 'on' (sinon : blocage global).
  BILLING_ENFORCEMENT: z.enum(['on', 'off']).default('off'),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_BASE: z.string().optional(),
  STRIPE_PRICE_METERED: z.string().optional(),
  // success/cancel/return URLs des sessions hébergées Stripe.
  BILLING_DASHBOARD_URL: z.url().default('http://localhost:3001'),
  // Sweep horaire idempotent (report du jour J-1 UTC, sauté si déjà fait) —
  // même philosophie que les autres *_EVERY_MS.
  BILLING_USAGE_EVERY_MS: z.coerce.number().int().positive().default(3_600_000),
```

- [ ] **Step 4: Vérifier le passage**

Run: `pnpm exec vitest run tests/unit/<fichier-env>.test.ts`
Expected: PASS.

- [ ] **Step 5: Dépendance + .env.example**

```bash
cd apps/api && pnpm add stripe
```

Ajouter à `apps/api/.env.example` :

```sh
# Billing Stripe (phase 5) — 'none' = désactivé (défaut dev)
BILLING_DRIVER=none
BILLING_ENFORCEMENT=off
#STRIPE_SECRET_KEY=sk_test_...
#STRIPE_WEBHOOK_SECRET=whsec_...
#STRIPE_PRICE_BASE=price_...
#STRIPE_PRICE_METERED=price_...
BILLING_DASHBOARD_URL=http://localhost:3001
```

- [ ] **Step 6: Gate locale + commit**

Run: `pnpm exec tsc --noEmit && pnpm exec vitest run tests/unit && cd .. && pnpm audit && pnpm -r outdated`
Expected: verts, audit 0, outdated vierge.

```bash
git add apps/api/src/config/env.ts apps/api/.env.example apps/api/package.json pnpm-lock.yaml apps/api/tests/unit/
git commit -m "feat(api): env billing phase 5 (driver stripe/fake/none, enforcement off par défaut) + dépendance stripe"
```

---

### Task 2: Migration 0030 + schéma Drizzle (tenant_billing, billing_usage_reports, 2 fonctions SD)

**Files:**
- Create: `apps/api/src/db/migrations/0030_billing.sql`
- Modify: `apps/api/src/db/schema.ts` (énum + 2 tables, après `paymentSubtotals`)
- Modify: `apps/api/src/db/migrations/meta/_journal.json` (entrée 0030 — copier le format de l'entrée 0029)
- Test: e2e en Task 4 (repository) — cette tâche livre le socle SQL, compilable et migrable.

**Interfaces:**
- Produces: tables Drizzle `tenantBilling`, `billingUsageReports`, énum `billingStatus` ; fonctions SQL `find_billing_tenant_by_customer(p_customer text)` → `uuid` et `find_billing_subscribed_tenants()` → `TABLE(tenant_id uuid, stripe_customer_id text)`.

- [ ] **Step 1: Schéma Drizzle** (`apps/api/src/db/schema.ts`, après `paymentSubtotals`)

```ts
// ── Billing Stripe (phase 5, spec 2026-07-19) ─────────────────────────────
// Énum LOCALE (pas les statuts Stripe bruts) : mapping conservateur fait au
// webhook (incomplete_expired→canceled, paused→unpaid). 'none' = jamais
// abonné — ligne créée au premier checkout.
export const billingStatus = pgEnum('billing_status', [
  'none',
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'canceled',
  'incomplete',
])

// Miroir local de l'état d'abonnement (source de vérité = Stripe ; le garde
// ne lit QUE ce miroir — zéro appel réseau par requête).
// onDelete 'restrict' : historique comptable conservé (spec §3).
export const tenantBilling = pgTable(
  'tenant_billing',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    stripeCustomerId: text('stripe_customer_id'),
    stripeSubscriptionId: text('stripe_subscription_id'),
    status: billingStatus('status').notNull().default('none'),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    // Horodatage Stripe (event.created) du dernier événement APPLIQUÉ :
    // garde anti-réordonnancement des webhooks (spec §4 — un événement plus
    // ancien que le dernier appliqué est rejeté silencieusement).
    lastEventCreated: timestamp('last_event_created', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('tenant_billing_customer_unique').on(t.stripeCustomerId),
  ],
)

// Idempotence du report d'usage : une ligne par (tenant, jour UTC) ;
// reported_at null = comptée mais pas encore poussée à Stripe (reprise au
// run suivant — crash-safe, spec §6).
export const billingUsageReports = pgTable(
  'billing_usage_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    day: text('day').notNull(), // YYYY-MM-DD (UTC)
    count: integer('count').notNull(),
    reportedAt: timestamp('reported_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('billing_usage_reports_tenant_day_unique').on(
      t.tenantId,
      t.day,
    ),
  ],
)
```

(Vérifier que `integer` est déjà importé de `drizzle-orm/pg-core` en tête de `schema.ts` ; sinon l'ajouter à l'import existant.)

- [ ] **Step 2: Migration SQL** (`apps/api/src/db/migrations/0030_billing.sql`)

```sql
CREATE TYPE "public"."billing_status" AS ENUM ('none', 'trialing', 'active', 'past_due', 'unpaid', 'canceled', 'incomplete');
--> statement-breakpoint
CREATE TABLE "tenant_billing" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"status" "billing_status" DEFAULT 'none' NOT NULL,
	"current_period_end" timestamp with time zone,
	"last_event_created" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_usage_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"day" text NOT NULL,
	"count" integer NOT NULL,
	"reported_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant_billing" ADD CONSTRAINT "tenant_billing_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "billing_usage_reports" ADD CONSTRAINT "billing_usage_reports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_billing_customer_unique" ON "tenant_billing" USING btree ("stripe_customer_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_usage_reports_tenant_day_unique" ON "billing_usage_reports" USING btree ("tenant_id","day");
--> statement-breakpoint
-- RLS FORCE + moindre privilège (gabarit tenant_isolation, cf. 0025). Le
-- miroir billing est mutable (UPDATE) contrairement aux captures payments :
-- il suit l'état Stripe. Pas de DELETE (historique comptable, spec §3).
ALTER TABLE tenant_billing ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenant_billing FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON tenant_billing
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON tenant_billing TO factelec_app;
--> statement-breakpoint
GRANT SELECT ON tenant_billing TO factelec_worker;
--> statement-breakpoint
ALTER TABLE billing_usage_reports ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE billing_usage_reports FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON billing_usage_reports
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT ON billing_usage_reports TO factelec_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON billing_usage_reports TO factelec_worker;
--> statement-breakpoint
-- SD 1 : résolution du tenant d'un webhook par customer Stripe — le webhook
-- arrive SANS contexte tenant (RLS bloquerait). STRUCTURELLEMENT read-only
-- (LANGUAGE sql, un seul SELECT), projette une seule colonne — même posture
-- que find_stuck_generation_invoices (2.1).
CREATE FUNCTION find_billing_tenant_by_customer(p_customer text)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tenant_id FROM tenant_billing WHERE stripe_customer_id = p_customer;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION find_billing_tenant_by_customer(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION find_billing_tenant_by_customer(text) TO factelec_app;
--> statement-breakpoint
-- SD 2 : énumération des tenants abonnés pour le sweep d'usage (worker,
-- cross-tenant par nature). Read-only, colonnes projetées seulement.
CREATE FUNCTION find_billing_subscribed_tenants()
RETURNS TABLE(tenant_id uuid, stripe_customer_id text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tenant_id, stripe_customer_id
  FROM tenant_billing
  WHERE status IN ('trialing', 'active', 'past_due')
    AND stripe_customer_id IS NOT NULL;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION find_billing_subscribed_tenants() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION find_billing_subscribed_tenants() TO factelec_worker;
```

- [ ] **Step 3: Journal des migrations** — ajouter l'entrée 0030 à `apps/api/src/db/migrations/meta/_journal.json` en copiant la forme exacte de l'entrée 0029 (mêmes champs, `idx: 30`, `tag: "0030_billing"`). Si le projet régénère les snapshots via drizzle-kit, exécuter la commande utilisée par les migrations précédentes (voir scripts `package.json`, p. ex. `pnpm drizzle:generate` — sinon journal manuel comme les migrations hand-written 0022+).

- [ ] **Step 4: Vérifier compilation + migration**

Run: `cd apps/api && pnpm exec tsc --noEmit`
Expected: PASS.
Run: `pnpm exec vitest run tests/e2e/invoices-repository.e2e.test.ts` (démarre un Postgres Testcontainers et applique TOUTES les migrations dont 0030)
Expected: PASS (aucun test billing encore — vérifie juste que 0030 s'applique sans erreur).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/
git commit -m "feat(api): migration 0030 billing — tenant_billing + billing_usage_reports (RLS FORCE, grants app/worker différenciés, 2 fonctions SD read-only)"
```

---

### Task 3: BillingPort + drivers fake/none + module factory

**Files:**
- Create: `apps/api/src/billing/billing.port.ts`
- Create: `apps/api/src/billing/fake-billing.driver.ts`
- Create: `apps/api/src/billing/none-billing.driver.ts`
- Create: `apps/api/src/billing/billing-port.module.ts`
- Test: `apps/api/tests/unit/billing-port.test.ts`

**Interfaces:**
- Produces (consommé par Tasks 4-9) :

```ts
export const BILLING_PORT: unique symbol
export type BillingSubscriptionStatus =
  | 'none' | 'trialing' | 'active' | 'past_due'
  | 'unpaid' | 'canceled' | 'incomplete'
export interface BillingCustomerMeta {
  tenantId: string
  name: string
  siren: string
  email: string
}
export interface BillingUsageEvent {
  customerId: string
  day: string // YYYY-MM-DD UTC
  count: number
}
// Événement webhook NORMALISÉ par le driver (le parsing spécifique Stripe
// vit dans le driver, pas dans le service).
export interface BillingWebhookEvent {
  customerId: string | null
  occurredAt: Date // event.created
  subscriptionId: string | null
  status: BillingSubscriptionStatus | null // null = événement sans statut
  currentPeriodEnd: Date | null
}
export class BillingDisabledError extends Error {}
export class BillingSignatureError extends Error {}
export interface BillingPort {
  ensureCustomer(meta: BillingCustomerMeta): Promise<string>
  createCheckoutSession(customerId: string, successUrl: string, cancelUrl: string): Promise<string>
  createPortalSession(customerId: string, returnUrl: string): Promise<string>
  reportUsage(events: BillingUsageEvent[]): Promise<void>
  constructWebhookEvent(rawBody: Buffer, signature: string): BillingWebhookEvent
}
```

- `FakeBillingDriver` expose en plus (tests) : `static sign(rawBody: Buffer): string` (HMAC-SHA256 hex, secret `'whsec_fake'`) et `readonly reported: BillingUsageEvent[]`.
- `NoneBillingDriver` : toute méthode → `throw new BillingDisabledError('billing désactivé (BILLING_DRIVER=none)')`.

- [ ] **Step 1: Test qui échoue** (`tests/unit/billing-port.test.ts`)

```ts
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  BillingDisabledError,
  BillingSignatureError,
} from '../../src/billing/billing.port.js'
import { FakeBillingDriver } from '../../src/billing/fake-billing.driver.js'
import { NoneBillingDriver } from '../../src/billing/none-billing.driver.js'

describe('FakeBillingDriver', () => {
  it('ensureCustomer est idempotent par tenant', async () => {
    const fake = new FakeBillingDriver()
    const meta = {
      tenantId: 't-1',
      name: 'Org',
      siren: '123456789',
      email: 'o@ex.com',
    }
    const a = await fake.ensureCustomer(meta)
    const b = await fake.ensureCustomer(meta)
    expect(a).toBe(b)
    expect(a).toMatch(/^cus_fake_/)
  })

  it('createCheckoutSession/createPortalSession renvoient des URLs déterministes', async () => {
    const fake = new FakeBillingDriver()
    const cus = await fake.ensureCustomer({
      tenantId: 't-1',
      name: 'Org',
      siren: '123456789',
      email: 'o@ex.com',
    })
    const checkout = await fake.createCheckoutSession(
      cus,
      'http://ok',
      'http://ko',
    )
    expect(checkout).toContain('checkout')
    const portal = await fake.createPortalSession(cus, 'http://back')
    expect(portal).toContain('portal')
  })

  it('constructWebhookEvent vérifie la signature HMAC et normalise', () => {
    const fake = new FakeBillingDriver()
    const body = Buffer.from(
      JSON.stringify({
        customerId: 'cus_fake_t-1',
        occurredAt: '2026-07-19T00:00:00.000Z',
        subscriptionId: 'sub_fake_1',
        status: 'active',
        currentPeriodEnd: '2026-08-19T00:00:00.000Z',
      }),
    )
    const evt = fake.constructWebhookEvent(body, FakeBillingDriver.sign(body))
    expect(evt.customerId).toBe('cus_fake_t-1')
    expect(evt.status).toBe('active')
    expect(evt.occurredAt).toEqual(new Date('2026-07-19T00:00:00.000Z'))
  })

  it('constructWebhookEvent rejette une signature invalide', () => {
    const fake = new FakeBillingDriver()
    const body = Buffer.from('{}')
    const bad = createHmac('sha256', 'wrong').update(body).digest('hex')
    expect(() => fake.constructWebhookEvent(body, bad)).toThrow(
      BillingSignatureError,
    )
  })

  it('reportUsage accumule (observable pour les tests aval)', async () => {
    const fake = new FakeBillingDriver()
    await fake.reportUsage([
      { customerId: 'cus_fake_t-1', day: '2026-07-18', count: 3 },
    ])
    expect(fake.reported).toEqual([
      { customerId: 'cus_fake_t-1', day: '2026-07-18', count: 3 },
    ])
  })
})

describe('NoneBillingDriver', () => {
  it.each([
    ['ensureCustomer'],
    ['createCheckoutSession'],
    ['createPortalSession'],
    ['reportUsage'],
  ] as const)('%s → BillingDisabledError', async (method) => {
    const none = new NoneBillingDriver()
    // biome-ignore lint/suspicious/noExplicitAny: dispatch générique de test
    await expect((none as any)[method]()).rejects.toThrow(BillingDisabledError)
  })

  it('constructWebhookEvent → BillingDisabledError (synchrone)', () => {
    const none = new NoneBillingDriver()
    expect(() => none.constructWebhookEvent(Buffer.from(''), 'x')).toThrow(
      BillingDisabledError,
    )
  })
})
```

- [ ] **Step 2: Vérifier l'échec** — `pnpm exec vitest run tests/unit/billing-port.test.ts` → FAIL (modules inexistants).

- [ ] **Step 3: Implémenter** — `billing.port.ts` (interfaces + erreurs du bloc Interfaces ci-dessus, avec `export const BILLING_PORT = Symbol('BILLING_PORT')`), puis :

`fake-billing.driver.ts` :

```ts
import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  type BillingCustomerMeta,
  type BillingPort,
  BillingSignatureError,
  type BillingUsageEvent,
  type BillingWebhookEvent,
} from './billing.port.js'

const FAKE_SECRET = 'whsec_fake'

// Driver en mémoire, déterministe — tests unit/e2e ET dev interactif sans
// compte Stripe. Le customer est dérivé du tenantId (idempotence naturelle).
export class FakeBillingDriver implements BillingPort {
  private readonly customers = new Map<string, string>()
  readonly reported: BillingUsageEvent[] = []

  static sign(rawBody: Buffer): string {
    return createHmac('sha256', FAKE_SECRET).update(rawBody).digest('hex')
  }

  async ensureCustomer(meta: BillingCustomerMeta): Promise<string> {
    const existing = this.customers.get(meta.tenantId)
    if (existing) return existing
    const id = `cus_fake_${meta.tenantId}`
    this.customers.set(meta.tenantId, id)
    return id
  }

  async createCheckoutSession(
    customerId: string,
    successUrl: string,
    _cancelUrl: string,
  ): Promise<string> {
    return `https://fake.stripe.local/checkout/${customerId}?success=${encodeURIComponent(successUrl)}`
  }

  async createPortalSession(
    customerId: string,
    returnUrl: string,
  ): Promise<string> {
    return `https://fake.stripe.local/portal/${customerId}?return=${encodeURIComponent(returnUrl)}`
  }

  async reportUsage(events: BillingUsageEvent[]): Promise<void> {
    this.reported.push(...events)
  }

  constructWebhookEvent(rawBody: Buffer, signature: string): BillingWebhookEvent {
    const expected = FakeBillingDriver.sign(rawBody)
    const a = Buffer.from(expected, 'hex')
    const b = Buffer.from(signature, 'hex')
    // timingSafeEqual exige des longueurs égales — une signature de longueur
    // différente est invalide par construction.
    if (a.length !== b.length || !timingSafeEqual(a, b))
      throw new BillingSignatureError('signature invalide')
    const parsed = JSON.parse(rawBody.toString()) as {
      customerId: string | null
      occurredAt: string
      subscriptionId: string | null
      status: BillingWebhookEvent['status']
      currentPeriodEnd: string | null
    }
    return {
      customerId: parsed.customerId,
      occurredAt: new Date(parsed.occurredAt),
      subscriptionId: parsed.subscriptionId,
      status: parsed.status,
      currentPeriodEnd: parsed.currentPeriodEnd
        ? new Date(parsed.currentPeriodEnd)
        : null,
    }
  }
}
```

`none-billing.driver.ts` :

```ts
import {
  BillingDisabledError,
  type BillingPort,
  type BillingWebhookEvent,
} from './billing.port.js'

const DISABLED = 'billing désactivé (BILLING_DRIVER=none)'

// Neutre : tout usage actif échoue explicitement — le service traduit en
// 503 problem-details ; le garde, lui, ne passe JAMAIS par le port.
export class NoneBillingDriver implements BillingPort {
  async ensureCustomer(): Promise<string> {
    throw new BillingDisabledError(DISABLED)
  }
  async createCheckoutSession(): Promise<string> {
    throw new BillingDisabledError(DISABLED)
  }
  async createPortalSession(): Promise<string> {
    throw new BillingDisabledError(DISABLED)
  }
  async reportUsage(): Promise<void> {
    throw new BillingDisabledError(DISABLED)
  }
  constructWebhookEvent(): BillingWebhookEvent {
    throw new BillingDisabledError(DISABLED)
  }
}
```

`billing-port.module.ts` (calque exact de `ConsentSignatureModule`) :

```ts
import { Global, Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { EnvConfig } from '../config/env.js'
import { BILLING_PORT, type BillingPort } from './billing.port.js'
import { FakeBillingDriver } from './fake-billing.driver.js'
import { NoneBillingDriver } from './none-billing.driver.js'
import { StripeBillingDriver } from './stripe-billing.driver.js'

// Sélection du driver billing par env — motif ConsentSignatureModule (3.5).
// 'stripe' exige les 4 clés STRIPE_* : throw au bootstrap (fail-fast) plutôt
// qu'au premier appel.
@Global()
@Module({
  providers: [
    {
      provide: BILLING_PORT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvConfig, true>): BillingPort => {
        const driver = config.get('BILLING_DRIVER', { infer: true })
        if (driver === 'none') return new NoneBillingDriver()
        if (driver === 'fake') return new FakeBillingDriver()
        if (driver === 'stripe') {
          const secretKey = config.get('STRIPE_SECRET_KEY', { infer: true })
          const webhookSecret = config.get('STRIPE_WEBHOOK_SECRET', {
            infer: true,
          })
          const priceBase = config.get('STRIPE_PRICE_BASE', { infer: true })
          const priceMetered = config.get('STRIPE_PRICE_METERED', {
            infer: true,
          })
          if (!secretKey || !webhookSecret || !priceBase || !priceMetered)
            throw new Error(
              'BILLING_DRIVER=stripe exige STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_BASE et STRIPE_PRICE_METERED',
            )
          return new StripeBillingDriver(
            secretKey,
            webhookSecret,
            priceBase,
            priceMetered,
          )
        }
        // exhaustivité : zod borne déjà l'énum, ceci est le filet anti-drift
        throw new Error(`driver billing inconnu: ${driver satisfies never}`)
      },
    },
  ],
  exports: [BILLING_PORT],
})
export class BillingPortModule {}
```

Nota Task 3 : `StripeBillingDriver` n'existe pas encore (Task 4). Pour compiler, créer dès cette tâche un `stripe-billing.driver.ts` SQUELETTE dont chaque méthode `throw new Error('non implémenté (Task 4)')`, remplacé en Task 4 — OU inverser : implémenter Task 4 avant le module. Choix retenu : squelette (le module se teste dès maintenant).

- [ ] **Step 4: Vérifier le passage** — `pnpm exec vitest run tests/unit/billing-port.test.ts` → PASS. Ajouter au même fichier de test la factory (via `Test.createTestingModule` ou appel direct de la fonction si extraite) : `none`→NoneBillingDriver, `fake`→FakeBillingDriver, `stripe` sans clés → throw contenant `STRIPE_SECRET_KEY`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/billing/ apps/api/tests/unit/billing-port.test.ts
git commit -m "feat(api): BillingPort (6e port) + drivers fake/none + factory fail-fast"
```

---

### Task 4: StripeBillingDriver (SDK officiel, zéro réseau en test)

**Files:**
- Modify: `apps/api/src/billing/stripe-billing.driver.ts` (remplace le squelette)
- Test: `apps/api/tests/unit/stripe-billing-driver.test.ts`

**Interfaces:**
- Consumes: `BillingPort` et types de Task 3.
- Produces: `new StripeBillingDriver(secretKey, webhookSecret, priceBase, priceMetered)` implémentant `BillingPort` ; meter Stripe nommé `documents_processed`.

- [ ] **Step 1: Test qui échoue** — mocker le SDK avec `vi.mock('stripe')` ; vérifier :
  - `ensureCustomer` : cherche par metadata tenant (`stripe.customers.search({ query: "metadata['tenant_id']:'t-1'" })`) → si trouvé renvoie l'id, sinon `customers.create` avec `metadata: { tenant_id, siren }`, `name`, `email` ;
  - `createCheckoutSession` : `checkout.sessions.create` en `mode: 'subscription'`, `line_items` = `[{ price: priceBase, quantity: 1 }, { price: priceMetered }]`, `customer`, `success_url`/`cancel_url` → renvoie `session.url` ;
  - `createPortalSession` : `billingPortal.sessions.create({ customer, return_url })` → `session.url` ;
  - `reportUsage` : un `billing.meterEvents.create` PAR événement avec `event_name: 'documents_processed'`, `identifier: `${customerId}-${day}`` (idempotence côté Stripe), `payload: { stripe_customer_id, value: String(count) }` ;
  - `constructWebhookEvent` : délègue à `stripe.webhooks.constructEvent(rawBody, signature, webhookSecret)` puis normalise. Utiliser `stripe.webhooks.generateTestHeaderString({ payload, secret })` du VRAI SDK (non mocké pour ce cas — instancier un vrai `Stripe` avec une clé factice, la vérification de signature est purement locale, zéro réseau) sur un payload `customer.subscription.updated` minimal :

```ts
const payload = JSON.stringify({
  id: 'evt_1',
  type: 'customer.subscription.updated',
  created: 1786060800,
  data: {
    object: {
      id: 'sub_1',
      customer: 'cus_1',
      status: 'active',
      current_period_end: 1788739200,
    },
  },
})
```

  attendre `{ customerId: 'cus_1', subscriptionId: 'sub_1', status: 'active', occurredAt: new Date(1786060800 * 1000), currentPeriodEnd: new Date(1788739200 * 1000) }` ; signature falsifiée → `BillingSignatureError`.
  - normalisation des statuts : `it.each` — `incomplete_expired`→`canceled`, `paused`→`unpaid`, `trialing`→`trialing`, `past_due`→`past_due` ;
  - `checkout.session.completed` (payload `data.object = { customer, subscription, ... }` sans `status`) → `status: 'active'` (un checkout complété EST un abonnement démarré) ;
  - `invoice.paid` / `invoice.payment_failed` → `status: 'active'` / `'past_due'` ;
  - type non consommé (`payment_intent.created`) → `status: null, customerId` extrait si présent sinon null (le service ignorera).

- [ ] **Step 2: Vérifier l'échec** — squelette → tout FAIL.

- [ ] **Step 3: Implémenter** `stripe-billing.driver.ts` : classe qui instancie `new Stripe(secretKey)` en interne, méthodes ci-dessus, normalisation dans une fonction privée `toLocalStatus(stripeStatus: string): BillingSubscriptionStatus` et `normalizeEvent(event: Stripe.Event): BillingWebhookEvent`. `constructWebhookEvent` attrape l'erreur du SDK et relance `BillingSignatureError`.

- [ ] **Step 4: PASS** — `pnpm exec vitest run tests/unit/stripe-billing-driver.test.ts`.

- [ ] **Step 5: Commit** — `git commit -m "feat(api): StripeBillingDriver (checkout/portal/meter events/webhook signé, normalisation des statuts)"`.

---

### Task 5: BillingRepository (miroir CAS anti-réordonnancement + usage idempotent)

**Files:**
- Create: `apps/api/src/billing/billing.repository.ts`
- Test: `apps/api/tests/e2e/billing-persistence.e2e.test.ts` (Postgres seul → reste dans `light`, PAS de workers)

**Interfaces:**
- Consumes: `TenantContextService.run(tenantId, work)` (`src/db/tenant-context.service.ts`), tables Task 2, `Pool` owner du setup e2e existant (voir `tests/e2e/invoices-repository.e2e.test.ts` pour le gabarit beforeAll/afterAll).
- Produces:

```ts
export interface TenantBillingState {
  status: BillingSubscriptionStatus
  stripeCustomerId: string | null
  stripeSubscriptionId: string | null
  currentPeriodEnd: Date | null
}
export class BillingRepository {
  getState(tenantId: string): Promise<TenantBillingState> // ligne absente → status 'none'
  attachCustomer(tenantId: string, customerId: string): Promise<void> // upsert, n'écrase pas un customer différent (throw)
  applyEvent(tenantId: string, evt: BillingWebhookEvent): Promise<boolean> // false = événement plus ancien qu'appliqué (rejeté)
  findTenantByCustomer(customerId: string): Promise<string | null> // SD 1
  listSubscribedTenants(): Promise<{ tenantId: string; stripeCustomerId: string }[]> // SD 2 (connexion worker)
  recordUsage(tenantId: string, day: string, count: number): Promise<void> // ON CONFLICT DO NOTHING
  findUnreportedUsage(tenantId: string): Promise<{ id: string; day: string; count: number }[]>
  markUsageReported(tenantId: string, id: string): Promise<void>
}
```

- [ ] **Step 1: Tests e2e qui échouent** — gabarit beforeAll de `invoices-repository.e2e.test.ts` (conteneur + rôles + migrations). Cas :
  1. `getState` sans ligne → `{ status: 'none', stripeCustomerId: null, ... }` ;
  2. `attachCustomer` puis `getState` → customer présent, statut `none` ; ré-appel même customer → idempotent ; customer DIFFÉRENT → throw ;
  3. `applyEvent` (status `active`, `occurredAt` T1) → true, statut `active` ; ré-appel avec `occurredAt` T0 < T1 et status `canceled` → **false**, statut TOUJOURS `active` (anti-réordonnancement) ; T2 > T1 `canceled` → true ;
  4. RLS : `applyEvent`/`getState` d'un tenant B ne voit jamais la ligne du tenant A (état `none`) ;
  5. `findTenantByCustomer` (rôle app, hors contexte tenant) retrouve le tenant ; customer inconnu → null ;
  6. `recordUsage` deux fois même `(tenant, day)` → une seule ligne (unique) ; `findUnreportedUsage` la renvoie ; `markUsageReported` → plus renvoyée ;
  7. `listSubscribedTenants` : tenant `active` listé, tenant `none`/`canceled` absent.

- [ ] **Step 2: FAIL** — `pnpm exec vitest run tests/e2e/billing-persistence.e2e.test.ts`.

- [ ] **Step 3: Implémenter** — `applyEvent` : UPDATE CAS `WHERE tenant_id = $1 AND (last_event_created IS NULL OR last_event_created < $occurredAt)` (retour 0 ligne → tenter l'INSERT si ligne absente, sinon false) ; `findTenantByCustomer` : `SELECT find_billing_tenant_by_customer($1)` ; `listSubscribedTenants` : `SELECT * FROM find_billing_subscribed_tenants()` sur la connexion worker (voir comment `invoice-reconciliation.service.ts` exécute ses SD).

- [ ] **Step 4: PASS**, **Step 5: Commit** — `git commit -m "feat(api): BillingRepository — miroir CAS anti-réordonnancement, usage idempotent (tenant,day), SD app/worker"`.

---

### Task 6: BillingService + endpoints checkout/portal/status (+ ProblemType)

**Files:**
- Create: `apps/api/src/billing/billing.service.ts`
- Create: `apps/api/src/billing/billing.controller.ts`
- Create: `apps/api/src/billing/billing.module.ts` (importe BillingPortModule, déclare service+repo+controller ; enregistrer dans `app.module.ts`)
- Modify: `apps/api/src/common/problem.ts` (2 types)
- Test: `apps/api/tests/unit/billing.service.test.ts` + `apps/api/tests/e2e/billing-endpoints.e2e.test.ts` (light — pas de workers)

**Interfaces:**
- Consumes: `BILLING_PORT`, `BillingRepository`, guards existants `SessionGuard`, `RolesGuard`, `CsrfGuard`, décorateur `@Roles` (voir `invoices.controller.ts:116-117`), helper `problem()`.
- Produces: routes `POST /billing/checkout-session` → `{ url }`, `POST /billing/portal-session` → `{ url }`, `GET /billing/status` → `{ status, currentPeriodEnd, hasCustomer }` ; `ProblemType.paymentRequired = 'urn:factelec:problem:subscription-required'` et `ProblemType.billingDisabled = 'urn:factelec:problem:billing-disabled'`.

- [ ] **Step 1: Tests unit qui échouent** (mocks repo+port) :
  - checkout : tenant sans customer → `ensureCustomer` (meta = tenant name/siren/email du owner) puis `attachCustomer` puis URL ; tenant avec customer → pas de re-création ;
  - portal : sans customer → 409 problem `conflict` (« aucun abonnement ») ; avec → URL ;
  - status : relaie `getState` ;
  - driver none (`BillingDisabledError`) → 503 problem `billingDisabled` pour checkout/portal, mais `GET /status` répond `{ status: 'none' }` SANS toucher le port ;
  - URLs construites depuis `BILLING_DASHBOARD_URL` : success `${base}/billing?checkout=success`, cancel `${base}/billing?checkout=cancel`, return `${base}/billing`.
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implémenter.** Controller : `@Controller('billing')` ; GET status `@UseGuards(SessionGuard, RolesGuard)` + `@Roles('owner', 'admin')` ; les 2 POST ajoutent `CsrfGuard`. Le service lit tenant name/siren depuis la table `tenants` (via repo dédié existant ou requête directe TenantContext), email = user de session (`req.user.email` — vérifier la forme exacte posée par SessionGuard dans `src/auth/`).
- [ ] **Step 4: e2e** (gabarit signup/cookie/csrf de `lifecycle.e2e.test.ts`, `BILLING_DRIVER=fake` via env du module de test) : 401 sans session ; 403 rôle `viewer` ; 403 POST sans CSRF ; 200 checkout → `{ url }` contient `checkout` ; portal avant checkout → 409 ; status → `none` puis, après `applyEvent` direct repo (statut `active`), → `active`.
- [ ] **Step 5: PASS + commit** — `git commit -m "feat(api): endpoints billing checkout/portal/status (session owner|admin + CSRF, 503 driver none, 409 portal sans customer)"`.

---

### Task 7: Webhook (rawBody + signature + mapping miroir)

**Files:**
- Modify: `apps/api/src/main.ts:12` → `NestFactory.create(AppModule, { bufferLogs: true, rawBody: true })`
- Create: `apps/api/src/billing/billing-webhook.controller.ts`
- Create: `apps/api/src/billing/billing-webhook.service.ts`
- Test: `apps/api/tests/unit/billing-webhook.test.ts` + cas webhook dans `apps/api/tests/e2e/billing-endpoints.e2e.test.ts`

**Interfaces:**
- Consumes: `BILLING_PORT.constructWebhookEvent`, `BillingRepository.findTenantByCustomer` + `applyEvent`, `FakeBillingDriver.sign` (e2e).
- Produces: `POST /billing/webhook` (AUCUN guard session/CSRF — auth = signature ; `@SkipThrottle()` de `@nestjs/throttler` si le throttler est global, vérifier dans `app.module.ts`).

- [ ] **Step 1: Tests unit qui échouent** (service, mocks) :
  - signature invalide (`BillingSignatureError`) → `{ handled: false, reason: 'signature' }` → controller 400 SANS détail ;
  - customer inconnu → `{ handled: false, reason: 'unknown-customer' }` → 200 (contrat Stripe) + log warn ;
  - événement sans statut (`status: null`) → 200 ignoré, `applyEvent` JAMAIS appelé ;
  - événement valide → `applyEvent(tenantId, evt)` appelé, 200 ;
  - `applyEvent` → false (hors ordre) → 200 quand même (idempotence côté émetteur).
- [ ] **Step 2: FAIL.** **Step 3: Implémenter** — controller :

```ts
@Post('webhook')
@SkipThrottle()
@HttpCode(200)
async webhook(
  @Req() req: RawBodyRequest<Request>,
  @Headers('stripe-signature') signature: string | undefined,
): Promise<{ received: true }> {
  const raw = req.rawBody
  if (!raw || !signature)
    throw new BadRequestException(problem(400, ProblemType.validation, 'Bad request'))
  const result = await this.webhookService.handle(raw, signature)
  if (result.reason === 'signature')
    throw new BadRequestException(problem(400, ProblemType.validation, 'Bad request'))
  return { received: true }
}
```

- [ ] **Step 4: e2e** (driver fake) : POST body signé `FakeBillingDriver.sign` avec le customer attaché en Task 6 → 200 puis `GET /billing/status` = `active` ; signature fausse → 400 ; événement antérieur (occurredAt plus vieux) statut `canceled` → 200 mais statut reste `active` ; le tout SANS cookie de session (preuve : hors auth).
- [ ] **Step 5: PASS + commit** — `git commit -m "feat(api): webhook billing signé (rawBody, 400 silencieux, 200 idempotent, mapping miroir anti-réordonnancement)"`.

---

### Task 8: BillingGuard 402 sur les mutations d'émission

**Files:**
- Create: `apps/api/src/billing/billing.guard.ts`
- Modify: `apps/api/src/invoices/invoices.controller.ts:56-58` (`@UseGuards(ApiKeyGuard, BillingGuard)` sur `@Post()`)
- Modify: `apps/api/src/ereporting/ereporting.controller.ts:94-97` (`@UseGuards(TenantAuthGuard, RolesGuard, CsrfGuard, BillingGuard)` sur `@Post('retransmissions')`)
- Test: `apps/api/tests/unit/billing.guard.test.ts` + cas dans `apps/api/tests/e2e/billing-endpoints.e2e.test.ts`

**Interfaces:**
- Consumes: `req.tenantId` (posé par ApiKeyGuard/TenantAuthGuard — `api-key.guard.ts:46`), `BillingRepository.getState`, env `BILLING_DRIVER`/`BILLING_ENFORCEMENT`.
- Produces: `BillingGuard implements CanActivate` — 402 `ProblemType.paymentRequired` quand bloquant.

- [ ] **Step 1: Tests unit qui échouent** — matrice complète :

| driver | enforcement | status | résultat |
|---|---|---|---|
| none | on | * | PASSE (neutralisation, spec §4) |
| fake/stripe | off | none | PASSE (+ log) |
| fake/stripe | on | active / trialing / past_due | PASSE |
| fake/stripe | on | none / unpaid / canceled / incomplete | **402** |

  - 402 = `HttpException(problem(402, ProblemType.paymentRequired, 'Subscription required'), 402)` ;
  - `req.tenantId` absent (mauvais ordre de guards) → 402 conservateur ? NON : throw 500 interne explicite (« BillingGuard exige un guard d'auth en amont ») — un oubli de câblage doit hurler, pas facturer.
- [ ] **Step 2: FAIL.** **Step 3: Implémenter** (guard injectable, lit la config au constructor comme `SessionPurgeScheduler`). **Step 4: e2e** : avec `BILLING_ENFORCEMENT=on` + driver fake dans le module de test : tenant sans abonnement → `POST /invoices` (clé API valide) 402 type `urn:factelec:problem:subscription-required` ; après webhook `active` → 201 ; `GET /invoices` reste 200 pendant le blocage (lecture jamais bloquée) ; `POST /invoices/:id/status` (transition) reste 201 (jamais bloquée).
- [ ] **Step 5: PASS + commit** — `git commit -m "feat(api): BillingGuard 402 sur dépôt factures et retransmissions e-reporting (matrice driver×enforcement×statut, lectures jamais bloquées)"`.

---

### Task 9: Job worker de report d'usage (heavy-suites)

**Files:**
- Create: `apps/api/src/worker/billing-usage.service.ts`
- Create: `apps/api/src/worker/billing-usage.scheduler.ts` (calque `session-purge.scheduler.ts`, clé `'billing-usage'`, job `BILLING_USAGE_JOB`)
- Modify: `apps/api/src/queue/maintenance.job.ts` (`export const BILLING_USAGE_JOB = 'billing-usage'`)
- Modify: `apps/api/src/worker/maintenance.processor.ts` (route `job.name === BILLING_USAGE_JOB`)
- Modify: `apps/api/src/worker/worker.module.ts` (providers)
- Modify: `apps/api/vitest.config.ts` (**MÊME COMMIT** : ajouter `'tests/e2e/billing-usage.e2e.test.ts'` à `HEAVY_TESTS` — verrou heavy-suites)
- Test: `apps/api/tests/unit/billing-usage.service.test.ts` + `apps/api/tests/e2e/billing-usage.e2e.test.ts`

**Interfaces:**
- Consumes: `BillingRepository.listSubscribedTenants/recordUsage/findUnreportedUsage/markUsageReported`, `BILLING_PORT.reportUsage`, `TenantContextService`, tables `invoices` + `ereportingTransmissions` (comptage par `created_at`).
- Produces: `BillingUsageService.sweep(): Promise<{ tenants: number; reported: number }>`.

- [ ] **Step 1: Tests unit qui échouent** (mocks) : `sweep()` — jour cible = veille UTC calculée depuis `new Date()` (`const d = new Date(); d.setUTCDate(d.getUTCDate() - 1)` → `YYYY-MM-DD` par `toISOString().slice(0, 10)`) ; pour chaque tenant abonné : `recordUsage(tenant, day, count)` puis `findUnreportedUsage` → `port.reportUsage` → `markUsageReported` ; échec `reportUsage` (rejet) → `markUsageReported` PAS appelé, les autres tenants continuent (isolation d'erreur par tenant, log).
- [ ] **Step 2: FAIL.** **Step 3: Implémenter** — comptage dans le service :

```ts
// documents traités du jour J (UTC) : factures ingérées + transmissions
// e-reporting créées. Compte RLS-scopé (tenant.run) — le SD ne sert qu'à
// énumérer les tenants abonnés.
private async countDocuments(tenantId: string, day: string): Promise<number> {
  const from = new Date(`${day}T00:00:00.000Z`)
  const to = new Date(`${day}T24:00:00.000Z`)
  return this.tenant.run(tenantId, async (db) => {
    const [inv] = await db
      .select({ n: count() })
      .from(invoices)
      .where(and(gte(invoices.createdAt, from), lt(invoices.createdAt, to)))
    const [ere] = await db
      .select({ n: count() })
      .from(ereportingTransmissions)
      .where(
        and(
          gte(ereportingTransmissions.createdAt, from),
          lt(ereportingTransmissions.createdAt, to),
        ),
      )
    return Number(inv?.n ?? 0) + Number(ere?.n ?? 0)
  })
}
```

- [ ] **Step 4: e2e heavy** (workers BullMQ démarrés, gabarit d'un test HEAVY existant, p. ex. `cdv-transmission-sweep.e2e.test.ts`) : seed 1 tenant `active` (repo) + 2 factures antidatées à J-1 (UPDATE `created_at` en SQL owner) → `sweep()` → ligne `billing_usage_reports` `(tenant, J-1, 2)` reportée, `FakeBillingDriver.reported` contient l'événement ; re-`sweep()` → aucune nouvelle ligne ni double report. **Vérifier que le fichier est bien dans HEAVY_TESTS.**
- [ ] **Step 5: PASS + commit** — `git commit -m "feat(api): sweep billing d'usage quotidien (J-1 UTC, idempotent par tenant×jour, isolation d'erreur, HEAVY_TESTS même commit)"`.

---

### Task 10: Script bootstrap sandbox

**Files:**
- Create: `apps/api/scripts/billing-bootstrap.ts`
- Modify: `apps/api/package.json` (script `"billing:bootstrap": "node --import tsx scripts/billing-bootstrap.ts"`)
- Test: `apps/api/tests/unit/billing-bootstrap.test.ts` (fonction pure `ensureBillingCatalog(stripe)` mockée — le script CLI n'est qu'un appel)

**Interfaces:**
- Consumes: SDK `stripe`, env `STRIPE_SECRET_KEY`.
- Produces: fonction exportée `ensureBillingCatalog(stripe: Stripe): Promise<{ priceBase: string; priceMetered: string }>` — idempotente par `lookup_key`.

- [ ] **Step 1: Test qui échoue** : catalogue absent → crée meter `documents_processed` (`stripe.billing.meters.create`), product `Factelec` (`metadata.factelec: 'base'`), price base (2900 centimes EUR `recurring: { interval: 'month' }`, `lookup_key: 'factelec_base'`, `tax_behavior: 'exclusive'`) et price métré gradué (`lookup_key: 'factelec_metered'`, `recurring: { interval: 'month', usage_type: 'metered' /* rattaché au meter */ }`, `billing_scheme: 'tiered'`, `tiers: [{ up_to: 100, unit_amount: 0 }, { up_to: 'inf', unit_amount: 20 }]`, `tiers_mode: 'graduated'`) ; catalogue déjà présent (prices.list par lookup_keys renvoie 2 prix) → AUCUNE création, renvoie les IDs existants.
- [ ] **Step 2: FAIL.** **Step 3: Implémenter** (+ le `main` du script : lit `STRIPE_SECRET_KEY`, appelle la fonction, imprime `STRIPE_PRICE_BASE=… STRIPE_PRICE_METERED=…`). **Step 4: PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(api): script billing:bootstrap idempotent (product/meter/prices sandbox par lookup_key, TVA exclusive)"`.

---

### Task 11: Page dashboard « Abonnement » (apps/web)

**Files:**
- Create: `apps/web/src/app/(app)/billing/page.tsx`
- Create: `apps/web/src/components/billing-panel.tsx`
- Modify: `apps/web/src/lib/api.ts` (3 fonctions — suivre les signatures des fonctions existantes du fichier : `getBillingStatus()`, `createBillingCheckout()`, `createBillingPortal()`)
- Modify: le layout/nav de `(app)` (lien « Abonnement », visible owner/admin — copier la logique de rôle existante de la nav)
- Test: `apps/web/tests/components/billing-panel.test.tsx`

**Interfaces:**
- Consumes: `GET /billing/status` → `{ status, currentPeriodEnd, hasCustomer }`, `POST /billing/checkout-session`/`portal-session` → `{ url }` (Task 6), client HTTP existant de `lib/api.ts` (gère cookie + CSRF).
- Produces: page `/billing`.

- [ ] **Step 1: Tests composant qui échouent** (RTL, mock du module `lib/api` — gabarit `api-keys-manager.test.tsx`) : statut `none` → bouton « S'abonner » qui appelle `createBillingCheckout` et assigne `window.location.href` à l'URL reçue ; statut `active` avec date → « Abonnement actif », date formatée `fr-FR`, bouton « Gérer mon abonnement » → portal ; statut `past_due` → bannière d'avertissement (`role="alert"`) « Paiement en retard » + bouton portal ; statut `canceled`/`unpaid` → bannière blocage + bouton « S'abonner » ; erreur API 503 → message « Facturation indisponible ».
- [ ] **Step 2: FAIL.** **Step 3: Implémenter** (composant client, états locaux, pas de lib nouvelle). **Step 4: PASS** — `cd apps/web && pnpm test`.
- [ ] **Step 5: Commit** — `git commit -m "feat(web): page Abonnement (statuts, bannières past_due/bloqué, redirections Checkout/Portal hébergés)"`.

---

### Task 12: Documentation + version + gate finale

**Files:**
- Modify: `apps/api/README.md` (nouvelle section « Billing Stripe (phase 5, itération 1) » : architecture miroir/webhooks, matrice du garde, env, runbook bootstrap sandbox + `stripe listen --forward-to localhost:3000/billing/webhook`, dette « slot unique vs 212 répétés » NON liée mais voisine — ne pas dupliquer)
- Modify: `README.md` racine (phase 5 : Stripe livré en itération 1 — abonnement+usage+garde ; restent super admin complet + observabilité durcie ; dette « Stripe/abonnements → phase 5 » soldée pour l'itération 1)
- Modify: `apps/api/package.json` (version 0.14.0)

- [ ] **Step 1: Rédiger la doc** (sections ci-dessus, style et densité des sections voisines, TOUT état de fait vérifié contre le code).
- [ ] **Step 2: Gate complète**

Run (racine) : `pnpm -r test && pnpm audit && pnpm -r outdated && cd apps/api && pnpm exec tsc --noEmit && cd ../.. && pnpm exec biome check apps/api/src/billing apps/web/src`
Expected: tous verts, couverture agrégat >90 %, audit 0, outdated vierge.

- [ ] **Step 3: Commit + merge**

```bash
git add -A && git commit -m "docs(api): billing Stripe phase 5 itération 1 (miroir webhooks, garde 402, runbook sandbox) + bump 0.14.0"
git checkout main && git merge --no-ff feat/phase5-stripe-billing -m "Merge phase 5 itération 1 — billing Stripe (port ×3 drivers, miroir anti-réordonnancement, garde 402 émission, usage métré idempotent, dashboard Abonnement, gate verte)"
git branch -d feat/phase5-stripe-billing
```

(Push vers origin : selon l'autorisation en vigueur dans la session.)

---

## Self-Review (exécutée à l'écriture du plan)

1. **Couverture spec** : §1 périmètre→T3-T11 ; §2 tarification→T10 (bootstrap) + contrainte « jamais en dur » (T1 env IDs) ; §3 données→T2/T5 ; §4 module/endpoints/webhooks→T3/T4/T6/T7 ; §5 garde→T8 ; §6 usage→T9 ; §7 dashboard→T11 ; §8 erreurs→T6 (503/409), T7 (400/200), T5 (hors-ordre) ; §9 tests→dans chaque tâche + gate T12 ; §10 config→T1 ; §11 dépendances→T1. Aucun trou.
2. **Placeholders** : néant — chaque étape code ou commande concrète ; les deux points « vérifier la forme exacte » (clés BASE du test env T1, `req.user.email` T6) sont des instructions de lecture de fichier précises, pas des TBD.
3. **Cohérence de types** : `BillingPort`/`BillingWebhookEvent`/`TenantBillingState` définis en T3/T5 et consommés à l'identique en T6-T9 ; statuts autorisés du garde (T8) = ensemble `listSubscribedTenants` (T2/T5) = spec §5.
