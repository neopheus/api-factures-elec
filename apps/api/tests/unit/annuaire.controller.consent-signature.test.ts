import { UnprocessableEntityException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import { AnnuaireController } from '../../src/annuaire/annuaire.controller.js'
import type { AnnuaireConsultationService } from '../../src/annuaire/annuaire-consultation.service.js'
import {
  type AnnuairePublicationService,
  ConsentSignatureError,
} from '../../src/annuaire/annuaire-publication.service.js'

// Revue T2 plan 3.5, NIT-1 : le mapping contrôleur
// `ConsentSignatureError → 422 businessRule` (« Consent signature
// rejected ») n'était exercé par AUCUN test — le driver `local` ne throw
// jamais en e2e (clé de sceau toujours sûre côté serveur). Ce test ferme le
// trou en injectant un service de publication qui throw, et épingle le CORPS
// problem+json en littéral (même statut/type que ConsentRequiredError —
// c'est le contrat D3 « même 422 »).
describe('AnnuaireController — mapping ConsentSignatureError (NIT-1 revue T2 3.5)', () => {
  it('POST /annuaire/lignes : un scellement rejeté est mappé en 422 business-rule au corps épinglé', async () => {
    const publication = {
      publishLigne: vi
        .fn()
        .mockRejectedValue(new ConsentSignatureError('preuve non scellable')),
    }
    const controller = new AnnuaireController(
      {} as unknown as AnnuaireConsultationService,
      publication as unknown as AnnuairePublicationService,
    )

    const body = {
      siren: '123456789',
      nature: 'D',
      dateDebut: '20260101',
      plateforme: '0001',
      proof: {
        consentType: 'mandat',
        signerIdentity: 'Jean Dupont',
        evidenceRef: 'EVID-1',
        obtainedAt: '2026-01-01T00:00:00.000Z',
      },
    }

    let caught: unknown
    try {
      await controller.publish('tenant-1', body)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(UnprocessableEntityException)
    expect((caught as UnprocessableEntityException).getResponse()).toEqual({
      type: 'urn:factelec:problem:business-rule-violation',
      title: 'Consent signature rejected',
      status: 422,
      detail:
        'échec du scellement de la preuve de consentement : preuve non scellable',
    })
    expect(publication.publishLigne).toHaveBeenCalledTimes(1)
  })
})
