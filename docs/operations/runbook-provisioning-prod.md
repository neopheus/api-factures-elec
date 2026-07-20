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
`apply` Terraform réel, DNS/certificats, CI/CD de déploiement (squelette
Terraform et script `verify-provisioning.ts` : livrables compagnons de ce même
chantier, voir `infra/README.md` et §12).

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
  (`package.json:7`), à activer via `corepack`.
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
  à ce jour (`README.md:1062-1064`), **jamais testée sur l'offre managée
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
  de provisioning CLI (`README.md:3299-3302`) — **jamais** par les process
  API/worker.
- **`factelec_app`** — `LOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`, `NOCREATEDB`.
  Rôle du process **API** (`DATABASE_URL`).
- **`factelec_worker`** — `LOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`,
  `NOCREATEDB`. Rôle du process **worker** (`DATABASE_URL_WORKER`, 3.5) —
  **doit exister avant tout déploiement** de cette version : le worker throw
  explicitement au bootstrap si `DATABASE_URL_WORKER` est absente
  (`README.md:3341-3343`), et la migration `0029` échoue si le rôle n'existe
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
(`README.md:466-471`) : un processus avec les droits filesystem suffisants
peut toujours réécrire le fichier, contrairement à un vrai object-lock. Si
la production démarre sans adaptateur S3, **monter un volume persistant** sur
`ARCHIVE_LOCAL_DIR` est indispensable — sans quoi les archives probatoires
sont perdues à chaque redéploiement du container.

**COMMANDE** (préparation infra, indépendante du code — peut être faite
maintenant) : créer un bucket Object Storage Scaleway avec
`object-lock`/rétention en mode **`COMPLIANCE`**, ~10 ans
(`README.md:475`), policy IAM minimale (écriture par l'application
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

## 8. Billing Stripe

## 9. Super admin + MFA (consigne TOFU)

## 10. Observabilité

## 11. Processus (api / worker / web)

## 12. Vérification finale
