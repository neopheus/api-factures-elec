import { beforeEach, describe, expect, it, vi } from 'vitest'

// parseConsultationF14 fait XSD-validation + parsing (Task 3) — impureté
// d'exécution (subprocess xmllint), mockée ici pour tester l'ORCHESTRATION
// (routage TypeFlux C/D, gestion des 3 issues sémantique/vide/outillage) en
// isolation, motif ereporting-generation.service.test.ts. Les classes
// d'erreur (InvalidConsultationF14XmlError etc.) restent les VRAIES — seule
// la fonction est remplacée (vi.importActual), pour pouvoir les construire
// et les faire reconnaître par les `instanceof` du service.
const mockParse = vi.fn()
vi.mock('../../src/annuaire/flux14-parse.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/annuaire/flux14-parse.js')
  >('../../src/annuaire/flux14-parse.js')
  return {
    ...actual,
    parseConsultationF14: (...args: unknown[]) => mockParse(...args),
  }
})

const { AnnuaireSyncService, effectiveDateFin, toDirectoryEntry } =
  await import('../../src/annuaire/annuaire-sync.service.js')
const {
  InvalidConsultationF14XmlError,
  UnknownLigneNatureError,
  UnknownTypeFluxError,
} = await import('../../src/annuaire/flux14-parse.js')
const { AnnuaireXsdToolingError } = await import(
  '../../src/annuaire/annuaire-xsd-validator.js'
)

const TENANT = 'tenant-1'

const ligneD = {
  maille: { siren: '111111111' },
  nature: 'D' as const,
  dateDebut: '20260101',
  plateforme: '0001',
}

function fakePort(overrides: Record<string, unknown> = {}) {
  return {
    publish: vi.fn(),
    fetchConsultation: vi
      .fn()
      .mockResolvedValue({ typeFlux: 'D', xml: '<xml/>' }),
    publicationStatus: vi.fn(),
    ...overrides,
  }
}

function fakeRepo(overrides: Record<string, unknown> = {}) {
  return {
    upsertDirectoryEntries: vi.fn().mockResolvedValue(undefined),
    replaceDirectoryEntries: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function build(portOverrides = {}, repoOverrides = {}) {
  const port = fakePort(portOverrides)
  const repo = fakeRepo(repoOverrides)
  const service = new AnnuaireSyncService(port as never, repo as never)
  return { service, port, repo }
}

describe('effectiveDateFin (injection revue T3, MED)', () => {
  it('absence des deux → undefined (toujours en vigueur)', () => {
    expect(effectiveDateFin({ ...ligneD })).toBeUndefined()
  })

  it('dateFin seule → dateFin', () => {
    expect(effectiveDateFin({ ...ligneD, dateFin: '20270101' })).toBe(
      '20270101',
    )
  })

  it('dateFinEffective seule → dateFinEffective', () => {
    expect(effectiveDateFin({ ...ligneD, dateFinEffective: '20260601' })).toBe(
      '20260601',
    )
  })

  it('les deux présentes : retient la plus PRÉCOCE (early-terminated, jamais sur-router)', () => {
    expect(
      effectiveDateFin({
        ...ligneD,
        dateFin: '20270101',
        dateFinEffective: '20260601',
      }),
    ).toBe('20260601')
    // Ordre inversé (dateFinEffective postérieure à dateFin — cas non
    // nominal mais la fonction reste symétrique) : le minimum l'emporte
    // toujours, quel que soit l'ordre des deux valeurs.
    expect(
      effectiveDateFin({
        ...ligneD,
        dateFin: '20260601',
        dateFinEffective: '20270101',
      }),
    ).toBe('20260601')
  })
})

describe('toDirectoryEntry', () => {
  it('projette LigneAdressage → NewDirectoryEntry avec la fin EFFECTIVE (pas dateFin brute)', () => {
    expect(
      toDirectoryEntry({
        maille: { siren: '111111111', siret: '11111111100011' },
        nature: 'D',
        dateDebut: '20260101',
        dateFin: '20270101',
        dateFinEffective: '20260601',
        plateforme: '0002',
      }),
    ).toEqual({
      siren: '111111111',
      siret: '11111111100011',
      routageId: undefined,
      suffixe: undefined,
      nature: 'D',
      dateDebut: '20260101',
      dateFin: '20260601',
      plateforme: '0002',
    })
  })
})

describe('AnnuaireSyncService.sync', () => {
  beforeEach(() => {
    mockParse.mockReset()
  })

  it("TypeFlux='D' (différentiel) : upsertDirectoryEntries (jamais replace)", async () => {
    mockParse.mockResolvedValue({
      typeFlux: 'D',
      horodate: 'H',
      lignes: [ligneD],
    })
    const { service, port, repo } = build()
    const n = await service.sync(TENANT, 'D')
    expect(n).toBe(1)
    expect(port.fetchConsultation).toHaveBeenCalledWith('D')
    expect(repo.upsertDirectoryEntries).toHaveBeenCalledWith(
      TENANT,
      expect.arrayContaining([expect.objectContaining({ siren: '111111111' })]),
    )
    expect(repo.replaceDirectoryEntries).not.toHaveBeenCalled()
  })

  it("TypeFlux='C' (complet) : replaceDirectoryEntries (A-SYNC-RECONCILE, jamais upsert)", async () => {
    mockParse.mockResolvedValue({
      typeFlux: 'C',
      horodate: 'H',
      lignes: [ligneD],
    })
    const { service, repo } = build()
    const n = await service.sync(TENANT, 'C')
    expect(n).toBe(1)
    expect(repo.replaceDirectoryEntries).toHaveBeenCalledWith(
      TENANT,
      expect.arrayContaining([expect.objectContaining({ siren: '111111111' })]),
    )
    expect(repo.upsertDirectoryEntries).not.toHaveBeenCalled()
  })

  it('F14 vide (0 ligne) : no-op — aucun appel repo, renvoie 0', async () => {
    mockParse.mockResolvedValue({ typeFlux: 'C', horodate: 'H', lignes: [] })
    const { service, repo } = build()
    const n = await service.sync(TENANT, 'C')
    expect(n).toBe(0)
    expect(repo.replaceDirectoryEntries).not.toHaveBeenCalled()
    expect(repo.upsertDirectoryEntries).not.toHaveBeenCalled()
  })

  it('F14 XSD-invalide (InvalidConsultationF14XmlError) : log+skip, aucun appel repo, renvoie 0', async () => {
    mockParse.mockRejectedValue(
      new InvalidConsultationF14XmlError('schema error'),
    )
    const { service, repo } = build()
    const n = await service.sync(TENANT, 'D')
    expect(n).toBe(0)
    expect(repo.upsertDirectoryEntries).not.toHaveBeenCalled()
  })

  it('Nature hors nomenclature (UnknownLigneNatureError) : log+skip, aucun appel repo', async () => {
    mockParse.mockRejectedValue(new UnknownLigneNatureError('X', 0))
    const { service, repo } = build()
    const n = await service.sync(TENANT, 'D')
    expect(n).toBe(0)
    expect(repo.upsertDirectoryEntries).not.toHaveBeenCalled()
  })

  it('TypeFlux hors nomenclature (UnknownTypeFluxError) : log+skip, aucun appel repo', async () => {
    mockParse.mockRejectedValue(new UnknownTypeFluxError('Z'))
    const { service, repo } = build()
    const n = await service.sync(TENANT, 'D')
    expect(n).toBe(0)
    expect(repo.upsertDirectoryEntries).not.toHaveBeenCalled()
  })

  it("erreur d'OUTILLAGE (AnnuaireXsdToolingError) : propage (throw -> retry BullMQ), JAMAIS un skip silencieux", async () => {
    mockParse.mockRejectedValue(
      new AnnuaireXsdToolingError(new Error('ENOENT')),
    )
    const { service, repo } = build()
    await expect(service.sync(TENANT, 'D')).rejects.toBeInstanceOf(
      AnnuaireXsdToolingError,
    )
    expect(repo.upsertDirectoryEntries).not.toHaveBeenCalled()
  })
})
