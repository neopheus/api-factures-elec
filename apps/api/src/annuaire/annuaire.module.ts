import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module.js'
import { TenantAuthGuard } from '../auth/tenant-auth.guard.js'
import { UsersModule } from '../users/users.module.js'
import { AnnuaireController } from './annuaire.controller.js'
import { AnnuaireRepository } from './annuaire.repository.js'
import { AnnuaireConsultationService } from './annuaire-consultation.service.js'
import { AnnuairePublicationService } from './annuaire-publication.service.js'
import { AnnuaireTransportModule } from './annuaire-transport.module.js'

// Calqué `EreportingModule` (Task 9, plan 2.3) : `TenantAuthGuard` dépend
// d'`ApiKeyService` (`AuthModule`) ET de `SessionService` (`UsersModule`) —
// les deux imports sont requis (`AuthModule` seul ne suffit pas,
// `SessionService` n'y est pas exporté). `AnnuaireRepository` n'est fourni
// par AUCUN autre module HTTP (jusqu'ici seulement instancié hors contexte
// Nest, Task 5) : fourni ICI en provider (`TenantContextService`, dont il
// dépend, est global via `DbModule`). `AnnuaireTransportModule` (Task 6) est
// `@Global()` — l'importer ICI suffit à exposer `ANNUAIRE_TRANSPORT` à toute
// l'app (motif `EreportingTransmissionModule`, jamais importé ailleurs avant
// Task 8) ; `AnnuairePublicationService` (Task 8) en dépend (`@Inject`).
@Module({
  imports: [AuthModule, UsersModule, AnnuaireTransportModule],
  controllers: [AnnuaireController],
  providers: [
    AnnuaireRepository,
    AnnuaireConsultationService,
    AnnuairePublicationService,
    TenantAuthGuard,
  ],
  exports: [AnnuaireConsultationService, AnnuairePublicationService],
})
export class AnnuaireModule {}
