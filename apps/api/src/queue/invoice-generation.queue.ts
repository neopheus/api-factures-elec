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

  // État courant (BullMQ) du job d'une facture, s'il existe encore. `undefined`
  // = aucun job (orphelin, ou déjà purgé). Utilisé par la réconciliation pour
  // décider s'il faut évincer un job `failed` résiduel avant de ré-enfiler
  // (cf. InvoiceReconciliationService), ou au contraire ne RIEN faire si un
  // job vivant (waiting/active/delayed/...) existe déjà (dédup voulu).
  async getJobState(invoiceId: string): Promise<string | undefined> {
    const job = await this.queue.getJob(invoiceId)
    if (!job) return undefined
    return job.getState()
  }

  // Évince un job résiduel (typiquement `failed`, conservé par
  // `removeOnFail`) qui bloquerait sinon le dédup `jobId = invoiceId` d'un
  // ré-enfilement légitime.
  async removeJob(invoiceId: string): Promise<void> {
    await this.queue.remove(invoiceId)
  }
}
