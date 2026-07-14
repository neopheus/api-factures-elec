import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiKeysManager } from '../../src/components/api-keys-manager.js'

vi.mock('../../src/lib/client.js', () => ({
  apiKeysApi: { list: vi.fn(), create: vi.fn(), revoke: vi.fn() },
}))
const { apiKeysApi } = await import('../../src/lib/client.js')

describe('ApiKeysManager', () => {
  afterEach(() => vi.clearAllMocks())

  it('reveals the freshly created secret ONCE and never lists it', async () => {
    vi.mocked(apiKeysApi.list)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'k1',
          prefix: 'abc123',
          label: 'prod',
          createdAt: 'x',
          lastUsedAt: null,
          revokedAt: null,
        },
      ])
    vi.mocked(apiKeysApi.create).mockResolvedValue({
      id: 'k1',
      prefix: 'abc123',
      label: 'prod',
      createdAt: 'x',
      lastUsedAt: null,
      revokedAt: null,
      token: 'fk_abc123.SECRET',
    })
    render(<ApiKeysManager />)
    await userEvent.type(screen.getByLabelText(/libellé/i), 'prod')
    await userEvent.click(screen.getByRole('button', { name: /créer/i }))
    const banner = await screen.findByTestId('fresh-token')
    expect(within(banner).getByText('fk_abc123.SECRET')).toBeInTheDocument()
    // La ligne listée n'expose que le préfixe, jamais le secret.
    const item = await screen.findByText(/abc123… — prod/)
    expect(item).toBeInTheDocument()
    expect(screen.getAllByText('fk_abc123.SECRET')).toHaveLength(1) // uniquement dans la bannière

    // Fermer la bannière ("J'ai copié") : le secret ne doit plus jamais être affiché nulle part.
    await userEvent.click(screen.getByRole('button', { name: /j'ai copié/i }))
    expect(screen.queryByTestId('fresh-token')).toBeNull()
    expect(screen.queryByText('fk_abc123.SECRET')).toBeNull()
  })

  it('revokes a key and refreshes', async () => {
    vi.mocked(apiKeysApi.list)
      .mockResolvedValueOnce([
        {
          id: 'k1',
          prefix: 'abc123',
          label: 'prod',
          createdAt: 'x',
          lastUsedAt: null,
          revokedAt: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'k1',
          prefix: 'abc123',
          label: 'prod',
          createdAt: 'x',
          lastUsedAt: null,
          revokedAt: 'now',
        },
      ])
    vi.mocked(apiKeysApi.revoke).mockResolvedValue(undefined)
    render(<ApiKeysManager />)
    await userEvent.click(
      await screen.findByRole('button', { name: /révoquer/i }),
    )
    expect(apiKeysApi.revoke).toHaveBeenCalledWith('k1')
    expect(await screen.findByText(/révoquée/i)).toBeInTheDocument()
  })

  it('shows an error when the key list fails to load', async () => {
    vi.mocked(apiKeysApi.list).mockRejectedValueOnce(new Error('500'))
    render(<ApiKeysManager />)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /chargement impossible/i,
    )
  })

  it('shows an error when key creation fails, without revealing any secret', async () => {
    vi.mocked(apiKeysApi.list).mockResolvedValue([])
    vi.mocked(apiKeysApi.create).mockRejectedValueOnce(new Error('500'))
    render(<ApiKeysManager />)
    await userEvent.type(await screen.findByLabelText(/libellé/i), 'prod')
    await userEvent.click(screen.getByRole('button', { name: /créer/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /création impossible/i,
    )
    expect(screen.queryByTestId('fresh-token')).toBeNull()
  })

  it('shows an error when revocation fails', async () => {
    vi.mocked(apiKeysApi.list).mockResolvedValue([
      {
        id: 'k1',
        prefix: 'abc123',
        label: 'prod',
        createdAt: 'x',
        lastUsedAt: null,
        revokedAt: null,
      },
    ])
    vi.mocked(apiKeysApi.revoke).mockRejectedValueOnce(new Error('500'))
    render(<ApiKeysManager />)
    await userEvent.click(
      await screen.findByRole('button', { name: /révoquer/i }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /révocation impossible/i,
    )
  })

  it('renders an empty list with the create form when the tenant has no keys yet', async () => {
    vi.mocked(apiKeysApi.list).mockResolvedValueOnce([])
    render(<ApiKeysManager />)
    await screen.findByRole('button', { name: /créer/i })
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
  })

  it('does not call create when the label is only whitespace (client-side guard)', async () => {
    vi.mocked(apiKeysApi.list).mockResolvedValue([])
    render(<ApiKeysManager />)
    await userEvent.type(await screen.findByLabelText(/libellé/i), '   ')
    await userEvent.click(screen.getByRole('button', { name: /créer/i }))
    expect(apiKeysApi.create).not.toHaveBeenCalled()
  })
})
