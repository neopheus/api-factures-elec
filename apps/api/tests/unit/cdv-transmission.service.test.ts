import type { Invoice } from '@factelec/invoice-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AmbiguousResolutionError,
  RecipientUnaddressableError,
} from '../../src/annuaire/ligne-adressage.js'

// Validation F6 (Task 2) est PURE (regex, pas d'outillage async) — mais on la
// mocke ICI pour piloter délibérément un chemin "structurellement invalide"
// (motif ereporting-generation.service.test.ts : `generateFlux6Cdar`, réel,
// ne produit jamais de F6 invalide pour des entrées bien formées). On
// conserve `generateFlux6Cdar` RÉEL (importOriginal) : le XML réellement
// passé au port reste un vrai F6, seule la DÉCISION de validité est pilotée.
const mockValidate = vi.fn()
vi.mock('../../src/cdv/flux6-cdar.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/cdv/flux6-cdar.js')>()
  return {
    ...actual,
    validateFlux6Structure: (...args: unknown[]) =>
      mockValidate(...(args as [string])),
  }
})

const {
  CdvTransmissionService,
  BuyerIdentifierMissingError,
  buildMailleFromBuyer,
  formatMessageHorodate,
  isoDateToYmd,
  normalizeToUndefined,
} = await import('../../src/cdv/cdv-transmission.service.js')

function fakeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    number: 'FA-1',
    issueDate: '2026-07-16',
    typeCode: '380',
    currency: 'EUR',
    seller: {
      name: 'Vendeur SARL',
      siren: '111111111',
      address: { countryCode: 'FR' },
    },
    buyer: {
      name: 'Client SARL',
      siren: '222222222',
      address: { countryCode: 'FR' },
    },
    lines: [],
    vatBreakdown: [],
    totals: {
      sumOfLines: '0.00',
      taxExclusive: '0.00',
      taxAmount: '0.00',
      taxInclusive: '0.00',
      payable: '0.00',
    },
    ...overrides,
  } as Invoice
}

function fakeRepo(overrides: Record<string, unknown> = {}) {
  return {
    findResumable: vi.fn().mockResolvedValue(null),
    insertTransmission: vi
      .fn()
      .mockResolvedValue({ id: 'tr-1', created: true }),
    markParked: vi.fn().mockResolvedValue(undefined),
    markTransmitted: vi.fn().mockResolvedValue(undefined),
    appendStatusEvent: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function fakeAnnuaire(overrides: Record<string, unknown> = {}) {
  return {
    resolveRecipient: vi.fn().mockResolvedValue({ plateforme: '0042' }),
    ...overrides,
  }
}

function fakeInvoicesRepo(overrides: Record<string, unknown> = {}) {
  return {
    loadCanonical: vi.fn().mockResolvedValue(fakeInvoice()),
    ...overrides,
  }
}

function fakePort(overrides: Record<string, unknown> = {}) {
  return {
    transmit: vi
      .fn()
      .mockResolvedValue({ trackingRef: 'TRACK-1', location: 'mem://x' }),
    status: vi.fn(),
    ...overrides,
  }
}

const fakeConfig = {
  get: () => '0238',
}

function build(
  repoOverrides: Record<string, unknown> = {},
  annuaireOverrides: Record<string, unknown> = {},
  invoicesRepoOverrides: Record<string, unknown> = {},
  portOverrides: Record<string, unknown> = {},
) {
  const repo = fakeRepo(repoOverrides)
  const annuaire = fakeAnnuaire(annuaireOverrides)
  const invoicesRepo = fakeInvoicesRepo(invoicesRepoOverrides)
  const port = fakePort(portOverrides)
  const service = new CdvTransmissionService(
    repo as never,
    annuaire as never,
    invoicesRepo as never,
    port as never,
    fakeConfig as never,
  )
  return { service, repo, annuaire, invoicesRepo, port }
}

describe('fonctions pures (formatMessageHorodate / isoDateToYmd / normalizeToUndefined / buildMailleFromBuyer)', () => {
  it('formatMessageHorodate sérialise AAAAMMJJHHMMSS en UTC', () => {
    expect(
      formatMessageHorodate(new Date(Date.UTC(2026, 6, 16, 9, 3, 7))),
    ).toBe('20260716090307')
  })

  it('isoDateToYmd convertit AAAA-MM-JJ -> AAAAMMJJ (retire les tirets)', () => {
    expect(isoDateToYmd('2026-07-16')).toBe('20260716')
  })

  it('normalizeToUndefined normalise la chaîne vide en undefined, laisse le reste intact', () => {
    expect(normalizeToUndefined('')).toBeUndefined()
    expect(normalizeToUndefined(undefined)).toBeUndefined()
    expect(normalizeToUndefined('123456789')).toBe('123456789')
  })

  describe('buildMailleFromBuyer (amendement A4)', () => {
    it('SIREN (9 chiffres) -> { siren }, siret ABSENT (jamais vide)', () => {
      const maille = buildMailleFromBuyer({
        name: 'x',
        siren: '123456789',
        address: { countryCode: 'FR' },
      })
      expect(maille).toEqual({ siren: '123456789' })
      expect('siret' in maille).toBe(false)
    })

    it('SIRET (14 chiffres) -> { siren: 9 premiers chiffres, siret: valeur complète }', () => {
      const maille = buildMailleFromBuyer({
        name: 'x',
        siren: '12345678900014',
        address: { countryCode: 'FR' },
      })
      expect(maille).toEqual({
        siren: '123456789',
        siret: '12345678900014',
      })
    })

    it('buyer sans siren (undefined) -> BuyerIdentifierMissingError', () => {
      expect(() =>
        buildMailleFromBuyer({ name: 'x', address: { countryCode: 'FR' } }),
      ).toThrow(BuyerIdentifierMissingError)
    })

    it("buyer avec siren='' (coalesce trap, A4) -> BuyerIdentifierMissingError, PAS une maille siren=''", () => {
      expect(() =>
        buildMailleFromBuyer({
          name: 'x',
          siren: '',
          address: { countryCode: 'FR' },
        }),
      ).toThrow(BuyerIdentifierMissingError)
    })
  })
})

describe('CdvTransmissionService.transmitStatus', () => {
  beforeEach(() => {
    mockValidate.mockReset()
    mockValidate.mockReturnValue({ valid: true, errors: '' })
  })

  it('FRESH, cible ppf : aucune résolution annuaire, insertTransmission(xml) -> transmit -> markTransmitted', async () => {
    const { service, repo, annuaire, port } = build()
    await service.transmitStatus(
      't1',
      'inv-1',
      'deposee',
      'ppf',
      '20260716120000',
    )

    expect(annuaire.resolveRecipient).not.toHaveBeenCalled()
    expect(repo.insertTransmission).toHaveBeenCalledTimes(1)
    const arg = repo.insertTransmission.mock.calls[0]![1]
    expect(arg.recipientMatricule).toBeUndefined()
    expect(typeof arg.xml).toBe('string')
    expect(arg.xml).toContain('200') // MDT-105, deposee

    expect(port.transmit).toHaveBeenCalledTimes(1)
    // Injection revue T6 (F1/F2) : xml TOUJOURS repassé à markTransmitted
    // (no-op idempotent en FRESH, cf. bannière repository) ; recipientMatricule
    // reste undefined pour la cible ppf (jamais résolu, D7).
    expect(repo.markTransmitted).toHaveBeenCalledWith('t1', 'tr-1', 'TRACK-1', {
      xml: expect.any(String),
      recipientMatricule: undefined,
    })
  })

  it("FRESH, cible recipient : résout via l'annuaire (maille depuis buyer, date AAAAMMJJ), recipientMatricule renseigné, transmit -> markTransmitted", async () => {
    const { service, repo, annuaire, port } = build()
    await service.transmitStatus(
      't1',
      'inv-1',
      'deposee',
      'recipient',
      '20260716120000',
    )

    expect(annuaire.resolveRecipient).toHaveBeenCalledWith(
      't1',
      { siren: '222222222' },
      '20260716', // isoDateToYmd('2026-07-16') — PAS l'ISO brut (correction vs plan littéral)
    )
    const arg = repo.insertTransmission.mock.calls[0]![1]
    expect(arg.recipientMatricule).toBe('0042')
    expect(port.transmit).toHaveBeenCalledTimes(1)
    // Injection revue T6 (F1/F2) : recipientMatricule PERSISTÉ via
    // markTransmitted (pas seulement insertTransmission).
    expect(repo.markTransmitted).toHaveBeenCalledWith('t1', 'tr-1', 'TRACK-1', {
      xml: expect.any(String),
      recipientMatricule: '0042',
    })
  })

  it('résout la maille SIREN_SIRET quand buyer.siren porte un SIRET (14 chiffres)', async () => {
    const { service, annuaire } = build(
      {},
      {},
      {
        loadCanonical: vi.fn().mockResolvedValue(
          fakeInvoice({
            buyer: {
              name: 'x',
              siren: '22222222200019',
              address: { countryCode: 'FR' },
            },
          }),
        ),
      },
    )
    await service.transmitStatus(
      't1',
      'inv-1',
      'deposee',
      'recipient',
      '20260716120000',
    )
    expect(annuaire.resolveRecipient).toHaveBeenCalledWith(
      't1',
      { siren: '222222222', siret: '22222222200019' },
      '20260716',
    )
  })

  it('SKIP total si la transmission est déjà TERMINALE (acknowledged) : aucune lecture de facture, aucun appel port', async () => {
    const { service, repo, invoicesRepo, port } = build({
      findResumable: vi.fn().mockResolvedValue({
        id: 'tr-x',
        status: 'acknowledged',
        resumable: false,
      }),
    })
    await service.transmitStatus(
      't1',
      'inv-1',
      'deposee',
      'ppf',
      '20260716120000',
    )
    expect(invoicesRepo.loadCanonical).not.toHaveBeenCalled()
    expect(repo.insertTransmission).not.toHaveBeenCalled()
    expect(port.transmit).not.toHaveBeenCalled()
  })

  it("SKIP total si la transmission est déjà 'transmitted' (PAS terminal dans la machine, mais skip explicite du service — seule la frontière d'acquittement la fait progresser)", async () => {
    const { service, repo, invoicesRepo, port } = build({
      findResumable: vi.fn().mockResolvedValue({
        id: 'tr-x',
        status: 'transmitted',
        resumable: true,
      }),
    })
    await service.transmitStatus(
      't1',
      'inv-1',
      'deposee',
      'ppf',
      '20260716120000',
    )
    expect(invoicesRepo.loadCanonical).not.toHaveBeenCalled()
    expect(repo.insertTransmission).not.toHaveBeenCalled()
    expect(port.transmit).not.toHaveBeenCalled()
  })

  it("RESUME (parked -> résolution désormais réussie) : réutilise l'id existant, transmit -> markTransmitted, PAS de second insertTransmission minimal", async () => {
    const { service, repo, annuaire, port } = build({
      findResumable: vi.fn().mockResolvedValue({
        id: 'tr-parked',
        status: 'parked',
        resumable: true,
      }),
    })
    await service.transmitStatus(
      't1',
      'inv-1',
      'deposee',
      'recipient',
      '20260716120000',
    )
    expect(annuaire.resolveRecipient).toHaveBeenCalledTimes(1)
    expect(repo.insertTransmission).toHaveBeenCalledTimes(1)
    expect(repo.insertTransmission.mock.calls[0]![1].recipientMatricule).toBe(
      '0042',
    )
    expect(port.transmit).toHaveBeenCalledTimes(1)
    // Injection revue T6 (F1/F2, PROUVÉ ici) : la REPRISE persiste enfin
    // xml+recipientMatricule via markTransmitted — insertTransmission (rejeu,
    // created:false) ne les a PAS écrits (conflit -> reload seul).
    expect(repo.markTransmitted).toHaveBeenCalledWith(
      't1',
      'tr-1', // id renvoyé par insertTransmission (created:false, reload) — cf. fakeRepo
      'TRACK-1',
      { xml: expect.any(String), recipientMatricule: '0042' },
    )
  })

  it('PARKED (RecipientUnaddressableError) : insertTransmission minimal (sans xml) puis markParked(motif), port JAMAIS appelé', async () => {
    const { service, repo, port } = build(
      {},
      {
        resolveRecipient: vi
          .fn()
          .mockRejectedValue(
            new RecipientUnaddressableError({ siren: '222222222' }, '20260716'),
          ),
      },
    )
    await service.transmitStatus(
      't1',
      'inv-1',
      'deposee',
      'recipient',
      '20260716120000',
    )
    expect(repo.insertTransmission).toHaveBeenCalledTimes(1)
    const arg = repo.insertTransmission.mock.calls[0]![1]
    expect(arg.xml).toBeUndefined()
    expect(repo.markParked).toHaveBeenCalledWith(
      't1',
      'tr-1',
      expect.stringContaining('non adressable'),
    )
    expect(port.transmit).not.toHaveBeenCalled()
  })

  it('PARKED (AmbiguousResolutionError) : idem, markParked(motif) avec le message de désambiguïsation', async () => {
    const { service, repo, port } = build(
      {},
      {
        resolveRecipient: vi
          .fn()
          .mockRejectedValue(
            new AmbiguousResolutionError({ siren: '222222222' }, '20260716'),
          ),
      },
    )
    await service.transmitStatus(
      't1',
      'inv-1',
      'deposee',
      'recipient',
      '20260716120000',
    )
    expect(repo.markParked).toHaveBeenCalledWith(
      't1',
      'tr-1',
      expect.stringContaining('indéterminée'),
    )
    expect(port.transmit).not.toHaveBeenCalled()
  })

  it('PARKED (buyer sans SIREN/SIRET, A4) : markParked SANS jamais appeler resolveRecipient (maille non constructible)', async () => {
    const { service, repo, annuaire, port, invoicesRepo } = build(
      {},
      {},
      {
        loadCanonical: vi.fn().mockResolvedValue(
          fakeInvoice({
            buyer: { name: 'x', address: { countryCode: 'FR' } },
          }),
        ),
      },
    )
    await service.transmitStatus(
      't1',
      'inv-1',
      'deposee',
      'recipient',
      '20260716120000',
    )
    expect(annuaire.resolveRecipient).not.toHaveBeenCalled()
    expect(repo.markParked).toHaveBeenCalledWith(
      't1',
      'tr-1',
      expect.stringContaining('BT-30/BT-47'),
    )
    expect(port.transmit).not.toHaveBeenCalled()
    void invoicesRepo
  })

  it("déjà 'parked' et la résolution échoue TOUJOURS : NO-OP (pas de second markParked, hors ALLOWED)", async () => {
    const { service, repo, annuaire } = build(
      {
        findResumable: vi.fn().mockResolvedValue({
          id: 'tr-parked',
          status: 'parked',
          resumable: true,
        }),
      },
      {
        resolveRecipient: vi
          .fn()
          .mockRejectedValue(
            new RecipientUnaddressableError({ siren: '222222222' }, '20260716'),
          ),
      },
    )
    await service.transmitStatus(
      't1',
      'inv-1',
      'deposee',
      'recipient',
      '20260716120000',
    )
    expect(annuaire.resolveRecipient).toHaveBeenCalledTimes(1)
    expect(repo.insertTransmission).not.toHaveBeenCalled()
    expect(repo.markParked).not.toHaveBeenCalled()
  })

  it('F6 structurellement invalide : appendStatusEvent(prepared, rejected, platform, f6-invalide), port JAMAIS appelé', async () => {
    mockValidate.mockReturnValue({ valid: false, errors: 'MDT-105 absent' })
    const { service, repo, port } = build()
    await service.transmitStatus(
      't1',
      'inv-1',
      'deposee',
      'ppf',
      '20260716120000',
    )
    expect(repo.appendStatusEvent).toHaveBeenCalledWith(
      't1',
      'tr-1',
      'prepared',
      'rejected',
      'platform',
      'f6-invalide',
    )
    expect(port.transmit).not.toHaveBeenCalled()
    expect(repo.markTransmitted).not.toHaveBeenCalled()
  })

  it("F6 invalide en reprise depuis 'parked' : appendStatusEvent part de 'parked' (pas 'prepared')", async () => {
    mockValidate.mockReturnValue({ valid: false, errors: 'boom' })
    const { service, repo } = build({
      findResumable: vi.fn().mockResolvedValue({
        id: 'tr-parked',
        status: 'parked',
        resumable: true,
      }),
    })
    await service.transmitStatus(
      't1',
      'inv-1',
      'deposee',
      'ppf',
      '20260716120000',
    )
    expect(repo.appendStatusEvent).toHaveBeenCalledWith(
      't1',
      'tr-1',
      'parked',
      'rejected',
      'platform',
      'f6-invalide',
    )
  })

  it("erreur d'outillage à la résolution (annuaire, non typée) : PROPAGÉE, jamais park", async () => {
    const { service, repo } = build(
      {},
      {
        resolveRecipient: vi.fn().mockRejectedValue(new Error('annuaire down')),
      },
    )
    await expect(
      service.transmitStatus(
        't1',
        'inv-1',
        'deposee',
        'recipient',
        '20260716120000',
      ),
    ).rejects.toThrow('annuaire down')
    expect(repo.markParked).not.toHaveBeenCalled()
  })

  it("erreur d'outillage au transport (port.transmit) : PROPAGÉE (throw -> retry), markTransmitted jamais appelé", async () => {
    const { service, repo } = build(
      {},
      {},
      {},
      {
        transmit: vi.fn().mockRejectedValue(new Error('ENOSPC')),
      },
    )
    await expect(
      service.transmitStatus('t1', 'inv-1', 'deposee', 'ppf', '20260716120000'),
    ).rejects.toThrow('ENOSPC')
    expect(repo.markTransmitted).not.toHaveBeenCalled()
  })

  it('CAS périmé sur markTransmitted (concurrent) : capturé, no-op, transmitStatus ne lève pas', async () => {
    const { service, repo } = build({
      markTransmitted: vi
        .fn()
        .mockRejectedValue(
          new Error(
            "transmission tr-1 is not in 'prepared' or 'parked' status",
          ),
        ),
    })
    await expect(
      service.transmitStatus('t1', 'inv-1', 'deposee', 'ppf', '20260716120000'),
    ).resolves.toBeUndefined()
    expect(repo.markTransmitted).toHaveBeenCalledTimes(1)
  })

  it('CAS périmé sur markParked (concurrent) : capturé, no-op, transmitStatus ne lève pas', async () => {
    const { service, repo } = build(
      {
        markParked: vi
          .fn()
          .mockRejectedValue(
            new Error("transmission tr-1 is not in 'prepared' status"),
          ),
      },
      {
        resolveRecipient: vi
          .fn()
          .mockRejectedValue(
            new RecipientUnaddressableError({ siren: '222222222' }, '20260716'),
          ),
      },
    )
    await expect(
      service.transmitStatus(
        't1',
        'inv-1',
        'deposee',
        'recipient',
        '20260716120000',
      ),
    ).resolves.toBeUndefined()
    expect(repo.markParked).toHaveBeenCalledTimes(1)
  })

  it('facture disparue (loadCanonical -> null) : no-op idempotent, aucune écriture', async () => {
    const { service, repo, annuaire, port } = build(
      {},
      {},
      {
        loadCanonical: vi.fn().mockResolvedValue(null),
      },
    )
    await service.transmitStatus(
      't1',
      'inv-1',
      'deposee',
      'ppf',
      '20260716120000',
    )
    expect(annuaire.resolveRecipient).not.toHaveBeenCalled()
    expect(repo.insertTransmission).not.toHaveBeenCalled()
    expect(port.transmit).not.toHaveBeenCalled()
  })
})
