import { ConflictException, NotFoundException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type {
  DeclarantSummary,
  InitialTransmissionSummary,
} from '../../src/ereporting/ereporting.repository.js'
import { EreportingRetransmissionService } from '../../src/ereporting/ereporting-retransmission.service.js'

// Garde-fous D4 (+ amendement M-D4-1) du service de retransmission — mocks
// PURS (repo/queue), oracle INDÉPENDANT : le `transmissionRef` attendu est
// calculé À LA MAIN (jamais en rappelant buildTransmissionRef), motif
// tests/unit/build-transmission-ref.test.ts (Task 1).
const DECLARANT_ID = '11111111-2222-3333-4444-555555555555'
const OTHER_TENANT_DECLARANT_ID = '99999999-8888-7777-6666-555555555555'

function declarant(over: Partial<DeclarantSummary> = {}): DeclarantSummary {
  return {
    id: DECLARANT_ID,
    siren: '611111111',
    name: 'Déclarant e2e',
    role: 'SE',
    vatRegime: 'reel_normal_mensuel',
    active: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  }
}

function initialTransmission(
  over: Partial<InitialTransmissionSummary> = {},
): InitialTransmissionSummary {
  return {
    id: 'in-1',
    status: 'transmitted',
    periodEnd: '20260910',
    ...over,
  }
}

function build({
  declarantRow = declarant(),
  initialRow = initialTransmission(),
  reSeq = 0,
}: {
  declarantRow?: DeclarantSummary | null
  initialRow?: InitialTransmissionSummary | null
  reSeq?: number
} = {}) {
  const repo = {
    findDeclarant: vi.fn().mockResolvedValue(declarantRow),
    findInitialTransmission: vi.fn().mockResolvedValue(initialRow),
    countRetransmissions: vi.fn().mockResolvedValue(reSeq),
  }
  // Simule le comportement RÉEL de EreportingGenerationQueue.enqueueRetransmission
  // (jobId dérivé DÉTERMINISTE de l'input, séparateur `-`, motif NIT-2) —
  // suffisant pour prouver l'anti-double-clic AU NIVEAU DU SERVICE (deux
  // appels lisant le même reSeq produisent le même jobId), sans dépendre de
  // BullMQ (couvert par l'e2e enfilement, Task 2 Step 4).
  const queue = {
    enqueueRetransmission: vi
      .fn()
      .mockImplementation(
        (input: {
          declarantId: string
          fluxKind: string
          periodStart: string
          reSeq: number
        }) =>
          Promise.resolve(
            `${input.declarantId}-${input.fluxKind}-${input.periodStart}-RE-${input.reSeq}`,
          ),
      ),
  }
  const service = new EreportingRetransmissionService(
    repo as never,
    queue as never,
  )
  return { service, repo, queue }
}

const TENANT_ID = 'tenant-1'
const INPUT = {
  declarantId: DECLARANT_ID,
  fluxKind: 'transactions' as const,
  periodStart: '20260901',
}

describe('EreportingRetransmissionService.retransmit', () => {
  it('déclarant inconnu (ou cross-tenant) → NotFoundException (404), aucune enfilée', async () => {
    const { service, repo, queue } = build({ declarantRow: null })

    await expect(
      service.retransmit(TENANT_ID, {
        ...INPUT,
        declarantId: OTHER_TENANT_DECLARANT_ID,
      }),
    ).rejects.toBeInstanceOf(NotFoundException)

    expect(repo.findInitialTransmission).not.toHaveBeenCalled()
    expect(repo.countRetransmissions).not.toHaveBeenCalled()
    expect(queue.enqueueRetransmission).not.toHaveBeenCalled()
  })

  it('aucun IN préalable pour (déclarant,flux,période) → ConflictException (409), aucune enfilée', async () => {
    const { service, repo, queue } = build({ initialRow: null })

    await expect(service.retransmit(TENANT_ID, INPUT)).rejects.toBeInstanceOf(
      ConflictException,
    )

    expect(repo.countRetransmissions).not.toHaveBeenCalled()
    expect(queue.enqueueRetransmission).not.toHaveBeenCalled()
  })

  it("IN encore en statut 'prepared' → 409, MÊME CORPS que l'absence d'IN (amendement M-D4-1)", async () => {
    const { service: serviceNoIn } = build({ initialRow: null })
    const { service: servicePrepared, queue } = build({
      initialRow: initialTransmission({ status: 'prepared' }),
    })

    const noInError: ConflictException = await serviceNoIn
      .retransmit(TENANT_ID, INPUT)
      .catch((e) => e)
    const preparedError: ConflictException = await servicePrepared
      .retransmit(TENANT_ID, INPUT)
      .catch((e) => e)

    expect(preparedError).toBeInstanceOf(ConflictException)
    expect(preparedError.getResponse()).toEqual(noInError.getResponse())
    expect(queue.enqueueRetransmission).not.toHaveBeenCalled()
  })

  it("nominal → reSeq=count(RE), enqueueRetransmission avec periodEnd REPRIS DE L'IN (jamais du client), type=RE", async () => {
    const { service, repo, queue } = build({
      initialRow: initialTransmission({
        status: 'deposee',
        periodEnd: '20260910',
      }),
      reSeq: 2,
    })

    const result = await service.retransmit(TENANT_ID, INPUT)

    expect(repo.countRetransmissions).toHaveBeenCalledWith(
      TENANT_ID,
      INPUT.declarantId,
      INPUT.fluxKind,
      INPUT.periodStart,
    )
    expect(queue.enqueueRetransmission).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      declarantId: INPUT.declarantId,
      siren: '611111111',
      role: 'SE',
      fluxKind: INPUT.fluxKind,
      periodStart: INPUT.periodStart,
      periodEnd: '20260910',
      reSeq: 2,
    })
    // Oracle indépendant (calculé à la main, pas via buildTransmissionRef).
    expect(result).toEqual({
      jobId: `${DECLARANT_ID}-transactions-20260901-RE-2`,
      transmissionRef: 'ER-11111111-20260901-RE-2',
    })
  })

  it('déclarant INACTIF MAIS IN préalable existe → autorisé (active NON exigé, D4)', async () => {
    const { service, queue } = build({
      declarantRow: declarant({ active: false }),
    })

    await expect(service.retransmit(TENANT_ID, INPUT)).resolves.toBeDefined()
    expect(queue.enqueueRetransmission).toHaveBeenCalledTimes(1)
  })

  it('anti-double-clic : deux appels concurrents lisant le MÊME reSeq → même jobId (dédup au niveau file)', async () => {
    const { service } = build({ reSeq: 0 })

    const [first, second] = await Promise.all([
      service.retransmit(TENANT_ID, INPUT),
      service.retransmit(TENANT_ID, INPUT),
    ])

    expect(first.jobId).toBe(second.jobId)
    expect(first.transmissionRef).toBe(second.transmissionRef)
  })
})
