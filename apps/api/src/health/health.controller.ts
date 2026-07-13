import { Controller, Get, Inject } from '@nestjs/common'
// biome-ignore lint/style/useImportType: HealthCheckService est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { HealthCheck, HealthCheckService } from '@nestjs/terminus'
import type pg from 'pg'
import { APP_POOL } from '../db/client.js'

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    @Inject(APP_POOL) private readonly pool: pg.Pool,
  ) {}

  @Get()
  liveness(): { status: 'ok' } {
    return { status: 'ok' }
  }

  @Get('ready')
  @HealthCheck()
  readiness() {
    return this.health.check([
      async () => {
        await this.pool.query('SELECT 1')
        return { database: { status: 'up' } }
      },
    ])
  }
}
