# Plan 2.4 — Annuaire (Flux 13/14) : miroir d'adressage, consultation & publication

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Livrer le **socle annuaire côté PA** (spec §3.5, ANNEXE 3 v1.8, Swagger annuaire v1.11.0) — l'annuaire réel est **hébergé par le PPF** et exige des **credentials d'immatriculation** (accréditation PISTE) : ce plan livre donc le **domaine PA pré-accréditation**, entièrement testable sans partenaire PPF. Concrètement : (1) un **modèle de domaine pur de la ligne d'adressage** (mailles SIREN / SIREN+SIRET / SIREN+SIRET+RoutageID / SIREN+Suffixe, période d'effet **semi-ouverte** `[DateDebut, DateFin)`, nature Définition/Masquage, matricule plateforme) avec sa **logique de validité et de résolution** ; (2) une **génération Flux 13 (Actualisation) XML XSD-valide** et un **parseur Flux 14 (Consultation) XML XSD-validé** (les **XSD DGFiP de l'annuaire existent et sont strictement typés** — `Annuaire_Actualisation_F12-F13.xsd`, `Annuaire_Consultation_F14.xsd`, `Annuaire_Commun.xsd` ; validation `xmllint`/libxml2, miroir 2.3) ; (3) un **miroir de consultation tenant-scopé** alimenté par la synchronisation Flux 14 et un **service de résolution du routage** (destinataire → matricule de plateforme de réception, à la date de la facture) — la brique que le flux de facturation consommera pour router ; (4) un **flux de publication des lignes de NOS tenants** (Flux 13) avec **cycle de vie DISTINCT** (draft → published → acquittement PPF déposée/rejetée), **journal append-only** et **portail de consentement obligatoire** (accord formel préalable à toute création/modification de ligne, §3.5.5.5) ; (5) un **ordonnanceur de synchronisation** (différentiel quotidien / complet hebdomadaire — borné, discipline de balayage 2.3) ; (6) un **`AnnuairePort` différé au déploiement** (consultation + publication, implémentation locale write-once/fixtures testable ; adaptateurs réels API PISTE-OAuth2 / EDI SFTP-AS2-AS4 **spécifiés, activés au déploiement**, `throw` testé). L'**annuaire réel** (feed INSEE/Chorus/DGFiP, habilitations, matricules de plateforme vrais) reste **derrière le port** — go-live.

**Architecture:** On **réutilise le socle 1.x/2.x** exactement comme en 2.3 : modèle `Invoice` canonique (`@factelec/invoice-core`, pour identifier le destinataire à router), infra BullMQ (file dédiée + `@Processor` unique routant par `job.name` + `upsertJobScheduler` répétable, motifs 2.1/2.3), discipline drizzle + **RLS `FORCE`** + `runInTenant`/`SET LOCAL app.tenant_id` + rôle `factelec_app` sans `BYPASSRLS`, fonctions **`SECURITY DEFINER` à `search_path=pg_catalog,pg_temp` épinglé + schéma-qualifiées** (miroir `find_ereporting_declarants_due` 0017 / `find_failed_archives` 0015), filtre `problem+json`, guards dual-auth session/clé API. Le **domaine pur** (nomenclatures, modèle de ligne, validité/résolution, génération F13, parseur F14, machine à états) vit dans `apps/api/src/annuaire/*` en modules **purs sans dépendance NestJS** — précédent direct : `src/ereporting/*` (2.3), `src/archive/archive-bundle.ts`, `src/ledger/ledger-hash.ts` (2.2). La **génération XML** réutilise `xmlbuilder2` (**déjà présent** dans `apps/api` depuis 2.3, MIT, dédupliqué via `invoice-core`) — aucune dépendance ajoutée ; le **parseur F14** réutilise le **même `xmlbuilder2`** (`create(xml).end({ format: 'object' })`) pour éviter tout ajout. La **validation XSD** réutilise le motif `xmllint --schema` (`tests/helpers/ereporting-xsd.ts`, 2.3) contre les **XSD DGFiP de l'annuaire livrés** (`docs/reglementaire`, lecture seule). La **persistance** ajoute quatre tables tenant-scopées (`annuaire_consents`, `annuaire_lignes` publications, `annuaire_ligne_events` journal, `annuaire_directory_entries` miroir de consultation) sous RLS `FORCE`. L'**ordonnanceur** énumère les tenants **à synchroniser** via une **fonction SD cross-tenant** (miroir `find_ereporting_declarants_due`) puis enfile un job de sync par tenant. La **transmission/consultation** passe par un **port** (`AnnuairePort`) : `LocalFilesystemAnnuaireStore` (écrit le F13 XML write-once, renvoie un `trackingRef` déterministe ; sert des fixtures F14 déterministes pour la consultation — entièrement testable) ; les adaptateurs réels API/EDI sont **spécifiés** et **activés au déploiement** (`throw` documenté et testé), exactement comme `Flux10TransmissionPort` (2.3) et `ArchiveStore` (2.2).

**Tech Stack:** **Aucune dépendance runtime ajoutée.** Génération **et** parsing XML : `xmlbuilder2` (déjà dans `apps/api` depuis 2.3 — dédup via `invoice-core@^4.0.3`, `pnpm outdated -r`/`audit:ci` restent verts ; échappement XML correct pour la génération, parsing DOM→objet pour l'ingestion F14). Validation : `xmllint` (libxml2, déjà requis par les tests `invoice-core`/`ereporting`, présent en CI Ubuntu `libxml2-utils`). Dates/hash/IO : `node:*` natifs. Files : **BullMQ 5.80.4** (déjà présent). Aucun ajout à `apps/web`. `docker-compose` inchangé (le store local écrit dans un répertoire temporaire/monté).

## Global Constraints

Reprises **verbatim** du socle 1.x/2.x (non négociables) — chaque tâche en hérite implicitement :

- **TDD strict RED/GREEN** : test écrit et vu échouer avant toute implémentation ; aucun merge si un test échoue (spec §7). Un commit minimum par tâche, message en **français**, **sans** trailer `Co-Authored-By: Claude` ni mention Claude ; commits au seul nom de l'utilisateur. `pnpm format` avant chaque commit.
- **Couverture bloquante** : **≥ 90 %** (lines/functions/statements/branches) maintenue sur `apps/api` ; `packages/invoice-core` reste à **100 %** (ne pas y toucher). `apps/web` : seuil 90×4 maintenu (aucune modif web dans ce plan). Exclusions de couverture existantes conservées (`src/main.ts`, `src/worker-main.ts`, `**/*.module.ts`, `src/db/migrations/**`). **Tout module pur de domaine annuaire** (nomenclatures, modèle de ligne, validité/résolution, machine à états, génération F13, parseur F14) est visé à **100 %** par des tests unitaires déterministes (goldens XSD-validés, vecteurs de date fixés). Le code de transport réel (adaptateurs API/EDI, non testable sans infra) **n'est pas écrit** dans ce plan : seul son contrat est spécifié (branche `throw` testée — aucune ligne à exclure, voir D7).
- **e2e sur Postgres réel (Testcontainers)** pour toute table/endpoint ; **Redis réel** pour tout flux worker/scheduler ; **tests d'isolation multi-tenant explicites** (consentement/ligne/journal/miroir d'un tenant jamais visible d'un autre). **Motifs de stabilité e2e OBLIGATOIRES** (acquis 1.4/2.1/2.2/2.3) : `listenOnce` (serveur de test démarré **une seule fois** par fichier), `maxWorkers: 5`, `withStartupTimeout(120_000)`, `hookTimeout: 150_000`, écouteur `error` sur tout pool `pg` brut (bruit `57P01` au teardown).
- **Sécurité OWASP** : validation de toute entrée (zod), authz systématique (dual-auth session/clé API sur les endpoints de consultation et de publication). **Aucune donnée sensible hors des frontières tenant** : consentements, lignes publiées, journal et miroir de consultation restent sous la frontière tenant (RLS `FORCE`). Erreurs normalisées **RFC 9457 `application/problem+json`**. **Aucun secret dans Redis** : les jobs ne portent que des identifiants internes (le worker recharge sous RLS — motif 2.1/2.3).
- **Moindre privilège Postgres inchangé** : rôle `factelec_app` ≠ propriétaire, **sans `BYPASSRLS`, sans superuser** ; RLS **`ENABLE` + `FORCE`** sur toute table tenant ajoutée ; propagation du tenant par `SET LOCAL` via `runInTenant`. Le process API/worker ne connaît **que** `DATABASE_URL` (rôle app). Les migrations (colonnes, RLS, grants, fonction SD cross-tenant) s'exécutent sous le rôle **propriétaire** via `db:migrate`. La fonction SD d'énumération des tenants à synchroniser épingle **`search_path=pg_catalog, pg_temp`** et **schéma-qualifie** ses objets applicatifs, miroir de `find_ereporting_declarants_due` (0017).
- **TypeScript `strict: true`, ESM (`"type": "module"`), NodeNext, Node ≥ 22.** `typescript` pinné **exactement `7.0.2`** (racine, tsgo). Repli local `typescript@5.9.x` **du seul workspace concerné** autorisé et documenté si un typecheck bute — sans toucher le pin racine.
- **Dépendances pinnées exactement** (pas de `^`/`~`), **dernière stable** vérifiée au registre, avec licence. **`pnpm run audit:ci` 0 vulnérabilité** et **`pnpm outdated -r` vierge** restent **bloquants** en CI. **Aucune dépendance ajoutée** dans ce plan (réutilisation `xmlbuilder2` + `xmllint`) → l'objectif « outdated vierge / audit 0 » est mécaniquement tenu (vérifier néanmoins à **chaque** tâche — un patch amont peut sortir en cours de plan, cf. leçon 2.2-T5 / drift bullmq 2.3-T3).
- **`@factelec/invoice-core` consommé via son exports map**, jamais par chemin relatif inter-packages. `docs/reference/` et `docs/reglementaire/` en **lecture seule** (les XSD DGFiP sont référencés par chemin absolu depuis les tests, jamais copiés/modifiés).
- Identifiants de code en **anglais** ; commentaires/commits/docs en **français**.

---

## Périmètre : retenu en 2.4 vs reporté

**Retenu (ce plan) — socle annuaire côté PA, pré-accréditation (spec §3.5, ANNEXE 3 v1.8, Swagger v1.11.0) :**
1. **Nomenclatures & mailles d'adressage** : nature `D`/`M` (Définition/Masquage, DT-7-2), niveaux de maille (`SIREN`, `SIREN_SIRET`, `SIREN_SIRET_ROUTAGE`, `SIREN_SUFFIXE`), qualifiants ISO 6523 (`0002` SIREN, `0009` SIRET, routage variable), format matricule plateforme (`[0-9]{4}`), `TypeFlux` `C`/`D` (complet/différentiel), `MotifPresence` `C`/`P`/`S`, `Diffusible` `O`/`P`/`M`, plateforme fictive `9998` + Chorus Pro par défaut (concepts d'initialisation).
2. **Modèle de domaine pur de la ligne d'adressage + validité/résolution** : `LigneAdressage` (maille × période semi-ouverte × plateforme × nature), calcul de **clé de maille**, détection de **chevauchement**, **masquage**, **résolution de la maille la plus spécifique en vigueur à une date** (le cœur métier de la consultation).
3. **Génération Flux 13 (Actualisation) XSD-valide + Parseur Flux 14 (Consultation) XSD-validé** : `generateActualisationXml(...)` → `AnnuaireActualisation` (BlocCodesRoutage 0..1 + BlocLignesAnnuaire 0..1), validé `xmllint` contre `Annuaire_Actualisation_F12-F13.xsd` ; `parseConsultationF14(xml)` → validation XSD contre `Annuaire_Consultation_F14.xsd` + désérialisation en modèle de miroir.
4. **Machine à états publication DISTINCTE** (draft → published → {déposée/rejetée+motif}, + masquée), miroir pur de `ereporting-lifecycle.ts`, journal `annuaire_ligne_events` **append-only** (RLS `FORCE`, grants `SELECT`+`INSERT`) — **non scellé** (auth transport, comme le journal e-reporting, D6).
5. **Persistance** : `annuaire_consents` (preuve d'accord formel, gate de publication), `annuaire_lignes` (lignes publiées par NOS tenants + cycle de vie), `annuaire_ligne_events` (journal), `annuaire_directory_entries` (miroir de consultation tenant-scopé alimenté par la sync F14) ; RLS `FORCE`, moindre privilège différencié, fonction SD cross-tenant `find_annuaire_sync_targets`.
6. **`AnnuairePort` (consultation + publication)** + **implémentation locale testable** (`LocalFilesystemAnnuaireStore` : publication F13 write-once → `trackingRef` déterministe ; consultation → fixtures F14 déterministes) ; adaptateurs réels **API PISTE-OAuth2 / EDI SFTP-AS2-AS4 spécifiés, activés au déploiement** (`throw` documenté et testé).
7. **Service de consultation + résolution de routage** : `resolveRecipient(maille, date)` → matricule de plateforme de réception via le miroir (maille la plus spécifique en vigueur), + endpoint de recherche/résolution dual-auth. **La brique que le flux de facturation consommera pour router** (câblage dans le pipeline de facturation = étape future légère, l'émission vers le destinataire étant elle-même un item déploiement).
8. **Flux de publication consent-gated** : `POST /annuaire/lignes` (création, **consentement obligatoire**), `PUT` (fin d'effet), `DELETE` (masquage) ; génération F13 XSD-validée → transmission via le port → acquittement (déposée/rejetée) via la machine à états + journal.
9. **Ordonnanceur de synchronisation** : job répétable BullMQ **différentiel quotidien** + **complet hebdomadaire** (borné, discipline 2.3 : fenêtre bornée + jobId déterministe + backstop DB unique) → worker d'ingestion F14 (validation XSD → parse → upsert du miroir, application des masquages).
10. **CI / docs / OpenAPI / versions** : README + OpenAPI mis à jour, provenance §3.5 / ANNEXE 3 / XSD annuaire / Swagger v1.11.0, bump version.

**Reporté (acté ici, justifié en D7/D8/D11/D12/D13) :**
- **Adaptateurs de transport réels** (API PISTE-OAuth2 sur les 20 endpoints Swagger v1.11.0 ; EDI SFTP/AS2/AS4) : credentials d'accréditation + secrets à la main de Xavier, non testables sans partenaire PPF ; **conçus** (contrat du port), **activés au déploiement** (D7). C'est la raison structurelle du découpage : l'annuaire réel est PPF-hosted.
- **Feed d'initialisation réel** (INSEE unités légales/établissements, Chorus Pro codes routage B2G, registre TVA DGFiP, service d'immatriculation des PA) + **lignes par défaut PPF** (plateforme fictive `9998` pour les assujettis, Chorus Pro pour le public) : **concepts modélisés** (nomenclature + colonnes), **aucune donnée réelle chargée** (D12, §3.5.3).
- **Synchronisation des habilitations** depuis le service d'immatriculation PA (quelles entités ce PA peut voir/modifier) : le miroir est **tenant-scopé** par construction (D8) ; la dérivation par habilitation réelle est **au déploiement**.
- **Cycle de vie autonome des codes routage** (6 endpoints Swagger `code-routage/*`) : le `RoutageID` est porté **inline** en colonne de maille (D11) ; la table/les endpoints dédiés de gestion des codes routage sont **différés** (créer le code avant la ligne = geste PPF au go-live).
- **Intégration de capture du consentement** (e-signature, formulaire Figure 38) : le **modèle de preuve** + la **gate applicative** sont livrés (D5) ; le connecteur de signature réel est différé.
- **Contrôles sémantiques schematron / règles de gestion ANNEXE 7** : la validation de ce plan est **XSD structurelle** (les XSD annuaire sont livrés et **strictement typés** — contraste avec l'e-reporting permissif, D3) ; les règles de gestion fines (ordre masquage-avant-définition au-delà de l'émission, unicité inter-PA, collisions suffixe) sont **appliquées côté application** là où c'est possible et **marquées interprétation go-live** sinon (D11).
- **Câblage de la résolution dans le pipeline d'émission de facture** : le service `resolveRecipient` est livré et interrogeable ; sa consommation par l'émetteur (routage réel vers la plateforme destinataire) suit l'activation du transport (déploiement).

---

## Décisions structurantes (à lire avant d'exécuter)

### D1 — Annuaire = registre PPF-hosted ; le livrable pré-accréditation est le DOMAINE PA
- L'annuaire est un **registre central maintenu par le PPF** stockant les lignes d'adressage des destinataires ; les PA le **consultent** pour router les factures (Flux 14) et l'**actualisent** pour leurs clients (Flux 13). L'accès réel exige un **bearer PISTE** (credentials d'immatriculation, déploiement). **Décision** : ce plan livre le **domaine PA** entièrement testable — miroir local, modèle de ligne, service de consultation/résolution, flux de publication, ordonnanceur de sync, et un **`AnnuairePort` différé** ; le registre réel reste derrière le port (go-live).
- **Source vérifiée** : dossier `research-2-4-annuaire.md` §1, §5, §10-11 ; Swagger v1.11.0 (Bearer PISTE, `servers: https://aife.economie.gouv.fr/ppf/annuaire-public/v1`).

### D2 — Domaine pur dans `apps/api/src/annuaire/*` ; AUCUNE dépendance ajoutée
- Le domaine annuaire (nomenclatures, modèle, validité, XML F13/F14, machine à états) est **pur, sans NestJS**, sous `apps/api/src/annuaire/*` — **précédent direct** : `src/ereporting/*` (2.3), `src/archive/*`, `src/ledger/*` (2.2), unit-testés à 100 %. On évite un nouveau package (surcoût build/exports map, cf. dette 1.3 / arbitrage 2.3-Q2 tranché « rester dans apps/api »).
- **`xmlbuilder2` réutilisé** (déjà dans `apps/api` depuis 2.3, pinné exact, dédup lockfile via `invoice-core`) pour la **génération** (échappement XML correct — une concaténation maison serait injection-prone, proscrit) **et le parsing F14** (`create(xml).end({ format: 'object' })` — évite d'ajouter `fast-xml-parser` ou équivalent). **Aucune dépendance runtime ajoutée** → `outdated`/`audit` mécaniquement verts.

### D3 — Les XSD annuaire EXISTENT et sont STRICTEMENT typés ; validation des DEUX directions (correction du dossier)
- **Le dossier de recherche (§14) n'a listé qu'ANNEXE 3 + Swagger ; il a OMIS les XSD DGFiP de l'annuaire, qui sont pourtant présents et autoritatifs.** Vérifié in situ : `docs/reglementaire/specifications-externes-v3.2/3- XSD_v3.2/0 - Annuaire/` contient **`actualisation/Annuaire_Actualisation_F12-F13.xsd`** (racine `AnnuaireActualisation`), **`consultation/Annuaire_Consultation_F14.xsd`** (racine `AnnuaireConsultationF14`) et **`common/Annuaire_Commun.xsd`** (types partagés, inclus par `xs:include`).
- Contrairement au XSD e-reporting (permissif, `xs:string` partout, D9 de 2.3), les XSD annuaire sont **strictement typés** : `DateType` = `\d{4}(0[1-9]|1[012])(0[1-9]|[12][0-9]|3[01])` (**AAAAMMJJ**), `HorodateType` (**AAAAMMJJHHMMSS**), `IdentifiantSIRENType` = `[0-9]{9}`, `IdentifiantSIRETType` = `[0-9]{14}`, `IdentifiantMatriculePlateformeType` = `[0-9]{4}`, attribut `qualifiant` **requis** sur `IdSiren/IdSiret/IdCodesRoutage`. **La validité XSD est donc bien plus signifiante ici** : elle contraint dates, identifiants et matricules. **Décision** : valider **la génération F13** (émission) ET **le parsing F14** (ingestion) via `xmllint --schema` (motif `tests/helpers/ereporting-xsd.ts`). Les XSD n'ont **pas de `targetNamespace` ni `elementFormDefault`** → instance **sans préfixe de namespace** (même situation qu'e-reporting) : **confirmé empiriquement au premier run `xmllint`** (le test XSD est la sentinelle), golden capté après validation verte.
- **Source vérifiée** : les 3 XSD lus (F12-F13 : `BlocCodesRoutage`/`BlocLignesAnnuaire` ; F14 : `HorodateProduction`/`DernierHorodateProduction`/`TypeFlux`/`BlocUnitesLegales`/`BlocEtablissements`/`BlocCodesRoutage`/`BlocIdPlateformesReception`/`BlocLignesAnnuaire` ; commun : mailles + `PeriodeEffet`).

### D4 — Ligne d'adressage : intervalle SEMI-OUVERT `[DateDebut, DateFin)` ; résolution = maille la plus spécifique en vigueur (résout ambiguïté #5)
- **Décision ferme** (résout l'ambiguïté #5 « comportement à J=DateFin ») : la période d'effet **inclut la date de début, exclut la date de fin** (intervalle semi-ouvert). Une ligne est **en vigueur à la date `D`** ssi `DateDebut ≤ D` et (`DateFin` absente **ou** `D < DateFin`). Une facture émise **le jour de `DateFin` n'utilise plus la ligne**. Le masquage (`Nature='M'`) rend la maille **non adressable** à compter de sa date d'effet.
- **Résolution du routage** : parmi les lignes en vigueur à `D` pour un destinataire, on retient la **maille la plus spécifique** (`SIREN_SIRET_ROUTAGE`/`SIREN_SUFFIXE` > `SIREN_SIRET` > `SIREN`) — c'est la granularité d'adressage voulue par l'entité. **Aucune ligne en vigueur → destinataire non adressable** (erreur typée `RecipientUnaddressableError`).
- **Source vérifiée** : ANNEXE 3 F13 rows 23-24 (« inclut le début, exclut la fin » ; « aucune ligne en vigueur → aucune facture ne peut lui être adressée » verbatim, dossier §4) + F13 row 25 (les 4 mailles verbatim, dossier §4).

### D5 — Consentement OBLIGATOIRE avant publication (résout ambiguïté #1) ; modèle de preuve = interprétation go-live
- **Décision ferme** (résout l'ambiguïté #1) : toute création/modification d'une ligne par le PA exige un **accord formel préalable** de l'assujetti (§3.5.5.5 verbatim : « Le recueil du consentement de l'assujetti pour désigner la plateforme de réception… peut se faire au-travers de la complétion d'un "accord formel" »). On modélise `annuaire_consents` (preuve : `siren` + portée maille, `consentType`, `signerIdentity`, `evidenceRef`/empreinte, `obtainedAt`, `revokedAt?`) et une **gate applicative** : `AnnuairePublicationService` **refuse (422)** toute publication sans consentement **actif** couvrant la maille. Versionnement par **append** (nouvelle ligne par révision) ; un `revokedAt` non nul retire le consentement.
- Le **schéma de données** du consentement n'est **pas** spécifié (la spec ne fournit qu'un formulaire, Figure 38) → **marqué INTERPRÉTATION PROJET**, champs à confirmer au go-live. Ce qui est **ancré** : l'**exigence** du consentement (règle, §3.5.5.5).

### D6 — Machine à états publication DISTINCTE ; journal append-only NON scellé
- La publication d'une ligne a son **propre cycle de vie**, **distinct** du CDV facture (200-213) et de l'e-reporting (300/301) : états internes PA `draft` (rédigée localement) → `published` (émise via le port) puis acquittement PPF `deposee` (acceptée, terminal) ⊕ `rejetee` (terminal, **motif requis**), plus un chemin `masked` (fin d'adressage via `Nature='M'`). Machine **pure** (`annuaire-lifecycle.ts`), **miroir structurel** de `ereporting-lifecycle.ts` (transitions explicites `ALLOWED`, `Object.hasOwn` garde de type, `InvalidAnnuaireTransitionError`), **sans conflation** avec les autres.
- Journal `annuaire_ligne_events` **append-only** (RLS `FORCE` + grants `SELECT`+`INSERT`, motif e-reporting 0017) mais **NON scellé** (pas de trigger de hash-chain, contrairement à `invoice_status_events` 0012) : la transmission au PPF est **authentifiée au niveau transport** (pas de scellement message dans l'annuaire, comme le Flux 10 — D3 de 2.3). **Aucun code de rejet réglementaire « Tableau » n'étant fourni pour l'annuaire**, le motif de rejet est une **chaîne libre** portée par le journal (interprétation, à cadrer go-live) — on n'invente pas d'énum normatif.

### D7 — `AnnuairePort` différé au déploiement (miroir `Flux10TransmissionPort` / `ArchiveStore`) — résout ambiguïté #3
- **Testable sans partenaire PPF** : le **port** `AnnuairePort` (`publish(actualisation)` → `PublishResult{trackingRef}` ; `fetchConsultation(typeFlux)` → `ConsultationResult{xml}` ; `publicationStatus(trackingRef)` → acquittement simulé) et l'implémentation **`LocalFilesystemAnnuaireStore`** — écrit le F13 XML **write-once** (`wx` + `chmod 0o444`, anti-traversée `SAFE_KEY`/normalize/`..`), renvoie un `trackingRef` déterministe (SHA-256 hex du contenu) ; `fetchConsultation` sert un **F14 fixture déterministe** (fichier de fixtures monté ou vide). Miroir exact de `LocalFilesystemTransmissionStore` (2.3-T6).
- **NON testable sans infra** (instruit honnêtement) : adaptateurs **API PISTE** (bearer OAuth2, 20 endpoints Swagger), **EDI** (SFTP clés RSA / AS2-AS4 X.509). **Non écrits** dans ce plan — **contrat spécifié** (mêmes signatures), **sélection par env** `ANNUAIRE_DRIVER=local|api|edi` (défaut `local`) + `ANNUAIRE_LOCAL_DIR`. La branche non-`local` de la factory est un **`throw` documenté et testé** (une ligne couverte). **Résout l'ambiguïté #3** : la bascule local→réel est une décision de déploiement portée par l'env ; le local reste le driver de dev/test.

### D8 — Miroir de consultation TENANT-SCOPÉ sous RLS FORCE (uniformité + PII)
- Le miroir de consultation (`annuaire_directory_entries`) et les publications (`annuaire_lignes`) sont **tenant-scopés** sous RLS `FORCE`. **Décision** : on **ne** matérialise **pas** un pool global du registre PPF (qui contiendrait SIREN/SIRET/noms/adresses de toutes les entités — masse PII/`Diffusible`). Chaque tenant ne voit que **sa** vue du miroir, alimentée par la sync F14 **selon ses habilitations** (au go-live, l'adaptateur réel filtre par habilitation ; en pré-accréditation, la sync locale peuple depuis des fixtures scopées au tenant). Cohérent avec la discipline projet (RLS `FORCE` uniforme sur toute table tenant) et avec le modèle d'autorisation du Swagger (« un PA voit ses clients enregistrés »).
- **Interprétation marquée go-live** : la dérivation exacte « habilitation → périmètre du miroir » dépend du service d'immatriculation PA (différé). Le miroir tenant-scopé est le choix **discipline-consistant** et **PII-safe** par défaut.
- **Source** : Swagger v1.11.0 (modèle d'autorisation basé habilitations, dossier §3 « Auth & Authorization Model »).

### D9 — Cadence de sync : différentiel quotidien + complet hebdomadaire, borné ; J+1 = interprétation (résout ambiguïté #6)
- **Décision** : deux jobs répétables — **différentiel quotidien** (`TypeFlux='D'`) et **complet hebdomadaire** (`TypeFlux='C'`) — miroir de la cadence PPF (F14 différentiel 24h ; complet hebdo dimanche→lundi, dossier §8). **Balayage borné** (discipline 2.3-A2 : la sync ne ré-ingère jamais un historique entier ; jobId déterministe ; backstop DB unique sur le miroir). La **mécanique exacte des fenêtres** (heure précise, rattrapage si le PPF saute un jour — ambiguïté #6) est **INTERPRÉTATION PROJET documentée**, à confirmer go-live (on applique la cadence quotidien/hebdo, on marque l'incertitude — comme les deadlines Tableau 13 en 2.3-D4).
- **Visibilité J+1** des lignes publiées : §3.5.5.5 verbatim « Toute actualisation de l'annuaire… sera consultable dès le lendemain (J+1) ». Modélisé comme **interprétation** (champ dérivé `visible_from = publishDate + 1j` non contraignant, documenté) — la mécanique réelle est côté PPF.
- **Source vérifiée** : dossier §8 (différentiel quotidien / complet hebdo) + §9 (J+1 verbatim).

### D10 — Réutilisation : Invoice (destinataire), infra BullMQ, discipline drizzle+RLS+SD, dual-auth
- **Données** : la résolution part de l'`Invoice` canonique (destinataire `buyer` SIREN/SIRET) pour interroger le miroir — aucune ré-extraction. **Infra** : file BullMQ dédiée `annuaire-sync` + `@Processor` unique (motif `ereporting-generation`/`maintenance`), scheduler `upsertJobScheduler` répétable (motif `EreportingScheduler`), énumération cross-tenant par fonction **SD** (motif `find_ereporting_declarants_due`). **Discipline DB** : migrations drizzle pour colonnes/tables, **manuelles** pour RLS/grants/SD (`--> statement-breakpoint`), `nullif(current_setting('app.tenant_id',true),'')::uuid`, SD `search_path=pg_catalog,pg_temp` + schéma-qualifié. **Contrôleur** : dual-auth `TenantAuthGuard` + 404 anti-fuite (motif `EreportingController`/`LedgerController`).

### D11 — Suffixe/collision (résout ambiguïté #4) ; codes routage standalone différés
- **Décision** (résout l'ambiguïté #4) : unicité **locale** par `(tenant, mailleKey, dateDebut)` où `mailleKey` inclut le suffixe (une `Définition` par maille×date) → **rejet des chevauchements pour la même maille** (23505→409). La **collision inter-PA** d'un même suffixe pour un même client est un arbitrage **PPF** (le PPF tranche à la réception) → **différé**, documenté ; localement on garantit la cohérence **intra-tenant**.
- **Codes routage** : le `RoutageID` est porté **inline** (colonne de maille) plutôt que par une table/6 endpoints dédiés (Swagger `code-routage/*`) → **différé** (D11). La règle « créer le code routage avant la ligne » est un **geste PPF au go-live** (le port réel le fera) ; le domaine local accepte un `RoutageID` opaque.

### D12 — Données d'initialisation modélisées, non chargées
- Les **sources d'initialisation** (INSEE, Chorus Pro, registre TVA, service PA) et les **lignes par défaut PPF** (assujetti privé → maille SIREN, plateforme fictive **`9998`** non-routante ; public → SIRET+routage, **Chorus Pro** par défaut) sont **modélisées comme concepts** (nomenclature `FICTITIOUS_PLATFORM='9998'`, colonnes de miroir) mais **aucune donnée réelle n'est chargée** (feed = go-live, D1/D7). En pré-accréditation, les fixtures F14 servent des lignes de démonstration.
- **Source vérifiée** : dossier §7 (PDF §3.5.3).

### D13 — Publication : succès partiel au grain ligne, retry BullMQ dédié (résout ambiguïté #2)
- **Décision** (résout l'ambiguïté #2) : la publication supporte le **succès partiel au grain ligne** — l'acquittement (via le port, puis via la machine à états) marque **chaque ligne** `deposee` ou `rejetee` (+ motif). Le retry d'une publication échouée (erreur transport) suit une **politique BullMQ dédiée** `ANNUAIRE_PUBLISH_JOB_ATTEMPTS` (défaut 3, miroir `EREPORTING_GENERATION_JOB_ATTEMPTS`). Le **nombre de retries** et la granularité DLQ sont **interprétation projet** (la spec définit des motifs de rejet mais pas de stratégie de retry). Un rejet **métier** (règle de gestion) marque `rejetee`, ce n'est **jamais** un retry (miroir `REJ_SEMAN` local 2.3-T8).

---

## Versions & dépendances (registre npm vérifié le 2026-07-16)

| Brique | Fournisseur | Provenance / note |
|---|---|---|
| Génération **& parsing** XML | **`xmlbuilder2`** (déjà présent `apps/api`, pin exact) | **Aucun ajout** ; dédup lockfile via `invoice-core@^4.0.3` → `outdated`/`audit` verts. MIT. Échappement correct (génération) + `create(xml).end({format:'object'})` (parsing F14, D2). |
| Validation XSD | **`xmllint`** (libxml2) | Déjà requis par `invoice-core`/`ereporting` ; présent en CI (Ubuntu `libxml2-utils`). Aucun ajout npm. |
| Files / scheduler | **BullMQ 5.80.4** (déjà présent) | Files dédiées `annuaire-sync` (+ éventuelle `annuaire-publish`) + jobs répétables `maintenance`. |
| Dates / IO / hash | `node:*` natifs | Calcul de fenêtres (Date UTC), écriture write-once, empreinte SHA-256 du `trackingRef`. |

> **Gate** : `pnpm run audit:ci` = 0 et `pnpm outdated -r` **vierge**. Vérifier à **chaque** tâche (un patch amont peut sortir en cours de plan — leçon 2.2/2.3). Overrides existants inchangés.

---

## Points de risque signalés d'emblée

1. **Qualification des espaces de noms de l'instance XML.** Les 3 XSD annuaire sans `targetNamespace`/`elementFormDefault` → instance **sans préfixe**. **Traité** : déterminé empiriquement au premier run `xmllint` (Task 3), golden capté après vert. Repli : si un préfixe s'avère requis, ajuster générateur/parseur et re-valider (le test XSD est la sentinelle) — miroir du pivot 2.3-T2.
2. **Forme F13 InfoAdressage ≠ F14 InfoAdressage.** Le commun définit **deux** types : `InfoAdressageActualisationType` (F13 : identifiants **imbriqués** sous un élément `Identifiant`) vs `InfoAdressageConsultationType` (F14 : `Identifiant` texte **plat** + `IdLinSIREN`/… en frères). **Traité** : générateur F13 et parseur F14 ciblent chacun leur type exact (cité dans les Steps) ; les tests XSD sanctionnent toute confusion.
3. **Ordre masquage-avant-définition (F13 row 20).** L'actualisation doit **masquer/remplacer avant de définir** pour éviter les chevauchements de dates. **Traité** : le générateur émet les lignes `Nature='M'` **avant** les `Nature='D'` dans `BlocLignesAnnuaire` ; testé.
4. **Attribut `qualifiant` requis.** `IdLinSIREN`/`IdLinSIRET`/`IdLinRoutage` exigent `@qualifiant` (XSD `use="required"`). **Traité** : le générateur pose systématiquement `qualifiant` (0002/0009/…) ; un oubli est rejeté par `xmllint` (sentinelle).
5. **Résolution de maille & bornes de date.** Semi-ouvert `[début, fin)`, maille la plus spécifique. **Traité** : D4, vecteurs unit-testés sur dates fixes (J=DateFin exclu, chevauchement rejeté, masquage).
6. **Consentement (pas de schéma spec).** **Traité/instruit** : D5 (exigence ancrée §3.5.5.5, modèle marqué interprétation), gate applicative 422 testée.
7. **Cadence de sync exacte.** **Traité** : D9 (quotidien/hebdo, borné, marqué interprétation), vecteurs de fenêtre unit-testés.
8. **Transport réel absent.** **Traité/instruit** : D7 (port + local testable ; adaptateurs réels au déploiement, `throw` testé).
9. **PII du miroir.** **Traité** : D8 (tenant-scopé, pas de pool global ; RLS `FORCE`).
10. **Numérotation des migrations.** Dernière = **0017**. Ce plan démarre à **0018** (drizzle : enums + 4 tables) et **0019** (manuel : RLS/grants + SD cross-tenant). Entrées `meta/_journal.json` : la migration drizzle écrit son entrée + snapshot ; la manuelle est ajoutée **à la main** (`{ idx:19, version:"7", when:<epoch-ms>, tag:"0019_annuaire_rls", breakpoints:true }`, **sans** snapshot — comme 0015/0017).

---

## Sources réglementaires vérifiées (dossier `docs/reglementaire/specifications-externes-v3.2/`, lecture seule)

> Vérifiées in situ (les 3 XSD annuaire lus ; Swagger v1.11.0 parsé ; dossier `research-2-4-annuaire.md` consolidé). Provenance tracée pour chaque affirmation.

- **XSD Actualisation (Flux 12/13)** — `3- XSD_v3.2/0 - Annuaire/actualisation/Annuaire_Actualisation_F12-F13.xsd` : `<xs:element name="AnnuaireActualisation" type="AnnuaireActualisationType"/>` ; `AnnuaireActualisationType` = séquence `BlocCodesRoutage` (`CodesRoutageActualisationType`, 0..1) + `BlocLignesAnnuaire` (`LignesAnnuaireActualisationType`, 0..1). `xs:include` du commun. **Aucun `targetNamespace`.**
- **XSD Consultation (Flux 14)** — `…/consultation/Annuaire_Consultation_F14.xsd` : `<xs:element name="AnnuaireConsultationF14" .../>` ; séquence `HorodateProduction` (`HorodateType`, 1..1), `DernierHorodateProduction` (0..1), `TypeFlux` (`xs:string`, 1..1), `BlocUnitesLegales`/`BlocEtablissements`/`BlocCodesRoutage`/`BlocIdPlateformesReception`/`BlocLignesAnnuaire` (chacun 0..1).
- **XSD Commun** — `…/common/Annuaire_Commun.xsd` : `DateType` (`\d{4}(0[1-9]|1[012])(0[1-9]|[12][0-9]|3[01])`, AAAAMMJJ), `HorodateType` (AAAAMMJJHHMMSS), `IdentifiantSIRENType` (`[0-9]{9}`), `IdentifiantSIRETType` (`[0-9]{14}`), `IdentifiantMatriculePlateformeType` (`[0-9]{4}`), `IdSirenType`/`IdSiretType`/`IdCodesRoutageType` (`@qualifiant` **required**). `LignesAnnuaireActualisationType` → `LigneAnnuaire` (1..n) : `Nature`, `DateEffet` (`DateDebut` 1..1 + `DateFin` 0..1), `InfoAdressage` (`InfoAdressageActualisationType` : `Identifiant` → `IdLinSIREN` 1..1 + `IdLinSIRET` 0..1 + `IdLinRoutage` 0..1 + `Suffixe` 0..1), `IdPlateforme` (matricule 4 chiffres). `LignesAnnuaireF14Type` → `LigneAnnuaire` (1..n) : `IdInstance`, `MotifPresence`, `Nature`, `DateEffet` (`PeriodeEffetConsultationType` : `DateDebut`/`DateFin`/`DateFinEffective`), `InfoAdressage` (`InfoAdressageConsultationType` : `Identifiant` texte + `IdLinSIREN`/… plats), `IdPlateforme`. `BlocIdPlateformesReception` → `Matricule` (4 chiffres) + `TypePlateforme` + immatriculation.
- **Swagger annuaire v1.11.0** — `4- Swagger_v3.2/ppf-openapi-annuaire-api-public-1.11.0-openapi.json` : 15 chemins / 20 opérations (SIREN 3, SIRET 3, `code-routage` 6, `ligne-annuaire` 7 dont `POST /ligne-annuaire`, `POST /ligne-annuaire/recherche`, `GET …/code:{identifiant-adressage}`, `GET/PATCH/PUT/DELETE …/id-instance:{id-instance}`, healthcheck 1). Bearer PISTE. **Cible du port réel (différé, D7).**
- **ANNEXE 3 v1.8** — `2- Annexes_v3.2/20260430_Annexe 3 - Format sémantique FE annuaire - V1.8.xlsx` : mailles d'adressage (F13 row 25, verbatim dossier §4), période semi-ouverte + entité non adressable sans ligne (F13 rows 23-24), ordre masquage-avant-définition (F13 row 20).
- **Spec PDF v3.2** — §3.5.1-3.5.5 : consultation avant routage (§3.5.4 verbatim), consentement/accord formel (§3.5.5.5 verbatim, CGI art. 289 bis / L.123 2026), visibilité J+1 (§3.5.5.5 verbatim), initialisation & lignes par défaut (§3.5.3).
- **Absence de signature message** (auth transport) et **absence de code de rejet normatif** pour l'annuaire (aucun « Tableau » de motifs livré) : motif de rejet = chaîne libre (D6).

---

## Structure des fichiers (vue d'ensemble)

```
apps/api/
  package.json                              # INCHANGÉ (xmlbuilder2 déjà présent depuis 2.3)
  src/
    config/env.ts                           # + ANNUAIRE_DRIVER, ANNUAIRE_LOCAL_DIR, ANNUAIRE_SYNC_EVERY_MS,
                                            #   ANNUAIRE_COMPLETE_EVERY_MS, ANNUAIRE_PUBLISH_JOB_ATTEMPTS
    db/
      schema.ts                             # + enums + annuaire_consents/lignes/ligne_events/directory_entries
      migrations/
        0018_annuaire_tables.sql            # (drizzle) enums + 4 tables (Task 5)
        0019_annuaire_rls.sql               # (hand) RLS FORCE + grants + SD find_annuaire_sync_targets (Task 5)
        meta/_journal.json                  # + 0018/0019 (0019 ajouté manuellement)
    annuaire/
      nomenclature.ts                       # PUR : nature D/M, mailles, qualifiants, matricule, TypeFlux, 9998… (Task 1)
      ligne-adressage.ts                    # PUR : modèle, mailleKey, validité [début,fin), chevauchement, résolution (Task 2)
      flux13-xml.ts                         # PUR : generateActualisationXml (xmlbuilder2, XSD-valide) (Task 3)
      flux14-parse.ts                       # PUR : parseConsultationF14 (validation XSD + désérialisation) (Task 3)
      annuaire-lifecycle.ts                 # PUR : machine à états publication draft/published/deposee/rejetee/masked (Task 4)
      annuaire.repository.ts                # consents/lignes/journal/miroir sous RLS (Task 5)
      annuaire.port.ts                      # port + token + erreurs (Task 6)
      local-filesystem-annuaire-store.ts    # impl write-once locale + fixtures F14 (Task 6)
      annuaire-transport.module.ts          # @Global factory selon ANNUAIRE_DRIVER (Task 6)
      annuaire-consultation.service.ts      # resolveRecipient(maille, date) via miroir (Task 7)
      annuaire-publication.service.ts       # publication consent-gated → F13 → transmit → ack (Task 8)
      annuaire.controller.ts                # endpoints dual-auth (Task 7/8)
      annuaire.module.ts                    # câblage API (Task 7/8)
    worker/
      annuaire-sync.service.ts              # ingestion F14 → miroir (validation XSD → parse → upsert) (Task 9)
      annuaire-sweep.service.ts             # énumère les tenants dus (SD) → enfile la sync (Task 9)
      annuaire.scheduler.ts                 # upsertJobScheduler différentiel + complet (Task 9)
      annuaire-sync.processor.ts            # @Processor(ANNUAIRE_SYNC_QUEUE) (Task 9)
      maintenance.processor.ts              # + branches ANNUAIRE_SYNC_DIFF_JOB / ANNUAIRE_SYNC_FULL_JOB (Task 9)
      worker.module.ts                      # + providers annuaire (Task 9)
    queue/
      queue.constants.ts                    # + ANNUAIRE_SYNC_QUEUE (Task 9)
      maintenance.job.ts                    # + ANNUAIRE_SYNC_DIFF_JOB / ANNUAIRE_SYNC_FULL_JOB (Task 9)
      annuaire-sync.job.ts                  # payload minimal { tenantId, typeFlux } (Task 9)
  tests/
    unit/
      annuaire-nomenclature.test.ts         # (Task 1)
      ligne-adressage.test.ts               # validité/résolution/chevauchement (Task 2)
      flux13-xml.test.ts                    # golden + XSD-valide (Task 3)
      flux14-parse.test.ts                  # XSD-validé + désérialisation (Task 3)
      annuaire-lifecycle.test.ts            # transitions + motif (Task 4)
      local-filesystem-annuaire-store.test.ts  # write-once + fixtures (Task 6)
      env.test.ts                           # (MODIFIÉ) cas ANNUAIRE_* (Task 6)
    e2e/
      annuaire-persistence.e2e.test.ts      # RLS/isolation consents/lignes/journal/miroir (Task 5)
      annuaire-consultation.e2e.test.ts     # resolveRecipient + endpoint dual-auth, isolation (Task 7)
      annuaire-publication.e2e.test.ts      # consent gate 422 + publication F13 + ack, isolation (Task 8)
      annuaire-sync.e2e.test.ts             # sync F14 → miroir, borné/idempotent (Task 9)
    helpers/annuaire-xsd.ts                 # validateAgainstAnnuaireActualisationXsd / …ConsultationXsd (Task 3)
    fixtures/annuaire-f14-*.xml             # fixtures de consultation déterministes (Task 3/6/9)
```

Fichiers hors `apps/api` : `README.md` racine + `apps/api/README.md` (annuaire, `ANNUAIRE_*`, différés), `.github/workflows/ci.yml` inchangé (libxml2 déjà présent).

---

### Task 1 : Nomenclatures annuaire & mailles d'adressage (module pur)

**Files:**
- Create: `apps/api/src/annuaire/nomenclature.ts`
- Create: `apps/api/tests/unit/annuaire-nomenclature.test.ts`

**Interfaces:**
- Consumes : rien (constantes autoportantes).
- Produces (Tasks 2-3-9) : `NATURES` (`D`/`M`), `MAILLE_LEVELS`, `SCHEME_ID_SIREN` (`0002`), `SCHEME_ID_SIRET` (`0009`), `TYPE_FLUX` (`C`/`D`), `MOTIF_PRESENCE` (`C`/`P`/`S`), `DIFFUSIBLE` (`O`/`P`/`M`), `FICTITIOUS_PLATFORM` (`9998`), `PLATFORM_MATRICULE_RE` (`/^[0-9]{4}$/`), `SIREN_RE`/`SIRET_RE`/`DATE_RE`/`HORODATE_RE` (miroir des patterns XSD commun), `mailleLevelOf(ids)`, `isPlatformMatricule`.

- [ ] **Step 1 : Tests (RED) — nomenclatures ancrées XSD/ANNEXE 3**

`apps/api/tests/unit/annuaire-nomenclature.test.ts` :
```ts
import { describe, expect, it } from 'vitest'
import {
  DATE_RE,
  DIFFUSIBLE,
  FICTITIOUS_PLATFORM,
  isPlatformMatricule,
  mailleLevelOf,
  MOTIF_PRESENCE,
  NATURES,
  SCHEME_ID_SIREN,
  SCHEME_ID_SIRET,
  SIREN_RE,
  TYPE_FLUX,
} from '../../src/annuaire/nomenclature.js'

describe('nomenclatures annuaire (ANNEXE 3 v1.8 / Annuaire_Commun.xsd)', () => {
  it('expose les codes réglementaires ancrés', () => {
    expect(NATURES).toEqual(['D', 'M']) // Définition / Masquage (DT-7-2)
    expect(SCHEME_ID_SIREN).toBe('0002')
    expect(SCHEME_ID_SIRET).toBe('0009')
    expect(TYPE_FLUX).toEqual(['C', 'D']) // Complet / Différentiel (F14)
    expect(MOTIF_PRESENCE).toEqual(['C', 'P', 'S'])
    expect(DIFFUSIBLE).toEqual(['O', 'P', 'M'])
    expect(FICTITIOUS_PLATFORM).toBe('9998') // plateforme non-routante par défaut (§3.5.3)
  })

  it('valide les identifiants aux patterns du XSD commun', () => {
    expect(SIREN_RE.test('123456789')).toBe(true)
    expect(SIREN_RE.test('12345')).toBe(false)
    expect(DATE_RE.test('20260905')).toBe(true) // AAAAMMJJ
    expect(DATE_RE.test('20261305')).toBe(false) // mois 13
    expect(isPlatformMatricule('9998')).toBe(true)
    expect(isPlatformMatricule('99')).toBe(false)
  })

  it('déduit le niveau de maille (F13 row 25)', () => {
    expect(mailleLevelOf({ siren: '1'.repeat(9) })).toBe('SIREN')
    expect(mailleLevelOf({ siren: '1'.repeat(9), siret: '1'.repeat(14) })).toBe('SIREN_SIRET')
    expect(mailleLevelOf({ siren: '1'.repeat(9), siret: '1'.repeat(14), routageId: 'SVC' })).toBe('SIREN_SIRET_ROUTAGE')
    expect(mailleLevelOf({ siren: '1'.repeat(9), suffixe: 'X' })).toBe('SIREN_SUFFIXE')
  })
})
```
Run: `pnpm --filter @factelec/api test -- annuaire-nomenclature` → RED (module absent).

- [ ] **Step 2 : Implémentation (GREEN)** — `nomenclature.ts` : constantes `as const` + regex **copiées des patterns du XSD commun** (SIREN `[0-9]{9}`, SIRET `[0-9]{14}`, matricule `[0-9]{4}`, `DATE_RE`/`HORODATE_RE` verbatim des `xs:pattern`). `mailleLevelOf` déduit le niveau depuis la présence de `siret`/`routageId`/`suffixe` (les 4 mailles F13 row 25). Commentaire d'en-tête : **codes NORMATIFS, ne jamais altérer** (audit d'immatriculation).

- [ ] **Step 3 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): nomenclatures annuaire et mailles d'adressage (nature, qualifiants, TypeFlux)"
```
Expected: PASS, couverture ≥ 90 %×4 (module pur 100 %).

---

### Task 2 : Modèle de ligne d'adressage + validité & résolution (module pur)

**Files:**
- Create: `apps/api/src/annuaire/ligne-adressage.ts`
- Create: `apps/api/tests/unit/ligne-adressage.test.ts`

**Interfaces:**
- Consumes : Task 1 (nomenclatures, mailles).
- Produces (Tasks 3-5-7) : types `Maille`, `LigneAdressage` (maille + `dateDebut`/`dateFin?` + `plateforme` + `nature`), `mailleKey(maille): string`, `isInForce(ligne, dateYmd): boolean` (semi-ouvert, D4), `overlaps(a, b): boolean`, `resolveRecipient(lignes, maille, dateYmd): string` (matricule ; lève `RecipientUnaddressableError` si aucune), `RecipientUnaddressableError`.

- [ ] **Step 1 : Tests (RED) — validité semi-ouverte, chevauchement, résolution**

`apps/api/tests/unit/ligne-adressage.test.ts` :
```ts
import { describe, expect, it } from 'vitest'
import {
  isInForce,
  mailleKey,
  overlaps,
  RecipientUnaddressableError,
  resolveRecipient,
  type LigneAdressage,
} from '../../src/annuaire/ligne-adressage.js'

const siren = '123456789'
const ligne = (over: Partial<LigneAdressage>): LigneAdressage => ({
  maille: { siren }, nature: 'D', dateDebut: '20260101', dateFin: undefined,
  plateforme: '0007', ...over,
})

describe('validité semi-ouverte [DateDebut, DateFin) (D4, ANNEXE 3 F13 rows 23-24)', () => {
  it('inclut la date de début, exclut la date de fin', () => {
    const l = ligne({ dateDebut: '20260901', dateFin: '20260910' })
    expect(isInForce(l, '20260901')).toBe(true) // début inclus
    expect(isInForce(l, '20260909')).toBe(true)
    expect(isInForce(l, '20260910')).toBe(false) // fin EXCLUE (J=DateFin)
    expect(isInForce(l, '20260831')).toBe(false)
  })
  it('sans DateFin : en vigueur indéfiniment à partir du début', () => {
    expect(isInForce(ligne({ dateDebut: '20260101' }), '20991231')).toBe(true)
  })
})

describe('chevauchement de mailles identiques', () => {
  it('détecte deux définitions qui se recouvrent', () => {
    const a = ligne({ dateDebut: '20260101', dateFin: '20260201' })
    const b = ligne({ dateDebut: '20260115', dateFin: '20260301' })
    expect(overlaps(a, b)).toBe(true)
  })
  it('des périodes jointives ne se chevauchent pas (semi-ouvert)', () => {
    const a = ligne({ dateDebut: '20260101', dateFin: '20260201' })
    const b = ligne({ dateDebut: '20260201', dateFin: '20260301' })
    expect(overlaps(a, b)).toBe(false)
  })
})

describe('résolution du routage (maille la plus spécifique en vigueur)', () => {
  it('préfère SIREN_SIRET à SIREN', () => {
    const lignes = [
      ligne({ maille: { siren }, plateforme: '0001' }),
      ligne({ maille: { siren, siret: '1'.repeat(14) }, plateforme: '0002' }),
    ]
    expect(resolveRecipient(lignes, { siren, siret: '1'.repeat(14) }, '20260601')).toBe('0002')
  })
  it('ignore une ligne masquée (Nature=M) et lève si non adressable', () => {
    const lignes = [ligne({ nature: 'M', dateDebut: '20260101' })]
    expect(() => resolveRecipient(lignes, { siren }, '20260601')).toThrow(RecipientUnaddressableError)
  })
})
```
Run: `pnpm --filter @factelec/api test -- ligne-adressage` → RED.

- [ ] **Step 2 : Implémentation (GREEN)** — `ligne-adressage.ts` : comparaison **lexicographique** des dates `AAAAMMJJ` (largeur fixe, valide comme en 2.3 `invoicesForPeriod`). `isInForce` = `debut ≤ d && (fin === undefined || d < fin)`. `overlaps` = mailles identiques (`mailleKey` égales) ET intervalles semi-ouverts sécants. `resolveRecipient` : filtrer `nature==='D'` en vigueur, grouper par spécificité de maille (`SIREN_SIRET_ROUTAGE`/`SIREN_SUFFIXE` > `SIREN_SIRET` > `SIREN`), retirer les mailles masquées (`nature==='M'` en vigueur), retourner le matricule de la plus spécifique ; sinon `throw new RecipientUnaddressableError(...)`. Commentaire d'en-tête **D4** citant ANNEXE 3 F13 rows 23-25.

- [ ] **Step 3 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): modèle de ligne d'adressage, validité semi-ouverte et résolution de routage"
```

---

### Task 3 : Génération Flux 13 (Actualisation) + Parseur Flux 14 (Consultation), XSD-validés

**Files:**
- Create: `apps/api/src/annuaire/flux13-xml.ts`, `apps/api/src/annuaire/flux14-parse.ts`
- Create: `apps/api/tests/helpers/annuaire-xsd.ts`, `apps/api/tests/unit/flux13-xml.test.ts`, `apps/api/tests/unit/flux14-parse.test.ts`
- Create: `apps/api/tests/fixtures/annuaire-f14-minimal.xml`

**Interfaces:**
- Consumes : Tasks 1-2 ; `xmlbuilder2` (déjà présent) ; XSD DGFiP (chemins absolus, lecture seule).
- Produces (Tasks 6-8-9) : `generateActualisationXml(actualisation): string` (XSD-valide `AnnuaireActualisation`) ; `parseConsultationF14(xml): ConsultationF14` (validation XSD + désérialisation en `LigneAdressage[]` + matricules) ; helpers `validateAgainstAnnuaireActualisationXsd(xml)` / `validateAgainstAnnuaireConsultationXsd(xml)`.

- [ ] **Step 1 : Helper de validation XSD (miroir `tests/helpers/ereporting-xsd.ts`)**

`apps/api/tests/helpers/annuaire-xsd.ts` — deux fonctions `validateAgainst…Xsd(xml)` pointant `--schema` sur les XSD **en place** (les `xs:include` du commun sont résolus par `xmllint` depuis le dossier du XSD ; `docs/reglementaire` en **lecture seule**) :
```ts
export const ANNUAIRE_ACTUALISATION_XSD = resolve(
  import.meta.dirname,
  '../../../../docs/reglementaire/specifications-externes-v3.2/3- XSD_v3.2/0 - Annuaire/actualisation/Annuaire_Actualisation_F12-F13.xsd',
)
export const ANNUAIRE_CONSULTATION_XSD = resolve(
  import.meta.dirname,
  '../../../../docs/reglementaire/specifications-externes-v3.2/3- XSD_v3.2/0 - Annuaire/consultation/Annuaire_Consultation_F14.xsd',
)
// … execFileSync('xmllint', ['--noout','--schema', <xsd>, xmlPath]) dans un mkdtemp, cf. ereporting-xsd.ts
```

- [ ] **Step 2 : Tests (RED) — génération F13 XSD-valide + ordre masquage-avant-définition**

`apps/api/tests/unit/flux13-xml.test.ts` :
```ts
import { describe, expect, it } from 'vitest'
import { generateActualisationXml } from '../../src/annuaire/flux13-xml.js'
import { validateAgainstAnnuaireActualisationXsd } from '../helpers/annuaire-xsd.js'

const base = {
  codesRoutage: [],
  lignes: [
    { nature: 'D' as const, dateDebut: '20260901', dateFin: undefined,
      maille: { siren: '123456789', siret: '12345678900011' }, plateforme: '0007' },
  ],
}

describe('generateActualisationXml (Annuaire_Actualisation_F12-F13.xsd)', () => {
  it('produit un XML valide contre le XSD DGFiP actualisation', () => {
    const { valid, errors } = validateAgainstAnnuaireActualisationXsd(generateActualisationXml(base))
    expect(errors).toBe('')
    expect(valid).toBe(true)
  })
  it('émet Nature/DateEffet/InfoAdressage imbriqué + qualifiant requis', () => {
    const xml = generateActualisationXml(base)
    expect(xml).toContain('<AnnuaireActualisation>')
    expect(xml).toContain('<BlocLignesAnnuaire>')
    expect(xml).toContain('<Nature>D</Nature>')
    expect(xml).toContain('<DateDebut>20260901</DateDebut>')
    expect(xml).toContain('qualifiant="0002"') // IdLinSIREN@qualifiant (XSD required)
    expect(xml).toContain('<IdPlateforme>0007</IdPlateforme>')
  })
  it('émet les lignes de masquage AVANT les définitions (F13 row 20)', () => {
    const xml = generateActualisationXml({ ...base, lignes: [
      { ...base.lignes[0] },
      { nature: 'M' as const, dateDebut: '20260801', dateFin: undefined,
        maille: { siren: '123456789' }, plateforme: '0007' },
    ]})
    expect(xml.indexOf('<Nature>M</Nature>')).toBeLessThan(xml.indexOf('<Nature>D</Nature>'))
    expect(validateAgainstAnnuaireActualisationXsd(xml).valid).toBe(true)
  })
  it('échappe les caractères XML dangereux (injection-proof)', () => {
    // suffixe arbitraire porté par un tenant — jamais concaténé nu
    const xml = generateActualisationXml({ ...base, lignes: [
      { ...base.lignes[0], maille: { siren: '123456789', suffixe: 'A & <B>' } },
    ]})
    expect(xml).toContain('A &amp; &lt;B&gt;')
  })
})
```

`apps/api/tests/unit/flux14-parse.test.ts` (RED) : charge `tests/fixtures/annuaire-f14-minimal.xml` (une `AnnuaireConsultationF14` XSD-valide avec 1 `LigneAnnuaire`), attend `validateAgainstAnnuaireConsultationXsd(fixture).valid === true`, et `parseConsultationF14(fixture)` renvoie `{ typeFlux, horodate, lignes:[{ maille:{siren,…}, nature, dateDebut, dateFin?, plateforme }] }` avec les valeurs exactes de la fixture ; un XML **invalide** (matricule à 3 chiffres) → `parseConsultationF14` **lève** (validation XSD d'abord).

Run: `pnpm --filter @factelec/api test -- flux13-xml flux14-parse` → RED.

- [ ] **Step 3 : Implémentation (GREEN)**

> **Découverte empirique (risque #1/#2)** : XSD sans `targetNamespace` → **instance sans préfixe**. F13 = `InfoAdressageActualisationType` (identifiants **imbriqués** sous `Identifiant`) ; F14 = `InfoAdressageConsultationType` (`Identifiant` texte + `IdLinSIREN`/… **plats**). Ajuster **jusqu'à ce que `xmllint` passe** (sentinelle). Golden capté après vert.

`flux13-xml.ts` : `create({ version:'1.0', encoding:'UTF-8' }).ele('AnnuaireActualisation')` → si `codesRoutage.length` : `BlocCodesRoutage` (chaque `CodeRoutage` : `Statut`/`IdSIRET@qualifiant`/`IdRoutage@qualifiant`/`Nom`) → `BlocLignesAnnuaire` : lignes **triées M avant D** (F13 row 20), chaque `LigneAnnuaire` : `Nature`, `DateEffet`(`DateDebut`[+`DateFin`]), `InfoAdressage`→`Identifiant`→(`IdLinSIREN` att `qualifiant=0002`, `IdLinSIRET` att `qualifiant=0009` si présent, `IdLinRoutage` att `qualifiant` si présent, `Suffixe` si présent), `IdPlateforme`. `xmlbuilder2` échappe `&`/`<`/`>`/`"` par construction.

`flux14-parse.ts` : `validateAgainstAnnuaireConsultationXsd(xml)` d'abord (lève si invalide, réutilise le helper via un petit validateur de prod `annuaire-xsd-validator.ts` — miroir `ereporting-xsd-validator.ts` : `xmllint` en `execFile`, outillage manquant → `throw` retry, invalide → erreur typée), puis `create(xml).end({ format:'object' })` → mapper `AnnuaireConsultationF14.BlocLignesAnnuaire.LigneAnnuaire[]` en `LigneAdressage[]` (Task 2), extraire `TypeFlux`/`HorodateProduction` et `BlocIdPlateformesReception` (matricules). Normaliser la cardinalité 1 vs n (xmlbuilder2 renvoie objet vs tableau).

Run → **ajuster jusqu'à XSD verte** puis PASS.

- [ ] **Step 4 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test && pnpm run audit:ci && pnpm outdated -r
git add -A
git commit -m "feat(api): génération Flux 13 et parseur Flux 14 annuaire validés contre les XSD DGFiP"
```
Expected: PASS, 2 XSD vertes, couverture ≥ 90 %×4, audit 0, outdated vierge.

---

### Task 4 : Machine à états publication annuaire (module pur)

**Files:**
- Create: `apps/api/src/annuaire/annuaire-lifecycle.ts`
- Create: `apps/api/tests/unit/annuaire-lifecycle.test.ts`

**Interfaces:**
- Consumes : rien.
- Produces (Tasks 5-8) : `ANNUAIRE_STATUS_META` (`draft`/`published`/`deposee`/`rejetee`/`masked`), `canTransition`, `isTerminal`, `motifRequired`, `assertTransition`, `AnnuaireLigneStatus`, `InvalidAnnuaireTransitionError`.

> **Miroir structurel de `src/ereporting/ereporting-lifecycle.ts` mais SÉPARÉ (D6)**. États internes PA `draft`→`published` puis acquittement PPF `deposee` (déposée/acceptée, terminal) ⊕ `rejetee` (terminal, **motif requis**) ; chemin `masked` (fin d'adressage, terminal) atteignable depuis `deposee` (une ligne en vigueur qu'on masque). Pas de code réglementaire « Tableau » pour l'annuaire → `code: null` partout (pas de faux code DGFiP, leçon 2.3-A3). Motif de rejet = **chaîne libre** (D6).

- [ ] **Step 1 : Tests (RED)** — calquer `ereporting-lifecycle.test.ts` : `canTransition('draft','published')`, `('published','deposee')`, `('published','rejetee')`, `('deposee','masked')` vrais ; `isTerminal('rejetee')`/`isTerminal('masked')` vrais ; `motifRequired('rejetee')` vrai / `motifRequired('deposee')` faux ; `assertTransition('draft','deposee')` lève `InvalidAnnuaireTransitionError`.

- [ ] **Step 2 : Implémentation (GREEN)** — calquer `ereporting-lifecycle.ts` : `ALLOWED: Record<Status, Status[]>` = `{ draft:['published'], published:['deposee','rejetee'], deposee:['masked'], rejetee:[], masked:[] }`, `TERMINAL = new Set(['rejetee','masked'])` (`deposee` **non terminal** : une ligne déposée peut être masquée), `Object.hasOwn` garde de type, erreur typée. Commentaire d'en-tête **D6** (distinct CDV/e-reporting, non scellé, motif libre).

- [ ] **Step 3 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): machine à états de publication annuaire (draft→published→déposée/rejetée, masquage)"
```

---

### Task 5 : Persistance — consentements, lignes, journal, miroir (RLS `FORCE`, moindre privilège)

**Files:**
- Modify: `apps/api/src/db/schema.ts` (enums + 4 tables)
- Create: `apps/api/src/db/migrations/0018_annuaire_tables.sql` (drizzle) + snapshot + `_journal`
- Create: `apps/api/src/db/migrations/0019_annuaire_rls.sql` (hand : RLS/grants + SD `find_annuaire_sync_targets`)
- Create: `apps/api/src/annuaire/annuaire.repository.ts`
- Create: `apps/api/tests/e2e/annuaire-persistence.e2e.test.ts`

**Interfaces:**
- Consumes : Tasks 1-2-4, `TenantContextService` (`runInTenant`).
- Produces (Tasks 7-8-9) : tables `annuaire_consents`/`annuaire_lignes`/`annuaire_ligne_events`/`annuaire_directory_entries` sous RLS `FORCE` ; SD cross-tenant `find_annuaire_sync_targets` ; repository (`insertConsent`, `findActiveConsent`, `insertLigne` [+ événement `draft`], `markPublished`, `appendLigneEvent`, `listLignes`, `listLigneEvents`, `upsertDirectoryEntries`, `findDirectoryEntries`).

- [ ] **Step 1 : Schéma (enums + tables)** — `schema.ts`, calquer les idiomes `ereporting*` (uuid pk, `tenantId` FK cascade, index tenant, `createdAt` tz). Enums : `annuaireNature` (`D`/`M`), `annuaireLigneStatus` (`draft`/`published`/`deposee`/`rejetee`/`masked`, aligné `ANNUAIRE_STATUS_META`). Tables :
  - `annuaire_consents` : `tenantId`, `siren`, `siret?`, `routageId?`, `suffixe?` (portée maille), `consentType text`, `signerIdentity text`, `evidenceRef text`, `obtainedAt tz`, `revokedAt tz?`, `createdAt`. Index `(tenantId, siren)`.
  - `annuaire_lignes` (publications) : `tenantId`, `siren`, `siret?`, `routageId?`, `suffixe?`, `nature annuaireNature`, `dateDebut text`(AAAAMMJJ), `dateFin text?`, `plateforme text`(matricule), `status annuaireLigneStatus default 'draft'`, `consentId uuid FK annuaire_consents restrict`, `trackingRef text?`, `rejectReason text?`, `createdAt`/`updatedAt`. **Unique partiel** `(tenantId, siren, coalesce(siret,''), coalesce(routageId,''), coalesce(suffixe,''), dateDebut) WHERE nature='D'` (D11 : une définition par maille×date ; les masquages libres — miroir de l'index partiel `type='IN'` 2.3).
  - `annuaire_ligne_events` (journal append-only, NON scellé) : `tenantId`, `ligneId uuid FK restrict`, `fromStatus annuaireLigneStatus?`, `toStatus annuaireLigneStatus`, `motif text?`, `actor text`, `createdAt`. Index `(ligneId, createdAt)`.
  - `annuaire_directory_entries` (miroir de consultation) : `tenantId`, `idInstance bigint?`, `siren`, `siret?`, `routageId?`, `suffixe?`, `nature annuaireNature`, `dateDebut text`, `dateFin text?`, `plateforme text`, `sourceHorodate text?`, `createdAt`/`updatedAt`. **Unique** `(tenantId, siren, coalesce(siret,''), coalesce(routageId,''), coalesce(suffixe,''), dateDebut)` (upsert idempotent de la sync — backstop DB, D9). Index `(tenantId, siren)`.

- [ ] **Step 2 : Migration drizzle (0018)** — `db:generate` → renommer `0018_annuaire_tables.sql`, tag idx 18. Relire : `CREATE TYPE` des 2 enums + `CREATE TABLE` des 4 tables + index/uniques partiels. Aucune RLS/grant (migration manuelle 0019). Vérifier que le prédicat `WHERE nature='D'` du partiel **survit** à drizzle (leçon 2.3-T5 : le prédicat de l'index partiel doit être présent dans le SQL généré — sinon l'ajouter à la main).

- [ ] **Step 3 : Migration manuelle RLS/grants + SD cross-tenant (0019)** — calquer `0017_ereporting_rls.sql` :
  - RLS `ENABLE`+`FORCE` + policy `tenant_isolation` (`nullif(current_setting('app.tenant_id',true),'')::uuid`) sur **les 4 tables**.
  - Grants différenciés : `annuaire_consents` = `SELECT, INSERT, UPDATE` (révocation via `revokedAt`, pas de DELETE) ; `annuaire_lignes` = `SELECT, INSERT, UPDATE` (pas de DELETE — masquage = update de statut) ; `annuaire_ligne_events` = `SELECT, INSERT` **seulement** (append-only, immuabilité par grants) ; `annuaire_directory_entries` = `SELECT, INSERT, UPDATE, DELETE` (miroir régénérable par la sync).
  - SD `find_annuaire_sync_targets()` `RETURNS TABLE(tenant_id uuid)` `LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp STABLE` → `SELECT id FROM public.tenants ORDER BY id` (tous les tenants — la sync peuple la vue de chacun ; l'habilitation réelle est différée, D8), `REVOKE ALL … FROM PUBLIC` + `GRANT EXECUTE … TO factelec_app`. Commentaire : miroir `find_ereporting_declarants_due`.
  - Enregistrer 0019 dans `meta/_journal.json` (idx 19, `version:"7"`, `when` epoch-ms, `tag:"0019_annuaire_rls"`, `breakpoints:true`, **sans** snapshot).

- [ ] **Step 4 : Repository** — mêmes idiomes que `EreportingRepository` (`this.tenant.run(tenantId, async (db) => …)`). Points clés :
  - `insertConsent` (INSERT preuve) ; `findActiveConsent(tenantId, maille)` (consentement non révoqué couvrant la maille — gate Task 8).
  - `insertLigne` : INSERT (statut `draft`, `consentId` requis) **+ événement `draft` (from=NULL, actor='platform')** dans la **même transaction** (miroir `insertTransmission`). Sur conflit unique partiel `nature='D'` → 23505 propagé (409 à l'API) ou `onConflictDoNothing`+reload selon le besoin d'idempotence (choisir la même politique que 2.3 : reload `created:false`).
  - `markPublished` (CAS `draft`→`published` + `trackingRef` + journal, miroir `markTransmitted`).
  - `appendLigneEvent` (CAS générique `assertTransition`+`motifRequired`, miroir `EreportingRepository.appendStatusEvent`).
  - `upsertDirectoryEntries(tenantId, entries)` : upsert idempotent sur la clé unique (backstop sync, D9) ; `findDirectoryEntries(tenantId, siren)` (lecture RLS pour la résolution Task 7).

- [ ] **Step 5 : e2e (RED→GREEN) — isolation & append-only** — `annuaire-persistence.e2e.test.ts` (motifs 2.2/2.3 : `startTestDb`, `ownerPool`/`appPool` + écouteur `error`) :
```ts
it('isole les lignes/consentements/miroir par tenant (RLS FORCE)')       // tenant A invisible sous B
it("interdit UPDATE/DELETE sur le journal annuaire (42501)")             // append-only, comme ereporting_status_events
it('find_annuaire_sync_targets voit les tenants de tous les tenants')    // SD cross-tenant
it("rejette une 2e définition sur la même maille×date (23505)")          // unique partiel nature='D'
it('bloque la suppression d’une ligne munie d’un journal (23503)')       // FK restrict
```

- [ ] **Step 6 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): persistance annuaire (consentements, lignes, journal, miroir) sous RLS FORCE et SD cross-tenant"
```

---

### Task 6 : `AnnuairePort` + implémentation locale + factory (transport différé)

**Files:**
- Modify: `apps/api/src/config/env.ts` (+ `ANNUAIRE_DRIVER`, `ANNUAIRE_LOCAL_DIR`, `ANNUAIRE_SYNC_EVERY_MS`, `ANNUAIRE_COMPLETE_EVERY_MS`, `ANNUAIRE_PUBLISH_JOB_ATTEMPTS`)
- Create: `apps/api/src/annuaire/annuaire.port.ts`, `apps/api/src/annuaire/local-filesystem-annuaire-store.ts`, `apps/api/src/annuaire/annuaire-transport.module.ts`
- Modify: `apps/api/tests/unit/env.test.ts`
- Create: `apps/api/tests/unit/local-filesystem-annuaire-store.test.ts`, `apps/api/tests/fixtures/annuaire-f14-minimal.xml` (réutilisée)

**Interfaces:**
- Consumes : env config, Task 3 (fixtures F14).
- Produces (Tasks 8-9) : `ANNUAIRE_TRANSPORT` token + `AnnuairePort` (`publish(payload): Promise<PublishResult>`, `fetchConsultation(typeFlux): Promise<ConsultationResult>`, `publicationStatus(trackingRef): Promise<AnnuaireAckStatus>`) + `LocalFilesystemAnnuaireStore` + `@Global` factory (`throw` documenté sur `api`/`edi`).

- [ ] **Step 1 : Env (RED→GREEN)** — ajouter à `env.ts` (motif `EREPORTING_*`) :
```ts
  ANNUAIRE_DRIVER: z.enum(['local', 'api', 'edi']).default('local'),
  ANNUAIRE_LOCAL_DIR: z.string().default('./var/annuaire'),
  ANNUAIRE_SYNC_EVERY_MS: z.coerce.number().int().positive().default(86_400_000),      // différentiel ~quotidien
  ANNUAIRE_COMPLETE_EVERY_MS: z.coerce.number().int().positive().default(604_800_000), // complet ~hebdo
  ANNUAIRE_PUBLISH_JOB_ATTEMPTS: z.coerce.number().int().positive().default(3),        // D13
```
`env.test.ts` : cas défauts + override driver.

- [ ] **Step 2 : Port + impl locale (miroir `flux10-transmission.port.ts` / `LocalFilesystemTransmissionStore`)** — `annuaire.port.ts` : token `Symbol('ANNUAIRE_TRANSPORT')`, `PublishPayload{ tenantId, publicationRef, xml }`, `PublishResult{ trackingRef, location }`, `ConsultationResult{ typeFlux, xml }`, `AnnuaireAckStatus{ trackingRef, outcome: 'pending'|'deposee'|'rejetee', motif?: string }`, `AnnuairePublishRejectedError`. `local-filesystem-annuaire-store.ts` : `publish` write-once (`wx`+`chmod 0o444`, anti-traversée `SAFE_KEY`/normalize/`..`, `EEXIST`→résultat d'origine — leçon 2.2 appliquée d'emblée), `trackingRef=sha256(xml)` ; `fetchConsultation(typeFlux)` lit un **fixture F14 déterministe** (`ANNUAIRE_LOCAL_DIR/f14-<typeFlux>.xml` s'il existe, sinon un `AnnuaireConsultationF14` **vide XSD-valide** — `TypeFlux` + `HorodateProduction`, blocs absents) ; `publicationStatus`→`pending` par défaut (acquittement appliqué Task 8). Tests : write-once (rejeu idempotent), traversée refusée, `trackingRef` déterministe, `fetchConsultation` renvoie un XML F14 XSD-valide.

- [ ] **Step 3 : Factory `@Global` (miroir `EreportingTransmissionModule`)** — `local`→`LocalFilesystemAnnuaireStore(config.ANNUAIRE_LOCAL_DIR)` ; `api`/`edi`→`throw new Error("driver annuaire '<x>' activé au déploiement (non fourni en 2.4)")`. La branche `throw` est **testée** (factory invoquée avec `ANNUAIRE_DRIVER='api'` → lève) — une ligne couverte.

- [ ] **Step 4 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test && pnpm run audit:ci && pnpm outdated -r
git add -A
git commit -m "feat(api): port annuaire (consultation/publication) et implémentation locale write-once (adaptateurs réels différés)"
```

---

### Task 7 : Service de consultation + résolution de routage + endpoints (dual-auth)

**Files:**
- Create: `apps/api/src/annuaire/annuaire-consultation.service.ts`, `apps/api/src/annuaire/annuaire.controller.ts`, `apps/api/src/annuaire/annuaire.module.ts`
- Modify: `apps/api/src/app.module.ts` (importer `AnnuaireModule`)
- Create: `apps/api/tests/e2e/annuaire-consultation.e2e.test.ts`

**Interfaces:**
- Consumes : Task 2 (`resolveRecipient`), Task 5 (repository `findDirectoryEntries`), guards dual-auth (`TenantAuthGuard`, motif `EreportingController`).
- Produces : `AnnuaireConsultationService.resolveRecipient(tenantId, maille, dateYmd): Promise<{ plateforme }>` ; endpoints `GET /annuaire/lignes?siren=…` (recherche dans le miroir), `GET /annuaire/resolution?siren=…&siret=…&date=AAAAMMJJ` (matricule cible).

- [ ] **Step 1 : Service (GREEN après RED e2e)** — `resolveRecipient` : `findDirectoryEntries(tenantId, siren)` (sous RLS) → mapper en `LigneAdressage[]` → `resolveRecipient(lignes, maille, date)` (Task 2) ; `RecipientUnaddressableError` → 404 anti-fuite à l'API (le destinataire n'est pas adressable / hors périmètre du tenant). **C'est la brique consommée par le futur routage d'émission** (câblage différé, périmètre).

- [ ] **Step 2 : Endpoints (dual-auth)** — `annuaire.controller.ts` : `@UseGuards(TenantAuthGuard)`, `@CurrentTenant()` (motif `EreportingController`), zod sur les query params (SIREN/SIRET/date aux regex Task 1), 404 anti-fuite byte-identique pour un destinataire inconnu/hors-tenant. `annuaire.module.ts` (imports `AuthModule`, `UsersModule` pour le dual-auth ; providers `AnnuaireRepository`, `AnnuaireConsultationService`, `TenantAuthGuard`) — calqué `EreportingModule`. Importer dans `app.module.ts`.

- [ ] **Step 3 : e2e (RED→GREEN)** — `annuaire-consultation.e2e.test.ts` : seed miroir (2 lignes SIREN + SIREN_SIRET pour un tenant), `GET /annuaire/resolution` renvoie le matricule de la maille la plus spécifique ; date hors période → 404 ; **isolation** (miroir du tenant A invisible pour B, 404 byte-identique) ; dual-auth (clé API **et** session).

- [ ] **Step 4 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): service de consultation annuaire et résolution de routage (endpoints dual-auth, isolation)"
```

---

### Task 8 : Publication consent-gated + émission Flux 13 + acquittements (dual-auth)

**Files:**
- Create: `apps/api/src/annuaire/annuaire-publication.service.ts`
- Modify: `apps/api/src/annuaire/annuaire.controller.ts` (+ mutations), `apps/api/src/annuaire/annuaire.module.ts` (+ service, port)
- Create: `apps/api/tests/e2e/annuaire-publication.e2e.test.ts`

**Interfaces:**
- Consumes : Task 2 (validité/chevauchement), Task 3 (`generateActualisationXml` + validation), Task 4 (machine à états), Task 5 (repository + gate consentement), Task 6 (port), guards dual-auth.
- Produces : `AnnuairePublicationService.publishLigne(tenantId, input)` (gate consentement → insert `draft` → F13 XSD-validé → `transmit` port → `markPublished`) ; `recordAck(tenantId, ligneId, outcome, motif?)` (`published`→`deposee`/`rejetee` via `assertTransition`+`motifRequired`) ; `maskLigne(...)` ; endpoints `POST /annuaire/lignes`, `PUT /annuaire/lignes/:id` (fin d'effet), `DELETE /annuaire/lignes/:id` (masquage).

- [ ] **Step 1 : Service (GREEN après RED e2e)** — `publishLigne` :
  1. **gate consentement** : `findActiveConsent(tenantId, maille)` ; absent → **422** (`ProblemType`, D5) **avant** toute écriture ;
  2. valider la ligne (dates `[début,fin)`, pas de chevauchement avec une définition existante — sinon 409/422) ;
  3. `insertLigne(…, consentId)` (statut `draft` + événement) ;
  4. `generateActualisationXml({ lignes:[…] })` **puis valider XSD** (le service **rejette** un XML non-valide → ligne `rejetee` motif `xsd-invalide` sans appel au port — miroir born-rejetee 2.3-T8) ;
  5. `transmit`(payload) via le port → `markPublished(trackingRef)` (`draft`→`published`).
  `recordAck` applique `published`→`deposee`/`rejetee` (**motif requis** pour rejet, D13) via la machine à états + journal (`actor='ppf'`). **La source de l'acquittement (push PPF) est différée (D7)** : le service est la **frontière** exercée directement par les e2e. **Succès partiel au grain ligne** (D13) : chaque ligne a son propre statut.

- [ ] **Step 2 : Endpoints (dual-auth)** — `POST /annuaire/lignes` (body zod : maille + nature + dates + plateforme + `consentId` **ou** preuve), `PUT :id` (fin d'effet), `DELETE :id` (masquage → `maskLigne`) ; 422 sans consentement, 409 sur chevauchement, 404 anti-fuite hors-tenant. Ajouter `AnnuairePublicationService` + `ANNUAIRE_TRANSPORT` (via `AnnuaireTransportModule`) au `AnnuaireModule`.

- [ ] **Step 3 : e2e (RED→GREEN)** — `annuaire-publication.e2e.test.ts` :
```ts
it('REFUSE la publication sans consentement actif (422)')                 // gate D5, avant toute écriture
it('publie une ligne consentie : draft→published, F13 XSD-valide persisté, trackingRef non nul')
it('applique un acquittement déposée (published→deposee) puis un masquage (deposee→masked)')
it('applique un rejet avec motif (published→rejetee) ; refuse un rejet sans motif (422)')
it('refuse une 2e définition chevauchante sur la même maille (409)')      // D11
it('isole les lignes par tenant (404 hors-tenant)')
```

- [ ] **Step 4 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): publication annuaire consent-gated, émission Flux 13 XSD-validée et acquittements PPF"
```

---

### Task 9 : Ordonnanceur de synchronisation + worker d'ingestion Flux 14

**Files:**
- Create: `apps/api/src/annuaire/… ` (rien de neuf) ; `apps/api/src/worker/annuaire-sync.service.ts`, `annuaire-sweep.service.ts`, `annuaire.scheduler.ts`, `annuaire-sync.processor.ts`
- Modify: `apps/api/src/worker/maintenance.processor.ts`, `apps/api/src/worker/worker.module.ts`
- Modify: `apps/api/src/queue/queue.constants.ts` (+ `ANNUAIRE_SYNC_QUEUE`), `apps/api/src/queue/maintenance.job.ts` (+ `ANNUAIRE_SYNC_DIFF_JOB`/`ANNUAIRE_SYNC_FULL_JOB`)
- Create: `apps/api/src/queue/annuaire-sync.job.ts`
- Modify: `apps/api/tests/e2e/helpers/worker.ts` (override du port annuaire par un stub en mémoire)
- Create: `apps/api/tests/e2e/annuaire-sync.e2e.test.ts`

**Interfaces:**
- Consumes : Task 3 (`parseConsultationF14`), Task 5 (repository `upsertDirectoryEntries`, SD `find_annuaire_sync_targets`), Task 6 (port `fetchConsultation`), BullMQ.
- Produces : deux jobs répétables (`ANNUAIRE_SYNC_DIFF_JOB` quotidien `TypeFlux='D'` / `ANNUAIRE_SYNC_FULL_JOB` hebdo `TypeFlux='C'`) → sweep énumère les tenants (SD) → enfile un job `annuaire-sync` par tenant → worker : `fetchConsultation` → **validation XSD** → `parseConsultationF14` → `upsertDirectoryEntries` (application des masquages, borné/idempotent).

- [ ] **Step 1 : Scheduler + sweep + worker (miroir `EreportingScheduler`/`EreportingSweepService`)**
  - `annuaire.scheduler.ts` : `OnApplicationBootstrap` → `upsertJobScheduler('annuaire-sync-diff', { every: ANNUAIRE_SYNC_EVERY_MS }, { name: ANNUAIRE_SYNC_DIFF_JOB })` **et** `upsertJobScheduler('annuaire-sync-full', { every: ANNUAIRE_COMPLETE_EVERY_MS }, { name: ANNUAIRE_SYNC_FULL_JOB })` (clés dédiées, coexistent avec `ereporting-sweep`/`archive-retry`/… sur `maintenance`).
  - `maintenance.processor.ts` : brancher les deux `job.name` → `annuaireSweep.sweep('D'|'C')`.
  - `annuaire-sweep.service.ts` : `SELECT tenant_id FROM find_annuaire_sync_targets()` (APP_POOL direct, hors contexte tenant — motif `EreportingSweepService`) → pour chaque tenant, enfile un job `annuaire-sync` sur `ANNUAIRE_SYNC_QUEUE` avec **jobId déterministe** `${tenantId}:${typeFlux}:${bucket}` (`bucket` = fenêtre bornée, discipline 2.3-A2 : le balayage ne ré-ingère jamais tout l'historique ; BullMQ déduplique par jobId).
  - `annuaire-sync.processor.ts` (`@Processor(ANNUAIRE_SYNC_QUEUE)`) : `fetchConsultation(typeFlux)` via le port → **valider XSD** (outillage manquant → throw retry ; invalide → log+skip, jamais une corruption du miroir) → `parseConsultationF14` → `runInTenant(tenantId)` `upsertDirectoryEntries` (upsert idempotent = **backstop DB** via la clé unique ; masquages appliqués). **3 couches anti-corruption/doublon** (leçon 2.3) : (1) fenêtre bornée du sweep, (2) jobId déterministe, (3) unique DB du miroir.

- [ ] **Step 2 : e2e (RED→GREEN)** — `annuaire-sync.e2e.test.ts` (Postgres réel, override du port par un **stub F14 en mémoire** dans le helper worker — motif `InMemoryTransmissionSink` 2.3) :
```ts
it('ingère un F14 différentiel dans le miroir du tenant (parse → upsert)')  // 1 ligne → 1 directory_entry
it('est idempotent : re-sync du même F14 ne duplique pas (unique DB)')      // backstop D9
it('applique un masquage F14 (Nature=M) au miroir')                        // maille non résolue ensuite
it('isole le miroir par tenant (RLS)')
```

- [ ] **Step 3 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): ordonnanceur de synchronisation annuaire et worker d'ingestion Flux 14 (borné, idempotent)"
```

---

### Task 10 : CI / docs / OpenAPI / bump version — clôture

**Files:**
- Modify: `README.md` racine, `apps/api/README.md`
- Modify: OpenAPI/Swagger (nouveaux endpoints `annuaire/*`)
- Modify: `apps/api/package.json` (`version` → `0.6.0`)

- [ ] **Step 1 : Documentation honnête** — décrire : annuaire = registre **PPF-hosted** ⇒ livrable pré-accréditation = **domaine PA** (D1) ; ligne d'adressage (4 mailles), **intervalle semi-ouvert `[début, fin)`** (D4, ambiguïté #5 résolue) ; **XSD annuaire strictement typés** validés dans les 2 directions (D3, correction du dossier) ; **consentement obligatoire** avant publication (D5, ambiguïté #1) ; cycle de vie publication **distinct** + journal **non scellé** (D6) ; **port différé** + **adaptateurs réels API/EDI au déploiement** (D7) ; **miroir tenant-scopé** (D8, PII) ; cadence **différentiel quotidien / complet hebdo** bornée + **J+1** + **interprétations go-live** (D9, ambiguïté #6) ; **suffixe/collision intra-tenant** + **codes routage standalone différés** (D11, ambiguïté #4) ; **init modélisée non chargée** (`9998`/Chorus, D12) ; **succès partiel + retry** (D13, ambiguïté #2) ; nomenclature `ANNUAIRE_*` env ; endpoints. **Feuille de route** : adaptateurs transport réels + feed d'initialisation + habilitations (déploiement), câblage de la résolution dans l'émetteur, codes routage, schematron/ANNEXE 7, connecteur consentement.
  - **RUNBOOK** (miroir dette slot 2.3) : documenter la contrainte unique partielle `nature='D'` (une définition par maille×date), la nécessité du masquage-avant-redéfinition, et le prérequis `libxml2` sur l'hôte worker.

- [ ] **Step 2 : Bump version + gate finale + commit**
```bash
# apps/api/package.json : "version": "0.6.0" (phase 2.4 : annuaire Flux 13/14)
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm test && pnpm run audit:ci && pnpm outdated -r
git add -A
git commit -m "docs(api): documentation annuaire Flux 13/14 et bump version 0.6.0"
```
Expected: tout vert ; couverture invoice-core 100 %, apps/api ≥ 90 %×4, apps/web ≥ 90 %×4 ; audit:ci 0 ; outdated vierge.

---

## Self-Review (relecture contre la spec §3.5 / ANNEXE 3 / XSD annuaire / Swagger v1.11.0 et le cadrage 2.4)

**1. Couverture du cadrage :**
- Annuaire = registre PPF-hosted, livrable = domaine PA (D1) → Tasks 1-9. ✅
- Ligne d'adressage (4 mailles, semi-ouvert, résolution la plus spécifique) → Task 2 (D4). ✅
- **XSD annuaire réels validés dans les 2 directions** (F13 génération + F14 parsing) → Task 3 (D3, corrige l'omission du dossier). ✅
- Consultation → résolution de routage (la brique du flux de facturation) → Task 7. ✅
- Publication consent-gated + F13 + acquittements → Tasks 5/8 (D5/D6/D13). ✅
- Sync différentiel/complet borné, idempotent → Task 9 (D9). ✅
- Port différé (contrat + local testable ; adaptateurs réels au déploiement, `throw` testé) → Tasks 6/8/9 (D7). ✅
- RLS FORCE + moindre privilège + SD `search_path=pg_catalog,pg_temp` schéma-qualifié + journal append-only non scellé → Task 5. ✅
- Réutilisation (Invoice, BullMQ, drizzle/RLS/SD, dual-auth) → Tasks 5/7/8/9 (D10). ✅
- Aucune dette dépendances (aucun ajout — xmlbuilder2/xmllint réutilisés, audit 0/outdated vierge) → Tasks 3/6/10. ✅

**2. Les 6 ambiguïtés du dossier, toutes tranchées (pas d'inventé) :**
- #1 Consentement → **exigence ancrée** (§3.5.5.5) + gate 422 ; **modèle de données = interprétation go-live** (D5).
- #2 Erreurs Flux 13 → succès partiel au grain ligne + retry BullMQ dédié ; **compte de retries = interprétation** (D13).
- #3 Frontière local/réel → env `ANNUAIRE_DRIVER`, local testé, réel `throw` testé (D7).
- #4 Collision suffixe → unicité **intra-tenant** garantie ; **inter-PA = concern PPF différé** (D11).
- #5 Bornes de date → **semi-ouvert `[début, fin)`** ferme, ancré ANNEXE 3 F13 rows 23-24 (D4).
- #6 Cadence → quotidien/hebdo borné + J+1 ; **fenêtres exactes = interprétation go-live** (D9).

**3. Interprétations marquées go-live (jamais fabriquées) :** instance XML sans namespace (confirmée au 1er `xmllint`, D3/A1) ; modèle de données du consentement (D5) ; motif de rejet chaîne libre — pas d'énum normatif annuaire (D6) ; fenêtres de cadence exactes + mécanique J+1 (D9) ; collision suffixe inter-PA (D11) ; lignes par défaut `9998`/Chorus non chargées (D12) ; nombre de retries/DLQ (D13) ; scoping du miroir par habilitation réelle (D8).

**4. Cohérence des types & migrations :** `Maille`/`LigneAdressage` partagés Tasks 2-3-5-7-9 ; `AnnuaireLigneStatus` partagé Tasks 4-5-8 ; enums Drizzle (`annuaire_ligne_status`) alignés `ANNUAIRE_STATUS_META` ; port `AnnuairePort`/`ANNUAIRE_TRANSPORT` cohérent impl locale ↔ factory ↔ services ↔ worker ; migrations **0018 (drizzle) → 0019 (hand)** contiguës après 0017 ; SD `find_annuaire_sync_targets` calquée sur `find_ereporting_declarants_due`.

## Amendements possibles à l'exécution (à valider empiriquement)

- **A1** — **Qualification XML** : XSD annuaire sans `targetNamespace`/`elementFormDefault` → instance sans préfixe (Task 3). Si `xmllint` exige une qualification, ajuster générateur/parseur jusqu'au vert (sentinelle). Confirmer au 1er run.
- **A2** — **Forme minimale XSD-valide** : les séquences `LigneAnnuaire` (F13) et les blocs F14 imposent l'ORDRE des éléments ; si `xmllint` rejette, réordonner selon les XSD (ex. `Nature`→`DateEffet`→`InfoAdressage`→`IdPlateforme`). Golden capté après vert.
- **A3** — **F13 vs F14 InfoAdressage** : F13 imbrique les identifiants sous `Identifiant` (`InfoAdressageActualisationType`) ; F14 les met plats (`InfoAdressageConsultationType`) — cibler chacun son type (risque #2).
- **A4** — **Override du port annuaire dans le worker e2e** : propager `ANNUAIRE_TRANSPORT` dans `WorkerModule` (helper `worker.ts`), même mécanique que l'override `FLUX10_TRANSMISSION`/`ARCHIVE_STORE` (2.1/2.2/2.3).
- **A5** — **Unique partiel `nature='D'`** : vérifier que drizzle conserve le prédicat `WHERE nature='D'` dans le SQL généré (leçon 2.3-T5) ; sinon l'ajouter à la main dans 0018.
- **A6** — **`bucket` du jobId de sync** : dériver une fenêtre bornée déterministe (ex. jour civil pour le différentiel, semaine ISO pour le complet) passée en paramètre du sweep — aucun `Date.now()` caché dans la logique pure.
- **A7** — **Contrainte unique du miroir avec colonnes nullables** : utiliser `coalesce(col,'')` dans l'index unique (SIRET/routage/suffixe nullables) pour un upsert idempotent déterministe.

## Execution Handoff

Plan complet, sauvegardé dans `docs/superpowers/plans/2026-07-16-phase2-4-annuaire-flux13-14.md`. Deux options :
1. **Subagent-Driven (recommandé)** — un subagent frais par tâche, revue Opus entre chaque (aligné 1.x/2.x/2.3).
2. **Inline** — exécution par lots avec points de contrôle.

**Recommandations fermes de périmètre (le contrôleur ratifie — aucune question ouverte laissée) :**
- **R1 — Domaine dans `apps/api/src/annuaire/*`** (pas de nouveau package) — précédent `ereporting`/`archive`/`ledger`, arbitrage 2.3-Q2 déjà tranché. **Retenu.**
- **R2 — Valider les DEUX directions contre les XSD annuaire réels** (F13 génération + F14 parsing) : le dossier les avait omis ; ils existent et sont strictement typés → la validation XSD est plus forte qu'en 2.3 et **doit** être exploitée. **Retenu.**
- **R3 — Miroir de consultation TENANT-SCOPÉ** (pas de pool global) : discipline RLS uniforme + PII-safe ; habilitation réelle différée. **Retenu (D8).**
- **R4 — Consentement OBLIGATOIRE avec gate 422**, modèle de preuve marqué interprétation. **Retenu (D5).**
- **R5 — `RoutageID` inline, codes routage standalone (6 endpoints Swagger) DIFFÉRÉS** pour borner le périmètre. **Retenu (D11).**
- **R6 — Adaptateurs transport réels (API PISTE / EDI), feed d'initialisation, habilitations : DIFFÉRÉS derrière le port** (go-live). **Retenu (D7/D12).**
- **R7 — TB paiements-équivalent : sans objet** pour l'annuaire ; le seul différé structurel est le transport réel et les codes routage.
- **R8 — Bump `0.6.0`.** **Retenu.**
