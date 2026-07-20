# Variables du squelette Terraform Scaleway — chaque variable est décrite en
# français. Aucune valeur par défaut sensible ici : les mots de passe et
# autres secrets n'ont PAS de `default`, ils doivent être fournis via
# `terraform.tfvars` (JAMAIS commité, voir .gitignore) ou variables d'env
# `TF_VAR_*`. Voir `terraform.tfvars.example` pour le squelette de valeurs
# factices.

# --- Général -----------------------------------------------------------

variable "project_id" {
  description = "ID du projet Scaleway (console → Paramètres du projet) dans lequel toutes les ressources sont créées."
  type        = string
}

variable "region" {
  description = "Région Scaleway pour les ressources régionales (RDB, Redis, Object Storage, Containers)."
  type        = string
  default     = "fr-par"
}

variable "zone" {
  description = "Zone Scaleway pour les ressources zonées, si nécessaire (non utilisée directement par les ressources régionales de ce squelette, conservée pour extension future)."
  type        = string
  default     = "fr-par-1"
}

variable "environment" {
  description = "Nom de l'environnement, utilisé comme préfixe/tag sur toutes les ressources (ex. 'production')."
  type        = string
  default     = "production"
}

# --- PostgreSQL managé (runbook §2/§3/§4) -------------------------------

variable "rdb_instance_name" {
  description = "Nom de l'instance PostgreSQL managée Scaleway."
  type        = string
  default     = "factelec-pg"
}

variable "rdb_node_type" {
  description = "Type de nœud de l'instance RDB (ex. 'DB-GP-S'). Dimensionnement initial non déterminable depuis le code (runbook §11) — à ajuster après observation des métriques Prometheus pg_pool en production. Liste des types disponibles : `scw rdb node-type list` ou console Scaleway."
  type        = string
  default     = "DB-GP-S"
}

variable "rdb_ha_enabled" {
  description = "Active la haute disponibilité (is_ha_cluster) de l'instance RDB. Optionnelle au sens du brief phase 6 — à activer selon le budget/SLA retenu par Xavier, pas déterminable depuis le code."
  type        = bool
  default     = false
}

variable "rdb_volume_type" {
  description = "Type de volume de stockage RDB : 'lssd' (local, taille liée au node_type), 'sbs_5k' ou 'sbs_15k' (Block Storage, taille indépendante — recommandé en production pour dimensionner le stockage sans changer de node_type)."
  type        = string
  default     = "sbs_15k"
}

variable "rdb_volume_size_gb" {
  description = "Taille du volume RDB en Go. Ignorée si rdb_volume_type = 'lssd' (taille alors liée au node_type)."
  type        = number
  default     = 10
}

variable "rdb_owner_password" {
  description = "Mot de passe du rôle Postgres 'factelec_owner' (propriétaire du schéma, migrations — runbook §3). Générer avec `openssl rand -base64 32`, JAMAIS la valeur de db-init/00-roles.sql (dev). Sensible : aucun default."
  type        = string
  sensitive   = true
}

variable "rdb_app_password" {
  description = "Mot de passe du rôle Postgres 'factelec_app' (process API, NOBYPASSRLS — runbook §3). Générer avec `openssl rand -base64 32`. Sensible : aucun default."
  type        = string
  sensitive   = true
}

variable "rdb_worker_password" {
  description = "Mot de passe du rôle Postgres 'factelec_worker' (process worker, NOBYPASSRLS — runbook §3). Générer avec `openssl rand -base64 32`. Sensible : aucun default."
  type        = string
  sensitive   = true
}

# --- Redis managé (runbook §5) ------------------------------------------

variable "redis_cluster_name" {
  description = "Nom du cluster Redis managé Scaleway."
  type        = string
  default     = "factelec-redis"
}

variable "redis_node_type" {
  description = "Type de nœud du cluster Redis (ex. 'RED1-MICRO'). Dimensionnement initial non déterminable depuis le code — à ajuster après observation (bullmq_jobs en Prometheus, §10/§11 runbook)."
  type        = string
  default     = "RED1-MICRO"
}

variable "redis_version" {
  description = "Version Redis de l'offre managée. Valeur à reconfirmer au moment de l'apply via `scw redis version list` ou la console (dernière version stable proposée par Scaleway peut avoir changé depuis la rédaction de ce squelette)."
  type        = string
  default     = "7.2.5"
}

variable "redis_cluster_size" {
  description = "Nombre de nœuds du cluster Redis. En mode Cluster (>1 nœud selon le node_type retenu), seule la DB logique 0 est utilisable — limite du protocole Redis Cluster documentée au runbook §5, pas spécifique à Scaleway."
  type        = number
  default     = 1
}

variable "redis_user_name" {
  description = "Nom du premier utilisateur Redis managé."
  type        = string
  default     = "factelec"
}

variable "redis_password" {
  description = "Mot de passe du cluster Redis (→ REDIS_PASSWORD, runbook §7-E). Générer avec `openssl rand -base64 32`. Sensible : aucun default."
  type        = string
  sensitive   = true
}

variable "redis_tls_enabled" {
  description = "Active TLS sur le cluster Redis (→ REDIS_TLS=true côté API/worker, runbook §5). Ne JAMAIS mettre à false en production : BullMQ échoue bruyamment au démarrage si REDIS_TLS ne correspond pas à l'exigence réelle de l'offre managée."
  type        = bool
  default     = true
}

# --- Object Storage WORM (runbook §6) -----------------------------------

variable "archive_bucket_name" {
  description = "Nom du bucket Object Storage d'archivage probant (WORM). Les noms de bucket Scaleway sont globalement uniques : pas de default généraliste, à choisir explicitement (ex. 'factelec-archives-prod')."
  type        = string
}

variable "archive_object_lock_mode" {
  description = "Mode de rétention object-lock : 'COMPLIANCE' (aucune suppression/raccourcissement possible, y compris par un administrateur Scaleway — requis pour la valeur probante WORM des archives) ou 'GOVERNANCE' (contournable par des permissions IAM spécifiques). Ne JAMAIS utiliser 'GOVERNANCE' pour les archives probatoires de production."
  type        = string
  default     = "COMPLIANCE"

  validation {
    condition     = contains(["COMPLIANCE", "GOVERNANCE"], var.archive_object_lock_mode)
    error_message = "archive_object_lock_mode doit valoir 'COMPLIANCE' ou 'GOVERNANCE'."
  }
}

variable "archive_object_lock_retention_days" {
  description = "Durée de rétention object-lock en jours. Runbook §6 recommande ~10 ans (3650 jours) pour les archives probatoires — à confirmer avec Xavier selon l'obligation légale de conservation retenue."
  type        = number
  default     = 3650

  validation {
    condition     = var.archive_object_lock_retention_days > 0
    error_message = "archive_object_lock_retention_days doit être strictement positif."
  }
}

# --- Containers (runbook §7/§11) ----------------------------------------

variable "container_namespace_name" {
  description = "Nom du namespace Scaleway Containers regroupant api/worker/web."
  type        = string
  default     = "factelec"
}

variable "container_api_image" {
  description = "Image (registry + tag) du container API, ex. 'rg.fr-par.scw.cloud/factelec/api:<tag>'. Placeholder explicite en tfvars.example — aucune image réelle n'est construite/poussée par ce squelette."
  type        = string
}

variable "container_worker_image" {
  description = "Image (registry + tag) du container worker, ex. 'rg.fr-par.scw.cloud/factelec/worker:<tag>'."
  type        = string
}

variable "container_web_image" {
  description = "Image (registry + tag) du container web (apps/web, next start), ex. 'rg.fr-par.scw.cloud/factelec/web:<tag>'."
  type        = string
}

variable "container_min_scale" {
  description = "Nombre minimal d'instances par container, maintenues en permanence. Point de départ non vérifié (runbook §11 : dimensionnement initial non déterminable depuis le code) — 1 par défaut, à ajuster par observation."
  type        = number
  default     = 1
}

variable "container_max_scale" {
  description = "Nombre maximal d'instances par container (scaling horizontal automatique)."
  type        = number
  default     = 3
}
