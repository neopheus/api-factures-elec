# Conception — Plateforme agréée de facturation électronique (SaaS)

Date : 2026-07-12
Statut : validé en brainstorming, en attente de relecture finale

## 1. Objectif et positionnement

Construire un SaaS multi-tenant qui devient **plateforme agréée (PA/PDP)** immatriculée
par la DGFiP pour la réforme française de la facturation électronique, avec une
spécialisation e-commerce : connecteurs natifs PrestaShop, WooCommerce, Shopify et une
API publique pour les systèmes custom (ERP, sites sur mesure).

Périmètre fonctionnel complet dès le lancement (obligatoire pour une PA) :

- **E-invoicing B2B domestique** : émission, transmission, réception des factures
  électroniques (formats du socle), gestion du cycle de vie des statuts.
- **E-reporting** : transmission à la DGFiP des données de transactions B2C /
  internationales et des données de paiement.
- **Annuaire** : interrogation de l'annuaire central pour le routage, gestion des
  inscriptions des clients dont la plateforme est PA de réception.
- **Archivage à valeur probante** : conservation 10 ans.

Contraintes structurantes :

- Développement et exploitation **en solo** (assisté par IA) → simplicité opérationnelle maximale.
- **Coût d'infrastructure minimal** compatible avec les exigences d'une PA.
- **Sécurité de niveau audit d'immatriculation** dès la conception.
- **Aucun code sans tests** (TDD, CI bloquante).
- Point d'accès **Peppol interne, non sous-traité** (décision explicite).

Calendrier réaliste : l'échéance du 1er septembre 2026 (grandes entreprises et
obligation de réception) n'est pas atteignable pour un nouvel entrant ; l'objectif est
l'**immatriculation courant 2027**, pour être prêt à l'échéance TPE/PME de
**septembre 2027** — qui est précisément la cible e-commerce.

Démarches administratives à mener en parallèle du développement (rien n'est commencé) :

1. Adhésion OpenPeppol (peppol.org/join).
2. Convention avec l'Autorité Peppol française (DGFiP) via demarche.numerique.gouv.fr/commencer/peppolfrance.
3. Certificats PKI Peppol de test, conformité sur le testbed, puis certificats de production.
4. Dossier d'immatriculation PA auprès du service d'immatriculation de la DGFiP
   (immat.pdp@dgfip.finances.gouv.fr) — le guide d'immatriculation et la liste des
   pièces sont téléchargeables sur impots.gouv.fr (page « facturation électronique et
   plateformes agréées »).

## 2. Modèle commercial

- Abonnement direct des marchands/entreprises : inscription en self-service,
  abonnement mensuel par organisation + facturation au volume (factures émises/reçues,
  transactions e-reporting), via Stripe (subscriptions + metered usage).
- Un **super admin** (l'exploitant) supervise l'ensemble de la plateforme.

## 3. Architecture générale

Décision : **monolithe modulaire TypeScript** + **point d'accès Peppol auto-hébergé**
(phase4/phoss SMP, conteneurs Java configurés, sans développement Java).

Alternatives écartées : sous-traitance du point d'accès Peppol (refusée par décision
produit) ; microservices événementiels (charge d'exploitation et coût incompatibles
avec un développement solo).

### 3.1 Monorepo

```
apps/
  api/            → NestJS : API REST (OpenAPI), webhooks entrants/sortants, auth
  worker/         → mêmes modules NestJS exécutés en processus séparé (BullMQ)
  web/            → Next.js : dashboard marchands + espace super admin
  peppol-ap/      → point d'accès AS4 basé sur phase4 (conteneur Java, config + glue)
  peppol-smp/     → phoss SMP : publication des participants dans le réseau Peppol
packages/
  invoice-core/   → modèle canonique EN 16931, génération/lecture/validation
                    Factur-X, UBL 2.1, CII — bibliothèque pure, sans I/O
  peppol/         → interface TransmissionProvider + adaptateur vers l'AP interne
  connectors-sdk/ → types, client HTTP et signatures partagés par les connecteurs
infra/            → Terraform (Scaleway) + manifestes de déploiement
docs/             → specs, plans, dossier technique pour l'immatriculation
connectors/
  prestashop/     → module PHP
  woocommerce/    → plugin PHP
  shopify/        → app OAuth + webhooks
```

### 3.2 Flux central

Connecteur/API → ingestion (validation, idempotence) → file BullMQ → workers :
génération du format cible → validation Schematron → scellement + archivage →
transmission (Peppol AS4 pour le B2B, concentrateur DGFiP pour l'e-reporting) →
réception des statuts de cycle de vie → notification de la boutique par webhook signé.

Tout passage vers l'extérieur transite par l'interface `TransmissionProvider` : le
métier ne connaît jamais le détail du transport.

### 3.3 Infrastructure (Scaleway, ~200-300 €/mois au départ)

- Kubernetes Kapsule mutualisé (control plane gratuit), 2-3 nœuds + 1 nœud dimensionné
  pour les JVM phase4/SMP.
- PostgreSQL managé (chiffrement au repos, sauvegardes automatiques) — base unique
  multi-tenant, isolation par `tenant_id` + Row-Level Security.
- Redis managé (BullMQ).
- Object Storage S3 avec **object lock (WORM)** pour l'archivage 10 ans.
- Secret Manager pour tous les secrets.
- CI/CD GitHub Actions : lint, typecheck, tests, Semgrep, Trivy, audit dépendances,
  build, déploiement.
- Observabilité : Sentry, logs structurés JSON centralisés, alerting uptime ; l'AP
  Peppol doit être hautement disponible (réception entrante permanente).

## 4. Domaine métier

### 4.1 Multi-tenancy et rôles

- `Organization` (SIREN) → `Shops` (boutiques connectées, une clé API chacune) →
  `Users` (rôles : propriétaire, admin, comptable, lecture seule).
- Super admin : espace séparé — supervision de tous les tenants, état des
  transmissions et files, gestion annuaire, impersonation tracée, feature flags,
  santé plateforme.

### 4.2 Moteur de factures (`invoice-core`)

- Modèle canonique interne aligné sur le modèle sémantique EN 16931 ; tous les
  formats entrent et sortent par ce pivot.
- Formats du socle : Factur-X (PDF/A-3 + XML CII), UBL 2.1, CII. Validation
  Schematron officielle systématique avant toute transmission.
- Cycle de vie DGFiP complet (déposée, rejetée, refusée, encaissée…), échangé avec
  les autres PA, exposé aux boutiques par webhooks.

### 4.3 E-reporting

Les connecteurs remontent chaque transaction B2C et les données de paiement ;
agrégation périodique selon le régime fiscal du client ; transmission au concentrateur
DGFiP au calendrier réglementaire ; suivi des rejets et relances.

### 4.4 Annuaire

Interrogation de l'annuaire central (SIREN → PA du destinataire) pour le routage B2B ;
gestion des inscriptions des clients (PA de réception).

### 4.5 Archivage à valeur probante

Scellement de chaque facture (hash SHA-256 chaîné, horodatage), stockage S3
object-lock 10 ans, piste d'audit fiable (PAF) exportable par client.

## 5. Connecteurs

- Tous les connecteurs consomment **la même API publique** (OpenAPI documenté) : ce
  que font les modules officiels, un intégrateur custom peut le faire.
- PrestaShop (module PHP) et WooCommerce (plugin PHP) : poussent commandes, factures,
  paiements ; reçoivent les statuts par webhook ; clé API par boutique.
- Shopify : app OAuth, webhooks Shopify natifs.
- Webhooks sortants signés HMAC, livrés avec retries + idempotence.

## 6. Sécurité

- MFA TOTP obligatoire pour tout rôle admin ; super admin : MFA + allowlist IP.
- Clés API hachées, à portée limitée (scopes par boutique), rotation possible.
- Isolation tenant : RLS Postgres, vérifiée par des tests automatiques dédiés.
- Chiffrement au repos partout ; champs sensibles chiffrés applicativement ;
  secrets exclusivement dans Secret Manager.
- Réseau privé ; seuls le load balancer et l'endpoint AS4 sont exposés ; rate
  limiting ; TLS 1.2+ ; mTLS Peppol.
- Journal d'audit immuable (actions admin/support) ; PRA documenté, sauvegardes
  chiffrées, restauration testée régulièrement.
- CI sécurité à chaque PR (Semgrep, Trivy, audit de dépendances).
- RGPD : registre des traitements, DPA type, données hébergées en France.

## 7. Tests — règle absolue

- TDD systématique ; CI bloquante (échec de test ou baisse de couverture = pas de merge).
- Unitaires Vitest sur `invoice-core` et la logique métier.
- **Golden files** : factures de référence validées contre les Schematron officiels à chaque build.
- Intégration : Testcontainers (Postgres, Redis réels).
- E2e API : parcours complets ingestion → génération → transmission → statuts.
- Tests d'isolation multi-tenant explicites.
- Connecteurs : tests PHP (PHPUnit) et tests de contrat contre l'OpenAPI.

## 8. Phasage

| Phase | Contenu technique | Administratif en parallèle |
|---|---|---|
| 1. Socle | Monorepo, auth multi-tenant, `invoice-core`, API ingestion, dashboard minimal | Adhésion OpenPeppol, convention Autorité Peppol FR, début dossier DGFiP |
| 2. Cœur réglementaire | Cycle de vie, scellement/archivage, moteur e-reporting | Constitution du dossier technique |
| 3. Peppol interne | phase4 + SMP déployés, certificats de test, conformité testbed | Tests de conformité Peppol |
| 4. Connecteurs | PrestaShop, WooCommerce, Shopify, doc API publique | — |
| 5. Commercialisation | Stripe, super admin complet, observabilité durcie | Dépôt du dossier d'immatriculation |
| 6. Production | Audit de conformité, certificats de production, go-live | Immatriculation (objectif courant 2027) |

Chaque phase fera l'objet de son propre plan d'implémentation détaillé
(cycle spec → plan → implémentation par sous-projet).

## 9. Références

- https://www.impots.gouv.fr/facturation-electronique-et-plateformes-agreees
  (guide d'immatriculation, liste des pièces, FAQ plateformes — PDF téléchargeables)
- https://www.impots.gouv.fr/rejoindre-le-reseau-peppol
- https://demarche.numerique.gouv.fr/commencer/peppolfrance (convention Autorité Peppol)
- https://peppol.org/tools-support/testbed/ (testbed de conformité)
- phase4 : https://github.com/phax/phase4 — phoss SMP : https://github.com/phax/phoss-smp
- Norme EN 16931, spécifications Factur-X (FNFE-MPE), spécifications externes DGFiP
