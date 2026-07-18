import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module.js'
import { RolesGuard } from '../auth/roles.guard.js'
import { TenantAuthGuard } from '../auth/tenant-auth.guard.js'
import { UsersModule } from '../users/users.module.js'
import { AnnuaireController } from './annuaire.controller.js'
import { AnnuaireRepository } from './annuaire.repository.js'
import { AnnuaireConsultationService } from './annuaire-consultation.service.js'
import { AnnuairePublicationService } from './annuaire-publication.service.js'
import { AnnuaireTransportModule } from './annuaire-transport.module.js'
import { ConsentSignatureModule } from './consent-signature.module.js'

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
// `ConsentSignatureModule` (Task 1, plan 3.5) est également `@Global()`,
// même motif : l'importer ICI expose `CONSENT_SIGNATURE` à toute l'app,
// requis par `AnnuairePublicationService` (Task 2, 3.5) pour le scellement
// de la preuve de consentement à la création (branche `proof`, D3).
// `RolesGuard` (Task 4bis, correctif faille 2.4) ne dépend que de
// `Reflector` (built-in Nest) — fourni en provider local (motif
// `PaymentsModule`/`InvoicesModule`/`EreportingModule`). `CsrfGuard` N'EST
// PAS re-déclaré ici : `UsersModule` (déjà importé) l'exporte déjà.
@Module({
  imports: [
    AuthModule,
    UsersModule,
    AnnuaireTransportModule,
    ConsentSignatureModule,
  ],
  controllers: [AnnuaireController],
  providers: [
    AnnuaireRepository,
    AnnuaireConsultationService,
    AnnuairePublicationService,
    TenantAuthGuard,
    RolesGuard,
  ],
  exports: [AnnuaireConsultationService, AnnuairePublicationService],
})
export class AnnuaireModule {}
