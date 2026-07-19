import { UnauthorizedException } from '@nestjs/common'
import type pg from 'pg'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminService } from '../../src/admin/admin.service.js'
import type {
  AdminAnomaly,
  AdminSupervisionRepository,
  AdminTenantDetail,
  AdminTenantStats,
} from '../../src/admin/admin-supervision.repository.js'
import { TotpService } from '../../src/admin/totp.service.js'
import * as passwordModule from '../../src/auth/password.js'

// `totp` = VRAIE instance TotpService (pas un mock) dans TOUT ce fichier :
// motif `AuthUsersService`/aucun précédent de mock pour des primitives
// crypto pures dans ce projet (cf. password.test.ts, en clair sur argon2id
// réel) — reproduire otplib/argon2id en double dans un mock ferait courir
// le risque de tester une fausse sémantique plutôt que le comportement réel.
describe('AdminService', () => {
  let query: ReturnType<typeof vi.fn>
  let supervision: {
    tenantStats: ReturnType<typeof vi.fn>
    tenantDetail: ReturnType<typeof vi.fn>
    suspend: ReturnType<typeof vi.fn>
    unsuspend: ReturnType<typeof vi.fn>
    anomalies: ReturnType<typeof vi.fn>
  }
  let totp: TotpService
  let service: AdminService

  beforeEach(() => {
    query = vi.fn()
    supervision = {
      tenantStats: vi.fn(),
      tenantDetail: vi.fn(),
      suspend: vi.fn(),
      unsuspend: vi.fn(),
      anomalies: vi.fn(),
    }
    totp = new TotpService()
    service = new AdminService(
      { query } as unknown as pg.Pool,
      supervision as unknown as AdminSupervisionRepository,
      totp,
    )
  })

  // Ligne authenticate_platform_admin (migration 0032) pour un admin NON
  // enrôlé (totp_enabled_at NULL, totp_secret NULL au tout premier login).
  function pendingRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      admin_id: 'a1',
      password_hash: '',
      totp_secret: null,
      totp_enabled_at: null,
      recovery_codes: null,
      ...overrides,
    }
  }

  describe('login — password seul (avant tout état MFA)', () => {
    it('rejects an unknown email with 401 and runs the timing-safe dummy verify (anti-enumeration)', async () => {
      query.mockResolvedValue({ rows: [] })
      const spy = vi.spyOn(passwordModule, 'timingSafeVerifyReject')

      await expect(
        service.login('ghost@factelec.fr', 'whatever-guess', {}),
      ).rejects.toBeInstanceOf(UnauthorizedException)
      expect(spy).toHaveBeenCalledWith('whatever-guess')
    })

    it('rejects a wrong password with the identical 401 problem body as an unknown email', async () => {
      const hash = await passwordModule.hashPassword('super-admin-passphrase-1')
      query.mockResolvedValueOnce({
        rows: [pendingRow({ password_hash: hash })],
      })
      const wrongPasswordError = await service
        .login('root@factelec.fr', 'wrong-password', {})
        .catch((e) => e)

      query.mockResolvedValueOnce({ rows: [] })
      const unknownEmailError = await service
        .login('ghost@factelec.fr', 'super-admin-passphrase-1', {})
        .catch((e) => e)

      expect(wrongPasswordError).toBeInstanceOf(UnauthorizedException)
      expect(wrongPasswordError.getResponse()).toEqual(
        unknownEmailError.getResponse(),
      )
    })
  })

  // Task 7 (spec §5) : password OK + non enrôlé → enrollment_required, sans
  // session (le contrôleur mappe ça sur 202).
  describe('login — enrôlement PENDING (totp_enabled_at NULL)', () => {
    it('generates and persists a new secret when none exists yet, returns enrollment_required', async () => {
      const hash = await passwordModule.hashPassword('super-admin-passphrase-1')
      query.mockResolvedValueOnce({
        rows: [pendingRow({ password_hash: hash })],
      })
      query.mockResolvedValueOnce({
        rows: [{ set_admin_totp_secret_pending: 'GENERATEDSECRETXXXXXXXX' }],
      })

      const result = await service.login(
        'root@factelec.fr',
        'super-admin-passphrase-1',
        {},
      )

      expect(result.outcome).toBe('enrollment_required')
      if (result.outcome !== 'enrollment_required')
        throw new Error('unreachable')
      expect(result.secret).toBe('GENERATEDSECRETXXXXXXXX')
      expect(result.otpauthUrl).toContain('otpauth://totp/')
      const [sql, params] = query.mock.calls[1]!
      expect(sql).toContain('set_admin_totp_secret_pending')
      expect(params[0]).toBe('a1')
    })

    it('reuses the already-persisted PENDING secret instead of generating a new one', async () => {
      const hash = await passwordModule.hashPassword('super-admin-passphrase-1')
      query.mockResolvedValueOnce({
        rows: [
          pendingRow({
            password_hash: hash,
            totp_secret: 'EXISTINGPENDINGSECRET',
          }),
        ],
      })

      const result = await service.login(
        'root@factelec.fr',
        'super-admin-passphrase-1',
        {},
      )

      expect(result).toEqual({
        outcome: 'enrollment_required',
        otpauthUrl: totp.otpauthUrl(
          'root@factelec.fr',
          'EXISTINGPENDINGSECRET',
        ),
        secret: 'EXISTINGPENDINGSECRET',
      })
      expect(query).toHaveBeenCalledTimes(1) // aucune écriture : rien à persister
    })
  })

  // Task 7 (spec §5) : password OK + enrôlé → totpCode OU recoveryCode.
  describe('login — enrôlé (totp_enabled_at posé)', () => {
    async function enrolledRow(password: string) {
      const hash = await passwordModule.hashPassword(password)
      const secret = totp.generateSecret()
      return {
        row: pendingRow({
          password_hash: hash,
          totp_secret: secret,
          totp_enabled_at: new Date('2026-07-01T00:00:00Z'),
        }),
        secret,
      }
    }

    it('succeeds with a valid totpCode', async () => {
      const { row, secret } = await enrolledRow('super-admin-passphrase-1')
      query.mockResolvedValueOnce({ rows: [row] })
      const { generate } = await import('otplib')
      const totpCode = await generate({ secret })

      const result = await service.login(
        'root@factelec.fr',
        'super-admin-passphrase-1',
        { totpCode },
      )

      expect(result).toEqual({ outcome: 'success', adminId: 'a1' })
    })

    it('rejects a wrong totpCode with the SAME 401 body as a wrong password (anti-oracle)', async () => {
      const { row } = await enrolledRow('super-admin-passphrase-1')
      query.mockResolvedValueOnce({ rows: [row] })
      const wrongTotp = await service
        .login('root@factelec.fr', 'super-admin-passphrase-1', {
          totpCode: '000000',
        })
        .catch((e) => e)

      const hash = await passwordModule.hashPassword('super-admin-passphrase-1')
      query.mockResolvedValueOnce({
        rows: [pendingRow({ password_hash: hash })],
      })
      const wrongPassword = await service
        .login('root@factelec.fr', 'wrong-password', {})
        .catch((e) => e)

      expect(wrongTotp).toBeInstanceOf(UnauthorizedException)
      expect(wrongTotp.getResponse()).toEqual(wrongPassword.getResponse())
    })

    it('rejects a login with neither totpCode nor recoveryCode, SAME 401 body (anti-oracle)', async () => {
      const { row } = await enrolledRow('super-admin-passphrase-1')
      query.mockResolvedValueOnce({ rows: [row] })
      const missingMfa = await service
        .login('root@factelec.fr', 'super-admin-passphrase-1', {})
        .catch((e) => e)

      const hash = await passwordModule.hashPassword('super-admin-passphrase-1')
      query.mockResolvedValueOnce({
        rows: [pendingRow({ password_hash: hash })],
      })
      const wrongPassword = await service
        .login('root@factelec.fr', 'wrong-password', {})
        .catch((e) => e)

      expect(missingMfa).toBeInstanceOf(UnauthorizedException)
      expect(missingMfa.getResponse()).toEqual(wrongPassword.getResponse())
    })

    it('succeeds with a valid recoveryCode, then persists the remaining codes (consumed once)', async () => {
      const hash = await passwordModule.hashPassword('super-admin-passphrase-1')
      const { plain, hashed } = await totp.generateRecoveryCodes()
      query.mockResolvedValueOnce({
        rows: [
          pendingRow({
            password_hash: hash,
            totp_secret: totp.generateSecret(),
            totp_enabled_at: new Date('2026-07-01T00:00:00Z'),
            recovery_codes: hashed,
          }),
        ],
      })
      query.mockResolvedValueOnce({ rows: [] }) // set_admin_recovery_codes

      const result = await service.login(
        'root@factelec.fr',
        'super-admin-passphrase-1',
        { recoveryCode: plain[0] },
      )

      expect(result).toEqual({ outcome: 'success', adminId: 'a1' })
      const [sql, params] = query.mock.calls[1]!
      expect(sql).toContain('set_admin_recovery_codes')
      expect(params[0]).toBe('a1')
      const remaining = JSON.parse(params[1])
      expect(remaining).toHaveLength(9)
      expect(remaining).not.toContain(hashed[0])
    })

    it('rejects an unknown recoveryCode with the SAME 401 body as a wrong password (anti-oracle)', async () => {
      const hash = await passwordModule.hashPassword('super-admin-passphrase-1')
      const { hashed } = await totp.generateRecoveryCodes()
      query.mockResolvedValueOnce({
        rows: [
          pendingRow({
            password_hash: hash,
            totp_secret: totp.generateSecret(),
            totp_enabled_at: new Date('2026-07-01T00:00:00Z'),
            recovery_codes: hashed,
          }),
        ],
      })
      const wrongRecovery = await service
        .login('root@factelec.fr', 'super-admin-passphrase-1', {
          recoveryCode: 'ffff-ffff',
        })
        .catch((e) => e)

      query.mockResolvedValueOnce({
        rows: [pendingRow({ password_hash: hash })],
      })
      const wrongPassword = await service
        .login('root@factelec.fr', 'wrong-password', {})
        .catch((e) => e)

      expect(wrongRecovery).toBeInstanceOf(UnauthorizedException)
      expect(wrongRecovery.getResponse()).toEqual(wrongPassword.getResponse())
    })
  })

  describe('confirmTotp', () => {
    it('rejects an unknown email with the generic 401 and runs the timing-safe dummy verify', async () => {
      query.mockResolvedValueOnce({ rows: [] })
      const spy = vi.spyOn(passwordModule, 'timingSafeVerifyReject')

      await expect(
        service.confirmTotp('ghost@factelec.fr', 'whatever-guess', '123456'),
      ).rejects.toBeInstanceOf(UnauthorizedException)
      expect(spy).toHaveBeenCalledWith('whatever-guess')
    })

    it('rejects a wrong password with the generic 401', async () => {
      const hash = await passwordModule.hashPassword('super-admin-passphrase-1')
      query.mockResolvedValueOnce({
        rows: [
          pendingRow({
            password_hash: hash,
            totp_secret: totp.generateSecret(),
          }),
        ],
      })

      await expect(
        service.confirmTotp('root@factelec.fr', 'wrong-password', '123456'),
      ).rejects.toBeInstanceOf(UnauthorizedException)
    })

    it('confirms enrollment with a valid PENDING secret + code, returns plain recovery codes once', async () => {
      const hash = await passwordModule.hashPassword('super-admin-passphrase-1')
      const secret = totp.generateSecret()
      query.mockResolvedValueOnce({
        rows: [pendingRow({ password_hash: hash, totp_secret: secret })],
      })
      query.mockResolvedValueOnce({ rows: [{ confirm_admin_totp: true }] })
      const { generate } = await import('otplib')
      const totpCode = await generate({ secret })

      const result = await service.confirmTotp(
        'root@factelec.fr',
        'super-admin-passphrase-1',
        totpCode,
      )

      expect(result.recoveryCodes).toHaveLength(10)
      for (const code of result.recoveryCodes) {
        expect(code).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}$/)
      }
      const [sql, params] = query.mock.calls[1]!
      expect(sql).toContain('confirm_admin_totp')
      expect(params[0]).toBe('a1')
    })

    it('rejects an already-enrolled admin with the generic 401 (SAME body as a wrong password)', async () => {
      const hash = await passwordModule.hashPassword('super-admin-passphrase-1')
      query.mockResolvedValueOnce({
        rows: [
          pendingRow({
            password_hash: hash,
            totp_secret: totp.generateSecret(),
            totp_enabled_at: new Date('2026-07-01T00:00:00Z'),
          }),
        ],
      })
      const alreadyEnrolled = await service
        .confirmTotp('root@factelec.fr', 'super-admin-passphrase-1', '123456')
        .catch((e) => e)

      query.mockResolvedValueOnce({
        rows: [pendingRow({ password_hash: hash })],
      })
      const wrongPassword = await service
        .login('root@factelec.fr', 'wrong-password', {})
        .catch((e) => e)

      expect(alreadyEnrolled).toBeInstanceOf(UnauthorizedException)
      expect(alreadyEnrolled.getResponse()).toEqual(wrongPassword.getResponse())
    })

    it('rejects a wrong code against the PENDING secret (generic 401)', async () => {
      const hash = await passwordModule.hashPassword('super-admin-passphrase-1')
      query.mockResolvedValueOnce({
        rows: [
          pendingRow({
            password_hash: hash,
            totp_secret: totp.generateSecret(),
          }),
        ],
      })

      await expect(
        service.confirmTotp(
          'root@factelec.fr',
          'super-admin-passphrase-1',
          '000000',
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException)
    })
  })

  // Vecteur modifié (Task 3, spec §3) : `listTenants` ne construit plus la
  // requête SQL/le mapping bigint→number lui-même (ancien test ci-dessus,
  // supprimé) — cette logique a migré dans `AdminSupervisionRepository`
  // (SD 1 find_admin_tenant_stats), couverte par
  // `tests/e2e/admin-supervision.e2e.test.ts` contre un vrai Postgres (même
  // convention que BillingRepository, jamais unit-testé avec un pool mocké).
  // `AdminService.listTenants` est désormais un pur délégateur : le seul
  // comportement à vérifier ici est la délégation elle-même.
  describe('listTenants', () => {
    it('delegates to AdminSupervisionRepository.tenantStats and forwards its result unchanged', async () => {
      const stats: AdminTenantStats[] = [
        {
          id: 't1',
          name: 'Shop A',
          siren: null,
          createdAt: new Date('2024-01-01T00:00:00Z'),
          suspendedAt: null,
          billingStatus: 'active',
          invoices30d: 3,
          ereporting30d: 1,
          deadLetters: 0,
        },
      ]
      supervision.tenantStats.mockResolvedValue(stats)

      const result = await service.listTenants()

      expect(supervision.tenantStats).toHaveBeenCalledWith()
      expect(result).toBe(stats)
    })
  })

  describe('tenantDetail', () => {
    it('delegates to AdminSupervisionRepository.tenantDetail with the given id', async () => {
      const detail: AdminTenantDetail = {
        id: 't1',
        name: 'Shop A',
        siren: null,
        createdAt: new Date('2024-01-01T00:00:00Z'),
        suspendedAt: null,
        billingStatus: 'active',
        invoices30d: 3,
        ereporting30d: 1,
        deadLetters: 0,
        invoices: [],
        billing: {
          status: 'active',
          currentPeriodEnd: null,
          hasCustomer: true,
        },
        anomalies: [],
      }
      supervision.tenantDetail.mockResolvedValue(detail)

      const result = await service.tenantDetail('t1')

      expect(supervision.tenantDetail).toHaveBeenCalledWith('t1')
      expect(result).toBe(detail)
    })

    it('forwards null unchanged when the repository finds no matching tenant (controller turns it into 404)', async () => {
      supervision.tenantDetail.mockResolvedValue(null)

      const result = await service.tenantDetail('unknown-id')

      expect(result).toBeNull()
    })
  })

  // Task 4 (spec §3) : purs délégateurs (même motif que listTenants/
  // tenantDetail ci-dessus) — le mapping HTTP (404/409) vit dans
  // AdminController, la logique SQL/transaction dans le repository.
  describe('suspendTenant', () => {
    it('delegates to AdminSupervisionRepository.suspend and forwards its outcome unchanged', async () => {
      const outcome = { outcome: 'suspended' as const, suspendedAt: new Date() }
      supervision.suspend.mockResolvedValue(outcome)

      const result = await service.suspendTenant('t1', 'a1', 'abus signalé')

      expect(supervision.suspend).toHaveBeenCalledWith(
        't1',
        'a1',
        'abus signalé',
      )
      expect(result).toBe(outcome)
    })
  })

  describe('unsuspendTenant', () => {
    it('delegates to AdminSupervisionRepository.unsuspend and forwards its outcome unchanged', async () => {
      const outcome = { outcome: 'unsuspended' as const }
      supervision.unsuspend.mockResolvedValue(outcome)

      const result = await service.unsuspendTenant('t1', 'a1')

      expect(supervision.unsuspend).toHaveBeenCalledWith('t1', 'a1')
      expect(result).toBe(outcome)
    })
  })

  // Task 6 (spec §3) : pur délégateur (même motif que listTenants ci-dessus)
  // — `limit` est déjà validé par AdminController avant d'arriver ici.
  describe('anomalies', () => {
    it('delegates to AdminSupervisionRepository.anomalies with the given limit and forwards its result unchanged', async () => {
      const anomalies: AdminAnomaly[] = [
        {
          kind: 'dead_letter',
          tenantId: 't1',
          refId: 'dl1',
          detail: 'poison',
          createdAt: new Date('2026-07-19T10:00:00Z'),
        },
      ]
      supervision.anomalies.mockResolvedValue(anomalies)

      const result = await service.anomalies(50)

      expect(supervision.anomalies).toHaveBeenCalledWith(50)
      expect(result).toBe(anomalies)
    })
  })
})
