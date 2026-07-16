import { Module } from '@nestjs/common'
import { AnnuaireRepository } from '../annuaire/annuaire.repository.js'
import { AnnuaireConsultationService } from '../annuaire/annuaire-consultation.service.js'
import { AuthModule } from '../auth/auth.module.js'
import { TenantAuthGuard } from '../auth/tenant-auth.guard.js'
import { InvoicesRepository } from '../invoices/invoices.repository.js'
import { UsersModule } from '../users/users.module.js'
import { CdvController } from './cdv.controller.js'
import { CdvStatusService } from './cdv-status.service.js'
import { CdvTransmissionModule } from './cdv-transmission.module.js'
import { CdvTransmissionRepository } from './cdv-transmission.repository.js'
import { CdvTransmissionService } from './cdv-transmission.service.js'

// Câblage HTTP du domaine CDV (émission Task 6 + frontière d'acquittement/
// endpoints Task 8, plan 3.1) — calqué `EreportingModule`/`AnnuaireModule` :
// `AnnuaireRepository`+`AnnuaireConsultationService` (2.4) et
// `InvoicesRepository` (2.1) ne sont fournis par AUCUN autre module HTTP
// importé ici → fournis DIRECTEMENT en provider (chacun ne dépend que de
// `TenantContextService`, global via `DbModule`) plutôt que d'importer
// `AnnuaireModule`/`InvoicesModule` en entier (qui embarqueraient
// guards/contrôleurs/services étrangers au périmètre de ce module).
// `CdvTransmissionModule` (Task 5) est `@Global()` — l'importer ICI suffit à
// exposer `CDV_TRANSMISSION` à toute l'app HTTP. `TenantAuthGuard` dépend
// d'`ApiKeyService` (`AuthModule`) ET de `SessionService` (`UsersModule`) —
// les deux imports sont requis (motif `EreportingModule` 2.3-T9 :
// `AuthModule` seul ne suffit pas, `SessionService` n'y est pas exporté).
@Module({
  imports: [CdvTransmissionModule, AuthModule, UsersModule],
  controllers: [CdvController],
  providers: [
    CdvTransmissionRepository,
    CdvTransmissionService,
    CdvStatusService,
    AnnuaireRepository,
    AnnuaireConsultationService,
    InvoicesRepository,
    TenantAuthGuard,
  ],
  exports: [CdvTransmissionService, CdvStatusService],
})
export class CdvModule {}
