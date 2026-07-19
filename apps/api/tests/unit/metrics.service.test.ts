import { Logger } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import { MetricsService } from '../../src/metrics/metrics.service.js'

describe('MetricsService', () => {
  it('expose un histogram http_request_duration_seconds enregistré sur SON registre (render() le contient)', async () => {
    const service = new MetricsService()
    const text = await service.render()
    expect(text).toContain('http_request_duration_seconds')
  })

  it('une observation posée sur httpDuration apparaît dans render() avec ses labels', async () => {
    const service = new MetricsService()
    service.httpDuration.observe(
      { method: 'GET', route: '/x', status: '200' },
      0.01,
    )
    const text = await service.render()
    expect(text).toContain('method="GET"')
    expect(text).toContain('route="/x"')
    expect(text).toContain('status="200"')
  })

  it('contentType reflète le registre dédié (format Prometheus text)', () => {
    const service = new MetricsService()
    expect(service.contentType).toMatch(/^text\/plain/)
  })

  it('registerCollector : la fonction est exécutée au début de render()', async () => {
    const service = new MetricsService()
    let called = false
    service.registerCollector(async () => {
      called = true
    })
    await service.render()
    expect(called).toBe(true)
  })

  it('collector isolé : un collector qui throw n’empêche ni les autres collectors ni le render, et logue un warn', async () => {
    const service = new MetricsService()
    const warnSpy = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined)
    const second = vi.fn(async () => undefined)
    service.registerCollector(async () => {
      throw new Error('collector en échec')
    })
    service.registerCollector(second)

    const text = await service.render()

    expect(second).toHaveBeenCalledTimes(1)
    expect(text).toContain('http_request_duration_seconds')
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]?.[0]).toContain('collector en échec')
    warnSpy.mockRestore()
  })

  it('collector qui throw une valeur non-Error (ex: chaîne brute) : loggé via String(), jamais un crash', async () => {
    const service = new MetricsService()
    const warnSpy = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined)
    service.registerCollector(async () => {
      throw 'panne brute sans Error'
    })

    await expect(service.render()).resolves.toContain(
      'http_request_duration_seconds',
    )

    expect(warnSpy.mock.calls[0]?.[0]).toContain('panne brute sans Error')
    warnSpy.mockRestore()
  })

  it('deux instances ne se marchent pas dessus (registre dédié, pas le register global prom-client)', () => {
    expect(() => new MetricsService()).not.toThrow()
    expect(() => new MetricsService()).not.toThrow()
  })
})
