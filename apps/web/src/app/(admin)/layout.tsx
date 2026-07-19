import type { ReactNode } from 'react'

// Nav minimale du groupe (admin) — introduite par cette tâche (Task 11) :
// aucune n'existait avant (seule `/tenants` était routée, sans layout).
// Pas de logique de session ici (server component, aucun hook) : chaque
// page enfant gère elle-même l'échec 401/403 de son propre appel API
// (même patron que `TenantsTable`/`AnomaliesTable`/`TenantDetail`).
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <nav>
        <a href="/tenants">Tenants</a> <a href="/anomalies">Anomalies</a>
      </nav>
      {children}
    </>
  )
}
