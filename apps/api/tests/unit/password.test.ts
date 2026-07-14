import { describe, expect, it } from 'vitest'
import {
  hashPassword,
  passwordSchema,
  verifyPassword,
} from '../../src/auth/password.js'

describe('password', () => {
  it('hashes and verifies a password (argon2id)', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(hash).toMatch(/^\$argon2id\$/)
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(
      true,
    )
    expect(await verifyPassword(hash, 'wrong password here!!')).toBe(false)
  })

  it('returns false (never throws) on a malformed hash', async () => {
    expect(await verifyPassword('not-a-hash', 'whatever password')).toBe(false)
  })

  it('rejects passwords shorter than 12 characters', () => {
    expect(passwordSchema.safeParse('short').success).toBe(false)
    expect(passwordSchema.safeParse('twelve chars ok').success).toBe(true)
  })
})
