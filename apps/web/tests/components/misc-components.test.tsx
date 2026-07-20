import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { InvoiceDetail } from '../../src/components/invoice-detail.js'
import { RequireAuth } from '../../src/components/require-auth.js'
import { SessionProvider } from '../../src/lib/session-context.js'

const replace = vi.fn()
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'inv-1' }),
  useRouter: () => ({ replace, push: vi.fn() }),
}))
vi.mock('../../src/lib/client.js', () => ({
  invoicesApi: {
    get: vi.fn(),
    formatUrl: (id: string, k: string) =>
      `http://api/invoices/${id}/formats/${k}`,
  },
  authApi: { me: vi.fn(), logout: vi.fn() },
}))
const client = await import('../../src/lib/client.js')

describe('InvoiceDetail', () => {
  it('renders fields and format download links', async () => {
    vi.mocked(client.invoicesApi.get).mockResolvedValue({
      id: 'inv-1',
      number: 'FA-9',
      typeCode: '380',
      issueDate: '2026-07-01',
      currency: 'EUR',
      status: 'generated',
      createdAt: '2026-07-01T00:00:00Z',
      availableFormats: ['ubl', 'facturx'],
    })
    render(<InvoiceDetail />)
    expect(
      await screen.findByRole('heading', { name: 'FA-9' }),
    ).toBeInTheDocument()
    expect(await screen.findByRole('link', { name: 'ubl' })).toHaveAttribute(
      'href',
      'http://api/invoices/inv-1/formats/ubl',
    )
  })

  it('shows an error when the invoice cannot be found or is not accessible', async () => {
    vi.mocked(client.invoicesApi.get).mockRejectedValueOnce(new Error('404'))
    render(<InvoiceDetail />)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /facture introuvable/i,
    )
  })

  it('renders no format links when the invoice has none available yet', async () => {
    vi.mocked(client.invoicesApi.get).mockResolvedValue({
      id: 'inv-1',
      number: 'FA-10',
      typeCode: '380',
      issueDate: '2026-07-01',
      currency: 'EUR',
      status: 'pending',
      createdAt: '2026-07-01T00:00:00Z',
      availableFormats: [],
    })
    render(<InvoiceDetail />)
    expect(
      await screen.findByRole('heading', { name: 'FA-10' }),
    ).toBeInTheDocument()
    expect(screen.queryAllByRole('link')).toHaveLength(0)
  })
})

describe('RequireAuth', () => {
  it('shows a loading indicator before the session resolves', () => {
    vi.mocked(client.authApi.me).mockReturnValue(new Promise(() => {})) // ne se résout jamais durant ce test
    render(
      <SessionProvider>
        <RequireAuth>
          <p>secret</p>
        </RequireAuth>
      </SessionProvider>,
    )
    expect(screen.getByText('Chargement…')).toBeInTheDocument()
    expect(screen.queryByText('secret')).toBeNull()
  })

  it('redirects to /login when unauthenticated', async () => {
    vi.mocked(client.authApi.me).mockRejectedValue(new Error('401'))
    render(
      <SessionProvider>
        <RequireAuth>
          <p>secret</p>
        </RequireAuth>
      </SessionProvider>,
    )
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login'))
    expect(screen.queryByText('secret')).toBeNull()
  })
  it('renders children when authenticated', async () => {
    vi.mocked(client.authApi.me).mockResolvedValue({
      user: {
        id: '1',
        email: 'u@ex.com',
        role: 'owner',
        tenantId: 't',
        emailVerified: false,
      },
    })
    render(
      <SessionProvider>
        <RequireAuth>
          <p>secret</p>
        </RequireAuth>
      </SessionProvider>,
    )
    expect(await screen.findByText('secret')).toBeInTheDocument()
  })
})
