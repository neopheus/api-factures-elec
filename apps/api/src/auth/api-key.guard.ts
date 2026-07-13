import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import type { Request } from 'express'
import { ProblemType, problem } from '../common/problem.js'
import { ApiKeyService } from './api-key.service.js'

export interface TenantRequest extends Request {
  tenantId?: string
  apiKeyId?: string
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  // @Inject(ApiKeyService) explicite (au-delà du brief) : sans lui, SWC émet un
  // design:paramtypes ternaire (`typeof ApiKeyService !== 'undefined' ? ... :
  // Object`) dont la branche "false" n'est atteignable que si ApiKeyService
  // était `undefined` au chargement du module (import circulaire cassé) —
  // structurellement impossible ici, donc jamais couvrable par un test.
  // @Inject() explicite évite ce ternaire (même pattern qu'ApiKeyService pour
  // APP_POOL) et supprime la branche fantôme côté couverture v8.
  constructor(@Inject(ApiKeyService) private readonly apiKeys: ApiKeyService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<TenantRequest>()
    const header = req.header('authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    const auth = token ? await this.apiKeys.authenticate(token) : null
    if (!auth) {
      throw new UnauthorizedException(
        problem(401, ProblemType.unauthorized, 'Unauthorized', {
          detail: 'Missing or invalid API key',
        }),
      )
    }
    req.tenantId = auth.tenantId
    req.apiKeyId = auth.apiKeyId
    return true
  }
}
