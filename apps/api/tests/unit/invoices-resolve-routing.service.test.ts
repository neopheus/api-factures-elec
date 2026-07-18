import { ConflictException, NotFoundException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import { InvoicesService } from '../../src/invoices/invoices.service.js'

// Step 1 (Task 4, plan 3.5, D6) : les 4 tests BINDING du brief, plus 2 tests
// des branches défensives (`loadCanonical`/relecture post-`resolveAndRecord`
// → null) mentionnées par D6 mais non énumérées explicitement — mêmes motif
// que le 404 défensif de `get()` (invoices.service.ts). Oracle indépendant :
// repo/routing entièrement mockés, `resolveRouting` est exercée seule.
function fakeRepo() {
  return {
    findRoutingState: vi.fn(),
    loadCanonical: vi.fn(),
  }
}
function fakeQueue() {
  return { enqueue: vi.fn() }
}
function fakeRouting() {
  return { resolveAndRecord: vi.fn() }
}

const INVOICE_ID = '11111111-1111-4111-8111-111111111111'

describe('InvoicesService.resolveRouting', () => {
  it('routing_status=ambiguous → resolveAndRecord appelé, retourne le NOUVEL état relu (findRoutingState)', async () => {
    const repo = fakeRepo()
    repo.findRoutingState
      .mockResolvedValueOnce({ status: 'ambiguous', platform: null }) // garde d'admission
      .mockResolvedValueOnce({ status: 'resolved', platform: 'PPF' }) // relecture post-resolveAndRecord
    const canonical = { number: 'FA-1' }
    repo.loadCanonical.mockResolvedValue(canonical)
    const routing = fakeRouting()
    routing.resolveAndRecord.mockResolvedValue(undefined)
    const service = new InvoicesService(
      repo as never,
      fakeQueue() as never,
      routing as never,
    )

    const result = await service.resolveRouting('tenant-1', INVOICE_ID)

    expect(routing.resolveAndRecord).toHaveBeenCalledWith(
      'tenant-1',
      INVOICE_ID,
      canonical,
    )
    expect(result).toEqual({
      invoiceId: INVOICE_ID,
      routingStatus: 'resolved',
      recipientPlatform: 'PPF',
    })
  })

  it('routing_status ≠ ambiguous (resolved/pending/unaddressable) → ConflictException 409, resolveAndRecord JAMAIS appelé', async () => {
    for (const status of ['resolved', 'pending', 'unaddressable']) {
      const repo = fakeRepo()
      repo.findRoutingState.mockResolvedValue({ status, platform: null })
      const routing = fakeRouting()
      const service = new InvoicesService(
        repo as never,
        fakeQueue() as never,
        routing as never,
      )

      await expect(
        service.resolveRouting('tenant-1', INVOICE_ID),
      ).rejects.toMatchObject(
        new ConflictException(
          expect.objectContaining({
            status: 409,
            type: 'urn:factelec:problem:conflict',
          }),
        ),
      )
      expect(routing.resolveAndRecord).not.toHaveBeenCalled()
      expect(repo.loadCanonical).not.toHaveBeenCalled()
    }
  })

  it('findRoutingState → null (inconnue/cross-tenant) → NotFoundException 404 byte-identique', async () => {
    const repo = fakeRepo()
    repo.findRoutingState.mockResolvedValue(null)
    const routing = fakeRouting()
    const service = new InvoicesService(
      repo as never,
      fakeQueue() as never,
      routing as never,
    )

    await expect(
      service.resolveRouting(
        'tenant-1',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ),
    ).rejects.toMatchObject(
      new NotFoundException(
        expect.objectContaining({
          status: 404,
          type: 'urn:factelec:problem:not-found',
        }),
      ),
    )
    expect(routing.resolveAndRecord).not.toHaveBeenCalled()
  })

  it(':id malformé (non-UUID) → 404 byte-identique (motif invoices.service.notFound)', async () => {
    const repo = fakeRepo()
    const service = new InvoicesService(
      repo as never,
      fakeQueue() as never,
      fakeRouting() as never,
    )

    await expect(
      service.resolveRouting('tenant-1', 'not-a-uuid'),
    ).rejects.toMatchObject(
      new NotFoundException(
        expect.objectContaining({
          status: 404,
          type: 'urn:factelec:problem:not-found',
        }),
      ),
    )
    expect(repo.findRoutingState).not.toHaveBeenCalled()
  })

  it('loadCanonical → null (facture disparue entre la garde et la lecture) → 404 défensif', async () => {
    const repo = fakeRepo()
    repo.findRoutingState.mockResolvedValue({
      status: 'ambiguous',
      platform: null,
    })
    repo.loadCanonical.mockResolvedValue(null)
    const routing = fakeRouting()
    const service = new InvoicesService(
      repo as never,
      fakeQueue() as never,
      routing as never,
    )

    await expect(
      service.resolveRouting('tenant-1', INVOICE_ID),
    ).rejects.toMatchObject(
      new NotFoundException(
        expect.objectContaining({
          status: 404,
          type: 'urn:factelec:problem:not-found',
        }),
      ),
    )
    expect(routing.resolveAndRecord).not.toHaveBeenCalled()
  })

  it('relecture post-resolveAndRecord → null (facture disparue pendant le best-effort) → 404 défensif', async () => {
    const repo = fakeRepo()
    repo.findRoutingState
      .mockResolvedValueOnce({ status: 'ambiguous', platform: null })
      .mockResolvedValueOnce(null)
    repo.loadCanonical.mockResolvedValue({ number: 'FA-1' })
    const routing = fakeRouting()
    routing.resolveAndRecord.mockResolvedValue(undefined)
    const service = new InvoicesService(
      repo as never,
      fakeQueue() as never,
      routing as never,
    )

    await expect(
      service.resolveRouting('tenant-1', INVOICE_ID),
    ).rejects.toMatchObject(
      new NotFoundException(
        expect.objectContaining({
          status: 404,
          type: 'urn:factelec:problem:not-found',
        }),
      ),
    )
  })
})
