'use client'
import { type FormEvent, useCallback, useEffect, useState } from 'react'
import type { ApiKeyView } from '../lib/api-types'
import { apiKeysApi } from '../lib/client'

export function ApiKeysManager() {
  const [keys, setKeys] = useState<ApiKeyView[]>([])
  const [freshToken, setFreshToken] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setKeys(await apiKeysApi.list())
    } catch {
      setError('Chargement impossible')
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function onCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const label = String(
      new FormData(e.currentTarget).get('label') ?? '',
    ).trim()
    if (!label) return
    setError(null)
    try {
      const created = await apiKeysApi.create(label)
      setFreshToken(created.token) // révélé une seule fois
      await refresh()
    } catch {
      setError('Création impossible')
    }
  }

  async function onRevoke(id: string) {
    try {
      await apiKeysApi.revoke(id)
      await refresh()
    } catch {
      setError('Révocation impossible')
    }
  }

  return (
    <section>
      <form onSubmit={onCreate} aria-label="Nouvelle clé API">
        <label>
          Libellé
          <input name="label" required />
        </label>
        <button type="submit">Créer</button>
      </form>
      {freshToken && (
        <div role="alert" data-testid="fresh-token">
          <p>Copiez ce secret maintenant — il ne sera plus jamais affiché :</p>
          <code>{freshToken}</code>
          <button type="button" onClick={() => setFreshToken(null)}>
            J'ai copié
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      <ul>
        {keys.map((k) => (
          <li key={k.id}>
            <span>
              {k.prefix}… — {k.label}
            </span>
            {k.revokedAt ? (
              <em> (révoquée)</em>
            ) : (
              <button type="button" onClick={() => void onRevoke(k.id)}>
                Révoquer
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
