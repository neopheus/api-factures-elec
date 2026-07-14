'use client'
import { useRouter } from 'next/navigation'
import { type FormEvent, useState } from 'react'
import { ApiError } from '../lib/api'
import { authApi } from '../lib/client'
import { signupSchema } from '../lib/forms'
import { useSession } from '../lib/session-context'

export function SignupForm() {
  const router = useRouter()
  const { refresh } = useSession()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    const parsed = signupSchema.safeParse(
      Object.fromEntries(new FormData(e.currentTarget)),
    )
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Formulaire invalide')
      return
    }
    setPending(true)
    try {
      await authApi.signup(parsed.data)
      await refresh()
      router.push('/invoices')
    } catch (err) {
      setError(
        err instanceof ApiError
          ? (err.problem.detail ?? "Échec de l'inscription")
          : 'Erreur réseau',
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <form onSubmit={onSubmit} aria-label="Inscription">
      <label>
        Email
        <input name="email" type="email" required />
      </label>
      <label>
        Mot de passe (≥ 12 caractères)
        <input name="password" type="password" required minLength={12} />
      </label>
      <label>
        Organisation
        <input name="organizationName" required />
      </label>
      <label>
        SIREN (optionnel)
        <input name="siren" inputMode="numeric" />
      </label>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={pending}>
        Créer mon compte
      </button>
    </form>
  )
}
