'use client'
import { useCallback, useEffect, useState } from 'react'
import type { InvoiceSummary } from '../lib/api-types'
import { invoicesApi } from '../lib/client'

export function InvoicesTable() {
  const [items, setItems] = useState<InvoiceSummary[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (c: string | null) => {
    try {
      const page = await invoicesApi.list(c)
      setItems((prev) => (c ? [...prev, ...page.items] : page.items))
      setCursor(page.nextCursor)
      setDone(page.nextCursor === null)
    } catch {
      setError('Chargement impossible')
    }
  }, [])

  useEffect(() => {
    void load(null)
  }, [load])

  return (
    <section>
      <table>
        <thead>
          <tr>
            <th>Numéro</th>
            <th>Type</th>
            <th>Date</th>
            <th>Statut</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.id}>
              <td>
                <a href={`/invoices/${i.id}`}>{i.number}</a>
              </td>
              <td>{i.typeCode}</td>
              <td>{i.issueDate}</td>
              <td>{i.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {error && <p role="alert">{error}</p>}
      {!done && (
        <button type="button" onClick={() => void load(cursor)}>
          Charger plus
        </button>
      )}
    </section>
  )
}
