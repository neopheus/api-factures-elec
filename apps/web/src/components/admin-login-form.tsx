'use client'
import { useRouter } from 'next/navigation'
import { type FormEvent, useState } from 'react'
import { ApiError } from '../lib/api'
import { adminApi } from '../lib/client'
import { AdminTotpEnrollment } from './admin-totp-enrollment'

interface PendingEnrollment {
  email: string
  password: string
  otpauthUrl: string
  secret: string
}

// Login admin à 3 états (spec §5/§7) : (a) email+mot de passe seuls → 200
// direct si le super admin n'a pas encore de TOTP enrôlé mais que son compte
// n'exige rien de plus ; (b) 202 enrollmentRequired → bascule vers l'écran
// d'enrôlement (AUCUNE session posée par l'API dans ce cas) ; (c) une fois
// enrôlé, le même formulaire expose un champ TOTP/recovery code optionnel —
// le client ne sait jamais à l'avance si l'admin est enrôlé, ce champ est
// donc toujours visible et envoyé s'il est renseigné.
export function AdminLoginForm() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [enrollment, setEnrollment] = useState<PendingEnrollment | null>(null)

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    const fd = new FormData(e.currentTarget)
    const email = String(fd.get('email') ?? '')
    const password = String(fd.get('password') ?? '')
    const code = String(fd.get('code') ?? '').trim() || undefined
    setPending(true)
    try {
      const result = await adminApi.login(email, password, code)
      if ('enrollmentRequired' in result) {
        // Email/mot de passe conservés en mémoire : requis à nouveau par
        // /admin/totp/confirm, qui tourne hors session (spec §5).
        setEnrollment({
          email,
          password,
          otpauthUrl: result.otpauthUrl,
          secret: result.secret,
        })
        return
      }
      router.push('/tenants')
    } catch (err) {
      setError(
        err instanceof ApiError
          ? (err.problem.detail ?? 'Échec de connexion')
          : 'Erreur réseau',
      )
    } finally {
      setPending(false)
    }
  }

  if (enrollment) {
    return (
      <AdminTotpEnrollment
        email={enrollment.email}
        password={enrollment.password}
        otpauthUrl={enrollment.otpauthUrl}
        secret={enrollment.secret}
        onDone={() => setEnrollment(null)}
      />
    )
  }

  return (
    <form onSubmit={onSubmit} aria-label="Connexion admin">
      <label>
        Email
        <input name="email" type="email" required />
      </label>
      <label>
        Mot de passe
        <input name="password" type="password" required />
      </label>
      <label>
        Code TOTP ou code de récupération
        <input name="code" type="text" autoComplete="one-time-code" />
      </label>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={pending}>
        Se connecter
      </button>
    </form>
  )
}
