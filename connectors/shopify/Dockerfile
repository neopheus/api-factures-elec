# syntax=docker/dockerfile:1
#
# Build DEPUIS LA RACINE DU MONOREPO (contexte requis — ce paquet consomme
# @factelec/connectors-sdk par référence workspace) :
#   docker build -f connectors/shopify/Dockerfile -t factelec-connector-shopify .
#
# Étage 1 — installation (workspace complet, résolution `workspace:*`) +
# build TypeScript + `pnpm deploy` : extrait un sous-arbre AUTONOME pour CE
# SEUL paquet (dist/ + node_modules --prod résolus, réels — pas de symlinks
# pointant hors de l'arbre déployé), sans apps/api, apps/web ni les
# devDependencies. `--legacy` : pnpm ≥10 exige par défaut
# `inject-workspace-packages=true` pour `pnpm deploy` sur un lockfile
# partagé — le mode legacy déploie depuis le store content-addressable sans
# ce réglage, vérifié empiriquement (dist/ + node_modules autonomes,
# `require('better-sqlite3')`/`require('zod')`/`import('@factelec/connectors-sdk')`
# fonctionnels une fois déployés).
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/connectors-sdk/package.json packages/connectors-sdk/package.json
COPY packages/invoice-core/package.json packages/invoice-core/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY connectors/shopify/package.json connectors/shopify/package.json
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/connectors-sdk packages/connectors-sdk
COPY connectors/shopify connectors/shopify
RUN pnpm --filter @factelec/connectors-sdk build
RUN pnpm --filter @factelec/connector-shopify build
RUN pnpm --filter @factelec/connector-shopify deploy --prod --legacy /out

# Étage 2 — image d'exécution minimale.
FROM node:22-alpine AS runtime
WORKDIR /app

# Outillage de compilation natif (python3/make/g++) — DÉFENSIF UNIQUEMENT :
# better-sqlite3@13 embarque des binaires N-API précompilés pour
# linuxmusl-x64/arm64 (musl = Alpine), chargés DIRECTEMENT sans
# recompilation node-gyp (vérifié empiriquement — `require()` charge le
# binaire bundlé sans toolchain présent). Conservé en filet de sécurité si
# un futur arch/ABI venait à manquer de prebuild lors d'une montée de
# version.
RUN apk add --no-cache python3 make g++

COPY --from=build /out ./

ENV NODE_ENV=production
EXPOSE 3100
# Store SQLite local (LINK_DB_PATH, défaut ./var/links.sqlite) — à monter en
# volume pour survivre au remplacement du conteneur. `mkdir` AVANT `VOLUME` :
# sans ça, le daemon Docker initialise le point de montage anonyme en
# root:root (répertoire absent de l'image à cet endroit précis), et
# l'utilisateur `node` (non-root, ci-dessous) ne peut plus y écrire —
# `SQLITE_CANTOPEN` constaté empiriquement au premier `docker run`.
RUN mkdir -p /app/var && chown -R node:node /app
VOLUME ["/app/var"]

USER node

CMD ["node", "dist/main.js"]
