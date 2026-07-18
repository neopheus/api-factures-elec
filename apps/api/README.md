# `@factelec/api`

API REST NestJS d'ingestion et de lecture des factures électroniques
(phase **1.3**), étendue en **1.4** avec l'authentification utilisateur
(sessions httpOnly + CSRF), le signup self-service transactionnel, la
gestion des clés API par session et un super admin plateforme minimal, puis
en **2.1** avec des **workers BullMQ** (génération asynchrone des formats)
et le **cycle de vie des statuts CDV** (nomenclature DGFiP, machine à états,
journal d'événements append-only), puis en **2.2** avec le **scellement
cryptographique** du journal `invoice_status_events` (chaîne SHA-256 par
tenant **imposée par la base**, non contournable par l'application), la
**vérification d'intégrité** indépendante (recompute TypeScript pur), l'
**archivage à valeur probante** (port `ArchiveStore` write-once + implémentation
locale testable, adaptateur S3 object-lock différé au déploiement), l'export de
la **Piste d'Audit Fiable (PAF)** et le **DLQ** des factures « poison », puis
en **2.3** avec l'**e-reporting DGFiP (Flux 10)** — transmission au PPF de
**données d'opérations** (agrégats), **distincte** de l'e-invoicing ci-dessus :
sous-flux **10.3 (B2C domestique) livré de bout en bout**, machine à états
**300/301** propre (distincte du CDV), cadence par régime TVA, port de
transmission différé au déploiement, puis en **2.4** avec l'**annuaire
central (Flux 13/14)** — le registre **hébergé par le PPF** qui adresse/route
les factures électroniques ; livrable pré-immatriculation = **domaine PA**
(socle) : ligne d'adressage (4 mailles, validité semi-ouverte
`[début, fin)`, résolution la plus spécifique d'abord), génération Flux 13 /
parsing Flux 14 **tous deux validés XSD** contre les schémas DGFiP réels,
miroir de consultation tenant-scopé **PII-minimal**, publication
**consent-gated** (422) avec gestion de slot (409 + libération), acquittements
PPF et synchronisation **bornée** (différentiel quotidien / complet
hebdomadaire, avec sweep de reprise des publications figées). Adaptateurs de
transport réels et câblage dans l'émetteur de factures différés au
déploiement, puis en **3.1** avec la **transmission des CDV (message de
statut Flux 6/CDAR)** et le **remplacement de la matrice de transitions du
cycle de vie facture** : la matrice **monotone** 2.1 (bloqueur go-live
documenté) est remplacée par une **matrice DAG data-driven** corrigeant les 4
anomalies mandatées, **paramétrée** pour absorber la norme **AFNOR
XP Z12-012** (payante, hors dépôt — achat Xavier) sans toucher au reste du
code — le bloqueur devient une **interprétation en attente d'AFNOR**, plus
une matrice **fausse**. Le Flux 6 est généré au format **CDAR** (UN/CEFACT
SCRDM CI, aucun XSD DGFiP disponible → **validation structurelle** honnête,
posture PAF) et transmis vers **deux cibles indépendantes** (PPF réglementaire
+ plateforme de réception résolue par l'annuaire 2.4), sous un délai **24h**
borné par un ordonnanceur BullMQ (fenêtre de rattrapage 48h), avec une machine
de livraison **distincte** du CDV facture (`prepared → transmitted →
{acknowledged, rejected(601)}`, `parked` retryable) et une **frontière
d'acquittement** dédiée. Adhésion **OpenPeppol** + PKI + SMP + stack AS4 et
adaptateurs de transport réels (sftp/as2/as4/as4-peppol/api) différés au
déploiement, puis en **3.2** avec la **ventilation biens/services** et les
**paiements TB-3 (Flux 10)** : discriminant `nature` optionnel au niveau
ligne dans `@factelec/invoice-core` (**0.4.0**, rétro-compat sans migration),
ventilation **réelle** (total conservé, résidu ≤ 1 centime absorbé côté
services) des cadres de facturation **mixtes** M1/M2/M4 pour les factures
**naturées**, activation du **10.1 B2Bi par facture** (TG-8, misrouting
export B2C résolu), **capture des encaissements** (idempotente, intégrité
anti-taux-inconnu/anti-sur-encaissement) et **agrégation/transmission**
TB-3 (10.2 per-facture / 10.4 agrégé) selon la règle **SERVICES-ONLY**
(note 119, autoliquidation et option débits exclues), sur une **2ᵉ cadence
de transmission dédiée** (le Tableau 13 distingue paiements et
transactions pour le régime réel normal mensuel) et un ordonnanceur à 3
couches étendu (`flux_kind='payments'`), puis en **3.3** avec la **couture
du routage destinataire à l'émission** (D1/D2/D4 — résolution annuaire
câblée dans le **worker de génération**, best-effort **strict** jamais
throw, métadonnée de routage **mutable** `routing_status`/
`recipient_platform` sur `invoices`, **sans jamais muter le cycle de vie CDV
scellé**), l'**énumération des codes-routage publiés par le tenant**
(`GET /annuaire/codes-routage`, D6, POST autonome refusé) et des
**durcissements transversaux 100 % code-interne** (validation UUID
harmonisée en 404 anti-fuite byte-identique sur 8 routes, erreurs CAS
typées `CasStaleError`, verrou d'architecture — un **ralentisseur**, pas une
barrière — sur le footgun `apiKeyId`, stabilisation e2e par split Vitest
`heavy`/`light`) — voir §§ Couture annuaire → émission / Durcissements
transverses ci-dessous, puis en **3.4** avec la **reprise & retransmission**
(chemin RE opérateur `POST /ereporting/retransmissions`, dual-auth,
retry-idempotent 3 couches, débloquant **conditionnellement** le deadlock du
slot IN né-`rejetee` de 2.3 ; sweep de reprise du routage destinataire
`pending`/`unaddressable`, `ambiguous` exclu ; filtre de liste
`routingStatus`), puis en **3.5** avec le **scellement structurel du
consentement annuaire** (`ConsentSignaturePort`, 5ᵉ instance du motif port —
intégrité sha256 + horodatage + write-once WORM, **aucune** signature
qualifiée, fournisseurs eIDAS réels différés), le rôle Postgres
**`factelec_worker`** de moindre privilège (grants dérivés de l'inventaire
réel du process worker, pool/env dédiés `DATABASE_URL_WORKER`, provisioning
prod différé) et l'**endpoint de re-résolution manuelle d'un routage
`ambiguous`** (`POST /invoices/:id/routing/resolve`, dual-auth, solde
F-2/3.4) — voir § Consentement scellé, rôle worker & re-résolution
ambiguous — 3.5 ci-dessous, puis en **3.6** avec la **révocation de
consentement annuaire** (`POST /annuaire/consents/:id/revoke`, 7ᵉ mutation
dual-auth, écriture `revoked_at` CAS write-once idempotente, 404
anti-fuite, rapport anti-silence `dependentActiveLignes`) : **révocation-
seule**, ancrée à la source primaire (§3.5.5.5 note 85) — bloque **toute
publication neuve** adossée au consentement révoqué (gate existant, non
régression prouvée sur les deux chemins) mais **ne rétracte pas**
automatiquement l'adressage déjà publié (`maskLigne` ne transmet rien au
PPF/miroir — une cascade aurait fabriqué une rétractation), le miroir de
consultation **continuant de router** les tiers vers la plateforme pour les
mailles déjà consolidées jusqu'à l'actualisation opérateur (procédure
§3.5.5.5 note 85, transmission Flux 13 réelle différée) — voir §
Révocation de consentement — 3.6 ci-dessous. Consomme
`@factelec/invoice-core` (validation, calculs, génération des formats du socle)
et expose l'ensemble derrière une couche d'authentification et d'isolation
multi-tenant Postgres.

> **Dettes 1.3 soldées** (plan 1.4, task 1) : `createDb` (piège hors-tenant,
> jamais appelé en production) retiré de `src/db/client.ts` ; `DATABASE_URL`
> migré de `z.string().url()` (déprécié) vers `z.url()` (zod 4). Aucun
> changement de comportement — refactor mécanique couvert par la suite
> existante.
>
> **Dettes 1.3/1.4 soldées** (plan 2.1, task 7) : `last_used_at` (table
> `api_keys`) est désormais écrit à chaque authentification réussie, depuis
> `authenticate_api_key` (seule fonction `SECURITY DEFINER` exécutée avant le
> contexte tenant — cf. §Architecture workers/Sécurité) ; la purge des
> sessions expirées tourne en job BullMQ répétable côté worker
> (`SessionPurgeScheduler` → `purge_expired_sessions()`, également
> `SECURITY DEFINER`, table `sessions` deny-all pour `factelec_app`).
>
> **Dette 2.1 soldée** (plan 2.2, task 1) : la FK `invoice_status_events.invoice_id
> → invoices.id`, en `ON DELETE CASCADE` depuis 2.1, est passée en
> **`ON DELETE RESTRICT`** — un journal à valeur probante ne doit plus pouvoir
> disparaître avec la suppression de sa facture (la base refuse, `23503`).
>
> **Dette opérationnelle 2.1 soldée** (plan 2.2, task 8) : le ré-enfilement
> par la réconciliation auto-cicatrisante est désormais **borné**
> (`GENERATION_MAX_ATTEMPTS_CAP`) — une facture « poison » (crash récurrent
> avant l'écriture d'un statut `failed` définitif) est déversée dans une
> **DLQ** (`invoice_dead_letters`, append-only) plutôt que ré-enfilée
> indéfiniment. Voir § DLQ / cap de réconciliation ci-dessous.

## Architecture & compromis

- **ESM pur + NestJS 11**, avec une chaîne de build volontairement scindée en
  trois outils :
  - **Émission JS** : [SWC](https://swc.rs/) (`.swcrc` — `legacyDecorator` +
    `decoratorMetadata`, cible `es2022`, module `es6`/NodeNext). SWC produit le
    JavaScript exécuté en dev (`pnpm dev`), en build (`pnpm build` → `dist/`)
    et transforme les tests.
  - **Typecheck** : `tsc --noEmit` via **tsgo 7.0.2** (paquet `typescript`
    racine, pin exact, partagé avec `invoice-core`), `experimentalDecorators`
    + `emitDecoratorMetadata` activés dans `apps/api/tsconfig.json`.
  - **Tests** : Vitest 4 via `unplugin-swc` (même moteur de transformation que
    le build, pas un second compilateur).
  - `reflect-metadata` est importé en tout premier dans `main.ts` et dans
    `tests/setup.ts` (requis par l'injection de dépendances par type de
    NestJS, `design:paramtypes`).
  - **Résultat réel du typecheck tsgo (point de risque n°1 du plan)** :
    **PASSÉ nativement, aucun repli nécessaire.** `tsc --noEmit` type-checke
    tous les décorateurs NestJS (`@Module`, `@Controller`, `@Injectable`,
    `@Get`/`@Post`, etc.) sans erreur sous tsgo 7.0.2, avec une exécution
    rapide (< 1 s sur le socle, pas de ralentissement notable observé sur
    l'ensemble du code livré). Vérifié empiriquement par injection volontaire
    d'une erreur de type (détectée puis revertie). Le repli documenté par le
    plan — pin `typescript@5.9.x` local à `apps/api` uniquement, sans toucher
    le pin racine `7.0.2` d'`invoice-core` — n'a **jamais été activé** et
    reste une option si une version future de tsgo régressait sur un
    décorateur NestJS particulier.
- **Génération asynchrone (2.1).** La génération des formats (UBL, CII,
  Factur-X, extraits de flux) est effectuée **par un worker BullMQ dédié**,
  hors de la requête HTTP d'ingestion — voir [§ Architecture
  workers](#architecture-workers) pour l'architecture complète (producteur/
  consommateur, idempotence, retries, réconciliation). **Écart assumé par
  rapport au plan initial (D2)** : le worker vit dans `apps/api`
  (`src/worker-main.ts`, second point d'entrée du même workspace, processus
  séparé au runtime) plutôt que dans un workspace `apps/worker` dédié —
  aucun bénéfice d'isolation supplémentaire à ce stade (même image de
  déploiement, mêmes dépendances), la séparation de workspace reste une
  option ouverte si le worker devait un jour diverger fortement de l'API en
  dépendances ou en cadence de déploiement.

## Architecture workers

**Producteur / consommateur**, séparés par une file BullMQ (Redis) :

- **Producteur** — le process API (`src/main.ts`). `POST /invoices` valide,
  persiste la facture (statut `received`) et **enfile** un job minimal sur la
  file `invoice-generation` via le port `InvoiceGenerationQueue`
  (`src/queue/invoice-generation.queue.ts`) — connexion BullMQ **paresseuse**
  côté producteur (`skipWaitingForReady`/`skipVersionCheck`, `QueueModule`) :
  aucune connexion Redis réelle n'est ouverte au montage du module, sauf
  usage effectif (enfilement, sonde readiness).
- **Consommateur** — `src/worker-main.ts`, **processus séparé** (`pnpm
  start:worker` en prod, `pnpm worker:dev` en watch mode), qui monte
  `WorkerModule` (jamais importé par l'API HTTP). Connexion BullMQ **eager**
  côté worker (`WorkerQueueModule` distinct de `QueueModule` — un worker doit
  échouer/crash-loop au démarrage si Redis est injoignable, pas tourner
  silencieusement sans consommer). `InvoiceGenerationProcessor`
  (`src/worker/invoice-generation.processor.ts`) charge la facture
  canonique, appelle `InvoiceFormatGenerator` (même port qu'en 1.3/1.4 —
  génération désormais exécutée **côté worker**, plus dans la requête HTTP),
  puis persiste les formats.

**Payload minimal (ids only).** Le job ne transporte que
`{ tenantId, invoiceId }` (`InvoiceGenerationJob`) — **aucun contenu de
facture ni format généré ne transite par Redis** ; le worker recharge la
facture canonique depuis Postgres avant de générer.

**Idempotence.** `jobId = invoiceId` : un ré-enfilement du même
`invoiceId` (retry BullMQ, réconciliation) ne crée jamais de doublon de job
en file. Côté persistance, `InvoicesRepository.completeGeneration` exécute
**delete + insert** des formats et le passage à `generated` dans **une seule
transaction tenant** : un retraitement complet (après crash, reconciliation)
remplace intégralement les formats précédents plutôt que de les dupliquer.

**Retries / backoff.** `GENERATION_JOB_ATTEMPTS` tentatives (défaut 3),
backoff exponentiel (1 s de base) — politique définie une seule fois
(`invoice-generation.job-options.ts`) et **partagée** entre le producteur
(enfilement initial) et le worker (re-enfilement par la réconciliation), pour
qu'un job rejoué hérite toujours de la même politique. `failed` n'est écrit
en base **qu'après épuisement** des tentatives (`OnWorkerEvent('failed')`,
compare `job.attemptsMade` à `job.opts.attempts`) — un retry en cours ne
repositionne jamais un statut `failed` prématuré.

**Rétention.** `removeOnComplete` (24 h / 1000 jobs), `removeOnFail` (7
jours) — les jobs terminés (succès ou échec définitif) ne s'accumulent pas
indéfiniment dans Redis.

**Réconciliation auto-cicatrisante** (`InvoiceReconciliationService`,
balayage périodique côté worker, file `maintenance`) : comble deux trous
structurels qu'aucun retry BullMQ ne couvre —
1. facture `received` **jamais enfilée** (l'enfilement Redis a pu échouer
   *après* le commit Postgres de l'ingestion — l'API n'a alors aucun moyen
   de le savoir de façon synchrone) : au-delà de `RECONCILIATION_STALE_MS`
   (défaut 5 min), la facture est considérée orpheline et re-enfilée ;
2. facture bloquée en `generating` (le worker a été tué — `SIGTERM`,
   OOM — exactement entre le marquage `generating` et la transaction
   `completeGeneration`, hors de toute couverture retry puisque le job
   BullMQ correspondant a pu être marqué `failed` et évincé de Redis par
   `removeOnFail`) : au-delà de `RECONCILIATION_GENERATING_STALE_MS`
   (défaut 15 min, délibérément plus large que le seuil `received` — une
   génération légitime ne dure jamais 15 minutes), re-enfilée à son tour.

Le balayage évince aussi les jobs `failed` déjà épuisés de la file avant
réenfilement (`getJobSchedulers`/eviction, cf. commentaires
`invoice-reconciliation.service.ts`). **Fenêtre résiduelle documentée, non
couverte** : un `SIGTERM` du worker frappant exactement entre le marquage
`generating` et `completeGeneration` laisse la facture bloquée jusqu'au
prochain balayage — bornée à `RECONCILIATION_GENERATING_STALE_MS` (~15 min
par défaut), jamais indéfiniment, mais pas instantanée. Aucune stratégie de
verrou distribué n'a été mise en place pour fermer cette fenêtre à zéro
(compromis assumé : complexité vs. gain sur un cas déjà borné et rare).

**Rôle Postgres du worker (D6 → révisé 3.5).** Jusqu'en 3.4, le worker
partageait `factelec_app` (`DATABASE_URL`) avec le process API — aucun
privilège différencié. **Depuis 3.5**, `WorkerModule` importe
inconditionnellement `DbModule.forRoot('DATABASE_URL_WORKER')`
(`src/worker/worker.module.ts`) : le worker tourne sous le rôle dédié de
moindre privilège **`factelec_worker`**, jamais `factelec_owner` ni
`factelec_app`. Voir § Consentement scellé, rôle worker & re-résolution
ambiguous — 3.5 pour le détail des grants, la preuve d'isolation et le
runbook de provisioning.

## Nouvelle sémantique `POST /invoices`

**Changement de contrat** vis-à-vis de 1.3/1.4 (assumé, D1) : `POST
/invoices` répond désormais `201 { id, status: 'received' }` — la génération
des formats n'est **plus** synchrone avec la réponse HTTP. Le suivi se fait
via `GET /invoices/:id` (`status` : `received → generating → generated`,
ou `failed` après épuisement des tentatives) ; les formats
(`GET /invoices/:id/formats/:format`) ne sont disponibles qu'une fois
`status = 'generated'` (404 sinon, comme pour une facture inconnue — aucune
distinction observable entre « pas encore généré » et « n'existe pas », par
cohérence avec le reste de l'API qui ne renvoie jamais d'état interne
explicite sur une ressource non accessible).

## Cycle de vie CDV

Deux axes de statut **distincts**, à ne jamais confondre :

- **`status`** (colonne `invoice_status`, décrit ci-dessus) : statut
  **technique** de génération des formats (`received`/`generating`/
  `generated`/`failed`), piloté par le worker, sans intervention humaine.
- **`lifecycle_status`** (colonne `invoice_lifecycle_status`) : statut
  **métier/réglementaire** du cycle de vie de la facture (CDV — Cadre de
  facturation électronique), piloté par des transitions explicites (API ou,
  plus tard, apposition automatique par la plateforme/le réseau Peppol).

**Nomenclature DGFiP** — 14 statuts (codes 200-213, source Dossier général
v3.2 §3.6.4 Tableau 8 + Annexe 7 règle G7.44 pour le socle obligatoire
`{200 Déposée, 210 Refusée, 212 Encaissée, 213 Rejetée}`) ; les 10 statuts
restants sont facultatifs (`emise`/`recue`/
`mise_a_disposition`/`prise_en_charge`/`approuvee`/
`approuvee_partiellement`/`en_litige`/`suspendue`/`completee`/
`paiement_transmis`). Chaque facture démarre à `deposee` (200, **obligatoire**)
à l'ingestion (événement initial inscrit dans le journal, cf. ci-dessous).

**Machine à états — matrice DAG data-driven** (`src/invoices/lifecycle-status.ts`,
**remplace en 3.1** la chronologie monotone de 2.1) : une transition
`from → to` n'est valide que si l'arête `to` figure dans
`ALLOWED_TRANSITIONS[from]` (`Record<LifecycleStatus, LifecycleStatus[]>`,
paramétrée — le reste du code, `LifecycleService`/`InvoicesController`/…,
n'appelle jamais que `canTransition`/`requiresReason`, jamais la table
directement) ; motif (`reason`) **obligatoire** pour `refusee`/`suspendue`
(règle G7.25) ; terminaux : `refusee` (210), `encaissee` (212) et `rejetee`
(213) — aucune transition sortante, y compris entre eux.

**4 anomalies mandatées, corrigées contre le modèle monotone 2.1** (ledger
2.1, appliquées à la table ci-dessus) :
- **`212 Encaissée → 213 Rejetée` INTERDIT** (`encaissee` rendu terminal —
  CGI art. 290 A : une facture encaissée n'est plus rejetable) — le monotone
  l'autorisait à tort (code strictement croissant).
- **`207 En litige → 205 Approuvée` AUTORISÉ** (dispute résolue) — le
  monotone le refusait (205 < 207).
- **`208 Suspendue → 204 Prise en charge` AUTORISÉ** (reprise
  post-suspension) — le monotone le refusait (204 < 208).
- **`206 Approuvée partiellement → 205 Approuvée` AUTORISÉ** (complétion) —
  le monotone le refusait (205 < 206).

> ⚠️ **INTERPRÉTATION PROJET — la table ENTIÈRE, en attente d'AFNOR
> XP Z12-012.** La DGFiP ne publie, dans le Dossier général, aucune matrice
> de transitions autorisées (les figures 48/49 du circuit de transmission
> sont purement graphiques, non extractibles en règles machine) — seule la
> contrainte « respect de la chronologie » (G7.19/G7.25/G7.45) est
> documentée, complétée par les 4 corrections mandatées ci-dessus (ledger
> 2.1). La norme qui énumère formellement ces transitions — **AFNOR
> XP Z12-012** — est **payante et hors dépôt** (**item Xavier : achat
> requis** avant tout passage en production réelle). La table est
> **paramétrée** précisément pour que ce remplacement futur ne touche QUE
> `ALLOWED_TRANSITIONS` + `REASON_REQUIRED` + les vecteurs de test — aucun
> autre fichier consommateur. **Amendement A3 (revue plan 3.1, binding) :**
> `encaissee` est rendu **entièrement** terminal (aucune arête sortante,
> pas seulement `¬(212→213)`) — un **sur-ensemble** du mandat dur, défendable
> (CGI 290 A ; aucune source publique n'ancre de transition sortante de 212)
> mais **plus strict que l'exigence mandatée**, donc **révisable** à
> l'acquisition d'AFNOR. **Le remplacement du monotone par ce DAG NE
> TOUCHE PAS au journal scellé (2.2)** : `verifyTenantChain` ne re-valide
> jamais les transitions historiques (seul le hash-chain est vérifié) — les
> lignes déjà inscrites sous l'ancienne matrice monotone restent
> intégralement valides après le swap ; seul le **garde de service** change
> pour les futures transitions. **Filet anti-régression indépendant** : les
> tests de complétude (14×14 arêtes) comparent `ALLOWED_TRANSITIONS` à un
> littéral `EXPECTED_TRANSITIONS` retranscrit à la main du plan — **pas** à
> lui-même — pour qu'une future erreur de retranscription AFNOR (typo de
> table) reste détectable plutôt que de valider silencieusement contre son
> propre sujet.

**Endpoints** :

- `POST /invoices/:id/status` — transition (`{ toStatus, reason? }`), session
  **owner/admin/accountant** + CSRF (jamais clé API : l'apposition
  automatique par un connecteur/la plateforme est différée, phase 3).
  **CAS anti-race** : l'`UPDATE` conditionne sur le statut courant lu juste
  avant (`WHERE lifecycle_status = from`) — 0 ligne affectée ⇒ **409**
  (changement concurrent, à réessayer) plutôt qu'un écrasement silencieux.
  **422** si la transition est invalide (chronologie) ou si `reason` manque
  alors que requis.
- `GET /invoices/:id/status` — statut courant + historique complet, dual-auth
  (clé API ou session du même tenant, comme la lecture des factures).

**Journal `invoice_status_events`** — append-only : la table n'accorde que
`SELECT`/`INSERT` à `factelec_app` (aucun `UPDATE`/`DELETE` — immuabilité
garantie par les grants Postgres, pas seulement par convention applicative).
L'événement initial (`fromStatus: null → toStatus: 'deposee'`, `actor:
'platform'`) est inscrit à l'ingestion, dans la même transaction que
l'insertion de la facture (`InvoicesRepository.insertReceived`) ; chaque
transition ultérieure inscrit `{fromStatus, toStatus, actor, reason,
createdAt}` dans la **même transaction** que la mise à jour
`lifecycle_status` (`InvoicesRepository.recordTransition`). Ce journal,
livré append-only en 2.1 (immuabilité par grants), est **scellé
cryptographiquement depuis 2.2** — voir § Scellement et vérification
d'intégrité ci-dessous.

## Scellement et vérification d'intégrité du journal (2.2)

Le journal `invoice_status_events` est **scellé** par une chaîne SHA-256
**par tenant**, calculée et **imposée par la base** — l'application ne peut
ni la fournir ni la modifier.

### Scellement (imposé côté base)

- **Trigger `BEFORE INSERT`** (`seal_status_event`, `SECURITY DEFINER`,
  propriété du rôle **propriétaire**, `search_path` épinglé à `pg_catalog,
  pg_temp` avec objets applicatifs schéma-qualifiés — défense en profondeur
  contre un shadowing d'objet, cf. commentaires migration `0012`) : sous
  **`pg_advisory_xact_lock`** par tenant (sérialise les insertions d'un même
  tenant sans bloquer les autres, verrou transactionnel), il calcule pour
  chaque événement un `seq` **monotone par tenant** (1, 2, 3…), le
  `prev_hash` (tête de chaîne courante, ou **genesis dérivé** du tenant —
  `SHA-256('factelec:ledger:genesis:v1:' || tenant_id)` — pour le premier
  événement), et `hash = SHA-256(prev_hash ‖ payload canonique)` via
  **`pgcrypto.digest`** (extension créée en migration `0010`, `CREATE
  EXTENSION IF NOT EXISTS pgcrypto`).
- **Canonicalisation longueur-préfixée** (injection-proof) : chaque champ
  (`tenant_id, invoice_id, seq, from_status, to_status, actor, reason,
  created_at_ms`, ordre figé) est encodé `octet_length‖'|'‖valeur` (`-1|` si
  `NULL`) — non ambigu même si `reason` (texte libre) contient `|` ou des
  sauts de ligne. La fonction PL/pgSQL `ledger_field` (migration `0012`) est
  le **miroir exact, à l'octet près**, du module TypeScript pur
  `src/ledger/ledger-hash.ts` (`canonicalizeStatusEvent`/`computeEventHash`) —
  vecteurs de test déterministes constants + test croisé DB↔Node prouvant
  l'égalité des deux implémentations pour un même événement.
- **Immuabilité inchangée** : `factelec_app` ne détient que `SELECT`+`INSERT`
  sur `invoice_status_events` (jamais `UPDATE`/`DELETE`, migration `0008`) et
  **ne possède pas** les colonnes `seq`/`prev_hash`/`hash` — le trigger les
  écrase systématiquement, même si le client tente de les fournir.

### Vérification d'intégrité — `GET /invoices/:id/ledger`

`LedgerVerificationService` recompute la chaîne **côté Node**, indépendamment
du trigger DB, et expose deux vérifications complémentaires :

- **`integrity`** (`verifyInvoiceEvents`) — self-check par facture : chaque
  événement de la facture est recalculé à partir de son `prev_hash` stocké et
  comparé au `hash` stocké.
- **`chainIntegrity`** (`verifyTenantChain`) — chaîne **complète** du tenant :
  genesis, contiguïté du `seq`, linkage `prev_hash`, `hash` — seule à révéler
  la suppression d'un maillon **intermédiaire**, invisible au self-check
  par-facture (chaque événement restant s'auto-vérifie contre son propre
  `prev_hash`, intact).

#### Limites de détection — honnêteté probatoire (lecture obligatoire)

Le scellement est une **tamper-evidence** contre l'édition, la suppression ou
l'insertion **partielle** d'événements (détectées par `verifyTenantChain` :
contiguïté `seq` + linkage `prev_hash` + genesis), renforcée par l'immuabilité
applicative (grants `SELECT`+`INSERT`, `42501`) et l'archivage WORM. **Ce
n'est pas une inviolabilité de la chaîne live** : un accès propriétaire
(`BYPASSRLS`, hors périmètre RLS) peut :

1. **TRONQUER la queue de chaîne** — supprimer le **dernier** maillon (ou les
   N derniers) laisse la chaîne `1..n-1` (ou `1..n-N`) parfaitement valide :
   `verifyTenantChain` ne voit rien d'anormal, la chaîne restante est
   cohérente de bout en bout.
2. **RÉÉCRIRE intégralement et de façon cohérente** toute la chaîne — le
   genesis est **dérivé publiquement** du `tenant_id` (recalculable par
   quiconque connaît la formule) : un accès direct-DB peut, en théorie,
   régénérer une chaîne entièrement différente mais interne-cohérente.

Ces deux modes sont **intrinsèques à tout hash-chain auto-contenu** (une
chaîne de hash n'est pas un MAC : elle prouve la cohérence interne d'une
séquence, pas qu'elle n'a pas été remplacée dans son ensemble par un accès
disposant des mêmes privilèges que celui qui l'a écrite). Ils ne sont
détectables **que par l'ancrage de tête** (le `seq` maximum et le `hash` de
tête, à un instant donné) dans le **bundle d'archive WORM externe** — ancrage
effectif uniquement une fois l'adaptateur S3 object-lock **activé au
déploiement** (`ARCHIVE_DRIVER=s3`, non fourni en 2.2, voir § Archivage). Tant
que cet adaptateur n'est pas branché, l'archive locale (write-once
applicatif) ne constitue **pas** un ancrage de tête indépendant du même
serveur Postgres.

## Archivage à valeur probante (WORM)

- **Port `ArchiveStore`** (`src/archive/archive-store.port.ts`) — contrat
  `put`/`head`/`get`, sémantique **write-once** : `put` ne réécrit **jamais**
  une clé existante (idempotent — un rejeu retombe sur la clé et renvoie
  l'empreinte du contenu d'origine, `alreadyExisted: true`).
- **`LocalFilesystemArchiveStore`** (dev/test, sélectionnée par
  `ARCHIVE_DRIVER=local`, défaut) : écriture atomique (`flag: 'wx'`, échec si
  la clé existe déjà — y compris en cas de course TOCTOU concurrente),
  permissions **`chmod 0o444`** après écriture (lecture seule), empreinte
  SHA-256 vérifiée en lecture. **Ceci est une immuabilité applicative locale
  (simulacre WORM), pas un WORM matériel** : un processus disposant des
  privilèges filesystem suffisants peut toujours modifier les permissions et
  réécrire le fichier — contrairement à un véritable object-lock, qui refuse
  la modification même au propriétaire du compte cloud pendant la période de
  rétention.
- **Adaptateur S3 object-lock** (`ARCHIVE_DRIVER=s3`) — **spécifié, non fourni
  en 2.2** (`ArchiveModule` lève une erreur explicite et testée tant que le
  driver `s3` est sélectionné sans implémentation). C'est cet adaptateur
  (Scaleway Object Storage, mode `COMPLIANCE`, rétention 10 ans) qui fournit
  le **WORM matériel réel** — activation **au déploiement**, hors périmètre
  de ce plan (infra à la main de Xavier).
- **Bundle d'archive probatoire** (`src/archive/archive-bundle.ts`) : facture
  canonique + les 5 formats du socle (rechargés) + extrait scellé du journal
  de la facture (`seq`/`hash`/`prevHash` de chaque événement) + manifeste
  d'empreintes SHA-256, sérialisé à ordre de clés **figé** (octets
  déterministes, empreinte reproductible). Clé d'archive déterministe
  (`{tenantId}/{invoiceId}/...bundle`).
- **Déclenchement best-effort, découplé de la génération** (`ArchiveService`,
  appelé par le worker après `completeGeneration`) : un échec d'archivage
  n'échoue **jamais** la génération (les formats restent disponibles,
  `archive_status='failed'`), repris par un balayage de réconciliation
  (`ARCHIVE_RETRY_EVERY_MS`, réutilise la file `maintenance` 2.1 — voir
  `find_failed_archives`, migration `0015`, qui balaie aussi les `pending`
  bloqués > 15 min).
- **Statut persisté** sur `invoices` : `archive_status` (`pending` |
  `archived` | `failed`), `archive_location`, `archive_hash`.

## Piste d'Audit Fiable (PAF)

`GET /invoices/:id/paf?format=json|csv` (dual-auth, comme la lecture des
factures) exporte la chaîne d'événements scellés d'une facture, ses
vérifications d'intégrité (`integrity`, `chainIntegrity`) et son état
d'archivage.

- **Format = conception projet, non normalisée DGFiP.** Constat de
  provenance vérifié : les spécifications externes v3.2 **ne définissent
  aucun format PAF ou de scellement normalisé** — l'obligation relève du CGI
  (art. 289 bis/289 E, intégrité/authenticité), pas d'un schéma XSD/JSON
  publié par la DGFiP. Le format JSON/CSV ci-dessous est donc une
  **conception projet**, documentée comme telle, **sans prétendre à une
  conformité de schéma DGFiP**.
- **JSON** : document complet (`invoiceId`, `lifecycleStatus`, `integrity`,
  `chainIntegrity`, `archive`, `events[]` — identité probatoire
  `(tenant_id, seq)`, jamais le PK surrogate `id`).
- **CSV** (`format=csv`, `Content-Disposition: attachment`) : table des
  **événements uniquement** (`integrity`/`chainIntegrity`/`archive` restent
  des métadonnées niveau-document, portées par le JSON, jamais injectées dans
  les lignes CSV). Échappement des champs **conforme RFC 4180** (guillemets
  si le champ contient `,` `"` CR ou LF, `"` doublé) ; les fins de ligne du
  rendu sont **LF** (RFC 4180 stricte prescrit CRLF — choix assumé : les
  parseurs CSV usuels tolèrent LF, et changer le terminateur casserait des
  tests sans bénéfice pratique).
- **⚠️ Injection de formule — rendu probatoire fidèle, volontairement non
  assaini.** Le CSV reproduit **verbatim** le contenu scellé, y compris un
  `reason` (motif de transition, texte libre) commençant par `=`, `+`, `-` ou
  `@` — un tel champ, ouvert dans un tableur, peut être interprété comme une
  formule. **Ce fichier doit être ouvert comme donnée/texte, jamais exécuté
  dans un tableur** (import CSV en mode texte, pas double-clic). Un
  assainissement par défaut (préfixe `'` par ex.) **corromprait la fidélité
  probatoire** de la PAF — elle doit reproduire l'exact contenu scellé, pas
  une version modifiée pour la rendre « safe » dans un logiciel tiers.
  Volontairement **non appliqué** ; une variante « spreadsheet-safe » à la
  demande pourrait être ajoutée en option explicite si un besoin réel
  apparaît, jamais comme comportement par défaut.

## DLQ / cap de réconciliation (factures poison)

Dette opérationnelle 2.1 soldée (task 8) : le balayage de réconciliation
auto-cicatrisante (§ Architecture workers) ré-enfile désormais les factures
orphelines/bloquées avec un **compteur borné** (`reconcile_attempts`,
comparé à `GENERATION_MAX_ATTEMPTS_CAP`, défaut 5). Au-delà du cap, une
facture qui continue de crasher avant d'atteindre un statut `failed`
définitif (« poison » — p. ex. crash récurrent du worker sur cette facture
précise) est **déversée dans la DLQ** (`invoice_dead_letters`,
`InvoicesRepository.recordDeadLetter`) plutôt que ré-enfilée indéfiniment :
table **append-only** (`SELECT`+`INSERT` seulement pour `factelec_app`, RLS
`FORCE` tenant-scopée, migration `0015`), consignant `reason`, `attempts` et
l'horodatage. Sans ce cap, une facture poison boucle indéfiniment dans la
file de réconciliation (dette 2.1 tracée, désormais soldée).

## E-reporting DGFiP (Flux 10) — 2.3

Le **Flux 10** transmet au PPF (Portail Public de Facturation, DGFiP)
des **données d'opérations** agrégées — un concept **distinct** de
l'e-invoicing (Flux 1-9 ci-dessus, qui transmet des factures individuelles).
Sous-domaine `apps/api/src/ereporting/*` : nomenclatures et modèle purs
(`nomenclature.ts`, `flux10-model.ts`), génération/validation XML
(`flux10-xml.ts`, `ereporting-xsd-validator.ts`), agrégation
(`flux10-aggregate.ts`), machine à états (`ereporting-lifecycle.ts`),
persistance (`ereporting.repository.ts`), port de transmission
(`flux10-transmission.port.ts`), cadence (`period.ts`), services applicatifs
(`ereporting-generation.service.ts`, `ereporting-status.service.ts`) et
endpoints (`ereporting.controller.ts`).

### Périmètre livré et honnêteté — lecture obligatoire

**LIVRÉ de bout en bout : le sous-flux 10.3 (B2C domestique), transactions
(TB-2)**, de la classification par facture jusqu'à l'acquittement PPF et la
consultation. **Étendu en 3.2** (plan « paiements & ventilation biens/
services ») : le **10.1 (B2Bi, transactions internationales)** est désormais
**émis par facture** (TG-8, § Agrégation et classification ci-dessous) ; les
**cadres mixtes M1/M2/M4** sont **réellement ventilés** (TLB1/TPS1) pour les
factures **naturées** ; les **paiements TB-3** (10.2 per-facture / 10.4
agrégé) sont **capturés et transmis**, mais **réservés aux prestations de
services** (note 119, § Paiements ci-dessous). **DIFFÉRÉS EXPLICITES — ne pas
surpromettre « B2B international/paiements complets » :**

- **Cadres de facturation MIXTES M1/M2/M4, factures NON NATURÉES** — le
  discriminant `nature` (`'goods'`/`'services'`, plan 3.2 D1) est
  **optionnel** au niveau ligne (rétro-compat JSONB **sans migration**,
  `@factelec/invoice-core` reste en **0.4.0**) : une facture historique, ou
  dont **au moins une** ligne n'a pas de `nature`, reste **indécidable** —
  `computeVatBreakdownByNature` renvoie `complete:false` et
  `aggregateTransactions`/`aggregatePayments` la **différent** (skip typé +
  log `deferredMixed`/`deferredIncomplete`), exactement comme en 2.3 —
  **aucune ventilation partielle fabriquée**. Une période dont les seules
  factures 10.3 sont à cadre mixte non naturé part donc toujours à blanc.
- **Heuristique d'assujettissement de l'acheteur + repli export B2C→10.3 —
  INTERPRÉTATIONS, à confirmer Annexe 7 (go-live)** : `classifyEreportingOperation`
  (`flux10-aggregate.ts`) n'a **aucun** champ dédié « assujetti » dans le
  modèle `Invoice` — l'heuristique retenue (présence d'un SIREN/SIRET,
  BT-47, **ou** d'un numéro de TVA intracommunautaire, BT-48) fait primer le
  **statut d'acheteur** sur le **pays** (correction du misrouting initial) :
  un acheteur **non-assujetti** étranger (ex. particulier allemand achetant à
  un vendeur FR) est un **export B2C** → `'10.3'`, agrégé **et émis** dans le
  même bucket que le B2C domestique — **aucun sous-code export dédié**
  aujourd'hui — jamais `'10.1'`. Un acheteur **assujetti** étranger est
  `'10.1'` (B2Bi, émis PAR FACTURE, TG-8). Chaque export B2C est compté
  séparément pour l'audit go-live (`isExportB2C`, log dédié, transactions
  **et** paiements), sans effet sur les montants déclarés.
- **TB-3 (paiements) — SERVICES-ONLY, note 119 citée verbatim** (§3.7.4 du
  Dossier général v3.2, revue T7 finding A-T7-1, BINDING) : « les données de
  paiement ne doivent être transmises qu'en cas de prestations de services,
  hors opérations donnant lieu à autoliquidation de la TVA et option de TVA
  sur les débits ». La part **biens** d'un encaissement n'est **jamais**
  transmise (proratisation par taux, § Agrégation des paiements) ; une
  facture 100 % biens ne produit **aucune** opération paiement. La clause
  « hors option de TVA sur les débits » **n'a aucun champ correspondant**
  dans le modèle `Invoice` — **différée honnêtement**, aucun signal fabriqué.
- **Auto-seed du 212 (Encaissée) depuis un paiement capturé — REFUSÉ,
  décision projet** : capturer un encaissement TB-3 (`POST /payments`)
  **n'appose jamais automatiquement** la transition CDV `212 Encaissée`
  (§ Cycle de vie CDV ci-dessus) — l'événement de statut CDV `212` ne porte
  lui-même **ni montant ni taux** ; le déduire d'un encaissement
  partiel/multi-référence aurait fabriqué une équivalence non garantie par la
  spec. Les deux mécanismes restent **strictement indépendants** : une
  facture peut être `212 Encaissée` sans aucun paiement TB-3 capturé, et
  réciproquement.
- **Adaptateurs de transport réels** (`sftp`/`as2`/`as4`/`api`) — `EreportingTransmissionModule`
  lève une erreur explicite et testée tant qu'un de ces drivers est
  sélectionné sans implémentation ; seul `local` (write-once testable) est
  câblé, **transactions et paiements confondus**. Activation **au
  déploiement**.
- **Push/acquittement PPF réel** — `EreportingStatusService.recordPpfStatus`
  est la **frontière** qu'un futur adaptateur webhook/annuaire appliquera ;
  elle est exercée **directement par les e2e** (aucune route HTTP entrante
  n'existe pour recevoir un acquittement PPF push dans ce plan) — même
  frontière pour les deux `flux_kind` (transactions/paiements).
- **Schematron / contrôles sémantiques Annexe 7** — non implémentés ; seule la
  validation **structurelle** XSD est faite (voir plus bas).
- **Chemin RE (rectificatif) — RÉSOLU en 3.4** — `POST
  /ereporting/retransmissions` régénère une période sur jugement opérateur
  (§ Chemin RE ci-dessous). Reste différé : aucun automatisme post-301
  (refusé, décision projet — un rectificatif est **toujours** déclenché par
  un humain après correction des données source).
- **Provisioning des déclarants** — `EreportingRepository.upsertDeclarant`
  existe et est testé, mais **aucun endpoint HTTP ni script CLI** ne l'expose
  (contrairement à `pnpm provision:tenant`) : à ce jour, une ligne
  `ereporting_declarants` ne peut être créée qu'en insérant directement en
  base ou via un futur endpoint d'administration — non fourni dans ce plan.
- **Validation de la devise capturée** — `POST /payments` accepte tout
  `currency` non vide (`z.string().min(1)`), **jamais confrontée** à
  `invoice.currency` ni à une liste ISO 4217 ; l'intégrité anti-sur-
  encaissement compare les montants **par taux** sans tenir compte d'un
  éventuel écart de devise. Différé (revue T5, LOW-2).
- **Rôle `viewer` non testé en e2e sur `POST /payments`** — le triplet
  `owner`/`admin`/`accountant` est prouvé en e2e ; le refus d'un `viewer` est
  prouvé au niveau **unitaire** `RolesGuard` seulement (revue T5, LOW-3).

**Aucun scellement ni signature au niveau message** (contraste explicite avec
2.2) : le XSD `ereporting.xsd` DGFiP ne porte aucun élément de signature —
l'authentification est assurée au niveau **transport** (SFTP/AS2/AS4 X.509,
API OAuth2), responsabilité de la Plateforme Agréée. Le scellement/PAF livré
en 2.2 pour le journal CDV **ne s'applique pas** au Flux 10 : le journal
`ereporting_status_events` est **append-only** (grants `SELECT`+`INSERT`
seulement, comme `invoice_status_events`) mais **non scellé** — comportement
correct, pas un oubli : rien dans la spec externe v3.2 n'exige un hash-chain
sur ce journal, contrairement à l'obligation CGI qui a motivé le scellement du
CDV.

### Machine à états 300/301 (distincte du CDV)

Cycle de vie **propre à l'e-reporting**, indépendant du CDV facture
(`ereporting-lifecycle.ts`) :

```
prepared → transmitted → { deposee (300) | rejetee (301) }
```

- **`prepared`/`transmitted`** sont des états **internes** à la Plateforme
  Agréée, antérieurs à toute transmission réelle au PPF — ils ne portent
  **aucun code DGFiP** (`code: null`, jamais un faux `0`/`1` qui laisserait
  croire à un code réglementaire).
- **`deposee` (300)** et **`rejetee` (301)** sont les deux seuls états
  **terminaux**, portant les codes DGFiP réels (Tableaux 5/6, §3.7.10). Un
  rejet (`rejetee`) **exige** un motif `REJ_SEMAN`/`REJ_UNI`/`REJ_COH`/`REJ_PER`
  (`motifRequired`) ; toute transition invalide (chronologie, motif manquant)
  est refusée par `assertTransition`/`InvalidEreportingTransitionError`.
- Le modèle **binaire** (un seul aller-retour transmitted→terminal, sans état
  intermédiaire de type « en cours de contrôle ») est une **interprétation
  projet** : la Figure 59 du Dossier général (visuel du cycle de vie e-reporting)
  n'est pas extractible en règles machine — seul le texte §3.7.9 est
  disponible, et il ne contredit pas ce modèle, mais ne le prouve pas non plus
  formellement. **À confirmer au go-live.**

**Deux origines distinctes pour `rejetee`, désambiguïsées** (`deriveRejectOrigin`,
`ereporting.controller.ts`, exposé en `rejectOrigin` sur les endpoints de
consultation) :

- **`rejectOrigin: 'local'`** — rejet **pré-transmission** (`fromStatus: null`,
  `actor: 'platform'`) : le worker de génération a produit un XML **non
  XSD-valide** et l'a rejeté lui-même (motif `REJ_SEMAN`) **avant tout appel
  au port de transmission** — le PPF n'a jamais vu ce document. C'est la
  transmission qui **naît directement `rejetee`** (« born-rejetee », voir le
  runbook ci-dessous), pas une transition `prepared`→`rejetee` (interdite par
  la machine à états : seul `transmitted`→`rejetee` est un 301 officiel).
- **`rejectOrigin: 'ppf'`** — rejet **réel** notifié par le PPF
  (`fromStatus: 'transmitted'`, `actor: 'ppf'`), appliqué via
  `EreportingStatusService.recordPpfStatus`.

### Agrégation et classification (10.1/10.3)

`classifyEreportingOperation(invoice)` (pure) classe chaque facture selon
deux règles appliquées dans l'ordre (amendement A1, revue Task 3, BINDING —
« non-assujetti PRIME la règle pays ») : (1) acheteur **non-assujetti** (FR
**ou** étranger, faute de champ dédié — heuristique SIREN/SIRET/vatId, voir
§ Périmètre ci-dessus) → **toujours** `'10.3'`, y compris un export B2C ; (2)
acheteur **assujetti et transfrontalier** → `'10.1'` ; (3) acheteur
**assujetti et domestique** (les deux parties en FR) → `'out'`, exclue
(relève de l'e-invoicing, pas de l'e-reporting).

`aggregateTransactions` traite les deux classes retenues séparément (3.2,
Task 3 — **activation** du 10.1, resté classifié-mais-non-émis en 2.3) :

- **`'10.3'`** — regroupées par (date ‖ devise ‖ catégorie TLB1/TPS1),
  montants sommés en `big.js` (BT→TT), dans `TransactionsReport.aggregated`
  (TG-31). Le **cadre de facturation** (`businessProcessType`, BT-23)
  détermine la catégorie : un cadre **unique** (M1 pur biens ou pur services)
  va directement dans son bucket TLB1/TPS1 ; un cadre **MIXTE** (M1/M2/M4,
  TLB1+TPS1 simultanés, plan 3.2 D2/D3) est ventilé via
  `computeVatBreakdownByNature` — **total conservé, base exacte, résidu TVA
  ≤ 1 centime absorbé côté services** (voir `compute.ts`,
  `@factelec/invoice-core`) — pour les factures **naturées** (`nature`
  renseigné sur **toutes** les lignes) ; une facture mixte **non naturée**
  reste différée (§ Périmètre ci-dessus, compteur `deferredMixed`). BT-23
  absent → repli **TLB1** par défaut (INTERPRÉTATION PROJET, à confirmer
  go-live).
- **`'10.1'`** — émises **PAR FACTURE** (TG-8) dans
  `TransactionsReport.invoices` (`buildFlux10Invoice`) : ventilation TVA
  **canonique** (UNTDID 5305, `vatBreakdown`), **pas** l'axe TLB1/TPS1 — le
  discriminant `nature` ne concerne **que** l'agrégat B2C 10.3. `CompanyId`
  vendeur vide si aucun SIREN côté vendeur (branche « acheteur FR assujetti +
  vendeur étranger », à confirmer Annexe 7).

**Transmission à blanc optionnelle** (§2.3.3) : si **aucune** opération
e-reportable n'est éligible sur la période (ni agrégat 10.3, ni facture 10.1
émise), `aggregateTransactions` renvoie `null` et **aucune écriture, aucun
appel au port de transmission** n'a lieu — pas de « transmission vide »
générée pour le principe.

**`invoiceCount` — métadonnée indicative, pas une source de vérité** : ce
compteur (persisté sur `ereporting_transmissions`) compte **toutes** les
factures classées `'10.3'` sur la période, y compris celles à cadre mixte
finalement **exclues** de l'agrégation — il peut donc **sur-compter** par
rapport au nombre réel de factures reflétées dans les montants du XML. Les
**montants déclarés au PPF restent exacts** (aucune facture à cadre mixte non
naturée n'entre dans les sommes) ; seul ce compteur est une approximation à
ne pas utiliser comme preuve d'exhaustivité.

### Génération et validation XML

`generateEreportingXml` (`flux10-xml.ts`, `xmlbuilder2` — dépendance déjà
vendorisée par `invoice-core`, pas un ajout) assemble `ReportDocument` (TB-1,
métadonnées émetteur PA + déclarant) et `TransactionsReport` (TB-2). Le worker
**valide** systématiquement le XML produit contre `ereporting.xsd` DGFiP via
`xmllint` (`ereporting-xsd-validator.ts`, `execFile`) **avant** tout envoi.

> ⚠️ **Validation STRUCTURELLE uniquement — pas une conformité sémantique
> PPF.** Un document XSD-valide respecte la grammaire du format, mais le PPF
> applique en plus des **contrôles sémantiques** (schematron, règles de
> cohérence Annexe 7) **non implémentés ici** — un flux structurellement
> valide peut donc légitimement être rejeté par un **301 réel** (`REJ_SEMAN`/
> `REJ_UNI`/`REJ_COH`/`REJ_PER`) après transmission. La validation XSD locale
> protège uniquement contre l'émission d'un document **malformé** ; elle ne
> garantit pas son acceptation par le PPF.

### Cadence de transmission par régime TVA (Tableau 13 §3.7.7, verbatim)

`period.ts` calcule les périodes dues, **data-driven par régime** (aucune
branche `switch`/`if` sur le régime dans la logique de calcul) :

| Régime TVA | Cadence | Échéance (Tableau 13, verbatim) |
| --- | --- | --- |
| `reel_normal_mensuel` | **Décadaire** (01-10 / 11-20 / 21-fin de mois) | 21 du mois / 1er du mois suivant / 11 du mois suivant, à 8h00 |
| `reel_normal_trimestriel` | Mensuelle (mois civil) | 1er du mois **suivant** la période, à 8h00 |
| `simplifie` | Mensuelle (mois civil) | 1er du **2e** mois suivant la période, à 8h00 |
| `franchise` | Bimestrielle (bimestres civils jan-fév…nov-déc) | 1er du **2e** mois suivant la fin du bimestre, à 8h00 |

> Ce tableau a été **exhumé verbatim** de la spec externe v3.2 lors de la
> revue de la Task 7 (il n'était pas, contrairement à une hypothèse initiale
> du plan, seulement « partiellement extractible ») — les échéances
> `simplifie`/`franchise` initialement codées un mois trop tôt (mois+1 au lieu
> de mois+2) ont été corrigées suite à cette revue.

**2ᵉ cadence — paiements TB-3 (même Tableau 13 primaire p.68, colonne dédiée,
plan 3.2 D6)** : `computeDuePaymentPeriods`/`PAYMENTS_CADENCE_BY_REGIME`
(`period.ts`) réutilisent **exclusivement** les formes existantes de
`PeriodCadence` — aucune nouvelle forme (ni `quarter`, ni décades-paiement,
ni « dernier jour du bimestre ») :

| Régime TVA | Cadence PAIEMENT | Échéance (Tableau 13, verbatim) | vs cadence transactions |
| --- | --- | --- | --- |
| `reel_normal_mensuel` | Mensuelle (mois civil, **pas** de décades) | 11 du mois suivant, à 8h00 | **DIFFÈRE** — seul régime où paiements ≠ transactions (transactions décadaires 21 / 1ᵉʳ M+1 / 11 M+1) |
| `reel_normal_trimestriel` | Mensuelle (mois civil) | 11 du mois suivant, à 8h00 | identique (post-hotfix `91531d3`) |
| `simplifie` | Mensuelle (mois civil) | 1ᵉʳ du **2ᵉ** mois suivant, à 8h00 | identique |
| `franchise` | Bimestrielle (bimestres civils) | 1ᵉʳ du **2ᵉ** mois suivant la fin du bimestre, à 8h00 | identique |

> ⚠️ **CORRECTION BINDING (revue plan 3.2, Task 9)** — une transcription
> antérieure du Tableau 13 avait fait circuler un texte **FAUX** pour cette
> cadence (décades 20/10/10, « trimestriel trimestriel », franchise
> « dernier jour du bimestre ») — vestige d'avant la réécriture D6. La table
> ci-dessus est la cadence **réelle**, **triple-vérifiée** (extraction
> cellule par cellule du Tableau 13 PRIMAIRE p.68, revue T6, source unique
> `apps/api/src/ereporting/period.ts`) — même motif constant que la cadence
> transactions (échéance PA = échéance de dépôt du déclarant + 1 jour).

Même moteur de calcul que les transactions (`computeDuePeriodsForCadence`,
fonction **pure**, `referenceDate` en paramètre — aucun `Date.now()`), même
fenêtre bornée `MAX_DUE_PERIODS=2`, mêmes « 8h00 » modélisées en **08:00 UTC**
(interprétation résiduelle, voir ci-dessous).

**Interprétations projet résiduelles, à confirmer au go-live** :

- Les « 8h00 » du Tableau 13 sont modélisées en **08:00 UTC** (≈ 09h/10h heure
  de Paris) — la période devient due **après** l'échéance réelle Paris (côté
  sûr : toutes les données du déclarant sont arrivées), tout en restant
  largement dans la fenêtre de remise PPF de 8h.
- Fenêtre de rattrapage **bornée** (`MAX_DUE_PERIODS=2`) : le balayage renvoie
  au plus les 2 périodes les plus récemment échues. Un rattrapage plus long
  (déclarant resté inactif longtemps) est un **processus d'exploitation**
  (ré-émission manuelle/ciblée), pas la responsabilité du balayage horaire
  automatique.
- Heuristique d'assujettissement de l'acheteur : présence d'un SIREN/SIRET
  (BT-47) **ou** d'un numéro de TVA intracommunautaire (BT-48) — faute de
  champ booléen dédié dans le modèle `Invoice`.
- TT-77 (date de transaction) = `issueDate` (BT-2) de la facture.
- SIREN/SIRET porté sous `schemeId` **`0002`** (TT-12/13/33-1).
- Catégorie par défaut **TLB1** (livraison de biens) si le cadre BT-23 est
  absent de la facture.
- Modèle **binaire** du cycle de vie 300/301 (Figure 59 non extractible, voir
  § Machine à états ci-dessus).

### Ordonnancement et anti double-envoi (3 couches)

`EreportingSweepService` (job répétable `EREPORTING_SWEEP_JOB`, périodicité
`EREPORTING_SWEEP_EVERY_MS`) énumère les déclarants actifs de **tous les
tenants** via la fonction `SECURITY DEFINER` `find_ereporting_declarants_due()`
(hors contexte tenant, miroir de `find_failed_archives` 2.2), et enfile pour
chacun, sur **deux cadences DISTINCTES et indépendantes** (plan 3.2, Task 8) :

- les périodes **transactions** dues (`computeDuePeriods`, `flux_kind='transactions'`) ;
- les périodes **paiements** dues (`computeDuePaymentPeriods`, `flux_kind='payments'`
  — la cadence PAIEMENT du Tableau 13, qui ne coïncide avec la cadence
  transactions que pour 3 régimes sur 4, § Cadence ci-dessus).

Un déclarant peut avoir des périodes transactions dues sans période paiement
due, et réciproquement. **Trois couches de défense, identiques pour les deux
flux, aucune suffisante seule** :

1. **Fenêtre bornée** (`MAX_DUE_PERIODS`, table de cadence dédiée par flux,
   `period.ts`) — le balayage ne peut jamais ré-enfiler un historique
   entier, quelle que soit l'ancienneté du dernier passage réussi.
2. **`jobId` déterministe** — BullMQ déduplique tant que le job existe
   encore dans Redis. Transactions : `${declarantId}:${fluxKind}:${periodStart}`
   (séparateur `:`, **legacy pré-existant** — dette BullMQ post-5.80.5, hors
   périmètre). Paiements : `${declarantId}-payments-${periodStart}`
   (séparateur `-`, **leçon 2.4-T9** — jamais `:` pour un flux introduit
   après cette leçon ; voir le runbook ci-dessous pour le risque latent sur
   le format legacy transactions).
3. **Backstop base de données** — l'index unique partiel `WHERE type='IN'`
   (migration `0016`), **clé sur `flux_kind`** : un slot `payments` ne
   collisionne **jamais** avec un slot `transactions` du même déclarant/
   période. `insertTransmission` idempotent (`created: false` → le worker
   relit le statut et saute la période déjà traitée au lieu de la
   ré-émettre au PPF) complète la défense si les couches 1/2 laissaient
   malgré tout passer un doublon.

Le sweep n'enfile que des flux **initiaux** (`type='IN'`) — les rectificatifs
(`RE`) ne sont jamais enfilés automatiquement, quel que soit le `flux_kind`.

### Chemin RE (rectificatif) — retransmission opérateur (3.4)

**Extraction réglementaire primaire** (§3.7.7 p.68-69, notes 127/131) : la
Plateforme Agréée **peut** transmettre un flux rectificatif (`type='RE'`)
qui **annule et remplace l'ensemble** des données précédemment transmises au
titre d'une période — jamais un diff. `POST /ereporting/retransmissions`
(`{ declarantId, fluxKind, periodStart }`) déclenche cette régénération sur
**jugement opérateur exclusivement** : la spec dit « peut », pas « doit » —
**aucun automatisme post-301** n'existe ni n'est prévu (un déclenchement
automatique fabriquerait une décision qu'aucun texte n'impose). La procédure
réelle est toujours : corriger d'abord les données source (facture(s)/
encaissement(s) concernés), puis appeler cet endpoint.

**Dual-auth, motif `PaymentsController.capture`** (`TenantAuthGuard` +
`RolesGuard` + `CsrfGuard`, `@Roles('owner','admin','accountant')`) —
2ᵉ route du projet à composer les trois guards. Réponse **202** `{ jobId,
transmissionRef }` : comme toute génération e-reporting, le RE est
**asynchrone** (BullMQ) — l'endpoint n'attend pas la transmission, l'opérateur
observe le résultat via `GET /ereporting/transmissions` (le champ `type`
distingue déjà `IN`/`RE`, `rejectOrigin` s'applique identiquement aux deux).
Le pipeline réutilisé est **exactement** `EreportingGenerationService.generate`
(dispatch `fluxKind`, `buildTransmissionRef`, `persistAndTransmit`,
`insertTransmission`) avec `type='RE'` — le worker régénère depuis les
données source **lues à l'exécution** (`invoicesForPeriod`/
`listPaymentsForPeriod`), la fraîcheur est donc intrinsèque au pipeline,
**aucune logique de diff n'existe**. Câblage : la file `ereporting-generation`
gagne un **producteur côté API** (`QueueModule`, jusqu'ici seul le process
worker l'enregistrait, à la fois producteur du sweep et consommateur) —
strict miroir de la façon dont `invoice-generation` est déjà produite côté
HTTP pour l'ingestion.

**Garde-fous (avant enfilement)** :

| Condition | Effet |
| --- | --- |
| Déclarant inconnu ou d'un autre tenant | **404** byte-identique (anti-fuite, même fabrique que le reste du contrôleur) |
| `declarantId` malformé (non-UUID) | **422** (`z.uuid()`, corps zod) |
| Aucune transmission `IN` préalable pour `(declarantId, fluxKind, periodStart)` | **409** — « aucune transmission initiale à rectifier pour cette période » |
| IN existant mais encore en statut `'prepared'` | **409, MÊME CORPS** que la ligne précédente — cet IN est en cours de reprise par le sweep backstop (2.3) ; admettre un RE ici créerait un aléa d'ordre RE-avant-IN au PPF. Le client ne distingue **pas** les deux cas (documentation honnête, pas de fuite d'état interne superflue) |
| Déclarant `active=false` | **Sans effet — pas une garde.** Rectifier des données **passées** d'un déclarant devenu inactif depuis reste légitime (l'erreur portait sur des données transmises quand il était actif) ; exiger `active=true` bloquerait une correction valide |

L'IN est accepté quel que soit son statut **hors `prepared`**
(`transmitted`/`deposee`/`rejetee`) — cela couvre le cas normal (rectifier un
`deposee`) **et** le cas du deadlock 2.3 (IN né-`rejetee`, § Runbook
ci-dessous). `periodEnd` est **toujours** repris de l'IN trouvé, jamais fait
confiance au client.

**Idempotence RE — défense en profondeur à 3 couches, miroir exact de
celle de l'IN** (aucun nouveau pipeline, `transmission_ref` n'a par nature
**aucune** contrainte d'unicité et le store de transmission est write-once
par ref — sans cette défense, un simple rejeu BullMQ dupliquerait la ligne) :

1. **`reSeq`** = nombre de RE déjà committés pour
   `(declarantId, fluxKind, periodStart)`, lu **à l'enfilement**
   (`countRetransmissions`). Deux POST quasi-simultanés lisent le **même**
   `reSeq` → collapse voulu (un seul RE réellement émis) ; un 2ᵉ RE
   **délibéré** ultérieur (données re-corrigées) lit `reSeq` incrémenté →
   émission distincte.
2. **`jobId` déterministe** `${declarantId}-${fluxKind}-${periodStart}-RE-${reSeq}`
   (séparateur `-` obligatoire, motif `payments` — pas `:`, qui ferait lever
   BullMQ 5.80.x hors 3 segments) : BullMQ déduplique les ré-enfilements tant
   que le job existe.
3. **Backstop DB** — nouvel index partiel unique
   `(declarant_id, flux_kind, period_start, transmission_ref) WHERE type='RE'`
   (migration `0027`, additif, aucune table/colonne/RLS nouvelle).
   `transmission_ref` du RE devient `ER-${id8}-${periodStart}-RE-${reSeq}`
   (ex. `…-RE-0`, `…-RE-1`) — **l'IN reste byte-identique**
   (`…-IN`, `reSeq` omis). `insertTransmission` arbitre désormais le conflit
   **par `type`** : un RE rejoué retombe sur l'index RE, `created:false`, et
   reprend la transmission verbatim (même logique de reprise que l'IN) —
   **jamais de duplication**.

**L'IN n'est jamais effacé ni muté par un RE** (D5) : le RE **ajoute** une
ligne `type='RE'`, il ne supprime/ne réécrit rien de la ligne IN ni de son
journal. La supersession « annule-et-remplace » est une sémantique **côté
PPF** ; le journal `ereporting_status_events` reste append-only. Le RE suit
le **même** cycle de vie interne que l'IN
(`prepared → transmitted → { deposee | rejetee }`, § Machine à états
ci-dessus) — y compris un rejet local `REJ_SEMAN` si les données corrigées
restent invalides.

### Paiements — capture des encaissements et agrégation TB-3 (3.2, D5/D7)

Sous-domaine `apps/api/src/payments/*` (indépendant du sous-domaine
`ereporting/*`, consommé par lui en aval) : modèle de capture
(`payment.model.ts`), persistance (`payments.repository.ts`), service
applicatif (`payments.service.ts`) et endpoints (`payments.controller.ts`).
L'agrégation TB-3 elle-même (10.2/10.4) vit côté `ereporting/*`
(`flux10-payments-aggregate.ts`), au même titre que `flux10-aggregate.ts`
(10.1/10.3).

**Capture EXPLICITE, jamais dérivée d'un statut CDV** — `POST /payments`
(`{ invoiceId, paymentDate, reference, subtotals: [{ taxPercent, amount }] }`)
enregistre un encaissement **constaté**, sans lien automatique avec le cycle
de vie CDV facture (§ Auto-seed du 212, § Périmètre ci-dessus) : l'événement
de statut `212 Encaissée` ne porte lui-même ni montant ni taux, il ne peut
donc jamais servir de source pour fabriquer un paiement.

**Idempotence `(invoice_id, reference)`** (index unique
`payments_invoice_reference_unique`, migration `0024`) : `insertPayment`
(`ON CONFLICT DO NOTHING` + reload, miroir `EreportingRepository
.insertTransmission`/`CdvTransmissionRepository.insertTransmission`) — un
re-POST de la **même** référence ne réécrit **jamais** rien de nouveau,
même si le payload posté diffère (montants/taux) : **200 `created:false`**,
valeurs d'**origine** conservées, payload divergent **silencieusement
ignoré**. **Correction d'un encaissement mal saisi = poster une NOUVELLE
référence**, jamais re-poster la même avec des valeurs différentes (aucun
endpoint de correction en place). `payments`/`payment_subtotals` ne portent
que `SELECT`+`INSERT` en grants RLS (migration `0025`) — un encaissement
capturé est un fait constaté, **jamais corrigé en place**.

**Intégrité (D5), contrôlée UNIQUEMENT sur une capture réellement nouvelle**
(le rejeu idempotent court-circuite les deux contrôles ci-dessous, sans quoi
un rejeu légitime doublerait artificiellement le cumul et échouerait à tort
en 422) :
- **Taux ⊆ ventilation facture** (`assertKnownRates`) — chaque `taxPercent`
  posté doit appartenir à `vatBreakdown` de la facture liée (comparaison
  normalisée via `big.js`, `"20.0" ≡ "20.00"`) ; un taux étranger → **422
  validation**.
- **Anti-sur-encaissement par taux** (`assertNoOverpayment`) — le plafond
  TTC par taux est reconstruit (`taxableAmount + taxAmount` de la
  ventilation, cumulé sur **toutes** les catégories TVA partageant ce taux,
  ex. Z et E à 0 %) et comparé **strictement** (`≤`, **aucune tolérance
  d'arrondi**) au cumul déjà capturé + nouveau montant ; dépassement → **422
  business-rule**. INTERPRÉTATION projet flaggée (tolérance/arrondi à
  confirmer go-live).
- **TOCTOU sur-encaissement concurrent, MEDIUM, non résolu** (revue T5,
  finding MEDIUM-3) — deux `POST` concurrents sur des références
  **distinctes** lisent chacun le cumul déjà capturé **avant** l'insertion
  de l'autre : aucune contrainte DB ni sérialisation (`SELECT … FOR UPDATE`/
  verrou avisoire/`CHECK` cumulatif) ne les empêche de passer tous les deux,
  cumul final **> TTC**. Race **réelle**, jugée acceptable en l'état
  (mono-tenant, opérateur authentifié, conséquence = qualité de donnée TB-3
  sur-déclarée, pas une fuite cross-tenant ; capture = action basse
  fréquence) — voir le runbook ci-dessous pour la note de vigilance go-live.

**Agrégation TB-3 — `aggregatePayments` (`flux10-payments-aggregate.ts`,
D7)**, appelée par le worker sur les encaissements de la période
(`listPaymentsForPeriod`, bornes `paymentDate` AAAAMMJJ inclusives) :

1. **Règle SERVICES-ONLY (note 119, verbatim)** — « les données de paiement
   ne doivent être transmises qu'en cas de prestations de services, hors
   opérations donnant lieu à autoliquidation de la TVA et option de TVA sur
   les débits ». Le modèle de capture (D5) ne porte qu'un `taxPercent`+
   `amount` par sous-total, **jamais** d'identifiant de ligne — impossible
   de savoir directement quelles lignes un encaissement solde (un
   encaissement référence une facture, qui peut mêler biens et services sur
   des lignes distinctes, `nature` étant au niveau ligne). Règle retenue
   (INTERPRÉTATION PROJET, la plus défendable, testée, à confirmer go-live) :
   la part **services** d'un encaissement, **par taux**, est estimée au
   **prorata** de la part que les services représentent, pour ce taux, dans
   le TTC canonique de la facture liée
   (`ratio(taux) = servicesTTC(taux) / canonicalTTC(taux)`, `big.js`,
   2 décimales). Une facture **tout-services** (ratio 1) n'est jamais
   tronquée ; une facture **tout-biens** (ratio 0) est **intégralement
   exclue**. Le numérateur exclut en outre la catégorie TVA `AE`
   (autoliquidation, UNTDID 5305) — application directe de la clause « hors
   autoliquidation ». La clause « hors option de TVA sur les débits »
   **n'a aucun champ correspondant** dans `Invoice` — différée honnêtement.
2. **Cas indécidable** — une facture liée dont au moins une ligne n'a pas de
   `nature` (`computeVatBreakdownByNature` → `complete:false`) est
   **différée** (skip typé + log `deferredIncomplete`), même posture que le
   différé des cadres M* ci-dessus — **jamais** de ventilation partielle
   fabriquée.
3. **Deux sous-flux, comme la classification 10.1/10.3** — `'10.1'` (B2Bi)
   produit une `Flux10PaymentInvoice` **par encaissement** dans
   `PaymentsReport.invoices` (10.2 — la forme XSD porte un seul `Payment`
   par `Invoice` : plusieurs encaissements partiels de la même facture
   produisent naturellement plusieurs éléments `<Invoice>`, **jamais**
   fusionnés) ; `'10.3'` (B2C) **agrège** dans `PaymentsReport.transactions`
   par (`paymentDate`, `taxPercent` normalisé, **devise**) — 10.4, **sans**
   référence facture ni catégorie. La **devise fait partie de la clé**
   (revue T7, MEDIUM-1) : deux encaissements même date/taux en devises
   différentes (EUR domestique + USD export B2C) restent deux sous-totaux
   distincts sous leur propre `CurrencyCode` — les sommer sous une seule
   devise fausserait la figure réglementaire. `'out'` exclue.
4. **MAILLE DÉCLARANT** (revue T8, MAJOR-1, correction appliquée) —
   `payments` ne porte **aucune** colonne siren/rôle (D5, la facture liée
   porte tout) : sans filtre, un tenant à **plusieurs déclarants**
   transmettrait les **mêmes** encaissements sous **chaque** déclarant dû à
   la même période (sur-déclaration N-fold). `filterInvoice` (miroir du
   filtre SQL `eq(partySiren, siren)` d'`invoicesForPeriod`, côté
   transactions) s'applique en aval du chargement : `SE` → SIREN
   **vendeur**, `BY` → SIREN **acheteur** ; un encaissement hors maille est
   **skippé silencieusement** (hors périmètre du rapport courant, pas une
   anomalie).
5. **XOR structurel, gardé au runtime** (D7, revue T7 MEDIUM-2) —
   `generateEreportingXml` **throw** si un `Flux10Report` porte
   `transactions` **et** `payments` simultanément (le type ne l'impose pas,
   discipline d'appelant) : sans ce garde, un appelant fautif verrait son
   `PaymentsReport` **perdu en silence** (l'ancien `else if` avalait
   `payments` quand `transactions` était non-null).
6. **Montants 19.6** (TT-95/TT-99, Annexe 6 v1.10) — les montants
   **capturés/agrégés** en amont (Tasks 4/5/7) restent en **2 décimales**
   (cohérentes avec les totaux facture) ; **seul l'émetteur XML**
   (`formatPaymentAmount`, `flux10-xml.ts`), unique frontière connaissant le
   format XSD cible, reformate à **6 décimales**.
7. **Garde `CurrencyCode` optionnelle** — `Flux10PaymentSubTotal.currency`
   est `string | undefined` ; l'élément `<CurrencyCode>` n'est émis dans le
   XML que si la valeur est présente (`row.currency` vaut toujours `'EUR'`
   par défaut à la capture, jamais une chaîne vide qui produirait un
   élément creux).

**Transmission à blanc** : si **aucune** opération e-reportable n'est
éligible sur la période (agrégats vides **et** aucune facture 10.1),
`aggregatePayments` renvoie `null` — **zéro écriture, zéro appel au port**,
mais **journalisée** (§ Runbook ci-dessous, contrairement au silence côté
transactions) : un encaissement peut exister sur la période sans jamais
produire d'opération e-reportable (services-only), ce qui mérite une trace
distincte d'un bug d'agrégation amont.

### Port de transmission

`Flux10TransmissionPort` (`transmit`/`status`) est implémenté en 2.3 par
`LocalFilesystemTransmissionStore` (write-once, `EREPORTING_TRANSMISSION_DRIVER=local`,
défaut) — écriture atomique, `trackingId` déterministe (`sha256(xml)`).
`EREPORTING_TRANSMISSION_DRIVER` accepte aussi `sftp`/`as2`/`as4`/`api`, tous
**activés au déploiement** (lèvent une erreur explicite tant que
l'implémentation réelle n'est pas fournie — même motif que l'adaptateur S3
object-lock de 2.2).

### Persistance

Trois tables tenant-scopées sous RLS **`ENABLE`+`FORCE`** (migrations `0016`
Drizzle / `0017` hand) : `ereporting_declarants` (config CRUD par déclarant :
SIREN, rôle, régime TVA), `ereporting_transmissions` (sans `DELETE`), et
`ereporting_status_events` (journal **append-only**, `SELECT`+`INSERT`
seulement). L'index unique partiel `ereporting_transmissions_declarant_flux_period_in_unique`
(`declarant_id, flux_kind, period_start` **où** `type='IN'`) porte l'A2
(anti double-envoi, voir ci-dessus **et** le runbook ci-dessous — c'est aussi
la cause du deadlock du slot A2, y compris pour `flux_kind='payments'`).

**Paiements (plan 3.2, migrations `0024` Drizzle / `0025` hand)** : deux
tables tenant-scopées sous RLS **`ENABLE`+`FORCE`**, grants **`SELECT`+
`INSERT` seulement** (immuabilité par grants — un encaissement est un fait
constaté, jamais corrigé en place, § Paiements ci-dessus) — `payments`
(index unique `payments_invoice_reference_unique` sur
`(invoice_id, reference)`, FK `invoice_id` en `ON DELETE RESTRICT`) et
`payment_subtotals` (FK `payment_id` en `ON DELETE RESTRICT`).

## Runbook opérationnel — e-reporting Flux 10

Section dédiée aux **dettes opérationnelles** identifiées en revue (Tasks 5 et
8), à connaître **avant** toute exploitation réelle.

### Deadlock du slot A2 — débloqué par le chemin RE (3.4, conditionnel)

**Symptôme, inchangé.** Une transmission `IN` née `rejetee` (rejet **local**
`REJ_SEMAN`, XML non XSD-valide produit par une donnée source incohérente)
occupe **définitivement** le slot unique (déclarant × flux × période **où**
`type='IN'`) : `rejetee` est un statut **terminal** (§ Machine à états
ci-dessus). **Identique pour `flux_kind='payments'`** (plan 3.2) — le slot
est clé sur `(declarant_id, flux_kind, period_start)` (§ Persistance
ci-dessus), donc une transmission paiements née `rejetee` occupe son propre
slot exactement selon la même mécanique, sans interférence avec le slot
transactions du même déclarant/période. Une fois la donnée source corrigée
en amont, le balayage suivant tente de régénérer la période, mais
`insertTransmission` retombe sur le conflit d'index existant
(`created: false`), recharge la ligne `rejetee` existante, et le worker
constate un statut **non-`prepared`** → il **ne fait rien** (`return`
silencieux, § `ereporting-generation.service.ts`). **La période ne peut
toujours pas être transmise une seconde fois en `IN`** — le chemin RE
(3.4) ne change **rien** à ce fait : il ouvre une voie **parallèle**, il ne
« répare » pas le slot `IN`.

**Pourquoi ce n'est PAS un bug à corriger en excluant `rejetee` de l'index.**
L'index unique partiel `WHERE type='IN'` (sans filtre sur le statut) est ce
qui garantit l'**idempotence anti double-envoi** entre `insertTransmission` et
`markTransmitted` (couche 3 de la défense en profondeur ci-dessus) : si un
crash survient entre l'insertion et la transmission effective, le rejeu du
balayage doit retomber sur la **même** ligne, quel que soit son statut, plutôt
que d'en créer une seconde qui serait transmise deux fois au PPF. **Retirer
`rejetee` de cet index rouvrirait cette fenêtre de double-envoi sur crash** —
ne jamais le faire pour « corriger » le deadlock. Le slot `IN` reste donc
**occupé pour toujours** par la ligne `rejetee` — c'est voulu (§ Chemin RE
ci-dessus, D5 : le RE ne prétend jamais être un IN).

**⚠️ Distinguer IMPÉRATIVEMENT les deux origines de `rejetee` avant d'agir**
— `GET /ereporting/transmissions` expose `rejectOrigin` (`'local'`\|`'ppf'`)
pour chaque transmission rejetée, dérivé de `deriveRejectOrigin` (§ Machine
à états ci-dessus). Les deux cas ne portent **pas** la même garantie de
conformité :

- **`rejectOrigin: 'ppf'`** — 301 réel : l'IN a été **transmis**, puis rejeté
  par le PPF après contrôle. Le RE correspond ici **exactement** à la lettre
  de la spec (§3.7.7 : « erreur sur des données **transmises** ») —
  déblocage **sans réserve**.
- **`rejectOrigin: 'local'`** (« born-rejetee ») — rejet **pré-transmission**
  (`REJ_SEMAN`, XML jamais XSD-valide) : **le PPF n'a rien vu** de cette
  période, le port de transmission n'a **jamais** été appelé. Le RE est
  **permis par le code** sur ce cas (c'est précisément ce qui débloque le
  deadlock de façon pragmatique — le garde D4 n'exige qu'un IN **existant**
  hors `prepared`, pas un IN effectivement transmis) mais l'extraction
  réglementaire primaire (§3.7.7 p.68-69) est **silencieuse** sur l'admission
  d'un rectificatif sans IN transmis préalable. **INTERPRÉTATION PROJET
  FLAGGÉE, À VALIDER EN PILOTE PPF** : rien ne garantit aujourd'hui que le
  PPF acceptera un `RE` pour une période dont il n'a **jamais** reçu d'`IN` —
  seul un pilote réel avec la DGFiP tranchera. Le déblocage local
  (retriable-idempotent, testé) fonctionne dans tous les cas côté Factelec ;
  c'est l'**acceptation PPF** de ce cas précis qui reste une hypothèse non
  vérifiée.

**Procédure de déblocage** :

1. Identifier la transmission bloquée : `GET /ereporting/transmissions`,
   filtrer `status='rejetee'`, noter `rejectOrigin` (`'local'` ou `'ppf'` —
   voir la distinction ci-dessus, elle conditionne le niveau de confiance à
   accorder au déblocage, pas la procédure elle-même).
2. Consulter le motif exact (`GET /ereporting/transmissions/:id/events`) pour
   comprendre l'incohérence source (typiquement une donnée de facturation
   invalide au regard du XSD e-reporting, ou un rejet 301 PPF réel).
3. Corriger la donnée source (facture(s)/encaissement(s) concernés) dans le
   système amont.
4. `POST /ereporting/retransmissions { declarantId, fluxKind, periodStart }`
   (dual-auth, § Chemin RE ci-dessus) → **202** `{ jobId, transmissionRef }`.
   Le worker régénère la période **complète** depuis les données **actuelles**
   et produit une transmission `RE` avec un `transmission_ref` **distinct**
   (`…-RE-0`) qui **passe** l'index partiel RE (0027) et le store write-once
   — **aucun conflit** avec la ligne `IN` rejetée, qui reste en base,
   inchangée, comme enregistrement historique.
5. Suivre la progression via `GET /ereporting/transmissions` (filtrer
   `type='RE'`) : la nouvelle transmission passe
   `prepared → transmitted → { deposee | rejetee }` exactement comme un IN.

**Edge connu — `reSeq` figé et dédup silencieuse (revue finale 3.4, F-1)** :
`reSeq` n'avance que lorsqu'une ligne `RE` est réellement **committée**. Si un
job RE se termine **sans** écrire de ligne (période devenue à-blanc, déclarant
disparu) ou reste en échec retenu (`XsdToolingError`, rétention BullMQ 7 j),
un re-`POST /ereporting/retransmissions` recalcule le **même** `reSeq` → même
`jobId` → **dédup BullMQ = no-op silencieux** tant que le job précédent est
dans la fenêtre de rétention (le 202 renvoyé référence le job existant). Ce
comportement est **sans danger** (aucun doublon PPF possible) mais peut
surprendre : si un re-POST semble sans effet, consulter la file (job existant
même id) ou attendre l'expiration de rétention. Le cas courant (RE rejeté
`REJ_SEMAN` → ligne committée → `reSeq` avancé) n'est **pas** concerné.

**Edge — sortie d'`ambiguous` (revue finale 3.4, F-2) — SOLDÉ en 3.5.** Le
sweep de reprise du routage **exclut** `ambiguous` à dessein (l'ambiguïté
exige un nettoyage humain de l'annuaire, pas un rejeu aveugle). Depuis 3.5,
`POST /invoices/:id/routing/resolve` (dual-auth, § Consentement scellé, rôle
worker & re-résolution ambiguous — 3.5) ferme le trou qui restait après ce
nettoyage : **procédure** — (1) corriger l'annuaire (masquer/republier la
ligne en trop) ; (2) appeler l'endpoint sur la facture concernée ; (3) lire
l'état retourné.

⚠️ **Honnêteté (L1, à lire avant d'exploiter)** : `resolveAndRecord` est
best-effort strict, il ne relève jamais — un `200` dont le corps reste
`routingStatus: 'ambiguous'` est **indistinguable** entre « l'annuaire n'a pas
(suffisamment) été nettoyé » et « une panne opérationnelle (annuaire/DB) est
survenue pendant la re-résolution ». Procédure en cas de persistance :
re-vérifier le nettoyage annuaire, **re-tenter** l'appel (idempotent — aucun
effet de bord à le rejouer), ou consulter les logs applicatifs pour trancher
— aucune télémétrie dédiée ne distingue aujourd'hui ces deux causes.
`unaddressable`/`pending` restent, eux, repris automatiquement par le sweep
3.4 sans intervention.
   Un nouveau rejet local (données encore invalides) est visible de la même
   façon (`rejectOrigin: 'local'` sur **cette** ligne RE) — corriger à
   nouveau et re-POST (`reSeq` s'incrémente automatiquement, `…-RE-1`).

**Ce que la procédure ne fait PAS** : elle ne supprime, ne modifie ni ne
« libère » jamais la ligne `IN` `rejetee` d'origine (aucun accès DB direct
requis, contrairement à l'ancienne procédure manuelle) — le slot `IN` reste
occupé, la période est **de facto** re-déclarée via le slot `RE` parallèle.

### Transmission à blanc PAIEMENTS — journalisée (≠ silence transactions, 3.2)

`generatePayments` (`ereporting-generation.service.ts`) journalise
explicitement (`logger.log`) toute période sans **aucune** opération
e-reportable (`aggregatePayments` → `null`) — comportement **différent** du
chemin transactions, qui reste silencieux dans le même cas. Motif : côté
paiements, une période « à blanc » peut recouvrir deux situations très
différentes qu'il faut pouvoir distinguer en exploitation — (a) aucun
encaissement capturé sur la période (normal, rien à signaler) et (b) des
encaissements existent mais **aucun** ne franchit le filtre services-only
(note 119) ou la maille déclarant — auquel cas l'absence de trace serait
indiscernable d'un bug d'agrégation amont. Un « à blanc » paiements
**fréquent** sur un déclarant qui capture pourtant des encaissements
mérite donc d'être investigué (cadre de facturation des factures liées,
`nature` de ligne renseignée) avant d'être considéré normal.

### `jobId` paiements (`-`) vs legacy transactions (`:`) — dette BullMQ latente (3.2)

Le séparateur du `jobId` transactions (`${declarantId}:${fluxKind}:${periodStart}`)
est un **legacy pré-existant** (2.3), documenté comme une dette BullMQ
post-5.80.5 hors périmètre de ce plan. Le `jobId` paiements
(`${declarantId}-payments-${periodStart}`) a délibérément choisi `-` (leçon
2.4-T9) pour ne **pas** reproduire ce risque sur un flux introduit après
qu'il a été identifié. **Ne jamais aligner rétroactivement le format
transactions sur `-`** sans traiter la dette BullMQ sous-jacente au même
moment (changer le séparateur d'un jobId existant en production changerait
la clé de déduplication Redis pour tous les jobs déjà enfilés).

### Sur-encaissement concurrent (TOCTOU) — vigilance go-live (3.2, MEDIUM)

Deux `POST /payments` concurrents portant des **références distinctes** sur
la **même** facture peuvent chacun passer le contrôle anti-sur-encaissement
(`assertNoOverpayment`) avant que l'autre n'ait écrit sa ligne — cumul final
possible **> TTC** de la facture (§ Paiements ci-dessus, revue T5
MEDIUM-3). **Aucune correction automatique en place** (pas de verrou
`(tenant, invoice)` ni de contrainte DB cumulative). **Procédure de
vigilance** (jusqu'à un correctif dédié — verrou applicatif ou contrainte
`CHECK`, non livré à ce jour) :

1. Un sur-encaissement détecté a posteriori (rapprochement comptable, ou
   `GET /payments?invoiceId=…` dont la somme des sous-totaux dépasse le TTC
   facture) n'est **pas** un bug applicatif à corriger en base — c'est une
   trace d'une race réelle entre deux captures concurrentes.
2. Aucune référence n'est à supprimer (grants `SELECT`+`INSERT` seulement,
   § Persistance ci-dessus — un encaissement capturé est un fait constaté) :
   traiter l'écart en aval (rapprochement comptable, remboursement hors
   système) plutôt qu'en réécrivant l'historique.
3. Risque jugé faible en pratique (capture = action opérateur basse
   fréquence, mono-tenant) mais **à surveiller** si le volume de captures
   concurrentes sur une même facture augmente (intégration avec un moyen de
   paiement à confirmations multiples, par exemple).

### Bypass CSRF/rôles pour l'authentification par clé API (garde-fou hérité, 3.2)

`POST /payments` est le **premier endpoint de mutation** du projet à
composer `TenantAuthGuard` (dual-auth clé API/session) avec `RolesGuard` **et**
`CsrfGuard` (`payments.controller.ts`). Les deux derniers guards
court-circuitent explicitement sur `req.apiKeyId` (posé par
`TenantAuthGuard` **uniquement après vérification cryptographique réussie**
de la clé, `tenant-auth.guard.ts` — jamais avant, jamais sur une clé
invalide) : un appel machine (clé API) n'a ni cookie ni
`authUser`/`authAdmin`, donc `RolesGuard`/`CsrfGuard` l'auraient sinon
**toujours** rejeté (403/401) en l'absence de ce bypass. **Garde-fou
documenté, pas une faille** : `apiKeyId` n'est jamais forgeable côté client,
et ce bypass ne change le comportement d'**aucune** route existante (aucune
ne combinait encore les trois guards avant `POST /payments`). **Toute
future route dual-auth qui empile `RolesGuard`/`CsrfGuard` après
`TenantAuthGuard` hérite automatiquement de ce même bypass** — à garder en
tête lors de l'ajout d'une nouvelle mutation dual-auth : le bypass est
correct pour une clé API (pas de notion de rôle utilisateur applicatif, pas
de cookie CSRF à vérifier), mais suppose que **rien** entre
`TenantAuthGuard` et ces deux guards ne pose `req.apiKeyId` sur un chemin
non authentifié. **Ce dernier point est désormais surveillé par un verrou
d'architecture** (plan 3.3, D9 — voir § Durcissements transverses ci-dessous
pour le détail et son honnêteté assumée : un **ralentisseur**, pas une
barrière d'exécution).

### `libxml2`/`xmllint` — prérequis de l'hôte du **worker**

Contrairement à `invoice-core`, où `xmllint` n'est requis **qu'en test**
(Schematron/XSD EN 16931), le worker e-reporting invoque `xmllint` **en
runtime**, à **chaque génération de transmission** (`ereporting-xsd-validator.ts`,
`execFile`). Si l'outil est absent de l'hôte d'exécution du worker en
production, la validation échoue avec une erreur **opérationnelle** (pas un
rejet sémantique) — le job est rejoué selon `EREPORTING_GENERATION_JOB_ATTEMPTS`
puis marqué `failed` après épuisement, **aucune transmission n'est jamais
émise** tant que l'outil manque. **À ajouter aux prérequis d'image/hôte de
déploiement du worker**, à côté de `pgcrypto` (2.2), du bucket S3 (2.2) et de
`TRUST_PROXY` (1.4).

### Durcissement du rôle SD cross-tenant (dette sécurité, revue Task 5)

`find_ereporting_declarants_due()` (fonction `SECURITY DEFINER`) expose, au
rôle applicatif `factelec_app` (partagé API + worker), les colonnes
`(tenant_id, siren, name)` de **tous les tenants** — plus large que le
périmètre RLS habituel d'un rôle applicatif, mais **nécessaire** tant que le
worker et l'API partagent le même rôle Postgres (aucun privilège
supplémentaire réel n'est accessible depuis l'API HTTP aujourd'hui, puisque
c'est le **même** rôle). **À durcir au déploiement** en retirant l'`EXECUTE`
au rôle utilisé par le process API HTTP lors d'un futur split du rôle worker
(API ↔ worker sur deux rôles Postgres distincts, avec des grants différenciés)
— non fait dans ce plan.

## Annuaire central (Flux 13/14) — 2.4

L'**annuaire** est le registre central **hébergé par le PPF** (Portail Public
de Facturation) qui associe à chaque entité une (ou plusieurs) plateforme(s)
destinataire(s) pour l'adressage/routage des factures électroniques — un
concept **distinct** de l'e-invoicing (Flux 1-9) et de l'e-reporting (Flux 10
ci-dessus). Le **livrable pré-immatriculation** est le **domaine PA**
(Plateforme Agréée) uniquement : consulter l'annuaire avant de router,
publier ses propres lignes, ingérer les mises à jour du PPF. Sous-domaine
`apps/api/src/annuaire/*` : nomenclatures pures (`nomenclature.ts`), modèle
de ligne d'adressage et résolution (`ligne-adressage.ts`), machine à états de
publication (`annuaire-lifecycle.ts`), génération Flux 13 / parsing Flux 14
(`flux13-xml.ts`, `flux14-parse.ts`, `annuaire-xsd-validator.ts`),
persistance (`annuaire.repository.ts`), port de transport
(`annuaire.port.ts`, `annuaire-transport.module.ts`,
`local-filesystem-annuaire-store.ts`), services applicatifs
(`annuaire-consultation.service.ts`, `annuaire-publication.service.ts`,
`annuaire-sync.service.ts`) et endpoints (`annuaire.controller.ts`).

### Périmètre livré et honnêteté — lecture obligatoire

**LIVRÉ de bout en bout, côté PA** :

- **Ligne d'adressage** (`ligne-adressage.ts`) : 4 mailles possibles (SIREN
  seul, SIREN+SIRET, SIREN+SIRET+identifiant de routage, SIREN+suffixe),
  validité **semi-ouverte `[dateDebut, dateFin)`** (ANNEXE 3 F13 rows 23-24,
  verbatim — la date de début est incluse, la date de fin est exclue),
  résolution du destinataire **la plus spécifique d'abord**
  (`resolveRecipient`) avec masquage (Nature `M`) à **portée exacte-maille**
  (ne cascade ni vers une maille plus large ni plus étroite).
- **Génération Flux 13 (Actualisation, PA→PPF) et parsing Flux 14
  (Consultation, PPF→PA), tous deux validés XSD** contre les schémas DGFiP
  réels (`Annuaire_Commun.xsd` + les XSD F12-F13/F14 dédiés) — dans les
  **deux directions**, ce que le dossier de cadrage initial avait omis (D3).
- **Miroir de consultation tenant-scopé, PII-minimal** (D8) : seuls maille +
  plateforme + validité + nature sont extraits du Flux 14 et persistés —
  `BlocUnitesLegales`/`BlocEtablissements`/`BlocIdPlateformesReception` (qui
  portent Nom/Adresse/Diffusible/Contact) ne sont **jamais lus**, pas même
  typés côté parseur : ces données sont structurellement absentes du
  résultat, pas seulement omises par convention.
- **Publication consent-gated** (D5, §3.5.5.5) : gate **422** (`Consent
  required`) évaluée **avant toute écriture** si aucun consentement actif ne
  couvre la maille ciblée ; conflit de slot (même maille × `dateDebut`, ligne
  `Définition` déjà active) → **409**, avec **libération automatique** du
  slot dès qu'une ligne atteint un statut terminal (`rejetee`/`masked`).
- **Acquittements PPF** (`recordAck`, CAS 1 transaction) avec désambiguïsation
  d'origine (naissance directe `rejetee` sur F13 localement XSD-invalide,
  dite « born-rejetee », vs acquittement réel du PPF).
- **Synchronisation bornée** : ordonnanceur BullMQ (`AnnuaireSweepService`)
  énumérant les tenants actifs (`find_annuaire_sync_targets`), différentiel
  **quotidien** (upsert seul, jamais de suppression) et complet
  **hebdomadaire** (upsert **puis remplacement** du miroir du tenant — les
  plateformes que le PPF a cessé d'annoncer disparaissent), plus un
  **sweep de reprise des publications figées** (voir Runbook ci-dessous).

**DIFFÉRÉS EXPLICITES — ne pas surpromettre « annuaire complet livré »** :

- **Adaptateurs de transport réels** (API PISTE-OAuth2, EDI SFTP/AS2/AS4) —
  `ANNUAIRE_DRIVER=api|edi` lève une erreur explicite et testée tant que
  l'implémentation réelle n'est pas fournie ; seul `local` (write-once
  testable) est câblé en 2.4. Activation **au déploiement**.
- **Feeds d'initialisation INSEE/Chorus/DGFiP** — non chargés : la
  plateforme fictive non-routante par défaut (`FICTITIOUS_PLATFORM = '9998'`,
  attribuée en théorie à toute entité nouvellement assujettie, PDF spec v3.2
  §3.5.3) est **modélisée** (constante nomenclature) mais **aucun processus
  d'ingestion** ne peuple automatiquement ces lignes par défaut à ce jour.
- **Habilitations réelles** — le scoping du miroir est **tenant-scopé** (RLS,
  D8) mais ne modélise pas encore d'habilitation fine par plateforme/mandat ;
  différé derrière le port de transport réel.
- **Codes routage standalone** (6 endpoints Swagger dédiés
  `SIREN×3`/`SIRET×3`/codes de routage du dossier de cadrage) — **différés**
  (R5) : `RoutageID` n'est porté qu'**inline** dans la ligne d'adressage
  (`routageId`), jamais géré par un endpoint dédié de gestion des codes de
  routage.
- **Connecteur de signature électronique du consentement** — la preuve de
  consentement (`ConsentProofInput` : type, identité signataire, référence de
  preuve, date d'obtention) est un simple enregistrement structuré ; aucune
  intégration avec un prestataire de signature électronique.
- **Câblage de la résolution dans l'émetteur de factures** — `resolveRecipient`/
  `AnnuaireConsultationService` existent et sont testés, mais **rien dans le
  pipeline de génération/émission des formats du socle (Flux 1-9) n'appelle
  encore la résolution de routage annuaire** : c'est la brique dont dépendra
  un futur câblage (phase 3, transmission Peppol), pas un oubli de ce plan.
- **Révocation de consentement — LIVRÉE en 3.6** — la colonne
  `annuaire_consents.revoked_at` existe et `findConsentById` la respecte
  déjà (un consentement révoqué ne couvre plus aucune publication) ;
  `POST /annuaire/consents/:id/revoke` écrit désormais ce champ. Voir §
  Révocation de consentement — 3.6 ci-dessous (révocation-seule, aucune
  cascade sur l'adressage déjà publié — honnêteté du miroir).

**Aucun scellement/signature au niveau message** (même motif que
l'e-reporting, D6/cohérent 2.3) : le journal `annuaire_ligne_events` est
**append-only** (grants `SELECT`+`INSERT` seulement) mais **non scellé** —
l'authentification relève du **transport**, pas du message ; le scellement
2.2 (chaîne SHA-256) ne s'applique pas ici.

### Machine à états de publication (distincte du CDV et du 300/301)

Cycle de vie **propre à la publication annuaire** (`annuaire-lifecycle.ts`) :

```
draft → published → { deposee | rejetee }
deposee → masked
```

- **Codes DGFiP (correctif backlog 3.6, §3.5.7 Tableau 6 p.54)** :
  `deposee` porte **400 « Acceptée »** et `rejetee` **401 « Rejetée »**
  (statuts obligatoires documentés) ; les états **internes PA**
  (`draft`/`published`/`masked`) restent `code: null` (leçon 2.3-A3 — jamais
  de faux code réglementaire sur un état interne). Le **motif** de rejet
  reste une **chaîne libre** : les 4 motifs normatifs du **Tableau 7 p.55**
  (`REJ_RG`/`REJ_HAB`/`REJ_COH`/`REJ_VAL_INC`) existent, leur contrainte est
  une **dette** liée au raccordement des adaptateurs annuaire réels (le port
  local ne produit pas d'acquittements réels).
- **Terminaux = `{rejetee, masked}`** — `deposee` n'**est pas** terminal
  (transition possible vers `masked`, fin d'adressage explicite via une
  ligne Nature `M`). `motifRequired` n'exige un motif que pour `rejetee`.
- **A-DEADLOCK (amendement de conception, analogue du slot A2 2.3, mais
  résolu différemment car l'annuaire n'a pas de concept de rectificatif)** :
  l'index unique partiel de définition (migration `0018`,
  `WHERE nature='D' AND status NOT IN ('rejetee','masked')`) **libère** le
  slot (tenant, maille, `dateDebut`) dès qu'une ligne atteint un statut
  terminal — une re-définition de la même maille×date après rejet/masquage
  est **toujours une nouvelle ligne** (nouveau `draft`), jamais une
  réouverture de l'ancienne ligne terminale.

### Ligne d'adressage, résolution et consultation

- **Hiérarchie de spécificité** (`mailleLevelOf`, avertissement
  d'interprétation) : `SIREN < SIREN_SIRET < {SIREN_SIRET_ROUTAGE,
  SIREN_SUFFIXE}` — ces deux derniers niveaux sont des **axes mutuellement
  exclusifs** traités à **rang égal**, le plus élevé de la hiérarchie ; deux
  mailles distinctes qui matcheraient au même rang lèvent
  `AmbiguousResolutionError` plutôt qu'un choix arbitraire (409 côté HTTP,
  sans jamais exposer les plateformes concurrentes).
- **Concurrence de lignes `D` à la même maille exacte** (le miroir F14 n'est
  pas contraint par l'unicité locale) : la `dateDebut` la plus récente
  l'emporte ; égalité stricte → `AmbiguousResolutionError` (interprétation
  A-RESOLVE-EDGES).
- **Masquage-repli** : une ligne `M` en vigueur retire de la résolution la/les
  Définition(s) de **même maille exacte**, mais ne bloque pas le repli vers
  une Définition **moins spécifique** restée en vigueur (ex. un masquage
  SIREN_SIRET laisse résoudre vers une Définition SIREN si elle existe) —
  interprétation non tranchée par la spec, retenue pour maximiser la
  délivrabilité.
- `GET /annuaire/resolution` renvoie **404 anti-fuite byte-identique** que le
  destinataire soit réellement inconnu, hors période d'effet, ou d'un
  **autre tenant** (RLS) — les trois cas sont indiscernables côté HTTP.

### Consentement (gate 422, D5/A-CONSENT)

`POST /annuaire/lignes` évalue le consentement **avant toute écriture** :
`consentId` référence un consentement déjà obtenu (couverture et
non-révocation vérifiées par le service, jamais une confiance aveugle en
l'identifiant fourni par le client) ; `proof` (sans `consentId`) enregistre un
**nouveau** consentement (append, jamais de mutation) ; sans les deux, une
publication précédente ayant déjà déposé un consentement couvrant la maille
est retrouvée automatiquement. Prédicat de couverture (interprétation go-live,
§3.5.5.5 non normative) : **même SIREN et maille égale ou plus large**
(`coversTarget`, la même notion que la résolution de routage) — un
consentement SIREN couvre toute maille de ce SIREN, un consentement
SIREN_SIRET_ROUTAGE ne couvre que la cible exacte SIRET+routage.

### Génération Flux 13 / parsing Flux 14 et validation XSD

`generateActualisationXml` (F13, xmlbuilder2) émet les lignes de **masquage
avant** les lignes de définition (F13 row 20, tri stable) et porte les
identifiants **imbriqués** sous `Identifiant`
(`InfoAdressageActualisationType`) ; `parseConsultationF14` (F14) valide
**avant** de parser et lit des identifiants **plats**
(`InfoAdressageConsultationType`) — les deux formes sont bien distinctes,
chacune ciblant son propre type XSD. Les deux XSD (`Annuaire_Commun.xsd` +
schémas F12-F13/F14) ne déclarent **aucun `targetNamespace`** : les instances
sont générées et lues **sans préfixe de namespace** (confirmé `xmllint`).

**Bug réel `xmlbuilder2@4.0.3` confirmé et contourné** : `end({format:
'object'})` ré-échappe `&`/`<`/`>` déjà échappés à la relecture DOM — corrigé
par `decodeXmlEntities` avant tout traitement applicatif du texte relu (sûr
pour toute donnée réaliste ; un cas pathologique d'entité `&amp;` littérale
doublement échappée n'est pas couvert — une lecture DOM lossless est notée
comme piste future, non implémentée).

**Qualifiant de routage `'9999'` — INTERPRÉTATION go-live à confirmer avec la
DGFiP/PPF avant mise en production** (`ROUTAGE_SCHEME_ID_PLACEHOLDER`,
`flux13-xml.ts`) : le XSD exige un attribut `@qualifiant` (`xs:token`,
`use="required"`) sur `IdRoutage` sans le contraindre par un pattern ;
l'ANNEXE 3 ne fixe qu'une contrainte **négative** (« ne peut pas prendre les
valeurs 0002 (SIREN) ou 0009 (SIRET) »), aucune valeur positive n'étant
normée dans la documentation disponible. `'9999'` satisfait la seule
contrainte structurelle connue — pas une valeur réglementaire vérifiée.

**Coercitions défensives à l'ingestion F14** (A-MIRROR-KEY) : `Nature` et
`TypeFlux` sont typés `xs:string` **non restreints** côté XSD — une valeur
hors `{D,M}`/`{C,D}`, **y compris un élément vide** (`<Nature/>` est
XSD-valide et désérialisé en objet vide par xmlbuilder2, normalisé par une
garde runtime), est rejetée de façon typée (`UnknownLigneNatureError`/
`UnknownTypeFluxError`, chemin log+skip du sync) avant d'atteindre toute
colonne enum ; un `<Suffixe/>` vide est traité comme **absent** (jamais
`''`, le piège des clés `coalesce`).
`DateFinEffective` (F14 seulement, DT-7-3-3) est portée jusqu'à l'ingestion,
qui calcule la fin **effective** (`min(dateFin, dateFinEffective)`) — une
ligne close par anticipation ne reste jamais résolue au-delà de sa fin
réelle (évite le sur-routage).

### Synchronisation bornée et ingestion Flux 14

`AnnuaireSweepService.sweepSync` (job répétable, `ANNUAIRE_SYNC_EVERY_MS`/
`ANNUAIRE_COMPLETE_EVERY_MS`) énumère les tenants actifs
(`find_annuaire_sync_targets`, fonction `SECURITY DEFINER` hors contexte
tenant, miroir `find_ereporting_declarants_due`) et enfile un job
`annuaire-sync` par tenant, `jobId` déterministe
`${tenantId}:${typeFlux}:${bucket}` (bucket = jour civil UTC, borne le
ré-enfilement — même discipline que 2.3). `AnnuaireSyncService.sync` :

- **Flux complet (`C`)** — **REMPLACE** le miroir du tenant
  (`replaceDirectoryEntries` : upsert **puis** suppression des entrées
  absentes du flux) : sans ce remplacement, le miroir dériverait vers des
  plateformes que le PPF a cessé d'annoncer.
- **Flux différentiel (`D`)** — **upsert seul, jamais de suppression** : un
  différentiel ne porte qu'un sous-ensemble de mouvements récents, le
  silence sur une maille ne signifie pas sa disparition.
- **F14 authentiquement vide → no-op** (jamais une suppression totale du
  miroir) : `LocalFilesystemAnnuaireStore` sert un F14 vide XSD-valide tant
  qu'aucun fixture réel n'a été déposé — traiter un flux vide comme un ordre
  de vidage serait dangereux. **Interprétation go-live documentée, limite
  assumée** : une désactivation **réellement totale et authentique** d'un
  annuaire côté PPF ne convergerait donc jamais vers un miroir vide par ce
  chemin (défaut sûr délibéré, pas un oubli).
- **Clé unique du miroir INCLUT `nature`** (A-MIRROR-KEY) : une ligne `D` et
  une ligne `M` de même maille×date ne s'écrasent jamais l'une l'autre.

### Persistance

Quatre tables tenant-scopées sous RLS **`ENABLE`+`FORCE`** (migrations `0018`
Drizzle / `0019`+`0020` hand) : `annuaire_consents` (preuves de consentement,
`SELECT`/`INSERT`/`UPDATE` — porte `revoked_at`, écrit par l'endpoint de
révocation depuis 3.6, § Révocation de consentement — 3.6),
`annuaire_lignes` (lignes publiées par ce tenant, `SELECT`/`INSERT`/`UPDATE`,
porteuses de l'index de slot A-DEADLOCK ci-dessus), `annuaire_ligne_events`
(journal **append-only**, `SELECT`+`INSERT` seulement) et
`annuaire_directory_entries` (miroir de consultation Flux 14,
`SELECT`/`INSERT`/`UPDATE`/`DELETE` — le seul `DELETE` du domaine, requis par
le remplacement complet ci-dessus).

## Runbook opérationnel — Annuaire Flux 13/14

Section dédiée aux **dettes opérationnelles** identifiées en revue (Tasks 8
et 9), à connaître **avant** toute exploitation réelle.

### Sweep de reprise des publications figées (« stuck-draft re-publish »)

**Symptôme.** Un crash exactement entre l'appel au port de transport
(`port.publish`, le F13 est déjà émis) et l'écriture `markPublished` laisse
une ligne en `draft` qui occupe **indéfiniment** son slot d'adressage
(A-DEADLOCK ci-dessus) sans qu'aucune requête HTTP ne puisse la faire
progresser.

**Résolution automatique livrée (Task 9).** `AnnuaireSweepService
.sweepStuckDrafts` énumère, tous tenants confondus, les lignes `draft` âgées
de plus de **15 minutes** (`find_stale_annuaire_drafts`, migration `0020`,
même discipline que le sweep de reprise d'archivage 2.2) et enfile un job
`annuaire-republish` par ligne. `AnnuairePublicationService.republishDraft`
**rejoue** le pipeline (génération → validation XSD → `port.publish` →
`markPublished`) à partir de l'état **persisté** de la ligne — jamais un
nouvel `insertLigne`. Idempotent **par construction**, sans code
supplémentaire dédié :

- le port est **write-once** par `publicationRef` (= id de la ligne) : si le
  F13 avait déjà été écrit avant le crash, ce second appel retrouve la clé
  déjà prise ;
- `markPublished` est un **CAS** (`WHERE status='draft'`) : si la ligne a
  entre-temps été publiée par un autre passage du sweep, le CAS échoue et
  c'est traité comme une résolution concurrente bénigne (`'skipped'`), pas
  une erreur.

**Résidu à connaître (INFO, pas un bug)** : si le crash original a eu lieu
**après** l'écriture réussie du F13 par le port, la re-publication renvoie le
**`trackingRef` d'origine** (comportement write-once voulu) — même si les
données de la ligne ont été mutées entre-temps par un autre chemin (cas
non observé en pratique, la ligne `draft` n'étant modifiable par aucun
endpoint HTTP), le `trackingRef` renvoyé resterait celui du **premier** F13
émis, pas d'un F13 recalculé sur les données actuelles.

### Libération de slot (rejetee/masked → redéfinition)

Une ligne `Définition` qui atteint un statut terminal (`rejetee` — F13
localement invalide au moment de la publication, ou `masked` — fin
d'adressage explicite) **libère** son slot (maille × `dateDebut`) : une
publication ultérieure sur exactement la même maille et la même date est
acceptée comme une **nouvelle** ligne. Tant qu'une ligne reste **active**
(`draft`/`published`/`deposee`), toute tentative de publication sur le même
slot est refusée en **409** — c'est une politique **user-driven** (le client
doit d'abord masquer/attendre le rejet) et non une réouverture automatique.

### Notes diverses

- **`consentId` requis même pour publier une ligne de Masquage (`nature:
  'M'`)** — lecture littérale du plan (le body `POST /annuaire/lignes` ne
  distingue pas `D`/`M` pour la gate consentement), acceptée telle quelle :
  masquer une maille exige donc la même preuve de consentement que la
  définir.
- **Consentement orphelin possible sur un scénario preuve+conflit** (LOW) :
  si `proof` est fourni et qu'un consentement équivalent existe déjà en
  parallèle (course), un consentement supplémentaire peut être inséré sans
  être jamais référencé par une ligne — n'aggrave aucune garantie de
  sécurité (la gate reste toujours vérifiée par couverture explicite), simple
  résidu de données.
- **`POST /annuaire/lignes` accepte `nature: 'M'` directement** (nit) : rien
  n'empêche un client de publier une ligne de Masquage comme première
  action sur une maille jamais définie — sans effet pratique (rien à
  masquer), mais un endpoint dédié « masquer une ligne existante »
  (`DELETE /annuaire/lignes/:id`) existe et est la voie normale.
- **`libxml2`/`xmllint` requis à l'exécution du worker** — même motif que
  l'e-reporting (2.3) : la validation XSD F13/F14 s'exécute en
  **runtime**, à chaque publication et chaque synchronisation, pas
  seulement en test/CI.

## Transmission des CDV (Flux 6) — 3.1

Le **Flux 6** transmet le **message CDV** (compte-rendu du cycle de vie
d'**une** facture, statuts 200-213 — § Cycle de vie CDV ci-dessus) au **PPF**
et à la **plateforme de réception** du destinataire — **distinct** de la
facture elle-même (Flux 1-9), de l'e-reporting (Flux 10, 2.3) et de
l'annuaire (Flux 13/14, 2.4). Sous-domaine `apps/api/src/cdv/*` : génération/
validation CDAR (`flux6-cdar.ts`), machine de **livraison** pure
(`cdv-transmission-lifecycle.ts`), fenêtre/échéance (`cdv-deadline.ts`),
persistance (`cdv-transmission.repository.ts`), port de transmission
(`cdv-transmission.port.ts`, `local-filesystem-cdv-store.ts`), service
d'émission (`cdv-transmission.service.ts`), frontière d'acquittement
(`cdv-status.service.ts`) et endpoints de consultation (`cdv.controller.ts`) ;
côté worker : `cdv-transmission-sweep.service.ts` (ordonnanceur 24h borné),
`cdv-transmission.processor.ts`/`.scheduler.ts` et `cdv-stuck-retry.service.ts`
(reprise des `parked`).

### Périmètre livré et honnêteté — lecture obligatoire

**LIVRÉ de bout en bout : la transmission des 4 statuts CDV obligatoires
(200/210/212/213) vers les deux cibles (PPF + destinataire), du déclenchement
par le journal scellé 2.2 jusqu'à l'acquittement et la consultation.**
**DIFFÉRÉS EXPLICITES — ne pas surpromettre « réseau Peppol livré »** :

- **Adaptateurs de transport réels** (`sftp`/`as2`/`as4`/`as4-peppol`/`api`)
  — `CdvTransmissionModule` lève une erreur explicite et testée tant qu'un de
  ces drivers est sélectionné sans implémentation ; seul `local` (write-once
  testable) est câblé en 3.1. Activation **au déploiement**.
- **Acquittements réseau/PPF réels** — `CdvStatusService.recordAck` est la
  **frontière** qu'un futur adaptateur webhook/Peppol appliquera ; elle est
  exercée **directement par les e2e** (aucune route HTTP entrante ne reçoit
  d'acquittement push dans ce plan — miroir exact `EreportingStatusService
  .recordPpfStatus`, 2.3).
- **Statuts CDV facultatifs** (10 des 14, hors socle obligatoire) et
  **ingestion d'un F6 entrant** (accusés de réception détaillés du réseau)
  — non transmis/consommés à ce jour, seuls les 4 statuts obligatoires
  sortants sont couverts.
- **Habilitation OpenPeppol** (adhésion, PKI test/prod, SMP, stack AS4) —
  aucune de ces briques n'existe dans ce plan ; le fallback Peppol (§2.3.10)
  reste une **cible**, pas une implémentation.
- **Aucune dette de dépendances** — `xmlbuilder2`/Node purs, réutilisés
  (aucun package ajouté pour le Flux 6).

**Aucun scellement ni signature au niveau message** (contraste avec 2.2,
même posture que 2.3/2.4) : le journal `cdv_transmission_events` est
**append-only** (grants `SELECT`+`INSERT` seulement) mais **non scellé** —
le scellement/PAF 2.2 protège le journal **CDV facture**
(`invoice_status_events`), pas ce journal de **livraison**, dont le SD de
balayage (ci-dessous) ne fait que **lire** le journal scellé sans jamais y
écrire.

### Format F6 / CDAR — validation structurelle (D3)

`generateFlux6Cdar` (`flux6-cdar.ts`) émet un message
`CrossIndustryApplicationResponse` au format sémantique **CDAR** (UN/CEFACT
SCRDM CI, Dossier général v3.2 §3.6.4 footnote 102, mapping vérifié contre
`Annexe 2 - Format sémantique FE CDV - Flux 6 - V2.3.xlsx`).

> ⚠️ **AUCUN XSD DGFiP pour le Flux 6/CDV/CDAR** (l'arbre
> `3- XSD_v3.2/` ne couvre que Annuaire + E-reporting + E-invoicing —
> `Changelog_XSD.md` n'énumère que ces 3 familles ; l'XSD UN/CEFACT CDAR
> externe n'est **pas vendorisé**). `validateFlux6Structure` est donc une
> validation **STRUCTURELLE EN CODE** (chemins obligatoires par présence de
> balises, code ∈ Tableau 8, horodates `^[0-9]{14}$`, `@schemeID` ∈ ICD 6523)
> — **pas** une validation de schéma. Contraste explicite avec les Flux
> 10/13/14 (2.3/2.4), qui **disposent** d'un XSD DGFiP réel (posture PAF,
> 2.2) — et donc `xmllint` n'est **pas** invoqué pour le Flux 6 (rien à
> valider contre).

**Sous-ensemble MINIMAL émis, honnêtement borné** :

- Parties (`Sender`/`Issuer`/`RecipientTradeParty`) nichées sous
  `/rsm:ExchangedDocument/` (amendement A2, corrigé contre le xlsx réel — le
  plan initial les plaçait à tort sous `AcknowledgementDocument`) ; champs de
  statut (MDT-78/87/105/126) sous `/rsm:AcknowledgementDocument/`.
- **MDT-74** (`MultipleReferencesIndicator`) — Requis 1..1, **valeur FIXE
  `'False'`**, premier enfant d'`AcknowledgementDocument` (revue Task 2,
  finding F-1 : initialement omis, corrigé + verrouillé par test).
- **MDT Requis-PPF NON émis** (interface figée du plan, à compléter si le
  PPF les exige à l'homologation) : **MDT-4, 5, 21, 40, 91, 95, 97**.
- **Issuer/Recipient optionnels** dans l'interface `Flux6Message`, alors que
  la source xlsx les note `R` (Requis, 1..n côté CDAR) — assoupli sciemment
  tant que l'adaptateur transport réel (différé) n'impose pas la forme
  finale ; à resserrer à l'homologation.
- **Namespaces `rsm:`/`ram:`/`udt:` — INTERPRÉTATION PROJET (amendement A1)**
  : l'Annexe 2 donne les chemins mais **aucune URN** (grep négatif exhaustif
  sur `urn:`/`xmlns` du classeur) — les URN suivent la convention UN/CEFACT
  CII/SCRDM standard, défendable mais non normée par la DGFiP ; sans effet
  sur `validateFlux6Structure` (structurel, pas XSD).
- **`601` — seul code F6 réellement documenté** (Annexe 2, onglet
  « Statuts », objet « message CDV (Flux 6) ») ; toute acceptation est
  **implicite** (aucune absence de rejet dans le délai ⇒ acquittement, cf.
  § Machine de livraison ci-dessous) — interprétation projet, D4/D7.
- **`CDV_INVOICE_PROFILE_ID = 'FACTURE'`** (MDT-3, colonne « Liste valeurs »
  vide dans l'Annexe 2, aucune valeur normée) — littéral stable identifiant
  le profil « cycle de vie facture » (par opposition à annuaire/e-reporting),
  à confirmer avec la DGFiP/PPF avant production (miroir
  `ROUTAGE_SCHEME_ID_PLACEHOLDER`, 2.4).

### Machine de livraison (distincte du CDV facture)

Cycle de vie de la **transmission** du message F6 (`cdv-transmission-lifecycle.ts`)
— **3ᵉ instance** de ce patron (miroir structurel de `ereporting-lifecycle.ts`
2.3 / `annuaire-lifecycle.ts` 2.4), **séparée sans conflation** du CDV facture
ci-dessus :

```
prepared → transmitted → { acknowledged (implicite) | rejected (601) }
parked  ⇄ (retry) transmitted   [ parked → rejected si sweep épuisé ]
```

- **Genèse** (`null → prepared`, hors table) à l'insertion de la ligne
  (Task 4) ; `acknowledged`/`rejected` sont **terminaux**, `parked` est
  **délibérément non terminal** — état d'attente **retryable** (destinataire
  non adressable/ambigu à la résolution annuaire), repris par le sweep
  `cdv-stuck-retry.service.ts`.
- **`code`** : seul `rejected` porte un code DGFiP réel (**601**) ;
  `prepared`/`transmitted`/`parked`/`acknowledged` portent `code: null`
  (jamais un code inventé pour un état interne à la plateforme — leçon
  2.3-A3).
- **Rejet LOCAL pré-envoi vs rejet PPF/réseau, désambiguïsés** : un F6
  structurellement invalide (bug de génération local) emprunte l'arête
  **réelle** `prepared → rejected` (ou `parked → rejected` sur reprise
  infructueuse), via `assertTransition` — **pas** un événement de genèse
  hors table (retouche de commentaire livrée en 3.1-T9, la logique T3/T6
  était déjà correcte, cf. `cdv-transmission-lifecycle.ts`) ; un rejet
  PPF/réseau porteur du 601 emprunte l'arête `transmitted → rejected`.

### Routage à deux cibles (PPF / destinataire) et résolution annuaire

`CdvTransmissionService.transmitStatus` fait progresser **deux cibles
indépendantes** par événement de statut obligatoire — **succès partiel au
grain** (facture × statut × cible) :

- **`ppf`** — toujours adressable, **aucune résolution** (matricule PPF
  interne, D7).
- **`recipient`** — résolu via `AnnuaireConsultationService.resolveRecipient`
  (2.4), maille dérivée du **`buyer`** de l'`Invoice` canonique
  (`buildMailleFromBuyer` : SIREN+SIRET si 14 chiffres, SIREN seul si 9,
  `''`→`undefined` — amendement A4) à la date `issueDate` (convertie
  ISO→AAAAMMJJ, `isoDateToYmd` — une comparaison lexicographique naïve avec
  le format ISO littéral aurait cassé silencieusement, corrigé en Task 6).
  Non-adressable/ambigu (`RecipientUnaddressableError`/
  `AmbiguousResolutionError`) ou buyer sans identifiant
  (`BuyerIdentifierMissingError`) → **`parked`** + reprise bornée
  (`cdv-stuck-retry.service.ts`), jamais un throw non typé absorbé à tort.

### Ordonnancement 24h et anti double-envoi (3 couches)

`CdvTransmissionSweepService` (job répétable, `CDV_SWEEP_EVERY_MS`) énumère,
**cross-tenant**, les événements de statut obligatoires dus via la fonction
`SECURITY DEFINER` `find_cdv_transmissions_due(p_since)` (migration `0022`,
**structurellement read-only** du journal scellé 2.2 — `LANGUAGE sql`, un
seul `SELECT`, jamais `seq`/`prev_hash`/`hash` projetés) et enfile un job
`cdv-transmission` par (facture, statut, **cible**). **3 couches de défense,
aucune suffisante seule** (miroir 2.3/2.4) :

1. **Fenêtre bornée** `dueSince(now, CDV_TRANSMISSION_LOOKBACK_MS)`
   (`cdv-deadline.ts`, défaut **48h = 2× le SLA 24h**, §3.6.6) — le sweep ne
   relit jamais tout le journal scellé, quelle que soit l'ancienneté du
   dernier passage réussi (**voir le runbook ci-dessous pour la limite de
   cette borne**).
2. **`jobId` déterministe** `${invoiceId}-${toStatus}-${target}` (séparateur
   `-`, jamais `:` — leçon 2.4) — BullMQ déduplique tant que le job existe
   dans Redis.
3. **Backstop base de données** — index unique `(invoice_id, to_status,
   target)` (migration `0021`) + `insertTransmission` idempotent (Task 4) :
   si les couches 1/2 laissent passer un doublon, `findResumable` le
   détecte et saute la transmission déjà `transmitted`/terminale.

**Échéance 24h (§3.6.6)** : `isPastDeadline` (`cdv-deadline.ts`) est un
**drapeau purement observationnel** (log de dépassement) — amendement A6,
**aucun** comportement de rejet ou de blocage n'en dépend ; le fuseau
(**UTC**, vs heure de Paris) reste une interprétation ouverte (§ Runbook).
`CdvStuckRetryService` (job répétable, `CDV_STUCK_RETRY_EVERY_MS`) reprend
les `parked` par lot **borné** (`RETRY_BATCH=100`, migration `0023`,
`find_parked_cdv_transmissions`, miroir `ArchiveRetryService` 2.2) —
rejeu **direct** dans le process worker (pas d'enfilement sur une file :
`transmitStatus` est idempotent par construction).

### Frontière d'acquittement (601 / acceptation implicite)

`CdvStatusService.recordAck(tenantId, transmissionId, outcome, actor, motif?)`
— miroir exact `EreportingStatusService.recordPpfStatus` (2.3) : **frontière**
applicable par un futur adaptateur réseau/Peppol, exercée directement par les
e2e. CAS atomique : l'`UPDATE` conditionne sur `status='transmitted'` — 0
ligne affectée (déjà terminale, jamais transmise, id inconnu ou cross-tenant,
invisible sous RLS `FORCE`) ⇒ **409**, transaction annulée **avant** tout
`INSERT` journal (**aucun événement fantôme**). Rejet (`outcome:'rejected'`)
exige un motif (MDT-126) — **422 avant toute écriture**, aucune tentative CAS
si absent.

**Endpoints** (dual-auth, `TenantAuthGuard` — clé API **ou** session, jamais
admin) :

- `GET /cdv/transmissions?invoiceId=…` — liste des transmissions d'une
  facture (résumés, **sans** le XML), `statusLabel`/`dgfipCode` (anti-fuite :
  `null` pour les états internes).
- `GET /cdv/transmissions/:id/xml` — XML `text/xml` (`null` si `parked`,
  résolution jamais aboutie) — 404 byte-identique inconnu/hors-tenant.
- `GET /cdv/transmissions/:id/events` — journal des statuts
  (`fromStatus`/`toStatus`/`motif`/`actor`), désambiguïsant rejet local
  (`actor:'platform'`, `fromStatus:'prepared'|'parked'`) vs acquittement
  réel (`actor:'ppf'|'recipient'`, `fromStatus:'transmitted'`).

### Persistance

Deux tables tenant-scopées sous RLS **`ENABLE`+`FORCE`** (migrations `0021`
Drizzle / `0022` hand) : `cdv_transmissions` (slot unique
`(invoice_id, to_status, target)`, **sans filtre partiel** — `rejected`
occupe le slot **à dessein**, cf. runbook) et `cdv_transmission_events`
(journal **append-only**, `SELECT`+`INSERT` seulement, **non scellé** — voir
§ Périmètre ci-dessus). Migration `0023` (hand) ajoute
`find_parked_cdv_transmissions` (`SECURITY DEFINER`, reprise bornée).

## Runbook opérationnel — Transmission CDV

Section dédiée aux **dettes opérationnelles** de la transmission CDV
(injections de revue Tasks 3/6/7/8), à connaître **avant** toute exploitation
réelle — mêmes principes que le runbook e-reporting (§ ci-dessus).

### Panne totale du worker CDV > 48h — rattrapage manuel requis

**Symptôme.** Le sweep ne regarde jamais plus loin que
`dueSince(now, CDV_TRANSMISSION_LOOKBACK_MS)` (défaut **48h**, 1ʳᵉ couche de
la défense anti-double-envoi ci-dessus). Si le worker (ou Redis) est
**indisponible pendant plus de 48h d'affilée**, un événement de statut
obligatoire dont l'horodate `created_at` (journal scellé 2.2) sort de cette
fenêtre au moment où le worker revient **ne sera plus jamais sélectionné**
par `find_cdv_transmissions_due` — **manqué silencieusement**, sans log
(`isPastDeadline` n'est évalué que sur les lignes effectivement retournées
par la requête, jamais sur celles qui n'y entrent plus). Le sweep reprend
normalement son activité, mais cet événement précis reste orphelin.

**Procédure manuelle de rattrapage** (jusqu'à un futur outil dédié — non
livré en 3.1) :

1. Identifier la fenêtre de panne exacte (logs worker/infra).
2. Requêter directement `invoice_status_events` (journal scellé 2.2, lecture
   seule) pour les statuts obligatoires (200/210/212/213) créés dans la
   fenêtre de panne, sans ligne `cdv_transmissions` correspondante
   (`(invoice_id, to_status)` absent des deux cibles).
3. Ré-enfiler manuellement (appel direct à
   `CdvTransmissionService.transmitStatus` en console d'administration, ou
   invoquer `find_cdv_transmissions_due` avec un `p_since` **élargi
   ponctuellement** au-delà des 48h par défaut) — geste d'exploitation
   explicite, jamais automatisé (élargir la fenêtre par défaut réouvrirait
   la protection anti-relecture totale du journal scellé, 1ʳᵉ couche
   ci-dessus).
4. Vérifier via `GET /cdv/transmissions?invoiceId=…` que la transmission
   rattrapée progresse normalement.

### `rejected` = terminal occupant le slot — faux-rejet : reset manuel hors-bande

Comme le slot A2 e-reporting (2.3), le slot unique `(invoice_id, to_status,
target)` **n'exclut pas** `rejected` : c'est ce qui garantit l'idempotence
anti-double-envoi (backstop DB, 3ᵉ couche ci-dessus) sur un crash entre
insertion et transmission. Conséquence assumée : `rejected` étant
**terminal** (`isTerminal`), une transmission qui y atterrit (601 réel, ou
born-rejetée sur F6 invalide) **occupe définitivement son slot** — **aucune
récupération in-band**. Si le rejet s'avère être un **faux-rejet** (601
erroné du réseau/destinataire, ou bug de génération local depuis corrigé),
la remise en circulation exige un **reset manuel hors-bande** (accès DB
direct, rôle propriétaire — comme la procédure du slot A2 e-reporting) ;
aucun endpoint de redrive n'est fourni en 3.1.

### 601 tardif après acceptation implicite — refus correct, sans événement fantôme

`acknowledged` (acceptation implicite) est **terminal** et **aucune** arête
`acknowledged → rejected` n'existe dans la machine de livraison (Task 3) : un
601 arrivant **après** que l'absence de rejet a été interprétée comme une
acceptation échoue en **409** (`CdvStatusService.recordAck`, CAS sur
`status='transmitted'`) **sans écrire d'événement** — comportement **voulu**,
pas un bug à corriger : l'interprétation projet (acceptation implicite, D4/D7)
ne permet pas à un rejet tardif de revenir sur un acquittement déjà réputé
acquis. À documenter côté exploitation (un 601 en échec 409 sur une
transmission `acknowledged` n'est pas une anomalie applicative).

### Horodate UTC vs heure de Paris — interprétation ouverte

`formatMessageHorodate`/l'horodate de statut sont calculés en **UTC**
(`getUTC*`), comme le précédent e-reporting « 08h00 UTC » (2.3, amendement
A6) — **à confirmer au go-live** si le PPF/Peppol attend une sémantique
heure de Paris pour l'échéance 24h ou l'horodatage du message MDT-8/MDT-78.

### Durcissement du rôle SD cross-tenant (dette sécurité, même motif 2.3/2.4)

`find_cdv_transmissions_due()` **et** `find_parked_cdv_transmissions()`
(fonctions `SECURITY DEFINER`) exposent, au rôle applicatif `factelec_app`
(partagé API + worker), la colonne `tenant_id` de **tous les tenants** — même
dette que `find_ereporting_declarants_due` (2.3) et
`find_annuaire_sync_targets`/`find_stale_annuaire_drafts` (2.4), **aucun
privilège supplémentaire réel** n'étant accessible depuis l'API HTTP
aujourd'hui (même rôle Postgres). **À durcir au déploiement**, dans le même
chantier de split du rôle worker que 2.3/2.4 (API et worker sur deux rôles
Postgres distincts, `EXECUTE` retiré au rôle HTTP) — non fait dans ce plan.

### Items Xavier (déploiement)

- **Achat AFNOR XP Z12-012** — seule source qui formalise la matrice de
  transitions CDV et ses sémantiques (§ Cycle de vie CDV ci-dessus).
- **Adhésion OpenPeppol + PKI test/prod + SMP + stack AS4** — préalable à
  tout adaptateur `as4-peppol` réel.
- **`CDV_PA_MATRICULE`** (ICD 0238) — matricule réel du PA à configurer
  avant production (défaut `'0000'`, placeholder dev/test).
- **Confirmation du code interface `FFE0614A`** — introuvable dans les
  sources primaires (Annexe 2 / Dossier général), présent seulement au
  dossier de recherche interne ; non contraignant dans ce plan (§3.4
  enveloppe / Chorus Pro, à vérifier avant prod).
- **Éventuelle vendorisation de l'XSD UN/CEFACT CDAR externe** — permettrait
  de faire passer `validateFlux6Structure` d'une validation structurelle en
  code à une validation `xmllint` réelle, si la DGFiP/UN/CEFACT publie un
  registre stable.

## Couture annuaire → émission de facture (routage destinataire) — 3.3

**Le trou fonctionnel hérité de 2.4** : l'annuaire (Flux 13/14) sait résoudre
le destinataire d'une facture (`AnnuaireConsultationService.resolveRecipient`,
2.4), mais **rien ne l'appelait** depuis le pipeline d'émission Flux 1-9.
Fermé en 3.3 : `RecipientRoutingService.resolveAndRecord`
(`src/invoices/recipient-routing.service.ts`) est appelé par
`InvoiceGenerationProcessor` (`src/worker/invoice-generation.processor.ts`),
**après** `archive.archiveInvoice(...)`, dernier pas d'un job de génération
déjà réussi.

### Point de couture : le worker de génération, pas l'ingestion HTTP (D1)

Quatre points de couture candidats (ingestion `POST /invoices`, contrôleur
HTTP, worker de génération, transition de cycle de vie) ont été évalués sur
trois critères : non-régression, sémantique d'erreurs, idempotence. Retenu :
**le worker**, parce qu'une résolution synchrone à l'ingestion couplerait le
chemin chaud HTTP à une lecture annuaire — soit en rejetant une facture
valide simplement non-routable *pour l'instant* (une ligne d'annuaire peut
entrer en vigueur plus tard), soit en dégradant la latence d'ingestion pour
une info molle sans effet persistant. Le worker résout **après** que la
génération a réussi : les formats du socle sont produits **exactement comme
avant** la couture, la résolution est un rider additif qui **ne peut jamais**
faire échouer l'émission.

### Best-effort strict — jamais throw, aucune mutation du CDV scellé (D2)

`resolveAndRecord` encapsule un **try/catch total**, miroir mot pour mot
d'`ArchiveService.archiveInvoice` (2.2) : une panne annuaire (opérationnelle)
ne fait **jamais** échouer un job de génération déjà réussi. Résoudre un
destinataire **≠** émettre **≠** transmettre : le résultat de résolution est
une **métadonnée de routage mutable** sur `invoices` (`routing_status`/
`recipient_platform`), **jamais** un événement écrit dans le journal
`invoice_status_events` (append-only et probatoire, scellé depuis 2.2) — la
mutation légitime vers `emise` (statut CDV 201) surviendra à l'**émission
réelle** (adaptateurs de transport, 3.4+, items Xavier), qui consommera
`recipient_platform`.

### Persistance : 2 colonnes additives, migration 0026 seule (D3)

Calque exact d'`archive_status`/`archive_location` (2.2) : `routing_status`
(`pgEnum` `'pending' | 'resolved' | 'unaddressable' | 'ambiguous'`,
`NOT NULL DEFAULT 'pending'`) et `recipient_platform` (`text`, nullable).
**Migration `0026_invoice_routing.sql` seule** — `CREATE TYPE` +
`ALTER TABLE invoices ADD COLUMN` ×2, **aucune** RLS/grant nouvelle
(`invoices` est déjà `ENABLE`+`FORCE`, `UPDATE` déjà accordé à
`factelec_app`, réutilisé par `markGenerationStatus`/`markArchiveStatus`).
Les factures antérieures à 3.3 obtiennent `'pending'` par défaut — honnête,
elles précèdent la fonctionnalité. Repo (miroir `markArchiveStatus`/
`findArchiveState`) : `markRoutingStatus(tenantId, invoiceId, status,
platform?)`, `findRoutingState(tenantId, invoiceId)`. Exposé en lecture
sur `GET /invoices/:id` (`InvoiceDetail`) **et**, depuis 3.4, sur
`GET /invoices` (§ Filtre de liste ci-dessous — **revert assumé** de la
restriction d'origine « on ne widen pas le DTO de liste », motivée à
l'époque par l'absence de consommateur ; le filtre **est** ce consommateur).

### Sémantique d'erreur de la résolution (D4)

| Résultat | Effet |
| --- | --- |
| Succès | `markRoutingStatus('resolved', plateforme)` |
| `RecipientUnaddressableError` | `markRoutingStatus('unaddressable')` + `logger.warn` (retriable — la ligne d'annuaire peut entrer en vigueur plus tard) |
| `AmbiguousResolutionError` | `markRoutingStatus('ambiguous')` + `logger.warn` (nécessite un nettoyage de l'annuaire par l'opérateur) |
| `BuyerIdentifierMissingError` (acheteur sans SIREN/SIRET, défensif — `partySchema.siren` est `.optional()`) | Traité comme `'unaddressable'` + `logger.warn` |
| Erreur **opérationnelle** (annuaire/DB indisponible) | `logger.error`, `routing_status` laissé **inchangé** (`'pending'`), **jamais** de throw |

**Idempotent** : un rejeu (retry BullMQ, réconciliation) re-résout et
**écrase** un résultat déterministe — aucun CAS, aucun journal, exactement
comme `markArchiveStatus`.

### ⚠️ AMENDEMENT M1 — SOLDÉ en 3.4 (sweep de reprise + filtre de liste)

**Rappel du trou 3.3, BINDING à l'époque.** Contrairement aux autres
best-effort du projet (`ArchiveRetryService` pour l'archive, le sweep
annuaire de 2.4), le routage n'avait **aucun** mécanisme de reprise
automatique en 3.3 : `InvoiceReconciliationService.sweep` ne balaie **que**
`received`/`generating` — une facture `generated` dont le routage est resté
`'pending'` après une panne annuaire **n'était jamais reprise**. Ce trou est
**soldé en 3.4** par deux livraisons indépendantes :

**1. Sweep de reprise (`RecipientRoutingRetryService`, worker), miroir EXACT
`ArchiveRetryService.sweepFailedArchives`** :

- **SD `find_pending_routing_invoices(p_limit)`** (migration `0028`,
  `SECURITY DEFINER` read-only, cross-tenant, motif `find_failed_archives`)
  sélectionne les factures `status='generated'` **et**
  `routing_status IN ('pending', 'unaddressable')` **et** `updated_at` âgé de
  plus de **15 minutes** (gate de fraîcheur — ne pas concurrencer une
  résolution en cours), triées par `updated_at`, bornées par un batch de 100.
- Pour chaque ligne : rejeu **direct** de `resolveAndRecord` (aucun
  enfilement, la résolution est idempotente par construction) —
  **best-effort strict**, la boucle ne throw jamais, une ligne en échec ne
  bloque jamais les suivantes.
- **`ambiguous` reste explicitement EXCLU** de la SD elle-même (D7,
  inchangé) : une ambiguïté d'annuaire est **structurelle**, elle nécessite
  un nettoyage opérateur — re-résoudre sans nettoyage re-échouerait à
  l'identique.
- **Anti-famine (amendement M-D7-1)** : le chemin d'erreur **opérationnelle**
  de `resolveAndRecord` (annuaire/DB indisponible) n'écrit rien —
  `updated_at` resterait figé et la ligne repasserait **en tête** de la
  requête `ORDER BY updated_at` à chaque cycle, affamant les suivantes. Le
  sweep applique donc un **touch** explicite après un échec opérationnel
  persistant : si le statut est resté `'pending'`, `markRoutingStatus(...,
  'pending')` est rappelé — écrasement **même-valeur**, seul `updated_at` est
  bumpé. Ce n'est **pas** un changement d'état, c'est la rotation équitable
  du batch ; la gate de fraîcheur 15 min sert ensuite d'espacement naturel
  entre deux tentatives sur la même ligne.
- **Cadence** : `ROUTING_RETRY_EVERY_MS` (défaut `300000`, 5 min — miroir
  `ARCHIVE_RETRY_EVERY_MS`), planifiée par `RoutingRetryScheduler`
  (`upsertJobScheduler`, idempotent) et dispatchée par la branche
  `ROUTING_RETRY_JOB` de `MaintenanceProcessor` (processor `maintenance`
  unique, pas un 2ᵉ `@Processor`).

**2. Filtre de liste** (Task 4, D8) : voir § Filtre de liste `routing_status`
ci-dessous — **l'ancienne requête SQL directe en base est retirée de cette
documentation**, devenue obsolète : `GET /invoices?routingStatus=` couvre
désormais le même besoin d'observabilité sans accès DB direct.

**Ce qui reste différé** (voir § Limites v1 / TODO) : backoff persistant du
sweep (colonnes `routing_attempts`/`routing_next_retry_at` — la rotation par
`updated_at` suffit tant qu'aucune churn réelle n'est observée) et filtre de
liste par `recipient_platform` (raffinement sans demande métier à ce jour).

### Filtre de liste `routing_status` + exposition du routage (3.4, D8)

`GET /invoices?routingStatus=` (query **optionnelle**, `z.enum` dérivé de
`routingStatus.enumValues` — source unique, jamais une liste recopiée)
filtre la liste paginée par statut de routage ; absente, elle laisse le
comportement **inchangé** (toutes les factures). Combinée au **curseur
keyset existant** via `and(keyset, statusFilter)` (drizzle ignore
silencieusement un filtre `undefined`) — la pagination micro-précise n'est
**pas** altérée, y compris lorsqu'un filtre est actif. Un `routingStatus`
invalide (valeur hors enum, y compris une **chaîne vide** `?routingStatus=`)
→ **422** ; un `routingStatus` valide sans résultat → page vide, jamais 404
(c'est une liste). Filtre appliqué **sous RLS**, aucune fuite cross-tenant.

`InvoiceSummary` expose désormais `routingStatus`/`recipientPlatform` — les
mêmes champs que `GET /invoices/:id`, `InvoiceDetail` en devient un **alias
sémantique** (§ Persistance ci-dessus). `GET /invoices/:id` reste inchangé.

### Extraction du helper *Party → Maille* (D5)

`buildMailleFromBuyer`/`isoDateToYmd`/`normalizeToUndefined`/
`BuyerIdentifierMissingError`, auparavant définis dans
`cdv-transmission.service.ts` (consommateur historique du cycle de vie CDV),
sont **déplacés** vers `src/annuaire/maille-from-buyer.ts` — extraction
**strictement comportement-préservante** (aucun changement de sortie, tests
CDV inchangés). Motif : séparation de domaine — l'émission (`invoices`/
`worker`) et le CDV (`cdv`) dépendent tous deux de l'**annuaire**
(fournisseur de la primitive *Party→Maille*), l'émission **ne doit jamais**
dépendre du domaine CDV (consommateur aval du cycle de vie, pas fournisseur
de primitives). `RecipientRoutingService` et `CdvTransmissionService`
importent désormais tous deux depuis `annuaire/maille-from-buyer.ts` — une
seule définition.

### `GET /annuaire/codes-routage?siren=` — énumération de gestion (D6)

**Le vrai trou de gestion HTTP comblé** : `GET /annuaire/lignes` (2.4) lit le
**miroir de consultation** (`annuaire_directory_entries` — ce que le tenant
peut *chercher*) ; **aucun endpoint** n'exposait `annuaire_lignes` (les
lignes que le tenant a lui-même **publiées**) — `listLignes` existait déjà
au repo, sans route.

`GET /annuaire/codes-routage?siren=` (dual-auth `TenantAuthGuard`, zod query
calqué sur `lignesQuerySchema`) renvoie `{ codes: [{ routageId, siret,
plateforme, status, dateDebut, dateFin }] }` : les codes-routage
**publiés par le tenant** (`annuaire_lignes` où `siren = …` **et**
`routageId IS NOT NULL`), **vue de gestion honnête** — **tous** les statuts
(`draft`/`published`/`deposee`/`rejetee`/`masked`), aucun filtre, à la
différence de `GET /annuaire/resolution` qui ne considère que ce qui est
effectivement adressable aujourd'hui. **Tableau vide, jamais 404**
(énumération) ; non-fuite RLS identique à `GET /annuaire/lignes` — un SIREN
d'un autre tenant renvoie un tableau vide, jamais une fuite d'existence.

**POST create autonome REFUSÉ** — décision ferme, pas un oubli : un
code-routage **n'est pas** une entité indépendante, c'est un composant de
maille (`SIREN_SIRET_ROUTAGE`) créé via `POST /annuaire/lignes` (2.4). Un
POST « create code » fabriquerait une entité absente du modèle et
dupliquerait le cycle de vie des lignes (aucune nouvelle table — contrainte
du plan). Réexaminable en 3.4+ si un besoin métier autonome émerge.

## Durcissements transverses — 3.3

Quatre durcissements 100 % code-interne (aucune extraction réglementaire
nouvelle), soldés dans le même plan que la couture ci-dessus.

### Validation UUID harmonisée — 404 anti-fuite byte-identique, jamais 500 (D7)

`isUuid` (regex `^[0-9a-f]{8}-…-…12$/i`, désormais `src/common/uuid.ts`,
source unique) était déjà appliqué en couche service pour
`invoices`/`lifecycle`/`api-keys` (404 **avant** toute requête SQL) mais
**absent** sur 4 contrôleurs (8 routes) qui passaient `:id` brut à
`eq(table.id, id)` (colonne `uuid`) — un cast Postgres échouait alors en
**500** :

- `cdv.controller` : `GET transmissions/:id/xml`, `GET transmissions/:id/events`
- `ereporting.controller` : `GET transmissions/:id/xml`, `GET transmissions/:id/events`
- `annuaire.controller` : `PUT lignes/:id`, `DELETE lignes/:id`
- `ledger.controller` : `GET :id/ledger`, `GET :id/paf`

Chaque contrôleur pose désormais `if (!isUuid(id)) throw <son 404 existant>`
**au point exact** où il produit déjà son 404, réutilisant la **même**
fabrique → **corps byte-identique** entre un `:id` malformé et un `:id`
inconnu/cross-tenant (anti-fuite préservée, prouvé `toEqual` en e2e).
`ledger.controller` n'avait **pas** de fabrique `notFound()` réutilisable
(404 dupliqué inline) : extraite d'abord en fabrique locale
(comportement-préservant), `isUuid` branché ensuite.

### Erreurs CAS typées — `CasStaleError` remplace 3 regex divergentes (D8)

**État antérieur, fragile** : trois déclarations distinctes de
`CAS_STALE_RE`, aux **regex divergentes**
(`/is not in 'transmitted' status/` vs `/is not in '.*' status/`), chacune
faisant `.test(err.message)` sur une `Error` générique — couplage
service↔wording du repo, assumé mais fragile.

`CasStaleError` (`src/common/cas-error.ts`, `extends Error`, champs
`readonly { entity, id, expectedStatus }`, message conservé dans `super(...)`
pour les logs) est désormais levée aux **7 sites CAS des repos**
(`cdv-transmission.repository.ts` ×3, `annuaire.repository.ts` ×2,
`ereporting.repository.ts` ×2) au lieu du `throw new Error(...)` textuel. Les
services catchent `instanceof CasStaleError` — **suppression** des 3
`CAS_STALE_RE`.

**Sortie HTTP strictement inchangée — 5 catch, 3 sorties distinctes**
(amendement M2, inventaire exhaustif) :

| Site | Sortie inchangée |
| --- | --- |
| `cdv-status.service` | **409** |
| `ereporting-status.service` | **409** |
| `annuaire-publication.service` / `recordAck` | `throw StaleLigneTransitionError` |
| `annuaire-publication.service` / `maskLigne` | `throw StaleLigneTransitionError` |
| `annuaire-publication.service` / `republishDraft` | `return 'skipped'` |

Seule la **détection** passe du texte au type ; la conflation voulue
« stale / id inconnu / cross-tenant » (indiscernable côté HTTP) est
préservée.

### Verrou d'architecture apiKeyId — un RALENTISSEUR, pas une barrière (D9 + amendement M3)

**Le footgun** : `req.apiKeyId`, posé par `api-key.guard.ts`/
`tenant-auth.guard.ts` **après** vérification cryptographique de la clé API,
est lu pour **bypass** par `csrf.guard.ts`/`roles.guard.ts`
(`if (req.apiKeyId) return true`) sur la seule route dual-auth-mutation à ce
jour (`POST /payments`, 3.2). Un **nouveau** code posant/lisant `apiKeyId`
hors de ces 4 fichiers court-circuiterait silencieusement un contrôle de
rôle/CSRF attendu.

`apps/api/tests/unit/apikeyid-setters.arch.test.ts` grep-structurel les
sources : (1) **seuls** `api-key.guard.ts`/`tenant-auth.guard.ts` peuvent
**écrire** `apiKeyId` ; (2) **seuls** `roles.guard.ts`/`csrf.guard.ts`
peuvent le **lire** pour bypass — 3 formes syntaxiques minimum matchées
(`.apiKeyId =`, `['apiKeyId'] =`, `["apiKeyId"] =`, idem en lecture), sur
**tout** `apps/api/src`, pas seulement les guards.

**⚠️ Honnêteté (amendement M3, BINDING)** : ce test est un **RALENTISSEUR**,
**pas** un « asservissement » — un grep multi-formes reste contournable par
un renommage de propriété, un helper construisant l'objet ailleurs, ou toute
transformation n'empruntant aucune des formes syntaxiques matchées. Il
échoue volontairement au moindre nouveau poseur/lecteur **textuel** — son
seul objectif est de ralentir une régression silencieuse, pas de la rendre
impossible. La **vraie** barrière d'exécution — un garde composé
`DualAuthMutationGuard` encapsulant « clé API OU session ; si session → rôle
∈ X ET CSRF » — reste **différée** (friction NestJS-idiomatique, touche les
routes qui marchent) malgré l'apparition d'une **seconde** route
dual-auth-mutation en 3.4 (`POST /ereporting/retransmissions`, même motif
exact que `POST /payments`) : le critère de déclenchement initial est
atteint, la factorisation reste un choix différé, pas un oubli.

**+ unification de type** : `apiKeyId?: string` vit désormais en **une
seule** source (`WithApiKeyId`, `src/auth/auth.types.ts`), réutilisée par
`SessionRequest`/`TenantRequest` — **pas** une augmentation globale
`declare module 'express'` (élargirait `apiKeyId` à **toute** `Request` du
projet, l'inverse de l'objectif), une interface **étroite** explicitement
importée par les seuls guards concernés. Zéro changement de comportement
runtime.

**Second verrou, sibling (3.5, amendement M1)** : ce verrou couvre le footgun
`apiKeyId` (bypass illégitime) mais n'assertait **rien** sur la
**composition** des guards d'une route — un guard entier peut être **omis**
sans que ce test ne le voie. Voir § Verrou d'architecture — composition
dual-auth (M1) dans la section Consentement scellé, rôle worker &
re-résolution ambiguous — 3.5 ci-dessous : c'est exactement ce résidu que
l'extension M1 a mis au jour, sur une faille **réelle** (annuaire, héritée de
2.4).

### Stabilisation e2e — teardown idempotent + split Vitest heavy/light (D10/D11)

**Teardown idempotent du pool** (`DbModule.onModuleDestroy`) : `pg-pool`
rejette « Called end on pool more than once » si `end()` est rappelé — NestJS
peut invoquer les hooks de shutdown plusieurs fois selon la combinaison de
signaux OS reçus. Garde `private ended = false` : double-destroy = no-op.
`createPool` (`src/db/client.ts`) ajoute un écouteur `pool.on('error', …)`
qui **avale et journalise** (jamais throw) le bruit `57P01` (admin shutdown)
émis par une connexion inactive pendant le teardown testcontainers.

**Split Vitest `heavy`/`light`** (`test.projects`, natif Vitest 4,
`vitest.config.ts`) : les **8 suites** qui démarrent Postgres + Redis + des
Workers BullMQ (chacune = un jeu **complet** de conteneurs testcontainers) —
plus `invoice-routing.e2e.test.ts` (Task 2, même profil lourd) — tombent
dans le projet `heavy`, exécuté en **série** (`fileParallelism: false`, au
plus un jeu de conteneurs lourds à la fois : élimine la source dominante de
la contention testcontainers observée depuis 3.2). Tout le reste
(Postgres-seul/léger) reste dans `light`, parallèle. **Sans retry** — la
contention est traitée à la racine, pas masquée.

**⚠️ Amendement m6 (BINDING)** : en `test.projects`, la config racine **ne
cascade pas** vers les projets (`extends: false`, comportement Vitest 4 par
défaut) — `setupFiles`/`hookTimeout`/`testTimeout` sont **redéclarés dans
chaque projet** (sans quoi `tests/setup.ts`, qui pose `DATABASE_URL`/
`LOG_LEVEL`/`*_LOCAL_DIR` **avant** le chargement eager de `ConfigModule`,
cesserait silencieusement de s'appliquer — rupture d'hermétisme). Seule
`coverage` reste définie une fois à la racine (Vitest l'exige au niveau
racine, non supporté en config de projet) ; les seuils s'appliquent à
l'**agrégat** heavy+light.

**⚠️ Amendement m7 (BINDING) — fallback appliqué** : `maxWorkers: 5` (aligné
CI) a **re-flaké en pratique** lors de la vérification empirique — le VM
Docker local mesure exactement **5 vCPU** (`docker info`), et 5 conteneurs
Postgres démarrés simultanément saturent le budget CPU du démon ;
`invoices-repository.e2e.test.ts` (un des 4 fichiers historiquement flaky
3.2 — avec `health-redis`/`paf-export`/`annuaire-consultation`, explicitement
surveillés) **et 2 autres suites `light`** ont échoué simultanément sur
« Timed out … while waiting for container ports to be bound to the host ».
**Fallback documenté et appliqué** : `maxWorkers: 3` pour le projet `light`
(headroom sous le plafond Docker), plutôt que de conclure « vert » sur un
run simplement plus chanceux.

## Consentement scellé, rôle worker de moindre privilège & re-résolution ambiguous — 3.5

Trois axes **strictement internes au code**, aucune extraction réglementaire
nouvelle (le consentement annuaire a déjà ses références 2.4, §3.5.5.5) : (1)
scellement structurel du consentement annuaire, (2) séparation du rôle
Postgres du worker, (3) endpoint de re-résolution manuelle d'un routage
`ambiguous` (solde F-2/3.4, § Runbook opérationnel — E-reporting ci-dessus).
Un **épisode sécurité non planifié** (faille héritée de 2.4, révélée en
cours de Task 4, close en Task 4bis) est documenté séparément ci-dessous.

### Scellement structurel du consentement annuaire (D1-D3)

**Ce que c'est — lire avant tout.** `ConsentSignaturePort`
(`src/annuaire/consent-signature.port.ts`, 5ᵉ instance du motif port du
projet, réplique exacte du gabarit CDV 3.1/Annuaire 2.4/Flux10 2.3/Archive
2.2) scelle la preuve de consentement déclarée par le client à la
publication d'une ligne d'annuaire (`POST /annuaire/lignes`) : intégrité
**SHA-256** de la forme canonique de la preuve, **horodatage** (`sealedAt`,
`AAAAMMJJHHMMSS` UTC) et **écriture write-once**
(`LocalFilesystemConsentStore`, `flag: 'wx'` + `chmod 0o444`). `verify(sealRef)`
relit le fichier et recalcule le SHA-256 : une altération du contenu scellé
est détectée (`ConsentSignatureRejectedError`), une clé inconnue aussi
(`ConsentSealNotFoundError`).

**⚠️ Ce que ce n'est PAS.** **Aucune vérification cryptographique de
signature. Aucune valeur probante. Aucune signature électronique qualifiée
eIDAS.** Le driver `local` scelle une preuve **déclarée** — il n'authentifie
ni le signataire, ni le contenu métier de la preuve, ni son origine. Les
**fournisseurs eIDAS réels** (signature qualifiée) sont des **drivers
différés** : `CONSENT_DRIVER=eidas` lève une erreur explicite et testée tant
qu'aucun adaptateur n'est fourni (`ConsentSignatureModule`, motif
`AnnuaireTransportModule`/`CdvTransmissionModule`) — **item Xavier**,
activation au déploiement.

**Point d'insertion — à la CRÉATION du consentement (D3).** Le scellement
s'insère dans l'**unique** frontière client→DB déjà identifiée par le
projet : la branche `proof` de `resolveConsent`, appelée par
`AnnuairePublicationService.publishLigne` **avant** `insertConsent`. Les
chemins `consentId` (référence à un consentement déjà persisté) et
l'auto-découverte n'apportent **aucune** preuve fraîche — rien à sceller,
seules la couverture (`coversTarget`) et la non-révocation
(`revokedAt IS NULL`) sont vérifiées, **inchangé**. Une preuve non scellable
(driver eIDAS différé sélectionné, ou intégrité rejetée) fait échouer la
publication — `ConsentSignatureError`, mappée au **même 422** que
`ConsentRequiredError` (`AnnuaireController.mapPublicationError`), la ligne
d'annuaire n'est **pas** créée.

**`evidence_ref` = sceau, pas la preuve brute.** La colonne
`annuaire_consents.evidence_ref` (déjà `notNull`, placeholder non lu par
aucune logique avant 3.5) est **repurposée** en pointeur vers le sceau
(`sealRef`, SHA-256 vérifiable) — **aucune nouvelle colonne ni migration de
schéma**. L'`evidenceRef` client d'origine n'est pas perdu : il fait partie
de la forme canonique scellée (WORM), relisible via `verify`.

**Idempotence du scellement (revue T1 → correctif BLOQUANT F1, fixé).**
`sealRef = sha256(forme canonique de la PREUVE MÉTIER SEULE)` — `sealedAt`
**n'entre PAS** dans ce hash. Rejouer la même preuve (ex. republication après
nettoyage annuaire) produit le **même** `sealRef`, y compris à horloge
différente : `seal()` retombe sur la clé write-once existante et renvoie le
`sealedAt` du **premier** scellement (fait constaté, jamais recalculé). Sans
cette séparation, deux scellements de la même preuve à des secondes
différentes auraient produit deux sceaux distincts — aucune déduplication
possible.

**Observation consciente — `sealedAt` hors enveloppe d'intégrité (revue T1,
documentée volontairement).** `sealedAt` est une **métadonnée
opérationnelle** écrite à côté du contenu scellé, mais **hors** de ce qui est
vérifié par `verify()` : une altération du seul `sealedAt` (sans toucher la
preuve canonique) ne serait pas détectée. Arbitrage assumé : `obtainedAt`
(l'horodatage juridiquement signifiant, déclaré par le client) **est**, lui,
dans l'enveloppe scellée ; `sealedAt` (l'instant technique de scellement côté
plateforme) ne l'est pas, protégé seulement par l'immuabilité WORM
(`chmod 0o444`) — pas par le hash. Réévaluable si un besoin futur l'exige.

**Stock legacy — consentements pré-3.5 NON scellés (L2, honnêteté).** Les
consentements créés **avant** ce plan portent un `evidence_ref` **libre**,
jamais scellé (l'ancien comportement — écriture verbatim de la chaîne
client, sans vérification). **Aucune migration rétroactive** ne les scelle :
un `evidence_ref` non-hash-vérifiable dans le stock existant est **normal**,
pas une anomalie. Seuls les consentements créés **depuis** 3.5 portent un
sceau vérifiable.

### Rôle `factelec_worker` de moindre privilège (D4/D5)

Le rôle applicatif `factelec_app` était jusqu'ici **partagé** par le process
API et le process worker (§ Rôles Postgres) — un accès offert au worker
(génération, sweeps) était donc aussi offert à la surface HTTP, et
réciproquement. 3.5 introduit **`factelec_worker`**, un rôle Postgres dédié
de moindre privilège, **dérivé de l'inventaire RÉEL** des accès effectivement
exercés par le worker (5 processors + sweeps câblés dans `WorkerModule`,
`worker-main.ts:10`) — **aucun** grant par anticipation, **aucune**
table/colonne/policy nouvelle.

**Grants — migration `0029_worker_role_grants.sql` (hand-written, motif
`0001`/`0019`, PAS dérivée du schéma) :**

| Table | Grants worker | Jamais |
| --- | --- | --- |
| `invoices` | `SELECT`, `UPDATE` | `INSERT`, `DELETE` |
| `invoice_formats` | `SELECT`, `INSERT`, `DELETE` | — |
| `invoice_status_events` | `SELECT` seul | `INSERT` (le trigger de scellement ne s'exécute jamais côté worker) |
| `invoice_dead_letters` | `INSERT` seul | — |
| `ereporting_declarants` | `SELECT` seul | — |
| `ereporting_transmissions` | `SELECT`, `INSERT`, `UPDATE` | — |
| `ereporting_status_events` | `INSERT` seul | — |
| `annuaire_lignes` | `SELECT`, `UPDATE` | `INSERT` |
| `annuaire_ligne_events` | `INSERT` seul | — |
| `annuaire_directory_entries` | `SELECT`, `INSERT`, `UPDATE`, `DELETE` | — |
| `cdv_transmissions` | `SELECT`, `INSERT`, `UPDATE` | — |
| `cdv_transmission_events` | `INSERT` seul | — |
| `payments`, `payment_subtotals` | `SELECT` seul | — |
| `tenants`, `api_keys`, `users`, `platform_admins`, `sessions`, `annuaire_consents` | **AUCUN** | tout |

Plus `EXECUTE` sur les **9 seules** fonctions `SECURITY DEFINER` réellement
appelées par le worker (`find_stuck_generation_invoices`,
`purge_expired_sessions`, `find_failed_archives`,
`find_ereporting_declarants_due`, `find_annuaire_sync_targets`,
`find_stale_annuaire_drafts`, `find_cdv_transmissions_due`,
`find_parked_cdv_transmissions`, `find_pending_routing_invoices`) — **jamais**
les 8 SD auth/session/admin (`authenticate_api_key` compris : refus `42501`
prouvé en e2e), **jamais** `find_stuck_received_invoices` (superseded).

**RLS active sous le nouveau rôle — sans policy nouvelle.** Toutes les
policies RLS du projet sont créées **sans clause `TO`** (donc implicitement
`TO PUBLIC`) — elles s'appliquent automatiquement à `factelec_worker`, qui
est `NOBYPASSRLS` (comme `factelec_app`) et donc soumis à
`FORCE ROW LEVEL SECURITY`. **Preuve empirique, pas seulement documentaire** :
un négatif cross-tenant dédié tourne sous `factelec_worker` (revue T3, NIT-1)
— l'isolation RLS **du rôle** est démontrée, pas seulement héritée par
construction.

**Split pool/env (D5).** `DbModule.forRoot('DATABASE_URL' | 'DATABASE_URL_WORKER')`
sélectionne la clé env **à la construction du module** — l'API
(`AppModule`/`main.ts`) et le worker (`WorkerModule`/`worker-main.ts`)
démarrent chacun leur **propre** arbre Nest, jamais les deux dans le même
process, donc jamais de conflit. `DATABASE_URL_WORKER` est **optionnelle** au
schéma zod (`env.ts`) — l'API n'en a pas besoin — mais `WorkerModule`
l'importe **inconditionnellement** : le worker throw explicitement si elle
est absente à son bootstrap.

**⚠️ `factelec_app` conserve tous ses grants historiques (honnêteté).** La
migration `0029` n'effectue **aucun** `REVOKE` sur `factelec_app` — elle
n'ajoute que des `GRANT` sur le nouveau rôle worker. Concrètement,
`factelec_app` garde aujourd'hui `EXECUTE` sur les 9 fonctions `SECURITY
DEFINER` cross-tenant ci-dessus, alors même que le worker (le seul appelant
réel) ne s'exécute plus sous ce rôle depuis cette version. La séparation des
privilèges **bénéficie au worker** (surface d'attaque du process worker
réduite à l'inventaire réel) ; elle **ne réduit pas encore** celle de
`factelec_app` — un `REVOKE` de suivi sur `factelec_app` serait un
durcissement supplémentaire légitime, non fait ici (hors périmètre D8 : une
seule migration, grants additifs seuls).

**Provisioning — ordre requis, item Xavier.** Le rôle `factelec_worker` est
créé par `scripts/db-init/00-roles.sql` en dev/test (et inline par le
harnais e2e, `tests/e2e/helpers/postgres.ts`, **avant** `migrate()` —
amendement B1 de la revue du plan : sans cette création préalable, la
migration `0029` échouerait dans **chaque** e2e, la migration ne faisant que
des `GRANT` sur un rôle supposé exister). **En production, ce rôle n'existe
pas par défaut** : avant de déployer cette version, il faut provisionner
`factelec_worker` (création du rôle + secret + `DATABASE_URL_WORKER`),
**exactement comme `factelec_app`** l'a été au déploiement initial — sinon
(a) la migration `0029` échoue à l'application, **et** (b) le process
worker refuse de démarrer (`DATABASE_URL_WORKER requis pour le process
worker`). **Runbook : créer le rôle `factelec_worker` AVANT d'appliquer la
migration `0029`.** Le **déploiement effectif** (bascule confirmée du
process worker, rotation du secret) reste un **item Xavier**, non livré par
ce plan.

### Re-résolution manuelle d'un routage `ambiguous` (D6)

`POST /invoices/:id/routing/resolve` (dual-auth, `TenantAuthGuard` +
`RolesGuard` + `CsrfGuard`, `@Roles('owner','admin','accountant')` — **triple
verbatim**, motif exact `PaymentsController.capture`/
`EreportingController.retransmit`) solde la limite F-2/3.4 (§ Runbook
opérationnel — E-reporting) : jusqu'ici, un routage `ambiguous` (annuaire
portant plusieurs plateformes candidates pour la même maille) n'avait
**aucune** voie de sortie automatique après nettoyage humain de l'annuaire.

**Logique (`InvoicesService.resolveRouting`) :** (1) `:id` invalide ou
facture inconnue/hors tenant → **404 byte-identique** ; (2)
`routing_status !== 'ambiguous'` → **409** (« Routing not in ambiguous state »
— n'admet **que** l'état `ambiguous`, `pending`/`unaddressable` restent
couverts par le sweep automatique 3.4) ; (3) réutilisation **verbatim** de
`RecipientRoutingService.resolveAndRecord` (même fonction que le worker de
génération 3.3 et le sweep 3.4 — aucune logique de résolution dupliquée) ;
(4) relecture de l'état et retour **synchrone, `200`** — divergence assumée
du `202` de `retransmit` : c'est un appel **direct** (une lecture annuaire +
un `UPDATE`), sans file, jamais un job lourd enfilé.

**⚠️ Honnêteté (L1, amendement BINDING revue du plan) — lire avant
d'exploiter.** `resolveAndRecord` est **best-effort strict**, il ne relève
**jamais**. L'endpoint rapporte donc l'état **obtenu**, pas une garantie de
succès : un `200` dont le corps reste `routingStatus: 'ambiguous'` est
**indistinguable** entre (a) l'annuaire n'a **pas** (suffisamment) été
nettoyé, et (b) une panne opérationnelle **pendant** la re-résolution
(annuaire/DB transitoirement indisponible). **Procédure recommandée** en cas
de `ambiguous` persistant après appel : re-vérifier le nettoyage annuaire,
**re-tenter** l'appel (idempotent), ou consulter les logs applicatifs pour
distinguer les deux cas — aucune télémétrie dédiée ne les distingue
aujourd'hui.

**Procédure de sortie d'`ambiguous`** (remplace le F-2 du runbook 3.4) : (1)
nettoyer l'annuaire — masquer/republier la ligne en trop, lever l'ambiguïté
structurelle ; (2) appeler `POST /invoices/:id/routing/resolve` ; (3) lire
l'état retourné : `resolved` = nettoyage effectif, `ambiguous` = relire §
honnêteté L1 ci-dessus, `unaddressable`/`pending` = repris automatiquement
par le sweep 3.4 dès le prochain cycle.

### ÉPISODE SÉCURITÉ — faille annuaire héritée de 2.4, close en Task 4bis (lecture obligatoire)

**Découverte, pas fabrication.** L'amendement M1 de la revue du plan
(extension du verrou d'architecture à la **composition** des guards, voir §
Verrou d'architecture — composition dual-auth ci-dessous) a révélé, **avant
même sa propre livraison**, que les 3 mutations d'`AnnuaireController`
(`POST lignes` / `PUT lignes/:id` / `DELETE lignes/:id`, héritées de 2.4
Tasks 7/8) composaient **`TenantAuthGuard` SEUL** — sans `RolesGuard` ni
`CsrfGuard`. Concrètement : **une session utilisateur de N'IMPORTE QUEL
rôle, `viewer` inclus, pouvait publier/modifier/masquer une ligne d'annuaire
sans jeton CSRF**, aucun garde CSRF global n'existant par ailleurs (vérifié
`main.ts`/`app.module.ts`). Faille **pré-existante depuis 2.4**, pas
introduite par ce plan — révélée par l'extension du verrou, pas créée par
elle.

**Fermée par Task 4bis, TDD RED prouvé.** Les 3 routes composent désormais
le **même triple** que toutes les autres mutations dual-auth du projet :
`@UseGuards(TenantAuthGuard, RolesGuard, CsrfGuard)` +
`@Roles('owner', 'admin', 'accountant')`. La preuve RED est **exemplaire** :
les 6 e2e négatifs (viewer authentifié, et owner/admin/accountant **sans**
jeton CSRF, sur les 3 routes) ont **réellement exécuté** les mutations
**avant** le correctif (la faille était démontrée, pas supposée) — **403**
après. Le verrou d'architecture étendu passe désormais **sans aucune
exclusion** (liste `KNOWN_PRE_EXISTING_GAPS` vidée).

**Aucun appelant existant affecté.** Tous les appels de production/tests aux
mutations annuaire transitaient par **clé API** — la faille n'était
exploitable **qu'en session utilisateur**, un vecteur non exercé par les
intégrations existantes.

**Ce qui change pour un intégrateur.** `POST/PUT/DELETE /annuaire/lignes*`
restent **dual-auth** (clé API **ou** session) — une clé API continue de
fonctionner sans changement. Une session utilisateur doit désormais fournir
un rôle `owner`/`admin`/`accountant` (un `viewer` est **refusé, 403**) **et**
un jeton CSRF valide (`X-CSRF-Token`) — auparavant accepté sans l'un ni
l'autre.

### Verrou d'architecture — composition dual-auth (M1) : un second RALENTISSEUR, pas une barrière

`apps/api/tests/unit/dual-auth-composition.arch.test.ts` (fichier **frère**
d'`apikeyid-setters.arch.test.ts`, même famille de motif) asserte que
**toute** route de mutation (`@Post`/`@Put`/`@Delete`) composant
`TenantAuthGuard` compose **aussi** `RolesGuard` **et** `CsrfGuard`,
`TenantAuthGuard` **en tête** — le résidu qu'`apikeyid-setters.arch.test.ts`
(§ ci-dessus) ne couvre pas : celui-ci verrouille le **footgun `apiKeyId`**
(bypass illégitime), pas l'**omission pure et simple** d'un guard entier.

**⚠️ Honnêteté (même motif M3 que le verrou apiKeyId, NIT-1 revue T4).** Scan
**textuel** du bloc de décorateurs immédiatement au-dessus de chaque méthode
de contrôleur (un seul `@UseGuards(...)` par méthode, formes réelles et
actuelles du projet) — **contournable** par un guard posé autrement (garde
composée custom, `APP_GUARD` global, `@UseGuards` reconstruit dynamiquement,
guards de classe combinés à des guards de méthode — cf.
`api-keys.controller.ts`, hors scope car il ne compose jamais
`TenantAuthGuard`). Ce test ne prétend détecter **que** le motif
`@UseGuards(...)` réel du projet, pas une preuve d'impossibilité
structurelle — un **tripwire** immédiat sur régression textuelle, pas un
verrou d'exécution.

**Preuve indépendante (revue groupée T4+T4bis, Opus).** Grep indépendant du
relecteur = **6** mutations `TenantAuthGuard` toutes conformes, **0** faux
positif ; snapshot figé des 6 routes qualifiantes (3 annuaire + `retransmit`
+ `resolveRouting` + `capture`) — toute route future ajoutée ou modifiée sans
les 3 guards casse le test **immédiatement**.

**Étendu 6→7 en 3.6** : `revokeConsent` (4ᵉ mutation annuaire, § Révocation
de consentement — 3.6) ajoutée à l'énumération, RED de morsure constaté
avant l'ajout (la route non énumérée faisait échouer `it('le scan repère
…')`), puis GREEN.

### Différés 3.6+ (D9)

- **Fournisseurs eIDAS réels** (`CONSENT_DRIVER=eidas`) — item Xavier, throw
  testé tant que non fourni.
- **Déploiement du rôle worker** — provisioning prod de `factelec_worker`
  (secret + `DATABASE_URL_WORKER`), puis un `REVOKE` de suivi sur
  `factelec_app` (§ ci-dessus, honnêteté) — item Xavier.
- **Révocation de consentement** (endpoint/service) — la colonne
  `revoked_at` existe et est respectée à la lecture (héritée 2.4). **Livrée
  en 3.6** (`POST /annuaire/consents/:id/revoke`) — voir § Révocation de
  consentement — 3.6 ci-dessous.
- **Garde composé `DualAuthMutationGuard`** — refusé **à nouveau** ce plan
  (D7, ratifié en **voie médiane** par l'amendement M1 ci-dessus) : le
  résidu **grave** que ce garde composé aurait pu prévenir (omission pure
  d'un guard, pas seulement le footgun `apiKeyId`) est désormais couvert par
  le second verrou d'architecture (§ ci-dessus). Le seuil « 4ᵉ+ route »
  évoqué en 3.3/3.4 est **largement dépassé** (6 routes qualifiantes
  aujourd'hui : 3 mutations annuaire + `retransmit` + `resolveRouting` +
  `capture`) sans que la répétition du triple manuel se soit révélée
  coûteuse en pratique — réexaminable si elle le devenait.
- **Transition `emise`/transport réel**, **backoff persistant du sweep
  routage**, **`POST /annuaire/codes-routage` autonome** — inchangés depuis
  3.3/3.4, voir §§ correspondantes.

## Révocation de consentement — 3.6

Écrit le seul axe encore manquant du cycle de vie du consentement annuaire
(2.4/3.5) : la colonne `annuaire_consents.revoked_at` existait déjà
(migration `0018`) et était déjà **lue** par le gate de publication
(`resolveConsent`, chemin `consentId` et auto-découverte), mais **aucun**
endpoint ni méthode applicative ne l'écrivait — la révocation était
« délibérément différée » (commentaire historique
`annuaire.repository.ts:191-198`). Ce plan livre l'écriture.

### Décision — révocation-seule, cascade automatique REJETÉE (D1-D2)

`POST /annuaire/consents/:id/revoke` écrit `revoked_at` et **ne cascade
aucun masquage automatique** sur les lignes d'adressage déjà publiées sous
ce consentement. Ancrage réglementaire ré-extrait (sources primaires,
`docs/reglementaire/specifications-externes-v3.2/0- Dossier de
specifications externes FE - Dossier général_v3.2.pdf`, lecture seule) :

- **§3.5.3 p.40 + note 79 p.41** — le masquage sert à *« annuler la prise
  d'effet d'une ligne d'annuaire »* ; les évènements exogènes raccourcissent
  une ligne **en vigueur** via une **date de fin effective**, pas via un
  masquage.
- **§3.5.5.2-4 p.45-47** — l'actualisation automatique sur évènement de
  registre (perte d'assujettissement, perte d'immatriculation) est décrite
  **côté PPF**, pas côté PA.
- **§3.5.5.5 p.48-50 + note 85 p.50** — l'analogue exact de la révocation de
  consentement (rupture PA↔client) : *« il est alors conseillé à la PA de
  clôturer les lignes d'annuaire en vigueur (...), de masquer les lignes
  dont la date d'entrée en vigueur n'était pas encore échue, puis de créer
  une ligne d'annuaire (...) attribuée au matricule de la plateforme
  fictive »* — une **actualisation opérateur, ligne par ligne**, transmise
  par Flux 13, **jamais** une cascade automatique uniforme.

**Sémantique réelle de `maskLigne` (le fait décisif).**
`AnnuairePublicationService.maskLigne` appelle uniquement
`repo.appendLigneEvent(tenantId, ligneId, 'deposee', 'masked', 'platform')`
— une transition **locale** (`deposee`-only, CAS `WHERE status='deposee'`),
sans `port.publish`, sans émission Flux 13, sans écriture du miroir
`annuaire_directory_entries` que lit `resolveRecipient`. Une cascade
automatique via `maskLigne` aurait donc été **triplement défaillante** :
incomplète (ne peut pas toucher `draft`/`published`, seulement `deposee`),
non-propagée (le routage réel resterait inchangé, le miroir n'étant jamais
écrit) et infidèle au modèle (la spec distingue clôturer/masquer/créer un
fallback, qu'un masquage uniforme confond). Elle aurait **fabriqué**
l'apparence d'une rétractation qui n'a pas eu lieu — la révocation-seule
évite cette fabrication.

### Endpoint, idempotence et 404 anti-fuite (D3-D4)

`POST /annuaire/consents/:id/revoke` (`@HttpCode(200)`, dual-auth triple
garde `TenantAuthGuard`+`RolesGuard`+`CsrfGuard`,
`@Roles('owner','admin','accountant')` — même motif exact que les 6 autres
mutations dual-auth du projet) :

- **Écriture CAS write-once** (motif `markPublished`) :
  `UPDATE annuaire_consents SET revoked_at = now() WHERE id = $1 AND
  revoked_at IS NULL RETURNING revoked_at`. Si **0 ligne**, ré-lecture
  RLS-scopée (`SELECT revoked_at WHERE id = $1`) : `null` → consentement
  inconnu/cross-tenant (404) ; trouvé → **déjà révoqué**, réponse
  **idempotente 200** avec le `revoked_at` **d'origine** (jamais réécrit,
  monotone).
- **404 anti-fuite byte-identique** (`:id` malformé, consentement inconnu,
  consentement d'un autre tenant — les trois cas indiscernables, motif
  `endEffect`/`maskLigne`).
- **Aucune migration** : `revoked_at` (`0018`) et le grant `UPDATE`
  (`0019:14`) existent déjà. **Aucune colonne `revoke_reason`** n'est
  ajoutée — le corps de requête est vide/ignoré ; stocker un motif inventé
  serait une fabrication.
- **Réponse** : `{ consentId, revokedAt, dependentActiveLignes }` —
  `dependentActiveLignes` = nombre de lignes `annuaire_lignes` de ce
  consentement encore **actives** (`draft`/`published`/`deposee`, hors
  terminaux `rejetee`/`masked`) : l'**anti-silence** de la posture « jamais
  prétendre » (amendement M1-DOC ci-dessous).
- **Verrou d'architecture M1 étendu 6→7** — la 7ᵉ mutation dual-auth du
  projet (`annuaire/annuaire.controller.ts#revokeConsent`), énumérée dans
  `dual-auth-composition.arch.test.ts`. RED de morsure constaté (le scan
  a nommé la route non conforme avant son ajout à l'énumération), puis
  GREEN. Voir § Verrou d'architecture — composition dual-auth (M1) ci-dessus.

### AMENDEMENT M1-DOC — honnêteté du miroir de consultation (lecture obligatoire)

**La révocation bloque le NEUF, elle ne rétracte PAS l'existant — sans
euphémisme.** `POST /annuaire/consents/:id/revoke` garantit que **plus
aucune publication neuve** ne peut s'adosser au consentement révoqué (gate
existant `resolveConsent`, chemin `consentId` **et** auto-découverte,
prouvé par non-régression e2e sur les **deux** chemins). Il **ne fait rien
d'autre** sur l'adressage déjà publié :

- Le **miroir de consultation** (`annuaire_directory_entries`, Flux 14) —
  la source **réelle** que lit `resolveRecipient` pour router une facture —
  **n'est pas modifié** par la révocation. Un tiers qui consulte l'annuaire
  après la révocation **continue d'être routé** vers la plateforme, pour
  toute maille déjà consolidée, **jusqu'à** l'actualisation opérateur
  décrite ci-dessous.
- Les lignes `annuaire_lignes` déjà `published`/`deposee` sous ce
  consentement **restent en l'état** — elles ne sont ni clôturées, ni
  masquées, ni retirées automatiquement par la révocation elle-même.
- La **transmission Flux 13 réelle** de l'actualisation (masquage +
  clôture + ligne fallback plateforme fictive `9998`, §3.5.5.5 note 85) est
  **DIFFÉRÉE** — elle exige l'émission Flux 13 réelle (transport différé
  depuis 2.4/3.1, item Xavier) et la propagation au miroir, aucune des deux
  n'étant fournie par ce plan.

Aucune formulation de ce projet ne doit laisser croire à une rétractation
effective de l'adressage existant : la révocation **écrit un fait
horodaté** (« publiée sous le consentement X, révoqué le T ») et **bloque le
neuf** — elle ne « débranche » pas silencieusement les tiers du routage
déjà en place.

### Runbook opérateur — actualisation post-révocation

Procédure recommandée immédiatement après un `200` de révocation dont
`dependentActiveLignes > 0` (§3.5.5.5 note 85, appliquée ligne par ligne) :

1. **Consulter** les lignes actives dépendantes (`GET /annuaire/lignes`,
   filtré par SIREN) — le champ `dependentActiveLignes` de la réponse de
   révocation donne le **compte**, pas la liste ; l'opérateur doit
   retrouver les lignes lui-même.
2. **Clôturer** les lignes en vigueur : `PUT /annuaire/lignes/:id` (fin
   d'effet, `dateFin`).
3. **Masquer** les lignes `deposee` dont la date d'entrée en vigueur
   n'est pas encore échue : `DELETE /annuaire/lignes/:id`.
4. **Créer une ligne fallback** vers la plateforme fictive (`9998`) — **outil
   non livré** : aucun endpoint ne crée aujourd'hui une ligne fallback en
   masse ni n'émet le Flux 13 de masquage/clôture réel vers le PPF ; cette
   étape reste **manuelle et hors outillage** tant que le transport Flux 13
   réel n'est pas fourni (item Xavier).

**Stock** : les consentements révoqués restent **lisibles** (`revoked_at`
non nul, historique jamais supprimé — `annuaire_consents` n'a pas de grant
`DELETE`) ; la révocation est un fait additif, jamais une purge.

### Backlog acté (hors périmètre de ce plan)

- **Divergence Tableau 6 — SOLDÉE (correctif backlog post-3.6)** :
  l'ancienne bannière d'`annuaire-lifecycle.ts` affirmait à tort *« aucun
  code officiel DGFiP »* ; les codes **400 Acceptée / 401 Rejetée** du
  **§3.5.7 Tableau 6 p.54** sont désormais portés par `deposee`/`rejetee`
  (`ANNUAIRE_STATUS_META`, oracle main-transcrit au test), et le **Tableau 7
  p.55** (motifs normatifs `REJ_*`) est acté — contrainte du motif différée
  au raccordement des adaptateurs réels (§ Machine à états ci-dessus).
- **Outils d'actualisation post-révocation différés** : clôture `dateFin`
  en masse et création de ligne fallback (plateforme fictive `9998`) — la
  procédure ci-dessus reste **manuelle**, ligne par ligne, via les endpoints
  existants (`PUT`/`DELETE /annuaire/lignes/:id`) ; aucun endpoint dédié
  « actualiser toutes les lignes d'un consentement révoqué » n'est livré.
- **Cascade réelle vers le PPF (Flux 13)** : masquage + clôture + ligne
  fallback transmis réellement au PPF — exige l'émission Flux 13 réelle
  (transport différé depuis 2.4/3.1, item Xavier) et la propagation au
  miroir de consultation.
- **Raison de révocation stockée** : aucune colonne `revoke_reason`
  n'existe ; en ajouter une exigerait une migration justifiée par un besoin
  métier réel, non fabriquée ici.
- **Blocage dur de la révocation tant que des lignes actives dépendent**
  (gate bloquante stricte) — **refusé** : les lignes `published` ne peuvent
  pas être masquées (machine `deposee`-only) et l'acquittement PPF
  (`published→deposee`) est différé (push PPF réel absent) — un blocage dur
  serait insatisfaisable (deadlock). Remplacé par le rapport honnête
  `dependentActiveLignes`.
- **Couverture de test — content-type asserté sur 1 des 3 cas 404** (revue
  T2, NIT-2 accepté) : `annuaire-consent-revoke.e2e.test.ts` vérifie le
  corps 404 byte-identique sur les 3 chemins (inconnu/cross-tenant/malformé)
  mais n'asserte le `Content-Type` que sur un seul — indiscernabilité
  transitive jugée suffisante (les 3 corps sont `toEqual`).

## Sécurité / multi-tenant

Cette section documente les mécanismes de sécurité destinés à figurer au
dossier d'immatriculation DGFiP (PA/PDP).

### Rôles Postgres

**Trois rôles depuis 3.5** (deux jusqu'en 3.4), jamais confondus :

- **`factelec_owner`** — `BYPASSRLS`, `CREATEDB`. Utilisé **uniquement** par
  les migrations (`pnpm db:migrate`) et le provisioning CLI
  (`pnpm provision:tenant`). Propriétaire du schéma `public` et de la
  fonction `authenticate_api_key`. **Jamais utilisé par le process API.**
- **`factelec_app`** — `NOSUPERUSER NOBYPASSRLS NOCREATEDB`. Rôle applicatif
  du process **API**, seul rôle dont dispose `DATABASE_URL`. N'a que `USAGE`
  sur le schéma, `SELECT/INSERT/UPDATE` sur les tables
  `tenants`/`api_keys`/`invoices`/`invoice_formats`, `SELECT/INSERT`
  **uniquement** (jamais `UPDATE`/`DELETE`) sur `invoice_status_events`
  (append-only, 2.1 — cf. § Cycle de vie CDV), et `EXECUTE` sur
  `authenticate_api_key`/`purge_expired_sessions` — jamais `BYPASSRLS`. (Les
  tables `users`/`sessions`/`platform_admins`, introduites en 1.4, ont leurs
  propres politiques RLS documentées dans `docs/superpowers/`.) **Jusqu'en
  3.4**, ce rôle était **aussi** celui du process worker (`src/worker-main.ts`,
  2.1, partagé, aucun privilège différencié). ⚠️ **`factelec_app` conserve
  aujourd'hui la totalité de ses grants historiques**, y compris `EXECUTE`
  sur les fonctions `SECURITY DEFINER` cross-tenant listées § Différé
  explicitement ci-dessous — la migration `0029` (3.5) n'effectue **aucun**
  `REVOKE` sur ce rôle, seulement des `GRANT` sur le nouveau rôle worker
  ci-dessous (honnêteté : la séparation des privilèges bénéficie au worker,
  pas encore à `factelec_app`).
- **`factelec_worker`** (3.5, D4/D5) — `NOSUPERUSER NOBYPASSRLS NOCREATEDB`,
  comme `factelec_app`. Rôle applicatif **dédié** du process **worker**
  (`WorkerModule` importe désormais inconditionnellement
  `DbModule.forRoot('DATABASE_URL_WORKER')`) — grants de **moindre
  privilège**, dérivés de l'inventaire **réel** des accès exercés par les 5
  processors + sweeps du worker (migration `0029_worker_role_grants.sql`,
  détail table par table en § Consentement scellé, rôle worker &
  re-résolution ambiguous — 3.5 ci-dessous). **AUCUN** accès à
  `tenants`/`api_keys`/`users`/`platform_admins`/`sessions`/
  `annuaire_consents`, **AUCUN** `INSERT` sur `invoices`/`annuaire_lignes`,
  **AUCUNE** des 8 fonctions `SECURITY DEFINER` auth/session/admin — soumis à
  la RLS `FORCE` comme `factelec_app` (policies existantes créées **sans**
  clause `TO`, donc `TO PUBLIC` : aucune policy nouvelle n'a été nécessaire).
  ⚠️ **Doit exister avant tout déploiement de cette version** : le worker
  throw explicitement au bootstrap si `DATABASE_URL_WORKER` est absente —
  provisioning prod (création du rôle + secret) = **item Xavier**.

### Row-Level Security : `ENABLE` + `FORCE`

Les 4 tables (`tenants`, `api_keys`, `invoices`, `invoice_formats`) ont la RLS
**activée et forcée** (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY` **et**
`... FORCE ROW LEVEL SECURITY`, migration `0001_roles_rls.sql`) — la RLS
s'applique aussi au propriétaire de table s'il n'a pas `BYPASSRLS` (ici
`factelec_app` n'a jamais ce droit ; seul `factelec_owner`, qui ne fait aucune
requête applicative, l'a).

Chaque table porte une policy fail-closed :

```sql
CREATE POLICY tenant_isolation ON invoices
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
```

**Déviation vérifiée par rapport au plan initial** : le plan prévoyait un
cast nu `current_setting('app.tenant_id', true)::uuid`. En pratique, un GUC
custom (`app.*`) déjà positionné une fois dans une session (via
`set_config(..., true)`, donc en `SET LOCAL`) est remis à la **chaîne vide**
`''` — et non `NULL` — après la fin de la transaction qui l'a posé (quirk
documenté de Postgres pour les paramètres placeholder). Sans le `nullif(...,
'')`, `''::uuid` lève une exception au lieu de fermer proprement l'accès (0
ligne) hors contexte tenant. Le `nullif` restaure le comportement fail-closed
voulu dans tous les cas : GUC jamais posé (`NULL`), GUC réinitialisé après
transaction (`''`), ou GUC valide (UUID).

### Propagation du tenant : une transaction par requête

`runInTenant(pool, tenantId, work)` (`src/db/tenant-context.ts`) ouvre une
connexion dédiée du pool, exécute `BEGIN`, pose
`SELECT set_config('app.tenant_id', $1, true)` (`is_local = true`, donc
**`SET LOCAL`**, réinitialisé au `COMMIT`/`ROLLBACK`), exécute `work` avec un
client `drizzle` lié à cette connexion, puis `COMMIT`. Le `ROLLBACK` du
chemin d'erreur est protégé : si le `ROLLBACK` lui-même échoue (connexion
probablement corrompue), l'erreur d'origine (celle de `work`, jamais celle du
rollback) est tout de même celle propagée à l'appelant, et la connexion
défaillante est évincée du pool (`client.release(err)`) plutôt que remise en
circulation. **Aucune fuite de tenant entre requêtes** sur une connexion
mutualisée du pool : chaque requête HTTP obtient sa propre transaction et son
propre `SET LOCAL`.

### Authentification par clés API

- Format du token : `fk_<prefix>.<secret>`. Seul le `secret` est un secret ;
  le `prefix` sert de clé de recherche publique.
- Le `secret` est haché au repos avec **Argon2id** (`@node-rs/argon2`,
  paramètres OWASP : `memoryCost=19456`, `timeCost=2`, `parallelism=1`).
  **Jamais stocké ni loggé en clair** — seul `secretHash` est persisté ; le
  token complet n'est révélé qu'une fois, en sortie du script de
  provisioning.
- **Problème poule/œuf** : l'authentification doit lire `api_keys` **avant**
  que le tenant (et donc `app.tenant_id`) ne soit connu — mais `api_keys` est
  sous RLS. Résolu par une fonction Postgres **`SECURITY DEFINER`**
  (`authenticate_api_key(prefix)`, propriété de `factelec_owner`,
  `search_path` **épinglé** à `public` pour éviter tout détournement par
  substitution de schéma), qui ne renvoie que la ligne minimale nécessaire
  pour **un seul préfixe**. `factelec_app` n'a que `EXECUTE` sur cette
  fonction, jamais `BYPASSRLS`.
- **Timing-safe par construction** : quel que soit le cas d'échec (préfixe
  inconnu, clé révoquée, ou préfixe connu mais secret incorrect),
  `ApiKeyService.authenticate()` effectue **exactement un** appel
  `argon2.verify()` avec les mêmes paramètres de coût — soit contre le hash
  réel, soit contre un hash-leurre précalculé et mis en cache
  (`timingSafeReject`). Seul le cas structurellement distinct (token qui ne
  respecte même pas la syntaxe `fk_xxx.yyy`) court-circuite avant tout appel
  argon2 — ce cas ne renseigne l'attaquant sur rien (aucun préfixe candidat
  n'est même formé). Mesuré empiriquement : écart de moyenne ~0,2 ms entre le
  chemin « préfixe inconnu » et le chemin « préfixe connu, mauvais secret »
  (~1,8 %, dominé par le bruit de scheduling, largement sous le jitter
  réseau réel).
- `ApiKeyGuard` pose `req.tenantId`/`req.apiKeyId` sur succès ; échec → 401
  `application/problem+json` uniforme, sans distinction observable entre les
  causes.

### Sécurité transverse

- **helmet** (en-têtes de sécurité par défaut) et **CORS allowlist**
  (`CORS_ALLOWED_ORIGINS`, méthodes `GET`/`POST` uniquement,
  `credentials: false`).
- **Rate limiting** (`@nestjs/throttler`, `APP_GUARD` global) : par IP,
  fenêtre glissante configurable (`RATE_LIMIT_TTL`/`RATE_LIMIT_LIMIT`),
  appliqué **avant** la résolution du tenant. Dépassement → **429** réel
  (vérifié en e2e sur un endpoint réel).
- **Erreurs RFC 9457** (`application/problem+json`) sur toute la surface API
  via `ProblemDetailsFilter` : `type` (URN stable `urn:factelec:problem:*`),
  `title`, `status`, `detail`/`errors` bornés (jamais de stack, de requête
  SQL ni de détail interne). Isolation cross-tenant renvoie systématiquement
  **404** (jamais 403, jamais 200) — prouvé byte-identique à un vrai
  not-found en test e2e.
- **Logs pino masqués** : les en-têtes sensibles (`authorization`
  notamment) et tout corps de requête sont retirés du flux de logs
  structurés, vérifié à la fois unitairement et sur le pipeline HTTP réel
  (tentative d'authentification échouée et réussie, secret absent des deux).

## Variables d'environnement

Voir `.env.example` (aucun secret réel n'y figure). Table :

| Variable | Rôle | Défaut |
| --- | --- | --- |
| `NODE_ENV` | `development` \| `test` \| `production` | `development` |
| `PORT` | Port d'écoute HTTP | `3000` |
| `LOG_LEVEL` | Niveau pino (`fatal`…`silent`) | `info` |
| `DATABASE_URL` | URL Postgres du rôle **applicatif API** (`factelec_app`, soumis à la RLS) | — (requis) |
| `DATABASE_URL_WORKER` | URL Postgres du rôle **applicatif worker** (`factelec_worker`, moindre privilège, 3.5) — **requise au bootstrap du process worker uniquement** (`WorkerModule`, throw explicite si absente) ; non lue par le process API | — (requis pour `pnpm start:worker`/`worker:dev`) |
| `DATABASE_OWNER_URL` | URL Postgres du rôle **owner** (`factelec_owner`, `BYPASSRLS`) | — (requis par les scripts uniquement) |
| `CORS_ALLOWED_ORIGINS` | Liste d'origines autorisées, séparées par virgule | `''` (aucune) |
| `RATE_LIMIT_TTL` | Fenêtre du rate limit (secondes) | `60` |
| `RATE_LIMIT_LIMIT` | Requêtes max par fenêtre et par IP | `120` |
| `TRUST_PROXY` | Nombre de proxys de confiance devant l'API (`app.set('trust proxy', n)`) | `0` (aucun) |
| `SESSION_TTL_HOURS` | Durée de vie **absolue** d'une session (utilisateur ou admin) — aucun renouvellement glissant (D1 amendé, plan 1.4) | `12` |
| `SESSION_COOKIE_DOMAIN` | Domaine des cookies `factelec_session`/`factelec_csrf` — requis en prod pour un partage same-site dashboard/API (ex. `.factelec.fr`) ; absent en dev (localhost) | — (absent = cookie scopé à l'hôte courant) |
| `REDIS_HOST` | Hôte Redis (BullMQ, workers) | `localhost` |
| `REDIS_PORT` | Port Redis | `6379` |
| `REDIS_DB` | Index de base logique Redis (`SELECT n`) | `0` |
| `REDIS_PASSWORD` | Mot de passe Redis (managed Redis en prod) | — (absent = aucune auth) |
| `REDIS_TLS` | TLS Redis — parsé explicitement (`"true"`/`"1"` uniquement ; **jamais** `z.coerce.boolean`, qui transformerait à tort `"false"` en `true`) | `false` |
| `GENERATION_JOB_ATTEMPTS` | Tentatives max d'un job de génération avant passage en `failed` (retries BullMQ, backoff exponentiel 1 s de base) | `3` |
| `SESSION_PURGE_EVERY_MS` | Périodicité (ms) du job répétable de purge des sessions expirées (worker, Task 7) | `3600000` (1 h) |
| `RECONCILIATION_STALE_MS` | Ancienneté (ms) au-delà de laquelle une facture `received` non enfilée est considérée orpheline et re-enfilée | `300000` (5 min) |
| `RECONCILIATION_SWEEP_EVERY_MS` | Périodicité (ms) du balayage de réconciliation | `60000` (1 min) |
| `RECONCILIATION_GENERATING_STALE_MS` | Ancienneté (ms) au-delà de laquelle une facture `generating` bloquée (worker tué en cours de génération) est re-enfilée | `900000` (15 min) |
| `ARCHIVE_DRIVER` | Adaptateur d'archivage WORM : `local` (`LocalFilesystemArchiveStore`, testable) \| `s3` (object-lock Scaleway, **activé au déploiement**, lève une erreur explicite tant que non fourni) | `local` |
| `ARCHIVE_LOCAL_DIR` | Répertoire local du driver `local` | `./var/archive` |
| `GENERATION_MAX_ATTEMPTS_CAP` | Cap de ré-enfilements par la réconciliation avant DLQ (`invoice_dead_letters`) — facture « poison » | `5` |
| `ARCHIVE_RETRY_EVERY_MS` | Périodicité (ms) du balayage de reprise d'archivage (`archive_status='failed'` ou `pending` bloqué > 15 min) | `300000` (5 min) |
| `ROUTING_RETRY_EVERY_MS` | Périodicité (ms) du balayage de reprise du routage destinataire (`routing_status IN ('pending','unaddressable')` bloqué > 15 min, miroir `ARCHIVE_RETRY_EVERY_MS`, plan 3.4) | `300000` (5 min) |
| `EREPORTING_TRANSMISSION_DRIVER` | Adaptateur de transmission Flux 10 : `local` (`LocalFilesystemTransmissionStore`, testable) \| `sftp`\|`as2`\|`as4`\|`api` (auth transport réelle, **activés au déploiement**, lèvent une erreur explicite tant que non fournis) | `local` |
| `EREPORTING_LOCAL_DIR` | Répertoire local du driver `local` | `./var/ereporting` |
| `EREPORTING_PA_ID` | Matricule émetteur de la Plateforme Agréée (TT-8, TB-1) | `PA00` |
| `EREPORTING_PA_SCHEME_ID` | Schéma d'identifiant de la PA (TT-7, ICD) | `0238` |
| `EREPORTING_PA_NAME` | Raison sociale de la PA (TT-9) | `Factelec PA` |
| `EREPORTING_SWEEP_EVERY_MS` | Périodicité (ms) du job répétable d'ordonnancement e-reporting (`EreportingSweepService`) | `3600000` (1 h) |
| `EREPORTING_GENERATION_JOB_ATTEMPTS` | Tentatives max d'un job de génération e-reporting avant `failed` — distingue une erreur **opérationnelle** (`xmllint` absent, DB/port transitoire) d'un rejet sémantique `REJ_SEMAN` (qui n'est jamais rejoué, il ne throw pas) | `3` |
| `PAYMENTS_SWEEP_EVERY_MS` | **Déclarée pour compléter le contrat env (plan 3.2), NON CONSOMMÉE** — la passe paiements (`EreportingSweepService.sweep()`) tourne aujourd'hui sur le même planificateur que les transactions (`EREPORTING_SWEEP_EVERY_MS`) ; réservée à un futur planificateur paiements dédié si l'exploitation souhaite découpler les cadences | `3600000` (1 h) |
| `PAYMENTS_LOOKBACK_MS` | **Déclarée, NON CONSOMMÉE** (même motif) — la fenêtre bornée réelle des paiements est `computeDuePaymentPeriods`/`MAX_DUE_PERIODS` (`period.ts`), pas ce paramètre | `172800000` (48 h) |
| `ANNUAIRE_DRIVER` | Adaptateur de transport annuaire : `local` (`LocalFilesystemAnnuaireStore`, testable) \| `api`\|`edi` (API PISTE-OAuth2 / EDI SFTP-AS2-AS4, **activés au déploiement**, lèvent une erreur explicite tant que non fournis) | `local` |
| `ANNUAIRE_LOCAL_DIR` | Répertoire local du driver `local` | `./var/annuaire` |
| `ANNUAIRE_SYNC_EVERY_MS` | Périodicité (ms) de l'ordonnanceur de synchronisation différentielle (Flux 14, quotidien) | `86400000` (24 h) |
| `ANNUAIRE_COMPLETE_EVERY_MS` | Périodicité (ms) de l'ordonnanceur de synchronisation complète (Flux 14, remplacement du miroir du tenant, hebdomadaire) | `604800000` (7 j) |
| `ANNUAIRE_PUBLISH_JOB_ATTEMPTS` | Tentatives max d'un job de la file `annuaire-sync` (ingestion F14 et reprise de draft figé) avant `failed` | `3` |
| `ANNUAIRE_REPUBLISH_SWEEP_EVERY_MS` | Périodicité (ms) du sweep de reprise des publications figées (drafts âgés > 15 min, `find_stale_annuaire_drafts`) | `300000` (5 min) |
| `CDV_TRANSMISSION_DRIVER` | Adaptateur de transmission CDV Flux 6 : `local` (`LocalFilesystemCdvStore`, testable) \| `sftp`\|`as2`\|`as4`\|`as4-peppol`\|`api` (auth transport réelle, **activés au déploiement**, lèvent une erreur explicite tant que non fournis) | `local` |
| `CDV_LOCAL_DIR` | Répertoire local du driver `local` | `./var/cdv` |
| `CDV_SWEEP_EVERY_MS` | Périodicité (ms) de l'ordonnanceur CDV borné 24h (`CdvTransmissionSweepService`) | `3600000` (1 h) |
| `CDV_TRANSMISSION_LOOKBACK_MS` | Fenêtre de rattrapage bornée du sweep CDV (48h = 2× le SLA 24h, §3.6.6, D8) — passée à `find_cdv_transmissions_due(p_since)` ; **voir le runbook** pour la limite d'une panne worker plus longue | `172800000` (48 h) |
| `CDV_TRANSMISSION_JOB_ATTEMPTS` | Tentatives max d'un job de transmission CDV avant `failed` — distingue une erreur **opérationnelle** (port transitoire) d'un rejet fonctionnel (601 / F6 invalide, qui ne throw jamais et n'est donc jamais rejoué) | `3` |
| `CDV_STUCK_RETRY_EVERY_MS` | Périodicité (ms) de la reprise des transmissions CDV `parked` (`CdvStuckRetryService`) | `300000` (5 min) |
| `CDV_PA_MATRICULE` | Matricule ICD 0238 du PA émetteur du F6 (`senderMatricule`) — **item Xavier au déploiement** | `'0000'` (placeholder dev/test) |
| `CONSENT_DRIVER` | Fournisseur de scellement de la preuve de consentement annuaire (3.5) : `local` (`LocalFilesystemConsentStore`, scellement **structurel** testable) \| `eidas` (fournisseur de signature qualifiée réel, **activé au déploiement**, lève une erreur explicite tant que non fourni) | `local` |
| `CONSENT_LOCAL_DIR` | Répertoire local du driver `local` | `./var/consent` |

**`DATABASE_OWNER_URL` n'est jamais lue par le process API** (absente du
schéma zod `envSchema`, `src/config/env.ts`) : elle n'est consommée que par
`scripts/migrate.ts`, `scripts/provision-tenant.ts` et
`scripts/provision-admin.ts`, tous trois exécutés hors du chemin de requête
HTTP.

**`TRUST_PROXY` — topologie réseau.** Le rate limiting par IP
(`ThrottlerGuard`) lit `req.ip`, qu'Express calcule à partir de
`X-Forwarded-For` **seulement** si `trust proxy` est activé. Déployée
directement (aucun load balancer / reverse-proxy devant elle), l'API doit
garder `TRUST_PROXY=0` (défaut) : tous les clients partagent alors
correctement leur vraie IP socket. **Derrière un LB/reverse-proxy**,
`TRUST_PROXY` doit être positionné au nombre exact de sauts de proxy pour que
le throttling par IP fonctionne (sinon tous les clients sont vus avec l'IP du
proxy et partagent le même seau). **Ne jamais positionner une valeur trop
haute** : un client pourrait alors forger son propre `X-Forwarded-For` pour
usurper une IP arbitraire et contourner le rate limiting d'un autre client
(risque de spoofing) — d'où le choix de n'accepter qu'un entier explicite
plutôt que `true` (qui ferait confiance à n'importe quelle chaîne de proxy
annoncée par le client).

## Développement

```sh
cd apps/api
docker compose up -d                         # Postgres ET Redis locaux + rôles (scripts/db-init)
DATABASE_OWNER_URL=... pnpm db:migrate        # applique 0000_init … 0009 (migrations séquentielles)
DATABASE_OWNER_URL=... pnpm provision:tenant "Ma boutique"   # → { tenantId, token } (token affiché 1 fois)
pnpm dev                                       # API : tsx watch
pnpm start:worker                              # worker (build requis, dist/worker-main.js) …
pnpm worker:dev                                # … ou tsx watch pour le worker, en développement
pnpm test                                      # Vitest + Testcontainers (Postgres + Redis, Docker requis)
```

L'API seule répond déjà (santé, ingestion, lecture) sans worker démarré —
mais les factures ingérées restent en `received` tant qu'aucun worker ne
tourne (aucune génération de formats ni transition de statut automatique).
En développement, lancer l'API **et** le worker dans deux terminaux séparés.

Depuis la racine du monorepo, `pnpm build` doit précéder `pnpm typecheck`
(`apps/api` résout `@factelec/invoice-core` via son `dist/`, pas ses
sources ; `pnpm build` compile aussi `src/worker-main.ts` via swc) : voir le
README racine.

## Endpoints

| Méthode & route | Description | Codes possibles |
| --- | --- | --- |
| `GET /health` | Liveness (aucune dépendance externe) | 200 |
| `GET /health/ready` | Readiness (ping Postgres **et Redis**, `@nestjs/terminus`, chacun borné 2 s) | 200, 503 |
| `POST /invoices` | Ingestion : validation `invoice-core`, persistance transactionnelle, **enfilement** du job de génération (asynchrone, 2.1 — voir § Nouvelle sémantique) | 201, 401, 409, 422 |
| `GET /invoices` | Liste paginée (keyset), tenant-scopée — `?routingStatus=` filtre optionnel (3.4, D8), expose `routingStatus`/`recipientPlatform` | 200, 401, 422 |
| `GET /invoices/:id` | Métadonnées d'une facture (`status` de génération, `lifecycleStatus` CDV, `routingStatus`/`recipientPlatform` — routage destinataire résolu à l'émission, 3.3, § Couture annuaire → émission) + formats disponibles | 200, 401, 404 |
| `GET /invoices/:id/formats/:format` | Contenu d'un format (`ubl`, `cii`, `facturx`, `flux_base`, `flux_full`) avec le bon `Content-Type` (`application/xml` ou `application/pdf` pour `facturx`) — **404 tant que `status ≠ 'generated'`** | 200, 401, 404 |
| `POST /invoices/:id/status` | Transition de statut CDV (`{ toStatus, reason? }`) — session owner/admin/accountant + CSRF, CAS anti-race | 201, 401, 403, 404, 409, 422 |
| `GET /invoices/:id/status` | Statut CDV courant + historique complet (journal `invoice_status_events`) | 200, 401, 404 |
| `GET /invoices/:id/ledger` | Journal scellé de la facture + vérifications d'intégrité (`integrity` self-check, `chainIntegrity` chaîne complète du tenant) | 200, 401, 404 |
| `GET /invoices/:id/paf` | Piste d'Audit Fiable (`?format=json` défaut \| `?format=csv`, `Content-Disposition: attachment` en CSV) — conception projet, non normalisée DGFiP | 200, 401, 404 |
| `POST /invoices/:id/routing/resolve` | Re-résolution manuelle d'un routage `ambiguous` (dual-auth, 3.5, § Consentement scellé / re-résolution ambiguous) — `ambiguous`-only, 200 synchrone, honnêteté L1 (un 200 encore `ambiguous` ne distingue pas annuaire non nettoyé / panne opérationnelle) | 200, 401, 403, 404, 409 |
| `POST /auth/signup` | Inscription self-service : crée le tenant **et** l'utilisateur `owner` de façon atomique (fonction `SECURITY DEFINER` `signup_tenant`), ouvre une session | 201, 409, 422 |
| `POST /auth/login` | Authentification utilisateur (email + mot de passe Argon2id), ouvre une session | 200, 401, 422 |
| `POST /auth/logout` | Révoque la session courante (cookie `factelec_session`) | 204, 401 |
| `GET /auth/me` | Profil de l'utilisateur de la session courante | 200, 401 |
| `POST /api-keys` | Création d'une clé API pour le tenant de la session (rôles `owner`/`admin` uniquement) ; secret **affiché une seule fois** | 201, 401, 403, 422 |
| `GET /api-keys` | Liste des clés du tenant (préfixes uniquement, jamais le secret) — tout rôle utilisateur authentifié | 200, 401, 403 |
| `DELETE /api-keys/:id` | Révocation immédiate d'une clé (rôles `owner`/`admin` uniquement) | 204, 401, 403, 404 |
| `POST /admin/login` | Authentification super admin plateforme (`platform_admins`, Argon2id), ouvre une session admin | 200, 401, 422 |
| `POST /admin/logout` | Révoque la session admin courante | 204, 401, 403 |
| `GET /admin/tenants` | Liste de tous les tenants (vue plateforme : nombre d'utilisateurs, de factures) | 200, 401, 403 |
| `POST /ereporting/retransmissions` | Retransmission RE opérateur (`{ declarantId, fluxKind, periodStart }`, dual-auth, 3.4, § Chemin RE) — régénération complète de la période sur jugement humain, jamais un automatisme | 202, 401, 403, 404, 409, 422 |
| `GET /ereporting/transmissions` | Liste des transmissions e-reporting Flux 10 du tenant (résumés — **sans** le XML, `IN` **et** `RE`), `rejectOrigin` (`local`\|`ppf`\|`null`) dérivé pour les rejets | 200, 401 |
| `GET /ereporting/transmissions/:id/xml` | XML de la transmission (`text/xml`) — 404 si absente ou d'un autre tenant | 200, 401, 404 |
| `GET /ereporting/transmissions/:id/events` | Journal des statuts de la transmission (`fromStatus`/`toStatus`/`motif`/`actor`) | 200, 401, 404 |
| `GET /annuaire/lignes` | Recherche dans le miroir de consultation (Flux 14) du tenant, filtrée par SIREN | 200, 401 |
| `GET /annuaire/codes-routage?siren=` | Énumération de gestion des codes-routage **publiés par le tenant** (`annuaire_lignes`, tous statuts, 3.3 D6) — tableau vide si aucun (pas 404) ; POST autonome refusé (composant de maille, créé via `POST /annuaire/lignes`) | 200, 401, 422 |
| `GET /annuaire/resolution` | Résolution du matricule de plateforme destinataire pour une maille à une date donnée (`?siren&siret?&routageId?&suffixe?&date`) — 404 anti-fuite (inconnu/hors période/hors tenant), 409 si résolution ambiguë | 200, 401, 404, 409 |
| `POST /annuaire/lignes` | Publication d'une ligne d'adressage (D/M) — dual-auth **+ rôles owner/admin/accountant + CSRF en session** (3.5, Task 4bis), gate consentement **scellé** (422, § Consentement scellé), F13 XSD-validé et transmis via le port ; succès partiel au grain ligne (201 même si le statut interne devient `rejetee`) | 201, 401, 403, 422 |
| `PUT /annuaire/lignes/:id` | Fin d'effet : positionne `dateFin` sur une ligne existante du tenant — dual-auth **+ rôles owner/admin/accountant + CSRF en session** (3.5, Task 4bis) | 200, 401, 403, 404, 409, 422 |
| `DELETE /annuaire/lignes/:id` | Masquage d'une ligne déposée (`deposee → masked`) — dual-auth **+ rôles owner/admin/accountant + CSRF en session** (3.5, Task 4bis) | 204, 401, 403, 404, 409 |
| `POST /annuaire/consents/:id/revoke` | Révocation d'un consentement (3.6, § Révocation de consentement) — dual-auth **+ rôles owner/admin/accountant + CSRF en session**, écrit `revoked_at` **CAS write-once idempotent** (rejeu → même `revokedAt` d'origine), 404 anti-fuite byte-identique (inconnu/cross-tenant/`:id` malformé), rapporte `dependentActiveLignes` (lignes actives dépendantes non retirées automatiquement — **aucune cascade**, § AMENDEMENT M1-DOC) | 200, 401, 403, 404 |
| `GET /cdv/transmissions?invoiceId=…` | Liste des transmissions CDV (Flux 6) d'une facture (résumés — **sans** le XML), `dgfipCode`/`statusLabel` dérivés | 200, 401 |
| `GET /cdv/transmissions/:id/xml` | XML `text/xml` de la transmission (absent si `parked`) — 404 anti-fuite (inconnue ou d'un autre tenant) | 200, 401, 404 |
| `GET /cdv/transmissions/:id/events` | Journal des statuts de la transmission (`fromStatus`/`toStatus`/`motif`/`actor`) | 200, 401, 404 |
| `POST /payments` | Capture d'un encaissement (`{ invoiceId, paymentDate, currency?, reference, subtotals: [{ taxPercent, amount }] }`) — dual-auth **et** session owner/admin/accountant + CSRF (voir ci-dessous), idempotent sur `(invoiceId, reference)` : **201** si nouveau, **200** si rejeu (`created:false`, payload divergent ignoré) | 201, 200, 401, 403, 404, 422 |
| `GET /payments?invoiceId=…` | Liste des encaissements capturés d'une facture (dual-auth, sans garde de rôle) | 200, 401, 404 |

**Rate limiting global par IP** (`ThrottlerGuard`, `APP_GUARD`) : **toute
route ci-dessus peut renvoyer 429**, à l'exception de `/health`/`/health/ready`
(exemptées via `@SkipThrottle()` — jamais rate-limitées, interrogées à haute
fréquence par l'orchestrateur). Seuils renforcés (`@Throttle`, en plus du
défaut `RATE_LIMIT_TTL`/`RATE_LIMIT_LIMIT`) sur `POST /auth/signup` (5/h/IP),
`POST /auth/login` (10/15 min/IP) et `POST /admin/login` (10/15 min/IP) —
anti-brute-force/anti-abus, vérifiés en e2e (429 réel).

**Deux régimes d'authentification distincts, jamais interchangeables** :
- **`POST /invoices`** (ingestion) reste **exclusivement machine** :
  `Authorization: Bearer fk_<prefix>.<secret>`, sans repli possible.
- **`GET /invoices`, `GET /invoices/:id`, `GET /invoices/:id/formats/:format`,
  `GET /invoices/:id/status`, `GET /invoices/:id/ledger`, `GET
  /invoices/:id/paf`, `GET /ereporting/transmissions*`, `GET
  /cdv/transmissions*`** (lecture) acceptent
  **soit une clé API, soit une session utilisateur** du même tenant
  (`TenantAuthGuard`, dual-auth) — jamais une session **admin** plateforme,
  refusée par ce guard. Un en-tête
  `Authorization: Bearer` présent est **toujours** résolu en priorité (même
  invalide) : un client machine ne retombe jamais silencieusement sur un
  cookie de session qui traînerait dans la même requête.
- **`/annuaire/*`** — la **consultation** (`GET`) reste dual-auth simple
  (`TenantAuthGuard` seul). Les **mutations** `POST /annuaire/lignes`,
  `PUT /annuaire/lignes/:id`, `DELETE /annuaire/lignes/:id` (Task 7/8 plan
  2.4) restent **dual-auth** (clé API **ou** session, une clé API machine
  publie/modifie/masque sans changement) mais composent **désormais**
  `RolesGuard`/`CsrfGuard` en plus — même motif que `POST /payments`/
  `POST /ereporting/retransmissions` ci-dessous : bypass sur `req.apiKeyId`
  (clé API), rôle `owner`/`admin`/`accountant` **et** CSRF **exigés en
  session**. ⚠️ **Ce n'était PAS le cas avant Task 4bis (plan 3.5)** : ces 3
  routes composaient `TenantAuthGuard` **seul**, une faille **héritée de
  2.4** (une session de n'importe quel rôle, `viewer` inclus, pouvait muter
  l'annuaire sans jeton CSRF) — voir § ÉPISODE SÉCURITÉ ci-dessous pour le
  détail complet, la preuve RED et le correctif. **`POST
  /annuaire/consents/:id/revoke`** (3.6) compose le même triple garde
  **dès sa création** (7ᵉ route dual-auth du projet, § Révocation de
  consentement — 3.6) — aucun épisode de sécurité analogue cette fois, le
  motif exact des mutations existantes a été repris d'emblée.
- **`POST /invoices/:id/status`** (transition CDV) est une **mutation
  métier** : exclusivement session **owner/admin/accountant** + CSRF
  (`SessionGuard`/`RolesGuard`/`CsrfGuard`) — un `viewer` est refusé (403),
  une clé API n'ouvre pas cette route (`SessionGuard` → 401, pas de cookie).
  L'apposition automatique par un connecteur/le réseau Peppol est différée
  (phase 3).
- **`POST /payments`** (capture d'un encaissement, plan 3.2) combine les
  **deux** régimes précédents — **premier endpoint de mutation** du projet à
  le faire : `TenantAuthGuard` (dual-auth, clé API **ou** session) **puis**
  `RolesGuard` (`owner`/`admin`/`accountant`) **et** `CsrfGuard`, ces deux
  derniers court-circuitant explicitement sur `req.apiKeyId` pour laisser
  passer un appel machine sans cookie/session (§ Runbook — bypass CSRF/rôles
  ci-dessus). `GET /payments` reste `TenantAuthGuard` seul, sans garde de
  rôle (lecture).
- **`POST /ereporting/retransmissions`** (déclenchement RE, plan 3.4) est la
  **2ᵉ route** du projet à combiner les mêmes trois guards que
  `POST /payments`, même motif, même bypass CSRF/rôles sur `req.apiKeyId` —
  le garde composé `DualAuthMutationGuard` (différé, 3.3 D9) reste donc
  différé, désormais avec **deux** sites à couvrir plutôt qu'un seul.
- **`/auth/*`, `/api-keys/*`, `/admin/*`** sont exclusivement pilotés par
  **session serveur httpOnly** (cookie `factelec_session`) + **CSRF
  double-submit** (`X-CSRF-Token` face au cookie lisible `factelec_csrf`) sur
  toute mutation — jamais par clé API. Détail complet (Argon2id partagé,
  jetons opaques 256 bits hash-only, RLS `FORCE` sur `users`/`sessions`,
  `platform_admins` isolé des tenants) : voir `docs/superpowers/` (plan 1.4)
  et les commentaires des guards (`src/auth/session.guard.ts`,
  `src/auth/tenant-auth.guard.ts`, `src/admin/admin.guard.ts`).

## Provisioning

- **Tenants** : self-service via `POST /auth/signup` (transactionnel,
  fonction `SECURITY DEFINER` `signup_tenant`) **ou** CLI
  `pnpm provision:tenant "Nom"` (rôle owner, hors chemin de requête,
  conservé pour le provisioning hors self-service).
- **Super admins plateforme** : **CLI uniquement**, aucune inscription
  self-service : `DATABASE_OWNER_URL=... PROVISION_ADMIN_PASSWORD=... pnpm
  provision:admin <email>` (`scripts/provision-admin.ts`, rôle owner, insère
  dans `platform_admins`). Le mot de passe ne transite **jamais** par argv
  (visible via `ps`/l'historique du shell) : il est lu depuis
  `PROVISION_ADMIN_PASSWORD`, ou saisi de façon interactive sur stdin si la
  variable est absente. Un email déjà provisionné (23505) renvoie un message
  d'erreur clair, sans stack trace.
- **Rôle `factelec_worker`** (3.5) : créé par `scripts/db-init/00-roles.sql`
  en dev/test — **en production, à provisionner manuellement AVANT
  d'appliquer la migration `0029`** (création du rôle + secret +
  `DATABASE_URL_WORKER`), au même titre que `factelec_app` au déploiement
  initial. Aucun script de provisioning dédié fourni (item Xavier). Voir §
  Consentement scellé, rôle worker & re-résolution ambiguous — 3.5.

## Tests

- **Postgres réel** (Testcontainers, aucun mock de persistance) pour tous
  les tests e2e — RLS, transactions, contraintes d'unicité et curseur keyset
  sont exercés contre un vrai moteur, pas une simulation.
- **Isolation cross-tenant** vérifiée à deux niveaux : DB (policies RLS,
  `SET app.tenant_id` puis lecture/écriture croisée) et HTTP (`GET
  /invoices/:id` d'un autre tenant → 404 byte-identique à un vrai
  not-found).
- **Curseur de pagination micro-précis** : le curseur keyset transite par une
  représentation texte en microsecondes (`to_char(created_at AT TIME ZONE
  'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`) plutôt que par un `Date` JS
  (précision milliseconde), pour éviter la perte de lignes dont le timestamp
  partage la même milliseconde qu'une borne de page (cas réaliste en cas
  d'ingestion par lot).
- **Contrat volontaire d'un curseur malformé** : un `cursor` illisible (mal
  recollé par un client, tronqué, etc.) ne renvoie jamais une erreur 400 —
  `decodeCursor` renvoie `null`, silencieusement traité comme « pas de
  curseur » (redémarrage en première page).
- **Isolation admin↔tenant** vérifiée dans les deux sens (`admin.e2e.test.ts`) :
  une session admin plateforme ne peut ni lire `/api-keys` ni la lecture des
  factures (`TenantAuthGuard` la refuse explicitement) ; une session tenant
  ne peut pas accéder à `/admin/tenants` (403).
- **Redis réel** (Testcontainers, `@testcontainers/redis`) pour tous les
  tests e2e touchant à la file (`queue-readiness`, `async-generation`,
  `session-purge`) — aucun mock BullMQ/ioredis.
- **Worker bouclé en-process** (`tests/e2e/helpers/worker.ts#createTestWorker`)
  : le **vrai** `WorkerModule` est monté contre le Postgres/Redis de test
  (mêmes overrides que l'app HTTP de test), pas un double — les e2e
  `async-generation.e2e.test.ts` exercent la génération asynchrone de bout
  en bout (`received → generating → generated`), les retries/échec définitif
  (`failed` après épuisement, générateur stub qui throw), et la
  réconciliation (factures orphelines re-enfilées, jobs `failed` évincés).
- **Cycle de vie CDV** (`lifecycle-persistence.e2e.test.ts`,
  `lifecycle.e2e.test.ts`) : transitions valides/invalides (422), motif
  requis (`refusee`/`suspendue`), CAS anti-race (409 sur écriture
  concurrente simulée), historique ordonné, isolation cross-tenant (404),
  immuabilité du journal vérifiée au niveau grants (tentative `UPDATE`/
  `DELETE` par `factelec_app` rejetée par Postgres, pas seulement par le
  code applicatif).
- **Dette de test mineure documentée** : l'ordonnancement de certaines
  assertions e2e sur l'historique du journal CDV s'appuie sur l'ordre
  d'insertion plutôt que sur un critère explicite indépendant du timing —
  fragile en théorie si deux transitions successives partageaient un
  timestamp identique à la microseconde ; non observé en pratique (chaque
  transition est sa propre transaction), à muscler (tri secondaire explicite)
  si la suite devenait flaky.
- **E-reporting Flux 10** (plan 2.3) : validation XSD **réelle** (`xmllint`
  exécuté, pas simulé) contre `ereporting.xsd` DGFiP, y compris un test négatif
  prouvant le rejet local `REJ_SEMAN` sur une donnée réellement invalide
  (pas un stub) ; agrégation testée avec assertions de **montants exacts**
  (pas seulement de structure) sur les cadres simples et l'exclusion des
  cadres mixtes ; machine à états 300/301 et désambiguïsation
  `rejectOrigin` ; A2 (index unique partiel `IN`) prouvé au niveau SQL réel
  (deux insertions concurrentes → une seule ligne, zéro événement dupliqué) ;
  ordonnanceur testé en e2e (déduplication `jobId`, fenêtre bornée) ; worker
  bouclé en-process (`createTestWorker`) exerçant le pipeline complet
  période→agrégat→XML→validation→persistance→transmission, y compris la
  transmission à blanc (aucune écriture, aucun appel au port). **Dette de
  test acceptée** (revue Task 9) : la course 300/301 concurrente est prouvée
  par le CAS SQL (`UPDATE ... WHERE status='transmitted'`), pas par un e2e
  concurrent explicite (deux requêtes HTTP simultanées) — jugé suffisant, le
  CAS étant la garantie réelle, pas une simulation de test.
- **Scellement/hash couverts par des vecteurs déterministes** (Task 3) : un
  vecteur canonique **constant** (genesis + événement entièrement spécifié →
  SHA-256 attendu hardcodé) verrouille la canonicalisation contre toute
  dérive ; un test **croisé** prouve `hash` calculé par le trigger DB == hash
  recalculé côté TypeScript pour le même événement (double preuve DB↔Node).
  Tentative d'altération/suppression de maillon prouvée détectée par
  `verifyTenantChain` **au niveau base réelle** (Testcontainers), pas
  simulée.
- **Annuaire Flux 13/14** (plan 2.4) : validation XSD **réelle** (`xmllint`
  exécuté, pas simulé) dans les **deux directions** (génération F13 +
  parsing F14) contre les schémas DGFiP réels, y compris un test négatif
  prouvant le rejet (« born-rejetee ») sur un F13 réellement invalide ;
  résolution de routage prouvée **indépendante de l'ordre** des entrées
  (permutation testée unitairement et en e2e) ; gate consentement (422)
  couverte pour les 4 cas de couverture (SIREN/SIRET/routage/suffixe) ;
  A-DEADLOCK prouvé au niveau SQL réel (redéfinition après rejet/masquage
  acceptée, ligne active → 409, sans fenêtre de double-slot) ; sweep de
  reprise des drafts figés exercé en e2e (draft âgé avec F13 déjà émis avant
  crash simulé → republié avec le `trackingRef` d'origine, write-once
  prouvé) ; synchronisation différentielle (upsert seul) vs complète
  (remplacement du miroir du tenant) testées séparément, y compris le
  no-op sur F14 vide ; worker bouclé en-process (`createTestWorker`)
  exerçant le pipeline complet ingestion Flux 14 → miroir.
- **Transmission des CDV / Flux 6** (plan 3.1) : matrice DAG vérifiée par un
  oracle `EXPECTED_TRANSITIONS` **indépendant** de `ALLOWED_TRANSITIONS`
  (retranscrit à la main, jamais une boucle auto-référente — filet du futur
  swap AFNOR), les 4 anomalies mandatées testées nommément
  (`212→213` refusé, `207→205`/`208→204`/`206→205` acceptés) ; génération F6
  vérifiée chemin par chemin contre le xlsx source (MDT-74 premier enfant,
  format fixe `'False'`) ; validation structurelle testée en positif **et**
  en négatif (F6 réellement malformé → rejeté) ; machine de livraison à
  oracle indépendant (`prepared→transmitted→{acknowledged,rejected}`,
  `parked` non terminal) ; anti-double-envoi (3 couches) prouvé au niveau SQL
  réel (index unique `(invoice_id, to_status, target)`, deux insertions
  concurrentes → une seule ligne) ; désambiguïsation rejet local
  (`prepared/parked → rejected`) vs 601 réel (`transmitted → rejected`)
  vérifiée aux deux niveaux (repository et e2e) ; late-601-après-acceptation-
  implicite prouvé refusé en 409 **sans** événement fantôme ; reprise
  `parked→transmitted` avec persistance de `xml`/`recipientMatricule` au
  resume (fix injecté revue Task 6/7) ; worker bouclé en-process exerçant le
  pipeline complet sweep→génération→port→persistance, y compris le
  stuck-retry des `parked`.
- **Couture annuaire → émission** (plan 3.3, Task 1/2) : oracle **indépendant**
  (seed d'une ligne d'annuaire à plateforme connue → `recipient_platform` ==
  cette plateforme ; pas de ligne → `'unaddressable'`) ; les 4 branches de
  `resolveAndRecord` testées séparément (résolu/unaddressable/ambiguous/
  erreur opérationnelle), y compris l'idempotence (deux appels → même
  écriture déterministe) ; e2e worker bouclé en-process
  (`invoice-routing.e2e.test.ts`) prouvant la résolution **et** la
  non-régression (les formats sont générés et servis indépendamment du
  routage) ; isolation RLS par tenant sur `routing_status`/
  `recipient_platform` ; extraction *Party→Maille* (D5) vérifiée
  **comportement-préservante** — la suite CDV reste verte, inchangée.
- **Codes-routage** (Task 3) : liste filtrée par tenant/SIREN, tableau vide
  (pas 404) si aucun code ou SIREN cross-tenant (non-fuite RLS), dual-auth,
  422 sur SIREN malformé.
- **Durcissements transverses** (Tasks 4-7) : les **8 routes** UUID
  harmonisées prouvées `toEqual` entre `:id` malformé et UUID inconnu (corps
  byte-identique, jamais 500) ; `CasStaleError` testée aux **7 sites CAS**
  des repos et aux **5 catch** des 3 services, un témoin par sortie (409 /
  `StaleLigneTransitionError` / `'skipped'`) prouvant la non-régression de
  contrat ; verrou d'architecture apiKeyId exercé contre les sources réelles
  (`apikeyid-setters.arch.test.ts`) ; teardown du pool prouvé idempotent
  (`onModuleDestroy` appelé deux fois → `pool.end` invoqué une seule fois).
- **Reprise & retransmission** (plan 3.4) : **chemin RE** — `buildTransmissionRef`
  RE discriminé vs IN **byte-identique** (oracle indépendant) ; worker
  bouclé en-process (`ereporting-retransmission.e2e.test.ts`) prouvant la
  régénération **complète** depuis les données source **actuelles**
  (modification puis re-RE → nouvelle transmission distincte), la
  **retry-idempotence** (même job rejoué → `created:false`, aucune ligne
  dupliquée) et que **l'IN n'est jamais effacé ni muté** ; garde-fous D4
  testés à l'unité (déclarant inconnu → 404, aucun IN → 409, IN `prepared`
  → 409 **même corps**, déclarant inactif → **autorisé**, anti-double-clic
  concurrent → même `jobId`) ; endpoint bout-en-bout (`POST` 202 → le worker
  produit la transmission RE). **Sweep routage** — `pending`/`unaddressable`
  résolus (`recipient_platform` prouvé après sweep), `ambiguous` **jamais**
  balayé (même au-delà de la gate 15 min), gate de fraîcheur prouvée
  (`pending` frais non repris), isolation multi-tenant du balayage
  cross-tenant. **Filtre de liste** — filtre + exposition, **pagination
  cohérente avec filtre actif** (keyset intact, aucun saut/doublon),
  `routingStatus` invalide → 422, comportement inchangé sans filtre.
- **Consentement scellé, rôle worker & re-résolution ambiguous** (plan 3.5) :
  **scellement** — vecteur canonique **littéral** re-vérifié par un outil
  tiers indépendant (`python3 hashlib`, pas seulement le code du projet) ;
  paire d'injection frontière (deux preuves distinctes ne collisionnant
  jamais) **et** absent-vs-vide (`siret`/`routageId`/`suffixe` non fournis vs
  chaîne vide) réellement testées ; rejeu de la **même** preuve à horloge
  **dérivante** → même `sealRef` **et** `sealedAt` du premier scellement
  (l'horloge n'est jamais appelée sur un stat-hit) ; `ENOENT` mappé en erreur
  typée au contrat `verify`. **Rôle worker** — matrice de grants vérifiée
  **grant par grant** contre les migrations d'origine (14 tables + 9
  fonctions `SECURITY DEFINER`) ; **suffisance** prouvée empiriquement (les
  suites `heavy` tournent intégralement sous `factelec_worker`, refus
  `42501` sur `authenticate_api_key` et sur les tables hors inventaire) ;
  négatif RLS cross-tenant **sous le rôle worker** (isolation active, pas
  seulement héritée). **Re-résolution ambiguous** — les 4 branches de
  `resolveRouting` (404 UUID invalide, 404 inconnue/cross-tenant, 409
  non-`ambiguous`, 200 `resolveAndRecord` verbatim) ; e2e bout-en-bout sans
  worker (suite `light`). **Épisode sécurité (Task 4bis)** — les 6 e2e
  négatifs annuaire (viewer + CSRF manquant ×3 rôles, sur les 3 routes) ont
  **réellement exécuté** les mutations avant correctif (faille démontrée,
  pas supposée), `403` après ; verrou d'architecture composition dual-auth
  (`dual-auth-composition.arch.test.ts`) passant **sans exclusion**, grep
  indépendant du relecteur = 6/6 routes conformes.
- **Révocation de consentement** (plan 3.6) : idempotence prouvée **par
  valeurs** (2ᵉ révocation → même `revokedAt`, relecture SQL indépendante,
  pas une confiance dans l'implémentation) ; 404 byte-identique sur les 3
  chemins convergents (inconnu, cross-tenant RLS, `:id` malformé) ; **non-
  régression réelle du gate de publication** exercée sur les **deux**
  chemins (`consentId` révoqué → 422 ; auto-découverte après révocation du
  seul consentement couvrant → 422), y compris un **contrôle positif
  in-file** (`publishOk` 201 **avant** révocation, causalité complète
  201→422) ; `dependentActiveLignes` semé par des transitions machine
  **valides** (oracle `findLigne` ×4 statuts) ; isolation multi-tenant de la
  révocation (RLS). Verrou M1 étendu 6→7, sans exclusion. Suite **LIGHT**
  (aucun `createTestWorker`) — `heavy-suites.arch`/`apikeyid-setters.arch`
  inchangés sans modification.
- **Couverture ≥ 90 % bloquante** (lignes/fonctions/statements/branches,
  `vitest.config.ts`, seuils fusionnés sur l'agrégat des projets `heavy` +
  `light`, § Durcissements transverses), exclusions limitées au bootstrap et
  au câblage DI pur (`main.ts`, `**/*.module.ts`, `src/db/migrations/**`).
  État actuel : 165 fichiers, **1167 tests**, couverture
  **97.86 / 94.27 / 95.77 / 98.15 %** (statements/branches/functions/lines).

```sh
pnpm test          # apps/api : Vitest + Testcontainers (Postgres + Redis, Docker requis)
```

## Limites v1 / TODO

- **Résolu en 2.2** : scellement cryptographique du journal (chaîne SHA-256
  par tenant imposée par la base) + vérification d'intégrité indépendante ;
  archivage à valeur probante (port `ArchiveStore` + implémentation locale
  write-once testable) ; export PAF (JSON/CSV) ; retrait de la FK cascade du
  journal (`ON DELETE RESTRICT`) ; cap de réconciliation + DLQ des factures
  poison. Voir §§ Scellement/Archivage/PAF/DLQ ci-dessus.
- **Limite intrinsèque du scellement (2.2, honnêteté probatoire) — NON
  résolue par ce plan** : le hash-chain auto-contenu ne détecte **ni** la
  troncature du dernier maillon (la chaîne restante `1..n-1` reste valide),
  **ni** une réécriture complète et cohérente de la chaîne par un accès
  propriétaire (le genesis est dérivé publiquement du `tenant_id`, donc
  recalculable). Ces deux modes ne seront couverts que par l'**ancrage de
  tête** dans l'archive WORM externe, effectif une fois l'adaptateur S3
  object-lock **activé au déploiement** (`ARCHIVE_DRIVER=s3`, non fourni en
  2.2). Voir § Scellement — Limites de détection.
- **WORM matériel non fourni en 2.2** : `LocalFilesystemArchiveStore`
  (`chmod 0o444`) est une immuabilité **applicative locale**, pas un WORM
  matériel — le véritable object-lock (refus de modification même par le
  propriétaire du compte cloud pendant la rétention) vient de l'adaptateur
  S3 `ARCHIVE_DRIVER=s3`, à fournir et activer **au déploiement**.
- **PAF non normalisée** : aucune spécification externe v3.2 ne définit de
  format PAF/scellement DGFiP — le format JSON/CSV livré est une conception
  **projet**, sans conformité de schéma DGFiP revendiquée.
- **PAF CSV — injection de formule, volontairement non assainie** : le CSV
  reproduit verbatim le contenu scellé (y compris un `reason` commençant par
  `= + - @`) ; à ouvrir comme donnée/texte, jamais à exécuter dans un
  tableur. Un assainissement par défaut corromprait la fidélité probatoire —
  non appliqué.
- **Résolu en 2.1** : génération asynchrone par workers BullMQ (était
  synchrone en 1.3/1.4) ; `last_used_at` (table `api_keys`) écrit à chaque
  authentification réussie ; purge périodique des sessions expirées (job
  BullMQ répétable). Voir § Architecture workers pour le détail.
- **Fenêtre résiduelle de réconciliation** (2.1, documentée, non couverte
  par un verrou distribué) : un `SIGTERM` du worker frappant exactement
  entre le marquage `generating` et la transaction `completeGeneration`
  laisse la facture bloquée jusqu'au balayage suivant — bornée à
  `RECONCILIATION_GENERATING_STALE_MS` (~15 min par défaut), jamais
  indéfiniment. Voir § Architecture workers.
- **Résolu en 3.1** : la machine à états CDV **chronologie monotone** de
  2.1 (bloqueur go-live documenté, matrice **fausse** sur 4 points) est
  **remplacée** par une **matrice DAG data-driven** (4 anomalies mandatées
  corrigées, paramétrée pour un futur swap AFNOR sans toucher au reste du
  code). **Reste une interprétation projet, en attente d'AFNOR XP Z12-012**
  (achat, item Xavier) — **la table entière**, pas seulement les 4
  corrections ; amendement A3 documenté (212-terminal, sur-ensemble du
  mandat dur). Voir § Cycle de vie CDV.
- **`last_used_at` : contention potentielle sous forte concurrence** (2.1)
  — `authenticate_api_key` exécute désormais un `UPDATE ... RETURNING` à
  **chaque** authentification (verrou de ligne implicite sur la clé API
  concernée) ; un même client émettant un très fort volume de requêtes
  concurrentes avec la **même** clé API pourrait observer une légère
  sérialisation sur cette ligne. Non mesuré en charge réelle à ce jour — à
  surveiller si un tenant à très haut débit d'ingestion apparaît ; piste de
  correction si nécessaire : différer/regrouper l'écriture (throttling) au
  lieu d'un `UPDATE` synchrone par requête.
- **Rate limiting par IP uniquement**, pas encore par tenant/clé — non
  planifié à ce jour.
- **Expiration glissante des sessions** différée : seule l'expiration
  **absolue** (`SESSION_TTL_HOURS`) est implémentée (D1 amendé, plan 1.4) ;
  pas de renouvellement à l'usage.
- **Durcissement de la session admin** (TTL réduit spécifique, distinct de
  `SESSION_TTL_HOURS`) différé — la session super admin partage aujourd'hui
  la même durée de vie absolue que les sessions utilisateur.
- **`Content-Disposition`** absent sur les téléchargements de formats
  (`GET /invoices/:id/formats/:format`) : le fichier s'ouvre dans l'onglet
  plutôt que de déclencher un téléchargement nommé — raffinement différé.
- **Garde anti-double-clic** absente côté client sur les mutations
  (création de clé API, ingestion) — différée.
- Provisioning tenant : **self-service** via `POST /auth/signup` (plan 1.4)
  **et** CLI `pnpm provision:tenant` (conservé). Provisioning **super
  admin** : **CLI exclusivement** (`pnpm provision:admin`), aucune
  inscription self-service — décision assumée, pas une limitation à lever.
- **Résolu en 2.3** : e-reporting DGFiP Flux 10, sous-flux **10.3 (B2C
  domestique)** de bout en bout — classification par facture, agrégation
  BT→TT, génération/validation XSD, machine à états 300/301, cadence par
  régime TVA, transmission (port différé au déploiement), acquittements et
  endpoints de consultation. Voir §§ E-reporting / Runbook opérationnel
  ci-dessus pour le détail complet et les différés.
- **Validation XSD e-reporting = structurelle uniquement** (2.3, honnêteté) —
  aucun schematron/contrôle sémantique Annexe 7 implémenté ; un flux
  XSD-valide peut être rejeté 301 par le PPF pour un motif sémantique. Voir
  § Génération et validation XML.
- **Deadlock du slot A2** (2.3, MEDIUM, fail-safe) — le slot `IN` rejeté
  reste **définitivement** occupé (voulu, ne jamais retirer `rejetee` de
  l'index). **Débloqué en 3.4** par une voie **parallèle** (le chemin RE,
  `POST /ereporting/retransmissions`), **conditionnellement** pour le cas
  `rejectOrigin='local'` (interprétation flaggée, à valider en pilote PPF —
  voir § Chemin RE / § Runbook ci-dessus). Le cas `rejectOrigin='ppf'` est
  débloqué **sans réserve**.
- **`invoiceCount` sur-compte les factures 10.3 à cadre mixte différées**
  (2.3, toujours vrai en 3.2 pour les cadres mixtes **non naturés**) —
  métadonnée indicative uniquement ; les montants déclarés restent exacts.
  Voir § Agrégation et classification.
- **Rôle SD `find_ereporting_declarants_due` cross-tenant** (2.3, dette
  sécurité) — expose `(tenant_id, siren, name)` de tous les tenants au rôle
  applicatif partagé API/worker ; à durcir au split du rôle worker au
  déploiement. Voir § Runbook opérationnel.
- **Aucun endpoint/CLI de provisioning des déclarants e-reporting** (2.3) —
  `EreportingRepository.upsertDeclarant` existe et est testé mais n'est
  exposé par aucune route HTTP ni script CLI à ce jour.
- **Résolu en 2.4** : annuaire central Flux 13/14, **domaine PA** de bout en
  bout — ligne d'adressage (4 mailles, validité semi-ouverte, résolution la
  plus spécifique d'abord), génération F13 + parsing F14 validés XSD dans
  les deux directions, miroir de consultation PII-minimal, publication
  consent-gated (422) avec gestion de slot (409 + libération), acquittements
  et synchronisation bornée (différentiel/complet + sweep de reprise des
  publications figées). Voir §§ Annuaire central / Runbook opérationnel —
  Annuaire ci-dessus pour le détail complet et les différés.
- **Qualifiant de routage annuaire `'9999'` — placeholder à confirmer avec la
  DGFiP/PPF avant production** (2.4, `ROUTAGE_SCHEME_ID_PLACEHOLDER`) — le
  XSD n'exprime qu'une contrainte négative (≠ 0002/0009), aucune valeur
  positive n'est normée dans la documentation disponible. Voir § Génération
  Flux 13 / parsing Flux 14.
- **Résidu du sweep de reprise des publications figées** (2.4, INFO) — une
  ligne republiée après un crash post-écriture-F13 renvoie le `trackingRef`
  **d'origine** (write-once voulu), jamais recalculé sur un état muté entre
  temps. Voir § Runbook opérationnel — Annuaire.
- **Révocation de consentement annuaire non exposée** (2.4) — la colonne
  `annuaire_consents.revoked_at` existe et est respectée à la lecture.
  **Résolu en 3.6** (`POST /annuaire/consents/:id/revoke`, révocation-seule,
  aucune cascade sur l'adressage déjà publié) — voir § Révocation de
  consentement — 3.6 ci-dessus.
- **Rôle SD `find_annuaire_sync_targets`/`find_stale_annuaire_drafts`
  cross-tenant** (2.4, même dette que `find_ereporting_declarants_due`
  2.3) — exposent des identifiants de tenants au rôle applicatif partagé
  API/worker ; à durcir au même split du rôle worker que 2.3.
- **Résolu en 3.1** : transmission des CDV (message de statut Flux 6/CDAR)
  de bout en bout pour les **4 statuts obligatoires** (200/210/212/213) vers
  les **deux cibles** (PPF réglementaire + destinataire résolu par
  l'annuaire 2.4) — machine de livraison distincte (`prepared→transmitted→
  {acknowledged,rejected(601)}`, `parked` retryable), ordonnanceur borné 24h
  (fenêtre de rattrapage 48h), anti-double-envoi 3 couches, frontière
  d'acquittement (accept implicite/601) et endpoints de consultation
  dual-auth. Voir §§ Transmission des CDV / Runbook opérationnel —
  Transmission CDV ci-dessus pour le détail complet et les différés.
- **Aucun XSD DGFiP pour le Flux 6/CDAR** (3.1, honnêteté) — validation
  **structurelle en code** uniquement (posture PAF) ; sous-ensemble MINIMAL
  de MDT émis (7 MDT Requis-PPF non émis, à compléter à l'homologation) ;
  Issuer/Recipient assouplis vs la source (`R`→optionnels). Voir § Format
  F6 / CDAR.
- **Panne worker CDV > 48h non rattrapée automatiquement** (3.1, MEDIUM,
  fail-safe) — un événement de statut obligatoire sorti de la fenêtre de
  rattrapage bornée (48h) avant le retour du worker n'est jamais rattrapé
  par le sweep suivant ; procédure manuelle documentée (élargissement
  ponctuel de `p_since`). Voir § Runbook opérationnel — Transmission CDV.
- **Slot CDV occupé par un `rejected`** (3.1, même motif que le slot A2
  e-reporting 2.3) — un faux-rejet (601 erroné, ou F6 invalide corrigé
  depuis) occupe définitivement son slot `(invoice_id, to_status, target)` ;
  reset manuel hors-bande requis, aucun endpoint de redrive. Voir § Runbook
  opérationnel — Transmission CDV.
- **Rôle SD `find_cdv_transmissions_due`/`find_parked_cdv_transmissions`
  cross-tenant** (3.1, même dette que 2.3/2.4) — exposent `tenant_id` de
  tous les tenants au rôle applicatif partagé API/worker ; à durcir au même
  split du rôle worker.
- **Résolu en 3.2** : ventilation biens/services et paiements TB-3 — discriminant
  `nature` optionnel au niveau ligne (rétro-compat JSONB sans migration,
  `computeVatBreakdownByNature`, total conservé) ; cadres mixtes M1/M2/M4
  **réellement ventilés** (TLB1/TPS1) pour les factures **naturées** ; **10.1
  B2Bi émis par facture** (TG-8), misrouting résolu (statut d'acheteur prime
  le pays) ; **paiements TB-3 capturés** (`POST /payments`, idempotent,
  intégrité anti-taux-inconnu et anti-sur-encaissement) et **agrégés/transmis**
  (10.2 per-facture / 10.4 agrégé) selon la règle **SERVICES-ONLY** (note 119) ;
  **2ᵉ cadence de transmission dédiée** (Tableau 13, paiements ≠ transactions
  pour le régime mensuel) ; ordonnanceur à 3 couches étendu (`flux_kind='payments'`).
  Voir §§ Agrégation et classification / Paiements / Cadence / Runbook
  opérationnel ci-dessus pour le détail complet et les différés.
- **Sur-encaissement concurrent (TOCTOU)** (3.2, MEDIUM, non résolu) — deux
  captures de paiement concurrentes sur des références distinctes peuvent
  toutes deux passer le contrôle anti-sur-encaissement avant l'écriture de
  l'autre ; aucun verrou/contrainte DB en place, procédure de vigilance
  documentée. Voir § Runbook opérationnel.
- **Validation de la devise capturée absente** (3.2) — `POST /payments`
  n'oppose `currency` ni à `invoice.currency` ni à une liste ISO 4217. Voir
  § Paiements.
- **Rôle `viewer` non testé en e2e sur `POST /payments`** (3.2) — refus
  prouvé au niveau unitaire `RolesGuard` seulement.
- **`PAYMENTS_SWEEP_EVERY_MS`/`PAYMENTS_LOOKBACK_MS` déclarées, non
  consommées** (3.2) — la passe paiements partage aujourd'hui le
  planificateur/la fenêtre bornée des transactions ; variables réservées à
  un futur découplage. Voir § Variables d'environnement.
- **Résolu en 3.3** : couture `resolveRecipient` à l'émission — **le trou
  fonctionnel PDP hérité de 2.4 est fermé** (résolution câblée dans le
  worker de génération, best-effort strict, métadonnée de routage mutable
  sans mutation du CDV scellé) ; endpoint `GET /annuaire/codes-routage`
  (énumération de gestion, POST autonome refusé) ; validation UUID
  harmonisée (404 anti-fuite byte-identique sur 8 routes, jamais 500) ;
  erreurs CAS typées (`CasStaleError`, 3 `CAS_STALE_RE` supprimées) ; verrou
  d'architecture sur le footgun `apiKeyId` ; teardown de pool idempotent +
  split Vitest heavy/light. Voir §§ Couture annuaire → émission /
  Durcissements transverses ci-dessus.
- **Résolu en 3.4** : sweep de reprise du routage (`RecipientRoutingRetryService`,
  miroir `ArchiveRetryService`, `pending`+`unaddressable`, `ambiguous` exclu,
  anti-famine amendement M-D7-1) — **soldé l'amendement M1 BINDING de 3.3**
  (un `routing_status='pending'` opérationnel n'était jamais repris
  automatiquement) ; filtre de liste `GET /invoices?routingStatus=` +
  exposition `routingStatus`/`recipientPlatform` sur `GET /invoices`
  (**l'ancienne requête SQL opérateur devient inutile**). Voir §§ Couture
  annuaire → émission (amendement M1) / Filtre de liste ci-dessus pour le
  détail complet.
- **Chemin RE (rectificatif)** — `POST /ereporting/retransmissions`,
  régénération complète sur jugement opérateur, retry-idempotente (défense
  3 couches, index partiel `0027`). **Débloque le deadlock du slot A2
  (2.3)**, mais de façon **conditionnelle** : pour un IN né-`rejetee` **local**
  (`rejectOrigin='local'`, le PPF n'a rien vu de la période), l'admission
  d'un RE reste une **interprétation projet flaggée, à valider en pilote
  PPF** — l'extraction primaire est silencieuse sur ce cas précis. Voir §§
  Chemin RE / Runbook — Deadlock du slot A2 ci-dessus.
- **Garde composé `DualAuthMutationGuard` — REFUSÉ à nouveau (3.5, D7 amendé
  en voie médiane par M1)** — le seuil « 4ᵉ+ route » évoqué en 3.3/3.4 est
  désormais **largement dépassé** (6 routes qualifiantes : 3 mutations
  annuaire + `retransmit` + `resolveRouting` + `capture`, § Consentement
  scellé, rôle worker & re-résolution ambiguous — 3.5). Le refus reste
  **ratifié**, mais le résidu **grave** que ce garde composé aurait pu
  prévenir (omission pure d'un guard entier, pas seulement le footgun
  `apiKeyId`) est désormais couvert par un **second** verrou d'architecture
  (`dual-auth-composition.arch.test.ts`, § Verrou d'architecture —
  composition dual-auth ci-dessus) — lui-même un **ralentisseur** (scan
  textuel mono-ligne `@UseGuards`), pas une barrière d'exécution.
- **Worker-role split — RÉSOLU CÔTÉ CODE en 3.5, déploiement différé** —
  `factelec_worker` existe (grants dérivés de l'inventaire réel, § ci-dessus)
  et le worker s'exécute **exclusivement** sous ce rôle depuis cette version
  (`WorkerModule`/`DATABASE_URL_WORKER`, plus de partage `factelec_app`).
  ⚠️ **Reste ouvert** : (a) le provisioning prod du rôle (secret +
  `DATABASE_URL_WORKER`) — **item Xavier**, bloquant au déploiement (le
  worker refuse de démarrer sans) ; (b) `factelec_app` conserve **tous** ses
  grants historiques, y compris `EXECUTE` sur les fonctions `SECURITY
  DEFINER` cross-tenant (`find_ereporting_declarants_due` 2.3,
  `find_annuaire_sync_targets`/`find_stale_annuaire_drafts` 2.4,
  `find_cdv_transmissions_due`/`find_parked_cdv_transmissions` 3.1,
  `find_pending_routing_invoices` 3.4) — la migration `0029` n'effectue
  **aucun** `REVOKE` sur ce rôle ; un durcissement de suivi (`REVOKE` sur
  `factelec_app` une fois la bascule prod confirmée) reste à faire.
- **Résolu en 3.5** : scellement structurel du consentement annuaire
  (`ConsentSignaturePort`, intégrité sha256 + horodatage + write-once WORM,
  **aucune** signature qualifiée — fournisseurs eIDAS réels différés) ;
  rôle Postgres `factelec_worker` de moindre privilège (grants dérivés de
  l'inventaire réel, isolation RLS prouvée sous le rôle, déploiement
  différé — voir ci-dessus) ; endpoint de re-résolution manuelle d'un
  routage `ambiguous` (`POST /invoices/:id/routing/resolve`, solde F-2/3.4,
  honnêteté L1 sur le `200` encore `ambiguous`). **Épisode sécurité non
  planifié** : faille annuaire héritée de 2.4 (3 mutations sans
  `RolesGuard`/`CsrfGuard`, exploitable en session de n'importe quel rôle)
  révélée par l'extension M1 du verrou d'architecture, close par Task 4bis
  (triple garde, preuve RED réelle). Voir § Consentement scellé, rôle
  worker & re-résolution ambiguous — 3.5 ci-dessus pour le détail complet et
  les différés.
- **Résolu en 3.6** : révocation de consentement annuaire (`POST
  /annuaire/consents/:id/revoke`, 7ᵉ mutation dual-auth) — écriture
  `revoked_at` **CAS write-once idempotente** (rejeu → `revokedAt`
  d'origine, monotone), 404 anti-fuite byte-identique, rapport
  `dependentActiveLignes` (anti-silence). **Révocation-seule** (D2,
  ancrage §3.5.5.5 note 85 + sémantique locale de `maskLigne`) : **aucune**
  cascade automatique sur l'adressage déjà publié — le miroir de
  consultation continue de router les tiers vers la plateforme jusqu'à
  l'actualisation opérateur (procédure runbook, transmission Flux 13 réelle
  différée). Verrou M1 étendu 6→7. Voir § Révocation de consentement — 3.6
  ci-dessus pour le détail complet et les différés.

### Différé explicitement (hors périmètre 2.4/3.1/3.2/3.3/3.4/3.5/3.6)

- **E-reporting DGFiP au-delà du 10.1/10.3/TB-3** (Flux 10, plans 2.3/3.2) :
  cadres de facturation mixtes M1/M2/M4 **non naturés** (au moins une ligne
  sans `nature`, différés — aucune ventilation partielle fabriquée),
  paiements pour la part **biens** d'un encaissement (règle services-only,
  note 119 — jamais transmise) et pour la clause « option de TVA sur les
  débits » de la même note (aucun champ correspondant dans `Invoice`),
  auto-seed du statut CDV `212 Encaissée` depuis un paiement capturé
  (**refusé, décision projet**), adaptateurs de transport réels
  (sftp/as2/as4/api), push/acquittement PPF réel (webhook), schematron/
  contrôles sémantiques Annexe 7, provisioning des déclarants (aucun
  endpoint/CLI) — voir §§ E-reporting / Paiements pour le détail de chaque
  point. **Chemin RE : RÉSOLU en 3.4** (§ Chemin RE ci-dessus), sous réserve
  du **RE automatique post-301** (**refusé**, décision projet — un
  déclenchement reste toujours un jugement opérateur).
- **Annuaire au-delà du domaine PA** (Flux 13/14, plan 2.4) : adaptateurs de
  transport réels (API PISTE-OAuth2, EDI SFTP/AS2/AS4), feeds
  d'initialisation INSEE/Chorus/DGFiP (lignes par défaut 9998/Chorus non
  chargées), habilitations réelles, codes routage standalone (6 endpoints
  Swagger différés, `RoutageID` inline seulement — l'**énumération** de
  gestion, elle, est livrée en 3.3, `GET /annuaire/codes-routage`), connecteur
  de signature électronique du consentement — voir § Annuaire central pour
  le détail de chaque point.
  **Câblage de la résolution de routage dans l'émetteur de factures : RÉSOLU
  en 3.3, sweep de reprise + filtre de liste : RÉSOLUS en 3.4, endpoint de
  révocation de consentement : RÉSOLU en 3.6** (§§ Couture annuaire →
  émission / Filtre de liste / Révocation de consentement — 3.6 ci-dessus)
  — restent différés le
  **garde composé** `DualAuthMutationGuard`, le **POST codes-routage**
  autonome (refusé, décision projet — D6), le **filtre de liste par
  `recipient_platform`** (3.4, raffinement sans demande métier), le
  **backoff persistant** du sweep de routage (3.4, colonnes non ajoutées
  tant qu'aucune churn réelle n'est observée) et la mutation `emise`/
  transport réel (adaptateurs de transport, items Xavier).
- **Adaptateur S3 object-lock réel** (`S3ObjectLockArchiveStore`, Scaleway
  Object Storage, mode `COMPLIANCE`, rétention 10 ans) — **spécifié** (même
  contrat que `ArchiveStore`) mais **non écrit** en 2.2 : infra à la main de
  Xavier, non testable sans bucket S3 réel. Activation par
  `ARCHIVE_DRIVER=s3` **au déploiement**. Tant qu'il n'est pas fourni, le
  WORM reste applicatif-local uniquement et l'ancrage de tête (seul rempart
  contre la troncature/réécriture de chaîne, cf. § Scellement) n'est pas
  effectif.
- **`CREATE EXTENSION pgcrypto`** — présente et vérifiée sur `postgres:17-alpine`
  (dev/CI/Testcontainers) ; **à confirmer** sur le Postgres managé Scaleway
  visé en production (extension contrib standard, généralement disponible
  sur les offres managées, mais non vérifiée sur l'infra réelle à ce jour).
- **Transmission CDV au-delà du socle 3.1** : adaptateurs de transport réels
  (`sftp`/`as2`/`as4`/`as4-peppol`/`api`, D1/D7), adhésion **OpenPeppol** +
  PKI test/prod + SMP + stack AS4 (préalable à `as4-peppol` réel),
  acquittements réseau/PPF réels (push — `CdvStatusService.recordAck` reste
  la frontière, exercée par les e2e), transmission des 10 statuts CDV
  **facultatifs**, ingestion d'un F6 entrant, MDT Requis-PPF non émis (4/5/
  21/40/91/95/97, à compléter à l'homologation), confirmation du code
  interface `FFE0614A`, éventuelle vendorisation de l'XSD UN/CEFACT CDAR
  externe — voir § Transmission des CDV pour le détail de chaque point.
  **L'apposition automatique** des transitions CDV **facture** par un
  connecteur/le réseau reste différée : les transitions 2.1 (`POST
  /invoices/:id/status`) demeurent exclusivement pilotées par session
  utilisateur — 3.1 ne livre que la **transmission** des statuts déjà
  décidés, pas leur déclenchement réseau.
- **Remplacement de la matrice de transitions CDV** contre la norme **AFNOR
  XP Z12-012** (payante, hors dépôt, **item Xavier : achat requis**) —
  **bloqueur go-live PDP partiellement résolu en 3.1** : la matrice
  **monotone fausse** de 2.1 est remplacée par une **matrice DAG** corrigeant
  les 4 anomalies mandatées et **paramétrée** pour absorber AFNOR sans
  retoucher le code — mais la table **reste** une interprétation projet en
  attente de la norme (amendement A3 : `encaissee`-terminal, sur-ensemble du
  mandat dur). Ce même bloqueur couvre l'immatriculation PDP côté
  e-reporting (2.3).
- **Journal d'audit des authentifications** (connexions, échecs,
  révocations de session — distinct du journal CDV 2.1) → **horizon 2.x**.
- **Migration Factur-X D22B / 1.09** (héritée d'`invoice-core`, plan
  1.2bis) — différée dans l'attente d'un Schematron D22B publié par
  ConnectingEurope.
- **Consentement, rôle worker & re-résolution au-delà du socle 3.5** :
  fournisseurs eIDAS réels de signature qualifiée (`CONSENT_DRIVER=eidas`,
  item Xavier, throw testé tant que non fourni), déploiement effectif du
  rôle `factelec_worker` (provisioning prod + `REVOKE` de suivi sur
  `factelec_app`, item Xavier), garde composé `DualAuthMutationGuard`
  (**refusé à nouveau**, D7 amendé en voie médiane par M1) — voir §
  Consentement scellé, rôle worker & re-résolution ambiguous — 3.5 pour le
  détail de chaque point. **Révocation de consentement (endpoint/service) :
  RÉSOLUE en 3.6** (§ Révocation de consentement — 3.6 ci-dessus) — restent
  différés côté révocation : la cascade réelle vers le PPF (Flux 13
  masquage + clôture + ligne fallback), la raison de révocation stockée
  (aucune colonne), et les outils d'actualisation post-révocation en masse.
