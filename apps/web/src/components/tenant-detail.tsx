'use client'
import { useParams } from 'next/navigation'
import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { ApiError } from '../lib/api'
import type { AdminTenantDetail } from '../lib/api-types'
import { adminApi } from '../lib/client'

// Détail tenant super admin (Task 3/4/11, spec §3/§4/§7) : stats + 10
// dernières factures + billing + 20 dernières anomalies, plus les actions
// de suspension/réactivation. Chaque action passe par une étape de
// confirmation explicite (aucun bouton n'appelle l'API directement) — la
// suspension exige en plus un motif 1..500 (borne serveur `suspendSchema`,
// non dupliquée ici au-delà du `required`/`maxLength` du champ).
export function TenantDetail() {
  const params = useParams<{ id: string }>()
  const [tenant, setTenant] = useState<AdminTenantDetail | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [suspendFormOpen, setSuspendFormOpen] = useState(false)
  const [confirmingUnsuspend, setConfirmingUnsuspend] = useState(false)

  const load = useCallback(async () => {
    try {
      setTenant(await adminApi.tenantDetail(params.id))
    } catch {
      setLoadError('Tenant introuvable')
    }
  }, [params.id])

  useEffect(() => {
    void load()
  }, [load])

  async function onSuspend(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const reason = String(
      new FormData(e.currentTarget).get('reason') ?? '',
    ).trim()
    if (!reason) return
    setActionError(null)
    setPending(true)
    try {
      await adminApi.suspend(params.id, reason)
      setSuspendFormOpen(false)
      await load()
    } catch (err) {
      // 409 : seule cause possible ici est une suspension déjà en place
      // (course avec une autre session admin) — on resynchronise l'affichage
      // avec l'état serveur réel plutôt que de laisser un bouton périmé.
      setActionError(
        err instanceof ApiError && err.problem.status === 409
          ? 'Ce tenant est déjà suspendu (page resynchronisée).'
          : 'Suspension impossible',
      )
      await load()
    } finally {
      setPending(false)
    }
  }

  async function onUnsuspend() {
    setActionError(null)
    setPending(true)
    try {
      await adminApi.unsuspend(params.id)
      setConfirmingUnsuspend(false)
      await load()
    } catch (err) {
      setActionError(
        err instanceof ApiError && err.problem.status === 409
          ? "Ce tenant n'est plus suspendu (page resynchronisée)."
          : 'Réactivation impossible',
      )
      await load()
    } finally {
      setPending(false)
    }
  }

  if (loadError) return <p role="alert">{loadError}</p>
  if (!tenant) return <p>Chargement…</p>

  return (
    <article>
      <h1>{tenant.name}</h1>
      {tenant.suspendedAt && (
        <p role="status">Suspendu depuis {tenant.suspendedAt}</p>
      )}
      <dl>
        <dt>SIREN</dt>
        <dd>{tenant.siren ?? '—'}</dd>
        <dt>Créé le</dt>
        <dd>{tenant.createdAt}</dd>
        <dt>Facturation</dt>
        <dd>
          {tenant.billing.status}
          {tenant.billing.currentPeriodEnd &&
            ` — fin de période ${tenant.billing.currentPeriodEnd}`}
        </dd>
        <dt>Factures (30j)</dt>
        <dd>{tenant.invoices30d}</dd>
        <dt>E-reporting (30j)</dt>
        <dd>{tenant.ereporting30d}</dd>
        <dt>Dead letters</dt>
        <dd>{tenant.deadLetters}</dd>
      </dl>

      {actionError && <p role="alert">{actionError}</p>}

      {tenant.suspendedAt ? (
        confirmingUnsuspend ? (
          <div>
            <p>Confirmer la réactivation de ce tenant ?</p>
            <button
              type="button"
              disabled={pending}
              onClick={() => void onUnsuspend()}
            >
              Confirmer la réactivation
            </button>
            <button type="button" onClick={() => setConfirmingUnsuspend(false)}>
              Annuler
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setConfirmingUnsuspend(true)}>
            Réactiver
          </button>
        )
      ) : suspendFormOpen ? (
        <form onSubmit={onSuspend} aria-label="Suspendre le tenant">
          <label>
            Motif
            <textarea name="reason" required minLength={1} maxLength={500} />
          </label>
          <button type="submit" disabled={pending}>
            Confirmer la suspension
          </button>
          <button type="button" onClick={() => setSuspendFormOpen(false)}>
            Annuler
          </button>
        </form>
      ) : (
        <button type="button" onClick={() => setSuspendFormOpen(true)}>
          Suspendre
        </button>
      )}

      <h2>Dernières factures</h2>
      {tenant.invoices.length === 0 ? (
        <p>Aucune facture</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Numéro</th>
              <th>Statut</th>
              <th>Créée le</th>
            </tr>
          </thead>
          <tbody>
            {tenant.invoices.map((i) => (
              <tr key={i.id}>
                <td>{i.number}</td>
                <td>{i.lifecycleStatus}</td>
                <td>{i.createdAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Anomalies</h2>
      {tenant.anomalies.length === 0 ? (
        <p>Aucune anomalie</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Référence</th>
              <th>Détail</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>
            {tenant.anomalies.map((a) => (
              <tr key={`${a.kind}-${a.refId}`}>
                <td>{a.kind}</td>
                <td>{a.refId}</td>
                <td>{a.detail}</td>
                <td>{a.createdAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </article>
  )
}
