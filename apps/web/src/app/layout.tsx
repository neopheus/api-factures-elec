import type { ReactNode } from 'react'
import { SessionProvider } from '../lib/session-context'
import './globals.css'

export const metadata = { title: 'Factelec — Dashboard' }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body>
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  )
}
