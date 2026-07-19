import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
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
import type { AuthenticatedAdmin, SessionRequest } from '../auth/auth.types.js'
import { csrfCookieOptions, sessionCookieOptions } from '../auth/cookie.js'
import { CsrfGuard } from '../auth/csrf.guard.js'
import { CurrentAdmin } from '../auth/current-admin.decorator.js'
import { SessionGuard } from '../auth/session.guard.js'
// biome-ignore lint/style/useImportType: SessionService est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { SessionService } from '../auth/session.service.js'
import { CSRF_COOKIE, SESSION_COOKIE } from '../auth/session-token.js'
import { ProblemType, problem } from '../common/problem.js'
import { isUuid } from '../common/uuid.js'
import { parseBody } from '../common/validation.js'
import type { EnvConfig } from '../config/env.js'
import { AdminGuard } from './admin.guard.js'
// biome-ignore lint/style/useImportType: AdminService est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { AdminService } from './admin.service.js'

const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1).max(200),
})

// Motif reason 1..500 (spec §3, symétrique à `retransmissionSchema.reason`
// de LifecycleService — cf. invoices.controller.ts `transitionSchema`, même
// bornage) : un motif vide n'est pas un motif, 500 évite un pavé de texte
// libre disproportionné dans le journal `admin_actions`.
const suspendSchema = z.object({
  reason: z.string().min(1).max(500),
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

  // Task 3 (spec §3) : liste enrichie (SD find_admin_tenant_stats), enveloppe
  // `{ tenants }` — remplace l'ancien tableau nu (adaptation du contrat,
  // motif documenté au rapport de tâche).
  @Get('tenants')
  @UseGuards(SessionGuard, AdminGuard)
  async listTenants() {
    return { tenants: await this.admin.listTenants() }
  }

  // Détail per-tenant RLS-scopé (spec §3) : 404 anti-fuite BYTE-IDENTIQUE
  // pour un id malformé (garde isUuid, motif LedgerController/CdvController)
  // ou un tenant inconnu (service → null) — un attaquant ne peut pas
  // distinguer les deux cas.
  @Get('tenants/:id')
  @UseGuards(SessionGuard, AdminGuard)
  async tenantDetail(@Param('id') id: string) {
    if (!isUuid(id)) throw this.notFound()
    const detail = await this.admin.tenantDetail(id)
    if (detail === null) throw this.notFound()
    return detail
  }

  // Suspension opérateur (Task 4, spec §3/§4) — 200 `{ suspendedAt }` (motif
  // symétrie avec le reste du contrôleur : aucune réponse 201 n'existe déjà
  // ici, une suspension ne « crée » rien). `CsrfGuard` : 1re mutation
  // protégée par double-submit de ce contrôleur (spec §2 « CsrfGuard sur les
  // POST ») — `logout` ci-dessus en est dépourvu (dette PRÉ-EXISTANTE à cette
  // tâche, hors périmètre Task 4, non touchée). Idempotence : déjà suspendu
  // → 409 conflict (jamais un 200 silencieux qui masquerait l'état réel à
  // l'opérateur).
  @Post('tenants/:id/suspend')
  @HttpCode(200)
  @UseGuards(SessionGuard, AdminGuard, CsrfGuard)
  async suspendTenant(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<{ suspendedAt: Date }> {
    if (!isUuid(id)) throw this.notFound()
    const { reason } = parseBody(suspendSchema, body)
    const result = await this.admin.suspendTenant(id, admin.adminId, reason)
    if (result.outcome === 'not_found') throw this.notFound()
    if (result.outcome === 'already_suspended') {
      throw this.conflict('Tenant already suspended')
    }
    return { suspendedAt: result.suspendedAt }
  }

  // Réactivation (Task 4, spec §3) — 204 (motif logout : mutation sans corps
  // de réponse utile). Symétrique de suspendTenant : non-suspendu → 409.
  @Post('tenants/:id/unsuspend')
  @HttpCode(204)
  @UseGuards(SessionGuard, AdminGuard, CsrfGuard)
  async unsuspendTenant(
    @Param('id') id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<void> {
    if (!isUuid(id)) throw this.notFound()
    const result = await this.admin.unsuspendTenant(id, admin.adminId)
    if (result.outcome === 'not_found') throw this.notFound()
    if (result.outcome === 'not_suspended') {
      throw this.conflict('Tenant not suspended')
    }
  }

  private notFound(): NotFoundException {
    return new NotFoundException(
      problem(404, ProblemType.notFound, 'Unknown tenant'),
    )
  }

  private conflict(detail: string): ConflictException {
    return new ConflictException(
      problem(409, ProblemType.conflict, 'Conflict', { detail }),
    )
  }
}
