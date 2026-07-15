import {
  Controller,
  Get,
  NotFoundException,
  Param,
  UseGuards,
} from '@nestjs/common'
import { CurrentTenant } from '../auth/current-tenant.decorator.js'
import { TenantAuthGuard } from '../auth/tenant-auth.guard.js'
import { ProblemType, problem } from '../common/problem.js'
// biome-ignore lint/style/useImportType: résolus par Nest via design:paramtypes.
import { InvoicesRepository } from '../invoices/invoices.repository.js'
// biome-ignore lint/style/useImportType: résolus par Nest via design:paramtypes.
import { LedgerVerificationService } from './ledger-verification.service.js'

@Controller('invoices')
export class LedgerController {
  constructor(
    private readonly repo: InvoicesRepository,
    private readonly verification: LedgerVerificationService,
  ) {}

  @Get(':id/ledger')
  @UseGuards(TenantAuthGuard)
  async ledger(@CurrentTenant() tenantId: string, @Param('id') id: string) {
    // 404 anti-fuite si la facture n'existe pas dans ce tenant (RLS).
    const status = await this.repo.getLifecycleStatus(tenantId, id)
    if (status === null) {
      throw new NotFoundException(
        problem(404, ProblemType.notFound, 'Unknown invoice'),
      )
    }
    const events = await this.repo.loadSealedEventsByInvoice(tenantId, id)
    // Deux vérifications complémentaires, exposées côte à côte (amendement
    // A-IMPORTANT, revue du plan) : `integrity` (self-check par-facture) ne
    // détecte PAS une suppression de maillon — chaque événement restant
    // s'auto-vérifie contre son propre prev_hash stocké, intact. Seule
    // `chainIntegrity` (contiguïté de la chaîne COMPLÈTE du tenant) révèle
    // une telle suppression owner-side.
    const [integrity, chainIntegrity] = await Promise.all([
      this.verification.verifyInvoiceEvents(tenantId, id),
      this.verification.verifyTenantChain(tenantId),
    ])
    return {
      invoiceId: id,
      // Identité probative = (tenant_id, seq) : `id` (PK surrogate) reste
      // HORS périmètre — jamais sérialisé ici.
      events: events.map((e) => ({
        seq: e.seq,
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        actor: e.actor,
        reason: e.reason,
        createdAt: e.createdAt.toISOString(),
        prevHash: e.prevHash.toString('hex'),
        hash: e.hash.toString('hex'),
      })),
      integrity,
      chainIntegrity,
    }
  }
}
