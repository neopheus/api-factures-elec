# Contraintes Terraform + provider — squelette de provisioning Scaleway.
#
# Portée : ce fichier ne fait QUE déclarer les versions. Aucune ressource
# n'est créée par ce squelette sans `terraform apply` explicite et revu
# (voir infra/README.md — AUCUN apply n'a été exécuté à ce jour).
#
# Version du provider `scaleway/scaleway` : dernière stable au moment de la
# rédaction (2026-07-20), vérifiée via le registry Terraform
# (https://registry.terraform.io/v1/providers/scaleway/scaleway/versions) :
# 2.79.0. Épinglée avec une borne haute majeure (`~> 2.79`) pour absorber les
# correctifs mineurs/patches sans changement de comportement non revu.
terraform {
  required_version = ">= 1.6"

  required_providers {
    scaleway = {
      source  = "scaleway/scaleway"
      version = "~> 2.79"
    }
  }
}
