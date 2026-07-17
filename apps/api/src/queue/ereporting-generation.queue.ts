import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import type { Queue } from 'bullmq'
import type { FluxKind } from '../ereporting/ereporting.repository.js'
import type { IssuerRole } from '../ereporting/nomenclature.js'
import {
  EREPORTING_GENERATE_JOB,
  type EreportingGenerationJob,
} from './ereporting-generation.job.js'
import { EREPORTING_GENERATION_QUEUE } from './queue.constants.js'

export interface RetransmissionEnqueueInput {
  tenantId: string
  declarantId: string
  siren: string
  role: IssuerRole
  fluxKind: FluxKind
  periodStart: string
  periodEnd: string
  reSeq: number
}

// Port d'enfilement du rectificatif RE (plan 3.4, D2/D3 — miroir
// InvoiceGenerationQueue, producteur HTTP). Idempotence/anti-double-clic :
// jobId DÉTERMINISTE construit ICI, séparateur `-` UNIQUEMENT (AMENDEMENT
// NIT-2, revue T1, BINDING — 5 segments `:` font LEVER bullmq 5.80.7,
// « Custom Id cannot contain : » hors exactement 3 segments ; NE PAS
// recopier la forme `:` du sweep IN, legacy pré-existant hors périmètre).
// BullMQ déduplique les ré-enfilements de même jobId tant que le job existe
// (couche 2 de la défense en profondeur D3) : deux appels concurrents lisant
// le même `reSeq` (couche 1, EreportingRetransmissionService) collapsent
// donc en un seul job.
@Injectable()
export class EreportingGenerationQueue {
  constructor(
    @InjectQueue(EREPORTING_GENERATION_QUEUE)
    private readonly queue: Queue<EreportingGenerationJob>,
  ) {}

  async enqueueRetransmission(
    input: RetransmissionEnqueueInput,
  ): Promise<string> {
    const jobId = `${input.declarantId}-${input.fluxKind}-${input.periodStart}-RE-${input.reSeq}`
    await this.queue.add(
      EREPORTING_GENERATE_JOB,
      {
        tenantId: input.tenantId,
        declarantId: input.declarantId,
        siren: input.siren,
        role: input.role,
        fluxKind: input.fluxKind,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        type: 'RE',
        reSeq: input.reSeq,
      },
      { jobId },
    )
    return jobId
  }
}
