import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TenantDetail } from '../../src/components/tenant-detail.js'
import { ApiError } from '../../src/lib/api.js'
import type { AdminTenantDetail } from '../../src/lib/api-types.js'

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 't1' }),
}))
vi.mock('../../src/lib/client.js', () => ({
  adminApi: {
    tenantDetail: vi.fn(),
    suspend: vi.fn(),
    unsuspend: vi.fn(),
  },
}))
const client = await import('../../src/lib/client.js')

// Annotation explicite (pas d'inférence de littéral) : `billingStatus`/
// `billing.status`/`anomalies[].kind` sont des unions de chaînes littérales
// dans `AdminTenantDetail` — sans elle, TypeScript élargirait ces propriétés
// en `string` sur ce `const` réutilisé (spread) plus bas et casserait
// `pnpm typecheck` au passage à `mockResolvedValueOnce`.
const baseDetail: AdminTenantDetail = {
  id: 't1',
  name: 'Shop A',
  siren: '123456789',
  createdAt: '2026-01-01T00:00:00Z',
  suspendedAt: null,
  billingStatus: 'active',
  invoices30d: 2,
  ereporting30d: 1,
  deadLetters: 0,
  invoices: [
    {
      id: 'i1',
      number: 'FA-1',
      lifecycleStatus: 'issued',
      createdAt: '2026-07-01T00:00:00Z',
    },
  ],
  billing: {
    status: 'active',
    currentPeriodEnd: '2026-08-01T00:00:00Z',
    hasCustomer: true,
  },
  anomalies: [
    {
      kind: 'dead_letter',
      tenantId: 't1',
      refId: 'j1',
      detail: 'boom',
      createdAt: '2026-07-02T00:00:00Z',
    },
  ],
}

describe('TenantDetail', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders tenant stats, last invoices and anomalies', async () => {
    vi.mocked(client.adminApi.tenantDetail).mockResolvedValue(baseDetail)
    render(<TenantDetail />)
    expect(
      await screen.findByRole('heading', { name: 'Shop A' }),
    ).toBeInTheDocument()
    expect(screen.getByText('FA-1')).toBeInTheDocument()
    expect(screen.getByText('issued')).toBeInTheDocument()
    expect(screen.getByText('boom')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Suspendre' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('renders empty-state messages when there are no invoices or anomalies', async () => {
    vi.mocked(client.adminApi.tenantDetail).mockResolvedValue({
      ...baseDetail,
      invoices: [],
      anomalies: [],
    })
    render(<TenantDetail />)
    await screen.findByRole('heading', { name: 'Shop A' })
    expect(screen.getByText('Aucune facture')).toBeInTheDocument()
    expect(screen.getByText('Aucune anomalie')).toBeInTheDocument()
  })

  it('shows an error when the tenant cannot be found', async () => {
    vi.mocked(client.adminApi.tenantDetail).mockRejectedValue(new Error('404'))
    render(<TenantDetail />)
    expect(await screen.findByRole('alert')).toHaveTextContent(/introuvable/i)
  })

  it('suspends the tenant after entering a reason and confirming', async () => {
    vi.mocked(client.adminApi.tenantDetail)
      .mockResolvedValueOnce(baseDetail)
      .mockResolvedValueOnce({
        ...baseDetail,
        suspendedAt: '2026-07-19T00:00:00Z',
      })
    vi.mocked(client.adminApi.suspend).mockResolvedValue({
      suspendedAt: '2026-07-19T00:00:00Z',
    })
    render(<TenantDetail />)
    await userEvent.click(
      await screen.findByRole('button', { name: 'Suspendre' }),
    )
    await userEvent.type(screen.getByLabelText(/motif/i), 'Fraude suspectée')
    await userEvent.click(
      screen.getByRole('button', { name: /confirmer la suspension/i }),
    )
    await waitFor(() =>
      expect(client.adminApi.suspend).toHaveBeenCalledWith(
        't1',
        'Fraude suspectée',
      ),
    )
    expect(await screen.findByText(/suspendu depuis/i)).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Réactiver' }),
    ).toBeInTheDocument()
  })

  it('does not call suspend when the reason is only whitespace (client-side guard, HTML required accepts it)', async () => {
    vi.mocked(client.adminApi.tenantDetail).mockResolvedValue(baseDetail)
    render(<TenantDetail />)
    await userEvent.click(
      await screen.findByRole('button', { name: 'Suspendre' }),
    )
    await userEvent.type(screen.getByLabelText(/motif/i), '   ')
    await userEvent.click(
      screen.getByRole('button', { name: /confirmer la suspension/i }),
    )
    expect(client.adminApi.suspend).not.toHaveBeenCalled()
  })

  it('shows a message on a 409 conflict while suspending, and resyncs the tenant state', async () => {
    vi.mocked(client.adminApi.tenantDetail)
      .mockResolvedValueOnce(baseDetail)
      .mockResolvedValueOnce({
        ...baseDetail,
        suspendedAt: '2026-07-15T00:00:00Z',
      })
    vi.mocked(client.adminApi.suspend).mockRejectedValue(
      new ApiError({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: 'Tenant already suspended',
      }),
    )
    render(<TenantDetail />)
    await userEvent.click(
      await screen.findByRole('button', { name: 'Suspendre' }),
    )
    await userEvent.type(screen.getByLabelText(/motif/i), 'Fraude')
    await userEvent.click(
      screen.getByRole('button', { name: /confirmer la suspension/i }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(/déjà suspendu/i)
    expect(await screen.findByText(/suspendu depuis/i)).toBeInTheDocument()
  })

  it('shows a generic error on a non-409 failure while suspending', async () => {
    vi.mocked(client.adminApi.tenantDetail).mockResolvedValue(baseDetail)
    vi.mocked(client.adminApi.suspend).mockRejectedValue(new Error('500'))
    render(<TenantDetail />)
    await userEvent.click(
      await screen.findByRole('button', { name: 'Suspendre' }),
    )
    await userEvent.type(screen.getByLabelText(/motif/i), 'Fraude')
    await userEvent.click(
      screen.getByRole('button', { name: /confirmer la suspension/i }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /suspension impossible/i,
    )
  })

  it('cancels the suspend form without calling the API', async () => {
    vi.mocked(client.adminApi.tenantDetail).mockResolvedValue(baseDetail)
    render(<TenantDetail />)
    await userEvent.click(
      await screen.findByRole('button', { name: 'Suspendre' }),
    )
    expect(screen.getByLabelText(/motif/i)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Annuler' }))
    expect(client.adminApi.suspend).not.toHaveBeenCalled()
    expect(screen.queryByLabelText(/motif/i)).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Suspendre' }),
    ).toBeInTheDocument()
  })

  it('shows a message on a 409 conflict while unsuspending, and resyncs the tenant state', async () => {
    const suspended = { ...baseDetail, suspendedAt: '2026-07-10T00:00:00Z' }
    vi.mocked(client.adminApi.tenantDetail)
      .mockResolvedValueOnce(suspended)
      .mockResolvedValueOnce(baseDetail)
    vi.mocked(client.adminApi.unsuspend).mockRejectedValue(
      new ApiError({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: 'Tenant not suspended',
      }),
    )
    render(<TenantDetail />)
    await userEvent.click(
      await screen.findByRole('button', { name: 'Réactiver' }),
    )
    await userEvent.click(
      screen.getByRole('button', { name: /confirmer la réactivation/i }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /n'est plus suspendu/i,
    )
    expect(
      await screen.findByRole('button', { name: 'Suspendre' }),
    ).toBeInTheDocument()
  })

  it('shows a generic error on a non-409 failure while unsuspending', async () => {
    const suspended = { ...baseDetail, suspendedAt: '2026-07-10T00:00:00Z' }
    vi.mocked(client.adminApi.tenantDetail).mockResolvedValue(suspended)
    vi.mocked(client.adminApi.unsuspend).mockRejectedValue(new Error('500'))
    render(<TenantDetail />)
    await userEvent.click(
      await screen.findByRole('button', { name: 'Réactiver' }),
    )
    await userEvent.click(
      screen.getByRole('button', { name: /confirmer la réactivation/i }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /réactivation impossible/i,
    )
  })

  it('reactivates a suspended tenant after confirmation', async () => {
    const suspended = { ...baseDetail, suspendedAt: '2026-07-10T00:00:00Z' }
    vi.mocked(client.adminApi.tenantDetail)
      .mockResolvedValueOnce(suspended)
      .mockResolvedValueOnce(baseDetail)
    vi.mocked(client.adminApi.unsuspend).mockResolvedValue(undefined)
    render(<TenantDetail />)
    await userEvent.click(
      await screen.findByRole('button', { name: 'Réactiver' }),
    )
    await userEvent.click(
      screen.getByRole('button', { name: /confirmer la réactivation/i }),
    )
    await waitFor(() =>
      expect(client.adminApi.unsuspend).toHaveBeenCalledWith('t1'),
    )
    expect(
      await screen.findByRole('button', { name: 'Suspendre' }),
    ).toBeInTheDocument()
  })

  it('cancels the unsuspend confirmation without calling the API', async () => {
    const suspended = { ...baseDetail, suspendedAt: '2026-07-10T00:00:00Z' }
    vi.mocked(client.adminApi.tenantDetail).mockResolvedValue(suspended)
    render(<TenantDetail />)
    await userEvent.click(
      await screen.findByRole('button', { name: 'Réactiver' }),
    )
    await userEvent.click(screen.getByRole('button', { name: 'Annuler' }))
    expect(client.adminApi.unsuspend).not.toHaveBeenCalled()
    expect(
      await screen.findByRole('button', { name: 'Réactiver' }),
    ).toBeInTheDocument()
  })
})
