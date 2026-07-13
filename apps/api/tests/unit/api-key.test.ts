import { describe, expect, it } from 'vitest'
import {
  generateApiKey,
  parseApiKeyToken,
  verifySecret,
} from '../../src/auth/api-key.js'

describe('api key format', () => {
  it('parses a well-formed token', () => {
    expect(parseApiKeyToken('fk_abc123.secretpart')).toEqual({
      prefix: 'abc123',
      secret: 'secretpart',
    })
  })

  it('rejects malformed tokens', () => {
    for (const t of [
      '',
      'nope',
      'fk_only',
      'fk_.secret',
      'fk_prefix.',
      'Bearer x',
    ]) {
      expect(parseApiKeyToken(t)).toBeNull()
    }
  })

  it('generates a token whose secret verifies against its hash (argon2id round-trip)', async () => {
    const key = await generateApiKey()
    const parsed = parseApiKeyToken(key.token)
    expect(parsed?.prefix).toBe(key.prefix)
    expect(key.secretHash.startsWith('$argon2id$')).toBe(true)
    expect(await verifySecret(key.secretHash, parsed!.secret)).toBe(true)
    expect(await verifySecret(key.secretHash, 'wrong-secret')).toBe(false)
  })

  it('never repeats prefixes/secrets', async () => {
    const [a, b] = await Promise.all([generateApiKey(), generateApiKey()])
    expect(a.prefix).not.toBe(b.prefix)
    expect(a.token).not.toBe(b.token)
  })

  it('resolves to false (never throws) when the stored hash is malformed/corrupted', async () => {
    // @node-rs/argon2 `verify()` REJETTE (throw) sur un hash qui n'est pas un
    // encodage argon2 valide (ex: corruption DB, migration partielle). Sans
    // garde, ce throw remonterait jusqu'au guard → 500 au lieu d'un 401
    // propre pour un cas qui doit être traité comme « secret invalide ».
    await expect(
      verifySecret('not-a-valid-argon2-hash', 'any-secret'),
    ).resolves.toBe(false)
  })
})
