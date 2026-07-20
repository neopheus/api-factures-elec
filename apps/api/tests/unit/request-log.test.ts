import type { Request } from 'express'
import { describe, expect, it, vi } from 'vitest'
import { bindRequestLog } from '../../src/logging/request-log.js'

describe('bindRequestLog', () => {
  it('req.log absent (tests unit sans pino-http) → aucun throw, req.log reste undefined', () => {
    const req = {} as Pick<Request, 'log'>

    expect(() => bindRequestLog(req, { tenantId: 'tenant-1' })).not.toThrow()
    expect(req.log).toBeUndefined()
  })

  it('req.log présent (motif pino-http) → réassigné au résultat de child(bindings)', () => {
    const child = vi.fn()
    const bound = { child: vi.fn() }
    child.mockReturnValue(bound)
    const req = { log: { child } } as unknown as Pick<Request, 'log'>

    bindRequestLog(req, { tenantId: 'tenant-1' })

    expect(child).toHaveBeenCalledWith({ tenantId: 'tenant-1' })
    expect(req.log).toBe(bound)
  })

  it('req.log présent mais SANS méthode child (objet dégénéré) → garde défensive, pas de throw, req.log inchangé', () => {
    const original = {} as Request['log']
    const req = { log: original } as unknown as Pick<Request, 'log'>

    expect(() => bindRequestLog(req, { adminId: 'admin-1' })).not.toThrow()
    expect(req.log).toBe(original)
  })
})
