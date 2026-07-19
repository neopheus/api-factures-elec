'use client'
import { useCallback, useEffect, useState } from 'react'
import {
  ApiError,
  createBillingCheckout,
  createBillingPortal,
  getBillingStatus,
} from '../lib/api'
import type { BillingStatus } from '../lib/api-types'

// Statuts qui bloquent l'émission côté BillingGuard (miroir de la matrice
// Task 8, driver×enforcement×statut) : le tenant doit re-souscrire depuis
// zéro (Checkout), une simple mise à jour de moyen de paiement (Portal) ne
// suffit pas — contrairement à `past_due` (grâce dunning, garde encore vert).
const BLOCKED_STATUSES = new Set(['canceled', 'unpaid', 'incomplete'])

export function BillingPanel() {
  const [status, setStatus] = useState<BillingStatus | null>(null)
  const [disabled, setDisabled] = useState(false) // 503 billing-disabled (BILLING_DRIVER=none)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const load = useCallback(async () => {
    try {
      setStatus(await getBillingStatus())
    } catch (err) {
      if (err instanceof ApiError && err.problem.status === 503) {
        setDisabled(true)
      } else {
        setError('Chargement impossible')
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function redirectTo(action: () => Promise<{ url: string }>) {
    setError(null)
    setPending(true)
    try {
      const { url } = await action()
      // `assign` (plutôt qu'une affectation de `href`) : seule façon d'espionner
      // la navigation en test sans dépendre de la navigation réelle de jsdom.
      window.location.assign(url)
    } catch {
      setError('Redirection impossible')
      setPending(false)
    }
  }

  if (disabled) return <p>Facturation indisponible</p>
  if (loading) return <p>Chargement…</p>
  // Échec définitif du chargement (non-503) : aucun statut à afficher, on ne
  // propose ni Checkout ni Portal sans savoir dans quel état est le tenant.
  if (!status) return <p role="alert">{error}</p>

  return (
    <section>
      {error && <p role="alert">{error}</p>}

      {status.status === 'none' && (
        <>
          <p>Abonnez-vous pour pouvoir émettre des factures.</p>
          <button
            type="button"
            disabled={pending}
            onClick={() => void redirectTo(createBillingCheckout)}
          >
            S'abonner
          </button>
        </>
      )}

      {(status.status === 'active' || status.status === 'trialing') && (
        <>
          <p>
            {status.status === 'active'
              ? 'Abonnement actif'
              : "Période d'essai"}
          </p>
          {status.currentPeriodEnd && (
            <p>
              Fin de période :{' '}
              {new Date(status.currentPeriodEnd).toLocaleDateString('fr-FR')}
            </p>
          )}
          <button
            type="button"
            disabled={pending}
            onClick={() => void redirectTo(createBillingPortal)}
          >
            Gérer mon abonnement
          </button>
        </>
      )}

      {status.status === 'past_due' && (
        <>
          <p role="alert">
            Paiement en retard — mettez à jour votre moyen de paiement
          </p>
          <button
            type="button"
            disabled={pending}
            onClick={() => void redirectTo(createBillingPortal)}
          >
            Gérer mon abonnement
          </button>
        </>
      )}

      {BLOCKED_STATUSES.has(status.status) && (
        <>
          <p role="alert">Émission de factures bloquée — abonnement requis</p>
          <button
            type="button"
            disabled={pending}
            onClick={() => void redirectTo(createBillingCheckout)}
          >
            S'abonner
          </button>
        </>
      )}
    </section>
  )
}
