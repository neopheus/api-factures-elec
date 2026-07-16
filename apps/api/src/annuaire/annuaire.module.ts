import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module.js'
import { TenantAuthGuard } from '../auth/tenant-auth.guard.js'
import { UsersModule } from '../users/users.module.js'
import { AnnuaireController } from './annuaire.controller.js'
import { AnnuaireRepository } from './annuaire.repository.js'
import { AnnuaireConsultationService } from './annuaire-consultation.service.js'

// Calqué `EreportingModule` (Task 9, plan 2.3) : `TenantAuthGuard` dépend
// d'`ApiKeyService` (`AuthModule`) ET de `SessionService` (`UsersModule`) —
// les deux imports sont requis (`AuthModule` seul ne suffit pas,
// `SessionService` n'y est pas exporté). `AnnuaireRepository` n'est fourni
// par AUCUN autre module HTTP (jusqu'ici seulement instancié hors contexte
// Nest, Task 5) : fourni ICI en provider (`TenantContextService`, dont il
// dépend, est global via `DbModule`).
@Module({
  imports: [AuthModule, UsersModule],
  controllers: [AnnuaireController],
  providers: [AnnuaireRepository, AnnuaireConsultationService, TenantAuthGuard],
  exports: [AnnuaireConsultationService],
})
export class AnnuaireModule {}
