'use client'
import { useEffect, useState } from 'react'
import type { AdminTenantStats } from '../lib/api-types'
import { adminApi } from '../lib/client'

// Liste enrichie (Task 3/11, spec §3/§7) — remplace l'ancien tableau
// userCount/invoiceCount par les colonnes billing/volumes 30j/anomalies de
// `AdminTenantStats`, et rend chaque ligne cliquable vers le détail tenant.
export function TenantsTable() {
  const [tenants, setTenants] = useState<AdminTenantStats[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    adminApi
      .listTenants()
      .then((r) => setTenants(r.tenants))
      .catch(() => setError('Accès refusé'))
  }, [])
  if (error) return <p role="alert">{error}</p>
  return (
    <table>
      <thead>
        <tr>
          <th>Nom</th>
          <th>SIREN</th>
          <th>Statut</th>
          <th>Facturation</th>
          <th>Factures (30j)</th>
          <th>E-reporting (30j)</th>
          <th>Dead letters</th>
        </tr>
      </thead>
      <tbody>
        {tenants.map((t) => (
          <tr key={t.id}>
            <td>
              <a href={`/tenants/${t.id}`}>{t.name}</a>
            </td>
            <td>{t.siren ?? '—'}</td>
            <td>{t.suspendedAt ? 'Suspendu' : 'Actif'}</td>
            <td>{t.billingStatus}</td>
            <td>{t.invoices30d}</td>
            <td>{t.ereporting30d}</td>
            <td>{t.deadLetters}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
