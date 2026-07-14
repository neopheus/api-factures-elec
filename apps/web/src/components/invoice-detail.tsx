'use client'
import { useParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import type { InvoiceDetail as Detail } from '../lib/api-types'
import { invoicesApi } from '../lib/client'

export function InvoiceDetail() {
  const params = useParams<{ id: string }>()
  const [invoice, setInvoice] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    invoicesApi
      .get(params.id)
      .then(setInvoice)
      .catch(() => setError('Facture introuvable'))
  }, [params.id])

  if (error) return <p role="alert">{error}</p>
  if (!invoice) return <p>Chargement…</p>
  return (
    <article>
      <h1>{invoice.number}</h1>
      <dl>
        <dt>Type</dt>
        <dd>{invoice.typeCode}</dd>
        <dt>Date</dt>
        <dd>{invoice.issueDate}</dd>
        <dt>Devise</dt>
        <dd>{invoice.currency}</dd>
        <dt>Statut</dt>
        <dd>{invoice.status}</dd>
      </dl>
      <h2>Formats disponibles</h2>
      <ul>
        {invoice.availableFormats.map((f) => (
          <li key={f}>
            <a href={invoicesApi.formatUrl(invoice.id, f)}>{f}</a>
          </li>
        ))}
      </ul>
    </article>
  )
}
