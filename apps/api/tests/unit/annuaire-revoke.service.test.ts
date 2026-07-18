import { describe, expect, it, vi } from 'vitest'
import {
  AnnuairePublicationService,
  ConsentNotFoundError,
} from '../../src/annuaire/annuaire-publication.service.js'

// Révocation de consentement (Plan 3.6, Task 1, D3) : oracle INDÉPENDANT —
// l'horodatage vient du repo MOCKÉ (jamais recalculé par le service), la
// monotonie de l'idempotence est donc prouvée par la VALEUR renvoyée par le
// mock, pas par une relecture de l'implémentation elle-même.

const TENANT = 'tenant-1'
const CONSENT_ID = 'consent-1'
const REVOKED_AT = new Date('2026-07-18T10:00:00Z')

function fakeRepo(overrides: Record<string, unknown> = {}) {
  return {
    findActiveConsent: vi.fn(),
    findConsentById: vi.fn(),
    insertConsent: vi.fn(),
    insertLigne: vi.fn(),
    markPublished: vi.fn(),
    appendLigneEvent: vi.fn(),
    findLigne: vi.fn(),
    updateDateFin: vi.fn(),
    revokeConsent: vi.fn().mockResolvedValue({ revokedAt: REVOKED_AT }),
    countActiveLignesForConsent: vi.fn().mockResolvedValue(0),
    ...overrides,
  }
}

function fakePort() {
  return {
    publish: vi.fn(),
    fetchConsultation: vi.fn(),
    publicationStatus: vi.fn(),
  }
}

function fakeConsentSignature() {
  return { seal: vi.fn(), verify: vi.fn() }
}

function build(repoOverrides: Record<string, unknown> = {}) {
  const repo = fakeRepo(repoOverrides)
  const service = new AnnuairePublicationService(
    repo as never,
    fakePort() as never,
    fakeConsentSignature() as never,
  )
  return { service, repo }
}

describe('AnnuairePublicationService.revokeConsent', () => {
  it('révocation fraîche : repo.revokeConsent renvoie revoked_at, service retourne { consentId, revokedAt: ISO, dependentActiveLignes }', async () => {
    const { service, repo } = build({
      revokeConsent: vi.fn().mockResolvedValue({ revokedAt: REVOKED_AT }),
      countActiveLignesForConsent: vi.fn().mockResolvedValue(2),
    })

    const result = await service.revokeConsent(TENANT, CONSENT_ID)

    expect(result).toEqual({
      consentId: CONSENT_ID,
      revokedAt: REVOKED_AT.toISOString(),
      dependentActiveLignes: 2,
    })
    expect(repo.revokeConsent).toHaveBeenCalledWith(TENANT, CONSENT_ID)
    expect(repo.countActiveLignesForConsent).toHaveBeenCalledWith(
      TENANT,
      CONSENT_ID,
    )
  })

  it('idempotence : 2e révocation → MÊME revoked_at (repo renvoie l’original, jamais réécrit)', async () => {
    // Le repo mocké simule fidèlement le CAS write-once réel : le 2e appel
    // renvoie la MÊME date d'origine (jamais une nouvelle date), exactement
    // ce que produit `UPDATE ... WHERE revoked_at IS NULL` suivi de la
    // relecture en cas de 0 ligne affectée.
    const revokeConsent = vi.fn().mockResolvedValue({ revokedAt: REVOKED_AT })
    const { service } = build({ revokeConsent })

    const first = await service.revokeConsent(TENANT, CONSENT_ID)
    const second = await service.revokeConsent(TENANT, CONSENT_ID)

    expect(first.revokedAt).toBe(REVOKED_AT.toISOString())
    expect(second.revokedAt).toBe(first.revokedAt)
    expect(revokeConsent).toHaveBeenCalledTimes(2)
  })

  it('consentement inconnu/cross-tenant (repo → null) → ConsentNotFoundError', async () => {
    const { service, repo } = build({
      revokeConsent: vi.fn().mockResolvedValue(null),
    })

    await expect(service.revokeConsent(TENANT, CONSENT_ID)).rejects.toThrow(
      ConsentNotFoundError,
    )
    expect(repo.countActiveLignesForConsent).not.toHaveBeenCalled()
  })

  it('dependentActiveLignes = countActiveLignesForConsent (statuts non terminaux uniquement)', async () => {
    const countActiveLignesForConsent = vi.fn().mockResolvedValue(5)
    const { service } = build({ countActiveLignesForConsent })

    const result = await service.revokeConsent(TENANT, CONSENT_ID)

    expect(countActiveLignesForConsent).toHaveBeenCalledWith(TENANT, CONSENT_ID)
    expect(result.dependentActiveLignes).toBe(5)
  })
})
