import type { ExecutionContext } from '@nestjs/common'
import { ForbiddenException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import { AdminGuard } from '../../src/admin/admin.guard.js'
import type {
  AuthenticatedAdmin,
  SessionRequest,
} from '../../src/auth/auth.types.js'

function mockContext(authAdmin?: AuthenticatedAdmin): {
  ctx: ExecutionContext
  req: SessionRequest
} {
  const req = { authAdmin } as unknown as SessionRequest
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext
  return { ctx, req }
}

describe('AdminGuard', () => {
  it('allows access when req.authAdmin is set (admin session, guard placed after SessionGuard)', () => {
    const guard = new AdminGuard()
    const { ctx } = mockContext({
      sessionId: 's1',
      adminId: 'a1',
      csrfHash: 'h',
    })

    expect(guard.canActivate(ctx)).toBe(true)
  })

  it('rejects with 403 when req.authAdmin is absent (regular user session, or malformed request)', () => {
    const guard = new AdminGuard()
    const { ctx } = mockContext(undefined)

    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException)
  })

  it('corrélation logs (Task 9, spec §6) : req.log rebindé sur req.log.child({ adminId })', () => {
    const guard = new AdminGuard()
    const { ctx, req } = mockContext({
      sessionId: 's1',
      adminId: 'a1',
      csrfHash: 'h',
    })
    const bound = { child: vi.fn() } as unknown as SessionRequest['log']
    const child = vi.fn().mockReturnValue(bound)
    req.log = { child } as unknown as SessionRequest['log']

    guard.canActivate(ctx)

    expect(child).toHaveBeenCalledWith({ adminId: 'a1' })
    expect(req.log).toBe(bound)
  })

  it('req.log ABSENT (tests unit sans pino) → garde défensive, canActivate ne throw pas', () => {
    const guard = new AdminGuard()
    const { ctx } = mockContext({
      sessionId: 's1',
      adminId: 'a1',
      csrfHash: 'h',
    })

    expect(() => guard.canActivate(ctx)).not.toThrow()
  })
})
