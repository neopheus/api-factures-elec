import { beforeEach, describe, expect, it, vi } from 'vitest'

// La validation XSD (impureté d'exécution : subprocess xmllint) est mockée
// ici — testée pour elle-même dans annuaire-xsd-validator.test.ts, et de
// bout en bout (real xmllint) dans annuaire-publication.e2e.test.ts. Motif
// ereporting-generation.service.test.ts (Task 8, 2.3) : tester
// l'ORCHESTRATION (repo/port/branches/gate consentement) en isolation de
// l'impureté.
const mockValidate = vi.fn()
vi.mock('../../src/annuaire/annuaire-xsd-validator.js', () => ({
  validateAnnuaireActualisationXml: (...args: unknown[]) =>
    mockValidate(...args),
}))

const {
  AnnuairePublicationService,
  ConsentRequiredError,
  InvalidLignePeriodError,
  MotifRequiredError,
  StaleLigneTransitionError,
} = await import('../../src/annuaire/annuaire-publication.service.js')
const { LigneSlotConflictError } = await import(
  '../../src/annuaire/annuaire.repository.js'
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

function fakeRepo(overrides: Record<string, unknown> = {}) {
  return {
    findActiveConsent: vi.fn().mockResolvedValue(activeConsent),
    findConsentById: vi.fn().mockResolvedValue(activeConsent),
    insertConsent: vi.fn().mockResolvedValue({ id: 'consent-new' }),
    insertLigne: vi.fn().mockResolvedValue({ id: 'ligne-1' }),
    markPublished: vi.fn().mockResolvedValue(undefined),
    appendLigneEvent: vi.fn().mockResolvedValue(undefined),
    findLigne: vi.fn().mockResolvedValue({
      id: 'ligne-1',
      siren: '111111111',
      siret: null,
      routageId: null,
      suffixe: null,
      nature: 'D',
      dateDebut: '20260101',
      dateFin: null,
      plateforme: '0001',
      status: 'published',
      consentId: 'consent-1',
      trackingRef: 'TRACK-1',
      rejectReason: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    }),
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

function build(repoOverrides = {}, portOverrides = {}) {
  const repo = fakeRepo(repoOverrides)
  const port = fakePort(portOverrides)
  const service = new AnnuairePublicationService(repo as never, port as never)
  return { service, repo, port }
}

describe('AnnuairePublicationService.publishLigne', () => {
  beforeEach(() => {
    mockValidate.mockReset()
    mockValidate.mockResolvedValue({ valid: true, errors: '' })
  })

  it('refuse la publication sans consentement actif (ConsentRequiredError), AVANT toute écriture', async () => {
    const { service, repo, port } = build({
      findActiveConsent: vi.fn().mockResolvedValue(null),
    })
    await expect(service.publishLigne(TENANT, ligneInput)).rejects.toThrow(
      ConsentRequiredError,
    )
    expect(repo.insertLigne).not.toHaveBeenCalled()
    expect(port.publish).not.toHaveBeenCalled()
  })

  it('crée le consentement inline quand `proof` est fourni, puis publie', async () => {
    const { service, repo } = build()
    const proof = {
      consentType: 'mandat',
      signerIdentity: 'Sign',
      evidenceRef: 'EV-1',
      obtainedAt: new Date('2026-01-01T00:00:00Z'),
    }
    await service.publishLigne(TENANT, { ...ligneInput, proof })
    expect(repo.insertConsent).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ siren: '111111111', ...proof }),
    )
    expect(repo.findActiveConsent).toHaveBeenCalledTimes(1)
  })

  it('référence un consentement existant via `consentId` (couverture vérifiée par le service, pas une confiance aveugle)', async () => {
    const { service, repo } = build()
    await service.publishLigne(TENANT, {
      ...ligneInput,
      consentId: 'consent-1',
    })
    expect(repo.findConsentById).toHaveBeenCalledWith(TENANT, 'consent-1')
    expect(repo.findActiveConsent).not.toHaveBeenCalled()
    expect(repo.insertLigne).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ consentId: 'consent-1' }),
    )
  })

  it('refuse un `consentId` révoqué (ConsentRequiredError)', async () => {
    const { service, repo } = build({
      findConsentById: vi
        .fn()
        .mockResolvedValue({ ...activeConsent, revokedAt: new Date() }),
    })
    await expect(
      service.publishLigne(TENANT, { ...ligneInput, consentId: 'consent-1' }),
    ).rejects.toThrow(ConsentRequiredError)
    expect(repo.insertLigne).not.toHaveBeenCalled()
  })

  it('refuse un `consentId` non-révoqué mais ne COUVRANT PAS la maille demandée (ConsentRequiredError)', async () => {
    const { service, repo } = build({
      findConsentById: vi.fn().mockResolvedValue({
        ...activeConsent,
        siren: '222222222', // SIREN distinct de ligneInput.siren
      }),
    })
    await expect(
      service.publishLigne(TENANT, { ...ligneInput, consentId: 'consent-1' }),
    ).rejects.toThrow(ConsentRequiredError)
    expect(repo.insertLigne).not.toHaveBeenCalled()
  })

  it('publie une ligne consentie : insertLigne (draft) -> transmit -> markPublished', async () => {
    const { service, repo, port } = build()
    const result = await service.publishLigne(TENANT, ligneInput)

    expect(result).toEqual({
      id: 'ligne-1',
      status: 'published',
      trackingRef: 'TRACK-1',
      rejectReason: null,
    })
    expect(repo.insertLigne).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ consentId: 'consent-1' }),
    )
    expect(repo.insertLigne.mock.calls[0]?.[1]?.rejectMotif).toBeUndefined()
    expect(port.publish).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, publicationRef: 'ligne-1' }),
    )
    expect(repo.markPublished).toHaveBeenCalledWith(
      TENANT,
      'ligne-1',
      'TRACK-1',
    )
  })

  it('F13 XSD-invalide (defensif) : born-rejetee — INSERT direct rejetee, port JAMAIS appelé (T4-F1)', async () => {
    mockValidate.mockResolvedValue({ valid: false, errors: 'boom' })
    const { service, repo, port } = build({
      insertLigne: vi.fn().mockResolvedValue({ id: 'ligne-2' }),
    })
    const result = await service.publishLigne(TENANT, ligneInput)

    expect(result).toEqual({
      id: 'ligne-2',
      status: 'rejetee',
      trackingRef: null,
      rejectReason: 'xsd-invalide',
    })
    expect(repo.insertLigne).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ rejectMotif: 'xsd-invalide' }),
    )
    expect(port.publish).not.toHaveBeenCalled()
    expect(repo.markPublished).not.toHaveBeenCalled()
  })

  it("erreur d'outillage (tooling) : PROPAGÉE telle quelle (jamais une rejetee, jamais un insertLigne)", async () => {
    mockValidate.mockRejectedValue(new Error('xmllint introuvable'))
    const { service, repo } = build()
    await expect(service.publishLigne(TENANT, ligneInput)).rejects.toThrow(
      'xmllint introuvable',
    )
    expect(repo.insertLigne).not.toHaveBeenCalled()
  })

  it('propage LigneSlotConflictError telle quelle (A-DEADLOCK — le contrôleur la mappe en 409)', async () => {
    const { service, port } = build({
      insertLigne: vi
        .fn()
        .mockRejectedValue(new LigneSlotConflictError('111111111', '20260101')),
    })
    await expect(
      service.publishLigne(TENANT, ligneInput),
    ).rejects.toBeInstanceOf(LigneSlotConflictError)
    expect(port.publish).not.toHaveBeenCalled()
  })
})

describe('AnnuairePublicationService.recordAck', () => {
  it('applique published→deposee sans motif', async () => {
    const { service, repo } = build()
    await service.recordAck(TENANT, 'ligne-1', 'deposee')
    expect(repo.appendLigneEvent).toHaveBeenCalledWith(
      TENANT,
      'ligne-1',
      'published',
      'deposee',
      'ppf',
      undefined,
    )
  })

  it('refuse un rejet SANS motif (MotifRequiredError), sans appeler le repository', async () => {
    const { service, repo } = build()
    await expect(
      service.recordAck(TENANT, 'ligne-1', 'rejetee'),
    ).rejects.toBeInstanceOf(MotifRequiredError)
    expect(repo.appendLigneEvent).not.toHaveBeenCalled()
  })

  it('applique un rejet AVEC motif', async () => {
    const { service, repo } = build()
    await service.recordAck(TENANT, 'ligne-1', 'rejetee', 'motif libre')
    expect(repo.appendLigneEvent).toHaveBeenCalledWith(
      TENANT,
      'ligne-1',
      'published',
      'rejetee',
      'ppf',
      'motif libre',
    )
  })

  it('mappe un CAS périmé/inconnu en StaleLigneTransitionError (409-analog)', async () => {
    const { service } = build({
      appendLigneEvent: vi
        .fn()
        .mockRejectedValue(new Error("ligne x is not in 'published' status")),
    })
    await expect(
      service.recordAck(TENANT, 'ligne-1', 'deposee'),
    ).rejects.toBeInstanceOf(StaleLigneTransitionError)
  })

  it('propage toute autre erreur inattendue telle quelle', async () => {
    const { service } = build({
      appendLigneEvent: vi.fn().mockRejectedValue(new Error('boom inattendu')),
    })
    await expect(
      service.recordAck(TENANT, 'ligne-1', 'deposee'),
    ).rejects.toThrow('boom inattendu')
  })
})

describe('AnnuairePublicationService.maskLigne', () => {
  it('applique deposee→masked (actor=platform)', async () => {
    const { service, repo } = build()
    await service.maskLigne(TENANT, 'ligne-1')
    expect(repo.appendLigneEvent).toHaveBeenCalledWith(
      TENANT,
      'ligne-1',
      'deposee',
      'masked',
      'platform',
    )
  })

  it('mappe un CAS périmé en StaleLigneTransitionError', async () => {
    const { service } = build({
      appendLigneEvent: vi
        .fn()
        .mockRejectedValue(new Error("ligne x is not in 'deposee' status")),
    })
    await expect(service.maskLigne(TENANT, 'ligne-1')).rejects.toBeInstanceOf(
      StaleLigneTransitionError,
    )
  })

  it('propage toute autre erreur inattendue telle quelle', async () => {
    const { service } = build({
      appendLigneEvent: vi.fn().mockRejectedValue(new Error('boom inattendu')),
    })
    await expect(service.maskLigne(TENANT, 'ligne-1')).rejects.toThrow(
      'boom inattendu',
    )
  })
})

describe('AnnuairePublicationService.endEffect', () => {
  it('positionne dateFin quand elle suit strictement dateDebut', async () => {
    const { service, repo } = build()
    await service.endEffect(TENANT, 'ligne-1', '20260601')
    expect(repo.updateDateFin).toHaveBeenCalledWith(
      TENANT,
      'ligne-1',
      '20260601',
    )
  })

  it('refuse une dateFin <= dateDebut existante (InvalidLignePeriodError)', async () => {
    const { service, repo } = build()
    await expect(
      service.endEffect(TENANT, 'ligne-1', '20260101'),
    ).rejects.toBeInstanceOf(InvalidLignePeriodError)
    expect(repo.updateDateFin).not.toHaveBeenCalled()
  })

  it('mappe une ligne inconnue (findLigne null) en StaleLigneTransitionError', async () => {
    const { service } = build({ findLigne: vi.fn().mockResolvedValue(null) })
    await expect(
      service.endEffect(TENANT, 'ligne-x', '20260601'),
    ).rejects.toBeInstanceOf(StaleLigneTransitionError)
  })

  it('mappe un updateDateFin sans effet (statut terminal, race) en StaleLigneTransitionError', async () => {
    const { service } = build({
      updateDateFin: vi.fn().mockResolvedValue(false),
    })
    await expect(
      service.endEffect(TENANT, 'ligne-1', '20260601'),
    ).rejects.toBeInstanceOf(StaleLigneTransitionError)
  })
})

describe('AnnuairePublicationService.getLigne', () => {
  it('délègue à repo.findLigne (passthrough RLS-scopé)', async () => {
    const { service, repo } = build()
    const result = await service.getLigne(TENANT, 'ligne-1')
    expect(repo.findLigne).toHaveBeenCalledWith(TENANT, 'ligne-1')
    expect(result).toMatchObject({ id: 'ligne-1' })
  })
})

// Task 9 (injection revue contrôleur — STUCK-DRAFT RE-PUBLISH SWEEP, fix du
// défaut T8 F1) : rejoue generate→validate→port.publish→markPublished pour
// une ligne restée en 'draft' (crash entre `port.publish` et
// `markPublished`). Idempotent PAR CONSTRUCTION : le port write-once renvoie
// le résultat D'ORIGINE au re-publish (prouvé e2e, annuaire-sync.e2e.test.ts
// — ici mocké) ; le CAS de `markPublished` absorbe la concurrence (prouvé ci-
// dessous).
const draftLigne = {
  id: 'ligne-draft-1',
  siren: '111111111',
  siret: null,
  routageId: null,
  suffixe: null,
  nature: 'D' as const,
  dateDebut: '20260101',
  dateFin: null,
  plateforme: '0001',
  status: 'draft' as const,
  consentId: 'consent-1',
  trackingRef: null,
  rejectReason: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
}

describe('AnnuairePublicationService.republishDraft', () => {
  beforeEach(() => {
    mockValidate.mockReset()
    mockValidate.mockResolvedValue({ valid: true, errors: '' })
  })

  it("ligne inconnue/hors tenant (findLigne null) : 'skipped', port JAMAIS appelé", async () => {
    const { service, port } = build({
      findLigne: vi.fn().mockResolvedValue(null),
    })
    const result = await service.republishDraft(TENANT, 'ligne-inconnue')
    expect(result).toBe('skipped')
    expect(port.publish).not.toHaveBeenCalled()
  })

  it("ligne déjà résolue (status != 'draft') : 'skipped', port JAMAIS appelé (course avec un autre chemin)", async () => {
    const { service, repo, port } = build({
      findLigne: vi
        .fn()
        .mockResolvedValue({ ...draftLigne, status: 'published' }),
    })
    const result = await service.republishDraft(TENANT, draftLigne.id)
    expect(result).toBe('skipped')
    expect(port.publish).not.toHaveBeenCalled()
    expect(repo.markPublished).not.toHaveBeenCalled()
  })

  it("rejoue generate→validate→port.publish→markPublished pour un draft : 'republished'", async () => {
    const { service, repo, port } = build({
      findLigne: vi.fn().mockResolvedValue(draftLigne),
    })
    const result = await service.republishDraft(TENANT, draftLigne.id)
    expect(result).toBe('republished')
    expect(port.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        publicationRef: draftLigne.id,
      }),
    )
    expect(repo.markPublished).toHaveBeenCalledWith(
      TENANT,
      draftLigne.id,
      'TRACK-1',
    )
  })

  it("CAS périmé sur markPublished (déjà publiée entre-temps, concurrence) : 'skipped', pas d'erreur propagée", async () => {
    const { service } = build(
      {
        findLigne: vi.fn().mockResolvedValue(draftLigne),
        markPublished: vi
          .fn()
          .mockRejectedValue(
            new Error(
              `markPublished: ligne ${draftLigne.id} is not in 'draft' status`,
            ),
          ),
      },
      {},
    )
    const result = await service.republishDraft(TENANT, draftLigne.id)
    expect(result).toBe('skipped')
  })

  it('F13 régénéré XSD-invalide (anomalie inattendue) : propage une erreur, JAMAIS un rejet silencieux', async () => {
    mockValidate.mockResolvedValue({ valid: false, errors: 'boom' })
    const { service, port } = build({
      findLigne: vi.fn().mockResolvedValue(draftLigne),
    })
    await expect(
      service.republishDraft(TENANT, draftLigne.id),
    ).rejects.toThrow()
    expect(port.publish).not.toHaveBeenCalled()
  })
})
