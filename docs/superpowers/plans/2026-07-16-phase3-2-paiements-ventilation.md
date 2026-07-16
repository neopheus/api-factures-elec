# Plan 3.2 — Paiements & ventilation biens/services : solde des différés e-reporting (TB-3, cadres M\*, 10.1 B2Bi)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un **PRÉREQUIS RACINE** (un discriminant biens/services au niveau ligne dans le modèle `invoice-core`) débloque d'un coup **TROIS différés réglementaires** tracés depuis 2.3 :

1. **Cadres MIXTES M1/M2/M4 (e-reporting transactions)** — la ventilation `vatBreakdown` entre **TLB1** (livraisons de biens) et **TPS1** (prestations de services) était **différée honnêtement** en 2.3-T3 (dupliquer le `vatBreakdown` sur les deux catégories **DOUBLAIT** la base et la TVA déclarées : M1 1000/200 → 2000/400). Avec le discriminant ligne, on **construit la vraie ventilation, total conservé** (règle « total conservé » du réviseur 2.3), **jamais doublée** ; les factures M\* **sans** donnée de ligne restent **différées par facture** (skip typé + log, **aucune fabrication**).
2. **Paiements e-reporting (TB-3, Flux 10.2 / 10.4)** — différés en 2.3 **faute de source** (aucune capture des encaissements). On livre la **surface de capture des encaissements** (date + montant **par taux de TVA** par facture, liée à la facture, endpoint dual-auth + persistance RLS), la **2ᵉ table de cadence** (colonne PAIEMENT du Tableau 13 — **différente** des transactions), et l'**agrégation TB-3** à travers le **générateur F10 existant** (`appendPaymentsReport`, déjà écrit en 2.3-T2 ; discipline **transactions XOR paiements**).
3. **Transactions B2B international par facture (10.1, TG-8)** — **classées depuis 2.3 mais jamais émises** (l'agrégateur renvoie `invoices: []`). Le générateur supporte **structurellement** `invoices[]` (TG-8) ; on **alimente** ce chemin et on **résout** au passage le **misrouting export-B2C** signalé en 2.3 (F2/T3 : un particulier étranger tombait en `'10.1'` par la règle pays).

**Architecture :** On **réutilise le socle 1.x/2.x** exactement comme en 2.3/2.4/3.1. Le **discriminant** est **additif et OPTIONNEL** dans `packages/invoice-core` (`invoiceLineInputSchema`) → **rétro-compatibilité SANS migration** du JSONB canonique en base (`invoices.canonical jsonb`, lu **sans re-parse** — un champ optionnel absent est sûr par construction). Tout le reste vit dans **`apps/api/src/ereporting/*`** (agrégation, classifieur, cadence, worker — précédent 2.3) et une **nouvelle surface de capture** `apps/api/src/payments/*` (persistance + endpoint), **sans nouveau package** (arbitrage 2.3-Q2/2.4-R1). La **génération XML** réutilise `flux10-xml.ts` (`appendPaymentsReport`/`appendInvoice` **déjà présents**) — **aucune dépendance ajoutée**. La **cadence** ajoute une **2ᵉ table data-driven** dans `period.ts`. Les **transmissions** réutilisent la table `ereporting_transmissions` (enum `flux_kind` **contient déjà `'payments'`** ; l'index unique partiel **clé déjà sur `flux_kind`** → un slot `payments` ne collisionne pas avec `transactions`). Le worker réutilise `find_ereporting_declarants_due` (**régime-agnostique**, sert les paiements inchangée) + BullMQ + la machine 300/301 + le port de transmission différé.

**Tech Stack :** **Aucune dépendance runtime ajoutée.** Modèle/ventilation : `zod` + `big.js` (déjà présents `invoice-core`). Génération XML : `xmlbuilder2` (déjà présent). Validation XSD : `ereporting-xsd-validator` (xmllint, déjà présent — `payment.xsd` déjà couvert par les imports du schéma). Files/scheduler : **BullMQ 5.80.x** (déjà présent). Dates/hash/IO : `node:*`. `docker-compose` inchangé.

## Global Constraints

Reprises **verbatim** du socle 1.x/2.x (non négociables) — chaque tâche en hérite implicitement :

- **TDD strict RED/GREEN** : test écrit et vu échouer avant toute implémentation ; aucun merge si un test échoue (spec §7). Un commit minimum par tâche, message en **français**, **sans** trailer `Co-Authored-By: Claude` ni mention Claude ; commits au seul nom de l'utilisateur. `pnpm format` avant chaque commit.
- **Couverture bloquante** : **≥ 90 %** (lines/functions/statements/branches) maintenue sur `apps/api` et `apps/web`. **`packages/invoice-core` EST TOUCHÉ CETTE FOIS** — le seuil configuré du paquet est 90×4 **mais le paquet se tient à 100 % sur tous ses fichiers** (ledger 1.x/2.x) : **toute nouvelle ligne d'`invoice-core` est visée à 100 %×4** (constante du projet, pas 90 — écrire les tests des branches présente/absente ou garder le champ en pass-through sans branche, comme `compute.ts` le fait délibérément). Exclusions de couverture `apps/api` conservées (`src/main.ts`, `src/worker-main.ts`, `**/*.module.ts`, `src/db/migrations/**`). **Tout module pur** (ventilation par nature, classifieur, cadence paiements, agrégation, helpers de fenêtre/deadline) visé **100 %** par des tests déterministes (vecteurs fixés, **aucun `Date.now()` dans la logique pure** ; `now` injecté).
- **e2e sur Postgres réel (Testcontainers)** pour toute table/endpoint ; **Redis réel** pour tout flux worker/scheduler ; **tests d'isolation multi-tenant explicites** (paiements/encaissements d'un tenant jamais visibles d'un autre). **Motifs de stabilité e2e OBLIGATOIRES** (1.4/2.1/2.2/2.3/2.4) : `listenOnce`, `maxWorkers: 5`, `withStartupTimeout(120_000)`, `hookTimeout: 150_000`, écouteur `error` sur tout pool `pg` brut (bruit `57P01` au teardown).
- **Sécurité OWASP** : validation de toute entrée (zod), authz systématique (dual-auth sur les endpoints ; CSRF sur les mutations de session). **Aucune donnée sensible hors des frontières tenant** : encaissements sous RLS `FORCE`. Erreurs normalisées **RFC 9457 `application/problem+json`**. **Aucun secret dans Redis** : les jobs ne portent que des identifiants internes (le worker recharge sous RLS).
- **Moindre privilège Postgres inchangé** : rôle `factelec_app` ≠ propriétaire, **sans `BYPASSRLS`, sans superuser** ; RLS **`ENABLE` + `FORCE`** sur toute table tenant ajoutée ; propagation du tenant par `SET LOCAL` via `runInTenant`. **Aucune nouvelle fonction SD** (réutilisation de `find_ereporting_declarants_due`) → pas de surface SD supplémentaire à durcir.
- **TypeScript `strict: true`, ESM, NodeNext, Node ≥ 22.** `typescript` pinné **exactement `7.0.2`** (racine, tsgo). Repli local `typescript@5.9.x` du seul workspace concerné autorisé et documenté si un typecheck bute — sans toucher le pin racine.
- **Dépendances pinnées exactement, dernière stable, licence.** **`pnpm run audit:ci` 0 vulnérabilité** et **`pnpm outdated -r` vierge** restent **bloquants** en CI. **Aucune dépendance ajoutée** → objectif mécaniquement tenu (vérifier néanmoins à **chaque** tâche — un patch amont peut sortir en cours de plan, drift bullmq 2.2-T5 / 2.3-T3 / 2.4-T8).
- **`@factelec/invoice-core` consommé via son exports map** (barrel `.` unique), jamais par chemin relatif. `docs/reference/` et `docs/reglementaire/` en **lecture seule** (aucun XSD copié/modifié).
- Identifiants de code en **anglais** ; commentaires/commits/docs en **français**.

---

## Périmètre : retenu en 3.2 vs reporté

**Retenu (ce plan) :**
1. **Discriminant biens/services de ligne** (`invoice-core`) : champ **OPTIONNEL** `nature ∈ {goods, services}` sur `invoiceLineInputSchema` + fonction pure `computeVatBreakdownByNature` (**total conservé**), rétro-compat JSONB sans migration, bump invoice-core (Task 1).
2. **Ventilation réelle des cadres M1/M2/M4** (agrégation **B2C / 10.3** — c'est **là** que vivent TLB1/TPS1 : `TT-81 CategoryCode`, xlsx R127) : M\* **avec** nature complète → split TLB1(biens)+TPS1(services) **conservé, jamais doublé** ; M\* **sans** nature complète → **skip typé + log** (différé par facture, aucune fabrication) ; B\*/S\* inchangés. **Le per-facture 10.1 (B2Bi) n'a AUCUN axe de catégorie** (ventilation TVA standard UNTDID 5305) → le discriminant n'affecte **que** l'agrégation B2C (Task 2).
3. **Classifieur raffiné + activation 10.1 B2Bi (TG-8 par facture)** : misrouting export-B2C **résolu** (non-assujetti → jamais `'10.1'`) ; émission per-facture via `invoices[]` déjà câblé dans le générateur ; mapping BT→TT vérifié vs Annexe 6 (Task 3).
4. **Capture des encaissements** : tables `payments` + `payment_subtotals` (montant **par taux**, liées à la facture) sous RLS `FORCE`, migrations **0024 (drizzle) + 0025 (hand)**, repo idempotent (Task 4).
5. **Endpoint dual-auth de capture** (+ lecture) : `POST /payments`, validation zod, intégrité vs facture liée (taux ∈ ventilation, non-sur-encaissement), 404 anti-fuite (Task 5).
6. **2ᵉ table de cadence PAIEMENTS** (`period.ts`, colonne PAIEMENT du Tableau 13 verbatim) : décades 20/10/10, trimestriel→**trimestriel**, simplifié→mois+2, franchise→**dernier jour du mois suivant** — pure, 100 %, **oracle indépendant** (Task 6).
7. **Agrégation TB-3** (`aggregatePayments`) : **10.2** (B2Bi) = **per-facture** (`PaymentsReport/Invoice`, `Flux10PaymentInvoice` **déjà modelé** 2.3-T2) ; **10.4** (B2C) = **agrégé par date×taux** (`PaymentsReport/Transactions`, TG-37/38/39 — **modèle+émetteur à AJOUTER**, sans axe catégorie ni réf facture) ; montants **19.6** (TT-95/99), `CurrencyCode` optionnel gardé ; **XOR** au niveau Report, XSD-valide `payment.xsd`, à blanc optionnel (Task 7).
8. **Ordonnanceur & worker paiements** : slot `flux_kind='payments'` (déjà supporté), sweep cadence paiement, **3 couches anti-double-envoi**, jobId `-` (jamais `:`), pipeline période→agrégat→XML→validation→persistance→transmission (Task 8).
9. **CI / docs / OpenAPI / bump `0.8.0`** (Task 9).

**Reporté (acté ici, justifié en D\*) :**
- **Auto-seed d'un paiement depuis le statut 212 « Encaissée »** — **REFUSÉ** (D5) : l'événement 212 du journal scellé ne porte **ni montant, ni taux, ni date de paiement** → seeder fabriquerait la ventilation (anti-pattern « aucune fabrication »). La capture reste **explicite**. La sweep CDV consomme déjà 212 pour le Flux 6 (3.1) — orthogonal.
- **Adaptateurs de transport réels** (SFTP/AS2/AS4/API) et **push PPF** des acquittements 300/301 : **inchangés** (port + frontière livrés en 2.3, source différée — items déploiement Xavier).
- **Schematron / contrôles sémantiques PPF** (Annexe 7) : validation XSD **structurelle** seule, comme 2.3 ; câblage go-live.
- **Chemin RE (rectificatif)** des paiements : le socle émet des **IN** ; le deadlock de slot `IN` né-`rejetee` **hérite du runbook 2.3** (procédure manuelle documentée) — chemin RE = chantier futur commun transactions/paiements.
- **Provisioning des déclarants** : inchangé (dette 2.3 notée).

---

## Décisions structurantes (à lire avant d'exécuter)

### D1 — Discriminant `nature` OPTIONNEL au niveau ligne ; rétro-compat JSONB sans migration ; invoice-core à 100 %
- Ajouter `nature: z.enum(['goods','services']).optional()` à **`invoiceLineInputSchema`** (`packages/invoice-core/src/model/schema.ts` ~l.108) — **miroir du template `businessProcessType`** (enum fermé + `.optional()` + décision aval). Le champ **se propage automatiquement** via `.extend()` vers `invoiceLineSchema`, les types inférés `InvoiceLine`/`Invoice`, et via le spread de `computeLines` à travers `buildInvoice` — **zéro changement** à `compute.ts` pour le pass-through.
- **Rétro-compat = exigence SANS migration** : `invoices.canonical` est du **JSONB** typé `$type<Invoice>()` (schemaless côté DB) ; `loadCanonical` **ne re-parse pas** à la lecture → une facture historique **sans** `nature` reste lisible telle quelle. Optionnel + pas de re-parse = **rétro-compatible par construction**. **Aucune migration DB** pour le discriminant.
- **Coverage** : `invoice-core` visé **100 %×4** (constante du projet ; le plancher configuré 90 est un filet, pas la cible). Le champ pur pass-through n'ajoute **aucune branche** (leçon `compute.ts`) ; la fonction `computeVatBreakdownByNature` (D2) est testée sur ses branches complète/incomplète.
- **Nommage** : `nature` (anglais), valeurs `'goods'` (→ **TLB1**, livraisons de biens) / `'services'` (→ **TPS1**, prestations de services). Le mapping nature→catégorie Flux 10 vit dans **`apps/api`** (nomenclature), pas dans invoice-core (séparation des responsabilités : invoice-core ignore le Flux 10).

### D2 — Ventilation par nature = **total conservé, exact** ; le résidu d'arrondi ne touche QUE la TVA
- `computeVatBreakdownByNature(invoice): { complete: boolean; goods: VatBreakdown[]; services: VatBreakdown[] }` (module pur invoice-core).
  - `complete = invoice.lines.every(l => l.nature !== undefined)`. Si `!complete` → `{ complete:false, goods:[], services:[] }` (le consommateur **diffère**, D3).
  - **La base (`taxableAmount`) se sépare EXACTEMENT** : `taxableAmount` d'un bucket `(catégorie,taux)` = **somme de `lineNetAmount`** (déjà 2 décimales), donc `goodsTaxable + servicesTaxable = canonicalTaxable` **sans arrondi** (addition de montants 2-dp = exacte).
  - **Seul le résidu de TVA existe** : `taxAmount = round(taxable × taux)` ; `goodsTax = round(goodsTaxable × taux)`, mais `servicesTax = canonicalTax − goodsTax` (**le bucket services absorbe le résidu ≤ 1 centime**) → `goodsTax + servicesTax = canonicalTax` **exactement**. Règle « total conservé » (réviseur 2.3) **prouvée**, jamais doublée.
  - Buckets vides omis (M\* tout-biens → seulement `goods` ; tout-services → seulement `services`).
- **Vecteur clé** (test) : M1 base 1000 / TVA 200, lignes biens 600 + services 400 → `goods {600, 120}` + `services {400, 80}` ; `600+400=1000`, `120+80=200` — **jamais 2000/400**. Un cas **inducteur de résidu** (montants impairs à un taux non trivial) prouve l'absorption du centime côté services.

### D3 — Cadres M\* : split réel si nature complète, sinon différé par facture (aucune fabrication)
- Dans `flux10-aggregate.ts` : le `continue` de skip actuel (l.99-100, `categories.length > 1 → undefined`) est **remplacé** par : si le cadre est **mixte** (`mapCadreToCategories(cadre).length > 1`), appeler `computeVatBreakdownByNature(invoice)` ; **si `complete`** → alimenter les buckets **TLB1 depuis `goods`** et **TPS1 depuis `services`** (conservation D2) ; **si `!complete`** → **skip typé + log** (`this.logger.warn`/compteur `deferredMixed`) et `continue` — la facture reste différée (même posture que 2.3, mais **par facture**, plus « toutes les M\* »). **B\*/S\* inchangés** : la nature de ligne est **ignorée** (le cadre décide — B→TLB1, S→TPS1, comportement 2.3 intact).
- **Aucune fabrication** : une M\* partiellement naturée (certaines lignes sans `nature`) est **différée**, jamais splittée sur hypothèse. Test : M1 lignes toutes naturées → 2 agrégats montants exacts ; M1 lignes partielles → skip+log (période à blanc si seule opération) ; M1 tout-biens → 1 agrégat TLB1.

### D4 — 10.1 B2Bi par facture (TG-8) via `invoices[]` déjà câblé ; misrouting export-B2C RÉSOLU
- **Classifieur raffiné** (`classifyEreportingOperation`, flux10-aggregate.ts l.44-55) — corriger l'ordre de décision pour que **la non-assujettissement prime la règle pays** :
  ```
  buyerIsTaxable = Boolean(buyer.siren) || Boolean(buyer.vatId)
  if (!buyerIsTaxable) return '10.3'         // B2C domestique OU export → 10.3 (résout export-B2C)
  crossBorder = buyer.country !== 'FR' || seller.country !== 'FR'
  return crossBorder ? '10.1' : 'out'        // assujetti étranger → 10.1 ; assujetti FR → e-invoicing
  ```
  Résout le **F2/T3-2.3** : un particulier étranger (ni SIREN ni n° TVA) ne tombe **plus** en `'10.1'`. **INTERPRÉTATION** flaggée : l'assujettissement est heuristiqué par présence SIREN/n° TVA (le modèle n'a pas de booléen « assujetti » ; à confirmer Annexe 7) ; le **bucket exact** d'un export-B2C (10.3 vs sous-code dédié) reste à confirmer — la **correction dure** (non-assujetti ⇏ 10.1) est sûre.
- **Émission per-facture** : `aggregateTransactions` alimente désormais `TransactionsReport.invoices[]` (type `Flux10Invoice`, TG-8) pour les opérations **`'10.1'`** (le générateur `appendInvoice` est **déjà écrit** — l.76-102 : TT-19/20/21/22/28/29/33/33-1/35/52/54/55/56/57). Un `TransactionsReport` peut porter **à la fois** les `invoices[]` (10.1 per-facture) **et** les agrégats (10.3) — TB-2 = « Flux 10.1 / 10.3 » (research §2.3). Mapping **BT→TT vérifié vs Annexe 6** (Task 3).
- **Réutilisation totale du pipeline transactions** (sweep/slot/worker `flux_kind='transactions'`) : 10.1 n'ajoute **aucune** infra — il alimente le chemin `invoices[]` que l'agrégateur laissait vide.

### D5 — Capture des encaissements EXPLICITE ; PAS d'auto-seed depuis 212 ; intégrité vs facture liée
> **AMENDEMENT revue du plan (binding)** : RÉCONCILIER la clé d'idempotence de la capture —
> une seule définition, `(invoice_id, reference)` (référence de paiement fournie par
> l'opérateur, unique par facture), portée par l'index unique ET par l'ON CONFLICT du
> repository (pas deux clés divergentes entre D5 et la Task 4).
- **Refus d'auto-seed 212** : l'événement `encaissee` (212) du **journal scellé 2.2** ne porte **aucun** montant/taux/date de paiement (statut binaire). Seeder un `PaymentsReport` (qui exige date + montant **par taux**) depuis 212 **fabriquerait** la ventilation → **anti-pattern**. Décision : **capture explicite** — la PA/le marchand **POST** les encaissements (date + sous-totaux par taux, `reference` client). Le lien 212↔paiement est **documenté** (atteindre 212 correspond typiquement à des paiements sommant au total), non automatisé.
- **Modèle** : `payments` (1 encaissement) `1—n` `payment_subtotals` (montant par taux). **Paiements partiels multiples** par facture supportés (TVA à l'encaissement). Montants stockés en **`text`** (précédent DGFiP : tous les montants Flux 10 sont `text`, pas de colonne numérique). Dates en `text` AAAAMMJJ.
- **Idempotence de capture** : clé unique `(invoice_id, reference)` (tenant-scopée par RLS ; UNE seule définition — amendement binding ci-dessus) + `insertPayment` **`ON CONFLICT DO NOTHING` + reload** (miroir `insertTransmission`) → un re-POST du même `reference` ne double pas.
- **Intégrité (endpoint, D6)** : la facture liée existe et appartient au tenant (**404 anti-fuite** sinon) ; les `taxPercent` postés ⊆ taux de la ventilation de la facture (`422` sinon) ; cumul encaissé par taux **≤** total TTC de la facture par taux (**sur-encaissement `422`** — **INTERPRÉTATION** : tolérance/arrondi à confirmer, flaggée).

### D6 — 2ᵉ table de cadence PAIEMENTS (Tableau 13 PRIMAIRE p.68) — RÉÉCRITE post-revue (B1)
> ⚠️ **B1 (revue du plan) — la version initiale de ce Dx transcrivait le Tableau 13 depuis
> `research-2-3-questions.md`, dont les colonnes étaient DÉSALIGNÉES (pdftotext). La vérité
> ci-dessous vient de l'extraction cellule-par-cellule du PDF p.68 par le contrôleur
> (colonne opérationnelle « transmission à l'administration fiscale par la PA, à 8h00 » ;
> motif constant : échéance PA = échéance de dépôt du déclarant + 1 jour). Le même
> désalignement cachait un bug TRANSACTIONS trimestriel shippé en 2.3, corrigé par le
> hotfix `91531d3` (échéance le 11 de M+1, pas le 1ᵉʳ) — la bannière du dossier de
> recherche est corrigée.**

- La cadence **transactions** (`CADENCE_BY_REGIME`, post-hotfix `deadlineDay`) reste **INTACTE**. On ajoute **`PAYMENTS_CADENCE_BY_REGIME`** + `computeDuePaymentPeriods(regime, referenceDate)` (pure, bornée `MAX_DUE_PERIODS`, aucun `Date.now()`). Vérité PRIMAIRE :

  | Régime | Période paiement | Échéance PAIEMENT (primaire p.68) | vs Échéance TRANSACTION |
  |---|---|---|---|
  | **réel normal mensuel** | **Mensuelle** (mois civil — PAS de décades) | **le 11 du mois suivant** — 8h00 | décades 21 / 1ᵉʳ M+1 / 11 M+1 (**SEUL régime qui diffère**) |
  | **réel normal trimestriel** | Mensuelle | **le 11 du mois suivant** — 8h00 | identique (post-hotfix 91531d3) |
  | **simplifié** | Mensuelle | **le 1ᵉʳ du 2ᵉ mois suivant** — 8h00 | identique |
  | **franchise en base** | Bimestrielle (bimestres civils) | **le 1ᵉʳ du 2ᵉ mois suivant** — 8h00 | identique |

- **Conséquence data-model (SIMPLIFIÉE)** : AUCUNE nouvelle forme de cadence (ni `quarter`, ni décades 20/10/10, ni « dernier jour ») — `PAYMENTS_CADENCE_BY_REGIME` réutilise les formes EXISTANTES post-hotfix : `{month, offset:1, day:11}` (mensuel ET trimestriel), `{month, offset:2, day:1}` (simplifié), `{bimester}` (franchise). `computeDuePaymentPeriods` = le même moteur (`monthCandidates`/`bimesterCandidates`), une table différente.
- **Interprétations flaggées go-live** (bannière, comme 2.3-T7) : **08:00 UTC vs Paris** (côté sûr). **Oracle indépendant** obligatoire (littéral `EXPECTED_PAYMENT_*` retranscrit **à la main** du Tableau 13 PRIMAIRE — leçon anti-tautologie 3.1-T1 ; NE PAS le retranscrire du dossier de recherche).
- **Source du fond** : la cadence vit dans le **Dossier §3.7.7 Tableau 13 p.68 (PDF PRIMAIRE — pas la transcription)** ; les RG Annexe 7 (`G6.24`/`G6.25`/`G1.36` référencées par TT-89/90) restent un point de confirmation go-live (Annexe 7 non lue).

### D7 — Deux formes de PaymentsReport (10.2 per-facture / 10.4 agrégé) ; transmission = réutilisation totale du slot 2.3
- **Formes TB-3 (xlsx R135-R154)** : `PaymentsReport/Invoice` (**TG-34**, per-facture : InvoiceID TT-91 + IssueDate TT-102 + Payment/Date TT-92 + SubTotals TG-36) = **sous-flux 10.2** (B2Bi) — **déjà modelé** (`Flux10PaymentInvoice`, `appendPaymentsReport`, 2.3-T2) ; `PaymentsReport/Transactions` (**TG-37/38/39**, agrégé : Payment/Date TT-96 + SubTotals par taux **sans réf facture ni catégorie**) = **sous-flux 10.4** (B2C) — **à AJOUTER** (modèle `Flux10PaymentAggregate` + émetteur). Montants **TT-95/TT-99 = MONTANT 19.6** (6 décimales, refonte v1.10) ; `CurrencyCode` **TT-94/TT-98 = 0..1** (garde élément vide, classe 2.4-I1). **Aucun axe TLB1/TPS1 dans les paiements** → l'agrégation B2C paiements est par **(date, taux)** seule.
- Aucune nouvelle table de transmission : **`ereporting_transmissions`** avec `flux_kind='payments'` (l'enum `ereporting_flux_kind` **contient déjà `payments`**, schema.ts l.252-255). L'**index unique partiel** `(declarant_id, flux_kind, period_start) WHERE type='IN'` **clé déjà sur `flux_kind`** → un slot `payments` **ne collisionne pas** avec un slot `transactions` du même déclarant/période. `insertTransmission` idempotent inchangé.
- **Aucune nouvelle SD** : `find_ereporting_declarants_due` renvoie **tous les déclarants actifs** (dueness calculée côté scheduler par la cadence — **régime-agnostique**), donc **sert les paiements telle quelle**. La sweep ajoute un **chemin d'enfilement `payments`** (jobId **`${declarantId}-payments-${periodStart}`**, séparateur **`-`** — leçon 2.4-T9 ; **note** : le jobId transactions existant utilise `:`, risque latent BullMQ post-5.80.5 **pré-existant hors périmètre**). La `EreportingGenerationService` (qui **lève** aujourd'hui sur `fluxKind !== 'transactions'`, l.95-99) reçoit une **branche `payments`**.
- **3 couches anti-double-envoi** (D8-2.3) : (1) fenêtre bornée `computeDuePaymentPeriods` (`MAX_DUE_PERIODS`) ; (2) jobId déterministe `-` ; (3) index unique partiel + `insertTransmission` idempotent. **Deadlock slot × terminal** : un `IN` né-`rejetee` (XSD-invalide) occupe le slot `(declarant, payments, période)` — **hérite du runbook 2.3** (procédure manuelle ; ne PAS retirer `rejetee` de l'index ; chemin RE = futur). **Aucune régression** : même sémantique que les transactions.

### D8 — Réutilisation : Invoice (nature ligne, buyer, ventilation), journal scellé 2.2 (212, lecture seule), F10 XML/XSD, cadence, BullMQ, drizzle/RLS, dual-auth
- **Données** : la nature part de la **ligne** de l'`Invoice` canonique ; la classification/agrégation réutilise `classifyEreportingOperation`, `mapCadreToCategories`, `computeVatBreakdownByNature`. La **génération** réutilise `flux10-xml.ts` (`appendPaymentsReport`, `appendInvoice`, XOR). La **validation** réutilise `ereporting-xsd-validator` (payment.xsd). L'**infra** réutilise la file `ereporting-generation`, `MaintenanceProcessor`/`EreportingScheduler`, la machine 300/301, le port de transmission (local write-once ; réels différés), `find_ereporting_declarants_due`. **Discipline DB** : migrations drizzle (tables) + **manuelles** (RLS/grants), `nullif(current_setting('app.tenant_id',true),'')::uuid`, FK `invoice_id` **restrict** (journal/lien). **Contrôleur** : dual-auth (`TenantAuthGuard` lecture ; `SessionGuard/RolesGuard/CsrfGuard` **ou** `ApiKeyGuard` mutation — machine PA), 404 anti-fuite.

---

## Versions & dépendances (registre npm — à re-vérifier à chaque tâche)

| Brique | Fournisseur | Provenance / note |
|---|---|---|
| Discriminant + ventilation par nature | **`zod` + `big.js`** (déjà dans `invoice-core`) | **Aucun ajout**. Bump `invoice-core` **0.3.1 → 0.4.0** (feature additive). |
| Génération XML TB-3 | **`xmlbuilder2`** (déjà `apps/api`, `appendPaymentsReport` déjà écrit 2.3-T2) | **Aucun ajout**. |
| Validation `payment.xsd` | **`ereporting-xsd-validator`** (xmllint, déjà présent) | Aucun ajout ; libxml2 = prérequis hôte worker (dette 2.3). |
| Files / scheduler | **BullMQ 5.80.x** (déjà présent) | File `ereporting-generation` + branche sweep `payments`. |
| Persistance encaissements | drizzle + `pg` (déjà présents) | Migrations 0024 (drizzle) + 0025 (hand). |

> **Gate** : `pnpm run audit:ci` = 0 et `pnpm outdated -r` **vierge**. Vérifier à **chaque** tâche (patch amont possible en cours de plan).

---

## Points de risque signalés d'emblée

1. **Ventilation qui double** (le bug 2.3). **Traité** : D2, base séparée **exactement** (somme de 2-dp), TVA-résidu absorbé côté services → conservation prouvée, vecteur M1 1000/200→600/400.
2. **M\* partiellement naturée → fabrication.** **Traité** : D3, skip typé + log par facture, jamais splittée sur hypothèse.
3. **Misrouting export-B2C** (F2/T3-2.3). **Traité** : D4, non-assujetti prime la règle pays ; correction dure sûre, bucket export flaggé interprétation.
4. **Cadence paiements confondue avec transactions.** **Traité** : D6, **2ᵉ table** verbatim Tableau 13, oracle indépendant, décades 20/10/10, trimestriel trimestriel, franchise dernier-jour-mois-suivant.
5. **Auto-seed 212 fabrique la TVA.** **Traité** : D5, capture explicite, seed refusé.
6. **Rétro-compat JSONB canonique.** **Traité** : D1, champ optionnel + lecture sans re-parse → sûr par construction, **aucune migration**.
7. **jobId BullMQ `:`.** **Traité** : D7, paiements en `-` ; `:` transactions = risque latent pré-existant noté.
8. **Deadlock slot × terminal (paiements).** **Traité** : D7, même sémantique que 2.3, runbook hérité ; ne pas retirer `rejetee` de l'index.
9. **Migration sur enum/flux_kind.** **Traité** : D7, `payments` **déjà** dans l'enum → aucune migration d'enum ; slots par flux_kind déjà distincts.
10. **XSD paiements + forme agrégée nouvelle.** **Traité** : la forme per-facture (10.2) est déjà `payment.xsd`-valide (2.3-T2) ; la forme **agrégée 10.4 (TG-37) est AJOUTÉE** et **re-validée** `payment.xsd` (montants 19.6, garde `CurrencyCode` 0..1 vide — classe 2.4-I1) ; validation structurelle honnête (pas de schematron — comme 2.3).

---

## Sources réglementaires vérifiées (lecture seule)

- **Annexe 6 v1.10 re-parsée (openpyxl, lecture seule) — TB-3 `PaymentsReport` (xlsx R135-R154), VERBATIM** :
  - `ReportPeriod` **TG-33** : `StartDate` **TT-89** (1..1, AAAAMMJJ), `EndDate` **TT-90** (1..1).
  - `Invoice` **TG-34** (0..n, **sous-flux 10.2**, B2Bi+B2C) : `InvoiceID` **TT-91** (1..1, 35), `IssueDate` **TT-102** (1..1, AAAAMMJJ), `Payment` **TG-35** → `Date` **TT-92** (1..1), `SubTotals` **TG-36** (1..n) → `TaxPercent` **TT-93** (1..1, 3.2), `CurrencyCode` **TT-94** (**0..1**, ISO4217), `Amount` **TT-95** (1..1, **MONTANT 19.6**).
  - `Transactions` **TG-37** (0..n, **sous-flux 10.4**, **B2C only**) : `Payment` **TG-38** → `Date` **TT-96** (1..1), `SubTotals` **TG-39** (1..n) → `TaxPercent` **TT-97**, `CurrencyCode` **TT-98** (**0..1**), `Amount` **TT-99** (1..1, **MONTANT 19.6**). **Aucun `CategoryCode` ni réf facture** dans la forme agrégée.
  - `Flux10PaymentInvoice`/`Flux10PaymentSubTotal` (per-facture, TG-34) **déjà** typés/émis (2.3-T2, XSD-valides) ; la forme agrégée TG-37 est **à ajouter** (D7).
- **Annexe 6 « Correspondance » (xlsx R5-R18), VERBATIM** — B1/B2/B4/B7→**TLB1**, S1/S2/S3/S4/S5/S6/S7→**TPS1**, **M1/M2/M4→TLB1 + TPS1** avec la note : « *Les opérateurs doivent distinguer les LB et les PS en e-reporting B2C (cf. lignes de facture)* » (justification directe du discriminant) ; **s'applique au passage flux 9 → flux 10.3 (B2C)**. TLB1/TPS1 en **`TT-81 CategoryCode`** (agrégé B2C uniquement) ; per-facture 10.1/TG-8 = ventilation **TG-23** UNTDID 5305 (`TT-56`), **sans** TLB1/TPS1.
- **research-2-3-ereporting.md §2.3 / §3.3 (TB-2/TG-8 + Correspondance)** — Invoice TT-19/20/21/22/28/29/33/33-1/35 ; **Correspondance** B1→TLB1, S1→TPS1, **M1/M2/M4 → TLB1 + TPS1** (« Opérateurs distinguent LB et PS **en lignes** ») — c'est **la** justification du discriminant.
- **research-2-3-questions.md §Tableau 13 (colonne PAIEMENT), VERBATIM** — décades **le 20 / le 10 suivant / le 10 suivant** ; trimestriel **le 1ᵉʳ du mois suivant** ; simplifié **le 1ᵉʳ du 2ᵉ mois suivant** ; franchise **le dernier jour du mois suivant** — **8h00** ; remise PPF ≤ 8h après l'échéance. **Cadence ≠ transactions** (le brief l'exige, re-vérifié).
- **Cycle de vie 300/301** (research-2-3-questions.md §3.4) — inchangé, réutilisé pour les paiements.
- **Vérifié in situ (2.3)** : `flux10-xml.ts` `appendPaymentsReport`/`appendInvoice` **présents** ; enum `ereporting_flux_kind` **contient `payments`** ; index unique partiel **clé sur `flux_kind`** ; `find_ereporting_declarants_due` **régime-agnostique** ; classifieur/skip M\* aux lignes citées. **Migration la plus haute = 0023** → next **0024/0025**.

---

## Structure des fichiers (vue d'ensemble)

```
packages/invoice-core/
  package.json                              # version 0.3.1 → 0.4.0
  src/model/schema.ts                       # + nature?: 'goods'|'services' sur invoiceLineInputSchema (Task 1)
  src/model/compute.ts                      # + computeVatBreakdownByNature (pur, conservation) (Task 1)
  src/index.ts                              # export computeVatBreakdownByNature (barrel) (Task 1)
  tests/unit/compute.test.ts                # ventilation par nature, conservation, complète/incomplète (Task 1)

apps/api/
  package.json                              # version 0.7.0 → 0.8.0 (Task 9)
  src/config/env.ts                         # + PAYMENTS_* (sweep/lookback), (Task 8)
  src/ereporting/
    flux10-aggregate.ts                     # M* split réel (B2C/10.3) + classifieur raffiné + 10.1 invoices[] (Tasks 2/3)
    flux10-model.ts                         # + Flux10PaymentAggregate ; PaymentsReport.transactions[] (Task 7)
    flux10-xml.ts                           # + émission /PaymentsReport/Transactions (TG-37) (Task 7)
    period.ts                               # + PAYMENTS_CADENCE_BY_REGIME + computeDuePaymentPeriods (Task 6)
    flux10-payments-aggregate.ts            # PUR : aggregatePayments → PaymentsReport (10.2/10.4) (Task 7)
    ereporting-generation.service.ts        # + branche fluxKind='payments' (Task 8)
  src/payments/
    payment.model.ts                        # PUR : types + zod capture (Task 4/5)
    payments.repository.ts                  # RLS ; insertPayment idempotent ; sums-per-rate (Task 4)
    payments.service.ts                     # intégrité vs facture liée (Task 5)
    payments.controller.ts                  # dual-auth POST/GET (Task 5)
    payments.module.ts                      # câblage (Task 5)
  src/worker/
    ereporting-sweep.service.ts             # + enfilement 'payments' (cadence paiement) (Task 8)
  src/db/
    schema.ts                               # + tables payments / payment_subtotals (Task 4)
    migrations/0024_payments.sql            # (drizzle) 2 tables + index unique + FK restrict (Task 4)
    migrations/0025_payments_rls.sql        # (hand) RLS FORCE + grants (Task 4)
    migrations/meta/_journal.json           # + 0024/0025
  tests/
    unit/
      flux10-aggregate.test.ts              # M* split, classifieur, 10.1 TG-8 (Tasks 2/3)
      period.test.ts                        # cadence paiements (oracle indépendant) (Task 6)
      flux10-payments-aggregate.test.ts     # agrégation TB-3, XSD-valide, XOR (Task 7)
    e2e/
      payments-persistence.e2e.test.ts      # RLS/isolation/idempotence/FK restrict (Task 4)
      payments.e2e.test.ts                  # capture dual-auth, intégrité, 404 (Task 5)
      ereporting-payments.e2e.test.ts       # pipeline paiements bout-en-bout (Task 8)
```

Fichiers hors code : `README.md` racine + `apps/api/README.md` (Task 9).

---

### Task 1 : Discriminant biens/services de ligne + ventilation par nature (invoice-core, additif, 100 %×4)

**Files:**
- Modify: `packages/invoice-core/src/model/schema.ts`, `packages/invoice-core/src/model/compute.ts`, `packages/invoice-core/src/index.ts`, `packages/invoice-core/package.json`
- Modify: `packages/invoice-core/tests/unit/compute.test.ts` (+ éventuel `schema.test.ts`)

**Interfaces:**
- Consumes : rien (modèle pur).
- Produces (Tasks 2/3/7) : champ optionnel `nature` sur `InvoiceLineInput`/`InvoiceLine` ; `computeVatBreakdownByNature(invoice: Invoice): { complete: boolean; goods: VatBreakdown[]; services: VatBreakdown[] }`.

> **CONTRAT DE COMPAT (D1)** : champ **OPTIONNEL** → toute facture canonique historique (JSONB, sans `nature`) reste valide et lisible sans re-parse. **Aucune migration DB.** Signatures publiques existantes inchangées.

- [ ] **Step 1 : Tests (RED)** — dans `compute.test.ts` :
```ts
import { buildInvoice, computeVatBreakdownByNature } from '../../src/index.js'
// (helper d'input minimal réutilisé des tests existants)

it('accepte une ligne SANS nature (rétro-compat) et une AVEC', () => {
  expect(() => buildInvoice(inputWith({ /* pas de nature */ }))).not.toThrow()
  expect(() => buildInvoice(inputWith({ nature: 'goods' }))).not.toThrow()
})
it('ventile M1 1000/200 en biens 600/120 + services 400/80 (TOTAL CONSERVÉ, jamais doublé)', () => {
  const inv = buildInvoice(m1Input([{ net: '600.00', nature: 'goods' }, { net: '400.00', nature: 'services' }], '20'))
  const { complete, goods, services } = computeVatBreakdownByNature(inv)
  expect(complete).toBe(true)
  expect(goods[0]).toMatchObject({ taxableAmount: '600.00', taxAmount: '120.00' })
  expect(services[0]).toMatchObject({ taxableAmount: '400.00', taxAmount: '80.00' })
  // conservation exacte vs ventilation canonique
})
it('absorbe le résidu de TVA côté services (goods+services == canonique, au centime)', () => { /* cas inducteur */ })
it('renvoie complete:false si UNE ligne manque de nature (le consommateur diffère)', () => {
  const inv = buildInvoice(m1Input([{ net: '600.00', nature: 'goods' }, { net: '400.00' /* absente */ }], '20'))
  expect(computeVatBreakdownByNature(inv).complete).toBe(false)
})
it('omet le bucket vide (M* tout-biens → services vide)', () => { /* ... */ })
```
Run: `pnpm --filter @factelec/invoice-core test -- compute` → **RED** (fonction absente).

- [ ] **Step 2 : Implémentation (GREEN)** —
  - `schema.ts` : `nature: z.enum(['goods','services']).optional()` sur `invoiceLineInputSchema` (~l.108). Se propage via `.extend()`/inférence — **aucune** autre modif de schéma.
  - `compute.ts` : `computeVatBreakdownByNature(invoice)` : `complete = invoice.lines.every(l => l.nature !== undefined)` ; si `!complete` → `{ complete:false, goods:[], services:[] }`. Sinon : `goods = computeVatBreakdown(lines.filter(l => l.nature === 'goods'))` ; **`services` dérivé par soustraction** de la ventilation canonique `computeVatBreakdown(invoice.lines)` par bucket `(catégorie,taux)` (`servicesTaxable = canonicalTaxable − goodsTaxable` — exact ; `servicesTax = canonicalTax − goodsTax` — absorbe le résidu) ; buckets 0 omis. `big.js` pour les soustractions ; sortie via `vatBreakdownSchema` (2 décimales). **Pas de nouvelle branche non testée** (couvrir complète/incomplète/bucket-vide).
  - `index.ts` : `export { computeVatBreakdownByNature } from './model/compute.js'`.
  - `package.json` : `"version": "0.4.0"`.

- [ ] **Step 3 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/invoice-core test && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(invoice-core): discriminant biens/services de ligne (optionnel) et ventilation TVA par nature à total conservé"
```
Expected: invoice-core **100 %×4** sur le nouveau code ; suite `apps/api` intacte (compat prouvée : aucune facture existante ne casse).

---

### Task 2 : Ventilation réelle des cadres mixtes M1/M2/M4 (agrégation B2C / 10.3 — TLB1/TPS1)

**Files:**
- Modify: `apps/api/src/ereporting/flux10-aggregate.ts`
- Modify: `apps/api/tests/unit/flux10-aggregate.test.ts`

**Interfaces:**
- Consumes : Task 1 (`computeVatBreakdownByNature`), `mapCadreToCategories` (nomenclature), modèle `AggregatedTransaction`.
- Produces (Task 8) : agrégation transactions **débloquant** les M\* naturées.

> **Portée = B2C agrégé (10.3)** : TLB1/TPS1 ne vivent QUE dans le bloc agrégé `Transactions` (`TT-81 CategoryCode`, xlsx R127). Le per-facture 10.1 (TG-8, Task 3) porte la ventilation TVA standard UNTDID 5305 **sans** catégorie → le discriminant ne le concerne pas.

- [ ] **Step 1 : Tests (RED)** — dans `flux10-aggregate.test.ts` :
```ts
it('ventile un M1 naturé en 2 agrégats (TLB1 biens + TPS1 services), montants EXACTS, jamais doublés', () => {
  // M1 1000/200 lignes 600 goods + 400 services → TLB1 {600,120} + TPS1 {400,80}
})
it('DIFFÈRE un M1 partiellement naturé (skip typé + log ; période à blanc si seule opération)', () => {
  // computeVatBreakdownByNature.complete === false → continue, buckets.size 0 → null
})
it('émet un seul agrégat TLB1 pour un M1 tout-biens', () => { /* services vide */ })
it('laisse B1→TLB1 et S1→TPS1 INCHANGÉS (nature de ligne ignorée pour B*/S*)', () => { /* non-régression 2.3 */ })
```
Run → **RED** (l'agrégateur actuel `continue` sur tout cadre mixte).

- [ ] **Step 2 : Implémentation (GREEN)** — remplacer le bloc de skip mixte (l.82-100) : pour un cadre **mixte** (`categories.length > 1`), appeler `computeVatBreakdownByNature(invoice)` ; `!complete` → `logger.warn('cadre mixte différé (ligne sans nature)')` + `deferredMixed++` + `continue` ; `complete` → pour chaque bucket, alimenter **TLB1** depuis `goods` et **TPS1** depuis `services` (clé bucket `${date}|${currency}|${category}`, conservation D2). **B\*/S\*** : chemin inchangé (catégorie unique du cadre). Invariant ≥1 subtotal préservé (buckets créés dans la boucle vatBreakdown).

- [ ] **Step 3 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): ventilation réelle des cadres mixtes M1/M2/M4 en TLB1/TPS1 (total conservé, différé par facture si nature absente)"
```
Expected: PASS, module 100 %, dette M\* de 2.3 **soldée pour les factures naturées**.

---

### Task 3 : Classifieur raffiné (export-B2C résolu) + activation 10.1 B2Bi par facture (TG-8)

> **AMENDEMENTS revue du plan (plan-3-2-review.md §Task 3, binding)** : (a) ÉNUMÉRER le
> mapping BT→TT complet du TG-8 dans le brief (la revue porte le détail brief-ready) ;
> (b) FLAGUER FORT la conséquence du raffinement D4 : l'export-B2C (vendeur FR → particulier
> étranger), jusqu'ici classé '10.1' et JAMAIS émis, devient ACTIVEMENT émis et fusionné
> dans l'agrégat 10.3 — bannière d'interprétation dédiée + test nommé (un particulier DE
> acheteur → compté en 10.3), à confirmer go-live (frontière 10.3/10.4 vs sous-flux export).

**Files:**
- Modify: `apps/api/src/ereporting/flux10-aggregate.ts`
- Modify: `apps/api/tests/unit/flux10-aggregate.test.ts`

**Interfaces:**
- Consumes : `classifyEreportingOperation`, `Flux10Invoice` (flux10-model), `appendInvoice` (flux10-xml, déjà écrit).
- Produces (Task 8) : `TransactionsReport.invoices[]` alimenté pour les opérations `'10.1'`.

- [ ] **Step 1 : Tests (RED)** —
```ts
it('classe un EXPORT B2C (vendeur FR, particulier étranger sans SIREN/TVA) en 10.3, PAS 10.1', () => {
  expect(classifyEreportingOperation(exportB2C)).toBe('10.3')   // F2/T3-2.3 résolu
})
it('classe un assujetti étranger (n° TVA) en 10.1 et émet une Invoice TG-8 par facture', () => {
  const r = aggregateTransactions([b2biInvoice], opts)
  expect(r.invoices[0]).toMatchObject({ id: 'FAC-...', typeCode: '380', /* TT-19/20/21/22/28/29/33/35 */ })
})
it('classe un assujetti FR (SIREN) en out (e-invoicing, hors e-reporting)', () => { /* ... */ })
it('mappe BT→TT conformément à Annexe 6 (seller schemeId 0002, country FR, business process BT-23)', () => { /* ... */ })
```
Run → **RED** (classifieur actuel route l'étranger non-assujetti en 10.1 ; `invoices: []`).

- [ ] **Step 2 : Implémentation (GREEN)** — (a) réordonner `classifyEreportingOperation` (D4 : non-assujetti → `'10.3'` d'abord, puis cross-border → `'10.1'` sinon `'out'`) ; **retirer** le commentaire de dette export-B2C (l.27-31) et le remplacer par une **bannière INTERPRÉTATION** (heuristique assujetti par SIREN/n° TVA ; bucket export à confirmer Annexe 7). (b) `aggregateTransactions` : pour les opérations `'10.1'`, construire un `Flux10Invoice` (mapping BT→TT vérifié vs Annexe 6) et le pousser dans `invoices[]` (le générateur `appendInvoice` l'émet déjà). Les `'10.3'` restent agrégés ; un même `TransactionsReport` peut porter les deux.

- [ ] **Step 3 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): activation des transactions 10.1 B2B international par facture (TG-8) et résolution du misrouting export-B2C"
```
Expected: PASS ; 10.1 émis per-facture ; export-B2C correctement classé.

---

### Task 4 : Persistance des encaissements — tables `payments`/`payment_subtotals` (RLS FORCE, repo idempotent)

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/src/db/migrations/0024_payments.sql` (drizzle) + snapshot + `_journal`
- Create: `apps/api/src/db/migrations/0025_payments_rls.sql` (hand : RLS/grants)
- Create: `apps/api/src/payments/payment.model.ts`, `apps/api/src/payments/payments.repository.ts`
- Create: `apps/api/tests/e2e/payments-persistence.e2e.test.ts`

**Interfaces:**
- Consumes : `TenantContextService` (`runInTenant`).
- Produces (Tasks 5/7/8) : tables `payments`/`payment_subtotals` sous RLS `FORCE` ; repo `insertPayment` (idempotent), `listPayments`, `sumCapturedByRate`.

- [ ] **Step 1 : Schéma (2 tables)** — `schema.ts`, calquer `cdvTransmissions` :
  - `payments` : `id uuid pk`, `tenantId uuid FK tenants cascade`, `invoiceId uuid FK invoices **restrict**`, `paymentDate text` (AAAAMMJJ), `currency text default 'EUR'`, `reference text` (idempotence client), `createdAt`/`updatedAt`. **Index unique** `(invoice_id, reference)` (backstop idempotent), index `(tenantId, createdAt)`.
  - `payment_subtotals` : `id uuid pk`, `tenantId uuid`, `paymentId uuid FK payments **restrict**`, `taxPercent text` (TT-93, POURCENTAGE 3.2), `amount text` (TT-95, montant encaissé — **MONTANT 19.6** au XSD ; stocké `text`, comme tous les montants Flux 10). Index `(paymentId)`.

- [ ] **Step 2 : Migration drizzle (0024)** — `db:generate` → renommer `0024_payments.sql`, idx 24. Relire : `CREATE TABLE` ×2 + index unique `(invoice_id, reference)` + FK restrict. **Aucune** RLS/grant (→ 0025). Tables **neuves** → aucun backfill.

- [ ] **Step 3 : Migration manuelle RLS/grants (0025)** — calquer `0022_cdv_rls.sql` :
  - RLS `ENABLE`+`FORCE` + policy `tenant_isolation` (`nullif(current_setting('app.tenant_id',true),'')::uuid`) sur **les 2 tables**.
  - Grants : `payments` = `SELECT, INSERT` (immutables après capture — pas d'UPDATE/DELETE) ; `payment_subtotals` = `SELECT, INSERT`.
  - Enregistrer 0025 dans `meta/_journal.json` (idx 25, `version:"7"`, `when` epoch-ms ~+100000, `tag:"0025_payments_rls"`, `breakpoints:true`, **sans** snapshot — comme 0022).

- [ ] **Step 4 : Repository** — miroir `EreportingRepository`/`CdvTransmissionRepository` :
  - `insertPayment(tenantId, { invoiceId, paymentDate, currency, reference, subtotals })` : `ON CONFLICT (invoice_id, reference) DO NOTHING` + reload → `{ id, created }` ; sur INSERT, insérer les `payment_subtotals` **même transaction**.
  - `listPayments(tenantId, invoiceId)` (RLS) ; `sumCapturedByRate(tenantId, invoiceId)` (agrégat SQL par taux, pour l'intégrité Task 5) ; `listPaymentsForPeriod(tenantId, from, to)` (pour l'agrégation Task 7, join subtotals).

- [ ] **Step 5 : e2e (RED→GREEN)** — `payments-persistence.e2e.test.ts` (motifs 2.2/2.3) :
```ts
it('isole les encaissements par tenant (RLS FORCE)')                       // A invisible sous B
it('interdit UPDATE/DELETE sur payments et payment_subtotals (42501)')      // immutables
it('idempotence : 2e insert (invoice, reference) → created:false, 0 doublon de sous-total')
it('bloque la suppression d’une facture munie d’un encaissement (23503)')   // FK restrict
```

- [ ] **Step 6 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): persistance des encaissements (paiements par taux, RLS FORCE, capture idempotente)"
```

---

### Task 5 : Endpoint dual-auth de capture des encaissements (+ lecture, intégrité vs facture)

**Files:**
- Create: `apps/api/src/payments/payments.service.ts`, `apps/api/src/payments/payments.controller.ts`, `apps/api/src/payments/payments.module.ts`
- Modify: `apps/api/src/app.module.ts` (importer `PaymentsModule`)
- Create: `apps/api/tests/e2e/payments.e2e.test.ts`

**Interfaces:**
- Consumes : Task 4 (repo), `InvoicesRepository.loadCanonical` (2.1), guards dual-auth.
- Produces : `PaymentsService.capture(...)` + `GET/POST /payments`.

- [ ] **Step 1 : Service (GREEN après RED e2e)** — `capture(tenantId, body)` :
  1. `loadCanonical(tenantId, invoiceId)` ; `null` → **404** (byte-identique, anti-fuite : facture inconnue OU cross-tenant) ;
  2. Intégrité (D5) : chaque `taxPercent` posté ⊆ taux de la ventilation de la facture (sinon **422** `validation`) ; `sumCapturedByRate + nouveaux montants ≤ total TTC facture par taux` (sinon **422** `business-rule` — **INTERPRÉTATION** sur-encaissement, flaggée) ;
  3. `insertPayment(...)` idempotent → `{ id, created }` (re-POST même `reference` → `created:false`, 200/201 idempotent).

- [ ] **Step 2 : Endpoints (dual-auth)** — `payments.controller.ts` :
  - `POST /payments` : **dual-auth** `@UseGuards(TenantAuthGuard)` (capture machine PA **ou** session ; si session, ajouter `CsrfGuard`/`RolesGuard` — aligner sur `POST /invoices/:id/status`). Corps zod : `{ invoiceId: z.uuid(), paymentDate: DATE_RE, currency?: z.string(), reference: z.string().min(1), subtotals: z.array(z.object({ taxPercent: DECIMAL_RE, amount: AMOUNT_RE })).min(1) }` via `parseBody`. **`amount`** accepte la monnaie standard 2 décimales (comparable aux totaux 2-dp de la facture pour l'intégrité) ; le format XSD cible est **19.6** (l'émetteur Task 7 formate). `''`→normalisation aux frontières (leçon 2.4-T5#1).
  - `GET /payments?invoiceId=` : `@UseGuards(TenantAuthGuard)`, zod query, liste sous RLS, 404 anti-fuite.

- [ ] **Step 3 : e2e (RED→GREEN)** — `payments.e2e.test.ts` :
```ts
it('capture un encaissement (201) et le relit (GET) ; dual-auth clé & session')
it('est idempotent sur (invoice, reference) (re-POST → pas de doublon)')
it('refuse un taux absent de la ventilation de la facture (422)')
it('refuse un sur-encaissement cumulé au-delà du total par taux (422)')
it('renvoie 404 byte-identique pour une facture inconnue ET cross-tenant (anti-fuite)')
```

- [ ] **Step 4 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): endpoint dual-auth de capture des encaissements avec contrôle d'intégrité vs facture"
```

---

### Task 6 : 2ᵉ table de cadence PAIEMENTS (Tableau 13 PRIMAIRE p.68, module pur, oracle indépendant) — RÉÉCRITE post-B1

**Files:**
- Modify: `apps/api/src/ereporting/period.ts`
- Modify: `apps/api/tests/unit/period.test.ts`

**Interfaces:**
- Consumes : `VatRegime` (nomenclature), les formes `PeriodCadence` EXISTANTES (post-hotfix 91531d3 : `deadlineDay`).
- Produces (Task 8) : `PAYMENTS_CADENCE_BY_REGIME` + `computeDuePaymentPeriods(regime, referenceDate): DuePeriod[]` (bornée `MAX_DUE_PERIODS`, pure).

> **`CADENCE_BY_REGIME` (transactions) INTACTE.** La cadence paiement = une **2ᵉ table** sur le **MÊME moteur** — AUCUNE nouvelle forme (ni quarter, ni décades-paiement, ni dernier-jour : la version initiale de cette tâche transcrivait un Tableau 13 désaligné, cf. D6/B1). Vérité PRIMAIRE p.68 : les paiements ne diffèrent des transactions QUE pour le réel normal mensuel (mensuel/11-de-M+1 au lieu de décades).

- [ ] **Step 1 : Tests (RED) — oracle INDÉPENDANT** (leçon anti-tautologie 3.1-T1 : littéral `EXPECTED_PAYMENT_CADENCES` retranscrit **à la main du PDF p.68** — PAS du dossier de recherche, PAS de la table testée) :
```ts
describe('cadence PAIEMENTS (Tableau 13 PRIMAIRE p.68, colonne paiement)', () => {
  it('réel normal mensuel : MENSUEL (pas de décades), échéance le 11 du mois suivant à 08:00', () => { /* seul régime ≠ transactions */ })
  it('réel normal trimestriel : mensuel, échéance le 11 du mois suivant (identique transactions post-hotfix)', () => {})
  it('simplifié : mensuel, échéance le 1er du 2e mois suivant (identique transactions)', () => {})
  it('franchise : bimestre, échéance le 1er du 2e mois suivant (identique transactions)', () => {})
  it('la table paiements correspond EXACTEMENT à l’oracle indépendant (ensembliste par régime)', () => {})
  it('borne à MAX_DUE_PERIODS et gère year-wrap / février / bornes 08:00 pile', () => {})
})
```
Run → **RED** (fonction/table absentes).

- [ ] **Step 2 : Implémentation (GREEN)** — AUCUNE extension de `PeriodCadence` :
```ts
export const PAYMENTS_CADENCE_BY_REGIME: Record<VatRegime, PeriodCadence> = {
  reel_normal_mensuel:     { kind: 'month', deadlineMonthOffset: 1, deadlineDay: 11 }, // ≠ transactions (décades)
  reel_normal_trimestriel: { kind: 'month', deadlineMonthOffset: 1, deadlineDay: 11 }, // == transactions
  simplifie:               { kind: 'month', deadlineMonthOffset: 2, deadlineDay: 1 },  // == transactions
  franchise:               { kind: 'bimester' },                                        // == transactions
}
```
`computeDuePaymentPeriods` = même pipeline que `computeDuePeriods` avec cette table (factoriser le corps en interne, deux entrées publiques). **Bannière** : Tableau 13 PRIMAIRE p.68 (motif échéance-PA = échéance-déclarant + 1 jour) ; interprétation résiduelle 08:00 UTC vs Paris.

- [ ] **Step 3 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): table de cadence des paiements e-reporting (Tableau 13 primaire — mensuel au 11, autres régimes alignés transactions)"
```
Expected: period.ts **100 %** (branches des 4 régimes), oracle indépendant.

---

### Task 7 : Modèle+émetteur agrégé (TG-37) & agrégation TB-3 (10.2 per-facture / 10.4 agrégé, XOR, XSD-valide)

> **AMENDEMENTS revue du plan (plan-3-2-review.md §Task 7, binding)** : (a) la RÈGLE
> « SERVICES-ONLY » du §3.7.4 (note 119) s'applique aux données de paiement — l'e-reporting
> des paiements ne concerne que les PRESTATIONS DE SERVICES (les livraisons de biens en
> sont exclues) : l'agrégation TB-3 doit FILTRER par nature de ligne (le discriminant T1
> sert ici aussi) — citer la note 119 verbatim dans la bannière, tester biens-exclus ;
> (b) préciser le fetch du canonique PAR PAIEMENT (le paiement référence une facture —
> charger la ventilation par taux du canonique pour proratiser les montants encaissés
> par taux, règle de proratisation = interprétation flaggée).

**Files:**
- Modify: `apps/api/src/ereporting/flux10-model.ts` (+ `Flux10PaymentAggregate` ; `PaymentsReport.transactions[]`)
- Modify: `apps/api/src/ereporting/flux10-xml.ts` (+ émission `/PaymentsReport/Transactions` TG-37/38/39)
- Create: `apps/api/src/ereporting/flux10-payments-aggregate.ts`
- Modify: `apps/api/tests/unit/flux10-xml.test.ts`
- Create: `apps/api/tests/unit/flux10-payments-aggregate.test.ts`

**Interfaces:**
- Consumes : Task 4 (`listPaymentsForPeriod`), `classifyEreportingOperation`, `PaymentsReport`/`Flux10PaymentInvoice` (per-facture, **déjà présent**), `generateEreportingXml`+`appendPaymentsReport` (flux10-xml), `ereporting-xsd-validator` (payment.xsd).
- Produces (Task 8) : `Flux10PaymentAggregate` (TG-37/38/39) + `aggregatePayments(rows, opts): PaymentsReport | null`.

> **DEUX formes (D7, xlsx R135-R154)** : **10.2** (B2Bi) = per-facture (`PaymentsReport/Invoice`, `Flux10PaymentInvoice` **déjà modelé+émis** 2.3-T2) ; **10.4** (B2C) = agrégé (`PaymentsReport/Transactions`, TG-37/38/39, **sans réf facture ni catégorie**, groupé par **(date, taux)**) — **modèle+émetteur À AJOUTER**. Montants **19.6** ; `CurrencyCode` **0..1** → **garde élément vide** (classe 2.4-I1, ne jamais émettre `<CurrencyCode/>` vide).

- [ ] **Step 1 : Tests (RED)** —
```ts
// modèle/émetteur agrégé (flux10-xml.test.ts)
it('émet un /PaymentsReport/Transactions (TG-37) B2C : Payment/Date + SubTotals par taux, XSD-valide (payment.xsd)')
it('n’émet PAS de <CurrencyCode/> vide quand la devise est absente (garde 0..1)')
it('formate les montants encaissés en 19.6')
// agrégation (flux10-payments-aggregate.test.ts)
it('classe 10.2 (B2Bi) → per-facture Flux10PaymentInvoice ; 10.4 (B2C) → agrégé par (date, taux)')
it('exclut les factures classées out ; renvoie null (à blanc) si rien d’imposable')
it('respecte XOR : un Report porte payments OU transactions, jamais les deux')
```
Run → **RED** (modèle agrégé + agrégateur absents).

- [ ] **Step 2 : Implémentation (GREEN)** —
  - `flux10-model.ts` : `Flux10PaymentAggregate { paymentDate: string; subtotals: { taxPercent; amount; currency? }[] }` (TG-38/39) ; `PaymentsReport` gagne `transactions: Flux10PaymentAggregate[]` **à côté** de `invoices: Flux10PaymentInvoice[]`.
  - `flux10-xml.ts` : `appendPaymentsReport` émet **aussi** les blocs `/PaymentsReport/Transactions` (TG-37 : `Payment/Date` TT-96 + `SubTotals` par taux TT-97/98/99), **garde CurrencyCode vide**, montants **19.6**.
  - `flux10-payments-aggregate.ts` : `aggregatePayments` : pour chaque encaissement de la période, `classifyEreportingOperation(facture liée)` → **`'10.1'`** ⇒ `Flux10PaymentInvoice` (TT-91/102/92 + TG-36) dans `invoices[]` ; **`'10.3'`** ⇒ agréger par **(paymentDate, taxPercent)** dans `transactions[]` (`Flux10PaymentAggregate`, sommes `big.js`) ; **`'out'`** exclu ; `null` si vide. Le worker (Task 8) passe le `PaymentsReport` à `Flux10Report { transactions: null, payments }` (**XOR au niveau Report**) → `generateEreportingXml` (chemin `else if payments`) → validation `payment.xsd`.

- [ ] **Step 3 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): PaymentsReport TB-3 per-facture (10.2) et agrégé (10.4), agrégation des encaissements, XML XSD-valide, XOR"
```

---

### Task 8 : Ordonnanceur & worker des paiements (slot `payments`, cadence paiement, 3 couches, pipeline)

**Files:**
- Modify: `apps/api/src/config/env.ts` (+ `PAYMENTS_*`)
- Modify: `apps/api/src/worker/ereporting-sweep.service.ts` (branche enfilement `payments`)
- Modify: `apps/api/src/ereporting/ereporting-generation.service.ts` (branche `fluxKind='payments'`)
- Modify: `apps/api/tests/unit/env.test.ts`
- Create: `apps/api/tests/e2e/ereporting-payments.e2e.test.ts`

**Interfaces:**
- Consumes : Task 6 (`computeDuePaymentPeriods`), Task 7 (`aggregatePayments`), Task 4 (repo), `find_ereporting_declarants_due`, `insertTransmission` (`flux_kind='payments'`), port de transmission, machine 300/301.
- Produces : transmissions `payments` de bout en bout.

- [ ] **Step 1 : Env (RED→GREEN)** — `env.ts` (motif `EREPORTING_*`) : `PAYMENTS_SWEEP_EVERY_MS` (défaut horaire), `PAYMENTS_LOOKBACK_MS` (fenêtre bornée). `env.test.ts` : défauts.

- [ ] **Step 2 : Sweep + génération (GREEN après RED e2e)** —
  - `ereporting-sweep.service.ts` : **ajouter** une passe qui, pour chaque déclarant de `find_ereporting_declarants_due`, calcule `computeDuePaymentPeriods(regime, now)` et enfile un job `EREPORTING_GENERATE_JOB` avec `fluxKind:'payments'` et **jobId `${declarantId}-payments-${periodStart}`** (séparateur **`-`**). La passe transactions existante est **intacte**.
  - `ereporting-generation.service.ts` : **branche `payments`** (remplace le `throw` l.95-99 pour ce cas) : `listPaymentsForPeriod(tenant, from, to)` → `aggregatePayments` → `null` = à blanc (**0 écriture, 0 port**) → sinon `Flux10Report { transactions:null, payments }` → `generateEreportingXml` → **validation `payment.xsd`** (invalide → born-`rejetee` `REJ_SEMAN` **sans** appel port ; outillage manquant → throw/retry BullMQ, **jamais** un rejet) → `insertTransmission(flux_kind='payments', ...)` idempotent (`created:false` → resume/skip) → `transmit` port → `markTransmitted`. **Slot distinct** des transactions (index clé sur `flux_kind`).
  - **3 couches anti-double-envoi** (D7) : fenêtre bornée + jobId `-` + unique DB.

- [ ] **Step 3 : e2e (RED→GREEN)** — `ereporting-payments.e2e.test.ts` (Postgres réel + `InMemoryTransmissionSink` du helper worker) :
```ts
it('transmet un PaymentsReport 10.4 dû (encaissements capturés → 1 transmission payments)')
it('n’écrit rien si aucun encaissement sur la période (à blanc optionnelle)')
it('slot payments distinct du slot transactions pour le même déclarant/période (flux_kind)')
it('idempotent : re-sweep du même (déclarant, payments, période) ne double pas (3 couches)')
it('born-rejette (REJ_SEMAN) un PaymentsReport XSD-invalide sans appeler le port')
it('respecte la cadence paiement (une période non échue n’est pas enfilée)')
```

- [ ] **Step 4 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test && pnpm run audit:ci && pnpm outdated -r
git add -A
git commit -m "feat(api): ordonnanceur et worker de transmission des paiements TB-3 (slot payments, cadence dédiée, 3 couches anti-double-envoi)"
```

---

### Task 9 : CI / docs / OpenAPI / bump version — clôture

**Files:**
- Modify: `README.md` racine, `apps/api/README.md`
- Modify: OpenAPI/Swagger (endpoints `payments/*`)
- Modify: `apps/api/package.json` (`version` → `0.8.0`) ; vérifier `packages/invoice-core` = `0.4.0`

- [ ] **Step 1 : Documentation honnête** — décrire :
  - **Discriminant biens/services** (D1) : optionnel, rétro-compat JSONB sans migration, invoice-core 0.4.0.
  - **Cadres M\*** (D2/D3) : **dette 2.3 soldée pour les factures naturées** ; ventilation **total conservé** (base exacte, résidu TVA côté services), **jamais doublée** ; M\* non-naturée **toujours différée** (skip typé).
  - **10.1 B2Bi + export-B2C** (D4) : 10.1 émis per-facture (TG-8) ; misrouting résolu (non-assujetti ⇏ 10.1) ; heuristique assujetti + bucket export = **interprétations** (Annexe 7 go-live).
  - **Paiements TB-3** (D5/D6/D7) : capture explicite (pas d'auto-seed 212) ; **2ᵉ cadence** Tableau 13 verbatim (décades 20/10/10, trimestriel trimestriel, franchise dernier jour) + interprétation 08:00 UTC ; agrégation 10.2/10.4 XOR via générateur existant ; slot `flux_kind='payments'`.
  - **RUNBOOK** : deadlock slot × terminal **paiements** = même sémantique que 2.3 (procédure manuelle, ne pas retirer `rejetee` de l'index, chemin RE futur) ; sur-encaissement (interprétation) ; jobId paiements `-` (transactions `:` = risque latent noté).
  - **Différés** : auto-seed 212 (refusé) ; adaptateurs transport & push PPF ; schematron ; chemin RE ; provisioning déclarants.

- [ ] **Step 2 : Bump + gate finale + commit**
```bash
# apps/api/package.json : "version": "0.8.0" (phase 3.2 : paiements + ventilation biens/services)
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm test && pnpm run audit:ci && pnpm outdated -r
git add -A
git commit -m "docs: documentation paiements TB-3 et ventilation biens/services, bump versions 0.8.0 / invoice-core 0.4.0"
```
Expected: tout vert ; **invoice-core 100 %**, apps/api ≥ 90 %×4, apps/web ≥ 90 %×4 ; audit:ci 0 ; outdated vierge.

---

## Self-Review (contre research 2.3 / Tableau 13 / le cadrage 3.2)

**1. Couverture du cadrage :**
- Prérequis racine : discriminant `nature` optionnel + ventilation conservée (invoice-core, rétro-compat) → Task 1 (D1/D2). ✅
- Cadres M\* : split réel TLB1/TPS1 conservé, différé par facture sinon → Task 2 (D3). ✅
- 10.1 B2Bi per-facture + export-B2C résolu → Task 3 (D4). ✅
- Capture encaissements (RLS, idempotent, dual-auth, intégrité) → Tasks 4/5 (D5). ✅
- 2ᵉ cadence paiements (Tableau 13 verbatim, oracle indépendant) → Task 6 (D6). ✅
- Agrégation TB-3 : **10.2** per-facture (émetteur existant) + **10.4** agrégé (modèle+émetteur ajoutés), XOR, XSD-valide, montants 19.6, garde CurrencyCode vide → Task 7 (D7). ✅
- Worker/slot paiements (flux_kind=payments, 3 couches) → Task 8 (D7). ✅
- Aucune dépendance ajoutée ; aucune nouvelle SD ; aucun enum migration → mécaniquement vert. ✅

**2. Conservation & non-fabrication :** base séparée **exacte** (somme 2-dp), résidu TVA absorbé côté services → M1 1000/200→600/400 **jamais 2000/400** ; M\* non-naturée **différée** (aucune fabrication) ; pas d'auto-seed 212.

**3. Interprétations marquées go-live :** heuristique assujetti + bucket export-B2C (D4) ; sur-encaissement toléré (D5) ; échéances 08:00 UTC vs Paris (D6 — table primaire p.68, plus aucune forme dernier-jour/trimestre) ; validation XSD structurelle ≠ sémantique PPF (comme 2.3).

**4. Cohérence types & migrations :** `nature` partagé Tasks 1-2-3 ; `PaymentsReport`/`Flux10PaymentInvoice` réutilisés (2.3-T2) ; `flux_kind='payments'` déjà présent ; migrations **0024 (drizzle) → 0025 (hand)** contiguës après 0023 ; **aucune** nouvelle SD (réutilise `find_ereporting_declarants_due`).

## Recommandations fermes de périmètre (le contrôleur ratifie — aucune question ouverte)

- **R1 — Discriminant dans `invoice-core`, OPTIONNEL, rétro-compat sans migration.** Retenu (D1).
- **R2 — Ventilation à total conservé, résidu TVA côté services ; M\* non-naturée différée par facture.** Retenu (D2/D3).
- **R3 — 10.1 per-facture via `invoices[]` existant ; export-B2C résolu (non-assujetti ⇏ 10.1).** Retenu (D4).
- **R4 — Capture des encaissements EXPLICITE (endpoint dual-auth), PAS d'auto-seed 212.** Retenu (D5).
- **R5 — 2ᵉ table de cadence paiements verbatim Tableau 13, oracle indépendant.** Retenu (D6).
- **R6 — Réutilisation totale du slot 2.3 (`flux_kind='payments'`), aucune nouvelle SD, aucun enum migration.** Retenu (D7).
- **R7 — TB-3 : 10.2 per-facture (`Flux10PaymentInvoice` existant) + 10.4 agrégé (TG-37 ajouté, sans catégorie), XOR, XSD-valide, montants 19.6, garde CurrencyCode vide.** Retenu (D7).
- **R8 — Bump `invoice-core` 0.4.0 / `apps/api` 0.8.0.** Retenu.

## Execution Handoff

Plan complet, sauvegardé dans `docs/superpowers/plans/2026-07-16-phase3-2-paiements-ventilation.md`. Deux options :
1. **Subagent-Driven (recommandé)** — un subagent frais par tâche, revue Opus entre chaque (aligné 1.x/2.x).
2. **Inline** — exécution par lots avec points de contrôle.
