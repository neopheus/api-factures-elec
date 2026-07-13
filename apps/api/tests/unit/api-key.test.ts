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
})
