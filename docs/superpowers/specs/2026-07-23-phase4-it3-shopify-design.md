# Design — Phase 4 itération 3 : connecteur Shopify

Date : 2026-07-23 · Statut : exécution autonome (mandat « continue »).
Parentes : spec produit §3.1 (`connectors/shopify`) ; it.1 (contrat
`connectors-sdk`) ; it.2 (modèle fonctionnel — les acquis PrestaShop/Woo
s'appliquent : sonde authentifiée, résilience Throwable→pending_retry,
decimal4, 0 %→Z, idempotence stricte).

## 1. Forme retenue : service connecteur autonome (custom app)

Shopify n'exécute pas de code marchand : le connecteur est un **service
Node/TS autonome** (`connectors/shopify/`) que l'exploitant héberge (Docker),
appairé à une **custom app** Shopify du marchand (Admin API access token —
l'équivalent « zip d'abord » : pas d'app App Store/OAuth publique en v1,
itération future). C'est le premier connecteur qui consomme
`@factelec/connectors-sdk` EN TYPESCRIPT DIRECT (types + schéma).

## 2. Cibles techniques

- Node 22, TypeScript, ESM — mêmes conventions que le monorepo (biome,
  vitest, couverture >90 % logique, tsc). Paquet workspace privé
  `@factelec/connector-shopify` DANS le monorepo (gates TS existantes le
  couvrent) + `Dockerfile` + packaging `build-archive.sh` (tar/zip
  déployable).
- **Shopify Admin API** version stable courante épinglée (constante) ;
  auth par token custom app (`X-Shopify-Access-Token`). AUCUN SDK Shopify
  lourd : client REST minimal maison (fetch natif) — cohérent avec la
  philosophie zéro-dépendance des connecteurs (deps runtime autorisées :
  `better-sqlite3` pour le store local, rien d'autre sauf nécessité
  argumentée).
- **Webhooks entrants** : serveur HTTP minimal (node:http ou fastify sobre
  — au choix argumenté) exposant `POST /webhooks/shopify` ; vérification
  **HMAC SHA-256** (`X-Shopify-Hmac-Sha256`, timingSafeEqual sur le RAW
  body — motif billing-webhook it.1) AVANT tout traitement ; topic
  configuré `orders/paid` (défaut) ou `orders/fulfilled`. Au démarrage, le
  service enregistre/répare l'abonnement webhook via l'Admin API
  (idempotent).
- **Store local** : SQLite (`better-sqlite3`) — table `invoice_link`
  (`order_id` UNIQUE, invoice_id, status, last_error, timestamps) ; même
  machine d'états que PHP (submitted / pending_retry) ; **retry
  automatique périodique** (setInterval sobre — contrairement aux plugins
  PHP, un service long-vivant peut le faire ; backoff simple, plafonné).
- **Config** : variables d'environnement validées zod au boot (fail-fast) :
  SHOPIFY_SHOP, SHOPIFY_ACCESS_TOKEN, SHOPIFY_WEBHOOK_SECRET,
  SHOPIFY_TOPIC, FACTELEC_API_URL (https obligatoire hors localhost),
  FACTELEC_API_KEY, les 7 champs vendeur, PORT. Secrets jamais logués.
- **Client Factelec** : réutilise le motif éprouvé (Bearer, sonde
  authentifiée `GET /invoices?limit=1` exécutée AU BOOT — échec → log
  explicite sans secret, service démarre quand même en signalant l'état),
  submitInvoice/getInvoiceStatus, erreurs problem-details typées.

## 3. Mapping (contrat sdk, types TS directs)

`Order` webhook Shopify → `OrderMappingPayload` du sdk : vendeur = env ;
acheteur = billing_address (company → name si présent, sinon
first/last name) ; SIREN via note_attribute ou metafield conventionnel
(`factelec_siret`, 14→9) sinon B2C ; lignes = line_items avec
`tax_lines` (taux réel par ligne, **un taux : si plusieurs tax_lines sur un
item, sommer les taux est FAUX — prendre le taux composite ou rejeter en
pending_retry avec message clair, décision documentée**) ; shipping_lines →
ligne dédiée si > 0 ; montants decimal4 ; 0 % → **Z** (acquis it.2) ;
`currency` de la commande. Tests vitest rejouant LES MÊMES fixtures sdk
(payload attendu complet) + validation ajv contre le schéma.

## 4. Suivi

Pas d'UI marchande en v1 (le service est headless) : endpoint local
`GET /links` (JSON, auth par token local optionnel) + CLI `pnpm status`
listant les liaisons et leurs statuts Factelec (à la demande). Documenté
comme limite v1 (une page embarquée Shopify = itération App Store).

## 5. Sécurité

HMAC vérifié avant tout ; secrets uniquement en env, jamais logués (test) ;
TLS Factelec obligatoire hors localhost ; le serveur webhook ne répond
jamais de détail d'erreur (200/401 nus — contrat Shopify : non-2xx =
re-livraison, donc 200 même sur erreur métier APRÈS avoir persisté
pending_retry, 401 seulement sur HMAC invalide) ; idempotence par
`order_id` UNIQUE + `X-Shopify-Webhook-Id` (re-livraisons Shopify).

## 6. Découpage (3 tâches)

1. **Socle service** : paquet workspace, env zod, serveur HTTP + HMAC
   (timingSafeEqual raw body), store SQLite + machine d'états, client
   Factelec + sonde au boot, enregistrement webhook idempotent, Dockerfile
   + archive, CI (gates TS monorepo existantes + job dédié si besoin).
2. **Émission** : OrderMapper TS (fixtures sdk, ajv, decimal4, Z, taux
   composite), handler webhook → mapping → submit → liaison, idempotence
   (order_id + webhook_id), retry périodique avec backoff.
3. **Suivi + clôture** : GET /links + CLI status, README (custom app
   pas-à-pas côté Shopify admin, limites v1), README racine 4.3, bump
   apps/api 0.18.0, gates complètes. Revue de branche puis merge.
