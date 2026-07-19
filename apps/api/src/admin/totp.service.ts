import crypto from 'node:crypto'
import { Injectable } from '@nestjs/common'
// otplib 13.x (installé, cf. package.json) est une réécriture 100%
// fonctionnelle/statique : PLUS de singleton `authenticator` mutable
// (`authenticator.options = {...}`) comme dans l'ancienne API v12 —
// `generateSecret`/`generateURI`/`generate`/`verify` sont de pures
// fonctions qui reçoivent leurs options À CHAQUE APPEL (crypto/base32 par
// défaut = NobleCryptoPlugin/ScureBase32Plugin, posés en interne par la
// lib). Aucun état partagé entre deux appels : le "configure une instance
// locale, ne mute pas le singleton global" demandé au brief est donc
// satisfait par construction — il n'existe plus de singleton à muter.
import { generateSecret, generateURI, verify } from 'otplib'
import { hashPassword, verifyPassword } from '../auth/password.js'

const ISSUER = 'Factelec'

// Fenêtre ±1 pas de 30 s (spec §5/§9, motif documenté en §9 : pas d'anti-
// rejeu par jti, surface admin mono-utilisateur + throttle 10/15min en
// amont). `epochTolerance` (otplib 13.x) est une tolérance en SECONDES,
// symétrique passé/futur — avec la période TOTP par défaut (30 s),
// epochTolerance=30 déplace exactement `minCounter`/`maxCounter` de ±1 pas
// autour du compteur courant (vérifié empiriquement contre
// @otplib/totp#verify : soustraire/ajouter exactement une période entière
// à `epoch` avant la division entière décale le floor() d'exactement ±1,
// quel que soit le décalage à l'intérieur du pas courant). C'est
// l'équivalent EXACT du `window: 1` de l'ancienne API otplib v12.
const EPOCH_TOLERANCE_SECONDS = 30

const RECOVERY_CODE_COUNT = 10

export interface RecoveryCodes {
  /** Codes en clair — affichés à l'admin UNE SEULE FOIS (POST /admin/totp/confirm). */
  plain: string[]
  /** Hashs argon2id — seule forme persistée (platform_admins.recovery_codes). */
  hashed: string[]
}

export interface ConsumeRecoveryCodeResult {
  ok: boolean
  /** Hashs restants (le hash consommé retiré) — à repersister si `ok`. */
  remaining: string[]
}

@Injectable()
export class TotpService {
  /** Secret TOTP base32 (RFC 4226 §4 / RFC 6238) — 20 octets aléatoires par défaut. */
  generateSecret(): string {
    return generateSecret()
  }

  /** URI `otpauth://totp/...` pour QR code (label = email admin, issuer = Factelec). */
  otpauthUrl(email: string, secret: string): string {
    return generateURI({ issuer: ISSUER, label: email, secret })
  }

  /** Vérifie un code TOTP 6 chiffres contre `secret`, fenêtre ±1 pas (30 s). */
  async verify(secret: string, code: string): Promise<boolean> {
    const result = await verify({
      secret,
      token: code,
      epochTolerance: EPOCH_TOLERANCE_SECONDS,
    })
    return result.valid
  }

  // 10 codes de récupération, format `xxxx-xxxx` (8 caractères hex issus de
  // 4 octets CSPRNG, motif crypto.randomBytes demandé au brief — lisible/
  // copiable à la main, même esprit que les recovery codes GitHub/Google ;
  // 32 bits d'entropie par code, jugé suffisant pour un usage unique
  // protégé par argon2id + throttle amont, spec §5/§9). Hash argon2id via
  // les primitives auth existantes (auth/password.ts) — jamais un hash
  // maison.
  async generateRecoveryCodes(): Promise<RecoveryCodes> {
    const plain = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
      randomRecoveryCode(),
    )
    const hashed = await Promise.all(plain.map((code) => hashPassword(code)))
    return { plain, hashed }
  }

  // Vérifie `plainCode` contre chaque hash UN PAR UN (argon2id ne permet
  // aucune comparaison directe) et retire le hash consommé du tableau
  // retourné — à usage unique (spec §5 : « consommé (retiré du jsonb) »).
  // Le premier hash correspondant gagne (les codes sont indépendants,
  // aucune ambiguïté possible en pratique).
  async consumeRecoveryCode(
    hashedCodes: readonly string[],
    plainCode: string,
  ): Promise<ConsumeRecoveryCodeResult> {
    for (let i = 0; i < hashedCodes.length; i++) {
      const hash = hashedCodes[i]
      if (hash === undefined) continue
      if (await verifyPassword(hash, plainCode)) {
        return {
          ok: true,
          remaining: [...hashedCodes.slice(0, i), ...hashedCodes.slice(i + 1)],
        }
      }
    }
    return { ok: false, remaining: [...hashedCodes] }
  }
}

function randomRecoveryCode(): string {
  const hex = crypto.randomBytes(4).toString('hex') // 8 caractères hex (32 bits)
  return `${hex.slice(0, 4)}-${hex.slice(4)}`
}
