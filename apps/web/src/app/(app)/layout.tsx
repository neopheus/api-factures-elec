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
        {/* Pas de logique de rôle dans cette nav (aucun lien existant n'en a) :
            le lien reste visible à tous, le serveur refuse déjà les viewers en
            403 sur /billing/* (Task 6, RolesGuard owner|admin). */}
        <a href="/billing">Abonnement</a>{' '}
        <button type="button" onClick={() => void logout()}>
          Déconnexion
        </button>
      </nav>
      {children}
    </RequireAuth>
  )
}
