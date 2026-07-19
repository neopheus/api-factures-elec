import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TenantsTable } from '../../src/components/tenants-table.js'

vi.mock('../../src/lib/client.js', () => ({
  adminApi: { listTenants: vi.fn() },
}))
const client = await import('../../src/lib/client.js')

describe('TenantsTable', () => {
  it('renders the enriched columns for an active tenant, with a clickable name', async () => {
    vi.mocked(client.adminApi.listTenants).mockResolvedValue({
      tenants: [
        {
          id: 't1',
          name: 'Shop A',
          siren: '123456789',
          createdAt: '2026-01-01T00:00:00Z',
          suspendedAt: null,
          billingStatus: 'active',
          invoices30d: 4,
          ereporting30d: 2,
          deadLetters: 1,
        },
      ],
    })
    render(<TenantsTable />)
    expect(await screen.findByText('Shop A')).toBeInTheDocument()
    expect(screen.getByText('123456789')).toBeInTheDocument()
    expect(screen.getByText('Actif')).toBeInTheDocument()
    expect(screen.getByText('active')).toBeInTheDocument()
    expect(screen.getByText('4')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Shop A' })).toHaveAttribute(
      'href',
      '/tenants/t1',
    )
    expect(screen.queryByText('Suspendu')).toBeNull()
  })

  it('renders a SUSPENDU badge and a placeholder SIREN for a suspended tenant without one', async () => {
    vi.mocked(client.adminApi.listTenants).mockResolvedValue({
      tenants: [
        {
          id: 't2',
          name: 'Shop B',
          siren: null,
          createdAt: '2026-01-01T00:00:00Z',
          suspendedAt: '2026-07-01T00:00:00Z',
          billingStatus: 'canceled',
          invoices30d: 0,
          ereporting30d: 0,
          deadLetters: 0,
        },
      ],
    })
    render(<TenantsTable />)
    expect(await screen.findByText('Suspendu')).toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.queryByText('Actif')).toBeNull()
  })

  it('shows an error when access is denied', async () => {
    vi.mocked(client.adminApi.listTenants).mockRejectedValue(new Error('403'))
    render(<TenantsTable />)
    expect(await screen.findByRole('alert')).toHaveTextContent(/refusé/i)
  })
})
