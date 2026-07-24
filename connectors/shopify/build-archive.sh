#!/usr/bin/env bash
# Empaquette @factelec/connector-shopify en archive tar.gz déployable sur un
# hôte nu (sans Docker — alternative au Dockerfile de ce répertoire pour un
# exploitant qui préfère un déploiement direct `node dist/main.js`).
#
# Contenu de l'archive = build TypeScript compilé (dist/) + dépendances
# RUNTIME résolues (node_modules --prod : better-sqlite3, zod,
# @factelec/connectors-sdk) + package.json — PAS les sources src/, PAS les
# devDependencies (vitest, tsx, types...), PAS le reste du monorepo
# (apps/api, apps/web). Produit via `pnpm deploy --prod --legacy` (motif
# Dockerfile de ce répertoire — voir son en-tête pour le détail du choix
# `--legacy`), qui donne un `node_modules` AUTONOME (deps réelles, pas des
# symlinks pointant hors de l'archive), vérifié empiriquement.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

if [[ ! -f "${SCRIPT_DIR}/package.json" ]]; then
    echo "connectors/shopify/package.json introuvable — lancez ce script depuis connectors/shopify/." >&2
    exit 1
fi

VERSION="$(node -p "require('${SCRIPT_DIR}/package.json').version")"
if [[ -z "${VERSION}" ]]; then
    echo "Impossible de déterminer la version depuis package.json." >&2
    exit 1
fi

ARCHIVE_NAME="factelec-connector-shopify-${VERSION}.tar.gz"
DEPLOY_DIR="$(mktemp -d)"
trap 'rm -rf "${DEPLOY_DIR}"' EXIT

echo "Build TypeScript (dist/)..."
(cd "${REPO_ROOT}" && pnpm --filter @factelec/connectors-sdk build)
(cd "${REPO_ROOT}" && pnpm --filter @factelec/connector-shopify build)

echo "pnpm deploy --prod (sous-arbre autonome)..."
(cd "${REPO_ROOT}" && pnpm --filter @factelec/connector-shopify deploy --prod --legacy "${DEPLOY_DIR}")

cd "${SCRIPT_DIR}"
rm -f "${ARCHIVE_NAME}"
tar -czf "${ARCHIVE_NAME}" -C "${DEPLOY_DIR}" .

echo "Archive générée : ${SCRIPT_DIR}/${ARCHIVE_NAME}"
echo "Déploiement : extraire, positionner .env (cf. src/config.ts), lancer \`node dist/main.js\`."
