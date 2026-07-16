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
déploiement. Consomme
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

**Rôle Postgres du worker : `factelec_app`** (D6, comme l'API) — le worker
n'a besoin d'aucun privilège supplémentaire (mêmes tables, même RLS) ; il
partage `DATABASE_URL` avec le process API, jamais `factelec_owner`.

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

**Machine à états** (`src/invoices/lifecycle-status.ts`) — chronologie
monotone : une transition `from → to` n'est valide que si `to` a un code
strictement supérieur à `from`, et si `from` n'est pas terminal (`refusee`
210 et `rejetee` 213, exception l'un vers l'autre y compris) ; motif
(`reason`) **obligatoire** pour `refusee`/`suspendue` (règle G7.25).

> ⚠️ **Interprétation projet, à durcir avant mise en production.** La DGFiP
> ne publie, dans le Dossier général, aucune matrice de transitions
> autorisées (les figures 48/49 du circuit de transmission sont purement
> graphiques, non extractibles en règles machine) — seule la contrainte
> « respect de la chronologie » (G7.19/G7.25/G7.45) est documentée. La
> machine à états ci-dessus encode donc une interprétation **projet**
> (chronologie stricte du code numérique) qui doit être recoupée avec la
> norme **AFNOR XP Z12-012** (hors dépôt DGFiP, à se procurer) avant tout
> passage en production réelle. Cas notable resté ouvert : `212 Encaissée →
> 213 Rejetée` est autorisé par la règle monotone (une facture encaissée
> peut être ultérieurement rejetée pour anomalie détectée après paiement) ;
> AFNOR pourrait l'interdire — à réexaminer lors du durcissement.

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
consultation. **DIFFÉRÉS EXPLICITES — ne pas surpromettre « B2B international
livré »** :

- **10.1/10.2 (B2Bi, transactions internationales)** — `classifyEreportingOperation`
  (`flux10-aggregate.ts`) **classifie** correctement une opération
  transfrontalière en `'10.1'`, mais aucune agrégation ni émission n'en est
  faite : `aggregateTransactions` ne retient que la classe `'10.3'`. Le mapping
  par facture (`TransactionsReport.invoices`, TG-8) reste une infrastructure
  de type non câblée (toujours `[]` en sortie).
- **TB-3 (paiements, 10.2/10.4)** — aucun modèle de capture des encaissements
  n'existe dans `@factelec/invoice-core` ; `Flux10Report.payments` est
  systématiquement `null` (XOR par construction, jamais les deux blocs à la
  fois).
- **Cadres de facturation MIXTES M1/M2/M4** — le modèle `Invoice` n'a **aucun
  discriminant biens/services au niveau ligne** (`vatBreakdown` est groupé par
  taux, pas par nature de ligne). Une ventilation forcée entre TLB1
  (livraisons) et TPS1 (prestations) aurait **doublé** la base et la TVA
  déclarées (un cadre M1 à 1000,00 €/200,00 € aurait été déclaré
  2000,00 €/400,00 €). Décision : les factures à cadre mixte sont **exclues**
  de l'agrégation (différées, comme 10.1/TB-3) plutôt que de fabriquer une
  ventilation incorrecte — une période dont les seules factures 10.3 sont à
  cadre mixte part donc à blanc.
- **Adaptateurs de transport réels** (`sftp`/`as2`/`as4`/`api`) — `EreportingTransmissionModule`
  lève une erreur explicite et testée tant qu'un de ces drivers est
  sélectionné sans implémentation ; seul `local` (write-once testable) est
  câblé en 2.3. Activation **au déploiement**.
- **Push/acquittement PPF réel** — `EreportingStatusService.recordPpfStatus`
  est la **frontière** qu'un futur adaptateur webhook/annuaire appliquera ;
  elle est exercée **directement par les e2e** (aucune route HTTP entrante
  n'existe pour recevoir un acquittement PPF push dans ce plan).
- **Schematron / contrôles sémantiques Annexe 7** — non implémentés ; seule la
  validation **structurelle** XSD est faite (voir plus bas).
- **Chemin RE (rectificatif)** — le type `RE` (`TRANSMISSION_TYPES`) est
  modélisé et n'entre jamais en conflit avec l'index unique `IN`, mais aucun
  flux applicatif ne produit de rectificatif dans ce plan (voir aussi le
  runbook du slot A2 ci-dessous).
- **Provisioning des déclarants** — `EreportingRepository.upsertDeclarant`
  existe et est testé, mais **aucun endpoint HTTP ni script CLI** ne l'expose
  (contrairement à `pnpm provision:tenant`) : à ce jour, une ligne
  `ereporting_declarants` ne peut être créée qu'en insérant directement en
  base ou via un futur endpoint d'administration — non fourni dans ce plan.

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

### Agrégation et classification (10.3)

`classifyEreportingOperation(invoice)` (pure) classe chaque facture en
`'10.1'` (transfrontalière — différée), `'10.3'` (acheteur français **et**
non-assujetti — agrégée) ou `'out'` (acheteur français **et** assujetti —
relève de l'e-invoicing, exclue de l'e-reporting). `aggregateTransactions`
regroupe les factures `'10.3'` éligibles d'une période par (date ‖ devise ‖
catégorie TLB1/TPS1), sommant les montants en `big.js` (BT→TT). **Transmission
à blanc optionnelle** (§2.3.3) : si aucune facture n'est éligible sur la
période (ou si les seules factures 10.3 sont à cadre mixte, différées
ci-dessus), `aggregateTransactions` renvoie `null` et **aucune écriture, aucun
appel au port de transmission** n'a lieu — pas de « transmission vide »
générée pour le principe.

**`invoiceCount` — métadonnée indicative, pas une source de vérité** : ce
compteur (persisté sur `ereporting_transmissions`) compte **toutes** les
factures classées `'10.3'` sur la période, y compris celles à cadre mixte
finalement **exclues** de l'agrégation — il peut donc **sur-compter** par
rapport au nombre réel de factures reflétées dans les montants du XML. Les
**montants déclarés au PPF restent exacts** (aucune facture à cadre mixte
n'entre dans les sommes) ; seul ce compteur est une approximation à ne pas
utiliser comme preuve d'exhaustivité.

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
(hors contexte tenant, miroir de `find_failed_archives` 2.2), calcule pour
chacun les périodes dues (`computeDuePeriods`) et enfile un job
`ereporting-generate` par couple (déclarant, période due). **Trois couches de
défense, aucune suffisante seule** :

1. **Fenêtre bornée** (`MAX_DUE_PERIODS`, `period.ts`) — le balayage ne peut
   jamais ré-enfiler un historique entier.
2. **`jobId` déterministe** `${declarantId}:${fluxKind}:${periodStart}` —
   BullMQ déduplique tant que le job existe encore dans Redis.
3. **Backstop base de données** — l'index unique partiel `WHERE type='IN'`
   (migration `0016`) + `insertTransmission` idempotent (`created: false` →
   le worker relit le statut et saute la période déjà traitée au lieu de la
   ré-émettre au PPF).

Le sweep n'enfile que des transactions **initiales** (`fluxKind='transactions'`,
`type='IN'`) — les paiements (`payments`, différé D10) et les rectificatifs
(`RE`) ne sont jamais enfilés automatiquement.

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
la cause du deadlock du slot A2).

## Runbook opérationnel — e-reporting Flux 10

Section dédiée aux **dettes opérationnelles** identifiées en revue (Tasks 5 et
8), à connaître **avant** toute exploitation réelle.

### Deadlock du slot A2 (MEDIUM, fail-safe — procédure manuelle requise)

**Symptôme.** Une transmission `IN` née `rejetee` (rejet **local**
`REJ_SEMAN`, XML non XSD-valide produit par une donnée source incohérente)
occupe **définitivement** le slot unique (déclarant × flux × période **où**
`type='IN'`) : `rejetee` est un statut **terminal** (§ Machine à états
ci-dessus). Une fois la donnée source corrigée en amont, le balayage suivant
tente de régénérer la période, mais `insertTransmission` retombe sur le
conflit d'index existant (`created: false`), recharge la ligne `rejetee`
existante, et le worker constate un statut **non-`prepared`** → il **ne fait
rien** (`return` silencieux, § `ereporting-generation.service.ts`). **La
période ne peut plus jamais être transmise en `IN` sans intervention.**

**Pourquoi ce n'est PAS un bug à corriger en excluant `rejetee` de l'index.**
L'index unique partiel `WHERE type='IN'` (sans filtre sur le statut) est ce
qui garantit l'**idempotence anti double-envoi** entre `insertTransmission` et
`markTransmitted` (couche 3 de la défense en profondeur ci-dessus) : si un
crash survient entre l'insertion et la transmission effective, le rejeu du
balayage doit retomber sur la **même** ligne, quel que soit son statut, plutôt
que d'en créer une seconde qui serait transmise deux fois au PPF. **Retirer
`rejetee` de cet index rouvrirait cette fenêtre de double-envoi sur crash** —
ne jamais le faire pour « corriger » le deadlock.

**Procédure manuelle (jusqu'à un chantier RE/libération de slot dédié)** :

1. Identifier la transmission bloquée : `GET /ereporting/transmissions` (ou
   requête directe), filtrer `status='rejetee'` et `rejectOrigin='local'`
   (`fromStatus IS NULL` en base) — **ne pas confondre** avec un rejet PPF
   réel (`rejectOrigin='ppf'`), qui lui est un 301 légitime, pas un deadlock.
2. Consulter le motif exact (`GET /ereporting/transmissions/:id/events`) pour
   comprendre l'incohérence source (typiquement une donnée de facturation
   invalide au regard du XSD e-reporting).
3. Corriger la donnée source (facture concernée) dans le système amont.
4. Débloquer le slot par **une** de ces deux voies :
   - **(a)** Supprimer manuellement la ligne `ereporting_transmissions`
     rejetée localement (accès DB direct, rôle propriétaire) — le prochain
     balayage régénérera une transmission `IN` propre pour la période ;
   - **(b)** Attendre un futur chantier **RE/rectificatif** ou de
     **libération de slot** dédié (non livré dans ce plan — `type='RE'` est
     modélisé mais aucun flux applicatif ne le produit à ce jour).
5. Vérifier après re-balayage que la nouvelle transmission `IN` passe bien
   `prepared → transmitted → deposee`.

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
- **Révocation de consentement** — la colonne `annuaire_consents.revoked_at`
  existe et `findConsentById` la respecte déjà (un consentement révoqué ne
  couvre plus aucune publication), mais **aucun endpoint ni méthode
  applicative ne l'écrit** à ce jour : la base supporte la révocation, rien
  ne la déclenche encore.

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

- **`draft`/`published`/`deposee`/`rejetee`/`masked`** portent tous
  `code: null` — **aucun code officiel DGFiP n'est documenté** pour le cycle
  de publication annuaire (contraste avec les 300/301 e-reporting, Tableau
  5/6) : un motif de rejet est une **chaîne libre**, pas un énum
  réglementaire normatif (D6, interprétation go-live).
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
hors `{D,M}`/`{C,D}` validerait le XSD mais ferait échouer l'upsert du miroir
(colonnes enum) ; rejetées explicitement (`UnknownLigneNatureError`/
`UnknownTypeFluxError`) avant d'atteindre toute colonne enum.
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
`SELECT`/`INSERT`/`UPDATE` — la révocation future s'écrirait ici),
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

## Sécurité / multi-tenant

Cette section documente les mécanismes de sécurité destinés à figurer au
dossier d'immatriculation DGFiP (PA/PDP).

### Rôles Postgres

Deux rôles, jamais confondus :

- **`factelec_owner`** — `BYPASSRLS`, `CREATEDB`. Utilisé **uniquement** par
  les migrations (`pnpm db:migrate`) et le provisioning CLI
  (`pnpm provision:tenant`). Propriétaire du schéma `public` et de la
  fonction `authenticate_api_key`. **Jamais utilisé par le process API.**
- **`factelec_app`** — `NOSUPERUSER NOBYPASSRLS NOCREATEDB`. Rôle applicatif
  (runtime), seul rôle dont dispose `DATABASE_URL` — **y compris pour le
  worker** (`src/worker-main.ts`, 2.1), qui partage exactement le même rôle
  et les mêmes politiques RLS que le process API (aucun privilège
  supplémentaire). N'a que `USAGE` sur le schéma, `SELECT/INSERT/UPDATE` sur
  les tables `tenants`/`api_keys`/`invoices`/`invoice_formats`, `SELECT/
  INSERT` **uniquement** (jamais `UPDATE`/`DELETE`) sur `invoice_status_events`
  (append-only, 2.1 — cf. § Cycle de vie CDV), et `EXECUTE` sur
  `authenticate_api_key`/`purge_expired_sessions` — jamais `BYPASSRLS`. (Les
  tables `users`/`sessions`/`platform_admins`, introduites en 1.4, ont leurs
  propres politiques RLS documentées dans `docs/superpowers/`.)

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
| `DATABASE_URL` | URL Postgres du rôle **applicatif** (`factelec_app`, soumis à la RLS) | — (requis) |
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
| `EREPORTING_TRANSMISSION_DRIVER` | Adaptateur de transmission Flux 10 : `local` (`LocalFilesystemTransmissionStore`, testable) \| `sftp`\|`as2`\|`as4`\|`api` (auth transport réelle, **activés au déploiement**, lèvent une erreur explicite tant que non fournis) | `local` |
| `EREPORTING_LOCAL_DIR` | Répertoire local du driver `local` | `./var/ereporting` |
| `EREPORTING_PA_ID` | Matricule émetteur de la Plateforme Agréée (TT-8, TB-1) | `PA00` |
| `EREPORTING_PA_SCHEME_ID` | Schéma d'identifiant de la PA (TT-7, ICD) | `0238` |
| `EREPORTING_PA_NAME` | Raison sociale de la PA (TT-9) | `Factelec PA` |
| `EREPORTING_SWEEP_EVERY_MS` | Périodicité (ms) du job répétable d'ordonnancement e-reporting (`EreportingSweepService`) | `3600000` (1 h) |
| `EREPORTING_GENERATION_JOB_ATTEMPTS` | Tentatives max d'un job de génération e-reporting avant `failed` — distingue une erreur **opérationnelle** (`xmllint` absent, DB/port transitoire) d'un rejet sémantique `REJ_SEMAN` (qui n'est jamais rejoué, il ne throw pas) | `3` |
| `ANNUAIRE_DRIVER` | Adaptateur de transport annuaire : `local` (`LocalFilesystemAnnuaireStore`, testable) \| `api`\|`edi` (API PISTE-OAuth2 / EDI SFTP-AS2-AS4, **activés au déploiement**, lèvent une erreur explicite tant que non fournis) | `local` |
| `ANNUAIRE_LOCAL_DIR` | Répertoire local du driver `local` | `./var/annuaire` |
| `ANNUAIRE_SYNC_EVERY_MS` | Périodicité (ms) de l'ordonnanceur de synchronisation différentielle (Flux 14, quotidien) | `86400000` (24 h) |
| `ANNUAIRE_COMPLETE_EVERY_MS` | Périodicité (ms) de l'ordonnanceur de synchronisation complète (Flux 14, remplacement du miroir du tenant, hebdomadaire) | `604800000` (7 j) |
| `ANNUAIRE_PUBLISH_JOB_ATTEMPTS` | Tentatives max d'un job de la file `annuaire-sync` (ingestion F14 et reprise de draft figé) avant `failed` | `3` |
| `ANNUAIRE_REPUBLISH_SWEEP_EVERY_MS` | Périodicité (ms) du sweep de reprise des publications figées (drafts âgés > 15 min, `find_stale_annuaire_drafts`) | `300000` (5 min) |

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
| `GET /invoices` | Liste paginée (keyset), tenant-scopée | 200, 401 |
| `GET /invoices/:id` | Métadonnées d'une facture (`status` de génération, `lifecycleStatus` CDV) + formats disponibles | 200, 401, 404 |
| `GET /invoices/:id/formats/:format` | Contenu d'un format (`ubl`, `cii`, `facturx`, `flux_base`, `flux_full`) avec le bon `Content-Type` (`application/xml` ou `application/pdf` pour `facturx`) — **404 tant que `status ≠ 'generated'`** | 200, 401, 404 |
| `POST /invoices/:id/status` | Transition de statut CDV (`{ toStatus, reason? }`) — session owner/admin/accountant + CSRF, CAS anti-race | 201, 401, 403, 404, 409, 422 |
| `GET /invoices/:id/status` | Statut CDV courant + historique complet (journal `invoice_status_events`) | 200, 401, 404 |
| `GET /invoices/:id/ledger` | Journal scellé de la facture + vérifications d'intégrité (`integrity` self-check, `chainIntegrity` chaîne complète du tenant) | 200, 401, 404 |
| `GET /invoices/:id/paf` | Piste d'Audit Fiable (`?format=json` défaut \| `?format=csv`, `Content-Disposition: attachment` en CSV) — conception projet, non normalisée DGFiP | 200, 401, 404 |
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
| `GET /ereporting/transmissions` | Liste des transmissions e-reporting Flux 10 du tenant (résumés — **sans** le XML), `rejectOrigin` (`local`\|`ppf`\|`null`) dérivé pour les rejets | 200, 401 |
| `GET /ereporting/transmissions/:id/xml` | XML de la transmission (`text/xml`) — 404 si absente ou d'un autre tenant | 200, 401, 404 |
| `GET /ereporting/transmissions/:id/events` | Journal des statuts de la transmission (`fromStatus`/`toStatus`/`motif`/`actor`) | 200, 401, 404 |
| `GET /annuaire/lignes` | Recherche dans le miroir de consultation (Flux 14) du tenant, filtrée par SIREN | 200, 401 |
| `GET /annuaire/resolution` | Résolution du matricule de plateforme destinataire pour une maille à une date donnée (`?siren&siret?&routageId?&suffixe?&date`) — 404 anti-fuite (inconnu/hors période/hors tenant), 409 si résolution ambiguë | 200, 401, 404, 409 |
| `POST /annuaire/lignes` | Publication d'une ligne d'adressage (D/M) — gate consentement (422), F13 XSD-validé et transmis via le port ; succès partiel au grain ligne (201 même si le statut interne devient `rejetee`) | 201, 401, 422 |
| `PUT /annuaire/lignes/:id` | Fin d'effet : positionne `dateFin` sur une ligne existante du tenant | 200, 401, 404, 409, 422 |
| `DELETE /annuaire/lignes/:id` | Masquage d'une ligne déposée (`deposee → masked`) | 204, 401, 404, 409 |

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
  /invoices/:id/paf`, `GET /ereporting/transmissions*`** (lecture) acceptent
  **soit une clé API, soit une session utilisateur** du même tenant
  (`TenantAuthGuard`, dual-auth) — jamais une session **admin** plateforme,
  refusée par ce guard. Un en-tête
  `Authorization: Bearer` présent est **toujours** résolu en priorité (même
  invalide) : un client machine ne retombe jamais silencieusement sur un
  cookie de session qui traînerait dans la même requête.
- **`/annuaire/*`** (consultation **et** publication/fin d'effet/masquage,
  Task 7/8 plan 2.4) est **entièrement dual-auth** (`TenantAuthGuard`), y
  compris les mutations `POST`/`PUT`/`DELETE` — contrairement à
  `POST /invoices/:id/status` ci-dessous, une clé API machine peut donc
  publier/masquer une ligne d'annuaire au même titre qu'une session
  utilisateur : ce domaine ne porte **aucune** garde CSRF, la publication
  annuaire n'étant pas modélisée comme une mutation pilotée exclusivement
  depuis le dashboard.
- **`POST /invoices/:id/status`** (transition CDV) est une **mutation
  métier** : exclusivement session **owner/admin/accountant** + CSRF
  (`SessionGuard`/`RolesGuard`/`CsrfGuard`) — un `viewer` est refusé (403),
  une clé API n'ouvre pas cette route (`SessionGuard` → 401, pas de cookie).
  L'apposition automatique par un connecteur/le réseau Peppol est différée
  (phase 3).
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
- **Couverture ≥ 90 % bloquante** (lignes/fonctions/statements/branches,
  `vitest.config.ts`), exclusions limitées au bootstrap et au câblage DI pur
  (`main.ts`, `**/*.module.ts`, `src/db/migrations/**`). État actuel : 121
  fichiers, **782 tests**, couverture **97.71 / 94.51 / 95.75 / 98.2 %**
  (statements/branches/functions/lines).

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
- **Machine à états CDV = interprétation projet** (2.1, chronologie
  monotone du code DGFiP) — **à durcir contre la norme AFNOR XP Z12-012**
  avant mise en production réelle ; aucune matrice de transitions formelle
  n'est publiée par la DGFiP dans le dépôt. Voir § Cycle de vie CDV.
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
- **Deadlock du slot A2** (2.3, MEDIUM, fail-safe, non résolu) — une
  transmission `IN` rejetée localement occupe définitivement son slot ;
  procédure manuelle documentée, pas d'automatisation de libération de slot
  à ce jour. Voir § Runbook opérationnel.
- **`invoiceCount` sur-compte les factures 10.3 à cadre mixte différées**
  (2.3) — métadonnée indicative uniquement ; les montants déclarés restent
  exacts. Voir § Agrégation et classification.
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
  `annuaire_consents.revoked_at` existe et est respectée à la lecture, mais
  aucun endpoint/méthode applicative ne l'écrit à ce jour.
- **Rôle SD `find_annuaire_sync_targets`/`find_stale_annuaire_drafts`
  cross-tenant** (2.4, même dette que `find_ereporting_declarants_due`
  2.3) — exposent des identifiants de tenants au rôle applicatif partagé
  API/worker ; à durcir au même split du rôle worker que 2.3.

### Différé explicitement (hors périmètre 2.4)

- **E-reporting DGFiP au-delà du 10.3** (Flux 10, plan 2.3) : 10.1/10.2 B2Bi
  (classifiées mais non émises), TB-3 paiements (10.2/10.4, aucun modèle de
  capture des encaissements), cadres de facturation mixtes M1/M2/M4 (aucun
  discriminant biens/services par ligne dans le modèle `Invoice`),
  adaptateurs de transport réels (sftp/as2/as4/api), push/acquittement PPF
  réel (webhook), schematron/contrôles sémantiques Annexe 7, chemin
  RE/rectificatif — voir § E-reporting pour le détail de chaque point.
- **Annuaire au-delà du domaine PA** (Flux 13/14, plan 2.4) : adaptateurs de
  transport réels (API PISTE-OAuth2, EDI SFTP/AS2/AS4), feeds
  d'initialisation INSEE/Chorus/DGFiP (lignes par défaut 9998/Chorus non
  chargées), habilitations réelles, codes routage standalone (6 endpoints
  Swagger différés, `RoutageID` inline seulement), connecteur de signature
  électronique du consentement, câblage de la résolution de routage dans
  l'émetteur de factures (phase 3), endpoint de révocation de consentement —
  voir § Annuaire central pour le détail de chaque point.
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
- **Transmission Peppol des statuts CDV** et **apposition automatique** des
  transitions par un connecteur/le réseau → **phase 3**. Les transitions
  2.1 sont exclusivement pilotées par session utilisateur.
- **Remplacement de la matrice de transitions CDV** contre la norme **AFNOR
  XP Z12-012** (payante, hors dépôt) → **phase 3**, **bloqueur go-live PDP**
  (D7) — la matrice monotone 2.1 reste une interprétation projet documentée ;
  ce même bloqueur couvre l'immatriculation PDP côté e-reporting (2.3).
- **Journal d'audit des authentifications** (connexions, échecs,
  révocations de session — distinct du journal CDV 2.1) → **horizon 2.x**.
- **Migration Factur-X D22B / 1.09** (héritée d'`invoice-core`, plan
  1.2bis) — différée dans l'attente d'un Schematron D22B publié par
  ConnectingEurope.
