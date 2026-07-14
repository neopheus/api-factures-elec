'use client'
import type { ReactNode } from 'react'
import { RequireAuth } from '../../components/require-auth'
import { useSession } from '../../lib/session-context'

export default function AppLayout({ children }: { children: ReactNode }) {
  const { logout } = useSession()
  return (
    <RequireAuth>
      <nav>
        <a href="/invoices">Factures</a> <a href="/api-keys">Clés API</a>{' '}
        <button type="button" onClick={() => void logout()}>
          Déconnexion
        </button>
      </nav>
      {children}
    </RequireAuth>
  )
}
