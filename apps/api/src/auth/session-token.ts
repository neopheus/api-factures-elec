import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE = 'factelec_session'
export const CSRF_COOKIE = 'factelec_csrf'
export const CSRF_HEADER = 'x-csrf-token'

export interface OpaqueToken {
  token: string
  tokenHash: string
}

/** Jeton opaque 256 bits (CSPRNG) ; seul le hash SHA-256 est persisté. */
export function generateOpaqueToken(): OpaqueToken {
  const token = randomBytes(32).toString('base64url')
  return { token, tokenHash: hashToken(token) }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Comparaison à temps constant de deux digests hex non vides et de même longueur. */
export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex')
  const bb = Buffer.from(b, 'hex')
  if (ba.length !== bb.length || ba.length === 0) return false
  return timingSafeEqual(ba, bb)
}
