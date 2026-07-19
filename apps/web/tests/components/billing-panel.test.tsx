import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BillingPanel } from '../../src/components/billing-panel.js'

// Pas de mock de `lib/api` : gabarit `login-form.test.tsx`/`signup-form.test.tsx`
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

const statusOf = (
  status: string,
  currentPeriodEnd: string | null = null,
  hasCustomer = true,
) => jsonResponse(200, { status, currentPeriodEnd, hasCustomer })

const assign = vi.fn()

describe('BillingPanel', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, assign },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    assign.mockClear()
  })

  it('shows a loading indicator before the first status resolves', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockReturnValue(new Promise(() => {})), // ne se résout jamais durant ce test
    )
    render(<BillingPanel />)
    expect(screen.getByText('Chargement…')).toBeInTheDocument()
  })

  it('status "none": invite à s\'abonner, redirige vers Checkout hébergé', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(statusOf('none', null, false))
      .mockResolvedValueOnce(
        jsonResponse(201, { url: 'https://checkout.stripe.com/abc' }),
      )
    vi.stubGlobal('fetch', f)
    render(<BillingPanel />)
    const button = await screen.findByRole('button', { name: /s'abonner/i })
    await userEvent.click(button)
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith('https://checkout.stripe.com/abc'),
    )
  })

  it('status "active" : abonnement actif avec date de fin formatée fr-FR, redirige vers le Portal', async () => {
    const periodEnd = '2026-08-15T10:00:00.000Z'
    const f = vi
      .fn()
      .mockResolvedValueOnce(statusOf('active', periodEnd))
      .mockResolvedValueOnce(
        jsonResponse(201, { url: 'https://billing.stripe.com/p/abc' }),
      )
    vi.stubGlobal('fetch', f)
    render(<BillingPanel />)
    expect(await screen.findByText(/abonnement actif/i)).toBeInTheDocument()
    const expectedDate = new Date(periodEnd).toLocaleDateString('fr-FR')
    expect(
      screen.getByText(new RegExp(expectedDate.replace(/\//g, '\\/'))),
    ).toBeInTheDocument()
    const button = screen.getByRole('button', {
      name: /gérer mon abonnement/i,
    })
    await userEvent.click(button)
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith('https://billing.stripe.com/p/abc'),
    )
  })

  it('status "trialing" sans date de fin connue : période d\'essai, aucune date affichée', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(statusOf('trialing', null)),
    )
    render(<BillingPanel />)
    expect(await screen.findByText(/période d'essai/i)).toBeInTheDocument()
    expect(screen.queryByText(/fin de période/i)).toBeNull()
  })

  it('status "past_due" : bannière d\'alerte + bouton Portal ; erreur réseau → message générique', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(statusOf('past_due', null))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', f)
    render(<BillingPanel />)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/paiement en retard/i)
    await userEvent.click(
      screen.getByRole('button', { name: /gérer mon abonnement/i }),
    )
    expect(
      await screen.findByText(/redirection impossible/i),
    ).toBeInTheDocument()
    expect(assign).not.toHaveBeenCalled()
  })

  it('statuts "canceled"/"unpaid"/"incomplete" : bannière de blocage + bouton S\'abonner', async () => {
    for (const status of ['canceled', 'unpaid', 'incomplete']) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(statusOf(status)))
      const { unmount } = render(<BillingPanel />)
      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent(/bloqu/i)
      expect(
        screen.getByRole('button', { name: /s'abonner/i }),
      ).toBeInTheDocument()
      unmount()
      vi.unstubAllGlobals()
    }
  })

  it('status "canceled" : échec de la redirection Checkout → message générique, pas de navigation', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(statusOf('canceled'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', f)
    render(<BillingPanel />)
    await userEvent.click(
      await screen.findByRole('button', { name: /s'abonner/i }),
    )
    expect(
      await screen.findByText(/redirection impossible/i),
    ).toBeInTheDocument()
    expect(assign).not.toHaveBeenCalled()
  })

  it('erreur 503 billing-disabled : "Facturation indisponible", aucun bouton', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        jsonResponse(503, {
          type: 'urn:factelec:problem:billing-disabled',
          title: 'Billing disabled',
          status: 503,
          detail: 'BILLING_DRIVER=none',
        }),
      ),
    )
    render(<BillingPanel />)
    expect(
      await screen.findByText(/facturation indisponible/i),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('erreur générique (non billing-disabled) au chargement du statut', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        jsonResponse(500, {
          type: 'about:blank',
          title: 'Error',
          status: 500,
        }),
      ),
    )
    render(<BillingPanel />)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /chargement impossible/i,
    )
  })

  it("désactive le bouton pendant l'appel de redirection en cours", async () => {
    let resolveCheckout!: (r: Response) => void
    const pending = new Promise<Response>((res) => {
      resolveCheckout = res
    })
    const f = vi
      .fn()
      .mockResolvedValueOnce(statusOf('none', null, false))
      .mockReturnValueOnce(pending)
    vi.stubGlobal('fetch', f)
    render(<BillingPanel />)
    const button = await screen.findByRole('button', { name: /s'abonner/i })
    await userEvent.click(button)
    expect(button).toBeDisabled()
    resolveCheckout(jsonResponse(201, { url: 'https://checkout.stripe.com/x' }))
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith('https://checkout.stripe.com/x'),
    )
  })
})
