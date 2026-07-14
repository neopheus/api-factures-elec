# Plan 1.4 — Dashboard marchand & provisioning self-service

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Livrer l'**authentification humaine** du SaaS et son **dashboard** : côté `apps/api`, des **comptes utilisateurs** (distincts des clés API machine) par **sessions serveur opaques** (cookie httpOnly + CSRF), un **signup self-service** transactionnel (compte + tenant), la **gestion des clés API par l'API** (création affichée une fois, listage des préfixes, révocation) et une **vue super admin minimale** ; côté nouveau workspace `apps/web`, un **dashboard Next.js 16 (App Router, TypeScript strict, ESM)** : login/signup, liste des factures (pagination keyset), détail + téléchargement des formats, gestion des clés API, liste des tenants (super admin) — le tout couvert par des tests (Vitest + Testing Library côté web ; e2e Postgres réel côté API), gates bloquantes maintenues.

**Architecture:** On **réutilise intégralement** le socle 1.3 (RLS Postgres `FORCE`, `runInTenant` + `SET LOCAL app.tenant_id`, rôles `factelec_app`/`factelec_owner`, fonctions `SECURITY DEFINER`, Argon2id, filtre `problem+json`). L'**identité humaine** est un second plan d'authentification à côté des clés API : un utilisateur s'authentifie par **mot de passe (Argon2id)**, reçoit une **session serveur opaque** (jeton aléatoire 256 bits, seul son **hash SHA-256** est stocké) matérialisée par un **cookie httpOnly + Secure + SameSite=Lax** ; la protection **CSRF** est un **jeton synchroniseur lié à la session** (en-tête `X-CSRF-Token` vérifié contre le hash stocké). Login et session sont résolus par des fonctions `SECURITY DEFINER` (même schéma que `authenticate_api_key` : lecture minimale avant que le tenant soit connu), puis toute la logique métier tourne sous `factelec_app` dans le **contexte tenant** de l'utilisateur via `runInTenant`. Le **signup** (création tenant + owner atomique) passe par une fonction `SECURITY DEFINER` `signup_tenant(...)` : le process API ne détient **jamais** l'URL du rôle owner (moindre privilège 1.3 inchangé). Le **dashboard** est une SPA Next.js authentifiée qui parle directement à l'API (`credentials: 'include'`, CORS en allowlist, en-tête CSRF) et n'affiche **jamais** un secret de clé après sa création.

**Tech Stack:** Ajouts côté API : `cookie-parser` (lecture des cookies Express) + primitives `node:crypto` (jetons opaques, comparaison à temps constant) — aucune bibliothèque d'auth tierce. Nouveau `apps/web` : **Next.js 16** (App Router, ESM), **React 19**, **TypeScript 7.0.2** (repli local documenté si nécessaire), lint **Biome** (déjà au dépôt, pas d'ESLint Next), tests **Vitest 4** + **@testing-library/react** + **jsdom** (transform TSX par esbuild natif de Vitest, sans `@vitejs/plugin-react`).

## Global Constraints

Reprises **verbatim** du socle 1.3 (non négociables) — chaque tâche en hérite implicitement :

- **TDD strict RED/GREEN** : test écrit et vu échouer avant toute implémentation ; aucun merge si un test échoue (spec §7). Un commit minimum par tâche, message en **français**, **sans** trailer `Co-Authored-By: Claude` ni mention Claude. `pnpm format` avant chaque commit.
- **Couverture bloquante** : **≥ 90 %** (lines/functions/statements/branches) maintenue sur `apps/api` ; `packages/invoice-core` reste à **100 %** (ne pas y toucher). `apps/web` : seuil **instruit et justifié** ci-dessous (Décisions §D5) — écart à faire valider par Xavier.
- **e2e sur Postgres réel (Testcontainers)** pour tout nouvel endpoint API ; **tests d'isolation multi-tenant explicites** (un utilisateur/tenant ne voit jamais les données d'un autre).
- **Sécurité OWASP** : validation de toute entrée (zod), authz systématique. **Sessions cookie httpOnly + Secure + SameSite + CSRF** ; **aucun secret côté client** ; le dashboard **ne voit jamais** le secret d'une clé API après sa création (affiché une seule fois par l'API). **Aucune donnée sensible dans les logs** (redaction). **Aucune fuite d'erreur interne** : réponses d'erreur normalisées **RFC 9457 `application/problem+json`** (anti-fuite conservé).
- **Moindre privilège Postgres inchangé** : rôle applicatif `factelec_app` ≠ propriétaire, **sans `BYPASSRLS`, sans superuser** ; RLS **`ENABLE` + `FORCE`** sur toute table tenant ; propagation du tenant par `SET LOCAL` transactionnel. Le process API ne connaît **que** `DATABASE_URL` (rôle app) — **jamais** `DATABASE_OWNER_URL`.
- **TypeScript `strict: true`, ESM (`"type": "module"`), NodeNext, Node ≥ 22.** `typescript` pinné **exactement `7.0.2`** (racine). **Repli local documenté** autorisé si un workspace bute au typecheck (comme le prévoyait 1.3 pour apps/api) : pin `typescript@5.9.x` **local au seul workspace concerné**, sans toucher le pin racine.
- **Dépendances pinnées exactement** (pas de `^`/`~`), **dernière stable** vérifiée au registre, avec licence. **`pnpm audit` 0 vulnérabilité** et **`pnpm outdated -r` vierge** restent **bloquants** en CI (politique transitive détaillée en Décisions §D7).
- **`@factelec/invoice-core` consommé via son exports map**, jamais par chemin relatif inter-packages. `docs/reference/` et `docs/reglementaire/` en **lecture seule**.
- Identifiants de code en **anglais**.

---

## Décisions structurantes (à lire avant d'exécuter)

### D1 — Auth utilisateur : sessions serveur opaques (cookie httpOnly) + CSRF, **artisanales**, PAS de JWT ni de lib tierce

**Retenu : sessions serveur opaques + Argon2id, implémentation maison (~150 lignes) réutilisant le socle 1.3.**

- **Sessions vs JWT.** Une **plateforme agréée** (audit d'immatriculation, RGPD, révocation immédiate exigée) a besoin de **révoquer** une session instantanément (déconnexion, compromission, changement de rôle). Un JWT est révoquable seulement via une denylist serveur — ce qui annule son unique avantage (l'apatridie) tout en gardant ses défauts (fuite = valide jusqu'à expiration, rotation de clé lourde). **Session serveur opaque retenue** : jeton aléatoire **256 bits** (CSPRNG `node:crypto`), **seul le hash SHA-256** est stocké (une fuite de la base ne donne pas de jeton utilisable), révocation = `DELETE` d'une ligne.
- **Artisanal vs lib.** On dispose **déjà** d'Argon2id (`@node-rs/argon2`), de Postgres/RLS, de `runInTenant`, et du **motif `SECURITY DEFINER`** pour lire une ligne d'auth avant de connaître le tenant (`authenticate_api_key`). Une session opaque = table + un lookup `SECURITY DEFINER` + génération/hash de jeton : entièrement **auditable** pour le dossier DGFiP, **zéro dépendance d'auth**. Les libs (Lucia — **sunset** par son auteur, devenu ressource pédagogique ; `iron-session` — cookie chiffré **sans** révocation serveur ; Auth.js/`better-auth` — schéma/adaptateurs opinionnés qui **entrent en conflit** avec notre RLS/Drizzle/provisioning owner et gonflent la surface transitive, cf. contrainte « audit tenable ») sont **écartées**.
- **Mot de passe** : Argon2id (mêmes paramètres que les secrets de clés API 1.3). Politique minimale (longueur ≥ 12, zod) ; vérification email **différée** (cf. D3).
- **CSRF** : **double-submit lié à la session**. Au login/signup, l'API pose **deux** cookies : `factelec_session` (httpOnly, la session) et `factelec_csrf` (**lisible** par JS, valeur haute entropie) ; seul le **hash** du jeton CSRF est stocké côté session. Le client lit `factelec_csrf` (résilient au rechargement de page, contrairement à un jeton en mémoire) et l'envoie en en-tête **`X-CSRF-Token`** sur toute mutation ; un `CsrfGuard` compare `hash(header)` au hash stocké. Le cookie CSRF **ne donne aucun accès seul** (l'accès vient du cookie httpOnly) : le lire ne sert qu'à prouver une origine same-site. Combiné à **SameSite=Lax** + CORS allowlist.
- **Cookie** : `httpOnly`, `Secure` (prod), `SameSite=Lax`, `Path=/`, `Domain` optionnel (`SESSION_COOKIE_DOMAIN`, non posé en dev → host-only ; en prod `.factelec.fr` pour partager entre `dashboard.` et `api.`). Expiration **absolue seule en 1.4** (`SESSION_TTL`, défaut 12 h) — l'expiration glissante bornée est **différée** (arbitrage contrôleur : plus simple et plus sûre pour l'MVP ; à acter au point de reprise).

### D2 — Modèle user↔tenant : utilisateurs **tenant-scopés**, email **globalement unique**, appartenance mono-tenant en 1.4

- **Retenu** : chaque `users.tenant_id` référence **un** tenant (aligné spec §4.1 « Organization → Users »), avec un **index unique global sur `lower(email)`** (le login se fait par email seul, sans connaître le tenant a priori → unicité globale nécessaire). La table `users` est **tenant-scopée** (RLS `FORCE` par `app.tenant_id`, comme `invoices`) ; le **bootstrap de login** (lecture par email avant contexte tenant) passe par `authenticate_user(email)` **`SECURITY DEFINER`** — strict miroir de `authenticate_api_key`.
- **Un user appartient-il à plusieurs tenants ?** **Non en 1.4** (tranché). L'appartenance multi-tenant (un humain gérant plusieurs marchands via une table `memberships` M:N + sélecteur d'organisation) est un besoin réel mais **différé** (YAGNI pour l'MVP dashboard, simplicité RLS pour un dev solo). Documenté au point de reprise ; le schéma reste extensible (on pourra promouvoir `users.tenant_id` en table `memberships` sans casser l'auth, qui passe déjà par `SECURITY DEFINER`).
- **Rôles** : enum `owner | admin | accountant | viewer` (spec §4.1). Seul **`owner`** est créé au signup ; l'**invitation de membres est différée** (cf. D3). Les rôles sont **déjà appliqués** en 1.4 sur la gestion des clés API (owner/admin uniquement) — la mécanique de rôle est donc livrée, pas seulement déclarée.
- **Super admin** = plan **séparé et global** (`platform_admins`, hors tenant), cf. D4. Ce n'est **pas** un rôle d'un tenant.

### D3 — Signup self-service : transactionnel via `SECURITY DEFINER`, anti-abus ; vérification email & invitations **différées**

- **Création atomique compte + tenant** : le signup est un endpoint **public** tournant sous `factelec_app` (qui n'a **pas** le droit d'insérer des tenants arbitrairement — invariant 1.3). Résolution : fonction **`signup_tenant(p_email, p_password_hash, p_tenant_name, p_siren)` `SECURITY DEFINER`** (propriété `factelec_owner`, `EXECUTE` accordé à `factelec_app`) qui, **atomiquement**, crée le tenant + l'utilisateur `owner`, en faisant respecter l'unicité d'email (conflit → `409`). Aucune URL owner exposée au runtime.
- **Anti-abus** : rate limit **dédié et strict** sur `/auth/signup` et `/auth/login` (`@Throttle` par IP, plus serré que le défaut global) ; réponses génériques (pas d'oracle « email déjà pris » exploitable au-delà du 409 nécessaire au self-service — on renvoie 409 sans détail de compte).
- **Vérification email : différée** (tranché sur le coût). Aucun fournisseur d'email transactionnel n'est encore provisionné (Scaleway/SES = phase infra ultérieure). Colonne `email_verified boolean default false` **présente** (schéma prêt) mais **non contraignante** en 1.4 : le compte est actif immédiatement. À activer quand l'email transactionnel arrivera (noté au reprise). Le rate limit strict compense l'absence de vérification pour l'MVP.
- **Invitation de membres : différée** (l'appartenance mono-tenant D2 la rend hors périmètre) — reportée avec `memberships`.

### D4 — Super admin : minimal (login + liste des tenants), plan global, reste **différé en phase 5**

- **Inclus en 1.4** (exigence d'origine de Xavier, coût faible) : table **globale** `platform_admins` (email + Argon2id), auth par `authenticate_platform_admin(email)` `SECURITY DEFINER`, **session réutilisant la table `sessions`** (colonnes `user_id`/`admin_id` mutuellement exclusives, `tenant_id` nul pour un admin), un `SuperAdminGuard`, et **`GET /admin/tenants`** (liste de tous les tenants via `list_tenants_for_admin()` `SECURITY DEFINER` — `factelec_app` ne lit **jamais** les tenants cross-RLS directement). Le **premier** super admin est provisionné par un **script CLI** (connexion `factelec_owner`, hors chemin de requête), comme le provisioning de tenant 1.3.
- **Différé en phase 5** (spec §8 « super admin complet ») : **impersonation tracée**, feature flags, **MFA TOTP + allowlist IP** (spec §6), supervision des files/transmissions, santé plateforme. Acté au reprise.

### D5 — Stack web & stratégie de tests ; seuil de couverture `apps/web` = **90 % (ruling contrôleur)**

- **Next.js 16 App Router**, **SPA authentifiée** : le dashboard est derrière login (SEO/SSR non critiques) → **composants clients** + **client fetch typé** (`lib/api.ts`, `credentials: 'include'`, en-tête CSRF, parsing `problem+json`). Le rendu serveur avec transfert de cookie (RSC) est une **optimisation ultérieure**, pas requise en 1.4. Justification : surface minimale, entièrement testable avec Testing Library + `fetch` mocké, aucune fuite de secret côté serveur Next.
- **Tests** : **Vitest 4 + @testing-library/react + jsdom** (transform TSX par l'esbuild natif de Vitest, **sans** `@vitejs/plugin-react` → moins de transitives) ; l'API est **mockée** (`vi.stubGlobal('fetch', …)`, **pas de MSW** → moins de dépendances). La correction backend est déjà garantie par les **e2e Testcontainers** de l'API.
- **Playwright (e2e navigateur réel) : différé** (tranché sur le coût CI). Un e2e complet exige API + Postgres + web orchestrés → coût et fragilité incompatibles avec la CI d'un dev solo à ce stade. Proposé pour le **durcissement phase 5**. Documenté comme écart.
- **Seuil de couverture `apps/web` = 90 % sur les 4 métriques (lines/functions/statements/branches)** — ruling contrôleur, aligné sur le standard du dépôt. **Exclusions bornées et explicites** : `src/app/**` (coques de page/layouts/loading/error sans logique), `next.config.*`, `**/*.d.ts`, `src/lib/api-types.ts` (types purs). Tout le reste — `src/lib/**` (client API, session, schémas), hooks, composants porteurs de logique — est couvert à 90, branches comprises (tests de branches dédiés : CSRF absent, réponses non-JSON, erreurs non-ApiError, chemins catch). Si une impossibilité réelle apparaît à l'exécution, la prouver et remonter au contrôleur — ne jamais abaisser le seuil unilatéralement.

### D6 — tsgo 7.0.2 vs Next 16 : verdict anticipé + repli documenté

- En 1.3, **tsgo 7.0.2 type-check nativement** un codebase NestJS (décorateurs, preuve par injection d'erreur). Pour le web, le point dur est différent : **types JSX React 19** + **types générés par Next** (`next-env.d.ts`, `.next/types/**` — types de routes/`PageProps`) et `moduleResolution: bundler`.
- **Décision** : le **typecheck** du workspace reste `tsc --noEmit` (tsgo 7.0.2) sur `src/**` + `next-env.d.ts`, **en excluant `.next/`** (types de routes générés, disponibles seulement après un build). L'autorité de typage des routes Next reste **`next build`** (son propre plugin TS) exécuté en CI. **Anticipation honnête** : tsgo 7.0.2 étant un portage encore jeune, un **repli local `typescript@5.9.x` pour `apps/web` uniquement** est **probable** sur les types JSX/React 19 — appliqué et documenté si le premier `pnpm --filter @factelec/web typecheck` échoue (même politique que le repli prévu en 1.3), sans toucher le pin racine 7.0.2. **⚠ À trancher empiriquement à la Task 7.**

### D7 — Politique dépendances : audit 0 & outdated vierge tenables malgré l'écosystème Next

- Next 16 tire de nombreuses transitives. Marche à suivre si une **vulnérabilité transitive** apparaît en CI : **(1)** si un correctif existe → `pnpm.overrides` forçant la version patchée (motif déjà employé en 1.3 pour `esbuild`) ; **(2)** si **aucun** correctif → **ne pas** contourner silencieusement : documenter la CVE, l'exposition réelle (chemin exploitable ou non), et **soumettre à Xavier** la décision (attente d'un patch amont vs override provisoire vs retrait de la dépendance) — jamais de merge avec une vulnérabilité exploitable connue. **(3)** `pnpm outdated -r` vierge : chaque paquet ajouté est pinné à la dernière stable ce jour (table ci-dessous) ; toute dérive en CI est corrigée avant merge.

---

## Versions & dépendances à pinner (registre npm vérifié le 2026-07-13)

> Versions relevées via `npm view <pkg> version|license` le 2026-07-13. Toutes pinnées **exactes**. ⚠ = revérifier au moment du `pnpm add` (cadence rapide).

**Ajouts `apps/api` — `dependencies`**

| Paquet | Version | Licence | Rôle |
|---|---|---|---|
| `cookie-parser` | `1.4.7` | MIT | Lecture des cookies sur la requête Express (`req.cookies`) pour le cookie de session. |

**Ajouts `apps/api` — `devDependencies`**

| Paquet | Version | Licence | Rôle |
|---|---|---|---|
| `@types/cookie-parser` | `1.4.10` | MIT | Types de `cookie-parser`. |

> Aucune autre dépendance API : jetons de session/CSRF via `node:crypto` (CSPRNG, SHA-256, `timingSafeEqual`) ; mot de passe via `@node-rs/argon2` (déjà présent).

**Nouveau workspace `apps/web` — `dependencies`**

| Paquet | Version | Licence | Rôle |
|---|---|---|---|
| `next` | `16.2.10` | MIT | Framework dashboard (App Router, ESM). Node ≥ 20.9 (OK, on est ≥ 22). |
| `react` | `19.2.7` | MIT | UI. Peer de Next 16 (`^19`). |
| `react-dom` | `19.2.7` | MIT | Rendu DOM. |
| `zod` | `4.4.3` | MIT | Validation des formulaires côté client (aligné sur le reste du dépôt). |

**Nouveau workspace `apps/web` — `devDependencies`**

| Paquet | Version | Licence | Rôle |
|---|---|---|---|
| `@types/react` | `19.2.17` | MIT | Types React 19. |
| `@types/react-dom` | `19.2.3` | MIT | Types react-dom 19. |
| `vitest` | `4.1.10` | MIT | Runner de tests (aligné sur apps/api). |
| `@vitest/coverage-v8` | `4.1.10` | MIT | Couverture v8 (seuils D5). |
| `jsdom` | `29.1.1` | MIT | Environnement DOM pour les tests de composants. |
| `@testing-library/react` | `16.3.2` | MIT | Rendu/asserts de composants React (peer `@testing-library/dom` ^10, react ^19). |
| `@testing-library/dom` | `10.4.1` | MIT | Cœur DOM Testing Library (peer explicite). |
| `@testing-library/jest-dom` | `6.9.1` | MIT | Matchers DOM (`toBeInTheDocument`, …) pour Vitest `expect`. |
| `@testing-library/user-event` | `14.6.1` | MIT | Simulation d'interactions utilisateur. |

> **`@vitejs/plugin-react` volontairement absent** (cf. D5) : Vitest transforme le TSX via son esbuild interne (`jsx: 'automatic'`), suffisant pour Testing Library ; on évite le peer `vite@8` + `babel-plugin-react-compiler`. **`vite` non déclaré** (fourni transitivement par Vitest ; non listé → hors `outdated`). **`@playwright/test` (`1.61.1`, Apache-2.0) NON ajouté** en 1.4 (Playwright différé, D5). `next` **n'a pas besoin d'ESLint** : lint par Biome (racine). `typescript 7.0.2` et `@types/node 26.1.1` viennent de la racine (repli local 5.9.x possible pour apps/web, D6).

---

## Points de risque signalés d'emblée

1. **Signup sous `factelec_app` sans droit d'insérer un tenant (invariant 1.3).** Le self-service doit créer un tenant, or `factelec_app` ne le peut pas (provisioning = owner en 1.3). **Résolu** par `signup_tenant(...)` `SECURITY DEFINER` (propriété owner, `EXECUTE` à app) : création atomique tenant+owner, invariants (unicité email) dans la fonction. Aucune URL owner au runtime. **Miroir exact** du motif `authenticate_api_key`.
2. **Poule/œuf de la session (comme l'auth clé API).** Le cookie de session doit être résolu **avant** que le tenant soit connu, mais `sessions`/`users` sont sous RLS. **Résolu** par `find_session(token_hash)` et `authenticate_user(email)` `SECURITY DEFINER` renvoyant la ligne minimale (user_id, tenant_id, role, hash CSRF, expiration) ; le reste tourne ensuite en RLS sous `factelec_app` via `runInTenant`.
3. **CSRF avec cookie de session.** Cookie → vulnérable CSRF. **Résolu** par **double-submit lié à la session** : cookie `factelec_csrf` **lisible** (double du hash stocké côté session), renvoyé en `X-CSRF-Token` et vérifié par le `CsrfGuard` + `SameSite=Lax` + CORS allowlist. Le cookie CSRF n'ouvre aucun accès seul (l'accès vient du cookie httpOnly `factelec_session`).
4. **Cross-origin dashboard↔API en prod.** Sous-domaines `dashboard.` / `api.` = **same-site** (domaine enregistrable partagé) → `SameSite=Lax` fonctionne ; cookie `Domain=.factelec.fr` (`SESSION_COOKIE_DOMAIN`). En dev, `localhost:PORT_A`↔`localhost:PORT_B` = same-site (host `localhost`) → OK. CORS `credentials: true` + allowlist stricte (origine dashboard), à ajouter à la config CORS 1.3.
5. **tsgo 7.0.2 vs types Next/React 19 (D6).** Repli local `typescript@5.9.x` pour apps/web **probable** ; à trancher au premier typecheck web. `.next/types` exclus du typecheck rapide ; `next build` fait autorité en CI.
6. **`pnpm audit`/`outdated` sous Next (D7).** Surface transitive large ; politique override→attente→arbitrage Xavier documentée ; jamais de merge avec vuln exploitable.
7. **Réutilisation de la table `sessions` pour user ET admin.** Colonnes `user_id`/`admin_id` **mutuellement exclusives** (`CHECK ((user_id IS NULL) <> (admin_id IS NULL))`), `tenant_id` nul pour un admin. Le `SessionGuard` branche selon le scope. Compromis assumé (une table, un lookup) vs deux mécaniques parallèles.
8. **Dette 1.3 `createDb` (piège latent hors-tenant).** `createDb(pool)` exporté = accès DB **hors** contexte tenant (fail-closed mais dangereux). Soldé en Task 1 (dé-export ou `@internal` + garde).

---

## Structure des fichiers (vue d'ensemble)

Ajouts/modifs `apps/api/` :

```
apps/api/
  src/
    config/env.ts                     # + clés session/CSRF/CORS credentials ; z.string().url()→z.url() (dette 1.3)
    db/
      schema.ts                       # + users, sessions, platformAdmins (+ enums userRole)
      migrations/
        0002_users_sessions_admins.sql# tables, RLS FORCE, policies, GRANTs, fonctions SECURITY DEFINER
        meta/_journal.json            # maj drizzle-kit
      client.ts                       # createDb : dé-exporté/@internal (dette 1.3)
    auth/
      auth.types.ts                   # UserRole, AuthenticatedUser/Admin, SessionRequest (+ apiKeyId? en Task 7)
      password.ts                     # hashPassword/verifyPassword (argon2id) + passwordSchema (zod)
      session-token.ts                # generate/hash jeton opaque + CSRF ; cookie/header constants ; safeEqualHex
      cookie.ts                       # sessionCookieOptions (httpOnly) / csrfCookieOptions (lisible)
      session.service.ts              # create/find/revoke (fonctions SD + jetons)
      session.guard.ts                # SessionGuard (cookie → user|admin + contexte tenant)
      csrf.guard.ts                   # CsrfGuard (X-CSRF-Token vs hash session)
      roles.guard.ts                  # RolesGuard + @Roles() (owner/admin/…)
      tenant-auth.guard.ts            # dual-auth lecture factures : clé API OU session (Task 7)
      current-user.decorator.ts       # @CurrentUser(): AuthenticatedUser
    common/validation.ts              # parseBody(schema, body) → 422 problem+json
    users/
      users.service.ts                # signup (signup_tenant SD), login, me
      users.controller.ts             # POST /auth/signup|login|logout, GET /auth/me
      users.module.ts
    api-keys/                         # gestion des clés PAR l'utilisateur (distinct de src/auth machine)
      api-keys.service.ts             # create (secret 1×), list (préfixes), revoke
      api-keys.controller.ts          # POST /api-keys, GET /api-keys, DELETE /api-keys/:id
      api-keys.module.ts
    admin/
      admin.service.ts                # login admin, listTenants (list_tenants_for_admin SD)
      admin.controller.ts             # POST /admin/login|logout, GET /admin/tenants
      admin.guard.ts                  # SuperAdminGuard
      admin.module.ts
    main.ts                           # + cookie-parser, CORS credentials
    app.module.ts                     # + UsersModule, ApiKeysModule, AdminModule
  scripts/provision-admin.ts          # provisioning du 1er super admin (rôle owner)
  tests/
    unit/password.test.ts, session-token.test.ts
    e2e/
      helpers/postgres.ts             # + seed users/admins helpers
      helpers/app.ts                  # + helper de session (signup/login → cookie+csrf)
      users-auth.e2e.test.ts          # signup/login/logout/me, CSRF, rate limit
      users-rls.e2e.test.ts           # isolation users/sessions niveau DB
      api-keys.e2e.test.ts            # create/list/revoke, rôles, cross-tenant
      admin.e2e.test.ts               # login admin, liste tenants, cloisonnement
```

Nouveau workspace `apps/web/` :

```
apps/web/
  package.json                        # @factelec/web, Next 16, scripts build/dev/lint/typecheck/test
  next.config.ts                      # ESM, strict
  tsconfig.json                       # extends base + jsx react-jsx + repli 5.9.x possible (D6)
  vitest.config.ts                    # jsdom, esbuild jsx automatic, coverage D5
  tests/setup.ts                      # @testing-library/jest-dom
  next-env.d.ts                       # généré Next
  src/
    lib/
      api.ts                          # apiFetch + ApiError (credentials, CSRF, problem+json)
      api-types.ts                    # types partagés (Invoice list, ApiKey, Tenant…)
      client.ts                       # wrappers typés authApi/invoicesApi/apiKeysApi/adminApi
      session-context.tsx             # SessionProvider + useSession
      forms.ts                        # schémas zod login/signup/create-key
    app/
      layout.tsx                      # racine (SessionProvider)
      globals.css
      (auth)/login/page.tsx , (auth)/signup/page.tsx
      (app)/layout.tsx                # RequireAuth + nav
      (app)/invoices/page.tsx         # liste (pagination keyset)
      (app)/invoices/[id]/page.tsx    # détail + téléchargement formats
      (app)/api-keys/page.tsx         # gestion des clés
      (admin)/tenants/page.tsx        # super admin (liste tenants)
    components/                       # login-form, signup-form, require-auth, invoices-table,
                                      # invoice-detail, api-keys-manager, tenants-table
  tests/{lib,components}/*.test.{ts,tsx}
```

Fichiers hors workspaces :
- `.github/workflows/ci.yml` — étapes web (build Next, typecheck, test+coverage) ; audit/outdated déjà bloquants (§D7).
- `README.md` racine + `apps/api/README.md` + nouveau `apps/web/README.md` (Task 9).
- `pnpm-lock.yaml` — nouvelles deps.

---
### Task 1 : Dettes 1.3 — `createDb` (piège hors-tenant) retiré + `z.string().url()` → `z.url()`

**Files:**
- Modify: `apps/api/src/db/client.ts` (retrait de `createDb`)
- Modify: `apps/api/tests/unit/client.test.ts` (retrait du cas `createDb`)
- Modify: `apps/api/src/config/env.ts` (`z.string().url()` → `z.url()`)

**Interfaces:**
- Consumes: rien.
- Produces: `client.ts` n'exporte plus `createDb` (seuls `APP_POOL`, `createPool`, `type Db` restent). `runInTenant` crée déjà son `drizzle(client, { schema })` en interne — aucun appelant de production n'est touché. `env.ts` : schéma inchangé fonctionnellement (`DATABASE_URL` reste une URL valide requise).

> **Portée** : uniquement deux dettes 1.3 (`createDb` foot-gun hors-tenant ; forme dépréciée `z.string().url()` en zod 4). Refactor/hygiène garanti par la suite existante — pas de nouveau comportement.

- [ ] **Step 1 : Baseline verte + preuve que `createDb` est mort dans `src/`**

```bash
grep -rn "createDb" apps/api/src            # attendu : uniquement la définition dans client.ts
pnpm --filter @factelec/api test
```
Expected: PASS (suite 1.3 verte). `createDb` n'apparaît que dans `client.ts` (définition) et `tests/unit/client.test.ts` (son test) — jamais dans le chemin de production.

- [ ] **Step 2 : Retirer `createDb` et son test**

Dans `apps/api/src/db/client.ts`, supprimer la fonction exportée `createDb` (garder `APP_POOL`, `createPool`, `type Db`, et l'import `drizzle` seulement s'il reste utilisé — sinon le retirer). Dans `apps/api/tests/unit/client.test.ts`, supprimer l'import de `createDb` et le `it('createDb wraps the pool …')` ; conserver les cas `createPool`/`APP_POOL`.

- [ ] **Step 3 : Remplacer `z.string().url()` par `z.url()`**

`apps/api/src/config/env.ts` ligne `DATABASE_URL` :
```ts
  DATABASE_URL: z.url(),
```
(zod 4 : `z.url()` est la forme non dépréciée, comportement identique.)

- [ ] **Step 4 : Vérifier et committer**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm --filter @factelec/api test`
Expected: PASS, couverture apps/api ≥ 90 % maintenue (le dénominateur perd `createDb`, aucune régression). Les tests `env` valident toujours le rejet d'une URL invalide.

```bash
git add -A
git commit -m "chore(api): retire createDb (piège hors-tenant) et z.string().url() déprécié"
```

---

### Task 2 : Modèle DB de l'identité — schéma Drizzle + migration RLS + fonctions `SECURITY DEFINER`

**Files:**
- Modify: `apps/api/src/db/schema.ts` (tables `users`, `platformAdmins`, `sessions` + enum `userRole`)
- Create: `apps/api/src/db/migrations/0002_users_sessions_admins.sql` (généré drizzle-kit, relu)
- Create: `apps/api/src/db/migrations/0003_auth_rls_functions.sql` (hand-written : RLS/GRANT/fonctions)
- Modify: `apps/api/src/db/migrations/meta/_journal.json` (drizzle-kit ajoute 0002 ; ajout **manuel** de 0003, comme 0001 en 1.3)
- Create: `apps/api/tests/e2e/users-rls.e2e.test.ts`

**Interfaces:**
- Consumes: `tenants`, `invoices` (schéma 1.3) ; rôles `factelec_owner`/`factelec_app` (créés hors migration, helper Testcontainers 1.3).
- Produces (utilisé par toutes les tâches auth) :
  - Tables Drizzle `users`, `platformAdmins`, `sessions` (+ enum `userRole` = `'owner'|'admin'|'accountant'|'viewer'`).
  - Fonctions SQL `SECURITY DEFINER` : `authenticate_user(text)`, `authenticate_platform_admin(text)`, `signup_tenant(text,text,text,text) → (user_id,tenant_id)`, `create_session(uuid,uuid,uuid,text,text,timestamptz) → uuid`, `find_session(text) → (session_id,user_id,admin_id,tenant_id,role,csrf_hash,expires_at)`, `revoke_session(text)`, `list_tenants_for_admin() → (id,name,siren,created_at,user_count,invoice_count)`. Toutes : `REVOKE ALL … FROM PUBLIC` + `GRANT EXECUTE … TO factelec_app`.
  - RLS : `users` tenant-scopée (policy `tenant_isolation`, gabarit 0001) ; `sessions` et `platform_admins` en `FORCE` **sans policy** → deny-all pour `factelec_app` (accès uniquement via SD). `GRANT SELECT ON users TO factelec_app` (INSERT via `signup_tenant`).

- [ ] **Step 1 : Écrire le test d'isolation DB (échoue)**

`apps/api/tests/e2e/users-rls.e2e.test.ts` :
```ts
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestDb, type TestDb } from './helpers/postgres.js'

describe('users/sessions/admins isolation (DB level)', () => {
  let db: TestDb
  let ownerPool: pg.Pool
  let appPool: pg.Pool
  let tenantA: string
  let tenantB: string

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    appPool = new pg.Pool({ connectionString: db.appUrl })
    const a = await ownerPool.query(
      `SELECT user_id, tenant_id FROM signup_tenant('a@ex.com', 'hash-a', 'Tenant A', NULL)`,
    )
    tenantA = a.rows[0].tenant_id
    const b = await ownerPool.query(
      `SELECT user_id, tenant_id FROM signup_tenant('b@ex.com', 'hash-b', 'Tenant B', '123456789')`,
    )
    tenantB = b.rows[0].tenant_id
  })

  afterAll(async () => {
    await appPool.end()
    await ownerPool.end()
    await db.stop()
  })

  it('signup_tenant created a tenant + owner user atomically', async () => {
    const r = await ownerPool.query('SELECT role, email_verified FROM users WHERE tenant_id = $1', [
      tenantA,
    ])
    expect(r.rows[0]).toMatchObject({ role: 'owner', email_verified: false })
  })

  it('rejects a duplicate email (global unique) → 23505', async () => {
    await expect(
      ownerPool.query(
        `SELECT signup_tenant('A@EX.COM', 'hash-x', 'Dup', NULL)`, // casse différente : même email
      ),
    ).rejects.toMatchObject({ code: '23505' })
  })

  it('factelec_app sees users only within its tenant context', async () => {
    const client = await appPool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantB])
      const foreign = await client.query('SELECT id FROM users WHERE tenant_id = $1', [tenantA])
      expect(foreign.rowCount).toBe(0)
      const own = await client.query('SELECT id FROM users WHERE tenant_id = $1', [tenantB])
      expect(own.rowCount).toBe(1)
      await client.query('COMMIT')
    } finally {
      client.release()
    }
  })

  it('factelec_app has no direct access to sessions or platform_admins (42501)', async () => {
    // Aucun GRANT direct : ces tables ne sont accessibles que via les fonctions SD.
    await expect(appPool.query('SELECT id FROM sessions')).rejects.toMatchObject({ code: '42501' })
    await expect(appPool.query('SELECT id FROM platform_admins')).rejects.toMatchObject({ code: '42501' })
  })

  it('find_session / revoke_session round-trip via SECURITY DEFINER', async () => {
    const u = await appPool.query('SELECT user_id FROM authenticate_user($1)', ['a@ex.com'])
    const userId = u.rows[0].user_id
    await appPool.query(
      "SELECT create_session($1, NULL, $2, 'tok-hash-1', 'csrf-hash-1', now() + interval '1 hour')",
      [userId, tenantA],
    )
    const found = await appPool.query('SELECT user_id, tenant_id, role FROM find_session($1)', [
      'tok-hash-1',
    ])
    expect(found.rows[0]).toMatchObject({ user_id: userId, tenant_id: tenantA, role: 'owner' })
    await appPool.query('SELECT revoke_session($1)', ['tok-hash-1'])
    const gone = await appPool.query('SELECT user_id FROM find_session($1)', ['tok-hash-1'])
    expect(gone.rowCount).toBe(0)
  })

  it('factelec_app is still NOBYPASSRLS / NOSUPERUSER', async () => {
    const r = await appPool.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    )
    expect(r.rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false })
  })
})
```

Run: `pnpm --filter @factelec/api test -- users-rls`
Expected: FAIL — tables/fonctions absentes.

- [ ] **Step 2 : Étendre le schéma Drizzle**

`apps/api/src/db/schema.ts` — ajouter les imports manquants (`boolean`, `check`, `sql`) puis, **après** les tables existantes :
```ts
export const userRole = pgEnum('user_role', ['owner', 'admin', 'accountant', 'viewer'])

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: userRole('role').notNull().default('owner'),
    emailVerified: boolean('email_verified').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_email_unique').on(sql`lower(${t.email})`),
    index('users_tenant_idx').on(t.tenantId),
  ],
)

export const platformAdmins = pgTable(
  'platform_admins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('platform_admins_email_unique').on(sql`lower(${t.email})`)],
)

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    adminId: uuid('admin_id').references(() => platformAdmins.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    csrfHash: text('csrf_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_unique').on(t.tokenHash),
    index('sessions_expires_idx').on(t.expiresAt),
    check('sessions_subject_xor', sql`(${t.userId} IS NULL) <> (${t.adminId} IS NULL)`),
    check('sessions_admin_no_tenant', sql`${t.adminId} IS NULL OR ${t.tenantId} IS NULL`),
  ],
)
```

- [ ] **Step 3 : Générer la migration des tables (0002) et la relire**

```bash
pnpm --filter @factelec/api db:generate     # drizzle-kit → 0002_*.sql + maj _journal.json
```
Renommer le fichier généré en `0002_users_sessions_admins.sql` si le suffixe drizzle diffère (garder la cohérence du journal). **Relire** : le fichier doit contenir `CREATE TYPE "public"."user_role"`, les 3 `CREATE TABLE`, l'index fonctionnel `lower("email")` (⚠ si drizzle-kit émet `("email")` au lieu de `lower("email")`, corriger **à la main** l'index `users_email_unique` et `platform_admins_email_unique` en `USING btree (lower(email))`), et les deux `CONSTRAINT … CHECK`. Aucun `ENABLE ROW LEVEL SECURITY` ici (drizzle-kit ne l'émet pas — c'est le rôle de 0003).

- [ ] **Step 4 : Écrire la migration RLS + fonctions (0003, hand-written)**

`apps/api/src/db/migrations/0003_auth_rls_functions.sql` :
```sql
-- Plan d'authentification humaine : RLS + fonctions SECURITY DEFINER.
-- users : tenant-scopé (gabarit tenant_isolation de 0001).
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON users
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- sessions & platform_admins : FORCE sans policy → deny-all pour factelec_app
-- (accès uniquement via les fonctions SECURITY DEFINER ci-dessous).
ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_admins FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;

-- Moindre privilège : SELECT users (GET /auth/me) ; INSERT users via signup_tenant.
GRANT SELECT ON users TO factelec_app;
-- sessions & platform_admins : aucun GRANT direct.

-- ── Fonctions SECURITY DEFINER ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION authenticate_user(p_email text)
RETURNS TABLE (user_id uuid, tenant_id uuid, role user_role, password_hash text, email_verified boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE
AS $$
  SELECT id, tenant_id, role, password_hash, email_verified
  FROM users WHERE lower(email) = lower(p_email) LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION authenticate_platform_admin(p_email text)
RETURNS TABLE (admin_id uuid, password_hash text)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE
AS $$
  SELECT id, password_hash FROM platform_admins WHERE lower(email) = lower(p_email) LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION signup_tenant(p_email text, p_password_hash text, p_tenant_name text, p_siren text)
RETURNS TABLE (user_id uuid, tenant_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_tenant uuid; v_user uuid;
BEGIN
  INSERT INTO tenants (name, siren) VALUES (p_tenant_name, p_siren) RETURNING id INTO v_tenant;
  INSERT INTO users (tenant_id, email, password_hash, role)
    VALUES (v_tenant, p_email, p_password_hash, 'owner') RETURNING id INTO v_user;
  RETURN QUERY SELECT v_user, v_tenant;
END;
$$;

CREATE OR REPLACE FUNCTION create_session(
  p_user_id uuid, p_admin_id uuid, p_tenant_id uuid,
  p_token_hash text, p_csrf_hash text, p_expires_at timestamptz)
RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  INSERT INTO sessions (user_id, admin_id, tenant_id, token_hash, csrf_hash, expires_at)
  VALUES (p_user_id, p_admin_id, p_tenant_id, p_token_hash, p_csrf_hash, p_expires_at)
  RETURNING id;
$$;

CREATE OR REPLACE FUNCTION find_session(p_token_hash text)
RETURNS TABLE (session_id uuid, user_id uuid, admin_id uuid, tenant_id uuid, role user_role, csrf_hash text, expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE
AS $$
  SELECT s.id, s.user_id, s.admin_id, s.tenant_id, u.role, s.csrf_hash, s.expires_at
  FROM sessions s LEFT JOIN users u ON u.id = s.user_id
  WHERE s.token_hash = p_token_hash LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION revoke_session(p_token_hash text)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  DELETE FROM sessions WHERE token_hash = p_token_hash;
$$;

CREATE OR REPLACE FUNCTION list_tenants_for_admin()
RETURNS TABLE (id uuid, name text, siren text, created_at timestamptz, user_count bigint, invoice_count bigint)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE
AS $$
  SELECT t.id, t.name, t.siren, t.created_at,
         (SELECT count(*) FROM users u WHERE u.tenant_id = t.id),
         (SELECT count(*) FROM invoices i WHERE i.tenant_id = t.id)
  FROM tenants t ORDER BY t.created_at DESC;
$$;

REVOKE ALL ON FUNCTION authenticate_user(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authenticate_user(text) TO factelec_app;
REVOKE ALL ON FUNCTION authenticate_platform_admin(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authenticate_platform_admin(text) TO factelec_app;
REVOKE ALL ON FUNCTION signup_tenant(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION signup_tenant(text, text, text, text) TO factelec_app;
REVOKE ALL ON FUNCTION create_session(uuid, uuid, uuid, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_session(uuid, uuid, uuid, text, text, timestamptz) TO factelec_app;
REVOKE ALL ON FUNCTION find_session(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION find_session(text) TO factelec_app;
REVOKE ALL ON FUNCTION revoke_session(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION revoke_session(text) TO factelec_app;
REVOKE ALL ON FUNCTION list_tenants_for_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_tenants_for_admin() TO factelec_app;
```

Enregistrer 0003 dans `meta/_journal.json` : ajouter une entrée après 0002 (même forme que les entrées existantes : `idx` incrémenté, `version: "7"`, `when` timestamp epoch ms, `tag: "0003_auth_rls_functions"`, `breakpoints: true`). C'est le même geste manuel que pour 0001 en 1.3 (drizzle-kit ne génère pas les migrations custom).

- [ ] **Step 5 : Verdir**

Run: `pnpm --filter @factelec/api test -- users-rls`
Expected: PASS (6 cas). Si `signup_tenant` ne lève pas 23505 sur casse différente → vérifier que l'index unique porte bien sur `lower(email)` (Step 3).

- [ ] **Step 6 : Vérifier l'ensemble et committer**

Run: `pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test`
Expected: PASS. Couverture apps/api ≥ 90 % (schema.ts = déclaratif, exclu/trivial ; aucune logique TS neuve dans cette tâche).

```bash
git add -A
git commit -m "feat(api): tables users/sessions/platform_admins, RLS et fonctions SECURITY DEFINER d'auth"
```

---
### Task 3 : Primitives d'auth — mot de passe (Argon2id) + jetons opaques de session/CSRF

**Files:**
- Create: `apps/api/src/auth/password.ts`
- Create: `apps/api/src/auth/session-token.ts`
- Create: `apps/api/tests/unit/password.test.ts`, `apps/api/tests/unit/session-token.test.ts`

**Interfaces:**
- Produces :
  - `password.ts` : `passwordSchema: z.ZodString` (≥ 12) ; `hashPassword(password): Promise<string>` ; `verifyPassword(hash, password): Promise<boolean>` (fail-safe `.catch(false)`) ; `timingSafeVerifyReject(password): Promise<void>` (verify leurre quand aucun utilisateur, temps égalisé — même motif que `timingSafeReject` de `api-key.ts`).
  - `session-token.ts` : constantes `SESSION_COOKIE = 'factelec_session'`, `CSRF_COOKIE = 'factelec_csrf'`, `CSRF_HEADER = 'x-csrf-token'` ; `generateOpaqueToken(): { token, tokenHash }` (256 bits, hash SHA-256 hex) ; `hashToken(token): string` ; `safeEqualHex(a, b): boolean` (comparaison à temps constant).

- [ ] **Step 1 : Écrire les tests unitaires (échouent)**

`apps/api/tests/unit/password.test.ts` :
```ts
import { describe, expect, it } from 'vitest'
import { hashPassword, passwordSchema, verifyPassword } from '../../src/auth/password.js'

describe('password', () => {
  it('hashes and verifies a password (argon2id)', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(hash).toMatch(/^\$argon2id\$/)
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true)
    expect(await verifyPassword(hash, 'wrong password here!!')).toBe(false)
  })

  it('returns false (never throws) on a malformed hash', async () => {
    expect(await verifyPassword('not-a-hash', 'whatever password')).toBe(false)
  })

  it('rejects passwords shorter than 12 characters', () => {
    expect(passwordSchema.safeParse('short').success).toBe(false)
    expect(passwordSchema.safeParse('twelve chars ok').success).toBe(true)
  })
})
```

`apps/api/tests/unit/session-token.test.ts` :
```ts
import { describe, expect, it } from 'vitest'
import {
  generateOpaqueToken,
  hashToken,
  safeEqualHex,
} from '../../src/auth/session-token.js'

describe('session-token', () => {
  it('generates a high-entropy token distinct from its hash', () => {
    const { token, tokenHash } = generateOpaqueToken()
    expect(token).not.toBe(tokenHash)
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(hashToken(token)).toBe(tokenHash)
  })

  it('produces unique tokens across calls', () => {
    expect(generateOpaqueToken().token).not.toBe(generateOpaqueToken().token)
  })

  it('compares hex digests in constant time', () => {
    const h = hashToken('abc')
    expect(safeEqualHex(h, h)).toBe(true)
    expect(safeEqualHex(h, hashToken('def'))).toBe(false)
    expect(safeEqualHex(h, 'deadbeef')).toBe(false) // longueurs différentes
    expect(safeEqualHex('', '')).toBe(false)
  })
})
```

Run: `pnpm --filter @factelec/api test -- password session-token`
Expected: FAIL — modules inexistants.

- [ ] **Step 2 : Implémenter `password.ts`**

```ts
import { Algorithm, hash, verify } from '@node-rs/argon2'
import { z } from 'zod'

// Mêmes paramètres OWASP que les secrets de clés API (auth/api-key.ts).
const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const

export const passwordSchema = z.string().min(12, 'password must be at least 12 characters').max(200)

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS)
}

export function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password).catch(() => false)
}

// Verify leurre pour égaliser le temps quand l'email n'existe pas (anti-énumération).
let dummyHash: string | undefined
export async function timingSafeVerifyReject(password: string): Promise<void> {
  dummyHash ??= await hashPassword('factelec-timing-safe-dummy-password')
  await verifyPassword(dummyHash, password)
}
```

- [ ] **Step 3 : Implémenter `session-token.ts`**

```ts
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE = 'factelec_session'
export const CSRF_COOKIE = 'factelec_csrf'
export const CSRF_HEADER = 'x-csrf-token'

export interface OpaqueToken {
  token: string
  tokenHash: string
}

/** Jeton opaque 256 bits (CSPRNG) ; seul le hash SHA-256 est persisté. */
export function generateOpaqueToken(): OpaqueToken {
  const token = randomBytes(32).toString('base64url')
  return { token, tokenHash: hashToken(token) }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Comparaison à temps constant de deux digests hex non vides et de même longueur. */
export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex')
  const bb = Buffer.from(b, 'hex')
  if (ba.length !== bb.length || ba.length === 0) return false
  return timingSafeEqual(ba, bb)
}
```

- [ ] **Step 4 : Verdir et committer**

Run: `pnpm --filter @factelec/api test -- password session-token`
Expected: PASS. Puis :
```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): primitives d'auth (mot de passe argon2id, jetons opaques session/CSRF)"
```

---

### Task 4 : Sessions serveur + endpoints d'auth utilisateur (`/auth/signup|login|logout|me`)

**Files:**
- Create: `apps/api/src/auth/auth.types.ts`, `apps/api/src/auth/cookie.ts`, `apps/api/src/auth/session.service.ts`
- Create: `apps/api/src/auth/session.guard.ts`, `apps/api/src/auth/csrf.guard.ts`, `apps/api/src/auth/current-user.decorator.ts`
- Create: `apps/api/src/common/validation.ts`
- Create: `apps/api/src/users/users.service.ts`, `apps/api/src/users/users.controller.ts`, `apps/api/src/users/users.module.ts`
- Modify: `apps/api/src/config/env.ts` (clés session/cookie), `apps/api/src/main.ts` (cookie-parser, CORS credentials), `apps/api/src/app.module.ts` (UsersModule), `apps/api/tests/e2e/helpers/app.ts` (cookie-parser dans l'app de test)
- Modify: `apps/api/package.json` (+ `cookie-parser`, `@types/cookie-parser`)
- Create: `apps/api/tests/e2e/users-auth.e2e.test.ts`, `apps/api/tests/e2e/auth-rate-limit.e2e.test.ts`

**Interfaces:**
- Consumes: fonctions SD (Task 2), primitives (Task 3), `TenantContextService.run` + `users` schema (1.3/Task 2), `problem`/`ProblemType`, `APP_POOL`.
- Produces (utilisé par Tasks 5–6) :
  - `auth.types.ts` : `type UserRole` ; `interface AuthenticatedUser { sessionId; userId; tenantId; role; csrfHash }` ; `interface AuthenticatedAdmin { sessionId; adminId; csrfHash }` ; `interface SessionRequest extends Request { authUser?; authAdmin?; tenantId? }`.
  - `SessionService` : `create({ userId?, adminId?, tenantId? }): Promise<{ token; csrfToken; expiresAt }>`, `find(token): Promise<SessionSubject | null>`, `revoke(token): Promise<void>`.
  - `SessionGuard` (résout le cookie → `req.authUser` **ou** `req.authAdmin` ; pose `req.tenantId` pour un user, réutilisable par `@CurrentTenant`), `CsrfGuard` (double-submit lié à la session), `@CurrentUser(): AuthenticatedUser`.
  - `cookie.ts` : `sessionCookieOptions(config, maxAgeMs)`, `csrfCookieOptions(config, maxAgeMs)` (CSRF **lisible** : `httpOnly:false`).
  - `parseBody(schema, body): T` (zod → 422 `problem+json`).

- [ ] **Step 1 : Écrire les e2e d'auth (échouent)**

`apps/api/tests/e2e/users-auth.e2e.test.ts` :
```ts
import type { INestApplication } from '@nestjs/common'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'

const signup = { email: 'owner@shop.example', password: 'a-strong-passphrase-123', organizationName: 'Ma Boutique', siren: '732829320' }

describe('user auth (e2e)', () => {
  let db: TestDb
  let app: INestApplication
  let ownerPool: pg.Pool

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    app = await createTestApp(db.appUrl)
  })
  afterAll(async () => {
    await app.close()
    await ownerPool.end()
    await db.stop()
  })

  function cookies(res: request.Response): string[] {
    const raw = res.headers['set-cookie']
    return Array.isArray(raw) ? raw : raw ? [raw] : []
  }

  it('signs up, creating a user + tenant, and sets session + csrf cookies', async () => {
    const res = await request(app.getHttpServer()).post('/auth/signup').send(signup).expect(201)
    expect(res.body.user).toMatchObject({ email: signup.email, role: 'owner' })
    const set = cookies(res).join(';')
    expect(set).toContain('factelec_session=')
    expect(set).toContain('factelec_csrf=')
    expect(set).toContain('HttpOnly') // session httpOnly ; csrf lisible
    const t = await ownerPool.query('SELECT count(*)::int AS n FROM tenants WHERE name = $1', [signup.organizationName])
    expect(t.rows[0].n).toBe(1)
  })

  it('rejects a duplicate email with 409', async () => {
    await request(app.getHttpServer()).post('/auth/signup').send(signup).expect(409)
  })

  it('rejects a weak password with 422', async () => {
    await request(app.getHttpServer())
      .post('/auth/signup')
      .send({ ...signup, email: 'weak@shop.example', password: 'short' })
      .expect(422)
  })

  it('logs in with valid credentials and rejects wrong ones', async () => {
    const ok = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: signup.email, password: signup.password })
      .expect(200)
    expect(cookies(ok).join(';')).toContain('factelec_session=')
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: signup.email, password: 'wrong-password-xxx' })
      .expect(401)
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'nobody@shop.example', password: signup.password })
      .expect(401)
  })

  it('GET /auth/me returns the profile with a valid session, 401 without', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: signup.email, password: signup.password })
      .expect(200)
    const cookieHeader = cookies(login)
    const me = await request(app.getHttpServer()).get('/auth/me').set('Cookie', cookieHeader).expect(200)
    expect(me.body.user).toMatchObject({ email: signup.email, role: 'owner', emailVerified: false })
    await request(app.getHttpServer()).get('/auth/me').expect(401)
  })

  it('logs out: revokes the session so /auth/me is 401 afterwards', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: signup.email, password: signup.password })
      .expect(200)
    const cookieHeader = cookies(login)
    await request(app.getHttpServer()).post('/auth/logout').set('Cookie', cookieHeader).expect(204)
    await request(app.getHttpServer()).get('/auth/me').set('Cookie', cookieHeader).expect(401)
  })
})
```

`apps/api/tests/e2e/auth-rate-limit.e2e.test.ts` (limite anti-abus statique du login = 10/fenêtre) :
```ts
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'

describe('auth rate limiting (e2e)', () => {
  let db: TestDb
  let app: INestApplication
  beforeAll(async () => {
    db = await startTestDb()
    app = await createTestApp(db.appUrl)
  })
  afterAll(async () => {
    await app.close()
    await db.stop()
  })

  it('throttles brute-force login attempts (429 after 10)', async () => {
    const attempt = () =>
      request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'nobody@x.example', password: 'bad-password-1' })
    for (let i = 0; i < 10; i++) await attempt()
    await attempt().expect(429)
  })
})
```

Run: `pnpm --filter @factelec/api test -- users-auth auth-rate-limit`
Expected: FAIL — endpoints/guards absents.

- [ ] **Step 2 : Étendre `env.ts` (session/cookie) + `package.json`**

`apps/api/src/config/env.ts` — ajouter au `z.object({...})` :
```ts
  SESSION_TTL_HOURS: z.coerce.number().int().positive().max(720).default(12),
  SESSION_COOKIE_DOMAIN: z.string().optional(),
```
`apps/api/package.json` — ajouter (versions vérifiées 2026-07-13) :
```jsonc
    // dependencies
    "cookie-parser": "1.4.7",
    // devDependencies
    "@types/cookie-parser": "1.4.10",
```
Puis `pnpm install`.

- [ ] **Step 3 : Types partagés + helper de validation + options de cookie**

`apps/api/src/auth/auth.types.ts` :
```ts
import type { Request } from 'express'

export type UserRole = 'owner' | 'admin' | 'accountant' | 'viewer'

export interface AuthenticatedUser {
  sessionId: string
  userId: string
  tenantId: string
  role: UserRole
  csrfHash: string
}
export interface AuthenticatedAdmin {
  sessionId: string
  adminId: string
  csrfHash: string
}
export interface SessionRequest extends Request {
  authUser?: AuthenticatedUser
  authAdmin?: AuthenticatedAdmin
  tenantId?: string // posé pour un user → réutilise @CurrentTenant / runInTenant
}
```

`apps/api/src/common/validation.ts` :
```ts
import { UnprocessableEntityException } from '@nestjs/common'
import type { ZodType } from 'zod'
import { problem, ProblemType } from './problem.js'

export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body)
  if (!r.success) {
    const errors = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
    throw new UnprocessableEntityException(
      problem(422, ProblemType.validation, 'Unprocessable Entity', { errors }),
    )
  }
  return r.data
}
```

`apps/api/src/auth/cookie.ts` :
```ts
import type { ConfigService } from '@nestjs/config'
import type { CookieOptions } from 'express'
import type { EnvConfig } from '../config/env.js'

function base(config: ConfigService<EnvConfig, true>, maxAgeMs: number): CookieOptions {
  const domain = config.get('SESSION_COOKIE_DOMAIN', { infer: true })
  return {
    secure: config.get('NODE_ENV', { infer: true }) === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeMs,
    ...(domain ? { domain } : {}),
  }
}
// Cookie de session : httpOnly (jamais lisible par JS).
export const sessionCookieOptions = (c: ConfigService<EnvConfig, true>, m: number): CookieOptions => ({
  ...base(c, m),
  httpOnly: true,
})
// Cookie CSRF : LISIBLE par JS (double-submit) ; ne donne aucun accès seul.
export const csrfCookieOptions = (c: ConfigService<EnvConfig, true>, m: number): CookieOptions => ({
  ...base(c, m),
  httpOnly: false,
})
```

- [ ] **Step 4 : `SessionService`**

`apps/api/src/auth/session.service.ts` :
```ts
import { Inject, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type pg from 'pg'
import type { EnvConfig } from '../config/env.js'
import { APP_POOL } from '../db/client.js'
import type { UserRole } from './auth.types.js'
import { generateOpaqueToken, hashToken } from './session-token.js'

export interface SessionSubject {
  sessionId: string
  userId: string | null
  adminId: string | null
  tenantId: string | null
  role: UserRole | null
  csrfHash: string
}
export interface IssuedSession {
  token: string
  csrfToken: string
  expiresAt: Date
}

@Injectable()
export class SessionService {
  constructor(
    @Inject(APP_POOL) private readonly pool: pg.Pool,
    private readonly config: ConfigService<EnvConfig, true>,
  ) {}

  ttlMs(): number {
    return this.config.get('SESSION_TTL_HOURS', { infer: true }) * 3_600_000
  }

  async create(subject: { userId?: string; adminId?: string; tenantId?: string }): Promise<IssuedSession> {
    const session = generateOpaqueToken()
    const csrf = generateOpaqueToken()
    const expiresAt = new Date(Date.now() + this.ttlMs())
    await this.pool.query('SELECT create_session($1, $2, $3, $4, $5, $6)', [
      subject.userId ?? null,
      subject.adminId ?? null,
      subject.tenantId ?? null,
      session.tokenHash,
      csrf.tokenHash,
      expiresAt,
    ])
    return { token: session.token, csrfToken: csrf.token, expiresAt }
  }

  async find(token: string): Promise<SessionSubject | null> {
    const res = await this.pool.query(
      'SELECT session_id, user_id, admin_id, tenant_id, role, csrf_hash, expires_at FROM find_session($1)',
      [hashToken(token)],
    )
    const row = res.rows[0]
    if (!row) return null
    if (new Date(row.expires_at).getTime() <= Date.now()) return null
    return {
      sessionId: row.session_id,
      userId: row.user_id,
      adminId: row.admin_id,
      tenantId: row.tenant_id,
      role: row.role,
      csrfHash: row.csrf_hash,
    }
  }

  async revoke(token: string): Promise<void> {
    await this.pool.query('SELECT revoke_session($1)', [hashToken(token)])
  }
}
```

- [ ] **Step 5 : Guards + décorateur**

`apps/api/src/auth/session.guard.ts` :
```ts
import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
import { problem, ProblemType } from '../common/problem.js'
import type { SessionRequest } from './auth.types.js'
import { SESSION_COOKIE } from './session-token.js'
import { SessionService } from './session.service.js'

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<SessionRequest>()
    const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE]
    const deny = () =>
      new UnauthorizedException(
        problem(401, ProblemType.unauthorized, 'Unauthorized', { detail: 'No active session' }),
      )
    if (!token) throw deny()
    const subject = await this.sessions.find(token)
    if (!subject) throw deny()
    if (subject.userId && subject.tenantId) {
      req.authUser = {
        sessionId: subject.sessionId,
        userId: subject.userId,
        tenantId: subject.tenantId,
        role: subject.role ?? 'viewer',
        csrfHash: subject.csrfHash,
      }
      req.tenantId = subject.tenantId
      return true
    }
    if (subject.adminId) {
      req.authAdmin = { sessionId: subject.sessionId, adminId: subject.adminId, csrfHash: subject.csrfHash }
      return true
    }
    throw deny()
  }
}
```

`apps/api/src/auth/csrf.guard.ts` :
```ts
import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common'
import { problem, ProblemType } from '../common/problem.js'
import type { SessionRequest } from './auth.types.js'
import { CSRF_HEADER, hashToken, safeEqualHex } from './session-token.js'

// Double-submit lié à la session : X-CSRF-Token (valeur du cookie lisible) vs hash stocké.
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<SessionRequest>()
    const csrfHash = req.authUser?.csrfHash ?? req.authAdmin?.csrfHash
    const header = req.header(CSRF_HEADER)
    const deny = () =>
      new ForbiddenException(problem(403, ProblemType.forbidden, 'Forbidden', { detail: 'Invalid CSRF token' }))
    if (!csrfHash || !header) throw deny()
    if (!safeEqualHex(hashToken(header), csrfHash)) throw deny()
    return true
  }
}
```

`apps/api/src/auth/current-user.decorator.ts` :
```ts
import { createParamDecorator, type ExecutionContext } from '@nestjs/common'
import type { AuthenticatedUser, SessionRequest } from './auth.types.js'

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
  const req = ctx.switchToHttp().getRequest<SessionRequest>()
  if (!req.authUser) throw new Error('CurrentUser used without SessionGuard (user session)')
  return req.authUser
})
```

- [ ] **Step 6 : `UsersService`**

`apps/api/src/users/users.service.ts` :
```ts
import { ConflictException, Inject, Injectable, UnauthorizedException } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import type pg from 'pg'
import { problem, ProblemType } from '../common/problem.js'
import type { AuthenticatedUser, UserRole } from '../auth/auth.types.js'
import { hashPassword, timingSafeVerifyReject, verifyPassword } from '../auth/password.js'
import { APP_POOL } from '../db/client.js'
import { users } from '../db/schema.js'
import { TenantContextService } from '../db/tenant-context.service.js'

export interface SignupInput {
  email: string
  password: string
  organizationName: string
  siren: string | null
}
export interface UserProfile {
  id: string
  email: string
  role: UserRole
  tenantId: string
  emailVerified: boolean
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(APP_POOL) private readonly pool: pg.Pool,
    private readonly tenant: TenantContextService,
  ) {}

  async signup(input: SignupInput): Promise<{ userId: string; tenantId: string; role: UserRole }> {
    const passwordHash = await hashPassword(input.password)
    try {
      const res = await this.pool.query(
        'SELECT user_id, tenant_id FROM signup_tenant($1, $2, $3, $4)',
        [input.email, passwordHash, input.organizationName, input.siren],
      )
      const row = res.rows[0]
      return { userId: row.user_id, tenantId: row.tenant_id, role: 'owner' }
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        throw new ConflictException(
          problem(409, ProblemType.conflict, 'Conflict', { detail: 'Email already registered' }),
        )
      }
      throw e
    }
  }

  async login(email: string, password: string): Promise<{ userId: string; tenantId: string; role: UserRole }> {
    const res = await this.pool.query(
      'SELECT user_id, tenant_id, role, password_hash FROM authenticate_user($1)',
      [email],
    )
    const row = res.rows[0]
    const invalid = () =>
      new UnauthorizedException(
        problem(401, ProblemType.unauthorized, 'Unauthorized', { detail: 'Invalid credentials' }),
      )
    if (!row) {
      await timingSafeVerifyReject(password) // temps égalisé (anti-énumération)
      throw invalid()
    }
    if (!(await verifyPassword(row.password_hash, password))) throw invalid()
    return { userId: row.user_id, tenantId: row.tenant_id, role: row.role }
  }

  me(user: Pick<AuthenticatedUser, 'userId' | 'tenantId'>): Promise<UserProfile> {
    return this.tenant.run(user.tenantId, async (db) => {
      const [row] = await db
        .select({
          id: users.id,
          email: users.email,
          role: users.role,
          tenantId: users.tenantId,
          emailVerified: users.emailVerified,
        })
        .from(users)
        .where(eq(users.id, user.userId))
        .limit(1)
      // RLS garantit l'appartenance au tenant ; la session garantit l'existence.
      return row as UserProfile
    })
  }
}
```

- [ ] **Step 7 : `UsersController` + `UsersModule`**

`apps/api/src/users/users.controller.ts` :
```ts
import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Throttle } from '@nestjs/throttler'
import type { Response } from 'express'
import { z } from 'zod'
import type { EnvConfig } from '../config/env.js'
import { CurrentUser } from '../auth/current-user.decorator.js'
import type { AuthenticatedUser, SessionRequest } from '../auth/auth.types.js'
import { csrfCookieOptions, sessionCookieOptions } from '../auth/cookie.js'
import { passwordSchema } from '../auth/password.js'
import { CSRF_COOKIE, SESSION_COOKIE } from '../auth/session-token.js'
import { SessionService } from '../auth/session.service.js'
import { SessionGuard } from '../auth/session.guard.js'
import { parseBody } from '../common/validation.js'
import { UsersService } from './users.service.js'

const signupSchema = z.object({
  email: z.email(),
  password: passwordSchema,
  organizationName: z.string().min(1).max(200),
  siren: z
    .string()
    .regex(/^\d{9}$/, 'siren must be 9 digits')
    .nullish()
    .transform((v) => v ?? null),
})
const loginSchema = z.object({ email: z.email(), password: z.string().min(1).max(200) })

@Controller('auth')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly sessions: SessionService,
    private readonly config: ConfigService<EnvConfig, true>,
  ) {}

  private issue(res: Response, session: { token: string; csrfToken: string }): void {
    const maxAge = this.sessions.ttlMs()
    res.cookie(SESSION_COOKIE, session.token, sessionCookieOptions(this.config, maxAge))
    res.cookie(CSRF_COOKIE, session.csrfToken, csrfCookieOptions(this.config, maxAge))
  }

  @Post('signup')
  @HttpCode(201)
  @Throttle({ default: { ttl: 3_600_000, limit: 5 } }) // anti-abus : 5 inscriptions / h / IP
  async signup(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const input = parseBody(signupSchema, body)
    const created = await this.users.signup(input)
    const session = await this.sessions.create({ userId: created.userId, tenantId: created.tenantId })
    this.issue(res, session)
    return { user: { id: created.userId, email: input.email, role: created.role, tenantId: created.tenantId, emailVerified: false } }
  }

  @Post('login')
  @HttpCode(200)
  @Throttle({ default: { ttl: 900_000, limit: 10 } }) // anti-brute-force : 10 / 15 min / IP
  async login(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const input = parseBody(loginSchema, body)
    const user = await this.users.login(input.email, input.password)
    const session = await this.sessions.create({ userId: user.userId, tenantId: user.tenantId })
    this.issue(res, session)
    return { user: { id: user.userId, email: input.email, role: user.role, tenantId: user.tenantId } }
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async logout(@Req() req: SessionRequest, @Res({ passthrough: true }) res: Response): Promise<void> {
    const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE]
    if (token) await this.sessions.revoke(token)
    res.clearCookie(SESSION_COOKIE, sessionCookieOptions(this.config, 0))
    res.clearCookie(CSRF_COOKIE, csrfCookieOptions(this.config, 0))
  }

  @Get('me')
  @UseGuards(SessionGuard)
  async me(@CurrentUser() user: AuthenticatedUser) {
    return { user: await this.users.me(user) }
  }
}
```
> Note types : `config` est typé `ConfigService<EnvConfig, true>` (requis par `cookie.ts`/`session.service.ts` qui utilisent `{ infer: true }`).

`apps/api/src/users/users.module.ts` :
```ts
import { Module } from '@nestjs/common'
import { CsrfGuard } from '../auth/csrf.guard.js'
import { SessionGuard } from '../auth/session.guard.js'
import { SessionService } from '../auth/session.service.js'
import { UsersController } from './users.controller.js'
import { UsersService } from './users.service.js'

@Module({
  controllers: [UsersController],
  providers: [UsersService, SessionService, SessionGuard, CsrfGuard],
  exports: [SessionService, SessionGuard, CsrfGuard],
})
export class UsersModule {}
```

- [ ] **Step 8 : Câbler cookie-parser, CORS credentials, module racine**

`apps/api/src/main.ts` — importer `cookie-parser` et l'enregistrer **avant** les routes ; élargir CORS :
```ts
import cookieParser from 'cookie-parser'
// … après app.use(helmet()) :
app.use(cookieParser())
app.enableCors({
  origin: config.get('CORS_ALLOWED_ORIGINS', { infer: true }),
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'X-CSRF-Token'],
  credentials: true, // cookies de session cross-subdomain
})
```

`apps/api/tests/e2e/helpers/app.ts` — enregistrer cookie-parser dans l'app de test (sinon `req.cookies` indéfini) :
```ts
import cookieParser from 'cookie-parser'
// … après app.use(helmet()) :
app.use(cookieParser())
```

`apps/api/src/app.module.ts` — ajouter `UsersModule` aux imports.

`apps/api/.env.example` — la CORS doit autoriser l'origine du dashboard **avec** credentials : mettre `CORS_ALLOWED_ORIGINS=http://localhost:3001` (le dashboard tourne sur 3001, cf. Task 8) ; en prod, l'origine `https://dashboard.factelec.fr`. Ajouter `SESSION_TTL_HOURS=12` et (prod) `SESSION_COOKIE_DOMAIN=.factelec.fr`.

- [ ] **Step 9 : Verdir**

Run: `pnpm --filter @factelec/api test -- users-auth auth-rate-limit`
Expected: PASS. Points de vigilance : `set-cookie` (supertest) est un tableau ; `HttpOnly` présent sur le cookie de session mais **pas** sur le cookie CSRF (vérifiable si besoin) ; le 429 arrive au 11ᵉ login (limite statique 10).

- [ ] **Step 10 : Vérifier l'ensemble et committer**

Run: `pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test`
Expected: PASS, couverture apps/api ≥ 90 %. `pnpm audit` 0 / `pnpm outdated -r` vierge (cookie-parser/@types pinnés).

```bash
git add -A
git commit -m "feat(api): sessions serveur opaques + endpoints d'auth utilisateur (signup/login/logout/me) avec CSRF"
```

---
### Task 5 : Gestion des clés API par l'API (création 1×, listage des préfixes, révocation) + rôles

**Files:**
- Create: `apps/api/src/auth/roles.guard.ts` (`RolesGuard` + `@Roles()`)
- Create: `apps/api/src/api-keys/api-keys.service.ts`, `apps/api/src/api-keys/api-keys.controller.ts`, `apps/api/src/api-keys/api-keys.module.ts`
- Create: `apps/api/tests/e2e/helpers/session.ts` (helper `signupSession`)
- Modify: `apps/api/src/app.module.ts` (ApiKeysModule)
- Create: `apps/api/tests/e2e/api-keys.e2e.test.ts`

**Interfaces:**
- Consumes: `SessionGuard`, `CsrfGuard` (UsersModule), `@CurrentTenant` (réutilisé — `SessionGuard` pose `req.tenantId`), `generateApiKey` (`auth/api-key.ts`), `apiKeys` schema, `TenantContextService`, `isUuid` (`invoices/format-kind.ts`), `parseBody`.
- Produces (utilisé par Task 6/web) :
  - `RolesGuard` + `Roles(...roles)` (métadonnées `ROLES_KEY`) : exige `req.authUser.role ∈ required` ; **un session admin (sans `authUser`) est refusé 403** → protège aussi contre l'usage d'un cookie admin sur les routes tenant.
  - `ApiKeysService` : `create(tenantId, label) → ApiKeyView & { token }` (token **une seule fois**), `list(tenantId) → ApiKeyView[]` (préfixes/label/dates, **jamais** le secret), `revoke(tenantId, id): Promise<void>` (soft-delete `revoked_at` — `factelec_app` n'a pas de DELETE).
  - `signupSession(app, input) → { cookie: string[]; csrf: string }` (helper e2e).

- [ ] **Step 1 : Écrire l'e2e des clés API (échoue)**

`apps/api/tests/e2e/helpers/session.ts` :
```ts
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'

export interface Session {
  cookie: string[]
  csrf: string
}

export function extractCookie(setCookie: string[], name: string): string {
  const c = setCookie.find((s) => s.startsWith(`${name}=`))
  if (!c) throw new Error(`cookie ${name} absent`)
  return decodeURIComponent(c.split(';')[0].slice(name.length + 1))
}

export async function signupSession(app: INestApplication, input: unknown): Promise<Session> {
  const res = await request(app.getHttpServer()).post('/auth/signup').send(input).expect(201)
  const setCookie = res.headers['set-cookie'] as unknown as string[]
  return { cookie: setCookie, csrf: extractCookie(setCookie, 'factelec_csrf') }
}
```

`apps/api/tests/e2e/api-keys.e2e.test.ts` :
```ts
import type { INestApplication } from '@nestjs/common'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashPassword } from '../../src/auth/password.js'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { type Session, signupSession } from './helpers/session.js'

const ownerInput = { email: 'owner@a.example', password: 'owner-passphrase-123', organizationName: 'Tenant A', siren: '732829320' }

describe('api keys management (e2e)', () => {
  let db: TestDb
  let app: INestApplication
  let ownerPool: pg.Pool
  let sess: Session

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    app = await createTestApp(db.appUrl)
    sess = await signupSession(app, ownerInput)
  })
  afterAll(async () => {
    await app.close()
    await ownerPool.end()
    await db.stop()
  })

  it('refuses key creation without a CSRF token (403)', async () => {
    await request(app.getHttpServer())
      .post('/api-keys')
      .set('Cookie', sess.cookie)
      .send({ label: 'no-csrf' })
      .expect(403)
  })

  it('creates a key, returns the secret ONCE, and the key authenticates machine calls', async () => {
    const res = await request(app.getHttpServer())
      .post('/api-keys')
      .set('Cookie', sess.cookie)
      .set('X-CSRF-Token', sess.csrf)
      .send({ label: 'prod' })
      .expect(201)
    expect(res.body).toMatchObject({ label: 'prod' })
    expect(res.body.prefix).toMatch(/^[0-9a-f]{24}$/)
    expect(res.body.token).toMatch(/^fk_[0-9a-f]{24}\./)
    // La clé fonctionne pour l'auth machine (bout en bout).
    await request(app.getHttpServer())
      .get('/invoices')
      .set('Authorization', `Bearer ${res.body.token}`)
      .expect(200)
  })

  it('lists keys with prefixes only (never the secret)', async () => {
    const res = await request(app.getHttpServer()).get('/api-keys').set('Cookie', sess.cookie).expect(200)
    expect(Array.isArray(res.body)).toBe(true)
    for (const k of res.body) {
      expect(k).toHaveProperty('prefix')
      expect(k).not.toHaveProperty('token')
      expect(k).not.toHaveProperty('secretHash')
      expect(k).not.toHaveProperty('secret_hash')
    }
  })

  it('revokes a key so it no longer authenticates', async () => {
    const created = await request(app.getHttpServer())
      .post('/api-keys')
      .set('Cookie', sess.cookie)
      .set('X-CSRF-Token', sess.csrf)
      .send({ label: 'to-revoke' })
      .expect(201)
    await request(app.getHttpServer())
      .delete(`/api-keys/${created.body.id}`)
      .set('Cookie', sess.cookie)
      .set('X-CSRF-Token', sess.csrf)
      .expect(204)
    await request(app.getHttpServer())
      .get('/invoices')
      .set('Authorization', `Bearer ${created.body.token}`)
      .expect(401)
  })

  it('enforces roles: a viewer cannot create keys (403)', async () => {
    // Semer un viewer dans le tenant A (invitation différée → insertion directe via owner).
    const tenantRow = await ownerPool.query('SELECT tenant_id FROM authenticate_user($1)', [ownerInput.email])
    const tenantId = tenantRow.rows[0].tenant_id
    const hash = await hashPassword('viewer-passphrase-123')
    await ownerPool.query(
      "INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1, 'viewer@a.example', $2, 'viewer')",
      [tenantId, hash],
    )
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'viewer@a.example', password: 'viewer-passphrase-123' })
      .expect(200)
    const viewer = login.headers['set-cookie'] as unknown as string[]
    const csrf = decodeURIComponent(
      viewer.find((s) => s.startsWith('factelec_csrf='))!.split(';')[0].slice('factelec_csrf='.length),
    )
    // Le viewer peut lister…
    await request(app.getHttpServer()).get('/api-keys').set('Cookie', viewer).expect(200)
    // …mais pas créer.
    await request(app.getHttpServer())
      .post('/api-keys')
      .set('Cookie', viewer)
      .set('X-CSRF-Token', csrf)
      .send({ label: 'nope' })
      .expect(403)
  })

  it('isolates tenants: B cannot see or revoke A keys', async () => {
    const bSess = await signupSession(app, { email: 'owner@b.example', password: 'owner-b-passphrase-1', organizationName: 'Tenant B', siren: null })
    const aList = await request(app.getHttpServer()).get('/api-keys').set('Cookie', sess.cookie).expect(200)
    const bList = await request(app.getHttpServer()).get('/api-keys').set('Cookie', bSess.cookie).expect(200)
    expect(bList.body.length).toBe(0)
    await request(app.getHttpServer())
      .delete(`/api-keys/${aList.body[0].id}`)
      .set('Cookie', bSess.cookie)
      .set('X-CSRF-Token', bSess.csrf)
      .expect(404) // clé de A invisible pour B (RLS) → 404, jamais 204
  })
})
```

Run: `pnpm --filter @factelec/api test -- api-keys`
Expected: FAIL — module absent.

- [ ] **Step 2 : `RolesGuard` + `@Roles()`**

`apps/api/src/auth/roles.guard.ts` :
```ts
import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { problem, ProblemType } from '../common/problem.js'
import type { SessionRequest, UserRole } from './auth.types.js'

export const ROLES_KEY = 'factelec:roles'
export const Roles = (...roles: UserRole[]): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles)

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ])
    if (!required || required.length === 0) return true
    const role = ctx.switchToHttp().getRequest<SessionRequest>().authUser?.role
    if (!role || !required.includes(role)) {
      throw new ForbiddenException(
        problem(403, ProblemType.forbidden, 'Forbidden', { detail: 'Insufficient role' }),
      )
    }
    return true
  }
}
```

- [ ] **Step 3 : `ApiKeysService`**

`apps/api/src/api-keys/api-keys.service.ts` :
```ts
import { Injectable, NotFoundException } from '@nestjs/common'
import { desc, eq } from 'drizzle-orm'
import { generateApiKey } from '../auth/api-key.js'
import { problem, ProblemType } from '../common/problem.js'
import { apiKeys } from '../db/schema.js'
import { TenantContextService } from '../db/tenant-context.service.js'
import { isUuid } from '../invoices/format-kind.js'

export interface ApiKeyView {
  id: string
  prefix: string
  label: string
  createdAt: Date
  lastUsedAt: Date | null
  revokedAt: Date | null
}

const VIEW = {
  id: apiKeys.id,
  prefix: apiKeys.prefix,
  label: apiKeys.label,
  createdAt: apiKeys.createdAt,
  lastUsedAt: apiKeys.lastUsedAt,
  revokedAt: apiKeys.revokedAt,
} as const

@Injectable()
export class ApiKeysService {
  constructor(private readonly tenant: TenantContextService) {}

  async create(tenantId: string, label: string): Promise<ApiKeyView & { token: string }> {
    const key = await generateApiKey()
    return this.tenant.run(tenantId, async (db) => {
      const [row] = await db
        .insert(apiKeys)
        .values({ tenantId, prefix: key.prefix, secretHash: key.secretHash, label })
        .returning(VIEW)
      return { ...(row as ApiKeyView), token: key.token }
    })
  }

  list(tenantId: string): Promise<ApiKeyView[]> {
    return this.tenant.run(tenantId, (db) =>
      db.select(VIEW).from(apiKeys).orderBy(desc(apiKeys.createdAt)),
    ) as Promise<ApiKeyView[]>
  }

  async revoke(tenantId: string, id: string): Promise<void> {
    if (!isUuid(id)) throw this.notFound()
    const revoked = await this.tenant.run(tenantId, (db) =>
      db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, id)).returning({ id: apiKeys.id }),
    )
    if (revoked.length === 0) throw this.notFound() // RLS : clé d'un autre tenant → 0 ligne → 404
  }

  private notFound(): NotFoundException {
    return new NotFoundException(
      problem(404, ProblemType.notFound, 'Not Found', { detail: 'API key not found' }),
    )
  }
}
```
> **Secret jamais relu** : `VIEW` n'inclut pas `secretHash` ; `revoke` par `UPDATE revoked_at` (l'auth machine 1.3 traite déjà `revoked_at != null` comme révoquée). `create` renvoie `token` (une fois), jamais persisté en clair.

- [ ] **Step 4 : `ApiKeysController` + `ApiKeysModule`**

`apps/api/src/api-keys/api-keys.controller.ts` :
```ts
import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common'
import { z } from 'zod'
import { CurrentTenant } from '../auth/current-tenant.decorator.js'
import { CsrfGuard } from '../auth/csrf.guard.js'
import { Roles, RolesGuard } from '../auth/roles.guard.js'
import { SessionGuard } from '../auth/session.guard.js'
import { parseBody } from '../common/validation.js'
import { ApiKeysService } from './api-keys.service.js'

const createKeySchema = z.object({ label: z.string().min(1).max(100) })

// Classe : session utilisateur obligatoire (tout rôle) → un cookie admin (sans authUser) est 403.
@Controller('api-keys')
@UseGuards(SessionGuard, RolesGuard)
@Roles('owner', 'admin', 'accountant', 'viewer')
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Post()
  @HttpCode(201)
  @UseGuards(CsrfGuard)
  @Roles('owner', 'admin') // override niveau méthode
  create(@CurrentTenant() tenantId: string, @Body() body: unknown) {
    const { label } = parseBody(createKeySchema, body)
    return this.keys.create(tenantId, label) // secret affiché une seule fois
  }

  @Get()
  list(@CurrentTenant() tenantId: string) {
    return this.keys.list(tenantId)
  }

  @Delete(':id')
  @HttpCode(204)
  @UseGuards(CsrfGuard)
  @Roles('owner', 'admin')
  async revoke(@CurrentTenant() tenantId: string, @Param('id') id: string): Promise<void> {
    await this.keys.revoke(tenantId, id)
  }
}
```

`apps/api/src/api-keys/api-keys.module.ts` :
```ts
import { Module } from '@nestjs/common'
import { RolesGuard } from '../auth/roles.guard.js'
import { UsersModule } from '../users/users.module.js'
import { ApiKeysController } from './api-keys.controller.js'
import { ApiKeysService } from './api-keys.service.js'

@Module({
  imports: [UsersModule], // SessionGuard/CsrfGuard/SessionService
  controllers: [ApiKeysController],
  providers: [ApiKeysService, RolesGuard],
})
export class ApiKeysModule {}
```

Ajouter `ApiKeysModule` aux imports de `app.module.ts`.

- [ ] **Step 5 : Verdir puis vérifier l'ensemble et committer**

Run: `pnpm --filter @factelec/api test -- api-keys`
Expected: PASS (6 cas). Puis :
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): gestion des clés API par session (création unique, listage des préfixes, révocation, rôles)"
```

---

### Task 6 : Super admin minimal — login, liste des tenants, provisioning CLI

**Files:**
- Create: `apps/api/src/admin/admin.service.ts`, `apps/api/src/admin/admin.controller.ts`, `apps/api/src/admin/admin.guard.ts`, `apps/api/src/admin/admin.module.ts`
- Create: `apps/api/scripts/provision-admin.ts`
- Modify: `apps/api/src/app.module.ts` (AdminModule), `apps/api/package.json` (script `provision:admin`)
- Create: `apps/api/tests/e2e/admin.e2e.test.ts`

**Interfaces:**
- Consumes: `authenticate_platform_admin`, `list_tenants_for_admin` (SD, Task 2), `SessionService`/`SessionGuard`/`CsrfGuard`, `verifyPassword`/`hashPassword`, cookie helpers, `parseBody`.
- Produces : `AdminGuard` (exige `req.authAdmin` — à placer **après** `SessionGuard`) ; endpoints `POST /admin/login`, `POST /admin/logout`, `GET /admin/tenants` ; script `pnpm provision:admin <email> <password>`.

- [ ] **Step 1 : Écrire l'e2e admin (échoue)**

`apps/api/tests/e2e/admin.e2e.test.ts` :
```ts
import type { INestApplication } from '@nestjs/common'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashPassword } from '../../src/auth/password.js'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { signupSession } from './helpers/session.js'

describe('super admin (e2e)', () => {
  let db: TestDb
  let app: INestApplication
  let ownerPool: pg.Pool

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    app = await createTestApp(db.appUrl)
    // Deux tenants (pour la liste) + un admin plateforme.
    await signupSession(app, { email: 'a@shop.example', password: 'passphrase-aaaaaa-1', organizationName: 'Shop A', siren: null })
    await signupSession(app, { email: 'b@shop.example', password: 'passphrase-bbbbbb-1', organizationName: 'Shop B', siren: null })
    const hash = await hashPassword('super-admin-passphrase-1')
    await ownerPool.query("INSERT INTO platform_admins (email, password_hash) VALUES ('root@factelec.fr', $1)", [hash])
  })
  afterAll(async () => {
    await app.close()
    await ownerPool.end()
    await db.stop()
  })

  async function adminCookie(): Promise<string[]> {
    const res = await request(app.getHttpServer())
      .post('/admin/login')
      .send({ email: 'root@factelec.fr', password: 'super-admin-passphrase-1' })
      .expect(200)
    return res.headers['set-cookie'] as unknown as string[]
  }

  it('logs in a platform admin and rejects bad credentials', async () => {
    await adminCookie()
    await request(app.getHttpServer())
      .post('/admin/login')
      .send({ email: 'root@factelec.fr', password: 'wrong' })
      .expect(401)
  })

  it('lists all tenants for an authenticated admin', async () => {
    const cookie = await adminCookie()
    const res = await request(app.getHttpServer()).get('/admin/tenants').set('Cookie', cookie).expect(200)
    const names = res.body.map((t: { name: string }) => t.name)
    expect(names).toContain('Shop A')
    expect(names).toContain('Shop B')
    expect(res.body[0]).toHaveProperty('userCount')
  })

  it('forbids a tenant user from the admin area (403)', async () => {
    const user = await signupSession(app, { email: 'c@shop.example', password: 'passphrase-cccccc-1', organizationName: 'Shop C', siren: null })
    await request(app.getHttpServer()).get('/admin/tenants').set('Cookie', user.cookie).expect(403)
  })

  it('forbids an admin session on tenant key management (403)', async () => {
    const cookie = await adminCookie()
    await request(app.getHttpServer()).get('/api-keys').set('Cookie', cookie).expect(403)
  })

  it('requires a session for the admin area (401)', async () => {
    await request(app.getHttpServer()).get('/admin/tenants').expect(401)
  })
})
```

Run: `pnpm --filter @factelec/api test -- admin`
Expected: FAIL — module absent.

- [ ] **Step 2 : `AdminService` + `AdminGuard`**

`apps/api/src/admin/admin.service.ts` :
```ts
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common'
import type pg from 'pg'
import { problem, ProblemType } from '../common/problem.js'
import { timingSafeVerifyReject, verifyPassword } from '../auth/password.js'
import { APP_POOL } from '../db/client.js'

export interface TenantOverview {
  id: string
  name: string
  siren: string | null
  createdAt: Date
  userCount: number
  invoiceCount: number
}

@Injectable()
export class AdminService {
  constructor(@Inject(APP_POOL) private readonly pool: pg.Pool) {}

  async login(email: string, password: string): Promise<{ adminId: string }> {
    const res = await this.pool.query('SELECT admin_id, password_hash FROM authenticate_platform_admin($1)', [email])
    const row = res.rows[0]
    const invalid = () =>
      new UnauthorizedException(problem(401, ProblemType.unauthorized, 'Unauthorized', { detail: 'Invalid credentials' }))
    if (!row) {
      await timingSafeVerifyReject(password)
      throw invalid()
    }
    if (!(await verifyPassword(row.password_hash, password))) throw invalid()
    return { adminId: row.admin_id }
  }

  async listTenants(): Promise<TenantOverview[]> {
    const res = await this.pool.query(
      'SELECT id, name, siren, created_at, user_count, invoice_count FROM list_tenants_for_admin()',
    )
    return res.rows.map((r) => ({
      id: r.id,
      name: r.name,
      siren: r.siren,
      createdAt: r.created_at,
      userCount: Number(r.user_count),
      invoiceCount: Number(r.invoice_count),
    }))
  }
}
```

`apps/api/src/admin/admin.guard.ts` :
```ts
import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common'
import { problem, ProblemType } from '../common/problem.js'
import type { SessionRequest } from '../auth/auth.types.js'

// À placer APRÈS SessionGuard : exige une session de type admin.
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<SessionRequest>()
    if (!req.authAdmin) {
      throw new ForbiddenException(problem(403, ProblemType.forbidden, 'Forbidden', { detail: 'Super admin only' }))
    }
    return true
  }
}
```

- [ ] **Step 3 : `AdminController` + `AdminModule`**

`apps/api/src/admin/admin.controller.ts` :
```ts
import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Throttle } from '@nestjs/throttler'
import type { Response } from 'express'
import { z } from 'zod'
import type { EnvConfig } from '../config/env.js'
import type { SessionRequest } from '../auth/auth.types.js'
import { csrfCookieOptions, sessionCookieOptions } from '../auth/cookie.js'
import { CSRF_COOKIE, SESSION_COOKIE } from '../auth/session-token.js'
import { SessionGuard } from '../auth/session.guard.js'
import { SessionService } from '../auth/session.service.js'
import { parseBody } from '../common/validation.js'
import { AdminGuard } from './admin.guard.js'
import { AdminService } from './admin.service.js'

const loginSchema = z.object({ email: z.email(), password: z.string().min(1).max(200) })

@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly sessions: SessionService,
    private readonly config: ConfigService<EnvConfig, true>,
  ) {}

  @Post('login')
  @HttpCode(200)
  @Throttle({ default: { ttl: 900_000, limit: 10 } })
  async login(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const input = parseBody(loginSchema, body)
    const { adminId } = await this.admin.login(input.email, input.password)
    const session = await this.sessions.create({ adminId })
    const maxAge = this.sessions.ttlMs()
    res.cookie(SESSION_COOKIE, session.token, sessionCookieOptions(this.config, maxAge))
    res.cookie(CSRF_COOKIE, session.csrfToken, csrfCookieOptions(this.config, maxAge))
    return { admin: { id: adminId, email: input.email } }
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(SessionGuard, AdminGuard)
  async logout(@Req() req: SessionRequest, @Res({ passthrough: true }) res: Response): Promise<void> {
    const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE]
    if (token) await this.sessions.revoke(token)
    res.clearCookie(SESSION_COOKIE, sessionCookieOptions(this.config, 0))
    res.clearCookie(CSRF_COOKIE, csrfCookieOptions(this.config, 0))
  }

  @Get('tenants')
  @UseGuards(SessionGuard, AdminGuard)
  listTenants() {
    return this.admin.listTenants()
  }
}
```

`apps/api/src/admin/admin.module.ts` :
```ts
import { Module } from '@nestjs/common'
import { UsersModule } from '../users/users.module.js'
import { AdminController } from './admin.controller.js'
import { AdminGuard } from './admin.guard.js'
import { AdminService } from './admin.service.js'

@Module({
  imports: [UsersModule], // SessionService/SessionGuard
  controllers: [AdminController],
  providers: [AdminService, AdminGuard],
})
export class AdminModule {}
```

Ajouter `AdminModule` aux imports de `app.module.ts`.

- [ ] **Step 4 : Script de provisioning du 1er admin**

`apps/api/scripts/provision-admin.ts` (calqué sur `provision-tenant.ts`, rôle **owner**) :
```ts
import pg from 'pg'
import { hashPassword } from '../src/auth/password.js'

async function main(): Promise<void> {
  const [email, password] = process.argv.slice(2)
  if (!email || !password) throw new Error('usage: provision:admin <email> <password>')
  const ownerUrl = process.env.DATABASE_OWNER_URL
  if (!ownerUrl) throw new Error('DATABASE_OWNER_URL is required')
  const pool = new pg.Pool({ connectionString: ownerUrl })
  try {
    const hash = await hashPassword(password)
    const res = await pool.query(
      'INSERT INTO platform_admins (email, password_hash) VALUES ($1, $2) RETURNING id',
      [email, hash],
    )
    console.log(JSON.stringify({ adminId: res.rows[0].id, email }, null, 2))
  } finally {
    await pool.end()
  }
}

void main()
```
`apps/api/package.json` — ajouter au bloc `scripts` : `"provision:admin": "node --import tsx scripts/provision-admin.ts"`.

- [ ] **Step 5 : Verdir puis vérifier l'ensemble et committer**

Run: `pnpm --filter @factelec/api test -- admin`
Expected: PASS (5 cas). Puis :
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): super admin minimal (login, liste des tenants) + provisioning CLI"
```

---
### Task 7 : Lecture des factures en dual-auth (clé API **ou** session) — l'ingestion reste machine-only

> **Pourquoi** : `GET /invoices*` est protégé par `ApiKeyGuard` (auth machine, 1.3). Le dashboard porte une **session**, pas une clé — et on **n'expose jamais** de clé au navigateur. On autorise donc la **lecture** des factures par une clé API **ou** une session utilisateur du **même tenant**. `POST /invoices` (ingestion) **reste** exclusivement clé API (conforme au cadrage : pas de création via l'UI en 1.4).

**Files:**
- Create: `apps/api/src/auth/tenant-auth.guard.ts`
- Modify: `apps/api/src/invoices/invoices.controller.ts` (guards par méthode), `apps/api/src/invoices/invoices.module.ts` (import UsersModule)
- Create: `apps/api/tests/e2e/invoices-session-read.e2e.test.ts`

**Interfaces:**
- Consumes: `ApiKeyService` (AuthModule, exporté), `SessionService` (UsersModule, exporté), `TenantRequest`/`SessionRequest`, `problem`.
- Produces : `TenantAuthGuard` — autorise si (a) `Authorization: Bearer <clé>` valide **ou** (b) cookie de session **utilisateur** valide ; pose `req.tenantId` dans les deux cas (et `req.apiKeyId`/`req.authUser` selon le cas). Une session **admin** (sans tenant) est refusée (401). `@CurrentTenant` fonctionne inchangé.

- [ ] **Step 1 : Écrire l'e2e (échoue)**

`apps/api/tests/e2e/invoices-session-read.e2e.test.ts` :
```ts
import type { INestApplication } from '@nestjs/common'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashPassword } from '../../src/auth/password.js'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { signupSession, type Session } from './helpers/session.js'

async function seedInvoice(ownerPool: pg.Pool, tenantId: string, number: string): Promise<string> {
  const inv = await ownerPool.query(
    `INSERT INTO invoices (tenant_id, number, type_code, issue_date, currency, canonical)
     VALUES ($1, $2, '380', '2026-07-13', 'EUR', '{}'::jsonb) RETURNING id`,
    [tenantId, number],
  )
  const id = inv.rows[0].id
  await ownerPool.query(
    `INSERT INTO invoice_formats (tenant_id, invoice_id, kind, content_type, body_text, byte_size)
     VALUES ($1, $2, 'ubl', 'application/xml', '<Invoice/>', 10)`,
    [tenantId, id],
  )
  return id
}

describe('invoices read via session (e2e)', () => {
  let db: TestDb
  let app: INestApplication
  let ownerPool: pg.Pool
  let sessA: Session
  let tenantA: string
  let invoiceA: string

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    app = await createTestApp(db.appUrl)
    sessA = await signupSession(app, { email: 'a@shop.example', password: 'passphrase-aaaaaa-1', organizationName: 'Shop A', siren: null })
    tenantA = (await ownerPool.query('SELECT tenant_id FROM authenticate_user($1)', ['a@shop.example'])).rows[0].tenant_id
    invoiceA = await seedInvoice(ownerPool, tenantA, 'FA-A-1')
  })
  afterAll(async () => {
    await app.close()
    await ownerPool.end()
    await db.stop()
  })

  it('a user session lists and reads its tenant invoices', async () => {
    const list = await request(app.getHttpServer()).get('/invoices').set('Cookie', sessA.cookie).expect(200)
    expect(list.body.items.map((i: { number: string }) => i.number)).toContain('FA-A-1')
    await request(app.getHttpServer()).get(`/invoices/${invoiceA}`).set('Cookie', sessA.cookie).expect(200)
  })

  it('a user session downloads a format', async () => {
    const res = await request(app.getHttpServer())
      .get(`/invoices/${invoiceA}/formats/ubl`)
      .set('Cookie', sessA.cookie)
      .expect(200)
    expect(res.headers['content-type']).toContain('application/xml')
  })

  it('ingestion (POST /invoices) still requires an API key, not a session', async () => {
    await request(app.getHttpServer()).post('/invoices').set('Cookie', sessA.cookie).send({}).expect(401)
  })

  it('an admin session cannot read tenant invoices (401)', async () => {
    const hash = await hashPassword('super-admin-passphrase-1')
    await ownerPool.query("INSERT INTO platform_admins (email, password_hash) VALUES ('root@factelec.fr', $1)", [hash])
    const login = await request(app.getHttpServer())
      .post('/admin/login')
      .send({ email: 'root@factelec.fr', password: 'super-admin-passphrase-1' })
      .expect(200)
    const adminCookie = login.headers['set-cookie'] as unknown as string[]
    await request(app.getHttpServer()).get('/invoices').set('Cookie', adminCookie).expect(401)
  })

  it('isolates tenants: B cannot read A invoice (404)', async () => {
    const sessB = await signupSession(app, { email: 'b@shop.example', password: 'passphrase-bbbbbb-1', organizationName: 'Shop B', siren: null })
    await request(app.getHttpServer()).get(`/invoices/${invoiceA}`).set('Cookie', sessB.cookie).expect(404)
  })
})
```

Run: `pnpm --filter @factelec/api test -- invoices-session-read`
Expected: FAIL — `TenantAuthGuard` absent (les GET renvoient 401 sur cookie).

- [ ] **Step 2 : Implémenter `TenantAuthGuard`**

`apps/api/src/auth/tenant-auth.guard.ts` :
```ts
import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
import { problem, ProblemType } from '../common/problem.js'
import type { SessionRequest } from './auth.types.js'
import { ApiKeyService } from './api-key.service.js'
import { SESSION_COOKIE } from './session-token.js'
import { SessionService } from './session.service.js'

const BEARER_RE = /^Bearer\s+(.+)$/i

// Lecture tenant : clé API (machine) OU session utilisateur (dashboard). Admin refusé.
@Injectable()
export class TenantAuthGuard implements CanActivate {
  constructor(
    private readonly apiKeys: ApiKeyService,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<SessionRequest>()
    const deny = () =>
      new UnauthorizedException(
        problem(401, ProblemType.unauthorized, 'Unauthorized', { detail: 'Missing or invalid credentials' }),
      )

    const bearer = req.header('authorization')?.match(BEARER_RE)
    if (bearer?.[1]) {
      const key = await this.apiKeys.authenticate(bearer[1])
      if (!key) throw deny()
      req.tenantId = key.tenantId
      req.apiKeyId = key.apiKeyId
      return true
    }

    const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE]
    if (token) {
      const subject = await this.sessions.find(token)
      if (subject?.userId && subject.tenantId) {
        req.authUser = {
          sessionId: subject.sessionId,
          userId: subject.userId,
          tenantId: subject.tenantId,
          role: subject.role ?? 'viewer',
          csrfHash: subject.csrfHash,
        }
        req.tenantId = subject.tenantId
        return true
      }
    }
    throw deny()
  }
}
```
> `SessionRequest` étend `Request` avec `tenantId?` et `apiKeyId?` — ajouter `apiKeyId?: string` à `auth.types.ts` (déjà présent sur `TenantRequest` en 1.3 ; on l'aligne). Vérifier l'import : `ApiKeyService` vient de `./api-key.service.js`.

- [ ] **Step 3 : Guards par méthode dans le contrôleur factures**

`apps/api/src/invoices/invoices.controller.ts` — retirer le `@UseGuards(ApiKeyGuard)` **de classe** et le poser **par méthode** : `POST` → `@UseGuards(ApiKeyGuard)` (inchangé, ingestion machine) ; `GET`, `GET :id`, `GET :id/formats/:format` → `@UseGuards(TenantAuthGuard)`. Importer `TenantAuthGuard`. `@CurrentTenant()` reste identique (posé par les deux guards).

`apps/api/src/invoices/invoices.module.ts` — importer `UsersModule` (pour `SessionService`) en plus de `AuthModule` (pour `ApiKeyService`), et ajouter `TenantAuthGuard` aux `providers`.

- [ ] **Step 4 : Verdir (+ non-régression 1.3)**

Run: `pnpm --filter @factelec/api test -- invoices`
Expected: PASS — nouveau fichier vert **et** `read.e2e`/`ingestion.e2e`/`tenant-isolation.e2e` de 1.3 toujours verts (la clé API fonctionne comme avant sur toutes les routes). Puis suite complète :
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): lecture des factures en dual-auth clé API/session (ingestion machine inchangée)"
```

---
### Task 8 : Socle `apps/web` — Next.js 16, client API typé, contexte de session, pages login/signup

**Files:**
- Create: `apps/web/package.json`, `apps/web/next.config.ts`, `apps/web/tsconfig.json`, `apps/web/vitest.config.ts`, `apps/web/.gitignore`, `apps/web/.env.example`, `apps/web/tests/setup.ts`
- Create: `apps/web/src/lib/api.ts`, `api-types.ts`, `client.ts`, `forms.ts`, `session-context.tsx`
- Create: `apps/web/src/components/login-form.tsx`, `signup-form.tsx`
- Create: `apps/web/src/app/layout.tsx`, `globals.css`, `(auth)/login/page.tsx`, `(auth)/signup/page.tsx`
- Create: `apps/web/tests/lib/api.test.ts`, `apps/web/tests/components/login-form.test.tsx`, `apps/web/tests/components/signup-form.test.tsx`

**Interfaces:**
- Produces (utilisé par Task 9) :
  - `apiFetch<T>(path, init?): Promise<T>` (credentials include, en-tête CSRF automatique sur mutations, parse `problem+json`), `class ApiError { problem: ApiProblem }`.
  - `authApi`, `invoicesApi`, `apiKeysApi`, `adminApi` (wrappers typés).
  - `SessionProvider`, `useSession(): { user, loading, refresh, logout }`.
  - Schémas zod `loginSchema`, `signupSchema`, `createKeySchema`.

- [ ] **Step 1 : Scaffolder le workspace**

`apps/web/package.json` :
```json
{
  "name": "@factelec/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "next dev -p 3001",
    "build": "next build",
    "start": "next start -p 3001",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --coverage",
    "test:watch": "vitest"
  },
  "dependencies": {
    "next": "16.2.10",
    "react": "19.2.7",
    "react-dom": "19.2.7",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@testing-library/dom": "10.4.1",
    "@testing-library/jest-dom": "6.9.1",
    "@testing-library/react": "16.3.2",
    "@testing-library/user-event": "14.6.1",
    "@types/react": "19.2.17",
    "@types/react-dom": "19.2.3",
    "@vitest/coverage-v8": "4.1.10",
    "jsdom": "29.1.1",
    "vitest": "4.1.10"
  }
}
```

`apps/web/next.config.ts` :
```ts
import type { NextConfig } from 'next'

const config: NextConfig = {
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: true }, // lint = Biome (racine), pas ESLint
}
export default config
```

`apps/web/tsconfig.json` (typecheck rapide via tsgo ; `next build` fait autorité pour les types de routes) :
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "esnext",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "noEmit": true,
    "allowJs": true,
    "incremental": true,
    "lib": ["dom", "dom.iterable", "esnext"],
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "src/**/*", "tests/**/*", ".next/types/**/*.ts"],
  "exclude": ["node_modules", ".next"]
}
```
> `.next/types` est inclus mais **vide tant qu'aucun build n'a tourné** (tsc n'échoue pas sur un glob vide). Nos pages utilisent `useParams()` (hook client), **pas** les types de routes générés → l'absence de `.next/types` est inoffensive au typecheck rapide.

`apps/web/vitest.config.ts` :
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' }, // transform TSX sans @vitejs/plugin-react
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/lib/**/*.{ts,tsx}', 'src/components/**/*.{ts,tsx}'],
      // Exclus : scaffolding Next, types purs, et wrappers HTTP sans branche
      // (client.ts = construction d'URL/corps, exercé par les e2e ultérieurs). Cf. D5.
      exclude: ['src/app/**', '**/*.d.ts', 'src/lib/api-types.ts', 'src/lib/client.ts'],
      thresholds: { lines: 90, functions: 90, statements: 90, branches: 90 },
    },
  },
})
```

`apps/web/.gitignore` :
```
.next/
coverage/
next-env.d.ts
.env
```

`apps/web/.env.example` :
```
NEXT_PUBLIC_API_BASE_URL=http://localhost:3000
```

`apps/web/tests/setup.ts` :
```ts
import '@testing-library/jest-dom/vitest'
```

- [ ] **Step 2 : Client API + types + wrappers**

`apps/web/src/lib/api.ts` :
```ts
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3000'

export interface ApiProblem {
  type: string
  title: string
  status: number
  detail?: string
  errors?: { path: string; message: string }[]
}

export class ApiError extends Error {
  constructor(readonly problem: ApiProblem) {
    super(problem.detail ?? problem.title)
    this.name = 'ApiError'
  }
}

function readCsrfCookie(): string | null {
  if (typeof document === 'undefined') return null
  const m = document.cookie.match(/(?:^|;\s*)factelec_csrf=([^;]+)/)
  return m ? decodeURIComponent(m[1]) : null
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase()
  const headers = new Headers(init.headers)
  if (init.body != null && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  if (method !== 'GET' && method !== 'HEAD') {
    const csrf = readCsrfCookie()
    if (csrf) headers.set('X-CSRF-Token', csrf) // double-submit CSRF
  }
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers, credentials: 'include' })
  if (res.status === 204) return undefined as T
  const isJson = res.headers.get('content-type')?.includes('json') ?? false
  const payload = isJson ? await res.json() : await res.text()
  if (!res.ok) {
    throw new ApiError(
      isJson && payload && typeof payload === 'object'
        ? (payload as ApiProblem)
        : { type: 'about:blank', title: 'Error', status: res.status },
    )
  }
  return payload as T
}
```

`apps/web/src/lib/api-types.ts` :
```ts
export type UserRole = 'owner' | 'admin' | 'accountant' | 'viewer'
export interface UserProfile { id: string; email: string; role: UserRole; tenantId: string; emailVerified: boolean }
export interface InvoiceSummary { id: string; number: string; typeCode: string; issueDate: string; currency: string; status: string; createdAt: string }
export interface InvoicePage { items: InvoiceSummary[]; nextCursor: string | null }
export interface InvoiceDetail extends InvoiceSummary { availableFormats: string[] }
export interface ApiKeyView { id: string; prefix: string; label: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }
export interface CreatedApiKey extends ApiKeyView { token: string }
export interface TenantOverview { id: string; name: string; siren: string | null; createdAt: string; userCount: number; invoiceCount: number }
```

`apps/web/src/lib/client.ts` :
```ts
import { API_BASE, apiFetch } from './api.js'
import type {
  ApiKeyView, CreatedApiKey, InvoiceDetail, InvoicePage, TenantOverview, UserProfile,
} from './api-types.js'

export const authApi = {
  me: () => apiFetch<{ user: UserProfile }>('/auth/me'),
  login: (email: string, password: string) =>
    apiFetch<{ user: UserProfile }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  signup: (input: { email: string; password: string; organizationName: string; siren: string | null }) =>
    apiFetch<{ user: UserProfile }>('/auth/signup', { method: 'POST', body: JSON.stringify(input) }),
  logout: () => apiFetch<void>('/auth/logout', { method: 'POST' }),
}

export const invoicesApi = {
  list: (cursor?: string | null) =>
    apiFetch<InvoicePage>(`/invoices${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),
  get: (id: string) => apiFetch<InvoiceDetail>(`/invoices/${id}`),
  formatUrl: (id: string, kind: string) => `${API_BASE}/invoices/${id}/formats/${kind}`,
}

export const apiKeysApi = {
  list: () => apiFetch<ApiKeyView[]>('/api-keys'),
  create: (label: string) => apiFetch<CreatedApiKey>('/api-keys', { method: 'POST', body: JSON.stringify({ label }) }),
  revoke: (id: string) => apiFetch<void>(`/api-keys/${id}`, { method: 'DELETE' }),
}

export const adminApi = {
  login: (email: string, password: string) =>
    apiFetch<{ admin: { id: string; email: string } }>('/admin/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  tenants: () => apiFetch<TenantOverview[]>('/admin/tenants'),
}
```

`apps/web/src/lib/forms.ts` :
```ts
import { z } from 'zod'

export const loginSchema = z.object({ email: z.email(), password: z.string().min(1) })

export const signupSchema = z.object({
  email: z.email(),
  password: z.string().min(12, 'Au moins 12 caractères'),
  organizationName: z.string().min(1, 'Nom requis'),
  siren: z
    .string()
    .regex(/^\d{9}$/, 'SIREN à 9 chiffres')
    .or(z.literal(''))
    .transform((v) => (v === '' ? null : v)),
})

export const createKeySchema = z.object({ label: z.string().min(1).max(100) })
```

- [ ] **Step 3 : Contexte de session**

`apps/web/src/lib/session-context.tsx` :
```tsx
'use client'
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { UserProfile } from './api-types.js'
import { authApi } from './client.js'

interface SessionState {
  user: UserProfile | null
  loading: boolean
  refresh: () => Promise<void>
  logout: () => Promise<void>
}

const SessionContext = createContext<SessionState | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setUser((await authApi.me()).user)
    } catch {
      setUser(null)
    } finally {
      setLoading(false)
    }
  }, [])

  const logout = useCallback(async () => {
    await authApi.logout()
    setUser(null)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const value = useMemo(() => ({ user, loading, refresh, logout }), [user, loading, refresh, logout])
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used within SessionProvider')
  return ctx
}
```

- [ ] **Step 4 : Formulaires login/signup (composants porteurs de logique)**

`apps/web/src/components/login-form.tsx` :
```tsx
'use client'
import { useRouter } from 'next/navigation'
import { type FormEvent, useState } from 'react'
import { ApiError } from '../lib/api.js'
import { authApi } from '../lib/client.js'
import { loginSchema } from '../lib/forms.js'
import { useSession } from '../lib/session-context.js'

export function LoginForm() {
  const router = useRouter()
  const { refresh } = useSession()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    const parsed = loginSchema.safeParse(Object.fromEntries(new FormData(e.currentTarget)))
    if (!parsed.success) {
      setError('Identifiants invalides')
      return
    }
    setPending(true)
    try {
      await authApi.login(parsed.data.email, parsed.data.password)
      await refresh()
      router.push('/invoices')
    } catch (err) {
      setError(err instanceof ApiError ? (err.problem.detail ?? 'Échec de connexion') : 'Erreur réseau')
    } finally {
      setPending(false)
    }
  }

  return (
    <form onSubmit={onSubmit} aria-label="Connexion">
      <label>
        Email<input name="email" type="email" required />
      </label>
      <label>
        Mot de passe<input name="password" type="password" required />
      </label>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={pending}>
        Se connecter
      </button>
    </form>
  )
}
```

`apps/web/src/components/signup-form.tsx` :
```tsx
'use client'
import { useRouter } from 'next/navigation'
import { type FormEvent, useState } from 'react'
import { ApiError } from '../lib/api.js'
import { authApi } from '../lib/client.js'
import { signupSchema } from '../lib/forms.js'
import { useSession } from '../lib/session-context.js'

export function SignupForm() {
  const router = useRouter()
  const { refresh } = useSession()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    const parsed = signupSchema.safeParse(Object.fromEntries(new FormData(e.currentTarget)))
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Formulaire invalide')
      return
    }
    setPending(true)
    try {
      await authApi.signup(parsed.data)
      await refresh()
      router.push('/invoices')
    } catch (err) {
      setError(err instanceof ApiError ? (err.problem.detail ?? "Échec de l'inscription") : 'Erreur réseau')
    } finally {
      setPending(false)
    }
  }

  return (
    <form onSubmit={onSubmit} aria-label="Inscription">
      <label>
        Email<input name="email" type="email" required />
      </label>
      <label>
        Mot de passe (≥ 12 caractères)<input name="password" type="password" required minLength={12} />
      </label>
      <label>
        Organisation<input name="organizationName" required />
      </label>
      <label>
        SIREN (optionnel)<input name="siren" inputMode="numeric" />
      </label>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={pending}>
        Créer mon compte
      </button>
    </form>
  )
}
```

- [ ] **Step 5 : Layout racine + pages auth (coques minces)**

`apps/web/src/app/globals.css` : un reset minimal (body font-family system, max-width container). Contenu libre, non testé.

`apps/web/src/app/layout.tsx` :
```tsx
import type { ReactNode } from 'react'
import { SessionProvider } from '../lib/session-context.js'
import './globals.css'

export const metadata = { title: 'Factelec — Dashboard' }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body>
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  )
}
```

`apps/web/src/app/(auth)/login/page.tsx` :
```tsx
import { LoginForm } from '../../../components/login-form.js'

export default function LoginPage() {
  return (
    <main>
      <h1>Connexion</h1>
      <LoginForm />
      <a href="/signup">Créer un compte</a>
    </main>
  )
}
```

`apps/web/src/app/(auth)/signup/page.tsx` :
```tsx
import { SignupForm } from '../../../components/signup-form.js'

export default function SignupPage() {
  return (
    <main>
      <h1>Créer un compte</h1>
      <SignupForm />
      <a href="/login">J'ai déjà un compte</a>
    </main>
  )
}
```

- [ ] **Step 6 : Écrire les tests (échouent puis passent)**

`apps/web/tests/lib/api.test.ts` :
```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, apiFetch } from '../../src/lib/api.js'

function mockFetch(res: Partial<Response> & { jsonBody?: unknown }) {
  return vi.fn().mockResolvedValue({
    ok: res.ok ?? true,
    status: res.status ?? 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => res.jsonBody ?? {},
    text: async () => JSON.stringify(res.jsonBody ?? {}),
  } as Response)
}

describe('apiFetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    document.cookie = 'factelec_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT'
  })

  it('sends credentials and adds the CSRF header on mutations from the cookie', async () => {
    document.cookie = 'factelec_csrf=csrf-abc'
    const f = mockFetch({ jsonBody: { ok: true } })
    vi.stubGlobal('fetch', f)
    await apiFetch('/api-keys', { method: 'POST', body: JSON.stringify({ label: 'x' }) })
    const [, init] = f.mock.calls[0]
    expect(init.credentials).toBe('include')
    expect((init.headers as Headers).get('X-CSRF-Token')).toBe('csrf-abc')
    expect((init.headers as Headers).get('Content-Type')).toBe('application/json')
  })

  it('does not add CSRF header on GET', async () => {
    document.cookie = 'factelec_csrf=csrf-abc'
    const f = mockFetch({ jsonBody: { items: [] } })
    vi.stubGlobal('fetch', f)
    await apiFetch('/invoices')
    expect((f.mock.calls[0][1].headers as Headers).get('X-CSRF-Token')).toBeNull()
  })

  it('throws ApiError carrying the problem+json body on non-2xx', async () => {
    vi.stubGlobal('fetch', mockFetch({ ok: false, status: 401, jsonBody: { type: 'urn:factelec:problem:unauthorized', title: 'Unauthorized', status: 401, detail: 'Invalid credentials' } }))
    await expect(apiFetch('/auth/me')).rejects.toMatchObject({ problem: { status: 401, detail: 'Invalid credentials' } })
    await expect(apiFetch('/auth/me')).rejects.toBeInstanceOf(ApiError)
  })

  it('returns undefined on 204', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 204, headers: new Headers() } as Response))
    expect(await apiFetch('/auth/logout', { method: 'POST' })).toBeUndefined()
  })
})
```

`apps/web/tests/components/login-form.test.tsx` :
```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LoginForm } from '../../src/components/login-form.js'
import { SessionProvider } from '../../src/lib/session-context.js'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

function mockFetchSequence(handlers: Array<() => Response>) {
  let i = 0
  return vi.fn().mockImplementation(() => Promise.resolve(handlers[Math.min(i++, handlers.length - 1)]()))
}
const meUnauthed = () => ({ ok: false, status: 401, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ status: 401, title: 'Unauthorized', type: 'x' }), text: async () => '' }) as Response

describe('LoginForm', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    push.mockClear()
  })

  it('shows an error when credentials are rejected', async () => {
    // 1er appel : /auth/me du provider (401) ; 2e : /auth/login (401)
    vi.stubGlobal('fetch', mockFetchSequence([meUnauthed, () => ({ ok: false, status: 401, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ status: 401, title: 'Unauthorized', type: 'x', detail: 'Invalid credentials' }), text: async () => '' }) as Response]))
    render(<SessionProvider><LoginForm /></SessionProvider>)
    await userEvent.type(screen.getByLabelText(/email/i), 'user@ex.com')
    await userEvent.type(screen.getByLabelText(/mot de passe/i), 'a-strong-passphrase-1')
    await userEvent.click(screen.getByRole('button', { name: /se connecter/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid credentials')
    expect(push).not.toHaveBeenCalled()
  })

  it('navigates to /invoices on success', async () => {
    const ok = () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ user: { id: '1', email: 'u@ex.com', role: 'owner', tenantId: 't', emailVerified: false } }), text: async () => '' }) as Response
    vi.stubGlobal('fetch', mockFetchSequence([meUnauthed, ok, ok])) // me(401), login(200), refresh me(200)
    render(<SessionProvider><LoginForm /></SessionProvider>)
    await userEvent.type(screen.getByLabelText(/email/i), 'u@ex.com')
    await userEvent.type(screen.getByLabelText(/mot de passe/i), 'a-strong-passphrase-1')
    await userEvent.click(screen.getByRole('button', { name: /se connecter/i }))
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith('/invoices'))
  })
})
```

`apps/web/tests/components/signup-form.test.tsx` :
```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SignupForm } from '../../src/components/signup-form.js'
import { SessionProvider } from '../../src/lib/session-context.js'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
const me401 = () => ({ ok: false, status: 401, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ status: 401, title: 'x', type: 'x' }), text: async () => '' }) as Response
const created = () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ user: { id: '1', email: 'o@ex.com', role: 'owner', tenantId: 't', emailVerified: false } }), text: async () => '' }) as Response

describe('SignupForm', () => {
  afterEach(() => { vi.unstubAllGlobals(); push.mockClear() })

  it('validates the password client-side before calling the API', async () => {
    const f = vi.fn().mockImplementation(() => Promise.resolve(me401()))
    vi.stubGlobal('fetch', f)
    render(<SessionProvider><SignupForm /></SessionProvider>)
    await userEvent.type(screen.getByLabelText(/email/i), 'o@ex.com')
    await userEvent.type(screen.getByLabelText(/mot de passe/i), 'short')
    await userEvent.type(screen.getByLabelText(/organisation/i), 'Ma Boutique')
    await userEvent.click(screen.getByRole('button', { name: /créer mon compte/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/12 caractères/i)
    // Aucune requête signup émise (seul le /auth/me du provider a pu partir).
    expect(f.mock.calls.every(([url]) => !String(url).includes('/auth/signup'))).toBe(true)
  })

  it('signs up and navigates to /invoices', async () => {
    let i = 0
    const handlers = [me401, created, created] // me(401), signup(200), refresh me(200)
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(handlers[Math.min(i++, 2)]())))
    render(<SessionProvider><SignupForm /></SessionProvider>)
    await userEvent.type(screen.getByLabelText(/email/i), 'o@ex.com')
    await userEvent.type(screen.getByLabelText(/mot de passe/i), 'a-strong-passphrase-1')
    await userEvent.type(screen.getByLabelText(/organisation/i), 'Ma Boutique')
    await userEvent.click(screen.getByRole('button', { name: /créer mon compte/i }))
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith('/invoices'))
  })
})
```

Run: `pnpm install && pnpm --filter @factelec/web test`
Expected: après implémentation, PASS. Couverture `src/lib/**` + `src/components/**` (hors exclusions) ≥ 90 sur les 4 métriques.

- [ ] **Step 7 : Générer `next-env.d.ts`, typecheck (verdict tsgo/Next), committer**

```bash
pnpm --filter @factelec/web build   # génère next-env.d.ts + valide les types de routes (autorité)
pnpm --filter @factelec/web typecheck
```
> **Point de risque n°5 — validation tsgo** : si `pnpm --filter @factelec/web typecheck` (tsgo 7.0.2) échoue sur les types JSX/React 19 ou `moduleResolution: bundler`, appliquer le repli documenté : ajouter `typescript@5.9.x` en devDependency **exacte** de `apps/web` uniquement (le pin racine 7.0.2 est inchangé), et consigner la décision dans `apps/web/README.md` (Task 10). `next build` reste l'autorité de typage des routes.

```bash
pnpm format && pnpm lint && pnpm --filter @factelec/web test
git add -A
git commit -m "feat(web): socle Next.js 16 (client API, contexte de session, pages login/signup)"
```

---
### Task 9 : Pages du dashboard — factures (keyset), détail + formats, clés API, tenants (super admin)

**Files:**
- Create: `apps/web/src/components/require-auth.tsx`, `invoices-table.tsx`, `invoice-detail.tsx`, `api-keys-manager.tsx`, `tenants-table.tsx`
- Create: `apps/web/src/app/(app)/layout.tsx`, `(app)/invoices/page.tsx`, `(app)/invoices/[id]/page.tsx`, `(app)/api-keys/page.tsx`, `(admin)/tenants/page.tsx`
- Create: `apps/web/tests/components/invoices-table.test.tsx`, `api-keys-manager.test.tsx`, `misc-components.test.tsx`

**Interfaces:**
- Consumes: `invoicesApi`, `apiKeysApi`, `adminApi`, `useSession` (Task 8).
- Produces : composants `RequireAuth`, `InvoicesTable` (pagination keyset « charger plus »), `InvoiceDetail` (via `useParams`), `ApiKeysManager` (secret révélé **une fois**), `TenantsTable`.

- [ ] **Step 1 : Écrire les tests de composants (échouent)**

`apps/web/tests/components/invoices-table.test.tsx` :
```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InvoicesTable } from '../../src/components/invoices-table.js'

vi.mock('../../src/lib/client.js', () => ({ invoicesApi: { list: vi.fn() } }))
const { invoicesApi } = await import('../../src/lib/client.js')

describe('InvoicesTable', () => {
  afterEach(() => vi.clearAllMocks())

  it('loads the first page and appends the next via keyset cursor', async () => {
    vi.mocked(invoicesApi.list)
      .mockResolvedValueOnce({ items: [{ id: '1', number: 'FA-1', typeCode: '380', issueDate: '2026-07-01', currency: 'EUR', status: 'generated', createdAt: 'x' }], nextCursor: 'c1' })
      .mockResolvedValueOnce({ items: [{ id: '2', number: 'FA-2', typeCode: '380', issueDate: '2026-07-02', currency: 'EUR', status: 'generated', createdAt: 'y' }], nextCursor: null })
    render(<InvoicesTable />)
    expect(await screen.findByText('FA-1')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /charger plus/i }))
    expect(await screen.findByText('FA-2')).toBeInTheDocument()
    expect(invoicesApi.list).toHaveBeenNthCalledWith(2, 'c1')
    expect(screen.queryByRole('button', { name: /charger plus/i })).toBeNull() // nextCursor null → bouton disparaît
  })
})
```

`apps/web/tests/components/api-keys-manager.test.tsx` :
```tsx
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiKeysManager } from '../../src/components/api-keys-manager.js'

vi.mock('../../src/lib/client.js', () => ({
  apiKeysApi: { list: vi.fn(), create: vi.fn(), revoke: vi.fn() },
}))
const { apiKeysApi } = await import('../../src/lib/client.js')

describe('ApiKeysManager', () => {
  afterEach(() => vi.clearAllMocks())

  it('reveals the freshly created secret ONCE and never lists it', async () => {
    vi.mocked(apiKeysApi.list)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'k1', prefix: 'abc123', label: 'prod', createdAt: 'x', lastUsedAt: null, revokedAt: null }])
    vi.mocked(apiKeysApi.create).mockResolvedValue({ id: 'k1', prefix: 'abc123', label: 'prod', createdAt: 'x', lastUsedAt: null, revokedAt: null, token: 'fk_abc123.SECRET' })
    render(<ApiKeysManager />)
    await userEvent.type(screen.getByLabelText(/libellé/i), 'prod')
    await userEvent.click(screen.getByRole('button', { name: /créer/i }))
    const banner = await screen.findByTestId('fresh-token')
    expect(within(banner).getByText('fk_abc123.SECRET')).toBeInTheDocument()
    // La ligne listée n'expose que le préfixe, jamais le secret.
    const item = await screen.findByText(/abc123… — prod/)
    expect(item).toBeInTheDocument()
    expect(screen.getAllByText('fk_abc123.SECRET')).toHaveLength(1) // uniquement dans la bannière
  })

  it('revokes a key and refreshes', async () => {
    vi.mocked(apiKeysApi.list)
      .mockResolvedValueOnce([{ id: 'k1', prefix: 'abc123', label: 'prod', createdAt: 'x', lastUsedAt: null, revokedAt: null }])
      .mockResolvedValueOnce([{ id: 'k1', prefix: 'abc123', label: 'prod', createdAt: 'x', lastUsedAt: null, revokedAt: 'now' }])
    vi.mocked(apiKeysApi.revoke).mockResolvedValue(undefined)
    render(<ApiKeysManager />)
    await userEvent.click(await screen.findByRole('button', { name: /révoquer/i }))
    expect(apiKeysApi.revoke).toHaveBeenCalledWith('k1')
    expect(await screen.findByText(/révoquée/i)).toBeInTheDocument()
  })
})
```

`apps/web/tests/components/misc-components.test.tsx` (couvre `InvoiceDetail`, `TenantsTable`, `RequireAuth` + les deux branches de `session-context`) :
```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { InvoiceDetail } from '../../src/components/invoice-detail.js'
import { RequireAuth } from '../../src/components/require-auth.js'
import { TenantsTable } from '../../src/components/tenants-table.js'
import { SessionProvider } from '../../src/lib/session-context.js'

const replace = vi.fn()
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'inv-1' }),
  useRouter: () => ({ replace, push: vi.fn() }),
}))
vi.mock('../../src/lib/client.js', () => ({
  invoicesApi: { get: vi.fn(), formatUrl: (id: string, k: string) => `http://api/invoices/${id}/formats/${k}` },
  adminApi: { tenants: vi.fn() },
  authApi: { me: vi.fn(), logout: vi.fn() },
}))
const client = await import('../../src/lib/client.js')

describe('InvoiceDetail', () => {
  it('renders fields and format download links', async () => {
    vi.mocked(client.invoicesApi.get).mockResolvedValue({ id: 'inv-1', number: 'FA-9', typeCode: '380', issueDate: '2026-07-01', currency: 'EUR', status: 'generated', availableFormats: ['ubl', 'facturx'] })
    render(<InvoiceDetail />)
    expect(await screen.findByRole('heading', { name: 'FA-9' })).toBeInTheDocument()
    expect(await screen.findByRole('link', { name: 'ubl' })).toHaveAttribute('href', 'http://api/invoices/inv-1/formats/ubl')
  })
})

describe('TenantsTable', () => {
  it('lists tenants for an admin', async () => {
    vi.mocked(client.adminApi.tenants).mockResolvedValue([{ id: 't1', name: 'Shop A', siren: null, createdAt: 'x', userCount: 2, invoiceCount: 5 }])
    render(<TenantsTable />)
    expect(await screen.findByText('Shop A')).toBeInTheDocument()
  })
  it('shows an error when access is denied', async () => {
    vi.mocked(client.adminApi.tenants).mockRejectedValue(new Error('403'))
    render(<TenantsTable />)
    expect(await screen.findByRole('alert')).toHaveTextContent(/refusé/i)
  })
})

describe('RequireAuth', () => {
  it('redirects to /login when unauthenticated', async () => {
    vi.mocked(client.authApi.me).mockRejectedValue(new Error('401'))
    render(<SessionProvider><RequireAuth><p>secret</p></RequireAuth></SessionProvider>)
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login'))
    expect(screen.queryByText('secret')).toBeNull()
  })
  it('renders children when authenticated', async () => {
    vi.mocked(client.authApi.me).mockResolvedValue({ user: { id: '1', email: 'u@ex.com', role: 'owner', tenantId: 't', emailVerified: false } })
    render(<SessionProvider><RequireAuth><p>secret</p></RequireAuth></SessionProvider>)
    expect(await screen.findByText('secret')).toBeInTheDocument()
  })
})
```

Run: `pnpm --filter @factelec/web test -- invoices-table api-keys-manager misc-components`
Expected: FAIL — composants absents.

- [ ] **Step 2 : `RequireAuth` + `InvoicesTable`**

`apps/web/src/components/require-auth.tsx` :
```tsx
'use client'
import { useRouter } from 'next/navigation'
import { type ReactNode, useEffect } from 'react'
import { useSession } from '../lib/session-context.js'

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useSession()
  const router = useRouter()
  useEffect(() => {
    if (!loading && !user) router.replace('/login')
  }, [loading, user, router])
  if (loading) return <p>Chargement…</p>
  if (!user) return null
  return <>{children}</>
}
```

`apps/web/src/components/invoices-table.tsx` :
```tsx
'use client'
import { useCallback, useEffect, useState } from 'react'
import type { InvoiceSummary } from '../lib/api-types.js'
import { invoicesApi } from '../lib/client.js'

export function InvoicesTable() {
  const [items, setItems] = useState<InvoiceSummary[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (c: string | null) => {
    try {
      const page = await invoicesApi.list(c)
      setItems((prev) => (c ? [...prev, ...page.items] : page.items))
      setCursor(page.nextCursor)
      setDone(page.nextCursor === null)
    } catch {
      setError('Chargement impossible')
    }
  }, [])

  useEffect(() => {
    void load(null)
  }, [load])

  return (
    <section>
      <table>
        <thead>
          <tr><th>Numéro</th><th>Type</th><th>Date</th><th>Statut</th></tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.id}>
              <td><a href={`/invoices/${i.id}`}>{i.number}</a></td>
              <td>{i.typeCode}</td>
              <td>{i.issueDate}</td>
              <td>{i.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {error && <p role="alert">{error}</p>}
      {!done && (
        <button type="button" onClick={() => void load(cursor)}>
          Charger plus
        </button>
      )}
    </section>
  )
}
```

- [ ] **Step 3 : `ApiKeysManager`, `InvoiceDetail`, `TenantsTable`**

`apps/web/src/components/api-keys-manager.tsx` :
```tsx
'use client'
import { type FormEvent, useCallback, useEffect, useState } from 'react'
import type { ApiKeyView } from '../lib/api-types.js'
import { apiKeysApi } from '../lib/client.js'

export function ApiKeysManager() {
  const [keys, setKeys] = useState<ApiKeyView[]>([])
  const [freshToken, setFreshToken] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setKeys(await apiKeysApi.list())
    } catch {
      setError('Chargement impossible')
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function onCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const label = String(new FormData(e.currentTarget).get('label') ?? '').trim()
    if (!label) return
    setError(null)
    try {
      const created = await apiKeysApi.create(label)
      setFreshToken(created.token) // révélé une seule fois
      await refresh()
    } catch {
      setError('Création impossible')
    }
  }

  async function onRevoke(id: string) {
    try {
      await apiKeysApi.revoke(id)
      await refresh()
    } catch {
      setError('Révocation impossible')
    }
  }

  return (
    <section>
      <form onSubmit={onCreate} aria-label="Nouvelle clé API">
        <label>
          Libellé<input name="label" required />
        </label>
        <button type="submit">Créer</button>
      </form>
      {freshToken && (
        <div role="alert" data-testid="fresh-token">
          <p>Copiez ce secret maintenant — il ne sera plus jamais affiché :</p>
          <code>{freshToken}</code>
          <button type="button" onClick={() => setFreshToken(null)}>
            J'ai copié
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      <ul>
        {keys.map((k) => (
          <li key={k.id}>
            <span>
              {k.prefix}… — {k.label}
            </span>
            {k.revokedAt ? (
              <em> (révoquée)</em>
            ) : (
              <button type="button" onClick={() => void onRevoke(k.id)}>
                Révoquer
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
```

`apps/web/src/components/invoice-detail.tsx` :
```tsx
'use client'
import { useParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import type { InvoiceDetail as Detail } from '../lib/api-types.js'
import { invoicesApi } from '../lib/client.js'

export function InvoiceDetail() {
  const params = useParams<{ id: string }>()
  const [invoice, setInvoice] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    invoicesApi.get(params.id).then(setInvoice).catch(() => setError('Facture introuvable'))
  }, [params.id])

  if (error) return <p role="alert">{error}</p>
  if (!invoice) return <p>Chargement…</p>
  return (
    <article>
      <h1>{invoice.number}</h1>
      <dl>
        <dt>Type</dt><dd>{invoice.typeCode}</dd>
        <dt>Date</dt><dd>{invoice.issueDate}</dd>
        <dt>Devise</dt><dd>{invoice.currency}</dd>
        <dt>Statut</dt><dd>{invoice.status}</dd>
      </dl>
      <h2>Formats disponibles</h2>
      <ul>
        {invoice.availableFormats.map((f) => (
          <li key={f}>
            <a href={invoicesApi.formatUrl(invoice.id, f)}>{f}</a>
          </li>
        ))}
      </ul>
    </article>
  )
}
```
> **Téléchargement** : les liens de format pointent vers l'API (`GET /invoices/:id/formats/:kind`). Le cookie de session `SameSite=Lax` **est** envoyé sur une navigation top-level GET → l'endpoint dual-auth (Task 7) autorise la session. (Amélioration ultérieure : `Content-Disposition: attachment` côté API pour forcer le nom de fichier.)

`apps/web/src/components/tenants-table.tsx` :
```tsx
'use client'
import { useEffect, useState } from 'react'
import type { TenantOverview } from '../lib/api-types.js'
import { adminApi } from '../lib/client.js'

export function TenantsTable() {
  const [tenants, setTenants] = useState<TenantOverview[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    adminApi.tenants().then(setTenants).catch(() => setError('Accès refusé'))
  }, [])
  if (error) return <p role="alert">{error}</p>
  return (
    <table>
      <thead>
        <tr><th>Nom</th><th>SIREN</th><th>Utilisateurs</th><th>Factures</th></tr>
      </thead>
      <tbody>
        {tenants.map((t) => (
          <tr key={t.id}>
            <td>{t.name}</td><td>{t.siren ?? '—'}</td><td>{t.userCount}</td><td>{t.invoiceCount}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
```

- [ ] **Step 4 : Layout `(app)` + pages (coques minces)**

`apps/web/src/app/(app)/layout.tsx` :
```tsx
'use client'
import type { ReactNode } from 'react'
import { RequireAuth } from '../../components/require-auth.js'
import { useSession } from '../../lib/session-context.js'

export default function AppLayout({ children }: { children: ReactNode }) {
  const { logout } = useSession()
  return (
    <RequireAuth>
      <nav>
        <a href="/invoices">Factures</a> <a href="/api-keys">Clés API</a>{' '}
        <button type="button" onClick={() => void logout()}>Déconnexion</button>
      </nav>
      {children}
    </RequireAuth>
  )
}
```

`apps/web/src/app/(app)/invoices/page.tsx` :
```tsx
import { InvoicesTable } from '../../../components/invoices-table.js'

export default function InvoicesPage() {
  return (<main><h1>Factures</h1><InvoicesTable /></main>)
}
```

`apps/web/src/app/(app)/invoices/[id]/page.tsx` :
```tsx
import { InvoiceDetail } from '../../../../components/invoice-detail.js'

export default function InvoiceDetailPage() {
  return (<main><InvoiceDetail /></main>)
}
```

`apps/web/src/app/(app)/api-keys/page.tsx` :
```tsx
import { ApiKeysManager } from '../../../components/api-keys-manager.js'

export default function ApiKeysPage() {
  return (<main><h1>Clés API</h1><ApiKeysManager /></main>)
}
```

`apps/web/src/app/(admin)/tenants/page.tsx` (super admin — hors `(app)`, non gardé par `RequireAuth` ; l'API renvoie 403 si non-admin) :
```tsx
import { TenantsTable } from '../../../components/tenants-table.js'

export default function TenantsPage() {
  return (<main><h1>Tenants (super admin)</h1><TenantsTable /></main>)
}
```

- [ ] **Step 5 : Verdir puis vérifier et committer**

Run: `pnpm --filter @factelec/web test`
Expected: PASS. Couverture `src/lib/**` + `src/components/**` ≥ 90 sur les 4 métriques (les pages `src/app/**` sont exclues, D5). Puis :
```bash
pnpm --filter @factelec/web build && pnpm --filter @factelec/web typecheck
pnpm format && pnpm lint && pnpm --filter @factelec/web test
git add -A
git commit -m "feat(web): pages factures (keyset), détail/formats, clés API, tenants (super admin)"
```

---
### Task 10 : Intégration monorepo (CI, Biome), READMEs, point de reprise, différés

**Files:**
- Modify: `biome.json` (ignorer `.next`, `next-env.d.ts`)
- Modify: `.github/workflows/ci.yml` (commentaire + confirmation web dans la gate)
- Create: `apps/web/README.md`
- Modify: `apps/api/README.md` (nouveaux endpoints + env + dettes soldées), `README.md` racine (reprise + roadmap)
- Modify: `apps/api/package.json`, `apps/web/package.json` (bumps de version)

**Interfaces:** aucune (documentation + gate). Vérifie que **toute la gate passe workspace-wide**.

> **Portée** : l'essentiel de la CI fonctionne déjà via `pnpm -r` (lint/build/typecheck/test balaient tous les workspaces). Cette tâche verrouille les exclusions Biome, documente le verdict tsgo/Next réel, et acte les reports.

- [ ] **Step 1 : Exclusions Biome pour Next**

`biome.json` — étendre `files.includes` (générés Next, jamais linter/formatter) :
```json
  "files": {
    "includes": ["**", "!**/docs", "!**/dist", "!**/coverage", "!**/*.sef.json", "!**/.next", "!**/next-env.d.ts"]
  },
```
Run: `pnpm lint` → PASS (aucun fichier généré Next linté).

- [ ] **Step 2 : Vérifier la gate complète workspace-wide**

```bash
pnpm install
pnpm audit                 # 0 vulnérabilité (toutes sévérités) — cf. politique D7 si transitive Next
pnpm outdated -r           # vierge (toutes deps en dernière stable ce jour)
pnpm lint
pnpm build                 # invoice-core (tsc) + apps/api (swc) + apps/web (next build → génère next-env.d.ts)
pnpm typecheck             # invoice-core + apps/api + apps/web (tsgo 7.0.2 ; repli 5.9.x local apps/web si nécessaire, D6)
pnpm test                  # invoice-core (100 %) + apps/api (≥90 %, Testcontainers) + apps/web (jsdom, ≥90)
```
Expected: PASS partout. **Si `pnpm audit` remonte une transitive Next sans correctif** : appliquer la politique D7 (override si patch dispo ; sinon documenter + arbitrage Xavier — jamais de merge avec vuln exploitable). **Si `pnpm outdated -r` signale une dérive** (patch sorti depuis le 2026-07-13) : bumper au dernier stable et re-vérifier.

- [ ] **Step 3 : Mettre à jour la CI (clarté)**

`.github/workflows/ci.yml` — mettre à jour le commentaire de l'étape build et confirmer que web est couvert (aucune étape nouvelle requise, `pnpm -r` l'inclut) :
```yaml
      - run: pnpm build        # invoice-core (tsc) → apps/api (swc) → apps/web (next build), ordre topologique pnpm
      - run: pnpm typecheck     # apps/api + apps/web (tsc --noEmit tsgo ; next build fait autorité sur les types de routes)
      - run: pnpm test          # invoice-core + apps/api (Docker/Testcontainers) + apps/web (jsdom, sans Docker)
```
> Docker reste fourni nativement par le runner ubuntu (Testcontainers API). Les tests web n'exigent pas Docker. `next build` (étape build, **avant** typecheck) génère `next-env.d.ts` requis par le typecheck web.

- [ ] **Step 4 : `apps/web/README.md`**

Rédiger (concis, factuel — pièce potentielle du dossier) :
- **Rôle** : dashboard marchand + espace super admin minimal (Next.js 16 App Router, ESM, TypeScript strict).
- **Stack pinnée** : Next 16.2.10 / React 19.2.7 / zod 4.4.3 ; tests Vitest 4.1.10 + Testing Library + jsdom (transform TSX esbuild, **sans** `@vitejs/plugin-react`) ; lint Biome (racine).
- **Modèle d'auth** : SPA authentifiée par **session serveur httpOnly** (cookie `factelec_session`) posée par l'API ; **CSRF double-submit** (cookie lisible `factelec_csrf` → en-tête `X-CSRF-Token`) ; `credentials: 'include'` ; **aucun secret** stocké côté client ; le secret d'une clé API n'est **affiché qu'une fois** à sa création.
- **Lancement dev** : API (`pnpm --filter @factelec/api dev`, Postgres + rôles via docker-compose) puis `pnpm --filter @factelec/web dev` ; `NEXT_PUBLIC_API_BASE_URL` pointant sur l'API ; en prod, cookies `Domain=.factelec.fr` + sous-domaines same-site.
- **Tests & couverture** : composants/logique (`src/lib`, `src/components`) via Testing Library + `fetch`/`client` mockés ; **seuil 90 % sur les 4 métriques** (ruling contrôleur, D5), scaffolding Next exclu (liste bornée). **Playwright différé** (phase 5).
- **tsgo/Next** : consigner le **verdict réel** obtenu à la Task 8 step 7 (tsgo 7.0.2 OK **ou** repli `typescript@5.9.x` local à apps/web) ; `next build` fait autorité sur les types de routes.
- **Limites v1** : super admin minimal (liste des tenants) ; pas de SSR/RSC (SPA cliente) ; pas de création de facture via l'UI (ingestion = API).

- [ ] **Step 5 : `apps/api/README.md` (endpoints + env + dettes soldées)**

Compléter le tableau des endpoints avec : `POST /auth/signup` (201/409/422/429), `POST /auth/login` (200/401/422/429), `POST /auth/logout` (204/401), `GET /auth/me` (200/401), `POST /api-keys` (201/403), `GET /api-keys` (200/403), `DELETE /api-keys/:id` (204/403/404), `POST /admin/login` (200/401/429), `GET /admin/tenants` (200/401/403). Préciser : `GET /invoices*` accepte désormais **clé API OU session utilisateur** (même tenant) ; `POST /invoices` reste **clé API**. Documenter les nouvelles variables d'env (`SESSION_TTL_HOURS`, `SESSION_COOKIE_DOMAIN`) et le script `pnpm provision:admin <email> <password>`. Mentionner les dettes 1.3 **soldées** (`createDb` retiré ; `z.url()`). Bumper `apps/api` `0.1.0 → 0.2.0`.

- [ ] **Step 6 : `README.md` racine — reprise + différés explicites**

Mettre à jour le point de reprise :
- **Plan 1.4 TERMINÉ** : auth utilisateur (sessions httpOnly + CSRF), signup self-service transactionnel, gestion des clés API par session, super admin minimal, dashboard Next.js 16.
- **Différés actés** (avec phase cible) :
  - **BullMQ / workers** → **phase 2** (Cœur réglementaire) : pas de transmission/cycle de vie en 1.4 → aucune file nécessaire ; le port `InvoiceFormatGenerator` reste prêt (génération synchrone).
  - **Stripe / abonnements** → **phase 5** (Commercialisation, spec §8).
  - **Vérification email** différée (fournisseur transactionnel non provisionné) — colonne `email_verified` prête, non contraignante ; rate limit strict en compensation.
  - **Invitation de membres** + **appartenance multi-tenant** (table `memberships` M:N) différées (users mono-tenant en 1.4).
  - **Playwright e2e** → phase 5 (coût CI).
  - **Super admin complet** (impersonation tracée, feature flags, **MFA TOTP + allowlist IP**, supervision files/transmissions) → phase 5 (spec §6/§8).
  - **Pré-prod** : configurer `SESSION_COOKIE_DOMAIN` + `TRUST_PROXY` selon la topologie ; `SameSite`/cookies cross-subdomain.
  - **Horizon 2.x** : journal d'audit persistant à valeur probante (rappel 1.3).
- Roadmap : cocher 1.4, pointer 2.x (cycle de vie, scellement/archivage, e-reporting) et l'adaptateur BullMQ.

- [ ] **Step 7 : Vérifier et committer**

Run: `pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm test`
Expected: PASS partout (invoice-core 100 %, apps/api ≥ 90 %, apps/web ≥ 90), `pnpm audit` 0, `pnpm outdated -r` vierge.

```bash
git add -A
git commit -m "docs(1.4): READMEs web/api, exclusions Biome Next, point de reprise et différés"
```

---

## Auto-revue (couverture de la spec & cohérence)

- **Spec §2 (modèle commercial : abonnement self-service)** → signup self-service livré (Task 3/4) ; **Stripe différé phase 5** (acté). ✅ (partiel assumé, conforme phasage)
- **Spec §4.1 (Organization → Users, rôles ; super admin séparé)** → users tenant-scopés + rôles (Task 2/4/5) ; super admin global minimal (Task 6). ✅
- **Spec §6 (sécurité : clés hachées, RLS, moindre privilège, rate limit)** → Argon2id, RLS `FORCE`, SD, throttle auth (Tasks 2–6) ; **MFA/allowlist IP différés phase 5** (acté). ✅ (partiel assumé)
- **Spec §7 (TDD, Testcontainers, isolation multi-tenant)** → chaque endpoint API en e2e Postgres réel + isolation cross-tenant (Tasks 2,4,5,6,7). ✅
- **Spec §8 (phase 1 : dashboard marchand + espace super admin)** → dashboard Next.js (Tasks 8–9). ✅
- **Cadrage team-lead** : auth user (D1), user↔tenant (D2), stack web pinnée (versions), tests web + seuil (D5), tsgo/Next (D6), BullMQ/Stripe tranchés (Task 10 §reprise), dettes 1.3 (`createDb`, `z.url` Task 1). ✅
- **Cohérence des types** : `problem/ProblemType`, `runInTenant`, `TenantContextService.run`, `@CurrentTenant`, `generateApiKey`, `apiKeys`/`invoices` schema, curseur keyset — tous consommés avec les signatures 1.3 vérifiées. Nouveaux contrats (`AuthenticatedUser`, `SessionSubject`, `ApiKeyView`, `TenantOverview`, fonctions SD) définis en amont de leurs consommateurs.

