import { describe, expect, it } from 'vitest'
import {
  generateOpaqueToken,
  hashToken,
  safeEqualHex,
} from '../../src/auth/session-token.js'

describe('session-token', () => {
  it('generates a high-entropy token distinct from its hash', () => {
    const { token, tokenHash } = generateOpaqueToken()
    expect(token).not.toBe(tokenHash)
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(hashToken(token)).toBe(tokenHash)
  })

  it('produces unique tokens across calls', () => {
    expect(generateOpaqueToken().token).not.toBe(generateOpaqueToken().token)
  })

  it('compares hex digests in constant time', () => {
    const h = hashToken('abc')
    expect(safeEqualHex(h, h)).toBe(true)
    expect(safeEqualHex(h, hashToken('def'))).toBe(false)
    expect(safeEqualHex(h, 'deadbeef')).toBe(false) // longueurs différentes
    expect(safeEqualHex('', '')).toBe(false)
  })
})
