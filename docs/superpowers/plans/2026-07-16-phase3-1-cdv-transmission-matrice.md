# Plan 3.1 — Transmission des CDV (Flux 6) & matrice de cycle de vie (interop / Peppol différé)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Livrer deux briques de socle PA/PDP indissociables et jusqu'ici différées à la phase 3 :

1. **REMPLACER** la matrice de transitions CDV **monotone** (`apps/api/src/invoices/lifecycle-status.ts`, phase 1.1 — bloqueur go-live tracé en 2.1) par une **machine DAG data-driven** (miroir structurel de `ereporting-lifecycle.ts` / `annuaire-lifecycle.ts`) : transitions `ALLOWED` **explicites** dérivées des sources **publiques** (Dossier v3.2 §3.6.4 Tableau 8, CGI, Annexe 2 CDV V2.3), **corrigeant les 4 anomalies connues** (interdire `212→213` ; autoriser les retours légitimes `207→205`, `208→204`, `206→205`), la table **entière marquée INTERPRÉTATION PROJET** en l'attente de la norme **AFNOR XP Z12-012** (payante, hors dépôt — item Xavier) et **PARAMÉTRÉE** de sorte que l'acquisition de la norme ne change **que la table + les tests**. Le journal scellé `invoice_status_events` (2.2) et le CAS `recordTransition` sont **INTOUCHÉS** ; seul le **garde de service** échange les matrices (compat : toute transition historique enregistrée sous l'ancienne matrice reste **valide dans le journal**).

2. **TRANSMETTRE** les CDV : émission du **Flux 6 (message de cycle de vie, format CDAR / UN-CEFACT SCRDM CI Application Response)** portant les **statuts obligatoires 200/210/212/213** vers le **PPF** (obligation §3.6.6, **délai 24h** depuis l'horodatage du statut) **et** vers la **plateforme de réception** via le réseau d'interop (§2.3.10, Peppol en repli), avec **routage** résolu par l'**annuaire 2.4** (`resolveRecipient`), un **`CdvTransmissionPort` différé au déploiement** (4ᵉ instance de port : contrat + impl locale write-once + factory ; drivers `sftp`/`as2`/`as4`/`as4-peppol`/`api` → `throw`), un **ordonnanceur borné** (discipline 24h, 3 couches anti-double-envoi) et une **frontière d'acquittement** (601 « message CDV rejeté » / accept implicite) — les acquittements réels (push PPF / inbound réseau) et l'adhésion OpenPeppol/PKI/SMP/AS4 restant **derrière le port** (go-live, items Xavier).

**Architecture :** On **réutilise le socle 1.x/2.x** exactement comme en 2.3/2.4. La **matrice DAG** reste **dans `apps/api/src/invoices/lifecycle-status.ts`** (couplée à la facture, consommée par `LifecycleService.transition`) — c'est un remplacement chirurgical d'un module pur existant, pas un déplacement. Le **domaine de transmission CDV** vit dans un **nouveau dossier `apps/api/src/cdv/*`** (modules **purs sans NestJS** pour la génération F6/CDAR et la machine de livraison ; services NestJS pour l'orchestration/le port/les endpoints) — précédent direct : `src/ereporting/*` (2.3), `src/annuaire/*` (2.4). La **génération XML** réutilise `xmlbuilder2` (**déjà présent** dans `apps/api` depuis 2.3, MIT, dédupliqué via `invoice-core`) — **aucune dépendance ajoutée**. La **source des statuts** est le **journal scellé `invoice_status_events`** (2.2, **lecture seule**, jamais re-scellé ni re-validé). Le **routage** consomme `AnnuaireConsultationService.resolveRecipient(tenantId, maille, dateYmd)` (2.4) — la maille est dérivée du destinataire (`buyer`) de l'`Invoice` canonique. L'**infra** réutilise BullMQ (file dédiée `cdv-transmission` + `@Processor` unique routant par `job.name` ; jobs répétables sur `maintenance` ; `upsertJobScheduler` ; énumération cross-tenant par **fonction SD** `find_cdv_transmissions_due`, miroir `find_ereporting_declarants_due`). La **persistance** ajoute **deux tables tenant-scopées** (`cdv_transmissions` suivi de livraison + cycle de vie, `cdv_transmission_events` journal append-only **non scellé**) sous RLS `FORCE`. La **transmission** passe par le **port** `CdvTransmissionPort` : `LocalFilesystemCdvStore` (écrit le F6 XML write-once, `trackingRef` = SHA-256 déterministe — entièrement testable) ; adaptateurs réels (SFTP/AS2/AS4 X.509, **AS4-Peppol**, API OAuth2) **spécifiés, activés au déploiement** (`throw` documenté et testé), exactement comme `Flux10TransmissionPort` (2.3), `ArchiveStore` (2.2) et `AnnuairePort` (2.4).

**Tech Stack :** **Aucune dépendance runtime ajoutée.** Génération XML CDAR : `xmlbuilder2` (déjà dans `apps/api` depuis 2.3, pin exact, dédup lockfile via `invoice-core@^4.0.3`). Validation F6 : **STRUCTURELLE en code** (well-formedness `xmlbuilder2` + présence/patterns des champs obligatoires MDT + code ∈ Tableau 8) — **il n'existe AUCUN XSD DGFiP pour le Flux 6/CDV** (vérifié in situ, cf. D3) ; l'XSD UN/CEFACT CDAR n'est **pas** vendorisé (`docs/reglementaire` en lecture seule, aucun fetch externe, aucune dépendance) → validation structurelle honnête (posture PAF 2.2). Dates/hash/IO : `node:*` natifs. Files : **BullMQ 5.80.x** (déjà présent). Aucun ajout à `apps/web`. `docker-compose` inchangé (le store local écrit dans un tmpdir/monté ; `tests/setup.ts` pointe déjà `*_LOCAL_DIR` vers un tmpdir par run — leçon 2.4).

## Global Constraints

Reprises **verbatim** du socle 1.x/2.x (non négociables) — chaque tâche en hérite implicitement :

- **TDD strict RED/GREEN** : test écrit et vu échouer avant toute implémentation ; aucun merge si un test échoue (spec §7). Un commit minimum par tâche, message en **français**, **sans** trailer `Co-Authored-By: Claude` ni mention Claude ; commits au seul nom de l'utilisateur. `pnpm format` avant chaque commit.
- **Couverture bloquante** : **≥ 90 %** (lines/functions/statements/branches) maintenue sur `apps/api` ; `packages/invoice-core` reste à **100 %** et **N'EST PAS TOUCHÉ** (vérifié : aucun code F6/CDV/CDAR dans invoice-core — la génération F6 est écrite de zéro dans `apps/api`). `apps/web` : seuil 90×4 maintenu (aucune modif web). Exclusions de couverture existantes conservées (`src/main.ts`, `src/worker-main.ts`, `**/*.module.ts`, `src/db/migrations/**`). **Tout module pur** (matrice DAG, génération F6/CDAR, machine de livraison, helpers de fenêtre/deadline) est visé à **100 %** par des tests unitaires déterministes (goldens, vecteurs de date fixés, aucun `Date.now()` dans la logique pure).
- **e2e sur Postgres réel (Testcontainers)** pour toute table/endpoint ; **Redis réel** pour tout flux worker/scheduler ; **tests d'isolation multi-tenant explicites** (transmission/journal d'un tenant jamais visible d'un autre). **Motifs de stabilité e2e OBLIGATOIRES** (acquis 1.4/2.1/2.2/2.3/2.4) : `listenOnce`, `maxWorkers: 5`, `withStartupTimeout(120_000)`, `hookTimeout: 150_000`, écouteur `error` sur tout pool `pg` brut (bruit `57P01` au teardown).
- **Sécurité OWASP** : validation de toute entrée (zod), authz systématique (dual-auth session/clé API sur les endpoints de lecture ; frontière d'acquittement exercée par les e2e). **Aucune donnée sensible hors des frontières tenant** : transmissions, journal restent sous RLS `FORCE`. Erreurs normalisées **RFC 9457 `application/problem+json`**. **Aucun secret dans Redis** : les jobs ne portent que des identifiants internes (le worker recharge sous RLS — motif 2.1/2.3/2.4).
- **Moindre privilège Postgres inchangé** : rôle `factelec_app` ≠ propriétaire, **sans `BYPASSRLS`, sans superuser** ; RLS **`ENABLE` + `FORCE`** sur toute table tenant ajoutée ; propagation du tenant par `SET LOCAL` via `runInTenant`. La fonction SD d'énumération cross-tenant épingle **`search_path=pg_catalog, pg_temp`** et **schéma-qualifie** ses objets (miroir `find_ereporting_declarants_due` 0017 / `find_annuaire_sync_targets` 0019).
- **TypeScript `strict: true`, ESM, NodeNext, Node ≥ 22.** `typescript` pinné **exactement `7.0.2`** (racine, tsgo). Repli local `typescript@5.9.x` du seul workspace concerné autorisé et documenté si un typecheck bute — sans toucher le pin racine.
- **Dépendances pinnées exactement, dernière stable, licence.** **`pnpm run audit:ci` 0 vulnérabilité** et **`pnpm outdated -r` vierge** restent **bloquants** en CI. **Aucune dépendance ajoutée** (réutilisation `xmlbuilder2` + `node:*`) → objectif mécaniquement tenu (vérifier néanmoins à **chaque** tâche — un patch amont peut sortir en cours de plan, leçon 2.2-T5 / drift bullmq 2.3-T3 / 2.4-T8).
- **`@factelec/invoice-core` consommé via son exports map**, jamais par chemin relatif. `docs/reference/` et `docs/reglementaire/` en **lecture seule** (aucun XSD copié/modifié ; aucun schéma externe vendorisé).
- Identifiants de code en **anglais** ; commentaires/commits/docs en **français**.

---

## Périmètre : retenu en 3.1 vs reporté

**Retenu (ce plan) :**
1. **Matrice DAG CDV** (remplace le monotone) : 14 statuts (200-213), `ALLOWED: Record<Status, Status[]>` explicite, `TERMINAL`, `REASON_REQUIRED`, **4 anomalies corrigées**, table **paramétrée** + **bannière INTERPRÉTATION PROJET / AFNOR XP Z12-012**, compat journal scellé (Task 1).
2. **Génération Flux 6 / CDAR** (`generateFlux6Cdar`) : `rsm:CrossIndustryApplicationResponse` par le mapping Annexe 2 V2.3 (MDT-8/78/87/105/126/3, parties ICD 6523), **validation STRUCTURELLE en code** (pas de XSD DGFiP, cf. D3), échappement XML correct (Task 2).
3. **Machine de livraison CDV DISTINCTE** (`prepared`→`transmitted`→{`acknowledged`, `rejected`(601)} + `parked` retryable), miroir pur de `ereporting-lifecycle.ts` mais séparée (Task 3).
4. **Persistance** : `cdv_transmissions` (suivi + cycle de vie, index unique idempotent **slot-safe**), `cdv_transmission_events` (journal append-only **non scellé**) ; RLS `FORCE`, SD cross-tenant `find_cdv_transmissions_due` ; migrations **0021 (drizzle)** + **0022 (hand)** (Task 4).
5. **`CdvTransmissionPort`** + `LocalFilesystemCdvStore` write-once + factory `@Global` (drivers réels `throw`) + env `CDV_*` (Task 5).
6. **Service de transmission + routage** : `resolveRecipient` (annuaire 2.4) câblé dans l'émission ; F6 généré+validé → `transmit` port → enregistrement ; **succès partiel au grain (statut × cible)** ; destinataire non adressable/ambigu → **`parked`** + reprise bornée (Task 6).
7. **Ordonnanceur borné (24h) + worker + reprise des transmissions figées** : sweep des événements de statut obligatoires dus (fenêtre bornée) → job par (facture, statut, cible) → worker (résolution/génération/validation/transmission), **3 couches anti-double-envoi**, sweep `parked`→retry (miroir archive-retry 2.2 / stuck-draft 2.4) (Task 7).
8. **Frontière d'acquittement + endpoints dual-auth** : `recordPpfStatus`/`recordRecipientStatus` (601 rejeté / accept implicite, motif MDT-126, désambiguïsation `actor`/`from` — miroir 2.3-T9) ; `GET /cdv/transmissions`, `:id/xml`, `:id/events` (Task 8).
9. **CI / docs / OpenAPI / bump `0.7.0`** (Task 9).

**Reporté (acté ici, justifié en D3/D5/D6/D7/D8) :**
- **Adaptateurs de transport réels** (SFTP clés RSA / AS2-AS4 X.509 / **AS4-Peppol** / API OAuth2) : credentials + secrets à la main de Xavier, non testables sans partenaire PPF/réseau ; **conçus** (contrat du port), **activés au déploiement** (`throw` testé).
- **Acquittements réels** (push PPF 601 / inbound réseau) : la **frontière** (`recordPpfStatus`/`recordRecipientStatus`) est livrée et exercée par les e2e ; la **source** (webhook/AS4 inbound) est différée (miroir D7 de 2.3, D6 de 2.4).
- **Adhésion OpenPeppol / PKI test+prod / SMP / stack AS4** : items **Xavier** (déploiement), documentés (dossier §4.2 / §1).
- **Norme AFNOR XP Z12-012** (payante, hors dépôt) : item **Xavier** ; à l'acquisition, remplacer **UNIQUEMENT** la table `ALLOWED`/`TERMINAL`/`REASON_REQUIRED` + les vecteurs de test (paramétrisation, D1).
- **Validation XSD du F6** : aucun XSD DGFiP n'existe (D3) ; l'XSD UN/CEFACT CDAR n'est pas vendorisé → validation **structurelle** seule pour l'instant ; câbler un `xmllint --schema` **si** Xavier vendorise le schéma UN/CEFACT CDAR ou si la DGFiP en publie un (go-live).
- **Streaming des statuts FACULTATIFS** (201-209, 211) vers les plateformes de réception : le socle transmet les **obligatoires** (200/210/212/213) ; le streaming des facultatifs au destinataire est différé.
- **Ingestion INBOUND de F6** (recevoir des CDV d'autres PA / fournisseur→PAE, acheteur→PAR ; le PPF émet aussi des CDV) : le socle **émet** les statuts de nos factures ; la réception de F6 tiers suit l'activation du transport (déploiement) — garde « élément XSD/xs:string vide » **posée d'emblée** sur tout futur parseur (D10, leçon 2.4-I1).
- **Confirmation du code interface `FFE0614A`** : introuvable dans les sources primaires (Annexe 2 / Dossier), présent seulement au dossier de recherche → **à confirmer** avant prod (§3.4 enveloppe / Chorus Pro) ; non utilisé comme identifiant contraignant ici.

---

## Décisions structurantes (à lire avant d'exécuter)

### D1 — Matrice CDV = DAG data-driven remplaçant le monotone ; INTERPRÉTATION PROJET / AFNOR ; 4 anomalies corrigées ; paramétrée ; compat journal scellé
- **REMPLACER** (pas seulement durcir) le modèle **monotone** (`canTransition` = `code(to) > code(from)` si `from` non terminal — `lifecycle-status.ts` L97-106) par une **machine à états DAG** : `ALLOWED: Record<LifecycleStatus, LifecycleStatus[]>` **explicite**, `TERMINAL: Set`, garde `Object.hasOwn`, `InvalidLifecycleTransitionError` — **miroir structurel exact** de `ereporting-lifecycle.ts` / `annuaire-lifecycle.ts`.
- **Corriger les 4 anomalies** (BLOQUEUR 2.1, ledger L181) : **interdire `212→213`** (encaissée → rejetée : rejet fonctionnel après paiement, absurde) ; **autoriser `207→205`** (litige résolu → approuvée), **`208→204`** (suspension levée → prise en charge), **`206→205`** (partielle → totale). Encodage retenu (le plus propre) : rendre **`212 Encaissée` TERMINAL** (chemin heureux clos, CGI art. 290 A) — ce qui interdit **mécaniquement** `212→213` sans règle ad hoc ; et énumérer les retours légitimes dans `ALLOWED`.
- **Table entière = INTERPRÉTATION PROJET.** Aucune matrice de transitions n'est énumérée par la DGFiP (§3.6.4 renvoie explicitement à **AFNOR XP Z12-012**, « liste non exhaustive, voir norme AFNOR XP Z12-012 »). La table encode une **chronologie plausible respectant la seule contrainte documentée** (« respect de la chronologie ») **+ les 4 corrections mandatées**. **Seules les 4 corrections sont "dures"** ; le reste des arêtes est une interprétation défendable, **bannière en tête de fichier** (style `ereporting-lifecycle.ts` Figure 59).
- **PARAMÉTRÉE** : acquérir AFNOR XP Z12-012 ne doit changer **QUE** `ALLOWED`/`TERMINAL`/`REASON_REQUIRED` (constantes) **et** les vecteurs de test — **zéro** autre fichier (le service, le CAS, le journal, les endpoints sont agnostiques à la table).
- **Compat / chemin de migration** : le journal scellé `invoice_status_events` (2.2, trigger `seal_status_event` 0012) et le CAS `InvoicesRepository.recordTransition` sont **INTOUCHÉS** (aucune migration, aucun changement de schéma/trigger). Le garde de matrice est **au niveau SERVICE** (`LifecycleService.transition` appelle `canTransition` **avant** `recordTransition`). `verifyTenantChain` (2.2) **recalcule des hash, ne re-valide JAMAIS les transitions** → **toute transition historique** enregistrée sous l'ancienne matrice (ex. un `212→213` légataire) **reste scellée et valide** dans le journal ; seule une **nouvelle** transition est gardée par le DAG. **`invoice-core` n'est PAS touché** (la matrice vit dans `apps/api`).
- **Source vérifiée** : §3.6.4 Tableau 8 (14 codes + caractère obligatoire/facultatif, verbatim §Sources) ; renvoi AFNOR XP Z12-012 (verbatim) ; ledger 2.1 (BLOQUEUR go-live, 4 anomalies nommées).

### D2 — Matrice dans `invoices/`, domaine transmission dans `apps/api/src/cdv/*` ; AUCUNE dépendance ajoutée ; invoice-core intouché
- La **matrice** reste dans `apps/api/src/invoices/lifecycle-status.ts` (module pur existant, couplé facture) — remplacement chirurgical. Le **domaine transmission** (génération F6/CDAR, machine de livraison, port, repo, services, worker) vit dans **`apps/api/src/cdv/*`** — précédent direct `src/ereporting/*` (2.3), `src/annuaire/*` (2.4). Pas de nouveau package (arbitrage 2.3-Q2/2.4-R1 « rester dans apps/api »).
- **`xmlbuilder2` réutilisé** (déjà présent, pin exact, dédup) pour la génération CDAR (échappement XML correct — proscrit la concaténation maison, injection-prone). **Aucune dépendance runtime ajoutée** → `outdated`/`audit` mécaniquement verts. **Vérifié : aucun code F6/CDV/CDAR dans `packages/invoice-core`** (seul `flux/generate-extract.ts` existe = extrait fiscal F1, sans rapport) → la génération F6 est écrite **de zéro** dans `apps/api`, invoice-core reste à 100 % **sans y toucher**.

### D3 — F6 = CDAR (UN/CEFACT SCRDM CI Application Response) ; AUCUN XSD DGFiP → validation STRUCTURELLE honnête (posture PAF)
- **Vérifié in situ** (l'arbre `3- XSD_v3.2/` ne contient QUE `0 - Annuaire`, `1 - E-reporting`, `2 - E-invoicing` ; `Changelog_XSD.md` n'énumère que ces trois familles) : **il n'existe AUCUN XSD DGFiP pour le Flux 6 / CDV / CDAR / Application Response.** Le format F6 est décrit **sémantiquement** dans **`Annexe 2 - Format sémantique FE CDV - Flux 6 - V2.3.xlsx`** (onglet **« CDV FE - CI ARM »**, 313 lignes) mappé sur le standard **externe** UN/CEFACT **SCRDM CI Cross Domain Application Response Message** (footnote 102 : « format CDAR … UN/CEFACT SCRDM CI Cross Domain Application Response message », verbatim §Sources).
- **Décision** : générer `rsm:CrossIndustryApplicationResponse` (namespaces `rsm:`/`ram:`/`udt:`) par le mapping Annexe 2 V2.3, blocs `rsm:ExchangedDocumentContext` / `rsm:ExchangedDocument` / `rsm:AcknowledgementDocument`. Champs obligatoires (Required PPF) : **MDT-105** `AcknowledgementDocument/ram:ReferenceReferencedDocument/ram:ProcessConditionCode` (code statut 3 car.), **MDT-87** `.../ram:IssuerAssignedID` (n° facture / id flux), **MDT-78** `AcknowledgementDocument/ram:IssueDateTime/udt:DateTimeString` (horodate statut AAAAMMJJHHMMSS), **MDT-8** `ExchangedDocument/ram:IssueDateTime/udt:DateTimeString` (`@format=204`), **MDT-3** `ExchangedDocumentContext/.../ram:ID` (profil), parties `ram:SenderTradeParty`/`IssuerTradeParty`/`RecipientTradeParty` via `ram:GlobalID @schemeID` **ICD 6523** (`0002` SIREN / `0009` SIRET / `0224` code routage / `0238` matricule PDP-PPF), motif de rejet `MDT-126` `.../ram:SpecifiedDocumentStatus/ram:IncludedNote/ram:Content`.
- **Validation** : **AUCUN XSD à valider** (l'XSD UN/CEFACT CDAR n'est **pas** vendorisé ; `docs/reglementaire` lecture seule ; aucun fetch externe ; aucune dépendance). → **validation STRUCTURELLE en code** : well-formedness (`xmlbuilder2` round-trip), **présence** des MDT obligatoires, code ∈ Tableau 8, horodate `^[0-9]{14}$`, `@schemeID` ∈ ICD 6523, échappement. **Posture PAF (2.2)** honnête : « aucun format normalisé XSD → conception projet, validation structurelle » — **contraste explicite** avec 2.3/2.4 (qui DISPOSAIENT d'XSD stricts). Marqué **INTERPRÉTATION PROJET**. Câblage d'un vrai `xmllint --schema` = go-live **si** Xavier vendorise le schéma UN/CEFACT CDAR.
- **Source vérifiée** : Annexe 2 V2.3 (onglet CI ARM, mapping MDT ci-dessus) ; Dossier §3.6.4 (« format structuré CDAR ») + footnote 102 (UN/CEFACT SCRDM CI) + cartographie flux p.19 (F6 = CDAR).

### D4 — Machine de livraison CDV DISTINCTE ; `rejected` ancré au code 601 ; journal append-only NON scellé
- La **livraison** d'un CDV a son **propre cycle**, **distinct** du CDV facture (200-213), de l'e-reporting (300/301) et de l'annuaire (draft/published/...) : `prepared` (F6 rédigé localement) → `transmitted` (émis via le port) puis **acquittement** `acknowledged` (accepté — **implicite**, aucun code d'acceptation F6) ⊕ `rejected` (**code 601 « message CDV rejeté »**, Annexe 2 onglet « Statuts », objet « message CDV (Flux 6) ») ; plus un chemin **`parked`** (destinataire non adressable/ambigu — **NON terminal**, repris par le sweep). Machine **pure** (`cdv-transmission-lifecycle.ts`), **miroir structurel** de `ereporting-lifecycle.ts` (transitions `ALLOWED`, `Object.hasOwn`, `InvalidCdvTransmissionTransitionError`), **sans conflation**.
- **`code`** : `prepared`/`transmitted`/`parked`/`acknowledged` = `code: null` (états internes/implicites — aucun code DGFiP inventé, leçon 2.3-A3) ; **`rejected` = `code: 601`** (RÉEL, Annexe 2). Motif de rejet = **chaîne libre** (MDT-126 `Content`, texte 2000) — pas d'énum normatif de motifs F6 fourni.
- **Désambiguïsation** (miroir 2.3-T9) : un rejet **LOCAL** pré-envoi (F6 structurellement invalide) naît `rejected` par **genèse** (`from=null`, `actor='platform'`) ; un rejet **PPF/réseau** 601 est `transmitted→rejected` (`actor='ppf'|'recipient'`) — les endpoints/exports exposent `actor`+`fromStatus` (jamais un 601 ambigu).
- Journal `cdv_transmission_events` **append-only** (RLS `FORCE` + grants `SELECT`+`INSERT`, motif e-reporting/annuaire) mais **NON scellé** (pas de hash-chain) : la transmission au PPF/réseau est **authentifiée au niveau transport** (le scellement 2.2 s'applique au journal CDV **facture** `invoice_status_events`, PAS au flux de transmission — cohérent D3 de 2.3, D6 de 2.4).

### D5 — `CdvTransmissionPort` différé au déploiement (4ᵉ instance ; miroir `Flux10TransmissionPort`)
- **Testable sans partenaire** : le **port** `CdvTransmissionPort` (`transmit(payload) → TransmitResult{trackingRef, location}` ; `status(trackingRef) → CdvAckStatus{outcome}`) et l'impl **`LocalFilesystemCdvStore`** — écrit le F6 XML **write-once** (`wx` + `chmod 0o444`, anti-traversée `SAFE_KEY`/`normalize`/`..`, `EEXIST` capturé d'emblée → résultat d'origine — leçon 2.2 appliquée), `trackingRef = sha256(xml)` ; `status()` → `pending` par défaut. **Miroir exact** de `LocalFilesystemTransmissionStore` (2.3-T6) / `LocalFilesystemAnnuaireStore` (2.4-T6).
- **NON testable sans infra** : adaptateurs **SFTP** (clés RSA), **AS2/AS4** (X.509), **AS4-Peppol** (SMP + PKI Peppol + PINT Application Response), **API** (OAuth2 PISTE). **Non écrits** — **contrat spécifié**, **sélection par env** `CDV_TRANSMISSION_DRIVER=local|sftp|as2|as4|as4-peppol|api` (défaut `local`) + `CDV_LOCAL_DIR`. La branche non-`local` de la factory est un **`throw` documenté et testé** (une ligne couverte). **Peppol = l'un des drivers de déploiement** (`as4-peppol`) : la bascule est une décision d'env, exactement comme S3/SFTP.
- **Items Xavier (déploiement)** : adhésion OpenPeppol (AISBL, cotisation/assurance), PKI test+prod (via PA/OO, renouvellement 2 ans), enregistrement SMP, stack AS4 (gateway ebMS3). **Différés derrière le port** ; documentés au README (Task 9).

### D6 — Routage via l'annuaire 2.4 ; non-adressable/ambigu → `parked` + reprise bornée ; succès partiel au grain (statut × cible)
- La cible « plateforme de réception » est résolue par **`AnnuaireConsultationService.resolveRecipient(tenantId, maille, dateYmd)`** (2.4, déjà livré) : la **maille** est dérivée du destinataire (`buyer`) de l'`Invoice` canonique (SIREN/SIRET) ; la **date** = `issueDate` de la facture (**INTERPRÉTATION** : la ligne d'annuaire en vigueur à la date d'émission — la spec ne tranche pas la date de routage d'un CDV ; défendable et documenté).
- `RecipientUnaddressableError` / `AmbiguousResolutionError` (2.4) → la cible `recipient` passe en **`parked`** (transmission NON terminale, reprise par le sweep `parked`→retry quand l'annuaire est mis à jour) — miroir **archive-retry** (2.2) / **stuck-draft** (2.4). La cible `ppf` (réglementaire, **sans annuaire**) progresse **indépendamment** : **succès partiel au grain (facture × statut × cible)** (miroir D13 de 2.4).
- **Câblage** : ce plan consomme `resolveRecipient` (la brique livrée en 2.4) — c'est **l'aboutissement** du chaînage annoncé en 2.4 (« la brique que le flux de facturation consommera pour router »).

### D7 — Cibles & délai 24h ; obligatoires seuls ; SLA/ack Peppol = interprétation
- **Cibles** : les statuts **obligatoires** (200/210/212/213) sont transmis (a) au **PPF** (obligation §3.6.6 : « Toute plateforme (PAE ou PAR) a l'obligation de transmettre au PPF les statuts obligatoires ») et (b) à la **plateforme de réception** via l'interop (§2.3.10, Peppol en repli) **lorsqu'adressable**. Les statuts **facultatifs** (201-209, 211) ne sont **PAS** transmis au PPF (§3.6.4 « ne doivent pas être transmis à l'administration fiscale ») ; leur streaming au destinataire est **différé**.
- **Délai 24h** (§3.6.5 : 24h depuis l'émission de « Déposée » ; §3.6.6 : 24h depuis l'**horodatage du statut**) : le sweep tourne **fréquemment** (≪ 24h, défaut horaire) sur une **fenêtre bornée** (discipline 2.3-A2) → transmission au plus tôt ; l'**échéance** (`event_created_at + 24h`) est **calculée et journalisée** (drapeau « à risque » si dépassée) — helper pur testé. La **mécanique exacte** de l'SLA (24h côté PPF vs côté réseau ; l'ack Peppol AS4 satisfait-il le délai ?) est **INTERPRÉTATION PROJET documentée** (comme les deadlines Tableau 13 en 2.3-D4).

### D8 — Anti-double-envoi 3 couches ; pas de deadlock slot × terminal (leçon 2.3-A2 / 2.4-A-DEADLOCK)
- **3 couches** (aucune seule ne suffit — leçon 2.3) : (1) **fenêtre bornée** du sweep (`CDV_TRANSMISSION_LOOKBACK_MS` ; ne ré-émet jamais tout l'historique) ; (2) **jobId déterministe** `${invoiceId}-${toStatus}-${target}` — **séparateur `-`, PAS `:`** (leçon 2.4-T9 : BullMQ `validateOptions` rejette `:` dans un jobId) ; (3) **backstop DB** : index unique `(invoice_id, to_status, target)` + `insertTransmission` idempotent (`ON CONFLICT DO NOTHING` + reload, `created:false` → skip/resume — miroir `EreportingRepository.insertTransmission`).
- **Pas de deadlock slot × terminal** : le slot unique `(invoice_id, to_status, target)` porte **une** ligne qui **progresse** par états. Les échecs **retryables** (destinataire non adressable) utilisent l'état **`parked` NON terminal** (repris **en place** par le sweep, jamais une nouvelle ligne) — la fenêtre de double-envoi n'est **pas** rouverte (la ligne reste indexée). Les échecs **définitifs** (F6 structurellement invalide = bug de génération, ou 601 métier) sont **terminaux** (`rejected`) et occupent **légitimement** le slot (ne pas spammer le PPF). **Analyse explicite** (l'anti-pattern 2.3-A2 était un IN born-rejetée figeant le slot — ici le seul terminal-qui-fige est un échec authentiquement permanent, jamais un cas retryable). Un born-rejetée local n'occupe le slot que pour la cible concernée ; la **re-génération après correction de code** est un rejeu de code, pas un flux de données à retenter.

### D9 — Réutilisation : Invoice (destinataire), journal scellé 2.2 (source, lecture seule), annuaire 2.4, BullMQ, drizzle/RLS/SD, dual-auth
- **Données** : la maille de routage part de l'`Invoice` canonique (`buyer` SIREN/SIRET) — aucune ré-extraction. La **source des statuts** est **`invoice_status_events`** (2.2, journal scellé) — **lecture seule**, énumérée par la SD `find_cdv_transmissions_due` ; **jamais** re-scellée ni re-validée. **Résolution** : `AnnuaireConsultationService.resolveRecipient` (2.4). **Infra** : file `cdv-transmission` + `@Processor` unique (motif `ereporting-generation`), jobs répétables sur `maintenance` (branches `CDV_TRANSMISSION_SWEEP_JOB` / `CDV_STUCK_RETRY_JOB`, motif `MaintenanceProcessor`), scheduler `upsertJobScheduler` (motif `EreportingScheduler`/`AnnuaireScheduler`), énumération cross-tenant par **SD** (motif `find_ereporting_declarants_due`). **Discipline DB** : migrations drizzle (table/enum), **manuelles** (RLS/grants/SD), `nullif(current_setting('app.tenant_id',true),'')::uuid`, SD `search_path=pg_catalog,pg_temp` + schéma-qualifié. **Contrôleur** : dual-auth `TenantAuthGuard` + 404 anti-fuite (motif `EreportingController`).

### D10 — Gardes « élément XSD/xs:string vide » d'emblée sur tout parseur inbound (leçon 2.4-I1)
- Bien que l'**ingestion inbound** de F6 (ack PPF/réseau, F6 tiers) soit **différée** (D5, derrière le port), **toute** frontière de désérialisation posée dans ce plan (ex. mapping d'un ack simulé, futur parseur) applique **d'emblée** la garde de la **classe** de bug 2.4-I1 : un élément **XSD-valide mais VIDE** (`xs:string`/`xs:token` non contraint désérialisé `{}`/`undefined` par `xmlbuilder2`) → **rejet TYPÉ log+skip**, **jamais** un `TypeError` non typé ni une corruption. On **balaie la CLASSE** (tous les champs texte non contraints), pas une liste nommée (leçon I1b). Les acquittements simulés des e2e passent par la frontière typée (`recordPpfStatus`/`recordRecipientStatus`), déjà robuste (validation zod/motif avant écriture).

---

## Versions & dépendances (registre npm vérifié le 2026-07-16)

| Brique | Fournisseur | Provenance / note |
|---|---|---|
| Génération XML CDAR | **`xmlbuilder2`** (déjà présent `apps/api`, pin exact) | **Aucun ajout** ; dédup lockfile via `invoice-core@^4.0.3` → `outdated`/`audit` verts. MIT. Échappement correct. |
| Validation F6 | **aucune** (structurelle en code) | **Aucun XSD DGFiP F6** (D3) ; schéma UN/CEFACT CDAR non vendorisé, aucun fetch. Validation structurelle `node:*`/regex. |
| Files / scheduler | **BullMQ 5.80.x** (déjà présent) | File dédiée `cdv-transmission` + jobs répétables `maintenance`. |
| Dates / IO / hash | `node:*` natifs | Fenêtre bornée (Date UTC), écriture write-once, `trackingRef` SHA-256, horodate AAAAMMJJHHMMSS. |

> **Gate** : `pnpm run audit:ci` = 0 et `pnpm outdated -r` **vierge**. Vérifier à **chaque** tâche (un patch amont peut sortir en cours de plan — leçons 2.2/2.3/2.4). Overrides existants inchangés.

---

## Points de risque signalés d'emblée

1. **Table DAG = interprétation.** Seules les 4 corrections sont "dures" ; le reste des arêtes est défendable mais non normé. **Traité** : D1, bannière en tête, paramétrisation (AFNOR = table + tests seuls), 4 anomalies verrouillées par test.
2. **Tests monotones existants à INVERSER.** `lifecycle-status.test.ts` (1.1) asserte le monotone (`212→213` vrai, `207→205` faux). **Traité** : Task 1 Step RED **réécrit** ces vecteurs aux attentes DAG → échec contre l'impl monotone → implémentation DAG (vrai cycle RED/GREEN, pas un ajout).
3. **Aucun XSD F6.** **Traité** : D3, validation structurelle honnête (posture PAF), pas d'XSD pretendu, pas de schéma externe vendorisé.
4. **Namespaces CDAR `rsm:/ram:/udt:`.** Contrairement aux instances annuaire/e-reporting **sans** préfixe, le CDAR **est** un vocabulaire à namespaces. **Traité** : `xmlbuilder2` pose les déclarations `xmlns:rsm/ram/udt` (mapping Annexe 2) ; golden capté ; validation structurelle par présence de chemins (`ProcessConditionCode`, `IssueDateTime`), pas par un XSD.
5. **jobId BullMQ.** `:` interdit (2.4-T9). **Traité** : D8, séparateur `-`.
6. **Deadlock slot × terminal.** **Traité** : D8, `parked` non terminal retryé en place ; seuls les échecs permanents sont terminaux.
7. **Migration 0021 sur table non vide.** `cdv_transmissions` est **neuve** (aucun backfill) → aucun risque type 2.2-0011. **Traité** : table vierge.
8. **Transport réel absent + acks réels absents.** **Traité** : D5 (port + local ; drivers `throw` testés ; frontière ack exercée e2e, source différée).
9. **Date de routage d'un CDV.** Non tranchée par la spec. **Traité** : D6, `issueDate`, marqué interprétation.
10. **Compat matrice ↔ journal scellé.** **Traité** : D1, `verifyTenantChain` ne re-valide pas les transitions ; historique intact ; seul le service échange le garde.

---

## Sources réglementaires vérifiées (dossier `docs/reglementaire/specifications-externes-v3.2/`, lecture seule)

> Vérifiées in situ (arbre XSD listé — **aucun XSD F6** ; Annexe 2 V2.3 onglet « CDV FE - CI ARM » lu ; Dossier §3.6.4-3.6.6/§2.3.10/cartographie p.19 cités ; `invoice-core` inventorié — **aucun code F6**). Provenance tracée pour chaque affirmation.

- **§3.6.4 Tableau 8 (p.58-59)** — 14 statuts facture 200-213 ; **obligatoires = 200 Déposée, 210 Refusée, 212 Encaissée, 213 Rejetée** ; facultatifs = les 10 autres. Verbatim : « Les statuts possibles (**liste non exhaustive, voir norme AFNOR XP Z12-012**) d'un cycle de vie sont : » ; « les statuts obligatoires … sont transmis à l'administration fiscale dans le format structuré **CDAR** » ; « statuts facultatifs qui **ne doivent pas être transmis à l'administration fiscale** » ; note « Refusée / Rejetée → **annulation comptable (avoir interne)**, ne génère pas de flux F1 ». (212 → CGI art. 290 A ; 213 = anomalie fonctionnelle détectée par contrôle PAE/PAR.)
- **§3.6.5 (p.60)** — « les PAE les adressent au PPF **dans un délai de 24h à compter de l'émission du cycle de vie du statut « Déposée »** … ». **§3.6.6 (p.60)** — « les plateformes agréées (PAE ou PAR) les adressent au PPF **dans un délai de 24h à compter de l'horodatage du statut** … » (le compteur F6 part de l'**horodatage du statut** = MDT-78).
- **§2.3.10 (p.16-17)** — Peppol = « **infrastructure d'interopérabilité complémentaire** » ; « Dans le cas où **deux plateformes agréées ne parviendraient pas à assurer leur interopérabilité** … **les plateformes devront recourir à ce protocole** » (repli, projet art. 242 nonies I annexe II CGI).
- **Cartographie flux (p.19)** — « **F6 : Flux de cycle de vie, au format syntaxique CDAR** … transmis par le fournisseur à la PAE ; transmis par l'acheteur à la PAR ; **généré par les plateformes (PAE ou PAR)**. **Toute plateforme (PAE ou PAR) a l'obligation de transmettre au PPF les statuts obligatoires** … Le PPF contrôle puis transmet à l'administration fiscale. Le PPF émet également des cycles de vie … » ; footnote 102 : « format CDAR … **UN/CEFACT SCRDM CI Cross Domain Application Response message** ».
- **Annexe 2 V2.3** — `2- Annexes_v3.2/20260430_Annexe 2 - Format sémantique FE CDV - Flux 6 - V2.3.xlsx` : onglet **« Statuts »** (objet « message CDV (Flux 6) » → **601 Rejeté**) ; onglet **« CDV FE - CI ARM »** (mapping CDAR : **MDT-105** ProcessConditionCode = code statut ; **MDT-87** IssuerAssignedID = n° facture/id flux ; **MDT-78** AcknowledgementDocument/IssueDateTime (AAAAMMJJHHMMSS) ; **MDT-8** ExchangedDocument/IssueDateTime `@format=204` ; **MDT-3** profil ; **MDT-126** IncludedNote/Content = motif ; parties `ram:GlobalID @schemeID` **ICD 6523** : `0002` SIREN / `0009` SIRET / `0224` routage / `0238` matricule PDP-PPF).
- **AUCUN XSD DGFiP pour F6/CDV** (`3- XSD_v3.2/` = Annuaire + E-reporting + E-invoicing seulement ; `Changelog_XSD.md` n'énumère que ces 3 familles) ; **aucun code F6/CDV/CDAR dans `packages/invoice-core`** (seul `flux/generate-extract.ts` = extrait fiscal F1). **Code interface `FFE0614A`** : **introuvable** dans Annexe 2 / Dossier → **à confirmer** avant prod, non contraignant ici.

---

## Structure des fichiers (vue d'ensemble)

```
apps/api/
  package.json                               # INCHANGÉ (xmlbuilder2 déjà présent)
  src/
    config/env.ts                            # + CDV_TRANSMISSION_DRIVER, CDV_LOCAL_DIR, CDV_SWEEP_EVERY_MS,
                                             #   CDV_TRANSMISSION_LOOKBACK_MS, CDV_TRANSMISSION_JOB_ATTEMPTS,
                                             #   CDV_STUCK_RETRY_EVERY_MS, CDV_PA_MATRICULE
    invoices/
      lifecycle-status.ts                    # MODIFIÉ : matrice DAG data-driven (Task 1)
    cdv/
      flux6-cdar.ts                          # PUR : generateFlux6Cdar + validateFlux6Structure (Task 2)
      cdv-transmission-lifecycle.ts          # PUR : prepared/transmitted/parked/acknowledged/rejected(601) (Task 3)
      cdv-deadline.ts                        # PUR : dueSince(now, lookbackMs) + isPastDeadline (Task 7, testé Task 7)
      cdv-transmission.repository.ts          # suivi + journal sous RLS ; insertTransmission idempotent (Task 4)
      cdv-transmission.port.ts               # port + token + erreurs (Task 5)
      local-filesystem-cdv-store.ts          # impl write-once locale (Task 5)
      cdv-transmission.module.ts             # @Global factory selon CDV_TRANSMISSION_DRIVER (Task 5)
      cdv-transmission.service.ts            # orchestration : maille buyer → resolveRecipient → F6 → transmit (Task 6)
      cdv-status.service.ts                  # frontière ack 601/implicite (Task 8)
      cdv.controller.ts                      # endpoints dual-auth (Task 8)
      cdv.module.ts                          # câblage API (Task 6/8)
    db/
      schema.ts                              # + enum cdvTransmissionStatus + tables cdv_transmissions/_events
      migrations/
        0021_cdv_transmissions.sql           # (drizzle) enum + 2 tables + index (Task 4)
        0022_cdv_rls.sql                     # (hand) RLS FORCE + grants + SD find_cdv_transmissions_due (Task 4)
        meta/_journal.json                   # + 0021/0022 (0022 ajouté manuellement)
    worker/
      cdv-transmission-sweep.service.ts      # énumère les statuts obligatoires dus (SD, fenêtre bornée) (Task 7)
      cdv-stuck-retry.service.ts             # reprise des transmissions 'parked' (Task 7)
      cdv-transmission.scheduler.ts          # upsertJobScheduler sweep + stuck-retry (Task 7)
      cdv-transmission.processor.ts          # @Processor(CDV_TRANSMISSION_QUEUE) (Task 7)
      maintenance.processor.ts               # + branches CDV_TRANSMISSION_SWEEP_JOB / CDV_STUCK_RETRY_JOB (Task 7)
      worker.module.ts                       # + providers cdv (Task 7)
    queue/
      queue.constants.ts                     # + CDV_TRANSMISSION_QUEUE (Task 7)
      maintenance.job.ts                     # + CDV_TRANSMISSION_SWEEP_JOB / CDV_STUCK_RETRY_JOB (Task 7)
      cdv-transmission.job.ts                # payload minimal { tenantId, invoiceId, toStatus, target } (Task 7)
  tests/
    unit/
      lifecycle-status.test.ts               # MODIFIÉ : DAG + 4 anomalies verrouillées (Task 1)
      flux6-cdar.test.ts                     # golden + validité structurelle + injection-proof (Task 2)
      cdv-transmission-lifecycle.test.ts     # transitions + motif + terminaux (Task 3)
      cdv-deadline.test.ts                   # fenêtre bornée + échéance 24h (Task 7)
      local-filesystem-cdv-store.test.ts     # write-once + traversée + déterminisme (Task 5)
      env.test.ts                            # (MODIFIÉ) cas CDV_* (Task 5)
    e2e/
      cdv-transmission-persistence.e2e.test.ts  # RLS/isolation/append-only/slot idempotent (Task 4)
      cdv-transmission.e2e.test.ts           # routage → F6 → transmit → ack (601/impl), parked, isolation (Task 6/8)
      cdv-transmission-sweep.e2e.test.ts     # borné/idempotent/3-couches, stuck-retry (Task 7)
```

Fichiers hors `apps/api` : `README.md` racine + `apps/api/README.md` (CDV/matrice/`CDV_*`/différés), `.github/workflows/ci.yml` inchangé.

---

### Task 1 : Remplacer la matrice CDV monotone par une machine DAG data-driven (module pur)

**Files:**
- Modify: `apps/api/src/invoices/lifecycle-status.ts`
- Modify: `apps/api/tests/unit/lifecycle-status.test.ts`

**Interfaces:**
- Consumes : rien (module pur autoportant).
- Produces (INCHANGÉES — signatures préservées, seule l'implémentation change) : `STATUS_META`, `LifecycleStatus`, `LIFECYCLE_STATUSES`, `INITIAL_STATUS`, `TERMINAL_STATUSES`, `isLifecycleStatus`, `isTerminal`, `requiresReason`, `statusByCode`, `canTransition`, `assertTransition`, `InvalidLifecycleTransitionError`. **Nouveau (interne, exporté pour test)** : `ALLOWED_TRANSITIONS: Record<LifecycleStatus, LifecycleStatus[]>`.

> **CONTRAT DE COMPAT (D1)** : signatures publiques **inchangées** → `LifecycleService`/`InvoicesController`/`recordTransition`/journal scellé (2.2) **intacts, aucun autre fichier modifié**. Seuls la table + les tests changent (paramétrisation AFNOR).

- [ ] **Step 1 : Tests (RED) — INVERSER le monotone, verrouiller les 4 anomalies + la structure DAG**

Réécrire `lifecycle-status.test.ts` : remplacer les assertions monotones par les attentes DAG. Vecteurs clés :
```ts
import { describe, expect, it } from 'vitest'
import {
  ALLOWED_TRANSITIONS, assertTransition, canTransition,
  InvalidLifecycleTransitionError, isTerminal, requiresReason,
} from '../../src/invoices/lifecycle-status.js'

describe('matrice CDV DAG (INTERPRÉTATION PROJET / AFNOR XP Z12-012 ; §3.6.4 Tableau 8)', () => {
  it('CORRIGE les 4 anomalies du monotone (BLOQUEUR 2.1)', () => {
    // interdit 212→213 (encaissée terminale — chemin heureux clos)
    expect(canTransition('encaissee', 'rejetee')).toBe(false)
    // autorise les retours légitimes que le monotone rejetait
    expect(canTransition('en_litige', 'approuvee')).toBe(true)              // 207→205
    expect(canTransition('suspendue', 'prise_en_charge')).toBe(true)       // 208→204
    expect(canTransition('approuvee_partiellement', 'approuvee')).toBe(true) // 206→205
  })
  it('terminaux = {refusee(210), encaissee(212), rejetee(213)} — aucune sortie', () => {
    for (const t of ['refusee', 'encaissee', 'rejetee'] as const) {
      expect(isTerminal(t)).toBe(true)
      expect(ALLOWED_TRANSITIONS[t]).toEqual([])
    }
  })
  it('backbone chronologique préservé (dépôt → traitement → approbation → paiement)', () => {
    expect(canTransition('deposee', 'prise_en_charge')).toBe(true)   // saut de facultatifs
    expect(canTransition('prise_en_charge', 'approuvee')).toBe(true)
    expect(canTransition('completee', 'encaissee')).toBe(true)
    expect(canTransition('deposee', 'rejetee')).toBe(true)           // contrôle au dépôt
  })
  it('interdit les transitions absurdes (garde Object.hasOwn, aucune traversée prototype)', () => {
    expect(canTransition('encaissee', 'deposee')).toBe(false)        // retour arrière depuis terminal
    expect(() => assertTransition('encaissee', 'rejetee')).toThrow(InvalidLifecycleTransitionError)
    // @ts-expect-error entrée non fiable
    expect(canTransition('toString', 'deposee')).toBe(false)
  })
  it('motif requis inchangé (G7.25) : refusee & suspendue', () => {
    expect(requiresReason('refusee')).toBe(true)
    expect(requiresReason('suspendue')).toBe(true)
    expect(requiresReason('approuvee')).toBe(false)
  })
})
```
Run: `pnpm --filter @factelec/api test -- lifecycle-status` → **RED** (l'impl monotone actuelle asserte l'inverse : `212→213` vrai, `207→205` faux).

- [ ] **Step 2 : Implémentation (GREEN)** — réécrire `lifecycle-status.ts` : garder `STATUS_META`/types/`statusByCode`/`isLifecycleStatus` (Object.hasOwn) ; remplacer le monotone par la table DAG **paramétrée** :
```ts
// Table PROPOSÉE (INTERPRÉTATION PROJET — voir bannière). Backbone = chronologie
// documentée §3.6.4 + 4 CORRECTIONS mandatées (ledger 2.1). Acquérir AFNOR XP
// Z12-012 ne change QUE cette table + REASON_REQUIRED + les vecteurs de test.
export const ALLOWED_TRANSITIONS: Record<LifecycleStatus, LifecycleStatus[]> = {
  deposee: ['emise', 'recue', 'mise_a_disposition', 'prise_en_charge', 'refusee', 'rejetee'],
  emise: ['recue', 'mise_a_disposition', 'prise_en_charge', 'refusee', 'rejetee'],
  recue: ['mise_a_disposition', 'prise_en_charge', 'refusee', 'rejetee'],
  mise_a_disposition: ['prise_en_charge', 'refusee', 'rejetee'],
  prise_en_charge: ['approuvee', 'approuvee_partiellement', 'en_litige', 'suspendue', 'completee', 'refusee', 'rejetee'],
  approuvee: ['completee', 'paiement_transmis', 'en_litige', 'refusee'],
  approuvee_partiellement: ['approuvee', 'en_litige', 'suspendue', 'completee', 'refusee', 'rejetee'], // 206→205
  en_litige: ['approuvee', 'approuvee_partiellement', 'prise_en_charge', 'suspendue', 'refusee'],       // 207→205
  suspendue: ['prise_en_charge', 'approuvee', 'approuvee_partiellement', 'en_litige', 'refusee'],       // 208→204
  completee: ['paiement_transmis', 'encaissee', 'refusee'],
  paiement_transmis: ['encaissee'],
  refusee: [],   // terminal (avoir interne)
  encaissee: [], // terminal (CGI 290 A) → 212→213 INTERDIT
  rejetee: [],   // terminal (anomalie fonctionnelle)
}
export const TERMINAL_STATUSES = new Set<LifecycleStatus>(['refusee', 'encaissee', 'rejetee'])
export function canTransition(from: LifecycleStatus, to: LifecycleStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to)
}
```
`REASON_REQUIRED` inchangé (`{refusee, suspendue}`, G7.25). **Réécrire la bannière d'en-tête** : remplacer le bloc « chronologie monotone » + « A7 (212→213 autorisé) » par le bloc **DAG / INTERPRÉTATION PROJET / AFNOR XP Z12-012 / 4 corrections / paramétrisation / compat journal scellé** (citer §3.6.4 Tableau 8, le renvoi AFNOR, le ledger 2.1).

- [ ] **Step 3 : Gate + commit** (vérifier qu'AUCUN autre fichier ne casse — la suite invoices/ledger doit rester verte, preuve de compat)
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): matrice de cycle de vie CDV data-driven (DAG) remplaçant le monotone, 4 anomalies corrigées"
```
Expected: PASS, couverture module pur 100 %, suite invoices/ledger (2.1/2.2) intacte (compat prouvée).

---

### Task 2 : Génération Flux 6 / CDAR (module pur, validation structurelle)

**Files:**
- Create: `apps/api/src/cdv/flux6-cdar.ts`
- Create: `apps/api/tests/unit/flux6-cdar.test.ts`

**Interfaces:**
- Consumes : Task 1 (`STATUS_META`/`statusByCode` pour le code numérique) ; `xmlbuilder2` (déjà présent).
- Produces (Tasks 5-6-7) : `generateFlux6Cdar(msg): string` (`rsm:CrossIndustryApplicationResponse` XSD-absent, mapping Annexe 2 V2.3) ; `validateFlux6Structure(xml): { valid: boolean; errors: string }` (structurelle en code) ; type `Flux6Message` (`{ senderMatricule, invoiceRef, statusCode, statusHorodate, messageHorodate, motif?, issuer?, recipient? }`).

- [ ] **Step 1 : Tests (RED)** — `flux6-cdar.test.ts` :
```ts
import { describe, expect, it } from 'vitest'
import { generateFlux6Cdar, validateFlux6Structure } from '../../src/cdv/flux6-cdar.js'

const base = {
  senderMatricule: '0000', invoiceRef: 'FAC-2026-0001',
  statusCode: 213, statusHorodate: '20260905143000', messageHorodate: '20260905143005',
  motif: 'Anomalie fonctionnelle détectée au contrôle', issuer: '123456789', recipient: '987654321',
}

describe('generateFlux6Cdar (Annexe 2 V2.3 « CDV FE - CI ARM », UN/CEFACT SCRDM CI)', () => {
  it('émet un CrossIndustryApplicationResponse structurellement valide', () => {
    const xml = generateFlux6Cdar(base)
    expect(xml).toContain('rsm:CrossIndustryApplicationResponse')
    expect(xml).toContain('<ram:ProcessConditionCode>213</ram:ProcessConditionCode>')   // MDT-105
    expect(xml).toContain('<ram:IssuerAssignedID>FAC-2026-0001</ram:IssuerAssignedID>')  // MDT-87
    expect(xml).toContain('20260905143000')                                              // MDT-78 horodate statut
    expect(xml).toContain('schemeID="0002"')                                             // ICD 6523 SIREN
    const { valid, errors } = validateFlux6Structure(xml)
    expect(errors).toBe('')
    expect(valid).toBe(true)
  })
  it('rejette un code de statut hors Tableau 8', () => {
    expect(() => generateFlux6Cdar({ ...base, statusCode: 999 })).toThrow()
  })
  it('rejette un horodate mal formé (≠ AAAAMMJJHHMMSS)', () => {
    expect(() => generateFlux6Cdar({ ...base, statusHorodate: '2026-09-05' })).toThrow()
  })
  it('échappe les caractères XML dangereux du motif (injection-proof)', () => {
    const xml = generateFlux6Cdar({ ...base, motif: 'A & <B>' })
    expect(xml).toContain('A &amp; &lt;B&gt;')
  })
  it('validateFlux6Structure détecte un ProcessConditionCode manquant', () => {
    expect(validateFlux6Structure('<rsm:CrossIndustryApplicationResponse/>').valid).toBe(false)
  })
})
```
Run: `pnpm --filter @factelec/api test -- flux6-cdar` → RED (module absent).

- [ ] **Step 2 : Implémentation (GREEN)** — `flux6-cdar.ts` : `create({ version:'1.0', encoding:'UTF-8' }).ele('rsm:CrossIndustryApplicationResponse', { 'xmlns:rsm': ..., 'xmlns:ram': ..., 'xmlns:udt': ... })` (URN UN/CEFACT SCRDM CI ARM, mapping Annexe 2) → `rsm:ExchangedDocumentContext` (MDT-3 profil) → `rsm:ExchangedDocument` (MDT-8 IssueDateTime `@format=204`) → `rsm:AcknowledgementDocument` (MDT-78 IssueDateTime, `ram:ReferenceReferencedDocument` : MDT-87 IssuerAssignedID + MDT-105 ProcessConditionCode + `ram:SpecifiedDocumentStatus/ram:IncludedNote/ram:Content` MDT-126 motif ; parties `ram:SenderTradeParty`/`IssuerTradeParty`/`RecipientTradeParty` avec `ram:GlobalID @schemeID` ICD 6523 — `0238` sender, `0002` SIREN issuer/recipient). **Gardes d'entrée** : `statusByCode(statusCode)` non nul (Task 1), `HORODATE_RE = /^[0-9]{14}$/` sur les 2 horodates, sinon `throw`. `xmlbuilder2` échappe `&`/`<`/`>` par construction. `validateFlux6Structure` : présence des chemins obligatoires (`ProcessConditionCode`, `IssuerAssignedID`, les 2 `IssueDateTime`), code ∈ Tableau 8, horodates `^[0-9]{14}$`, `@schemeID` ∈ `{0002,0009,0224,0238}` — **posture PAF honnête** (bannière : pas de XSD DGFiP, validation structurelle projet).

- [ ] **Step 3 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test && pnpm run audit:ci && pnpm outdated -r
git add -A
git commit -m "feat(api): génération Flux 6 (message CDV au format CDAR UN/CEFACT) et validation structurelle"
```
Expected: PASS, module pur 100 %, audit 0, outdated vierge.

---

### Task 3 : Machine de livraison CDV (module pur, DISTINCTE)

**Files:**
- Create: `apps/api/src/cdv/cdv-transmission-lifecycle.ts`
- Create: `apps/api/tests/unit/cdv-transmission-lifecycle.test.ts`

**Interfaces:**
- Consumes : rien.
- Produces (Tasks 4-6-8) : `CDV_TRANSMISSION_STATUS_META` (`prepared`/`transmitted`/`parked`/`acknowledged`/`rejected`), `canTransition`, `isTerminal`, `motifRequired`, `assertTransition`, `CdvTransmissionStatus`, `InvalidCdvTransmissionTransitionError`.

> **Miroir structurel de `ereporting-lifecycle.ts` mais SÉPARÉ (D4).** `rejected` porte le **code RÉEL 601** (Annexe 2 « message CDV rejeté ») ; les autres = `code: null` (aucun code inventé, leçon 2.3-A3). `parked` = NON terminal (retry). Motif de rejet = chaîne libre (MDT-126).

- [ ] **Step 1 : Tests (RED)** — calquer `ereporting-lifecycle.test.ts` : `canTransition('prepared','transmitted')`, `('prepared','parked')`, `('prepared','rejected')`, `('transmitted','acknowledged')`, `('transmitted','rejected')`, `('parked','transmitted')`, `('parked','rejected')` **vrais** ; `isTerminal('acknowledged')`/`isTerminal('rejected')` **vrais**, `isTerminal('parked')` **faux** ; `motifRequired('rejected')` vrai / `motifRequired('acknowledged')` faux ; `CDV_TRANSMISSION_STATUS_META.rejected.code === 601` ; `assertTransition('acknowledged','transmitted')` **lève**.

- [ ] **Step 2 : Implémentation (GREEN)** — calquer `ereporting-lifecycle.ts` : `ALLOWED = { prepared:['transmitted','parked','rejected'], transmitted:['acknowledged','rejected'], parked:['transmitted','rejected'], acknowledged:[], rejected:[] }`, `TERMINAL = new Set(['acknowledged','rejected'])`, `META` avec `rejected.code = 601` sinon `null` (`satisfies Record<Status,{code:number|null;label:string}>`), `motifRequired = (s) => s === 'rejected'`, `Object.hasOwn`, erreur typée. Bannière **D4** (distinct CDV facture / e-reporting / annuaire ; non scellé ; 601 réel ; parked retryable).

- [ ] **Step 3 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): machine de livraison des CDV (prepared→transmitted→acquittée/rejetée 601, parked retry)"
```

---

### Task 4 : Persistance — transmissions & journal (RLS `FORCE`, SD, slot idempotent)

**Files:**
- Modify: `apps/api/src/db/schema.ts` (enum + 2 tables)
- Create: `apps/api/src/db/migrations/0021_cdv_transmissions.sql` (drizzle) + snapshot + `_journal`
- Create: `apps/api/src/db/migrations/0022_cdv_rls.sql` (hand : RLS/grants + SD `find_cdv_transmissions_due`)
- Create: `apps/api/src/cdv/cdv-transmission.repository.ts`
- Create: `apps/api/tests/e2e/cdv-transmission-persistence.e2e.test.ts`

**Interfaces:**
- Consumes : Tasks 1-3, `TenantContextService` (`runInTenant`).
- Produces (Tasks 6-7-8) : tables `cdv_transmissions`/`cdv_transmission_events` sous RLS `FORCE` ; SD cross-tenant `find_cdv_transmissions_due(p_since)` ; repository (`insertTransmission` idempotent [+ événement `prepared`], `markTransmitted`, `markParked`, `appendStatusEvent`, `findTransmission`, `listTransmissions`, `listStatusEvents`, `findResumable`).

- [ ] **Step 1 : Schéma (enum + tables)** — `schema.ts`, calquer les idiomes `ereporting_transmissions`/`_status_events` :
  - Enum `cdvTransmissionStatus` (`prepared`/`transmitted`/`parked`/`acknowledged`/`rejected`, aligné `CDV_TRANSMISSION_STATUS_META`) ; enum `cdvTarget` (`ppf`/`recipient`).
  - `cdv_transmissions` : `tenantId`, `invoiceId uuid FK invoices restrict`, `toStatus invoiceLifecycleStatus` (le statut CDV transmis — 200/210/212/213), `target cdvTarget`, `status cdvTransmissionStatus default 'prepared'`, `recipientMatricule text?` (résolu annuaire, cible recipient), `trackingRef text?`, `xml text?`, `rejectReason text?` (MDT-126, code 601), `statusHorodate text` (AAAAMMJJHHMMSS, pour l'échéance 24h), `createdAt`/`updatedAt`. **Index unique idempotent** `(invoiceId, toStatus, target)` (backstop anti-double-envoi, D8 ; **couvre TOUS les statuts** — une ligne par (facture, statut, cible), qui progresse). Index `(tenantId, createdAt)`.
  - `cdv_transmission_events` (journal append-only, NON scellé) : `tenantId`, `transmissionId uuid FK restrict`, `fromStatus cdvTransmissionStatus?`, `toStatus cdvTransmissionStatus`, `motif text?`, `actor text` (`platform`/`ppf`/`recipient`), `createdAt`. Index `(transmissionId, createdAt)`.

- [ ] **Step 2 : Migration drizzle (0021)** — `db:generate` → renommer `0021_cdv_transmissions.sql`, tag idx 21. Relire : `CREATE TYPE` des 2 enums + `CREATE TABLE` des 2 tables + index unique `(invoice_id, to_status, target)` + FK restrict. Aucune RLS/grant (migration 0022). Table **neuve** → aucun risque backfill (contraste 2.2-0011).

- [ ] **Step 3 : Migration manuelle RLS/grants + SD (0022)** — calquer `0017_ereporting_rls.sql` :
  - RLS `ENABLE`+`FORCE` + policy `tenant_isolation` (`nullif(current_setting('app.tenant_id',true),'')::uuid`) sur **les 2 tables**.
  - Grants : `cdv_transmissions` = `SELECT, INSERT, UPDATE` (statut/tracking/xml, pas de DELETE) ; `cdv_transmission_events` = `SELECT, INSERT` **seulement** (append-only par grants, 42501 sur UPDATE/DELETE).
  - SD `find_cdv_transmissions_due(p_since timestamptz)` `RETURNS TABLE(tenant_id uuid, invoice_id uuid, to_status public.invoice_lifecycle_status, status_created_at timestamptz)` `LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp STABLE` → `SELECT e.tenant_id, e.invoice_id, e.to_status, e.created_at FROM public.invoice_status_events e WHERE e.to_status IN ('deposee','refusee','encaissee','rejetee') AND e.created_at >= p_since ORDER BY e.tenant_id, e.created_at` (statuts **obligatoires** seuls, D7 ; **fenêtre bornée** par `p_since`, D8 ; enum de retour schéma-qualifié) + `REVOKE ALL … FROM PUBLIC` + `GRANT EXECUTE … TO factelec_app`. Commentaire : miroir `find_ereporting_declarants_due` ; **lecture seule** du journal scellé 2.2 (jamais de re-scellement).
  - Enregistrer 0022 dans `meta/_journal.json` (idx 22, `version:"7"`, `when` epoch-ms, `tag:"0022_cdv_rls"`, `breakpoints:true`, **sans** snapshot — comme 0015/0017/0019).

- [ ] **Step 4 : Repository** — mêmes idiomes que `EreportingRepository` :
  - `insertTransmission(tenantId, {invoiceId, toStatus, target, statusHorodate, xml?, recipientMatricule?})` : `ON CONFLICT (invoice_id, to_status, target) DO NOTHING` + reload → `{ id, created }` (`created:false` → le worker resume/skip, miroir `insertTransmission` 2.3) ; sur INSERT, événement genèse `prepared` (from=NULL, actor='platform') **même transaction**.
  - `markTransmitted(id, trackingRef)` (CAS `prepared|parked`→`transmitted` + trackingRef + journal, miroir `markTransmitted`).
  - `markParked(id, motif?)` (CAS `prepared`→`parked` + journal ; NON terminal).
  - `appendStatusEvent(id, from, to, actor, motif?)` (CAS générique `assertTransition`+`motifRequired`, miroir `EreportingRepository.appendStatusEvent` ; sur `rejected`, reporte `rejectReason`).
  - `findResumable(tenantId, invoiceId, toStatus, target)` / `listTransmissions` / `listStatusEvents` (lecture RLS).

- [ ] **Step 5 : e2e (RED→GREEN) — isolation, append-only, slot idempotent** — `cdv-transmission-persistence.e2e.test.ts` (motifs 2.2/2.3 : `startTestDb`, `ownerPool`/`appPool` + écouteur `error`) :
```ts
it('isole les transmissions/journal par tenant (RLS FORCE)')                 // A invisible sous B
it("interdit UPDATE/DELETE sur le journal CDV (42501)")                      // append-only
it('find_cdv_transmissions_due voit les événements obligatoires de tous les tenants dans la fenêtre') // SD cross-tenant + p_since borné
it('idempotence de slot : 2e insert (facture,statut,cible) → created:false, 0 doublon') // backstop D8
it('bloque la suppression d’une facture munie d’une transmission (23503)')   // FK restrict
```

- [ ] **Step 6 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): persistance des transmissions CDV (suivi, journal append-only) sous RLS FORCE et SD cross-tenant"
```

---

### Task 5 : `CdvTransmissionPort` + implémentation locale + factory (transport différé)

**Files:**
- Modify: `apps/api/src/config/env.ts` (+ `CDV_*`)
- Create: `apps/api/src/cdv/cdv-transmission.port.ts`, `apps/api/src/cdv/local-filesystem-cdv-store.ts`, `apps/api/src/cdv/cdv-transmission.module.ts`
- Modify: `apps/api/tests/unit/env.test.ts`
- Create: `apps/api/tests/unit/local-filesystem-cdv-store.test.ts`

**Interfaces:**
- Consumes : env config.
- Produces (Tasks 6-7) : `CDV_TRANSMISSION` token + `CdvTransmissionPort` (`transmit(payload): Promise<CdvTransmitResult>`, `status(trackingRef): Promise<CdvAckStatus>`) + `LocalFilesystemCdvStore` + `@Global` factory (`throw` sur `sftp`/`as2`/`as4`/`as4-peppol`/`api`).

- [ ] **Step 1 : Env (RED→GREEN)** — ajouter à `env.ts` (motif `EREPORTING_*`/`ANNUAIRE_*`) :
```ts
  CDV_TRANSMISSION_DRIVER: z.enum(['local', 'sftp', 'as2', 'as4', 'as4-peppol', 'api']).default('local'),
  CDV_LOCAL_DIR: z.string().default('./var/cdv'),
  CDV_SWEEP_EVERY_MS: z.coerce.number().int().positive().default(3_600_000),            // horaire (≪ 24h)
  CDV_TRANSMISSION_LOOKBACK_MS: z.coerce.number().int().positive().default(172_800_000), // 48h bornée (2× SLA)
  CDV_TRANSMISSION_JOB_ATTEMPTS: z.coerce.number().int().positive().max(10).default(3),
  CDV_STUCK_RETRY_EVERY_MS: z.coerce.number().int().positive().default(300_000),         // reprise 'parked'
  CDV_PA_MATRICULE: z.string().default('0000'),                                          // ICD 0238, matricule PA (déploiement)
```
`env.test.ts` : défauts + override driver.

- [ ] **Step 2 : Port + impl locale (miroir `flux10-transmission.port.ts` / `LocalFilesystemTransmissionStore`)** — `cdv-transmission.port.ts` : token `Symbol('CDV_TRANSMISSION')`, `CdvTransmitPayload{ tenantId, invoiceId, toStatus, target, xml }`, `CdvTransmitResult{ trackingRef, location }`, `CdvAckStatus{ trackingRef, outcome: 'pending'|'acknowledged'|'rejected', motif? }`, `CdvTransmissionRejectedError`. `local-filesystem-cdv-store.ts` : `transmit` write-once (clé `${tenantId}/${target}/${invoiceId}-${toStatus}.xml`, `wx`+`chmod 0o444`, `SAFE_KEY`/`normalize`/`..`, `EEXIST`→résultat d'origine — leçon 2.2 d'emblée), `trackingRef=sha256(xml)` ; `status`→`pending`. Tests : write-once (rejeu idempotent), traversée refusée, `trackingRef` déterministe.

- [ ] **Step 3 : Factory `@Global` (miroir `EreportingTransmissionModule`)** — `local`→`LocalFilesystemCdvStore(config.CDV_LOCAL_DIR)` ; sinon `throw new Error("driver de transmission CDV '<x>' activé au déploiement (non fourni en 3.1)")`. Branche `throw` **testée** (factory invoquée `CDV_TRANSMISSION_DRIVER='as4-peppol'` → lève) — une ligne couverte.

- [ ] **Step 4 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test && pnpm run audit:ci && pnpm outdated -r
git add -A
git commit -m "feat(api): port de transmission CDV et implémentation locale write-once (adaptateurs SFTP/AS4/Peppol différés)"
```

---

### Task 6 : Service de transmission + routage annuaire (émission)

**Files:**
- Create: `apps/api/src/cdv/cdv-transmission.service.ts`, `apps/api/src/cdv/cdv.module.ts`
- Modify: `apps/api/src/app.module.ts` (importer `CdvModule`)
- Create: `apps/api/tests/e2e/cdv-transmission.e2e.test.ts` (partagé Task 8)

**Interfaces:**
- Consumes : Task 1 (`STATUS_META`), Task 2 (`generateFlux6Cdar`+`validateFlux6Structure`), Task 3 (machine), Task 4 (repository), Task 5 (port), **`AnnuaireConsultationService.resolveRecipient` (2.4)**, `InvoicesRepository.loadCanonical` (2.1, pour le `buyer`).
- Produces (Task 7-8) : `CdvTransmissionService.transmitStatus(tenantId, invoiceId, toStatus, target, statusHorodate)` (émission au grain (facture, statut, cible)).

- [ ] **Step 1 : Service (GREEN après RED e2e)** — `transmitStatus` :
  1. `insertTransmission(...)` idempotent (`created:false` → resume : si terminal → skip ; si `transmitted` → skip ; si `parked` → ré-essayer la résolution) ;
  2. **cible `recipient`** : dériver la maille du `buyer` de l'`Invoice` canonique (`loadCanonical`) ; `resolveRecipient(tenantId, maille, invoice.issueDate)` (D6) ; `RecipientUnaddressableError`/`AmbiguousResolutionError` → `markParked(id, motif)` (NON terminal, repris Task 7) et **retour** (pas d'appel port) ; sinon `recipientMatricule` renseigné. **Cible `ppf`** : pas de résolution (matricule PPF interne) ;
  3. `generateFlux6Cdar({ senderMatricule: CDV_PA_MATRICULE, invoiceRef: invoice.number, statusCode: STATUS_META[toStatus].code, statusHorodate, messageHorodate: <horodate courant>, issuer/recipient })` **puis `validateFlux6Structure`** → si invalide, **`appendStatusEvent(...,'rejected', actor='platform', motif='f6-invalide')`** (born-rejetée, PAS d'appel port — miroir 2.3-T8) et retour ;
  4. `transmit(payload)` via le port → `markTransmitted(id, trackingRef)` (`prepared|parked`→`transmitted`).
  **Succès partiel au grain (facture × statut × cible)** (D6) : `ppf` et `recipient` progressent indépendamment.

- [ ] **Step 2 : Module + câblage** — `cdv.module.ts` (providers `CdvTransmissionRepository`, `CdvTransmissionService`, `AnnuaireConsultationService`+`AnnuaireRepository` [réutilisés 2.4], `InvoicesRepository`, `CDV_TRANSMISSION` via `CdvTransmissionModule`) ; importer `CdvModule` dans `app.module.ts`.

- [ ] **Step 3 : e2e (RED→GREEN)** — dans `cdv-transmission.e2e.test.ts` :
```ts
it('émet un F6 vers le PPF (prepared→transmitted, XML persisté, trackingRef non nul)')
it('résout le destinataire via l’annuaire (miroir seedé) et émet vers la plateforme de réception')
it('PARKE la cible recipient si le destinataire est non adressable (parked, pas d’appel port)')
it('born-rejette (rejected) un F6 structurellement invalide sans appeler le port')
it('isole les transmissions par tenant (404/absence hors-tenant)')
```

- [ ] **Step 4 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): service de transmission CDV avec routage annuaire (résolution destinataire, F6, parked)"
```

---

### Task 7 : Ordonnanceur borné (24h) + worker + reprise des transmissions figées

**Files:**
- Create: `apps/api/src/cdv/cdv-deadline.ts` + `apps/api/tests/unit/cdv-deadline.test.ts`
- Create: `apps/api/src/worker/cdv-transmission-sweep.service.ts`, `cdv-stuck-retry.service.ts`, `cdv-transmission.scheduler.ts`, `cdv-transmission.processor.ts`
- Modify: `apps/api/src/worker/maintenance.processor.ts`, `apps/api/src/worker/worker.module.ts`
- Modify: `apps/api/src/queue/queue.constants.ts` (+ `CDV_TRANSMISSION_QUEUE`), `apps/api/src/queue/maintenance.job.ts` (+ `CDV_TRANSMISSION_SWEEP_JOB`/`CDV_STUCK_RETRY_JOB`)
- Create: `apps/api/src/queue/cdv-transmission.job.ts`
- Modify: `apps/api/tests/e2e/helpers/worker.ts` (override du port CDV par un stub mémoire)
- Create: `apps/api/tests/e2e/cdv-transmission-sweep.e2e.test.ts`

**Interfaces:**
- Consumes : Task 4 (SD `find_cdv_transmissions_due`, repo), Task 6 (`transmitStatus`), Task 5 (port), BullMQ.
- Produces : job répétable `CDV_TRANSMISSION_SWEEP_JOB` (fenêtre bornée `now - CDV_TRANSMISSION_LOOKBACK_MS`) → sweep énumère les statuts obligatoires dus × 2 cibles → enfile un job `cdv-transmission` par (facture, statut, cible) → worker `transmitStatus` ; job répétable `CDV_STUCK_RETRY_JOB` → reprise des `parked`.

- [ ] **Step 1 : Deadline/fenêtre pure (RED→GREEN)** — `cdv-deadline.ts` : `dueSince(now: Date, lookbackMs): Date` (borne inférieure de la fenêtre) ; `isPastDeadline(statusCreatedAt: Date, now: Date): boolean` (échéance = `+24h`, §3.6.6). Unit : fenêtre bornée déterministe, échéance 24h (avant/pile/après). **Aucun `Date.now()` dans la logique** (now injecté).

- [ ] **Step 2 : Scheduler + sweep + stuck-retry + worker (miroir `EreportingScheduler`/`EreportingSweepService`/`ArchiveRetryService`)**
  - `cdv-transmission.scheduler.ts` : `OnApplicationBootstrap` → `upsertJobScheduler('cdv-transmission-sweep', { every: CDV_SWEEP_EVERY_MS }, { name: CDV_TRANSMISSION_SWEEP_JOB })` **et** `upsertJobScheduler('cdv-stuck-retry', { every: CDV_STUCK_RETRY_EVERY_MS }, { name: CDV_STUCK_RETRY_JOB })` (clés dédiées, coexistent sur `maintenance`).
  - `maintenance.processor.ts` : brancher les deux `job.name` → `cdvSweep.sweep()` / `cdvStuckRetry.retryParked()`.
  - `cdv-transmission-sweep.service.ts` : `SELECT … FROM find_cdv_transmissions_due($1)` (APP_POOL direct, hors contexte tenant — motif `EreportingSweepService` ; `$1 = dueSince(now, CDV_TRANSMISSION_LOOKBACK_MS)`) → pour chaque (event) × `target ∈ {ppf, recipient}`, enfile un job sur `CDV_TRANSMISSION_QUEUE` avec **jobId déterministe** `${invoiceId}-${toStatus}-${target}` (**séparateur `-`, PAS `:`** — leçon 2.4-T9).
  - `cdv-transmission.processor.ts` (`@Processor(CDV_TRANSMISSION_QUEUE)`) : appelle `transmitStatus(...)` (Task 6). Idempotent par construction (insert `created:false` + trackingRef write-once). Retry BullMQ dédié `CDV_TRANSMISSION_JOB_ATTEMPTS` (erreur transport/outillage → retry ; born-rejetée → **jamais** un retry, miroir 2.3-T8).
  - `cdv-stuck-retry.service.ts` : liste les `parked` (bornée, batch) → ré-appelle `transmitStatus` (la résolution annuaire est retentée en place ; si toujours non adressable → reste `parked` ; si résolue → `transmitted`). Miroir `ArchiveRetryService.sweepFailedArchives` (2.2) / stuck-draft (2.4).
  - **3 couches anti-double-envoi** (D8) : (1) fenêtre bornée `p_since`, (2) jobId déterministe `-`, (3) unique DB `(invoiceId, toStatus, target)`.

- [ ] **Step 3 : e2e (RED→GREEN)** — `cdv-transmission-sweep.e2e.test.ts` (Postgres réel + override du port par un **stub CDV en mémoire** dans le helper worker — motif `InMemoryTransmissionSink` 2.3) :
```ts
it('transmet les statuts obligatoires dus vers PPF (1 event obligatoire → 1 transmission PPF)')
it('n’enfile PAS les statuts facultatifs (204/205… hors périmètre)')       // D7
it('est idempotent : re-sweep du même event ne double pas (created:false + jobId + unique DB)') // 3 couches
it('reprend une transmission parked quand l’annuaire devient adressable (parked→transmitted)')
it('respecte la fenêtre bornée (un event hors lookback n’est pas ré-enfilé)') // D8
```

- [ ] **Step 4 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): ordonnanceur borné (24h) et worker de transmission CDV, reprise des transmissions parked"
```

---

### Task 8 : Frontière d'acquittement + endpoints (dual-auth)

**Files:**
- Create: `apps/api/src/cdv/cdv-status.service.ts`, `apps/api/src/cdv/cdv.controller.ts`
- Modify: `apps/api/src/cdv/cdv.module.ts` (+ service, controller)
- Modify: `apps/api/tests/e2e/cdv-transmission.e2e.test.ts` (+ acks, endpoints)

**Interfaces:**
- Consumes : Task 3 (`motifRequired`), Task 4 (repository), guards dual-auth (`TenantAuthGuard`, motif `EreportingController`).
- Produces : `CdvStatusService.recordAck(tenantId, transmissionId, outcome, actor, motif?)` (`transmitted`→`acknowledged`/`rejected` via `assertTransition`+`motifRequired`, CAS 1 txn) ; endpoints `GET /cdv/transmissions?invoiceId=…`, `GET /cdv/transmissions/:id/xml`, `GET /cdv/transmissions/:id/events`.

- [ ] **Step 1 : Service (GREEN après RED e2e)** — `recordAck` : `motifRequired('rejected')` vérifié **avant** toute écriture (422 sans motif) ; CAS `appendStatusEvent(id, 'transmitted', outcome, actor, motif)` (le prédécesseur attendu est TOUJOURS `transmitted` ; stale/terminal → 409 ; miroir `EreportingStatusService.recordPpfStatus` 2.3-T9). **`rejected` = code 601** (Annexe 2) ; **désambiguïsation** `actor` (`ppf`/`recipient`) + `fromStatus` exposés (jamais un 601 ambigu). **La SOURCE réelle (push PPF/réseau) est différée (D5)** : `recordAck` est la **frontière** exercée directement par les e2e (aucune route HTTP n'y accède).

- [ ] **Step 2 : Endpoints (dual-auth)** — `cdv.controller.ts` : `@UseGuards(TenantAuthGuard)`, `@CurrentTenant()` (motif `EreportingController`), zod sur les query params, 404 anti-fuite byte-identique hors-tenant, XML en `text/xml`, événements exposant `actor`+`fromStatus` (désambiguïsation), **codes DGFiP seuls** (601 pour rejected ; `null`/absent pour les états internes — jamais un faux code). Ajouter au `CdvModule`.

- [ ] **Step 3 : e2e (RED→GREEN)** — dans `cdv-transmission.e2e.test.ts` :
```ts
it('applique un acquittement PPF accepté (transmitted→acknowledged)')                     // accept implicite
it('applique un rejet 601 avec motif (transmitted→rejected) ; refuse un rejet sans motif (422)') // MDT-126
it('désambiguïse rejet LOCAL (actor=platform, from=null) vs 601 PPF (actor=ppf, from=transmitted)') // 2.3-T9
it('refuse un acquittement sur une transmission déjà terminale (409)')
it('GET /cdv/transmissions/:id/xml renvoie le F6 ; isolation 404 hors-tenant ; dual-auth clé & session')
```

- [ ] **Step 4 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): frontière d'acquittement CDV (601/accept implicite) et endpoints dual-auth"
```

---

### Task 9 : CI / docs / OpenAPI / bump version — clôture

**Files:**
- Modify: `README.md` racine, `apps/api/README.md`
- Modify: OpenAPI/Swagger (endpoints `cdv/*`)
- Modify: `apps/api/package.json` (`version` → `0.7.0`)

- [ ] **Step 1 : Documentation honnête** — décrire :
  - **Matrice CDV DAG** remplaçant le monotone (D1) : **INTERPRÉTATION PROJET / AFNOR XP Z12-012** (item Xavier) ; **4 anomalies corrigées** (212→213 interdit ; 207→205/208→204/206→205 autorisés) ; **paramétrée** (AFNOR = table + tests seuls) ; **compat** (journal scellé 2.2 intact, historique valide, seul le garde de service change).
  - **Transmission CDV Flux 6** : **CDAR (UN/CEFACT SCRDM CI)** par Annexe 2 V2.3, **AUCUN XSD DGFiP** → **validation structurelle** honnête (posture PAF, contraste 2.3/2.4) ; obligatoires 200/210/212/213 → PPF (§3.6.6) **+ plateforme de réception** (§2.3.10, Peppol en repli) ; **délai 24h** (§3.6.5/6) + interprétation SLA ; **routage** via l'annuaire 2.4 ; **code 601** pour un F6 rejeté.
  - **Différés / port** (D5) : adaptateurs SFTP/AS2/AS4/**AS4-Peppol**/API `throw` (déploiement) ; acks réels (push) différés (frontière livrée) ; streaming des facultatifs & ingestion inbound F6 différés.
  - **Items Xavier (déploiement)** : achat **AFNOR XP Z12-012** ; adhésion **OpenPeppol** + **PKI test/prod** + **SMP** + **stack AS4** ; matricule PA (`CDV_PA_MATRICULE`, ICD 0238) ; confirmation du code interface **FFE0614A** ; éventuelle vendorisation de l'XSD UN/CEFACT CDAR pour une validation `xmllint`.
  - **RUNBOOK** : contrainte unique `(invoice_id, to_status, target)` + sémantique `parked` (retry) vs terminaux ; env `CDV_*` ; pas de deadlock slot × terminal (analyse D8).

- [ ] **Step 2 : Bump version + gate finale + commit**
```bash
# apps/api/package.json : "version": "0.7.0" (phase 3.1 : transmission CDV + matrice DAG)
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm test && pnpm run audit:ci && pnpm outdated -r
git add -A
git commit -m "docs(api): documentation transmission CDV et matrice DAG, bump version 0.7.0"
```
Expected: tout vert ; couverture invoice-core 100 %, apps/api ≥ 90 %×4, apps/web ≥ 90 %×4 ; audit:ci 0 ; outdated vierge.

---

## Self-Review (relecture contre §3.6.4-3.6.6 / §2.3.10 / Annexe 2 V2.3 / cartographie F6 et le cadrage 3.1)

**1. Couverture du cadrage :**
- Matrice monotone → DAG data-driven, 4 anomalies corrigées, paramétrée, compat journal scellé → Task 1 (D1). ✅
- F6 = CDAR (Annexe 2 V2.3, UN/CEFACT SCRDM CI), **aucun XSD** → validation structurelle honnête → Task 2 (D3). ✅
- Machine de livraison DISTINCTE, code 601 réel, journal append-only non scellé → Tasks 3/4 (D4). ✅
- Transmission PPF (obligatoires, 24h borné) + destinataire via annuaire 2.4 → Tasks 6/7 (D6/D7). ✅
- Port différé (contrat + local testable ; SFTP/AS2/AS4/**Peppol**/API `throw` testés) → Task 5 (D5). ✅
- 3 couches anti-double-envoi + pas de deadlock slot × terminal (parked retry) → Tasks 4/7 (D8). ✅
- Frontière d'acquittement (601/implicite, désambiguïsation) ; acks réels différés → Task 8 (D4/D5). ✅
- RLS FORCE + moindre privilège + SD `search_path=pg_catalog,pg_temp` schéma-qualifié + append-only → Task 4. ✅
- Réutilisation (Invoice buyer, journal scellé 2.2 lecture seule, annuaire 2.4, BullMQ, drizzle/RLS/SD, dual-auth) → D9. ✅
- Aucune dette dépendances (aucun ajout — xmlbuilder2/node réutilisés) → Tasks 2/5/9. ✅

**2. Anomalies & corrections (rien d'inventé au-delà des 4 mandatées) :**
- `212→213` **interdit** via `encaissee` TERMINAL (CGI 290 A) ; `207→205`, `208→204`, `206→205` **autorisés** explicitement. Le reste du DAG = interprétation défendable (chronologie), **bannière** + paramétrisation.

**3. Interprétations marquées go-live (jamais fabriquées) :** table DAG entière (AFNOR XP Z12-012, D1) ; format F6 CDAR sans XSD DGFiP → structurel (D3) ; code 601 = seul code F6 fourni, accept implicite (D4) ; date de routage = `issueDate` (D6) ; SLA 24h/ack Peppol (D7) ; motif de rejet chaîne libre MDT-126 (D4) ; matricule PA `CDV_PA_MATRICULE` (déploiement) ; `FFE0614A` à confirmer.

**4. Cohérence des types & migrations :** `LifecycleStatus` partagé Tasks 1-2-4-6-7 ; `CdvTransmissionStatus` partagé Tasks 3-4-8 ; enums Drizzle (`cdv_transmission_status`, `cdv_target`) alignés `CDV_TRANSMISSION_STATUS_META` ; port `CdvTransmissionPort`/`CDV_TRANSMISSION` cohérent impl locale ↔ factory ↔ service ↔ worker ; migrations **0021 (drizzle) → 0022 (hand)** contiguës après 0020 ; SD `find_cdv_transmissions_due` calquée sur `find_ereporting_declarants_due`, **lecture seule** du journal scellé 2.2.

## Amendements possibles à l'exécution (à valider empiriquement)

- **A1** — **Namespaces CDAR** : URN exacts UN/CEFACT SCRDM CI ARM (`urn:un:unece:uncefact:data:standard:CrossIndustryApplicationResponse:…`) — capter depuis l'en-tête de l'Annexe 2 (onglet CI ARM) ; si l'ordre/les préfixes divergent, ajuster jusqu'à la validité structurelle (golden après vert). La validation étant structurelle (pas d'XSD), la sentinelle est le jeu d'assertions de présence de chemins.
- **A2** — **Override du port CDV dans le worker e2e** : propager `CDV_TRANSMISSION` dans `WorkerModule` (helper `worker.ts`), même mécanique que l'override `FLUX10_TRANSMISSION`/`ANNUAIRE_TRANSPORT` (2.3/2.4).
- **A3** — **SD paramétrée** : `find_cdv_transmissions_due(p_since timestamptz)` prend la borne de fenêtre en argument (calculée par `cdv-deadline.ts`, injectée par le sweep — aucun `now()` caché dans la logique pure). Vérifier que le rôle app n'a l'EXECUTE que sur cette signature.
- **A4** — **Résolution de la cible `recipient`** : la maille dérive du `buyer` de l'`Invoice` canonique ; confirmer les champs (SIREN/SIRET) et normaliser `''`→`undefined` aux frontières (leçon 2.4-T5#1 : `coversTarget`/`mailleKey` distinguent absence et chaîne vide).
- **A5** — **jobId** : séparateur `-` (jamais `:`) — vérifier `validateOptions` de la version BullMQ courante (leçon 2.4-T9).
- **A6** — **Deadline 24h** : `isPastDeadline` alimente un **drapeau** journalisé (pas un rejet) ; la mécanique exacte (UTC vs Paris, ack Peppol) reste interprétation documentée (comme 08:00 UTC en 2.3-T7).
- **A7** — **Garde inbound d'emblée** (D10) : si un mapping d'ack simulé lit un texte XML, appliquer la garde « xs:string/token vide → rejet typé » de la CLASSE 2.4-I1 (jamais un `TypeError`).

## Execution Handoff

Plan complet, sauvegardé dans `docs/superpowers/plans/2026-07-16-phase3-1-cdv-transmission-matrice.md`. Deux options :
1. **Subagent-Driven (recommandé)** — un subagent frais par tâche, revue Opus entre chaque (aligné 1.x/2.x).
2. **Inline** — exécution par lots avec points de contrôle.

**Recommandations fermes de périmètre (le contrôleur ratifie — aucune question ouverte laissée) :**
- **R1 — Matrice DAG dans `invoices/lifecycle-status.ts`** (remplacement chirurgical, signatures préservées, compat journal scellé). **Retenu (D1).**
- **R2 — Domaine transmission dans `apps/api/src/cdv/*`** (précédent ereporting/annuaire ; pas de nouveau package). **Retenu (D2).**
- **R3 — F6 validé STRUCTURELLEMENT** (aucun XSD DGFiP F6 ; UN/CEFACT CDAR non vendorisé) — posture PAF honnête, **pas** un XSD prétendu. **Retenu (D3).**
- **R4 — Machine de livraison DISTINCTE**, code 601 réel, `parked` retryable, journal non scellé. **Retenu (D4).**
- **R5 — `CdvTransmissionPort` différé** (local testable ; SFTP/AS2/AS4/**AS4-Peppol**/API `throw`) ; OpenPeppol/PKI/SMP/AS4 = items Xavier. **Retenu (D5).**
- **R6 — Routage via l'annuaire 2.4** (`resolveRecipient`, date=`issueDate`) ; non-adressable → `parked` + reprise bornée ; succès partiel au grain. **Retenu (D6).**
- **R7 — Obligatoires seuls** (200/210/212/213) au PPF + destinataire ; facultatifs & inbound F6 différés ; 24h borné. **Retenu (D7).**
- **R8 — 3 couches anti-double-envoi + pas de deadlock slot × terminal** (parked non terminal). **Retenu (D8).**
- **R9 — AFNOR XP Z12-012 = item Xavier** ; à l'acquisition, remplacer table + tests seuls. **Retenu (D1).**
- **R10 — Bump `0.7.0`.** **Retenu.**
