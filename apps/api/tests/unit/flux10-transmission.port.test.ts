import { describe, expect, it } from 'vitest'
import {
  FLUX10_TRANSMISSION,
  TransmissionRejectedError,
} from '../../src/ereporting/flux10-transmission.port.js'

describe('FLUX10_TRANSMISSION token', () => {
  it('is a unique symbol usable as a DI token', () => {
    expect(typeof FLUX10_TRANSMISSION).toBe('symbol')
  })
})

describe('TransmissionRejectedError', () => {
  it('carries the rejection reason and a stable message/name (adapter réel, D3/D7)', () => {
    const err = new TransmissionRejectedError('flux XSD invalide')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('TransmissionRejectedError')
    expect(err.reason).toBe('flux XSD invalide')
    expect(err.message).toBe('transmission rejected: flux XSD invalide')
  })
})
