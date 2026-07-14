import type { ExecutionContext } from '@nestjs/common'
import { ForbiddenException } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import { AdminGuard } from '../../src/admin/admin.guard.js'
import type {
  AuthenticatedAdmin,
  SessionRequest,
} from '../../src/auth/auth.types.js'

function mockContext(authAdmin?: AuthenticatedAdmin): ExecutionContext {
  const req = { authAdmin } as unknown as SessionRequest
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext
}

describe('AdminGuard', () => {
  it('allows access when req.authAdmin is set (admin session, guard placed after SessionGuard)', () => {
    const guard = new AdminGuard()
    const ctx = mockContext({ sessionId: 's1', adminId: 'a1', csrfHash: 'h' })

    expect(guard.canActivate(ctx)).toBe(true)
  })

  it('rejects with 403 when req.authAdmin is absent (regular user session, or malformed request)', () => {
    const guard = new AdminGuard()
    const ctx = mockContext(undefined)

    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException)
  })
})
