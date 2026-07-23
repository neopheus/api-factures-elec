# Connecteur PrestaShop Factelec

Module PrestaShop **8.x** qui dépose automatiquement une facture
électronique conforme (Factur-X/UBL/CII, selon la configuration du tenant)
auprès de Factelec à la validation de commande.

Premier code PHP du monorepo Factelec — voir `../../docs/api-publique.md`
pour le contrat API consommé par ce connecteur, et
`../../packages/connectors-sdk/` pour le contrat de mapping partagé entre
tous les connecteurs (PrestaShop v1 ici, WooCommerce/Shopify en itérations
suivantes).

## Installation

1. Récupérez `factelec-prestashop-<version>.zip` (produit par
   `./build-zip.sh`, cf. § Développement ci-dessous — ou livré directement
   par Factelec).
2. Back-office PrestaShop → **Modules** → **Catalogue de modules** →
   **Importer un module** → sélectionnez le zip.
3. Une fois installé, ouvrez la configuration du module (**Modules** →
   rechercher « Factelec » → **Configurer**).

Compatibilité : PrestaShop **8.0 à 8.99**, PHP **8.1+**. Les versions 1.6
et 1.7 ne sont **pas** supportées.

## Configuration

### Connexion à l'API

| Champ | Description |
| --- | --- |
| URL de l'API | URL de base de l'API Factelec de votre tenant (ex. `https://api.factelec.example.com`). **TLS obligatoire** — `http://` est refusé sauf `localhost`/`127.0.0.1` (usage dev uniquement). |
| Clé API | Créée depuis le dashboard Factelec (page **Clés API**), cf. `../../docs/api-publique.md` §1. **Jamais réaffichée en clair** après saisie — un placeholder indique qu'elle est déjà configurée ; laissez le champ vide pour la conserver telle quelle. |
| État de commande déclencheur | État PrestaShop qui déclenche le dépôt automatique de la facture (défaut : *paiement accepté*). |

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

Quand une commande atteint l'état déclencheur configuré, le module :

1. mappe la commande PrestaShop (client, adresse de facturation, lignes)
   vers le contrat Factelec (`packages/connectors-sdk/schema/order-mapping.schema.json`) ;
2. dépose la facture (`POST /invoices`) ;
3. enregistre la liaison `id_order` ↔ `invoice_id` Factelec en base.

**Acheteur professionnel (B2B)** : si le client a une raison sociale et un
SIRET renseignés (mode B2B natif PrestaShop, `PS_B2B_ENABLE`), le SIREN
(9 premiers chiffres du SIRET) et le numéro de TVA intracommunautaire sont
transmis. Sinon, la facture est émise sans SIREN — Factelec la route alors
en e-reporting B2C.

**Idempotence stricte** : une commande ne peut jamais être déposée deux
fois — une liaison existante (quel que soit son statut) bloque tout
nouveau dépôt automatique.

**Panne réseau ou erreur API** : la commande passe en état *en attente de
renvoi* (`pending_retry`), avec le message d'erreur (jamais la clé API)
conservé pour diagnostic. **Aucune facture n'est jamais perdue
silencieusement.**

### Renvoi manuel

Le bouton **Renvoyer les factures en attente** (page de configuration du
module) retente le dépôt de **toutes** les commandes en `pending_retry` et
affiche un résumé (succès/échecs). **Il n'y a pas de tâche planifiée
(cron) en v1** — le renvoi est toujours déclenché manuellement.

### Suivi

Le détail de chaque commande affiche un bloc **Facturation électronique
Factelec** : statut du dépôt, identifiant Factelec, dernière erreur le cas
échéant. Le bouton **Actualiser** interroge l'API (`GET /invoices/:id`)
pour rafraîchir le statut de cycle de vie (nomenclature DGFiP) et lister
les formats déjà générés.

Les liens de téléchargement des formats pointent vers l'URL directe de
l'API (`GET /invoices/:id/formats/:format`) — cet endpoint est
**authentifié** (`Authorization: Bearer <clé API>`), ces liens ne sont
donc **pas directement cliquables** depuis un navigateur (aucun moyen
standard d'y attacher un en-tête personnalisé). Utilisez un client HTTP
(curl, Postman) avec votre clé API, ou téléchargez le document depuis le
dashboard Factelec. Un proxy de téléchargement intégré au module a été
délibérément écarté en v1 (surface de sécurité et de tests
supplémentaire — nouvelle route BO, streaming de flux binaires — non
justifiée à ce stade).

## Limites connues (v1)

- **PrestaShop 8.x uniquement** — pas de support 1.6/1.7.
- **Pas de tâche planifiée (cron)** — le renvoi des factures en échec est
  toujours manuel (bouton BO).
- **Pas d'avoirs/rectificatives** — seules les factures (typeCode `380`)
  sont émises ; la création d'un avoir reste manuelle depuis le dashboard
  Factelec.
- **`vatCategory` simplifiée** : chaque ligne est classée `S` (taux
  standard) si son taux de TVA PrestaShop est > 0, sinon `E` (exonéré
  générique) — PrestaShop ne modélise pas nativement la distinction EN
  16931 plus fine (zéro-taux/exonéré/hors-champ).
- **`dueDate`/`businessProcessType` non mappés** — aucune règle de délai
  de paiement ni de cadre de facturation DGFiP n'est configurée côté
  module ; ces deux champs (optionnels dans le contrat) restent absents du
  payload envoyé.
- **`unitCode` fixe** (`C62`, pièce/unité UN/ECE reco 20) — pas de code
  d'unité par produit.
- **Clé API stockée en configuration PrestaShop** (`ps_configuration`,
  méthode native du module) — jamais réaffichée en clair après saisie,
  jamais journalisée ; ce n'est pas un coffre-fort de secrets dédié.
- **Aucune donnée de facture n'est persistée côté module** au-delà des
  identifiants de corrélation (`id_order`, `invoice_id`, statut, dernière
  erreur) — le contenu de la facture reste exclusivement chez Factelec.

## Développement

```bash
composer install       # dev uniquement — vendor/ jamais dans le zip de production
vendor/bin/phpunit      # tests de la logique pure (mapping, client API, idempotence, suivi)
vendor/bin/phpstan analyse   # niveau 8 sur factelec/src
vendor/bin/php-cs-fixer fix --dry-run --diff   # PSR-12
./build-zip.sh          # produit factelec-prestashop-<version>.zip
```

Le module n'a **aucune dépendance runtime** : `factelec.php` embarque son
propre autoloader PSR-4 minimal pour `Factelec\`, aucun
`vendor/autoload.php` n'est distribué en production. `composer.json` ne
sert qu'à l'outillage de développement (phpunit/phpstan/php-cs-fixer).

`factelec.php` est de la **glue PrestaShop non testée unitairement** —
décision documentée dans le fichier lui-même : il dépend directement des
classes coeur PrestaShop réelles (`Module`, `Configuration`, `Db`,
`Tools`, `Order`, `Customer`, `Address`, `Currency`,
`PrestaShopLogger`...), non disponibles en CI. Des stubs minimaux
(`tests/stubs/`, seulement ce que le code référence) existent pour cette
raison. **Toute la logique décisionnelle** (mapping commande→facture,
idempotence, retry, présentation du suivi) vit dans `factelec/src/` et est
couverte à 100 % avec un transport HTTP mocké et une base en mémoire.

CI dédiée : `.github/workflows/ci-php.yml` (composer install, php-cs-fixer,
phpstan, phpunit).
