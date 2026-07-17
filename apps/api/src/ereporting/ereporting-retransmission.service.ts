import { ConflictException, Injectable } from '@nestjs/common'
import { ProblemType, problem } from '../common/problem.js'
// biome-ignore lint/style/useImportType: EreportingGenerationQueue résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { EreportingGenerationQueue } from '../queue/ereporting-generation.queue.js'
import { ereportingNotFound } from './ereporting.controller.js'
// biome-ignore lint/style/useImportType: EreportingRepository résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { EreportingRepository, type FluxKind } from './ereporting.repository.js'
import { buildTransmissionRef } from './ereporting-generation.service.js'

export interface RetransmissionInput {
  declarantId: string
  fluxKind: FluxKind
  periodStart: string
}

export interface RetransmissionResult {
  jobId: string
  transmissionRef: string
}

// 409 anti-fabrication (D4 + AMENDEMENT M-D4-1, BINDING) : AUCUN IN existant
// OU un IN encore en statut 'prepared' (reprise backstop du sweep EN COURS —
// admettre un RE ici créerait un aléa d'ordre RE-avant-IN au PPF) partagent
// le MÊME corps 409 — le client ne distingue PAS les deux cas (documentation
// honnête côté runbook, pas de fuite d'état interne superflue).
function noRectifiableInitialTransmission(): ConflictException {
  return new ConflictException(
    problem(
      409,
      ProblemType.conflict,
      'No rectifiable initial transmission for this period',
    ),
  )
}

// Déclenchement OPÉRATEUR du chemin RE (plan 3.4, D1, D4) : AUCUN
// automatisme post-301 — jugement humain requis, les données source ont été
// corrigées AVANT cet appel. Interprétation FLAGGÉE go-live (amendement
// M-D4-1) : un RE sur un IN né-`rejetee` LOCAL (REJ_SEMAN, jamais transmis
// au PPF) est PERMIS ici (débloque le deadlock 2.3, cf. runbook Task 5) mais
// reste une interprétation à valider en pilote PPF — le code ne distingue
// PAS 301-PPF vs born-rejetee, seul `status !== 'prepared'` conditionne
// l'admission (le statut `rejetee` lui-même n'est PAS un statut bloquant).
@Injectable()
export class EreportingRetransmissionService {
  constructor(
    private readonly repo: EreportingRepository,
    private readonly queue: EreportingGenerationQueue,
  ) {}

  async retransmit(
    tenantId: string,
    input: RetransmissionInput,
  ): Promise<RetransmissionResult> {
    const declarant = await this.repo.findDeclarant(tenantId, input.declarantId)
    if (!declarant) throw ereportingNotFound()
    // `active` n'est PAS vérifié (D4, décision tranchée) : rectifier des
    // données PASSÉES d'un déclarant devenu inactif depuis reste légitime —
    // l'erreur portait sur des données transmises quand il était actif.

    const initial = await this.repo.findInitialTransmission(
      tenantId,
      input.declarantId,
      input.fluxKind,
      input.periodStart,
    )
    if (!initial || initial.status === 'prepared') {
      throw noRectifiableInitialTransmission()
    }

    // Couche 1 de la défense D3 (anti-double-clic) : nombre de RE déjà
    // committés, lu à l'enfilement — deux déclenchements concurrents lisent
    // le MÊME compte → même reSeq → collapse voulu (couche 2, jobId
    // déterministe, appliquée par la queue).
    const reSeq = await this.repo.countRetransmissions(
      tenantId,
      input.declarantId,
      input.fluxKind,
      input.periodStart,
    )

    const jobId = await this.queue.enqueueRetransmission({
      tenantId,
      declarantId: input.declarantId,
      siren: declarant.siren,
      role: declarant.role,
      fluxKind: input.fluxKind,
      // periodEnd REPRIS DE L'IN — jamais fait confiance au client (D4).
      periodEnd: initial.periodEnd,
      periodStart: input.periodStart,
      reSeq,
    })

    return {
      jobId,
      transmissionRef: buildTransmissionRef(
        input.declarantId,
        input.periodStart,
        'RE',
        reSeq,
      ),
    }
  }
}
