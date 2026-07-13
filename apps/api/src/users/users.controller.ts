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
import type { AuthenticatedUser, SessionRequest } from '../auth/auth.types.js'
import { csrfCookieOptions, sessionCookieOptions } from '../auth/cookie.js'
import { CurrentUser } from '../auth/current-user.decorator.js'
import { passwordSchema } from '../auth/password.js'
import { SessionGuard } from '../auth/session.guard.js'
// biome-ignore lint/style/useImportType: SessionService est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { SessionService } from '../auth/session.service.js'
import { CSRF_COOKIE, SESSION_COOKIE } from '../auth/session-token.js'
import { parseBody } from '../common/validation.js'
import type { EnvConfig } from '../config/env.js'
// biome-ignore lint/style/useImportType: UsersService est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { UsersService } from './users.service.js'

const signupSchema = z.object({
  email: z.email(),
  password: passwordSchema,
  organizationName: z.string().min(1).max(200),
  siren: z
    .string()
    .regex(/^\d{9}$/, 'siren must be 9 digits')
    .nullish()
    .transform((v) => v ?? null),
})
const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1).max(200),
})

@Controller('auth')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly sessions: SessionService,
    private readonly config: ConfigService<EnvConfig, true>,
  ) {}

  private issue(
    res: Response,
    session: { token: string; csrfToken: string },
  ): void {
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
  }

  @Post('signup')
  @HttpCode(201)
  @Throttle({ default: { ttl: 3_600_000, limit: 5 } }) // anti-abus : 5 inscriptions / h / IP
  async signup(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const input = parseBody(signupSchema, body)
    const created = await this.users.signup(input)
    const session = await this.sessions.create({
      userId: created.userId,
      tenantId: created.tenantId,
    })
    this.issue(res, session)
    return {
      user: {
        id: created.userId,
        email: input.email,
        role: created.role,
        tenantId: created.tenantId,
        emailVerified: false,
      },
    }
  }

  @Post('login')
  @HttpCode(200)
  @Throttle({ default: { ttl: 900_000, limit: 10 } }) // anti-brute-force : 10 / 15 min / IP
  async login(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const input = parseBody(loginSchema, body)
    const user = await this.users.login(input.email, input.password)
    const session = await this.sessions.create({
      userId: user.userId,
      tenantId: user.tenantId,
    })
    this.issue(res, session)
    return {
      user: {
        id: user.userId,
        email: input.email,
        role: user.role,
        tenantId: user.tenantId,
      },
    }
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(SessionGuard)
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

  @Get('me')
  @UseGuards(SessionGuard)
  async me(@CurrentUser() user: AuthenticatedUser) {
    return { user: await this.users.me(user) }
  }
}
