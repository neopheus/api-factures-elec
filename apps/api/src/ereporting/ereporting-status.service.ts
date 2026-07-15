import {
  ConflictException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common'
import { ProblemType, problem } from '../common/problem.js'
// biome-ignore lint/style/useImportType: EreportingRepository est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { EreportingRepository } from './ereporting.repository.js'
import { motifRequired } from './ereporting-lifecycle.js'
import type { RejectMotif } from './nomenclature.js'

export type PpfOutcome = 'deposee' | 'rejetee'

// Message émis par EreportingRepository.appendStatusEvent quand le CAS
// (UPDATE ... WHERE status = 'transmitted') n'affecte aucune ligne — motif
// exact figé dans le repository (Task 5/9, `from` est TOUJOURS 'transmitted'
// ici, seul prédécesseur valide pour 300/301).
const CAS_STALE_RE = /is not in 'transmitted' status/

// Acquittement PPF (300 Déposée / 301 Rejetée, spec §3.7.10, Tableaux 5/6) —
// frontière D7 (plan 2.3, Task 9) : la SOURCE réelle de l'acquittement (push
// PPF / adaptateur webhook/annuaire) est DIFFÉRÉE au déploiement. Cette
// méthode est la frontière qu'un futur adaptateur appellera ; elle est
// exercée DIRECTEMENT par les e2e ici (aucune route HTTP n'invoque
// `recordPpfStatus` dans cette tâche — cf. brief Task 9).
@Injectable()
export class EreportingStatusService {
  constructor(private readonly repo: EreportingRepository) {}

  async recordPpfStatus(
    tenantId: string,
    transmissionId: string,
    outcome: PpfOutcome,
    motif?: RejectMotif,
  ): Promise<void> {
    // motifRequired (Task 4) vérifié AVANT toute écriture : un 301 sans motif
    // REJ_* est un 422 de validation — aucune transaction CAS n'est même
    // tentée (le repository porte la même garde, mais lève une Error
    // générique ; on la duplique ici pour un statut HTTP précis et une
    // erreur synchrone, sans dépendre du message d'erreur du repository).
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
      // (EreportingRepository.appendStatusEvent / TenantContextService.run,
      // BEGIN...COMMIT). Le prédécesseur attendu est TOUJOURS 'transmitted'
      // (seul état d'où 300/301 sont atteignables, cf. ALLOWED dans
      // ereporting-lifecycle.ts) : toute transmission dont le statut COURANT
      // diffère — déjà terminale (`deposee`/`rejetee`, y compris née
      // `rejetee` localement via REJ_SEMAN pré-transmission, injection revue
      // T8 #3), encore `prepared` (jamais transmise), id inconnu, OU id d'un
      // AUTRE tenant (invisible sous RLS FORCE) — fait échouer l'UPDATE (0
      // ligne affectée) : la transaction est intégralement annulée AVANT
      // tout INSERT dans le journal (aucun événement fantôme, injection
      // revue T8 #4).
      await this.repo.appendStatusEvent(
        tenantId,
        transmissionId,
        'transmitted',
        outcome,
        'ppf',
        motif,
      )
    } catch (err) {
      if (err instanceof Error && CAS_STALE_RE.test(err.message)) {
        throw new ConflictException(
          problem(409, ProblemType.conflict, 'PPF acknowledgement refused', {
            detail:
              'transmission is not currently transmitted (already acknowledged, never transmitted, or unknown)',
          }),
        )
      }
      throw err
    }
  }
}
