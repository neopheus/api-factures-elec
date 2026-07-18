import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConsentSignatureRejectedError } from '../../src/annuaire/consent-signature.port.js'

// Scellement de la preuve de consentement à la création (D3, Task 2) —
// branche `proof` de `resolveConsent` (annuaire-publication.service.ts).
// Isole l'orchestration (repo/port/scellement) du reste du service, motif
// annuaire-publication.service.test.ts. La validation XSD n'entre jamais en
// jeu ici : `resolveConsent` s'exécute AVANT toute génération F13.
const mockValidate = vi.fn()
vi.mock('../../src/annuaire/annuaire-xsd-validator.js', () => ({
  validateAnnuaireActualisationXml: (...args: unknown[]) =>
    mockValidate(...args),
}))

const { AnnuairePublicationService, ConsentSignatureError } = await import(
  '../../src/annuaire/annuaire-publication.service.js'
)

const TENANT = 'tenant-1'

const activeConsent = {
  id: 'consent-1',
  siren: '111111111',
  siret: null,
  routageId: null,
  suffixe: null,
  consentType: 'mandat',
  signerIdentity: 'Signataire',
  evidenceRef: 'EVID',
  obtainedAt: new Date('2026-01-01T00:00:00Z'),
  revokedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
}

const ligneInput = {
  siren: '111111111',
  nature: 'D' as const,
  dateDebut: '20260101',
  plateforme: '0001',
}

const proof = {
  consentType: 'mandat',
  signerIdentity: 'Signataire Preuve',
  evidenceRef: 'EVID-CLIENT-BRUTE',
  obtainedAt: new Date('2026-01-01T00:00:00Z'),
}

const sealResult = {
  sealRef: 'a'.repeat(64),
  location: '/var/consent/tenant-1/aaaa.seal',
  sealedAt: '20260101000000',
  alreadyExisted: false,
}

function fakeRepo(overrides: Record<string, unknown> = {}) {
  return {
    findActiveConsent: vi.fn().mockResolvedValue(activeConsent),
    findConsentById: vi.fn().mockResolvedValue(activeConsent),
    insertConsent: vi.fn().mockResolvedValue({ id: 'consent-new' }),
    insertLigne: vi.fn().mockResolvedValue({ id: 'ligne-1' }),
    markPublished: vi.fn().mockResolvedValue(undefined),
    appendLigneEvent: vi.fn().mockResolvedValue(undefined),
    findLigne: vi.fn().mockResolvedValue(null),
    updateDateFin: vi.fn().mockResolvedValue(true),
    ...overrides,
  }
}

function fakePort(overrides: Record<string, unknown> = {}) {
  return {
    publish: vi
      .fn()
      .mockResolvedValue({ trackingRef: 'TRACK-1', location: 'mem://x' }),
    fetchConsultation: vi.fn(),
    publicationStatus: vi.fn(),
    ...overrides,
  }
}

function fakeConsentSignature(overrides: Record<string, unknown> = {}) {
  return {
    seal: vi.fn().mockResolvedValue(sealResult),
    verify: vi.fn(),
    ...overrides,
  }
}

function build(
  repoOverrides = {},
  portOverrides = {},
  consentSignatureOverrides = {},
) {
  const repo = fakeRepo(repoOverrides)
  const port = fakePort(portOverrides)
  const consentSignature = fakeConsentSignature(consentSignatureOverrides)
  const service = new AnnuairePublicationService(
    repo as never,
    port as never,
    consentSignature as never,
  )
  return { service, repo, port, consentSignature }
}

describe('AnnuairePublicationService — scellement du consentement (branche proof, D3)', () => {
  beforeEach(() => {
    mockValidate.mockReset()
    mockValidate.mockResolvedValue({ valid: true, errors: '' })
  })

  it('branche proof : seal() appelé AVANT insertConsent, avec la maille + la preuve déclarée', async () => {
    const { service, repo, consentSignature } = build()
    await service.publishLigne(TENANT, { ...ligneInput, proof })

    expect(consentSignature.seal).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        siren: '111111111',
        consentType: proof.consentType,
        signerIdentity: proof.signerIdentity,
        evidenceRef: proof.evidenceRef,
        obtainedAt: proof.obtainedAt,
      }),
    )
    const sealOrder = consentSignature.seal.mock.invocationCallOrder[0]
    const insertOrder = repo.insertConsent.mock.invocationCallOrder[0]
    expect(sealOrder).toBeLessThan(insertOrder as number)
  })

  it('insertConsent reçoit evidence_ref = seal.sealRef (PAS la chaîne evidenceRef client brute)', async () => {
    const { service, repo } = build()
    await service.publishLigne(TENANT, { ...ligneInput, proof })

    expect(repo.insertConsent).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ evidenceRef: sealResult.sealRef }),
    )
    const [, insertedConsent] = repo.insertConsent.mock.calls[0] as [
      string,
      { evidenceRef: string },
    ]
    expect(insertedConsent.evidenceRef).not.toBe(proof.evidenceRef)
  })

  it('seal throw (ConsentSignatureRejectedError) → publication échoue, insertConsent JAMAIS appelé', async () => {
    const { service, repo } = build(
      {},
      {},
      {
        seal: vi
          .fn()
          .mockRejectedValue(new ConsentSignatureRejectedError('boom')),
      },
    )
    await expect(
      service.publishLigne(TENANT, { ...ligneInput, proof }),
    ).rejects.toBeInstanceOf(ConsentSignatureError)
    expect(repo.insertConsent).not.toHaveBeenCalled()
    expect(repo.insertLigne).not.toHaveBeenCalled()
  })

  it('chemin consentId (preuve déjà persistée) : seal() JAMAIS appelé (gate = couverture/révocation inchangé)', async () => {
    const { service, consentSignature, repo } = build()
    await service.publishLigne(TENANT, {
      ...ligneInput,
      consentId: 'consent-1',
    })
    expect(consentSignature.seal).not.toHaveBeenCalled()
    expect(repo.insertConsent).not.toHaveBeenCalled()
  })

  it('chemin auto-découverte : seal() JAMAIS appelé', async () => {
    const { service, consentSignature, repo } = build()
    await service.publishLigne(TENANT, { ...ligneInput })
    expect(consentSignature.seal).not.toHaveBeenCalled()
    expect(repo.insertConsent).not.toHaveBeenCalled()
  })
})
