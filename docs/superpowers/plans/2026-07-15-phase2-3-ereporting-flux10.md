# Plan 2.3 — e-reporting Flux 10 : données de transaction & de paiement

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Livrer le **socle e-reporting Flux 10** (obligation CGI art. 290 / 290 A, effectif 1er sept. 2026) : transmission au PPF des **données d'opérations** — B2B international (10.1 transactions / 10.2 paiements) et B2C domestique (10.3 transactions / 10.4 paiements) — **et non des factures elles-mêmes** (contraste avec l'e-invoicing Flux 1-9 déjà livré). Concrètement : (1) un **modèle de domaine pur** du rapport Flux 10 (`<Report>` = TB-1 `ReportDocument` obligatoire + TB-2 `TransactionsReport` XOR TB-3 `PaymentsReport`), (2) une **génération XML XSD-valide** (3 namespaces `report`/`transaction`/`payment`, validation `xmllint`/libxml2 contre le XSD DGFiP livré), (3) une **agrégation** dérivant les données Flux 10 des factures existantes (mapping EN 16931 BT → codes TT, correspondance cadre Flux 9 → catégorie Flux 10.3), (4) un **ordonnanceur de cadence par régime TVA** (décades du réel normal mensuel, mensuel/bimestriel des autres régimes) piloté par une table de déclarants, (5) une **machine à états e-reporting DISTINCTE et obligatoire** (300 Déposée/acceptée ⊕ 301 Rejetée + 4 motifs `REJ_SEMAN`/`REJ_UNI`/`REJ_COH`/`REJ_PER`) avec journal append-only, (6) un **port de transmission différé au déploiement** (`Flux10TransmissionPort` + implémentation locale write-once testable ; adaptateurs SFTP/AS2/AS4/API activés au déploiement). La **transmission à blanc est OPTIONNELLE** (aucune opération imposable → aucun envoi, pas de rapport vide). Il n'y a **AUCUN scellement/signature au niveau message** (l'authentification est au niveau transport, responsabilité PA) — la PAF/le scellement 2.2 **ne s'appliquent pas** au Flux 10.

**Architecture:** On **réutilise le socle 1.x/2.x** : modèle `Invoice` canonique (`@factelec/invoice-core`, EN 16931), infra BullMQ (files + `@Processor` unique + `upsertJobScheduler` répétable, motifs 2.1), discipline drizzle + **RLS `FORCE`** + `runInTenant`/`SET LOCAL app.tenant_id` + rôle `factelec_app` sans `BYPASSRLS`, fonctions **`SECURITY DEFINER` à `search_path=pg_catalog,pg_temp` épinglé + schéma-qualifiées** (règle projet durcie en 2.1/2.2), filtre `problem+json`, guards session/clé API. Le **domaine pur** (nomenclatures, modèle, agrégation, génération XML, machine à états, calcul de périodes) vit dans `apps/api/src/ereporting/*` en modules **purs sans dépendance NestJS** — exactement le précédent des modules purs `src/archive/archive-bundle.ts` et `src/ledger/ledger-hash.ts` livrés en 2.2. La **génération XML** s'appuie sur `xmlbuilder2` (déjà éprouvé et vendorisé dans le monorepo via `invoice-core`), ajouté à `apps/api` (D2). La **validation XSD** réutilise le motif `xmllint --schema` de `invoice-core/tests/helpers/xsd.ts` (libxml2, déjà disponible en CI) contre le `ereporting.xsd` DGFiP livré (qui importe `report`/`transaction`/`payment`/`parametre`). La **persistance** ajoute trois tables tenant-scopées (`ereporting_declarants` config, `ereporting_transmissions`, `ereporting_status_events` journal append-only) sous RLS `FORCE`. L'**ordonnanceur** énumère les déclarants **dus** pour une période via une **fonction `SECURITY DEFINER` cross-tenant** (miroir de `find_failed_archives`, 2.2) puis enfile un job de génération par déclarant/période sur une file BullMQ dédiée. La **transmission** passe par un **port** (contrat `transmit`/`status`) : `LocalFilesystemTransmissionStore` (écrit le XML sur disque write-once, renvoie un identifiant de suivi — entièrement testable) ; les adaptateurs réels SFTP/AS2/AS4/API sont **spécifiés** et **activés au déploiement** (throw documenté), exactement comme le port `ArchiveStore` a différé l'adaptateur S3 object-lock.

**Tech Stack:** **Une seule dépendance runtime ajoutée à `apps/api` : `xmlbuilder2`** (déjà présente dans le lockfile via `invoice-core@^4.0.3` → dédupliquée, `pnpm outdated -r`/`audit:ci` restent verts ; justifiée en D2 — génération XML déterministe avec échappement correct plutôt qu'une concaténation de chaînes injection-prone). Validation : **`xmllint`** (libxml2, déjà requis par les tests `invoice-core`, présent en CI). Périodes/hash/IO : `node:*` natifs. Files : **BullMQ 5.80.3** (déjà présent). Aucun ajout à `apps/web`. `docker-compose` inchangé (le store de transmission local écrit dans un répertoire temporaire/monté).

## Global Constraints

Reprises **verbatim** du socle 1.x/2.x (non négociables) — chaque tâche en hérite implicitement :

- **TDD strict RED/GREEN** : test écrit et vu échouer avant toute implémentation ; aucun merge si un test échoue (spec §7). Un commit minimum par tâche, message en **français**, **sans** trailer `Co-Authored-By: Claude` ni mention Claude ; commits au seul nom de l'utilisateur. `pnpm format` avant chaque commit.
- **Couverture bloquante** : **≥ 90 %** (lines/functions/statements/branches) maintenue sur `apps/api` ; `packages/invoice-core` reste à **100 %** (ne pas y toucher). `apps/web` : seuil 90×4 maintenu (aucune modif web dans ce plan). Exclusions de couverture existantes conservées (`src/main.ts`, `src/worker-main.ts`, `**/*.module.ts`, `src/db/migrations/**`). **Tout module pur de domaine e-reporting** (nomenclatures, modèle, agrégation, machine à états, périodes, XML) est visé à **100 %** par des tests unitaires déterministes (goldens XSD-validés, vecteurs de période fixés). Le code de transmission réel (adaptateurs SFTP/AS2/AS4/API, non testable sans infra) **n'est pas écrit** dans ce plan : seul son contrat est spécifié (aucune ligne à exclure — voir D7).
- **e2e sur Postgres réel (Testcontainers)** pour toute table/endpoint ; **Redis réel** pour tout flux worker/scheduler ; **tests d'isolation multi-tenant explicites** (déclarant/transmission/journal d'un tenant jamais visible d'un autre). **Motifs de stabilité e2e OBLIGATOIRES** (acquis 1.4/2.1/2.2) : `listenOnce` (serveur de test démarré **une seule fois** par fichier), `maxWorkers: 5`, `withStartupTimeout(120_000)`, `hookTimeout: 150_000`, écouteur `error` sur tout pool `pg` brut (bruit `57P01` au teardown).
- **Sécurité OWASP** : validation de toute entrée (zod), authz systématique (dual-auth session/clé API sur les endpoints de consultation). **Aucune donnée sensible hors des frontières tenant** : le XML Flux 10, les transmissions et le journal restent sous la frontière tenant (RLS). Erreurs normalisées **RFC 9457 `application/problem+json`**. **Aucun secret dans Redis** : les jobs ne portent que des identifiants internes (le worker recharge sous RLS — motif 2.1).
- **Moindre privilège Postgres inchangé** : rôle `factelec_app` ≠ propriétaire, **sans `BYPASSRLS`, sans superuser** ; RLS **`ENABLE` + `FORCE`** sur toute table tenant ajoutée ; propagation du tenant par `SET LOCAL` via `runInTenant`. Le process API/worker ne connaît **que** `DATABASE_URL` (rôle app). Les migrations (colonnes, RLS, grants, fonction SD cross-tenant) s'exécutent sous le rôle **propriétaire** via `db:migrate`. La fonction SD d'énumération des déclarants dus épingle **`search_path=pg_catalog, pg_temp`** et **schéma-qualifie** ses objets applicatifs (`public.ereporting_declarants`), miroir de `find_failed_archives` (0015).
- **TypeScript `strict: true`, ESM (`"type": "module"`), NodeNext, Node ≥ 22.** `typescript` pinné **exactement `7.0.2`** (racine, tsgo). Repli local `typescript@5.9.x` **du seul workspace concerné** autorisé et documenté si un typecheck bute — sans toucher le pin racine.
- **Dépendances pinnées exactement** (pas de `^`/`~`), **dernière stable** vérifiée au registre, avec licence. **`pnpm run audit:ci` 0 vulnérabilité** (script maison `scripts/audit.mjs`) et **`pnpm outdated -r` vierge** restent **bloquants** en CI. La seule dépendance ajoutée (`xmlbuilder2`, D2) est déjà résolue dans le lockfile via `invoice-core` → l'objectif « outdated vierge / audit 0 » est mécaniquement tenu (vérifier néanmoins à chaque tâche — un patch amont peut sortir en cours de plan, cf. leçon 2.2-T5).
- **`@factelec/invoice-core` consommé via son exports map**, jamais par chemin relatif inter-packages. `docs/reference/` et `docs/reglementaire/` en **lecture seule** (le XSD DGFiP est référencé par chemin absolu depuis les tests, jamais copié/modifié).
- Identifiants de code en **anglais** ; commentaires/commits/docs en **français**.

---

## Périmètre : retenu en 2.3 vs reporté

**Retenu (ce plan) — socle e-reporting Flux 10 (spec §3.7, Annexe 6 v1.10) :**
1. **Nomenclatures & correspondance** : codes de transmission (`IN`/`RE`), rôles (`WK` émetteur PA, `BY`/`SE` déclarant), schémas ISO 6523 (`0238` ICD PA, `0002` SIREN), UNTDID 1001 (types de facture), correspondance **cadre Flux 9 → catégorie Flux 10.3** (`B1→TLB1`, `S1→TPS1`, …), motifs de rejet.
2. **Modèle de domaine pur + génération XML XSD-valide** : `<Report>` (TB-1 obligatoire + TB-2 XOR TB-3), sérialisation `xmlbuilder2`, **validation `xmllint` contre le `ereporting.xsd` DGFiP** (goldens XSD-validés).
3. **Agrégation depuis les factures** : mapping BT → TT (transactions **10.1 par facture** / **10.3 agrégées** jour×devise×catégorie), détection de période à blanc.
4. **Machine à états e-reporting DISTINCTE** (300/301 + 4 motifs), miroir pur de `lifecycle-status.ts`, avec journal `ereporting_status_events` **append-only** (RLS `FORCE`, grants `SELECT`+`INSERT`).
5. **Persistance** : `ereporting_declarants` (config par déclarant : SIREN, rôle, régime TVA), `ereporting_transmissions`, `ereporting_status_events` ; RLS `FORCE`, moindre privilège, fonction SD cross-tenant.
6. **Ordonnanceur de cadence par régime TVA** : calcul des périodes dues (décades/mensuel/bimestriel), mapping régime→cadence **piloté par les données** ; job répétable BullMQ + file de génération dédiée.
7. **Port de transmission** `Flux10TransmissionPort` + **implémentation locale write-once testable** ; adaptateurs SFTP/AS2/AS4/API **spécifiés, activés au déploiement**.
8. **Endpoints de consultation** dual-auth (liste des transmissions, XML d'une transmission, journal des statuts) + application des acquittements PPF (300/301) via la machine à états.
9. **CI / docs / OpenAPI / versions** : README + OpenAPI mis à jour, provenance §3.7/Annexe 6, bump version.

**Reporté (acté ici, justifié en D10/D11) :**
- **Agrégation des PAIEMENTS (TB-3, Flux 10.2/10.4)** : le générateur XML et le port **supportent structurellement** TB-3 (XSD-valide), mais **la dérivation des paiements depuis des enregistrements sources est différée** — la plateforme ne capture PAS aujourd'hui les encaissements (date + montant par taux) ; seul le statut CDV `encaissee` (212) existe, sans montants. TB-3 sera alimenté quand un modèle de capture des paiements existera (**question d'arbitrage Xavier**, D11).
- **Adaptateurs de transmission réels** (SFTP clés RSA / AS2 X.509 / AS4 / API OAuth2) : infra + secrets à la main de Xavier, non testables sans partenaire PPF réel ; **conçus** (contrat du port), **activés au déploiement** (D7).
- **Transport entrant des notifications de cycle de vie PPF** (push 300/301 vers la PA) : la **frontière** (service `recordPpfStatus` + machine à états) est livrée et testée ; le **transport réel** (webhook/annuaire) est différé avec le port de transmission et l'annuaire (2.4).
- **Contrôles sémantiques schematron** (spec §3.7.8, note 128) : **aucun fichier schematron n'est livré** dans le dossier XSD E-reporting (vérifié : `report.xsd`, `ereporting.xsd`, `parametre.xsd`, `transaction.xsd`, `payment.xsd` uniquement). La validation de ce plan est **XSD structurelle** ; les contrôles sémantiques (règles de gestion Annexe 7) sont **différés** et marqués interprétation go-live (D9).
- **Annuaire (Flux 13/14)** : consultation SIREN→PA/routage — **plan 2.4** (déjà acté en 2.2/D8).
- **Remplacement de la matrice de transitions CDV facture** (AFNOR XP Z12-012) : **bloqueur phase 3**, hors périmètre (n'affecte pas la machine à états e-reporting, D5).

---

## Décisions structurantes (à lire avant d'exécuter)

### D1 — Flux 10 = transmission de DONNÉES d'opérations, distincte de l'e-invoicing

- Le Flux 10 transmet au PPF des **données agrégées de transactions et de paiements** (non les factures) : B2B international (10.1/10.2) et B2C domestique (10.3/10.4). C'est un **sous-système indépendant** des Flux 1-9 (e-invoicing) déjà livrés. Fondement : CGI art. 290/290 A (spec §2.3.5, effectif **1er sept. 2026** hors TPME). On dérive néanmoins les données des **factures existantes** (réutilisation du modèle canonique) — les BT EN 16931 se mappent aux codes TT du Flux 10 (D8, Annexe 6 « Correspondance »).
- **Source vérifiée** : `research-2-3-ereporting.md` §1 + `ereporting.xsd` (racine `<Report>` = `ReportDocument` [1..1] + `TransactionsReport` [0..1] + `PaymentsReport` [0..1]).

### D2 — Domaine pur dans `apps/api/src/ereporting/*` + `xmlbuilder2` ajouté à `apps/api`

- Le domaine Flux 10 (nomenclatures, modèle, agrégation, XML, machine à états, périodes) est **pur, sans NestJS**, placé sous `apps/api/src/ereporting/*` — **précédent direct** : les modules purs `src/archive/archive-bundle.ts` et `src/ledger/ledger-hash.ts` (2.2) vivent déjà dans `apps/api`, unit-testés à 100 %. On évite ainsi de créer un nouveau package (surcoût build/exports map, cf. dette 1.3) et on garde `invoice-core` strictement centré facture (100 %).
- **`xmlbuilder2` ajouté à `apps/api`** (pinné exact, dernière stable ; déjà résolu dans le lockfile via `invoice-core@^4.0.3` → dédup, `outdated`/`audit` verts). **Justification** : générer un XML déterministe avec échappement XML correct (`&`, `<`, `"`, caractères de contrôle) ; une concaténation de chaînes maison serait injection-prone (un `reason`/nom de société arbitraire casserait le document) — proscrit. `xmlbuilder2` est déjà éprouvé dans le monorepo (générateurs UBL/CII de `invoice-core`), licence MIT.
- **Alternative écartée — nouveau package `@factelec/ereporting-core`** : séparation de bounded-context plus « propre » mais surcoût (tsconfig, exports map, gate coverage, build avant consommation NestJS). Non retenu par défaut ; **signalé comme question d'arbitrage** (voir fin de plan) car défendable.

### D3 — AUCUN scellement/signature au niveau message Flux 10 (contraste explicite avec 2.2)

- Le XSD Flux 10 **ne définit aucun élément de signature** (`<Signature>`/`<Sign>` absents des 5 fichiers — vérifié `research-2-3-questions.md` §3.1). L'authentification est **au niveau transport** (SFTP clés RSA, AS2/AS4 certificat X.509, API OAuth2), **responsabilité PA** lors de l'envoi au PPF (spec §3.2-3.3). **Décision : ne PAS greffer de scellement/PAF sur le Flux 10.** Le chaînage SHA-256 / le trigger `seal_status_event` / la PAF (2.2) concernent le **journal CDV facture** et **ne s'appliquent pas** ici. Le journal `ereporting_status_events` est append-only (RLS + grants) mais **non scellé** — c'est le comportement correct pour une transmission unidirectionnelle authentifiée au transport.
- **Source vérifiée** : `research-2-3-questions.md` §3 (« Message Flux 10 signé ? NON — XSD aucun élément. Authentification transport OUI »).

### D4 — Cadence pilotée par le régime TVA, mapping DATA-DRIVEN ; mécanique exacte des deadlines = INTERPRÉTATION PROJET

- La cadence de transmission est **déterminée par le régime TVA du déclarant** (spec §3.7.7, Tableau 13) :
  - **Réel normal mensuel** → **3 décades** : 1-10, 11-20, 21-fin ; deadlines de dépôt **le 21 / le 1er du mois+1 / le 11 du mois+1, à 08:00** ; la PA remet au PPF **≤ 8h** après la deadline.
  - **Réel normal trimestriel** → mensuelle + trimestrielle.
  - **Simplifié** → mensuelle (le 1er du 2e mois suivant).
  - **Franchise en base** → **bimestrielle** (bimestres civils).
- Le mapping **régime → cadence** est une **constante de données** (`CADENCE_BY_REGIME`) — facilement promue en table de config plus tard, mais **data-driven et unit-testable** dès maintenant. La **mécanique exacte des deadlines** (Tableau 13 partiellement extractible ; certaines cases figées dans une image non parsée) est encodée comme **INTERPRÉTATION PROJET documentée**, à **confirmer contre la spec autoritative au go-live** — on n'invente pas de règle non écrite, on applique la table extraite et on marque l'incertitude (motif projet, comme la matrice CDV 2.1).
- **Source vérifiée** : `research-2-3-questions.md` §Q1 (Tableau 13 verbatim).

### D5 — Machine à états e-reporting DISTINCTE et obligatoire (300/301 + motifs), séparée du CDV facture

- Le Flux 10 a **son propre cycle de vie**, **distinct du CDV facture** (Flux 6, statuts 200-213 déjà livrés) : le PPF notifie la PA du caractère **accepté** ou **rejeté** de chaque objet métier transmis (spec §3.7.9). Deux statuts officiels (Tableau 5) : **300 Déposée** (contrôlée conforme, transmise à l'administration) / **301 Rejetée** (non conforme). Quatre **motifs de rejet** (Tableau 6, §3.7.10) : `REJ_SEMAN` (format sémantique), `REJ_UNI` (unicité), `REJ_COH` (cohérence), `REJ_PER` (période).
- On modélise une **nouvelle machine à états PURE** (`ereporting-lifecycle.ts`), **miroir structurel** de `lifecycle-status.ts` mais **sans conflation** avec lui : états internes PA `prepared` (généré localement) → `transmitted` (émis via le port) puis acquittement PPF `deposee` (300, terminal) ⊕ `rejetee` (301, terminal, **motif requis**). Journal `ereporting_status_events` append-only. La **Figure 59** (« cycle de vie d'un objet métier ») étant une **image non extractible**, le modèle à 2 états terminaux repose sur le **texte §3.7.9** (binaire déposée/rejetée) — marqué interprétation.
- **Source vérifiée** : `research-2-3-questions.md` §3.4 (Tableaux 5-6 verbatim).

### D6 — Transmission à blanc OPTIONNELLE : agrégat vide → aucun envoi (pas de rapport vide)

- Simplification §2.3.3 : **absence d'obligation d'« e-reporting à blanc »** — si **aucune opération imposable à la TVA** sur la période, **aucune transmission n'est requise** (ni TB-1 seul, ni TB-2/TB-3 vide). **Décision** : l'agrégation (Task 3) renvoie `null` pour une période sans opération ; le worker (Task 8) **n'émet alors AUCUN rapport** (pas de ligne `ereporting_transmissions`, pas d'appel au port). Aucun statut « vide » à tracer.
- **Source vérifiée** : `research-2-3-questions.md` §Q2 (« Absence d'obligation d'effectuer un e-reporting à blanc » verbatim).

### D7 — Port de transmission différé au déploiement (miroir du port `ArchiveStore`)

- **Testable sans partenaire PPF** : le **port** `Flux10TransmissionPort` (`transmit(payload)`/`status(trackingId)`) et l'implémentation **`LocalFilesystemTransmissionStore`** — écrit le XML write-once dans `EREPORTING_LOCAL_DIR`, renvoie un `trackingId` déterministe (empreinte SHA-256 du contenu) et un statut simulé configurable. Entièrement couverte (répertoire temporaire), miroir exact de `LocalFilesystemArchiveStore` (2.2/D5).
- **NON testable sans infra** (instruit honnêtement) : les adaptateurs **SFTP** (clés RSA), **AS2/AS4** (certificat X.509), **API REST** (OAuth2). **Ils ne sont PAS écrits** dans ce plan — on **spécifie le contrat** (mêmes signatures) et l'activation par env (`EREPORTING_TRANSMISSION_DRIVER=sftp|as2|as4|api` au déploiement, défaut `local`). La branche non-`local` du provider factory est un **`throw` documenté et testé** (une ligne, couverte). Aucun adaptateur réel non testé n'entre dans le périmètre → couverture honnête.
- **Sélection par env** : `EREPORTING_TRANSMISSION_DRIVER` (défaut `local`) + `EREPORTING_LOCAL_DIR`.

### D8 — Réutilisation : modèle Invoice (BT→TT), infra BullMQ, discipline drizzle+RLS+SD

- **Données** : l'agrégation lit les `invoices` (jsonb `canonical` = `Invoice` EN 16931) sous RLS et mappe BT→TT (Annexe 6 « Correspondance ») — aucune ré-extraction métier. **Infra** : file BullMQ dédiée `ereporting-generation` + `@Processor` (motif `invoice-generation`), scheduler `upsertJobScheduler` répétable sur `maintenance` (motif `ArchiveRetryScheduler`), énumération cross-tenant par fonction **SD** (motif `find_failed_archives`). **Discipline DB** : migrations drizzle pour colonnes/tables, **manuelles** pour RLS/grants/SD (avec `--> statement-breakpoint`), `nullif(current_setting('app.tenant_id',true),'')::uuid`, SD `search_path=pg_catalog,pg_temp` + schéma-qualifié.

### D9 — Validation XSD structurelle (xmllint/libxml2) ; schematron sémantique DIFFÉRÉ

- La génération est validée **structurellement** contre le `ereporting.xsd` DGFiP livré (importe `report`/`transaction`/`payment`/`parametre`) via **`xmllint --schema`** (libxml2, déjà en CI, motif `invoice-core/tests/helpers/xsd.ts`). **Aucun schematron n'est livré** dans le dossier E-reporting (vérifié). Les **contrôles sémantiques** (§3.7.8 « décrits au travers de schematrons », note 128 ; règles de gestion Annexe 7 non lue) sont **différés** et marqués **interprétation go-live**. Le XSD DGFiP est **très permissif** (`xs:string` partout, peu de restrictions — cf. `parametre.xsd` aux types vides) : la conformité XSD est nécessaire mais **non suffisante** ; la conformité sémantique complète dépend de l'Annexe 7 et des schematrons, à obtenir avant production.
- **Détermination empirique de la qualification des espaces de noms** : `ereporting.xsd` n'a **pas** de `targetNamespace` et `elementFormDefault` est « unqualified » partout → l'instance est **sans préfixe de namespace** (éléments non qualifiés). Ce point est **confirmé empiriquement au premier run `xmllint`** (comme le pivot F1 BASE→FULL→OASIS en 1.1) ; le golden est capté **après** validation verte.

### D10 — Découpage : transactions livrées, PAIEMENTS (TB-3) partiellement différés

- Le **générateur XML et le port supportent TB-3** (paiements) structurellement (XSD-valide). Mais l'**agrégation des paiements** (date + montant encaissé par taux, TG-35/36) **n'a pas de source** : la plateforme ne persiste pas les encaissements (seul le statut CDV `encaissee`, sans montants). **Décision** : livrer **TB-1 + TB-2 (transactions)** de bout en bout ; l'agrégation TB-3 est **différée** jusqu'à un modèle de capture des paiements. Le worker n'émet TB-3 que si des données de paiement existent (aucune aujourd'hui → aucun flux paiement, cohérent avec la transmission à blanc D6).

### D11 — Régime TVA & identité déclarant portés par une table de config (`ereporting_declarants`)

- La table `tenants` porte un `siren` nu, **pas** de régime TVA ni de rôle. Le Flux 10 exige, par **déclarant** (maille SIREN × rôle acheteur/vendeur, spec §3.7.7) : SIREN (TT-13, schéma `0002`), raison sociale (TT-14), rôle `BY`/`SE` (TT-15), **et le régime TVA** qui pilote la cadence (D4). On modélise `ereporting_declarants` (par tenant) portant ces attributs. Les **métadonnées de l'émetteur PA** (TG-3 : matricule TT-8, schéma `0238` TT-7, raison sociale TT-9, rôle `WK` TT-10) sont **au niveau plateforme**, injectées par **env** (`EREPORTING_PA_*`) — identiques pour tous les tenants.

---

## Versions & dépendances (registre npm vérifié le 2026-07-15)

| Brique | Fournisseur | Provenance / note |
|---|---|---|
| Génération XML | **`xmlbuilder2`** (pin exact, dernière stable) | **Ajout `apps/api`** ; déjà résolu via `invoice-core@^4.0.3` (dédup lockfile) → `outdated`/`audit` verts. MIT. Échappement XML correct (D2). |
| Validation XSD | **`xmllint`** (libxml2) | Déjà requis par les tests `invoice-core` ; présent en CI (Ubuntu `libxml2-utils`). Aucun ajout npm. |
| Files / scheduler | **BullMQ 5.80.3** (déjà présent) | File dédiée `ereporting-generation` + job répétable `maintenance`. |
| Périodes / IO / hash | `node:*` natifs | Calcul de périodes (Date UTC), écriture write-once, empreinte SHA-256 du trackingId. |

> **Gate** : `pnpm run audit:ci` = 0 et `pnpm outdated -r` **vierge**. Vérifier à **chaque** tâche (un patch amont peut sortir en cours de plan — leçon 2.2). Overrides existants inchangés.

---

## Points de risque signalés d'emblée

1. **Qualification des espaces de noms de l'instance XML.** `ereporting.xsd` sans `targetNamespace`, `elementFormDefault` unqualified → instance **sans préfixe**. **Traité** : déterminé empiriquement au premier run `xmllint` (Task 2), golden capté après validation verte. Repli : si un préfixe s'avère requis, ajuster le générateur et re-valider (le test XSD est la sentinelle).
2. **Permissivité du XSD DGFiP.** Types `xs:string`/vides (`parametre.xsd`) → la validité XSD ne garantit PAS la conformité sémantique (codes, formats de date). **Traité/instruit** : D9 (schematron sémantique différé, marqué go-live) ; les nomenclatures (Task 1) et les formats de date `AAAAMMJJ`/`AAAAMMJJHHMMSS` sont validés **côté application** (zod/tests) même si le XSD ne les contraint pas.
3. **Mécanique exacte des deadlines / décades.** Tableau 13 partiellement extractible. **Traité** : D4 (mapping data-driven + interprétation projet documentée), vecteurs de période unit-testés sur des dates fixes, marquage go-live.
4. **Absence de source pour les paiements (TB-3).** **Traité** : D10 (TB-3 supporté structurellement, agrégation différée), question d'arbitrage Xavier.
5. **`xmllint` sur le PATH.** Requis (macOS/Ubuntu). **Traité** : déjà le cas pour `invoice-core` (dette connue) ; documenté, présent en CI.
6. **Transport de transmission réel absent.** **Traité/instruit** : D7 (port + local write-once testable ; adaptateurs réels au déploiement, throw documenté et testé).
7. **Numérotation des migrations.** Dernière migration = **0015**. Ce plan démarre à **0016** (drizzle : enums + tables) et **0017** (manuel : RLS/grants + SD cross-tenant). Entrées `meta/_journal.json` : la migration drizzle écrit son entrée + snapshot ; la manuelle est ajoutée **à la main** (`{ idx, version:"7", when:<epoch-ms>, tag, breakpoints:true }`, **sans** snapshot — comme 0012/0015).

---

## Sources réglementaires vérifiées (dossier `docs/reglementaire/specifications-externes-v3.2/`, lecture seule)

> Vérifiées in situ (XSD lus, Annexe 6 v1.10 parsée openpyxl, spec §2.3/§3.7 extraite) — provenance tracée pour chaque affirmation. Dossiers de recherche : `.superpowers/sdd/research-2-3-ereporting.md`, `.superpowers/sdd/research-2-3-questions.md`.

- **Structure racine** — `3- XSD_v3.2/1 - E-reporting/ereporting.xsd`, l.11-33 : `<xs:element name="Report" type="ReportType">` (TB-0) ; `ReportType` = séquence `ReportDocument` (`rep:ReportDocumentType`, **minOccurs=1**), `TransactionsReport` (`trs:TransactionsReportType`, minOccurs=0), `PaymentsReport` (`pay:PaymentsReportType`, minOccurs=0). Aucun `targetNamespace` sur `ereporting.xsd`.
- **TB-1 `ReportDocument`** — `report.xsd`, l.8-138 : `Id` (TT-1, 1..1), `Name` (TT-2, 0..1), `IssueDateTime/DateTimeString` (TT-3, 1..1, **AAAAMMJJHHMMSS**), `TypeCode` (TT-4, 1..1, `IN`|`RE`), `Sender` (TG-3, 1..1 : `Id@schemeId` TT-8/TT-7, `Name` TT-9, `RoleCode` TT-10, `URIUniversalCommunication` 0..1), `Issuer` (TG-5, 1..1 : `Id@schemeId` TT-13/TT-12, `Name` TT-14, `RoleCode` TT-15).
- **TB-2 `TransactionsReport`** — `transaction.xsd`, l.7-698 : `ReportPeriod` (TG-7 : `StartDate` TT-17, `EndDate` TT-18, **AAAAMMJJ**), `Invoice` (TG-8, 0..n : `ID` TT-19, `IssueDate` TT-20, `TypeCode` TT-21, `CurrencyCode` TT-22, `DueDate` TT-201 0..1, `TaxDueDateTypeCode` TT-24 0..1, `IncludedNote` 0..n, **`BusinessProcess`** TG-10 1..1 : `ID` TT-28 / `TypeID` TT-29, `Seller` TG-12 1..1 : `CompanyId@schemeId` TT-33/33-1, `TaxRegistrationId` 0..1, `PostalAddress/CountryId` TT-35, `Buyer` 0..1, …, `MonetaryTotal` TG-22 1..1 : `TaxExclusiveAmount` TT-51 0..1 / `TaxAmount@CurrencyCode` TT-52/TT-202, `TaxSubTotal` TG-23 **1..n** : `TaxableAmount` TT-54 / `TaxAmount` TT-55 / `TaxCategory` : `Code` TT-56 0..1 / `Percent` TT-57 / `TaxExemptionReason(Code)` 0..1, `Line` TG-24 0..n), **`Transactions`** (TG-31, 0..n — **forme agrégée B2C 10.3** : `Date` TT-77 1..1, `TransactionsCurrency` TT-78 1..1, `TaxDueDateTypeCode` TT-80 0..1, `CategoryCode` TT-81 1..1, `TaxExclusiveAmount` TT-82 1..1, `TaxTotal` TT-83 1..1, `TransactionsCount` TT-85 **0..1** [simplifié, facultatif], `TaxSubtotal` TG-32 1..n : `TaxPercent` TT-86 / `TaxableAmount` TT-87 / `TaxTotal` TT-88).
- **TB-3 `PaymentsReport`** — `payment.xsd`, l.6-132 : `ReportPeriod` (TG-33 : `StartDate` TT-89 / `EndDate` TT-90), `Invoice` (TG-34, 0..n : `InvoiceID` TT-91, `IssueDate` TT-102, `Payment` TG-35 : `Date` TT-92, `SubTotals` TG-36 1..n : `TaxPercent` TT-93 / `CurrencyCode` TT-94 0..1 / `Amount` TT-95), `Transactions` (TG-37, 0..n — paiements agrégés).
- **Nomenclatures** — Annexe 6 v1.10 (`2- Annexes_v3.2/20260430_Annexe 6 - Format sémantique FE e-reporting - V1.10.xlsx`) : schéma PA `0238` (ICD, TT-7), rôle PA `WK` (UNCL 3035, TT-10), schéma SIREN `0002` (TT-12/33-1), rôle déclarant `BY`/`SE` (TT-15), types facture UNTDID 1001 (`380`/`381`/`384`…, TT-21), devise ISO 4217 (TT-22), types transmission `IN`/`RE` (TT-4). **Correspondance cadre Flux 9 → catégorie 10.3** (feuille « E-REPORTING - Correspondance ») : `B1→TLB1`, `S1→TPS1`, `M1→{TLB1,TPS1}`, `B2→TLB1`, `S2→TPS1`, `M2→{TLB1,TPS1}`, `B4→TLB1`, `S4→TPS1`, `M4→{TLB1,TPS1}`, `S5→TPS1`, `S6→TPS1`, `B7→TLB1`, `S7→TPS1`.
- **Cadence** — spec §3.7.7, Tableau 13 : réel normal mensuel → décades (deadlines 21 / 1er mois+1 / 11 mois+1 à 08:00) ; simplifié → mensuel (1er du 2e mois suivant) ; franchise → bimestriel ; PA remet au PPF ≤ 8h après deadline.
- **Cycle de vie** — spec §3.7.9-3.7.10, Tableaux 5-6 : statuts **300 Déposée** / **301 Rejetée** ; motifs `REJ_SEMAN`/`REJ_UNI`/`REJ_COH`/`REJ_PER`.
- **Simplifications** — spec §2.3.3 : e-reporting à blanc **optionnel** ; détail ligne 10.1 entrantes facultatif ; `TransactionsCount` (TT-85) 10.3 facultatif.
- **Absence de signature** — 5 XSD sans élément de signature (auth transport §3.2-3.3). **Absence de schematron** — dossier E-reporting sans `.sch`/`.xsl`.

---

## Structure des fichiers (vue d'ensemble)

```
apps/api/
  package.json                              # + xmlbuilder2 (pin exact)
  src/
    config/env.ts                           # + EREPORTING_PA_*, EREPORTING_TRANSMISSION_DRIVER, EREPORTING_LOCAL_DIR, EREPORTING_SWEEP_EVERY_MS
    db/
      schema.ts                             # + enums + ereporting_declarants/transmissions/status_events
      migrations/
        0016_ereporting_tables.sql          # (drizzle) enums + 3 tables (Task 5)
        0017_ereporting_rls.sql             # (hand) RLS FORCE + grants + SD find_ereporting_declarants_due (Task 5)
        meta/_journal.json                  # + 0016/0017 (0017 ajouté manuellement)
    ereporting/
      nomenclature.ts                       # PUR : codes IN/RE, WK, BY/SE, 0238/0002, UNTDID1001, correspondance cadre→catégorie (Task 1)
      flux10-model.ts                       # PUR : types ReportDocument/TransactionsReport/PaymentsReport (Task 2)
      flux10-xml.ts                         # PUR : generateEreportingXml (xmlbuilder2, XSD-valide) (Task 2)
      flux10-aggregate.ts                   # PUR : aggregateTransactions (BT→TT, à blanc→null) (Task 3)
      ereporting-lifecycle.ts               # PUR : machine à états 300/301 + motifs (Task 4)
      period.ts                             # PUR : computeDuePeriods(regime, ref) (Task 7)
      ereporting.repository.ts              # déclarants/transmissions/journal sous RLS (Task 5)
      flux10-transmission.port.ts           # port + token + erreurs (Task 6)
      local-filesystem-transmission-store.ts# impl write-once locale (Task 6)
      ereporting-transmission.module.ts     # @Global factory selon EREPORTING_TRANSMISSION_DRIVER (Task 6)
      ereporting-generation.service.ts      # période → agrégat → XML → validation → persistance → transmission (Task 8)
      ereporting-status.service.ts          # recordPpfStatus (300/301) via machine à états (Task 9)
      ereporting.controller.ts              # GET transmissions / :id/xml / :id/events (Task 9)
      ereporting.module.ts                  # câblage API (Task 9)
    worker/
      ereporting-generation.processor.ts    # @Processor(EREPORTING_GENERATION_QUEUE) (Task 8)
      ereporting.scheduler.ts               # upsertJobScheduler EREPORTING_SWEEP_JOB (Task 7)
      ereporting-sweep.service.ts           # énumère les déclarants dus (SD) → enfile (Task 7)
      maintenance.processor.ts              # + branche EREPORTING_SWEEP_JOB (Task 7)
      worker.module.ts                      # + providers e-reporting (Task 7/8)
    queue/
      queue.constants.ts                    # + EREPORTING_GENERATION_QUEUE (Task 7)
      maintenance.job.ts                    # + EREPORTING_SWEEP_JOB (Task 7)
      ereporting-generation.job.ts          # payload minimal { tenantId, declarantId, ... } (Task 7)
  tests/
    unit/
      ereporting-nomenclature.test.ts       # (Task 1)
      flux10-xml.test.ts                    # golden + XSD-valide (Task 2)
      flux10-aggregate.test.ts              # BT→TT, à blanc (Task 3)
      ereporting-lifecycle.test.ts          # 300/301 + motifs (Task 4)
      period.test.ts                        # décades/mensuel/bimestriel (Task 7)
      local-filesystem-transmission-store.test.ts  # write-once (Task 6)
      env.test.ts                           # (MODIFIÉ) cas EREPORTING_* (Task 6)
    e2e/
      ereporting-persistence.e2e.test.ts    # RLS/isolation déclarants/transmissions/journal (Task 5)
      ereporting-generation.e2e.test.ts     # période→transmission ; à blanc→rien (Task 8)
      ereporting-status.e2e.test.ts         # 300/301 + motif, isolation (Task 9)
      ereporting-endpoints.e2e.test.ts      # GET list/xml/events dual-auth, isolation (Task 9)
    helpers/ereporting-xsd.ts               # validateAgainstEreportingXsd (xmllint) (Task 2)
```

Fichiers hors `apps/api` : `README.md` racine + `apps/api/README.md` (e-reporting, `EREPORTING_*`, différés), `.github/workflows/ci.yml` inchangé (libxml2 déjà présent).

---

### Task 1 : Nomenclatures Flux 10 & correspondance cadre → catégorie (module pur)

**Files:**
- Create: `apps/api/src/ereporting/nomenclature.ts`
- Create: `apps/api/tests/unit/ereporting-nomenclature.test.ts`

**Interfaces:**
- Consumes : rien (constantes autoportantes) ; référence `BusinessProcessType` de `@factelec/invoice-core` (enum BT-23).
- Produces (Tasks 2-3-4-5-7) : `TRANSMISSION_TYPES` (`IN`/`RE`), `SENDER_ROLE_PA` (`WK`), `ISSUER_ROLES` (`BY`/`SE`), `SCHEME_ID_PA` (`0238`), `SCHEME_ID_SIREN` (`0002`), `VAT_REGIMES`, `REJECT_MOTIFS`, `mapCadreToCategories(bt23): Flux10Category[]`, `isUntdid1001Type`.

- [ ] **Step 1 : Tests (RED) — nomenclatures & correspondance**

`apps/api/tests/unit/ereporting-nomenclature.test.ts` :
```ts
import { describe, expect, it } from 'vitest'
import {
  ISSUER_ROLES,
  mapCadreToCategories,
  REJECT_MOTIFS,
  SCHEME_ID_PA,
  SCHEME_ID_SIREN,
  SENDER_ROLE_PA,
  TRANSMISSION_TYPES,
  VAT_REGIMES,
} from '../../src/ereporting/nomenclature.js'

describe('nomenclatures Flux 10', () => {
  it('expose les codes réglementaires ancrés (Annexe 6 v1.10)', () => {
    expect(TRANSMISSION_TYPES).toEqual(['IN', 'RE'])
    expect(SENDER_ROLE_PA).toBe('WK') // UNCL 3035, émetteur PA (TT-10)
    expect(ISSUER_ROLES).toEqual(['BY', 'SE']) // déclarant acheteur/vendeur (TT-15)
    expect(SCHEME_ID_PA).toBe('0238') // ICD PA (TT-7)
    expect(SCHEME_ID_SIREN).toBe('0002') // SIREN (TT-12/33-1)
    expect(REJECT_MOTIFS).toEqual([
      'REJ_SEMAN',
      'REJ_UNI',
      'REJ_COH',
      'REJ_PER',
    ])
    expect(VAT_REGIMES).toContain('reel_normal_mensuel')
    expect(VAT_REGIMES).toContain('franchise')
  })

  it('mappe le cadre de facturation (BT-23) → catégorie(s) 10.3', () => {
    // Correspondance Annexe 6 « E-REPORTING - Correspondance ».
    expect(mapCadreToCategories('B1')).toEqual(['TLB1']) // livraison de biens
    expect(mapCadreToCategories('S1')).toEqual(['TPS1']) // prestation de services
    expect(mapCadreToCategories('M1')).toEqual(['TLB1', 'TPS1']) // mixte
    expect(mapCadreToCategories('B7')).toEqual(['TLB1'])
    expect(mapCadreToCategories('S6')).toEqual(['TPS1'])
  })

  it('couvre les 13 cadres BT-23 (aucun trou)', () => {
    const cadres = [
      'B1', 'S1', 'M1', 'B2', 'S2', 'M2', 'B4', 'S4', 'M4', 'S5', 'S6', 'B7', 'S7',
    ] as const
    for (const c of cadres) expect(mapCadreToCategories(c).length).toBeGreaterThan(0)
  })
})
```
Run: `pnpm --filter @factelec/api test -- ereporting-nomenclature` → RED (module absent).

- [ ] **Step 2 : Implémentation (GREEN)**

`apps/api/src/ereporting/nomenclature.ts` :
```ts
import type { BusinessProcessType } from '@factelec/invoice-core'

// Codes réglementaires Flux 10 (Annexe 6 v1.10 ; spec §3.7). Ce sont les
// identifiants NORMATIFS — ne jamais les altérer (audit d'immatriculation).

export const TRANSMISSION_TYPES = ['IN', 'RE'] as const // TT-4 (initial / rectificatif)
export type TransmissionType = (typeof TRANSMISSION_TYPES)[number]

export const SENDER_ROLE_PA = 'WK' as const // TT-10, UNCL 3035 (workflow manager = PA)
export const ISSUER_ROLES = ['BY', 'SE'] as const // TT-15 (acheteur / vendeur)
export type IssuerRole = (typeof ISSUER_ROLES)[number]

export const SCHEME_ID_PA = '0238' as const // TT-7 (ICD plateforme agréée)
export const SCHEME_ID_SIREN = '0002' as const // TT-12/33-1 (SIREN)

// Régimes TVA pilotant la cadence (D4/D11) ; le mapping cadence vit dans period.ts.
export const VAT_REGIMES = [
  'reel_normal_mensuel',
  'reel_normal_trimestriel',
  'simplifie',
  'franchise',
] as const
export type VatRegime = (typeof VAT_REGIMES)[number]

// Motifs de rejet PPF (Tableau 6, §3.7.10).
export const REJECT_MOTIFS = [
  'REJ_SEMAN',
  'REJ_UNI',
  'REJ_COH',
  'REJ_PER',
] as const
export type RejectMotif = (typeof REJECT_MOTIFS)[number]

// Catégories de transactions B2C 10.3 (TT-81).
export const FLUX10_CATEGORIES = ['TLB1', 'TPS1'] as const // livraisons biens / prestations services
export type Flux10Category = (typeof FLUX10_CATEGORIES)[number]

// Correspondance cadre de facturation (BT-23, Flux 9) → catégorie(s) 10.3
// (feuille « E-REPORTING - Correspondance », Annexe 6 v1.10). Les cadres mixtes
// (M*) portent les DEUX catégories : l'opérateur distingue LB et PS en lignes.
const CADRE_TO_CATEGORIES: Record<BusinessProcessType, Flux10Category[]> = {
  B1: ['TLB1'],
  S1: ['TPS1'],
  M1: ['TLB1', 'TPS1'],
  B2: ['TLB1'],
  S2: ['TPS1'],
  M2: ['TLB1', 'TPS1'],
  B4: ['TLB1'],
  S4: ['TPS1'],
  M4: ['TLB1', 'TPS1'],
  S5: ['TPS1'],
  S6: ['TPS1'],
  B7: ['TLB1'],
  S7: ['TPS1'],
}

export function mapCadreToCategories(cadre: BusinessProcessType): Flux10Category[] {
  return CADRE_TO_CATEGORIES[cadre]
}
```
Run: `pnpm --filter @factelec/api test -- ereporting-nomenclature` → PASS.

- [ ] **Step 3 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): nomenclatures Flux 10 et correspondance cadre→catégorie e-reporting"
```
Expected: PASS, couverture ≥ 90 %×4 (module pur 100 %).

---

### Task 2 : Modèle de domaine Flux 10 + génération XML XSD-valide

**Files:**
- Modify: `apps/api/package.json` (+ `xmlbuilder2` pin exact)
- Create: `apps/api/src/ereporting/flux10-model.ts`, `apps/api/src/ereporting/flux10-xml.ts`
- Create: `apps/api/tests/helpers/ereporting-xsd.ts`, `apps/api/tests/unit/flux10-xml.test.ts`

**Interfaces:**
- Consumes : Task 1 (nomenclatures) ; `xmlbuilder2` ; `ereporting.xsd` DGFiP (chemin absolu, lecture seule).
- Produces (Tasks 3-8) : types `ReportDocument`, `TransactionsReport`, `PaymentsReport`, `Flux10Report` ; `generateEreportingXml(report): string` (XSD-valide) ; helper de test `validateAgainstEreportingXsd(xml)`.

- [ ] **Step 1 : Ajouter `xmlbuilder2` (dépendance justifiée D2)**
```bash
pnpm --filter @factelec/api add xmlbuilder2@<dernière-stable-exacte>   # ex. 4.0.3 (déjà dans le lockfile via invoice-core)
```
Vérifier `pnpm outdated -r` **vierge** et `pnpm run audit:ci` 0 après ajout (dédup attendue).

- [ ] **Step 2 : Helper de validation XSD (miroir invoice-core/tests/helpers/xsd.ts)**

`apps/api/tests/helpers/ereporting-xsd.ts` :
```ts
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// ereporting.xsd importe report/transaction/payment/parametre par schemaLocation
// RELATIF : xmllint résout ces imports depuis le dossier du XSD. On pointe donc
// --schema sur le fichier DGFiP en place (docs/reglementaire en LECTURE SEULE).
export const EREPORTING_XSD = resolve(
  import.meta.dirname,
  '../../../../docs/reglementaire/specifications-externes-v3.2/3- XSD_v3.2/1 - E-reporting/ereporting.xsd',
)

export function validateAgainstEreportingXsd(xml: string): {
  valid: boolean
  errors: string
} {
  const dir = mkdtempSync(join(tmpdir(), 'factelec-ereport-xsd-'))
  const xmlPath = join(dir, 'report.xml')
  writeFileSync(xmlPath, xml, 'utf8')
  try {
    execFileSync('xmllint', ['--noout', '--schema', EREPORTING_XSD, xmlPath], {
      stdio: 'pipe',
    })
    return { valid: true, errors: '' }
  } catch (error) {
    const e = error as { stderr?: Buffer }
    return { valid: false, errors: e.stderr?.toString() ?? String(error) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
```

- [ ] **Step 3 : Tests (RED) — génération XSD-valide + forme minimale**

`apps/api/tests/unit/flux10-xml.test.ts` :
```ts
import { describe, expect, it } from 'vitest'
import { generateEreportingXml } from '../../src/ereporting/flux10-xml.js'
import type { Flux10Report } from '../../src/ereporting/flux10-model.js'
import { validateAgainstEreportingXsd } from '../helpers/ereporting-xsd.js'

const sender = {
  id: 'PA01',
  schemeId: '0238',
  name: 'Factelec PA',
  roleCode: 'WK',
} as const
const issuer = {
  id: '123456789',
  schemeId: '0002',
  name: 'Vendeur SARL',
  roleCode: 'SE',
} as const

// TB-1 + TB-2 avec une transaction agrégée B2C (10.3) minimale XSD-valide.
const report: Flux10Report = {
  document: {
    id: 'TRX-2026-0001',
    issueDateTime: '20260921080000',
    typeCode: 'IN',
    sender,
    issuer,
  },
  transactions: {
    periodStart: '20260901',
    periodEnd: '20260910',
    invoices: [],
    aggregated: [
      {
        date: '20260905',
        currency: 'EUR',
        categoryCode: 'TLB1',
        taxExclusiveAmount: '1000.00',
        taxTotal: '200.00',
        subtotals: [
          { taxPercent: '20.00', taxableAmount: '1000.00', taxTotal: '200.00' },
        ],
      },
    ],
  },
  payments: null,
}

describe('generateEreportingXml', () => {
  it('produit un XML valide contre le XSD DGFiP e-reporting', () => {
    const xml = generateEreportingXml(report)
    const { valid, errors } = validateAgainstEreportingXsd(xml)
    expect(errors).toBe('')
    expect(valid).toBe(true)
  })

  it('sérialise TB-1 (ReportDocument) obligatoire et TB-2 (période + agrégat)', () => {
    const xml = generateEreportingXml(report)
    expect(xml).toContain('<Report')
    expect(xml).toContain('<ReportDocument>')
    expect(xml).toContain('<TypeCode>IN</TypeCode>')
    expect(xml).toContain('schemeId="0238"')
    expect(xml).toContain('<StartDate>20260901</StartDate>')
    expect(xml).toContain('<CategoryCode>TLB1</CategoryCode>')
  })

  it('échappe les caractères XML dangereux (injection-proof)', () => {
    const r: Flux10Report = {
      ...report,
      document: { ...report.document, issuer: { ...issuer, name: 'A & <B>' } },
    }
    const xml = generateEreportingXml(r)
    expect(xml).toContain('A &amp; &lt;B&gt;')
    expect(validateAgainstEreportingXsd(xml).valid).toBe(true)
  })
})
```
Run: `pnpm --filter @factelec/api test -- flux10-xml` → RED.

- [ ] **Step 4 : Implémentation (GREEN) — modèle + générateur**

> **Découverte empirique (risque #1)** : `ereporting.xsd` sans `targetNamespace`, `elementFormDefault` unqualified → **instance sans préfixe de namespace**. Générer des éléments nus ; ajuster **jusqu'à ce que `xmllint` passe** (le test XSD est la sentinelle, comme le pivot F1 en 1.1). Golden capté après validation verte.

`apps/api/src/ereporting/flux10-model.ts` :
```ts
import type { Flux10Category, IssuerRole, TransmissionType } from './nomenclature.js'

export interface Flux10Party {
  id: string
  schemeId: string // 0238 (émetteur PA) | 0002 (déclarant SIREN)
  name: string
  roleCode: string // WK (émetteur) | BY|SE (déclarant)
}
export interface ReportDocument {
  id: string // TT-1
  name?: string // TT-2
  issueDateTime: string // TT-3, AAAAMMJJHHMMSS
  typeCode: TransmissionType // TT-4
  sender: Flux10Party // TG-3
  issuer: Flux10Party & { roleCode: IssuerRole } // TG-5
}
export interface Flux10SubTotal {
  taxPercent: string // TT-86/TT-93
  taxableAmount: string // TT-87
  taxTotal: string // TT-88
  currency?: string // TT-94 (paiements)
}
// Forme agrégée B2C 10.3 (TG-31 Transactions).
export interface AggregatedTransaction {
  date: string // TT-77 AAAAMMJJ
  currency: string // TT-78
  categoryCode: Flux10Category // TT-81
  taxExclusiveAmount: string // TT-82
  taxTotal: string // TT-83
  transactionsCount?: number // TT-85 (facultatif, simplification §2.3.3)
  subtotals: Flux10SubTotal[] // TG-32
}
// Forme par facture B2B international 10.1 (TG-8 Invoice) — minimale XSD.
export interface Flux10Invoice {
  id: string // TT-19
  issueDate: string // TT-20
  typeCode: string // TT-21 (UNTDID 1001)
  currency: string // TT-22
  businessProcessId: string // TT-28
  businessProcessTypeId: string // TT-29
  seller: { companyId: string; schemeId: string; countryId?: string } // TG-12
  taxAmount: string // TT-52 (@CurrencyCode)
  taxSubTotals: {
    taxableAmount: string // TT-54
    taxAmount: string // TT-55
    categoryCode?: string // TT-56
    percent: string // TT-57
  }[]
}
export interface TransactionsReport {
  periodStart: string // TT-17
  periodEnd: string // TT-18
  invoices: Flux10Invoice[] // TG-8 (10.1)
  aggregated: AggregatedTransaction[] // TG-31 (10.3)
}
export interface PaymentsReport {
  periodStart: string
  periodEnd: string
  invoices: {
    invoiceId: string
    issueDate: string
    paymentDate: string
    subtotals: Flux10SubTotal[]
  }[]
}
export interface Flux10Report {
  document: ReportDocument // TB-1 (obligatoire)
  transactions: TransactionsReport | null // TB-2 (0..1)
  payments: PaymentsReport | null // TB-3 (0..1)
}
```

`apps/api/src/ereporting/flux10-xml.ts` :
```ts
import { create } from 'xmlbuilder2'
import type { XMLBuilder } from 'xmlbuilder2/lib/interfaces.js'
import type {
  Flux10Invoice,
  Flux10Report,
  TransactionsReport,
} from './flux10-model.js'

// Génération XSD-valide du rapport Flux 10 (ereporting.xsd). L'instance est
// SANS namespace (ereporting.xsd sans targetNamespace, elementFormDefault
// unqualified) — confirmé empiriquement par xmllint (tests/unit/flux10-xml).
export function generateEreportingXml(report: Flux10Report): string {
  const doc = create({ version: '1.0', encoding: 'UTF-8' })
  const root = doc.ele('Report')
  appendReportDocument(root, report.document)
  if (report.transactions) appendTransactionsReport(root, report.transactions)
  else if (report.payments) appendPaymentsReport(root, report.payments)
  return doc.end({ prettyPrint: true })
}

function appendReportDocument(root: XMLBuilder, d: Flux10Report['document']): void {
  const rd = root.ele('ReportDocument')
  rd.ele('Id').txt(d.id)
  if (d.name) rd.ele('Name').txt(d.name)
  rd.ele('IssueDateTime').ele('DateTimeString').txt(d.issueDateTime)
  rd.ele('TypeCode').txt(d.typeCode)
  const s = rd.ele('Sender')
  s.ele('Id').att('schemeId', d.sender.schemeId).txt(d.sender.id)
  s.ele('Name').txt(d.sender.name)
  s.ele('RoleCode').txt(d.sender.roleCode)
  const i = rd.ele('Issuer')
  i.ele('Id').att('schemeId', d.issuer.schemeId).txt(d.issuer.id)
  i.ele('Name').txt(d.issuer.name)
  i.ele('RoleCode').txt(d.issuer.roleCode)
}

function appendTransactionsReport(root: XMLBuilder, t: TransactionsReport): void {
  const tr = root.ele('TransactionsReport')
  const p = tr.ele('ReportPeriod')
  p.ele('StartDate').txt(t.periodStart)
  p.ele('EndDate').txt(t.periodEnd)
  for (const inv of t.invoices) appendInvoice(tr, inv)
  for (const a of t.aggregated) {
    const x = tr.ele('Transactions')
    x.ele('Date').txt(a.date)
    x.ele('TransactionsCurrency').txt(a.currency)
    x.ele('CategoryCode').txt(a.categoryCode)
    x.ele('TaxExclusiveAmount').txt(a.taxExclusiveAmount)
    x.ele('TaxTotal').txt(a.taxTotal)
    if (a.transactionsCount !== undefined)
      x.ele('TransactionsCount').txt(String(a.transactionsCount))
    for (const st of a.subtotals) {
      const s = x.ele('TaxSubtotal')
      s.ele('TaxPercent').txt(st.taxPercent)
      s.ele('TaxableAmount').txt(st.taxableAmount)
      s.ele('TaxTotal').txt(st.taxTotal)
    }
  }
}

function appendInvoice(tr: XMLBuilder, inv: Flux10Invoice): void {
  const x = tr.ele('Invoice')
  x.ele('ID').txt(inv.id)
  x.ele('IssueDate').txt(inv.issueDate)
  x.ele('TypeCode').txt(inv.typeCode)
  x.ele('CurrencyCode').txt(inv.currency)
  const bp = x.ele('BusinessProcess')
  bp.ele('ID').txt(inv.businessProcessId)
  bp.ele('TypeID').txt(inv.businessProcessTypeId)
  const seller = x.ele('Seller')
  seller.ele('CompanyId').att('schemeId', inv.seller.schemeId).txt(inv.seller.companyId)
  if (inv.seller.countryId)
    seller.ele('PostalAddress').ele('CountryId').txt(inv.seller.countryId)
  const mt = x.ele('MonetaryTotal')
  mt.ele('TaxAmount').att('CurrencyCode', inv.currency).txt(inv.taxAmount)
  for (const st of inv.taxSubTotals) {
    const s = x.ele('TaxSubTotal')
    s.ele('TaxableAmount').txt(st.taxableAmount)
    s.ele('TaxAmount').txt(st.taxAmount)
    const cat = s.ele('TaxCategory')
    if (st.categoryCode) cat.ele('Code').txt(st.categoryCode)
    cat.ele('Percent').txt(st.percent)
  }
}

// TB-3 supporté structurellement (D10) ; agrégation différée faute de source.
function appendPaymentsReport(root: XMLBuilder, pmt: NonNullable<Flux10Report['payments']>): void {
  const pr = root.ele('PaymentsReport')
  const p = pr.ele('ReportPeriod')
  p.ele('StartDate').txt(pmt.periodStart)
  p.ele('EndDate').txt(pmt.periodEnd)
  for (const inv of pmt.invoices) {
    const x = pr.ele('Invoice')
    x.ele('InvoiceID').txt(inv.invoiceId)
    x.ele('IssueDate').txt(inv.issueDate)
    const pay = x.ele('Payment')
    pay.ele('Date').txt(inv.paymentDate)
    for (const st of inv.subtotals) {
      const s = pay.ele('SubTotals')
      s.ele('TaxPercent').txt(st.taxPercent)
      if (st.currency) s.ele('CurrencyCode').txt(st.currency)
      s.ele('Amount').txt(st.taxTotal)
    }
  }
}
```
Run: `pnpm --filter @factelec/api test -- flux10-xml` → **ajuster jusqu'à validation XSD verte** puis PASS.

- [ ] **Step 5 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test && pnpm run audit:ci && pnpm outdated -r
git add -A
git commit -m "feat(api): modèle Flux 10 et génération XML validée contre le XSD DGFiP e-reporting"
```
Expected: PASS, XSD verte, couverture ≥ 90 %×4, audit 0, outdated vierge.

---

### Task 3 : Agrégation des transactions depuis les factures (BT → TT) + détection à blanc

**Files:**
- Create: `apps/api/src/ereporting/flux10-aggregate.ts`
- Create: `apps/api/tests/unit/flux10-aggregate.test.ts`

**Interfaces:**
- Consumes : `Invoice` (`@factelec/invoice-core`), Task 1 (correspondance), Task 2 (modèle).
- Produces (Task 8) : `aggregateTransactions(invoices, { periodStart, periodEnd, scope }): TransactionsReport | null` (null = à blanc, D6). `scope` = `b2c` (agrégat TG-31) | `b2bi` (par facture TG-8).

- [ ] **Step 1 : Tests (RED) — agrégation B2C + à blanc + mapping BT→TT**

`apps/api/tests/unit/flux10-aggregate.test.ts` :
```ts
import { buildInvoice } from '@factelec/invoice-core'
import { describe, expect, it } from 'vitest'
import { aggregateTransactions } from '../../src/ereporting/flux10-aggregate.js'

const inv = (over: Record<string, unknown>) =>
  buildInvoice({
    number: 'FA-1', issueDate: '2026-09-05', typeCode: '380', currency: 'EUR',
    businessProcessType: 'B1',
    seller: { name: 'V', siren: '123456789', address: { countryCode: 'FR' } },
    buyer: { name: 'A', address: { countryCode: 'FR' } },
    lines: [{ id: '1', name: 'x', quantity: '1', unitCode: 'C62', unitPrice: '1000.00', vatCategory: 'S', vatRate: '20.00' }],
    ...over,
  })

describe('aggregateTransactions (B2C 10.3)', () => {
  it('retourne null pour une période sans opération (transmission à blanc, D6)', () => {
    expect(
      aggregateTransactions([], { periodStart: '20260901', periodEnd: '20260910', scope: 'b2c' }),
    ).toBeNull()
  })

  it('agrège par (date, devise, catégorie) et somme base/TVA par taux', () => {
    const report = aggregateTransactions(
      [inv({}), inv({ number: 'FA-2' })],
      { periodStart: '20260901', periodEnd: '20260910', scope: 'b2c' },
    )
    expect(report).not.toBeNull()
    expect(report?.aggregated).toHaveLength(1) // même jour/devise/catégorie (B1→TLB1)
    const a = report!.aggregated[0]
    expect(a.categoryCode).toBe('TLB1')
    expect(a.date).toBe('20260905')
    expect(a.taxExclusiveAmount).toBe('2000.00')
    expect(a.taxTotal).toBe('400.00')
    expect(a.subtotals).toEqual([
      { taxPercent: '20.00', taxableAmount: '2000.00', taxTotal: '400.00' },
    ])
  })

  it('ventile un cadre mixte M1 sur TLB1 et TPS1', () => {
    const report = aggregateTransactions(
      [inv({ businessProcessType: 'M1' })],
      { periodStart: '20260901', periodEnd: '20260910', scope: 'b2c' },
    )
    expect(report?.aggregated.map((a) => a.categoryCode).sort()).toEqual(['TLB1', 'TPS1'])
  })
})
```
Run: `pnpm --filter @factelec/api test -- flux10-aggregate` → RED.

- [ ] **Step 2 : Implémentation (GREEN)**

`apps/api/src/ereporting/flux10-aggregate.ts` (esquisse — l'implémenteur complète la ventilation et le mapping B2Bi) :
```ts
import Big from 'big.js'
import type { Invoice } from '@factelec/invoice-core'
import type { AggregatedTransaction, TransactionsReport } from './flux10-model.js'
import { mapCadreToCategories } from './nomenclature.js'

export interface AggregateOptions {
  periodStart: string // AAAAMMJJ
  periodEnd: string
  scope: 'b2c' | 'b2bi'
}

// Dérive un TransactionsReport des factures d'une période. null si aucune
// opération (transmission à blanc OPTIONNELLE, D6). B2C (10.3) → agrégat
// TG-31 groupé par (date, devise, catégorie) ; B2Bi (10.1) → une Invoice
// TG-8 par facture (mapping minimal XSD).
export function aggregateTransactions(
  invoices: Invoice[],
  opts: AggregateOptions,
): TransactionsReport | null {
  if (invoices.length === 0) return null
  if (opts.scope === 'b2bi') {
    return {
      periodStart: opts.periodStart,
      periodEnd: opts.periodEnd,
      invoices: invoices.map(toFlux10Invoice),
      aggregated: [],
    }
  }
  // B2C : clé (date AAAAMMJJ ‖ devise ‖ catégorie).
  const buckets = new Map<string, AggregatedTransaction>()
  for (const inv of invoices) {
    const date = inv.issueDate.replaceAll('-', '')
    const categories = inv.businessProcessType
      ? mapCadreToCategories(inv.businessProcessType)
      : ['TLB1'] // défaut documenté si BT-23 absent (à confirmer go-live)
    for (const category of categories) {
      for (const vb of inv.vatBreakdown) {
        const key = `${date}|${inv.currency}|${category}`
        const bucket = buckets.get(key) ?? {
          date, currency: inv.currency, categoryCode: category,
          taxExclusiveAmount: '0.00', taxTotal: '0.00', subtotals: [],
        }
        bucket.taxExclusiveAmount = new Big(bucket.taxExclusiveAmount)
          .plus(vb.taxableAmount).toFixed(2)
        bucket.taxTotal = new Big(bucket.taxTotal).plus(vb.taxAmount).toFixed(2)
        const sub = bucket.subtotals.find((s) => s.taxPercent === vb.rate)
        if (sub) {
          sub.taxableAmount = new Big(sub.taxableAmount).plus(vb.taxableAmount).toFixed(2)
          sub.taxTotal = new Big(sub.taxTotal).plus(vb.taxAmount).toFixed(2)
        } else {
          bucket.subtotals.push({
            taxPercent: vb.rate, taxableAmount: vb.taxableAmount, taxTotal: vb.taxAmount,
          })
        }
        buckets.set(key, bucket)
      }
    }
  }
  return {
    periodStart: opts.periodStart,
    periodEnd: opts.periodEnd,
    invoices: [],
    aggregated: [...buckets.values()],
  }
}

function toFlux10Invoice(inv: Invoice) {
  return {
    id: inv.number, issueDate: inv.issueDate.replaceAll('-', ''),
    typeCode: inv.typeCode, currency: inv.currency,
    businessProcessId: inv.businessProcessType ?? 'B1',
    businessProcessTypeId: 'e-reporting-fr', // TT-29 : valeur provisoire (D9, à confirmer go-live)
    seller: {
      companyId: inv.seller.siren ?? '', schemeId: '0002',
      countryId: inv.seller.address.countryCode,
    },
    taxAmount: inv.totals.taxAmount,
    taxSubTotals: inv.vatBreakdown.map((vb) => ({
      taxableAmount: vb.taxableAmount, taxAmount: vb.taxAmount,
      categoryCode: vb.category, percent: vb.rate,
    })),
  }
}
```
Run: `pnpm --filter @factelec/api test -- flux10-aggregate` → PASS. **Note interprétation (D9)** : `businessProcessTypeId` (TT-29) et le défaut de catégorie sans BT-23 sont **provisoires**, à confirmer contre l'Annexe 7 au go-live (commentaire dans le code + suivi Task 10).

- [ ] **Step 3 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): agrégation des transactions e-reporting depuis les factures (BT→TT, à blanc→null)"
```

---

### Task 4 : Machine à états e-reporting (300/301 + motifs) — module pur

**Files:**
- Create: `apps/api/src/ereporting/ereporting-lifecycle.ts`
- Create: `apps/api/tests/unit/ereporting-lifecycle.test.ts`

**Interfaces:**
- Consumes : Task 1 (`REJECT_MOTIFS`).
- Produces (Tasks 5-9) : `EREPORTING_STATUS_META` (`prepared`/`transmitted`/`deposee`=300/`rejetee`=301), `canTransition`, `isTerminal`, `motifRequired`, `assertTransition`, `EreportingStatus`.

> **Miroir structurel de `src/invoices/lifecycle-status.ts` mais SÉPARÉ (D5)** — ne PAS réutiliser le CDV facture. États internes PA (`prepared`→`transmitted`) puis acquittement PPF (`deposee` 300 / `rejetee` 301, terminaux). `rejetee` exige un motif (`REJ_*`). Figure 59 non extractible → modèle binaire fondé sur le texte §3.7.9, marqué interprétation.

- [ ] **Step 1 : Tests (RED)**

`apps/api/tests/unit/ereporting-lifecycle.test.ts` :
```ts
import { describe, expect, it } from 'vitest'
import {
  assertTransition,
  canTransition,
  EREPORTING_STATUS_META,
  InvalidEreportingTransitionError,
  isTerminal,
  motifRequired,
} from '../../src/ereporting/ereporting-lifecycle.js'

describe('machine à états e-reporting (300/301)', () => {
  it('ancre les codes réglementaires 300/301', () => {
    expect(EREPORTING_STATUS_META.deposee.code).toBe(300)
    expect(EREPORTING_STATUS_META.rejetee.code).toBe(301)
  })
  it('autorise prepared→transmitted→deposee et transmitted→rejetee', () => {
    expect(canTransition('prepared', 'transmitted')).toBe(true)
    expect(canTransition('transmitted', 'deposee')).toBe(true)
    expect(canTransition('transmitted', 'rejetee')).toBe(true)
  })
  it('interdit toute sortie des statuts terminaux 300/301', () => {
    expect(isTerminal('deposee')).toBe(true)
    expect(isTerminal('rejetee')).toBe(true)
    expect(canTransition('deposee', 'rejetee')).toBe(false)
    expect(canTransition('rejetee', 'deposee')).toBe(false)
  })
  it('exige un motif pour un rejet (301)', () => {
    expect(motifRequired('rejetee')).toBe(true)
    expect(motifRequired('deposee')).toBe(false)
  })
  it('assertTransition lève sur une transition invalide', () => {
    expect(() => assertTransition('prepared', 'deposee')).toThrow(
      InvalidEreportingTransitionError,
    )
  })
})
```
Run: `pnpm --filter @factelec/api test -- ereporting-lifecycle` → RED.

- [ ] **Step 2 : Implémentation (GREEN)** — calquer `lifecycle-status.ts` (`Object.hasOwn` pour le garde de type, table `STATUS_META`, `TERMINAL_STATUSES`, transitions explicites `ALLOWED` plutôt que monotones — l'espace d'états e-reporting est petit et non ordonnable numériquement) :
```ts
// Cycle de vie e-reporting Flux 10 — DISTINCT du CDV facture (D5, spec §3.7.9).
// Statuts officiels PPF : 300 Déposée (Tableau 5) / 301 Rejetée (+ motif REJ_*,
// Tableau 6, §3.7.10). `prepared`/`transmitted` = états internes PA avant
// acquittement. Figure 59 (visuel) non extractible → modèle binaire fondé sur
// le TEXTE §3.7.9, marqué INTERPRÉTATION PROJET.
import type { RejectMotif } from './nomenclature.js'

export const EREPORTING_STATUS_META = {
  prepared: { code: 0, label: 'Préparée (PA)' },
  transmitted: { code: 1, label: 'Transmise au PPF (PA)' },
  deposee: { code: 300, label: 'Déposée' },
  rejetee: { code: 301, label: 'Rejetée' },
} as const
export type EreportingStatus = keyof typeof EREPORTING_STATUS_META

const ALLOWED: Record<EreportingStatus, EreportingStatus[]> = {
  prepared: ['transmitted'],
  transmitted: ['deposee', 'rejetee'],
  deposee: [],
  rejetee: [],
}
const TERMINAL = new Set<EreportingStatus>(['deposee', 'rejetee'])

export function isEreportingStatus(v: unknown): v is EreportingStatus {
  return typeof v === 'string' && Object.hasOwn(EREPORTING_STATUS_META, v)
}
export function isTerminal(s: EreportingStatus): boolean {
  return TERMINAL.has(s)
}
export function motifRequired(s: EreportingStatus): boolean {
  return s === 'rejetee'
}
export function canTransition(from: EreportingStatus, to: EreportingStatus): boolean {
  return ALLOWED[from].includes(to)
}
export class InvalidEreportingTransitionError extends Error {
  constructor(readonly from: EreportingStatus, readonly to: EreportingStatus) {
    super(`invalid e-reporting transition: ${from} → ${to}`)
    this.name = 'InvalidEreportingTransitionError'
  }
}
export function assertTransition(from: EreportingStatus, to: EreportingStatus): void {
  if (!canTransition(from, to)) throw new InvalidEreportingTransitionError(from, to)
}
export type { RejectMotif }
```
Run → PASS.

- [ ] **Step 3 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): machine à états e-reporting 300/301 avec motifs de rejet (distincte du CDV)"
```

---

### Task 5 : Persistance — déclarants, transmissions, journal (RLS `FORCE`, moindre privilège)

**Files:**
- Modify: `apps/api/src/db/schema.ts` (enums + 3 tables)
- Create: `apps/api/src/db/migrations/0016_ereporting_tables.sql` (drizzle) + snapshot + `_journal`
- Create: `apps/api/src/db/migrations/0017_ereporting_rls.sql` (hand : RLS/grants + SD `find_ereporting_declarants_due`)
- Create: `apps/api/src/ereporting/ereporting.repository.ts`
- Create: `apps/api/tests/e2e/ereporting-persistence.e2e.test.ts`

**Interfaces:**
- Consumes : Task 1 (`VAT_REGIMES`, `ISSUER_ROLES`, `REJECT_MOTIFS`, `TRANSMISSION_TYPES`), Task 4 (`EreportingStatus`), `TenantContextService` (`runInTenant`).
- Produces (Tasks 7-8-9) : tables `ereporting_declarants`/`ereporting_transmissions`/`ereporting_status_events` sous RLS `FORCE` ; SD cross-tenant `find_ereporting_declarants_due` ; repository (`upsertDeclarant`, `listDeclarantsByTenant`, `insertTransmission`, `appendStatusEvent`, `listTransmissions`, `loadTransmissionXml`, `listStatusEvents`, `invoicesForPeriod`).

- [ ] **Step 1 : Schéma (enums + tables)**

`apps/api/src/db/schema.ts` — ajouter :
```ts
export const ereportingVatRegime = pgEnum('ereporting_vat_regime', [
  'reel_normal_mensuel', 'reel_normal_trimestriel', 'simplifie', 'franchise',
])
export const ereportingIssuerRole = pgEnum('ereporting_issuer_role', ['BY', 'SE'])
export const ereportingTransmissionType = pgEnum('ereporting_transmission_type', ['IN', 'RE'])
export const ereportingFluxKind = pgEnum('ereporting_flux_kind', ['transactions', 'payments'])
export const ereportingStatus = pgEnum('ereporting_status', [
  'prepared', 'transmitted', 'deposee', 'rejetee', // 300/301 = deposee/rejetee (D5)
])
export const ereportingRejectMotif = pgEnum('ereporting_reject_motif', [
  'REJ_SEMAN', 'REJ_UNI', 'REJ_COH', 'REJ_PER',
])

// Config par déclarant (D11) : maille SIREN × rôle, régime TVA (→ cadence).
export const ereportingDeclarants = pgTable('ereporting_declarants', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  siren: text('siren').notNull(),
  name: text('name').notNull(),
  role: ereportingIssuerRole('role').notNull(),
  vatRegime: ereportingVatRegime('vat_regime').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('ereporting_declarants_tenant_siren_role_unique').on(t.tenantId, t.siren, t.role),
  index('ereporting_declarants_tenant_idx').on(t.tenantId),
])

export const ereportingTransmissions = pgTable('ereporting_transmissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  declarantId: uuid('declarant_id').notNull().references(() => ereportingDeclarants.id, { onDelete: 'restrict' }),
  transmissionRef: text('transmission_ref').notNull(), // TT-1
  type: ereportingTransmissionType('type').notNull(), // IN/RE
  fluxKind: ereportingFluxKind('flux_kind').notNull(),
  periodStart: text('period_start').notNull(), // AAAAMMJJ
  periodEnd: text('period_end').notNull(),
  status: ereportingStatus('status').notNull().default('prepared'),
  invoiceCount: integer('invoice_count').notNull().default(0),
  trackingId: text('tracking_id'),
  xml: text('xml'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('ereporting_transmissions_tenant_idx').on(t.tenantId, t.createdAt),
  index('ereporting_transmissions_declarant_period_idx').on(t.declarantId, t.periodStart),
])

// Journal APPEND-ONLY du cycle de vie e-reporting (NON scellé, D3/D5).
export const ereportingStatusEvents = pgTable('ereporting_status_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  transmissionId: uuid('transmission_id').notNull().references(() => ereportingTransmissions.id, { onDelete: 'restrict' }),
  fromStatus: ereportingStatus('from_status'),
  toStatus: ereportingStatus('to_status').notNull(),
  motif: ereportingRejectMotif('motif'), // requis ssi to_status='rejetee'
  actor: text('actor').notNull(), // 'platform' | 'ppf' | 'user:<uuid>'
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('ereporting_status_events_transmission_idx').on(t.transmissionId, t.createdAt)])
```

- [ ] **Step 2 : Migration drizzle (0016)**
```bash
pnpm --filter @factelec/api db:generate   # → 0016_<slug>.sql + snapshot + entrée _journal
```
**Renommer** en `0016_ereporting_tables.sql`, tag idx 16 = `"0016_ereporting_tables"`. **Relire** : `CREATE TYPE` des 6 enums + `CREATE TABLE` des 3 tables + index/uniques. Aucune RLS/grant (migration manuelle 0017).

- [ ] **Step 3 : Migration manuelle RLS/grants + SD cross-tenant (0017)**

`apps/api/src/db/migrations/0017_ereporting_rls.sql` :
```sql
-- RLS FORCE + moindre privilège sur les 3 tables e-reporting (gabarit tenant_isolation).
ALTER TABLE ereporting_declarants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ereporting_declarants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON ereporting_declarants
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- Config opérateur : mutable (SELECT/INSERT/UPDATE/DELETE).
GRANT SELECT, INSERT, UPDATE, DELETE ON ereporting_declarants TO factelec_app;
--> statement-breakpoint
ALTER TABLE ereporting_transmissions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ereporting_transmissions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON ereporting_transmissions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- Transmissions : INSERT + UPDATE (statut/tracking/xml), pas de DELETE.
GRANT SELECT, INSERT, UPDATE ON ereporting_transmissions TO factelec_app;
--> statement-breakpoint
ALTER TABLE ereporting_status_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ereporting_status_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON ereporting_status_events
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- Journal APPEND-ONLY : SELECT + INSERT seulement (immuabilité par grants, D3/D5).
GRANT SELECT, INSERT ON ereporting_status_events TO factelec_app;
--> statement-breakpoint
-- Énumération CROSS-TENANT des déclarants actifs (l'ordonnanceur tourne hors
-- contexte tenant, comme find_failed_archives 0015). SD search_path épinglé
-- pg_catalog,pg_temp + table applicative schéma-qualifiée (propriétaire
-- BYPASSRLS : pas de shadowing possible même si factelec_app obtenait CREATE
-- sur public — même motif que 0012/0015).
CREATE OR REPLACE FUNCTION find_ereporting_declarants_due()
RETURNS TABLE (tenant_id uuid, id uuid, vat_regime public.ereporting_vat_regime, role public.ereporting_issuer_role, siren text, name text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
STABLE
AS $$
  SELECT tenant_id, id, vat_regime, role, siren, name
  FROM public.ereporting_declarants
  WHERE active = true
  ORDER BY tenant_id, id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION find_ereporting_declarants_due() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION find_ereporting_declarants_due() TO factelec_app;
```
Enregistrer 0017 dans `meta/_journal.json` : idx 17 (`version:"7"`, `when` epoch-ms arrondi, `tag:"0017_ereporting_rls"`, `breakpoints:true`, **sans** snapshot).

> **Note de calcul de la « dueness »** : `find_ereporting_declarants_due` renvoie ici **tous** les déclarants actifs ; c'est l'ordonnanceur (Task 7, `period.ts`) qui calcule, **par régime**, les périodes échues à l'instant `now`. Garder la sélection des échéances **hors SQL** (dans le module pur `period.ts`, unit-testable) évite d'enfouir la mécanique de deadlines — interprétation projet (D4) — dans une fonction DB.

- [ ] **Step 4 : Repository (extrait)**

`apps/api/src/ereporting/ereporting.repository.ts` — mêmes idiomes que `InvoicesRepository` (`this.tenant.run(tenantId, async (db) => …)`). Méthodes clés :
```ts
// invoicesForPeriod : factures d'un déclarant (rôle SE → seller.siren) émises
// dans [start,end], lues SOUS RLS (tenant courant). Sert à l'agrégation Task 8.
async invoicesForPeriod(tenantId: string, siren: string, role: 'BY' | 'SE', startIso: string, endIso: string): Promise<Invoice[]>
async insertTransmission(tenantId: string, row: NewTransmission): Promise<{ id: string }>  // + événement initial 'prepared'
async markTransmitted(tenantId: string, id: string, trackingId: string): Promise<void>       // 'prepared'→'transmitted' + journal
async appendStatusEvent(tenantId: string, id: string, from: EreportingStatus, to: EreportingStatus, actor: string, motif?: RejectMotif): Promise<void>
async listTransmissions(tenantId: string): Promise<TransmissionSummary[]>
async loadTransmissionXml(tenantId: string, id: string): Promise<string | null>
async listStatusEvents(tenantId: string, id: string): Promise<EreportingStatusEvent[]>
```

- [ ] **Step 5 : e2e (RED→GREEN) — isolation & append-only**

`apps/api/tests/e2e/ereporting-persistence.e2e.test.ts` (motifs 2.2 : `startTestDb`, `ownerPool`/`appPool` avec écouteur `error`) — prouver :
```ts
it('isole les déclarants par tenant (RLS FORCE)', async () => { /* déclarant tenant A invisible sous contexte tenant B */ })
it("interdit UPDATE/DELETE sur le journal e-reporting (42501)", async () => { /* append-only, comme invoice_status_events */ })
it('find_ereporting_declarants_due voit les déclarants de tous les tenants', async () => { /* SD cross-tenant */ })
it('bloque la suppression d’une transmission munie d’un journal (23503)', async () => { /* FK restrict */ })
```
Run: `pnpm --filter @factelec/api test -- ereporting-persistence` → PASS.

- [ ] **Step 6 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): persistance e-reporting (déclarants, transmissions, journal) sous RLS FORCE et SD cross-tenant"
```

---

### Task 6 : Port de transmission Flux 10 + implémentation locale write-once + factory

**Files:**
- Modify: `apps/api/src/config/env.ts` (+ `EREPORTING_TRANSMISSION_DRIVER`, `EREPORTING_LOCAL_DIR`, `EREPORTING_PA_*`)
- Create: `apps/api/src/ereporting/flux10-transmission.port.ts`, `apps/api/src/ereporting/local-filesystem-transmission-store.ts`, `apps/api/src/ereporting/ereporting-transmission.module.ts`
- Modify: `apps/api/tests/unit/env.test.ts`
- Create: `apps/api/tests/unit/local-filesystem-transmission-store.test.ts`

**Interfaces:**
- Consumes : env config.
- Produces (Task 8) : `FLUX10_TRANSMISSION` token + `Flux10TransmissionPort` (`transmit(payload): Promise<TransmitResult>`, `status(trackingId): Promise<TransmissionStatus>`) + `LocalFilesystemTransmissionStore` + `@Global` factory (throw documenté sur les drivers réels).

- [ ] **Step 1 : Env (RED→GREEN)** — ajouter à `env.ts` (motif `ARCHIVE_DRIVER`/`ARCHIVE_LOCAL_DIR`) :
```ts
  // ── e-reporting Flux 10 (D7/D11) ─────────────────────────────────────────
  EREPORTING_TRANSMISSION_DRIVER: z.enum(['local', 'sftp', 'as2', 'as4', 'api']).default('local'),
  EREPORTING_LOCAL_DIR: z.string().default('./var/ereporting'),
  EREPORTING_PA_ID: z.string().default('PA00'),        // TT-8 (matricule émetteur PA)
  EREPORTING_PA_SCHEME_ID: z.string().default('0238'), // TT-7
  EREPORTING_PA_NAME: z.string().default('Factelec PA'), // TT-9
  EREPORTING_SWEEP_EVERY_MS: z.coerce.number().int().positive().default(3_600_000),
```
`env.test.ts` : cas défauts + override driver.

- [ ] **Step 2 : Port + impl locale (miroir `archive-store.port.ts` / `LocalFilesystemArchiveStore`)**

`apps/api/src/ereporting/flux10-transmission.port.ts` :
```ts
export const FLUX10_TRANSMISSION = Symbol('FLUX10_TRANSMISSION')

export interface TransmitPayload {
  tenantId: string
  transmissionRef: string
  fluxKind: 'transactions' | 'payments'
  xml: string
}
export interface TransmitResult {
  trackingId: string // identifiant de suivi renvoyé par le canal
  location: string
}
export interface TransmissionStatus {
  trackingId: string
  // Acquittement PPF si connu (300/301) — le canal local le simule ; le canal
  // réel l'obtiendra via le cycle de vie PPF (transport différé, D7).
  outcome: 'pending' | 'deposee' | 'rejetee'
}
// Contrat de transmission au PPF. Implémenté localement (dev/test) et — au
// déploiement — par un adaptateur SFTP/AS2/AS4/API (auth transport, D3/D7).
export interface Flux10TransmissionPort {
  transmit(payload: TransmitPayload): Promise<TransmitResult>
  status(trackingId: string): Promise<TransmissionStatus>
}

export class TransmissionRejectedError extends Error {
  constructor(readonly reason: string) {
    super(`transmission rejected: ${reason}`)
    this.name = 'TransmissionRejectedError'
  }
}
```

`local-filesystem-transmission-store.ts` : écrit le XML **write-once** (`wx` + `chmod 0o444`, anti-traversée `SAFE_KEY`/normalize/'..'), `trackingId = sha256(xml)` (hex), `status` renvoie `pending` par défaut (acquittement appliqué par Task 9). Tests : write-once (rejeu = idempotent), traversée refusée, trackingId déterministe.

`ereporting-transmission.module.ts` (`@Global`, factory par `EREPORTING_TRANSMISSION_DRIVER`) :
```ts
// local → LocalFilesystemTransmissionStore ; sftp/as2/as4/api → THROW documenté
// (adaptateur réel activé au déploiement, D7 — non fourni/non testable ici).
useFactory: (config) => {
  const driver = config.get('EREPORTING_TRANSMISSION_DRIVER', { infer: true })
  if (driver === 'local')
    return new LocalFilesystemTransmissionStore(config.get('EREPORTING_LOCAL_DIR', { infer: true }))
  throw new Error(`e-reporting transmission driver '${driver}' activé au déploiement (non fourni en 2.3)`)
}
```
La branche `throw` est **testée** (factory invoquée avec `EREPORTING_TRANSMISSION_DRIVER='sftp'` → lève) — une ligne couverte, comme la branche `s3` du port d'archivage (2.2/T5).

- [ ] **Step 3 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test && pnpm run audit:ci && pnpm outdated -r
git add -A
git commit -m "feat(api): port de transmission Flux 10 et implémentation locale write-once (adaptateurs réels différés)"
```

---

### Task 7 : Cadence par régime TVA (périodes) + ordonnanceur BullMQ répétable + file dédiée

**Files:**
- Create: `apps/api/src/ereporting/period.ts`, `apps/api/tests/unit/period.test.ts`
- Modify: `apps/api/src/queue/queue.constants.ts` (+ `EREPORTING_GENERATION_QUEUE`), `apps/api/src/queue/maintenance.job.ts` (+ `EREPORTING_SWEEP_JOB`)
- Create: `apps/api/src/queue/ereporting-generation.job.ts`, `apps/api/src/worker/ereporting.scheduler.ts`, `apps/api/src/worker/ereporting-sweep.service.ts`
- Modify: `apps/api/src/worker/maintenance.processor.ts`, `apps/api/src/worker/worker.module.ts`

**Interfaces:**
- Consumes : Task 1 (`VatRegime`), Task 5 (`find_ereporting_declarants_due` via repository), BullMQ.
- Produces (Task 8) : `computeDuePeriods(regime, referenceDate): DuePeriod[]` (pur) ; job répétable `EREPORTING_SWEEP_JOB` → énumère les déclarants dus → enfile `ereporting-generation` jobs (`{ tenantId, declarantId, siren, role, fluxKind, periodStart, periodEnd, type }`).

- [ ] **Step 1 : Tests (RED) — périodes par régime (vecteurs fixés, D4)**

`apps/api/tests/unit/period.test.ts` :
```ts
import { describe, expect, it } from 'vitest'
import { computeDuePeriods } from '../../src/ereporting/period.js'

// Vecteurs sur dates FIXES (Date UTC). La mécanique exacte des deadlines est une
// INTERPRÉTATION PROJET documentée (Tableau 13 partiellement extractible, D4).
describe('computeDuePeriods', () => {
  it('réel normal mensuel : décades 1-10 / 11-20 / 21-fin', () => {
    // Au 21/09, la 1ère décade (01-10/09) est échue (deadline le 21 à 08:00).
    const due = computeDuePeriods('reel_normal_mensuel', new Date(Date.UTC(2026, 8, 21, 9)))
    expect(due).toContainEqual({ periodStart: '20260901', periodEnd: '20260910' })
  })
  it('franchise en base : bimestres civils', () => {
    const due = computeDuePeriods('franchise', new Date(Date.UTC(2026, 10, 5)))
    expect(due[0].periodStart).toBe('20260901') // bimestre sept-oct
    expect(due[0].periodEnd).toBe('20261031')
  })
  it('simplifié : mensuel (mois civil)', () => {
    const due = computeDuePeriods('simplifie', new Date(Date.UTC(2026, 10, 1)))
    expect(due[0]).toEqual({ periodStart: '20260901', periodEnd: '20260930' })
  })
})
```
Run: `pnpm --filter @factelec/api test -- period` → RED.

- [ ] **Step 2 : Implémentation (GREEN)** — `period.ts` : mapping `CADENCE_BY_REGIME` (data-driven, D4) + calcul des fenêtres échues à `referenceDate` (décades / mois civil / bimestre). Commentaire d'en-tête **INTERPRÉTATION PROJET** citant §3.7.7 Tableau 13, à confirmer go-live. Fonctions pures, 100 % couvertes.

- [ ] **Step 3 : File, job, scheduler, sweep, dispatch**
- `queue.constants.ts` : `export const EREPORTING_GENERATION_QUEUE = 'ereporting-generation'`.
- `maintenance.job.ts` : `export const EREPORTING_SWEEP_JOB = 'ereporting-sweep'`.
- `ereporting-generation.job.ts` : payload minimal (identifiants seulement — motif 2.1).
- `ereporting.scheduler.ts` : `upsertJobScheduler('ereporting-sweep', { every: EREPORTING_SWEEP_EVERY_MS }, { name: EREPORTING_SWEEP_JOB })` (miroir `ArchiveRetryScheduler`).
- `ereporting-sweep.service.ts` : `find_ereporting_declarants_due()` → pour chaque déclarant, `computeDuePeriods(regime, now)` → enfile un job `ereporting-generation` par période (idempotence : `jobId` déterministe `${declarantId}:${fluxKind}:${periodStart}` → un rejeu du balayage ne duplique pas).
- `maintenance.processor.ts` : brancher `EREPORTING_SWEEP_JOB` → `ereportingSweep.sweep()`.
- `worker.module.ts` : ajouter les providers + le `@Processor(EREPORTING_GENERATION_QUEUE)` (Task 8) et la file au `WorkerQueueModule`.

> **Registre horloge** : `computeDuePeriods` prend `referenceDate` en paramètre (le sweep passe `new Date()`), gardant le module pur testable sur dates fixes (aucun `Date.now()` caché dans la logique de période).

- [ ] **Step 4 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): cadence e-reporting par régime TVA et ordonnanceur répétable des périodes dues"
```

---

### Task 8 : Worker de génération — période → agrégat → XML → validation → persistance → transmission

**Files:**
- Create: `apps/api/src/ereporting/ereporting-generation.service.ts`, `apps/api/src/worker/ereporting-generation.processor.ts`
- Create: `apps/api/tests/e2e/ereporting-generation.e2e.test.ts`
- Modify: `apps/api/tests/e2e/helpers/worker.ts` (override du port de transmission par un sink en mémoire)

**Interfaces:**
- Consumes : Task 3 (agrégation), Task 2 (XML + validation), Task 5 (repository), Task 6 (port), Task 1 (métadonnées PA/env).
- Produces : une `ereporting_transmissions` + son XML + événement initial + acquittement port, OU **rien** (à blanc, D6).

- [ ] **Step 1 : Service (GREEN après RED e2e)** `ereporting-generation.service.ts` — pipeline par job `{ tenantId, declarantId, siren, role, fluxKind, periodStart, periodEnd, type }` :
  1. `invoicesForPeriod(...)` (sous RLS) ;
  2. `aggregateTransactions(invoices, { periodStart, periodEnd, scope })` → **si `null` : return** (transmission à blanc, aucune écriture) ;
  3. assembler `Flux10Report` (TB-1 émetteur PA depuis env + déclarant depuis la config ; TB-2) ;
  4. `generateEreportingXml(report)` **puis valider** (le service **rejette** un XML non XSD-valide → `REJ_SEMAN` local, transmission `rejetee` motif `REJ_SEMAN` — cohérent avec le contrôle sémantique PPF) ;
  5. `insertTransmission(...)` (statut `prepared`, XML, invoiceCount) + événement initial ;
  6. `transmit(payload)` via le port → `markTransmitted(trackingId)` (`prepared`→`transmitted`).
  > La validation XSD **dans le worker** protège contre l'émission d'un flux malformé. **Note honnêteté (D9)** : XSD ≠ conformité sémantique complète (schematron/Annexe 7 différés) — un flux XSD-valide peut être `REJ_*` par le PPF (appliqué en Task 9).

- [ ] **Step 2 : e2e (RED→GREEN)** `ereporting-generation.e2e.test.ts` (Postgres réel, override du port par un sink en mémoire dans le helper worker — motif `InMemoryArchiveStore` 2.2/T6) :
```ts
it('génère et transmet une transmission pour une période avec opérations', async () => {
  // seed : déclarant SE régime réel_normal_mensuel + 2 factures FR le 05/09.
  // exécuter le service pour la période 01-10/09 → 1 transmission 'transmitted',
  // XML XSD-valide persisté, trackingId non nul, 1 événement 'prepared'→'transmitted'.
})
it('N’ÉMET RIEN pour une période sans opération (transmission à blanc, D6)', async () => {
  // aucune facture → aucune ligne ereporting_transmissions, aucun appel au port.
})
it('isole les transmissions par tenant (RLS)', async () => { /* … */ })
```
Run: `pnpm --filter @factelec/api test -- ereporting-generation` → PASS.

- [ ] **Step 3 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): worker de génération e-reporting (agrégat→XML validé→transmission, à blanc ignoré)"
```

---

### Task 9 : Acquittements PPF (300/301) + endpoints de consultation dual-auth

**Files:**
- Create: `apps/api/src/ereporting/ereporting-status.service.ts`, `apps/api/src/ereporting/ereporting.controller.ts`, `apps/api/src/ereporting/ereporting.module.ts`
- Modify: `apps/api/src/app.module.ts` (importer `EreportingModule`)
- Create: `apps/api/tests/e2e/ereporting-status.e2e.test.ts`, `apps/api/tests/e2e/ereporting-endpoints.e2e.test.ts`

**Interfaces:**
- Consumes : Task 4 (machine à états), Task 5 (repository), Task 6 (port `status`), guards session/clé API (`TenantAuthGuard`, motif `LedgerController`/`InvoicesController`).
- Produces : `EreportingStatusService.recordPpfStatus(tenantId, transmissionId, outcome, motif?)` (applique `assertTransition` + `motifRequired`, append journal) ; endpoints `GET /ereporting/transmissions`, `GET /ereporting/transmissions/:id/xml`, `GET /ereporting/transmissions/:id/events`.

- [ ] **Step 1 : Service d'acquittement (GREEN après RED e2e)** — applique la transition `transmitted`→`deposee`/`rejetee` (300/301) via `assertTransition`, **exige un motif `REJ_*` pour 301** (`motifRequired`), append au journal (`actor='ppf'`), met à jour `ereporting_transmissions.status`. La **source** de l'acquittement (le transport push PPF) est **différée** (D7) : le service est la **frontière** applicable par un futur adaptateur d'annuaire/webhook et **exercée directement** par les e2e.

- [ ] **Step 2 : e2e statut (RED→GREEN)** `ereporting-status.e2e.test.ts` :
```ts
it('applique un acquittement 300 (déposée) : transmitted→deposee', async () => { /* … */ })
it('applique un rejet 301 avec motif REJ_SEMAN : transmitted→rejetee', async () => { /* … */ })
it('refuse un rejet 301 SANS motif (422)', async () => { /* motifRequired */ })
it('refuse une transition invalide depuis un statut terminal (409/422)', async () => { /* assertTransition */ })
it('isole les acquittements par tenant', async () => { /* … */ })
```

- [ ] **Step 3 : Endpoints de consultation (dual-auth)** — `ereporting.controller.ts` (guards session **ou** clé API, 404 anti-fuite pour un id d'un autre tenant, motif `LedgerController`) :
  - `GET /ereporting/transmissions` → liste (résumé, sans XML) ;
  - `GET /ereporting/transmissions/:id/xml` → `text/xml` (404 si absent/autre tenant) ;
  - `GET /ereporting/transmissions/:id/events` → journal des statuts.
  e2e `ereporting-endpoints.e2e.test.ts` : dual-auth, isolation (404 byte-identique), forme des réponses.

- [ ] **Step 4 : Gate + commit**
```bash
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @factelec/api test
git add -A
git commit -m "feat(api): acquittements PPF 300/301 et endpoints de consultation e-reporting (dual-auth, isolation)"
```

---

### Task 10 : CI / docs / OpenAPI / bump version — clôture

**Files:**
- Modify: `README.md` racine, `apps/api/README.md`
- Modify: OpenAPI/Swagger (nouveaux endpoints `ereporting/*`)
- Modify: `apps/api/package.json` (`version` → `0.5.0`)

- [ ] **Step 1 : Documentation honnête** — décrire : sous-flux Flux 10 (10.1-10.4) et **contraste e-invoicing** ; **AUCUN scellement/signature message** (auth transport, D3) ; cadence par régime (décades/mensuel/bimestriel) **+ interprétation projet des deadlines à confirmer go-live** (D4) ; machine à états **300/301** distincte + motifs ; **transmission à blanc optionnelle** ; **port de transmission** + **adaptateurs réels différés au déploiement** (D7) ; **TB-3 paiements différé** faute de source (D10) ; **validation XSD structurelle, schematron sémantique différé** (D9) ; nomenclature `EREPORTING_*` env ; endpoints. **Feuille de route** : différés 2.4 (annuaire Flux 13/14), déploiement (adaptateurs transport réels, PPF push), sémantique (Annexe 7 + schematrons).

- [ ] **Step 2 : Bump version + gate finale + commit**
```bash
# apps/api/package.json : "version": "0.5.0" (phase 2.3 : e-reporting Flux 10)
pnpm format && pnpm lint && pnpm build && pnpm typecheck && pnpm test && pnpm run audit:ci && pnpm outdated -r
git add -A
git commit -m "docs(api): documentation e-reporting Flux 10 et bump version 0.5.0"
```
Expected: tout vert ; couverture invoice-core 100 %, apps/api ≥ 90 %×4, apps/web ≥ 90 %×4 ; audit:ci 0 ; outdated vierge.

---

## Self-Review (relecture contre la spec §3.7 / Annexe 6 et le cadrage 2.3)

**1. Couverture du cadrage :**
- Flux 10 = données d'opérations, distinct e-invoicing (D1) → Tasks 1-3. ✅
- Format XSD 3 blocs (TB-1 + TB-2 XOR TB-3), XSD-valide → Task 2 (validation `xmllint` contre `ereporting.xsd` DGFiP). ✅
- Agrégation depuis les factures (BT→TT, correspondance cadre→catégorie) → Tasks 1+3. ✅
- Cadence par régime TVA (décades/mensuel/bimestriel), data-driven → Tasks 1+7 ; deadlines = **interprétation projet documentée** (D4). ✅
- Machine à états 300/301 + 4 motifs, DISTINCTE du CDV → Task 4 ; journal append-only NON scellé → Task 5. ✅
- Transmission à blanc optionnelle → Tasks 3 (null) + 8 (skip). ✅
- AUCUN scellement/signature message (D3) ; PAF/scellement 2.2 non appliqués → explicité, journal non scellé. ✅
- Port de transmission différé (contrat + local testable ; adaptateurs réels au déploiement) → Tasks 6+8 ; throw testé (D7). ✅
- Réutilisation (Invoice, BullMQ, RLS/SD) → Tasks 3/5/7/8 (D8). ✅
- RLS FORCE + moindre privilège + SD `search_path=pg_catalog,pg_temp` schéma-qualifié → Task 5. ✅
- Aucune dette dépendances (xmlbuilder2 dédupliqué, audit 0/outdated vierge) → Tasks 2/6/10. ✅

**2. Placeholders / honnêteté :** aucun « TODO ». Points marqués **interprétation projet à confirmer go-live** (jamais fabriqués) : mécanique exacte des deadlines (D4), modèle binaire du cycle de vie (Figure 59 non extractible, D5), `businessProcessTypeId` TT-29 + défaut de catégorie sans BT-23 (D9), contrôles sémantiques schematron absents (D9). Différés honnêtement : adaptateurs transport réels + PPF push (D7), agrégation TB-3 paiements faute de source (D10), annuaire (2.4).

**3. Cohérence des types & migrations :** `Flux10Report`/`TransactionsReport`/`AggregatedTransaction` partagés Tasks 2-3-8 ; `EreportingStatus`/`RejectMotif` partagés Tasks 4-5-9 ; enums Drizzle (`ereporting_status` = `prepared`/`transmitted`/`deposee`/`rejetee`) alignés sur `EREPORTING_STATUS_META` (300/301) ; port `Flux10TransmissionPort`/`FLUX10_TRANSMISSION` cohérent impl locale ↔ factory ↔ service ; migrations **0016 (drizzle) → 0017 (hand)** contiguës après 0015 ; SD cross-tenant calquée sur `find_failed_archives`.

## Amendements possibles à l'exécution (à valider empiriquement)

- **A1** — **Qualification XML** : `ereporting.xsd` sans `targetNamespace`/unqualified → instance sans préfixe (Task 2). Si `xmllint` exige une qualification, ajuster le générateur jusqu'au vert (le test XSD est la sentinelle). Confirmer au premier run.
- **A2** — **Forme minimale XSD-valide** : la séquence `Invoice` (TG-8) et `Transactions` (TG-31) impose l'ORDRE des éléments ; si `xmllint` rejette, réordonner selon `transaction.xsd` (ex. `MonetaryTotal` avant `TaxSubTotal`, `TaxAmount` requis). Golden capté après vert.
- **A3** — **Override du port de transmission dans le worker e2e** : propager `FLUX10_TRANSMISSION` dans `WorkerModule` (helper `worker.ts`), même mécanique que l'override `ARCHIVE_STORE`/`REDIS_CONNECTION` (2.1/2.2).
- **A4** — **`invoicesForPeriod`** : filtrer par `issue_date` (texte `AAAA-MM-JJ`) dans `[startIso, endIso]` et par rôle (SE → `canonical->seller->siren`). Vérifier l'indexation ; sinon filtre applicatif borné (volumes de test faibles).
- **A5** — **`jobId` idempotent du sweep** : `${declarantId}:${fluxKind}:${periodStart}` évite les doublons entre deux balayages ; vérifier que BullMQ dédoublonne (option `jobId`).
- **A6** — **`computeDuePeriods`** : garder `referenceDate` en paramètre (aucun `Date.now()` dans la logique pure) ; le sweep passe `new Date()`.

## Execution Handoff

Plan complet, sauvegardé dans `docs/superpowers/plans/2026-07-15-phase2-3-ereporting-flux10.md`. Deux options :
1. **Subagent-Driven (recommandé)** — un subagent frais par tâche, revue Opus entre chaque (aligné 1.x/2.x).
2. **Inline** — exécution par lots avec points de contrôle.

**Questions d'arbitrage pour Xavier (avant exécution) :**
- **Q1 (paiements TB-3, D10)** : confirmer le **report de l'agrégation des paiements** (10.2/10.4) faute de modèle de capture des encaissements — ou prioriser d'abord un modèle de paiements ? Recommandation : **reporter** (livrer TB-1+TB-2 de bout en bout, TB-3 supporté structurellement).
- **Q2 (bounded context, D2)** : domaine Flux 10 dans `apps/api/src/ereporting/*` (retenu, précédent `archive-bundle`/`ledger-hash`) **ou** nouveau package `@factelec/ereporting-core` (séparation plus nette, surcoût build/exports) ? Recommandation : **rester dans `apps/api`**.
