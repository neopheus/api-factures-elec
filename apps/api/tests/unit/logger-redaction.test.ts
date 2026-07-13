import { Writable } from 'node:stream'
import pino from 'pino'
import { describe, expect, it } from 'vitest'
import { buildPinoHttpOptions } from '../../src/logging/logger.module.js'

function captureLogger(level: 'info' | 'debug' = 'info') {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString())
      cb()
    },
  })
  const logger = pino(buildPinoHttpOptions(level), stream)
  return { logger, output: () => chunks.join('') }
}

describe('pino redaction (apps/api logging config)', () => {
  it('never leaks the Authorization header value in log output', () => {
    const { logger, output } = captureLogger()
    logger.info(
      {
        req: {
          id: 'req-1',
          method: 'GET',
          url: '/invoices',
          headers: { authorization: 'Bearer super-secret-token' },
        },
      },
      'request',
    )
    expect(output()).not.toContain('super-secret-token')
  })

  it('never leaks x-api-key or cookie header values', () => {
    const { logger, output } = captureLogger()
    logger.info(
      {
        req: {
          id: 'req-2',
          method: 'GET',
          url: '/invoices',
          headers: {
            'x-api-key': 'apikey-secret',
            cookie: 'session=cookie-secret',
          },
        },
      },
      'request',
    )
    const out = output()
    expect(out).not.toContain('apikey-secret')
    expect(out).not.toContain('cookie-secret')
  })

  it('never leaks the request body (may contain invoice PII)', () => {
    const { logger, output } = captureLogger()
    logger.info(
      {
        req: {
          id: 'req-3',
          method: 'POST',
          url: '/invoices',
          body: { siret: '12345678900011' },
        },
      },
      'request',
    )
    expect(output()).not.toContain('12345678900011')
  })

  it('redacts Set-Cookie response headers (defense in depth, no custom res serializer)', () => {
    const { logger, output } = captureLogger()
    logger.info(
      { res: { headers: { 'set-cookie': 'session=response-cookie-secret' } } },
      'response',
    )
    expect(output()).not.toContain('response-cookie-secret')
  })

  it('still logs the safe request identifiers (id, method, url)', () => {
    const { logger, output } = captureLogger()
    logger.info(
      {
        req: {
          id: 'req-4',
          method: 'GET',
          url: '/health',
          headers: { authorization: 'x' },
        },
      },
      'request',
    )
    const out = output()
    expect(out).toContain('req-4')
    expect(out).toContain('/health')
  })

  it('honours the configured log level', () => {
    const { logger, output } = captureLogger('info')
    logger.debug(
      { req: { id: 'req-5', method: 'GET', url: '/x' } },
      'debug message',
    )
    expect(output()).toBe('')
  })
})
