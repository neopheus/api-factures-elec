# Phase 5 it.2 — Super admin + Observabilité + MFA TOTP : Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Livrer la spec `docs/superpowers/specs/2026-07-19-phase5-it2-admin-observabilite-design.md` : supervision admin (liste enrichie, détail, suspension motivée journalisée, relance de jobs, anomalies), observabilité Prometheus/healthcheck/corrélation logs, MFA TOTP super admin.

**Architecture:** module `admin` étendu (SD cross-tenant + tenant.run pour le détail + journal append-only), `SuspensionGuard` 403 derrière `BillingGuard` sur les 2 mutations d'émission, `TotpService` (otplib) avec enrôlement forcé/recovery codes hashés argon2id, module `metrics` (prom-client, registre dédié, collect au scrape), bindings pino `child({tenantId|adminId})` posés par les guards d'auth.

**Tech Stack:** existante + `prom-client` et `otplib` (dernières stables, épinglées exactes).

## Global Constraints

- TDD strict (RED prouvé), couverture >90 %, audit 0, outdated vierge, Biome, ESM `.js`, commentaires français POURQUOI.
- Verrous : **heavy-suites** (tout nouveau e2e démarrant les workers → `HEAVY_TESTS` MÊME COMMIT) ; **dual-auth-composition** (admin = session-only, AUCUNE mutation dual-auth touchée) ; **apikeyid-setters** (non concerné).
- Migration suivante : **0031**. Branche : `feat/phase5-it2-admin-observabilite` depuis `main`.
- ProblemType nouveau : `tenantSuspended = urn:factelec:problem:tenant-suspended`.
- Sémantiques dures de la spec : suspension = **403** (jamais 402) uniquement sur POST /invoices et POST /ereporting/retransmissions, APRÈS BillingGuard ; `/metrics` sans `METRICS_TOKEN` env → **404** ; token faux → 401 ; login admin sans TOTP valide → **401 générique sans oracle** ; TTL session admin = `ADMIN_SESSION_TTL_HOURS` (défaut 2) ; recovery codes hashés argon2id, usage unique ; healthcheck public = statuts+latences seulement.
- Les endpoints admin (hors login/totp/confirm) : `@UseGuards(SessionGuard, AdminGuard)` + `CsrfGuard` sur les POST — calque `admin.controller.ts` existant.
- Patrons imposés : SD read-only posture 0030 ; journal append-only grants posture 0025 (payments) ; guard fail-loud posture BillingGuard (`req.tenantId` absent → throw) ; factories/env posture existante.

---

### Task 1: Env + dépendances + ProblemType

**Files:** Modify `apps/api/src/config/env.ts`, `apps/api/.env.example`, `apps/api/src/common/problem.ts`, `apps/api/package.json` ; Test : fichier de test d'env existant (`env.test.ts`).
**Interfaces — Produces:** `ADMIN_SESSION_TTL_HOURS: z.coerce.number().int().positive().max(24).default(2)` ; `METRICS_TOKEN: z.string().min(16).optional()` ; `ProblemType.tenantSuspended = 'urn:factelec:problem:tenant-suspended'` ; deps `prom-client` + `otplib` épinglées exactes.
- [ ] RED (env défauts/bornes, min 16 du token, ProblemType exact) → implémenter → GREEN → `pnpm add prom-client otplib --save-exact` (apps/api) → audit/outdated → commit `feat(api): env it.2 (ADMIN_SESSION_TTL_HOURS, METRICS_TOKEN) + ProblemType tenant-suspended + deps prom-client/otplib`.

### Task 2: Migration 0031 + schéma

**Files:** Create `apps/api/src/db/migrations/0031_admin_observability.sql` ; Modify `apps/api/src/db/schema.ts`, `_journal.json` (idx 31, patron 0030 sans snapshot).
**Interfaces — Produces:** colonnes `tenants.suspendedAt/suspendedReason` ; `platformAdmins.totpSecret/totpEnabledAt/recoveryCodes(jsonb)` ; table `adminActions` (id, adminId FK restrict, action text, tenantId FK nullable restrict, detail jsonb, createdAt) ; SD `find_admin_tenant_stats()` et `find_admin_anomalies(p_limit int)` (shapes exacts spec §2, REVOKE PUBLIC + GRANT EXECUTE factelec_app).
Contraintes SQL : `admin_actions` grants INSERT+SELECT à factelec_app SEULEMENT (pas UPDATE/DELETE — append-only posture 0025) ; PAS de RLS tenant sur admin_actions/platform_admins (tables plateforme — vérifier la posture existante de platform_admins et la conserver) ; `find_admin_tenant_stats` : LEFT JOIN tenants↔tenant_billing + sous-requêtes agrégats 30 j (invoices, ereporting_transmissions, invoice_dead_letters) — UN seul SELECT ; `find_admin_anomalies` : UNION ALL bornée LIMIT p_limit par branche (dead letters / cdv parked+rejected / ereporting failed), colonnes (kind, tenant_id, ref_id, detail, created_at), aucune colonne de contenu de facture.
- [ ] Écrire schéma+SQL+journal → `tsc --noEmit` → run d'un e2e existant (applique 0031) → commit `feat(api): migration 0031 — suspension tenants, TOTP admin, journal admin_actions append-only, 2 SD supervision`.

### Task 3: Supervision — liste enrichie + détail tenant

**Files:** Modify `apps/api/src/admin/admin.service.ts`, `admin.controller.ts` ; Create `apps/api/src/admin/admin-supervision.repository.ts` ; Tests unit + `apps/api/tests/e2e/admin-supervision.e2e.test.ts` (light — pas de workers).
**Interfaces — Produces:** `AdminSupervisionRepository.tenantStats(): Promise<AdminTenantStats[]>` (SD 1) ; `tenantDetail(tenantId): Promise<AdminTenantDetail | null>` (stats ligne + via `tenant.run` : 10 dernières factures {id, number, lifecycleStatus, createdAt} SANS montants, état billing miroir) ; routes `GET /admin/tenants` (remplace l'actuelle — préserver le contrat minimal existant en l'enrichissant, adapter ses tests existants) et `GET /admin/tenants/:id` (404 problem si inconnu, garde UUID).
- [ ] RED (unit service + e2e : auth admin requise 401/403, liste enrichie avec un tenant billing `active` seedé, détail RLS-scopé, 404 inconnu) → implémenter → GREEN → commit `feat(api): supervision admin — liste tenants enrichie (SD stats) + détail per-tenant RLS-scopé`.

### Task 4: Suspension + SuspensionGuard

**Files:** Modify `admin.service.ts`, `admin.controller.ts`, `apps/api/src/invoices/invoices.controller.ts` (POST : `ApiKeyGuard, BillingGuard, SuspensionGuard`), `apps/api/src/ereporting/ereporting.controller.ts` (retransmissions : `..., BillingGuard, SuspensionGuard`) ; Create `apps/api/src/admin/suspension.guard.ts`, service/répo de lecture (`tenants.suspended_at` par PK) ; Tests unit (matrice guard) + e2e dans `admin-supervision.e2e.test.ts`.
**Interfaces — Produces:** `POST /admin/tenants/:id/suspend {reason: 1..500}` → `{suspendedAt}` (409 si déjà) ; `unsuspend` (409 si pas suspendu) ; chaque action INSERT `admin_actions` (action, tenantId, detail{reason}) ; `SuspensionGuard implements CanActivate` : suspendu → 403 `problem(403, ProblemType.tenantSuspended, 'Tenant suspended')` ; non suspendu → passe ; `req.tenantId` absent → throw Error fail-loud.
- [ ] RED → implémenter → GREEN (e2e : suspend → POST /invoices clé API = 403 type exact → GET /invoices toujours 200 → unsuspend → 201 ; journal admin_actions vérifié en SQL) → non-régression `billing-guard.e2e` → commit `feat(api): suspension opérateur (403 tenant-suspended sur émission, journal admin_actions, 409 idempotence)`.

### Task 5: Relance de jobs échoués (heavy)

**Files:** Modify `admin.controller.ts`/`admin.service.ts` ; Create `apps/api/tests/e2e/admin-jobs-retry.e2e.test.ts` ; Modify `apps/api/vitest.config.ts` (**HEAVY_TESTS MÊME COMMIT**).
**Interfaces — Produces:** `POST /admin/jobs/:queue/retry {limit?: 1..500 = 100}` → `{retried}` ; allowlist = constantes de `queue.constants.ts` (map nom-public→queue Nest injectée) ; `:queue` inconnu → 404 ; `Queue.getFailed(0, limit-1)` puis `job.retry()` en isolation (un throw → compté non relancé, continue) ; journal `admin_actions` (action retry_jobs, detail{queue, retried, errors}).
- [ ] RED → implémenter → GREEN (heavy e2e : job forcé en échec — patron d'un test heavy existant qui manipule les jobs — puis retry → job repasse et aboutit ; file vide → {retried:0}) → commit `feat(api): relance admin des jobs échoués par file (allowlist, isolation, journalisé, HEAVY_TESTS même commit)`.

### Task 6: Anomalies

**Files:** Modify `admin.controller.ts`/`admin.service.ts`/`admin-supervision.repository.ts` ; e2e dans `admin-supervision.e2e.test.ts`.
**Interfaces — Produces:** `GET /admin/anomalies?limit=1..200=50` → `{anomalies: [{kind, tenantId, refId, detail, createdAt}]}` via SD 2, tri createdAt desc côté SQL.
- [ ] RED → implémenter → GREEN (e2e : seed d'une dead letter + d'une transmission parked → les 2 kinds remontent, borne limit respectée) → commit `feat(api): vue admin anomalies (SD union bornée dead-letters/cdv/ereporting)`.

### Task 7: TotpService + flux login/confirm

**Files:** Create `apps/api/src/admin/totp.service.ts` ; Modify `apps/api/src/admin/admin.service.ts`, `admin.controller.ts` (login remplacé, + `POST /admin/totp/confirm`), `apps/api/src/auth/session.service.ts` UNIQUEMENT si nécessaire pour un TTL par-création (préférer : paramètre optionnel `ttlMs` à `create()` — vérifier la signature réelle et rester minimal) ; Tests unit (TotpService + AdminService) + `apps/api/tests/e2e/admin-totp.e2e.test.ts` (light).
**Interfaces — Produces:** `TotpService.generateSecret(): string` (base32) ; `otpauthUrl(email, secret): string` (issuer Factelec) ; `verify(secret, code): boolean` (fenêtre ±1) ; `generateRecoveryCodes(): {plain: string[], hashed: Promise<string[]>}` (10 codes, format `xxxx-xxxx`, hash argon2id via primitives auth existantes) ; `consumeRecoveryCode(hashed[], plain): Promise<{ok: boolean, remaining: string[]}>`.
Flux (spec §5 verbatim) : login 202 enrollmentRequired (secret PENDING posé, AUCUNE session) ; confirm hors session {email, password, totpCode} → totp_enabled_at + recoveryCodes une-fois ; login enrôlé exige totpCode OU recoveryCode (consommé) → session TTL `ADMIN_SESSION_TTL_HOURS` ; échec TOTP → 401 générique identique au mauvais password (anti-oracle : MÊME corps problem — asserté byte-à-byte en test) ; throttle login inchangé, confirm throttlé pareil.
- [ ] RED (unit : verify fenêtre, recovery consommé une fois, anti-oracle ; e2e : cycle complet 202→confirm→login TOTP→session 2 h (asserte l'expiration via la table sessions), login recovery → code consommé, rejeu → 401) → implémenter (otplib : `authenticator` avec `window: 1`) → GREEN → commit `feat(api): MFA TOTP super admin (enrôlement forcé, anti-oracle, recovery codes argon2id usage unique, TTL session dédié)`.

### Task 8: Module metrics (/metrics + histogramme HTTP + jauges pg)

**Files:** Create `apps/api/src/metrics/metrics.module.ts`, `metrics.controller.ts`, `metrics.service.ts`, `http-metrics.interceptor.ts` ; Modify `app.module.ts` (module + interceptor global `APP_INTERCEPTOR`) ; Tests unit + e2e light `apps/api/tests/e2e/metrics.e2e.test.ts`.
**Interfaces — Produces:** `MetricsService` (registre `prom-client` DÉDIÉ — pas le global, hygiène des tests) exposant `httpDuration: Histogram{method,route,status}`, `render(): Promise<string>`, `registerCollector(fn)` (collecte au scrape) ; `GET /metrics` : env token absent → 404 problem notFound (indiscernable) ; `Authorization: Bearer <token>` exact → 200 text/plain format Prometheus ; sinon 401 ; `@SkipThrottle()` ; AUCUN guard session. Interceptor : route normalisée Nest (`context.getHandler()`/route path — jamais l'URL brute, cardinalité bornée), durée en secondes.
- [ ] RED → implémenter → GREEN (e2e : 404 sans env, 401 token faux, 200 contient `http_request_duration_seconds` après un appel API ; unit interceptor : labels normalisés) → commit `feat(api): module metrics Prometheus (/metrics Bearer opt-in 404, histogramme HTTP routes normalisées, registre dédié)`.

### Task 9: Metrics BullMQ + billing + healthcheck enrichi + corrélation logs

**Files:** Modify `metrics.service.ts` (collector files : `getJobCounts()` par file de queue.constants au scrape ; jauges `bullmq_jobs{queue,state}`), `apps/api/src/billing/billing.guard.ts` (+compteur denials), `billing-webhook.service.ts` (+compteur events{outcome}), module health existant (DB ping + Redis ping + migrations count, 503 si down, réponse publique bornée), guards d'auth (`session.guard.ts`, `api-key.guard.ts`, `admin.guard.ts`) : `req.log = req.log.child({tenantId|adminId})` post-auth (garde défensive si req.log absent) ; Tests unit + extension `metrics.e2e.test.ts` (light : jauges bullmq via Redis réel ? — si le fichier doit démarrer les workers → le passer en HEAVY_TESTS même commit ; sinon collecter sur files vides connectées Redis sans workers, rester light — TRANCHER à l'implémentation et le documenter).
- [ ] RED → implémenter → GREEN → non-régression billing (unit guard/webhook) → commit `feat(api): jauges BullMQ + compteurs billing au scrape, healthcheck enrichi 503, corrélation tenantId/adminId dans les logs pino`.

### Task 10: Web — login admin 3 états + enrôlement TOTP

**Files:** Modify l'écran de login admin existant d'apps/web (chercher `admin` dans `apps/web/src`) ou Create s'il n'existe pas (`app/(admin)/...` — suivre la structure existante) ; composant `admin-totp-enrollment.tsx` (QR : rendu otpauth en `<img src=data:>` généré par une lib QR locale légère épinglée OU affichage secret+URL en texte si aucune lib retenue — préférer le texte pur, zéro dépendance, YAGNI) ; Tests RTL.
**Interfaces — Consumes:** contrats Task 7 (202 enrollmentRequired{otpauthUrl,secret}, confirm{recoveryCodes}, login{totpCode|recoveryCode}).
- [ ] RED → implémenter (3 états : password → champ TOTP ; 202 → écran enrôlement secret/otpauth + champ code + affichage UNE FOIS des recovery codes avec avertissement) → GREEN (suite web complète) → commit `feat(web): login admin MFA TOTP (enrôlement forcé, codes de récupération affichés une fois)`.

### Task 11: Web — pages supervision (tenants enrichis, détail/suspension, anomalies)

**Files:** Create/Modify pages+composants admin apps/web (liste avec badges billing/suspendu, détail avec suspend/unsuspend + motif + confirmation, anomalies tableau) ; `lib` client (fonctions des endpoints Task 3/4/6, style existant) ; Tests RTL.
- [ ] RED → implémenter → GREEN (suite web) → commit `feat(web): supervision admin (tenants enrichis, suspension motivée, anomalies)`.

### Task 12: Doc + bump 0.15.0 + gate finale

**Files:** `apps/api/README.md` (§ Super admin réécrit : supervision/suspension/jobs/anomalies/MFA/metrics/healthcheck — chaque claim vérifié contre le code ; dette « durcissement session super admin » soldée pour TOTP+TTL, allowlist IP restant infra), `README.md` racine (phase 5 it.2 livrée ; dette MFA admin résolue), `apps/api/package.json` 0.15.0.
- [ ] Rédiger → gate complète monorepo (`pnpm -r test`, audit, outdated, tsc, biome) → commit `docs(api): phase 5 it.2 (supervision, MFA TOTP, observabilité) + bump 0.15.0` → PAS de merge (revue finale de branche d'abord).

## Self-Review
1. Couverture spec : §2→T2 ; §3→T3/T4/T5/T6 ; §4→T4 ; §5→T7(+T10) ; §6→T8/T9 ; §7→T10/T11 ; §8→T1 ; §9 cas limites→dans les tasks concernées (anti-oracle T7, isolation retry T5, 404 metrics T8, émissions en vol T4 doc) ; §10 tests→chaque task ; §11 deps→T1. 2. Placeholders : les deux points « TRANCHER à l'implémentation » (light-vs-heavy metrics T9, QR-vs-texte T10) sont des décisions bornées avec préférence énoncée, pas des TBD. 3. Types cohérents : contrats nommés dans chaque bloc Produces/Consumes.
