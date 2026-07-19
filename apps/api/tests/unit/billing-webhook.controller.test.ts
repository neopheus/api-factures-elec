import { BadRequestException, type RawBodyRequest } from '@nestjs/common'
import type { Request } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BillingWebhookController } from '../../src/billing/billing-webhook.controller.js'
import type { BillingWebhookService } from '../../src/billing/billing-webhook.service.js'

function fakeReq(rawBody: Buffer | undefined): RawBodyRequest<Request> {
  return { rawBody } as unknown as RawBodyRequest<Request>
}

describe('BillingWebhookController', () => {
  let webhookService: { handle: ReturnType<typeof vi.fn> }
  let controller: BillingWebhookController

  beforeEach(() => {
    webhookService = { handle: vi.fn() }
    controller = new BillingWebhookController(
      webhookService as unknown as BillingWebhookService,
    )
  })

  it('rawBody absent → 400 sans détail, le service n’est jamais appelé', async () => {
    const err = await controller
      .webhook(fakeReq(undefined), 'sig')
      .catch((e) => e)

    expect(err).toBeInstanceOf(BadRequestException)
    expect(err.getStatus()).toBe(400)
    expect(err.getResponse()).toEqual({
      type: 'urn:factelec:problem:validation-error',
      title: 'Bad request',
      status: 400,
    })
    expect(webhookService.handle).not.toHaveBeenCalled()
  })

  it('en-tête stripe-signature absent → 400 sans détail, le service n’est jamais appelé', async () => {
    const err = await controller
      .webhook(fakeReq(Buffer.from('{}')), undefined)
      .catch((e) => e)

    expect(err).toBeInstanceOf(BadRequestException)
    expect(err.getStatus()).toBe(400)
    expect(webhookService.handle).not.toHaveBeenCalled()
  })

  it('service.handle → reason "signature" → 400 sans détail', async () => {
    webhookService.handle.mockResolvedValue({
      handled: false,
      reason: 'signature',
    })
    const raw = Buffer.from('{}')

    const err = await controller.webhook(fakeReq(raw), 'sig').catch((e) => e)

    expect(err).toBeInstanceOf(BadRequestException)
    expect(err.getResponse()).toEqual({
      type: 'urn:factelec:problem:validation-error',
      title: 'Bad request',
      status: 400,
    })
    expect(webhookService.handle).toHaveBeenCalledWith(raw, 'sig')
  })

  it('service.handle → handled: true → 200 { received: true }', async () => {
    webhookService.handle.mockResolvedValue({ handled: true })
    const raw = Buffer.from('{}')

    const result = await controller.webhook(fakeReq(raw), 'sig')

    expect(result).toEqual({ received: true })
  })

  it.each(['unknown-customer', 'no-status', 'stale'] as const)(
    'service.handle → reason "%s" (ignoré délibérément) → 200 { received: true } quand même',
    async (reason) => {
      webhookService.handle.mockResolvedValue({ handled: false, reason })
      const raw = Buffer.from('{}')

      const result = await controller.webhook(fakeReq(raw), 'sig')

      expect(result).toEqual({ received: true })
    },
  )
})
