# Sorties du squelette — utiles pour renseigner l'environnement runtime
# (runbook §7) une fois un `apply` réel effectué. Tout ce qui dérive d'un
# mot de passe est marqué `sensitive = true` (masqué par défaut dans la
# sortie CLI/CI, toujours lisible via `terraform output -raw <nom>`).

output "rdb_instance_id" {
  description = "ID de l'instance PostgreSQL managée."
  value       = scaleway_rdb_instance.postgresql.id
}

output "rdb_endpoint_host" {
  description = "Hôte de connexion PostgreSQL (endpoint load-balancer public de l'instance managée — runbook §2/§4, à utiliser dans DATABASE_URL/DATABASE_URL_WORKER/DATABASE_OWNER_URL)."
  value       = local.database_host
}

output "rdb_endpoint_port" {
  description = "Port de connexion PostgreSQL."
  value       = local.database_port
}

output "rdb_database_name" {
  description = "Nom de la base applicative (toujours 'factelec')."
  value       = scaleway_rdb_database.factelec.name
}

output "rdb_owner_connection_url" {
  description = "URL de connexion complète du rôle factelec_owner (→ DATABASE_OWNER_URL, migrations/scripts CLI uniquement — JAMAIS dans l'environnement d'un container en service, runbook §7)."
  value       = "postgres://factelec_owner:${var.rdb_owner_password}@${local.database_host}:${local.database_port}/factelec"
  sensitive   = true
}

output "rdb_app_connection_url" {
  description = "URL de connexion complète du rôle factelec_app (→ DATABASE_URL du process API)."
  value       = "postgres://factelec_app:${var.rdb_app_password}@${local.database_host}:${local.database_port}/factelec"
  sensitive   = true
}

output "rdb_worker_connection_url" {
  description = "URL de connexion complète du rôle factelec_worker (→ DATABASE_URL_WORKER du process worker)."
  value       = "postgres://factelec_worker:${var.rdb_worker_password}@${local.database_host}:${local.database_port}/factelec"
  sensitive   = true
}

output "redis_endpoint" {
  description = "Endpoint du cluster Redis managé (host:port du premier nœud public — runbook §5/§7-E, → REDIS_HOST/REDIS_PORT). Vérifier la topologie exacte (public/private_network) au moment de l'apply réel."
  value       = scaleway_redis_cluster.main
  sensitive   = true # le bloc entier inclut le password, masqué par précaution.
}

output "archive_bucket_name" {
  description = "Nom du bucket Object Storage WORM d'archivage (→ variable d'implémentation de l'adaptateur S3, quand livré — runbook §6)."
  value       = scaleway_object_bucket.archives.name
}

output "archive_bucket_endpoint" {
  description = "Endpoint S3 du bucket d'archivage."
  value       = scaleway_object_bucket.archives.endpoint
}

output "container_namespace_id" {
  description = "ID du namespace Scaleway Containers (api/worker/web)."
  value       = scaleway_container_namespace.main.id
}

output "container_api_endpoint" {
  description = "URL publique du container api (→ base des URLs client dashboard/webhook Stripe, runbook §8/§11)."
  value       = scaleway_container.api.public_endpoint
}

output "container_web_endpoint" {
  description = "URL publique du container web (dashboard apps/web)."
  value       = scaleway_container.web.public_endpoint
}

output "container_worker_status" {
  description = "Statut déclaré du container worker (pas d'endpoint public — privacy=private, cf. note architecturale dans main.tf)."
  value       = scaleway_container.worker.status
}
