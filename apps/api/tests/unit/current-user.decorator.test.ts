import type { ExecutionContext } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import type {
  AuthenticatedUser,
  SessionRequest,
} from '../../src/auth/auth.types.js'
import { CurrentUser } from '../../src/auth/current-user.decorator.js'

// Même recette que tests/unit/current-tenant.decorator.test.ts (cf. son
// commentaire pour le détail de la déviation `ROUTE_ARGS_METADATA` inline).
const ROUTE_ARGS_METADATA = '__routeArguments__'

function extractFactory(): (
  data: unknown,
  ctx: ExecutionContext,
) => AuthenticatedUser {
  class ProbeController {
    method(@CurrentUser() _user: AuthenticatedUser): void {}
  }
  const metadata = Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    ProbeController,
    'method',
  )
  const key = Object.keys(metadata)[0] as string
  return metadata[key].factory
}

function mockContext(req: Partial<SessionRequest>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext
}

describe('@CurrentUser()', () => {
  it('returns req.authUser when the SessionGuard already resolved it', () => {
    const factory = extractFactory()
    const authUser: AuthenticatedUser = {
      sessionId: 's1',
      userId: 'u1',
      tenantId: 't1',
      role: 'owner',
      csrfHash: 'h',
    }

    expect(factory(undefined, mockContext({ authUser }))).toBe(authUser)
  })

  it('throws when used without SessionGuard (authUser not set — misuse guard)', () => {
    const factory = extractFactory()

    expect(() => factory(undefined, mockContext({}))).toThrow(
      'CurrentUser used without SessionGuard (user session)',
    )
  })
})
