import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common'
import type { Response } from 'express'
import { z } from 'zod'
import { CsrfGuard } from '../auth/csrf.guard.js'
import { CurrentTenant } from '../auth/current-tenant.decorator.js'
import { Roles, RolesGuard } from '../auth/roles.guard.js'
import { TenantAuthGuard } from '../auth/tenant-auth.guard.js'
import { ProblemType, problem } from '../common/problem.js'
import { isUuid } from '../common/uuid.js'
import { parseBody } from '../common/validation.js'
import type { EreportingStatusEventRow } from './ereporting.repository.js'
// biome-ignore lint/style/useImportType: EreportingRepository est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { EreportingRepository } from './ereporting.repository.js'
import {
  EREPORTING_STATUS_META,
  type EreportingStatus,
} from './ereporting-lifecycle.js'
// biome-ignore lint/style/useImportType: EreportingRetransmissionService est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { EreportingRetransmissionService } from './ereporting-retransmission.service.js'

// AAAAMMJJ (motif payments/payment.model.ts DATE_RE) — REDÉFINIE localement
// (pas d'import cross-domaine, décision contrôleur plan 3.2 Task 5) : chaque
// jour valide du calendrier, y compris les débuts de décade (01/11/21).
const PERIOD_RE = /^\d{4}(0[1-9]|1[012])(0[1-9]|[12][0-9]|3[01])$/

const retransmissionSchema = z.object({
  declarantId: z.uuid(),
  fluxKind: z.enum(['transactions', 'payments']),
  periodStart: z
    .string()
    .regex(
      PERIOD_RE,
      'periodStart must be AAAAMMJJ (8 digits, valid month/day)',
    ),
})

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
  constructor(
    private readonly repo: EreportingRepository,
    private readonly retransmission: EreportingRetransmissionService,
  ) {}

  // Endpoint OPÉRATEUR de retransmission (plan 3.4, D1/D2/D4) — déclenchement
  // MANUEL uniquement, jamais un automatisme post-301 (jugement humain après
  // correction des données source). Dual-auth (motif EXACT
  // PaymentsController.capture, 1ᵉ précédent de mutation dual-auth du
  // projet) : TenantAuthGuard (clé API OU session) + RolesGuard/CsrfGuard
  // (s'appliquent SEULEMENT à la session, bypass explicite sur apiKeyId).
  // 202 (pas 200/201) : la génération/transmission RE reste ASYNCHRONE
  // (BullMQ) — l'opérateur observe le résultat via GET /ereporting/transmissions
  // (déjà livré 2.3).
  @Post('retransmissions')
  @HttpCode(202)
  @UseGuards(TenantAuthGuard, RolesGuard, CsrfGuard)
  @Roles('owner', 'admin', 'accountant')
  async retransmit(
    @CurrentTenant() tenantId: string,
    @Body() body: unknown,
  ): Promise<{ jobId: string; transmissionRef: string }> {
    const input = parseBody(retransmissionSchema, body)
    return this.retransmission.retransmit(tenantId, input)
  }

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
    if (!isUuid(id)) throw this.notFound()
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
    if (!isUuid(id)) throw this.notFound()
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
    return ereportingNotFound()
  }
}

// Fabrique 404 PARTAGÉE (plan 3.4, Task 2) : le service de retransmission
// (ereporting-retransmission.service.ts, garde D4 « déclarant inconnu ») la
// réutilise TELLE QUELLE pour un corps byte-identique — anti-fuite
// d'existence de déclarant, un seul body 404 pour TOUT le contrôleur
// ereporting (nit revue du plan : la précision du wording cède devant
// l'anti-fuite).
export function ereportingNotFound(): NotFoundException {
  return new NotFoundException(
    problem(404, ProblemType.notFound, 'Unknown transmission'),
  )
}
