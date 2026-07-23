# Phase 4 it.1 — OpenAPI publique + connecteur PrestaShop : Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Livrer la spec `docs/superpowers/specs/2026-07-23-phase4-it1-openapi-prestashop-design.md` : document OpenAPI 3.1 du périmètre public clé-API + doc d'intégration + contrat de mapping partagé + module PrestaShop 8 distribuable en zip.

**Architecture:** décorateurs @nestjs/swagger filtrés par inclusion explicite (jamais la surface admin/session/webhook) ; contrat de mapping JSON Schema dans connectors-sdk validé des deux côtés (fixtures ↔ API réelle) ; module PHP autonome (aucune dépendance runtime, client cURL PS natif), logique pure testée PHPUnit avec stubs PS.

**Tech Stack:** existante + `@nestjs/swagger` (dernière stable exacte) ; PHP 8.1+/PHPUnit/PHPStan/php-cs-fixer (CI job dédié setup-php).

## Global Constraints

- TDD strict, couverture >90 % (TS ; PHP : logique pure ≥90 %, glue PS exclue documentée), audit 0, outdated vierge, Biome, ESM `.js`, commentaires français POURQUOI (PHP : commentaires français aussi).
- Verrous d'architecture intacts (aucun contact dual-auth/heavy nouveau sans HEAVY_TESTS même commit).
- Le document OpenAPI n'expose JAMAIS admin/session/billing-webhook/metrics — test d'exclusion obligatoire.
- Aucun secret dans le module PHP ; clé API jamais loguée ; TLS requis hors localhost.
- Branche : `feat/phase4-it1-openapi-prestashop` (courante). Migration : AUCUNE attendue.
- Bump versions : apps/api 0.16.0 en fin d'itération (Task 5).

### Task 1: OpenAPI périmètre public
**Files:** apps/api — ajout `@nestjs/swagger` (exact), décorateurs sur les contrôleurs du périmètre PUBLIC clé-API seulement (invoices dépôt/lecture/formats, statuts CDV, santé — VÉRIFIER la liste réelle des routes TenantAuthGuard/ApiKeyGuard consommables par intégrateur), bootstrap `SwaggerModule` filtré par `include:[...modules]` OU tags explicites servi sur `GET /openapi.json` (sans auth, @SkipThrottle NON — throttle standard OK), snapshot test.
**Interfaces — Produces:** `GET /openapi.json` (OpenAPI 3.1, info.title "Factelec API publique", version = package.json) ; test unit/e2e : (a) document valide structurellement, (b) contient POST /invoices + GET /invoices/:id, (c) NE CONTIENT AUCUN chemin /admin, /auth, /billing (sauf éventuel statut public ? NON — aucun), /metrics.
- [ ] RED (test exclusions + présences) → implémenter → GREEN → gate (tsc/biome/unit/audit/outdated) → commit `feat(api): document OpenAPI 3.1 du périmètre public clé-API (/openapi.json, exclusions verrouillées par test)`.

### Task 2: Doc publique + connectors-sdk (contrat de mapping + fixtures)
**Files:** Create `docs/api-publique.md` (démarrage clé API — header réel du ApiKeyGuard à vérifier —, cycle dépôt→génération→formats→statuts CDV, erreurs problem-details avec les types urn réels, rate limiting réel, lien /openapi.json) ; Create `packages/connectors-sdk/` (package TS privé : `src/order-mapping.ts` types du payload de dépôt côté connecteur + `schema/order-mapping.schema.json` JSON Schema 2020-12 ALIGNÉ sur le schéma zod réel de POST /invoices — lis le contrôleur/DTO réel —, `fixtures/` ≥3 commandes réalistes (B2B SIREN, B2C sans SIREN, multi-taux TVA), test qui valide les fixtures contre le schéma) ; Modify apps/api tests e2e : un e2e light qui POSTe les fixtures du sdk sur /invoices (via clé API du harnais) → 201 (fixtures ↔ API réelle prouvé).
- [ ] RED → implémenter → GREEN → gate → commit `feat(sdk): contrat de mapping connecteurs (JSON Schema + fixtures validées contre l'API réelle) + doc API publique`.

### Task 3: Module PrestaShop — socle
**Files:** Create `connectors/prestashop/` : `factelec/factelec.php` (module PS 8, install/uninstall — table `factelec_invoice_link` (id_order unique, invoice_id, status, created_at) —, config BO URL+clé API+état déclencheur avec « Tester la connexion »), `factelec/src/` (PSR-4 : `Api/FactelecClient.php` — cURL, X-API-Key, TLS obligatoire hors localhost, timeouts, erreurs typées —, `Config/`), `composer.json` (dev-deps phpunit/phpstan/php-cs-fixer, autoload), stubs PS pour tests (`tests/stubs/`), packaging : script `build-zip.sh` produisant `factelec-prestashop-<version>.zip` (exclut tests/dev), `.github/workflows/ci-php.yml` (setup-php 8.1, composer install, phpstan, php-cs-fixer --dry-run, phpunit — job séparé, PATH `connectors/prestashop/**` en trigger).
**Interfaces — Produces:** `FactelecClient::__construct(baseUrl, apiKey)`, `::testConnection(): bool`, `::submitInvoice(array $payload): array{invoiceId:string}`, `::getInvoiceStatus(string $invoiceId): array`.
- [ ] RED (PHPUnit client mock cURL via interface HttpTransport injectable + config) → implémenter → GREEN (phpunit+phpstan+cs local) → CI PHP verte → commit `feat(prestashop): socle du module (config BO, client API, table de liaison, packaging zip, CI PHP)`.

### Task 4: Module PrestaShop — émission
**Files:** `factelec/src/Mapping/OrderMapper.php` (commande PS → payload conforme au JSON Schema du sdk — implémente CHAQUE champ du schéma, TVA par taux agrégée par ligne, SIREN B2C absent → payload sans buyer.siren), hook `actionOrderStatusPostUpdate` (état configuré → mapper → submitInvoice → INSERT liaison ; erreur → status pending_retry + message BO), idempotence (liaison existante → no-op), bouton « Renvoyer » BO (retry manuel).
- [ ] RED (PHPUnit : mapping sur les MÊMES fixtures que le sdk — portées en PHP par un loader JSON —, idempotence, retry, multi-taux, B2B/B2C) → implémenter → GREEN → CI PHP → commit `feat(prestashop): émission à la validation de commande (mapping contractuel, idempotence, retry manuel)`.

### Task 5: Module PrestaShop — suivi + doc + clôture
**Files:** onglet/hook admin commande (statut Factelec + statut CDV à la demande via getInvoiceStatus, liens de téléchargement des formats), `connectors/prestashop/README.md` (installation zip, config, limites v1 : pas de cron, pas d'avoirs, PS 8 seulement), bump apps/api 0.16.0, README racine (phase 4 it.1 livrée), gate complète monorepo + CI PHP.
- [ ] Implémenter+tester → gates → commit `feat(prestashop): suivi des statuts + doc utilisateur ; docs: phase 4 it.1 + bump 0.16.0` → PAS de merge (revue de branche d'abord).

## Self-Review
Spec §2→T1/T2 ; §3→T3/T4/T5 ; §4 sécurité→T3 (TLS/clé) ; §5 gates→chaque task + CI PHP T3 ; §6 découpage identique. Contrats nommés (FactelecClient, schéma sdk) cohérents T2↔T3↔T4. Pas de placeholder.
