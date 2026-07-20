import { afterEach, describe, expect, it, vi } from 'vitest'
import { API_BASE } from '../../src/lib/api.js'
import { adminApi, apiKeysApi, invoicesApi } from '../../src/lib/client.js'

function mockFetch(jsonBody: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => jsonBody,
    text: async () => JSON.stringify(jsonBody),
  } as unknown as Response)
}

describe('invoicesApi', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists invoices without a cursor', async () => {
    const f = mockFetch({ items: [], nextCursor: null })
    vi.stubGlobal('fetch', f)
    const page = await invoicesApi.list()
    expect(page).toEqual({ items: [], nextCursor: null })
    expect(String(f.mock.calls[0]![0])).toBe(`${API_BASE}/invoices`)
  })

  it('lists invoices with a cursor, URL-encoded in the query string', async () => {
    const f = mockFetch({ items: [], nextCursor: null })
    vi.stubGlobal('fetch', f)
    await invoicesApi.list('cursor with space')
    expect(String(f.mock.calls[0]![0])).toBe(
      `${API_BASE}/invoices?cursor=cursor%20with%20space`,
    )
  })

  it('gets a single invoice by id', async () => {
    const detail = {
      id: '1',
      number: 'F-1',
      typeCode: '380',
      issueDate: '2026-01-01',
      currency: 'EUR',
      status: 'issued',
      createdAt: '2026-01-01T00:00:00Z',
      availableFormats: ['ubl'],
    }
    const f = mockFetch(detail)
    vi.stubGlobal('fetch', f)
    expect(await invoicesApi.get('1')).toEqual(detail)
    expect(String(f.mock.calls[0]![0])).toBe(`${API_BASE}/invoices/1`)
  })

  it('builds a format download URL without making a request', () => {
    expect(invoicesApi.formatUrl('1', 'ubl')).toBe(
      `${API_BASE}/invoices/1/formats/ubl`,
    )
  })
})

describe('apiKeysApi', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists API keys', async () => {
    const f = mockFetch([])
    vi.stubGlobal('fetch', f)
    expect(await apiKeysApi.list()).toEqual([])
    expect(String(f.mock.calls[0]![0])).toBe(`${API_BASE}/api-keys`)
  })

  it('creates an API key with the given label', async () => {
    const created = {
      id: '1',
      prefix: 'fe_ab',
      label: 'ci',
      createdAt: '2026-01-01T00:00:00Z',
      lastUsedAt: null,
      revokedAt: null,
      token: 'fe_ab_secret',
    }
    const f = mockFetch(created)
    vi.stubGlobal('fetch', f)
    expect(await apiKeysApi.create('ci')).toEqual(created)
    const [url, init] = f.mock.calls[0]!
    expect(String(url)).toBe(`${API_BASE}/api-keys`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ label: 'ci' })
  })

  it('revokes an API key by id', async () => {
    const f = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      headers: new Headers(),
    } as unknown as Response)
    vi.stubGlobal('fetch', f)
    expect(await apiKeysApi.revoke('1')).toBeUndefined()
    const [url, init] = f.mock.calls[0]!
    expect(String(url)).toBe(`${API_BASE}/api-keys/1`)
    expect(init.method).toBe('DELETE')
  })
})

describe('adminApi', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('logs an admin in', async () => {
    const f = mockFetch({ admin: { id: '1', email: 'root@ex.com' } })
    vi.stubGlobal('fetch', f)
    expect(await adminApi.login('root@ex.com', 'p')).toEqual({
      admin: { id: '1', email: 'root@ex.com' },
    })
    const [url, init] = f.mock.calls[0]!
    expect(String(url)).toBe(`${API_BASE}/admin/login`)
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'root@ex.com',
      password: 'p',
    })
  })

  it('logs an admin in with a 6-digit code sent as totpCode', async () => {
    const f = mockFetch({ admin: { id: '1', email: 'root@ex.com' } })
    vi.stubGlobal('fetch', f)
    await adminApi.login('root@ex.com', 'p', '123456')
    const [, init] = f.mock.calls[0]!
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'root@ex.com',
      password: 'p',
      totpCode: '123456',
    })
  })

  it('logs an admin in with a non-6-digit code sent as recoveryCode', async () => {
    const f = mockFetch({ admin: { id: '1', email: 'root@ex.com' } })
    vi.stubGlobal('fetch', f)
    await adminApi.login('root@ex.com', 'p', 'ab12-cd34')
    const [, init] = f.mock.calls[0]!
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'root@ex.com',
      password: 'p',
      recoveryCode: 'ab12-cd34',
    })
  })

  it('surfaces a 202 enrollment-required response without a session', async () => {
    const f = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        enrollmentRequired: true,
        otpauthUrl: 'otpauth://totp/Factelec:root@ex.com?secret=ABC',
        secret: 'ABC',
      }),
      text: async () => '',
    } as unknown as Response)
    vi.stubGlobal('fetch', f)
    expect(await adminApi.login('root@ex.com', 'p')).toEqual({
      enrollmentRequired: true,
      otpauthUrl: 'otpauth://totp/Factelec:root@ex.com?secret=ABC',
      secret: 'ABC',
    })
  })

  it('confirms TOTP enrollment and receives the recovery codes once', async () => {
    const f = mockFetch({ recoveryCodes: ['aaaa-1111', 'bbbb-2222'] })
    vi.stubGlobal('fetch', f)
    expect(await adminApi.confirmTotp('root@ex.com', 'p', '123456')).toEqual({
      recoveryCodes: ['aaaa-1111', 'bbbb-2222'],
    })
    const [url, init] = f.mock.calls[0]!
    expect(String(url)).toBe(`${API_BASE}/admin/totp/confirm`)
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'root@ex.com',
      password: 'p',
      totpCode: '123456',
    })
  })

  it('lists enriched tenants (contrat Task 3 : enveloppe { tenants })', async () => {
    const tenants = [
      {
        id: 't1',
        name: 'Shop A',
        siren: null,
        createdAt: '2026-01-01T00:00:00Z',
        suspendedAt: null,
        billingStatus: 'active',
        invoices30d: 3,
        ereporting30d: 1,
        deadLetters: 0,
      },
    ]
    const f = mockFetch({ tenants })
    vi.stubGlobal('fetch', f)
    expect(await adminApi.listTenants()).toEqual({ tenants })
    expect(String(f.mock.calls[0]![0])).toBe(`${API_BASE}/admin/tenants`)
  })

  it('gets tenant detail by id', async () => {
    const detail = {
      id: 't1',
      name: 'Shop A',
      siren: null,
      createdAt: '2026-01-01T00:00:00Z',
      suspendedAt: null,
      billingStatus: 'active',
      invoices30d: 0,
      ereporting30d: 0,
      deadLetters: 0,
      invoices: [],
      billing: { status: 'active', currentPeriodEnd: null, hasCustomer: true },
      anomalies: [],
    }
    const f = mockFetch(detail)
    vi.stubGlobal('fetch', f)
    expect(await adminApi.tenantDetail('t1')).toEqual(detail)
    expect(String(f.mock.calls[0]![0])).toBe(`${API_BASE}/admin/tenants/t1`)
  })

  it('suspends a tenant with a reason', async () => {
    const f = mockFetch({ suspendedAt: '2026-07-19T00:00:00Z' })
    vi.stubGlobal('fetch', f)
    expect(await adminApi.suspend('t1', 'Fraude suspectée')).toEqual({
      suspendedAt: '2026-07-19T00:00:00Z',
    })
    const [url, init] = f.mock.calls[0]!
    expect(String(url)).toBe(`${API_BASE}/admin/tenants/t1/suspend`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({
      reason: 'Fraude suspectée',
    })
  })

  it('unsuspends a tenant', async () => {
    const f = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      headers: new Headers(),
    } as unknown as Response)
    vi.stubGlobal('fetch', f)
    expect(await adminApi.unsuspend('t1')).toBeUndefined()
    const [url, init] = f.mock.calls[0]!
    expect(String(url)).toBe(`${API_BASE}/admin/tenants/t1/unsuspend`)
    expect(init.method).toBe('POST')
  })

  it('lists anomalies without a limit', async () => {
    const f = mockFetch({ anomalies: [] })
    vi.stubGlobal('fetch', f)
    expect(await adminApi.anomalies()).toEqual({ anomalies: [] })
    expect(String(f.mock.calls[0]![0])).toBe(`${API_BASE}/admin/anomalies`)
  })

  it('lists anomalies with a limit in the query string', async () => {
    const f = mockFetch({ anomalies: [] })
    vi.stubGlobal('fetch', f)
    await adminApi.anomalies(10)
    expect(String(f.mock.calls[0]![0])).toBe(
      `${API_BASE}/admin/anomalies?limit=10`,
    )
  })
})
