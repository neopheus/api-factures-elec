import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common'
// biome-ignore lint/style/useImportType: ConfigService est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { ConfigService } from '@nestjs/config'
import { Throttle } from '@nestjs/throttler'
import type { Response } from 'express'
import { z } from 'zod'
import type { SessionRequest } from '../auth/auth.types.js'
import { csrfCookieOptions, sessionCookieOptions } from '../auth/cookie.js'
import { SessionGuard } from '../auth/session.guard.js'
// biome-ignore lint/style/useImportType: SessionService est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { SessionService } from '../auth/session.service.js'
import { CSRF_COOKIE, SESSION_COOKIE } from '../auth/session-token.js'
import { parseBody } from '../common/validation.js'
import type { EnvConfig } from '../config/env.js'
import { AdminGuard } from './admin.guard.js'
// biome-ignore lint/style/useImportType: AdminService est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { AdminService } from './admin.service.js'

const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1).max(200),
})

@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly sessions: SessionService,
    private readonly config: ConfigService<EnvConfig, true>,
  ) {}

  @Post('login')
  @HttpCode(200)
  @Throttle({ default: { ttl: 900_000, limit: 10 } }) // anti-brute-force : 10 / 15 min / IP (même politique que /auth/login)
  async login(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const input = parseBody(loginSchema, body)
    const { adminId } = await this.admin.login(input.email, input.password)
    const session = await this.sessions.create({ adminId })
    const maxAge = this.sessions.ttlMs()
    res.cookie(
      SESSION_COOKIE,
      session.token,
      sessionCookieOptions(this.config, maxAge),
    )
    res.cookie(
      CSRF_COOKIE,
      session.csrfToken,
      csrfCookieOptions(this.config, maxAge),
    )
    return { admin: { id: adminId, email: input.email } }
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(SessionGuard, AdminGuard)
  async logout(
    @Req() req: SessionRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const token = (req.cookies as Record<string, string> | undefined)?.[
      SESSION_COOKIE
    ]
    if (token) await this.sessions.revoke(token)
    res.clearCookie(SESSION_COOKIE, sessionCookieOptions(this.config, 0))
    res.clearCookie(CSRF_COOKIE, csrfCookieOptions(this.config, 0))
  }

  @Get('tenants')
  @UseGuards(SessionGuard, AdminGuard)
  listTenants() {
    return this.admin.listTenants()
  }
}
