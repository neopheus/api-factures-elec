# Correctif billing I1/I2 + minors — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Solder les 2 findings Important de la revue finale de branche phase 5 (I1 `currentPeriodEnd` fiable en prod ; I2 fenêtre de rattrapage du sweep) + 5 minors retenus — arbitrage Xavier acté dans l'amendement A1 de la spec (`docs/superpowers/specs/2026-07-19-stripe-billing-phase5-design.md`).

**Architecture:** sémantique tri-état `currentPeriodEnd` (`Date` porté / `null` porté-vide / `undefined` non-porté→préserve), lecture période via `items.data[].current_period_end`, CAS assoupli `<=`, sweep en boucle J-1..J-N.

**Tech Stack:** inchangée (NestJS ESM, Drizzle, stripe 22.3.2, Vitest/Testcontainers).

## Global Constraints

- TDD strict, couverture >90 %, audit 0, outdated vierge, Biome, ESM `.js`, commentaires français POURQUOI.
- Verrous d'architecture intacts (aucun nouveau fichier heavy ; dual-auth non touché).
- Branche : `fix/billing-i1-i2` depuis `main`.
- Amendement A1 (spec) fait foi : `undefined` = « non porté » → PRÉSERVE ; `null` = « porté vide » → efface ; CAS `last_event_created <= occurredAt`… ATTENTION : `<=` sur le CAS signifie « applique si occurredAt ≥ last_event_created » (les événements de la même seconde s'appliquent dans l'ordre d'arrivée, le re-délivré identique se ré-applique sans changement d'état — inoffensif).

---

### Task 1: I1 — currentPeriodEnd fiable + CAS same-second

**Files:**
- Modify: `apps/api/src/billing/billing.port.ts` (`BillingWebhookEvent.currentPeriodEnd: Date | null | undefined` + doc tri-état)
- Modify: `apps/api/src/billing/stripe-billing.driver.ts` (extraction période + undefined)
- Modify: `apps/api/src/billing/fake-billing.driver.ts` (relaie `undefined` si champ absent du JSON)
- Modify: `apps/api/src/billing/billing.repository.ts` (`applyEvent` : préserve si undefined ; CAS `<=`)
- Test: `apps/api/tests/unit/stripe-billing-driver.test.ts`, `apps/api/tests/unit/billing-webhook.test.ts` (si impacté), `apps/api/tests/e2e/billing-persistence.e2e.test.ts`, `apps/api/tests/e2e/billing-endpoints.e2e.test.ts` (si vecteurs impactés)

**Interfaces:**
- Produces: `BillingWebhookEvent.currentPeriodEnd?: Date | null` (undefined = non porté). `applyEvent` inchangé de signature.

- [ ] **Step 1 (RED)** : tests d'abord —
  - driver : `customer.subscription.updated` SANS `current_period_end` top-level mais AVEC `items: { data: [{ current_period_end: 1788739200 }] }` → `currentPeriodEnd: new Date(1788739200*1000)` (fallback items, nouvelle lecture) ; avec les DEUX présents → top-level prioritaire (compat legacy) ; `checkout.session.completed`/`invoice.paid`/`invoice.payment_failed` → `currentPeriodEnd: undefined` (non porté — plus `null`) ; `subscription.updated` sans AUCUNE source → `null` (porté-vide).
  - repo (e2e) : applyEvent(active, T1, period P) puis applyEvent(active, T2>T1, `currentPeriodEnd: undefined`) → période PRÉSERVE P ; puis applyEvent(T3, `null`) → période EFFACÉE ; **même seconde** : applyEvent(checkout-like T4, undefined) puis applyEvent(subscription-like T4 égal, period Q) → **appliqué** (CAS `<=`), période Q ; l'événement STRICTEMENT antérieur (T3 < T4) reste rejeté.
- [ ] **Step 2** : vérifier l'échec (nouveaux vecteurs FAIL).
- [ ] **Step 3** : implémenter — driver : accès typé local commenté pour `items.data[].current_period_end` (même approche que `SubscriptionWithLegacyPeriod`) ; ordre : top-level sinon `items.data[0]` sinon null ; events sans période → `undefined`. Repo : `currentPeriodEnd === undefined ? sql préservant la colonne (ne pas l'inclure dans le SET) : valeur` ; prédicat CAS `lte`. Fake driver : si la clé `currentPeriodEnd` est ABSENTE du JSON → `undefined`, si `null` → `null`.
- [ ] **Step 4** : suites ciblées puis unit complète + e2e billing (persistence + endpoints) → PASS ; tsc + biome.
- [ ] **Step 5** : commit `fix(api): currentPeriodEnd fiable (tri-état undefined/null, fallback items.data, CAS <= same-second) — revue finale I1, amendement A1`.

### Task 2: I2 lookback + minors M1/M5/M10/M13 + commentaire problem.ts

**Files:**
- Modify: `apps/api/src/config/env.ts` (`BILLING_USAGE_LOOKBACK_DAYS: z.coerce.number().int().positive().max(30).default(3)`)
- Modify: `apps/api/.env.example` (`BILLING_USAGE_EVERY_MS` + `BILLING_USAGE_LOOKBACK_DAYS` — M1)
- Modify: `apps/api/src/worker/billing-usage.service.ts` (boucle jours J-1..J-N, N=lookback ; le comptage/recordUsage restent idempotents par (tenant,day) donc la boucle est un simple `for` sur les jours, du plus ancien au plus récent ; commentaire POURQUOI citant le patron CDV_TRANSMISSION_LOOKBACK_MS + le chemin mark-échoué/identifier Stripe — M12 au passage)
- Modify: `apps/api/src/worker/maintenance.processor.ts` (retirer le log dupliqué — M13, garder celui du service)
- Modify: `apps/api/src/common/problem.ts` (commentaire périmé paymentRequired « pas encore câblé » → câblé Task 8 phase 5)
- Test: `apps/api/tests/unit/billing-usage.service.test.ts` (lookback : jour J-2 jamais enregistré → rattrapé ; jours déjà enregistrés → aucune double ligne), `apps/api/tests/e2e/billing-persistence.e2e.test.ts` (M5 : `attachCustomer` d'un tenant SANS abonnement puis `listSubscribedTenants` ne le liste PAS — exclusion d'une ligne status='none' EXISTANTE), `apps/api/tests/unit/billing-webhook.test.ts` (M10 : `constructWebhookEvent` throw `Error` générique → `handle` REJETTE — la promesse est rejetée, pas un `{handled:false}`)
- [ ] **Step 1 (RED)** : les 3 nouveaux vecteurs + test env lookback défaut 3.
- [ ] **Step 2** : FAIL vérifié. **Step 3** : implémenter. **Step 4** : suites ciblées + unit complète + e2e billing-persistence (light) + e2e billing-usage (HEAVY — le comportement du sweep change) → PASS ; tsc + biome ; audit/outdated.
- [ ] **Step 5** : commit `fix(api): lookback du sweep d'usage (J-1..J-N, défaut 3 j — revue finale I2) + minors M1/M5/M10/M13 et commentaire problem.ts`.

### Task 3: gate + doc + merge (contrôleur)

- [ ] README api § billing : une phrase sur le tri-état currentPeriodEnd + le lookback (tableau env). Gate complète monorepo. Merge --no-ff, push.

## Self-Review
1. Couverture : I1 (3 sous-points du finding : écrasement null ✓ tri-état ; champ legacy ✓ fallback items ; same-second ✓ CAS <=) ; I2 ✓ lookback ; M1/M5/M10/M12/M13 ✓ ; commentaire problem.ts ✓. 2. Pas de placeholder. 3. Types cohérents (`currentPeriodEnd?: Date | null` propagé port→drivers→repo).
