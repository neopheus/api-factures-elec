# `infra/` — Squelette Terraform Scaleway (production Factelec)

Squelette de provisioning **non appliqué**. Aucune ressource réelle n'a été
créée par ce code au moment de la rédaction (2026-07-20) — voir
`docs/operations/runbook-provisioning-prod.md` pour la procédure complète
d'exécution assistée (« on le fera ensemble », décision Xavier).

## Portée et limites

**Fait par ce squelette** : décrire, en Terraform, les ressources Scaleway
nécessaires à un premier environnement de production — PostgreSQL managé
(3 rôles applicatifs), Redis managé (TLS), un bucket Object Storage WORM
(object-lock), un namespace Containers avec 3 containers (api/worker/web).

**PAS fait par ce squelette** (limites connues, documentées ici pour ne pas
prétendre plus que ce qui est réellement vérifiable) :

- **BYPASSRLS / propriétaire du schéma `public`** — le provider
  `scaleway/scaleway` (vérifié sur le schéma de `scaleway_rdb_user`
  v2.79.0) n'expose NI l'attribut PostgreSQL `BYPASSRLS`, NI la propriété
  d'un schéma. Le seul levier exposé est `is_admin`, un concept propre à la
  couche de gestion Scaleway — **pas un synonyme confirmé** de BYPASSRLS.
  La séquence SQL du runbook §3 (`ALTER SCHEMA public OWNER TO
  factelec_owner;`, vérification `SELECT rolbypassrls FROM pg_roles ...`)
  **doit être exécutée manuellement** après le premier `apply` réel, sous
  le rôle admin fourni par Scaleway à la création de l'instance. Terraform
  crée les 3 rôles et leurs mots de passe, rien de plus sur ce point.
- **DNS / certificats** — hors périmètre (dépend du nom de domaine choisi
  par Xavier, non tranché à ce jour). Les containers exposent un
  `public_endpoint` Scaleway par défaut (`*.functions.fnc.fr-par.scw.cloud`
  ou équivalent) ; le mapping vers un domaine `<À-CHOISIR>` et son
  certificat TLS sont **exclus** de ce squelette.
- **CI/CD de déploiement** — hors périmètre (itération future). Ce
  squelette ne construit ni ne pousse d'images : `container_api_image` /
  `container_worker_image` / `container_web_image` sont des variables à
  renseigner avec une image déjà poussée dans un registry (ex. Scaleway
  Container Registry).
- **Secrets applicatifs avec valeur réelle** (Stripe, `METRICS_TOKEN`) —
  volontairement **non créés** avec une valeur par ce squelette : les créer
  ici les écrirait en clair dans l'état Terraform local (`.tfstate`), que ce
  dépôt ne committe jamais (voir `.gitignore`). La structure
  `scaleway_secret`/`scaleway_secret_version` attendue est documentée en
  commentaire dans `main.tf`, à instancier hors Terraform lors du
  provisioning réel.
- **Choix du produit Containers pour le worker** — Scaleway Containers est
  un produit HTTP scale-to-zero, request-driven. Le worker Factelec
  (`node dist/worker-main.js`) est un consommateur BullMQ + boucles de
  sweep en arrière-plan, pas un serveur HTTP. `min_scale = 1` est forcé
  dans `main.tf` (jamais de scale-to-zero, sinon aucun job n'est jamais
  consommé), mais la pertinence à long terme de Containers pour ce
  process (vs Serverless Jobs ou une Instance dédiée) **reste à trancher
  avec Xavier** avant l'apply réel — non déterminable depuis ce dépôt.
- **ACL réseau Redis** — `redis_acl_allowed_cidrs` (`variables.tf`) est
  **sans valeur par défaut** et refuse explicitement `0.0.0.0/0` par une
  validation Terraform. La topologie réseau réelle (CIDR de sortie des
  containers, LB) n'est pas connue à ce jour — à renseigner au moment du
  premier `plan` réel.

## Prérequis

```bash
command -v terraform || brew install terraform   # ou tfenv install <version>, voir versions.tf
terraform -chdir=infra version                   # >= 1.6 requis (voir versions.tf)
```

Ce squelette a été écrit et validé avec **Terraform 1.15.5** et le provider
**`scaleway/scaleway` v2.79.0** (dernière version stable au 2026-07-20,
vérifiée sur https://registry.terraform.io/v1/providers/scaleway/scaleway/versions).

## Usage

**JAMAIS d'`apply` sans revue.** Ce squelette n'a été validé qu'à l'aide de
`fmt`, `init -backend=false`, `validate`, et `plan` à blanc avec des
variables **factices** (aucun secret réel, aucune ressource créée). La
séquence normale d'usage, une fois le compte Scaleway et les secrets réels
disponibles (item Xavier) :

```bash
cd infra
cp terraform.tfvars.example terraform.tfvars   # puis remplacer TOUS les <REMPLACER-...>
terraform init                                 # avec backend distant si configuré, voir plus bas
terraform fmt -check                           # doit passer sans modification
terraform validate                             # doit passer (avertissements de dépréciation tolérés)
terraform plan -var-file=terraform.tfvars      # à REVOIR intégralement avant tout apply
# terraform apply -var-file=terraform.tfvars   # UNIQUEMENT après revue humaine explicite du plan
```

`terraform.tfvars` est ignoré par git (`.gitignore` racine) — ne jamais le
committer, il contient les 4 mots de passe sensibles (owner/app/worker DB +
Redis) une fois renseignés.

## Backend d'état distant (préparé, commenté)

Aucun backend distant n'est configuré aujourd'hui : l'état local
(`terraform.tfstate`, ignoré par git) suffit tant qu'aucun `apply` réel n'a
eu lieu. Avant le premier `apply` réel, décommenter et adapter le bloc
suivant dans `versions.tf` (bucket à créer manuellement au préalable — un
backend S3 ne peut pas s'auto-provisionner) :

```hcl
# terraform {
#   backend "s3" {
#     bucket                      = "factelec-terraform-state"       # à créer manuellement, hors object-lock
#     key                         = "production/terraform.tfstate"
#     region                      = "fr-par"
#     endpoints                   = { s3 = "https://s3.fr-par.scw.cloud" }
#     skip_credentials_validation = true
#     skip_region_validation      = true
#     skip_requesting_account_id  = true
#     use_path_style              = true
#     # access_key / secret_key : via variables d'env AWS_ACCESS_KEY_ID /
#     # AWS_SECRET_ACCESS_KEY (clé API Scaleway), jamais en dur ici.
#   }
# }
```

**Pourquoi un bucket séparé, sans object-lock** : l'état Terraform doit
rester **modifiable** (verrouillage exclusif, réécritures fréquentes) —
l'inverse du bucket d'archives WORM créé par ce squelette
(`scaleway_object_bucket.archives`), qui lui doit être immuable. Ne jamais
réutiliser le même bucket pour les deux usages.

## Correspondance ressources ↔ runbook

| Ressource Terraform | Section du runbook | Notes |
| --- | --- | --- |
| `scaleway_rdb_instance.postgresql` | §2 | PostgreSQL 17, miroir de `postgres:17-alpine` (dev/CI). `pgcrypto` reste un test SQL manuel post-création (§2), pas gérable par ce provider. |
| `scaleway_rdb_database.factelec` | §2 | Base `factelec`. |
| `scaleway_rdb_user.owner` / `.app` / `.worker` | §3 | 3 rôles. BYPASSRLS/propriété du schéma **hors périmètre provider** — SQL manuel obligatoire (voir « Portée et limites » ci-dessus). |
| *(aucune ressource — migrations)* | §4 | Hors périmètre Terraform : `pnpm --filter @factelec/api db:migrate` sous `DATABASE_OWNER_URL`. |
| `scaleway_redis_cluster.main` | §5 | TLS, mot de passe, `cluster_size`. ACL réseau à renseigner explicitement (`redis_acl_allowed_cidrs`). |
| `scaleway_object_bucket.archives` + `scaleway_object_bucket_lock_configuration.archives` | §6 | Object-lock `COMPLIANCE`, rétention paramétrable. Préparé, activation applicative différée (`ARCHIVE_DRIVER=s3` non livré côté code — voir runbook §6). |
| `scaleway_container_namespace.main` + `scaleway_container.api/.worker/.web` | §7 (env minimale non secrète), §11 (processus) | Secrets DB/Redis injectés via `secret_environment_variables` à partir des variables *sensitive*. Le tableau exhaustif des ~61 clés d'environnement reste dans le runbook §7, pas répliqué ici. |
| *(aucune ressource — Stripe)* | §8 | Hors périmètre Terraform : `pnpm billing:bootstrap` + secrets manuels. |
| *(aucune ressource — admin/TOTP)* | §9 | Hors périmètre Terraform : `provision-admin.ts` + enrôlement TOTP manuel. |
| *(aucune ressource — observabilité applicative)* | §10 | `METRICS_TOKEN` : structure `scaleway_secret` documentée en commentaire dans `main.tf`, valeur non créée. |
| — | §12 | `verify-provisioning.ts` (Task 3 du même chantier) s'exécute après un `apply` réel, contre l'infrastructure provisionnée par ce squelette. |

## Gate (exécutée, résultats réels)

```bash
terraform -chdir=infra fmt -check       # PASS
terraform -chdir=infra init -backend=false   # PASS (réseau disponible) — provider scaleway v2.79.0
terraform -chdir=infra validate         # PASS (avertissements de dépréciation non bloquants : endpoint_ip/endpoint_port)
```

Un `terraform plan` à blanc (variables factices non commitées, aucun
secret réel) a en outre été exécuté pendant le développement de ce
squelette pour vérifier l'absence d'erreur de plan sur les 12 ressources —
au-delà de ce que `validate` seul aurait détecté (un bug d'indexation sur
un attribut de liste calculée a été trouvé et corrigé de cette façon, voir
l'historique git de `infra/main.tf`). Ce test n'a créé aucune ressource
réelle (`plan` sans `-out`, jamais suivi d'`apply`).
