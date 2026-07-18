import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'

export interface TestDb {
  container: StartedPostgreSqlContainer
  appUrl: string
  workerUrl: string
  ownerUrl: string
  stop(): Promise<void>
}

export async function startTestDb(): Promise<TestDb> {
  const container = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('factelec')
    .withUsername('postgres')
    .withPassword('postgres')
    // Défaut testcontainers (10-60 s selon le wait strategy) trop juste sous
    // exécution concurrente de plusieurs fichiers e2e (chacun démarre son
    // propre conteneur) : un délai plus long ne change rien au déterminisme
    // (un conteneur réellement cassé échoue quand même, juste plus tard) mais
    // absorbe la lenteur de démarrage sous forte charge Docker.
    .withStartupTimeout(120_000)
    .start()

  const host = container.getHost()
  const port = container.getPort()
  const superUrl = container.getConnectionUri()

  // Rôles + propriété du schéma (fait par le superuser, comme le db-init dev / Terraform prod).
  const su = new pg.Pool({ connectionString: superUrl })
  await su.query(
    `CREATE ROLE factelec_owner LOGIN PASSWORD 'owner_pw' BYPASSRLS CREATEDB`,
  )
  await su.query(
    `CREATE ROLE factelec_app LOGIN PASSWORD 'app_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB`,
  )
  // AMENDEMENT B1 (revue plan 3.5, BLOCKER corrigé) : la migration 0029
  // (GRANT … TO factelec_worker) échouerait dans CHAQUE e2e si ce rôle
  // n'existe pas AVANT `migrate()` — les conteneurs de test n'appliquent PAS
  // scripts/db-init/00-roles.sql (motif exact factelec_app ci-dessus).
  await su.query(
    `CREATE ROLE factelec_worker LOGIN PASSWORD 'worker_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB`,
  )
  await su.query(`GRANT ALL ON DATABASE factelec TO factelec_owner`)
  await su.query(`ALTER SCHEMA public OWNER TO factelec_owner`)
  await su.end()

  const ownerUrl = `postgres://factelec_owner:owner_pw@${host}:${port}/factelec`
  const appUrl = `postgres://factelec_app:app_pw@${host}:${port}/factelec`
  const workerUrl = `postgres://factelec_worker:worker_pw@${host}:${port}/factelec`

  // Migrations en owner (DDL + RLS + fonction SECURITY DEFINER).
  const ownerPool = new pg.Pool({ connectionString: ownerUrl })
  await migrate(drizzle(ownerPool), { migrationsFolder: 'src/db/migrations' })
  await ownerPool.end()

  return {
    container,
    appUrl,
    workerUrl,
    ownerUrl,
    stop: async () => {
      await container.stop()
    },
  }
}
