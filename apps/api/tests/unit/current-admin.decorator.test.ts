import type { ExecutionContext } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import type {
  AuthenticatedAdmin,
  SessionRequest,
} from '../../src/auth/auth.types.js'
import { CurrentAdmin } from '../../src/auth/current-admin.decorator.js'

// Même recette que tests/unit/current-user.decorator.test.ts (cf. son
// commentaire pour le détail de la déviation `ROUTE_ARGS_METADATA` inline).
const ROUTE_ARGS_METADATA = '__routeArguments__'

function extractFactory(): (
  data: unknown,
  ctx: ExecutionContext,
) => AuthenticatedAdmin {
  class ProbeController {
    method(@CurrentAdmin() _admin: AuthenticatedAdmin): void {}
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

describe('@CurrentAdmin()', () => {
  it('returns req.authAdmin when the SessionGuard already resolved it', () => {
    const factory = extractFactory()
    const authAdmin: AuthenticatedAdmin = {
      sessionId: 's1',
      adminId: 'a1',
      csrfHash: 'h',
    }

    expect(factory(undefined, mockContext({ authAdmin }))).toBe(authAdmin)
  })

  it('throws when used without AdminGuard (authAdmin not set — misuse guard)', () => {
    const factory = extractFactory()

    expect(() => factory(undefined, mockContext({}))).toThrow(
      'CurrentAdmin used without AdminGuard (admin session)',
    )
  })
})
