import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common'
import { z } from 'zod'
import { CsrfGuard } from '../auth/csrf.guard.js'
import { CurrentTenant } from '../auth/current-tenant.decorator.js'
import { Roles, RolesGuard } from '../auth/roles.guard.js'
import { SessionGuard } from '../auth/session.guard.js'
import { parseBody } from '../common/validation.js'
// biome-ignore lint/style/useImportType: ApiKeysService est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { ApiKeysService } from './api-keys.service.js'

const createKeySchema = z.object({ label: z.string().min(1).max(100) })

// Classe : session utilisateur obligatoire (tout rôle) → un cookie admin
// (sans authUser) est 403 ; une clé API Bearer n'ouvre jamais ces routes
// (pas de cookie de session → SessionGuard refuse en 401).
@Controller('api-keys')
@UseGuards(SessionGuard, RolesGuard)
@Roles('owner', 'admin', 'accountant', 'viewer')
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Post()
  @HttpCode(201)
  @UseGuards(CsrfGuard)
  @Roles('owner', 'admin') // override niveau méthode
  create(@CurrentTenant() tenantId: string, @Body() body: unknown) {
    const { label } = parseBody(createKeySchema, body)
    return this.keys.create(tenantId, label) // secret affiché une seule fois
  }

  @Get()
  list(@CurrentTenant() tenantId: string) {
    return this.keys.list(tenantId)
  }

  @Delete(':id')
  @HttpCode(204)
  @UseGuards(CsrfGuard)
  @Roles('owner', 'admin')
  async revoke(
    @CurrentTenant() tenantId: string,
    @Param('id') id: string,
  ): Promise<void> {
    await this.keys.revoke(tenantId, id)
  }
}
