'use client'
import { useRouter } from 'next/navigation'
import { type ReactNode, useEffect } from 'react'
import { useSession } from '../lib/session-context'

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useSession()
  const router = useRouter()
  useEffect(() => {
    if (!loading && !user) router.replace('/login')
  }, [loading, user, router])
  if (loading) return <p>Chargement…</p>
  if (!user) return null
  return <>{children}</>
}
