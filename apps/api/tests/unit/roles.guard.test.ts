import type { ExecutionContext } from '@nestjs/common'
import { ForbiddenException } from '@nestjs/common'
import type { Reflector } from '@nestjs/core'
import { describe, expect, it, vi } from 'vitest'
import type {
  AuthenticatedAdmin,
  AuthenticatedUser,
  SessionRequest,
  UserRole,
} from '../../src/auth/auth.types.js'
import { ROLES_KEY, Roles, RolesGuard } from '../../src/auth/roles.guard.js'

function mockContext(opts: {
  authUser?: AuthenticatedUser
  authAdmin?: AuthenticatedAdmin
  apiKeyId?: string
}): ExecutionContext {
  const req = {
    authUser: opts.authUser,
    authAdmin: opts.authAdmin,
    apiKeyId: opts.apiKeyId,
  } as unknown as SessionRequest
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext
}

function reflectorReturning(roles: UserRole[] | undefined): Reflector {
  return {
    getAllAndOverride: vi.fn().mockReturnValue(roles),
  } as unknown as Reflector
}

const owner: AuthenticatedUser = {
  sessionId: 's1',
  userId: 'u1',
  tenantId: 't1',
  role: 'owner',
  csrfHash: 'h',
}

describe('Roles decorator', () => {
  it('attaches the required roles as ROLES_KEY metadata', () => {
    class Fixture {
      @Roles('owner', 'admin')
      method() {}
    }
    const roles = Reflect.getMetadata(ROLES_KEY, Fixture.prototype.method)
    expect(roles).toEqual(['owner', 'admin'])
  })
})

describe('RolesGuard', () => {
  it('allows access when no roles are required (route without @Roles())', () => {
    const guard = new RolesGuard(reflectorReturning(undefined))
    const ctx = mockContext({})

    expect(guard.canActivate(ctx)).toBe(true)
  })

  it('allows access when @Roles() is declared with an empty list', () => {
    const guard = new RolesGuard(reflectorReturning([]))
    const ctx = mockContext({})

    expect(guard.canActivate(ctx)).toBe(true)
  })

  it('rejects a platform-admin session (authAdmin, no authUser) on a tenant route requiring roles (403)', () => {
    const guard = new RolesGuard(reflectorReturning(['owner', 'admin']))
    const admin: AuthenticatedAdmin = {
      sessionId: 's2',
      adminId: 'a1',
      csrfHash: 'h',
    }
    const ctx = mockContext({ authAdmin: admin })

    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException)
  })

  it('rejects a user whose role is not in the required list (403)', () => {
    const guard = new RolesGuard(reflectorReturning(['owner', 'admin']))
    const viewer: AuthenticatedUser = { ...owner, role: 'viewer' }
    const ctx = mockContext({ authUser: viewer })

    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException)
  })

  it('allows a user whose role is in the required list', () => {
    const guard = new RolesGuard(reflectorReturning(['owner', 'admin']))
    const ctx = mockContext({ authUser: owner })

    expect(guard.canActivate(ctx)).toBe(true)
  })

  it('bypasses the role check for a machine call (apiKeyId set, dual-auth TenantAuthGuard)', () => {
    const guard = new RolesGuard(reflectorReturning(['owner', 'admin']))
    const ctx = mockContext({ apiKeyId: 'key-1' })

    expect(guard.canActivate(ctx)).toBe(true)
  })
})
