import { Global, Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { EnvConfig } from '../config/env.js'
import {
  CONSENT_SIGNATURE,
  type ConsentSignaturePort,
} from './consent-signature.port.js'
import { LocalFilesystemConsentStore } from './local-filesystem-consent-store.js'

// Sélection du driver de scellement de signature du consentement par env
// (D1/D3). En 3.5 seul 'local' est câblé (scellement STRUCTUREL : intégrité
// sha256 + horodatage + write-once WORM, AUCUNE vérification cryptographique
// ni valeur probante) ; 'eidas' (fournisseur de signature qualifiée réel,
// D1/D3) est ACTIVÉ AU DÉPLOIEMENT → throw explicite tant que l'adaptateur
// n'est pas fourni (branche testée — calque CdvTransmissionModule 3.1 /
// AnnuaireTransportModule 2.4).
@Global()
@Module({
  providers: [
    {
      provide: CONSENT_SIGNATURE,
      inject: [ConfigService],
      useFactory: (
        config: ConfigService<EnvConfig, true>,
      ): ConsentSignaturePort => {
        const driver = config.get('CONSENT_DRIVER', { infer: true })
        if (driver === 'local') {
          return new LocalFilesystemConsentStore(
            config.get('CONSENT_LOCAL_DIR', { infer: true }),
          )
        }
        throw new Error(
          `fournisseur de signature de consentement '${driver}' activé au déploiement (non fourni en 3.5)`,
        )
      },
    },
  ],
  exports: [CONSENT_SIGNATURE],
})
export class ConsentSignatureModule {}
