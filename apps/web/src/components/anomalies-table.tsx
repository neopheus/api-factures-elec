'use client'
import { useEffect, useState } from 'react'
import type { AdminAnomaly } from '../lib/api-types'
import { adminApi } from '../lib/client'

// Vue anomalies plateforme (Task 6/11, spec §3/§7) — lecture seule, tri
// createdAt desc déjà posé côté serveur (SD find_admin_anomalies).
export function AnomaliesTable() {
  const [anomalies, setAnomalies] = useState<AdminAnomaly[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    adminApi
      .anomalies()
      .then((r) => setAnomalies(r.anomalies))
      .catch(() => setError('Chargement impossible'))
  }, [])
  if (error) return <p role="alert">{error}</p>
  if (anomalies.length === 0) return <p>Aucune anomalie</p>
  return (
    <table>
      <thead>
        <tr>
          <th>Type</th>
          <th>Tenant</th>
          <th>Détail</th>
          <th>Date</th>
        </tr>
      </thead>
      <tbody>
        {anomalies.map((a) => (
          <tr key={`${a.kind}-${a.refId}`}>
            <td>{a.kind}</td>
            <td>{a.tenantId}</td>
            <td>{a.detail}</td>
            <td>{a.createdAt}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
