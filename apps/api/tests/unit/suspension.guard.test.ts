import type { ExecutionContext } from '@nestjs/common'
import { HttpException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { AdminSupervisionRepository } from '../../src/admin/admin-supervision.repository.js'
import { SuspensionGuard } from '../../src/admin/suspension.guard.js'
import type { TenantRequest } from '../../src/auth/api-key.guard.js'
import { ProblemType } from '../../src/common/problem.js'

function mockContext(tenantId?: string): ExecutionContext {
  const req = { tenantId } as unknown as TenantRequest
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext
}

describe('SuspensionGuard', () => {
  it('req.tenantId absent (guard d’auth manquant en amont) → throw Error interne, jamais un 403 conservateur', async () => {
    const isSuspended = vi.fn()
    const guard = new SuspensionGuard({
      isSuspended,
    } as unknown as AdminSupervisionRepository)

    const err = await guard.canActivate(mockContext(undefined)).catch((e) => e)

    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(HttpException)
    expect((err as Error).message).toMatch(
      /SuspensionGuard exige un guard d'authentification en amont/,
    )
    expect(isSuspended).not.toHaveBeenCalled()
  })

  it('tenant non suspendu → passe (true)', async () => {
    const isSuspended = vi.fn().mockResolvedValue(false)
    const guard = new SuspensionGuard({
      isSuspended,
    } as unknown as AdminSupervisionRepository)

    await expect(guard.canActivate(mockContext('tenant-1'))).resolves.toBe(true)
    expect(isSuspended).toHaveBeenCalledWith('tenant-1')
  })

  it('tenant suspendu → 403 urn:factelec:problem:tenant-suspended (JAMAIS 402)', async () => {
    const isSuspended = vi.fn().mockResolvedValue(true)
    const guard = new SuspensionGuard({
      isSuspended,
    } as unknown as AdminSupervisionRepository)

    const err = await guard.canActivate(mockContext('tenant-1')).catch((e) => e)

    expect(err).toBeInstanceOf(HttpException)
    expect((err as HttpException).getStatus()).toBe(403)
    expect((err as HttpException).getResponse()).toMatchObject({
      status: 403,
      type: ProblemType.tenantSuspended,
      title: 'Tenant suspended',
    })
  })
})
