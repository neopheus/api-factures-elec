import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PublishPayload } from '../../src/annuaire/annuaire.port.js'
import {
  InvalidPublicationKeyError,
  LocalFilesystemAnnuaireStore,
} from '../../src/annuaire/local-filesystem-annuaire-store.js'
import { validateAgainstAnnuaireConsultationXsd } from '../helpers/annuaire-xsd.js'

const FIXTURE_F14 = join(
  import.meta.dirname,
  '..',
  'fixtures',
  'annuaire-f14-minimal.xml',
)

function payload(overrides: Partial<PublishPayload> = {}): PublishPayload {
  return {
    tenantId: 'tenant-1',
    publicationRef: 'publication-1',
    xml: '<AnnuaireActualisation><BlocLignesAnnuaire/></AnnuaireActualisation>',
    ...overrides,
  }
}

describe('LocalFilesystemAnnuaireStore (write-once + consultation fixtures)', () => {
  let dir: string
  let store: LocalFilesystemAnnuaireStore

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'factelec-annuaire-'))
    store = new LocalFilesystemAnnuaireStore(dir)
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  describe('publish (write-once)', () => {
    it('publishes and returns a deterministic sha256 trackingRef', async () => {
      const xml =
        '<AnnuaireActualisation><Id>determ</Id></AnnuaireActualisation>'
      const res = await store.publish(
        payload({ publicationRef: 'determ', xml }),
      )
      expect(res.trackingRef).toBe(
        createHash('sha256').update(xml, 'utf8').digest('hex'),
      )
      expect(res.location).toContain('determ')
    })

    it('is idempotent: replaying the same publicationRef does NOT overwrite and returns the ORIGINAL trackingRef', async () => {
      const originalXml =
        '<AnnuaireActualisation><Id>replay</Id></AnnuaireActualisation>'
      const first = await store.publish(
        payload({ publicationRef: 'replay', xml: originalXml }),
      )
      const second = await store.publish(
        payload({
          publicationRef: 'replay',
          xml: '<AnnuaireActualisation><Id>DIFFERENT</Id></AnnuaireActualisation>',
        }),
      )
      expect(second.trackingRef).toBe(first.trackingRef)
      expect(second.trackingRef).toBe(
        createHash('sha256').update(originalXml, 'utf8').digest('hex'),
      )
      expect(second.location).toBe(first.location)
    })

    it('is race-safe: concurrent first-publishes on the same key yield one winner, the other idempotent', async () => {
      // Course TOCTOU : deux publish() simultanés sur une clé NEUVE. `wx`
      // fail-close → un seul écrit réellement ; le perdant capture EEXIST et
      // renvoie le trackingRef du GAGNANT (pas une erreur non capturée).
      const [a, b] = await Promise.all([
        store.publish(
          payload({
            publicationRef: 'race',
            xml: '<AnnuaireActualisation><Id>AAAA</Id></AnnuaireActualisation>',
          }),
        ),
        store.publish(
          payload({
            publicationRef: 'race',
            xml: '<AnnuaireActualisation><Id>BBBBBB</Id></AnnuaireActualisation>',
          }),
        ),
      ])
      expect(a.trackingRef).toBe(b.trackingRef)
      expect(a.location).toBe(b.location)
    })

    it('rejects path-traversal keys derived from tenantId/publicationRef', async () => {
      await expect(
        store.publish(payload({ publicationRef: '../escape' })),
      ).rejects.toBeInstanceOf(InvalidPublicationKeyError)
      await expect(
        store.publish(payload({ tenantId: '/abs/olute' })),
      ).rejects.toBeInstanceOf(InvalidPublicationKeyError)
    })
  })

  describe('fetchConsultation (F14 fixtures)', () => {
    it('returns the deposited fixture verbatim when f14-<typeFlux>.xml exists', async () => {
      await copyFile(FIXTURE_F14, join(dir, 'f14-D.xml'))
      const res = await store.fetchConsultation('D')
      expect(res.typeFlux).toBe('D')
      expect(res.xml).toBe(await readFile(FIXTURE_F14, 'utf8'))
    })

    it('returns an empty XSD-valid F14 (HorodateProduction + TypeFlux only) when no fixture is deposited', async () => {
      const res = await store.fetchConsultation('C')
      expect(res.typeFlux).toBe('C')
      expect(res.xml).toContain('<TypeFlux>C</TypeFlux>')
      const { valid, errors } = validateAgainstAnnuaireConsultationXsd(res.xml)
      expect(valid, errors).toBe(true)
    })
  })

  describe('publicationStatus', () => {
    it('returns pending by default (acquittement appliqué Task 8/9)', async () => {
      const res = await store.publish(payload({ publicationRef: 'status-1' }))
      await expect(store.publicationStatus(res.trackingRef)).resolves.toEqual({
        trackingRef: res.trackingRef,
        outcome: 'pending',
      })
    })
  })
})
