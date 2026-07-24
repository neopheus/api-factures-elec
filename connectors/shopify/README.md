# Connecteur Shopify Factelec

Service **Node/TypeScript autonome** qui dépose automatiquement une facture
électronique conforme (Factur-X/UBL/CII, selon la configuration du tenant)
auprès de Factelec à réception d'un webhook de commande Shopify.

Troisième connecteur du monorepo Factelec, mais **le premier écrit en
TypeScript** (contrairement à PrestaShop/WooCommerce, des plugins PHP) et le
**premier consommant `@factelec/connectors-sdk` en TypeScript direct**
(types + schéma, pas une réimplémentation manuelle du contrat). Voir
`../../docs/api-publique.md` pour le contrat API consommé, et
`../../packages/connectors-sdk/` pour le contrat de mapping partagé entre
tous les connecteurs.

## Pourquoi un service autonome, pas un plugin ?

Shopify n'exécute **aucun code marchand** (contrairement à WordPress/
PrestaShop, qui hébergent le plugin dans le processus de la boutique) : ce
connecteur est un service **headless** que l'exploitant héberge lui-même
(Docker ou archive tar.gz déployable), appairé à une **custom app** Shopify
côté boutique (Admin API access token — pas d'app App Store/OAuth publique
en v1, itération future). Conséquence directe : contrairement aux
connecteurs PHP (accès permanent à la base de la plateforme e-commerce),
ce service n'a **aucun accès durable à "la commande"** — il doit tout tirer
du webhook reçu, y compris pour ses reprises automatiques (cf. § Retry
automatique).

## Installation

### Option A — Docker (recommandé)

```bash
# Depuis la racine du monorepo (contexte requis — dépendance workspace) :
docker build -f connectors/shopify/Dockerfile -t factelec-connector-shopify .
# Créez d'abord un fichier .env (non versionné) avec les variables listées
# ci-dessous (§ Variables d'environnement), puis :
docker run -d --name factelec-shopify \
  --env-file connectors/shopify/.env \
  -p 3100:3100 \
  -v factelec-shopify-var:/app/var \
  factelec-connector-shopify
```

Le volume `/app/var` doit être monté pour survivre au remplacement du
conteneur — c'est là que vit le store SQLite (`LINK_DB_PATH`).

### Option B — Archive tar.gz (hôte nu, sans Docker)

```bash
cd connectors/shopify
./build-archive.sh   # produit factelec-connector-shopify-<version>.tar.gz
# Transférer + extraire sur l'hôte cible, puis :
tar -xzf factelec-connector-shopify-<version>.tar.gz -C /opt/factelec-shopify
cd /opt/factelec-shopify
# positionner les variables d'environnement (§ Configuration), puis :
node dist/main.js
```

Compatibilité : **Node 22+**.

## Configuration Shopify — custom app pas-à-pas

1. Admin Shopify de la boutique → **Paramètres** → **Applications et
   canaux de vente** → **Développer des applications** (activer le
   développement d'apps si ce n'est pas déjà fait) → **Créer une
   application**. Nommez-la (ex. « Factelec »).
2. Onglet **Configuration** → **Configurer les champs d'application Admin
   API** → cochez le scope **`read_orders`** (seul scope requis : Shopify
   exige le scope de lecture de la ressource correspondant à chaque topic
   de webhook souscrit — ici `orders/paid`/`orders/fulfilled`). Aucun autre
   scope n'est nécessaire en v1 (pas de lecture produit/client/metafield).
3. Onglet **API credentials** → **Installer l'application** → copiez le
   **jeton d'accès Admin API** (`shpat_...`, affiché **une seule fois**) →
   `SHOPIFY_ACCESS_TOKEN`.
4. Toujours sur cet onglet : la **clé secrète API** de l'app sert de
   secret de signature des webhooks → `SHOPIFY_WEBHOOK_SECRET`. (Le
   service **enregistre lui-même** l'abonnement webhook au démarrage via
   l'Admin API — `ensureWebhookSubscription`, idempotent — inutile de le
   créer manuellement dans l'admin Shopify.)
5. `SHOPIFY_SHOP` = domaine `*.myshopify.com` de la boutique (PAS le
   domaine personnalisé, même si un domaine custom est configuré par
   ailleurs).
6. `PUBLIC_WEBHOOK_URL` = URL **publique HTTPS** par laquelle Shopify peut
   atteindre CE service (`https://.../webhooks/shopify` est construit
   automatiquement à partir de cette base) — jamais `localhost` : Shopify
   appelle ce webhook depuis son propre cloud, pas depuis la machine de
   l'exploitant.

**SIREN acheteur (B2B)** : ce connecteur lit le SIREN/SIRET depuis un
**`note_attribute`** de commande nommé `factelec_siret` (14 chiffres SIRET,
converti en 9 chiffres SIREN) — PAS un metafield. Décision documentée
(design) : un metafield exigerait un appel Admin API supplémentaire **par
commande traitée** (latence + nouveau point de défaillance synchrone sur
le chemin critique du webhook), alors qu'un `note_attribute` est **déjà**
inclus dans le payload webhook reçu. Pour le renseigner, ajoutez un champ
personnalisé au tunnel de commande (thème/app checkout extension) qui
soumet un `note_attribute` de clé `factelec_siret`. Absent ou malformé →
commande traitée en B2C (jamais une erreur).

## Variables d'environnement

| Variable | Obligatoire | Défaut | Description |
| --- | --- | --- | --- |
| `SHOPIFY_SHOP` | oui | — | Domaine `*.myshopify.com` de la boutique. |
| `SHOPIFY_ACCESS_TOKEN` | oui | — | Jeton Admin API de la custom app (≥ 20 caractères). |
| `SHOPIFY_WEBHOOK_SECRET` | oui | — | Secret de signature HMAC des webhooks (≥ 16 caractères). |
| `SHOPIFY_TOPIC` | non | `orders/paid` | `orders/paid` ou `orders/fulfilled` — événement déclenchant l'émission. |
| `PUBLIC_WEBHOOK_URL` | oui | — | URL publique **HTTPS** de ce service (jamais `localhost` — Shopify doit pouvoir l'atteindre depuis son cloud). |
| `FACTELEC_API_URL` | oui | — | URL de base de l'API Factelec du tenant. **HTTPS obligatoire** (`http://` toléré uniquement pour `localhost`/`127.0.0.1`, usage dev). |
| `FACTELEC_API_KEY` | oui | — | Clé API Factelec (dashboard, page **Clés API**), cf. `../../docs/api-publique.md` §1 (≥ 16 caractères). |
| `SELLER_NAME` | oui | — | Raison sociale vendeur (BG-4). |
| `SELLER_SIREN` | oui | — | SIREN vendeur, 9 chiffres. |
| `SELLER_VAT_ID` | non | — | Numéro de TVA intracommunautaire vendeur. |
| `SELLER_STREET` / `SELLER_CITY` / `SELLER_POSTAL_CODE` | non | — | Adresse vendeur. |
| `SELLER_COUNTRY` | non | `FR` | Code pays ISO 3166-1 alpha-2. |
| `PORT` | non | `3100` | Port HTTP d'écoute du service. |
| `LINK_DB_PATH` | non | `./var/links.sqlite` | Chemin du store SQLite (liaisons commande↔facture). À faire persister (volume Docker). |
| `RETRY_EVERY_MS` | non | `300000` (5 min) | Cadence du balayage de reprise automatique (§ Retry automatique). |
| `LINKS_ACCESS_TOKEN` | non | — | Jeton optionnel (≥ 16 caractères) autorisant `GET /links` depuis un appelant **non-loopback** (`Authorization: Bearer <jeton>`). Sans lui, `/links` reste accessible uniquement depuis `localhost`/l'intérieur du conteneur — comportement inchangé. |

Toute variable manquante/malformée fait échouer le démarrage immédiatement
(fail-fast, zod) avec un message ne citant **que les noms des clés
fautives**, jamais leurs valeurs.

## Fonctionnement

### Émission automatique

À réception d'un webhook `SHOPIFY_TOPIC` (HMAC vérifié **avant tout**
traitement — `401` nu si invalide, aucun détail) :

1. déduplication par `X-Shopify-Webhook-Id` (re-livraisons Shopify) **et**
   par `order_id` (une commande déjà liée, quel que soit son statut, n'est
   jamais re-mappée ni re-soumise) ;
2. mappe la commande Shopify vers le contrat Factelec
   (`packages/connectors-sdk/schema/order-mapping.schema.json`) ;
3. dépose la facture (`POST /invoices`) ;
4. enregistre la liaison `order_id` ↔ `invoice_id` Factelec (store SQLite
   local).

**Acheteur professionnel (B2B)** : si `billing_address.company` est
renseigné, il devient la raison sociale de l'acheteur. SIREN via
`note_attribute factelec_siret` (cf. § Configuration ci-dessus).

**Frais de port** : mappés en ligne de facture dédiée dès lors qu'ils sont
non nuls.

**Panne réseau, erreur API ou erreur de mapping** : la commande passe en
statut `pending_retry`, avec le message d'erreur (jamais la clé API/le
jeton Shopify) conservé pour diagnostic — **capturés dans le même bloc que
la soumission** (pas seulement les erreurs API typées), motif direct de la
revue PrestaShop it.1 : une panne réseau ne doit jamais faire disparaître
une commande en silence. Si la persistance elle-même échoue (SQLite
verrouillé/disque plein — cas extrême), le service répond `500` (pas `200`)
pour que Shopify re-livre l'événement plus tard plutôt que de perdre
silencieusement une commande jamais tracée.

### Retry automatique

**Différence majeure avec les connecteurs PHP** (plugins WordPress/
PrestaShop, cycle de vie court d'une requête HTTP, renvoi **toujours
manuel**) : ce service est un processus **long-vivant** qui reprend
automatiquement les commandes `pending_retry`, toutes les
`RETRY_EVERY_MS` (défaut 5 min), avec un **backoff** simple par nombre de
tentatives (`2^(tentatives-1)`, plafonné à 16× l'intervalle) — évite de
marteler une commande persistamment en échec à chaque tick.

La reprise **ne re-contacte jamais Shopify** : elle re-mappe la commande
depuis le JSON brut du webhook, **persisté localement** dès le premier
échec (`order_payload`) — un retry ne doit pas dépendre de la disponibilité
de l'API Shopify au moment où on en a justement le plus besoin.

Au-delà de **10 tentatives**, la liaison passe au statut terminal
`abandoned` — **elle n'est alors plus jamais retentée automatiquement**
(aucune action de déblocage manuel en v1, cf. § Limites). La commande
reste tracée (jamais supprimée), consultable via `GET /links`/`pnpm
status`.

### Suivi

Pas d'UI marchande en v1 (service headless) :

- **`GET /links`** — JSON de toutes les liaisons (statut, `invoice_id`,
  dernière erreur, nombre de tentatives). Restreint à `localhost`/
  l'intérieur du conteneur par défaut ; `LINKS_ACCESS_TOKEN` (optionnel)
  élargit l'accès à un appelant distant muni du jeton, sans jamais
  restreindre l'accès loopback.
- **`pnpm status`** (ou `node dist/cli-status.js` en production) — liste
  les liaisons **et** interroge Factelec (`GET /invoices/:id`) pour le
  statut de cycle de vie DGFiP courant de chaque facture soumise, à la
  demande (aucun polling en arrière-plan) :
  ```bash
  docker exec factelec-shopify node dist/cli-status.js
  ```

**Réconciliation des liaisons `abandoned`** : une liaison `abandoned` ne
signifie pas nécessairement qu'aucune facture n'a été créée — si la
réponse HTTP d'un `POST /invoices` réussi a été perdue (timeout après
création côté serveur), le connecteur re-tente et reçoit un `409`
(numéro déjà utilisé), ce qui finit en `abandoned` **sans jamais créer de
doublon** (l'unicité `(tenant, numéro)` protège l'intégrité), mais la
facture existe réellement côté Factelec. Utilisez `GET /links`/`pnpm
status` pour repérer les `abandoned` et vérifier manuellement (dashboard
Factelec, recherche par numéro = nom de commande Shopify) avant toute
action corrective.

## Limites connues (v1)

- **Pas d'UI marchande** — service headless, suivi via `GET /links`/`pnpm
  status` uniquement (pas de page embarquée dans l'admin Shopify — réservé
  à une itération App Store).
- **Custom app uniquement** — pas d'app publique OAuth/App Store en v1 ;
  un exploitant par boutique installe et configure sa propre custom app.
- **Un seul taux de TVA par ligne** (article ou frais de port) : si
  plusieurs `tax_lines` s'appliquent à un même item (juridictions fiscales
  composées, rare en France, fréquent aux US), la commande est rejetée en
  `pending_retry` avec un message clair — **jamais** de somme de taux
  inventée. Après 10 tentatives infructueuses (l'erreur étant
  structurelle, chaque reprise échoue de la même façon), la liaison finit
  `abandoned` — cf. § Réconciliation.
- **SIREN acheteur via `note_attribute` uniquement** — pas de repli
  metafield (décision documentée § Configuration) ; un marchand utilisant
  un metafield conventionnel plutôt qu'un `note_attribute` au checkout ne
  verra jamais son SIREN détecté (commande traitée en B2C silencieusement
  du point de vue métier, pas une erreur technique).
- **`buyer.vatId` non mappé** — aucune convention Shopify établie pour le
  numéro de TVA intracommunautaire acheteur (même discipline que
  WooCommerce : non deviné plutôt que faux).
- **`dueDate`/`businessProcessType` non mappés**, **`unitCode` fixe**
  (`C62`), **`typeCode` toujours `380`** (pas d'avoirs — création manuelle
  depuis le dashboard Factelec).
- **Pas de webhooks sortants Factelec→boutique** (statut de cycle de vie
  consultable uniquement à la demande, `pnpm status`).

## Développement

```bash
pnpm install
pnpm --filter @factelec/connector-shopify typecheck
pnpm --filter @factelec/connector-shopify test    # vitest --coverage, seuils >=90 %
pnpm --filter @factelec/connector-shopify build   # tsc -> dist/
pnpm lint                                          # biome (racine du monorepo)
```

Gates couvertes par la CI TS existante du monorepo (`.github/workflows/
ci.yml` — `pnpm build`/`pnpm typecheck`/`pnpm test` à la racine incluent ce
paquet ; pas de job CI dédié comme pour les connecteurs PHP,
`.github/workflows/ci-php.yml` est scopé aux deux connecteurs PHP
uniquement).

Le service a **deux dépendances runtime** (`better-sqlite3` pour le store
local, `zod` pour la validation d'environnement fail-fast) — philosophie
zéro-dépendance des connecteurs, cf. commentaires `config.ts`/
`link-store.ts` pour la justification de chacune. `@factelec/
connectors-sdk` est également une dépendance mais consommée en `import
type` uniquement (poids runtime nul).
