# Connecteur WooCommerce Factelec

Plugin WordPress/WooCommerce qui dépose automatiquement une facture
électronique conforme (Factur-X/UBL/CII, selon la configuration du tenant)
auprès de Factelec à la transition de statut de commande.

Second connecteur du monorepo Factelec, iso-fonctionnel au
[connecteur PrestaShop](../prestashop/README.md) — voir
`../../docs/api-publique.md` pour le contrat API consommé, et
`../../packages/connectors-sdk/` pour le contrat de mapping partagé entre
tous les connecteurs (PrestaShop, WooCommerce ici, Shopify en itération
suivante). Duplication assumée entre connecteurs : chaque zip est
autonome, aucune dépendance inter-connecteurs.

## Installation

1. Récupérez `factelec-woocommerce-<version>.zip` (produit par
   `./build-zip.sh`, cf. § Développement ci-dessous — ou livré directement
   par Factelec).
2. Back-office WordPress → **Extensions** → **Ajouter une extension** →
   **Téléverser une extension** → sélectionnez le zip → **Installer** →
   **Activer**.
3. Ouvrez **WooCommerce → Factelec** pour configurer le plugin.

Compatibilité : WordPress **6.5+**, WooCommerce **9.0+**, PHP **8.1+**.
Compatible HPOS (High-Performance Order Storage) déclaré — fonctionne
aussi bien avec le stockage de commandes legacy (table `wp_posts`) qu'avec
HPOS.

## Configuration

### Connexion à l'API

| Champ | Description |
| --- | --- |
| URL de l'API | URL de base de l'API Factelec de votre tenant (ex. `https://api.factelec.example.com`). **TLS obligatoire** — `http://` est refusé sauf `localhost`/`127.0.0.1` (usage dev uniquement). |
| Clé API | Créée depuis le dashboard Factelec (page **Clés API**), cf. `../../docs/api-publique.md` §1. **Jamais réaffichée en clair** après saisie — un placeholder indique qu'elle est déjà configurée ; laissez le champ vide pour la conserver telle quelle. Stockée dans `wp_options` (option `factelec_settings`) — ce n'est **pas** un coffre-fort de secrets dédié, au même titre que la configuration native PrestaShop côté connecteur sœur. |
| Statut de commande déclencheur | Statut WooCommerce qui déclenche le dépôt automatique de la facture (défaut : *En cours* / `processing`). |

Utilisez le bouton **Tester la connexion** pour vérifier l'URL et la clé
(`GET /invoices?limit=1`, endpoint authentifié — un 401 signale
spécifiquement une clé invalide/révoquée, distinct d'une panne réseau).

### Identité vendeur

Ces 7 champs figurent sur **chaque facture émise** (BG-4 "seller" du
contrat de mapping) :

- Raison sociale
- SIREN
- Numéro de TVA intracommunautaire
- Adresse, ville, code postal
- Code pays (ISO 3166-1 alpha-2, ex. `FR`)

## Fonctionnement

### Émission automatique

Quand une commande atteint le statut déclencheur configuré (hook
`woocommerce_order_status_changed`), le plugin :

1. mappe la commande WooCommerce (adresse de facturation, items) vers le
   contrat Factelec (`packages/connectors-sdk/schema/order-mapping.schema.json`) ;
2. dépose la facture (`POST /invoices`) ;
3. enregistre la liaison `order_id` ↔ `invoice_id` Factelec en base
   (table `wp_factelec_invoice_link`).

**Acheteur professionnel (B2B)** : si `billing_company` est renseigné, il
devient la raison sociale de l'acheteur. Le SIREN est lu depuis la méta de
commande `_billing_siret` (**convention** des plugins FR courants pour
stocker le SIRET saisi au tunnel de commande, ex. plugins de champs
personnalisés à la caisse) — un SIRET valide (14 chiffres) donne le SIREN
(9 premiers chiffres) ; absent ou malformé, la facture est émise sans
SIREN (Factelec la route alors en e-reporting B2C). **Le numéro de TVA
intracommunautaire acheteur n'est volontairement pas mappé** : contrairement
au SIRET, aucune convention de méta n'est établie côté écosystème
WooCommerce pour ce champ — deviner un nom de méta aurait risqué un
mapping silencieusement faux face à un plugin populaire utilisant une
autre clé.

**Frais de port** : mappés en ligne de facture dédiée dès lors qu'ils sont
non nuls (différence assumée avec le connecteur PrestaShop, qui les
exclut — WooCommerce modélise le port comme un item de commande structuré,
pas un champ agrégé).

**Idempotence stricte** : une commande ne peut jamais être déposée deux
fois — une liaison existante (quel que soit son statut) bloque tout
nouveau dépôt automatique, sans même appeler l'API.

**Panne réseau ou erreur API** : la commande passe en statut *en attente
de renvoi* (`pending_retry`), avec le message d'erreur (jamais la clé API)
conservé pour diagnostic et journalisé via `wc_get_logger()` (source
`factelec`, visible dans **WooCommerce → Statut → Journaux**). **Aucune
facture n'est jamais perdue silencieusement.**

### Renvoi manuel

Deux façons de renvoyer une facture en échec :

- Le bouton **Renvoyer les factures en attente** (page **WooCommerce →
  Factelec**) retente le dépôt de **toutes** les commandes en
  `pending_retry` et affiche un résumé (succès/échecs).
- Le bouton **Renvoyer** dans la metabox de suivi d'une commande
  individuelle (voir ci-dessous) ne retente que **cette** commande.

**Il n'y a pas de tâche planifiée (cron) en v1** — le renvoi est toujours
déclenché manuellement.

### Suivi

L'écran de commande (compatible HPOS et legacy) affiche une metabox
**Factelec — Facturation électronique** : statut du dépôt, identifiant
Factelec, dernière erreur le cas échéant. Le bouton **Actualiser**
interroge l'API (`GET /invoices/:id`) pour rafraîchir le statut de cycle
de vie (nomenclature DGFiP) et lister les formats déjà générés.

Les liens de téléchargement des formats pointent vers l'URL directe de
l'API (`GET /invoices/:id/formats/:format`) — cet endpoint est
**authentifié** (`Authorization: Bearer <clé API>`), ces liens ne sont
donc **pas directement cliquables** depuis un navigateur (aucun moyen
standard d'y attacher un en-tête personnalisé). Utilisez un client HTTP
(curl, Postman) avec votre clé API, ou téléchargez le document depuis le
dashboard Factelec. Un proxy de téléchargement intégré au plugin a été
délibérément écarté en v1 (même arbitrage que le connecteur PrestaShop).

## Limites connues (v1)

- **WooCommerce 9.x / WordPress 6.5+ uniquement** (le plugin déclare un
  header `Requires Plugins: woocommerce`, effectif seulement à partir de
  WordPress 6.5).
- **Pas de tâche planifiée (cron)** — le renvoi des factures en échec est
  toujours manuel (page de réglages ou metabox commande).
- **Pas d'avoirs/rectificatives** — seules les factures (typeCode `380`)
  sont émises ; la création d'un avoir reste manuelle depuis le dashboard
  Factelec.
- **`vatCategory` simplifiée** : chaque ligne (produit ou port) est
  classée `S` (taux standard) si son taux de TVA est > 0, sinon `Z` (taux
  zéro) — WooCommerce ne modélise pas nativement la distinction EN 16931
  plus fine (zéro-taux/exonéré/hors-champ).
- **Un seul taux de TVA par ligne** : si plusieurs taux s'appliquent
  simultanément à un même item (classes de taxe composées, rare en
  France), seul le premier taux rencontré est retenu, jamais sommé.
- **Quantités entières uniquement** : le mapper convertit la quantité de
  chaque item en entier (`(int) $item->get_quantity()`) — les quantités
  décimales (ex. vente au poids/à la découpe via des plugins WooCommerce
  spécialisés) sont tronquées, pas arrondies ni rejetées. Non testé avec
  ce type de plugin en v1.
- **`buyer.vatId` non mappé** — aucune convention de méta WooCommerce
  établie pour le numéro de TVA intracommunautaire acheteur (cf. ci-dessus).
- **`dueDate`/`businessProcessType` non mappés** — aucune règle de délai
  de paiement ni de cadre de facturation DGFiP n'est configurée côté
  plugin ; ces deux champs (optionnels dans le contrat) restent absents du
  payload envoyé.
- **`unitCode` fixe** (`C62`, pièce/unité UN/ECE reco 20) — pas de code
  d'unité par produit.
- **Clé API stockée en option WordPress** (`wp_options`, option
  `factelec_settings`) — jamais réaffichée en clair après saisie, jamais
  journalisée ; ce n'est pas un coffre-fort de secrets dédié.
- **Aucune donnée de facture n'est persistée côté plugin** au-delà des
  identifiants de corrélation (`order_id`, `invoice_id`, statut, dernière
  erreur) — le contenu de la facture reste exclusivement chez Factelec.

## Développement

```bash
composer install       # dev uniquement — vendor/ jamais dans le zip de production
vendor/bin/phpunit      # tests de la logique pure (mapping, client API, idempotence, suivi)
vendor/bin/phpstan analyse   # niveau 8 sur factelec/src
vendor/bin/php-cs-fixer fix --dry-run --diff   # PSR-12
./build-zip.sh          # produit factelec-woocommerce-<version>.zip
```

Le plugin n'a **aucune dépendance runtime** : `factelec.php` embarque son
propre autoloader PSR-4 minimal pour `FactelecWoo\`, aucun
`vendor/autoload.php` n'est distribué en production. `composer.json` ne
sert qu'à l'outillage de développement (phpunit/phpstan/php-cs-fixer).

`factelec.php` est de la **glue WordPress/WooCommerce non testée
unitairement** — décision documentée dans le fichier lui-même : il dépend
directement des fonctions/classes coeur WordPress et WooCommerce réelles
(`add_action`, `register_setting`, `$wpdb`/`dbDelta`, `WC_Order`,
`FeaturesUtil`...), non disponibles en CI. Des stubs minimaux
(`tests/stubs/`, seulement ce que le code référence) existent pour cette
raison. **Toute la logique décisionnelle** (mapping commande→facture,
idempotence, retry, présentation du suivi) vit dans `factelec/src/` et est
couverte à 100 % avec un transport HTTP mocké et une base `$wpdb` en
mémoire.

CI dédiée (jobs `woocommerce`/`woocommerce-php-lint-81`, parallèles aux
jobs PrestaShop) : `../../.github/workflows/ci-php.yml` (composer install,
php-cs-fixer, phpstan, phpunit, `php -l` sous PHP 8.1 réel).
