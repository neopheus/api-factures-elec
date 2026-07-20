import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
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
import { parseBody, parseQuery } from '../common/validation.js'
import type { EnvConfig } from '../config/env.js'
import { AdminGuard } from './admin.guard.js'
// biome-ignore lint/style/useImportType: AdminService est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { AdminService } from './admin.service.js'
// biome-ignore lint/style/useImportType: AdminJobsService est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { AdminJobsService } from './admin-jobs.service.js'

// `totpCode`/`recoveryCode` optionnels (Task 7, spec §5) : c'est
// AdminService.login qui tranche selon l'état d'enrôlement — un admin non
// enrôlé peut se passer des deux (→ 202 enrollment_required), un admin
// enrôlé DOIT fournir l'un des deux (sinon 401 générique, posé par le
// service). `totpCode` bornée 6 chiffres exactement (format TOTP standard) ;
// `recoveryCode` bornée en longueur seulement (PAS de regex stricte sur le
// format `xxxx-xxxx` ici : un format invalide échoue simplement à matcher
// un hash dans consumeRecoveryCode → même 401 générique, aucune fuite
// d'information supplémentaire à distinguer par un 422 dédié).
const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1).max(200),
  totpCode: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
  recoveryCode: z.string().min(1).max(32).optional(),
})

// POST /admin/totp/confirm (Task 7, spec §5) — hors session, mêmes bornes
// email/password que loginSchema ; totpCode REQUIS (pas d'enrollment sans
// code, contrairement au login où il est conditionnel à l'état admin).
const totpConfirmSchema = z.object({
  email: z.email(),
  password: z.string().min(1).max(200),
  totpCode: z.string().regex(/^\d{6}$/),
})

// Motif reason 1..500 (spec §3, symétrique à `retransmissionSchema.reason`
// de LifecycleService — cf. invoices.controller.ts `transitionSchema`, même
// bornage) : un motif vide n'est pas un motif, 500 évite un pavé de texte
// libre disproportionné dans le journal `admin_actions`.
const suspendSchema = z.object({
  reason: z.string().min(1).max(500),
})

// Relance jobs échoués (Task 5, spec §3) : `limit` borné 1..500, défaut 100
// — `.default(100)` couvre le body ENTIÈREMENT absent (`parseBody(schema,
// body ?? {})` ci-dessous), contrairement à `suspendSchema.reason` qui reste
// obligatoire (aucun défaut sensé pour un motif de suspension).
const retryJobsSchema = z.object({
  limit: z.number().int().min(1).max(500).default(100),
})

// Vue anomalies (Task 6, spec §3) : `limit` bornée 1..200, défaut 50 —
// `z.coerce.number()` (PAS `z.number()` comme `retryJobsSchema` ci-dessus) :
// un paramètre de query string HTTP est TOUJOURS une chaîne (`?limit=10`),
// jamais un number natif, contrairement à un body JSON (même motif que
// `ADMIN_SESSION_TTL_HOURS`, config/env.ts). `.default(50)` couvre le
// paramètre ENTIÈREMENT absent (même mécanique que `retryJobsSchema.limit`
// ci-dessus : zod applique le défaut AVANT la validation interne quand la
// clé est `undefined`). Invalide (0, > 200, non numérique tel que 'abc') →
// 422 validation (`parseQuery`, motif annuaire.controller.ts — AUCUNE route
// de ce projet ne renvoie 400 pour une erreur zod, cf. grep
// `ProblemType.validation` : toujours couplé à 422 sauf le webhook Stripe,
// hors zod).
const anomaliesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly sessions: SessionService,
    private readonly config: ConfigService<EnvConfig, true>,
    private readonly jobs: AdminJobsService,
  ) {}

  // Flux MFA TOTP (Task 7, spec §5) — status dynamique (200 succès / 202
  // enrollment_required), motif `PaymentsController.capture` (`res.status()`
  // + `@Res({passthrough:true})`, PAS de `@HttpCode()` fixe ici,
  // contrairement à l'ancien flux password-seul) : la même route ne peut
  // plus renvoyer un unique code figé.
  @Post('login')
  @Throttle({ default: { ttl: 900_000, limit: 10 } }) // anti-brute-force : 10 / 15 min / IP (même politique que /auth/login), inchangé par cette tâche
  async login(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const input = parseBody(loginSchema, body)
    const result = await this.admin.login(input.email, input.password, {
      totpCode: input.totpCode,
      recoveryCode: input.recoveryCode,
    })
    if (result.outcome === 'enrollment_required') {
      // AUCUNE session ici (spec §5) : l'admin n'a pas encore prouvé son
      // second facteur, seul POST /admin/totp/confirm peut la créer ensuite.
      res.status(202)
      return {
        enrollmentRequired: true,
        otpauthUrl: result.otpauthUrl,
        secret: result.secret,
      }
    }
    // Revue sécurité Task 7, Issue 2 (fail-closed ACCEPTÉ, documenté) : à cet
    // instant, si `result` vient de la branche recoveryCode, le code est
    // DÉJÀ consommé côté SQL (COMMIT de set_admin_recovery_codes dans
    // AdminService.login, avant son `return`) — un échec de `sessions.create`
    // ci-dessous (panne DB transitoire, etc.) laisse l'admin SANS session
    // ET avec un code de récupération perdu. Ordre inverse (créer la session
    // AVANT de consommer le code) rejeté : une session serait alors accordée
    // sans second facteur définitivement validé si la consommation échouait
    // ensuite — inacceptable pour une surface admin. Le sens retenu échoue
    // toujours du côté sûr (refuser l'accès), jamais du côté qui l'accorderait
    // à tort ; l'admin dispose de 9 autres codes en cas de panne isolée.
    //
    // TTL dédié (spec §5/§8, ADMIN_SESSION_TTL_HOURS, défaut 2h) — PAS le
    // TTL standard (SESSION_TTL_HOURS, 12h) : surface d'exposition réduite
    // d'un compte à privilèges élevés, cf. config/env.ts.
    const maxAge =
      this.config.get('ADMIN_SESSION_TTL_HOURS', { infer: true }) * 3_600_000
    const session = await this.sessions.create(
      { adminId: result.adminId },
      maxAge,
    )
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
    res.status(200)
    return { admin: { id: result.adminId, email: input.email } }
  }

  // POST /admin/totp/confirm (Task 7, spec §5) — HORS SESSION (l'admin n'en
  // a pas encore à ce stade du flux) : ni SessionGuard/AdminGuard (rien à
  // authentifier par cookie) ni CsrfGuard (double-submit suppose déjà un
  // cookie CSRF posé, absent ici — même motif que login() ci-dessus, qui
  // n'en a jamais eu). Throttle IDENTIQUE à login (copie exacte du
  // décorateur, spec §5 « Throttle identique au login ») — clé de
  // rate-limiting distincte côté ThrottlerGuard (nom de handler différent),
  // donc un bucket 10/15min SÉPARÉ de /admin/login, pas partagé.
  @Post('totp/confirm')
  @HttpCode(200)
  @Throttle({ default: { ttl: 900_000, limit: 10 } })
  async confirmTotp(@Body() body: unknown) {
    const input = parseBody(totpConfirmSchema, body)
    return this.admin.confirmTotp(input.email, input.password, input.totpCode)
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

  // Relance admin des jobs échoués d'une file (Task 5, spec §3) — `:queue` =
  // nom PUBLIC exact d'une constante de queue.constants.ts (allowlist
  // STRICTE posée par AdminJobsService, JAMAIS un nom Redis arbitraire) ;
  // inconnu → 404 (même garde générique que tenantDetail/suspendTenant :
  // `result === null` → `notFound()`). `body` peut être ENTIÈREMENT absent
  // (`?? {}`) : `limit` a un défaut zod (100), motif retryJobsSchema.
  @Post('jobs/:queue/retry')
  @HttpCode(200)
  @UseGuards(SessionGuard, AdminGuard, CsrfGuard)
  async retryJobs(
    @Param('queue') queueName: string,
    @Body() body: unknown,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<{ retried: number; errors: number }> {
    const { limit } = parseBody(retryJobsSchema, body ?? {})
    const result = await this.jobs.retryFailed(queueName, admin.adminId, limit)
    if (result === null) throw this.notFound('Unknown queue')
    return result
  }

  // Vue anomalies plateforme, lecture seule (Task 6, spec §3) — SD 2
  // find_admin_anomalies (migration 0031), tri createdAt desc déjà posé
  // côté SQL par la fonction (AdminSupervisionRepository.anomalies).
  @Get('anomalies')
  @UseGuards(SessionGuard, AdminGuard)
  async anomalies(@Query() query: unknown) {
    const { limit } = parseQuery(anomaliesQuerySchema, query)
    return { anomalies: await this.admin.anomalies(limit) }
  }

  private notFound(title = 'Unknown tenant'): NotFoundException {
    return new NotFoundException(problem(404, ProblemType.notFound, title))
  }

  private conflict(detail: string): ConflictException {
    return new ConflictException(
      problem(409, ProblemType.conflict, 'Conflict', { detail }),
    )
  }
}
