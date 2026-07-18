import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConsentSealPayload } from '../../src/annuaire/consent-signature.port.js'
import { ConsentSignatureRejectedError } from '../../src/annuaire/consent-signature.port.js'
import {
  InvalidConsentKeyError,
  LocalFilesystemConsentStore,
} from '../../src/annuaire/local-filesystem-consent-store.js'

const FIXED_SEALED_AT = '20260118093000'

function payload(
  overrides: Partial<ConsentSealPayload> = {},
): ConsentSealPayload {
  return {
    tenantId: 'tenant-1',
    siren: '123456789',
    consentType: 'annuaire',
    signerIdentity: 'Jean Dupont',
    evidenceRef: 'evidence-xyz',
    obtainedAt: new Date('2026-01-18T09:00:00.000Z'),
    ...overrides,
  }
}

// Oracle INDÉPENDANT (D1/D3) : ré-implémentation, à la main, du seul contrat
// documenté (encodage longueur-préfixé, ordre figé) — jamais un import de la
// forme canonique/`field()` de l'impl sous test.
function oracleField(v: string | null | undefined): string {
  if (v === null || v === undefined) return '-1|'
  return `${Buffer.byteLength(v, 'utf8')}|${v}`
}

function oracleCanonical(p: ConsentSealPayload, sealedAt: string): string {
  return (
    oracleField(p.tenantId) +
    oracleField(p.siren) +
    oracleField(p.siret) +
    oracleField(p.routageId) +
    oracleField(p.suffixe) +
    oracleField(p.consentType) +
    oracleField(p.signerIdentity) +
    oracleField(p.evidenceRef) +
    oracleField(p.obtainedAt.toISOString()) +
    oracleField(sealedAt)
  )
}

function oracleSealRef(p: ConsentSealPayload, sealedAt: string): string {
  return createHash('sha256')
    .update(oracleCanonical(p, sealedAt), 'utf8')
    .digest('hex')
}

describe('LocalFilesystemConsentStore (scellement structurel write-once)', () => {
  let dir: string
  let store: LocalFilesystemConsentStore

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'factelec-consent-'))
    store = new LocalFilesystemConsentStore(dir, () => FIXED_SEALED_AT)
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('seal → sealRef = sha256(forme canonique) recalculé indépendamment, location écrite, alreadyExisted:false', async () => {
    const p = payload({ evidenceRef: 'evidence-determ' })
    const res = await store.seal(p)
    expect(res.sealRef).toBe(oracleSealRef(p, FIXED_SEALED_AT))
    expect(res.sealedAt).toBe(FIXED_SEALED_AT)
    expect(res.alreadyExisted).toBe(false)
    expect(res.location).toContain(res.sealRef)
    const written = await readFile(res.location, 'utf8')
    expect(written).toBe(oracleCanonical(p, FIXED_SEALED_AT))
  })

  it('write-once : 2e seal de la MÊME preuve → alreadyExisted:true, MÊME sealRef, fichier non réécrit (chmod 0o444)', async () => {
    const p = payload({ evidenceRef: 'evidence-replay' })
    const first = await store.seal(p)
    const second = await store.seal(p)
    expect(second.sealRef).toBe(first.sealRef)
    expect(second.location).toBe(first.location)
    expect(second.alreadyExisted).toBe(true)
    // Le fichier reste bien celui du premier scellement (contenu inchangé).
    const content = await readFile(first.location, 'utf8')
    expect(content).toBe(oracleCanonical(p, FIXED_SEALED_AT))
    // Immuabilité : une réécriture directe doit échouer (lecture seule).
    await expect(
      writeFile(first.location, 'altered', { encoding: 'utf8' }),
    ).rejects.toThrow(/EACCES|EPERM/)
  })

  it('deux preuves DIFFÉRENTES (un champ change) → sealRef distincts (encodage longueur-préfixé injection-proof)', async () => {
    const base = payload({
      evidenceRef: 'evidence-diff',
      signerIdentity: 'Jean Dupont',
    })
    const a = await store.seal(base)
    const b = await store.seal({ ...base, signerIdentity: 'Jean Dupontx' })
    expect(a.sealRef).not.toBe(b.sealRef)
  })

  it('verify(sealRef) relit, recalcule sha256 et confirme l\'intégrité → outcome:"sealed"', async () => {
    const p = payload({ evidenceRef: 'evidence-verify' })
    const sealed = await store.seal(p)
    await expect(store.verify(sealed.sealRef)).resolves.toEqual({
      sealRef: sealed.sealRef,
      outcome: 'sealed',
    })
  })

  it('clé de traversée (.. / absolu) → InvalidConsentKeyError', async () => {
    await expect(
      store.seal(payload({ tenantId: '../escape' })),
    ).rejects.toBeInstanceOf(InvalidConsentKeyError)
    await expect(
      store.seal(payload({ tenantId: '/abs/olute' })),
    ).rejects.toBeInstanceOf(InvalidConsentKeyError)
  })

  it('verify() sur un sealRef inconnu → ConsentSignatureRejectedError', async () => {
    await expect(
      store.verify(
        '0000000000000000000000000000000000000000000000000000000000000000',
      ),
    ).rejects.toBeInstanceOf(ConsentSignatureRejectedError)
  })

  it("verify() détecte une altération du contenu scellé (contrôle d'intégrité réel)", async () => {
    const p = payload({ evidenceRef: 'evidence-tamper' })
    const sealed = await store.seal(p)
    await chmod(sealed.location, 0o644)
    await writeFile(sealed.location, 'tampered-content', { encoding: 'utf8' })
    await expect(store.verify(sealed.sealRef)).rejects.toBeInstanceOf(
      ConsentSignatureRejectedError,
    )
  })

  it('is race-safe: concurrent first-seals of the same proof yield one winner, the other idempotent', async () => {
    const p = payload({ evidenceRef: 'evidence-race' })
    const [a, b] = await Promise.all([store.seal(p), store.seal(p)])
    expect(a.sealRef).toBe(b.sealRef)
    expect(a.location).toBe(b.location)
  })

  it('scopes the key by tenant: two tenants sealing distinct proofs do not collide', async () => {
    const a = await store.seal(
      payload({ tenantId: 'tenant-a', evidenceRef: 'evidence-shard' }),
    )
    const b = await store.seal(
      payload({ tenantId: 'tenant-b', evidenceRef: 'evidence-shard' }),
    )
    expect(a.location).not.toBe(b.location)
    await expect(store.verify(a.sealRef)).resolves.toEqual({
      sealRef: a.sealRef,
      outcome: 'sealed',
    })
    await expect(store.verify(b.sealRef)).resolves.toEqual({
      sealRef: b.sealRef,
      outcome: 'sealed',
    })
  })

  it("sans horloge injectée, utilise l'horloge UTC par défaut (format AAAAMMJJHHMMSS, motif horodateNow())", async () => {
    const defaultStore = new LocalFilesystemConsentStore(dir)
    const res = await defaultStore.seal(
      payload({
        tenantId: 'tenant-default-clock',
        evidenceRef: 'evidence-default-clock',
      }),
    )
    expect(res.sealedAt).toMatch(/^\d{14}$/)
  })
})
