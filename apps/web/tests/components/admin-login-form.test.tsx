import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AdminLoginForm } from '../../src/components/admin-login-form.js'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

// Pas de mock de `lib/client` : gabarit `login-form.test.tsx`/`billing-panel.test.tsx`
// (composants qui distinguent `err instanceof ApiError`) — on stub `fetch` et on
// laisse tourner le vrai `apiFetch`/`ApiError`, seule façon d'obtenir une
// authentique instance `ApiError` sans dupliquer sa classe dans un mock.
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

const recoveryCodes = Array.from({ length: 10 }, (_, i) => `aaaa-${1000 + i}`)

async function fillLogin(email: string, password: string, code?: string) {
  await userEvent.type(screen.getByLabelText(/^email$/i), email)
  await userEvent.type(screen.getByLabelText(/mot de passe/i), password)
  if (code !== undefined) {
    await userEvent.type(
      screen.getByLabelText(/code totp ou code de récupération/i),
      code,
    )
  }
}

describe('AdminLoginForm', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    push.mockClear()
  })

  it('logs the admin in directly on a 200 response (état a)', async () => {
    const f = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, { admin: { id: '1', email: 'root@ex.com' } }),
      )
    vi.stubGlobal('fetch', f)
    render(<AdminLoginForm />)
    await fillLogin('root@ex.com', 'a-strong-passphrase-1')
    await userEvent.click(screen.getByRole('button', { name: /se connecter/i }))
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith('/tenants'))
    const [, init] = f.mock.calls[0]!
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'root@ex.com',
      password: 'a-strong-passphrase-1',
    })
  })

  it('sends the 6-digit code as totpCode', async () => {
    const f = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, { admin: { id: '1', email: 'root@ex.com' } }),
      )
    vi.stubGlobal('fetch', f)
    render(<AdminLoginForm />)
    await fillLogin('root@ex.com', 'a-strong-passphrase-1', '123456')
    await userEvent.click(screen.getByRole('button', { name: /se connecter/i }))
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith('/tenants'))
    const [, init] = f.mock.calls[0]!
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'root@ex.com',
      password: 'a-strong-passphrase-1',
      totpCode: '123456',
    })
  })

  it('sends a non-6-digit code as recoveryCode', async () => {
    const f = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, { admin: { id: '1', email: 'root@ex.com' } }),
      )
    vi.stubGlobal('fetch', f)
    render(<AdminLoginForm />)
    await fillLogin('root@ex.com', 'a-strong-passphrase-1', 'ab12-cd34')
    await userEvent.click(screen.getByRole('button', { name: /se connecter/i }))
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith('/tenants'))
    const [, init] = f.mock.calls[0]!
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'root@ex.com',
      password: 'a-strong-passphrase-1',
      recoveryCode: 'ab12-cd34',
    })
  })

  it('shows a generic error message on 401 (mauvais mot de passe ou code)', async () => {
    const f = vi.fn().mockResolvedValue(
      jsonResponse(401, {
        status: 401,
        title: 'Unauthorized',
        type: 'x',
        detail: 'Invalid credentials',
      }),
    )
    vi.stubGlobal('fetch', f)
    render(<AdminLoginForm />)
    await fillLogin('root@ex.com', 'a-strong-passphrase-1')
    await userEvent.click(screen.getByRole('button', { name: /se connecter/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Invalid credentials',
    )
    expect(push).not.toHaveBeenCalled()
  })

  it('falls back to a generic message when the 401 problem has no detail', async () => {
    const f = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(401, { status: 401, title: 'Unauthorized', type: 'x' }),
      )
    vi.stubGlobal('fetch', f)
    render(<AdminLoginForm />)
    await fillLogin('root@ex.com', 'a-strong-passphrase-1')
    await userEvent.click(screen.getByRole('button', { name: /se connecter/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Échec de connexion',
    )
  })

  it('shows a network-error message on a non-ApiError failure', async () => {
    const f = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', f)
    render(<AdminLoginForm />)
    await fillLogin('root@ex.com', 'a-strong-passphrase-1')
    await userEvent.click(screen.getByRole('button', { name: /se connecter/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Erreur réseau')
    expect(push).not.toHaveBeenCalled()
  })

  it('disables the submit button while the login request is pending', async () => {
    let resolveLogin!: (r: Response) => void
    const pending = new Promise<Response>((res) => {
      resolveLogin = res
    })
    const f = vi.fn().mockReturnValue(pending)
    vi.stubGlobal('fetch', f)
    render(<AdminLoginForm />)
    await fillLogin('root@ex.com', 'a-strong-passphrase-1')
    const button = screen.getByRole('button', { name: /se connecter/i })
    await userEvent.click(button)
    expect(button).toBeDisabled()
    resolveLogin(
      jsonResponse(200, { admin: { id: '1', email: 'root@ex.com' } }),
    )
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith('/tenants'))
  })

  it('202 → écran d’enrôlement → confirm → recovery codes affichés une fois → retour login (état b puis c)', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(202, {
          enrollmentRequired: true,
          otpauthUrl:
            'otpauth://totp/Factelec:root@ex.com?secret=JBSWY3DPEHPK3PXP',
          secret: 'JBSWY3DPEHPK3PXP',
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { recoveryCodes }))
    vi.stubGlobal('fetch', f)
    render(<AdminLoginForm />)
    await fillLogin('root@ex.com', 'a-strong-passphrase-1')
    await userEvent.click(screen.getByRole('button', { name: /se connecter/i }))

    // Écran d'enrôlement : secret + otpauthUrl en texte pur (aucune lib QR).
    expect(await screen.findByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument()
    expect(
      screen.getByRole('link', {
        name: 'otpauth://totp/Factelec:root@ex.com?secret=JBSWY3DPEHPK3PXP',
      }),
    ).toHaveAttribute(
      'href',
      'otpauth://totp/Factelec:root@ex.com?secret=JBSWY3DPEHPK3PXP',
    )
    expect(push).not.toHaveBeenCalled()

    await userEvent.type(screen.getByLabelText(/code à 6 chiffres/i), '654321')
    await userEvent.click(screen.getByRole('button', { name: /confirmer/i }))

    // La confirmation renvoie email+mot de passe d'origine (hors session).
    const [, confirmInit] = f.mock.calls[1]!
    expect(JSON.parse(confirmInit.body as string)).toEqual({
      email: 'root@ex.com',
      password: 'a-strong-passphrase-1',
      totpCode: '654321',
    })

    // Recovery codes affichés une seule fois, avec avertissement.
    for (const code of recoveryCodes) {
      expect(await screen.findByText(code)).toBeInTheDocument()
    }
    expect(screen.getByRole('alert')).toHaveTextContent(
      /ne réapparaîtront jamais/i,
    )

    await userEvent.click(
      screen.getByRole('button', { name: /j.ai noté mes codes/i }),
    )

    // Retour au login : les codes ne sont plus dans le DOM.
    expect(
      screen.getByRole('form', { name: /connexion admin/i }),
    ).toBeInTheDocument()
    expect(screen.queryByText(recoveryCodes[0]!)).toBeNull()
  })

  it('shows a generic error message when the confirm request is rejected', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(202, {
          enrollmentRequired: true,
          otpauthUrl: 'otpauth://totp/Factelec:root@ex.com?secret=ABC',
          secret: 'ABC',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(401, { status: 401, title: 'Unauthorized', type: 'x' }),
      )
    vi.stubGlobal('fetch', f)
    render(<AdminLoginForm />)
    await fillLogin('root@ex.com', 'a-strong-passphrase-1')
    await userEvent.click(screen.getByRole('button', { name: /se connecter/i }))
    await screen.findByText('ABC')
    await userEvent.type(screen.getByLabelText(/code à 6 chiffres/i), '000000')
    await userEvent.click(screen.getByRole('button', { name: /confirmer/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Échec de la confirmation',
    )
  })

  it('disables the confirm button while the confirmation request is pending', async () => {
    let resolveConfirm!: (r: Response) => void
    const confirmPending = new Promise<Response>((res) => {
      resolveConfirm = res
    })
    const f = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(202, {
          enrollmentRequired: true,
          otpauthUrl: 'otpauth://totp/Factelec:root@ex.com?secret=ABC',
          secret: 'ABC',
        }),
      )
      .mockReturnValueOnce(confirmPending)
    vi.stubGlobal('fetch', f)
    render(<AdminLoginForm />)
    await fillLogin('root@ex.com', 'a-strong-passphrase-1')
    await userEvent.click(screen.getByRole('button', { name: /se connecter/i }))
    await screen.findByText('ABC')
    await userEvent.type(screen.getByLabelText(/code à 6 chiffres/i), '000000')
    const confirmButton = screen.getByRole('button', { name: /confirmer/i })
    await userEvent.click(confirmButton)
    expect(confirmButton).toBeDisabled()
    resolveConfirm(jsonResponse(200, { recoveryCodes }))
    await screen.findByText(recoveryCodes[0]!)
  })
})
