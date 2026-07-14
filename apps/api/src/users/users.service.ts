import {
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import { eq } from 'drizzle-orm'
import type pg from 'pg'
import type { AuthenticatedUser, UserRole } from '../auth/auth.types.js'
import {
  hashPassword,
  timingSafeVerifyReject,
  verifyPassword,
} from '../auth/password.js'
import { ProblemType, problem } from '../common/problem.js'
import { APP_POOL } from '../db/client.js'
import { users } from '../db/schema.js'
// biome-ignore lint/style/useImportType: TenantContextService est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { TenantContextService } from '../db/tenant-context.service.js'

export interface SignupInput {
  email: string
  password: string
  organizationName: string
  siren: string | null
}
export interface UserProfile {
  id: string
  email: string
  role: UserRole
  tenantId: string
  emailVerified: boolean
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(APP_POOL) private readonly pool: pg.Pool,
    private readonly tenant: TenantContextService,
  ) {}

  async signup(
    input: SignupInput,
  ): Promise<{ userId: string; tenantId: string; role: UserRole }> {
    const passwordHash = await hashPassword(input.password)
    try {
      const res = await this.pool.query(
        'SELECT user_id, tenant_id FROM signup_tenant($1, $2, $3, $4)',
        [input.email, passwordHash, input.organizationName, input.siren],
      )
      const row = res.rows[0]
      return { userId: row.user_id, tenantId: row.tenant_id, role: 'owner' }
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        // Pas de détail au-delà du conflit lui-même (anti-énumération) : ni
        // l'email fautif, ni la contrainte violée ne sont divulgués.
        throw new ConflictException(
          problem(409, ProblemType.conflict, 'Conflict', {
            detail: 'Email already registered',
          }),
        )
      }
      throw e
    }
  }

  async login(
    email: string,
    password: string,
  ): Promise<{ userId: string; tenantId: string; role: UserRole }> {
    const res = await this.pool.query(
      'SELECT user_id, tenant_id, role, password_hash FROM authenticate_user($1)',
      [email],
    )
    const row = res.rows[0]
    // Corps 401 identique (aucun détail distinctif) pour les trois échecs
    // possibles : email inconnu, mot de passe erroné, session expirée.
    const invalid = () =>
      new UnauthorizedException(
        problem(401, ProblemType.unauthorized, 'Unauthorized', {
          detail: 'Invalid credentials',
        }),
      )
    if (!row) {
      await timingSafeVerifyReject(password) // temps égalisé (anti-énumération)
      throw invalid()
    }
    if (!(await verifyPassword(row.password_hash, password))) throw invalid()
    return { userId: row.user_id, tenantId: row.tenant_id, role: row.role }
  }

  me(
    user: Pick<AuthenticatedUser, 'userId' | 'tenantId'>,
  ): Promise<UserProfile> {
    return this.tenant.run(user.tenantId, async (db) => {
      const [row] = await db
        .select({
          id: users.id,
          email: users.email,
          role: users.role,
          tenantId: users.tenantId,
          emailVerified: users.emailVerified,
        })
        .from(users)
        .where(eq(users.id, user.userId))
        .limit(1)
      // RLS garantit l'appartenance au tenant ; la session garantit l'existence.
      return row as UserProfile
    })
  }
}
