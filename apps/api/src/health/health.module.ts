import { Module } from '@nestjs/common'
import { QueueModule } from '../queue/queue.module.js'
import { HealthController } from './health.controller.js'

// TerminusModule retiré (Task 9, spec §6) : le healthcheck enrichi
// (db/redis/migrations, statuts booléens + latences, aucune fuite de
// détail) est désormais construit À LA MAIN dans HealthController — le
// format terminus (info/error/details) ne correspond plus au contrat public.
@Module({
  imports: [QueueModule],
  controllers: [HealthController],
})
export class HealthModule {}
