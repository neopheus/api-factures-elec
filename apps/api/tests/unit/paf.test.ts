import { describe, expect, it } from 'vitest'
import { type PafDocument, renderPafCsv } from '../../src/ledger/paf.js'

const doc: PafDocument = {
  invoiceId: 'inv-1',
  lifecycleStatus: 'deposee',
  integrity: { valid: true, length: 1 },
  // Amendement A-IMPORTANT (revue plan, brief Task 7) : le PAF porte AUSSI la
  // vérification de chaîne complète du tenant, à côté du self-check
  // par-facture — seule `chainIntegrity` détecte une suppression owner-side
  // de maillon (cf. Task 4 / GET /ledger).
  chainIntegrity: { valid: true, length: 1 },
  archive: { status: 'archived', location: 'k', hash: 'abc' },
  events: [
    {
      seq: 1,
      fromStatus: null,
      toStatus: 'deposee',
      actor: 'platform',
      reason: null,
      createdAt: '2026-07-14T00:00:00.000Z',
      prevHash: 'aa',
      hash: 'bb',
    },
    {
      seq: 2,
      fromStatus: 'deposee',
      toStatus: 'en_litige',
      actor: 'user:x',
      reason: 'motif; avec, virgule "et" guillemet',
      createdAt: '2026-07-14T01:00:00.000Z',
      prevHash: 'bb',
      hash: 'cc',
    },
  ],
}

describe('renderPafCsv', () => {
  it('émet un en-tête + une ligne par événement', () => {
    const csv = renderPafCsv(doc)
    const lines = csv.trimEnd().split('\n')
    expect(lines[0]).toBe(
      'seq,from_status,to_status,actor,reason,created_at,prev_hash,hash',
    )
    expect(lines).toHaveLength(3)
    expect(lines[1]).toBe('1,,deposee,platform,,2026-07-14T00:00:00.000Z,aa,bb')
  })

  it('échappe les champs contenant virgule/guillemet/point-virgule (RFC 4180)', () => {
    const csv = renderPafCsv(doc)
    // reason contient , et " → champ entre guillemets, " doublés.
    expect(csv).toContain('"motif; avec, virgule ""et"" guillemet"')
  })

  it('ne porte PAS integrity/chainIntegrity dans les lignes CSV (métadonnées niveau-document, portées par le JSON)', () => {
    const csv = renderPafCsv(doc)
    expect(csv).not.toContain('valid')
    expect(csv).not.toContain('archived')
  })
})
