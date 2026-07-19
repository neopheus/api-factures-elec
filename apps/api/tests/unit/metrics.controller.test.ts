import { NotFoundException, UnauthorizedException } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import type { Request, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'
import { MetricsController } from '../../src/metrics/metrics.controller.js'
import type { MetricsService } from '../../src/metrics/metrics.service.js'

const TOKEN = 'right-token-0123456789'

function fakeConfig(token: string | undefined): ConfigService<never, true> {
  return { get: () => token } as unknown as ConfigService<never, true>
}

function fakeMetrics(rendered = 'http_request_duration_seconds_count 0'): {
  metrics: MetricsService
  render: ReturnType<typeof vi.fn>
} {
  const render = vi.fn().mockResolvedValue(rendered)
  const metrics = {
    render,
    contentType: 'text/plain; version=0.0.4; charset=utf-8',
  } as unknown as MetricsService
  return { metrics, render }
}

function fakeReqRes(): {
  req: Request
  res: Response
  setHeader: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
} {
  const setHeader = vi.fn()
  const send = vi.fn()
  const req = { method: 'GET', originalUrl: '/metrics' } as unknown as Request
  const res = { setHeader, send } as unknown as Response
  return { req, res, setHeader, send }
}

describe('MetricsController', () => {
  it('METRICS_TOKEN absent de l’env → 404 indiscernable d’une route inexistante (même forme que le 404 global)', async () => {
    const { metrics, render } = fakeMetrics()
    const controller = new MetricsController(metrics, fakeConfig(undefined))
    const { req, res, send } = fakeReqRes()

    const err = await controller.scrape(req, res, undefined).catch((e) => e)

    expect(err).toBeInstanceOf(NotFoundException)
    expect((err as NotFoundException).getStatus()).toBe(404)
    expect((err as NotFoundException).getResponse()).toEqual({
      type: 'urn:factelec:problem:not-found',
      title: 'Not Found',
      status: 404,
      detail: 'Cannot GET /metrics',
    })
    expect(render).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('token configuré mais en-tête Authorization absent → 401 générique', async () => {
    const { metrics, render } = fakeMetrics()
    const controller = new MetricsController(metrics, fakeConfig(TOKEN))
    const { req, res } = fakeReqRes()

    const err = await controller.scrape(req, res, undefined).catch((e) => e)

    expect(err).toBeInstanceOf(UnauthorizedException)
    expect((err as UnauthorizedException).getResponse()).toEqual({
      type: 'urn:factelec:problem:unauthorized',
      title: 'Unauthorized',
      status: 401,
    })
    expect(render).not.toHaveBeenCalled()
  })

  it('token faux, longueur DIFFÉRENTE de l’attendu → 401 générique (court-circuit avant timingSafeEqual)', async () => {
    const { metrics, render } = fakeMetrics()
    const controller = new MetricsController(metrics, fakeConfig(TOKEN))
    const { req, res } = fakeReqRes()

    const err = await controller
      .scrape(req, res, 'Bearer wrong-token')
      .catch((e) => e)

    expect(err).toBeInstanceOf(UnauthorizedException)
    expect(render).not.toHaveBeenCalled()
  })

  it('token faux, MÊME longueur que l’attendu (1 seul caractère diffère) → 401 générique (branche timingSafeEqual)', async () => {
    // Couvre spécifiquement la comparaison à temps constant elle-même (pas
    // le court-circuit de longueur du test précédent) : un token de même
    // longueur que TOKEN, différent uniquement sur le dernier caractère.
    const sameLengthWrongToken = `${TOKEN.slice(0, -1)}${TOKEN.endsWith('9') ? '0' : '9'}`
    expect(sameLengthWrongToken.length).toBe(TOKEN.length)
    const { metrics, render } = fakeMetrics()
    const controller = new MetricsController(metrics, fakeConfig(TOKEN))
    const { req, res } = fakeReqRes()

    const err = await controller
      .scrape(req, res, `Bearer ${sameLengthWrongToken}`)
      .catch((e) => e)

    expect(err).toBeInstanceOf(UnauthorizedException)
    expect(render).not.toHaveBeenCalled()
  })

  it('bon token → 200, Content-Type du registre, corps = render()', async () => {
    const { metrics, render } = fakeMetrics(
      'http_request_duration_seconds_count 3',
    )
    const controller = new MetricsController(metrics, fakeConfig(TOKEN))
    const { req, res, setHeader, send } = fakeReqRes()

    await controller.scrape(req, res, `Bearer ${TOKEN}`)

    expect(render).toHaveBeenCalledTimes(1)
    expect(setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'text/plain; version=0.0.4; charset=utf-8',
    )
    expect(send).toHaveBeenCalledWith('http_request_duration_seconds_count 3')
  })
})
