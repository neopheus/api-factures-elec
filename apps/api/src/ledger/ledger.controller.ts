import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common'
import type { Response } from 'express'
import { CurrentTenant } from '../auth/current-tenant.decorator.js'
import { TenantAuthGuard } from '../auth/tenant-auth.guard.js'
import { ProblemType, problem } from '../common/problem.js'
// biome-ignore lint/style/useImportType: résolus par Nest via design:paramtypes.
import { InvoicesRepository } from '../invoices/invoices.repository.js'
// biome-ignore lint/style/useImportType: résolus par Nest via design:paramtypes.
import { LedgerVerificationService } from './ledger-verification.service.js'
import { renderPafCsv } from './paf.js'
// biome-ignore lint/style/useImportType: résolus par Nest via design:paramtypes.
import { PafService } from './paf.service.js'

@Controller('invoices')
export class LedgerController {
  constructor(
    private readonly repo: InvoicesRepository,
    private readonly verification: LedgerVerificationService,
    // Nommé `pafService` (pas `paf`) : une propriété d'instance nommée comme
    // la méthode `paf()` ci-dessous masquerait cette dernière (les propriétés
    // d'instance masquent les méthodes de prototype de même nom en JS/TS) —
    // `controller.paf(...)` deviendrait alors « not a function ».
    private readonly pafService: PafService,
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

  // Export de la Piste d'Audit Fiable (PAF) — spec §4.5, obligation
  // d'intégrité/authenticité CGI art. 289 bis/289 E. CADRAGE HONNÊTE : aucun
  // format PAF normalisé dans les spécifications externes v3.2 (constat
  // vérifié) — conception projet, cf. paf.ts. `@Res()` court-circuite la
  // sérialisation Nest (calqué sur InvoicesController.getFormat) ; les
  // exceptions lancées AVANT res.send restent captées par
  // ProblemDetailsFilter.
  @Get(':id/paf')
  @UseGuards(TenantAuthGuard)
  async paf(
    @CurrentTenant() tenantId: string,
    @Param('id') id: string,
    @Query('format') format: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const doc = await this.pafService.buildPaf(tenantId, id)
    if (doc === null) {
      throw new NotFoundException(
        problem(404, ProblemType.notFound, 'Unknown invoice'),
      )
    }
    if (format === 'csv') {
      res.type('text/csv')
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="paf-${id}.csv"`,
      )
      res.send(renderPafCsv(doc))
      return
    }
    res.json(doc)
  }
}
