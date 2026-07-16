import {
  ConflictException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common'
import { ProblemType, problem } from '../common/problem.js'
// biome-ignore lint/style/useImportType: CdvTransmissionRepository est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import {
  type CdvTarget,
  CdvTransmissionRepository,
} from './cdv-transmission.repository.js'
import { motifRequired } from './cdv-transmission-lifecycle.js'

export type CdvAckOutcome = 'acknowledged' | 'rejected'

// Message émis par CdvTransmissionRepository.appendStatusEvent quand le CAS
// (UPDATE ... WHERE status = 'transmitted') n'affecte aucune ligne — motif
// exact figé dans le repository (Task 4, `from` est TOUJOURS 'transmitted'
// ici, seul prédécesseur valide pour acknowledged/rejected via CETTE
// frontière, cf. ALLOWED dans cdv-transmission-lifecycle.ts).
const CAS_STALE_RE = /is not in 'transmitted' status/

// Frontière d'acquittement CDV (601 « message CDV rejeté » / acceptation
// implicite, D4/D7, plan 3.1 Task 8) — miroir EXACT
// EreportingStatusService.recordPpfStatus (2.3-T9) : la SOURCE réelle
// (push PPF / inbound réseau/Peppol) est DIFFÉRÉE au déploiement (D5). Cette
// méthode est la frontière qu'un futur adaptateur appellera ; elle est
// exercée DIRECTEMENT par les e2e ici (aucune route HTTP n'invoque
// `recordAck` dans cette tâche).
//
// `actor` désambiguïse la SOURCE de l'acquittement — TOUJOURS le
// `CdvTarget` ('ppf' | 'recipient') de la ligne acquittée (D4 :
// désambiguïsation actor/fromStatus, jamais un 601 ambigu). Un rejet LOCAL
// pré-envoi (F6 structurellement invalide) naît `rejected` par GENÈSE
// (`from=null`, `actor='platform'`, Task 6) — HORS PÉRIMÈTRE de cette
// méthode, qui ne gère QUE la transition `transmitted` → acquittement.
@Injectable()
export class CdvStatusService {
  constructor(private readonly repo: CdvTransmissionRepository) {}

  async recordAck(
    tenantId: string,
    transmissionId: string,
    outcome: CdvAckOutcome,
    actor: CdvTarget,
    motif?: string,
  ): Promise<void> {
    // motifRequired (Task 3) vérifié AVANT toute écriture : un rejet 601
    // sans motif MDT-126 est un 422 de validation — aucune transaction CAS
    // n'est même tentée (le repository porte la même garde mais lève une
    // Error générique ; on la duplique ici pour un statut HTTP précis et une
    // erreur synchrone, sans dépendre du message d'erreur du repository —
    // miroir EreportingStatusService).
    if (motifRequired(outcome) && !motif) {
      throw new UnprocessableEntityException(
        problem(422, ProblemType.validation, 'A reject motif is required', {
          errors: [
            {
              path: 'motif',
              message: `motif required for outcome '${outcome}'`,
            },
          ],
        }),
      )
    }

    try {
      // CAS atomique — statut UPDATE + INSERT journal en UNE transaction
      // (CdvTransmissionRepository.appendStatusEvent / TenantContextService
      // .run, BEGIN...COMMIT). Le prédécesseur attendu est TOUJOURS
      // 'transmitted' (seul état d'où acknowledged/rejected sont
      // atteignables via cette frontière, cf. ALLOWED dans
      // cdv-transmission-lifecycle.ts) : toute transmission dont le statut
      // COURANT diffère — déjà terminale (`acknowledged`/`rejected`, y
      // compris un rejet né localement pré-transmission), encore
      // `prepared`/`parked` (jamais transmise), id inconnu, OU id d'un
      // AUTRE tenant (invisible sous RLS FORCE) — fait échouer l'UPDATE (0
      // ligne affectée) : la transaction est intégralement annulée AVANT
      // tout INSERT dans le journal (aucun événement fantôme). Couvre en
      // particulier le late-601-après-acceptation-implicite (revue T3/T8,
      // BINDING) : `acknowledged` est TERMINAL — un 601 tardif échoue ici en
      // 409 SANS écrire d'événement `acknowledged→rejected` (arête qui
      // n'existe pas dans ALLOWED, Task 3).
      await this.repo.appendStatusEvent(
        tenantId,
        transmissionId,
        'transmitted',
        outcome,
        actor,
        motif,
      )
    } catch (err) {
      if (err instanceof Error && CAS_STALE_RE.test(err.message)) {
        throw new ConflictException(
          problem(409, ProblemType.conflict, 'CDV acknowledgement refused', {
            detail:
              'transmission is not currently transmitted (already acknowledged/rejected, never transmitted, or unknown)',
          }),
        )
      }
      throw err
    }
  }
}
