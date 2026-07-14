'use client'
import { useRouter } from 'next/navigation'
import { type FormEvent, useState } from 'react'
import { ApiError } from '../lib/api'
import { authApi } from '../lib/client'
import { loginSchema } from '../lib/forms'
import { useSession } from '../lib/session-context'

export function LoginForm() {
  const router = useRouter()
  const { refresh } = useSession()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    const parsed = loginSchema.safeParse(
      Object.fromEntries(new FormData(e.currentTarget)),
    )
    if (!parsed.success) {
      setError('Identifiants invalides')
      return
    }
    setPending(true)
    try {
      await authApi.login(parsed.data.email, parsed.data.password)
      await refresh()
      router.push('/invoices')
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

  return (
    <form onSubmit={onSubmit} aria-label="Connexion">
      <label>
        Email
        <input name="email" type="email" required />
      </label>
      <label>
        Mot de passe
        <input name="password" type="password" required />
      </label>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={pending}>
        Se connecter
      </button>
    </form>
  )
}
