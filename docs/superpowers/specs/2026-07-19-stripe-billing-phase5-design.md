# Design — Intégration Stripe (phase 5 « Commercialisation », itération 1)

Date : 2026-07-19 · Statut : validé par Xavier (brainstorming session)
Spec produit parente : `2026-07-12-plateforme-agreee-facturation-electronique-design.md` §2
(« abonnement mensuel par organisation + facturation au volume, via Stripe
(subscriptions + metered usage) »).

## Décisions de cadrage (validées une à une)

1. **Structure tarifaire** : un plan unique + compteur de volume (metered).
2. **Enforcement** : blocage de l'émission seulement, lecture/export toujours
   ouverts ; grâce pendant le dunning Stripe.
3. **TVA** : 20 % fixe France sur les Prices Stripe (clients = entreprises
   françaises, SIREN obligatoire dans Factelec). Pas de Stripe Tax.
4. **UX paiement** : 100 % hébergé Stripe (Checkout + Customer Portal). Aucune
   donnée carte côté Factelec, conformité PCI déléguée.
5. **Architecture** : approche A — miroir local piloté par webhooks (B
   « interrogation Stripe en direct » et C « moteur de facturation local »
   écartées : latence/couplage pour B, réinvention du dunning pour C).

## 1. Périmètre

**Inclus (cette itération)** : abonnement unique + volume métré ; sessions
Checkout et Customer Portal ; miroir local d'état d'abonnement ; garde
d'émission ; report d'usage quotidien ; page « Abonnement » du dashboard ;
TVA 20 % fixe ; script de bootstrap sandbox.

**Exclus (itérations suivantes)** : paliers multiples, essai gratuit, vue
facturation du super admin (au-delà du statut par tenant), Stripe Tax,
coupons/parrainage, changement de plan.

## 2. Tarification

- **Base** : 29 € HT/mois par organisation (Price récurrent mensuel,
  TVA 20 % attachée au Price).
- **Volume** : Billing Meter Stripe `documents_processed` = factures émises
  + factures reçues + transmissions e-reporting. Price métré **gradué** :
  0-100 documents/mois → 0 € ; au-delà → 0,20 € HT/document.
- Les montants vivent dans Stripe, **jamais dans le code** : l'API ne
  référence que des IDs (`STRIPE_PRICE_BASE`, `STRIPE_PRICE_METERED`).
  Changement de prix = dashboard Stripe, sans redéploiement.
- **`pnpm billing:bootstrap`** (script idempotent, clé de test) : crée
  Product, Meter et les deux Prices en sandbox et imprime les IDs à copier
  dans `.env`.

## 3. Modèle de données

Migration Drizzle (numéro suivant disponible), RLS FORCE + politiques
`nullif` comme les tables existantes ; grants différenciés app/worker dans
le même esprit que les verrous actifs.

- **`tenant_billing`** (1 ligne par tenant) :
  `tenant_id` (PK, FK tenants), `stripe_customer_id` (unique, nullable tant
  qu'aucun checkout), `stripe_subscription_id` (nullable),
  `status` (énum locale `none | trialing | active | past_due | unpaid |
  canceled | incomplete`), `current_period_end` (timestamptz, nullable),
  `last_event_created` (timestamptz — horodatage Stripe du dernier événement
  appliqué, garde anti-réordonnancement), `created_at`, `updated_at`.
  Mapping statuts Stripe → énum locale : `incomplete_expired` → `canceled`,
  `paused` → `unpaid` (conservateur : bloque), autres identiques.
- **`billing_usage_reports`** : `tenant_id` (FK), `day` (date), `count`
  (int ≥ 0), `reported_at` ; **unique `(tenant_id, day)`** — idempotence du
  report, rejouable sans double-facturation.
- Suppression de tenant : lignes billing conservées (historique comptable)
  — FK sans cascade destructive.

## 4. Module `billing` (apps/api) — motif port (6e port du projet)

**`BillingPort`** : `createCheckoutSession(customerRef, urls)`,
`createPortalSession(customerRef, returnUrl)`, `ensureCustomer(tenantMeta)`,
`reportUsage(events[])`, `constructWebhookEvent(rawBody, signature)`.

Drivers (factory sur `BILLING_DRIVER`, throw exhaustif comme les autres
factories) :
- **`stripe`** : SDK officiel `stripe` (dernière stable), clé `STRIPE_SECRET_KEY`.
- **`fake`** : en mémoire, déterministe — tests unit/e2e et dev interactif.
- **`none`** (défaut dev) : endpoints checkout/portal → 503 explicite
  « billing désactivé », statut `none`, **garde inconditionnellement
  inactif** (précédence : `BILLING_DRIVER=none` neutralise le garde même si
  `BILLING_ENFORCEMENT=on` — activer l'enforcement sans driver bloquerait
  tous les tenants). La plateforme reste entièrement testable sans compte
  Stripe.

**Endpoints** (session + CSRF, rôles `owner|admin` ; PAS de dual-auth — les
7 mutations dual-auth verrouillées ne sont pas touchées, le verrou
dual-auth-composition reste intact) :
- `POST /billing/checkout-session` → `ensureCustomer` (metadata
  `tenant_id`, SIREN) puis URL de session Checkout (mode subscription, les
  deux Prices). Success/cancel URLs → dashboard.
- `POST /billing/portal-session` → URL du Customer Portal.
- `GET /billing/status` → lecture du miroir (dashboard) : `{ status,
  currentPeriodEnd, hasCustomer }`.
- `POST /billing/webhook` → **hors auth session/CSRF** (authentification =
  signature Stripe sur le **raw body** ; NestJS rawBody activé pour cette
  route), hors rate-limit IP. Réponses : 400 signature invalide (sans
  détail), 200 pour tout événement traité ou ignoré (contrat Stripe).

**Webhooks consommés** : `checkout.session.completed`,
`customer.subscription.created|updated|deleted`, `invoice.paid`,
`invoice.payment_failed`. Traitement : résolution du tenant par
`stripe_customer_id` → upsert du miroir **ssi `event.created` >
`last_event_created`** (rejet silencieux des événements en retard).
Customer inconnu → 200 + log warn (événement d'un autre environnement).

## 5. Garde d'émission (`BillingGuard`)

- S'applique aux mutations d'**émission** uniquement : `POST /invoices`
  (dépôt) et création de soumissions e-reporting. **Jamais** : lectures,
  exports, transitions de statut CDV, annuaire, auth, endpoints billing.
- Décision sur le **miroir local** (zéro appel réseau) : autorise
  `active | trialing | past_due` (grâce dunning) ; bloque
  `none | unpaid | canceled | incomplete` → **402 Payment Required**,
  problem-details type dédié `urn:factelec:problem:subscription-required`.
- **`BILLING_ENFORCEMENT`** (`off` par défaut) : à `off`, le garde évalue et
  log (observabilité) mais laisse passer — activation explicite au go-live
  commercial. Zéro régression tant que non activé.

## 6. Report d'usage (worker BullMQ)

Job répétable quotidien (process worker existant) : pour chaque tenant
abonné, compte les documents de la **veille en UTC** (`day` = date UTC ;
frontière 00:00 UTC, même convention que les horodatages du journal),
requêtes d'agrégation sur les tables existantes factures/e-reporting,
insère `billing_usage_reports`
(`ON CONFLICT DO NOTHING`), puis pousse les Meter Events Stripe pour les
lignes non encore reportées (`reported_at` null → set après succès). Rejeu
et crash-safe : la clé unique par jour garantit l'absence de double
facturation ; un échec Stripe laisse `reported_at` null → repris au run
suivant. Tests de ce job sous le régime **heavy-suites** (verrou actif).

## 7. Dashboard (apps/web)

Page « Abonnement » (owner/admin) : statut courant + date de fin de période,
bouton « S'abonner » (statut `none`/`canceled` → redirection Checkout) ou
« Gérer mon abonnement » (→ Portal), bannière d'avertissement si `past_due`
ou bloqué. Aucun composant de paiement embarqué.

## 8. Erreurs & cas limites

- Signature webhook invalide → 400 sans corps détaillé (pas de fuite).
- Événement Stripe de type non consommé → 200 ignoré.
- Indisponibilité Stripe : checkout/portal → 503 problem-details ; le garde
  et l'émission ne dépendent jamais de la disponibilité Stripe.
- Webhooks dupliqués/hors ordre : neutralisés par `last_event_created` +
  upsert d'état (idempotence par valeur, pas par event.id — pas de table
  d'événements à purger).
- Tenant supprimé : ligne billing conservée.

## 9. Tests (gates inchangées : >90 %, TDD, audit 0, outdated vierge)

- **Unit** : services (checkout/portal/status), matrice du garde
  (statuts × enforcement on/off × routes), mapping webhook→miroir (y compris
  hors-ordre, customer inconnu, statuts exotiques `incomplete_expired`/
  `paused`), factory drivers (throw exhaustif), port fake.
- **E2E** (Testcontainers, driver fake) : cycle complet — checkout simulé →
  webhook signé (helper de signature du SDK Stripe, zéro réseau) → miroir →
  garde bloque puis débloque ; RLS de `tenant_billing` (cross-tenant 404/0
  ligne) ; idempotence de `billing_usage_reports` ; 402 problem-details.
- **Hors CI** : smoke manuel `stripe listen` avec les clés de test de
  Xavier, à réception.

## 10. Configuration

| Variable | Défaut | Rôle |
|---|---|---|
| `BILLING_DRIVER` | `none` | `stripe` / `fake` / `none` |
| `BILLING_ENFORCEMENT` | `off` | `on` = le garde bloque réellement |
| `STRIPE_SECRET_KEY` | — | clé secrète (test puis live) |
| `STRIPE_WEBHOOK_SECRET` | — | signature du endpoint webhook |
| `STRIPE_PRICE_BASE` | — | Price abonnement 29 € HT |
| `STRIPE_PRICE_METERED` | — | Price gradué 0 €/0,20 € HT |
| `BILLING_DASHBOARD_URL` | dérivé CORS | success/cancel/return URLs |

## 11. Dépendances & prérequis

- Item Xavier : création du compte Stripe + clés de **test** (`sk_test_…`,
  `whsec_…`) — nécessaires seulement pour le smoke manuel et le bootstrap
  sandbox ; tout le développement et la CI passent par le driver `fake`.
- Nouvelle dépendance npm : `stripe` (SDK officiel, dernière stable —
  gate outdated vierge).

## Amendement A1 (2026-07-19, post-revue finale de branche — arbitrage Xavier)

Le principe « l'événement Stripe est l'état complet, pas un patch partiel »
(§ Modèle de données / applyEvent) est **amendé pour le seul champ
`currentPeriodEnd`** : un événement qui ne PORTE pas la notion de période
(`checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`)
transmet désormais `undefined` (« non porté ») et **préserve** la valeur du
miroir ; `null` explicite (porté par un `customer.subscription.*` sans
période) continue d'effacer. Motivation : revue finale I1 — l'écrasement à
null rendait `currentPeriodEnd` intermittent/null en production. S'y
ajoutent : lecture de la période via `items.data[].current_period_end`
(le champ top-level a disparu des API Stripe récentes) et CAS assoupli à
`<=` sur `last_event_created` (les événements de la même seconde ne sont
plus rejetés — le couple checkout+subscription.created arrive dans la même
seconde et le second portait la période).
