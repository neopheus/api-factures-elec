import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SignupForm } from '../../src/components/signup-form.js'
import { SessionProvider } from '../../src/lib/session-context.js'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
const me401 = () =>
  ({
    ok: false,
    status: 401,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({ status: 401, title: 'x', type: 'x' }),
    text: async () => '',
  }) as unknown as Response
const created = () =>
  ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({
      user: {
        id: '1',
        email: 'o@ex.com',
        role: 'owner',
        tenantId: 't',
        emailVerified: false,
      },
    }),
    text: async () => '',
  }) as unknown as Response

describe('SignupForm', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    push.mockClear()
  })

  it('validates the password client-side before calling the API', async () => {
    const f = vi.fn().mockImplementation(() => Promise.resolve(me401()))
    vi.stubGlobal('fetch', f)
    render(
      <SessionProvider>
        <SignupForm />
      </SessionProvider>,
    )
    await userEvent.type(screen.getByLabelText(/email/i), 'o@ex.com')
    await userEvent.type(screen.getByLabelText(/mot de passe/i), 'short')
    await userEvent.type(screen.getByLabelText(/organisation/i), 'Ma Boutique')
    await userEvent.click(
      screen.getByRole('button', { name: /créer mon compte/i }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(/12 caractères/i)
    // Aucune requête signup émise (seul le /auth/me du provider a pu partir).
    expect(
      f.mock.calls.every(([url]) => !String(url).includes('/auth/signup')),
    ).toBe(true)
  })

  it('signs up (with a SIREN) and navigates to /invoices', async () => {
    let i = 0
    const handlers = [me401, created, created] // me(401), signup(200), refresh me(200)
    const f = vi
      .fn()
      .mockImplementation(() => Promise.resolve(handlers[Math.min(i++, 2)]!()))
    vi.stubGlobal('fetch', f)
    render(
      <SessionProvider>
        <SignupForm />
      </SessionProvider>,
    )
    await userEvent.type(screen.getByLabelText(/email/i), 'o@ex.com')
    await userEvent.type(
      screen.getByLabelText(/mot de passe/i),
      'a-strong-passphrase-1',
    )
    await userEvent.type(screen.getByLabelText(/organisation/i), 'Ma Boutique')
    // SIREN renseigné et valide : exerce la branche non vide du transform zod (siren.ts, `v !== ''`).
    await userEvent.type(screen.getByLabelText(/siren/i), '123456789')
    await userEvent.click(
      screen.getByRole('button', { name: /créer mon compte/i }),
    )
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith('/invoices'))
    const signupCall = f.mock.calls.find(([url]) =>
      String(url).includes('/auth/signup'),
    )
    expect(signupCall).toBeDefined()
    const [, signupInit] = signupCall as unknown as [string, RequestInit]
    expect(JSON.parse(signupInit.body as string)).toMatchObject({
      siren: '123456789',
    })
  })

  it('shows a network-error message when the request fails without an ApiError (non-ApiError catch branch)', async () => {
    let i = 0
    const handlers: Array<() => Response> = [me401]
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        if (i < handlers.length) return Promise.resolve(handlers[i++]!())
        return Promise.reject(new TypeError('Failed to fetch'))
      }),
    )
    render(
      <SessionProvider>
        <SignupForm />
      </SessionProvider>,
    )
    await userEvent.type(screen.getByLabelText(/email/i), 'o@ex.com')
    await userEvent.type(
      screen.getByLabelText(/mot de passe/i),
      'a-strong-passphrase-1',
    )
    await userEvent.type(screen.getByLabelText(/organisation/i), 'Ma Boutique')
    await userEvent.click(
      screen.getByRole('button', { name: /créer mon compte/i }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('Erreur réseau')
    expect(push).not.toHaveBeenCalled()
  })

  it('falls back to a generic message when the ApiError problem has no detail', async () => {
    let i = 0
    const conflictNoDetail = () =>
      ({
        ok: false,
        status: 409,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          type: 'urn:factelec:problem:conflict',
          title: 'Conflict',
          status: 409,
        }),
        text: async () => '',
      }) as unknown as Response
    const handlers = [me401, conflictNoDetail]
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
        <SignupForm />
      </SessionProvider>,
    )
    await userEvent.type(screen.getByLabelText(/email/i), 'o@ex.com')
    await userEvent.type(
      screen.getByLabelText(/mot de passe/i),
      'a-strong-passphrase-1',
    )
    await userEvent.type(screen.getByLabelText(/organisation/i), 'Ma Boutique')
    await userEvent.click(
      screen.getByRole('button', { name: /créer mon compte/i }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Échec de l'inscription",
    )
  })

  it('shows the API problem detail when signup fails server-side (ApiError branch)', async () => {
    let i = 0
    const conflict = () =>
      ({
        ok: false,
        status: 409,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          type: 'urn:factelec:problem:conflict',
          title: 'Conflict',
          status: 409,
          detail: 'Email already registered',
        }),
        text: async () => '',
      }) as unknown as Response
    const handlers = [me401, conflict]
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
        <SignupForm />
      </SessionProvider>,
    )
    await userEvent.type(screen.getByLabelText(/email/i), 'o@ex.com')
    await userEvent.type(
      screen.getByLabelText(/mot de passe/i),
      'a-strong-passphrase-1',
    )
    await userEvent.type(screen.getByLabelText(/organisation/i), 'Ma Boutique')
    await userEvent.click(
      screen.getByRole('button', { name: /créer mon compte/i }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Email already registered',
    )
    expect(push).not.toHaveBeenCalled()
  })
})
