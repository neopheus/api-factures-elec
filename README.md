# Factelec

Plateforme agréée (PA/PDP) de facturation électronique française, spécialisée
e-commerce — SaaS multi-tenant visant l'immatriculation DGFiP courant 2027, pour
l'échéance TPE/PME de septembre 2027.

Périmètre cible : e-invoicing B2B domestique (formats du socle, cycle de vie des
statuts), e-reporting DGFiP, annuaire central, archivage à valeur probante 10 ans,
point d'accès Peppol interne. Connecteurs natifs PrestaShop, WooCommerce, Shopify et
API publique pour les systèmes custom.

> **État du projet (18/07/2026) : plans 1.1, 1.2, 1.2bis, 1.3, 1.4, 2.1, 2.2,
> 2.3, 2.4, 3.1, 3.2, 3.3, 3.4 et 3.5 terminés et mergés ; plan 3.6
> (révocation de consentement) terminé sur cette branche ; dettes
> héritées soldées avant chaque plan suivant.**
> `invoice-core` (v0.3.1 — patch BT-9) livre les **formats du socle** : UBL 2.1
> Invoice **et** CreditNote (avoir), extraits de flux DGFiP F1 (facture et
> avoir), CII D16B (avec échéance de paiement BT-9) et Factur-X PDF/A-3 (CII
> embarqué), tous validés XSD + Schematron officiel EN 16931 (Node pur,
> saxon-js — un test canari prouve que le Schematron CII rejette bien un
> document non conforme) ; motifs d'exonération BT-120/121 avec appartenance
> VATEX (décision : liste interne, non exposée par l'API 1.3 — voir
> `packages/invoice-core/README.md`) ; tests par propriétés fast-check.
> Couverture 100 %.
>
> **1.3 — `apps/api` (NestJS 11 ESM)** livre l'**ingestion et la lecture des
> factures** : santé (`/health`, `/health/ready`), config validée zod
> (fail-fast), logs pino masqués, helmet/CORS allowlist ; **Postgres
> multi-tenant** avec RLS **`ENABLE` + `FORCE`** sur les 4 tables (policies
> fail-closed, rôle applicatif `factelec_app` **sans** `BYPASSRLS`) ; **auth
> par clés API Argon2id** (`fk_<prefix>.<secret>`, lookup via fonction
> `SECURITY DEFINER` pour résoudre l'ordre poule/œuf auth-avant-tenant) ;
> `POST /invoices` (validation `invoice-core`, génération **synchrone** des 5
> formats du socle, persistance transactionnelle, idempotence par
> `(tenant_id, number)`) ; lecture tenant-scopée (`GET /invoices`, pagination
> keyset micro-précise, `GET /invoices/:id`, `GET
> /invoices/:id/formats/:format` aux bons `Content-Type`) ; erreurs RFC 9457 ;
> **isolation cross-tenant testée** (DB et HTTP, 404 byte-identique) ; rate
> limiting par IP (429 réel, vérifié en e2e). Dettes 1.3 soldées en tout
> début de plan 1.4 : `createDb` (piège hors-tenant) retiré, `z.url()` (zod
> 4) remplace `z.string().url()` déprécié.
>
> **1.4 — authentification utilisateur, self-service et dashboard**
> livre : **users tenant-scopés** (email global unique, rôles
> `owner`/`admin`/`accountant`/`viewer`) et **sessions serveur httpOnly**
> (jetons opaques 256 bits hash-only, RLS `FORCE` deny-all, expiration
> **absolue** uniquement — pas de renouvellement glissant) avec **CSRF
> double-submit** ; `POST /auth/signup` **self-service transactionnel**
> (fonction `SECURITY DEFINER` unique, création tenant + owner atomique) ;
> `POST/GET /auth/login|me`, `POST /auth/logout` ; **gestion des clés API
> par session** (`POST/GET/DELETE /api-keys`, secret affiché une seule
> fois, révocation immédiate) ; **super admin plateforme minimal**
> (`POST /admin/login`, `GET /admin/tenants`, provisioning **CLI
> uniquement** `pnpm provision:admin`, isolation admin↔tenant prouvée dans
> les deux sens) ; **lecture des factures en dual-auth** (`GET /invoices*`
> accepte clé API **ou** session utilisateur du même tenant — l'ingestion
> `POST /invoices` reste exclusivement clé API) ; **`apps/web`** (Next.js
> 16 App Router, SPA authentifiée par cookie httpOnly, dashboard
> factures/clés API + espace super admin). **414 tests** au total
> (`invoice-core` 129 100 % · `apps/api` 237 ≥ 90 % · `apps/web` 48
> ≥ 90 % sur les 4 métriques). Détail complet : `apps/api/README.md`,
> `apps/web/README.md`.
>
> **2.1 — Workers BullMQ et cycle de vie des statuts (CDV)** livre : **infra
> Redis/BullMQ** (`QueueModule` producteur, connexion paresseuse ; sonde de
> readiness Redis bornée 2 s, `HealthCheckError` propre) ; **ingestion
> asynchrone** — **changement de contrat** vis-à-vis de 1.x :
> `POST /invoices` répond désormais **`201 { status: 'received' }`**
> (enfilement d'un job minimal `{tenantId, invoiceId}`, `jobId = invoiceId`
> pour l'idempotence — **aucun contenu de facture ne transite par Redis**),
> génération **asynchrone** des 5 formats du socle par un **worker BullMQ**
> séparé (`apps/api/src/worker-main.ts`, processus dédié `pnpm start:worker`,
> retries/backoff configurables, statut `generating → generated|failed`) ;
> **réconciliation auto-cicatrisante** (balayage périodique des factures
> `received`/`generating` orphelines, éviction des jobs `failed` épuisés) —
> une fenêtre résiduelle bornée (~15 min, `RECONCILIATION_GENERATING_STALE_MS`)
> subsiste en cas de `SIGTERM` du worker exactement entre marquage
> `generating` et complétion, rattrapée par le balayage suivant ; **cycle de
> vie des statuts CDV** — nomenclature DGFiP 14 statuts (200-213, socle
> obligatoire {200,210,212,213}), machine à états **ancrée depuis le
> 2026-07-19 sur les normes AFNOR XP Z12-012/XP Z12-014 (juillet 2025)** —
> transmission ordonnée, traitement indépendant, `refusee`/`rejetee`
> terminaux, `encaissee` ré-ouvrable (encaissements partiels) —, motif
> obligatoire pour `refusee`/`rejetee`/`en_litige`/`suspendue`, endpoints
> `POST/GET /invoices/:id/status` (rôles `owner`/`admin`/`accountant` + CSRF,
> CAS anti-race → 409 sur changement concurrent, 422 transition invalide) et
> **journal `invoice_status_events` append-only** (immuable par grants
> Postgres — substrat du futur journal à valeur probante, 2.2). Dettes 1.4
> soldées : `last_used_at` des clés API (écrit à l'authentification) et
> purge des sessions expirées (job BullMQ répétable). **512 tests** au total
> (`invoice-core` 129 100 % · `apps/api` 335 à 98.02/94.64/95.91/98.53 %
> (statements/branches/fonctions/lignes) · `apps/web` 48 à
> 100/96.66/100/100 %). Détail complet : `apps/api/README.md`.
>
> **2.2 — Scellement et archivage à valeur probante du journal CDV** livre :
> chaîne SHA-256 **par tenant**, calculée et **imposée par la base** (trigger
> `SECURITY DEFINER`, verrou consultatif par tenant, genesis dérivé du
> tenant, `pgcrypto`) sur le journal `invoice_status_events` (append-only
> depuis 2.1) ; **vérification d'intégrité** indépendante (recompute
> TypeScript pur, miroir exact du PL/pgSQL, endpoint `GET
> /invoices/:id/ledger`) ; **archivage WORM** — port `ArchiveStore`
> write-once + implémentation locale testable (`chmod 0o444`), adaptateur S3
> object-lock **différé à l'activation au déploiement** ; export de la
> **Piste d'Audit Fiable** (`GET /invoices/:id/paf`, JSON/CSV, **conception
> projet non normalisée DGFiP** — aucune spec externe v3.2 ne normalise ce
> format) ; **DLQ** des factures poison (cap de réconciliation
> `GENERATION_MAX_ATTEMPTS_CAP`, `invoice_dead_letters` append-only).
> Dettes soldées : retrait de la FK cascade du journal (`ON DELETE
> RESTRICT`, dette 2.1) et cap de réconciliation/DLQ (dette opérationnelle
> 2.1). **Honnêteté probatoire (limite intrinsèque, non résolue par ce
> plan)** : le scellement est une tamper-evidence contre l'édition/
> suppression/insertion **partielle** d'événements — ce n'est **pas** une
> inviolabilité de la chaîne live : un accès propriétaire peut **tronquer**
> la queue de chaîne (supprimer le dernier maillon laisse `1..n-1` valide)
> ou la **réécrire intégralement de façon cohérente** (genesis dérivé
> publiquement du tenant, donc recalculable) — deux modes intrinsèques à
> tout hash-chain auto-contenu (≠ MAC), détectables uniquement par
> l'**ancrage de tête** dans l'archive WORM externe, effectif seulement une
> fois l'adaptateur S3 object-lock **activé au déploiement**. **617 tests**
> au total (`invoice-core` 129 100 % · `apps/api` 440 à
> 98.11/95.1/96.09/98.48 % (statements/branches/fonctions/lignes) ·
> `apps/web` 48 à 100/96.66/100/100 %). Détail complet : `apps/api/README.md`.
>
> **2.3 — E-reporting DGFiP (Flux 10)** livre : le Flux 10 = transmission au
> PPF de **données d'opérations** (agrégats), **distinct** de l'e-invoicing
> (Flux 1-9) qui transmet des factures. **RÉSOLU de bout en bout : le
> sous-flux 10.3 (B2C domestique)**, transactions agrégées — classification
> par facture (`classifyEreportingOperation`), agrégation BT→TT (date ‖
> devise ‖ catégorie TLB1/TPS1), génération XML XSD-valide (`xmllint`),
> machine à états **300/301** distincte du CDV (statuts internes
> `prepared`/`transmitted` sans code DGFiP → `deposee`=300/`rejetee`=301),
> transmission à blanc optionnelle, cadence par régime TVA (Tableau 13),
> ordonnanceur BullMQ idempotent, acquittements PPF et endpoints de
> consultation dual-auth. **DIFFÉRÉS EXPLICITES (à ne pas surpromettre
> « B2B international livré »)** : 10.1/10.2 B2Bi (classifiées mais non
> émises), TB-3 paiements (10.2/10.4, aucun modèle de capture des
> encaissements), cadres de facturation **mixtes M1/M2/M4** (le modèle
> `Invoice` n'a aucun discriminant biens/services par ligne — une
> ventilation forcée aurait doublé la base/TVA déclarées, donc différée
> plutôt que fabriquée), adaptateurs de transport réels (sftp/as2/as4/api →
> lèvent une erreur explicite, activés au déploiement), push/acquittement
> PPF réel (le service `recordPpfStatus` est la **frontière** applicable,
> exercée directement par les e2e faute de webhook PPF), schematron/contrôles
> sémantiques Annexe 7, chemin RE/rectificatif. **Aucun scellement/signature
> au niveau message** (auth au niveau transport, responsabilité PA — le
> PAF/scellement 2.2 ne s'applique pas ici ; journal e-reporting append-only
> **non scellé**, comportement correct). Validation **XSD structurelle
> uniquement** dans le worker — XSD-valide ≠ conformité sémantique PPF (un
> flux structurellement valide peut être rejeté 301 par le PPF).
> **Interprétations projet résiduelles à confirmer au go-live** : échéances
> « 8h00 » du Tableau 13 modélisées en **UTC** (côté sûr vs heure de Paris),
> fenêtre de rattrapage bornée (`MAX_DUE_PERIODS=2`, un rattrapage plus long
> est un processus d'exploitation manuel), heuristique d'assujettissement de
> l'acheteur (présence SIREN/TVA, faute de champ dédié dans le modèle),
> TT-77 = date d'émission de la facture, SIREN/SIRET sous `schemeId 0002`,
> catégorie par défaut TLB1 si le cadre BT-23 est absent, modèle binaire du
> cycle de vie (Figure 59 DGFiP non extractible). **745 tests** au total
> (`invoice-core` 129 100 % · `apps/api` 568 à 97.87/94.25/95.73/98.31 %
> (statements/branches/fonctions/lignes) · `apps/web` 48 à
> 100/96.66/100/100 %). Détail complet, runbook opérationnel (dont le point
> d'attention slot A2 ci-dessous) et variables d'environnement
> `EREPORTING_*` : `apps/api/README.md`.
>
> **2.4 — Annuaire central (Flux 13/14)** livre le **domaine PA** de
> l'annuaire — le registre **hébergé par le PPF** qui adresse/route les
> factures électroniques, **distinct** de l'e-invoicing et de l'e-reporting
> ci-dessus : ligne d'adressage (4 mailles — SIREN, SIREN+SIRET,
> SIREN+SIRET+routage, SIREN+suffixe), validité **semi-ouverte
> `[début, fin)`** (ANNEXE 3 verbatim) et résolution du destinataire **la
> plus spécifique d'abord** (masquage à portée exacte-maille) ; **génération
> Flux 13 et parsing Flux 14 tous deux validés XSD** contre les schémas
> DGFiP réels (les deux directions, omises par le dossier de cadrage
> initial) ; **miroir de consultation tenant-scopé PII-minimal** (maille +
> plateforme seuls, Nom/Adresse jamais extraits du Flux 14) ; **publication
> consent-gated** (422 avant toute écriture, §3.5.5.5) avec **gestion de
> slot** (409 sur conflit, libération automatique après rejet/masquage) ;
> **acquittements PPF** (désambiguïsation rejet local vs rejet PPF réel) ;
> **synchronisation bornée** (différentiel quotidien en upsert seul / complet
> hebdomadaire en remplacement du miroir du tenant) et **sweep de reprise**
> des publications figées par un crash (idempotent, write-once + CAS).
> **DIFFÉRÉS EXPLICITES** : adaptateurs de transport réels (API
> PISTE-OAuth2, EDI SFTP/AS2/AS4), feeds d'initialisation INSEE/Chorus/DGFiP
> (lignes par défaut 9998/Chorus non chargées), habilitations réelles,
> codes routage standalone (6 endpoints Swagger, `RoutageID` inline
> seulement), connecteur de signature électronique du consentement,
> **câblage de la résolution de routage dans l'émetteur de factures**
> (aucun appel depuis le pipeline Flux 1-9 à ce jour — brique prête,
> non consommée), endpoint de révocation de consentement (colonne prête en
> base, non exposée). **Interprétations go-live à confirmer** : qualifiant de
> routage `'9999'` (placeholder structurel, aucune valeur positive normée —
> **à confirmer avec la DGFiP/PPF**), prédicat de couverture du consentement
> (même SIREN + maille égale ou plus large, §3.5.5.5 non normative), motif de
> rejet en chaîne libre (les motifs normatifs REJ_RG/HAB/COH/VAL_INC du
> Tableau 7 p.55 EXISTENT — correctif 3.6 : contrainte différée au
> raccordement des adaptateurs réels ; les statuts 400/401 du Tableau 6
> portent désormais leur code), F14 complet authentiquement vide traité en **no-op**
> plutôt qu'en vidage du miroir (défaut sûr délibéré — une désactivation
> totale authentique côté PPF ne convergerait donc jamais par ce seul
> chemin). **959 tests** au total (`invoice-core` 129 100 % · `apps/api` 782
> à 97.71/94.51/95.75/98.2 % (statements/branches/fonctions/lignes) ·
> `apps/web` 48 à 100/96.66/100/100 %). Détail complet : `apps/api/README.md`.
>
> **3.1 — Transmission des CDV (Flux 6) & matrice de cycle de vie** livre :
> **RÉSOLU — le bloqueur go-live de la matrice CDV** (chronologie
> **monotone** 2.1, fausse sur 4 règles métier mandatées) est **remplacé**
> par une **matrice DAG data-driven** (`src/invoices/lifecycle-status.ts`)
> corrigeant les 4 anomalies mandatées nommément (**interdit** `212 Encaissée
> → 213 Rejetée`, CGI 290 A ; **autorisés** `207→205`, `208→204`, `206→205`)
> et **paramétrée** (le reste du code n'appelle jamais que
> `canTransition`/`requiresReason` — un futur remplacement par la norme
> **AFNOR XP Z12-012** ne touchera que la table + les vecteurs de test) ; le
> bloqueur devient donc une **interprétation en attente d'achat AFNOR**
> (**item Xavier**), plus une matrice **fausse** — amendement A3 documenté
> (`encaissee` rendu entièrement terminal, sur-ensemble du mandat dur qui
> n'exige que `¬(212→213)`) ; le swap ne touche **pas** au journal scellé
> 2.2 (`verifyTenantChain` ne re-valide jamais les transitions historiques,
> seules les futures transitions changent de garde). **[Mise à jour
> 2026-07-19 : swap AFNOR effectué** — table ré-ancrée sur XP Z12-012 +
> XP Z12-014 (juillet 2025), amendement A3 levé (encaissements partiels
> normatifs `212→212`/`212→211`), `¬(212→213)` maintenu ; détail :
> `apps/api/README.md` § Cycle de vie CDV.**]** **Transmission des CDV
> de bout en bout** pour les **4 statuts obligatoires** (200/210/212/213)
> vers **deux cibles indépendantes** (PPF réglementaire + destinataire résolu
> par l'annuaire 2.4, succès partiel au grain facture×statut×cible) : le
> message de statut Flux 6, au format sémantique **CDAR** (UN/CEFACT SCRDM
> CI, Annexe 2 V2.3) — **aucun XSD DGFiP n'existe pour ce flux**, validation
> **structurelle en code** honnête (posture PAF), sous-ensemble MINIMAL de
> MDT émis (7 MDT Requis-PPF non émis, à compléter à l'homologation) ;
> machine de **livraison** distincte du CDV facture (`prepared→transmitted→
> {acknowledged (acceptation implicite), rejected (601, seul code F6
> documenté)}`, `parked` retryable — destinataire non adressable/ambigu) ;
> ordonnanceur BullMQ **borné 24h** (§3.6.6, fenêtre de rattrapage 48h) avec
> 3 couches anti-double-envoi (fenêtre bornée, `jobId` déterministe, index
> unique DB) ; frontière d'acquittement (601/accept implicite) refusant
> correctement un 601 tardif après acceptation implicite (409, sans
> événement fantôme) ; endpoints de consultation dual-auth. **DIFFÉRÉS
> EXPLICITES** : adaptateurs de transport réels
> (sftp/as2/as4/**as4-peppol**/api), adhésion **OpenPeppol** + PKI test/prod
> + SMP + stack AS4, acquittements réseau/PPF réels (push), statuts CDV
> **facultatifs**, ingestion F6 entrante, MDT Requis-PPF non émis, code
> interface `FFE0614A` à confirmer. **RUNBOOK nouveau** : une panne worker
> CDV **> 48h** manque silencieusement les événements sortis de la fenêtre
> de rattrapage (procédure manuelle de rattrapage, élargissement ponctuel de
> `p_since`) ; un faux-`rejected` occupe définitivement son slot
> `(invoice_id, to_status, target)` (reset manuel hors-bande, même motif que
> le slot A2 e-reporting 2.3) ; horodate **UTC** (vs heure de Paris) =
> interprétation ouverte. **1100 tests** au total (`invoice-core` 129
> 100 % · `apps/api` 923 à 97.69/94.37/95.6/98.08 %
> (statements/branches/fonctions/lignes) · `apps/web` 48 à
> 100/96.66/100/100 %). Détail complet : `apps/api/README.md`.
>
> **Reprise — prochaine étape : phase 3 (suite)** : adhésion **OpenPeppol**
> + PKI test/prod + SMP + stack AS4 (item Xavier), adaptateurs de transport
> CDV réels (sftp/as2/as4/as4-peppol/api), point d'accès Peppol interne.
> L'**achat de la norme AFNOR XP Z12-012 est RÉSOLU (2026-07-19)** : normes
> XP Z12-012/-013/-014 obtenues, **swap de la matrice CDV effectué** —
> l'interprétation projet est levée, le bloqueur go-live matrice est clos
> (côté facture comme côté immatriculation PDP e-reporting). Le
> **câblage de la résolution de routage annuaire dans l'émetteur de
> factures**, différé depuis 2.4, est **RÉSOLU en 3.3** (couture
> `resolveRecipient` dans le worker de génération, best-effort strict, voir
> `apps/api/README.md` § Couture annuaire → émission) ; le **sweep de
> reprise** d'un routage `'pending'`/`'unaddressable'` opérationnel est
> **RÉSOLU en 3.4** ; la **sortie manuelle d'un routage `ambiguous`** (après
> nettoyage annuaire) est **RÉSOLUE en 3.5** (`POST
> /invoices/:id/routing/resolve`, dual-auth, voir `apps/api/README.md` §
> Consentement scellé, rôle worker & re-résolution ambiguous). Le
> **scellement structurel du consentement annuaire** et le **rôle Postgres
> `factelec_worker`** de moindre privilège sont également livrés **côté
> code** en 3.5 — les fournisseurs eIDAS réels de signature qualifiée et le
> provisioning prod du rôle worker restent des **items Xavier** (voir
> Déploiement ci-dessous). La **révocation de consentement** (colonne
> `revoked_at` prête depuis 2.4, non exposée) est **RÉSOLUE en 3.6** (`POST
> /annuaire/consents/:id/revoke`, dual-auth, révocation-**seule** — voir
> `apps/api/README.md` § Révocation de consentement — 3.6) : elle bloque
> **toute publication neuve** adossée au consentement révoqué mais ne
> rétracte **pas** l'adressage déjà publié — le miroir de consultation
> continue de router les tiers vers la plateforme jusqu'à l'actualisation
> opérateur (procédure §3.5.5.5 note 85, transmission Flux 13 réelle
> différée). **Horizon 2.x** : journal d'audit des authentifications
> (distinct du journal CDV).
> **Déploiement** : confirmer `CREATE EXTENSION pgcrypto` sur le Postgres
> managé Scaleway, fournir l'adaptateur `S3ObjectLockArchiveStore`,
> adaptateurs de transmission e-reporting réels (sftp/as2/as4/api),
> adaptateurs de transport annuaire réels (API PISTE-OAuth2, EDI
> SFTP/AS2/AS4) et identifiants PPF associés, adaptateurs de transport CDV
> réels (sftp/as2/as4/as4-peppol/api) et adhésion OpenPeppol (PKI/SMP/stack
> AS4), feeds d'initialisation annuaire INSEE/Chorus/DGFiP, matricule PA réel
> (`CDV_PA_MATRICULE`, ICD 0238), confirmation du code interface `FFE0614A`,
> **`libxml2`/`xmllint` sur l'hôte du worker** (validation XSD runtime du
> Flux 10 **et** du Flux 13/14 — **pas** le Flux 6/CDAR, structurellement
> validé en code, aucun XSD DGFiP disponible — à ajouter aux prérequis
> existants pgcrypto/S3/`TRUST_PROXY`), et les **fournisseurs eIDAS réels**
> de signature qualifiée du consentement (`CONSENT_DRIVER=eidas`, 3.5).
> **Le rôle `factelec_worker`** (3.5, moindre privilège) est livré **côté
> code** — reste à **provisionner en prod** (création du rôle + secret +
> `DATABASE_URL_WORKER`, **bloquant** : le worker refuse de démarrer sans)
> et à **retirer, en suivi, l'`EXECUTE` désormais superflu de
> `factelec_app`** sur les fonctions `SECURITY DEFINER` cross-tenant
> (`find_ereporting_declarants_due`, `find_annuaire_sync_targets`,
> `find_stale_annuaire_drafts`, `find_cdv_transmissions_due`,
> `find_parked_cdv_transmissions`, `find_pending_routing_invoices`) —
> `factelec_app` les conserve intégralement à ce jour (§ 3.5, aucun `REVOKE`
> dans la migration `0029`). Reports explicites détaillés en Feuille de route
> ci-dessous.
> La conformité PDF/A-3 formelle (veraPDF, Java) tourne en CI optionnelle non bloquante.
> Journal détaillé : `.superpowers/sdd/progress.md` (hors git, local).

## Structure du dépôt

```
apps/
  api/              API REST NestJS (ingestion/lecture des factures, auth utilisateur
                    + clés API + super admin, phases 1.3/1.4) : multi-tenant Postgres
                    RLS, sessions httpOnly + CSRF ; workers BullMQ (génération
                    asynchrone) + cycle de vie des statuts CDV (phase 2.1)
  web/              Dashboard Next.js 16 (phase 1.4) : SPA authentifiée par session
                    serveur, factures/clés API, espace super admin minimal
packages/
  invoice-core/     Bibliothèque pure (sans I/O) : modèle canonique EN 16931,
                    calculs TVA/totaux, règles de cohérence, génération UBL 2.1
docs/
  reglementaire/    Documents officiels DGFiP/Peppol + spécifications externes v3.2
                    (XSD, formats sémantiques, OpenAPI annuaire)
  superpowers/      Spec de conception et plans d'implémentation
```

L'architecture cible est un monolithe modulaire TypeScript (API NestJS, worker
BullMQ, dashboard Next.js) avec un point d'accès Peppol AS4 auto-hébergé
(phase4/phoss SMP). Voir la spec de conception pour le détail.

## `@factelec/invoice-core`

Cœur métier de la facturation, aligné sur le modèle sémantique EN 16931 :

- **Schémas zod** (`src/model/schema.ts`) : modèle canonique de facture, validation
  structurelle stricte (dates calendaires réelles, montants décimaux à 2 décimales).
- **Monnaie** (`src/model/money.ts`) : arithmétique décimale exacte via big.js,
  arrondi demi-supérieur (round half up).
- **Moteur de calcul** (`src/model/compute.ts`) : `buildInvoice` calcule la
  ventilation TVA et les totaux à partir des lignes. `computeVatBreakdownByNature`
  (plan 3.2, D1) ventile la ventilation TVA canonique entre biens et services
  à partir du discriminant `nature` (`'goods'`\|`'services'`) **optionnel**
  au niveau ligne (`invoiceLineNatureSchema`, rétro-compat JSONB **sans
  migration**) — total conservé, base exacte, résidu TVA ≤ 1 centime absorbé
  côté services ; `complete:false` (aucune ventilation fabriquée) dès qu'une
  ligne n'a pas de `nature`. Consommé par l'agrégation e-reporting côté
  `apps/api` (cadres mixtes M1/M2/M4, paiements TB-3 services-only) — voir
  `apps/api/README.md`.
- **Règles de gestion** (`src/model/rules.ts`) : contrôles de cohérence EN 16931
  (BR-CO-*) et motifs d'exonération BT-120/121 (BR-{E,AE,IC,G,O}-10), signalés en
  `RuleViolation`.
- **Génération UBL 2.1** : `generateUbl` route la facture (380 → Invoice) **et**
  l'avoir (381 → `generateCreditNote`, CreditNote), XML validé dans les tests
  contre le XSD standard OASIS (Invoice **et** CreditNote) **et** le Schematron
  officiel EN 16931 (`validation-1.3.16`, exécuté en Node pur via saxon-js, sans
  JVM).
- **Extraits de flux DGFiP F1** (`src/flux/generate-extract.ts`) : profils BASE
  (en-tête sans lignes) et FULL (lignes épurées), pour la facture **et** l'avoir,
  validés contre les XSD réglementaires
  (`docs/reglementaire/specifications-externes-v3.2/3- XSD_v3.2/`). Le
  `cbc:ProfileID` de l'extrait porte le cadre de facturation BT-23 (règle de
  gestion DGFiP G1.02, nomenclature fermée de 13 codes) ; `generateFluxExtractUbl`
  lève `MissingBusinessProcessTypeError` si `businessProcessType` n'est pas
  renseigné sur la facture.
- **CII D16B** (`src/cii/generate.ts`) : `generateCii` émet le CII UN/CEFACT
  D16B (profil EN 16931) pour la facture et l'avoir, y compris l'échéance de
  paiement BT-9 (`ram:SpecifiedTradePaymentTerms/ram:DueDateDateTime`) quand
  `dueDate` est renseigné, validé XSD D16B vendorisé et Schematron officiel
  EN 16931 CII (Node pur, saxon-js).
- **Factur-X PDF/A-3** (`src/facturx/generate.ts`) : `generateFacturX` produit
  un PDF/A-3 porteur avec le CII (`generateCii`) embarqué en pièce jointe
  (`AFRelationship=Alternative`), XMP PDF/A-3 + Factur-X et `OutputIntent` sRGB.
  Page visuelle minimale en v1 (rendu lisible reporté) ; conformité PDF/A-3
  formelle vérifiée hors bande par veraPDF en CI optionnelle non bloquante
  (`.github/workflows/ci-pdfa.yml`).

La bibliothèque n'effectue aucun accès réseau, base de données ni système de
fichiers (hors tests).

## `@factelec/api`

API REST NestJS 11 (ESM), phases **1.3 + 1.4 + 2.1 + 2.2 + 2.3 + 2.4 + 3.1 +
3.2 + 3.3 + 3.4 + 3.5 + 3.6 + 5.1** : ingestion et lecture des factures (consommant `@factelec/invoice-core`),
authentification utilisateur (sessions httpOnly + CSRF), signup self-service
transactionnel, gestion des clés API par session, super admin plateforme
minimal, **workers BullMQ de génération asynchrone**, **cycle de vie des
statuts CDV** (matrice data-driven 3.1, **ancrée depuis le 2026-07-19 sur
les normes AFNOR XP Z12-012/XP Z12-014** — l'interprétation projet est
levée), **transmission des CDV (Flux 6/CDAR)** vers PPF et
destinataire (3.1, machine de livraison distincte, ordonnanceur borné 24h,
adaptateurs de transport réels/OpenPeppol différés au déploiement),
**e-reporting DGFiP Flux 10** (10.3 B2C bout-en-bout, **10.1 B2Bi par facture
et paiements TB-3 étendus en 3.2**, machine à états 300/301 distincte, deux
cadences par régime TVA — transactions et paiements —, transmission différée
au déploiement) et **annuaire central Flux 13/14** (domaine PA : ligne
d'adressage 4 mailles, résolution de routage, génération F13/parsing F14
validés XSD, miroir de consultation PII-minimal, publication consent-gated,
synchronisation bornée — transport réel et câblage dans l'émetteur différés).
**Ventilation biens/services et paiements TB-3** (3.2) : discriminant `nature`
optionnel au niveau ligne (`@factelec/invoice-core` 0.4.0, rétro-compat sans
migration), cadres mixtes M1/M2/M4 réellement ventilés pour les factures
naturées, capture des encaissements idempotente et intégrité anti-sur-
encaissement, agrégation/transmission TB-3 selon la règle **SERVICES-ONLY**
(note 119) — voir § E-reporting dans `apps/api/README.md` pour le détail
complet et les différés.
**Couture annuaire → émission & durcissements transverses** (3.3) : **ferme
le trou fonctionnel PDP hérité de 2.4** — l'annuaire savait résoudre le
destinataire d'une facture, mais l'émetteur ne l'appelait jamais.
`RecipientRoutingService` résout désormais le destinataire dans le
**worker de génération** (best-effort **strict**, jamais d'échec du job),
persiste une **métadonnée de routage mutable** (`routing_status`/
`recipient_platform`, migration 0026 additive) **sans jamais muter le cycle
de vie CDV scellé**, exposée en lecture sur `GET /invoices/:id`. **Aucun
sweep de reprise** d'un routage `'pending'` opérationnel en 3.3 (documenté
explicitement, requête SQL opérateur au runbook — **soldé en 3.4, voir
ci-dessous**). `GET /annuaire/codes-routage` énumère les codes-routage
publiés par le tenant (POST autonome refusé). Quatre **durcissements 100 %
code-interne** : validation UUID harmonisée (404 anti-fuite byte-identique
sur 8 routes, plus de 500), erreurs CAS typées (`CasStaleError` remplace 3
regex divergentes), verrou d'architecture — un **ralentisseur honnête**, pas
une barrière — sur le footgun `apiKeyId`, et stabilisation e2e (teardown de
pool idempotent, split Vitest `heavy`/`light`). Voir §§ Couture annuaire →
émission / Durcissements transverses dans `apps/api/README.md` pour le
détail complet et les différés.
**Reprise & retransmission** (3.4) : **rejoue/répare** ce que 2.3-3.3 ont
posé, sur trois axes. **Chemin RE (rectificatif)** — `POST
/ereporting/retransmissions` (dual-auth, jugement opérateur exclusif, jamais
un automatisme post-301) régénère une période **complète** depuis les
données source **actuelles**, retry-idempotente (défense en profondeur à 3
couches : `reSeq` → `jobId` → index partiel DB) ; **débloque le deadlock du
slot IN né-`rejetee`** (2.3) de façon **conditionnelle** — le cas
`rejectOrigin='ppf'` (301 réel) est conforme à la lettre de la spec, le cas
`rejectOrigin='local'` (born-rejetee, le PPF n'a rien vu) reste une
**interprétation projet flaggée, à valider en pilote PPF**. **Sweep de
reprise du routage** (`RecipientRoutingRetryService`, miroir
`ArchiveRetryService`) — **solde l'amendement M1/3.3** : `pending`/
`unaddressable` sont désormais repris automatiquement (`ambiguous` exclu,
nettoyage opérateur requis), rotation anti-famine. **Filtre de liste** `GET
/invoices?routingStatus=` + exposition du routage sur `GET /invoices` — la
requête SQL opérateur du runbook 3.3 devient inutile. Voir §§ Chemin RE /
Runbook — Deadlock du slot A2 / Couture annuaire → émission (amendement M1)
/ Filtre de liste dans `apps/api/README.md` pour le détail complet et les
différés (RE automatique post-301 **refusé**, backoff persistant du sweep,
filtre par plateforme).
**Consentement scellé, rôle worker de moindre privilège & re-résolution
ambiguous** (3.5) : trois axes **strictement internes au code**, aucune
extraction réglementaire nouvelle. **Scellement structurel du consentement
annuaire** — `ConsentSignaturePort` (5ᵉ instance du motif port du projet)
scelle la preuve déclarée à la publication (`sha256` de la forme canonique +
horodatage + write-once WORM) ; **aucune** vérification cryptographique de
signature, **aucune** valeur probante ni signature électronique qualifiée
eIDAS — les fournisseurs réels sont des drivers différés (item Xavier).
`evidence_ref` devient le sceau vérifiable des consentements créés depuis
3.5 ; le stock legacy (pré-3.5) reste **non scellé**, aucune migration
rétroactive. **Rôle Postgres `factelec_worker`** de moindre privilège
(grants dérivés de l'inventaire réel des accès du worker, isolation RLS
prouvée sous le rôle) — le worker s'exécute désormais **exclusivement** sous
ce rôle (fini le partage `factelec_app`) ; `factelec_app` **conserve**
cependant tous ses grants historiques (aucun `REVOKE`) et le provisioning
prod du nouveau rôle reste un **item Xavier bloquant au déploiement** (le
worker refuse de démarrer sans `DATABASE_URL_WORKER`). **Re-résolution
manuelle d'un routage `ambiguous`** — `POST /invoices/:id/routing/resolve`
(dual-auth, 200 synchrone) solde F-2/3.4 ; honnêteté L1 : un `200` dont le
corps reste `ambiguous` ne distingue pas « annuaire non nettoyé » d'une
panne opérationnelle pendant la re-résolution. **Épisode sécurité non
planifié, close dans ce plan** : l'extension du verrou d'architecture à la
**composition** des guards a révélé une faille **héritée de 2.4** — les 3
mutations d'annuaire (`POST`/`PUT`/`DELETE lignes`) composaient
`TenantAuthGuard` **seul**, sans `RolesGuard` ni `CsrfGuard` (une session de
n'importe quel rôle, `viewer` inclus, pouvait muter l'annuaire sans jeton
CSRF) — fermée par le même triple garde que les autres mutations dual-auth
du projet, preuve RED réelle (6 e2e négatifs ayant réellement exécuté les
mutations avant correctif). Voir § Consentement scellé, rôle worker &
re-résolution ambiguous dans `apps/api/README.md` pour le détail complet, la
matrice de grants et les différés (fournisseurs eIDAS réels, déploiement du
rôle worker, garde composé `DualAuthMutationGuard` — refusé à nouveau, en
voie médiane).
**Révocation de consentement** (3.6) : `POST
/annuaire/consents/:id/revoke` (7ᵉ mutation dual-auth du projet, triple
garde dès sa création) écrit `revoked_at` en **CAS write-once idempotent**
(rejeu → `revokedAt` d'origine, monotone) et bloque **toute publication
neuve** adossée au consentement révoqué (gate existant, non-régression
prouvée sur les deux chemins de résolution du consentement). **Révocation-
seule** (ancrage §3.5.5.5 note 85 + sémantique locale, non-propagée, de
`maskLigne`) : **aucune cascade automatique** sur l'adressage déjà publié —
formulé **sans euphémisme**, le miroir de consultation continue de router
les tiers vers la plateforme pour les mailles déjà consolidées, jusqu'à
l'actualisation opérateur (procédure clôturer/masquer/fallback, note 85 ;
transmission Flux 13 réelle **différée**). Réponse
`{ consentId, revokedAt, dependentActiveLignes }` — l'anti-silence sur les
lignes actives encore dépendantes. Verrou d'architecture M1 étendu 6→7.
Voir § Révocation de consentement — 3.6 dans `apps/api/README.md` pour le
détail complet, le runbook opérateur et les différés (cascade Flux 13
réelle, raison de révocation stockée, outils d'actualisation en masse,
ainsi qu'une divergence Tableau 6 **pré-existante** et **non liée**,
notée au backlog).
**Billing Stripe** (5.1, itération 1) : modèle commercial self-service —
abonnement mensuel unique + volume métré, 100 % hébergé Stripe (Checkout +
Customer Portal, aucune donnée carte côté Factelec). `BillingPort` (6ᵉ port
du projet) + miroir local `tenant_billing` piloté par **webhooks signés**
(CAS anti-réordonnancement, jamais Stripe interrogé en direct hors
webhook) ; garde d'émission 402 (`BillingGuard`, matrice
driver×enforcement×statut, câblé sur `POST /invoices` et `POST
/ereporting/retransmissions` **uniquement** — les lectures ne sont jamais
bloquées) ; sweep quotidien de report d'usage métré (idempotent par
tenant×jour) ; script `pnpm billing:bootstrap` (catalogue sandbox
idempotent par `lookup_key`) ; page dashboard `/billing` (5 états,
redirections hébergées). `BILLING_ENFORCEMENT=off` par défaut — activer le
blocage 402 est une **décision commerciale**, pas un oubli technique.
Détail complet : `apps/api/README.md` § Billing Stripe (phase 5, itération
1).
Multi-tenant Postgres avec Row-Level Security **`ENABLE` + `FORCE`**, double
régime d'auth (clés API Argon2id pour l'ingestion machine, sessions Argon2id
pour le dashboard — lecture des factures acceptant l'un ou l'autre du même
tenant). Génération **asynchrone** des formats du socle (UBL, CII, Factur-X,
extraits de flux) : `POST /invoices` enfile un job minimal (ids only) derrière
le port `InvoiceFormatGenerator` et répond `201 { status: 'received' }` ;
un **worker** (processus séparé, `apps/api/src/worker-main.ts`) le consomme,
génère les formats et persiste, avec retries/backoff et réconciliation
auto-cicatrisante des orphelins (désormais **bornée**, cap + DLQ des
factures poison). Cycle de vie métier CDV (nomenclature DGFiP 14 statuts,
machine à états, journal append-only) distinct du statut de génération ; ce
journal est désormais **scellé** (chaîne SHA-256 par tenant imposée par la
base) et **archivé** (port WORM), avec export PAF — tamper-evidence contre
l'altération/suppression/insertion **partielle**, **pas** une inviolabilité
totale de la chaîne live (troncature de queue et réécriture complète
cohérente hors périmètre du hash-chain seul, cf. `apps/api/README.md`).
Documentation complète — architecture & compromis (ESM +
typecheck tsgo + émission SWC), workers, sécurité multi-tenant et auth,
scellement/archivage/PAF/DLQ détaillés, **e-reporting Flux 10 (périmètre,
runbook opérationnel, différés)**, **transmission des CDV Flux 6 (matrice
DAG, format CDAR, runbook opérationnel, différés)**, variables
d'environnement, endpoints, tests, limites — dans
[`apps/api/README.md`](apps/api/README.md).

## `@factelec/web`

Dashboard Next.js 16 (App Router, ESM), phase **1.4** : SPA authentifiée par
session serveur httpOnly (cookie posé par `apps/api`, CSRF double-submit),
consommant `@factelec/api`. Pages factures (pagination keyset, détail,
téléchargement des formats), gestion des clés API (secret affiché une seule
fois), espace super admin minimal (liste des tenants). Aucun SSR/RSC des
données métier, aucune création de facture via l'UI (ingestion = API, clé
API uniquement). Stack pinnée, modèle d'auth, tests & couverture, verdict
tsgo/Next — dans [`apps/web/README.md`](apps/web/README.md).

## Développement

Prérequis : Node.js ≥ 22 (`.nvmrc`), pnpm 10, `xmllint` (libxml2) et Docker
(Postgres **et Redis** de dev/tests `apps/api`, via Testcontainers pour les
e2e — **non requis** pour `apps/web`, dont les tests tournent en jsdom pur).
`xmllint` est requis à **deux titres distincts** : validation XSD
`invoice-core` **en tests uniquement**, et validation XSD e-reporting Flux 10
(`apps/api`) **en runtime** — le worker de génération e-reporting (2.3)
l'invoque à chaque transmission (`ereporting-xsd-validator.ts`, `execFile`),
pas seulement en test. **`libxml2`/`xmllint` est donc désormais un prérequis
de l'hôte de déploiement du worker**, pas seulement de la CI/du poste de dev
(voir « Prérequis pré-production » ci-dessous et `apps/api/README.md`). Le
Schematron EN 16931 officiel s'exécute en **Node pur** (saxon-js, `xslt3`),
sans JVM ; le premier `pnpm test` compile le SEF (~10-20 s), mis en cache
ensuite (répertoire git-ignoré).

```sh
pnpm install
pnpm lint        # Biome (lint + format check) — scaffolding Next (.next/, next-env.d.ts) exclu
pnpm build       # Compilation — DOIT précéder typecheck : invoice-core (tsc) → apps/api
                 # (swc, résout @factelec/invoice-core via son dist/, compile aussi
                 # worker-main.ts) → apps/web (next build, génère next-env.d.ts requis
                 # par son propre typecheck)
pnpm typecheck   # tsc --noEmit sur tous les packages (invoice-core + apps/api : tsgo ; apps/web :
                 # repli typescript@5.9.x local, cf. apps/web/README.md — verdict D6)
pnpm test        # Vitest avec couverture (seuil bloquant : 90 %) — invoice-core + apps/api
                 # (Testcontainers Postgres + Redis, Docker requis, worker bouclé en
                 # process via createTestWorker) + apps/web (jsdom, sans Docker)
```

Base de données **et file** locales d'`apps/api` (Postgres + rôles + RLS,
Redis) :

```sh
cd apps/api && docker compose up -d   # démarre Postgres ET Redis
```

Worker de génération (processus séparé, après l'API — cf.
[`apps/api/README.md`](apps/api/README.md) pour l'architecture producteur/consommateur) :

```sh
pnpm --filter @factelec/api start:worker   # build, ou worker:dev pour le watch mode
```

Dashboard en développement (après l'API) :

```sh
pnpm --filter @factelec/web dev   # http://localhost:3001
```

Voir [`apps/api/README.md`](apps/api/README.md) pour les migrations, le
provisioning (tenant self-service ou CLI, super admin CLI uniquement), les
workers BullMQ et le détail des variables d'environnement ;
[`apps/web/README.md`](apps/web/README.md) pour le modèle d'auth et la stack
du dashboard.

Conventions du projet :

- TDD obligatoire : tout code est précédé d'un test vu échouer ; aucun merge si un
  test échoue.
- TypeScript `strict`, ESM uniquement.
- Montants représentés en chaînes décimales à 2 décimales exactement (ex.
  `"1000.00"`).
- Identifiants de code en anglais, messages de commit en français.
- **Dépendances toujours en dernière version stable, 0 vulnérabilité** :
  `pnpm outdated -r` doit rester vierge et `pnpm run audit:ci` ne doit
  remonter **aucune** vulnérabilité applicable (toutes sévérités) — les deux
  sont des étapes **bloquantes** de la CI (`.github/workflows/ci.yml`), au
  même titre que lint/build/typecheck/test. `audit:ci` (`scripts/audit.mjs`)
  remplace `pnpm audit` : ce dernier interroge l'ancien endpoint npm
  `/-/npm/v1/security/audits`, **retiré** par npm (l'outil est cassé, pas nos
  dépendances) — sur pnpm 10.12.1 comme sur pnpm 11.x. Le script interroge
  directement le nouvel endpoint officiel `POST
  /-/npm/v1/security/advisories/bulk` sur l'arbre de dépendances résolu
  (`pnpm ls -r --depth Infinity --json`, transitives comprises), donc les
  overrides `pnpm.overrides` ci-dessous sont naturellement pris en compte.
  Deux overrides tolérés à ce jour
  (`pnpm.overrides` racine) : `@esbuild-kit/core-utils>esbuild` épinglé à
  `^0.25.0`, nécessaire à la chaîne de dépendances de `drizzle-kit` ; et
  `postcss` épinglé à `8.5.19` (CVE-2026-41305, `next@16.2.10` épingle en
  interne une version vulnérable de `postcss`) — **provisoire**, à retirer
  dès qu'une release de `next` absorbe nativement le correctif (vérifier via
  `pnpm why postcss -r` après tout bump de `next`). Un faux-positif de
  `pnpm outdated -r` sur le repli `typescript@5.9.x` volontaire d'`apps/web`
  (verdict D6, cf. `apps/web/README.md`) est neutralisé par
  `pnpm.updateConfig.ignoreDependencies: ["typescript"]` — le pin racine
  `typescript@7.0.2` (tsgo) n'est, lui, jamais ignoré.
- CI GitHub Actions bloquante : `pnpm run audit:ci`, `pnpm outdated -r`, lint,
  build, typecheck, tests — `invoice-core` + `apps/api` (ce dernier via
  Testcontainers Postgres **et Redis**, Docker natif du runner, aucun service
  `redis:`/`postgres:` de job requis) + `apps/web` (jsdom, sans Docker), les
  trois balayés par `pnpm -r`.

## Documentation réglementaire

Les référentiels officiels (guide d'immatriculation PA, spécifications externes
v3.2 avec XSD et Schematron, onboarding Peppol) sont archivés dans
[`docs/reglementaire/`](docs/reglementaire/README.md). Les XSD et l'OpenAPI de
l'annuaire y font foi — ne pas en télécharger d'autres versions.

## Feuille de route

- [x] **1.1 — Socle monorepo + invoice-core** (terminé) : modèle canonique,
      calculs, UBL 2.1 validé XSD.
- [x] **1.2 — Conformité EN 16931 + extraits de flux** (terminé) : montants
      non négatifs et refus de l'avoir 381, exonérations BT-120/121,
      Schematron EN 16931 officiel, extraits de flux DGFiP F1 BASE/FULL,
      tests par propriétés.
- [x] **1.2bis — Formats du socle : CII D16B, Factur-X, avoir** (terminé) :
      UBL CreditNote pour l'avoir 381 (commercial et extrait de flux F1), CII
      D16B (facture et avoir), Factur-X PDF/A-3 (CII embarqué), appartenance
      VATEX (BT-121) et ProfileID BT-23 sur les documents commerciaux.
- [x] **1.3 — API NestJS, auth multi-tenant, ingestion** (terminé) : socle
      NestJS 11 ESM, Postgres multi-tenant RLS `FORCE`, auth clés API
      Argon2id, `POST /invoices` (génération synchrone — **remplacée en
      2.1**), lecture paginée, isolation cross-tenant testée. Détail :
      `apps/api/README.md`.
- [x] **1.4 — Auth utilisateur, self-service, dashboard** (terminé) :
      users tenant-scopés + sessions serveur httpOnly + CSRF double-submit
      (expiration absolue), signup self-service transactionnel, gestion des
      clés API par session, super admin plateforme minimal, lecture des
      factures en dual-auth (clé API ou session), dashboard Next.js 16.
      Détail : `apps/api/README.md`, `apps/web/README.md`.
- [x] **2.1 — Workers BullMQ, ingestion asynchrone, cycle de vie CDV**
      (terminé) : infra Redis/BullMQ, ingestion asynchrone (`POST /invoices`
      → `201 { status: 'received' }`, **changement de contrat** vs 1.x),
      worker de génération dédié (idempotence, retries/backoff,
      réconciliation auto-cicatrisante), machine à états du cycle de vie CDV
      (nomenclature DGFiP 14 statuts ; interprétation projet levée le
      2026-07-19 par le swap AFNOR XP Z12-012/-014), endpoints de
      transition/historique, journal
      `invoice_status_events` append-only (substrat valeur probante),
      dettes 1.3/1.4 soldées (`last_used_at`, purge des sessions expirées).
      Détail : `apps/api/README.md`.
- [x] **2.2 — Scellement et archivage à valeur probante du journal CDV**
      (terminé) : chaîne SHA-256 **par tenant** imposée par la base (trigger
      `SECURITY DEFINER`, genesis dérivé du tenant, `pgcrypto`) sur le
      journal `invoice_status_events` ; vérification d'intégrité
      indépendante (recompute TypeScript pur, `GET /invoices/:id/ledger`) ;
      archivage WORM (port `ArchiveStore` + implémentation locale
      write-once testable, adaptateur S3 object-lock différé au
      déploiement) ; export de la Piste d'Audit Fiable (`GET
      /invoices/:id/paf`, JSON/CSV, conception projet non normalisée
      DGFiP) ; DLQ des factures poison (cap de réconciliation borné,
      `invoice_dead_letters`) ; retrait de la FK cascade du journal (dette
      2.1). **Limite intrinsèque documentée, non résolue** : le hash-chain
      auto-contenu ne détecte pas la troncature de la queue de chaîne ni une
      réécriture complète cohérente par accès propriétaire — seul l'ancrage
      de tête dans l'archive WORM externe (S3 object-lock, activé au
      déploiement) couvre ces deux modes. Détail : `apps/api/README.md`.
- [x] **2.3 — E-reporting DGFiP (Flux 10)** (terminé) : **RÉSOLU** de bout en
      bout pour le sous-flux **10.3 (B2C domestique)** — classification par
      facture, agrégation des transactions (BT→TT), génération XML XSD-valide
      (`xmllint`), machine à états **300/301** distincte du CDV, cadence par
      régime TVA (Tableau 13 §3.7.7 verbatim), ordonnanceur BullMQ idempotent
      (fenêtre bornée `MAX_DUE_PERIODS=2`), transmission à blanc optionnelle,
      port de transmission (implémentation locale write-once testable),
      acquittements PPF et endpoints de consultation dual-auth. **Différés
      explicites** : 10.1/10.2 B2Bi, TB-3 paiements, cadres mixtes M1/M2/M4,
      adaptateurs de transport réels, push PPF réel, schematron Annexe 7,
      chemin RE. **Aucun scellement message** (auth transport, D3). **Runbook
      opérationnel nouveau** : procédure de déblocage du slot A2 (transmission
      IN rejetée localement qui occupe définitivement son slot), prérequis
      `libxml2`/`xmllint` sur l'hôte du worker, dette de durcissement du rôle
      SD cross-tenant. Détail complet : `apps/api/README.md`.
- [x] **2.4 — Annuaire central (Flux 13/14)** (terminé) : **RÉSOLU** le
      **domaine PA** de bout en bout — ligne d'adressage (4 mailles, validité
      semi-ouverte `[début, fin)`, résolution la plus spécifique d'abord,
      masquage à portée exacte-maille), génération Flux 13 **et** parsing
      Flux 14 tous deux validés XSD (les deux directions), miroir de
      consultation tenant-scopé PII-minimal, publication consent-gated (422)
      avec gestion de slot (409 + libération après rejet/masquage),
      acquittements PPF (désambiguïsation rejet local/PPF) et
      synchronisation bornée (différentiel quotidien / complet hebdomadaire
      en remplacement du miroir du tenant) avec sweep de reprise des
      publications figées (idempotent, write-once + CAS). **Différés
      explicites** : adaptateurs de transport réels, feeds d'initialisation
      INSEE/Chorus/DGFiP, habilitations réelles, codes routage standalone
      (6 endpoints Swagger), connecteur de signature électronique du
      consentement, câblage de la résolution dans l'émetteur de factures,
      endpoint de révocation de consentement. **Interprétation go-live à
      confirmer** : qualifiant de routage `'9999'` (placeholder structurel,
      aucune valeur positive normée par la DGFiP). Détail complet :
      `apps/api/README.md`.
- [x] **3.1 — Transmission des CDV (Flux 6) & matrice de cycle de vie**
      (terminé) : **RÉSOLU** le bloqueur go-live de la matrice CDV —
      chronologie **monotone** 2.1 (fausse sur 4 règles métier mandatées)
      **remplacée** par une **matrice DAG data-driven** paramétrée (4
      anomalies corrigées nommément : `212→213` interdit, `207→205`/
      `208→204`/`206→205` autorisés), le bloqueur devenant une
      **interprétation projet en attente d'achat AFNOR XP Z12-012** (item
      Xavier) plutôt qu'une matrice fausse ; swap sans impact sur le journal
      scellé 2.2 — **interprétation levée le 2026-07-19 : swap AFNOR
      XP Z12-012/-014 effectué**. **Transmission des CDV de bout en bout** pour les 4
      statuts obligatoires vers PPF **et** destinataire (annuaire 2.4) :
      Flux 6 au format CDAR (aucun XSD DGFiP → validation structurelle
      honnête), machine de livraison distincte (`prepared→transmitted→
      {acknowledged,rejected(601)}`, `parked` retryable), ordonnanceur
      borné 24h (fenêtre 48h) à 3 couches anti-double-envoi, frontière
      d'acquittement et endpoints de consultation dual-auth. **Différés
      explicites** : adaptateurs de transport réels
      (sftp/as2/as4/as4-peppol/api), adhésion OpenPeppol + PKI/SMP/AS4,
      acquittements réseau réels, statuts CDV facultatifs, ingestion F6
      entrante. **Runbook nouveau** : rattrapage manuel d'une panne worker
      > 48h, reset manuel d'un faux-`rejected` occupant son slot, horodate
      UTC = interprétation ouverte. Détail complet : `apps/api/README.md`.
- [x] **3.2 — Ventilation biens/services & paiements TB-3 (Flux 10)**
      (terminé) : discriminant `nature` (`'goods'`/`'services'`) **optionnel**
      au niveau ligne (`@factelec/invoice-core`, rétro-compat JSONB **sans
      migration**, reste en **0.4.0**), `computeVatBreakdownByNature` (total
      conservé, base exacte, résidu TVA ≤ 1 centime absorbé côté services) ;
      **cadres de facturation mixtes M1/M2/M4 réellement ventilés** (TLB1/
      TPS1) pour les factures **naturées** — dette 2.3 soldée sur ce
      sous-ensemble, les factures non naturées restant différées ; **10.1
      B2Bi activé** (émis **par facture**, TG-8, misrouting export B2C
      résolu — le statut d'acheteur prime le pays) ; **paiements TB-3**
      (`POST`/`GET /payments`) : capture **explicite** des encaissements
      (aucun auto-seed depuis le statut CDV `212`, refusé), **idempotente**
      `(invoice_id, reference)`, intégrité anti-taux-inconnu et anti-sur-
      encaissement (TOCTOU concurrent non résolu, vigilance documentée) ;
      **agrégation et transmission** 10.2 (per-facture) / 10.4 (agrégé) selon
      la règle **SERVICES-ONLY** (note 119, proratisation par ratio
      services/TTC, autoliquidation et option débits exclues) ; **2ᵉ cadence
      de transmission dédiée** (Tableau 13 §3.7.7 primaire, triple-vérifiée —
      le régime réel normal mensuel est le seul où paiements ≠ transactions) ;
      ordonnanceur BullMQ étendu à 3 couches (`flux_kind='payments'`, jobId
      dédié). **Différés explicites** : part biens d'un encaissement (jamais
      transmise), option de TVA sur les débits (note 119, aucun champ
      modèle), cadres mixtes non naturés, validation devise vs ISO 4217,
      rôle viewer non testé e2e. Détail complet : `apps/api/README.md`.
- [x] **3.3 — Couture annuaire à l'émission & durcissements transverses**
      (terminé) : **RÉSOLU le trou fonctionnel PDP hérité de 2.4** —
      l'annuaire savait résoudre le destinataire d'une facture, l'émetteur
      ne l'appelait jamais. `RecipientRoutingService` résout désormais le
      destinataire dans le **worker de génération** (best-effort **strict**,
      jamais d'échec du job, miroir `ArchiveService`), persiste une
      **métadonnée de routage mutable** (`routing_status`/
      `recipient_platform`, migration 0026 additive) **sans jamais muter le
      cycle de vie CDV scellé** (résolution ≠ émission ≠ transmission),
      exposée sur `GET /invoices/:id`. **Aucun sweep de reprise** en 3.3 pour
      un routage `'pending'` opérationnel (documenté explicitement, requête
      SQL opérateur au runbook `apps/api/README.md`). `GET
      /annuaire/codes-routage` énumère les codes-routage publiés par le
      tenant (POST autonome refusé, composant de maille). **Quatre
      durcissements 100 % code-interne** : validation UUID harmonisée (404
      anti-fuite byte-identique sur 8 routes, plus de 500), erreurs CAS
      typées (`CasStaleError` remplace 3 `CAS_STALE_RE` divergentes, sortie
      HTTP inchangée), verrou d'architecture — un **ralentisseur honnête**,
      pas une barrière — sur le footgun `apiKeyId` (garde composé dédié
      différé), teardown de pool idempotent et split Vitest `heavy`/`light`
      (fallback `maxWorkers:3` documenté après re-flake). **Différés
      explicites** : sweep de reprise du routage, garde composé
      `DualAuthMutationGuard`, POST codes-routage autonome, transition
      `emise`/transport réel (adaptateurs, items Xavier). Détail complet :
      `apps/api/README.md`.
- [x] **3.4 — Reprise & retransmission** (terminé) : livre ce qui **rejoue
      ou répare** ce que 2.3-3.3 ont posé, sur trois axes. **Chemin RE
      (rectificatif e-reporting)** — `POST /ereporting/retransmissions`
      (dual-auth, jugement opérateur exclusif, jamais un automatisme
      post-301) régénère une période **complète** (« annule et remplace »,
      §3.7.7 primaire) depuis les données source **actuelles**, via le
      pipeline existant, retry-idempotente (défense en profondeur à 3
      couches : `reSeq` discriminant → `jobId` déterministe → index partiel
      DB `0027`) ; l'IN n'est **jamais** effacé (journal append-only).
      **Débloque le deadlock du slot IN né-`rejetee`** (2.3) de façon
      **conditionnelle** (amendement M-D4-1, BINDING) — `rejectOrigin='ppf'`
      (301 réel) est conforme à la lettre de la spec ; `rejectOrigin='local'`
      (born-rejetee, le PPF n'a rien vu de la période) reste une
      **interprétation projet FLAGGÉE, à valider en pilote PPF**. **Sweep de
      reprise du routage destinataire** (`RecipientRoutingRetryService`,
      miroir exact `ArchiveRetryService`, SD `find_pending_routing_invoices`
      migration `0028`) — **SOLDE l'amendement M1/3.3** : `pending`/
      `unaddressable` repris automatiquement (gate 15 min, batch 100,
      cadence `ROUTING_RETRY_EVERY_MS`), `ambiguous` exclu (nettoyage
      opérateur requis), rotation anti-famine (amendement M-D7-1 : touch
      explicite sur échec opérationnel persistant). **Filtre de liste** `GET
      /invoices?routingStatus=` + exposition `routingStatus`/
      `recipientPlatform` sur `GET /invoices` (curseur keyset intact) — la
      requête SQL opérateur du runbook 3.3 devient inutile. **Différés
      explicites** : RE automatique post-301 (**refusé**, décision projet),
      backoff persistant du sweep routage, filtre de liste par
      `recipient_platform`. Détail complet : `apps/api/README.md`.
- [x] **3.5 — Consentement probant & séparation des rôles** (terminé) :
      trois axes **strictement internes au code**, aucune extraction
      réglementaire nouvelle. **Scellement structurel du consentement
      annuaire** — `ConsentSignaturePort` (5ᵉ instance du motif port) scelle
      la preuve déclarée à la publication (`sha256` de la forme canonique +
      horodatage + write-once WORM) ; **aucune** vérification cryptographique
      de signature, **aucune** valeur probante ni signature électronique
      qualifiée eIDAS — les fournisseurs réels sont des drivers différés
      (item Xavier). `evidence_ref` devient le sceau vérifiable des
      consentements créés depuis 3.5 ; le stock legacy (pré-3.5) reste
      **non scellé** (aucune migration rétroactive). **Rôle Postgres
      `factelec_worker`** de moindre privilège (grants dérivés de
      l'inventaire réel des accès du worker, isolation RLS prouvée sous le
      rôle) — le worker s'exécute désormais **exclusivement** sous ce rôle ;
      `factelec_app` **conserve** cependant tous ses grants historiques
      (aucun `REVOKE`), et le provisioning prod du nouveau rôle reste un
      **item Xavier bloquant au déploiement**. **Re-résolution manuelle d'un
      routage `ambiguous`** — `POST /invoices/:id/routing/resolve`
      (dual-auth, 200 synchrone) **solde F-2/3.4** ; honnêteté L1 : un `200`
      dont le corps reste `ambiguous` ne distingue pas annuaire non nettoyé
      d'une panne opérationnelle pendant la re-résolution. **Épisode
      sécurité non planifié, close dans ce plan** : l'extension du verrou
      d'architecture à la **composition** des guards a révélé une faille
      **héritée de 2.4** — les 3 mutations d'annuaire composaient
      `TenantAuthGuard` **seul**, sans `RolesGuard` ni `CsrfGuard` (une
      session de n'importe quel rôle, `viewer` inclus, pouvait muter
      l'annuaire sans jeton CSRF) — fermée par le même triple garde que les
      autres mutations dual-auth du projet, preuve RED réelle (6 e2e
      négatifs ayant réellement exécuté les mutations avant correctif).
      **Différés explicites** : fournisseurs eIDAS réels, déploiement du
      rôle worker (incluant le retrait de suivi de l'`EXECUTE` superflu à
      `factelec_app`), garde composé `DualAuthMutationGuard` (**refusé à
      nouveau**, en voie médiane).
      Détail complet : `apps/api/README.md`.
- [x] **3.6 — Révocation de consentement** (terminé) : ferme le seul axe
      manquant du cycle de vie du consentement annuaire — la colonne
      `annuaire_consents.revoked_at` (2.4) était déjà **lue** par le gate de
      publication mais **aucun** endpoint ne l'écrivait. `POST
      /annuaire/consents/:id/revoke` (7ᵉ mutation dual-auth du projet,
      triple garde dès sa création) écrit `revoked_at` en **CAS write-once
      idempotent** (rejeu → `revokedAt` d'origine, monotone), 404 anti-fuite
      byte-identique, aucune migration (colonne et grant existants).
      **Révocation-seule (D2)** — ancrée à la source primaire réextraite
      (§3.5.5.5 note 85 : rupture PA↔client ⇒ actualisation **opérateur**
      ligne par ligne, jamais une cascade automatique) et à la sémantique
      réelle de `maskLigne` (transition **locale**, `deposee`-only, ne
      transmet **rien** au PPF/miroir — une cascade aurait **fabriqué** une
      rétractation) : **aucun** masquage automatique des lignes déjà
      publiées. **AMENDEMENT M1-DOC (honnêteté sans euphémisme)** : la
      révocation bloque **toute publication neuve** adossée au consentement
      (gate existant, non-régression prouvée sur les deux chemins de
      résolution du consentement) mais **ne rétracte pas** l'adressage déjà
      publié — le miroir de consultation **continue de router** les tiers
      vers la plateforme pour les mailles déjà consolidées, jusqu'à
      l'actualisation opérateur (procédure clôturer/masquer/fallback note
      85 ; transmission Flux 13 réelle **différée**). Réponse
      `{ consentId, revokedAt, dependentActiveLignes }` — anti-silence sur
      les lignes actives encore dépendantes, procédure runbook documentée.
      Verrou d'architecture M1 étendu **6→7**. **Différés explicites** :
      cascade réelle vers le PPF (Flux 13 masquage + clôture + ligne
      fallback plateforme fictive `9998`), raison de révocation stockée
      (aucune colonne), outils d'actualisation post-révocation en masse.
      **Backlog Tableau 6 : SOLDÉ** (correctif post-3.6) — `deposee`/
      `rejetee` portent désormais les codes **400 Acceptée / 401 Rejetée**
      (§3.5.7 p.54) ; motifs normatifs Tableau 7 actés, contrainte différée
      aux adaptateurs réels.
      Détail complet : `apps/api/README.md` § Révocation de consentement —
      3.6.
- [x] **5.1 — Billing Stripe (abonnement + usage, garde d'émission)**
      (terminé, itération 1) : premier axe de la **phase 5 (Commercialisation)**
      — modèle self-service, plan unique + volume métré, 100 % hébergé Stripe
      (Checkout + Customer Portal, aucune donnée carte côté Factelec).
      `BillingPort` (6ᵉ port) + 3 drivers (`none`/`fake`/`stripe`, factory
      fail-fast) ; miroir local `tenant_billing` piloté par **webhooks
      signés** (CAS anti-réordonnancement `last_event_created`, état complet
      jamais un patch, migration `0030` RLS `FORCE`) — Stripe reste la seule
      source de vérité, jamais interrogé en direct hors webhook. **Garde
      d'émission** 402 (`BillingGuard`, matrice driver×enforcement×statut)
      câblé sur `POST /invoices` et `POST /ereporting/retransmissions`
      **uniquement** — aucune lecture jamais bloquée ; `driver='none'`
      neutralise le garde **inconditionnellement**. **Usage métré** : sweep
      worker quotidien (veille UTC, idempotent par tenant×jour, isolation
      d'erreur par tenant). **Script** `pnpm billing:bootstrap` (catalogue
      sandbox idempotent par `lookup_key`, montants câblés en dur
      **uniquement** dans ce script). **Dashboard** : page `/billing` (5
      états, bannières `past_due`/bloqué, redirections Checkout/Portal
      hébergées). **Restent en phase 5** : vue facturation du super admin,
      super admin complet (impersonation tracée, feature flags, MFA TOTP +
      allowlist IP, supervision des files/transmissions), observabilité
      durcie, `BILLING_ENFORCEMENT=on` par défaut (décision commerciale),
      Playwright (e2e navigateur). Détail complet : `apps/api/README.md` §
      Billing Stripe (phase 5, itération 1).

> **Point de reprise → phase 3 (suite)** : adhésion OpenPeppol + PKI
> test/prod + SMP + stack AS4 (item Xavier), adaptateurs de transport CDV
> réels (sftp/as2/as4/as4-peppol/api), point d'accès Peppol interne —
> l'**achat AFNOR XP Z12-012 est RÉSOLU (2026-07-19, swap matrice CDV
> effectué, bloqueur go-live matrice clos)** —, correctif du sur-encaissement
> concurrent (TOCTOU, 3.2, verrou applicatif ou contrainte DB dédiée), et
> **validation en pilote PPF de l'interprétation RE sur slot born-`rejetee`**
> (3.4, amendement M-D4-1 — le déblocage fonctionne côté Factelec, mais
> l'acceptation réelle par le PPF d'un rectificatif sans IN transmis
> préalable n'est vérifiée par aucun texte disponible). Le **sweep de
> reprise du routage destinataire**, différé depuis 3.3, est **RÉSOLU en
> 3.4** ; la **sortie manuelle d'un routage `ambiguous`** est **RÉSOLUE en
> 3.5** (voir `apps/api/README.md` § Couture annuaire → émission, amendement
> M1 / § Consentement scellé, rôle worker & re-résolution ambiguous). La
> **révocation de consentement** est **RÉSOLUE en 3.6** (`POST
> /annuaire/consents/:id/revoke`, dual-auth, révocation-**seule** — voir
> `apps/api/README.md` § Révocation de consentement — 3.6) ; restent
> différés côté révocation la **cascade réelle vers le PPF** (Flux 13), la
> **raison de révocation stockée** et les **outils d'actualisation en
> masse**, ainsi qu'une **divergence Tableau 6 pré-existante** (backlog
> dédié, sans lien avec la révocation) notée dans ce même paragraphe du
> détail complet. **Fournisseurs eIDAS réels** de signature qualifiée du
> consentement et **provisioning prod du rôle `factelec_worker`** (3.5,
> items Xavier bloquants au déploiement de cette version pour le second)
> restent à fournir.

### Prérequis pré-production / pré-DGFiP

Liste compacte consolidant des points déjà détaillés ci-dessous (dette
reportée) ou dans `apps/api/README.md` : aucun ne bloque le passage en
phase 3, mais **tous** doivent être traités avant une exposition réelle
(immatriculation DGFiP, onboarding de tenants en production) :

- **Journal d'audit des authentifications** (connexions, échecs, révocations
  de session — distinct du journal CDV livré en 2.1) — absent à ce jour,
  prévu horizon **2.x**.
- **Vérification email** avant tout onboarding réel — colonne
  `email_verified` prête en base, non contraignante aujourd'hui (rate
  limiting strict sur `/auth/signup` en compensation provisoire).
- **`TRUST_PROXY` + `SESSION_COOKIE_DOMAIN`** à configurer selon la topologie
  réelle de déploiement (load balancer/reverse-proxy devant l'API, partage de
  cookies cross-subdomain dashboard/API) — les défauts conviennent au dev
  local uniquement.
- **Durcissement de la session super admin** (MFA TOTP, allowlist IP, TTL
  dédié réduit) — la session admin 1.4 réutilise le régime standard
  (Argon2id, TTL absolu générique), sans contrôle additionnel → **phase 5**.
- **Validation et unicité du SIREN (KYB)** — seul le format est vérifié (9
  chiffres) ; ni la clé de contrôle (Luhn), ni l'existence, ni l'unicité
  réelle de l'entreprise ne sont vérifiées à ce jour.
- **Matrice de cycle de vie CDV — RÉSOLU le 2026-07-19 (swap AFNOR
  effectué)** : la table est ancrée sur les normes **XP Z12-012 et
  XP Z12-014 (juillet 2025)**, pages primaires ré-extraites au moment du
  swap ; la paramétrisation a tenu (seuls `ALLOWED_TRANSITIONS`,
  `REASON_REQUIRED`, `TERMINAL_STATUSES` et les vecteurs de test ont bougé).
  Restent hors socle, en backlog conditionnel : statuts émergents
  « Annulée » (sans code), « ERREUR_ROUTAGE » (221, avec les adaptateurs
  transport réels), « RECEVABLE »/« IRRECEVABLE » (500/501, niveau lot).
  Détail : `apps/api/README.md`.
- **Ancrage de tête WORM non effectif** (2.2) — le scellement du journal ne
  détecte pas la troncature de queue ni une réécriture complète cohérente
  par accès propriétaire (limite intrinsèque du hash-chain) ; seul
  l'ancrage de tête dans l'archive WORM **externe** couvre ces deux modes,
  effectif uniquement une fois l'adaptateur S3 object-lock **activé au
  déploiement**. Détail : `apps/api/README.md`.
- **`CREATE EXTENSION pgcrypto`** (2.2) — à confirmer sur le Postgres managé
  Scaleway visé en production (vérifiée uniquement sur `postgres:17-alpine`
  dev/CI à ce jour).
- **`libxml2`/`xmllint` = prérequis de l'hôte du worker** (2.3, **NOUVEAU**) —
  la validation XSD du Flux 10 s'exécute en **runtime** (`execFile`) à chaque
  transmission, pas seulement en test/CI ; à ajouter à côté de
  pgcrypto/S3/`TRUST_PROXY` sur toute image/hôte exécutant le worker. Détail :
  `apps/api/README.md`.
- **Deadlock du slot A2 — débloqué par le chemin RE, conditionnellement**
  (2.3, MEDIUM, fail-safe, **RÉSOLU en 3.4 sous réserve**) — une transmission
  IN née `rejetee` occupe **toujours définitivement** son slot (voulu,
  inchangé) ; `POST /ereporting/retransmissions` ouvre désormais une voie
  **parallèle** (§ Chemin RE, `apps/api/README.md`). Pour `rejectOrigin='ppf'`
  (301 réel), le déblocage est **conforme à la spec**. Pour
  `rejectOrigin='local'` (born-rejetee, le PPF n'a rien vu de la période),
  **l'admission d'un RE reste une interprétation projet FLAGGÉE, à valider
  en pilote PPF** (amendement M-D4-1) — voir § Point de reprise ci-dessus.
- **Durcissement du rôle SD e-reporting — rôle worker créé en 3.5, `REVOKE`
  toujours différé** (2.3) — `find_ereporting_declarants_due` expose
  `(tenant_id, siren, name)` **cross-tenant**. Le worker s'exécute désormais
  sous `factelec_worker` (3.5) et n'a plus besoin de cet accès HTTP-side,
  mais `factelec_app` (rôle du process API) **conserve** l'`EXECUTE`
  historique — la migration `0029` n'effectue aucun `REVOKE`. Reste à
  retirer, en suivi, une fois le déploiement du rôle worker confirmé — voir
  `apps/api/README.md` § Consentement scellé, rôle worker & re-résolution
  ambiguous.
- **Adaptateurs de transport annuaire réels + identifiants PPF** (2.4,
  **NOUVEAU**) — API PISTE-OAuth2 et EDI SFTP/AS2/AS4 restent à fournir et
  activer (`ANNUAIRE_DRIVER=api|edi`) ; seul `local` est câblé à ce jour.
- **Feeds d'initialisation annuaire INSEE/Chorus/DGFiP** (2.4, **NOUVEAU**) —
  aucun processus ne charge à ce jour les lignes par défaut (plateforme
  fictive 9998/Chorus) pour les entités nouvellement assujetties.
- **Habilitations annuaire réelles** (2.4, **NOUVEAU**) — le miroir de
  consultation est tenant-scopé (RLS) mais ne modélise pas encore
  d'habilitation fine par plateforme/mandat ; différé derrière le transport
  réel.
- **Qualifiant de routage `'9999'` à confirmer avec la DGFiP/PPF** (2.4,
  **NOUVEAU**) — placeholder structurel (`ROUTAGE_SCHEME_ID_PLACEHOLDER`),
  aucune valeur positive normée dans la documentation disponible.
- **Durcissement du rôle SD annuaire — même statut que e-reporting 2.3
  ci-dessus** (2.4) — `find_annuaire_sync_targets` et
  `find_stale_annuaire_drafts` exposent des identifiants de tenants
  **cross-tenant** ; `factelec_app` conserve l'`EXECUTE` (aucun `REVOKE` en
  3.5), à retirer en suivi du déploiement du rôle worker.
- **`libxml2`/`xmllint` — désormais requis aussi pour l'annuaire** (2.4) — la
  validation XSD F13/F14 s'exécute en **runtime**, à chaque publication et
  synchronisation, au même titre que le Flux 10 (2.3, prérequis déjà noté
  ci-dessus).
- **Achat de la norme AFNOR XP Z12-012 — RÉSOLU (2026-07-19)** : normes
  XP Z12-012/-013/-014 + annexe A de la 014 obtenues (PDF hors dépôt,
  `normes-afnor/` gitignoré — licence AFNOR), swap de la matrice CDV
  effectué le jour même. Constat : la norme n'énumère pas de matrice
  `from→to` — la table est la traduction machine-à-états du modèle
  « transmission ordonnée / traitement indépendant » (détail :
  `apps/api/README.md` § Cycle de vie CDV).
- **Adhésion OpenPeppol + PKI test/prod + SMP + stack AS4** (3.1,
  **NOUVEAU**, item Xavier) — préalable à tout adaptateur `as4-peppol` réel
  et au point d'accès Peppol interne (phase 3, suite).
- **Adaptateurs de transport CDV réels** (3.1, **NOUVEAU**) —
  sftp/as2/as4/as4-peppol/api restent à fournir et activer
  (`CDV_TRANSMISSION_DRIVER`) ; seul `local` est câblé à ce jour.
- **`CDV_PA_MATRICULE` réel** (3.1, **NOUVEAU**, ICD 0238) — placeholder
  `'0000'` en dev/test, à configurer avant production.
- **Confirmation du code interface `FFE0614A`** (3.1, **NOUVEAU**) —
  introuvable dans les sources primaires (Annexe 2 / Dossier général),
  présent seulement au dossier de recherche interne ; non contraignant dans
  ce plan, à confirmer avant prod.
- **Panne worker CDV > 48h non rattrapée automatiquement** (3.1,
  **NOUVEAU**, MEDIUM, fail-safe) — un événement de statut obligatoire sorti
  de la fenêtre de rattrapage bornée (48h, `CDV_TRANSMISSION_LOOKBACK_MS`)
  avant le retour du worker n'est jamais rattrapé par le sweep suivant ;
  procédure manuelle documentée (runbook) dans `apps/api/README.md`.
- **Slot CDV occupé par un faux-`rejected`** (3.1, **NOUVEAU**, même motif
  que le slot A2 e-reporting 2.3) — un faux-rejet (601 erroné, ou F6 invalide
  corrigé depuis) occupe définitivement son slot `(invoice_id, to_status,
  target)` ; reset manuel hors-bande requis, procédure documentée (runbook)
  dans `apps/api/README.md`.
- **Durcissement du rôle SD CDV — même statut que e-reporting 2.3/annuaire
  2.4 ci-dessus** (3.1) — `find_cdv_transmissions_due` et
  `find_parked_cdv_transmissions` exposent des identifiants de tenants
  **cross-tenant** ; `factelec_app` conserve l'`EXECUTE` (aucun `REVOKE` en
  3.5), à retirer en suivi du déploiement du rôle worker. Voir aussi
  `find_pending_routing_invoices` (3.4), même dette, même statut.
- **Sur-encaissement concurrent (TOCTOU) sur `POST /payments`** (3.2,
  **NOUVEAU**, MEDIUM, fail-safe) — deux captures de paiement concurrentes
  sur des références distinctes, même facture, peuvent toutes deux passer le
  contrôle anti-sur-encaissement avant l'écriture de l'autre (cumul final
  > TTC) ; aucun verrou/contrainte DB en place, procédure de vigilance
  documentée (rapprochement comptable). Voir § Runbook opérationnel —
  E-reporting dans `apps/api/README.md`.
- **Validation de la devise capturée absente** (3.2, **NOUVEAU**) —
  `POST /payments` n'oppose `currency` ni à `invoice.currency` ni à une
  liste ISO 4217.
- **Rôle `viewer` non testé en e2e sur `POST /payments`** (3.2, **NOUVEAU**)
  — refus prouvé au niveau unitaire `RolesGuard` seulement.
- **Sweep de reprise du routage destinataire — RÉSOLU en 3.4** (3.3 →
  3.4) — un `routing_status='pending'`/`'unaddressable'` **opérationnel**
  est désormais repris automatiquement (`RecipientRoutingRetryService`,
  miroir `ArchiveRetryService`, cadence `ROUTING_RETRY_EVERY_MS`) ;
  `GET /invoices?routingStatus=` remplace la requête SQL opérateur du
  runbook 3.3. Voir `apps/api/README.md` § Couture annuaire → émission
  (amendement M1) / § Filtre de liste.
- **Verrous d'architecture dual-auth = ralentisseurs, pas des barrières**
  (3.3, critère déclencheur largement dépassé en 3.5) — le test
  grep-structurel sur les poseurs d'`apiKeyId`
  (`apikeyid-setters.arch.test.ts`) reste contournable (renommage, helper
  indirect) ; un **second** verrou, sibling, couvre depuis 3.5 la
  **composition** des guards (`dual-auth-composition.arch.test.ts`, scan
  textuel mono-ligne `@UseGuards`, également contournable par construction) —
  c'est ce second verrou qui a révélé la faille annuaire héritée de 2.4,
  close en Task 4bis (§ ÉPISODE SÉCURITÉ, `apps/api/README.md`). La vraie
  barrière d'exécution (`DualAuthMutationGuard`) reste **refusée à nouveau**
  en 3.5 (D7, voie médiane) malgré **6** routes dual-auth-mutation
  qualifiantes désormais (payments, retransmissions, resolveRouting, 3
  mutations annuaire). Voir `apps/api/README.md` § Durcissements transverses
  / § Consentement scellé, rôle worker & re-résolution ambiguous.
- **Interprétation RE sur slot born-`rejetee` — à valider en pilote PPF**
  (3.4, **NOUVEAU**, amendement M-D4-1 BINDING) — le RE débloque le
  deadlock du slot A2 de façon pragmatique côté Factelec (retriable-idempotent,
  testé), mais l'**acceptation réelle par le PPF** d'un rectificatif pour une
  période dont il n'a **jamais** reçu d'IN transmis n'est confirmée par aucun
  texte disponible (§3.7.7 primaire silencieux sur ce cas). Voir
  `apps/api/README.md` § Chemin RE / § Runbook — Deadlock du slot A2.
- **Provisioning prod du rôle `factelec_worker` — BLOQUANT au déploiement**
  (3.5, **NOUVEAU**, item Xavier) — le rôle (grants de moindre privilège,
  migration `0029`) n'existe **pas** par défaut en production ; `WorkerModule`
  importe désormais inconditionnellement `DATABASE_URL_WORKER`, donc **le
  process worker refuse de démarrer** tant que le rôle + le secret + la
  variable d'environnement ne sont pas provisionnés — à faire **avant** tout
  déploiement de cette version, dans le même mouvement que la migration
  `0029`. Voir `apps/api/README.md` § Consentement scellé, rôle worker &
  re-résolution ambiguous.
- **Fournisseurs eIDAS réels de signature qualifiée du consentement** (3.5,
  **NOUVEAU**, item Xavier) — `CONSENT_DRIVER=eidas` lève une erreur
  explicite et testée tant qu'aucun adaptateur n'est fourni ; seul `local`
  (scellement **structurel**, sans valeur probante) est câblé à ce jour.

Dette explicitement reportée (aucune ne bloque le passage en phase 3) :

- **Stripe / abonnements — RÉSOLU pour l'itération 1 (2026-07-19)** :
  abonnement mensuel unique + volume métré, sessions Checkout/Customer
  Portal 100 % hébergées Stripe, miroir local piloté par webhooks, garde
  d'émission 402 (`POST /invoices`, `POST /ereporting/retransmissions`),
  sweep quotidien de report d'usage, script de bootstrap catalogue sandbox
  et page dashboard `/billing` — voir § Billing Stripe (phase 5, itération
  1) dans `apps/api/README.md`. Restent différés (itérations suivantes) :
  vue facturation du super admin, `BILLING_ENFORCEMENT=on` par défaut
  (décision commerciale), paliers tarifaires multiples, essai gratuit,
  Stripe Tax, coupons/parrainage, changement de plan en self-service.
- **Vérification email** différée : fournisseur transactionnel non
  provisionné ; colonne `email_verified` prête en base, non contraignante
  aujourd'hui — rate limiting strict sur `/auth/signup` en compensation.
- **Invitation de membres + appartenance multi-tenant** (table `memberships`
  M:N) différées : les users sont mono-tenant en 1.4 (un `owner` par
  signup).
- **Playwright (e2e navigateur)** → **phase 5** (coût CI).
- **Super admin complet** (impersonation tracée, feature flags, MFA TOTP +
  allowlist IP, supervision des files/transmissions) → **phase 5** (spec
  §6/§8) ; le super admin livré en 1.4 est volontairement minimal (login +
  liste des tenants).
- **Pré-prod** : configurer `SESSION_COOKIE_DOMAIN` + `TRUST_PROXY` selon la
  topologie réelle (load balancer / reverse-proxy) ; vérifier `SameSite` et
  le partage de cookies cross-subdomain dashboard/API.
- **Throttle par tenant** (rate limiting actuellement par IP uniquement,
  `apps/api`) — non planifié à ce jour.
- **E-reporting DGFiP (Flux 10) au-delà du 10.1/10.3/TB-3** (2.3, étendu
  3.2) : cadres de facturation **mixtes M1/M2/M4 non naturés** (au moins une
  ligne sans discriminant `nature` — différés, aucune ventilation partielle
  fabriquée), part **biens** d'un encaissement (règle SERVICES-ONLY, note
  119 — jamais transmise) et clause « option de TVA sur les débits » de la
  même note (aucun champ correspondant dans le modèle `Invoice`), auto-seed
  du statut CDV `212 Encaissée` depuis un paiement capturé (**refusé,
  décision projet**), adaptateurs de transport réels (sftp/as2/as4/api),
  push/acquittement PPF réel (webhook), schematron/contrôles sémantiques
  Annexe 7, chemin RE/rectificatif, provisioning des déclarants (aucun
  endpoint/CLI) — tous différés, aucun n'est fabriqué. Détail :
  `apps/api/README.md`.
- **Annuaire central (Flux 13/14) au-delà du domaine PA** (2.4) : adaptateurs
  de transport réels (API PISTE-OAuth2, EDI SFTP/AS2/AS4), feeds
  d'initialisation INSEE/Chorus/DGFiP (lignes par défaut 9998/Chorus non
  chargées), habilitations réelles, codes routage standalone (6 endpoints
  Swagger, `RoutageID` inline seulement — l'**énumération** de gestion, elle,
  est livrée en 3.3, `GET /annuaire/codes-routage`) — tous différés, aucun
  n'est fabriqué. **Câblage de la résolution de routage annuaire dans
  l'émetteur de factures : RÉSOLU en 3.3** (§ Couture annuaire → émission,
  `apps/api/README.md`). **Connecteur de signature électronique du
  consentement : livré en 3.5** en **motif port établi**
  (`ConsentSignaturePort`, scellement **structurel** — sha256 + horodatage +
  write-once WORM, **aucune** valeur probante) ; seuls les **fournisseurs
  eIDAS réels** de signature qualifiée restent différés (item Xavier).
  **Endpoint de révocation de consentement : livré en 3.6**
  (`POST /annuaire/consents/:id/revoke`, révocation-**seule**, aucune
  cascade sur l'adressage déjà publié — § Révocation de consentement — 3.6,
  `apps/api/README.md`) ; restent différés côté révocation la cascade
  réelle vers le PPF (Flux 13), la raison de révocation stockée et les
  outils d'actualisation en masse. Détail : `apps/api/README.md` §
  Consentement scellé, rôle worker & re-résolution ambiguous / § Révocation
  de consentement — 3.6.
- **Adaptateur S3 object-lock réel** (`S3ObjectLockArchiveStore`, Scaleway,
  mode `COMPLIANCE`, rétention 10 ans) → **déploiement** — spécifié (2.2,
  même contrat que `ArchiveStore`) mais non écrit (infra à la main de
  Xavier, non testable sans bucket S3 réel) ; tant qu'il n'est pas fourni,
  l'ancrage de tête (seul rempart contre la troncature/réécriture du
  journal scellé, cf. `apps/api/README.md`) n'est pas effectif.
- **Transmission des CDV au-delà du socle 3.1** : adaptateurs de transport
  réels (sftp/as2/as4/as4-peppol/api), adhésion OpenPeppol + PKI test/prod +
  SMP + stack AS4, acquittements réseau/PPF réels (push), statuts CDV
  **facultatifs**, ingestion F6 entrante, MDT Requis-PPF non émis (4/5/21/
  40/91/95/97), confirmation du code interface `FFE0614A` — tous différés,
  aucun n'est fabriqué. **L'apposition automatique** des transitions CDV
  **facture** par un connecteur/le réseau reste différée : les transitions
  2.1 (`POST /invoices/:id/status`) demeurent exclusivement pilotées par
  session utilisateur — 3.1 ne livre que la **transmission** des statuts
  déjà décidés, pas leur déclenchement réseau. Détail : `apps/api/README.md`.
- **Remplacement de la matrice de transitions CDV** contre la norme AFNOR XP
  Z12-012 (payante, hors dépôt, **item Xavier : achat requis**) —
  **bloqueur go-live PDP partiellement résolu en 3.1** : la matrice
  **monotone fausse** de 2.1 est remplacée par une **matrice DAG** corrigeant
  les 4 anomalies mandatées et **paramétrée** pour absorber AFNOR sans
  retoucher le code, mais la table **reste** une interprétation projet en
  attente de la norme (amendement A3 documenté).
- **Horizon 2.x** : journal d'audit persistant des **authentifications**
  (distinct du journal CDV à valeur probante, livré en substrat par 2.1).
- **Migration Factur-X D22B / 1.09** (héritée d'`invoice-core`, plan
  1.2bis) : le socle cible D16B (Factur-X ≤ 1.07.3) par cohérence avec le
  Schematron EN 16931 CII `validation-1.3.16`, lui-même D16B ; Factur-X
  1.08/1.09 sont passés à D22B. Migration différée dans l'attente d'un
  Schematron D22B publié par ConnectingEurope.
