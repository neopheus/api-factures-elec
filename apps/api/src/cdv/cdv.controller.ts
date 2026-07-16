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
import { z } from 'zod'
import { CurrentTenant } from '../auth/current-tenant.decorator.js'
import { TenantAuthGuard } from '../auth/tenant-auth.guard.js'
import { ProblemType, problem } from '../common/problem.js'
import { isUuid } from '../common/uuid.js'
import { parseQuery } from '../common/validation.js'
// biome-ignore lint/style/useImportType: CdvTransmissionRepository est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { CdvTransmissionRepository } from './cdv-transmission.repository.js'
import {
  CDV_TRANSMISSION_STATUS_META,
  type CdvTransmissionStatus,
} from './cdv-transmission-lifecycle.js'

const listQuerySchema = z.object({ invoiceId: z.uuid() })

// Vue de statut anti-fuite (miroir EreportingController.statusView,
// 2.3-T9 — même discipline D4/D8) : le code DGFiP (601, SEUL code F6 réel)
// n'est exposé QUE quand il existe réellement — `null` pour les états
// INTERNES de livraison (`prepared`/`transmitted`/`parked`/`acknowledged`),
// jamais un code inventé qui laisserait croire à un code réglementaire.
function statusView(status: CdvTransmissionStatus) {
  const meta = CDV_TRANSMISSION_STATUS_META[status]
  return { statusLabel: meta.label, dgfipCode: meta.code }
}

// Consultation des transmissions CDV (Task 8, plan 3.1) — dual-auth
// (`TenantAuthGuard` : clé API OU session, jamais admin — motif
// `EreportingController` 2.3-T9), 404 anti-fuite BYTE-IDENTIQUE pour un id
// inconnu ou d'un AUTRE tenant (RLS `FORCE`, indiscernables), liste SANS le
// XML (colonne lourde — motif `EreportingController`), événements exposant
// `actor`+`fromStatus` (désambiguïsation rejet LOCAL/genèse vs 601
// PPF/réseau, D4). La frontière d'acquittement elle-même
// (`CdvStatusService.recordAck`) N'A AUCUNE route HTTP dans cette tâche
// (D5 — la source réelle push PPF/réseau est différée au déploiement,
// exercée directement par les e2e).
@Controller('cdv')
export class CdvController {
  constructor(private readonly repo: CdvTransmissionRepository) {}

  @Get('transmissions')
  @UseGuards(TenantAuthGuard)
  async list(@CurrentTenant() tenantId: string, @Query() query: unknown) {
    const { invoiceId } = parseQuery(listQuerySchema, query)
    const rows = await this.repo.listTransmissions(tenantId, invoiceId)
    return {
      transmissions: rows.map((row) => ({
        id: row.id,
        invoiceId: row.invoiceId,
        toStatus: row.toStatus,
        target: row.target,
        status: row.status,
        ...statusView(row.status),
        recipientMatricule: row.recipientMatricule,
        trackingRef: row.trackingRef,
        rejectReason: row.rejectReason,
        statusHorodate: row.statusHorodate,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
    }
  }

  // @Res() court-circuite la sérialisation Nest (motif EreportingController
  // .xml/InvoicesController.getFormat) ; les exceptions lancées AVANT
  // res.send restent captées par ProblemDetailsFilter.
  @Get('transmissions/:id/xml')
  @UseGuards(TenantAuthGuard)
  async xml(
    @CurrentTenant() tenantId: string,
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    if (!isUuid(id)) throw this.notFound()
    const row = await this.repo.findTransmission(tenantId, id)
    // `xml === null` (ex. `parked`, résolution annuaire jamais aboutie —
    // Task 6) traité comme absent : rien à servir, même 404 QUE pour un id
    // inconnu/hors-tenant (byte-identique — `notFound()` ne varie jamais).
    if (row === null || row.xml === null) throw this.notFound()
    res.type('text/xml')
    res.send(row.xml)
  }

  @Get('transmissions/:id/events')
  @UseGuards(TenantAuthGuard)
  async events(@CurrentTenant() tenantId: string, @Param('id') id: string) {
    if (!isUuid(id)) throw this.notFound()
    const row = await this.repo.findTransmission(tenantId, id)
    if (row === null) throw this.notFound()
    const events = await this.repo.listStatusEvents(tenantId, id)
    return {
      events: events.map((e) => ({
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        motif: e.motif,
        actor: e.actor,
        createdAt: e.createdAt.toISOString(),
      })),
    }
  }

  private notFound(): NotFoundException {
    return new NotFoundException(
      problem(404, ProblemType.notFound, 'Unknown transmission'),
    )
  }
}
