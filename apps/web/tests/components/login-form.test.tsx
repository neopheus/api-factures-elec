import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LoginForm } from '../../src/components/login-form.js'
import { SessionProvider } from '../../src/lib/session-context.js'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

function mockFetchSequence(handlers: Array<() => Response>) {
  let i = 0
  return vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(handlers[Math.min(i++, handlers.length - 1)]!()),
    )
}
const meUnauthed = () =>
  ({
    ok: false,
    status: 401,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({ status: 401, title: 'Unauthorized', type: 'x' }),
    text: async () => '',
  }) as unknown as Response

describe('LoginForm', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    push.mockClear()
  })

  it('shows an error when credentials are rejected', async () => {
    // 1er appel : /auth/me du provider (401) ; 2e : /auth/login (401)
    vi.stubGlobal(
      'fetch',
      mockFetchSequence([
        meUnauthed,
        () =>
          ({
            ok: false,
            status: 401,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => ({
              status: 401,
              title: 'Unauthorized',
              type: 'x',
              detail: 'Invalid credentials',
            }),
            text: async () => '',
          }) as unknown as Response,
      ]),
    )
    render(
      <SessionProvider>
        <LoginForm />
      </SessionProvider>,
    )
    await userEvent.type(screen.getByLabelText(/email/i), 'user@ex.com')
    await userEvent.type(
      screen.getByLabelText(/mot de passe/i),
      'a-strong-passphrase-1',
    )
    await userEvent.click(screen.getByRole('button', { name: /se connecter/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Invalid credentials',
    )
    expect(push).not.toHaveBeenCalled()
  })

  it('navigates to /invoices on success', async () => {
    const ok = () =>
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
            emailVerified: false,
          },
        }),
        text: async () => '',
      }) as unknown as Response
    vi.stubGlobal('fetch', mockFetchSequence([meUnauthed, ok, ok])) // me(401), login(200), refresh me(200)
    render(
      <SessionProvider>
        <LoginForm />
      </SessionProvider>,
    )
    await userEvent.type(screen.getByLabelText(/email/i), 'u@ex.com')
    await userEvent.type(
      screen.getByLabelText(/mot de passe/i),
      'a-strong-passphrase-1',
    )
    await userEvent.click(screen.getByRole('button', { name: /se connecter/i }))
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith('/invoices'))
  })

  it('shows a validation error and makes no login request when the email is malformed', async () => {
    const f = mockFetchSequence([meUnauthed])
    vi.stubGlobal('fetch', f)
    render(
      <SessionProvider>
        <LoginForm />
      </SessionProvider>,
    )
    // "user@localhost" satisfait la contrainte native input[type=email] (jsdom laisse donc
    // le submit atteindre le handler) mais échoue le regex zod (exige un TLD) : ça exerce
    // la branche safeParse(...).success === false sans être bloqué par la validation native.
    await userEvent.type(screen.getByLabelText(/email/i), 'user@localhost')
    await userEvent.type(
      screen.getByLabelText(/mot de passe/i),
      'a-strong-passphrase-1',
    )
    await userEvent.click(screen.getByRole('button', { name: /se connecter/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Identifiants invalides',
    )
    expect(
      f.mock.calls.every(([url]) => !String(url).includes('/auth/login')),
    ).toBe(true)
    expect(push).not.toHaveBeenCalled()
  })

  it('falls back to a generic message when the ApiError problem has no detail', async () => {
    const noDetail = () =>
      ({
        ok: false,
        status: 401,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ status: 401, title: 'Unauthorized', type: 'x' }),
        text: async () => '',
      }) as unknown as Response
    vi.stubGlobal('fetch', mockFetchSequence([meUnauthed, noDetail]))
    render(
      <SessionProvider>
        <LoginForm />
      </SessionProvider>,
    )
    await userEvent.type(screen.getByLabelText(/email/i), 'user@ex.com')
    await userEvent.type(
      screen.getByLabelText(/mot de passe/i),
      'a-strong-passphrase-1',
    )
    await userEvent.click(screen.getByRole('button', { name: /se connecter/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Échec de connexion',
    )
  })

  it('shows a network-error message when the request fails without an ApiError (non-ApiError catch branch)', async () => {
    let i = 0
    const handlers: Array<() => Response> = [meUnauthed]
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        if (i < handlers.length) return Promise.resolve(handlers[i++]!())
        return Promise.reject(new TypeError('Failed to fetch'))
      }),
    )
    render(
      <SessionProvider>
        <LoginForm />
      </SessionProvider>,
    )
    await userEvent.type(screen.getByLabelText(/email/i), 'u@ex.com')
    await userEvent.type(
      screen.getByLabelText(/mot de passe/i),
      'a-strong-passphrase-1',
    )
    await userEvent.click(screen.getByRole('button', { name: /se connecter/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Erreur réseau')
    expect(push).not.toHaveBeenCalled()
  })
})
