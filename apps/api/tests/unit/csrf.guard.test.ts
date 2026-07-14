import type { ExecutionContext } from '@nestjs/common'
import { ForbiddenException } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import type {
  AuthenticatedAdmin,
  AuthenticatedUser,
  SessionRequest,
} from '../../src/auth/auth.types.js'
import { CsrfGuard } from '../../src/auth/csrf.guard.js'
import { CSRF_HEADER, hashToken } from '../../src/auth/session-token.js'

function mockContext(opts: {
  header?: string
  authUser?: AuthenticatedUser
  authAdmin?: AuthenticatedAdmin
}): ExecutionContext {
  const req = {
    header: (name: string) => (name === CSRF_HEADER ? opts.header : undefined),
    authUser: opts.authUser,
    authAdmin: opts.authAdmin,
  } as unknown as SessionRequest
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext
}

const user: AuthenticatedUser = {
  sessionId: 's1',
  userId: 'u1',
  tenantId: 't1',
  role: 'owner',
  csrfHash: hashToken('the-real-csrf-token'),
}

describe('CsrfGuard', () => {
  it('rejects when there is no authUser/authAdmin at all (SessionGuard not applied first)', () => {
    const ctx = mockContext({ header: 'anything' })

    expect(() => new CsrfGuard().canActivate(ctx)).toThrow(ForbiddenException)
  })

  it('rejects when the X-CSRF-Token header is missing', () => {
    const ctx = mockContext({ authUser: user })

    expect(() => new CsrfGuard().canActivate(ctx)).toThrow(ForbiddenException)
  })

  it('rejects when the header does not match the stored hash', () => {
    const ctx = mockContext({ header: 'wrong-token', authUser: user })

    expect(() => new CsrfGuard().canActivate(ctx)).toThrow(ForbiddenException)
  })

  it('accepts a matching double-submit token (user session)', () => {
    const ctx = mockContext({ header: 'the-real-csrf-token', authUser: user })

    expect(new CsrfGuard().canActivate(ctx)).toBe(true)
  })

  it('accepts a matching double-submit token (admin session)', () => {
    const admin: AuthenticatedAdmin = {
      sessionId: 's2',
      adminId: 'a1',
      csrfHash: hashToken('admin-csrf-token'),
    }
    const ctx = mockContext({ header: 'admin-csrf-token', authAdmin: admin })

    expect(new CsrfGuard().canActivate(ctx)).toBe(true)
  })
})
