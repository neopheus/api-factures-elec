import type { ExecutionContext } from '@nestjs/common'
import { UnauthorizedException } from '@nestjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ApiKeyGuard,
  type TenantRequest,
} from '../../src/auth/api-key.guard.js'
import type { ApiKeyService } from '../../src/auth/api-key.service.js'
import { ProblemType } from '../../src/common/problem.js'

function mockContext(authorization?: string): {
  ctx: ExecutionContext
  req: TenantRequest
} {
  const req = {
    header: (name: string) =>
      name.toLowerCase() === 'authorization' ? authorization : undefined,
  } as unknown as TenantRequest
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext
  return { ctx, req }
}

describe('ApiKeyGuard', () => {
  let authenticate: ReturnType<typeof vi.fn>
  let guard: ApiKeyGuard

  beforeEach(() => {
    authenticate = vi.fn()
    guard = new ApiKeyGuard({ authenticate } as unknown as ApiKeyService)
  })

  it('rejects a request with no Authorization header at all (401 problem+json, no service call)', async () => {
    const { ctx } = mockContext(undefined)

    await expect(guard.canActivate(ctx)).rejects.toMatchObject(
      new UnauthorizedException(
        expect.objectContaining({
          status: 401,
          type: ProblemType.unauthorized,
        }),
      ),
    )
    expect(authenticate).not.toHaveBeenCalled()
  })

  it('rejects a malformed scheme (not "Bearer ...") without calling the service', async () => {
    const { ctx } = mockContext('Basic dXNlcjpwYXNz')

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
    expect(authenticate).not.toHaveBeenCalled()
  })

  it('rejects when the service reports no match (unknown prefix / bad secret / revoked)', async () => {
    authenticate.mockResolvedValue(null)
    const { ctx } = mockContext('Bearer fk_x.y')

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
    expect(authenticate).toHaveBeenCalledWith('fk_x.y')
  })

  it('accepts a valid key: sets req.tenantId/apiKeyId and returns true', async () => {
    authenticate.mockResolvedValue({ apiKeyId: 'key-1', tenantId: 'tenant-1' })
    const { ctx, req } = mockContext('Bearer fk_x.y')

    const activated = await guard.canActivate(ctx)

    expect(activated).toBe(true)
    expect(req.tenantId).toBe('tenant-1')
    expect(req.apiKeyId).toBe('key-1')
  })

  it.each([
    'bearer',
    'BEARER',
    'BeArEr',
  ])('accepts the scheme case-insensitively (RFC 7235): "%s fk_x.y"', async (scheme) => {
    authenticate.mockResolvedValue({
      apiKeyId: 'key-1',
      tenantId: 'tenant-1',
    })
    const { ctx } = mockContext(`${scheme} fk_x.y`)

    const activated = await guard.canActivate(ctx)

    expect(activated).toBe(true)
    // Le TOKEN, lui, reste comparé tel quel (seul le mot-clé de schéma est
    // insensible à la casse).
    expect(authenticate).toHaveBeenCalledWith('fk_x.y')
  })
})
