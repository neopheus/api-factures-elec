# Design — Phase 4 itération 1 : documentation API publique (OpenAPI) + connecteur PrestaShop

Date : 2026-07-23 · Statut : cadrage validé par Xavier (2026-07-20 : PrestaShop
d'abord · dernières majeures · distribution zip d'abord), exécution autonome
(mandat « fait tout »).
Spec produit parente : `2026-07-12-plateforme-agreee-facturation-electronique-design.md`
§3.1 (`connectors/prestashop`, `packages/connectors-sdk`, doc API publique —
phase 4).

## 1. Périmètre itération 1

**Inclus** : (a) spécification **OpenAPI 3.1** de l'API publique (endpoints
clé-API uniquement — le périmètre qu'un intégrateur tiers consomme) servie
par l'API + doc d'intégration (`docs/api-publique.md`) ; (b) **connecteur
PrestaShop 8.x** (PHP 8.1+, module zip) : configuration (URL + clé API),
émission d'une facture Factelec à la validation de commande, consultation du
statut de génération/cycle de vie ; (c) fixation du **contrat connecteur**
réutilisable (mapping commande→facture) dans `packages/connectors-sdk`
(types TS + JSON Schema exporté — consommé par la doc et les tests, PAS par
le PHP directement).

**Exclus (itérations suivantes)** : WooCommerce (it.2), Shopify (it.3),
publication marketplaces (Addons/WordPress.org/App Store), webhooks sortants
Factelec→boutique (poll uniquement en v1), avoirs/rectificatives déclenchés
depuis la boutique (création manuelle côté dashboard en attendant).

## 2. OpenAPI + doc publique

- Génération **par décorateurs NestJS** (`@nestjs/swagger`) sur les SEULS
  contrôleurs du périmètre public clé-API : dépôt facture
  (`POST /invoices`), lecture (`GET /invoices`, `GET /invoices/:id`,
  formats), statut/historique CDV, santé. Les endpoints session
  (dashboard), admin et webhook Stripe sont EXCLUS du document public
  (filtrage par tags/includes explicites — pas de fuite de surface admin).
- Servie sur `GET /openapi.json` (statique, sans auth — c'est de la doc) +
  `docs/api-publique.md` : démarrage (obtenir une clé, en-tête
  `X-API-Key` — vérifier le nom réel du header dans ApiKeyGuard), cycle
  complet dépôt→génération→statuts, erreurs problem-details, limites de
  débit, versionnement.
- Gate : le JSON généré est validé par un test (openapi-types/spectral
  léger OU validation structurelle maison — au choix de l'implémenteur,
  sobre), et un test verrouille l'ABSENCE des routes admin/session/webhook
  dans le document.

## 3. Connecteur PrestaShop (`connectors/prestashop/`)

- **Cible** : PrestaShop **8.x**, PHP **8.1+**. Pas de 1.6/1.7.
- **Forme** : module `factelec` classique (fichier principal
  `factelec.php`, `composer.json` sans dépendance runtime externe — cURL
  natif via `Tools`/`HttpClient` PS, autoload PSR-4 pour `src/`),
  distribuable en **zip** (script de packaging `make zip` ou
  `composer archive` — livré).
- **Fonctionnel v1** :
  1. **Configuration** (back-office) : URL de l'API Factelec, clé API,
     bouton « Tester la connexion » (GET santé/lecture), activation par
     état de commande (défaut : paiement accepté).
  2. **Émission** : hook `actionOrderStatusPostUpdate` (état
     configurable) → mapping commande PS → payload `POST /invoices`
     Factelec (numéro, dates, vendeur = boutique configurée, acheteur =
     client/adresse de facturation, lignes avec TVA par taux, SIREN
     acheteur si champ B2B disponible — sinon champ de config par client
     absent → facture B2C e-reporting côté Factelec). Idempotence :
     `order_id` PS stocké en table module avec l'`invoice_id` Factelec —
     jamais de double dépôt (contrainte unique).
  3. **Suivi** : onglet admin commandes — statut Factelec (received/
     generated/…, statut CDV courant) rafraîchi par appel à la demande
     (pas de cron v1) ; lien de téléchargement des formats via l'API.
  4. **Robustesse** : échec réseau → message back-office + table module
     marque `pending_retry`, bouton « Renvoyer » manuel (pas de cron v1 —
     documenté comme limite).
- **Qualité PHP** : PHPStan niveau max raisonnable + php-cs-fixer (PSR-12),
  tests **PHPUnit** de la logique pure (mapping, client HTTP mocké,
  idempotence) — l'environnement PS complet n'est PAS requis en CI v1
  (les classes PS sont stubbées, limite documentée) ; CI GitHub job PHP
  dédié (setup-php, composer install, phpstan + phpunit + cs-check).
- **Contrat de mapping** : défini dans `packages/connectors-sdk`
  (`order-mapping.schema.json` + types TS) — le module PHP l'implémente,
  un test TS valide des fixtures partagées (`connectors/fixtures/*.json`)
  contre le schéma ET contre l'API réelle (e2e léger côté api :
  `POST /invoices` accepte les fixtures).

## 4. Sécurité

Clé API stockée chiffrée dans la config PS (méthode native du module —
au minimum non affichée en clair après saisie), jamais loguée ; TLS requis
(refus http:// hors localhost) ; aucune donnée de facture persistée côté
module au-delà des identifiants de corrélation.

## 5. Tests / gates

TS : gates habituelles (le connectors-sdk et l'OpenAPI passent par la CI
existante — unit + e2e fixtures). PHP : job CI dédié (phpstan/phpunit/
cs-fixer) — vert obligatoire. Couverture PHP : logique pure ≥90 %
(mapping/client), glue PS exclue et documentée.

## 6. Découpage (5 tâches)

1. OpenAPI (décorateurs périmètre public + /openapi.json + tests
   d'exclusion) ;
2. `docs/api-publique.md` + `packages/connectors-sdk` (types + JSON Schema
   + fixtures + test e2e fixtures↔API) ;
3. Module PrestaShop — socle (structure, config BO, test connexion,
   packaging zip, CI PHP) ;
4. Module PrestaShop — émission (hook, mapping, idempotence, retry
   manuel) + PHPUnit ;
5. Module PrestaShop — suivi (statuts, téléchargements) + doc utilisateur
   (`connectors/prestashop/README.md`) + revue de branche + merge.
