# Préparatifs phase 6 — provisioning prod : Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Livrer la spec `docs/superpowers/specs/2026-07-20-phase6-provisioning-infra-design.md` : runbook de provisioning production exhaustif, squelette Terraform Scaleway validable hors-ligne, script de vérification post-provisioning.

**Architecture:** documentation opérationnelle ancrée sur le code réel (aucun claim non vérifié) ; Terraform déclaratif sans apply ; script Node read-only réutilisant le pool/env existants.

**Tech Stack:** existante + Terraform (provider scaleway épinglé, HCL seulement — aucune dépendance npm nouvelle sauf si le script l'exige, à éviter).

## Global Constraints

- AUCUN apply/ressource réelle ; AUCUN secret réel nulle part (exemples factices explicites).
- Chaque commande/claim du runbook VÉRIFIÉ contre le code de main (env.ts ~60 clés, scripts/db-init/00-roles.sql, migrate.ts, package.json, README existants — exigences 0029/pgcrypto/WORM/libxml2/TOFU).
- Honnêteté : ce qui n'est pas encore câblé (adaptateur S3 archives ? transports réels ?) est dit « préparé, activation différée », jamais présenté comme actif — VÉRIFIER l'état réel d'ARCHIVE_DRIVER=s3 dans le code avant d'écrire.
- Gates : biome/typecheck si code touché ; `terraform fmt -check` obligatoire ; `terraform validate` si faisable hors-ligne (documenter sinon) ; unit tests du script ; audit/outdated inchangés.
- Branche : `feat/phase6-prep-provisioning` depuis `main`.

### Task 1: Runbook `docs/operations/runbook-provisioning-prod.md`
Contenu = spec §2 intégrale (12 sections ordonnées, commandes exactes, vérifications, tableau des ~60 clés env avec obligatoire/valeur prod/source du secret, points durs TRUST_PROXY/COOKIE_DOMAIN/3 URLs DB, consigne TOFU + reset recovery SQL, honnêteté sur les drivers locaux). Lire AVANT d'écrire : env.ts complet, db-init/00-roles.sql, migrate.ts, provision-admin.ts, billing-bootstrap.ts, sections déploiement des README. 
- [ ] Rédiger → auto-vérification claim par claim → commit `docs(ops): runbook de provisioning production (rôles avant migrations, pgcrypto, WORM, env exhaustif, TOFU TOTP, Stripe live)`.

### Task 2: `infra/` Terraform Scaleway
Spec §3 : versions.tf (provider scaleway dernière stable épinglée — vérifier sur le registry si accessible, sinon version connue documentée), main/variables/outputs, tfvars.example sans secret, README. Ressources : rdb (PG17 + 3 users), redis (TLS), object bucket (object-lock COMPLIANCE paramétrable), container namespace + 3 containers (placeholders), secrets Scaleway référencés.
- [ ] Écrire → `terraform fmt -check` (installer terraform via brew si absent — vérifier `command -v terraform`) → `terraform init -backend=false && terraform validate` SI le provider est téléchargeable, sinon documenter la limite → commit `feat(infra): squelette Terraform Scaleway (rdb/redis/object-lock/containers, sans apply)`.

### Task 3: `apps/api/scripts/verify-provisioning.ts` + tests
Spec §4 : contrôles listés, aucune impression de secret, exit code, rapport par contrôle. Tests unit de la logique (checks mockés). + runbook §12 pointe le script ; README api § scripts complété.
- [ ] TDD (RED) → implémenter → unit + tsc + biome → commit `feat(api): script verify-provisioning (rôles/pgcrypto/migrations/RLS/grants/redis/env, read-only, exit code)`.

### Task 4 (contrôleur): revue de branche courte + merge
- [ ] Revue Opus (fidélité runbook↔code + qualité Terraform/script) → fix éventuel → merge --no-ff → push → CI → ledger.

## Self-Review
Spec §2→T1, §3→T2, §4→T3, §5 gates→dans chaque task. Pas de placeholder (les deux points « vérifier avant d'écrire » sont des instructions de lecture). Types/chemins cohérents.
