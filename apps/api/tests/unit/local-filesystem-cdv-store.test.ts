import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CdvTransmitPayload } from '../../src/cdv/cdv-transmission.port.js'
import {
  InvalidCdvTransmissionKeyError,
  LocalFilesystemCdvStore,
} from '../../src/cdv/local-filesystem-cdv-store.js'

function payload(
  overrides: Partial<CdvTransmitPayload> = {},
): CdvTransmitPayload {
  return {
    tenantId: 'tenant-1',
    invoiceId: 'invoice-1',
    toStatus: 'deposee',
    target: 'ppf',
    xml: '<rsm:CrossIndustryApplicationResponse><Id>1</Id></rsm:CrossIndustryApplicationResponse>',
    ...overrides,
  }
}

describe('LocalFilesystemCdvStore (write-once)', () => {
  let dir: string
  let store: LocalFilesystemCdvStore

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'factelec-cdv-'))
    store = new LocalFilesystemCdvStore(dir)
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('transmits and returns a deterministic sha256 trackingRef', async () => {
    const xml =
      '<rsm:CrossIndustryApplicationResponse><Id>determ</Id></rsm:CrossIndustryApplicationResponse>'
    const res = await store.transmit(payload({ invoiceId: 'determ', xml }))
    expect(res.trackingRef).toBe(
      createHash('sha256').update(xml, 'utf8').digest('hex'),
    )
    expect(res.location).toContain('determ')
  })

  it('is idempotent: replaying the same (invoiceId, toStatus, target) does NOT overwrite and returns the ORIGINAL trackingRef', async () => {
    const originalXml =
      '<rsm:CrossIndustryApplicationResponse><Id>replay</Id></rsm:CrossIndustryApplicationResponse>'
    const first = await store.transmit(
      payload({ invoiceId: 'replay', xml: originalXml }),
    )
    const second = await store.transmit(
      payload({
        invoiceId: 'replay',
        xml: '<rsm:CrossIndustryApplicationResponse><Id>DIFFERENT</Id></rsm:CrossIndustryApplicationResponse>',
      }),
    )
    expect(second.trackingRef).toBe(first.trackingRef)
    expect(second.trackingRef).toBe(
      createHash('sha256').update(originalXml, 'utf8').digest('hex'),
    )
    expect(second.location).toBe(first.location)
  })

  it('is race-safe: concurrent first-transmits on the same key yield one winner, the other idempotent', async () => {
    // Course TOCTOU : deux transmit() simultanés sur une clé NEUVE. `wx`
    // fail-close → un seul écrit réellement ; le perdant capture EEXIST et
    // renvoie le trackingRef du GAGNANT (pas une erreur non capturée).
    const [a, b] = await Promise.all([
      store.transmit(
        payload({
          invoiceId: 'race',
          xml: '<rsm:CrossIndustryApplicationResponse><Id>AAAA</Id></rsm:CrossIndustryApplicationResponse>',
        }),
      ),
      store.transmit(
        payload({
          invoiceId: 'race',
          xml: '<rsm:CrossIndustryApplicationResponse><Id>BBBBBB</Id></rsm:CrossIndustryApplicationResponse>',
        }),
      ),
    ])
    expect(a.trackingRef).toBe(b.trackingRef)
    expect(a.location).toBe(b.location)
  })

  it('scopes the key by target: the same (invoiceId, toStatus) transmitted to ppf and recipient does not collide', async () => {
    const ppf = await store.transmit(
      payload({ invoiceId: 'dual-target', target: 'ppf' }),
    )
    const recipient = await store.transmit(
      payload({ invoiceId: 'dual-target', target: 'recipient' }),
    )
    expect(ppf.location).not.toBe(recipient.location)
  })

  it('status() returns pending by default (acquittement applied by Task 8)', async () => {
    const res = await store.transmit(payload({ invoiceId: 'status-1' }))
    await expect(store.status(res.trackingRef)).resolves.toEqual({
      trackingRef: res.trackingRef,
      outcome: 'pending',
    })
  })

  it('rejects path-traversal keys derived from tenantId/invoiceId', async () => {
    await expect(
      store.transmit(payload({ invoiceId: '../escape' })),
    ).rejects.toBeInstanceOf(InvalidCdvTransmissionKeyError)
    await expect(
      store.transmit(payload({ tenantId: '/abs/olute' })),
    ).rejects.toBeInstanceOf(InvalidCdvTransmissionKeyError)
  })
})
