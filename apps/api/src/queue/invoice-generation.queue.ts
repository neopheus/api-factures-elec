import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import type { Queue } from 'bullmq'
import {
  GENERATE_JOB,
  type InvoiceGenerationJob,
} from './invoice-generation.job.js'
import { INVOICE_GENERATION_QUEUE } from './queue.constants.js'

// Port d'enfilement (producteur). Idempotence : jobId = invoiceId → BullMQ
// déduplique les ré-enfilements (at-least-once) tant que le job existe.
@Injectable()
export class InvoiceGenerationQueue {
  constructor(
    @InjectQueue(INVOICE_GENERATION_QUEUE)
    private readonly queue: Queue<InvoiceGenerationJob>,
  ) {}

  async enqueue(tenantId: string, invoiceId: string): Promise<void> {
    await this.queue.add(
      GENERATE_JOB,
      { tenantId, invoiceId },
      { jobId: invoiceId },
    )
  }
}
