import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Res,
  UseGuards,
} from '@nestjs/common'
import type { Response } from 'express'
import { CurrentTenant } from '../auth/current-tenant.decorator.js'
import { TenantAuthGuard } from '../auth/tenant-auth.guard.js'
import { ProblemType, problem } from '../common/problem.js'
import type { EreportingStatusEventRow } from './ereporting.repository.js'
// biome-ignore lint/style/useImportType: EreportingRepository est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { EreportingRepository } from './ereporting.repository.js'
import {
  EREPORTING_STATUS_META,
  type EreportingStatus,
} from './ereporting-lifecycle.js'

type RejectOrigin = 'local' | 'ppf' | null

// Désambiguïsation rejet LOCAL vs PPF-301 (injection revue T8, plan 2.3 Task
// 9) : `rejetee` est TERMINAL (Task 4, ALLOWED.rejetee = []) — au plus UN
// événement du journal porte `toStatus='rejetee'`. Sa nature détermine
// l'origine sans ambiguïté : événement de GENÈSE (fromStatus=null,
// actor='platform', rejet sémantique local pré-transmission REJ_SEMAN, Task
// 8) → 'local' ; transition depuis 'transmitted' (actor='ppf', acquittement
// 301 réel, Task 9) → 'ppf'.
export function deriveRejectOrigin(
  events: Pick<EreportingStatusEventRow, 'fromStatus' | 'toStatus'>[],
): RejectOrigin {
  const rejection = events.find((e) => e.toStatus === 'rejetee')
  if (!rejection) return null
  return rejection.fromStatus === null ? 'local' : 'ppf'
}

// Vue de statut anti-fuite (injection revue T4 #3, plan 2.3 Task 9) : le
// `code` DGFiP (300/301, EREPORTING_STATUS_META) n'est exposé QUE quand il
// existe réellement — `null` pour les états internes PA (`prepared`/
// `transmitted`), jamais un code inventé qui laisserait croire à un code
// réglementaire Tableau 5/6.
function statusView(status: EreportingStatus) {
  const meta = EREPORTING_STATUS_META[status]
  return { statusLabel: meta.label, dgfipCode: meta.code }
}

// Consultation e-reporting (Task 9, plan 2.3) — dual-auth (TenantAuthGuard :
// clé API OU session, jamais admin), 404 anti-fuite byte-identique pour un id
// inconnu ou d'un autre tenant (motif LedgerController), liste SANS le XML
// (colonne lourde).
@Controller('ereporting')
export class EreportingController {
  constructor(private readonly repo: EreportingRepository) {}

  @Get('transmissions')
  @UseGuards(TenantAuthGuard)
  async list(@CurrentTenant() tenantId: string) {
    const rows = await this.repo.listTransmissions(tenantId)
    const transmissions = await Promise.all(
      rows.map(async (row) => {
        let rejectOrigin: RejectOrigin = null
        if (row.status === 'rejetee') {
          const events = await this.repo.listStatusEvents(tenantId, row.id)
          rejectOrigin = deriveRejectOrigin(events)
        }
        return {
          id: row.id,
          declarantId: row.declarantId,
          transmissionRef: row.transmissionRef,
          type: row.type,
          fluxKind: row.fluxKind,
          periodStart: row.periodStart,
          periodEnd: row.periodEnd,
          status: row.status,
          ...statusView(row.status),
          invoiceCount: row.invoiceCount,
          trackingId: row.trackingId,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          rejectOrigin,
        }
      }),
    )
    return { transmissions }
  }

  // @Res() court-circuite la sérialisation Nest (motif InvoicesController
  // .getFormat/LedgerController.paf) ; les exceptions lancées AVANT res.send
  // restent captées par ProblemDetailsFilter.
  @Get('transmissions/:id/xml')
  @UseGuards(TenantAuthGuard)
  async xml(
    @CurrentTenant() tenantId: string,
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    const status = await this.repo.findTransmissionStatus(tenantId, id)
    if (status === null) throw this.notFound()
    const xml = await this.repo.loadTransmissionXml(tenantId, id)
    if (xml === null) throw this.notFound()
    res.type('text/xml')
    res.send(xml)
  }

  @Get('transmissions/:id/events')
  @UseGuards(TenantAuthGuard)
  async events(@CurrentTenant() tenantId: string, @Param('id') id: string) {
    const status = await this.repo.findTransmissionStatus(tenantId, id)
    if (status === null) throw this.notFound()
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
