import { Global, Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { EnvConfig } from '../config/env.js'
import {
  CDV_TRANSMISSION,
  type CdvTransmissionPort,
} from './cdv-transmission.port.js'
import { LocalFilesystemCdvStore } from './local-filesystem-cdv-store.js'

// Sélection du driver de transmission CDV par env (D1/D7). En 3.1 seul
// 'local' est câblé ; sftp/as2/as4/as4-peppol/api (auth transport X.509 /
// AS4-Peppol / OAuth2, D1/D7) sont ACTIVÉS AU DÉPLOIEMENT → throw explicite
// tant que l'adaptateur n'est pas fourni (branche testée — calque
// EreportingTransmissionModule 2.3 / AnnuaireTransportModule 2.4). Base du
// service de transmission (Task 6).
@Global()
@Module({
  providers: [
    {
      provide: CDV_TRANSMISSION,
      inject: [ConfigService],
      useFactory: (
        config: ConfigService<EnvConfig, true>,
      ): CdvTransmissionPort => {
        const driver = config.get('CDV_TRANSMISSION_DRIVER', { infer: true })
        if (driver === 'local') {
          return new LocalFilesystemCdvStore(
            config.get('CDV_LOCAL_DIR', { infer: true }),
          )
        }
        throw new Error(
          `driver de transmission CDV '${driver}' activé au déploiement (non fourni en 3.1)`,
        )
      },
    },
  ],
  exports: [CDV_TRANSMISSION],
})
export class CdvTransmissionModule {}
