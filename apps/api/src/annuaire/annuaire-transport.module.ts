import { Global, Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { EnvConfig } from '../config/env.js'
import { ANNUAIRE_TRANSPORT, type AnnuairePort } from './annuaire.port.js'
import { LocalFilesystemAnnuaireStore } from './local-filesystem-annuaire-store.js'

// Sélection du driver de transport annuaire par env (D1/D7). En 2.4 seul
// 'local' est câblé ; api/edi (auth transport PISTE-OAuth2 / SFTP-AS2-AS4,
// D1/D7) sont ACTIVÉS AU DÉPLOIEMENT → throw explicite tant que l'adaptateur
// n'est pas fourni (branche testée — calque EreportingTransmissionModule,
// 2.3/Task 6). Base du service de consultation/publication (Tasks 7-9).
@Global()
@Module({
  providers: [
    {
      provide: ANNUAIRE_TRANSPORT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvConfig, true>): AnnuairePort => {
        const driver = config.get('ANNUAIRE_DRIVER', { infer: true })
        if (driver === 'local') {
          return new LocalFilesystemAnnuaireStore(
            config.get('ANNUAIRE_LOCAL_DIR', { infer: true }),
          )
        }
        throw new Error(
          `driver annuaire '${driver}' activé au déploiement (non fourni en 2.4)`,
        )
      },
    },
  ],
  exports: [ANNUAIRE_TRANSPORT],
})
export class AnnuaireTransportModule {}
