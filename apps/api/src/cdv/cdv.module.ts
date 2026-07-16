import { Module } from '@nestjs/common'
import { AnnuaireRepository } from '../annuaire/annuaire.repository.js'
import { AnnuaireConsultationService } from '../annuaire/annuaire-consultation.service.js'
import { InvoicesRepository } from '../invoices/invoices.repository.js'
import { CdvTransmissionModule } from './cdv-transmission.module.js'
import { CdvTransmissionRepository } from './cdv-transmission.repository.js'
import { CdvTransmissionService } from './cdv-transmission.service.js'

// Câblage HTTP du domaine d'ÉMISSION CDV (Task 6, plan 3.1) — calqué
// `EreportingModule`/`AnnuaireModule` : `AnnuaireRepository`+
// `AnnuaireConsultationService` (2.4) et `InvoicesRepository` (2.1) ne sont
// fournis par AUCUN autre module HTTP importé ici → fournis DIRECTEMENT en
// provider (chacun ne dépend que de `TenantContextService`, global via
// `DbModule`) plutôt que d'importer `AnnuaireModule`/`InvoicesModule` en
// entier (qui embarqueraient guards/controllers/services étrangers au
// périmètre de ce module). `CdvTransmissionModule` (Task 5) est `@Global()`
// — l'importer ICI suffit à exposer `CDV_TRANSMISSION` à toute l'app HTTP
// (motif `AnnuaireTransportModule`/`EreportingTransmissionModule`, jamais
// importés ailleurs avant leur propre tâche consommatrice). Aucun contrôleur
// ici (Task 8 en ajoutera un, avec ses propres imports Auth/Users) : Task 6
// n'expose aucun endpoint.
@Module({
  imports: [CdvTransmissionModule],
  providers: [
    CdvTransmissionRepository,
    CdvTransmissionService,
    AnnuaireRepository,
    AnnuaireConsultationService,
    InvoicesRepository,
  ],
  exports: [CdvTransmissionService],
})
export class CdvModule {}
