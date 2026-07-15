import { describe, expect, it, vi } from 'vitest'
import type { InvoicesRepository } from '../../src/invoices/invoices.repository.js'
import type { LedgerVerificationService } from '../../src/ledger/ledger-verification.service.js'
import { PafService } from '../../src/ledger/paf.service.js'

const TENANT = 'tenant-1'
const INVOICE = 'invoice-1'

function fakeRepo() {
  return {
    getLifecycleStatus: vi.fn(),
    loadSealedEventsByInvoice: vi.fn(),
    findArchiveState: vi.fn(),
  }
}

function fakeVerification() {
  return {
    verifyInvoiceEvents: vi.fn(),
    verifyTenantChain: vi.fn(),
  }
}

describe('PafService.buildPaf', () => {
  it('returns null (→ 404 upstream) when the invoice is unknown in this tenant, without loading events/archive/verifying', async () => {
    const repo = fakeRepo()
    const verification = fakeVerification()
    repo.getLifecycleStatus.mockResolvedValue(null)
    const service = new PafService(
      repo as unknown as InvoicesRepository,
      verification as unknown as LedgerVerificationService,
    )

    const result = await service.buildPaf(TENANT, INVOICE)

    expect(result).toBeNull()
    expect(repo.loadSealedEventsByInvoice).not.toHaveBeenCalled()
    expect(repo.findArchiveState).not.toHaveBeenCalled()
    expect(verification.verifyInvoiceEvents).not.toHaveBeenCalled()
    expect(verification.verifyTenantChain).not.toHaveBeenCalled()
  })

  it('builds a PafDocument with lifecycleStatus, integrity, chainIntegrity, archive and hex-serialized events (no probative id leak)', async () => {
    const repo = fakeRepo()
    const verification = fakeVerification()
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
    repo.findArchiveState.mockResolvedValue({
      status: 'archived',
      location: 'tenant-1/invoice-1/v1.bundle.json',
      hash: 'deadbeef',
    })
    verification.verifyInvoiceEvents.mockResolvedValue({
      valid: true,
      length: 1,
    })
    verification.verifyTenantChain.mockResolvedValue({
      valid: true,
      length: 1,
    })
    const service = new PafService(
      repo as unknown as InvoicesRepository,
      verification as unknown as LedgerVerificationService,
    )

    const result = await service.buildPaf(TENANT, INVOICE)

    expect(repo.getLifecycleStatus).toHaveBeenCalledWith(TENANT, INVOICE)
    expect(repo.loadSealedEventsByInvoice).toHaveBeenCalledWith(TENANT, INVOICE)
    expect(repo.findArchiveState).toHaveBeenCalledWith(TENANT, INVOICE)
    expect(verification.verifyInvoiceEvents).toHaveBeenCalledWith(
      TENANT,
      INVOICE,
    )
    expect(verification.verifyTenantChain).toHaveBeenCalledWith(TENANT)
    expect(result).toEqual({
      invoiceId: INVOICE,
      lifecycleStatus: 'deposee',
      integrity: { valid: true, length: 1 },
      chainIntegrity: { valid: true, length: 1 },
      archive: {
        status: 'archived',
        location: 'tenant-1/invoice-1/v1.bundle.json',
        hash: 'deadbeef',
      },
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
    })
    expect(result?.events[0]).not.toHaveProperty('id')
  })

  it('defaults archive to {status:"pending", location:null, hash:null} when no archive row exists yet', async () => {
    const repo = fakeRepo()
    const verification = fakeVerification()
    repo.getLifecycleStatus.mockResolvedValue('deposee')
    repo.loadSealedEventsByInvoice.mockResolvedValue([])
    repo.findArchiveState.mockResolvedValue(null)
    verification.verifyInvoiceEvents.mockResolvedValue({
      valid: true,
      length: 0,
    })
    verification.verifyTenantChain.mockResolvedValue({
      valid: true,
      length: 0,
    })
    const service = new PafService(
      repo as unknown as InvoicesRepository,
      verification as unknown as LedgerVerificationService,
    )

    const result = await service.buildPaf(TENANT, INVOICE)

    expect(result?.archive).toEqual({
      status: 'pending',
      location: null,
      hash: null,
    })
  })

  it('surfaces chainIntegrity:false (seq-gap) even while the per-invoice integrity self-check stays valid', async () => {
    const repo = fakeRepo()
    const verification = fakeVerification()
    repo.getLifecycleStatus.mockResolvedValue('deposee')
    repo.loadSealedEventsByInvoice.mockResolvedValue([])
    repo.findArchiveState.mockResolvedValue(null)
    verification.verifyInvoiceEvents.mockResolvedValue({
      valid: true,
      length: 1,
    })
    verification.verifyTenantChain.mockResolvedValue({
      valid: false,
      brokenAtSeq: 3,
      reason: 'seq-gap',
    })
    const service = new PafService(
      repo as unknown as InvoicesRepository,
      verification as unknown as LedgerVerificationService,
    )

    const result = await service.buildPaf(TENANT, INVOICE)

    expect(result?.integrity).toEqual({ valid: true, length: 1 })
    expect(result?.chainIntegrity).toEqual({
      valid: false,
      brokenAtSeq: 3,
      reason: 'seq-gap',
    })
  })
})
