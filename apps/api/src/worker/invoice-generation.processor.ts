import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject, Logger } from '@nestjs/common'
import type { Job } from 'bullmq'
// biome-ignore lint/style/useImportType: ArchiveService résolu par Nest via design:paramtypes.
import { ArchiveService } from '../archive/archive.service.js'
import {
  INVOICE_FORMAT_GENERATOR,
  type InvoiceFormatGenerator,
} from '../invoices/format-generator.port.js'
// biome-ignore lint/style/useImportType: InvoicesRepository résolu par Nest via design:paramtypes.
import { InvoicesRepository } from '../invoices/invoices.repository.js'
import type { InvoiceGenerationJob } from '../queue/invoice-generation.job.js'
import { INVOICE_GENERATION_QUEUE } from '../queue/queue.constants.js'

@Processor(INVOICE_GENERATION_QUEUE)
export class InvoiceGenerationProcessor extends WorkerHost {
  private readonly logger = new Logger(InvoiceGenerationProcessor.name)

  constructor(
    private readonly repo: InvoicesRepository,
    @Inject(INVOICE_FORMAT_GENERATOR)
    private readonly generator: InvoiceFormatGenerator,
    private readonly archive: ArchiveService,
  ) {
    super()
  }

  async process(job: Job<InvoiceGenerationJob>): Promise<void> {
    const { tenantId, invoiceId } = job.data
    const invoice = await this.repo.loadCanonical(tenantId, invoiceId)
    if (!invoice) {
      // Facture supprimée entre l'enfilement et le traitement : no-op idempotent.
      this.logger.warn(`invoice ${invoiceId} vanished before generation`)
      return
    }
    await this.repo.markGenerationStatus(tenantId, invoiceId, 'generating')
    const formats = await this.generator.generate(invoice)
    // Amendement A1 (décision contrôleur) : delete+insert des formats ET
    // passage à `generated` en UNE SEULE transaction tenant
    // (repo.completeGeneration), au lieu de deux appels séparés
    // (saveFormats puis markGenerationStatus). Un crash entre les deux
    // anciennes étapes laissait une fenêtre observable où les formats
    // existaient déjà mais le statut restait `generating`. Le
    // `markGenerationStatus('generating')` ci-dessus reste, lui, une
    // transaction séparée : simple marqueur de pré-travail — un crash avant
    // qu'il ne s'exécute laisse la facture en `received` (ou `generating` s'il
    // a eu le temps de s'exécuter), et un retry rejoue le même travail dans
    // les deux cas, sans conséquence observable.
    await this.repo.completeGeneration(tenantId, invoiceId, formats)
    // Archivage à valeur probante (best-effort, découplé de la génération, D6) :
    // les formats sont déjà `generated` et servis ; un échec d'archive laisse
    // archive_status='failed', ré-essayé par la réconciliation (Task 8).
    await this.archive.archiveInvoice(tenantId, invoiceId)
  }

  // `failed` est émis à CHAQUE tentative échouée ; on ne bascule en `failed`
  // définitif qu'après épuisement des tentatives (sinon un retry en cours
  // repositionnerait un statut erroné pendant qu'il retente).
  @OnWorkerEvent('failed')
  async onFailed(job: Job<InvoiceGenerationJob>): Promise<void> {
    const maxAttempts = job.opts.attempts ?? 1
    if (job.attemptsMade < maxAttempts) return
    const { tenantId, invoiceId } = job.data
    await this.repo
      .markGenerationStatus(tenantId, invoiceId, 'failed')
      .catch((e) => this.logger.error(`failed to mark ${invoiceId} failed`, e))
  }
}
