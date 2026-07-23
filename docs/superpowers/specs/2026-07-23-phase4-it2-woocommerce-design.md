# Design — Phase 4 itération 2 : connecteur WooCommerce

Date : 2026-07-23 · Statut : exécution autonome (mandat relancé par Xavier —
« continue » ; cadrage 2026-07-20 : dernières majeures, distribution zip).
Parentes : spec produit §3.1 (`connectors/woocommerce`) ; spec phase 4 it.1
(`2026-07-23-phase4-it1-openapi-prestashop-design.md`) — le connecteur
PrestaShop v1 mergé est le MODÈLE fonctionnel ; le contrat de mapping est
`packages/connectors-sdk` (inchangé).

## 1. Périmètre

**Inclus** : plugin WordPress/WooCommerce `factelec` (`connectors/woocommerce/`),
iso-fonctionnel au PrestaShop v1 : configuration (URL API, clé, statut
déclencheur, 7 champs vendeur), test de connexion **authentifié**
(`GET /invoices?limit=1` — leçon it.1, jamais /health seul), émission à la
transition de statut de commande, idempotence stricte, `pending_retry`
résilient (Throwable, pas seulement les erreurs API — leçon Critical it.1),
renvoi manuel, suivi des statuts (génération + CDV) sur la commande admin,
packaging zip, CI PHP étendue.

**Exclus** : marketplace WordPress.org (zip d'abord), cron de retry, avoirs/
rectificatives, HPOS-only features au-delà de la compat déclarée, Shopify
(it.3).

## 2. Cibles techniques

- **WooCommerce 9.x / WordPress 6.x**, PHP **8.1+** (plancher produit),
  outillage CI PHP 8.2 + `composer config.platform.php = 8.2.0` DÈS LE
  DÉPART (leçon lock it.1).
- **Compatibilité HPOS déclarée** (`FeaturesUtil::declare_compatibility
  ('custom_order_tables', …)`) : tout accès commande passe par l'API CRUD
  `WC_Order` (jamais de requête directe sur les posts) — la table de liaison
  du plugin reste une table custom `{$wpdb->prefix}factelec_invoice_link`
  (`order_id` BIGINT UNIQUE, `invoice_id`, `status`, `last_error`,
  timestamps ; `dbDelta` à l'activation, DROP à la désinstallation via
  `uninstall.php`).
- **HTTP** : API HTTP WordPress (`wp_remote_request`) derrière la MÊME
  interface `HttpTransportInterface` que l'it.1 (impl `WpHttpTransport`),
  TLS vérifié (défaut WP conservé, jamais `sslverify => false`), refus
  `http://` hors localhost, timeouts 10 s. Client/exceptions : mêmes
  classes que PrestaShop, DUPLIQUÉES dans le namespace du plugin
  (`FactelecWoo\`) — chaque zip est autonome, aucune dépendance
  inter-connecteurs (décision assumée : la duplication est le prix de
  l'autonomie des artefacts ; le contrat commun vit dans connectors-sdk).
- **Hooks** : émission sur `woocommerce_order_status_changed` (statut cible
  configurable, défaut `processing`) ; affichage suivi via metabox admin
  commande (compat HPOS : `add_meta_box` sur l'écran commande HPOS et
  legacy) ; bouton « Renvoyer » + « Actualiser » (admin-post.php avec nonce
  + capability `manage_woocommerce`).
- **Config** : page de réglages dédiée sous le menu WooCommerce
  (Settings API WP) ; clé API en option WP, champ password jamais
  réaffiché (placeholder « configurée »), champ vide n'écrase pas ;
  échappement systématique (`esc_html`/`esc_attr`/`wp_kses`), nonces sur
  toutes les soumissions.
- **B2B** : `billing_company` mappé en buyer.name si présent ; SIREN/SIRET
  via meta de commande `_billing_siret` (convention des plugins FR
  courants) si présente — 14 chiffres → SIREN 9 ; sinon B2C sans siren
  (même règle qu'it.1). Documenté comme convention dans le README.

## 3. Mapping

Identique au contrat sdk (`order-mapping.schema.json`) : vendeur = 7 options
de config ; acheteur = billing address WC ; lignes = items de commande avec
taux de TVA par ligne (WC : `WC_Order_Item_Product::get_taxes` / taux via
`WC_Tax` — 1 ligne par item, taux réel, montants **decimal4** dès le départ
— leçon it.1) ; frais de port = ligne dédiée si non nuls (différence vs
PrestaShop v1, où le port était exclu — ici INCLUS car WooCommerce le
modélise proprement en item ; si l'exclusion s'avère plus simple, aligner
sur it.1 et documenter). PHPUnit rejoue LES MÊMES fixtures sdk.

## 4. Qualité / CI

Mêmes gates que l'it.1 : PHPUnit (logique pure ≥90 %, stubs WP/WC minimaux,
glue non testée documentée), PHPStan niveau 8 (`phpVersion: 80100`),
php-cs-fixer PSR-12, `php -l` sous 8.1 réel en CI. CI : étendre
`.github/workflows/ci-php.yml` (jobs woocommerce parallèles aux jobs
prestashop, paths `connectors/**`), setup-php SHA-pinné inchangé.
`build-zip.sh` propre (plugin seul, ni vendor ni tests).

## 5. Sécurité

Clé jamais loguée/réaffichée/dans les messages (tests dédiés comme it.1) ;
nonces + capabilities sur toute action admin ; échappement de tout output ;
`last_error` sans secret ; `uninstall.php` supprime table + options.

## 6. Découpage (3 tâches + clôture)

1. **Socle** : structure plugin, activation/table/uninstall, réglages
   (clé/URL/statut/7 champs vendeur), `WpHttpTransport` + client +
   exceptions, sonde authentifiée, CI étendue, zip. PHPUnit client/config.
2. **Émission** : OrderMapper WC (fixtures sdk), hook status_changed,
   idempotence, Throwable→pending_retry + journalisation
   (`wc_get_logger`), renvoi manuel. PHPUnit mapping/résilience.
3. **Suivi + clôture** : metabox statuts (présentateur pur testé,
   échappement), README plugin (limites v1 honnêtes), README racine
   (4.2), bump apps/api 0.17.0, gates complètes TS+PHP. Revue de branche
   puis merge.
