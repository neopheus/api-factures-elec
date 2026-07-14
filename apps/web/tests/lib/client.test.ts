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

  it('lists tenants', async () => {
    const f = mockFetch([])
    vi.stubGlobal('fetch', f)
    expect(await adminApi.tenants()).toEqual([])
    expect(String(f.mock.calls[0]![0])).toBe(`${API_BASE}/admin/tenants`)
  })
})
