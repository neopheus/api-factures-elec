'use client'
import { useEffect, useState } from 'react'
import type { TenantOverview } from '../lib/api-types'
import { adminApi } from '../lib/client'

export function TenantsTable() {
  const [tenants, setTenants] = useState<TenantOverview[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    adminApi
      .tenants()
      .then(setTenants)
      .catch(() => setError('Accès refusé'))
  }, [])
  if (error) return <p role="alert">{error}</p>
  return (
    <table>
      <thead>
        <tr>
          <th>Nom</th>
          <th>SIREN</th>
          <th>Utilisateurs</th>
          <th>Factures</th>
        </tr>
      </thead>
      <tbody>
        {tenants.map((t) => (
          <tr key={t.id}>
            <td>{t.name}</td>
            <td>{t.siren ?? '—'}</td>
            <td>{t.userCount}</td>
            <td>{t.invoiceCount}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
