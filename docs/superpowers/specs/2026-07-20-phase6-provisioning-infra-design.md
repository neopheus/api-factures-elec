# Design — Préparatifs phase 6 : runbook de provisioning production + squelette Terraform Scaleway

Date : 2026-07-20 · Statut : exécution autonome (mandat « fait tout » Xavier, 2026-07-19)
Spec produit parente : `2026-07-12-plateforme-agreee-facturation-electronique-design.md` §3.1 (`infra/` → Terraform Scaleway) et phase 6 « Production ».

## 1. Objectif et périmètre

Rendre le provisioning de production **exécutable ensemble** (décision Xavier :
« on le fera ensemble ») : tout ce qui peut être préparé sans compte Scaleway
ni secret réel l'est maintenant — un runbook exhaustif ordonné, un squelette
Terraform validable hors-ligne, des scripts de vérification post-provisioning.

**Inclus** : runbook `docs/operations/runbook-provisioning-prod.md` ;
arborescence `infra/` Terraform (provider Scaleway, AUCUN `apply` — validation
`terraform fmt -check` + `terraform validate` seulement) ; script de
vérification `apps/api/scripts/verify-provisioning.ts` (contrôles
post-déploiement contre la base/env réels) ; README `infra/`.

**Exclus** : tout `apply`/création de ressources réelles (nécessite le compte
Scaleway — item Xavier), DNS/certificats (dépend du domaine choisi), CI/CD de
déploiement (itération future), Kubernetes (YAGNI — la spec parente vise des
conteneurs simples).

## 2. Runbook de provisioning (contenu normatif)

Ordonné, chaque étape avec commande exacte, vérification, et rollback
éventuel. Sources : exigences DÉJÀ documentées dans les README/ledger —
chacune re-vérifiée contre le code au moment de la rédaction.

1. **Prérequis hôte/runtime** : Node 22 (`.nvmrc`), pnpm (version du
   `packageManager`), **libxml2/xmllint sur le PATH** (validation XSD
   runtime — Flux 10, annuaire F13/F14), Docker non requis en prod.
2. **PostgreSQL managé Scaleway** : version 17 ; **`CREATE EXTENSION
   pgcrypto`** (exigence 2.2 — à confirmer disponible sur l'offre managée,
   c'est un point de vérification explicite du runbook) ; création de la
   base `factelec`.
3. **Rôles AVANT toute migration** (leçon 0029) : transposition prod de
   `apps/api/scripts/db-init/00-roles.sql` — `factelec_owner` (LOGIN,
   BYPASSRLS, propriétaire du schéma), `factelec_app` (LOGIN, NOBYPASSRLS),
   `factelec_worker` (LOGIN, NOBYPASSRLS) — mots de passe générés forts
   (jamais ceux du fichier dev), `GRANT`s du fichier transposés. Attention
   offre managée : si `CREATE ROLE ... BYPASSRLS` est restreint, procédure
   alternative documentée (rôle admin Scaleway → propriétaire ; les
   migrations tournent sous owner, PAS sous le superuser Scaleway).
4. **Migrations** : `DATABASE_OWNER_URL` → `pnpm --filter @factelec/api
   exec node --import tsx scripts/migrate.ts` (vérifier le point d'entrée
   réel) ; contrôle : `SELECT count(*) FROM drizzle.__drizzle_migrations`
   == nombre d'entrées du journal.
5. **Redis managé** : TLS (`REDIS_TLS=true`), mot de passe, DB dédiée.
6. **Object Storage WORM** : bucket archives avec **object-lock/
   rétention** (exigence 2.2 — ancrage de tête WORM effectif SEULEMENT une
   fois l'adaptateur S3 activé : `ARCHIVE_DRIVER=s3` + variables associées
   à vérifier dans le code au moment de la rédaction ; si l'adaptateur S3
   n'est pas encore câblé dans le code, le runbook le dit HONNÊTEMENT et
   marque l'étape « préparée, activation différée »).
7. **Environnement API/worker** : tableau EXHAUSTIF des ~60 clés de
   `env.ts` avec, pour chaque : obligatoire/optionnelle, valeur prod
   recommandée, source du secret. Points durs : `TRUST_PROXY` (topologie
   LB Scaleway), `SESSION_COOKIE_DOMAIN` (cross-subdomain dashboard/API),
   `CORS_ALLOWED_ORIGINS`, `DATABASE_URL` (app) vs `DATABASE_URL_WORKER`
   (worker) vs `DATABASE_OWNER_URL` (migrations uniquement — jamais dans
   l'env des processus), drivers réels vs `local` (annuaire, cdv,
   e-reporting, consent — état actuel : locaux, transports réels = item
   Xavier), `EREPORTING_PA_*`/`CDV_PA_MATRICULE` (matricule PA réel après
   immatriculation).
8. **Billing Stripe** : compte live, `pnpm billing:bootstrap` (garde
   sk_test_ → warning), endpoint webhook prod
   (`https://api.<domaine>/billing/webhook`) + `STRIPE_WEBHOOK_SECRET`,
   `BILLING_DRIVER=stripe`, `BILLING_ENFORCEMENT=on` = décision
   commerciale explicite (défaut off).
9. **Super admin + MFA (consigne TOFU — revue finale it.2)** :
   `provision-admin.ts` puis **enrôlement TOTP IMMÉDIAT** de chaque admin
   (fenêtre time-of-first-use : tout admin non enrôlé dont le mot de passe
   fuit est prenable) ; runbook « recovery codes épuisés » (reset SQL
   documenté : `UPDATE platform_admins SET totp_secret=NULL,
   totp_enabled_at=NULL, recovery_codes=NULL WHERE email=...` sous owner,
   puis ré-enrôlement).
10. **Observabilité** : `METRICS_TOKEN` fort (≥16), scrape Prometheus sur
    `/metrics` (Bearer), healthcheck `/health` (LB), rétention logs.
11. **Processus** : api (`node dist/main.js`), worker
    (`node dist/worker-main.js` — vérifier le nom réel), web (`next
    start`), ordre de démarrage, arrêt gracieux (SIGTERM — fenêtre
    réconciliation documentée), dimensionnement initial.
12. **Vérification finale** : exécution de `verify-provisioning.ts`
    (§4) + checklist de smoke (signup, dépôt facture, /metrics, /health).

## 3. Terraform (`infra/`)

- `infra/README.md` : usage (init/plan avec variables d'exemple, JAMAIS
  d'apply sans revue), état distant (backend S3 Scaleway, préparé commenté),
  correspondance ressources↔runbook.
- `infra/main.tf`, `variables.tf`, `outputs.tf`, `versions.tf` (provider
  `scaleway/scaleway` dernière stable épinglée) ; `terraform.tfvars.example`
  (aucun secret réel).
- Ressources déclarées : `scaleway_rdb_instance` (PostgreSQL 17) +
  databases/users (owner/app/worker — mots de passe via variables
  sensibles), `scaleway_redis_cluster` (TLS), `scaleway_object_bucket` (+
  `object_lock_configuration` rétention COMPLIANCE paramétrable) +
  policy minimale, `scaleway_container_namespace` + 3
  `scaleway_container` (api, worker, web — image placeholder, env non
  secrète, secrets via `scaleway_secret` référencés), IP/LB si nécessaire
  au TRUST_PROXY (documenté).
- Contrainte : `terraform validate` DOIT passer hors-ligne (`terraform init
  -backend=false` + provider mirroré ou `validate` sans init si
  impossible : la gate minimale est `terraform fmt -check` + parse — la
  tâche documente ce qui est réellement vérifiable sans réseau ni compte,
  sans prétendre plus).

## 4. Script `verify-provisioning.ts`

Contrôles read-only post-provisioning, exécutable avec l'env prod (owner
url en option) : rôles présents avec les bons attributs (BYPASSRLS
owner seul, NOBYPASSRLS app/worker), pgcrypto présent, count migrations ==
journal, RLS FORCE sur les tables sensibles (échantillon), grants worker
conformes (spot-check : pas d'EXECUTE sur les 13 SD auth/session/admin),
Redis joignable, variables d'env critiques posées (sans imprimer les
secrets — présence/longueur seulement). Sortie : rapport OK/ÉCHEC par
contrôle, exit code ≠ 0 si un échec. Testé unitairement (logique de
contrôle mockée), PAS de Testcontainers dédié (les invariants sont déjà
couverts par les e2e existants — le script est un OUTIL de vérification,
sa logique seule est testée).

## 5. Tests / gates

Pas de nouvelle suite e2e. Gates : `terraform fmt -check` + le maximum
validable hors-ligne documenté ; unit tests du script de vérification ;
lint/typecheck/biome ; fidélité du runbook = revue documentaire (chaque
commande/claim vérifiée contre le code, posture Task 12).

## 6. Découpage (3 tâches)

1. **Runbook** (`docs/operations/runbook-provisioning-prod.md`) — la pièce
   maîtresse, chaque claim vérifié contre le code.
2. **Terraform squelette** (`infra/`) + README + gate fmt/validate.
3. **verify-provisioning.ts** + tests unit + mention dans le runbook §12 +
   README api (§ scripts).
