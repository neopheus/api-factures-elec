import type { ExecutionContext } from '@nestjs/common'
import { UnauthorizedException } from '@nestjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiKeyService } from '../../src/auth/api-key.service.js'
import type { SessionRequest } from '../../src/auth/auth.types.js'
import type {
  SessionService,
  SessionSubject,
} from '../../src/auth/session.service.js'
import { SESSION_COOKIE } from '../../src/auth/session-token.js'
import { TenantAuthGuard } from '../../src/auth/tenant-auth.guard.js'
import { ProblemType } from '../../src/common/problem.js'

function mockContext(input: {
  authorization?: string
  cookies?: Record<string, string>
}): { ctx: ExecutionContext; req: SessionRequest } {
  const req = {
    header: (name: string) =>
      name.toLowerCase() === 'authorization' ? input.authorization : undefined,
    cookies: input.cookies,
  } as unknown as SessionRequest
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext
  return { ctx, req }
}

function userSubject(overrides: Partial<SessionSubject> = {}): SessionSubject {
  return {
    sessionId: 's1',
    userId: 'user-1',
    adminId: null,
    tenantId: 'tenant-1',
    role: 'owner',
    csrfHash: 'h',
    ...overrides,
  }
}

describe('TenantAuthGuard', () => {
  let authenticate: ReturnType<typeof vi.fn>
  let find: ReturnType<typeof vi.fn>
  let guard: TenantAuthGuard

  beforeEach(() => {
    authenticate = vi.fn()
    find = vi.fn()
    guard = new TenantAuthGuard(
      { authenticate } as unknown as ApiKeyService,
      { find } as unknown as SessionService,
    )
  })

  it('rejects when there is neither an Authorization header nor a session cookie (401, no service call)', async () => {
    const { ctx } = mockContext({})

    await expect(guard.canActivate(ctx)).rejects.toMatchObject(
      new UnauthorizedException(
        expect.objectContaining({
          status: 401,
          type: ProblemType.unauthorized,
        }),
      ),
    )
    expect(authenticate).not.toHaveBeenCalled()
    expect(find).not.toHaveBeenCalled()
  })

  it('accepts a valid API key: sets req.tenantId/apiKeyId, returns true, never touches sessions', async () => {
    authenticate.mockResolvedValue({ apiKeyId: 'key-1', tenantId: 'tenant-1' })
    const { ctx, req } = mockContext({ authorization: 'Bearer fk_x.y' })

    const activated = await guard.canActivate(ctx)

    expect(activated).toBe(true)
    expect(req.tenantId).toBe('tenant-1')
    expect(req.apiKeyId).toBe('key-1')
    expect(find).not.toHaveBeenCalled()
  })

  it('rejects an invalid Bearer token WITHOUT falling back to a cookie present on the same request (precedence: Bearer is authoritative)', async () => {
    authenticate.mockResolvedValue(null)
    const { ctx } = mockContext({
      authorization: 'Bearer bad-key',
      cookies: { [SESSION_COOKIE]: 'valid-token' },
    })

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
    expect(authenticate).toHaveBeenCalledWith('bad-key')
    expect(find).not.toHaveBeenCalled()
  })

  it('prefers a valid Bearer over a cookie present on the same request (precedence: Bearer wins)', async () => {
    authenticate.mockResolvedValue({
      apiKeyId: 'key-1',
      tenantId: 'tenant-key',
    })
    find.mockResolvedValue(userSubject({ tenantId: 'tenant-cookie' }))
    const { ctx, req } = mockContext({
      authorization: 'Bearer fk_x.y',
      cookies: { [SESSION_COOKIE]: 'tok' },
    })

    const activated = await guard.canActivate(ctx)

    expect(activated).toBe(true)
    expect(req.tenantId).toBe('tenant-key')
    expect(req.apiKeyId).toBe('key-1')
    expect(req.authUser).toBeUndefined()
    expect(find).not.toHaveBeenCalled()
  })

  it('falls through to the session cookie when there is no Authorization header at all', async () => {
    find.mockResolvedValue(userSubject())
    const { ctx, req } = mockContext({ cookies: { [SESSION_COOKIE]: 'tok' } })

    const activated = await guard.canActivate(ctx)

    expect(activated).toBe(true)
    expect(req.authUser).toEqual({
      sessionId: 's1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      role: 'owner',
      csrfHash: 'h',
    })
    expect(req.tenantId).toBe('tenant-1')
    expect(find).toHaveBeenCalledWith('tok')
  })

  it('falls through to the session cookie when the Authorization header has a malformed scheme (not "Bearer ...")', async () => {
    find.mockResolvedValue(userSubject())
    const { ctx, req } = mockContext({
      authorization: 'Basic dXNlcjpwYXNz',
      cookies: { [SESSION_COOKIE]: 'tok' },
    })

    const activated = await guard.canActivate(ctx)

    expect(activated).toBe(true)
    expect(req.tenantId).toBe('tenant-1')
    expect(authenticate).not.toHaveBeenCalled()
  })

  it('defaults the role to viewer when the joined role is null (defensive)', async () => {
    find.mockResolvedValue(userSubject({ role: null }))
    const { ctx, req } = mockContext({ cookies: { [SESSION_COOKIE]: 'tok' } })

    await guard.canActivate(ctx)

    expect(req.authUser?.role).toBe('viewer')
  })

  it('rejects when the session cookie is unknown/expired (session.find returns null)', async () => {
    find.mockResolvedValue(null)
    const { ctx } = mockContext({ cookies: { [SESSION_COOKIE]: 'unknown' } })

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
  })

  it('rejects an admin session (no userId/tenantId): admin sessions never authenticate an invoice read', async () => {
    find.mockResolvedValue({
      sessionId: 's1',
      userId: null,
      adminId: 'admin-1',
      tenantId: null,
      role: null,
      csrfHash: 'h',
    } satisfies SessionSubject)
    const { ctx, req } = mockContext({
      cookies: { [SESSION_COOKIE]: 'admin-tok' },
    })

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
    expect(req.authUser).toBeUndefined()
    expect(req.tenantId).toBeUndefined()
  })

  it('anti-oracle: no credentials at all and an unknown/expired cookie produce the identical 401 problem body', async () => {
    const { ctx: ctxNone } = mockContext({})
    const noneError = await guard.canActivate(ctxNone).catch((e) => e)

    find.mockResolvedValue(null)
    const { ctx: ctxBadCookie } = mockContext({
      cookies: { [SESSION_COOKIE]: 'unknown' },
    })
    const badCookieError = await guard.canActivate(ctxBadCookie).catch((e) => e)

    expect(noneError.getResponse()).toEqual(badCookieError.getResponse())
  })
})
