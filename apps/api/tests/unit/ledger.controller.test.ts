import { NotFoundException } from '@nestjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InvoicesRepository } from '../../src/invoices/invoices.repository.js'
import { LedgerController } from '../../src/ledger/ledger.controller.js'
import type { LedgerVerificationService } from '../../src/ledger/ledger-verification.service.js'
import type { PafDocument } from '../../src/ledger/paf.js'
import type { PafService } from '../../src/ledger/paf.service.js'

const TENANT = 'tenant-1'
const INVOICE = 'invoice-1'

function fakeRepo() {
  return {
    getLifecycleStatus: vi.fn(),
    loadSealedEventsByInvoice: vi.fn(),
  }
}

function fakeVerification() {
  return {
    verifyInvoiceEvents: vi.fn(),
    verifyTenantChain: vi.fn(),
  }
}

function fakePafService() {
  return {
    buildPaf: vi.fn(),
  }
}

describe('LedgerController.ledger', () => {
  let repo: ReturnType<typeof fakeRepo>
  let verification: ReturnType<typeof fakeVerification>
  let paf: ReturnType<typeof fakePafService>
  let controller: LedgerController

  beforeEach(() => {
    repo = fakeRepo()
    verification = fakeVerification()
    paf = fakePafService()
    controller = new LedgerController(
      repo as unknown as InvoicesRepository,
      verification as unknown as LedgerVerificationService,
      paf as unknown as PafService,
    )
  })

  it('404s (anti-leak) when the invoice is unknown in this tenant, without loading events or verifying', async () => {
    repo.getLifecycleStatus.mockResolvedValue(null)

    await expect(controller.ledger(TENANT, INVOICE)).rejects.toBeInstanceOf(
      NotFoundException,
    )
    expect(repo.loadSealedEventsByInvoice).not.toHaveBeenCalled()
    expect(verification.verifyInvoiceEvents).not.toHaveBeenCalled()
    expect(verification.verifyTenantChain).not.toHaveBeenCalled()
  })

  it('returns { invoiceId, events, integrity, chainIntegrity } with hex-serialized hashes and no probative id leak', async () => {
    repo.getLifecycleStatus.mockResolvedValue('deposee')
    const createdAt = new Date('2026-07-14T10:00:00.000Z')
    repo.loadSealedEventsByInvoice.mockResolvedValue([
      {
        seq: 1,
        invoiceId: INVOICE,
        fromStatus: null,
        toStatus: 'deposee',
        actor: 'platform',
        reason: null,
        createdAt,
        prevHash: Buffer.from('aa'.repeat(32), 'hex'),
        hash: Buffer.from('bb'.repeat(32), 'hex'),
      },
    ])
    verification.verifyInvoiceEvents.mockResolvedValue({
      valid: true,
      length: 1,
    })
    verification.verifyTenantChain.mockResolvedValue({
      valid: true,
      length: 1,
    })

    const result = await controller.ledger(TENANT, INVOICE)

    expect(repo.getLifecycleStatus).toHaveBeenCalledWith(TENANT, INVOICE)
    expect(repo.loadSealedEventsByInvoice).toHaveBeenCalledWith(TENANT, INVOICE)
    expect(verification.verifyInvoiceEvents).toHaveBeenCalledWith(
      TENANT,
      INVOICE,
    )
    expect(verification.verifyTenantChain).toHaveBeenCalledWith(TENANT)
    expect(result).toEqual({
      invoiceId: INVOICE,
      events: [
        {
          seq: 1,
          fromStatus: null,
          toStatus: 'deposee',
          actor: 'platform',
          reason: null,
          createdAt: createdAt.toISOString(),
          prevHash: 'aa'.repeat(32),
          hash: 'bb'.repeat(32),
        },
      ],
      integrity: { valid: true, length: 1 },
      chainIntegrity: { valid: true, length: 1 },
    })
    // Identité probative = (tenant_id, seq) : le PK surrogate `id` reste HORS
    // périmètre — jamais sérialisé dans la réponse d'un événement.
    expect(result.events[0]).not.toHaveProperty('id')
  })

  it('surfaces chainIntegrity:false (seq-gap) even while the per-invoice integrity self-check stays valid', async () => {
    // Le contraste qui justifie l'amendement : la suppression d'un maillon
    // TIERS (une autre facture du même tenant) laisse l'auto-check de CETTE
    // facture valide (son propre prev_hash stocké reste intact), mais casse
    // la contiguïté globale de la chaîne du tenant.
    repo.getLifecycleStatus.mockResolvedValue('deposee')
    repo.loadSealedEventsByInvoice.mockResolvedValue([])
    verification.verifyInvoiceEvents.mockResolvedValue({
      valid: true,
      length: 1,
    })
    verification.verifyTenantChain.mockResolvedValue({
      valid: false,
      brokenAtSeq: 3,
      reason: 'seq-gap',
    })

    const result = await controller.ledger(TENANT, INVOICE)

    expect(result.integrity).toEqual({ valid: true, length: 1 })
    expect(result.chainIntegrity).toEqual({
      valid: false,
      brokenAtSeq: 3,
      reason: 'seq-gap',
    })
  })

  it('serializes an event with a non-null fromStatus/reason unchanged', async () => {
    repo.getLifecycleStatus.mockResolvedValue('emise')
    const createdAt = new Date('2026-07-14T11:00:00.000Z')
    repo.loadSealedEventsByInvoice.mockResolvedValue([
      {
        seq: 2,
        invoiceId: INVOICE,
        fromStatus: 'deposee',
        toStatus: 'emise',
        actor: 'user:x',
        reason: 'transmission',
        createdAt,
        prevHash: Buffer.from('cc'.repeat(32), 'hex'),
        hash: Buffer.from('dd'.repeat(32), 'hex'),
      },
    ])
    verification.verifyInvoiceEvents.mockResolvedValue({
      valid: true,
      length: 1,
    })
    verification.verifyTenantChain.mockResolvedValue({
      valid: true,
      length: 2,
    })

    const result = await controller.ledger(TENANT, INVOICE)

    expect(result.events[0]).toEqual({
      seq: 2,
      fromStatus: 'deposee',
      toStatus: 'emise',
      actor: 'user:x',
      reason: 'transmission',
      createdAt: createdAt.toISOString(),
      prevHash: 'cc'.repeat(32),
      hash: 'dd'.repeat(32),
    })
  })
})

function fakeResponse() {
  return {
    type: vi.fn(),
    setHeader: vi.fn(),
    send: vi.fn(),
    json: vi.fn(),
  }
}

describe('LedgerController.paf', () => {
  let repo: ReturnType<typeof fakeRepo>
  let verification: ReturnType<typeof fakeVerification>
  let paf: ReturnType<typeof fakePafService>
  let controller: LedgerController

  beforeEach(() => {
    repo = fakeRepo()
    verification = fakeVerification()
    paf = fakePafService()
    controller = new LedgerController(
      repo as unknown as InvoicesRepository,
      verification as unknown as LedgerVerificationService,
      paf as unknown as PafService,
    )
  })

  const doc: PafDocument = {
    invoiceId: INVOICE,
    lifecycleStatus: 'deposee',
    integrity: { valid: true, length: 1 },
    chainIntegrity: { valid: true, length: 1 },
    archive: { status: 'pending', location: null, hash: null },
    events: [],
  }

  it('404s (anti-leak) when the invoice is unknown in this tenant, before touching the response', async () => {
    paf.buildPaf.mockResolvedValue(null)
    const res = fakeResponse()

    await expect(
      controller.paf(TENANT, INVOICE, undefined, res as never),
    ).rejects.toBeInstanceOf(NotFoundException)
    expect(res.json).not.toHaveBeenCalled()
    expect(res.send).not.toHaveBeenCalled()
  })

  it('responds with the JSON document by default (no format query)', async () => {
    paf.buildPaf.mockResolvedValue(doc)
    const res = fakeResponse()

    await controller.paf(TENANT, INVOICE, undefined, res as never)

    expect(paf.buildPaf).toHaveBeenCalledWith(TENANT, INVOICE)
    expect(res.json).toHaveBeenCalledWith(doc)
    expect(res.send).not.toHaveBeenCalled()
  })

  it('responds with a text/csv attachment when format=csv', async () => {
    paf.buildPaf.mockResolvedValue(doc)
    const res = fakeResponse()

    await controller.paf(TENANT, INVOICE, 'csv', res as never)

    expect(res.type).toHaveBeenCalledWith('text/csv')
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      `attachment; filename="paf-${INVOICE}.csv"`,
    )
    expect(res.send).toHaveBeenCalledWith(
      'seq,from_status,to_status,actor,reason,created_at,prev_hash,hash\n',
    )
    expect(res.json).not.toHaveBeenCalled()
  })
})
