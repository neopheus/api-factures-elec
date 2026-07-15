import { describe, expect, it, vi } from 'vitest'
import { ArchiveService } from '../../src/archive/archive.service.js'

function repoStub(overrides: Record<string, unknown> = {}) {
  return {
    loadCanonical: vi
      .fn()
      .mockResolvedValue({ number: 'FA-1', currency: 'EUR' }),
    loadAllFormats: vi.fn().mockResolvedValue([
      {
        kind: 'ubl',
        contentType: 'application/xml',
        bodyText: '<x/>',
        bodyBytes: null,
        byteSize: 4,
      },
    ]),
    loadSealedEventsByInvoice: vi.fn().mockResolvedValue([
      {
        seq: 1,
        invoiceId: 'i',
        fromStatus: null,
        toStatus: 'deposee',
        actor: 'platform',
        reason: null,
        createdAt: new Date('2026-07-14T00:00:00.000Z'),
        prevHash: Buffer.from('aa', 'hex'),
        hash: Buffer.from('bb', 'hex'),
      },
    ]),
    markArchiveStatus: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('ArchiveService.archiveInvoice', () => {
  it('is a no-op when the invoice vanished (idempotent)', async () => {
    const repo = repoStub({ loadCanonical: vi.fn().mockResolvedValue(null) })
    const store = { put: vi.fn(), head: vi.fn(), get: vi.fn() }
    const service = new ArchiveService(repo as never, store as never)

    await service.archiveInvoice('t', 'i')

    expect(repo.loadAllFormats).not.toHaveBeenCalled()
    expect(repo.markArchiveStatus).not.toHaveBeenCalled()
  })

  it('builds the bundle, writes it, and marks archived with the store fingerprint', async () => {
    const repo = repoStub()
    const store = {
      put: vi.fn().mockResolvedValue({
        location: '/var/archive/t/i/v1.bundle.json',
        hash: 'feed',
        bytes: 42,
        alreadyExisted: false,
      }),
      head: vi.fn().mockResolvedValue({ exists: false }),
      get: vi.fn(),
    }
    const service = new ArchiveService(repo as never, store as never)

    await service.archiveInvoice('t', 'i')

    expect(repo.loadAllFormats).toHaveBeenCalledWith('t', 'i')
    expect(repo.loadSealedEventsByInvoice).toHaveBeenCalledWith('t', 'i')
    expect(store.head).toHaveBeenCalledWith('t/i/v1.bundle.json')
    expect(store.put).toHaveBeenCalledWith(
      't/i/v1.bundle.json',
      expect.any(Buffer),
    )
    expect(repo.markArchiveStatus).toHaveBeenCalledWith(
      't',
      'i',
      'archived',
      '/var/archive/t/i/v1.bundle.json',
      'feed',
    )
  })

  it('is idempotent: when the key already exists (head), it does NOT put — marks archived from the existing fingerprint', async () => {
    const repo = repoStub()
    const store = {
      put: vi.fn(),
      head: vi
        .fn()
        .mockResolvedValue({ exists: true, hash: 'existing-hash', bytes: 10 }),
      get: vi.fn(),
    }
    const service = new ArchiveService(repo as never, store as never)

    await service.archiveInvoice('t', 'i')

    expect(store.put).not.toHaveBeenCalled()
    expect(repo.markArchiveStatus).toHaveBeenCalledWith(
      't',
      'i',
      'archived',
      't/i/v1.bundle.json',
      'existing-hash',
    )
  })

  it('BEST-EFFORT: never throws when the store fails — marks failed instead', async () => {
    const repo = repoStub()
    const store = {
      put: vi.fn().mockRejectedValue(new Error('archive down')),
      head: vi.fn().mockResolvedValue({ exists: false }),
      get: vi.fn(),
    }
    const service = new ArchiveService(repo as never, store as never)

    await expect(service.archiveInvoice('t', 'i')).resolves.toBeUndefined()

    expect(repo.markArchiveStatus).toHaveBeenCalledWith('t', 'i', 'failed')
  })

  it('BEST-EFFORT: never throws even when marking failed also fails (logs, swallows)', async () => {
    const repo = repoStub({
      markArchiveStatus: vi.fn().mockRejectedValue(new Error('db down')),
    })
    const store = {
      put: vi.fn().mockRejectedValue(new Error('archive down')),
      head: vi.fn().mockResolvedValue({ exists: false }),
      get: vi.fn(),
    }
    const service = new ArchiveService(repo as never, store as never)

    await expect(service.archiveInvoice('t', 'i')).resolves.toBeUndefined()
  })

  it('BEST-EFFORT: a failure while loading data (before any store call) still marks failed', async () => {
    const repo = repoStub({
      loadAllFormats: vi.fn().mockRejectedValue(new Error('db down')),
    })
    const store = { put: vi.fn(), head: vi.fn(), get: vi.fn() }
    const service = new ArchiveService(repo as never, store as never)

    await expect(service.archiveInvoice('t', 'i')).resolves.toBeUndefined()

    expect(store.put).not.toHaveBeenCalled()
    expect(repo.markArchiveStatus).toHaveBeenCalledWith('t', 'i', 'failed')
  })
})
