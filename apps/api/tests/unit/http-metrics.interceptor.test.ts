import type { CallHandler, ExecutionContext } from '@nestjs/common'
import { HttpException } from '@nestjs/common'
import { of, throwError } from 'rxjs'
import { describe, expect, it, vi } from 'vitest'
import { HttpMetricsInterceptor } from '../../src/metrics/http-metrics.interceptor.js'
import { MetricsService } from '../../src/metrics/metrics.service.js'

function mockContext(
  req: unknown,
  res: unknown,
  handlerName = 'handler',
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
    getHandler: () => {
      const fn = (): void => undefined
      Object.defineProperty(fn, 'name', { value: handlerName })
      return fn
    },
  } as unknown as ExecutionContext
}

function handlerReturning(value: unknown): CallHandler {
  return { handle: () => of(value) }
}
function handlerThrowing(err: unknown): CallHandler {
  return { handle: () => throwError(() => err) }
}

async function drain(obs: ReturnType<CallHandler['handle']>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    obs.subscribe({
      next: () => undefined,
      error: reject,
      complete: () => resolve(undefined),
    })
  })
}

// Motif `drain` mais résout AVEC l'erreur (au lieu de rejeter) : utile pour
// les scénarios `catchError` où l'on veut inspecter l'erreur re-propagée
// sans faire échouer le test — `rxjs` `Observable#toPromise()` est déprécié
// en rxjs 7, on passe donc systématiquement par `subscribe`.
async function drainError(
  obs: ReturnType<CallHandler['handle']>,
): Promise<unknown> {
  return new Promise((resolve) => {
    obs.subscribe({
      next: () => undefined,
      error: resolve,
      complete: () => resolve(undefined),
    })
  })
}

describe('HttpMetricsInterceptor', () => {
  it('observe avec la route NORMALISÉE (req.route.path, motif Express) — jamais l’URL brute', async () => {
    const metrics = new MetricsService()
    const observeSpy = vi.spyOn(metrics.httpDuration, 'observe')
    const interceptor = new HttpMetricsInterceptor(metrics)
    const req = {
      method: 'GET',
      path: '/invoices/3f2a1c4e-aaaa-bbbb-cccc-1234567890ab',
      route: { path: '/invoices/:id' },
    }
    const res = { statusCode: 200 }

    await drain(
      interceptor.intercept(
        mockContext(req, res),
        handlerReturning({ ok: true }),
      ),
    )

    expect(observeSpy).toHaveBeenCalledTimes(1)
    const [labels, value] = observeSpy.mock.calls[0] as unknown as [
      Record<string, string>,
      number,
    ]
    expect(labels).toEqual({
      method: 'GET',
      route: '/invoices/:id',
      status: '200',
    })
    expect(value).toBeGreaterThanOrEqual(0)
  })

  it('repli sur le nom du handler quand req.route est absent (résolution incomplète)', async () => {
    const metrics = new MetricsService()
    const observeSpy = vi.spyOn(metrics.httpDuration, 'observe')
    const interceptor = new HttpMetricsInterceptor(metrics)
    const req = { method: 'GET', path: '/x' }
    const res = { statusCode: 200 }

    await drain(
      interceptor.intercept(
        mockContext(req, res, 'monHandler'),
        handlerReturning({}),
      ),
    )

    const [labels] = observeSpy.mock.calls[0] as unknown as [
      Record<string, string>,
    ]
    expect(labels.route).toBe('monHandler')
  })

  it('erreur HttpException propagée → comptée avec SON statut (pas 500), erreur re-propagée intacte', async () => {
    const metrics = new MetricsService()
    const observeSpy = vi.spyOn(metrics.httpDuration, 'observe')
    const interceptor = new HttpMetricsInterceptor(metrics)
    const req = { method: 'GET', path: '/x', route: { path: '/invoices/:id' } }
    const res = { statusCode: 200 }
    const err = new HttpException('nope', 404)

    const caught = await drainError(
      interceptor.intercept(mockContext(req, res), handlerThrowing(err)),
    )

    expect(caught).toBe(err)
    expect(observeSpy).toHaveBeenCalledTimes(1)
    const [labels] = observeSpy.mock.calls[0] as unknown as [
      Record<string, string>,
    ]
    expect(labels.status).toBe('404')
  })

  it('erreur non-HttpException (throw brut) → comptée en 500', async () => {
    const metrics = new MetricsService()
    const observeSpy = vi.spyOn(metrics.httpDuration, 'observe')
    const interceptor = new HttpMetricsInterceptor(metrics)
    const req = { method: 'POST', path: '/y', route: { path: '/y' } }
    const res = { statusCode: 200 }
    const err = new Error('boom interne')

    await drainError(
      interceptor.intercept(mockContext(req, res), handlerThrowing(err)),
    )

    const [labels] = observeSpy.mock.calls[0] as unknown as [
      Record<string, string>,
    ]
    expect(labels.status).toBe('500')
  })

  it('exclut /metrics de l’instrumentation (auto-mesure du scrape) — aucune observation', async () => {
    const metrics = new MetricsService()
    const observeSpy = vi.spyOn(metrics.httpDuration, 'observe')
    const interceptor = new HttpMetricsInterceptor(metrics)
    const req = { method: 'GET', path: '/metrics', route: { path: '/metrics' } }
    const res = { statusCode: 200 }

    await drain(
      interceptor.intercept(mockContext(req, res), handlerReturning({})),
    )

    expect(observeSpy).not.toHaveBeenCalled()
  })
})
