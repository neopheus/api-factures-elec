'use client'
import { type FormEvent, useState } from 'react'
import { ApiError } from '../lib/api'
import { adminApi } from '../lib/client'

interface AdminTotpEnrollmentProps {
  email: string
  password: string
  otpauthUrl: string
  secret: string
  // Ramène l'écran de login à son état initial (retour depuis les recovery
  // codes) — le parent oublie alors email/mot de passe/secret en mémoire.
  onDone: () => void
}

// Enrôlement TOTP forcé (spec §5/§7) : rendu texte pur du secret et de
// l'URL otpauth — YAGNI acté, aucune dépendance QR (pas de lib, pas de
// data-URI généré côté client).
export function AdminTotpEnrollment({
  email,
  password,
  otpauthUrl,
  secret,
  onDone,
}: AdminTotpEnrollmentProps) {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null)

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    const totpCode = String(
      new FormData(e.currentTarget).get('totpCode') ?? '',
    ).trim()
    setPending(true)
    try {
      const result = await adminApi.confirmTotp(email, password, totpCode)
      setRecoveryCodes(result.recoveryCodes)
    } catch (err) {
      setError(
        err instanceof ApiError
          ? (err.problem.detail ?? 'Échec de la confirmation')
          : 'Erreur réseau',
      )
    } finally {
      setPending(false)
    }
  }

  // Seule apparition des codes de récupération : ni conservés côté API après
  // ce rendu, ni renvoyés par un autre endpoint — le bouton se contente de
  // rendre la main au parent, aucune mémorisation locale des codes ailleurs.
  if (recoveryCodes) {
    return (
      <section aria-label="Codes de récupération">
        <h2>Codes de récupération</h2>
        <p role="alert">
          Notez ces codes maintenant : ils ne réapparaîtront jamais.
        </p>
        <ul>
          {recoveryCodes.map((code) => (
            <li key={code}>
              <code>{code}</code>
            </li>
          ))}
        </ul>
        <button type="button" onClick={onDone}>
          J'ai noté mes codes
        </button>
      </section>
    )
  }

  return (
    <section aria-label="Enrôlement TOTP">
      <h2>Configurer l'authentification à deux facteurs</h2>
      <p>
        Secret : <code>{secret}</code>
      </p>
      <p>
        URL otpauth : <a href={otpauthUrl}>{otpauthUrl}</a>
      </p>
      <form onSubmit={onSubmit} aria-label="Confirmation TOTP">
        <label>
          Code à 6 chiffres
          <input
            name="totpCode"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={pending}>
          Confirmer
        </button>
      </form>
    </section>
  )
}
