import type { Invoice } from '@factelec/invoice-core'
import { describe, expect, it, vi } from 'vitest'
import {
  AmbiguousResolutionError,
  RecipientUnaddressableError,
} from '../../src/annuaire/ligne-adressage.js'
import { RecipientRoutingService } from '../../src/invoices/recipient-routing.service.js'

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

function fakeAnnuaire(overrides: Record<string, unknown> = {}) {
  return {
    resolveRecipient: vi.fn().mockResolvedValue({ plateforme: '0042' }),
    ...overrides,
  }
}

function fakeRepo(overrides: Record<string, unknown> = {}) {
  return {
    markRoutingStatus: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function build(
  annuaireOverrides: Record<string, unknown> = {},
  repoOverrides: Record<string, unknown> = {},
) {
  const annuaire = fakeAnnuaire(annuaireOverrides)
  const repo = fakeRepo(repoOverrides)
  const service = new RecipientRoutingService(annuaire as never, repo as never)
  return { service, annuaire, repo }
}

// Oracle indépendant (anti-tautologie) : les attentes ci-dessous sont des
// littéraux (dates AAAAMMJJ, mailles, statuts) dérivés du plan (D4), jamais
// de la propre implémentation du service testé.
describe('RecipientRoutingService.resolveAndRecord (D2/D4, best-effort STRICT)', () => {
  it('résout → markRoutingStatus("resolved", plateforme)', async () => {
    const { service, annuaire, repo } = build()
    const invoice = fakeInvoice()

    await service.resolveAndRecord('t1', 'inv-1', invoice)

    expect(annuaire.resolveRecipient).toHaveBeenCalledWith(
      't1',
      { siren: '222222222' },
      '20260716',
    )
    expect(repo.markRoutingStatus).toHaveBeenCalledWith(
      't1',
      'inv-1',
      'resolved',
      '0042',
    )
  })

  it('RecipientUnaddressable → markRoutingStatus("unaddressable"), pas de throw', async () => {
    const { service, repo } = build({
      resolveRecipient: vi
        .fn()
        .mockRejectedValue(
          new RecipientUnaddressableError({ siren: '222222222' }, '20260716'),
        ),
    })
    const invoice = fakeInvoice()

    await expect(
      service.resolveAndRecord('t1', 'inv-1', invoice),
    ).resolves.toBeUndefined()

    expect(repo.markRoutingStatus).toHaveBeenCalledWith(
      't1',
      'inv-1',
      'unaddressable',
    )
  })

  it('Ambiguous → markRoutingStatus("ambiguous"), pas de throw', async () => {
    const { service, repo } = build({
      resolveRecipient: vi
        .fn()
        .mockRejectedValue(
          new AmbiguousResolutionError({ siren: '222222222' }, '20260716'),
        ),
    })
    const invoice = fakeInvoice()

    await expect(
      service.resolveAndRecord('t1', 'inv-1', invoice),
    ).resolves.toBeUndefined()

    expect(repo.markRoutingStatus).toHaveBeenCalledWith(
      't1',
      'inv-1',
      'ambiguous',
    )
  })

  it('BuyerIdentifierMissing → "unaddressable", pas de throw', async () => {
    const { service, annuaire, repo } = build()
    const invoice = fakeInvoice({
      buyer: { name: 'x', address: { countryCode: 'FR' } },
    })

    await expect(
      service.resolveAndRecord('t1', 'inv-1', invoice),
    ).resolves.toBeUndefined()

    expect(annuaire.resolveRecipient).not.toHaveBeenCalled()
    expect(repo.markRoutingStatus).toHaveBeenCalledWith(
      't1',
      'inv-1',
      'unaddressable',
    )
  })

  it('erreur opérationnelle (annuaire lève une erreur non typée) → log, PAS de markRoutingStatus resolved, PAS de throw', async () => {
    const { service, repo } = build({
      resolveRecipient: vi.fn().mockRejectedValue(new Error('annuaire down')),
    })
    const invoice = fakeInvoice()

    await expect(
      service.resolveAndRecord('t1', 'inv-1', invoice),
    ).resolves.toBeUndefined()

    expect(repo.markRoutingStatus).not.toHaveBeenCalled()
  })

  it("erreur opérationnelle : même l'échec de l'écriture 'unaddressable' elle-même ne fait jamais throw", async () => {
    const { service } = build(
      {
        resolveRecipient: vi
          .fn()
          .mockRejectedValue(
            new RecipientUnaddressableError({ siren: '222222222' }, '20260716'),
          ),
      },
      {
        markRoutingStatus: vi.fn().mockRejectedValue(new Error('db down')),
      },
    )
    const invoice = fakeInvoice()

    await expect(
      service.resolveAndRecord('t1', 'inv-1', invoice),
    ).resolves.toBeUndefined()
  })

  it("erreur opérationnelle : même l'échec de l'écriture 'ambiguous' elle-même ne fait jamais throw", async () => {
    const { service } = build(
      {
        resolveRecipient: vi
          .fn()
          .mockRejectedValue(
            new AmbiguousResolutionError({ siren: '222222222' }, '20260716'),
          ),
      },
      {
        markRoutingStatus: vi.fn().mockRejectedValue(new Error('db down')),
      },
    )
    const invoice = fakeInvoice()

    await expect(
      service.resolveAndRecord('t1', 'inv-1', invoice),
    ).resolves.toBeUndefined()
  })

  it('idempotent : deux appels → même écriture déterministe (aucun CAS)', async () => {
    const { service, repo } = build()
    const invoice = fakeInvoice()

    await service.resolveAndRecord('t1', 'inv-1', invoice)
    await service.resolveAndRecord('t1', 'inv-1', invoice)

    expect(repo.markRoutingStatus).toHaveBeenCalledTimes(2)
    expect(repo.markRoutingStatus).toHaveBeenNthCalledWith(
      1,
      't1',
      'inv-1',
      'resolved',
      '0042',
    )
    expect(repo.markRoutingStatus).toHaveBeenNthCalledWith(
      2,
      't1',
      'inv-1',
      'resolved',
      '0042',
    )
  })
})
