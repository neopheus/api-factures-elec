import type { ConfigService } from '@nestjs/config'
import { describe, expect, it } from 'vitest'
import {
  csrfCookieOptions,
  sessionCookieOptions,
} from '../../src/auth/cookie.js'
import type { EnvConfig } from '../../src/config/env.js'

function fakeConfig(
  values: Partial<EnvConfig>,
): ConfigService<EnvConfig, true> {
  return {
    get: (key: keyof EnvConfig) => values[key],
  } as unknown as ConfigService<EnvConfig, true>
}

describe('cookie options', () => {
  it('is not secure and has no domain in development (defaults)', () => {
    const config = fakeConfig({ NODE_ENV: 'development' })
    const opts = sessionCookieOptions(config, 1000)
    expect(opts).toMatchObject({
      secure: false,
      sameSite: 'lax',
      path: '/',
      maxAge: 1000,
      httpOnly: true,
    })
    expect(opts.domain).toBeUndefined()
  })

  it('is secure in production (A3: secure branch)', () => {
    const config = fakeConfig({ NODE_ENV: 'production' })
    expect(sessionCookieOptions(config, 1000).secure).toBe(true)
    expect(csrfCookieOptions(config, 1000).secure).toBe(true)
  })

  it('sets the cookie domain when SESSION_COOKIE_DOMAIN is configured (A3: domain branch)', () => {
    const config = fakeConfig({
      NODE_ENV: 'production',
      SESSION_COOKIE_DOMAIN: '.factelec.fr',
    })
    expect(sessionCookieOptions(config, 1000).domain).toBe('.factelec.fr')
    expect(csrfCookieOptions(config, 1000).domain).toBe('.factelec.fr')
  })

  it('the CSRF cookie is readable by JS (httpOnly: false) unlike the session cookie', () => {
    const config = fakeConfig({ NODE_ENV: 'development' })
    expect(sessionCookieOptions(config, 1000).httpOnly).toBe(true)
    expect(csrfCookieOptions(config, 1000).httpOnly).toBe(false)
  })
})
