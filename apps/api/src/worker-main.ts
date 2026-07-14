import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { WorkerModule } from './worker/worker.module.js'

// Processus worker séparé (mêmes modules NestJS, contexte applicatif sans
// HTTP). Les Workers BullMQ démarrent à onApplicationBootstrap et consomment
// tant que le process vit. enableShutdownHooks : SIGTERM/SIGINT → fermeture
// propre des files (@nestjs/bullmq) et du pool Postgres (DbModule.onModuleDestroy).
async function bootstrap(): Promise<void> {
  const ctx = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  })
  ctx.enableShutdownHooks()
}
void bootstrap()
