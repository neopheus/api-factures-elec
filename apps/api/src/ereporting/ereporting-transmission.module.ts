import { Global, Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { EnvConfig } from '../config/env.js'
import {
  FLUX10_TRANSMISSION,
  type Flux10TransmissionPort,
} from './flux10-transmission.port.js'
import { LocalFilesystemTransmissionStore } from './local-filesystem-transmission-store.js'

// Sélection du driver de transmission Flux 10 par env (D7/D11). En 2.3 seul
// 'local' est câblé ; sftp/as2/as4/api (auth transport, D3/D7) sont ACTIVÉS AU
// DÉPLOIEMENT → throw explicite tant que l'adaptateur n'est pas fourni
// (branche testée — calque ArchiveModule 2.2/T5). Base du worker (Task 8).
@Global()
@Module({
  providers: [
    {
      provide: FLUX10_TRANSMISSION,
      inject: [ConfigService],
      useFactory: (
        config: ConfigService<EnvConfig, true>,
      ): Flux10TransmissionPort => {
        const driver = config.get('EREPORTING_TRANSMISSION_DRIVER', {
          infer: true,
        })
        if (driver === 'local') {
          return new LocalFilesystemTransmissionStore(
            config.get('EREPORTING_LOCAL_DIR', { infer: true }),
          )
        }
        throw new Error(
          `e-reporting transmission driver '${driver}' activé au déploiement (non fourni en 2.3)`,
        )
      },
    },
  ],
  exports: [FLUX10_TRANSMISSION],
})
export class EreportingTransmissionModule {}
