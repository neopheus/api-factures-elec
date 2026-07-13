# Plan 1.3 — API NestJS : socle, auth multi-tenant, ingestion

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Livrer `apps/api` — l'application **NestJS 11 (ESM, TypeScript strict)** qui expose l'ingestion et la lecture des factures : configuration validée, santé, logs structurés, **Postgres multi-tenant avec Row-Level Security**, **auth par clés API hachées**, `POST /invoices` (validation via `@factelec/invoice-core`, persistance, génération synchrone des formats du socle) et lecture tenant-scopée — le tout couvert par des tests unitaires et e2e sur **Postgres réel**, couverture ≥ 90 % bloquante.

**Architecture:** Monolithe modulaire NestJS (conforme à la spec §3). Chaque requête HTTP est authentifiée par une clé API (préfixe public + secret argon2id haché au repos), qui résout le **tenant courant** ; toutes les écritures/lectures métier s'exécutent alors dans **une transaction** où `app.tenant_id` est posé en `SET LOCAL` (`set_config(..., true)`), et les **policies RLS Postgres** filtrent par ce GUC. Le rôle applicatif Postgres (`factelec_app`) n'est ni propriétaire ni `BYPASSRLS` : l'isolation tenant est garantie par la base, pas seulement par le code. La génération des formats (UBL/CII/Factur-X/extraits F1) est **synchrone**, derrière un **port** `InvoiceFormatGenerator` qui pourra recevoir un adaptateur BullMQ en 1.4/2.x sans changer les appelants.

**Tech Stack:** Node ≥ 22, **NestJS 11** (ESM NodeNext), TypeScript **7.0.2** (typecheck) + **SWC** (émission JS, décorateurs), **Drizzle ORM** + **drizzle-kit** (Postgres), driver **`pg`**, **`@node-rs/argon2`** (Argon2id), **nestjs-pino/pino** (logs structurés), **helmet** + **@nestjs/throttler** (sécurité), **@nestjs/terminus** (santé), **Vitest 4** + **unplugin-swc** + **supertest** + **Testcontainers** (Postgres réel), zod (config + réutilisation du modèle canonique).

## Global Constraints

- **TDD strict RED/GREEN** : test écrit et vu échouer avant toute implémentation ; aucun merge si un test échoue (spec §7). Un commit minimum par tâche.
- **Couverture Vitest v8 bloquante à 90 %** sur les 4 métriques (lines/functions/statements/branches) **aussi sur `apps/api`**. `packages/invoice-core` reste à **100 %** : ne pas y toucher sauf les dettes explicitement listées en Task 1.
- **TypeScript `strict: true`, ESM (`"type": "module"`), NodeNext, Node ≥ 22.** `typescript` pinné **exactement `7.0.2`** (déjà en place, ne pas modifier). `noUncheckedIndexedAccess` actif.
- **NestJS + ESM = compromis documenté (cf. Points de risque n°1)** : `apps/api` est ESM pur ; l'**émission JS et les métadonnées de décorateurs** sont produites par **SWC** (`legacyDecorator + decoratorMetadata`), le **typecheck** par `tsc` (tsgo 7.0.2) avec `experimentalDecorators` + `emitDecoratorMetadata`, les **tests** par Vitest via `unplugin-swc`. `reflect-metadata` importé en tête de `main.ts` et du setup de test.
- **Sécurité OWASP** : validation de toute entrée (zod), authz systématique, secrets **uniquement** via variables d'environnement validées, en-têtes durcis (helmet), CORS en allowlist, rate limiting. **Aucune donnée sensible dans les logs** (redaction des en-têtes d'auth, jamais de secret ni de partie/PII de facture — on logue des identifiants). **Aucune fuite d'erreur interne** : réponses d'erreur normalisées **RFC 9457 `application/problem+json`**.
- **Moindre privilège Postgres** : rôle applicatif `factelec_app` ≠ propriétaire, **sans `BYPASSRLS`, sans superuser** ; RLS **`ENABLE` + `FORCE`** sur toutes les tables tenant ; propagation du tenant par `SET LOCAL` transactionnel (jamais de GUC de session persistant sur une connexion mutualisée).
- **`@factelec/invoice-core` consommé via son exports map** (`@factelec/invoice-core`), **jamais** par chemin relatif inter-packages. Dépendance workspace (`workspace:*`).
- **`docs/reference/` et `docs/reglementaire/` en lecture seule** (ajout d'artefacts vendorisés avec README de provenance uniquement).
- Identifiants de code en **anglais** ; messages de commit en **français**, **sans** trailer `Co-Authored-By: Claude` ni mention Claude. `pnpm format` avant chaque commit.
- Toute nouvelle dépendance **pinnée exactement** (pas de `^`/`~`), avec justification + licence (tableau ci-dessous).

## Versions & dépendances à pinner (registre npm vérifié le 2026-07-13)

> Versions relevées via `npm view <pkg> version|license` le 2026-07-13. Toutes pinnées **exactes**. ⚠ = revérifier au moment du `pnpm add` (cadence rapide).

**Runtime `apps/api` (`dependencies`)**

| Paquet | Version | Licence | Rôle / justification |
|---|---|---|---|
| `@nestjs/core` | `11.1.28` | MIT | Cœur NestJS 11 (supporte Node ≥ 20 ; ESM OK avec SWC). |
| `@nestjs/common` | `11.1.28` | MIT | Décorateurs, pipes, guards, filters. |
| `@nestjs/platform-express` | `11.1.28` | MIT | Adaptateur HTTP Express (mature, compatible helmet/supertest). |
| `@nestjs/config` | `4.0.4` | MIT | Chargement `.env` ; validation déléguée à notre schéma zod (`validate`). |
| `@nestjs/throttler` | `6.5.0` | MIT | Rate limiting (par clé API/tenant). |
| `@nestjs/terminus` | `11.1.1` | MIT | Endpoints de santé (liveness/readiness + ping DB). |
| `nestjs-pino` | `4.6.1` | MIT | Intégration pino (logger applicatif + logs de requête). |
| `pino` | `10.3.1` | MIT | Logger structuré JSON. |
| `pino-http` | `11.0.0` | MIT | Middleware de log de requête (utilisé par nestjs-pino). |
| `drizzle-orm` | `0.45.2` | Apache-2.0 | ORM TypeScript-first, ESM natif, types stricts ; RLS via transactions explicites. |
| `pg` | `8.22.0` | MIT | Driver Postgres (via `drizzle-orm/node-postgres`). MIT + `Pool` explicite = auditable pour l'immatriculation. |
| `@node-rs/argon2` | `2.0.2` | MIT | Hachage **Argon2id** des secrets de clés API. napi-rs (binaires prébuild, **pas de node-gyp**) → ops K8s/solo simples. |
| `helmet` | `8.3.0` | MIT | En-têtes de sécurité HTTP. |
| `reflect-metadata` | `0.2.2` | Apache-2.0 | Métadonnées de décorateurs (DI NestJS) au runtime. |
| `zod` | `4.4.3` | MIT | Validation config (aligné sur invoice-core, déjà au dépôt). |
| `@factelec/invoice-core` | `workspace:*` | — | Modèle canonique + générateurs (consommé via exports map). |

**Outillage/dev `apps/api` (`devDependencies`)**

| Paquet | Version | Licence | Rôle |
|---|---|---|---|
| `@swc/core` | `1.15.43` | Apache-2.0 | Transpileur (émission ESM + `decoratorMetadata`). |
| `@swc/cli` | `0.8.1` | MIT | `swc` en ligne de commande (build `dist/`). |
| `unplugin-swc` | `1.5.9` | MIT | Transform SWC pour Vitest (décorateurs en test). |
| `drizzle-kit` | `0.31.10` | MIT | Génération/gestion des migrations SQL. |
| `vitest` | `4.1.10` | MIT | Runner de tests (aligné sur invoice-core). |
| `@vitest/coverage-v8` | `4.1.10` | MIT | Couverture v8 (seuils 90 %). |
| `supertest` | `7.2.2` | MIT | Requêtes HTTP e2e contre l'app Nest. |
| `@types/supertest` | `7.2.0` | MIT | Types supertest. |
| `testcontainers` | `12.0.4` | MIT | Cycle de vie conteneurs (Postgres éphémère e2e). |
| `@testcontainers/postgresql` | `12.0.4` | MIT | Module Postgres de Testcontainers. |
| `@types/node` | `26.1.1` | MIT | Types Node (aligné sur la valeur déjà présente dans invoice-core ; cf. Task 1 pour l'hygiène base). |
| `tsx` | `4.23.1` | MIT | Exécution TS directe (scripts de dev/provisioning, hors chemin de build). |

**Choix d'ORM — Drizzle retenu (vs Prisma / TypeORM / Kysely).** Critères : ESM natif, types stricts, licence permissive, **compatibilité RLS `SET LOCAL`**, empreinte opérationnelle.
- **Drizzle** ✅ TypeScript-first (schéma = types, aucun codegen runtime), ESM natif, léger (pas de moteur Rust/binaire lourd façon Prisma), `drizzle-kit` pour des **migrations SQL lisibles** (nécessaire : nos policies RLS/rôles sont du SQL manuel), et surtout **transactions explicites** permettant `SELECT set_config('app.tenant_id', $1, true)` avant chaque unité de travail. Apache-2.0.
- **Prisma** ❌ RLS malaisée (client extensions, pooling opaque, `$executeRaw` par requête), moteur/générateur lourd — friction ops pour un dev solo.
- **TypeORM** ❌ décorateurs/`DataSource`, friction ESM historique, types moins stricts (actively maintained mais moins « strict-first »).
- **Kysely** ➖ excellent en types/ESM, mais **pas d'outil de migration intégré** aussi complet que drizzle-kit ; Drizzle l'emporte sur le couple schéma-typé + migrations.

## Points de risque signalés d'emblée

1. **NestJS + ESM pur + TypeScript 7 (tsgo) = point dur, résolu par SWC.** NestJS dépend des **décorateurs legacy** + `emitDecoratorMetadata` (DI par type via `reflect-metadata`). Vérifié (microsoft/typescript-go #2551) : **tsgo type-check bien** un codebase NestJS avec `experimentalDecorators`+`emitDecoratorMetadata` (plus lent, non bloquant ici). **Décision** : `apps/api` reste **ESM pur** ; l'**émission JS** (dev, build, tests) passe par **SWC** (`.swcrc` : `legacyDecorator:true`, `decoratorMetadata:true`, `module: es6`/nodenext, `target: es2022`), le **typecheck** par `tsc --noEmit` (tsgo 7.0.2, `experimentalDecorators`+`emitDecoratorMetadata` activés), les **tests** par Vitest + `unplugin-swc`. `reflect-metadata` importé en tout premier (`main.ts`, setup de test). **Repli documenté** si tsgo 7.0.2 bute sur un décorateur Nest précis au typecheck : pinner `typescript@5.9.x` **localement pour apps/api uniquement** (le pin global 7.0.2 d'invoice-core est inchangé) — compromis explicitement autorisé par le cadrage. ⚠ confirmer le comportement tsgo au premier `pnpm typecheck` d'apps/api.
2. **RLS et chemin d'authentification (poule/œuf).** L'auth doit lire `api_keys` **avant** que le tenant soit connu, mais `api_keys` est sous RLS. **Résolu** par une fonction **`SECURITY DEFINER` `authenticate_api_key(prefix)`** appartenant à `factelec_owner` (qui a `BYPASSRLS`), renvoyant **uniquement** la ligne minimale d'un préfixe ; `factelec_app` n'a que le droit `EXECUTE`, **jamais** `BYPASSRLS`. Le reste des accès reste pleinement RLS-enforced sous `factelec_app`.
3. **Provisioning des tenants/clés = chemin privilégié séparé.** Aucun endpoint public de création de tenant/clé en 1.3 (dashboard = 1.4). La création de tenants + émission de clés se fait via un **script CLI provisioning** connecté en `factelec_owner` (jamais depuis le chemin de requête). Les tests e2e sèment via ce même chemin owner, puis l'app tourne en `factelec_app`. À exposer proprement (self-service) en 1.4/1.5.
4. **Génération synchrone vs workers BullMQ.** La spec §3.2 prévoit des workers BullMQ. **Décision 1.3** : génération **synchrone** derrière le port `InvoiceFormatGenerator` (adaptateur `SynchronousFormatGenerator` appelant invoice-core). **Justification** : pas de Redis/BullMQ maintenant (simplicité + coût, spec §1) ; génération pure et rapide (bytes en mémoire) ; e2e déterministes sans file. Le port isole les appelants → un `QueuedFormatGenerator` (BullMQ) le remplacera en 1.4/2.x sans toucher l'ingestion. **Documenté** dans le README + point de reprise.
5. **Persistance des octets Factur-X (bytea).** `generateFacturX` renvoie un `Uint8Array` (PDF/A-3). Stocké en `bytea` (colonne `body_bytes`) ; les formats XML en `text`. Attention à l'encodage (Buffer ↔ bytea via `pg`) et au `Content-Type` de restitution (`application/pdf` vs `application/xml`). Testé à l'octet près (round-trip DB) en e2e.
6. **Isolation cross-tenant = test bloquant explicite.** Deux niveaux de test : (a) **niveau DB** — en `factelec_app`, `SET app.tenant_id=B` puis `SELECT` d'une facture de A → **0 ligne** ; `INSERT` tenant_id=A sous GUC=B → violation `WITH CHECK` ; `factelec_app` **n'a pas** `BYPASSRLS` (contrôle `pg_roles`). (b) **niveau HTTP** — avec la clé de B, `GET /invoices/{id de A}` → **404** (jamais 200, jamais fuite). Un tenant ne voit **jamais** les factures d'un autre.
7. **Dettes héritées invoice-core (Task 1).** BT-9 (`DueDateDateTime`) absent de `generateCii` ; **canari SEF CII** (garantir la compilation du SEF CII) ; **décision d'export VATEX** (`VATEX_CODES`/`isVatexCode`) ; **hygiène `@types/node`** au socle. Traitées/tranchées en Task 1 en gardant invoice-core à **100 %** ; toute dette non pertinente pour 1.3 est **reportée explicitement**.

## Structure des fichiers (vue d'ensemble)

Nouveau workspace `apps/api/` (le glob `apps/*` de `pnpm-workspace.yaml` existe déjà) :

```
apps/api/
  package.json                      # @factelec/api, ESM, scripts build/dev/test/typecheck
  tsconfig.json                     # typecheck (extends base + experimentalDecorators + emitDecoratorMetadata)
  .swcrc                            # émission JS (legacyDecorator, decoratorMetadata, ESM)
  vitest.config.ts                  # unplugin-swc, couverture 90 %, testTimeout Testcontainers
  drizzle.config.ts                 # drizzle-kit (schema, out, dialect postgresql)
  docker-compose.yml                # Postgres de dev local
  .env.example                      # variables attendues (jamais de secret réel)
  README.md                         # doc apps/api (Task 9)
  src/
    main.ts                         # bootstrap: reflect-metadata, helmet, cors, shutdown, pino, listen
    app.module.ts                   # module racine
    config/
      env.ts                        # schéma zod + loadEnv(): EnvConfig
      config.module.ts              # ConfigModule.forRoot({ validate })
    logging/logger.module.ts        # nestjs-pino (redaction, niveaux, req id)
    common/
      problem.ts                    # type Problem (RFC 9457) + fabriques
      http-exception.filter.ts      # filtre global → application/problem+json
    health/
      health.controller.ts          # GET /health, /health/ready (terminus + ping DB)
      health.module.ts
    db/
      schema.ts                     # tables drizzle: tenants, apiKeys, invoices, invoiceFormats
      client.ts                     # createPool(url) + drizzle(pool, { schema })
      tenant-context.ts             # runInTenant(pool, tenantId, work) — tx + SET LOCAL
      db.module.ts                  # fournit APP_POOL, DB, TenantContextService
      migrations/                   # SQL versionné
        0000_init.sql               # tables (généré drizzle-kit, relu)
        0001_roles_rls.sql          # rôles, GRANT, ENABLE/FORCE RLS, policies, authenticate_api_key
    auth/
      api-key.ts                    # format du token, parseApiKeyToken, generateApiKey
      api-key.service.ts            # authenticate(token) → tenantId (SECURITY DEFINER + argon2)
      api-key.guard.ts              # ApiKeyGuard (Authorization: Bearer)
      current-tenant.decorator.ts   # @CurrentTenant(): string
      auth.module.ts
    invoices/
      format-generator.port.ts      # interface InvoiceFormatGenerator + type GeneratedFormat
      synchronous-format-generator.ts# adaptateur invoice-core (UBL/CII/Factur-X/flux)
      invoices.repository.ts        # persistance (tenant tx) + lecture paginée
      invoices.service.ts           # ingest(input) + get/list/getFormat
      invoices.controller.ts        # POST /invoices, GET /invoices, GET /invoices/:id[/formats/:format]
      invoices.module.ts
  tests/
    setup.ts                        # import 'reflect-metadata'
    unit/
      env.test.ts
      problem.test.ts
      api-key.test.ts               # parse/generate + argon2 round-trip
      format-generator.test.ts
    e2e/
      helpers/postgres.ts           # Testcontainers Postgres + migrations + rôles + seed owner
      helpers/app.ts                # bootstrap Nest app de test (pool app-role)
      health.e2e.test.ts
      rls.e2e.test.ts               # isolation niveau DB (raw SQL)
      auth.e2e.test.ts              # 401/403 + rate limit
      ingestion.e2e.test.ts         # POST /invoices (201, 422 zod, 422 règles, 409 idempotence)
      read.e2e.test.ts             # GET :id / liste / formats + content-types
      tenant-isolation.e2e.test.ts  # cross-tenant 404 (bloquant)
```

Fichiers hors `apps/api` modifiés :
- `.github/workflows/ci.yml` — Docker dispo pour Testcontainers (runner ubuntu l'a nativement) ; pas de service container requis. Étapes lint/typecheck/build/test déjà `pnpm -r`.
- `package.json` racine — `@types/node` pinné au socle (Task 1) ; scripts inchangés.
- `packages/invoice-core/src/cii/generate.ts` + tests — dette BT-9 (Task 1, invoice-core reste 100 %).
- `README.md` racine + roadmap (Task 9).

---

### Task 1 : Dettes héritées invoice-core (BT-9 CII, canari SEF CII, décision VATEX) + hygiène `@types/node`

**Files:**
- Modify: `packages/invoice-core/src/cii/generate.ts` (BT-9 `DueDateDateTime`)
- Modify: `packages/invoice-core/tests/cii/generate.test.ts` (assertion BT-9 + canari SEF CII)
- Régénérer: `packages/invoice-core/tests/golden/cii-simple.xml`, `packages/invoice-core/tests/golden/cii-multi-rate.xml` (et tout golden Factur-X qui embarque le CII)
- Modify: `package.json` (racine) — `@types/node` pinné au socle (dev)
- Modify: `README.md` racine / `packages/invoice-core/README.md` — décision VATEX (report explicite)

> **Portée** : seules les dettes listées par le cadrage. `packages/invoice-core` **reste à 100 %** de couverture. Les autres dettes non pertinentes pour 1.3 sont reportées explicitement (voir Step 6).

**Interfaces:**
- Consumes: `Invoice` (inchangé).
- Produces: `generateCii` émet désormais BT-9 (`ram:SpecifiedTradePaymentTerms/ram:DueDateDateTime`) **si `invoice.dueDate` est présent** ; signature inchangée. Aucune nouvelle API exportée. **Décision VATEX tranchée** : `VATEX_CODES`/`isVatexCode` **restent internes** (non exportés) — `parseInvoiceInput` valide déjà l'appartenance BT-121 en amont ; l'API 1.3 n'expose pas de picklist. Réexamen si le dashboard 1.4 a besoin d'une liste de référence.

- [ ] **Step 1 : Baseline verte**

Run: `pnpm --filter @factelec/invoice-core test`
Expected: PASS (126 tests, couverture 100 %). Noter le compte de tests.

- [ ] **Step 2 : Écrire les tests qui échouent (BT-9 + canari SEF CII)**

Ajouter à `packages/invoice-core/tests/cii/generate.test.ts`, dans le `describe('generateCii …')` :

```ts
  it('emits BT-9 DueDateDateTime (format 102) when a due date is present', () => {
    const xml = generateCii(buildInvoice(simpleInvoiceInput))
    expect(xml).toContain('<ram:SpecifiedTradePaymentTerms>')
    expect(xml).toContain(
      '<udt:DateTimeString format="102">20260811</udt:DateTimeString>',
    )
    // BT-9 vit sous ApplicableHeaderTradeSettlement, avant la sommation.
    expect(xml.indexOf('<ram:SpecifiedTradePaymentTerms>')).toBeLessThan(
      xml.indexOf('<ram:SpecifiedTradeSettlementHeaderMonetarySummation>'),
    )
  })

  it('omits payment terms when no due date is present', () => {
    const xml = generateCii(buildInvoice(minimalInvoiceInput))
    expect(xml).not.toContain('<ram:SpecifiedTradePaymentTerms>')
  })

  // Canari : prouve que le Schematron CII est réellement chargé et contraignant
  // (et non un SEF vide qui « passerait » tout). Un CII amputé d'un total
  // obligatoire (BR-CO) DOIT échouer.
  it('canary: the CII Schematron actually rejects a non-conformant document', () => {
    const good = generateCii(buildInvoice(simpleInvoiceInput))
    const broken = good.replace(
      /<ram:SpecifiedTradeSettlementHeaderMonetarySummation>[\s\S]*?<\/ram:SpecifiedTradeSettlementHeaderMonetarySummation>/,
      '',
    )
    const r = validateAgainstSchematron(broken, CII_SEF)
    expect(r.valid).toBe(false)
    expect(r.failedAsserts.length).toBeGreaterThan(0)
  })
```

- [ ] **Step 3 : Vérifier l'échec**

Run: `pnpm --filter @factelec/invoice-core test -- cii`
Expected: FAIL — `SpecifiedTradePaymentTerms` absent, et le canari peut déjà passer (informatif) ; la 1re assertion échoue à coup sûr.

- [ ] **Step 4 : Implémenter BT-9 dans `generateCii`**

`packages/invoice-core/src/cii/generate.ts` — insérer le bloc **après** la boucle `vatBreakdown` (`ApplicableTradeTax`) et **avant** `const sum = settle.ele('ram:SpecifiedTradeSettlementHeaderMonetarySummation')` :

```ts
  // BT-9 : échéance de paiement (SpecifiedTradePaymentTerms/DueDateDateTime).
  // Ordre D16B : après ApplicableTradeTax, avant la sommation d'en-tête.
  if (invoice.dueDate)
    settle
      .ele('ram:SpecifiedTradePaymentTerms')
      .ele('ram:DueDateDateTime')
      .ele('udt:DateTimeString')
      .att('format', '102')
      .txt(ciiDate(invoice.dueDate))
```

- [ ] **Step 5 : Verdir, régénérer et relire les goldens CII**

Run: `pnpm --filter @factelec/invoice-core test -- cii`
Expected: les assertions passent ; les tests golden `cii-simple.xml`/`cii-multi-rate.xml` échouent (contenu changé). Régénérer **explicitement** (supprimer puis recréer) et relire :

```bash
rm packages/invoice-core/tests/golden/cii-simple.xml packages/invoice-core/tests/golden/cii-multi-rate.xml
UPDATE_GOLDEN=1 pnpm --filter @factelec/invoice-core test -- cii
git diff -- packages/invoice-core/tests/golden/cii-simple.xml
```
**Relire** : présence de `<ram:SpecifiedTradePaymentTerms><ram:DueDateDateTime><udt:DateTimeString format="102">20260811…`, exactement une fois, au bon endroit. Puis lancer la **suite complète** — si un test/golden Factur-X compare l'octet du CII embarqué ou un `/ID` dérivé, il change de façon déterministe : régénérer de la même manière (supprimer/recréer/relire) tout golden Factur-X impacté.

```bash
pnpm --filter @factelec/invoice-core test
```
Expected: PASS, couverture **100 %** (le `if (invoice.dueDate)` est exercé par simple/multi-rate — présent — **et** par minimalInvoiceInput — absent : les deux branches sont couvertes).

- [ ] **Step 6 : Hygiène `@types/node` au socle + décision VATEX documentée + report des dettes non retenues**

`package.json` (racine) — ajouter aux `devDependencies` (source unique de types Node pour tous les packages ; invoice-core garde sa déclaration locale, apps/api s'appuiera dessus) :

```jsonc
    "@types/node": "26.1.1",   // pinné exact, aligné sur la valeur d'invoice-core
```

Documenter dans `packages/invoice-core/README.md` (section « Motifs d'exonération ») la décision **VATEX interne** : « `VATEX_CODES`/`isVatexCode` restent internes ; l'appartenance BT-121 est appliquée par `invoiceInputSchema`. L'API 1.3 n'a pas besoin d'exposer la liste ; réexamen en 1.4 si le dashboard requiert une picklist. » Reporter explicitement, dans le point de reprise du README racine, toute dette hors périmètre 1.3 (aucune autre identifiée : BT-9 et canari SEF CII soldés ici).

- [ ] **Step 7 : Vérifier l'ensemble et committer**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm --filter @factelec/invoice-core test`
Expected: PASS, couverture 100 %, même **compte de tests + 3** (les 3 nouveaux tests CII).

```bash
git add -A
git commit -m "feat(invoice-core): échéance BT-9 dans le CII + canari Schematron CII, hygiène @types/node socle"
```

---

### Task 2 : Socle `apps/api` — NestJS 11 ESM (build SWC, typecheck tsgo, Vitest, santé, CI)

**Files:**
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/.swcrc`, `apps/api/vitest.config.ts`, `apps/api/.env.example`, `apps/api/.gitignore`
- Create: `apps/api/src/main.ts`, `apps/api/src/app.module.ts`
- Create: `apps/api/src/health/health.controller.ts`, `apps/api/src/health/health.module.ts`
- Create: `apps/api/tests/setup.ts`, `apps/api/tests/e2e/health.e2e.test.ts`
- Modify: `.github/workflows/ci.yml` (ordre : build avant typecheck ; Docker pour Testcontainers)

**Interfaces:**
- Consumes: rien (point d'entrée du workspace).
- Produces (utilisé par toutes les tâches suivantes) :
  - `AppModule` — module racine ; les tâches suivantes y ajoutent leurs `imports`.
  - Convention de build : **SWC émet le JS** (`.swcrc`, ESM), **tsgo type-check** (`tsc --noEmit`), **Vitest transforme via `unplugin-swc`**. Imports internes **avec extension `.js`** (ESM NodeNext, comme invoice-core). `reflect-metadata` importé en tête de `main.ts` et de `tests/setup.ts`.

> **Note santé** : Task 2 ne livre que la **liveness** (`GET /health`, sans I/O). La **readiness** avec ping DB (`GET /health/ready`) est ajoutée en Task 5 (une fois le pool DB disponible).

- [ ] **Step 1 : Écrire le test e2e qui échoue**

`apps/api/tests/setup.ts` :
```ts
import 'reflect-metadata'
```

`apps/api/tests/e2e/health.e2e.test.ts` :
```ts
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HealthModule } from '../../src/health/health.module.js'

describe('health (e2e)', () => {
  let app: INestApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [HealthModule],
    }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  it('GET /health returns 200 { status: "ok" }', async () => {
    await request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok' })
  })
})
```

- [ ] **Step 2 : Scaffolder le workspace (fichiers de config)**

`apps/api/package.json` :
```json
{
  "name": "@factelec/api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/main.js",
  "scripts": {
    "build": "swc src --out-dir dist --strip-leading-paths",
    "dev": "node --import tsx --watch src/main.ts",
    "start": "node dist/main.js",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --coverage",
    "test:watch": "vitest",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "node --import tsx scripts/migrate.ts",
    "provision:tenant": "node --import tsx scripts/provision-tenant.ts"
  },
  "dependencies": {
    "@factelec/invoice-core": "workspace:*",
    "@nestjs/common": "11.1.28",
    "@nestjs/config": "4.0.4",
    "@nestjs/core": "11.1.28",
    "@nestjs/platform-express": "11.1.28",
    "@nestjs/terminus": "11.1.1",
    "@nestjs/throttler": "6.5.0",
    "@node-rs/argon2": "2.0.2",
    "drizzle-orm": "0.45.2",
    "helmet": "8.3.0",
    "nestjs-pino": "4.6.1",
    "pg": "8.22.0",
    "pino": "10.3.1",
    "pino-http": "11.0.0",
    "reflect-metadata": "0.2.2",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@swc/cli": "0.8.1",
    "@swc/core": "1.15.43",
    "@testcontainers/postgresql": "12.0.4",
    "@types/pg": "8.20.0",
    "@types/supertest": "7.2.0",
    "@vitest/coverage-v8": "4.1.10",
    "drizzle-kit": "0.31.10",
    "supertest": "7.2.2",
    "testcontainers": "12.0.4",
    "tsx": "4.23.1",
    "unplugin-swc": "1.5.9",
    "vitest": "4.1.10"
  }
}
```
> `@types/pg` : vérifier la dernière patch au `pnpm add` (`npm view @types/pg version`) et pinner exact. Le `@nestjs/*` runtime est CommonJS ; NodeNext gère l'interop ESM→CJS au typecheck, SWC à l'émission.

`apps/api/.swcrc` :
```json
{
  "$schema": "https://swc.rs/schema.json",
  "jsc": {
    "parser": { "syntax": "typescript", "decorators": true },
    "transform": {
      "legacyDecorator": true,
      "decoratorMetadata": true,
      "useDefineForClassFields": false
    },
    "target": "es2022",
    "keepClassNames": true
  },
  "module": { "type": "es6" }
}
```

`apps/api/tsconfig.json` (typecheck seulement — l'émission est SWC) :
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": ".",
    "noEmit": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "useDefineForClassFields": false,
    "types": ["node"]
  },
  "include": ["src/**/*", "tests/**/*", "vitest.config.ts", "drizzle.config.ts", "scripts/**/*"]
}
```

`apps/api/vitest.config.ts` :
```ts
import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [swc.vite()],
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Exclus : bootstrap et pur câblage DI (aucune logique à couvrir).
      exclude: ['src/main.ts', '**/*.module.ts', 'src/db/migrations/**'],
      thresholds: { lines: 90, functions: 90, statements: 90, branches: 90 },
    },
  },
})
```

`apps/api/.gitignore` :
```
dist/
coverage/
.env
```

`apps/api/.env.example` (jamais de secret réel — cf. Task 3 pour le schéma) :
```
NODE_ENV=development
PORT=3000
LOG_LEVEL=info
# Rôle applicatif (runtime) — soumis à la RLS, sans BYPASSRLS
DATABASE_URL=postgres://factelec_app:app_pw@localhost:5432/factelec
# Rôle propriétaire — migrations & provisioning UNIQUEMENT (jamais le runtime)
DATABASE_OWNER_URL=postgres://factelec_owner:owner_pw@localhost:5432/factelec
CORS_ALLOWED_ORIGINS=http://localhost:3000
RATE_LIMIT_TTL=60
RATE_LIMIT_LIMIT=120
```

- [ ] **Step 3 : Implémenter le module santé + le module racine + le bootstrap**

`apps/api/src/health/health.controller.ts` :
```ts
import { Controller, Get } from '@nestjs/common'

@Controller('health')
export class HealthController {
  @Get()
  liveness(): { status: 'ok' } {
    return { status: 'ok' }
  }
}
```

`apps/api/src/health/health.module.ts` :
```ts
import { Module } from '@nestjs/common'
import { HealthController } from './health.controller.js'

@Module({ controllers: [HealthController] })
export class HealthModule {}
```

`apps/api/src/app.module.ts` :
```ts
import { Module } from '@nestjs/common'
import { HealthModule } from './health/health.module.js'

@Module({ imports: [HealthModule] })
export class AppModule {}
```

`apps/api/src/main.ts` (minimal — enrichi en Task 3) :
```ts
import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule)
  await app.listen(Number(process.env.PORT ?? 3000))
}

void bootstrap()
```

- [ ] **Step 4 : Installer et vérifier l'échec devenu succès (RED→GREEN)**

```bash
pnpm install
pnpm --filter @factelec/api test -- health
```
Expected: le test e2e `GET /health` **passe** (200 `{ status: "ok" }`). S'il échoue à cause des décorateurs (`Reflect.getMetadata` absent), vérifier `tests/setup.ts` (import `reflect-metadata`) et le plugin `unplugin-swc` (décorateurs). C'est le point de validation concret du compromis SWC/ESM (Point de risque n°1).

- [ ] **Step 5 : Vérifier build + typecheck ; réordonner la CI**

`apps/api` se type-check avec tsgo et se build avec SWC :
```bash
pnpm --filter @factelec/api build      # swc → dist/ (ESM)
node apps/api/dist/main.js &           # démarre ; Ctrl-C après vérif d'un GET /health
pnpm --filter @factelec/api typecheck  # tsgo (tsc --noEmit) : peut être lent (cf. risque n°1), doit passer
```
> **Point de risque n°1 — validation** : si `pnpm typecheck` d'apps/api échoue sur un décorateur Nest sous tsgo 7.0.2, appliquer le repli documenté (pin `typescript@5.9.x` local à `apps/api` uniquement, ajouté en devDependency exacte, sans toucher le pin global 7.0.2). Consigner la décision dans `apps/api/README.md` (Task 9).

`apps/api` a besoin du **`dist/` d'invoice-core** pour son typecheck (types via l'exports map). Réordonner `.github/workflows/ci.yml` pour **builder avant de typechecker** (et confirmer que le runner ubuntu fournit Docker pour Testcontainers, ce qui est le cas nativement) :
```yaml
      - run: sudo apt-get update && sudo apt-get install -y libxml2-utils
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm build        # invoice-core (tsc) puis apps/api (swc), ordre topologique pnpm
      - run: pnpm typecheck     # apps/api résout @factelec/invoice-core via son dist/
      - run: pnpm test          # invoice-core + apps/api (Testcontainers Postgres via Docker du runner)
```

- [ ] **Step 6 : Vérifier l'ensemble et committer**

Run: `pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm test`
Expected: PASS partout ; couverture apps/api ≥ 90 % (à ce stade, seul le contrôleur santé est testé — il est couvert).

```bash
git add -A
git commit -m "feat(api): socle NestJS 11 ESM (build SWC, typecheck tsgo, Vitest, endpoint santé)"
```

---

### Task 3 : Config validée (zod), logs pino, arrêt propre, helmet/CORS, filtre `problem+json`

**Files:**
- Create: `apps/api/src/config/env.ts`, `apps/api/src/config/config.module.ts`
- Create: `apps/api/src/logging/logger.module.ts`
- Create: `apps/api/src/common/problem.ts`, `apps/api/src/common/http-exception.filter.ts`
- Modify: `apps/api/src/main.ts` (helmet, cors, filtre global, pino, shutdown hooks)
- Modify: `apps/api/src/app.module.ts` (config + logger globaux)
- Create: `apps/api/tests/unit/env.test.ts`, `apps/api/tests/unit/problem.test.ts`, `apps/api/tests/e2e/security-headers.e2e.test.ts`

**Interfaces:**
- Produces (utilisé partout ensuite) :
  - `export const envSchema` ; `export type EnvConfig` ; `export function validateEnv(raw): EnvConfig`. **`DATABASE_OWNER_URL` n'est PAS dans le schéma runtime** (moindre privilège : le process API ne connaît que l'URL du rôle `factelec_app`). Le rôle owner n'est lu que par les scripts migration/provisioning.
  - `export interface Problem`, `export const ProblemType`, `export function problem(status, type, title, extra?)` — RFC 9457.
  - `export class ProblemDetailsFilter` — filtre global (`application/problem+json`, jamais de fuite interne).

- [ ] **Step 1 : Écrire les tests unitaires qui échouent**

`apps/api/tests/unit/env.test.ts` :
```ts
import { describe, expect, it } from 'vitest'
import { validateEnv } from '../../src/config/env.js'

const base = {
  NODE_ENV: 'test',
  PORT: '3000',
  LOG_LEVEL: 'info',
  DATABASE_URL: 'postgres://factelec_app:pw@localhost:5432/factelec',
  CORS_ALLOWED_ORIGINS: 'http://a.example,http://b.example',
  RATE_LIMIT_TTL: '60',
  RATE_LIMIT_LIMIT: '120',
}

describe('validateEnv', () => {
  it('parses and coerces a valid environment', () => {
    const env = validateEnv(base)
    expect(env.PORT).toBe(3000)
    expect(env.RATE_LIMIT_LIMIT).toBe(120)
    expect(env.CORS_ALLOWED_ORIGINS).toEqual(['http://a.example', 'http://b.example'])
  })

  it('applies safe defaults for optional keys', () => {
    const env = validateEnv({ DATABASE_URL: base.DATABASE_URL })
    expect(env.PORT).toBe(3000)
    expect(env.LOG_LEVEL).toBe('info')
    expect(env.CORS_ALLOWED_ORIGINS).toEqual([])
  })

  it('throws listing offending KEYS only (never values — no secret leak)', () => {
    expect(() => validateEnv({ PORT: 'abc' })).toThrowError(/DATABASE_URL/)
    // le message ne doit contenir aucune valeur d'environnement
    try {
      validateEnv({ DATABASE_URL: 'not-a-url', SECRET: 'p@ssw0rd' })
    } catch (e) {
      expect((e as Error).message).not.toContain('p@ssw0rd')
      expect((e as Error).message).toContain('DATABASE_URL')
    }
  })
})
```

`apps/api/tests/unit/problem.test.ts` :
```ts
import { describe, expect, it } from 'vitest'
import { problem, ProblemType } from '../../src/common/problem.js'

describe('problem (RFC 9457)', () => {
  it('builds a problem document with type/title/status', () => {
    const p = problem(422, ProblemType.validation, 'Unprocessable Entity', {
      errors: [{ path: 'number', message: 'required' }],
    })
    expect(p).toMatchObject({
      type: ProblemType.validation,
      title: 'Unprocessable Entity',
      status: 422,
    })
    expect(p.errors).toHaveLength(1)
  })

  it('exposes stable urn: problem types', () => {
    expect(ProblemType.businessRule).toBe('urn:factelec:problem:business-rule-violation')
    expect(ProblemType.notFound).toBe('urn:factelec:problem:not-found')
  })
})
```

Run: `pnpm --filter @factelec/api test -- env problem`
Expected: FAIL — modules inexistants.

- [ ] **Step 2 : Implémenter la config (zod)**

`apps/api/src/config/env.ts` :
```ts
import { z } from 'zod'

const csv = z
  .string()
  .default('')
  .transform((s) => s.split(',').map((o) => o.trim()).filter(Boolean))

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  // Rôle applicatif UNIQUEMENT (soumis à la RLS). L'URL du rôle owner n'est
  // jamais chargée par le process API (elle sert aux scripts migration/provision).
  DATABASE_URL: z.string().url(),
  CORS_ALLOWED_ORIGINS: csv,
  RATE_LIMIT_TTL: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_LIMIT: z.coerce.number().int().positive().default(120),
})

export type EnvConfig = z.infer<typeof envSchema>

export function validateEnv(raw: Record<string, unknown>): EnvConfig {
  const parsed = envSchema.safeParse(raw)
  if (!parsed.success) {
    // On ne divulgue QUE les clés fautives, jamais les valeurs (secrets).
    const keys = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(root)'))]
    throw new Error(`Invalid environment configuration: ${keys.join(', ')}`)
  }
  return parsed.data
}
```

`apps/api/src/config/config.module.ts` :
```ts
import { ConfigModule } from '@nestjs/config'
import { validateEnv } from './env.js'

// Global : ConfigService<EnvConfig, true> injectable partout.
export const AppConfigModule = ConfigModule.forRoot({
  isGlobal: true,
  cache: true,
  validate: validateEnv,
})
```

- [ ] **Step 3 : Implémenter Problem + filtre global**

`apps/api/src/common/problem.ts` :
```ts
export interface Problem {
  type: string
  title: string
  status: number
  detail?: string
  errors?: unknown
}

const BASE = 'urn:factelec:problem'
export const ProblemType = {
  validation: `${BASE}:validation-error`,
  businessRule: `${BASE}:business-rule-violation`,
  unauthorized: `${BASE}:unauthorized`,
  forbidden: `${BASE}:forbidden`,
  notFound: `${BASE}:not-found`,
  conflict: `${BASE}:conflict`,
  rateLimited: `${BASE}:rate-limited`,
  internal: `${BASE}:internal-error`,
} as const

export function problem(
  status: number,
  type: string,
  title: string,
  extra?: Partial<Pick<Problem, 'detail' | 'errors'>>,
): Problem {
  return { type, title, status, ...extra }
}

export function isProblem(x: unknown): x is Problem {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as Problem).type === 'string' &&
    typeof (x as Problem).status === 'number' &&
    typeof (x as Problem).title === 'string'
  )
}
```

`apps/api/src/common/http-exception.filter.ts` :
```ts
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common'
import type { Response } from 'express'
import { isProblem, problem, type Problem, ProblemType } from './problem.js'

const TITLE_BY_STATUS: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
}
const TYPE_BY_STATUS: Record<number, string> = {
  401: ProblemType.unauthorized,
  403: ProblemType.forbidden,
  404: ProblemType.notFound,
  409: ProblemType.conflict,
  422: ProblemType.validation,
  429: ProblemType.rateLimited,
}

// Filtre attrape-tout : toute réponse d'erreur est un application/problem+json,
// et AUCUNE information interne (stack, message d'exception non maîtrisé) ne fuit.
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name)

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>()
    let body: Problem

    if (exception instanceof HttpException) {
      const status = exception.getStatus()
      const payload = exception.getResponse()
      if (isProblem(payload)) {
        body = payload
      } else {
        const detail =
          typeof payload === 'string'
            ? payload
            : typeof (payload as { message?: unknown }).message === 'string'
              ? (payload as { message: string }).message
              : undefined
        body = problem(
          status,
          TYPE_BY_STATUS[status] ?? ProblemType.internal,
          TITLE_BY_STATUS[status] ?? 'Error',
          detail ? { detail } : undefined,
        )
      }
    } else {
      // Non maîtrisé : log serveur, réponse générique — jamais de fuite.
      this.logger.error(exception instanceof Error ? exception.stack : String(exception))
      body = problem(500, ProblemType.internal, 'Internal Server Error')
    }

    res.status(body.status).type('application/problem+json').send(body)
  }
}
```

- [ ] **Step 4 : Logger pino + câblage main.ts + app.module.ts**

`apps/api/src/logging/logger.module.ts` :
```ts
import { ConfigModule, ConfigService } from '@nestjs/config'
import { LoggerModule } from 'nestjs-pino'
import type { EnvConfig } from '../config/env.js'

// Logs JSON structurés. Redaction stricte : aucun secret ni PII de facture.
export const AppLoggerModule = LoggerModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService<EnvConfig, true>) => ({
    pinoHttp: {
      level: config.get('LOG_LEVEL', { infer: true }),
      autoLogging: true,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers["x-api-key"]',
          'req.headers.cookie',
          'req.body',
          'res.headers["set-cookie"]',
        ],
        remove: true,
      },
      serializers: {
        req: (req: { id: unknown; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          url: req.url,
        }),
      },
    },
  }),
})
```

`apps/api/src/app.module.ts` :
```ts
import { Module } from '@nestjs/common'
import { AppConfigModule } from './config/config.module.js'
import { HealthModule } from './health/health.module.js'
import { AppLoggerModule } from './logging/logger.module.js'

@Module({ imports: [AppConfigModule, AppLoggerModule, HealthModule] })
export class AppModule {}
```

`apps/api/src/main.ts` :
```ts
import 'reflect-metadata'
import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import helmet from 'helmet'
import { Logger } from 'nestjs-pino'
import { AppModule } from './app.module.js'
import type { EnvConfig } from './config/env.js'
import { ProblemDetailsFilter } from './common/http-exception.filter.js'

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true })
  app.useLogger(app.get(Logger))
  const config = app.get<ConfigService<EnvConfig, true>>(ConfigService)

  app.use(helmet())
  app.enableCors({
    origin: config.get('CORS_ALLOWED_ORIGINS', { infer: true }),
    methods: ['GET', 'POST'],
    credentials: false,
  })
  app.useGlobalFilters(new ProblemDetailsFilter())
  app.enableShutdownHooks() // SIGTERM/SIGINT → onModuleDestroy (fermeture du pool DB, Task 5)

  await app.listen(config.get('PORT', { infer: true }))
}

void bootstrap()
```

- [ ] **Step 5 : Test e2e des en-têtes de sécurité + du filtre**

`apps/api/tests/e2e/security-headers.e2e.test.ts` — monte une app minimale avec le filtre et un contrôleur qui jette, vérifie helmet + problem+json :
```ts
import { Controller, Get, INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ProblemDetailsFilter } from '../../src/common/http-exception.filter.js'

@Controller('boom')
class BoomController {
  @Get()
  boom(): never {
    throw new Error('secret internal detail: db password xyz')
  }
}

describe('security + problem filter (e2e)', () => {
  let app: INestApplication
  beforeAll(async () => {
    const mod = await Test.createTestingModule({ controllers: [BoomController] }).compile()
    app = mod.createNestApplication()
    const helmet = (await import('helmet')).default
    app.use(helmet())
    app.useGlobalFilters(new ProblemDetailsFilter())
    await app.init()
  })
  afterAll(async () => { await app.close() })

  it('sets helmet security headers', async () => {
    const res = await request(app.getHttpServer()).get('/boom')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })

  it('never leaks internal error details (generic 500 problem+json)', async () => {
    const res = await request(app.getHttpServer()).get('/boom')
    expect(res.status).toBe(500)
    expect(res.headers['content-type']).toContain('application/problem+json')
    expect(res.body.type).toBe('urn:factelec:problem:internal-error')
    expect(JSON.stringify(res.body)).not.toContain('db password')
  })
})
```

Run: `pnpm --filter @factelec/api test`
Expected: PASS (env, problem, security-headers, health). Couverture ≥ 90 %.

- [ ] **Step 6 : Vérifier l'ensemble et committer**

Run: `pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test`
Expected: PASS.

```bash
git add -A
git commit -m "feat(api): config zod, logs pino redactés, arrêt propre, helmet/CORS, filtre problem+json"
```

---

### Task 4 : Base de données — schéma Drizzle, migrations, rôles Postgres, RLS `FORCE`, Testcontainers

**Files:**
- Create: `apps/api/src/db/schema.ts`
- Create: `apps/api/drizzle.config.ts`, `apps/api/scripts/migrate.ts`
- Create: `apps/api/docker-compose.yml`, `apps/api/scripts/db-init/00-roles.sql`
- Create: `apps/api/src/db/migrations/0000_init.sql` (généré drizzle-kit + relu), `apps/api/src/db/migrations/0001_roles_rls.sql` (custom, rédigé à la main), `apps/api/src/db/migrations/meta/_journal.json` (drizzle-kit)
- Create: `apps/api/tests/e2e/helpers/postgres.ts`
- Create: `apps/api/tests/e2e/rls.e2e.test.ts`

**Interfaces:**
- Produces (utilisé par toutes les tâches DB) :
  - `apps/api/src/db/schema.ts` : `tenants`, `apiKeys`, `invoices`, `invoiceFormats` (+ enums `invoiceStatus`, `formatKind`) et leurs types Drizzle inférés.
  - Migrations SQL versionnées ; le rôle **`factelec_app`** est le seul rôle runtime (RLS-enforced) ; **`factelec_owner`** (BYPASSRLS) pour migrations/provisioning et propriétaire de `authenticate_api_key(text)`.
  - `startTestDb(): Promise<TestDb>` (Testcontainers) — expose `appUrl` (factelec_app), `ownerUrl` (factelec_owner), `stop()`.

> **Rôles** : créés hors migration (docker-compose init en dev, harness en test, Terraform en prod). La migration `0001` **suppose** leur existence et applique GRANT/RLS/policies/fonction. `factelec_owner` a `BYPASSRLS` (migrations + fonction SECURITY DEFINER) ; `factelec_app` est `NOSUPERUSER NOBYPASSRLS`.

- [ ] **Step 1 : Écrire le test d'isolation niveau DB (échoue)**

`apps/api/tests/e2e/rls.e2e.test.ts` :
```ts
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestDb, type TestDb } from './helpers/postgres.js'

describe('RLS tenant isolation (DB level)', () => {
  let db: TestDb
  let ownerPool: pg.Pool
  let appPool: pg.Pool
  let tenantA: string
  let tenantB: string
  let invoiceA: string

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    appPool = new pg.Pool({ connectionString: db.appUrl })
    // Semis via le rôle owner (BYPASSRLS) — chemin privilégié, hors requête HTTP.
    const a = await ownerPool.query(
      "INSERT INTO tenants (name) VALUES ('Tenant A') RETURNING id",
    )
    const b = await ownerPool.query(
      "INSERT INTO tenants (name) VALUES ('Tenant B') RETURNING id",
    )
    tenantA = a.rows[0].id
    tenantB = b.rows[0].id
    const inv = await ownerPool.query(
      `INSERT INTO invoices (tenant_id, number, type_code, issue_date, currency, canonical)
       VALUES ($1, 'FA-A-1', '380', '2026-07-13', 'EUR', '{}'::jsonb) RETURNING id`,
      [tenantA],
    )
    invoiceA = inv.rows[0].id
  })

  afterAll(async () => {
    await appPool.end()
    await ownerPool.end()
    await db.stop()
  })

  it('factelec_app has neither superuser nor BYPASSRLS', async () => {
    const r = await appPool.query(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    )
    expect(r.rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false })
  })

  it('sees zero rows of another tenant', async () => {
    const client = await appPool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantB])
      const r = await client.query('SELECT id FROM invoices WHERE id = $1', [invoiceA])
      expect(r.rowCount).toBe(0)
      await client.query('COMMIT')
    } finally {
      client.release()
    }
  })

  it('sees its own rows once the context matches', async () => {
    const client = await appPool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA])
      const r = await client.query('SELECT id FROM invoices WHERE id = $1', [invoiceA])
      expect(r.rowCount).toBe(1)
      await client.query('COMMIT')
    } finally {
      client.release()
    }
  })

  it('cannot INSERT a row for a foreign tenant (WITH CHECK)', async () => {
    const client = await appPool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantB])
      await expect(
        client.query(
          `INSERT INTO invoices (tenant_id, number, type_code, issue_date, currency, canonical)
           VALUES ($1, 'FA-X', '380', '2026-07-13', 'EUR', '{}'::jsonb)`,
          [tenantA],
        ),
      ).rejects.toThrow(/row-level security/i)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  it('fails closed with no tenant context set (no rows)', async () => {
    const r = await appPool.query('SELECT id FROM invoices')
    expect(r.rowCount).toBe(0)
  })
})
```

Run: `pnpm --filter @factelec/api test -- rls`
Expected: FAIL — `helpers/postgres.js`, schéma et migrations absents.

- [ ] **Step 2 : Définir le schéma Drizzle**

`apps/api/src/db/schema.ts` :
```ts
import type { Invoice } from '@factelec/invoice-core'
import {
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

// bytea : non natif dans drizzle-orm — type sur mesure pour les octets Factur-X.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
})

export const invoiceStatus = pgEnum('invoice_status', ['received', 'generated', 'failed'])
export const formatKind = pgEnum('format_kind', ['ubl', 'cii', 'facturx', 'flux_base', 'flux_full'])

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  siren: text('siren'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    prefix: text('prefix').notNull(),
    secretHash: text('secret_hash').notNull(),
    label: text('label').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('api_keys_prefix_unique').on(t.prefix),
    index('api_keys_tenant_idx').on(t.tenantId),
  ],
)

export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    number: text('number').notNull(),
    typeCode: text('type_code').notNull(),
    issueDate: text('issue_date').notNull(),
    currency: text('currency').notNull(),
    status: invoiceStatus('status').notNull().default('received'),
    canonical: jsonb('canonical').$type<Invoice>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('invoices_tenant_number_unique').on(t.tenantId, t.number),
    index('invoices_tenant_created_idx').on(t.tenantId, t.createdAt),
  ],
)

export const invoiceFormats = pgTable(
  'invoice_formats',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    kind: formatKind('kind').notNull(),
    contentType: text('content_type').notNull(),
    bodyText: text('body_text'),
    bodyBytes: bytea('body_bytes'),
    byteSize: integer('byte_size').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('invoice_formats_invoice_kind_unique').on(t.invoiceId, t.kind),
    index('invoice_formats_tenant_idx').on(t.tenantId),
  ],
)
```

- [ ] **Step 3 : drizzle-kit config + génération de 0000 + migration custom 0001**

`apps/api/drizzle.config.ts` :
```ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  // Migrations exécutées par le rôle OWNER (DDL + RLS + fonction SECURITY DEFINER).
  dbCredentials: { url: process.env.DATABASE_OWNER_URL ?? '' },
})
```

Générer la migration des tables (crée `0000_*.sql` + `meta/_journal.json`), la **relire** ; puis créer la migration custom vide `0001` :
```bash
pnpm --filter @factelec/api exec drizzle-kit generate --name init
pnpm --filter @factelec/api exec drizzle-kit generate --custom --name roles_rls
```
> `--custom` crée un `.sql` vide (rien à diff dans le schéma) qu'on remplit à la main. Renommer si besoin en `0000_init.sql`/`0001_roles_rls.sql` (garder la cohérence avec `meta/_journal.json`).

`apps/api/src/db/migrations/0001_roles_rls.sql` (exécuté en tant que `factelec_owner` ; **statements séparés par `--> statement-breakpoint`**, convention du migrateur drizzle ; le corps `$$…$$` de la fonction reste **un seul** statement) :
```sql
GRANT USAGE ON SCHEMA public TO factelec_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON tenants, api_keys, invoices, invoice_formats TO factelec_app;
--> statement-breakpoint
ALTER TABLE tenants         ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenants         FORCE  ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE api_keys        ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE api_keys        FORCE  ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE invoices        ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE invoices        FORCE  ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE invoice_formats ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE invoice_formats FORCE  ROW LEVEL SECURITY;
--> statement-breakpoint
-- current_setting(..., true) : missing_ok → NULL si non posé → fail-closed.
CREATE POLICY tenant_isolation ON invoices
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
--> statement-breakpoint
CREATE POLICY tenant_isolation ON invoice_formats
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
--> statement-breakpoint
CREATE POLICY tenant_isolation ON api_keys
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
--> statement-breakpoint
CREATE POLICY tenant_self ON tenants
  USING (id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (id = current_setting('app.tenant_id', true)::uuid);
--> statement-breakpoint
-- Poule/œuf : l'auth précède le contexte tenant. SECURITY DEFINER (owner, BYPASSRLS),
-- bornée à UN préfixe, ne renvoie que le nécessaire. app n'a que EXECUTE.
CREATE OR REPLACE FUNCTION authenticate_api_key(p_prefix text)
RETURNS TABLE (api_key_id uuid, tenant_id uuid, secret_hash text, revoked_at timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT id, tenant_id, secret_hash, revoked_at
  FROM api_keys
  WHERE prefix = p_prefix
  LIMIT 1;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION authenticate_api_key(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION authenticate_api_key(text) TO factelec_app;
```

- [ ] **Step 4 : Script de migration + init des rôles (dev)**

`apps/api/scripts/migrate.ts` (exécuté en owner) :
```ts
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'

const url = process.env.DATABASE_OWNER_URL
if (!url) throw new Error('DATABASE_OWNER_URL is required for migrations')

const pool = new pg.Pool({ connectionString: url })
const db = drizzle(pool)
await migrate(db, { migrationsFolder: 'src/db/migrations' })
await pool.end()
```

`apps/api/scripts/db-init/00-roles.sql` (exécuté par le superuser au 1er démarrage du conteneur dev ; en prod → Terraform) :
```sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'factelec_owner') THEN
    CREATE ROLE factelec_owner LOGIN PASSWORD 'owner_pw' BYPASSRLS CREATEDB;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'factelec_app') THEN
    CREATE ROLE factelec_app LOGIN PASSWORD 'app_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB;
  END IF;
END $$;
GRANT ALL ON DATABASE factelec TO factelec_owner;
ALTER SCHEMA public OWNER TO factelec_owner;
GRANT CREATE, USAGE ON SCHEMA public TO factelec_owner;
```

`apps/api/docker-compose.yml` :
```yaml
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_DB: factelec
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    ports:
      - '5432:5432'
    volumes:
      - ./scripts/db-init:/docker-entrypoint-initdb.d:ro
```

- [ ] **Step 5 : Harness Testcontainers**

`apps/api/tests/e2e/helpers/postgres.ts` — démarre Postgres, crée les deux rôles (superuser), attribue la propriété du schéma à l'owner, migre en owner, expose les URLs :
```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'

export interface TestDb {
  container: StartedPostgreSqlContainer
  appUrl: string
  ownerUrl: string
  stop(): Promise<void>
}

export async function startTestDb(): Promise<TestDb> {
  const container = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('factelec')
    .withUsername('postgres')
    .withPassword('postgres')
    .start()

  const host = container.getHost()
  const port = container.getPort()
  const superUrl = container.getConnectionUri()

  // Rôles + propriété du schéma (fait par le superuser, comme le db-init dev / Terraform prod).
  const su = new pg.Pool({ connectionString: superUrl })
  await su.query(`CREATE ROLE factelec_owner LOGIN PASSWORD 'owner_pw' BYPASSRLS CREATEDB`)
  await su.query(`CREATE ROLE factelec_app LOGIN PASSWORD 'app_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB`)
  await su.query(`GRANT ALL ON DATABASE factelec TO factelec_owner`)
  await su.query(`ALTER SCHEMA public OWNER TO factelec_owner`)
  await su.end()

  const ownerUrl = `postgres://factelec_owner:owner_pw@${host}:${port}/factelec`
  const appUrl = `postgres://factelec_app:app_pw@${host}:${port}/factelec`

  // Migrations en owner (DDL + RLS + fonction SECURITY DEFINER).
  const ownerPool = new pg.Pool({ connectionString: ownerUrl })
  await migrate(drizzle(ownerPool), { migrationsFolder: 'src/db/migrations' })
  await ownerPool.end()

  return {
    container,
    appUrl,
    ownerUrl,
    stop: () => container.stop(),
  }
}
```
> ⚠ `getConnectionUri()` du module Testcontainers renvoie l'URL du superuser (`postgres`). Vérifier au premier run que `ALTER SCHEMA public OWNER TO factelec_owner` s'exécute avant `migrate` (les tables doivent appartenir à l'owner pour `FORCE RLS`).

- [ ] **Step 6 : Verdir le test RLS**

Run: `pnpm --filter @factelec/api test -- rls`
Expected: PASS — les 5 assertions (pas de superuser/bypass, 0 ligne cross-tenant, 1 ligne same-tenant, refus INSERT `WITH CHECK`, fail-closed sans contexte). C'est la **preuve niveau base** de l'isolation multi-tenant (spec §6).

- [ ] **Step 7 : Vérifier l'ensemble et committer**

Run: `pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test`
Expected: PASS.

```bash
git add -A
git commit -m "feat(api): schéma Drizzle + migrations, rôles Postgres, RLS FORCE par tenant, harness Testcontainers"
```

---

### Task 5 : Contexte tenant applicatif (transaction + `SET LOCAL`), module DB, readiness

**Files:**
- Create: `apps/api/src/db/client.ts`, `apps/api/src/db/tenant-context.ts`, `apps/api/src/db/tenant-context.service.ts`, `apps/api/src/db/db.module.ts`
- Modify: `apps/api/src/health/health.controller.ts`, `apps/api/src/health/health.module.ts` (readiness DB via terminus)
- Modify: `apps/api/src/app.module.ts` (importer `DbModule`)
- Create: `apps/api/tests/e2e/tenant-context.e2e.test.ts`, `apps/api/tests/e2e/helpers/app.ts`

**Interfaces:**
- Produces (utilisé par auth + invoices) :
  - `export const APP_POOL: symbol` (token DI du pool applicatif) et `export type Db` (`client.ts`).
  - `export async function runInTenant<T>(pool, tenantId, work: (db: Db) => Promise<T>): Promise<T>` — ouvre une transaction, pose `app.tenant_id` en `SET LOCAL`, exécute `work`, COMMIT (ROLLBACK sur erreur).
  - `@Injectable() TenantContextService { run<T>(tenantId, work): Promise<T> }`.
  - `createTestApp(appUrl): Promise<INestApplication>` (`helpers/app.ts`) — bootstrap Nest de test câblé sur le pool `factelec_app`.

- [ ] **Step 1 : Écrire le test qui échoue (contexte tenant scoping + rollback)**

`apps/api/tests/e2e/tenant-context.e2e.test.ts` :
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { runInTenant } from '../../src/db/tenant-context.js'
import { sql } from 'drizzle-orm'
import { startTestDb, type TestDb } from './helpers/postgres.js'

describe('runInTenant (transaction + SET LOCAL)', () => {
  let db: TestDb
  let ownerPool: pg.Pool
  let appPool: pg.Pool
  let tenantA: string
  let tenantB: string

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    appPool = new pg.Pool({ connectionString: db.appUrl })
    const a = await ownerPool.query("INSERT INTO tenants (name) VALUES ('A') RETURNING id")
    const b = await ownerPool.query("INSERT INTO tenants (name) VALUES ('B') RETURNING id")
    tenantA = a.rows[0].id
    tenantB = b.rows[0].id
    await ownerPool.query(
      `INSERT INTO invoices (tenant_id, number, type_code, issue_date, currency, canonical)
       VALUES ($1, 'A-1', '380', '2026-07-13', 'EUR', '{}'::jsonb)`,
      [tenantA],
    )
  })
  afterAll(async () => {
    await appPool.end(); await ownerPool.end(); await db.stop()
  })

  it('scopes reads to the current tenant', async () => {
    const seenByA = await runInTenant(appPool, tenantA, async (d) => {
      const r = await d.execute(sql`SELECT count(*)::int AS n FROM invoices`)
      return (r.rows[0] as { n: number }).n
    })
    const seenByB = await runInTenant(appPool, tenantB, async (d) => {
      const r = await d.execute(sql`SELECT count(*)::int AS n FROM invoices`)
      return (r.rows[0] as { n: number }).n
    })
    expect(seenByA).toBe(1)
    expect(seenByB).toBe(0)
  })

  it('resets the GUC after the transaction (no leak on the pooled connection)', async () => {
    await runInTenant(appPool, tenantA, async (d) => {
      await d.execute(sql`SELECT 1`)
    })
    // Hors transaction, aucun contexte : fail-closed.
    const r = await appPool.query('SELECT count(*)::int AS n FROM invoices')
    expect(r.rows[0].n).toBe(0)
  })

  it('rolls back on error', async () => {
    await expect(
      runInTenant(appPool, tenantA, async (d) => {
        await d.execute(sql`INSERT INTO invoices (tenant_id, number, type_code, issue_date, currency, canonical)
          VALUES (${tenantA}, 'A-2', '380', '2026-07-13', 'EUR', '{}'::jsonb)`)
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    const after = await runInTenant(appPool, tenantA, async (d) => {
      const r = await d.execute(sql`SELECT count(*)::int AS n FROM invoices`)
      return (r.rows[0] as { n: number }).n
    })
    expect(after).toBe(1) // A-2 annulée
  })
})
```

Run: `pnpm --filter @factelec/api test -- tenant-context`
Expected: FAIL — `runInTenant`/`client.js` absents.

- [ ] **Step 2 : Client + token + runInTenant**

`apps/api/src/db/client.ts` :
```ts
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema.js'

export const APP_POOL = Symbol('APP_POOL')
export type Db = NodePgDatabase<typeof schema>

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10 })
}

export function createDb(pool: pg.Pool): Db {
  return drizzle(pool, { schema })
}
```

`apps/api/src/db/tenant-context.ts` :
```ts
import { drizzle } from 'drizzle-orm/node-postgres'
import type pg from 'pg'
import type { Db } from './client.js'
import * as schema from './schema.js'

// Exécute `work` dans UNE transaction où app.tenant_id est posé en SET LOCAL
// (set_config(..., true) → is_local=true) : réinitialisé au COMMIT/ROLLBACK,
// donc aucune fuite de tenant entre requêtes sur une connexion mutualisée.
export async function runInTenant<T>(
  pool: pg.Pool,
  tenantId: string,
  work: (db: Db) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId])
    const db = drizzle(client, { schema })
    const result = await work(db)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
```

- [ ] **Step 3 : Service injectable + module DB (arrêt propre)**

`apps/api/src/db/tenant-context.service.ts` :
```ts
import { Inject, Injectable } from '@nestjs/common'
import type pg from 'pg'
import { APP_POOL, type Db } from './client.js'
import { runInTenant } from './tenant-context.js'

@Injectable()
export class TenantContextService {
  constructor(@Inject(APP_POOL) private readonly pool: pg.Pool) {}

  run<T>(tenantId: string, work: (db: Db) => Promise<T>): Promise<T> {
    return runInTenant(this.pool, tenantId, work)
  }
}
```

`apps/api/src/db/db.module.ts` :
```ts
import { Global, Inject, Module, type OnModuleDestroy } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type pg from 'pg'
import type { EnvConfig } from '../config/env.js'
import { APP_POOL, createPool } from './client.js'
import { TenantContextService } from './tenant-context.service.js'

@Global()
@Module({
  providers: [
    {
      provide: APP_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvConfig, true>) =>
        createPool(config.get('DATABASE_URL', { infer: true })),
    },
    TenantContextService,
  ],
  exports: [APP_POOL, TenantContextService],
})
export class DbModule implements OnModuleDestroy {
  constructor(@Inject(APP_POOL) private readonly pool: pg.Pool) {}

  async onModuleDestroy(): Promise<void> {
    await this.pool.end() // fermeture du pool à l'arrêt (enableShutdownHooks)
  }
}
```

- [ ] **Step 4 : Readiness DB (terminus) + câblage app.module**

`apps/api/src/health/health.module.ts` :
```ts
import { Module } from '@nestjs/common'
import { TerminusModule } from '@nestjs/terminus'
import { HealthController } from './health.controller.js'

@Module({ imports: [TerminusModule], controllers: [HealthController] })
export class HealthModule {}
```

`apps/api/src/health/health.controller.ts` :
```ts
import { Controller, Get, Inject } from '@nestjs/common'
import { HealthCheck, HealthCheckService } from '@nestjs/terminus'
import type pg from 'pg'
import { APP_POOL } from '../db/client.js'

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    @Inject(APP_POOL) private readonly pool: pg.Pool,
  ) {}

  @Get()
  liveness(): { status: 'ok' } {
    return { status: 'ok' }
  }

  @Get('ready')
  @HealthCheck()
  readiness() {
    return this.health.check([
      async () => {
        await this.pool.query('SELECT 1')
        return { database: { status: 'up' } }
      },
    ])
  }
}
```

`apps/api/src/app.module.ts` — ajouter `DbModule` :
```ts
import { Module } from '@nestjs/common'
import { AppConfigModule } from './config/config.module.js'
import { DbModule } from './db/db.module.js'
import { HealthModule } from './health/health.module.js'
import { AppLoggerModule } from './logging/logger.module.js'

@Module({ imports: [AppConfigModule, AppLoggerModule, DbModule, HealthModule] })
export class AppModule {}
```

> Le test e2e `health.e2e.test.ts` de Task 2 importait `HealthModule` seul ; il faut désormais un `APP_POOL`. Mettre à jour ce test pour monter l'app via `createTestApp` (Step 5) **ou** fournir un `APP_POOL` factice `{ query: async () => ({ rows: [{ '?column?': 1 }] }) }`. Choisir le helper `createTestApp` pour rester sur du Postgres réel (pas de mock de persistance en e2e).

- [ ] **Step 5 : Helper d'app de test (pool app-role réel)**

`apps/api/tests/e2e/helpers/app.ts` :
```ts
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import helmet from 'helmet'
import { AppModule } from '../../src/app.module.js'
import { APP_POOL, createPool } from '../../src/db/client.js'
import { ProblemDetailsFilter } from '../../src/common/http-exception.filter.js'

// Monte l'app complète en pointant le pool applicatif sur l'URL factelec_app du
// conteneur de test (override du provider APP_POOL par DATABASE_URL).
export async function createTestApp(appUrl: string): Promise<INestApplication> {
  process.env.DATABASE_URL = appUrl
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_POOL)
    .useFactory({ factory: () => createPool(appUrl) })
    .compile()
  const app = moduleRef.createNestApplication({ bufferLogs: true })
  app.use(helmet())
  app.useGlobalFilters(new ProblemDetailsFilter())
  app.enableShutdownHooks()
  await app.init()
  return app
}
```
> Le pool overridé est fermé par `DbModule.onModuleDestroy` à `app.close()`. `LOG_LEVEL=silent` dans l'env de test pour ne pas polluer la sortie.

- [ ] **Step 6 : Verdir + vérifier readiness**

Run: `pnpm --filter @factelec/api test -- tenant-context health`
Expected: PASS (scoping, reset GUC, rollback, `GET /health` 200, `GET /health/ready` avec `database: up`).

- [ ] **Step 7 : Vérifier l'ensemble et committer**

Run: `pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test`
Expected: PASS, couverture ≥ 90 %.

```bash
git add -A
git commit -m "feat(api): contexte tenant transactionnel (SET LOCAL), module DB, readiness Postgres"
```

---

### Task 6 : Auth multi-tenant — clés API Argon2id, guard, `@CurrentTenant`, rate limiting

**Files:**
- Create: `apps/api/src/auth/api-key.ts`, `apps/api/src/auth/api-key.service.ts`, `apps/api/src/auth/api-key.guard.ts`, `apps/api/src/auth/current-tenant.decorator.ts`, `apps/api/src/auth/auth.module.ts`
- Create: `apps/api/scripts/provision-tenant.ts`
- Create: `apps/api/tests/unit/api-key.test.ts`, `apps/api/tests/e2e/helpers/seed.ts`, `apps/api/tests/e2e/auth.e2e.test.ts`
- Modify: `apps/api/src/app.module.ts` (importer `AuthModule`)

**Interfaces:**
- Produces (utilisé par ingestion + lecture) :
  - `generateApiKey(): Promise<{ token; prefix; secretHash }>` ; `parseApiKeyToken(token): { prefix; secret } | null` ; `verifySecret(hash, secret): Promise<boolean>`.
  - `@Injectable() ApiKeyService { authenticate(token): Promise<{ apiKeyId; tenantId } | null> }`.
  - `@Injectable() ApiKeyGuard` (attend `Authorization: Bearer fk_…`, pose `req.tenantId`/`req.apiKeyId`, 401 problem+json sinon) ; `interface TenantRequest`.
  - `@CurrentTenant(): string` (param decorator).
  - `AuthModule` (exporte `ApiKeyService`, `ApiKeyGuard` ; enregistre le rate limiting global).
  - `seedTenantWithKey(ownerPool): Promise<{ tenantId; token }>` (helper de test).

- [ ] **Step 1 : Écrire les tests unitaires qui échouent**

`apps/api/tests/unit/api-key.test.ts` :
```ts
import { describe, expect, it } from 'vitest'
import { generateApiKey, parseApiKeyToken, verifySecret } from '../../src/auth/api-key.js'

describe('api key format', () => {
  it('parses a well-formed token', () => {
    expect(parseApiKeyToken('fk_abc123.secretpart')).toEqual({
      prefix: 'abc123',
      secret: 'secretpart',
    })
  })

  it('rejects malformed tokens', () => {
    for (const t of ['', 'nope', 'fk_only', 'fk_.secret', 'fk_prefix.', 'Bearer x']) {
      expect(parseApiKeyToken(t)).toBeNull()
    }
  })

  it('generates a token whose secret verifies against its hash (argon2id round-trip)', async () => {
    const key = await generateApiKey()
    const parsed = parseApiKeyToken(key.token)
    expect(parsed?.prefix).toBe(key.prefix)
    expect(key.secretHash.startsWith('$argon2id$')).toBe(true)
    expect(await verifySecret(key.secretHash, parsed!.secret)).toBe(true)
    expect(await verifySecret(key.secretHash, 'wrong-secret')).toBe(false)
  })

  it('never repeats prefixes/secrets', async () => {
    const [a, b] = await Promise.all([generateApiKey(), generateApiKey()])
    expect(a.prefix).not.toBe(b.prefix)
    expect(a.token).not.toBe(b.token)
  })
})
```

Run: `pnpm --filter @factelec/api test -- api-key`
Expected: FAIL — module absent.

- [ ] **Step 2 : Implémenter le format de clé (Argon2id)**

`apps/api/src/auth/api-key.ts` :
```ts
import { randomBytes } from 'node:crypto'
import { Algorithm, hash, verify } from '@node-rs/argon2'

const PREFIX_BYTES = 12 // 24 hex
const SECRET_BYTES = 32 // 43 base64url

// Paramètres OWASP Argon2id (Password Storage Cheat Sheet) : m=19 MiB, t=2, p=1.
const ARGON2_OPTS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const

export interface GeneratedApiKey {
  token: string // montré UNE fois au client
  prefix: string // stocké en clair (identifiant de lookup, non secret)
  secretHash: string // stocké (argon2id) — le secret n'est JAMAIS stocké
}

export async function generateApiKey(): Promise<GeneratedApiKey> {
  const prefix = randomBytes(PREFIX_BYTES).toString('hex')
  const secret = randomBytes(SECRET_BYTES).toString('base64url')
  const secretHash = await hash(secret, ARGON2_OPTS)
  return { token: `fk_${prefix}.${secret}`, prefix, secretHash }
}

export interface ParsedToken {
  prefix: string
  secret: string
}

export function parseApiKeyToken(token: string): ParsedToken | null {
  if (!token.startsWith('fk_')) return null
  const rest = token.slice(3)
  const dot = rest.indexOf('.')
  if (dot <= 0 || dot === rest.length - 1) return null
  return { prefix: rest.slice(0, dot), secret: rest.slice(dot + 1) }
}

export function verifySecret(secretHash: string, secret: string): Promise<boolean> {
  // Les paramètres/sel sont encodés dans le hash → pas d'options nécessaires.
  return verify(secretHash, secret)
}

// Égalise le temps de réponse quand le préfixe est inconnu (pas d'oracle temporel).
let dummyHash: string | null = null
export async function timingSafeReject(secret: string): Promise<void> {
  if (!dummyHash) dummyHash = await hash('timing-equalizer', ARGON2_OPTS)
  await verify(dummyHash, secret).catch(() => undefined)
}
```

- [ ] **Step 3 : Service d'authentification (lookup SECURITY DEFINER + argon2)**

`apps/api/src/auth/api-key.service.ts` :
```ts
import { Inject, Injectable } from '@nestjs/common'
import type pg from 'pg'
import { APP_POOL } from '../db/client.js'
import { parseApiKeyToken, timingSafeReject, verifySecret } from './api-key.js'

export interface AuthenticatedKey {
  apiKeyId: string
  tenantId: string
}

@Injectable()
export class ApiKeyService {
  constructor(@Inject(APP_POOL) private readonly pool: pg.Pool) {}

  // Renvoie le tenant si le token est valide et actif, sinon null. Ne distingue
  // jamais "préfixe inconnu" de "secret invalide" (pas d'oracle d'énumération).
  async authenticate(token: string): Promise<AuthenticatedKey | null> {
    const parsed = parseApiKeyToken(token)
    if (!parsed) return null

    const res = await this.pool.query<{
      api_key_id: string
      tenant_id: string
      secret_hash: string
      revoked_at: Date | null
    }>(
      'SELECT api_key_id, tenant_id, secret_hash, revoked_at FROM authenticate_api_key($1)',
      [parsed.prefix],
    )
    const row = res.rows[0]
    if (!row || row.revoked_at) {
      await timingSafeReject(parsed.secret)
      return null
    }
    if (!(await verifySecret(row.secret_hash, parsed.secret))) return null
    return { apiKeyId: row.api_key_id, tenantId: row.tenant_id }
  }
}
```
> `last_used_at` : mise à jour best-effort possible dans le contexte tenant (une fois la RLS satisfaite), reportée pour rester dans le périmètre 1.3 (non fonctionnel critique). Consigner en TODO.

- [ ] **Step 4 : Guard + décorateur + module (rate limiting)**

`apps/api/src/auth/api-key.guard.ts` :
```ts
import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import type { Request } from 'express'
import { problem, ProblemType } from '../common/problem.js'
import { ApiKeyService } from './api-key.service.js'

export interface TenantRequest extends Request {
  tenantId?: string
  apiKeyId?: string
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly apiKeys: ApiKeyService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<TenantRequest>()
    const header = req.header('authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    const auth = token ? await this.apiKeys.authenticate(token) : null
    if (!auth) {
      throw new UnauthorizedException(
        problem(401, ProblemType.unauthorized, 'Unauthorized', {
          detail: 'Missing or invalid API key',
        }),
      )
    }
    req.tenantId = auth.tenantId
    req.apiKeyId = auth.apiKeyId
    return true
  }
}
```

`apps/api/src/auth/current-tenant.decorator.ts` :
```ts
import { createParamDecorator, type ExecutionContext } from '@nestjs/common'
import type { TenantRequest } from './api-key.guard.js'

export const CurrentTenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<TenantRequest>()
    if (!req.tenantId) throw new Error('CurrentTenant used without ApiKeyGuard')
    return req.tenantId
  },
)
```

`apps/api/src/auth/auth.module.ts` :
```ts
import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { APP_GUARD } from '@nestjs/core'
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler'
import type { EnvConfig } from '../config/env.js'
import { ApiKeyGuard } from './api-key.guard.js'
import { ApiKeyService } from './api-key.service.js'

@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvConfig, true>) => ({
        throttlers: [
          {
            ttl: config.get('RATE_LIMIT_TTL', { infer: true }) * 1000,
            limit: config.get('RATE_LIMIT_LIMIT', { infer: true }),
          },
        ],
      }),
    }),
  ],
  providers: [
    ApiKeyService,
    ApiKeyGuard,
    { provide: APP_GUARD, useClass: ThrottlerGuard }, // rate limiting global (par IP en amont de l'auth)
  ],
  exports: [ApiKeyService, ApiKeyGuard],
})
export class AuthModule {}
```
> Le rate limiting global agit **par IP** (les guards globaux s'exécutent avant les guards de contrôleur, donc `req.tenantId` n'est pas encore posé). Un throttle **par clé/tenant** est un raffinement 1.4 (custom `getTracker`). Documenté.

`apps/api/src/app.module.ts` — ajouter `AuthModule` aux imports.

- [ ] **Step 5 : Script de provisioning (chemin owner privilégié) + helper de seed**

`apps/api/scripts/provision-tenant.ts` (connexion **owner**, jamais le runtime) :
```ts
import pg from 'pg'
import { generateApiKey } from '../src/auth/api-key.js'

const ownerUrl = process.env.DATABASE_OWNER_URL
if (!ownerUrl) throw new Error('DATABASE_OWNER_URL is required')
const name = process.argv[2]
if (!name) throw new Error('usage: provision:tenant <name> [label]')
const label = process.argv[3] ?? 'default'

const pool = new pg.Pool({ connectionString: ownerUrl })
const t = await pool.query('INSERT INTO tenants (name) VALUES ($1) RETURNING id', [name])
const tenantId = t.rows[0].id
const key = await generateApiKey()
await pool.query(
  'INSERT INTO api_keys (tenant_id, prefix, secret_hash, label) VALUES ($1, $2, $3, $4)',
  [tenantId, key.prefix, key.secretHash, label],
)
await pool.end()
// Le token n'est révélé qu'ICI, une seule fois.
console.log(JSON.stringify({ tenantId, token: key.token }, null, 2))
```

`apps/api/tests/e2e/helpers/seed.ts` :
```ts
import type pg from 'pg'
import { generateApiKey } from '../../../src/auth/api-key.js'

export async function seedTenantWithKey(
  ownerPool: pg.Pool,
  name = 'Tenant',
): Promise<{ tenantId: string; token: string }> {
  const t = await ownerPool.query('INSERT INTO tenants (name) VALUES ($1) RETURNING id', [name])
  const tenantId = t.rows[0].id
  const key = await generateApiKey()
  await ownerPool.query(
    'INSERT INTO api_keys (tenant_id, prefix, secret_hash, label) VALUES ($1, $2, $3, $4)',
    [tenantId, key.prefix, key.secretHash, 'test'],
  )
  return { tenantId, token: key.token }
}
```

- [ ] **Step 6 : Test e2e du guard + rate limit**

`apps/api/tests/e2e/auth.e2e.test.ts` — monte un contrôleur de test gardé pour isoler l'auth :
```ts
import { Controller, Get, INestApplication, Module, UseGuards } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ApiKeyGuard } from '../../src/auth/api-key.guard.js'
import { ApiKeyService } from '../../src/auth/api-key.service.js'
import { CurrentTenant } from '../../src/auth/current-tenant.decorator.js'
import { APP_POOL, createPool } from '../../src/db/client.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { seedTenantWithKey } from './helpers/seed.js'

@Controller('whoami')
class WhoamiController {
  @UseGuards(ApiKeyGuard)
  @Get()
  whoami(@CurrentTenant() tenantId: string): { tenantId: string } {
    return { tenantId }
  }
}

@Module({
  controllers: [WhoamiController],
  providers: [ApiKeyService, ApiKeyGuard],
})
class WhoamiModule {}

describe('ApiKeyGuard (e2e)', () => {
  let db: TestDb
  let ownerPool: pg.Pool
  let app: INestApplication
  let token: string
  let tenantId: string

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    ;({ token, tenantId } = await seedTenantWithKey(ownerPool))
    const mod = await Test.createTestingModule({ imports: [WhoamiModule] })
      .overrideProvider(APP_POOL)
      .useFactory({ factory: () => createPool(db.appUrl) })
      .compile()
    app = mod.createNestApplication()
    await app.init()
  })
  afterAll(async () => {
    await app.close(); await ownerPool.end(); await db.stop()
  })

  it('rejects a request without a key (401 problem+json)', async () => {
    const res = await request(app.getHttpServer()).get('/whoami')
    expect(res.status).toBe(401)
    expect(res.body.type).toBe('urn:factelec:problem:unauthorized')
  })

  it('rejects an invalid key (401)', async () => {
    await request(app.getHttpServer())
      .get('/whoami')
      .set('Authorization', 'Bearer fk_deadbeef.invalid')
      .expect(401)
  })

  it('accepts a valid key and resolves the tenant', async () => {
    const res = await request(app.getHttpServer())
      .get('/whoami')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(res.body.tenantId).toBe(tenantId)
  })

  it('rejects a revoked key (401)', async () => {
    const { token: revoked } = await seedTenantWithKey(ownerPool, 'Revoked')
    const prefix = revoked.slice(3, revoked.indexOf('.'))
    await ownerPool.query('UPDATE api_keys SET revoked_at = now() WHERE prefix = $1', [prefix])
    await request(app.getHttpServer())
      .get('/whoami')
      .set('Authorization', `Bearer ${revoked}`)
      .expect(401)
  })
})
```

Run: `pnpm --filter @factelec/api test -- api-key auth`
Expected: PASS (unit + e2e). (Le test de rate limit dédié 429 est ajouté en Task 8 avec les endpoints réels.)

- [ ] **Step 7 : Vérifier l'ensemble et committer**

Run: `pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test`
Expected: PASS, couverture ≥ 90 %.

```bash
git add -A
git commit -m "feat(api): auth par clés API Argon2id (lookup SECURITY DEFINER), guard tenant, rate limiting"
```

---

### Task 7 : Ingestion `POST /invoices` (validation, génération synchrone, persistance, idempotence)

**Files:**
- Create: `apps/api/src/invoices/format-generator.port.ts`, `apps/api/src/invoices/synchronous-format-generator.ts`
- Create: `apps/api/src/invoices/invoices.repository.ts`, `apps/api/src/invoices/invoices.service.ts`, `apps/api/src/invoices/invoices.controller.ts`, `apps/api/src/invoices/invoices.module.ts`
- Modify: `apps/api/src/app.module.ts` (importer `InvoicesModule`)
- Create: `apps/api/tests/unit/format-generator.test.ts`, `apps/api/tests/e2e/ingestion.e2e.test.ts`

**Interfaces:**
- Produces (utilisé par lecture Task 8) :
  - `type FormatKind = 'ubl'|'cii'|'facturx'|'flux_base'|'flux_full'` ; `interface GeneratedFormat` ; `interface InvoiceFormatGenerator { generate(invoice): Promise<GeneratedFormat[]> }` ; `const INVOICE_FORMAT_GENERATOR: symbol` (port — cf. risque n°4, un adaptateur BullMQ le remplacera).
  - `InvoicesRepository.persist(tenantId, invoice, formats): Promise<{ id }>` (transaction tenant, RLS) ; `existsByNumber(tenantId, number)`. (Les méthodes de lecture sont ajoutées en Task 8.)
  - `InvoicesService.ingest(tenantId, payload): Promise<{ id; status }>` — 422 zod / 422 règles / 409 idempotence.

- [ ] **Step 1 : Écrire le test unitaire du générateur (échoue)**

`apps/api/tests/unit/format-generator.test.ts` :
```ts
import { buildInvoice, type InvoiceInput } from '@factelec/invoice-core'
import { describe, expect, it } from 'vitest'
import { SynchronousFormatGenerator } from '../../src/invoices/synchronous-format-generator.js'

const input: InvoiceInput = {
  number: 'FA-2026-100',
  issueDate: '2026-07-13',
  dueDate: '2026-08-12',
  typeCode: '380',
  currency: 'EUR',
  businessProcessType: 'S1',
  seller: { name: 'Vendeur', address: { countryCode: 'FR' } },
  buyer: { name: 'Acheteur', address: { countryCode: 'FR' } },
  lines: [
    { id: '1', name: 'Service', quantity: '1', unitCode: 'C62', unitPrice: '100.00', vatCategory: 'S', vatRate: '20.00' },
  ],
}

describe('SynchronousFormatGenerator', () => {
  it('produces UBL, CII, Factur-X and both flux extracts (businessProcessType present)', async () => {
    const out = await new SynchronousFormatGenerator().generate(buildInvoice(input))
    const byKind = Object.fromEntries(out.map((f) => [f.kind, f]))
    expect(Object.keys(byKind).sort()).toEqual(['cii', 'facturx', 'flux_base', 'flux_full', 'ubl'])
    expect(byKind.ubl.contentType).toBe('application/xml')
    expect(byKind.ubl.bodyText).toContain('<Invoice')
    expect(byKind.facturx.contentType).toBe('application/pdf')
    expect(byKind.facturx.bodyBytes?.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(byKind.facturx.byteSize).toBeGreaterThan(0)
  })

  it('omits flux extracts when businessProcessType is absent', async () => {
    const noProc = buildInvoice({ ...input, businessProcessType: undefined })
    const kinds = (await new SynchronousFormatGenerator().generate(noProc)).map((f) => f.kind)
    expect(kinds).toEqual(['ubl', 'cii', 'facturx'])
  })
})
```

Run: `pnpm --filter @factelec/api test -- format-generator`
Expected: FAIL — adaptateur absent.

- [ ] **Step 2 : Port + adaptateur synchrone (invoice-core via exports map)**

`apps/api/src/invoices/format-generator.port.ts` :
```ts
import type { Invoice } from '@factelec/invoice-core'

export type FormatKind = 'ubl' | 'cii' | 'facturx' | 'flux_base' | 'flux_full'

export interface GeneratedFormat {
  kind: FormatKind
  contentType: string
  bodyText: string | null
  bodyBytes: Buffer | null
  byteSize: number
}

// Port : la génération est synchrone en 1.3 (SynchronousFormatGenerator) ; un
// adaptateur BullMQ pourra l'implémenter en 1.4/2.x sans toucher l'ingestion.
export interface InvoiceFormatGenerator {
  generate(invoice: Invoice): Promise<GeneratedFormat[]>
}

export const INVOICE_FORMAT_GENERATOR = Symbol('INVOICE_FORMAT_GENERATOR')
```

`apps/api/src/invoices/synchronous-format-generator.ts` :
```ts
import {
  generateCii,
  generateFacturX,
  generateFluxExtractUbl,
  generateUbl,
  type Invoice,
} from '@factelec/invoice-core'
import { Injectable } from '@nestjs/common'
import type { FormatKind, GeneratedFormat, InvoiceFormatGenerator } from './format-generator.port.js'

const XML = 'application/xml'
const PDF = 'application/pdf'

function text(kind: FormatKind, contentType: string, body: string): GeneratedFormat {
  return { kind, contentType, bodyText: body, bodyBytes: null, byteSize: Buffer.byteLength(body) }
}
function bytes(kind: FormatKind, contentType: string, body: Buffer): GeneratedFormat {
  return { kind, contentType, bodyText: null, bodyBytes: body, byteSize: body.length }
}

@Injectable()
export class SynchronousFormatGenerator implements InvoiceFormatGenerator {
  // eslint: méthode async pour respecter le port (future file BullMQ).
  async generate(invoice: Invoice): Promise<GeneratedFormat[]> {
    const formats: GeneratedFormat[] = [
      text('ubl', XML, generateUbl(invoice)),
      text('cii', XML, generateCii(invoice)),
      bytes('facturx', PDF, Buffer.from(await generateFacturX(invoice))),
    ]
    if (invoice.businessProcessType) {
      formats.push(text('flux_base', XML, generateFluxExtractUbl(invoice, 'BASE')))
      formats.push(text('flux_full', XML, generateFluxExtractUbl(invoice, 'FULL')))
    }
    return formats
  }
}
```

- [ ] **Step 3 : Repository (persistance en transaction tenant)**

`apps/api/src/invoices/invoices.repository.ts` :
```ts
import type { Invoice } from '@factelec/invoice-core'
import { Injectable } from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import { TenantContextService } from '../db/tenant-context.service.js'
import { invoiceFormats, invoices } from '../db/schema.js'
import type { GeneratedFormat } from './format-generator.port.js'

@Injectable()
export class InvoicesRepository {
  constructor(private readonly tenant: TenantContextService) {}

  // Persiste la facture + tous ses formats dans UNE transaction tenant (RLS).
  async persist(
    tenantId: string,
    invoice: Invoice,
    formats: GeneratedFormat[],
  ): Promise<{ id: string }> {
    return this.tenant.run(tenantId, async (db) => {
      const [row] = await db
        .insert(invoices)
        .values({
          tenantId,
          number: invoice.number,
          typeCode: invoice.typeCode,
          issueDate: invoice.issueDate,
          currency: invoice.currency,
          status: 'generated',
          canonical: invoice,
        })
        .returning({ id: invoices.id })
      const invoiceId = row!.id
      await db.insert(invoiceFormats).values(
        formats.map((f) => ({
          tenantId,
          invoiceId,
          kind: f.kind,
          contentType: f.contentType,
          bodyText: f.bodyText,
          bodyBytes: f.bodyBytes,
          byteSize: f.byteSize,
        })),
      )
      return { id: invoiceId }
    })
  }

  async existsByNumber(tenantId: string, number: string): Promise<boolean> {
    return this.tenant.run(tenantId, async (db) => {
      const rows = await db
        .select({ id: invoices.id })
        .from(invoices)
        .where(and(eq(invoices.tenantId, tenantId), eq(invoices.number, number)))
        .limit(1)
      return rows.length > 0
    })
  }
}
```

- [ ] **Step 4 : Service d'ingestion (pipeline validation → génération → persistance)**

`apps/api/src/invoices/invoices.service.ts` :
```ts
import {
  buildInvoice,
  parseInvoiceInput,
  validateBusinessRules,
} from '@factelec/invoice-core'
import {
  ConflictException,
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common'
import { z } from 'zod'
import { problem, ProblemType } from '../common/problem.js'
import {
  INVOICE_FORMAT_GENERATOR,
  type InvoiceFormatGenerator,
} from './format-generator.port.js'
import { InvoicesRepository } from './invoices.repository.js'

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505'
}

@Injectable()
export class InvoicesService {
  constructor(
    private readonly repo: InvoicesRepository,
    @Inject(INVOICE_FORMAT_GENERATOR)
    private readonly generator: InvoiceFormatGenerator,
  ) {}

  async ingest(tenantId: string, payload: unknown): Promise<{ id: string; status: string }> {
    // 1) Validation structurelle (zod) → 422 structuré.
    let input
    try {
      input = parseInvoiceInput(payload)
    } catch (e) {
      if (e instanceof z.ZodError) {
        throw new UnprocessableEntityException(
          problem(422, ProblemType.validation, 'Invalid invoice payload', {
            errors: e.issues.map((i) => ({
              path: i.path.join('.'),
              code: i.code,
              message: i.message,
            })),
          }),
        )
      }
      throw e
    }

    // 2) Calcul canonique + règles métier EN 16931 → 422 métier.
    const invoice = buildInvoice(input)
    const violations = validateBusinessRules(invoice)
    if (violations.length > 0) {
      throw new UnprocessableEntityException(
        problem(422, ProblemType.businessRule, 'Business rule violations', {
          errors: violations,
        }),
      )
    }

    // 3) Génération synchrone des formats du socle (port).
    const formats = await this.generator.generate(invoice)

    // 4) Persistance (idempotence : unique(tenant, number) → 409).
    try {
      const { id } = await this.repo.persist(tenantId, invoice, formats)
      return { id, status: 'generated' }
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException(
          problem(409, ProblemType.conflict, 'Invoice already exists', {
            detail: `An invoice with number "${invoice.number}" already exists for this tenant`,
          }),
        )
      }
      throw e
    }
  }
}
```

- [ ] **Step 5 : Contrôleur + module + câblage**

`apps/api/src/invoices/invoices.controller.ts` :
```ts
import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common'
import { ApiKeyGuard } from '../auth/api-key.guard.js'
import { CurrentTenant } from '../auth/current-tenant.decorator.js'
import { InvoicesService } from './invoices.service.js'

@UseGuards(ApiKeyGuard)
@Controller('invoices')
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Post()
  @HttpCode(201)
  ingest(
    @CurrentTenant() tenantId: string,
    @Body() body: unknown,
  ): Promise<{ id: string; status: string }> {
    return this.invoices.ingest(tenantId, body)
  }
}
```

`apps/api/src/invoices/invoices.module.ts` :
```ts
import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module.js'
import { INVOICE_FORMAT_GENERATOR } from './format-generator.port.js'
import { InvoicesController } from './invoices.controller.js'
import { InvoicesRepository } from './invoices.repository.js'
import { InvoicesService } from './invoices.service.js'
import { SynchronousFormatGenerator } from './synchronous-format-generator.js'

@Module({
  imports: [AuthModule],
  controllers: [InvoicesController],
  providers: [
    InvoicesService,
    InvoicesRepository,
    { provide: INVOICE_FORMAT_GENERATOR, useClass: SynchronousFormatGenerator },
  ],
})
export class InvoicesModule {}
```

`apps/api/src/app.module.ts` — ajouter `AuthModule` et `InvoicesModule` aux imports.

- [ ] **Step 6 : Test e2e d'ingestion (201 / 422 zod / 422 règles / 409)**

`apps/api/tests/e2e/ingestion.e2e.test.ts` :
```ts
import type { INestApplication } from '@nestjs/common'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { seedTenantWithKey } from './helpers/seed.js'

const valid = {
  number: 'FA-2026-1',
  issueDate: '2026-07-13',
  dueDate: '2026-08-12',
  typeCode: '380',
  currency: 'EUR',
  businessProcessType: 'S1',
  seller: { name: 'Vendeur', address: { countryCode: 'FR' } },
  buyer: { name: 'Acheteur', address: { countryCode: 'FR' } },
  lines: [{ id: '1', name: 'Service', quantity: '1', unitCode: 'C62', unitPrice: '100.00', vatCategory: 'S', vatRate: '20.00' }],
}

describe('POST /invoices (e2e)', () => {
  let db: TestDb
  let ownerPool: pg.Pool
  let app: INestApplication
  let token: string
  const auth = () => `Bearer ${token}`

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    ;({ token } = await seedTenantWithKey(ownerPool))
    app = await createTestApp(db.appUrl)
  })
  afterAll(async () => { await app.close(); await ownerPool.end(); await db.stop() })

  it('ingests a valid invoice → 201 with id + status', async () => {
    const res = await request(app.getHttpServer())
      .post('/invoices').set('Authorization', auth()).send(valid).expect(201)
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(res.body.status).toBe('generated')
    // persistance des 5 formats
    const n = await ownerPool.query('SELECT count(*)::int AS n FROM invoice_formats WHERE invoice_id = $1', [res.body.id])
    expect(n.rows[0].n).toBe(5)
  })

  it('rejects a structurally invalid payload → 422 validation', async () => {
    const res = await request(app.getHttpServer())
      .post('/invoices').set('Authorization', auth())
      .send({ ...valid, number: undefined }).expect(422)
    expect(res.headers['content-type']).toContain('application/problem+json')
    expect(res.body.type).toBe('urn:factelec:problem:validation-error')
    expect(res.body.errors.some((e: { path: string }) => e.path === 'number')).toBe(true)
  })

  it('rejects a business-rule violation → 422 businessRule (exempt category without reason, BR-E-10)', async () => {
    const res = await request(app.getHttpServer())
      .post('/invoices').set('Authorization', auth())
      .send({
        ...valid,
        number: 'FA-2026-E',
        lines: [{ id: '1', name: 'Export', quantity: '1', unitCode: 'C62', unitPrice: '100.00', vatCategory: 'E', vatRate: '0.00' }],
      })
      .expect(422)
    expect(res.body.type).toBe('urn:factelec:problem:business-rule-violation')
    expect(res.body.errors.some((v: { rule: string }) => v.rule === 'BR-E-10')).toBe(true)
  })

  it('is idempotent on (tenant, number) → 409 on duplicate', async () => {
    const body = { ...valid, number: 'FA-2026-DUP' }
    await request(app.getHttpServer()).post('/invoices').set('Authorization', auth()).send(body).expect(201)
    const res = await request(app.getHttpServer()).post('/invoices').set('Authorization', auth()).send(body).expect(409)
    expect(res.body.type).toBe('urn:factelec:problem:conflict')
  })
})
```

Run: `pnpm --filter @factelec/api test -- format-generator ingestion`
Expected: PASS.

- [ ] **Step 7 : Vérifier l'ensemble et committer**

Run: `pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test`
Expected: PASS, couverture ≥ 90 %.

```bash
git add -A
git commit -m "feat(api): ingestion POST /invoices (validation invoice-core, génération synchrone, idempotence)"
```

---

### Task 8 : Lecture (`GET`) + isolation cross-tenant (404 bloquant) + rate limit

**Files:**
- Modify: `apps/api/src/invoices/invoices.repository.ts` (`findById`, `list`, `findFormat`, `listFormatKinds`)
- Modify: `apps/api/src/invoices/invoices.service.ts` (`get`, `list`, `getFormat`)
- Modify: `apps/api/src/invoices/invoices.controller.ts` (routes GET)
- Create: `apps/api/src/invoices/cursor.ts`, `apps/api/src/invoices/format-kind.ts`
- Create: `apps/api/tests/unit/cursor.test.ts`
- Create: `apps/api/tests/e2e/read.e2e.test.ts`, `apps/api/tests/e2e/tenant-isolation.e2e.test.ts`, `apps/api/tests/e2e/rate-limit.e2e.test.ts`

**Interfaces:**
- Produces :
  - `InvoicesRepository.findById(tenantId, id)`, `list(tenantId, limit, cursor?)`, `findFormat(tenantId, id, kind)`, `listFormatKinds(tenantId, id)`.
  - `encodeCursor(createdAt, id)`, `decodeCursor(cursor)` (`cursor.ts`) ; `parseFormatKind(s): FormatKind | null` (`format-kind.ts`).
  - Routes : `GET /invoices` (liste keyset), `GET /invoices/:id`, `GET /invoices/:id/formats/:format` (Content-Type correct, Factur-X en `application/pdf`).

- [ ] **Step 1 : Écrire les tests qui échouent (curseur unit + lecture + isolation e2e)**

`apps/api/tests/unit/cursor.test.ts` :
```ts
import { describe, expect, it } from 'vitest'
import { decodeCursor, encodeCursor } from '../../src/invoices/cursor.js'

describe('keyset cursor', () => {
  it('round-trips createdAt + id', () => {
    const c = encodeCursor(new Date('2026-07-13T10:00:00.000Z'), '11111111-1111-1111-1111-111111111111')
    expect(decodeCursor(c)).toEqual({
      createdAt: '2026-07-13T10:00:00.000Z',
      id: '11111111-1111-1111-1111-111111111111',
    })
  })
  it('returns null on malformed cursor', () => {
    expect(decodeCursor('not-base64!!')).toBeNull()
    expect(decodeCursor(Buffer.from('nofield').toString('base64url'))).toBeNull()
  })
})
```

`apps/api/tests/e2e/tenant-isolation.e2e.test.ts` (le test **bloquant** exigé par la spec §6) :
```ts
import type { INestApplication } from '@nestjs/common'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { seedTenantWithKey } from './helpers/seed.js'

const invoice = (number: string) => ({
  number, issueDate: '2026-07-13', dueDate: '2026-08-12', typeCode: '380', currency: 'EUR',
  businessProcessType: 'S1',
  seller: { name: 'Vendeur', address: { countryCode: 'FR' } },
  buyer: { name: 'Acheteur', address: { countryCode: 'FR' } },
  lines: [{ id: '1', name: 'Service', quantity: '1', unitCode: 'C62', unitPrice: '100.00', vatCategory: 'S', vatRate: '20.00' }],
})

describe('cross-tenant isolation (e2e, MANDATORY)', () => {
  let db: TestDb
  let ownerPool: pg.Pool
  let app: INestApplication
  let tokenA: string
  let tokenB: string
  let invoiceIdA: string

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    ;({ token: tokenA } = await seedTenantWithKey(ownerPool, 'A'))
    ;({ token: tokenB } = await seedTenantWithKey(ownerPool, 'B'))
    app = await createTestApp(db.appUrl)
    const res = await request(app.getHttpServer())
      .post('/invoices').set('Authorization', `Bearer ${tokenA}`).send(invoice('A-1')).expect(201)
    invoiceIdA = res.body.id
  })
  afterAll(async () => { await app.close(); await ownerPool.end(); await db.stop() })

  it('tenant A can read its own invoice (200)', async () => {
    await request(app.getHttpServer())
      .get(`/invoices/${invoiceIdA}`).set('Authorization', `Bearer ${tokenA}`).expect(200)
  })

  it("tenant B NEVER sees tenant A's invoice (404, not 200/403 leak)", async () => {
    await request(app.getHttpServer())
      .get(`/invoices/${invoiceIdA}`).set('Authorization', `Bearer ${tokenB}`).expect(404)
  })

  it("tenant B cannot read tenant A's generated formats (404)", async () => {
    await request(app.getHttpServer())
      .get(`/invoices/${invoiceIdA}/formats/ubl`).set('Authorization', `Bearer ${tokenB}`).expect(404)
  })

  it("tenant B's listing excludes tenant A's invoices", async () => {
    const res = await request(app.getHttpServer())
      .get('/invoices').set('Authorization', `Bearer ${tokenB}`).expect(200)
    expect(res.body.items).toEqual([])
  })
})
```

`apps/api/tests/e2e/read.e2e.test.ts` (extraits ; réutilise `createTestApp`/`seedTenantWithKey`) :
```ts
  it('GET /invoices/:id returns metadata + available formats', async () => {
    const res = await request(app.getHttpServer()).get(`/invoices/${id}`).set('Authorization', auth()).expect(200)
    expect(res.body).toMatchObject({ id, number: 'R-1', typeCode: '380', status: 'generated' })
    expect(res.body.availableFormats.sort()).toEqual(['cii', 'facturx', 'flux_base', 'flux_full', 'ubl'])
  })

  it('GET a non-existent / non-uuid id → 404 (never 500)', async () => {
    await request(app.getHttpServer()).get('/invoices/not-a-uuid').set('Authorization', auth()).expect(404)
    await request(app.getHttpServer()).get('/invoices/22222222-2222-2222-2222-222222222222').set('Authorization', auth()).expect(404)
  })

  it('serves each format with the correct Content-Type', async () => {
    const ubl = await request(app.getHttpServer()).get(`/invoices/${id}/formats/ubl`).set('Authorization', auth()).expect(200)
    expect(ubl.headers['content-type']).toContain('application/xml')
    expect(ubl.text).toContain('<Invoice')
    const pdf = await request(app.getHttpServer()).get(`/invoices/${id}/formats/facturx`).set('Authorization', auth()).expect(200)
    expect(pdf.headers['content-type']).toContain('application/pdf')
    expect(pdf.body.subarray(0, 5).toString('latin1')).toBe('%PDF-')  // round-trip bytea intact
  })

  it('unknown format kind → 404', async () => {
    await request(app.getHttpServer()).get(`/invoices/${id}/formats/json`).set('Authorization', auth()).expect(404)
  })

  it('paginates by keyset (limit + nextCursor)', async () => {
    // 3 factures créées ; limit=2 → 2 items + cursor, page 2 → 1 item, cursor null
    const p1 = await request(app.getHttpServer()).get('/invoices?limit=2').set('Authorization', auth()).expect(200)
    expect(p1.body.items).toHaveLength(2)
    expect(p1.body.nextCursor).toBeTruthy()
    const p2 = await request(app.getHttpServer()).get(`/invoices?limit=2&cursor=${encodeURIComponent(p1.body.nextCursor)}`).set('Authorization', auth()).expect(200)
    expect(p2.body.items.length).toBeGreaterThanOrEqual(1)
    expect(p2.body.nextCursor).toBeNull()
  })
```

Run: `pnpm --filter @factelec/api test -- cursor tenant-isolation read`
Expected: FAIL — routes/méthodes absentes.

- [ ] **Step 2 : Curseur keyset + parsing du format**

`apps/api/src/invoices/cursor.ts` :
```ts
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url')
}

export function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
    const sep = decoded.indexOf('|')
    if (sep <= 0) return null
    const createdAt = decoded.slice(0, sep)
    const id = decoded.slice(sep + 1)
    if (!id || Number.isNaN(Date.parse(createdAt))) return null
    return { createdAt, id }
  } catch {
    return null
  }
}
```

`apps/api/src/invoices/format-kind.ts` :
```ts
import type { FormatKind } from './format-generator.port.js'

const KINDS: readonly FormatKind[] = ['ubl', 'cii', 'facturx', 'flux_base', 'flux_full']

export function parseFormatKind(value: string): FormatKind | null {
  return (KINDS as readonly string[]).includes(value) ? (value as FormatKind) : null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function isUuid(value: string): boolean {
  return UUID.test(value)
}
```

- [ ] **Step 3 : Étendre le repository (lecture keyset + formats)**

Ajouter à `apps/api/src/invoices/invoices.repository.ts` (imports : `and, desc, eq, lt, or` de `drizzle-orm` ; `encodeCursor, decodeCursor` ; `invoiceFormats, invoices` déjà importés ; `FormatKind`) :
```ts
export interface InvoiceSummary {
  id: string
  number: string
  typeCode: string
  issueDate: string
  currency: string
  status: string
  createdAt: Date
}

  async findById(tenantId: string, id: string): Promise<InvoiceSummary | null> {
    return this.tenant.run(tenantId, async (db) => {
      const rows = await db
        .select({
          id: invoices.id, number: invoices.number, typeCode: invoices.typeCode,
          issueDate: invoices.issueDate, currency: invoices.currency,
          status: invoices.status, createdAt: invoices.createdAt,
        })
        .from(invoices)
        .where(eq(invoices.id, id))
        .limit(1)
      return rows[0] ?? null
    })
  }

  async listFormatKinds(tenantId: string, invoiceId: string): Promise<FormatKind[]> {
    return this.tenant.run(tenantId, async (db) => {
      const rows = await db
        .select({ kind: invoiceFormats.kind })
        .from(invoiceFormats)
        .where(eq(invoiceFormats.invoiceId, invoiceId))
      return rows.map((r) => r.kind as FormatKind)
    })
  }

  async list(
    tenantId: string,
    limit: number,
    cursor?: string,
  ): Promise<{ items: InvoiceSummary[]; nextCursor: string | null }> {
    return this.tenant.run(tenantId, async (db) => {
      const decoded = cursor ? decodeCursor(cursor) : null
      const keyset = decoded
        ? or(
            lt(invoices.createdAt, new Date(decoded.createdAt)),
            and(eq(invoices.createdAt, new Date(decoded.createdAt)), lt(invoices.id, decoded.id)),
          )
        : undefined
      const rows = await db
        .select({
          id: invoices.id, number: invoices.number, typeCode: invoices.typeCode,
          issueDate: invoices.issueDate, currency: invoices.currency,
          status: invoices.status, createdAt: invoices.createdAt,
        })
        .from(invoices)
        .where(keyset)
        .orderBy(desc(invoices.createdAt), desc(invoices.id))
        .limit(limit + 1)
      const hasMore = rows.length > limit
      const items = hasMore ? rows.slice(0, limit) : rows
      const last = items.at(-1)
      const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : null
      return { items, nextCursor }
    })
  }

  async findFormat(
    tenantId: string,
    invoiceId: string,
    kind: FormatKind,
  ): Promise<{ contentType: string; bodyText: string | null; bodyBytes: Buffer | null } | null> {
    return this.tenant.run(tenantId, async (db) => {
      const rows = await db
        .select({
          contentType: invoiceFormats.contentType,
          bodyText: invoiceFormats.bodyText,
          bodyBytes: invoiceFormats.bodyBytes,
        })
        .from(invoiceFormats)
        .where(and(eq(invoiceFormats.invoiceId, invoiceId), eq(invoiceFormats.kind, kind)))
        .limit(1)
      return rows[0] ?? null
    })
  }
```
> `where(keyset)` avec `keyset` = `undefined` (1re page) ne filtre rien — la RLS reste le seul filtre tenant. `eq(invoices.tenantId, …)` est redondant (RLS) ; on le laisse implicite pour ne pas dupliquer la garde.

- [ ] **Step 4 : Étendre le service (get / list / getFormat, 404 propres)**

Ajouter à `apps/api/src/invoices/invoices.service.ts` (imports : `NotFoundException` ; `isUuid` de `./format-kind.js` ; `FormatKind` ; `InvoiceSummary`) :
```ts
  async get(tenantId: string, id: string): Promise<InvoiceSummary & { availableFormats: FormatKind[] }> {
    if (!isUuid(id)) throw this.notFound()
    const invoice = await this.repo.findById(tenantId, id)
    if (!invoice) throw this.notFound()
    const availableFormats = await this.repo.listFormatKinds(tenantId, id)
    return { ...invoice, availableFormats }
  }

  list(tenantId: string, limit: number, cursor?: string) {
    return this.repo.list(tenantId, limit, cursor)
  }

  async getFormat(tenantId: string, id: string, kind: FormatKind) {
    if (!isUuid(id)) throw this.notFound()
    const format = await this.repo.findFormat(tenantId, id, kind)
    if (!format) throw this.notFound()
    return format
  }

  private notFound(): NotFoundException {
    return new NotFoundException(problem(404, ProblemType.notFound, 'Invoice not found'))
  }
```

- [ ] **Step 5 : Routes GET (Content-Type via `@Res`)**

Ajouter à `apps/api/src/invoices/invoices.controller.ts` (imports : `Get, NotFoundException, Param, Query, Res` ; `Response` d'express ; `parseFormatKind` ; `problem, ProblemType`) :
```ts
  @Get()
  list(
    @CurrentTenant() tenantId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const n = Number(limit)
    const safeLimit = Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), 100) : 20
    return this.invoices.list(tenantId, safeLimit, cursor)
  }

  @Get(':id')
  get(@CurrentTenant() tenantId: string, @Param('id') id: string) {
    return this.invoices.get(tenantId, id)
  }

  @Get(':id/formats/:format')
  async getFormat(
    @CurrentTenant() tenantId: string,
    @Param('id') id: string,
    @Param('format') format: string,
    @Res() res: Response,
  ): Promise<void> {
    const kind = parseFormatKind(format)
    if (!kind) {
      throw new NotFoundException(problem(404, ProblemType.notFound, 'Unknown format'))
    }
    const f = await this.invoices.getFormat(tenantId, id, kind)
    res.type(f.contentType)
    res.send(f.bodyBytes ?? f.bodyText)
  }
```
> `@Res()` court-circuite la sérialisation Nest (nécessaire pour renvoyer des octets bruts) ; les exceptions lancées **avant** `res.send` restent captées par `ProblemDetailsFilter`. Ordre des routes : Nest résout `:id/formats/:format` sans conflit avec `:id`.

- [ ] **Step 6 : Test rate limit (429)**

`apps/api/tests/e2e/rate-limit.e2e.test.ts` — limite basse via env avant bootstrap :
```ts
// process.env.RATE_LIMIT_LIMIT = '3' AVANT createTestApp (lu par ThrottlerModule)
// 4 requêtes /health rapides → la 4e renvoie 429.
```
> Poser `process.env.RATE_LIMIT_LIMIT = '3'` et `RATE_LIMIT_TTL = '60'` dans `beforeAll` avant `createTestApp`. Frapper un endpoint non gardé (`/health`) 4 fois : attendre `200,200,200,429`. Vérifier `res.status === 429`. (Le throttle global est par IP ; supertest partage l'IP loopback.)

- [ ] **Step 7 : Verdir**

Run: `pnpm --filter @factelec/api test`
Expected: PASS — **y compris `tenant-isolation.e2e.test.ts`** (un tenant ne voit jamais les factures d'un autre : 404 systématique). Couverture ≥ 90 %.

- [ ] **Step 8 : Vérifier l'ensemble et committer**

Run: `pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm test`
Expected: PASS.

```bash
git add -A
git commit -m "feat(api): lecture des factures et formats (pagination keyset, content-types), isolation cross-tenant testée"
```

---

### Task 9 : README `apps/api`, mise à jour racine, version, point de reprise (plan 1.4)

**Files:**
- Create: `apps/api/README.md`
- Modify: `README.md` (racine — état du projet, structure, roadmap)
- (Versions : `apps/api/package.json` déjà en `0.1.0` ; `@factelec/invoice-core` inchangé en `0.3.0`, sauf le patch BT-9 de Task 1 — bumper en `0.3.1` si BT-9 modifie la sortie CII.)

> **Nature** : documentation. Pas de TDD ; le « test » est la cohérence doc ⇄ code livré. Aucun secret dans les exemples.

- [ ] **Step 1 : Rédiger `apps/api/README.md`**

Contenu (sections) :
- **Objet** : API NestJS d'ingestion/lecture des factures (phase 1.3). Consomme `@factelec/invoice-core`.
- **Architecture & compromis** :
  - ESM pur + NestJS 11 : **émission SWC** (`.swcrc`, décorateurs + métadonnées), **typecheck tsgo 7.0.2** (`experimentalDecorators`+`emitDecoratorMetadata`), **tests Vitest via `unplugin-swc`**. Consigner ici le résultat réel du typecheck tsgo (et, le cas échéant, l'activation du repli `typescript@5.9.x` local — Point de risque n°1).
  - **Génération synchrone** derrière le port `InvoiceFormatGenerator` ; **passage aux workers BullMQ prévu en 1.4/2.x** sans toucher l'ingestion (Point de risque n°4).
- **Sécurité / multi-tenant (à détailler, car pièce du dossier d'immatriculation)** :
  - Deux rôles Postgres : `factelec_owner` (BYPASSRLS ; migrations, provisioning, propriétaire de `authenticate_api_key`) et `factelec_app` (runtime, `NOSUPERUSER NOBYPASSRLS`).
  - **RLS `ENABLE` + `FORCE`** sur les 4 tables ; policies `tenant_id = current_setting('app.tenant_id', true)::uuid` (fail-closed).
  - Propagation du tenant : **une transaction par requête**, `SET LOCAL app.tenant_id` (`set_config(..., true)`) — réinitialisé au COMMIT/ROLLBACK (pas de fuite sur connexion mutualisée).
  - Auth : clés API `fk_<prefix>.<secret>`, secret **Argon2id** haché au repos, jamais stocké en clair ; lookup via fonction `SECURITY DEFINER` (poule/œuf). helmet, CORS allowlist, rate limiting, erreurs **RFC 9457** sans fuite interne, logs pino **redactés**.
- **Variables d'environnement** : table depuis `.env.example` (rappeler que `DATABASE_OWNER_URL` n'est **jamais** lue par le runtime).
- **Développement** :
  ```sh
  cd apps/api
  docker compose up -d                         # Postgres local + rôles (scripts/db-init)
  DATABASE_OWNER_URL=... pnpm db:migrate        # applique 0000_init + 0001_roles_rls
  DATABASE_OWNER_URL=... pnpm provision:tenant "Ma boutique"   # → { tenantId, token } (token affiché 1 fois)
  pnpm dev                                       # tsx watch
  pnpm test                                      # Vitest + Testcontainers (Docker requis)
  ```
- **Endpoints** : `GET /health`, `GET /health/ready`, `POST /invoices`, `GET /invoices`, `GET /invoices/:id`, `GET /invoices/:id/formats/:format` (ubl/cii/facturx/flux_base/flux_full). Codes : 201, 401, 404, 409, 422 (validation & règles), 429.
- **Tests** : Postgres **réel** (Testcontainers) ; isolation cross-tenant vérifiée (DB + HTTP). Couverture ≥ 90 % bloquante.
- **Limites v1 / TODO** : génération synchrone (workers 1.4) ; `last_used_at` non mis à jour ; throttle par IP (par-tenant en 1.4) ; pas de self-service tenant/clé (dashboard 1.4).

- [ ] **Step 2 : Mettre à jour `README.md` racine**

- Bloc « État du projet » : ajouter **1.3 terminé** — `apps/api` (NestJS 11 ESM) : santé, config zod, logs pino, **Postgres multi-tenant RLS `FORCE`**, **auth clés API Argon2id**, `POST /invoices` (validation invoice-core, génération synchrone des formats du socle), lecture tenant-scopée ; isolation cross-tenant testée ; couverture ≥ 90 %.
- Section « Structure du dépôt » : ajouter `apps/api/` (API REST NestJS).
- Roadmap : cocher **1.3**, préciser le **point de reprise → plan 1.4 (dashboard Next.js + self-service tenants/clés)**, puis 2.x (cycle de vie/scellement/e-reporting) et 3.x (Peppol interne). Mentionner la dette reportée : **workers BullMQ** (génération asynchrone), **throttle par tenant**, **`last_used_at`**, **migration Factur-X D22B/1.09** (héritée d'invoice-core).
- Rappeler la commande de dev DB (`docker compose` d'`apps/api`) et que `pnpm build` doit précéder `pnpm typecheck` (dépendance dist d'invoice-core).

- [ ] **Step 3 : Vérifier la cohérence finale + committer**

Run: `pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm test`
Expected: PASS (invoice-core 100 %, apps/api ≥ 90 %).

```bash
git add -A
git commit -m "docs(api): README apps/api, mise à jour README racine et point de reprise plan 1.4"
```

---

## Auto-revue (writing-plans)

**1. Couverture de la spec / du cadrage :**
- Socle apps/api (NestJS 11 ESM, config zod, santé, pino, arrêt propre, intégration monorepo/CI) → **Tasks 2, 3, 5**.
- Base de données (ORM tranché = Drizzle, migrations, docker-compose, tenants/api_keys/invoices/invoice_formats, **RLS par tenant**, rôle applicatif non-owner, SET LOCAL) → **Task 4** (+ contexte Task 5).
- Auth multi-tenant (clés API hachées Argon2id, guard, rate limiting, moindre privilège) → **Task 6**.
- Ingestion `POST /invoices` (validation invoice-core → 422 zod / 422 règles, persistance, génération synchrone derrière un port) → **Task 7**.
- Lecture `GET /invoices/:id` + liste paginée + formats (content-types, Factur-X `application/pdf`) → **Task 8**.
- Sécurité transverse (helmet/CORS, validation, pas de fuite, logs sans données sensibles, **authz cross-tenant = 404**) → **Tasks 3, 6, 8**.
- Tests unitaires + e2e sur Postgres réel (Testcontainers, pas de mock de persistance), couverture ≥ 90 % bloquante → **toutes les tasks e2e** + seuils Vitest (Task 2).
- README + version + point de reprise → **Task 9**.
- Dettes héritées (BT-9 CII, canari SEF CII, décision VATEX, `@types/node`) → **Task 1** (report explicite des non-retenues).

**2. Scan des placeholders :** aucun « TODO/à compléter » dans les étapes de code ; chaque étape porte le code réel. Les seuls renvois « détaillé en Task N » concernent des interfaces définies dans la tâche citée (types explicités dans les blocs `Interfaces`).

**3. Cohérence des types :** `APP_POOL`/`Db`/`createPool` (`db/client.ts`) partagés ; `TenantContextService.run` ; `runInTenant` ; `InvoiceFormatGenerator`/`GeneratedFormat`/`FormatKind`/`INVOICE_FORMAT_GENERATOR` ; `TenantRequest`/`CurrentTenant` ; `problem`/`ProblemType`/`Problem` ; `InvoiceSummary` — signatures identiques d'une tâche à l'autre. `parseInvoiceInput`/`buildInvoice`/`validateBusinessRules`/`generate*` consommés via `@factelec/invoice-core` (exports map).

## Handoff d'exécution

Plan enregistré. Deux options d'exécution :
1. **Subagent-Driven (recommandé)** — un subagent frais par tâche, revue entre les tâches (superpowers:subagent-driven-development).
2. **Inline** — exécution par lots avec points de contrôle (superpowers:executing-plans).

