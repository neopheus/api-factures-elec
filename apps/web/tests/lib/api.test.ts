import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  API_BASE,
  ApiError,
  apiFetch,
  createBillingCheckout,
  createBillingPortal,
  getBillingStatus,
} from '../../src/lib/api.js'

function mockFetch(res: Partial<Response> & { jsonBody?: unknown }) {
  return vi.fn().mockResolvedValue({
    ok: res.ok ?? true,
    status: res.status ?? 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => res.jsonBody ?? {},
    text: async () => JSON.stringify(res.jsonBody ?? {}),
  } as unknown as Response)
}

describe('apiFetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    document.cookie = 'factelec_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT'
  })

  it('sends credentials and adds the CSRF header on mutations from the cookie', async () => {
    document.cookie = 'factelec_csrf=csrf-abc'
    const f = mockFetch({ jsonBody: { ok: true } })
    vi.stubGlobal('fetch', f)
    await apiFetch('/api-keys', {
      method: 'POST',
      body: JSON.stringify({ label: 'x' }),
    })
    const [, init] = f.mock.calls[0]!
    expect(init.credentials).toBe('include')
    expect((init.headers as Headers).get('X-CSRF-Token')).toBe('csrf-abc')
    expect((init.headers as Headers).get('Content-Type')).toBe(
      'application/json',
    )
  })

  it('does not add CSRF header on GET', async () => {
    document.cookie = 'factelec_csrf=csrf-abc'
    const f = mockFetch({ jsonBody: { items: [] } })
    vi.stubGlobal('fetch', f)
    await apiFetch('/invoices')
    expect(
      (f.mock.calls[0]![1].headers as Headers).get('X-CSRF-Token'),
    ).toBeNull()
  })

  it('does not add a CSRF header on mutations when no csrf cookie is present', async () => {
    // Pas de document.cookie factelec_csrf posé : readCsrfCookie() renvoie null (branche non couverte sinon).
    const f = mockFetch({ jsonBody: { ok: true } })
    vi.stubGlobal('fetch', f)
    await apiFetch('/api-keys', {
      method: 'POST',
      body: JSON.stringify({ label: 'x' }),
    })
    expect(
      (f.mock.calls[0]![1].headers as Headers).get('X-CSRF-Token'),
    ).toBeNull()
  })

  it('throws ApiError carrying the problem+json body on non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        ok: false,
        status: 401,
        jsonBody: {
          type: 'urn:factelec:problem:unauthorized',
          title: 'Unauthorized',
          status: 401,
          detail: 'Invalid credentials',
        },
      }),
    )
    await expect(apiFetch('/auth/me')).rejects.toMatchObject({
      problem: { status: 401, detail: 'Invalid credentials' },
    })
    await expect(apiFetch('/auth/me')).rejects.toBeInstanceOf(ApiError)
  })

  it('falls back to an about:blank problem when the error body is not JSON/object', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        headers: new Headers({ 'content-type': 'text/plain' }),
        json: async () => {
          throw new Error('should not be called')
        },
        text: async () => 'Internal Server Error',
      } as unknown as Response),
    )
    await expect(apiFetch('/auth/me')).rejects.toMatchObject({
      problem: { type: 'about:blank', title: 'Error', status: 500 },
    })
  })

  it('returns undefined on 204', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
        headers: new Headers(),
      } as unknown as Response),
    )
    expect(await apiFetch('/auth/logout', { method: 'POST' })).toBeUndefined()
  })

  it('omits the CSRF header on mutations when document is unavailable (SSR-like branch)', async () => {
    vi.stubGlobal('document', undefined)
    const f = mockFetch({ jsonBody: { ok: true } })
    vi.stubGlobal('fetch', f)
    await apiFetch('/api-keys', {
      method: 'POST',
      body: JSON.stringify({ label: 'x' }),
    })
    expect(
      (f.mock.calls[0]![1].headers as Headers).get('X-CSRF-Token'),
    ).toBeNull()
  })

  it('falls back to false when the success response has no content-type header at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => {
          throw new Error('should not be called')
        },
        text: async () => 'no-content-type-body',
      } as unknown as Response),
    )
    expect(await apiFetch('/invoices/1/formats/ubl')).toBe(
      'no-content-type-body',
    )
  })

  it('returns raw text on a non-JSON success response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/plain' }),
        json: async () => {
          throw new Error('should not be called')
        },
        text: async () => 'plain body',
      } as unknown as Response),
    )
    expect(await apiFetch('/invoices/1/formats/ubl')).toBe('plain body')
  })
})

describe('getBillingStatus', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('fetches the billing mirror status', async () => {
    const f = mockFetch({
      jsonBody: {
        status: 'active',
        currentPeriodEnd: '2026-08-01T00:00:00.000Z',
        hasCustomer: true,
      },
    })
    vi.stubGlobal('fetch', f)
    const result = await getBillingStatus()
    expect(result).toEqual({
      status: 'active',
      currentPeriodEnd: '2026-08-01T00:00:00.000Z',
      hasCustomer: true,
    })
    expect(String(f.mock.calls[0]![0])).toBe(`${API_BASE}/billing/status`)
    expect(f.mock.calls[0]![1]?.method ?? 'GET').toBe('GET')
  })
})

describe('createBillingCheckout', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('opens a hosted Checkout session', async () => {
    const f = mockFetch({ jsonBody: { url: 'https://checkout.stripe.com/x' } })
    vi.stubGlobal('fetch', f)
    const result = await createBillingCheckout()
    expect(result).toEqual({ url: 'https://checkout.stripe.com/x' })
    expect(String(f.mock.calls[0]![0])).toBe(
      `${API_BASE}/billing/checkout-session`,
    )
    expect(f.mock.calls[0]![1]?.method).toBe('POST')
  })
})

describe('createBillingPortal', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('opens a hosted Customer Portal session', async () => {
    const f = mockFetch({ jsonBody: { url: 'https://billing.stripe.com/p/x' } })
    vi.stubGlobal('fetch', f)
    const result = await createBillingPortal()
    expect(result).toEqual({ url: 'https://billing.stripe.com/p/x' })
    expect(String(f.mock.calls[0]![0])).toBe(
      `${API_BASE}/billing/portal-session`,
    )
    expect(f.mock.calls[0]![1]?.method).toBe('POST')
  })
})
