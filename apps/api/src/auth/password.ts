import { Algorithm, hash, verify } from '@node-rs/argon2'
import { z } from 'zod'

// Mêmes paramètres OWASP que les secrets de clés API (auth/api-key.ts).
const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const

export const passwordSchema = z
  .string()
  .min(12, 'password must be at least 12 characters')
  .max(200)

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS)
}

export function verifyPassword(
  passwordHash: string,
  password: string,
): Promise<boolean> {
  return verify(passwordHash, password).catch(() => false)
}

// Verify leurre pour égaliser le temps quand l'email n'existe pas (anti-énumération).
let dummyHash: string | undefined
export async function timingSafeVerifyReject(password: string): Promise<void> {
  dummyHash ??= await hashPassword('factelec-timing-safe-dummy-password')
  await verifyPassword(dummyHash, password)
}
