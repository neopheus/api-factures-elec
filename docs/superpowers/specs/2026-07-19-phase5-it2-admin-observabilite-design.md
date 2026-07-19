# Design — Phase 5 itération 2 : super admin complet + observabilité durcie + MFA admin

Date : 2026-07-19 · Statut : validé par Xavier (périmètre, stack et MFA choisis par AskUserQuestion, design global approuvé)
Spec produit parente : `2026-07-12-plateforme-agreee-facturation-electronique-design.md` §2 (« un super admin (l'exploitant) supervise l'ensemble de la plateforme ») et feuille de route phase 5.

## Décisions de cadrage (validées)

1. **Super admin** : supervision + actions clés (PAS de backoffice d'édition
   métier, PAS d'impersonation) — vue tenants enrichie, détail, suspension/
   réactivation motivée et journalisée, relance de jobs échoués, vue
   anomalies lecture seule.
2. **Observabilité** : Prometheus (`prom-client`) + healthcheck enrichi +
   corrélation `requestId`/`tenantId` dans les logs pino existants. Ni
   OpenTelemetry ni Sentry (écartés : collecteur à héberger / compte
   externe).
3. **MFA** : TOTP obligatoire pour le super admin + TTL de session admin
   dédié (défaut 2 h) + codes de récupération. Allowlist IP → infra
   (hors code).

## 1. Périmètre

**Inclus** : endpoints admin ci-dessous, migration 0031 (suspension +
colonnes TOTP + journal `admin_actions` + 2 fonctions SD), garde de
suspension sur les 2 mutations d'émission, module metrics + healthcheck
enrichi + corrélation logs, flux TOTP complet (enrôlement forcé, login à
2 facteurs, codes de récupération), pages admin du dashboard (liste
enrichie, détail/suspension, anomalies, écran d'enrôlement TOTP).

**Exclus (itérations futures)** : édition de tenants/users, impersonation,
quotas, allowlist IP applicative, alerting (Prometheus rules = infra),
purge/rétention du journal admin, WebAuthn.

## 2. Modèle de données (migration 0031)

- **`tenants`** : + `suspended_at` (timestamptz, nullable), +
  `suspended_reason` (text, nullable). Suspendu ⇔ `suspended_at IS NOT
  NULL`.
- **`platform_admins`** : + `totp_secret` (text, nullable — base32, posé à
  l'enrôlement ; la table est déjà hors RLS tenant et hors grants app
  larges, vérifier et conserver le moindre privilège existant), +
  `totp_enabled_at` (timestamptz, nullable — null = enrôlement PENDING,
  secret généré mais pas encore confirmé), + `recovery_codes` (jsonb,
  nullable — tableau de hashs argon2id, chaque code à usage unique retiré
  après emploi).
- **`admin_actions`** (journal d'audit des actions opérateur, append-only
  par grants — INSERT+SELECT seulement, pas d'UPDATE/DELETE, motif
  payments 0025) : `id` uuid PK, `admin_id` FK platform_admins,
  `action` text (`suspend_tenant | unsuspend_tenant | retry_jobs`),
  `tenant_id` uuid nullable FK, `detail` jsonb (motif, compteurs…),
  `created_at`.
- **2 fonctions SD** (SECURITY DEFINER, LANGUAGE sql, un seul SELECT,
  colonnes projetées bornées, REVOKE PUBLIC + GRANT EXECUTE factelec_app —
  posture find_billing_* 0030) :
  - `find_admin_tenant_stats()` → TABLE(tenant_id, name, siren, created_at,
    suspended_at, billing_status, invoices_30d bigint, ereporting_30d
    bigint, dead_letters bigint) — agrégat cross-tenant pour la liste
    enrichie (LEFT JOIN tenant_billing + agrégats fenêtre 30 jours).
  - `find_admin_anomalies(p_limit int)` → TABLE(kind text, tenant_id,
    ref_id uuid, detail text, created_at) — UNION bornée (`LIMIT
    p_limit` par branche) : `invoice_dead_letters` récents, transmissions
    CDV `parked`/`rejected` récentes, transmissions e-reporting en échec
    récentes. Lecture seule, jamais de colonne de contenu de facture.

## 3. Endpoints admin (tous `SessionGuard, AdminGuard` + `CsrfGuard` sur les POST)

- `GET /admin/tenants` (remplace l'implémentation actuelle) →
  `find_admin_tenant_stats()`, tri created_at desc. Réponse :
  `{ tenants: [{ id, name, siren, createdAt, suspendedAt, billingStatus,
  invoices30d, ereporting30d, deadLetters }] }`.
- `GET /admin/tenants/:id` → détail : stats de la ligne + lecture
  per-tenant via `tenant.run(tenantId)` (RLS-scopée) : 10 dernières
  factures (id, number, statut, createdAt — PAS de montants), état billing
  du miroir, anomalies du tenant. 404 problem si inconnu.
- `POST /admin/tenants/:id/suspend` body `{ reason: string (1..500) }` →
  pose `suspended_at = now()`, `suspended_reason`, journalise
  (`admin_actions`), idempotent (déjà suspendu → 409 conflict). Réponse
  `{ suspendedAt }`.
- `POST /admin/tenants/:id/unsuspend` → efface les deux colonnes,
  journalise ; non-suspendu → 409.
- `POST /admin/jobs/:queue/retry` → `:queue` dans l'allowlist des
  constantes de `queue.constants.ts` (sinon 404) ; `Queue.getFailed(0,
  limit-1)` puis `job.retry()` un par un ; body `{ limit?: int (1..500,
  défaut 100) }` ; journalise (compte relancé) ; réponse
  `{ retried: number }`.
- `GET /admin/anomalies?limit=` → `find_admin_anomalies` (limit 1..200,
  défaut 50).

## 4. Garde de suspension (`SuspensionGuard`)

- Posé sur les 2 mêmes mutations d'émission que `BillingGuard` (POST
  /invoices, POST /ereporting/retransmissions), APRÈS lui dans la chaîne.
- Lit `tenants.suspended_at` (requête directe indexée par PK — même coût
  que le `getState` billing) ; suspendu → **403** problem type dédié
  `urn:factelec:problem:tenant-suspended` (jamais 402 : la suspension est
  opérateur, pas commerciale). `req.tenantId` absent → throw Error
  (même posture fail-loud que BillingGuard).
- Lectures/exports/transitions JAMAIS bloqués (même philosophie que le
  billing) ; le login des users du tenant suspendu reste possible
  (consultation).

## 5. MFA TOTP super admin

- Lib `otplib` (dernière stable) ; issuer `Factelec`, label = email admin.
- **Login (remplace le flux actuel)** `POST /admin/login` :
  - password invalide → 401 (inchangé, throttle inchangé) ;
  - password OK + TOTP non enrôlé (`totp_enabled_at` null) : si
    `totp_secret` null, le générer et le stocker (PENDING) ; répondre
    `202 { enrollmentRequired: true, otpauthUrl, secret }` — AUCUNE
    session créée ;
  - password OK + enrôlé : exiger `totpCode` (6 chiffres, fenêtre ±1) OU
    `recoveryCode` ; absent/faux → 401 problem `unauthorized` générique
    (pas d'oracle « password OK mais TOTP faux ») ; recovery code valide →
    consommé (retiré du jsonb) ; succès → session admin avec TTL
    **`ADMIN_SESSION_TTL_HOURS`** (défaut 2, env dédiée) au lieu du TTL
    standard.
- `POST /admin/totp/confirm` body `{ email, password, totpCode }` (hors
  session — l'admin n'en a pas encore) : vérifie password + code contre le
  secret PENDING → pose `totp_enabled_at`, génère **10 codes de
  récupération** (affichés UNE fois, stockés hashés argon2id) → répond
  `{ recoveryCodes: [...] }`. Throttle identique au login.
- Le hash argon2id réutilise les primitives auth existantes.
- Verrou dual-auth NON touché (admin = session-only depuis toujours).

## 6. Observabilité

- **Module `metrics`** (`prom-client`, registre dédié) :
  - `GET /metrics` : format Prometheus ; protégé par
    `Authorization: Bearer ${METRICS_TOKEN}` (env, optionnelle : token
    absent de l'env → route répond 404 — opt-in explicite) ; hors
    throttle ; hors auth session.
  - HTTP : histogramme `http_request_duration_seconds` (labels method,
    route normalisée Nest, status) via interceptor global.
  - BullMQ : jauges `bullmq_jobs{queue,state}` collectées AU SCRAPE
    (collect() async → `queue.getJobCounts()` sur les files de
    queue.constants).
  - Billing : compteurs `billing_guard_denials_total`,
    `billing_webhook_events_total{outcome}` incrémentés aux points de code
    existants (guard, webhook service).
  - DB : jauges du pool pg (total/idle/waiting).
- **Healthcheck enrichi** : le endpoint santé existant ajoute
  `{ db: ok/latenceMs, redis: ok/latenceMs, migrations: appliquées ==
  attendues }` — 503 si un composant est down (le détail des versions
  n'est PAS exposé sans auth ; réponse publique = statuts booléens +
  latences seulement).
- **Corrélation logs** : les guards d'auth (session, clé API, admin)
  posent `req.log = req.log.child({ tenantId | adminId })` après
  authentification — chaque ligne de log HTTP aval porte requestId (déjà
  fourni par pino-http `req.id`) + tenantId. Redaction pino existante
  inchangée.

## 7. Dashboard (apps/web — espace admin existant)

- Liste tenants enrichie (colonnes billing/volumes/anomalies, badge
  suspendu) ; page détail tenant avec bouton suspendre/réactiver (motif
  requis, confirmation) ; page anomalies (tableau, lecture seule) ; écran
  de login admin gérant les 3 états (password → TOTP → enrollment : QR
  code otpauth rendu SANS dépendance externe — lib qr locale ou data-URI
  généré côté client, codes de récupération affichés une fois avec
  avertissement).

## 8. Config

| Variable | Défaut | Rôle |
|---|---|---|
| `ADMIN_SESSION_TTL_HOURS` | `2` | TTL session super admin (≤ SESSION_TTL_HOURS) |
| `METRICS_TOKEN` | — (absent = /metrics 404) | Bearer du scrape Prometheus |

## 9. Erreurs & cas limites

- TOTP : fenêtre ±1 pas (30 s) ; rejeu du même code dans la fenêtre
  accepté (pas d'anti-rejeu par jti — surface admin mono-utilisateur,
  throttle 10/15 min en amont) — documenté comme limite.
- Recovery codes épuisés → ré-enrôlement manuel en base (runbook
  documenté) ; pas d'endpoint de régénération (surface minimale).
- `retry_jobs` sur file vide → `{ retried: 0 }` (200) ; job retry qui
  throw → compté non-relancé, continue (isolation), détail journalisé.
- Suspension d'un tenant avec émissions en vol : les jobs déjà en file
  s'exécutent (le garde protège l'ENTRÉE) — documenté.
- `/metrics` sans token configuré → 404 (indiscernable d'une route
  absente) ; token faux → 401 générique.

## 10. Tests (gates inchangées)

- Unit : TOTP (enrôlement/confirm/login/recovery/oracle), guards
  (suspension matrice, metrics token), service admin (journalisation),
  metrics (compteurs/histogrammes via registre).
- E2E light : endpoints admin (auth, CSRF, 404 queue inconnue, suspend →
  403 émission → unsuspend → 201 ; RLS du détail), /metrics (404 sans
  token env, 401 token faux, 200 + format), healthcheck.
- E2E heavy : retry de jobs échoués réels (worker BullMQ, job forcé en
  échec puis relancé) — fichier ajouté à HEAVY_TESTS **même commit**.
- Web : tests composants des nouveaux écrans (RTL, patrons existants).

## 11. Dépendances

`prom-client`, `otplib` (+ éventuel générateur QR local pour le web —
sinon rendu otpauth en texte + data-URI). Dernières stables, épinglées
exactes, audit 0/outdated vierge.
