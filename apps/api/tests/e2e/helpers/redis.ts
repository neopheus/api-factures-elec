import {
  RedisContainer,
  type StartedRedisContainer,
} from '@testcontainers/redis'

export interface TestRedis {
  container: StartedRedisContainer
  host: string
  port: number
  stop(): Promise<void>
}

export async function startTestRedis(): Promise<TestRedis> {
  // Timeout aligné sur Postgres (helpers/postgres.ts) : absorbe la lenteur de
  // démarrage sous forte charge Docker concurrente (maxWorkers 5).
  const container = await new RedisContainer('redis:7-alpine')
    .withStartupTimeout(120_000)
    .start()
  return {
    container,
    host: container.getHost(),
    port: container.getFirstMappedPort(),
    stop: () => container.stop().then(() => undefined),
  }
}
