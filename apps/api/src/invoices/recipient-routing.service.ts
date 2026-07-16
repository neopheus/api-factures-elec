import type { Invoice } from '@factelec/invoice-core'
import { Injectable, Logger } from '@nestjs/common'
// biome-ignore lint/style/useImportType: AnnuaireConsultationService est résolu par Nest via design:paramtypes.
import { AnnuaireConsultationService } from '../annuaire/annuaire-consultation.service.js'
import {
  AmbiguousResolutionError,
  RecipientUnaddressableError,
} from '../annuaire/ligne-adressage.js'
import {
  BuyerIdentifierMissingError,
  buildMailleFromBuyer,
  isoDateToYmd,
} from '../annuaire/maille-from-buyer.js'
// biome-ignore lint/style/useImportType: InvoicesRepository est résolu par Nest via design:paramtypes.
import { InvoicesRepository } from './invoices.repository.js'

// Couture `resolveRecipient` à l'émission (D1/D2/D4, plan 3.3 Task 2) — LE
// trou fonctionnel PDP : à la génération d'une facture, résout son
// destinataire via l'annuaire (2.4) et persiste le résultat comme métadonnée
// de routage MUTABLE (D3), orthogonale au cycle de vie CDV scellé — résoudre
// un destinataire ≠ émettre ≠ transmettre (D2). AUCUNE mutation
// d'`invoice_status_events`, AUCUNE machine à états ici.
//
// Best-effort STRICT (D2) : `resolveAndRecord` encapsule un try/catch TOTAL
// et NE RELÈVE JAMAIS — miroir mot pour mot d'`ArchiveService.archiveInvoice`
// (archive/archive.service.ts). Une panne annuaire ne fait jamais échouer un
// job de génération déjà réussi.
//
// Sémantique d'erreur (D4) :
//   - succès -> markRoutingStatus('resolved', plateforme) ;
//   - RecipientUnaddressableError / BuyerIdentifierMissingError ->
//     markRoutingStatus('unaddressable') + warn (retriable : la ligne
//     d'annuaire peut entrer en vigueur plus tard, ou l'acheteur être
//     corrigé) ;
//   - AmbiguousResolutionError -> markRoutingStatus('ambiguous') + warn
//     (nécessite un nettoyage de l'annuaire par l'opérateur) ;
//   - erreur opérationnelle (annuaire/DB indisponible) -> logger.error,
//     routing_status laissé INCHANGÉ ('pending'), aucune écriture.
//
// AMENDEMENT M1 (plan 3.3, BINDING) : AUCUN sweep de reprise n'existe pour un
// `routing_status='pending'` opérationnel en 3.3 — contrairement aux autres
// best-effort du projet (archive, ereporting), le routage n'a PAS de
// mécanisme de reprise automatique. Un `'pending'` opérationnel persiste
// jusqu'au sweep différé (3.4+) ou un re-enfilement manuel du job de
// génération (qui re-résout, D1 idempotence). N'invente AUCUN retry/sweep ici.
@Injectable()
export class RecipientRoutingService {
  private readonly logger = new Logger(RecipientRoutingService.name)

  constructor(
    private readonly annuaire: AnnuaireConsultationService,
    private readonly repo: InvoicesRepository,
  ) {}

  async resolveAndRecord(
    tenantId: string,
    invoiceId: string,
    invoice: Invoice,
  ): Promise<void> {
    try {
      const maille = buildMailleFromBuyer(invoice.buyer)
      const dateYmd = isoDateToYmd(invoice.issueDate)
      const { plateforme } = await this.annuaire.resolveRecipient(
        tenantId,
        maille,
        dateYmd,
      )
      await this.repo.markRoutingStatus(
        tenantId,
        invoiceId,
        'resolved',
        plateforme,
      )
    } catch (err) {
      if (
        err instanceof RecipientUnaddressableError ||
        err instanceof BuyerIdentifierMissingError
      ) {
        this.logger.warn(
          `invoice ${invoiceId}: destinataire non adressable — ${(err as Error).message}`,
        )
        await this.repo
          .markRoutingStatus(tenantId, invoiceId, 'unaddressable')
          .catch((e2) =>
            this.logger.error(
              `mark routing unaddressable failed for ${invoiceId}`,
              e2 as Error,
            ),
          )
        return
      }
      if (err instanceof AmbiguousResolutionError) {
        this.logger.warn(
          `invoice ${invoiceId}: résolution de routage ambiguë — ${(err as Error).message}`,
        )
        await this.repo
          .markRoutingStatus(tenantId, invoiceId, 'ambiguous')
          .catch((e2) =>
            this.logger.error(
              `mark routing ambiguous failed for ${invoiceId}`,
              e2 as Error,
            ),
          )
        return
      }
      // Erreur OPÉRATIONNELLE (annuaire/DB indisponible) : routing_status
      // reste INCHANGÉ ('pending') — AMENDEMENT M1, aucun sweep de reprise
      // en 3.3.
      this.logger.error(
        `recipient routing failed for ${invoiceId}`,
        err as Error,
      )
    }
  }
}
