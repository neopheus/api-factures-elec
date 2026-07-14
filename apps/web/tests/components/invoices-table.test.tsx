import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InvoicesTable } from '../../src/components/invoices-table.js'

vi.mock('../../src/lib/client.js', () => ({ invoicesApi: { list: vi.fn() } }))
const { invoicesApi } = await import('../../src/lib/client.js')

describe('InvoicesTable', () => {
  afterEach(() => vi.clearAllMocks())

  it('loads the first page and appends the next via keyset cursor', async () => {
    vi.mocked(invoicesApi.list)
      .mockResolvedValueOnce({
        items: [
          {
            id: '1',
            number: 'FA-1',
            typeCode: '380',
            issueDate: '2026-07-01',
            currency: 'EUR',
            status: 'generated',
            createdAt: 'x',
          },
        ],
        nextCursor: 'c1',
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: '2',
            number: 'FA-2',
            typeCode: '380',
            issueDate: '2026-07-02',
            currency: 'EUR',
            status: 'generated',
            createdAt: 'y',
          },
        ],
        nextCursor: null,
      })
    render(<InvoicesTable />)
    expect(await screen.findByText('FA-1')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /charger plus/i }))
    expect(await screen.findByText('FA-2')).toBeInTheDocument()
    expect(invoicesApi.list).toHaveBeenNthCalledWith(2, 'c1')
    expect(screen.queryByRole('button', { name: /charger plus/i })).toBeNull() // nextCursor null → bouton disparaît
  })

  it('shows an error when the first page fails to load, and allows retrying via the same button', async () => {
    vi.mocked(invoicesApi.list)
      .mockRejectedValueOnce(new Error('500'))
      .mockResolvedValueOnce({
        items: [
          {
            id: '1',
            number: 'FA-1',
            typeCode: '380',
            issueDate: '2026-07-01',
            currency: 'EUR',
            status: 'generated',
            createdAt: 'x',
          },
        ],
        nextCursor: null,
      })
    render(<InvoicesTable />)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /chargement impossible/i,
    )
    // Le bouton reste disponible (aucune page confirmée close) : sert de nouvelle tentative.
    await userEvent.click(screen.getByRole('button', { name: /charger plus/i }))
    expect(await screen.findByText('FA-1')).toBeInTheDocument()
    expect(invoicesApi.list).toHaveBeenNthCalledWith(2, null)
  })

  it('renders an empty table with no pagination button when the tenant has no invoices', async () => {
    vi.mocked(invoicesApi.list).mockResolvedValueOnce({
      items: [],
      nextCursor: null,
    })
    render(<InvoicesTable />)
    expect(
      await screen.findByRole('columnheader', { name: 'Numéro' }),
    ).toBeInTheDocument()
    expect(screen.queryAllByRole('row')).toHaveLength(1) // seule la ligne d'en-tête
    expect(screen.queryByRole('button', { name: /charger plus/i })).toBeNull()
  })
})
