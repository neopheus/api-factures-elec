import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AnomaliesTable } from '../../src/components/anomalies-table.js'

vi.mock('../../src/lib/client.js', () => ({
  adminApi: { anomalies: vi.fn() },
}))
const client = await import('../../src/lib/client.js')

describe('AnomaliesTable', () => {
  it('renders the read-only columns (kind, tenant, detail, date)', async () => {
    vi.mocked(client.adminApi.anomalies).mockResolvedValue({
      anomalies: [
        {
          kind: 'dead_letter',
          tenantId: 't1',
          refId: 'j1',
          detail: 'job failed 5 times',
          createdAt: '2026-07-18T00:00:00Z',
        },
        {
          kind: 'cdv_parked',
          tenantId: 't2',
          refId: 'inv-1',
          detail: 'parked',
          createdAt: '2026-07-17T00:00:00Z',
        },
      ],
    })
    render(<AnomaliesTable />)
    expect(await screen.findByText('dead_letter')).toBeInTheDocument()
    expect(screen.getByText('t1')).toBeInTheDocument()
    expect(screen.getByText('job failed 5 times')).toBeInTheDocument()
    expect(screen.getByText('2026-07-18T00:00:00Z')).toBeInTheDocument()
    expect(screen.getByText('cdv_parked')).toBeInTheDocument()
    expect(screen.getByText('t2')).toBeInTheDocument()
  })

  it('renders an empty-state message when there are no anomalies', async () => {
    vi.mocked(client.adminApi.anomalies).mockResolvedValue({ anomalies: [] })
    render(<AnomaliesTable />)
    expect(await screen.findByText('Aucune anomalie')).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('shows an error when the anomalies list fails to load', async () => {
    vi.mocked(client.adminApi.anomalies).mockRejectedValue(new Error('403'))
    render(<AnomaliesTable />)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /chargement impossible/i,
    )
  })
})
