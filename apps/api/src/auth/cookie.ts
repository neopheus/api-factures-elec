import type { ConfigService } from '@nestjs/config'
import type { CookieOptions } from 'express'
import type { EnvConfig } from '../config/env.js'

function base(
  config: ConfigService<EnvConfig, true>,
  maxAgeMs: number,
): CookieOptions {
  const domain = config.get('SESSION_COOKIE_DOMAIN', { infer: true })
  return {
    secure: config.get('NODE_ENV', { infer: true }) === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeMs,
    ...(domain ? { domain } : {}),
  }
}
// Cookie de session : httpOnly (jamais lisible par JS).
export const sessionCookieOptions = (
  c: ConfigService<EnvConfig, true>,
  m: number,
): CookieOptions => ({
  ...base(c, m),
  httpOnly: true,
})
// Cookie CSRF : LISIBLE par JS (double-submit) ; ne donne aucun accès seul.
export const csrfCookieOptions = (
  c: ConfigService<EnvConfig, true>,
  m: number,
): CookieOptions => ({
  ...base(c, m),
  httpOnly: false,
})
