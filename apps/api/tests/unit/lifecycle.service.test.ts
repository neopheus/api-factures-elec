import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LifecycleService } from '../../src/invoices/lifecycle.service.js'

function fakeRepo() {
  return {
    getLifecycleStatus: vi.fn(),
    recordTransition: vi.fn(),
    listStatusEvents: vi.fn(),
  }
}

const VALID_ID = '11111111-1111-1111-1111-111111111111'

describe('LifecycleService.transition', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects a non-uuid invoice id with 404, without ever hitting the repository', async () => {
    const repo = fakeRepo()
    const service = new LifecycleService(repo as never)

    await expect(
      service.transition(
        'tenant-1',
        'not-a-uuid',
        'approuvee',
        'user:1',
        undefined,
      ),
    ).rejects.toMatchObject(
      new NotFoundException(
        expect.objectContaining({
          status: 404,
          type: 'urn:factelec:problem:not-found',
        }),
      ),
    )
    expect(repo.getLifecycleStatus).not.toHaveBeenCalled()
  })

  it('maps a missing invoice (getLifecycleStatus → null, RLS/tenant isolation) to 404', async () => {
    const repo = fakeRepo()
    repo.getLifecycleStatus.mockResolvedValue(null)
    const service = new LifecycleService(repo as never)

    await expect(
      service.transition(
        'tenant-1',
        VALID_ID,
        'approuvee',
        'user:1',
        undefined,
      ),
    ).rejects.toMatchObject(
      new NotFoundException(
        expect.objectContaining({
          status: 404,
          type: 'urn:factelec:problem:not-found',
        }),
      ),
    )
    expect(repo.recordTransition).not.toHaveBeenCalled()
  })

  it('rejects a disallowed transition (state machine) with 422 invalidTransition, naming from/to', async () => {
    const repo = fakeRepo()
    repo.getLifecycleStatus.mockResolvedValue('approuvee')
    const service = new LifecycleService(repo as never)

    await expect(
      service.transition('tenant-1', VALID_ID, 'deposee', 'user:1', undefined),
    ).rejects.toMatchObject(
      new UnprocessableEntityException(
        expect.objectContaining({
          status: 422,
          type: 'urn:factelec:problem:invalid-status-transition',
          detail: expect.stringContaining('approuvee'),
        }),
      ),
    )
    expect(repo.recordTransition).not.toHaveBeenCalled()
  })

  it('requires a non-empty reason for refusee (G7.25) → 422 validation without one', async () => {
    const repo = fakeRepo()
    repo.getLifecycleStatus.mockResolvedValue('deposee')
    const service = new LifecycleService(repo as never)

    await expect(
      service.transition('tenant-1', VALID_ID, 'refusee', 'user:1', undefined),
    ).rejects.toMatchObject(
      new UnprocessableEntityException(
        expect.objectContaining({
          status: 422,
          type: 'urn:factelec:problem:validation-error',
          errors: [
            { path: 'reason', message: expect.stringContaining('refusee') },
          ],
        }),
      ),
    )
    expect(repo.recordTransition).not.toHaveBeenCalled()
  })

  it('treats a whitespace-only reason as missing → 422 validation', async () => {
    const repo = fakeRepo()
    repo.getLifecycleStatus.mockResolvedValue('deposee')
    const service = new LifecycleService(repo as never)

    await expect(
      service.transition('tenant-1', VALID_ID, 'refusee', 'user:1', '   '),
    ).rejects.toMatchObject(
      new UnprocessableEntityException(
        expect.objectContaining({ status: 422 }),
      ),
    )
    expect(repo.recordTransition).not.toHaveBeenCalled()
  })

  it('records a valid transition requiring no reason and returns the new status', async () => {
    const repo = fakeRepo()
    repo.getLifecycleStatus.mockResolvedValue('deposee')
    repo.recordTransition.mockResolvedValue(true)
    const service = new LifecycleService(repo as never)

    // deposee → prise_en_charge (DAG Task 1) : sous la matrice DAG, deposee
    // ne va plus directement à approuvee (chronologie : prise_en_charge
    // d'abord — cf. A1, plan-3-1-review.md).
    const result = await service.transition(
      'tenant-1',
      VALID_ID,
      'prise_en_charge',
      'user:1',
      undefined,
    )

    expect(result).toEqual({ status: 'prise_en_charge' })
    expect(repo.recordTransition).toHaveBeenCalledWith(
      'tenant-1',
      VALID_ID,
      'deposee',
      'prise_en_charge',
      'user:1',
      undefined,
    )
  })

  it('records a valid transition with a reason (refusee) and returns the new status', async () => {
    const repo = fakeRepo()
    repo.getLifecycleStatus.mockResolvedValue('deposee')
    repo.recordTransition.mockResolvedValue(true)
    const service = new LifecycleService(repo as never)

    const result = await service.transition(
      'tenant-1',
      VALID_ID,
      'refusee',
      'user:1',
      'destinataire inconnu',
    )

    expect(result).toEqual({ status: 'refusee' })
    expect(repo.recordTransition).toHaveBeenCalledWith(
      'tenant-1',
      VALID_ID,
      'deposee',
      'refusee',
      'user:1',
      'destinataire inconnu',
    )
  })

  it('maps a lost CAS race (recordTransition → false) to 409 conflict', async () => {
    const repo = fakeRepo()
    repo.getLifecycleStatus.mockResolvedValue('deposee')
    repo.recordTransition.mockResolvedValue(false)
    const service = new LifecycleService(repo as never)

    // deposee → prise_en_charge (DAG Task 1, cf. commentaire ci-dessus).
    await expect(
      service.transition(
        'tenant-1',
        VALID_ID,
        'prise_en_charge',
        'user:1',
        undefined,
      ),
    ).rejects.toMatchObject(
      new ConflictException(
        expect.objectContaining({
          status: 409,
          type: 'urn:factelec:problem:conflict',
        }),
      ),
    )
  })
})

describe('LifecycleService.history', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects a non-uuid invoice id with 404, without ever hitting the repository', async () => {
    const repo = fakeRepo()
    const service = new LifecycleService(repo as never)

    await expect(
      service.history('tenant-1', 'not-a-uuid'),
    ).rejects.toMatchObject(
      new NotFoundException(expect.objectContaining({ status: 404 })),
    )
    expect(repo.getLifecycleStatus).not.toHaveBeenCalled()
  })

  it('maps a missing invoice to 404', async () => {
    const repo = fakeRepo()
    repo.getLifecycleStatus.mockResolvedValue(null)
    const service = new LifecycleService(repo as never)

    await expect(service.history('tenant-1', VALID_ID)).rejects.toMatchObject(
      new NotFoundException(expect.objectContaining({ status: 404 })),
    )
    expect(repo.listStatusEvents).not.toHaveBeenCalled()
  })

  it('returns the current status and the ordered events', async () => {
    const repo = fakeRepo()
    repo.getLifecycleStatus.mockResolvedValue('approuvee')
    const events = [
      {
        fromStatus: null,
        toStatus: 'deposee',
        actor: 'platform',
        reason: null,
        createdAt: new Date(),
      },
      {
        fromStatus: 'deposee',
        toStatus: 'approuvee',
        actor: 'user:1',
        reason: null,
        createdAt: new Date(),
      },
    ]
    repo.listStatusEvents.mockResolvedValue(events)
    const service = new LifecycleService(repo as never)

    const result = await service.history('tenant-1', VALID_ID)

    expect(result).toEqual({ current: 'approuvee', events })
  })
})
