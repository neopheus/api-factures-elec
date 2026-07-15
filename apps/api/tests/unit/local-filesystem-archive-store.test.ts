import { createHash } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ArchiveObjectNotFoundError,
  InvalidArchiveKeyError,
} from '../../src/archive/archive-store.port.js'
import { LocalFilesystemArchiveStore } from '../../src/archive/local-filesystem-archive-store.js'

describe('LocalFilesystemArchiveStore (write-once)', () => {
  let dir: string
  let store: LocalFilesystemArchiveStore
  const key = 'tenant-1/invoice-1/v1.bundle.json'
  const body = Buffer.from('{"hello":"world"}', 'utf8')

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'factelec-archive-'))
    store = new LocalFilesystemArchiveStore(dir)
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('stores, sets read-only perms, and returns a sha256 fingerprint', async () => {
    const res = await store.put(key, body)
    expect(res.alreadyExisted).toBe(false)
    expect(res.bytes).toBe(body.byteLength)
    expect(res.hash).toMatch(/^[0-9a-f]{64}$/)
    const st = await stat(join(dir, key))
    expect(st.mode & 0o777).toBe(0o444) // lecture seule
  })

  it('is WRITE-ONCE: a second put on the same key does NOT overwrite', async () => {
    const res = await store.put(key, Buffer.from('DIFFERENT', 'utf8'))
    expect(res.alreadyExisted).toBe(true)
    // Contenu d'origine intact.
    expect((await store.get(key)).toString('utf8')).toBe('{"hello":"world"}')
    // L'empreinte renvoyée est celle du contenu D'ORIGINE, pas du contenu rejeté
    // (revue T5 : le chemin alreadyExisted doit refléter le gagnant).
    expect(res.bytes).toBe(body.byteLength)
    expect(res.hash).toBe(createHash('sha256').update(body).digest('hex'))
  })

  it('is race-safe: concurrent first-writes yield one winner, the other idempotent', async () => {
    // Course TOCTOU : deux put() simultanés sur une clé NEUVE. `wx` fail-close →
    // exactement un gagnant (alreadyExisted:false) ; le perdant capture EEXIST et
    // renvoie l'empreinte du gagnant (PAS une erreur) — revue T5 #1.
    const raceKey = 'tenant-2/race/v1.bundle.json'
    const [a, b] = await Promise.all([
      store.put(raceKey, Buffer.from('AAAA', 'utf8')),
      store.put(raceKey, Buffer.from('BBBBBB', 'utf8')),
    ])
    // Un seul a écrit ; l'autre a vu la clé déjà là.
    expect([a.alreadyExisted, b.alreadyExisted].sort()).toEqual([false, true])
    // Les deux renvoient l'empreinte du MÊME contenu (le gagnant), et get() le confirme.
    expect(a.hash).toBe(b.hash)
    const stored = await store.get(raceKey)
    expect(createHash('sha256').update(stored).digest('hex')).toBe(a.hash)
  })

  it('head reports existence + fingerprint', async () => {
    expect(await store.head(key)).toMatchObject({ exists: true })
    expect(await store.head('tenant-1/absent')).toEqual({ exists: false })
  })

  it('get throws for an absent object', async () => {
    await expect(store.get('tenant-1/absent')).rejects.toBeInstanceOf(
      ArchiveObjectNotFoundError,
    )
  })

  it('rejects path-traversal keys', async () => {
    await expect(store.put('../escape', body)).rejects.toBeInstanceOf(
      InvalidArchiveKeyError,
    )
    await expect(store.put('/abs/olute', body)).rejects.toBeInstanceOf(
      InvalidArchiveKeyError,
    )
  })
})
