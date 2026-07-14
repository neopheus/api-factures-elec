import type { ExecutionContext } from '@nestjs/common'
import { UnauthorizedException } from '@nestjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionRequest } from '../../src/auth/auth.types.js'
import { SessionGuard } from '../../src/auth/session.guard.js'
import type {
  SessionService,
  SessionSubject,
} from '../../src/auth/session.service.js'
import { SESSION_COOKIE } from '../../src/auth/session-token.js'

function mockContext(cookies?: Record<string, string>): {
  ctx: ExecutionContext
  req: SessionRequest
} {
  const req = { cookies } as unknown as SessionRequest
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext
  return { ctx, req }
}

describe('SessionGuard', () => {
  let find: ReturnType<typeof vi.fn>
  let guard: SessionGuard

  beforeEach(() => {
    find = vi.fn()
    guard = new SessionGuard({ find } as unknown as SessionService)
  })

  it('rejects when there is no session cookie at all (401 problem+json, no service call)', async () => {
    const { ctx } = mockContext(undefined)

    await expect(guard.canActivate(ctx)).rejects.toMatchObject(
      new UnauthorizedException(
        expect.objectContaining({
          status: 401,
          type: 'urn:factelec:problem:unauthorized',
        }),
      ),
    )
    expect(find).not.toHaveBeenCalled()
  })

  it('rejects when the session is not found (unknown/invalid token)', async () => {
    find.mockResolvedValue(null)
    const { ctx } = mockContext({ [SESSION_COOKIE]: 'tok' })

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
    expect(find).toHaveBeenCalledWith('tok')
  })

  it('rejects when neither userId+tenantId nor adminId are present on the subject (malformed row, defensive)', async () => {
    const subject: SessionSubject = {
      sessionId: 's1',
      userId: null,
      adminId: null,
      tenantId: null,
      role: null,
      csrfHash: 'h',
    }
    find.mockResolvedValue(subject)
    const { ctx } = mockContext({ [SESSION_COOKIE]: 'tok' })

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
  })

  it('accepts a user session: sets req.authUser and req.tenantId, returns true', async () => {
    const subject: SessionSubject = {
      sessionId: 's1',
      userId: 'user-1',
      adminId: null,
      tenantId: 'tenant-1',
      role: 'owner',
      csrfHash: 'h',
    }
    find.mockResolvedValue(subject)
    const { ctx, req } = mockContext({ [SESSION_COOKIE]: 'tok' })

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
    expect(req.authAdmin).toBeUndefined()
  })

  it('defaults the role to viewer when the joined role is null (defensive)', async () => {
    const subject: SessionSubject = {
      sessionId: 's1',
      userId: 'user-1',
      adminId: null,
      tenantId: 'tenant-1',
      role: null,
      csrfHash: 'h',
    }
    find.mockResolvedValue(subject)
    const { ctx, req } = mockContext({ [SESSION_COOKIE]: 'tok' })

    await guard.canActivate(ctx)

    expect(req.authUser?.role).toBe('viewer')
  })

  it('accepts an admin session: sets req.authAdmin, returns true, never sets tenantId', async () => {
    const subject: SessionSubject = {
      sessionId: 's1',
      userId: null,
      adminId: 'admin-1',
      tenantId: null,
      role: null,
      csrfHash: 'h',
    }
    find.mockResolvedValue(subject)
    const { ctx, req } = mockContext({ [SESSION_COOKIE]: 'tok' })

    const activated = await guard.canActivate(ctx)

    expect(activated).toBe(true)
    expect(req.authAdmin).toEqual({
      sessionId: 's1',
      adminId: 'admin-1',
      csrfHash: 'h',
    })
    expect(req.authUser).toBeUndefined()
    expect(req.tenantId).toBeUndefined()
  })

  it('anti-oracle: missing cookie and an unknown/expired token produce the identical 401 problem body', async () => {
    const { ctx: ctxNoCookie } = mockContext(undefined)
    const noCookieError = await guard.canActivate(ctxNoCookie).catch((e) => e)

    find.mockResolvedValue(null)
    const { ctx: ctxBadToken } = mockContext({
      [SESSION_COOKIE]: 'expired-or-unknown',
    })
    const badTokenError = await guard.canActivate(ctxBadToken).catch((e) => e)

    expect(noCookieError.getResponse()).toEqual(badTokenError.getResponse())
  })
})
