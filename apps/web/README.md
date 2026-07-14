# `@factelec/web`

Dashboard marchand (factures, clés API) + espace super admin minimal (liste des
tenants). Next.js 16 **App Router**, ESM, TypeScript strict — SPA cliente
authentifiée consommant `@factelec/api` via `fetch`.

## Stack pinnée

- **Next** 16.2.10 / **React** 19.2.7 / **react-dom** 19.2.7 / **zod** 4.4.3.
- **Tests** : Vitest 4.1.10 + Testing Library (`@testing-library/react`,
  `/dom`, `/user-event`, `/jest-dom`) + jsdom. Transform TSX via **oxc**
  (natif de Vite 8/Vitest 4, config `oxc.jsx` dans `vitest.config.ts`), **sans**
  `@vitejs/plugin-react` — le champ `esbuild` de la config Vitest est
  déprécié en v4 et sans effet, remplacé par l'équivalent `oxc`.
- **Lint/format** : Biome, configuration racine (`biome.json`) ; le
  scaffolding généré par Next (`.next/`, `next-env.d.ts`) est exclu du
  périmètre lint/format.

## Modèle d'auth

SPA authentifiée par **session serveur httpOnly** (cookie `factelec_session`,
posé par `apps/api`) — **aucun secret côté client** (`localStorage` /
`sessionStorage` jamais utilisés pour l'authentification). **CSRF
double-submit** : un cookie lisible `factelec_csrf` est renvoyé en en-tête
`X-CSRF-Token` sur toute requête de mutation ; toutes les requêtes `fetch`
sont émises avec `credentials: 'include'`. Le secret d'une clé API n'est
**affiché qu'une seule fois**, à sa création — jamais persisté côté client ni
re-consultable ensuite (l'API elle-même n'expose aucun endpoint de lecture du
secret).

## Lancement en développement

```sh
# 1. API (Postgres + rôles via docker-compose — voir apps/api/README.md)
pnpm --filter @factelec/api dev

# 2. Dashboard
pnpm --filter @factelec/web dev   # http://localhost:3001
```

`NEXT_PUBLIC_API_BASE_URL` doit pointer sur l'API (repli dev :
`http://localhost:3000`). En production, les cookies de session/CSRF sont
posés avec `Domain=.factelec.fr` (`SESSION_COOKIE_DOMAIN` côté API — voir
`apps/api/README.md`) pour un partage same-site entre les sous-domaines
dashboard et API.

## Tests & couverture

Composants (`src/components`) et logique (`src/lib`) testés via Testing
Library, `fetch`/client API systématiquement mockés — aucune requête réseau
réelle dans les tests. Seuil bloquant **90 % sur les 4 métriques**
(statements/branches/functions/lines, `vitest.config.ts`, décision D5).
Exclusions de couverture bornées : `src/app/**` (coques de routing Next, sans
logique propre), `**/*.d.ts`, `src/lib/api-types.ts` (types purs).

État actuel : 8 fichiers de test, **48 tests**, couverture
**100 / 96.66 / 100 / 100** (statements/branches/functions/lines).

**Playwright (e2e navigateur)** différé — **phase 5**.

```sh
pnpm --filter @factelec/web test    # Vitest + couverture v8 (jsdom, sans Docker)
```

## tsgo / Next — verdict

`tsc --noEmit` seul tolère le pin racine **tsgo 7.0.2** (partagé avec
`invoice-core`/`apps/api`) sans erreur sur ce workspace. En revanche, l'étape
interne « Running TypeScript … » de `next build` (Turbopack, Next 16.2.10)
plante avec tsgo 7.0.2 (`The "id" argument must be of type string. Received
undefined` — API `LanguageService` non implémentée par tsgo, attendue par
Next). **Repli appliqué** : `typescript@5.9.3` épinglé en devDependency
**exacte, locale à `apps/web` uniquement** — le pin racine `7.0.2` reste
inchangé pour `apps/api` et `packages/invoice-core`, qui continuent
d'utiliser tsgo sans repli. Détail empirique (deux vérifications
indépendantes, dans les deux sens) : commentaire de `tsconfig.json` et
`.superpowers/sdd/task-8-report.md`. `next build` fait autorité sur les types
des routes générées (`.next/types`).

## Limites v1

- **Super admin minimal** : liste des tenants uniquement — pas
  d'impersonation tracée, pas de MFA, pas d'audit trail (**phase 5**).
- **Pas de SSR/RSC** pour les données métier : SPA cliente authentifiée, tout
  le rendu passe par `fetch` côté client après résolution de la session.
- **Pas de création de facture via l'UI** : l'ingestion (`POST /invoices`)
  reste exclusivement machine (clé API) — voir `apps/api/README.md`.
