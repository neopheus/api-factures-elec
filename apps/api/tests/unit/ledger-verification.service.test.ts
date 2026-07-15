import { describe, expect, it, vi } from 'vitest'
import type {
  InvoicesRepository,
  SealedEvent,
} from '../../src/invoices/invoices.repository.js'
import {
  computeEventHash,
  genesisHash,
  type StatusEventForHash,
} from '../../src/ledger/ledger-hash.js'
import { LedgerVerificationService } from '../../src/ledger/ledger-verification.service.js'

// Construit une chaîne d'événements SCELLÉS *authentiquement valide* (même
// mécanique que le trigger DB : hash(n) = sha256(prev_hash(n) ‖ canonical(n)),
// prev_hash(1) = genesis) — sert de fixture de référence pour les tests
// positifs, et de base à altérer ponctuellement pour les tests négatifs.
function buildChain(
  tenantId: string,
  steps: Array<{
    seq: number
    invoiceId: string
    fromStatus: string | null
    toStatus: string
    actor: string
    reason: string | null
    createdAt: Date
  }>,
): SealedEvent[] {
  let prev = genesisHash(tenantId)
  return steps.map((s) => {
    const input: StatusEventForHash = {
      tenantId,
      invoiceId: s.invoiceId,
      seq: s.seq,
      fromStatus: s.fromStatus,
      toStatus: s.toStatus,
      actor: s.actor,
      reason: s.reason,
      createdAtMs: s.createdAt.getTime(),
    }
    const hash = computeEventHash(prev, input)
    const ev: SealedEvent = {
      seq: s.seq,
      invoiceId: s.invoiceId,
      fromStatus: s.fromStatus,
      toStatus: s.toStatus,
      actor: s.actor,
      reason: s.reason,
      createdAt: s.createdAt,
      prevHash: prev,
      hash,
    }
    prev = hash
    return ev
  })
}

function fakeRepo() {
  return {
    loadSealedEventsByInvoice: vi.fn(),
    loadSealedEventsByTenant: vi.fn(),
  }
}

const TENANT = '11111111-1111-1111-1111-111111111111'
const INVOICE = '22222222-2222-2222-2222-222222222222'
const INVOICE_2 = '33333333-3333-3333-3333-333333333333'
const INVOICE_3 = '44444444-4444-4444-4444-444444444444'

describe('LedgerVerificationService.verifyInvoiceEvents', () => {
  it('returns valid:true with length 0 for an invoice with no events (edge case)', async () => {
    const repo = fakeRepo()
    repo.loadSealedEventsByInvoice.mockResolvedValue([])
    const service = new LedgerVerificationService(
      repo as unknown as InvoicesRepository,
    )

    const result = await service.verifyInvoiceEvents(TENANT, INVOICE)

    expect(result).toEqual({ valid: true, length: 0 })
  })

  it('returns valid:true with the event count for a genuinely-sealed single event', async () => {
    const repo = fakeRepo()
    const events = buildChain(TENANT, [
      {
        seq: 1,
        invoiceId: INVOICE,
        fromStatus: null,
        toStatus: 'deposee',
        actor: 'platform',
        reason: null,
        createdAt: new Date('2026-07-14T10:00:00.000Z'),
      },
    ])
    repo.loadSealedEventsByInvoice.mockResolvedValue(events)
    const service = new LedgerVerificationService(
      repo as unknown as InvoicesRepository,
    )

    const result = await service.verifyInvoiceEvents(TENANT, INVOICE)

    expect(result).toEqual({ valid: true, length: 1 })
    expect(repo.loadSealedEventsByInvoice).toHaveBeenCalledWith(TENANT, INVOICE)
  })

  it('returns valid:true for a genuinely-sealed multi-event chain (recompute matches every stored hash)', async () => {
    const repo = fakeRepo()
    const events = buildChain(TENANT, [
      {
        seq: 1,
        invoiceId: INVOICE,
        fromStatus: null,
        toStatus: 'deposee',
        actor: 'platform',
        reason: null,
        createdAt: new Date('2026-07-14T10:00:00.000Z'),
      },
      {
        seq: 2,
        invoiceId: INVOICE,
        fromStatus: 'deposee',
        toStatus: 'emise',
        actor: 'platform',
        reason: null,
        createdAt: new Date('2026-07-14T10:05:00.000Z'),
      },
      {
        seq: 3,
        invoiceId: INVOICE,
        fromStatus: 'emise',
        toStatus: 'encaissee',
        actor: 'user:x',
        reason: 'paiement reçu',
        createdAt: new Date('2026-07-14T10:10:00.000Z'),
      },
    ])
    repo.loadSealedEventsByInvoice.mockResolvedValue(events)
    const service = new LedgerVerificationService(
      repo as unknown as InvoicesRepository,
    )

    const result = await service.verifyInvoiceEvents(TENANT, INVOICE)

    expect(result).toEqual({ valid: true, length: 3 })
  })

  it('detects owner-side tampering of a field (hash-mismatch) at the first altered event', async () => {
    const repo = fakeRepo()
    const events = buildChain(TENANT, [
      {
        seq: 1,
        invoiceId: INVOICE,
        fromStatus: null,
        toStatus: 'deposee',
        actor: 'platform',
        reason: null,
        createdAt: new Date('2026-07-14T10:00:00.000Z'),
      },
      {
        seq: 2,
        invoiceId: INVOICE,
        fromStatus: 'deposee',
        toStatus: 'emise',
        actor: 'platform',
        reason: null,
        createdAt: new Date('2026-07-14T10:05:00.000Z'),
      },
    ])
    // Altération hors application : le champ change mais le hash stocké reste l'ancien.
    events[1] = { ...events[1]!, actor: 'tampered' }
    repo.loadSealedEventsByInvoice.mockResolvedValue(events)
    const service = new LedgerVerificationService(
      repo as unknown as InvoicesRepository,
    )

    const result = await service.verifyInvoiceEvents(TENANT, INVOICE)

    expect(result).toEqual({
      valid: false,
      brokenAtSeq: 2,
      reason: 'hash-mismatch',
    })
  })

  it('mirrors the Task 3 input contract: null (not undefined) fromStatus/reason from pg still verify correctly', async () => {
    const repo = fakeRepo()
    const events = buildChain(TENANT, [
      {
        seq: 1,
        invoiceId: INVOICE,
        fromStatus: null,
        toStatus: 'deposee',
        actor: 'platform',
        reason: null,
        createdAt: new Date('2026-07-14T10:00:00.000Z'),
      },
    ])
    repo.loadSealedEventsByInvoice.mockResolvedValue(events)
    const service = new LedgerVerificationService(
      repo as unknown as InvoicesRepository,
    )

    const result = await service.verifyInvoiceEvents(TENANT, INVOICE)

    expect(result).toEqual({ valid: true, length: 1 })
  })
})

describe('LedgerVerificationService.verifyTenantChain', () => {
  it('returns valid:true with length 0 for a tenant with no events (edge case)', async () => {
    const repo = fakeRepo()
    repo.loadSealedEventsByTenant.mockResolvedValue([])
    const service = new LedgerVerificationService(
      repo as unknown as InvoicesRepository,
    )

    const result = await service.verifyTenantChain(TENANT)

    expect(result).toEqual({ valid: true, length: 0 })
  })

  it('returns valid:true with length 3 for a genuinely-sealed multi-invoice tenant chain', async () => {
    const repo = fakeRepo()
    const events = buildChain(TENANT, [
      {
        seq: 1,
        invoiceId: INVOICE,
        fromStatus: null,
        toStatus: 'deposee',
        actor: 'platform',
        reason: null,
        createdAt: new Date('2026-07-14T10:00:00.000Z'),
      },
      {
        seq: 2,
        invoiceId: INVOICE_2,
        fromStatus: null,
        toStatus: 'deposee',
        actor: 'platform',
        reason: null,
        createdAt: new Date('2026-07-14T10:01:00.000Z'),
      },
      {
        seq: 3,
        invoiceId: INVOICE_3,
        fromStatus: null,
        toStatus: 'deposee',
        actor: 'platform',
        reason: null,
        createdAt: new Date('2026-07-14T10:02:00.000Z'),
      },
    ])
    repo.loadSealedEventsByTenant.mockResolvedValue(events)
    const service = new LedgerVerificationService(
      repo as unknown as InvoicesRepository,
    )

    const result = await service.verifyTenantChain(TENANT)

    expect(result).toEqual({ valid: true, length: 3 })
    expect(repo.loadSealedEventsByTenant).toHaveBeenCalledWith(TENANT)
  })

  it('detects a seq-gap (owner-side deletion of a chain link) — the amendment scenario', async () => {
    const repo = fakeRepo()
    const events = buildChain(TENANT, [
      {
        seq: 1,
        invoiceId: INVOICE,
        fromStatus: null,
        toStatus: 'deposee',
        actor: 'platform',
        reason: null,
        createdAt: new Date('2026-07-14T10:00:00.000Z'),
      },
      {
        seq: 2,
        invoiceId: INVOICE_2,
        fromStatus: null,
        toStatus: 'deposee',
        actor: 'platform',
        reason: null,
        createdAt: new Date('2026-07-14T10:01:00.000Z'),
      },
      {
        seq: 3,
        invoiceId: INVOICE_3,
        fromStatus: null,
        toStatus: 'deposee',
        actor: 'platform',
        reason: null,
        createdAt: new Date('2026-07-14T10:02:00.000Z'),
      },
    ])
    // Suppression HORS application du maillon seq=2 (accès propriétaire) :
    // les maillons restants ne s'auto-corrompent pas (chacun garde son
    // prev_hash stocké intact) — seule la contiguïté du seq la révèle.
    const withGap = [events[0]!, events[2]!]
    repo.loadSealedEventsByTenant.mockResolvedValue(withGap)
    const service = new LedgerVerificationService(
      repo as unknown as InvoicesRepository,
    )

    const result = await service.verifyTenantChain(TENANT)

    expect(result).toEqual({
      valid: false,
      brokenAtSeq: 3,
      reason: 'seq-gap',
    })
  })

  it('detects a seq-gap when the very first event is missing (does not start at seq=1)', async () => {
    const repo = fakeRepo()
    const events = buildChain(TENANT, [
      {
        seq: 1,
        invoiceId: INVOICE,
        fromStatus: null,
        toStatus: 'deposee',
        actor: 'platform',
        reason: null,
        createdAt: new Date('2026-07-14T10:00:00.000Z'),
      },
      {
        seq: 2,
        invoiceId: INVOICE_2,
        fromStatus: null,
        toStatus: 'deposee',
        actor: 'platform',
        reason: null,
        createdAt: new Date('2026-07-14T10:01:00.000Z'),
      },
    ])
    repo.loadSealedEventsByTenant.mockResolvedValue([events[1]!])
    const service = new LedgerVerificationService(
      repo as unknown as InvoicesRepository,
    )

    const result = await service.verifyTenantChain(TENANT)

    expect(result).toEqual({
      valid: false,
      brokenAtSeq: 2,
      reason: 'seq-gap',
    })
  })

  it('detects a prev-hash-mismatch when the stored prev_hash does not match the previous hash', async () => {
    const repo = fakeRepo()
    const events = buildChain(TENANT, [
      {
        seq: 1,
        invoiceId: INVOICE,
        fromStatus: null,
        toStatus: 'deposee',
        actor: 'platform',
        reason: null,
        createdAt: new Date('2026-07-14T10:00:00.000Z'),
      },
      {
        seq: 2,
        invoiceId: INVOICE_2,
        fromStatus: null,
        toStatus: 'deposee',
        actor: 'platform',
        reason: null,
        createdAt: new Date('2026-07-14T10:01:00.000Z'),
      },
    ])
    // Owner-side : prev_hash du maillon 2 forgé (n'égale plus hash(1)).
    events[1] = { ...events[1]!, prevHash: Buffer.alloc(32, 0xaa) }
    repo.loadSealedEventsByTenant.mockResolvedValue(events)
    const service = new LedgerVerificationService(
      repo as unknown as InvoicesRepository,
    )

    const result = await service.verifyTenantChain(TENANT)

    expect(result).toEqual({
      valid: false,
      brokenAtSeq: 2,
      reason: 'prev-hash-mismatch',
    })
  })

  it('detects a prev-hash-mismatch on seq=1 when prev_hash does not equal genesis', async () => {
    const repo = fakeRepo()
    const events = buildChain(TENANT, [
      {
        seq: 1,
        invoiceId: INVOICE,
        fromStatus: null,
        toStatus: 'deposee',
        actor: 'platform',
        reason: null,
        createdAt: new Date('2026-07-14T10:00:00.000Z'),
      },
    ])
    events[0] = { ...events[0]!, prevHash: Buffer.alloc(32, 0xbb) }
    repo.loadSealedEventsByTenant.mockResolvedValue(events)
    const service = new LedgerVerificationService(
      repo as unknown as InvoicesRepository,
    )

    const result = await service.verifyTenantChain(TENANT)

    expect(result).toEqual({
      valid: false,
      brokenAtSeq: 1,
      reason: 'prev-hash-mismatch',
    })
  })

  it('detects a hash-mismatch when a field is tampered but prev_hash/seq linkage still holds', async () => {
    const repo = fakeRepo()
    const events = buildChain(TENANT, [
      {
        seq: 1,
        invoiceId: INVOICE,
        fromStatus: null,
        toStatus: 'deposee',
        actor: 'platform',
        reason: null,
        createdAt: new Date('2026-07-14T10:00:00.000Z'),
      },
      {
        seq: 2,
        invoiceId: INVOICE_2,
        fromStatus: null,
        toStatus: 'deposee',
        actor: 'platform',
        reason: null,
        createdAt: new Date('2026-07-14T10:01:00.000Z'),
      },
    ])
    // Le champ ET son propre hash sont altérés ensemble mais le prev_hash lié
    // au maillon précédent reste intact : la divergence n'apparaît qu'au
    // niveau du recalcul de hash (dernière garde), pas de la linkage.
    events[1] = {
      ...events[1]!,
      actor: 'tampered',
      hash: Buffer.alloc(32, 0xcc),
    }
    repo.loadSealedEventsByTenant.mockResolvedValue(events)
    const service = new LedgerVerificationService(
      repo as unknown as InvoicesRepository,
    )

    const result = await service.verifyTenantChain(TENANT)

    expect(result).toEqual({
      valid: false,
      brokenAtSeq: 2,
      reason: 'hash-mismatch',
    })
  })
})
