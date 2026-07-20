# Runbook de provisioning — production Scaleway

Document opérationnel, à suivre **pas à pas et dans l'ordre**. Chaque étape
donne : **BUT**, **COMMANDE** (copiable telle quelle), **VÉRIFICATION**
(commande + résultat attendu), et **PIÈGES/ROLLBACK** quand pertinent.

Statut : préparé pour exécution assistée (compte Scaleway + secrets réels =
item Xavier, décision « on le fera ensemble »). Aucune commande de ce document
n'a été exécutée contre une infrastructure réelle au moment de la rédaction ;
chaque claim a été vérifié contre le code de la branche (2026-07-20) —
références `fichier:ligne` données pour permettre une re-vérification si le
code évolue.

Portée : premier environnement de production (PostgreSQL managé, Redis
managé, Object Storage, containers api/worker/web). Exclu de ce runbook :
`apply` Terraform réel, DNS/certificats, CI/CD de déploiement. Le squelette
Terraform (`infra/`) et le script `verify-provisioning.ts` sont des
livrables **compagnons** de ce même chantier phase 6 prep, planifiés en
tâches séparées — **non encore présents sur le disque au moment où ces
lignes sont écrites** ; s'ils existent quand vous lisez ceci, voir
`infra/README.md` et §12 pour leur usage.

## Légende des placeholders

- `<GÉNÉRÉ-32-CHARS>` : secret à générer par l'opérateur (ex.
  `openssl rand -base64 32`), **jamais** une valeur de ce document, **jamais**
  un mot de passe des fichiers dev (`00-roles.sql`, `.env.example`).
- `<À-CHOISIR>` : décision d'exploitation (nom de domaine, etc.) propre à
  Xavier, non déterminable depuis le code.
- `<ITEM-XAVIER>` : valeur bloquée sur une démarche externe (immatriculation
  DGFiP, adhésion OpenPeppol...), déjà trackée en dette dans les README —
  non résoluble par ce runbook.

## 1. Prérequis hôte/runtime

**BUT** : garantir que tout hôte/image exécutant l'API ou le worker dispose
des runtimes et outils requis.

- **Node 22** — `.nvmrc` = `22` ; `package.json` racine :
  `"engines": {"node": ">=22"}`.
- **pnpm 10.12.1** — épinglé par `"packageManager": "pnpm@10.12.1"`
  (`package.json:8`, racine du monorepo), à activer via `corepack`.
- **`libxml2`/`xmllint` sur le PATH du worker** — validation XSD **en
  runtime**, à chaque transmission Flux 10 e-reporting
  (`apps/api/README.md:1308-1319`) et à chaque publication/synchronisation
  Flux 13/14 annuaire (`apps/api/README.md:1106-1109`). Absent → erreur
  **opérationnelle** (pas un rejet sémantique) : job rejoué puis `failed`
  après épuisement des tentatives, **aucune transmission n'est jamais émise**
  tant que l'outil manque. Pas requis par le process API (XSD validé
  seulement en test côté `invoice-core`) ni par `apps/web`.
- **Docker non requis en prod** — utilisé uniquement en local par
  `apps/api/docker-compose.yml` (Postgres 17-alpine + Redis 7-alpine de dev).

**COMMANDE** (sur l'hôte/image cible) :

```bash
node --version                          # doit afficher v22.x.x
corepack enable
corepack prepare pnpm@10.12.1 --activate
pnpm --version                          # doit afficher 10.12.1
xmllint --version                       # doit réussir (image worker SEULEMENT)
```

**VÉRIFICATION** : les 4 commandes réussissent sans erreur, `node --version`
commence par `v22`.

**PIÈGES** : une image de base minimaliste (ex. `node:22-alpine`) n'inclut
**pas** `xmllint` par défaut — installer explicitement (`apk add
libxml2-utils` sur Alpine, `apt-get install libxml2-utils` sur Debian/Ubuntu)
sur l'image du **worker** uniquement.

## 2. PostgreSQL managé Scaleway

**BUT** : provisionner l'instance et confirmer que l'extension requise par le
socle est disponible **avant** toute migration.

- **Version 17** — miroir exact de `postgres:17-alpine` (dev/CI,
  `apps/api/docker-compose.yml:3`), seule version exercée par la suite de
  tests.
- **Base `factelec`** — nom utilisé partout (`docker-compose.yml:5`,
  `.env.example`).
- **`CREATE EXTENSION pgcrypto`** — **point de vérification explicite**. La
  migration `0010_ledger_fk_restrict.sql:6` exécute elle-même
  `CREATE EXTENSION IF NOT EXISTS pgcrypto;` (scellement du journal CDV,
  trigger `SECURITY DEFINER`) — vérifiée uniquement sur `postgres:17-alpine`
  à ce jour (`README.md` racine :1062-1064), **jamais testée sur l'offre managée
  Scaleway**. Sur certaines offres managées, `CREATE EXTENSION` est restreint
  à une allowlist gérée par le fournisseur : si `pgcrypto` n'y figure pas,
  `pnpm db:migrate` (§4) s'arrêtera **au milieu** de la séquence (migrations
  `0000`-`0009` déjà appliquées, `0010` en échec) — d'où le test isolé
  ci-dessous, à faire **avant** de lancer `db:migrate`.

**COMMANDE** (créer l'instance via la console/CLI Scaleway, puis, une fois
`factelec_owner` créé — §3 — se connecter et tester à blanc) :

```bash
psql "$DATABASE_OWNER_URL" -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"
psql "$DATABASE_OWNER_URL" -c "SELECT extname FROM pg_extension WHERE extname='pgcrypto';"
```

**VÉRIFICATION** : la deuxième commande renvoie une ligne `pgcrypto`.

**PIÈGES/ROLLBACK** : si `CREATE EXTENSION` échoue (permission refusée /
extension non listée), contacter le support Scaleway pour l'activer sur
l'offre managée **avant** de poursuivre — ne pas lancer `db:migrate` tant que
ce test n'a pas réussi. Si `db:migrate` a déjà échoué à `0010` : corriger la
disponibilité de l'extension puis relancer `pnpm db:migrate` (drizzle ne
réapplique pas les migrations déjà commitées, reprend à `0010`).

## 3. Rôles AVANT toute migration

**BUT** : créer les 3 rôles Postgres applicatifs — **avant d'exécuter la
moindre migration**, pas seulement avant la migration `0029`.

**Pourquoi avant TOUTE migration, pas juste `0029`** : la toute première
migration de rôles/RLS (`0001_roles_rls.sql:1-3`) exécute déjà
`GRANT USAGE ON SCHEMA public TO factelec_app` — si `factelec_app` n'existe
pas, `db:migrate` échoue dès la migration `0001`. `factelec_worker` n'est
grantée qu'en `0029_worker_role_grants.sql`, mais créer les 3 rôles en un seul
geste avant `db:migrate` (comme le fait `scripts/db-init/00-roles.sql` en
dev/test) évite tout ordre partiel à retenir.

- **`factelec_owner`** — `LOGIN`, **`BYPASSRLS`**, `CREATEDB`, propriétaire du
  schéma `public`. Utilisé **uniquement** par les migrations et les scripts
  de provisioning CLI (`apps/api/README.md:3299-3302`) — **jamais** par les process
  API/worker.
- **`factelec_app`** — `LOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`, `NOCREATEDB`.
  Rôle du process **API** (`DATABASE_URL`).
- **`factelec_worker`** — `LOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`,
  `NOCREATEDB`. Rôle du process **worker** (`DATABASE_URL_WORKER`, 3.5) —
  **doit exister avant tout déploiement** de cette version : le worker throw
  explicitement au bootstrap si `DATABASE_URL_WORKER` est absente
  (`apps/api/README.md:3341-3343`), et la migration `0029` échoue si le rôle n'existe
  pas.

Transposition prod de `apps/api/scripts/db-init/00-roles.sql` — **mots de
passe générés forts, jamais ceux du fichier dev** (`owner_pw`/`app_pw`/
`worker_pw` sont des valeurs de développement local, à ne **jamais**
réutiliser) :

**COMMANDE** (à exécuter avec le rôle admin fourni par Scaleway à la création
de l'instance managée — remplacer les 3 placeholders par des secrets générés,
ex. `openssl rand -base64 32`, avant exécution) :

```sql
CREATE ROLE factelec_owner LOGIN PASSWORD '<GÉNÉRÉ-32-CHARS>' BYPASSRLS CREATEDB;
CREATE ROLE factelec_app   LOGIN PASSWORD '<GÉNÉRÉ-32-CHARS>' NOSUPERUSER NOBYPASSRLS NOCREATEDB;
CREATE ROLE factelec_worker LOGIN PASSWORD '<GÉNÉRÉ-32-CHARS>' NOSUPERUSER NOBYPASSRLS NOCREATEDB;
GRANT ALL ON DATABASE factelec TO factelec_owner;
ALTER SCHEMA public OWNER TO factelec_owner;
GRANT CREATE, USAGE ON SCHEMA public TO factelec_owner;
```

**VÉRIFICATION** :

```sql
SELECT rolname, rolcanlogin, rolbypassrls, rolcreatedb
FROM pg_roles WHERE rolname LIKE 'factelec_%' ORDER BY rolname;
```

Attendu : 3 lignes ; `factelec_owner` seul avec `rolbypassrls=t` et
`rolcreatedb=t` ; `factelec_app`/`factelec_worker` avec `rolbypassrls=f`,
`rolcreatedb=f`.

**PIÈGES/ROLLBACK** : si l'offre managée Scaleway **restreint**
`CREATE ROLE ... BYPASSRLS` (attribut parfois réservé aux rôles
superuser-like sur certaines offres cloud managées — **à confirmer en
conditions réelles, non vérifiable depuis ce dépôt**), procédure alternative :
utiliser le rôle admin fourni par Scaleway comme propriétaire de fait (les
migrations tournent alors sous **cet** admin plutôt que sous un
`factelec_owner` dédié) — dans tous les cas, **les migrations ne doivent
jamais tourner sous un rôle superuser Scaleway partagé avec d'autres bases**,
seulement sous le rôle propriétaire dédié à `factelec`. Ne jamais réutiliser
un mot de passe généré ici ailleurs (rotation indépendante par rôle).

## 4. Migrations

**BUT** : appliquer les 34 migrations (`0000` à `0033`) sous le rôle owner.

**Point d'entrée réel** (`apps/api/package.json:17`) :
`"db:migrate": "node --import tsx scripts/migrate.ts"`. Le script
(`apps/api/scripts/migrate.ts:1-11`) lit `DATABASE_OWNER_URL` (throw
explicite si absente), instancie `drizzle-orm/node-postgres` et appelle
`migrate(db, { migrationsFolder: 'src/db/migrations' })` — **forward-only** :
aucune commande `down`/rollback n'est outillée dans ce dépôt (vérifié : ni
`migrate.ts` ni `package.json` ne déclarent de script inverse).

**COMMANDE** (depuis la racine du monorepo, `DATABASE_OWNER_URL` = URL du
rôle `factelec_owner` créé en §3) :

```bash
DATABASE_OWNER_URL='postgres://factelec_owner:<GÉNÉRÉ-32-CHARS>@<HÔTE-PG>:5432/factelec' \
  pnpm --filter @factelec/api db:migrate
```

**VÉRIFICATION** :

```bash
psql "$DATABASE_OWNER_URL" -c "SELECT count(*) FROM drizzle.__drizzle_migrations;"
ls apps/api/src/db/migrations/*.sql | wc -l   # nombre de fichiers du journal
```

Attendu : les deux comptes sont **égaux**. À la rédaction de ce runbook :
34 migrations (`0000_init.sql` à `0033_health_migrations_read_grant.sql`,
recompter au moment de l'exécution si de nouvelles migrations ont été
ajoutées depuis).

**PIÈGES/ROLLBACK** : `db:migrate` échoue avant `0001` si `factelec_app`
n'existe pas (§3), avant `0029` si `factelec_worker` n'existe pas (§3), et à
`0010` si `pgcrypto` n'est pas disponible (§2). **Aucun rollback automatique**
: en cas d'échec en cours de séquence, restaurer depuis une sauvegarde/snapshot
Scaleway antérieure au run, corriger la cause racine (rôle manquant,
extension indisponible), puis relancer `db:migrate` — drizzle ne réapplique
pas les migrations déjà committées, il reprend à la première non appliquée.
Ne **jamais** exécuter ce script avec `DATABASE_URL` (rôle applicatif,
`NOBYPASSRLS`) : les migrations exigent le rôle owner.

## 5. Redis managé

**BUT** : provisionner une instance Redis managée, dédiée à Factelec (BullMQ
— génération, sweeps, session purge), avec TLS et mot de passe.

- **`REDIS_TLS=true`** — parsé **explicitement** (`"true"`/`"1"` seuls
  reconnus, `env.ts:61-67`) : `z.coerce.boolean` est volontairement **évité**
  (transformerait à tort toute chaîne non vide, y compris `"false"`, en
  `true`).
- **`REDIS_PASSWORD`** — obligatoire sur une offre managée (absent en dev
  local = aucune auth, `env.ts:60`).
- **`REDIS_DB`** — index de base logique (`SELECT n`, défaut `0`,
  `env.ts:59`). **Dédiée** à Factelec : si l'offre Redis managée choisie
  tourne en mode **Cluster**, seule la DB `0` est utilisable (limite du
  protocole Redis Cluster, pas spécifique Scaleway) — à vérifier sur la
  console selon l'offre retenue (instance simple vs cluster).

**COMMANDE** (provisionner via console/CLI Scaleway, puis vérifier la
connexion TLS) :

```bash
redis-cli -h <HÔTE-REDIS> -p 6379 --tls -a '<GÉNÉRÉ-32-CHARS>' PING
```

**VÉRIFICATION** : réponse `PONG`.

**PIÈGES** : `REDIS_TLS` mal positionné (`"false"` au lieu d'omis/`"true"`)
sur une offre managée qui **exige** TLS fait échouer toute connexion
BullMQ au démarrage du worker — aucune génération, aucun sweep ne tournera
silencieusement en local uniquement, l'échec est immédiat et bruyant (pool
Redis en erreur).

## 6. Object Storage WORM (archives)

**BUT** : préparer le bucket d'archivage à valeur probante — **honnêteté
d'abord** : l'infrastructure peut être préparée dès maintenant, mais
l'ancrage de tête WORM ne devient **effectif** qu'une fois l'adaptateur S3
livré côté code, ce qui **n'est pas le cas à ce jour**.

**État réel du code (vérifié)** : `ArchiveModule`
(`apps/api/src/archive/archive.module.ts:17-26`) sélectionne le driver via
`ARCHIVE_DRIVER`. Pour `driver === 's3'`, la factory **lève une erreur
explicite et testée** :

```
"ARCHIVE_DRIVER='s3' : adaptateur S3 object-lock activé au déploiement (non fourni en 2.2)"
```

Autrement dit : **préparé, activation différée** — positionner
`ARCHIVE_DRIVER=s3` en production **avant** que l'adaptateur ne soit livré
**fait planter l'API et le worker au démarrage** (erreur levée à la
construction du module DI, avant `app.listen`). Tant que ce driver n'existe
pas, la production doit tourner avec `ARCHIVE_DRIVER=local` (défaut).

**Conséquence opérationnelle si `local` reste utilisé en prod** :
`LocalFilesystemArchiveStore` écrit sur `ARCHIVE_LOCAL_DIR` (défaut
`./var/archive`, `archive.service`/`local-filesystem-archive-store.ts`) —
**le filesystem du container**, en `chmod 0o444` après écriture. C'est une
« immuabilité applicative locale (simulacre WORM), **pas** un WORM matériel »
(`apps/api/README.md:466-471`) : un processus avec les droits filesystem suffisants
peut toujours réécrire le fichier, contrairement à un vrai object-lock. Si
la production démarre sans adaptateur S3, **monter un volume persistant** sur
`ARCHIVE_LOCAL_DIR` est indispensable — sans quoi les archives probatoires
sont perdues à chaque redéploiement du container.

**COMMANDE** (préparation infra, indépendante du code — peut être faite
maintenant) : créer un bucket Object Storage Scaleway avec
`object-lock`/rétention en mode **`COMPLIANCE`**, ~10 ans
(`apps/api/README.md:475`), policy IAM minimale (écriture par l'application
uniquement, pas de suppression).

**VÉRIFICATION** : configuration du bucket visible en console (object-lock
actif, mode `COMPLIANCE`, durée de rétention). **Aucun test applicatif
possible tant que l'adaptateur n'est pas livré** — ne pas positionner
`ARCHIVE_DRIVER=s3` pour « tester » : l'échec est le comportement voulu et
testé du code actuel.

**PIÈGES/ROLLBACK** : ne **jamais** basculer `ARCHIVE_DRIVER=s3` avant que
l'implémentation de l'adaptateur ne soit mergée et re-vérifiée dans ce même
runbook. Si activé par erreur : redémarrage en échec immédiat, revenir à
`ARCHIVE_DRIVER=local` (ou l'omettre, c'est le défaut) et redéployer.

## 7. Environnement API/worker

**BUT** : positionner les **61 clés** validées par le schéma zod
`envSchema` (`apps/api/src/config/env.ts:13-278`, comptées à la rédaction).
Voir `.env.example` pour un squelette dev — **aucune valeur de ce fichier
n'est réutilisable en prod**.

**Hors schéma, à part** : `DATABASE_OWNER_URL` n'est **pas** une clé de
`envSchema` — le commentaire du code est explicite : « L'URL du rôle owner
n'est jamais chargée par le process API » (`env.ts:21-22`). Elle ne sert
qu'aux scripts `migrate.ts`/`provision-tenant.ts`/`provision-admin.ts`,
exécutés **hors** du chemin de requête HTTP — **ne jamais la déployer dans
l'environnement des containers api/worker en service**, seulement dans celui
d'une exécution ponctuelle de script (CI de migration, poste opérateur).

### A. Cœur HTTP / runtime

| Clé | Obligatoire prod | Valeur recommandée | Source du secret | Note |
| --- | --- | --- | --- | --- |
| `NODE_ENV` | Oui | `production` | — | **Point dur** (non listé dans la spec, trouvé au code) : `NODE_ENV==='production'` est le SEUL signal qui active `secure: true` sur les cookies de session/CSRF (`src/auth/cookie.ts:11`). Oublier cette valeur = cookies envoyés sans flag `Secure` en HTTPS prod. |
| `PORT` | Non (défaut `3000`) | Selon la convention du runtime Scaleway retenu (Containers serverless : `PORT` souvent injecté par la plateforme) | — | `app.listen(PORT)` (`main.ts:48`). |
| `LOG_LEVEL` | Non (défaut `info`) | `info` | — | `fatal`…`silent`, pino. |

### B. Base de données (rôle applicatif)

| Clé | Obligatoire prod | Valeur recommandée | Source du secret | Note |
| --- | --- | --- | --- | --- |
| `DATABASE_URL` | Oui (API **et** worker, voir points durs) | `postgres://factelec_app:<GÉNÉRÉ-32-CHARS>@<HÔTE-PG>:5432/factelec` | Secret manager (mot de passe généré §3) | Rôle `factelec_app`, soumis à la RLS. |
| `DATABASE_URL_WORKER` | Oui pour `pnpm start:worker` (throw explicite sinon, `WorkerModule`) | `postgres://factelec_worker:<GÉNÉRÉ-32-CHARS>@<HÔTE-PG>:5432/factelec` | Secret manager (mot de passe généré §3) | Rôle `factelec_worker`, moindre privilège (3.5). Non lue par le process API. |

### C. CORS / rate limit / proxy

| Clé | Obligatoire prod | Valeur recommandée | Source du secret | Note |
| --- | --- | --- | --- | --- |
| `CORS_ALLOWED_ORIGINS` | Oui | `https://<dashboard.À-CHOISIR>` (CSV si plusieurs origines) | — | Défaut `''` = **aucune** origine autorisée ; oubli = dashboard bloqué par CORS. |
| `RATE_LIMIT_TTL` | Non (défaut `60`) | Garder le défaut sauf besoin observé | — | Secondes, fenêtre glissante. |
| `RATE_LIMIT_LIMIT` | Non (défaut `120`) | Garder le défaut sauf besoin observé | — | Requêtes/fenêtre/IP. |
| `TRUST_PROXY` | Oui — **point dur** | Nombre exact de sauts de proxy réels devant l'API sur la topologie Scaleway retenue (à vérifier en conditions réelles) | — | `0` (défaut) = connexion directe. Derrière un LB, doit valoir le nombre de sauts **exact** — trop haut = spoofing d'IP possible (`main.ts:35-44`, `env.ts:33-39`). |

### D. Sessions / cookies

| Clé | Obligatoire prod | Valeur recommandée | Source du secret | Note |
| --- | --- | --- | --- | --- |
| `SESSION_TTL_HOURS` | Non (défaut `12`, max `720`) | Garder le défaut sauf décision produit | — | TTL absolu, sessions **utilisateur**. |
| `ADMIN_SESSION_TTL_HOURS` | Non (défaut `2`, max `24`) | Garder le défaut | — | TTL dédié session **super admin** (5.2). |
| `SESSION_COOKIE_DOMAIN` | Oui si dashboard et API sur des sous-domaines distincts — **point dur** | `.<À-CHOISIR>` (point de tête, ex. `.factelec.fr`) | — | Absent = cookie scopé à l'hôte courant (rompt le partage cross-subdomain dashboard↔API). |

### E. Redis / BullMQ

| Clé | Obligatoire prod | Valeur recommandée | Source du secret | Note |
| --- | --- | --- | --- | --- |
| `REDIS_HOST` | Oui | `<HÔTE-REDIS>` (endpoint managé Scaleway) | — | Défaut `localhost` (dev). |
| `REDIS_PORT` | Non (défaut `6379`) | Selon l'offre managée | — | — |
| `REDIS_DB` | Non (défaut `0`) | `0` (voir §5, limite cluster) | — | `SELECT n`. |
| `REDIS_PASSWORD` | Oui | — | Secret manager (fourni par Scaleway à la création) | Absent = aucune auth (dev seulement). |
| `REDIS_TLS` | Oui | `true` | — | Parsé explicitement (`"true"`/`"1"` seuls) — **jamais** `z.coerce.boolean` (§5). |

### F. Génération / réconciliation

| Clé | Obligatoire prod | Valeur recommandée | Source du secret | Note |
| --- | --- | --- | --- | --- |
| `GENERATION_JOB_ATTEMPTS` | Non (défaut `3`, max `10`) | Garder le défaut | — | Avant passage en `failed`. |
| `SESSION_PURGE_EVERY_MS` | Non (défaut `3600000` = 1 h) | Garder le défaut | — | Purge des sessions expirées. |
| `RECONCILIATION_STALE_MS` | Non (défaut `300000` = 5 min) | Garder le défaut | — | Factures `received` orphelines. |
| `RECONCILIATION_SWEEP_EVERY_MS` | Non (défaut `60000` = 1 min) | Garder le défaut | — | Périodicité du balayage. |
| `RECONCILIATION_GENERATING_STALE_MS` | Non (défaut `900000` = 15 min) | Garder le défaut | — | Factures `generating` bloquées (crash worker). |
| `GENERATION_MAX_ATTEMPTS_CAP` | Non (défaut `5`, max `50`) | Garder le défaut | — | Cap avant DLQ (facture poison). |

### G. Archivage WORM

| Clé | Obligatoire prod | Valeur recommandée | Source du secret | Note |
| --- | --- | --- | --- | --- |
| `ARCHIVE_DRIVER` | Oui | `local` — **`s3` fait planter le process, non fourni** (§6) | — | `archive.module.ts:19-21`. |
| `ARCHIVE_LOCAL_DIR` | Oui si driver `local` en prod | Chemin sur **volume persistant** monté (§6) | — | Défaut `./var/archive`. |
| `ARCHIVE_RETRY_EVERY_MS` | Non (défaut `300000` = 5 min) | Garder le défaut | — | Reprise `archive_status='failed'`. |

### H. Routage destinataire

| Clé | Obligatoire prod | Valeur recommandée | Source du secret | Note |
| --- | --- | --- | --- | --- |
| `ROUTING_RETRY_EVERY_MS` | Non (défaut `300000` = 5 min) | Garder le défaut | — | Reprise `routing_status` `pending`/`unaddressable`. |

### I. E-reporting Flux 10

| Clé | Obligatoire prod | Valeur recommandée | Source du secret | Note |
| --- | --- | --- | --- | --- |
| `EREPORTING_TRANSMISSION_DRIVER` | Oui | `local` — `sftp`/`as2`/`as4`/`api` **activés au déploiement, non fournis** (`ereporting-transmission.module.ts:31-33`) | — | Préparé, activation différée. |
| `EREPORTING_LOCAL_DIR` | Oui si driver `local` | Volume persistant | — | Défaut `./var/ereporting`. |
| `EREPORTING_PA_ID` | Oui — `<ITEM-XAVIER>` | Matricule réel de la PA (post-immatriculation DGFiP) | Dossier d'immatriculation | Défaut `'PA00'` placeholder. Miroir attendu = `CDV_PA_MATRICULE` (env.ts:234-236). |
| `EREPORTING_PA_SCHEME_ID` | Non | `0238` (défaut, schéma d'identifiant ICD de la PA, TT-7) | — | Garder le défaut — aucune indication contraire dans le code ou les README à ce jour. |
| `EREPORTING_PA_NAME` | Oui | Raison sociale réelle de la PA | — | Défaut `'Factelec PA'` placeholder. |
| `EREPORTING_SWEEP_EVERY_MS` | Non (défaut `3600000` = 1 h) | Garder le défaut | — | Ordonnanceur e-reporting. |
| `EREPORTING_GENERATION_JOB_ATTEMPTS` | Non (défaut `3`, max `10`) | Garder le défaut | — | Distingue erreur opérationnelle (xmllint absent) du rejet sémantique. |

### J. Paiements (déclarées, non consommées)

| Clé | Obligatoire prod | Valeur recommandée | Source du secret | Note |
| --- | --- | --- | --- | --- |
| `PAYMENTS_SWEEP_EVERY_MS` | Non | Garder le défaut | — | **Non consommée** — le sweep paiements tourne sur `EREPORTING_SWEEP_EVERY_MS` (`env.ts:148-158`). |
| `PAYMENTS_LOOKBACK_MS` | Non | Garder le défaut | — | **Non consommée** — fenêtre réelle = `computeDuePaymentPeriods`/`MAX_DUE_PERIODS` (`period.ts`). |

### K. Annuaire Flux 13/14

| Clé | Obligatoire prod | Valeur recommandée | Source du secret | Note |
| --- | --- | --- | --- | --- |
| `ANNUAIRE_DRIVER` | Oui | `local` — `api`/`edi` **activés au déploiement, non fournis** (`annuaire-transport.module.ts:25-27`) | — | Préparé, activation différée (API PISTE-OAuth2 / EDI SFTP-AS2-AS4). |
| `ANNUAIRE_LOCAL_DIR` | Oui si driver `local` | Volume persistant | — | Défaut `./var/annuaire`. |
| `ANNUAIRE_SYNC_EVERY_MS` | Non (défaut `86400000` = 24 h) | Garder le défaut | — | Synchro différentielle. |
| `ANNUAIRE_COMPLETE_EVERY_MS` | Non (défaut `604800000` = 7 j) | Garder le défaut | — | Synchro complète. |
| `ANNUAIRE_PUBLISH_JOB_ATTEMPTS` | Non (défaut `3`) | Garder le défaut | — | File `annuaire-sync`. |
| `ANNUAIRE_REPUBLISH_SWEEP_EVERY_MS` | Non (défaut `300000` = 5 min) | Garder le défaut | — | Reprise drafts figés. |

### L. Consentement annuaire

| Clé | Obligatoire prod | Valeur recommandée | Source du secret | Note |
| --- | --- | --- | --- | --- |
| `CONSENT_DRIVER` | Oui | `local` — `eidas` **activé au déploiement, non fourni** (`consent-signature.module.ts:32-34`) | — | Scellement structurel seul (pas de vérification cryptographique). |
| `CONSENT_LOCAL_DIR` | Oui si driver `local` | Volume persistant | — | Défaut `./var/consent`. |

### M. CDV Flux 6

| Clé | Obligatoire prod | Valeur recommandée | Source du secret | Note |
| --- | --- | --- | --- | --- |
| `CDV_TRANSMISSION_DRIVER` | Oui | `local` — `sftp`/`as2`/`as4`/`as4-peppol`/`api` **activés au déploiement, non fournis** (`cdv-transmission.module.ts:31-33`) | — | Préparé, activation différée (adhésion OpenPeppol = item Xavier pour `as4-peppol`). |
| `CDV_LOCAL_DIR` | Oui si driver `local` | Volume persistant | — | Défaut `./var/cdv`. |
| `CDV_SWEEP_EVERY_MS` | Non (défaut `3600000` = 1 h) | Garder le défaut | — | Ordonnanceur 24 h. |
| `CDV_TRANSMISSION_LOOKBACK_MS` | Non (défaut `172800000` = 48 h) | Garder le défaut | — | Fenêtre de rattrapage. |
| `CDV_TRANSMISSION_JOB_ATTEMPTS` | Non (défaut `3`, max `10`) | Garder le défaut | — | Erreur opérationnelle vs rejet fonctionnel. |
| `CDV_STUCK_RETRY_EVERY_MS` | Non (défaut `300000` = 5 min) | Garder le défaut | — | Reprise `parked`. |
| `CDV_PA_MATRICULE` | Oui — `<ITEM-XAVIER>` | Matricule ICD 0238 réel du PA (miroir `EREPORTING_PA_ID`) | Dossier d'immatriculation | Défaut `'0000'` placeholder. |

### N. Billing Stripe

| Clé | Obligatoire prod | Valeur recommandée | Source du secret | Note |
| --- | --- | --- | --- | --- |
| `BILLING_DRIVER` | Oui | `stripe` (voir §8) | — | `none` = 100 % fonctionnel sans Stripe ; `stripe` exige les 4 clés `STRIPE_*` ci-dessous, throw fail-fast sinon (`billing-port.module.ts:33`). |
| `BILLING_ENFORCEMENT` | Décision commerciale explicite | `off` jusqu'à décision go-live commercial, puis `on` | — | Découplé du driver ; `none` neutralise le garde même à `on`. |
| `STRIPE_SECRET_KEY` | Oui si driver `stripe` | `<CLÉ-LIVE-STRIPE-sk_live_...>` | Dashboard Stripe (mode live) → secret manager | Jamais `sk_test_...` en prod. |
| `STRIPE_WEBHOOK_SECRET` | Oui si driver `stripe` | `<whsec_...-LIVE>` | Dashboard Stripe (endpoint webhook live, §8) | **Pas** `stripe listen` (dev only). |
| `STRIPE_PRICE_BASE` | Oui si driver `stripe` | ID `price_...` imprimé par `billing:bootstrap` (§8) | Sortie du script `billing:bootstrap` | — |
| `STRIPE_PRICE_METERED` | Oui si driver `stripe` | ID `price_...` imprimé par `billing:bootstrap` (§8) | Sortie du script `billing:bootstrap` | — |
| `BILLING_DASHBOARD_URL` | Oui si driver `stripe` | `https://<dashboard.À-CHOISIR>` | — | Défaut `http://localhost:3001` (dev) — `success_url`/`cancel_url`/`return_url` Stripe. |
| `BILLING_USAGE_EVERY_MS` | Non (défaut `3600000` = 1 h) | Garder le défaut | — | Sweep de report d'usage métré. |
| `BILLING_USAGE_LOOKBACK_DAYS` | Non (défaut `3`, max `30`) | Garder le défaut | — | **En jours**, pas en ms (seule exception du fichier). |

### O. Observabilité

| Clé | Obligatoire prod | Valeur recommandée | Source du secret | Note |
| --- | --- | --- | --- | --- |
| `METRICS_TOKEN` | Recommandé (optionnelle au schéma) | `<GÉNÉRÉ-32-CHARS>` (min. 16 imposé par le schéma) | Secret manager | Absente = `/metrics` répond **404** (opt-in explicite, aucune métrique exposée par défaut). |

### Points durs — synthèse

- **`TRUST_PROXY`** : à positionner au nombre **exact** de sauts de proxy
  Scaleway devant l'API. Une valeur trop haute permet un spoofing d'IP côté
  rate limiting (`main.ts:35-44`) — à valider en conditions réelles, pas
  déductible du code seul.
- **`SESSION_COOKIE_DOMAIN`** : requis dès que dashboard (`apps/web`) et API
  sont sur des sous-domaines distincts (`credentials: true` côté CORS,
  `main.ts:32`) — sinon le cookie de session ne sera pas partagé.
- **`CORS_ALLOWED_ORIGINS`** : doit contenir l'origine exacte du dashboard
  prod, sinon `apps/web` ne peut plus appeler l'API (bloqué par le
  middleware CORS avant même l'authentification).
- **3 URLs base de données, jamais confondues** : `DATABASE_URL` (rôle
  `factelec_app`, process API), `DATABASE_URL_WORKER` (rôle
  `factelec_worker`, process worker), `DATABASE_OWNER_URL` (rôle
  `factelec_owner`, scripts de migration/provisioning **uniquement**,
  **jamais** dans l'environnement d'un container en service).
- **Le process worker a besoin des DEUX `DATABASE_URL*`** — piège non
  documenté ailleurs, trouvé au code : `WorkerModule` importe
  `AppConfigModule` (`worker.module.ts:57`), qui valide l'**intégralité** du
  schéma `envSchema` — y compris `DATABASE_URL`, requis (`z.url()`, pas
  `.optional()`, `env.ts:23`). Un container worker démarré avec **seulement**
  `DATABASE_URL_WORKER` échoue au bootstrap (« Invalid environment
  configuration: DATABASE_URL »), **avant même** que `DbModule.forRoot`
  (qui, lui, ne lit que `DATABASE_URL_WORKER`, `db.module.ts:38`) ne soit
  atteint. Positionner les **deux** clés sur le container worker (même
  valeur `DATABASE_URL` que celle de l'API — elle n'est jamais utilisée pour
  se connecter côté worker, seulement validée au format).
- **Drivers `local` vs réels** : `ARCHIVE_DRIVER`, `EREPORTING_TRANSMISSION_DRIVER`,
  `ANNUAIRE_DRIVER`, `CONSENT_DRIVER`, `CDV_TRANSMISSION_DRIVER` valent tous
  `local` à ce jour en production — les 5 alternatives réelles (S3
  object-lock, SFTP/AS2/AS4/API, PISTE-OAuth2/EDI, eIDAS, AS4-Peppol) sont
  **activées au déploiement**, chacune fait planter le process concerné au
  démarrage si sélectionnée sans adaptateur (vérifié module par module,
  §6 et tableaux G/I/K/L/M ci-dessus).
- **`EREPORTING_PA_ID`/`CDV_PA_MATRICULE`** : les deux doivent porter le
  **même** matricule réel une fois l'immatriculation DGFiP obtenue (item
  Xavier) — placeholders `'PA00'`/`'0000'` à ne jamais laisser en prod.

## 8. Billing Stripe

**BUT** : basculer sur un compte Stripe **live** et provisionner le
catalogue produit.

**COMMANDE** — 1. bootstrap du catalogue (idempotent par `lookup_key`,
`apps/api/scripts/billing-bootstrap.ts:61-123`, ne modifie jamais un objet
existant) :

```bash
STRIPE_SECRET_KEY='sk_live_...' pnpm --filter @factelec/api billing:bootstrap
```

**Garde du script** (`billing-bootstrap.ts:132-141`) : si la clé **ne**
commence **pas** par `sk_test_` — c'est-à-dire précisément le cas d'une clé
`sk_live_...` en production — le script affiche un **avertissement non
bloquant** (« pensé pour la sandbox... poursuite malgré tout ») puis
continue. **Ce warning est attendu en production**, il n'indique aucune
erreur.

2. Copier les 2 IDs imprimés (`STRIPE_PRICE_BASE=...`,
   `STRIPE_PRICE_METERED=...`) dans le secret manager.
3. Créer l'endpoint webhook dans le dashboard Stripe (mode live) :
   `https://api.<À-CHOISIR>/billing/webhook` — **pas** `stripe listen`
   (outil dev uniquement) — copier le `whsec_...` généré dans
   `STRIPE_WEBHOOK_SECRET`.
4. Positionner `BILLING_DRIVER=stripe` — la sélection du driver est **figée
   au bootstrap du process**, jamais réévaluée à chaud (`apps/api/README.md:3002-3004`).
5. `BILLING_ENFORCEMENT` : décision commerciale explicite, séparée du
   driver (défaut `off` — le garde journalise sans jamais bloquer tant que
   non activé, `env.ts:243-246`).

**VÉRIFICATION** : `stripe.billing.meters.list()`/`stripe.prices.list()`
côté dashboard Stripe montrent `factelec_base`/`factelec_metered` ; un
événement de test envoyé depuis le dashboard Stripe vers l'endpoint webhook
prod répond `200` (visible dans les logs de livraison Stripe) — le
compteur Prometheus `billing_webhook_events_total{outcome}` (§10)
s'incrémente en conséquence.

**PIÈGES/ROLLBACK** : le webhook accepte `POST /billing/webhook` **sans**
guard session/CSRF — authenticité garantie **uniquement** par la signature
HMAC (`stripe-signature` + `rawBody`, `apps/api/README.md:2832`) : une divergence de
`STRIPE_WEBHOOK_SECRET` entre Stripe et l'API fait échouer silencieusement
**tous** les événements en 400 (`rawBody`/signature invalides) — vérifier ce
secret en priorité si `billing_webhook_events_total` reste plat après un
événement de test. `BILLING_ENFORCEMENT=on` prématuré bloque
(402) toute émission de facture pour un tenant sans abonnement actif — ne
l'activer qu'après validation du flux Checkout/Portal.

## 9. Super admin + MFA (consigne TOFU)

**BUT** : créer chaque super admin plateforme puis **enrôler son MFA TOTP
immédiatement** — aucune fenêtre où le mot de passe est valide sans TOTP
enrôlé.

**Provisioning** — CLI **uniquement**, aucune inscription self-service
(`provision-admin.ts:20-51`) : le mot de passe ne transite **jamais** par
`argv` (visible via `ps`/historique shell) — lu depuis
`PROVISION_ADMIN_PASSWORD` ou saisi en interactif.

**COMMANDE** :

```bash
DATABASE_OWNER_URL='postgres://factelec_owner:<GÉNÉRÉ-32-CHARS>@<HÔTE-PG>:5432/factelec' \
PROVISION_ADMIN_PASSWORD='<GÉNÉRÉ-32-CHARS>' \
  pnpm --filter @factelec/api provision:admin 'admin@<À-CHOISIR>'
```

**Consigne TOFU (time-of-first-use) — pourquoi « immédiatement » n'est pas
cosmétique** : `POST /admin/login` avec mot de passe valide mais admin **non
enrôlé** (`totp_enabled_at IS NULL`) répond **202** `{ enrollmentRequired,
otpauthUrl, secret }` **sans créer de session** (`apps/api/README.md:3143-3146`) —
donc le mot de passe seul ne suffit **jamais** à obtenir une session. Le
risque réel : quiconque connaît le mot de passe (fuite du canal de
transmission `PROVISION_ADMIN_PASSWORD`, capture d'écran, etc.) peut
**lui-même** appeler `POST /admin/totp/confirm` et achever l'enrôlement **à
la place de l'admin légitime** — prenant possession définitive du compte
(nouveau secret TOTP + 10 codes de récupération connus de l'attaquant
seul). D'où la consigne : transmettre le mot de passe et faire enrôler le
TOTP **dans la foulée**, jamais en différé.

**COMMANDE** (l'admin s'enrôle lui-même, hors session, dès le premier
`POST /admin/login`) :

```bash
curl -s -X POST https://api.<À-CHOISIR>/admin/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@<À-CHOISIR>","password":"<MOT-DE-PASSE-ADMIN>"}'
# → 202 { enrollmentRequired: true, otpauthUrl, secret } : scanner otpauthUrl
# dans une app TOTP, puis confirmer :
curl -s -X POST https://api.<À-CHOISIR>/admin/totp/confirm \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@<À-CHOISIR>","password":"<MOT-DE-PASSE-ADMIN>","totpCode":"123456"}'
# → 200 { recoveryCodes: [...] } — les 10 codes ne sont AFFICHÉS QU'UNE FOIS,
# à stocker immédiatement dans un coffre (jamais rejournalisés ensuite).
```

**VÉRIFICATION** :

```sql
SELECT email, totp_enabled_at IS NOT NULL AS enrolled
FROM platform_admins WHERE email = 'admin@<À-CHOISIR>';
```

Attendu : `enrolled = t` immédiatement après la confirmation.

**Runbook — codes de récupération épuisés** (`apps/api/README.md:3169-3186`) :
**aucun endpoint de régénération** (surface minimale assumée). Reset
manuel, sous le rôle **owner** (jamais `factelec_app` — `platform_admins`
est deny-all pour ce dernier) :

```sql
UPDATE platform_admins
SET totp_secret = NULL, totp_enabled_at = NULL, recovery_codes = NULL
WHERE email = 'admin@<À-CHOISIR>';
```

**PIÈGES/ROLLBACK** : le prochain `POST /admin/login` de cet admin relance
l'enrôlement depuis zéro (**202** `enrollmentRequired`, nouveau secret,
nouveau QR, 10 nouveaux codes à la confirmation) — exécuter ce reset
**immédiatement** après l'avoir communiqué à l'admin légitime, même
consigne TOFU qu'au provisioning initial (fenêtre mot-de-passe-sans-TOTP
rouverte par le reset).

## 10. Observabilité

**BUT** : activer le scrape Prometheus et le healthcheck du load balancer.

- **`METRICS_TOKEN`** (≥16 caractères, imposé par le schéma `env.ts:277`) —
  Bearer sur `GET /metrics`, comparaison à temps constant
  (`timingSafeEqual`, `apps/api/README.md:3215-3217`). **Absente → 404**
  indiscernable d'une route absente (opt-in explicite).
- **`GET /health`** — liveness pure, aucune dépendance externe,
  `{ status: 'ok' }` (`apps/api/README.md:3264`). À pointer par le healthcheck du
  load balancer (redémarrage de container si down).
- **`GET /health/ready`** — readiness enrichi : sondes DB/Redis/migrations,
  chacune bornée 2 s, **503** si un composant est down
  (`apps/api/README.md:3243-3262`). À utiliser pour gater le trafic entrant
  (readiness probe), pas pour décider un redémarrage brutal.

**COMMANDE** :

```bash
curl -s https://api.<À-CHOISIR>/health
curl -s https://api.<À-CHOISIR>/health/ready
curl -s -H "Authorization: Bearer <GÉNÉRÉ-32-CHARS>" https://api.<À-CHOISIR>/metrics | head -5
```

**VÉRIFICATION** : `/health` → `{"status":"ok"}` ; `/health/ready` → `200`
avec les 3 sondes `ok:true` ; `/metrics` → texte au format Prometheus
(`http_request_duration_seconds`, `bullmq_jobs`, `pg_pool`,
`billing_guard_denials_total`, `billing_webhook_events_total`).

**PIÈGES** : `METRICS_TOKEN` de moins de 16 caractères est **rejeté au
bootstrap** (échec de validation zod, le process ne démarre pas du tout) —
générer un secret conforme dès le départ. Rétention des logs applicatifs :
**décision infrastructure non couverte par le code** (pas de politique de
rétention encodée) — à définir par Xavier au niveau du runtime de logs
retenu.

## 11. Processus (api / worker / web)

**BUT** : construire puis démarrer les 3 processus, dans l'ordre qui respecte
les dépendances établies aux sections précédentes.

**Build** (avant tout démarrage) :

```bash
pnpm --filter @factelec/api build     # swc → dist/, copie src/db/migrations
pnpm --filter @factelec/web build     # next build
```

**Ordre de démarrage** : §3 (rôles) → §2/§4 (pgcrypto + migrations) → **puis
seulement** les 3 process ci-dessous (`/health/ready` du process API
dépendra du décompte de migrations dès son premier appel, §10) :

| Process | Commande réelle | Script `package.json` | Env requis (en plus de §7) |
| --- | --- | --- | --- |
| **api** | `node dist/main.js` | `pnpm --filter @factelec/api start` | `DATABASE_URL` |
| **worker** | `node dist/worker-main.js` | `pnpm --filter @factelec/api start:worker` | `DATABASE_URL` **et** `DATABASE_URL_WORKER` (§7, point dur) |
| **web** | `next start -p 3001` | `pnpm --filter @factelec/web start` | Variables propres à `apps/web` (hors périmètre `envSchema` API — voir `apps/web/README.md`) |

**Arrêt gracieux (SIGTERM)** : les deux process Nest appellent
`enableShutdownHooks()` (`main.ts:46`, `worker-main.ts:13`) → `onModuleDestroy`
ferme le pool Postgres proprement (`db.module.ts:51-57`, garde
d'idempotence). Prévoir un délai de grâce **généreux** (≥30 s) côté
orchestrateur avant `SIGKILL` : une génération interrompue exactement entre
`generating` et complétion laisse une fenêtre résiduelle bornée reprise par
`RECONCILIATION_GENERATING_STALE_MS` (15 min par défaut, §7-F) — le filet de
sécurité existe, mais un arrêt trop brutal (délai de grâce trop court)
multiplie les jobs interrompus à rattraper.

**Dimensionnement initial** : **non déterminable depuis le code** (aucun
test de charge/benchmark dans ce dépôt) — décision infrastructure à affiner
par observation (`pg_pool{state}`/`bullmq_jobs{queue,state}` exposés en
Prometheus, §10). Point de départ raisonnable non vérifié : 1 instance
api + 1 instance worker + 1 instance web, taille container modeste,
scaling horizontal guidé par les métriques une fois le trafic réel observé.

**VÉRIFICATION** : `curl https://api.<À-CHOISIR>/health` → `200` pour l'api ;
logs worker sans erreur `DATABASE_URL_WORKER requis` au démarrage ; `curl
https://dashboard.<À-CHOISIR>` → page `apps/web` servie.

**PIÈGES/ROLLBACK** : démarrer le worker **avant** d'avoir provisionné
`factelec_worker`/`DATABASE_URL_WORKER` (§3/§7) le fait échouer au
bootstrap immédiatement (throw explicite, aucune génération asynchrone
possible tant que non corrigé) — sans affecter l'ingestion synchrone
`POST /invoices` côté API (le statut reste `received`, jamais généré, tant
que le worker ne tourne pas).

## 12. Vérification finale

**BUT** : dernier contrôle avant d'ouvrir le trafic réel, combinant un
contrôle automatisé et une checklist de smoke manuelle.

**Script automatisé** — `apps/api/scripts/verify-provisioning.ts` : livrable
**compagnon** de ce même chantier phase 6 prep (Task 3 du plan
`docs/superpowers/plans/2026-07-20-phase6-prep-provisioning.md`), read-only,
rôles/pgcrypto/migrations/RLS/grants/Redis/env critiques, exit code ≠ 0 si un
contrôle échoue. **S'il n'existe pas encore au moment où ce runbook est
suivi**, exécuter la checklist manuelle ci-dessous à la place — elle couvre
les mêmes invariants un par un.

**COMMANDE** (une fois le script livré) :

```bash
DATABASE_OWNER_URL='...' pnpm --filter @factelec/api exec node --import tsx scripts/verify-provisioning.ts
```

**Checklist de smoke manuelle** :

1. **Signup** : `POST /auth/signup` avec un tenant de test → `201`, cookie
   de session posé.
2. **Dépôt facture** : `POST /invoices` avec une clé API émise par
   `pnpm --filter @factelec/api provision:tenant` → `201 { status:
   'received' }`, puis `GET /invoices/:id` bascule sur `status: 'generated'`
   une fois le worker passé (5 formats du socle disponibles).
3. **`/metrics`** avec le bon `METRICS_TOKEN` → `200`, contenu Prometheus
   non vide (§10).
4. **`/health`** et **`/health/ready`** → `200`, 3 sondes `ok:true` (§10).
5. **Rôles/RLS** : `SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname
   LIKE 'factelec_%'` → seul `factelec_owner` a `rolbypassrls=t` (§3).
6. **Migrations** : `SELECT count(*) FROM drizzle.__drizzle_migrations`
   égale le nombre de fichiers `*.sql` du journal (§4).

**VÉRIFICATION** : les 6 points de la checklist passent, **et** (une fois le
script disponible) `verify-provisioning.ts` sort avec un code `0`.

**PIÈGES/ROLLBACK** : un échec à l'étape 2 (facture jamais `generated`)
pointe presque toujours vers le worker (§11 — `DATABASE_URL_WORKER`
manquante, ou `xmllint` absent de l'image worker si l'échec touche
spécifiquement le pipeline e-reporting, §1). Ne pas ouvrir le trafic
production tant que les 6 points ne sont pas verts.
