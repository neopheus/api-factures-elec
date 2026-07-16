import { describe, expect, it } from 'vitest'
import {
  CDV_TRANSMISSION,
  CdvTransmissionRejectedError,
} from '../../src/cdv/cdv-transmission.port.js'

describe('CDV_TRANSMISSION token', () => {
  it('is a unique symbol usable as a DI token', () => {
    expect(typeof CDV_TRANSMISSION).toBe('symbol')
  })
})

describe('CdvTransmissionRejectedError', () => {
  it('carries the rejection reason and a stable message/name (adapter réel, D1/D7)', () => {
    const err = new CdvTransmissionRejectedError('F6 structurellement invalide')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('CdvTransmissionRejectedError')
    expect(err.reason).toBe('F6 structurellement invalide')
    expect(err.message).toBe(
      'cdv transmission rejected: F6 structurellement invalide',
    )
  })
})
