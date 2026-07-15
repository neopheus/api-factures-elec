import { Global, Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { EnvConfig } from '../config/env.js'
import { ARCHIVE_STORE, type ArchiveStore } from './archive-store.port.js'
import { LocalFilesystemArchiveStore } from './local-filesystem-archive-store.js'

// Sélection du driver d'archivage par env (D5). En 2.2 seul 'local' est câblé ;
// 's3' (object-lock Scaleway) est ACTIVÉ AU DÉPLOIEMENT → throw explicite tant
// que l'adaptateur n'est pas fourni (branche testée, une ligne).
@Global()
@Module({
  providers: [
    {
      provide: ARCHIVE_STORE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvConfig, true>): ArchiveStore => {
        const driver = config.get('ARCHIVE_DRIVER', { infer: true })
        if (driver === 's3') {
          throw new Error(
            "ARCHIVE_DRIVER='s3' : adaptateur S3 object-lock activé au déploiement (non fourni en 2.2)",
          )
        }
        return new LocalFilesystemArchiveStore(
          config.get('ARCHIVE_LOCAL_DIR', { infer: true }),
        )
      },
    },
  ],
  exports: [ARCHIVE_STORE],
})
export class ArchiveModule {}
