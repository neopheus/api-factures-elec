import { describe, expect, it, vi } from 'vitest'
import { RecipientRoutingRetryService } from '../../src/worker/recipient-routing-retry.service.js'

describe('RecipientRoutingRetryService.sweepPendingRouting', () => {
  it('boucle sur les lignes du SD et rejoue resolveAndRecord (loadCanonical → resolve) par ligne', async () => {
    const rows = [
      { tenant_id: 't1', id: 'i1' },
      { tenant_id: 't2', id: 'i2' },
    ]
    const pool = { query: vi.fn().mockResolvedValue({ rows }) }
    const invoice1 = { number: 'FA-1' }
    const invoice2 = { number: 'FA-2' }
    const invoicesRepo = {
      loadCanonical: vi
        .fn()
        .mockResolvedValueOnce(invoice1)
        .mockResolvedValueOnce(invoice2),
      findRoutingState: vi
        .fn()
        .mockResolvedValue({ status: 'resolved', platform: 'PPF' }),
      markRoutingStatus: vi.fn().mockResolvedValue(undefined),
    }
    const routing = { resolveAndRecord: vi.fn().mockResolvedValue(undefined) }
    const service = new RecipientRoutingRetryService(
      pool as never,
      invoicesRepo as never,
      routing as never,
    )

    const n = await service.sweepPendingRouting()

    expect(pool.query).toHaveBeenCalledWith(
      'SELECT tenant_id, id FROM find_pending_routing_invoices($1)',
      [100],
    )
    expect(invoicesRepo.loadCanonical).toHaveBeenCalledWith('t1', 'i1')
    expect(invoicesRepo.loadCanonical).toHaveBeenCalledWith('t2', 'i2')
    expect(routing.resolveAndRecord).toHaveBeenCalledWith('t1', 'i1', invoice1)
    expect(routing.resolveAndRecord).toHaveBeenCalledWith('t2', 'i2', invoice2)
    expect(n).toBe(2)
  })

  it('loadCanonical null → ligne ignorée (skip), aucun appel à resolveAndRecord', async () => {
    const rows = [{ tenant_id: 't1', id: 'i1' }]
    const pool = { query: vi.fn().mockResolvedValue({ rows }) }
    const invoicesRepo = {
      loadCanonical: vi.fn().mockResolvedValue(null),
      findRoutingState: vi.fn(),
      markRoutingStatus: vi.fn(),
    }
    const routing = { resolveAndRecord: vi.fn() }
    const service = new RecipientRoutingRetryService(
      pool as never,
      invoicesRepo as never,
      routing as never,
    )

    const n = await service.sweepPendingRouting()

    expect(routing.resolveAndRecord).not.toHaveBeenCalled()
    expect(n).toBe(1)
  })

  it('best-effort : une résolution qui échoue n’interrompt pas la boucle (resolveAndRecord ne throw jamais)', async () => {
    const rows = [
      { tenant_id: 't1', id: 'i1' },
      { tenant_id: 't2', id: 'i2' },
    ]
    const pool = { query: vi.fn().mockResolvedValue({ rows }) }
    const invoice = { number: 'FA' }
    const invoicesRepo = {
      loadCanonical: vi.fn().mockResolvedValue(invoice),
      findRoutingState: vi
        .fn()
        .mockResolvedValue({ status: 'resolved', platform: 'PPF' }),
      markRoutingStatus: vi.fn().mockResolvedValue(undefined),
    }
    const routing = {
      resolveAndRecord: vi
        .fn()
        .mockRejectedValueOnce(new Error('panne inattendue'))
        .mockResolvedValueOnce(undefined),
    }
    const service = new RecipientRoutingRetryService(
      pool as never,
      invoicesRepo as never,
      routing as never,
    )

    const n = await service.sweepPendingRouting()

    expect(routing.resolveAndRecord).toHaveBeenCalledTimes(2)
    expect(routing.resolveAndRecord).toHaveBeenNthCalledWith(
      1,
      't1',
      'i1',
      invoice,
    )
    expect(routing.resolveAndRecord).toHaveBeenNthCalledWith(
      2,
      't2',
      'i2',
      invoice,
    )
    expect(n).toBe(2)
  })

  it('retourne le compte traité (0 si aucune ligne à reprendre)', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) }
    const invoicesRepo = {
      loadCanonical: vi.fn(),
      findRoutingState: vi.fn(),
      markRoutingStatus: vi.fn(),
    }
    const routing = { resolveAndRecord: vi.fn() }
    const service = new RecipientRoutingRetryService(
      pool as never,
      invoicesRepo as never,
      routing as never,
    )

    const n = await service.sweepPendingRouting()

    expect(invoicesRepo.loadCanonical).not.toHaveBeenCalled()
    expect(n).toBe(0)
  })

  // AMENDEMENT M-D7-1 (BINDING) : un `pending` dont la résolution échoue
  // opérationnellement À CHAQUE passage (resolveAndRecord laisse le statut
  // INCHANGÉ, aucune écriture) ne bumpe pas `updated_at` par lui-même →
  // resterait en tête de file et hot-looperait, affamant les factures
  // suivantes. Le service relit l'état après résolution et, s'il est resté
  // `pending`, applique un touch explicite (markRoutingStatus('pending')) —
  // écrasement même-valeur, bump `updated_at` seul, PAS un changement
  // d'état.
  it('AMENDEMENT M-D7-1 : facture en échec opérationnel persistant → touchée (bump), la suivante n’est pas affamée', async () => {
    const rows = [
      { tenant_id: 't1', id: 'i1' }, // reste pending après resolveAndRecord (échec opérationnel)
      { tenant_id: 't2', id: 'i2' }, // résolution normale
    ]
    const pool = { query: vi.fn().mockResolvedValue({ rows }) }
    const invoice = { number: 'FA' }
    const invoicesRepo = {
      loadCanonical: vi.fn().mockResolvedValue(invoice),
      findRoutingState: vi
        .fn()
        .mockResolvedValueOnce({ status: 'pending', platform: null })
        .mockResolvedValueOnce({ status: 'resolved', platform: 'PPF' }),
      markRoutingStatus: vi.fn().mockResolvedValue(undefined),
    }
    const routing = { resolveAndRecord: vi.fn().mockResolvedValue(undefined) }
    const service = new RecipientRoutingRetryService(
      pool as never,
      invoicesRepo as never,
      routing as never,
    )

    const n = await service.sweepPendingRouting()

    expect(routing.resolveAndRecord).toHaveBeenCalledTimes(2) // les deux factures sont vues, pas de famine
    expect(invoicesRepo.markRoutingStatus).toHaveBeenCalledTimes(1) // touch UNIQUEMENT sur i1
    expect(invoicesRepo.markRoutingStatus).toHaveBeenCalledWith(
      't1',
      'i1',
      'pending',
    )
    expect(n).toBe(2)
  })
})
