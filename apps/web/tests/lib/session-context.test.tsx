import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionProvider, useSession } from '../../src/lib/session-context.js'

function Consumer() {
  const { user, loading, logout } = useSession()
  if (loading) return <p>loading</p>
  return (
    <div>
      <p data-testid="user">{user ? user.email : 'anonymous'}</p>
      <button type="button" onClick={() => void logout()}>
        Se déconnecter
      </button>
    </div>
  )
}

function BareConsumer() {
  useSession()
  return null
}

describe('useSession', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('throws when used outside SessionProvider', () => {
    // Rend l'erreur de rendu silencieuse dans les logs de test (comportement React attendu, pas une régression).
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<BareConsumer />)).toThrow(
      'useSession must be used within SessionProvider',
    )
    consoleError.mockRestore()
  })

  it('clears the user on logout', async () => {
    const meOk = () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          user: {
            id: '1',
            email: 'u@ex.com',
            role: 'owner',
            tenantId: 't',
            emailVerified: true,
          },
        }),
        text: async () => '',
      }) as unknown as Response
    const logoutNoContent = () =>
      ({
        ok: true,
        status: 204,
        headers: new Headers(),
        json: async () => ({}),
        text: async () => '',
      }) as unknown as Response
    let i = 0
    const handlers = [meOk, logoutNoContent]
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(handlers[Math.min(i++, 1)]!()),
        ),
    )

    render(
      <SessionProvider>
        <Consumer />
      </SessionProvider>,
    )
    expect(await screen.findByTestId('user')).toHaveTextContent('u@ex.com')
    await userEvent.click(
      screen.getByRole('button', { name: /se déconnecter/i }),
    )
    expect(await screen.findByTestId('user')).toHaveTextContent('anonymous')
  })
})
