# API publique Factelec — guide d'intégration

Ce guide s'adresse aux intégrateurs tiers qui déposent des factures dans
Factelec depuis un système externe (boutique e-commerce, ERP, connecteur
maison — ex. module PrestaShop). Il documente le périmètre **clé API**
uniquement : dépôt et consultation de factures, téléchargement des formats
générés, suivi du statut réglementaire (CDV). Les fonctions dashboard
(session utilisateur, administration, facturation Stripe) sont hors
périmètre de ce document.

La spécification technique complète (schémas, tous les champs, tous les
codes de retour) est servie en **OpenAPI 3.1** à l'URL suivante, sans
authentification :

```
GET /openapi.json
```

Importez cette URL dans votre client HTTP ou générateur de code préféré
(Postman, Swagger Codegen, openapi-typescript, etc.) pour obtenir des types
et des clients à jour automatiquement.

## 1. Obtenir une clé API

Les clés API sont gérées depuis le dashboard Factelec, page **Clés API**
(`/api-keys`), par un utilisateur du rôle `owner` ou `admin` du tenant :

1. Se connecter au dashboard.
2. Aller sur la page **Clés API**.
3. Créer une clé (libellé libre, ex. `prestashop-boutique-1`).
4. Le secret complet n'est affiché **qu'une seule fois**, à la création —
   copiez-le immédiatement dans votre configuration (variable
   d'environnement ou stockage chiffré côté connecteur, jamais en clair
   dans un dépôt de code). Il n'est ensuite plus jamais récupérable :
   seule une révocation puis recréation est possible si vous le perdez.
5. Une clé peut être révoquée à tout moment depuis la même page — la
   révocation est immédiate.

Chaque clé est scopée à **un seul tenant** : elle n'a accès qu'aux
factures de ce tenant.

## 2. Authentification

Toutes les routes de ce périmètre (sauf `/health*` et `/openapi.json`)
exigent l'en-tête suivant :

```
Authorization: Bearer <clé API>
```

Le nom du schéma (`Bearer`) est insensible à la casse (`bearer`, `BEARER`
sont acceptés) ; le secret qui suit est comparé tel quel. **Il n'y a pas
d'en-tête `X-API-Key`** — c'est bien `Authorization: Bearer` qui est
vérifié côté serveur (`ApiKeyGuard`).

Une clé manquante ou invalide renvoie **401** :

```json
{
  "type": "urn:factelec:problem:unauthorized",
  "title": "Unauthorized",
  "status": 401,
  "detail": "Missing or invalid API key"
}
```

## 3. Cycle de vie d'une facture déposée

### 3.1 Dépôt — `POST /invoices`

Corps : une facture canonique **EN 16931** en JSON (voir `/openapi.json`
pour le schéma complet — champs, formats, contraintes). Exemple minimal :

```json
{
  "number": "FA-2026-1",
  "issueDate": "2026-07-23",
  "typeCode": "380",
  "currency": "EUR",
  "seller": {
    "name": "Ma Boutique SAS",
    "siren": "552100554",
    "address": { "countryCode": "FR" }
  },
  "buyer": {
    "name": "Client Particulier",
    "address": { "countryCode": "FR" }
  },
  "lines": [
    {
      "id": "1",
      "name": "Article",
      "quantity": "1",
      "unitCode": "C62",
      "unitPrice": "100.00",
      "vatCategory": "S",
      "vatRate": "20.00"
    }
  ]
}
```

Réponse **201** :

```json
{ "id": "<uuid>", "status": "received" }
```

Point important : ce `status` est le **statut de génération interne**
(`received` → `generating` → `generated`/`failed`), **distinct** du statut
réglementaire CDV (cycle de vie DGFiP, voir §3.4). À ce stade, seule la
facture est persistée ; la génération des formats (UBL, CII, Factur-X, flux
DGFiP) est enfilée de façon **asynchrone** — elle n'est pas encore
disponible immédiatement après le 201.

Réponses d'erreur possibles sur le dépôt (voir §4 pour le détail des
types) : **401** (clé absente/invalide), **402** (abonnement requis, si
l'enforcement de facturation est actif sur votre tenant), **403** (tenant
suspendu par un opérateur), **409** (numéro de facture déjà utilisé pour ce
tenant), **422** (facture structurellement invalide ou violant une règle
métier EN 16931).

### 3.2 Suivi du statut de génération — `GET /invoices/:id`

```
GET /invoices/<id>
```

Renvoie le détail de la facture, y compris `status` (génération —
`received`/`generating`/`generated`/`failed`), `lifecycleStatus` (CDV
courant) et `availableFormats` (liste des formats déjà générés et
téléchargeables). Interrogez cette route en poll après le dépôt jusqu'à ce
que `status` passe à `generated` (ou `failed`, à traiter comme une erreur
définitive côté connecteur — contactez le support).

### 3.3 Télécharger un format généré — `GET /invoices/:id/formats/:format`

```
GET /invoices/<id>/formats/ubl
GET /invoices/<id>/formats/cii
GET /invoices/<id>/formats/facturx
GET /invoices/<id>/formats/flux_base
GET /invoices/<id>/formats/flux_full
```

Renvoie le contenu brut du format demandé (`Content-Type` variable :
`application/xml` pour `ubl`/`cii`/`flux_base`/`flux_full`, type propre à
Factur-X pour `facturx`). **404** si la facture ou ce format précis n'est
pas encore disponible (génération asynchrone — vérifiez `availableFormats`
via `GET /invoices/:id` avant d'appeler cette route).

### 3.4 Statut réglementaire (CDV) et historique — `GET /invoices/:id/status`

```
GET /invoices/<id>/status
```

Renvoie le statut CDV courant (nomenclature DGFiP, codes 200 à 213 —
`deposee`, `emise`, `recue`, `mise_a_disposition`, `prise_en_charge`,
`approuvee`, `approuvee_partiellement`, `en_litige`, `suspendue`,
`completee`, `refusee`, `paiement_transmis`, `encaissee`, `rejetee`) et
l'historique complet des transitions (`fromStatus`, `toStatus`, `actor`,
`reason`, `createdAt`). Une facture nouvellement déposée est au statut
`deposee` (code 200).

### 3.5 Lister les factures du tenant — `GET /invoices`

```
GET /invoices?limit=20&cursor=<curseur opaque>&routingStatus=<...>
```

Pagination par curseur opaque (keyset, tri décroissant par date de
création) — repassez `nextCursor` de la page précédente en `?cursor=` pour
avancer. `limit` : 1 à 100, défaut 20.

## 4. Erreurs — `application/problem+json` (RFC 9457)

Toute réponse d'erreur (4xx/5xx) est un document `problem+json` :

```json
{
  "type": "urn:factelec:problem:<motif>",
  "title": "<titre humain>",
  "status": <code HTTP>,
  "detail": "<détail optionnel>",
  "errors": [ /* optionnel, ex. liste des violations de validation */ ]
}
```

Types réels (`urn:factelec:problem:<suffixe>`) rencontrés sur ce
périmètre :

| HTTP | Suffixe `type`             | Signification                                                                 |
|------|-----------------------------|--------------------------------------------------------------------------------|
| 401  | `unauthorized`               | Clé API manquante ou invalide.                                                |
| 402  | `subscription-required`      | Abonnement du tenant invalide (dépôt uniquement, si enforcement actif).       |
| 403  | `tenant-suspended`           | Tenant suspendu par un opérateur de la plateforme (dépôt uniquement).         |
| 404  | `not-found`                  | Facture inconnue pour ce tenant, ou identifiant hors format UUID.             |
| 409  | `conflict`                   | Numéro de facture déjà utilisé pour ce tenant (idempotence).                  |
| 422  | `validation-error`           | Facture structurellement invalide (`errors[]` : `path`/`code`/`message`).     |
| 422  | `business-rule-violation`    | Violation d'une règle métier EN 16931 (`errors[]` : `rule`/`message`).        |
| 429  | `rate-limited`                | Limite de débit dépassée (voir §5).                                          |
| 500  | `internal-error`              | Erreur serveur non maîtrisée — ne contient jamais de détail interne.          |

**402 et 403 ne concernent que le dépôt** (`POST /invoices`) : la lecture
(`GET /invoices*`) reste accessible même si le tenant est en situation
d'abonnement invalide ou suspendu.

## 5. Limites de débit (rate limiting)

Un plafond global de requêtes par adresse IP s'applique **avant**
l'authentification (`@nestjs/throttler`), sur toutes les routes de ce
périmètre à l'exception de `/health` (jamais limité — sonde de
disponibilité). Par défaut :

- Fenêtre : `RATE_LIMIT_TTL` = 60 secondes.
- Plafond : `RATE_LIMIT_LIMIT` = 120 requêtes par fenêtre.

Ces valeurs sont configurables par déploiement (variables d'environnement
côté opérateur Factelec) — les défauts ci-dessus sont ceux du code source à
la date de ce document ; contactez votre opérateur si vous avez besoin de
connaître la configuration effective de votre environnement. Au-delà de la
limite, la réponse est **429** avec `type: urn:factelec:problem:rate-limited`.
Recommandation d'intégration : traiter le 429 avec un retrait exponentiel
(`Retry-After` non garanti à ce jour — se baser sur un backoff côté
connecteur).

## 6. Versionnement

**Aucune garantie de stabilité n'est donnée avant la version 1.0** de
l'API. Le numéro de version exposé dans `/openapi.json`
(`info.version`) suit la version de release du service (actuellement en
`0.x`) : des champs peuvent être ajoutés, des contraintes affinées, et — en
`0.x` seulement — des changements non rétrocompatibles peuvent survenir
sans préavis long. Un connecteur en production doit :

- valider défensivement les réponses (ne pas supposer la présence d'un
  champ non documenté ici ou dans `/openapi.json`) ;
- suivre les notes de version du service ;
- s'attendre à ce qu'un passage en `1.0` fige un contrat stable avec
  politique de dépréciation formelle (non encore publiée à ce jour).

## 7. Contrat de mapping pour les connecteurs

Si vous développez un connecteur (ex. module e-commerce), le paquet
`@factelec/connectors-sdk` (dans ce monorepo,
`packages/connectors-sdk/`) fixe le contrat de mapping commande→facture
attendu par `POST /invoices` : types TypeScript
(`src/order-mapping.ts`), schéma JSON Schema 2020-12 équivalent
(`schema/order-mapping.schema.json`) et des fixtures JSON réalistes
(`fixtures/`) validées à la fois contre ce schéma et contre l'API réelle.
