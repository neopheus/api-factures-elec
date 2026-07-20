# Squelette Terraform Scaleway — provisioning production Factelec.
#
# AUCUN `apply` n'a été exécuté contre une infrastructure réelle (voir
# infra/README.md). Ce fichier décrit les ressources correspondant au
# runbook `docs/operations/runbook-provisioning-prod.md` — chaque bloc
# renvoie à la section du runbook qu'il matérialise.

provider "scaleway" {
  project_id = var.project_id
  region     = var.region
  zone       = var.zone
}

# =========================================================================
# PostgreSQL managé — runbook §2 (instance + pgcrypto), §3 (rôles), §4
# (migrations, hors périmètre Terraform).
# =========================================================================

# Runbook §2 : PostgreSQL 17, miroir exact de postgres:17-alpine (dev/CI).
# `user_name`/`password` de cette ressource sont volontairement OMIS : les
# 3 rôles applicatifs (owner/app/worker) sont gérés de façon uniforme via
# `scaleway_rdb_user` ci-dessous plutôt que via un compte "premier
# utilisateur" implicite — cohérent avec le runbook §3, qui interdit que les
# migrations ou les process API/worker tournent sous un rôle superuser
# Scaleway partagé. Scaleway provisionne malgré tout une identité de
# bootstrap interne à l'instance ; elle n'est PAS destinée à un usage
# applicatif (à confirmer en conditions réelles lors du premier apply
# assisté — non vérifiable depuis ce dépôt).
resource "scaleway_rdb_instance" "postgresql" {
  name           = var.rdb_instance_name
  engine         = "PostgreSQL-17"
  node_type      = var.rdb_node_type
  is_ha_cluster  = var.rdb_ha_enabled
  disable_backup = false
  volume_type    = var.rdb_volume_type
  # volume_size_in_gb ignoré par le provider si volume_type = "lssd".
  volume_size_in_gb  = var.rdb_volume_type == "lssd" ? null : var.rdb_volume_size_gb
  encryption_at_rest = true

  tags = [var.environment, "factelec"]
}

# Runbook §2 : base `factelec`, nom utilisé partout dans le code
# (docker-compose.yml, .env.example).
resource "scaleway_rdb_database" "factelec" {
  instance_id = scaleway_rdb_instance.postgresql.id
  name        = "factelec"
}

# --- Runbook §3 : les 3 rôles applicatifs, créés AVANT toute migration ---
#
# ATTENTION — limite connue de ce provider (vérifiée sur le schéma
# `scaleway_rdb_user` v2.79.0) : il n'expose NI l'attribut BYPASSRLS
# PostgreSQL, NI la propriété du schéma `public`. Le seul levier exposé ici
# est `is_admin` (« Grant admin permissions to database user »), un concept
# propre à la couche de gestion Scaleway — PAS un synonyme confirmé de
# BYPASSRLS. En conséquence, après le premier `apply` réel, la SÉQUENCE SQL
# du runbook §3 DOIT être exécutée manuellement sous le rôle admin fourni
# par Scaleway à la création de l'instance :
#   ALTER SCHEMA public OWNER TO factelec_owner;
#   GRANT CREATE, USAGE ON SCHEMA public TO factelec_owner;
#   -- + vérification BYPASSRLS réelle (SELECT rolbypassrls FROM pg_roles
#   --   WHERE rolname = 'factelec_owner') ; si l'offre managée restreint
#   --   BYPASSRLS, voir la procédure alternative du runbook §3 (rôle admin
#   --   Scaleway comme propriétaire de fait).
# Terraform ne peut PAS garantir ces deux propriétés : ce squelette crée les
# rôles et leurs mots de passe, rien de plus.

resource "scaleway_rdb_user" "owner" {
  instance_id = scaleway_rdb_instance.postgresql.id
  name        = "factelec_owner"
  password    = var.rdb_owner_password
  is_admin    = true # cf. commentaire ci-dessus : n'implique PAS BYPASSRLS confirmé.
}

resource "scaleway_rdb_user" "app" {
  instance_id = scaleway_rdb_instance.postgresql.id
  name        = "factelec_app"
  password    = var.rdb_app_password
  is_admin    = false # NOBYPASSRLS visé — rôle du process API (DATABASE_URL).
}

resource "scaleway_rdb_user" "worker" {
  instance_id = scaleway_rdb_instance.postgresql.id
  name        = "factelec_worker"
  password    = var.rdb_worker_password
  is_admin    = false # NOBYPASSRLS visé — rôle du process worker (DATABASE_URL_WORKER).
}

# =========================================================================
# Redis managé — runbook §5 (TLS, mot de passe, DB dédiée).
# =========================================================================

# `tls_enabled` est piloté par variable mais NE DOIT jamais être désactivé
# en prod (REDIS_TLS=true côté env API/worker, runbook §5 — parsing
# explicite "true"/"1", z.coerce.boolean volontairement évité côté code).
#
# SÉCURITÉ — ACL réseau : PAS de valeur par défaut de type "0.0.0.0/0" dans
# ce squelette (revue sécurité automatisée sur un commit précédent — un ACL
# grand ouvert codé en dur est un anti-pattern même dans un squelette
# jamais appliqué : il finit souvent recopié tel quel). `redis_acl_allowed_cidrs`
# est une variable SANS default : `plan`/`apply` échouent tant que
# l'opérateur n'a pas listé explicitement les CIDR de sortie réels des
# containers/LB (item Xavier — topologie réseau finale, non déterminable
# depuis ce dépôt). Ne jamais y mettre 0.0.0.0/0 en production.
resource "scaleway_redis_cluster" "main" {
  name         = var.redis_cluster_name
  version      = var.redis_version
  node_type    = var.redis_node_type
  cluster_size = var.redis_cluster_size
  user_name    = var.redis_user_name
  password     = var.redis_password
  tls_enabled  = var.redis_tls_enabled
  tags         = [var.environment, "factelec"]

  dynamic "acl" {
    for_each = var.redis_acl_allowed_cidrs
    content {
      ip          = acl.value
      description = "CIDR de sortie applicatif autorisé (fourni via redis_acl_allowed_cidrs)."
    }
  }
}

# =========================================================================
# Object Storage WORM — runbook §6 : préparation infra "prête, activation
# différée". L'ancrage de tête WORM ne devient EFFECTIF qu'une fois
# l'adaptateur ARCHIVE_DRIVER=s3 livré côté code (non fourni à ce jour —
# `ArchiveModule` lève une erreur explicite et testée si ce driver est
# sélectionné sans adaptateur). Ce bucket peut être créé dès maintenant,
# indépendamment de cette dette applicative.
# =========================================================================

# `object_lock_enabled` doit être positionné à la création du bucket — un
# bucket existant ne peut pas être converti après coup (contacter le
# support Scaleway sinon, cf. doc provider). `versioning` est activé
# explicitement : l'object-lock Scaleway/S3 repose sur le versioning du
# bucket (chaque verrouillage porte sur une version d'objet).
resource "scaleway_object_bucket" "archives" {
  name                = var.archive_bucket_name
  project_id          = var.project_id
  region              = var.region
  object_lock_enabled = true

  versioning {
    enabled = true
  }

  tags = {
    environment = var.environment
    purpose     = "archives-worm"
  }
}

# Runbook §6 : rétention COMPLIANCE (aucune suppression/raccourcissement
# possible, y compris par un administrateur Scaleway) — condition de la
# valeur probante des archives. Mode et durée paramétrables via variables,
# mais COMPLIANCE reste le seul mode acceptable pour la production
# (validation Terraform sur la variable, voir variables.tf).
resource "scaleway_object_bucket_lock_configuration" "archives" {
  bucket     = scaleway_object_bucket.archives.name
  project_id = var.project_id
  region     = var.region

  rule {
    default_retention {
      mode = var.archive_object_lock_mode
      days = var.archive_object_lock_retention_days
    }
  }
}

# =========================================================================
# Containers — runbook §7 (env minimale non secrète), §11 (api/worker/web).
#
# LIMITE ARCHITECTURALE À NOTER (non résolue par ce squelette) : Scaleway
# Containers est un produit HTTP scale-to-zero, request-driven. Le process
# **worker** de ce dépôt (`node dist/worker-main.js`) n'est PAS un serveur
# HTTP — c'est un consommateur BullMQ + plusieurs boucles de balayage en
# arrière-plan (réconciliation, sweeps e-reporting/CDV/annuaire/billing, cf.
# runbook §7-F/§11). Le déployer en Container "classique" exige au minimum
# `min_scale >= 1` (jamais de scale-to-zero, sinon aucun job n'est jamais
# consommé) ; ce squelette le fait, mais NE GARANTIT PAS que le produit
# Containers soit le bon choix à long terme pour un process durablement actif
# — Scaleway Serverless Jobs ou une Instance dédiée pourraient être plus
# appropriés. Décision à trancher avec Xavier avant l'apply réel, pas
# déterminable depuis le code de ce dépôt.
# =========================================================================

resource "scaleway_container_namespace" "main" {
  name        = var.container_namespace_name
  description = "Namespace Factelec production — api/worker/web (runbook §11)."
  project_id  = var.project_id
  region      = var.region
}

# --- Secrets référencés (structure uniquement) ---------------------------
#
# Conformément au brief phase 6 : les secrets applicatifs (STRIPE_SECRET_KEY,
# STRIPE_WEBHOOK_SECRET, METRICS_TOKEN — runbook §8/§10) ne sont PAS créés
# avec des valeurs par ce squelette : les provisionner avec une vraie valeur
# ici les écrirait en clair dans l'état Terraform local (`.tfstate`), ce que
# ce dépôt ne doit jamais committer ni manipuler pour de vrais secrets sans
# backend chiffré (voir README §backend). La structure Secret Manager
# attendue est documentée ci-dessous en commentaire, à instancier HORS
# Terraform (console/CLI Scaleway ou pipeline sécurisé dédié) lors du
# provisioning réel :
#
# resource "scaleway_secret" "stripe_secret_key" {
#   name = "factelec-stripe-secret-key"
# }
# resource "scaleway_secret_version" "stripe_secret_key" {
#   secret_id = scaleway_secret.stripe_secret_key.id
#   data      = "<injecté hors Terraform, jamais dans ce dépôt>"
# }
#
# Les secrets réellement câblés dans ce squelette (mots de passe DB/Redis)
# transitent par les variables Terraform *sensitive* déclarées dans
# variables.tf, elles-mêmes fournies via TF_VAR_* ou un fichier
# .tfvars non commité — jamais en dur dans main.tf.

locals {
  # Env non-secrète minimale, commune api/worker (runbook §7-A/§7-B point
  # dur : le worker doit AUSSI recevoir DATABASE_URL, pas seulement
  # DATABASE_URL_WORKER — cf. commentaire ci-dessous sur le container worker).
  common_env = {
    NODE_ENV = "production"
  }

  # Choix délibéré de `endpoint_ip`/`endpoint_port` plutôt que l'attribut
  # `load_balancer[0].ip/.port` recommandé par le provider (celui-ci est
  # marqué déprécié — avertissement non bloquant à `validate`) : vérifié en
  # pratique (`terraform plan` à blanc sur ce squelette) que `load_balancer`
  # est une liste VIDE tant que l'instance RDB n'existe pas encore,
  # provoquant une erreur "Invalid index" sur `[0]` dès le premier `plan`
  # d'une instance neuve — bloquant, pas seulement esthétique.
  # `endpoint_ip`/`endpoint_port` sont des attributs scalaires calculés qui,
  # eux, se résolvent proprement en "(known after apply)" avant création.
  # À réévaluer si une future version du provider corrige ce comportement
  # pour `load_balancer`.
  database_host = scaleway_rdb_instance.postgresql.endpoint_ip
  database_port = scaleway_rdb_instance.postgresql.endpoint_port
}

resource "scaleway_container" "api" {
  name         = "api"
  namespace_id = scaleway_container_namespace.main.id
  image        = var.container_api_image
  port         = 3000
  protocol     = "http1"
  privacy      = "public"
  min_scale    = var.container_min_scale
  max_scale    = var.container_max_scale

  environment_variables = local.common_env

  # Runbook §7-B/§7-E : DATABASE_URL (rôle factelec_app) + REDIS_* en secret
  # (jamais en clair dans les logs/console Scaleway). CORS_ALLOWED_ORIGINS,
  # SESSION_COOKIE_DOMAIN, TRUST_PROXY (points durs runbook §7) dépendent du
  # domaine/topologie LB retenus — <À-CHOISIR>, non déterminables ici.
  secret_environment_variables = {
    DATABASE_URL   = "postgres://factelec_app:${var.rdb_app_password}@${local.database_host}:${local.database_port}/factelec"
    REDIS_PASSWORD = var.redis_password
  }
}

resource "scaleway_container" "worker" {
  name         = "worker"
  namespace_id = scaleway_container_namespace.main.id
  image        = var.container_worker_image
  privacy      = "private" # aucun trafic HTTP entrant attendu (cf. note architecturale ci-dessus).
  min_scale    = 1         # jamais 0 : un worker à l'arrêt ne consomme plus aucun job (runbook §11).
  max_scale    = var.container_max_scale

  environment_variables = local.common_env

  # Point dur runbook §7 (synthèse) : le worker exige DATABASE_URL **et**
  # DATABASE_URL_WORKER (WorkerModule valide l'intégralité d'envSchema, qui
  # requiert DATABASE_URL même si db.module.ts n'utilise que
  # DATABASE_URL_WORKER pour se connecter). Ne jamais oublier l'un des deux.
  secret_environment_variables = {
    DATABASE_URL        = "postgres://factelec_app:${var.rdb_app_password}@${local.database_host}:${local.database_port}/factelec"
    DATABASE_URL_WORKER = "postgres://factelec_worker:${var.rdb_worker_password}@${local.database_host}:${local.database_port}/factelec"
    REDIS_PASSWORD      = var.redis_password
  }
}

resource "scaleway_container" "web" {
  name         = "web"
  namespace_id = scaleway_container_namespace.main.id
  image        = var.container_web_image
  port         = 3001
  protocol     = "http1"
  privacy      = "public"
  min_scale    = var.container_min_scale
  max_scale    = var.container_max_scale

  # apps/web a ses propres variables (hors envSchema API, runbook §11) —
  # non répliquées ici : à compléter au provisioning réel selon
  # apps/web/README.md.
  environment_variables = local.common_env
}
