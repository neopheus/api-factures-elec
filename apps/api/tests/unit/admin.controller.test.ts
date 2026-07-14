import type { ConfigService } from '@nestjs/config'
import type { Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminController } from '../../src/admin/admin.controller.js'
import type { AdminService } from '../../src/admin/admin.service.js'
import type { SessionRequest } from '../../src/auth/auth.types.js'
import type { SessionService } from '../../src/auth/session.service.js'
import { SESSION_COOKIE } from '../../src/auth/session-token.js'
import type { EnvConfig } from '../../src/config/env.js'

function fakeConfig(): ConfigService<EnvConfig, true> {
  return {
    get: (key: keyof EnvConfig) => (key === 'NODE_ENV' ? 'test' : undefined),
  } as unknown as ConfigService<EnvConfig, true>
}

function fakeResponse(): Response {
  return {
    cookie: vi.fn(),
    clearCookie: vi.fn(),
  } as unknown as Response
}

describe('AdminController', () => {
  let admin: {
    login: ReturnType<typeof vi.fn>
    listTenants: ReturnType<typeof vi.fn>
  }
  let sessions: {
    create: ReturnType<typeof vi.fn>
    revoke: ReturnType<typeof vi.fn>
    ttlMs: ReturnType<typeof vi.fn>
  }
  let controller: AdminController

  beforeEach(() => {
    admin = { login: vi.fn(), listTenants: vi.fn() }
    sessions = {
      create: vi.fn(),
      revoke: vi.fn(),
      ttlMs: vi.fn().mockReturnValue(1000),
    }
    controller = new AdminController(
      admin as unknown as AdminService,
      sessions as unknown as SessionService,
      fakeConfig(),
    )
  })

  it('login: validates the body, authenticates, issues session + csrf cookies, returns admin identity', async () => {
    admin.login.mockResolvedValue({ adminId: 'a1' })
    sessions.create.mockResolvedValue({
      token: 'tok',
      csrfToken: 'csrf',
      expiresAt: new Date(),
    })
    const res = fakeResponse()

    const result = await controller.login(
      { email: 'root@factelec.fr', password: 'super-admin-passphrase-1' },
      res,
    )

    expect(admin.login).toHaveBeenCalledWith(
      'root@factelec.fr',
      'super-admin-passphrase-1',
    )
    expect(sessions.create).toHaveBeenCalledWith({ adminId: 'a1' })
    expect(res.cookie).toHaveBeenCalledTimes(2)
    expect(result).toEqual({
      admin: { id: 'a1', email: 'root@factelec.fr' },
    })
  })

  it('logout: revokes the session and clears both cookies when a session cookie is present', async () => {
    const req = {
      cookies: { [SESSION_COOKIE]: 'tok' },
    } as unknown as SessionRequest
    const res = fakeResponse()

    await controller.logout(req, res)

    expect(sessions.revoke).toHaveBeenCalledWith('tok')
    expect(res.clearCookie).toHaveBeenCalledTimes(2)
  })

  it('logout: clears cookies without calling revoke when no session cookie is present (defensive)', async () => {
    const req = { cookies: {} } as unknown as SessionRequest
    const res = fakeResponse()

    await controller.logout(req, res)

    expect(sessions.revoke).not.toHaveBeenCalled()
    expect(res.clearCookie).toHaveBeenCalledTimes(2)
  })

  it('listTenants: delegates to AdminService.listTenants', async () => {
    const tenants = [
      {
        id: 't1',
        name: 'Shop A',
        siren: null,
        createdAt: new Date(),
        userCount: 1,
        invoiceCount: 2,
      },
    ]
    admin.listTenants.mockResolvedValue(tenants)

    const result = await controller.listTenants()

    expect(admin.listTenants).toHaveBeenCalled()
    expect(result).toEqual(tenants)
  })
})
