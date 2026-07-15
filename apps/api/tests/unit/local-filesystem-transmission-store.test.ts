import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TransmitPayload } from '../../src/ereporting/flux10-transmission.port.js'
import {
  InvalidTransmissionKeyError,
  LocalFilesystemTransmissionStore,
} from '../../src/ereporting/local-filesystem-transmission-store.js'

function payload(overrides: Partial<TransmitPayload> = {}): TransmitPayload {
  return {
    tenantId: 'tenant-1',
    transmissionRef: 'transmission-1',
    fluxKind: 'transactions',
    xml: '<Report><Id>1</Id></Report>',
    ...overrides,
  }
}

describe('LocalFilesystemTransmissionStore (write-once)', () => {
  let dir: string
  let store: LocalFilesystemTransmissionStore

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'factelec-ereporting-'))
    store = new LocalFilesystemTransmissionStore(dir)
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('transmits and returns a deterministic sha256 trackingId', async () => {
    const xml = '<Report><Id>determ</Id></Report>'
    const res = await store.transmit(
      payload({ transmissionRef: 'determ', xml }),
    )
    expect(res.trackingId).toBe(
      createHash('sha256').update(xml, 'utf8').digest('hex'),
    )
    expect(res.location).toContain('determ')
  })

  it('is idempotent: replaying the same transmissionRef does NOT overwrite and returns the ORIGINAL trackingId', async () => {
    const originalXml = '<Report><Id>replay</Id></Report>'
    const first = await store.transmit(
      payload({ transmissionRef: 'replay', xml: originalXml }),
    )
    const second = await store.transmit(
      payload({
        transmissionRef: 'replay',
        xml: '<Report><Id>DIFFERENT</Id></Report>',
      }),
    )
    expect(second.trackingId).toBe(first.trackingId)
    expect(second.trackingId).toBe(
      createHash('sha256').update(originalXml, 'utf8').digest('hex'),
    )
    expect(second.location).toBe(first.location)
  })

  it('is race-safe: concurrent first-transmits on the same key yield one winner, the other idempotent', async () => {
    // Course TOCTOU : deux transmit() simultanés sur une clé NEUVE. `wx`
    // fail-close → un seul écrit réellement ; le perdant capture EEXIST et
    // renvoie le trackingId du GAGNANT (pas une erreur non capturée).
    const [a, b] = await Promise.all([
      store.transmit(
        payload({
          transmissionRef: 'race',
          xml: '<Report><Id>AAAA</Id></Report>',
        }),
      ),
      store.transmit(
        payload({
          transmissionRef: 'race',
          xml: '<Report><Id>BBBBBB</Id></Report>',
        }),
      ),
    ])
    expect(a.trackingId).toBe(b.trackingId)
    expect(a.location).toBe(b.location)
  })

  it('status() returns pending by default (acquittement applied by Task 9)', async () => {
    const res = await store.transmit(payload({ transmissionRef: 'status-1' }))
    await expect(store.status(res.trackingId)).resolves.toEqual({
      trackingId: res.trackingId,
      outcome: 'pending',
    })
  })

  it('rejects path-traversal keys derived from tenantId/transmissionRef', async () => {
    await expect(
      store.transmit(payload({ transmissionRef: '../escape' })),
    ).rejects.toBeInstanceOf(InvalidTransmissionKeyError)
    await expect(
      store.transmit(payload({ tenantId: '/abs/olute' })),
    ).rejects.toBeInstanceOf(InvalidTransmissionKeyError)
  })
})
