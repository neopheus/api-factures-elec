import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  type ArchiveBundleInput,
  buildArchiveBundle,
} from '../../src/archive/archive-bundle.js'

const input: ArchiveBundleInput = {
  tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  invoiceId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  canonical: { number: 'FA-1', currency: 'EUR' },
  formats: [
    {
      kind: 'ubl',
      contentType: 'application/xml',
      bodyText: '<x/>',
      bodyBytes: null,
      byteSize: 4,
    },
    {
      kind: 'facturx',
      contentType: 'application/pdf',
      bodyText: null,
      bodyBytes: Buffer.from('PDF'),
      byteSize: 3,
    },
  ],
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
  ],
}

describe('buildArchiveBundle', () => {
  it('produit une clé déterministe tenant/invoice + empreinte de contenu', () => {
    const b = buildArchiveBundle(input)
    expect(b.key).toBe(`${input.tenantId}/${input.invoiceId}/v1.bundle.json`)
    expect(b.manifest.contentHash).toBe(
      createHash('sha256').update(b.content).digest('hex'),
    )
  })

  it('est déterministe (même entrée → mêmes octets)', () => {
    expect(
      buildArchiveBundle(input).content.equals(
        buildArchiveBundle(input).content,
      ),
    ).toBe(true)
  })

  it('empreinte chaque format et référence la chaîne scellée', () => {
    const b = buildArchiveBundle(input)
    expect(b.manifest.formats).toHaveLength(2)
    expect(b.manifest.formats[0]).toMatchObject({ kind: 'ubl', byteSize: 4 })
    expect(b.manifest.formats[0]!.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(b.manifest.ledger).toEqual([{ seq: 1, hash: 'bb', prevHash: 'aa' }])
  })

  it('traite un format sans corps (bodyText ET bodyBytes null) comme vide', () => {
    // Cas défensif (inatteignable en pratique — un format porte toujours un
    // corps) : formatBytes retombe sur un buffer vide → empreinte du vide.
    const emptyHash = createHash('sha256').update(Buffer.alloc(0)).digest('hex')
    const b = buildArchiveBundle({
      ...input,
      formats: [
        {
          kind: 'empty',
          contentType: 'application/octet-stream',
          bodyText: null,
          bodyBytes: null,
          byteSize: 0,
        },
      ],
    })
    expect(b.manifest.formats[0]!.sha256).toBe(emptyHash)
  })
})
