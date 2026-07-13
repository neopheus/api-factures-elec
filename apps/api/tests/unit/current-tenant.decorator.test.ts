import type { ExecutionContext } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import type { TenantRequest } from '../../src/auth/api-key.guard.js'
import { CurrentTenant } from '../../src/auth/current-tenant.decorator.js'

// Recette officielle Nest pour tester un ParamDecorator custom : le décorateur
// ne s'applique qu'à un paramètre de méthode, sa factory n'est pas exportée
// directement — on la récupère via les métadonnées posées par
// createParamDecorator sur une classe/méthode de test jetable.
//
// Déviation : `import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants'`
// (import documenté par Nest) résout à l'exécution (vitest/swc) mais échoue au
// typecheck (`tsc --noEmit`, moduleResolution NodeNext) — le sous-chemin du
// paquet CJS `@nestjs/common` (sans champ "exports") n'est pas résolu par TS
// en ESM strict : « Cannot find module '@nestjs/common/constants' ». La clé
// est un littéral stable de l'API interne Nest (inchangée depuis des années,
// revérifiée ici dans node_modules/@nestjs/common/constants.d.ts) — on l'inline
// pour lever l'ambiguïté de résolution sans toucher tsconfig.
const ROUTE_ARGS_METADATA = '__routeArguments__'

function extractFactory(): (data: unknown, ctx: ExecutionContext) => string {
  class ProbeController {
    method(@CurrentTenant() _tenantId: string): void {}
  }
  const metadata = Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    ProbeController,
    'method',
  )
  const key = Object.keys(metadata)[0] as string
  return metadata[key].factory
}

function mockContext(req: Partial<TenantRequest>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext
}

describe('@CurrentTenant()', () => {
  it('returns req.tenantId when the ApiKeyGuard already resolved it', () => {
    const factory = extractFactory()

    expect(factory(undefined, mockContext({ tenantId: 'tenant-1' }))).toBe(
      'tenant-1',
    )
  })

  it('throws when used without ApiKeyGuard (tenantId not set — misuse guard)', () => {
    const factory = extractFactory()

    expect(() => factory(undefined, mockContext({}))).toThrow(
      'CurrentTenant used without ApiKeyGuard',
    )
  })
})
