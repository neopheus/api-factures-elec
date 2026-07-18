import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConsentSealPayload } from '../../src/annuaire/consent-signature.port.js'
import {
  ConsentSealNotFoundError,
  ConsentSignatureRejectedError,
} from '../../src/annuaire/consent-signature.port.js'
import {
  InvalidConsentKeyError,
  LocalFilesystemConsentStore,
} from '../../src/annuaire/local-filesystem-consent-store.js'

const FIXED_SEALED_AT = '20260118093000'
const OTHER_SEALED_AT = '20260119100000' // horloge différente, jour suivant

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
// forme canonique/`field()` de l'impl sous test. `sealedAt` EXCLU de la
// preuve canonique (F1, revue T1) : c'est une métadonnée du fichier, pas une
// entrée de l'identité content-addressée.
function oracleField(v: string | null | undefined): string {
  if (v === null || v === undefined) return '-1|'
  return `${Buffer.byteLength(v, 'utf8')}|${v}`
}

function oracleCanonicalProof(p: ConsentSealPayload): string {
  return (
    oracleField(p.tenantId) +
    oracleField(p.siren) +
    oracleField(p.siret) +
    oracleField(p.routageId) +
    oracleField(p.suffixe) +
    oracleField(p.consentType) +
    oracleField(p.signerIdentity) +
    oracleField(p.evidenceRef) +
    oracleField(p.obtainedAt.toISOString())
  )
}

function oracleSealRef(p: ConsentSealPayload): string {
  return createHash('sha256')
    .update(oracleCanonicalProof(p), 'utf8')
    .digest('hex')
}

// Contenu persisté = preuve canonique (entrée du hash) + métadonnée
// `sealedAt` en dernier champ (F1) — écrite mais hors identité.
function oracleFileContent(p: ConsentSealPayload, sealedAt: string): string {
  return oracleCanonicalProof(p) + oracleField(sealedAt)
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

  it('seal → sealRef = sha256(forme canonique de la preuve métier SEULE, sealedAt exclu) recalculé indépendamment, location écrite, alreadyExisted:false', async () => {
    const p = payload({ evidenceRef: 'evidence-determ' })
    const res = await store.seal(p)
    expect(res.sealRef).toBe(oracleSealRef(p))
    expect(res.sealedAt).toBe(FIXED_SEALED_AT)
    expect(res.alreadyExisted).toBe(false)
    expect(res.location).toContain(res.sealRef)
    const written = await readFile(res.location, 'utf8')
    expect(written).toBe(oracleFileContent(p, FIXED_SEALED_AT))
  })

  it('write-once : 2e seal de la MÊME preuve (même horloge) → alreadyExisted:true, MÊME sealRef, fichier non réécrit (chmod 0o444)', async () => {
    const p = payload({ evidenceRef: 'evidence-replay' })
    const first = await store.seal(p)
    const second = await store.seal(p)
    expect(second.sealRef).toBe(first.sealRef)
    expect(second.location).toBe(first.location)
    expect(second.alreadyExisted).toBe(true)
    expect(second.sealedAt).toBe(first.sealedAt)
    // Le fichier reste bien celui du premier scellement (contenu inchangé).
    const content = await readFile(first.location, 'utf8')
    expect(content).toBe(oracleFileContent(p, FIXED_SEALED_AT))
    // Immuabilité : une réécriture directe doit échouer (lecture seule).
    await expect(
      writeFile(first.location, 'altered', { encoding: 'utf8' }),
    ).rejects.toThrow(/EACCES|EPERM/)
  })

  it('rejeu à une horloge DIFFÉRENTE → MÊME sealRef, alreadyExisted:true, sealedAt = celui du PREMIER scellement (fait constaté, pas recalculé)', async () => {
    const p = payload({ evidenceRef: 'evidence-replay-clock-drift' })
    const clocks = [FIXED_SEALED_AT, OTHER_SEALED_AT]
    let call = 0
    const driftingStore = new LocalFilesystemConsentStore(dir, () => {
      const value = clocks[call] ?? OTHER_SEALED_AT
      call += 1
      return value
    })
    const first = await driftingStore.seal(p)
    const second = await driftingStore.seal(p)
    expect(first.sealedAt).toBe(FIXED_SEALED_AT)
    expect(second.sealRef).toBe(first.sealRef)
    expect(second.alreadyExisted).toBe(true)
    // Le sealedAt retourné au rejeu est celui du PREMIER appel, jamais
    // l'horloge (différente) de ce 2e appel.
    expect(second.sealedAt).toBe(FIXED_SEALED_AT)
    expect(second.sealedAt).not.toBe(OTHER_SEALED_AT)
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

  it("injection-proof — décalage de frontière sur 2 champs adjacents (signerIdentity/evidenceRef) : ('A','B|C') vs ('A|B','C') → sealRef distincts", async () => {
    const base = payload({ evidenceRef: 'evidence-boundary-shift-base' })
    const a = await store.seal({
      ...base,
      evidenceRef: 'evidence-boundary-a',
      signerIdentity: 'A',
    })
    const b = await store.seal({
      ...base,
      evidenceRef: 'C-boundary-b',
      signerIdentity: 'A|B',
    })
    // Recompose le VRAI cas-limite (review F2) sur les 2 champs seuls, via
    // l'oracle indépendant, pour prouver que le décalage de frontière change
    // le sealRef même quand la concaténation naïve (sans longueur-préfixe)
    // collisionnerait.
    const left = payload({ signerIdentity: 'A', evidenceRef: 'B|C' })
    const right = payload({ signerIdentity: 'A|B', evidenceRef: 'C' })
    expect(oracleSealRef(left)).not.toBe(oracleSealRef(right))
    const sealedLeft = await store.seal(left)
    const sealedRight = await store.seal(right)
    expect(sealedLeft.sealRef).not.toBe(sealedRight.sealRef)
    expect(sealedLeft.sealRef).toBe(oracleSealRef(left))
    expect(sealedRight.sealRef).toBe(oracleSealRef(right))
    // Sanity : le couple auxiliaire (a/b) ci-dessus reste bien distinct.
    expect(a.sealRef).not.toBe(b.sealRef)
  })

  it("injection-proof — absent vs chaîne vide (siret: undefined vs '') → sealRef distincts ('-1|' vs '0|')", async () => {
    const absent = payload({
      evidenceRef: 'evidence-siret-absent',
      siret: undefined,
    })
    const empty = payload({
      evidenceRef: 'evidence-siret-absent',
      siret: '',
    })
    const sealedAbsent = await store.seal(absent)
    const sealedEmpty = await store.seal(empty)
    expect(sealedAbsent.sealRef).not.toBe(sealedEmpty.sealRef)
    expect(sealedAbsent.sealRef).toBe(oracleSealRef(absent))
    expect(sealedEmpty.sealRef).toBe(oracleSealRef(empty))
  })

  // F3 — vecteur canonique LITTÉRAL (oracle véritablement externe : ni
  // `field()` du SUT ni `oracleField()` du fichier de test ne participent à
  // ce calcul — la chaîne et le hash sont écrits en dur).
  //
  // Comment ce vecteur a été calculé (hors code, reproductible) :
  //   payload = { tenantId:'t1', siren:'123456789', siret:'12345678901234',
  //     routageId:'RTG-01', suffixe:'X', consentType:'annuaire',
  //     signerIdentity:'Jean Dupont', evidenceRef:'evidence-xyz',
  //     obtainedAt: 2026-01-18T09:00:00.000Z }
  //   Concaténation manuelle field(v) = byteLength(v,'utf8') + '|' + v
  //   (tous les octets sont ASCII ici, byteLength == longueur JS) :
  //     '2|t1' + '9|123456789' + '14|12345678901234' + '6|RTG-01' + '1|X'
  //     + '8|annuaire' + '11|Jean Dupont' + '12|evidence-xyz'
  //     + '24|2026-01-18T09:00:00.000Z'
  //   sha256 recalculé par DEUX outils indépendants (pas node:crypto) :
  //     printf '%s' '<LITERAL_CANONICAL>' | shasum -a 256
  //     printf '%s' '<LITERAL_CANONICAL>' | openssl dgst -sha256
  //   Les deux commandes ont produit le même digest, reporté ci-dessous.
  it('seal → correspond au vecteur canonique littéral figé (oracle externe, hash calculé hors code)', async () => {
    const LITERAL_CANONICAL =
      '2|t19|12345678914|123456789012346|RTG-011|X8|annuaire11|Jean Dupont12|evidence-xyz24|2026-01-18T09:00:00.000Z'
    const LITERAL_SEAL_REF =
      '7dfd546f0c3cad635d4a84dcbe3532f73a552ae6020170be362fe7c4e306837e'

    const p: ConsentSealPayload = {
      tenantId: 't1',
      siren: '123456789',
      siret: '12345678901234',
      routageId: 'RTG-01',
      suffixe: 'X',
      consentType: 'annuaire',
      signerIdentity: 'Jean Dupont',
      evidenceRef: 'evidence-xyz',
      obtainedAt: new Date('2026-01-18T09:00:00.000Z'),
    }
    const literalClockStore = new LocalFilesystemConsentStore(
      dir,
      () => FIXED_SEALED_AT,
    )
    const res = await literalClockStore.seal(p)
    expect(res.sealRef).toBe(LITERAL_SEAL_REF)
    const written = await readFile(res.location, 'utf8')
    expect(written.startsWith(LITERAL_CANONICAL)).toBe(true)
  })

  it('verify(sealRef) relit, recalcule sha256 sur la preuve métier seule (sealedAt exclu) et confirme l\'intégrité → outcome:"sealed"', async () => {
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

  it('verify() sur un sealRef inconnu (répertoire base existant) → ConsentSealNotFoundError', async () => {
    await expect(
      store.verify(
        '0000000000000000000000000000000000000000000000000000000000000000',
      ),
    ).rejects.toBeInstanceOf(ConsentSealNotFoundError)
  })

  it('verify() sur un répertoire base ABSENT (aucun seal jamais écrit) → ConsentSealNotFoundError typée, pas une ENOENT brute', async () => {
    const neverSealedStore = new LocalFilesystemConsentStore(
      join(dir, 'never-created-subdir'),
    )
    await expect(
      neverSealedStore.verify(
        '1111111111111111111111111111111111111111111111111111111111111111',
      ),
    ).rejects.toBeInstanceOf(ConsentSealNotFoundError)
  })

  it("verify() détecte une altération du contenu scellé (contrôle d'intégrité réel) → ConsentSignatureRejectedError", async () => {
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
