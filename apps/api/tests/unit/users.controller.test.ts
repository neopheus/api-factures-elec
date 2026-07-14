import type { ConfigService } from '@nestjs/config'
import type { Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionRequest } from '../../src/auth/auth.types.js'
import type { SessionService } from '../../src/auth/session.service.js'
import { SESSION_COOKIE } from '../../src/auth/session-token.js'
import type { EnvConfig } from '../../src/config/env.js'
import { UsersController } from '../../src/users/users.controller.js'
import type { UsersService } from '../../src/users/users.service.js'

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

describe('UsersController', () => {
  let users: {
    signup: ReturnType<typeof vi.fn>
    login: ReturnType<typeof vi.fn>
    me: ReturnType<typeof vi.fn>
  }
  let sessions: {
    create: ReturnType<typeof vi.fn>
    revoke: ReturnType<typeof vi.fn>
    ttlMs: ReturnType<typeof vi.fn>
  }
  let controller: UsersController

  beforeEach(() => {
    users = { signup: vi.fn(), login: vi.fn(), me: vi.fn() }
    sessions = {
      create: vi.fn(),
      revoke: vi.fn(),
      ttlMs: vi.fn().mockReturnValue(1000),
    }
    controller = new UsersController(
      users as unknown as UsersService,
      sessions as unknown as SessionService,
      fakeConfig(),
    )
  })

  it('signup: validates the body, creates the tenant, issues session + csrf cookies', async () => {
    users.signup.mockResolvedValue({
      userId: 'u1',
      tenantId: 't1',
      role: 'owner',
    })
    sessions.create.mockResolvedValue({
      token: 'tok',
      csrfToken: 'csrf',
      expiresAt: new Date(),
    })
    const res = fakeResponse()

    const result = await controller.signup(
      {
        email: 'a@b.com',
        password: 'a-strong-passphrase-123',
        organizationName: 'Shop',
        siren: null,
      },
      res,
    )

    expect(users.signup).toHaveBeenCalledWith({
      email: 'a@b.com',
      password: 'a-strong-passphrase-123',
      organizationName: 'Shop',
      siren: null,
    })
    expect(sessions.create).toHaveBeenCalledWith({
      userId: 'u1',
      tenantId: 't1',
    })
    expect(res.cookie).toHaveBeenCalledTimes(2)
    expect(result).toEqual({
      user: {
        id: 'u1',
        email: 'a@b.com',
        role: 'owner',
        tenantId: 't1',
        emailVerified: false,
      },
    })
  })

  it('login: validates the body, authenticates, issues cookies', async () => {
    users.login.mockResolvedValue({
      userId: 'u1',
      tenantId: 't1',
      role: 'owner',
    })
    sessions.create.mockResolvedValue({
      token: 'tok',
      csrfToken: 'csrf',
      expiresAt: new Date(),
    })
    const res = fakeResponse()

    const result = await controller.login(
      { email: 'a@b.com', password: 'a-strong-passphrase-123' },
      res,
    )

    expect(users.login).toHaveBeenCalledWith(
      'a@b.com',
      'a-strong-passphrase-123',
    )
    expect(res.cookie).toHaveBeenCalledTimes(2)
    expect(result).toEqual({
      user: { id: 'u1', email: 'a@b.com', role: 'owner', tenantId: 't1' },
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

  it('me: delegates to UsersService.me with the authenticated user', async () => {
    const profile = {
      id: 'u1',
      email: 'a@b.com',
      role: 'owner',
      tenantId: 't1',
      emailVerified: false,
    }
    users.me.mockResolvedValue(profile)

    const result = await controller.me({
      sessionId: 's1',
      userId: 'u1',
      tenantId: 't1',
      role: 'owner',
      csrfHash: 'h',
    })

    expect(users.me).toHaveBeenCalledWith({
      sessionId: 's1',
      userId: 'u1',
      tenantId: 't1',
      role: 'owner',
      csrfHash: 'h',
    })
    expect(result).toEqual({ user: profile })
  })
})
