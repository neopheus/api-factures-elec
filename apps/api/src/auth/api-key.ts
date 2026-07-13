import { randomBytes } from 'node:crypto'
import { Algorithm, hash, verify } from '@node-rs/argon2'

const PREFIX_BYTES = 12 // 24 hex
const SECRET_BYTES = 32 // 43 base64url

// Paramètres OWASP Argon2id (Password Storage Cheat Sheet) : m=19 MiB, t=2, p=1.
const ARGON2_OPTS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const

export interface GeneratedApiKey {
  token: string // montré UNE fois au client
  prefix: string // stocké en clair (identifiant de lookup, non secret)
  secretHash: string // stocké (argon2id) — le secret n'est JAMAIS stocké
}

export async function generateApiKey(): Promise<GeneratedApiKey> {
  const prefix = randomBytes(PREFIX_BYTES).toString('hex')
  const secret = randomBytes(SECRET_BYTES).toString('base64url')
  const secretHash = await hash(secret, ARGON2_OPTS)
  return { token: `fk_${prefix}.${secret}`, prefix, secretHash }
}

export interface ParsedToken {
  prefix: string
  secret: string
}

export function parseApiKeyToken(token: string): ParsedToken | null {
  if (!token.startsWith('fk_')) return null
  const rest = token.slice(3)
  const dot = rest.indexOf('.')
  if (dot <= 0 || dot === rest.length - 1) return null
  return { prefix: rest.slice(0, dot), secret: rest.slice(dot + 1) }
}

export function verifySecret(
  secretHash: string,
  secret: string,
): Promise<boolean> {
  // Les paramètres/sel sont encodés dans le hash → pas d'options nécessaires.
  // `.catch(() => false)` : un hash stocké malformé (corruption DB, migration
  // partielle) fait `throw` argon2 plutôt que renvoyer `false` — sans ce
  // filet, l'exception remonterait non catchée jusqu'au guard (500 au lieu
  // d'un 401 propre). On la traite comme un échec de vérification ordinaire.
  return verify(secretHash, secret).catch(() => false)
}

// Égalise le temps de réponse quand le préfixe est inconnu (pas d'oracle temporel).
let dummyHash: string | null = null
export async function timingSafeReject(secret: string): Promise<void> {
  if (!dummyHash) dummyHash = await hash('timing-equalizer', ARGON2_OPTS)
  await verify(dummyHash, secret).catch(() => undefined)
}
