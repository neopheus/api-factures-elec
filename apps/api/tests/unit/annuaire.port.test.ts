import { describe, expect, it } from 'vitest'
import {
  ANNUAIRE_TRANSPORT,
  AnnuairePublishRejectedError,
} from '../../src/annuaire/annuaire.port.js'

describe('ANNUAIRE_TRANSPORT token', () => {
  it('is a unique symbol usable as a DI token', () => {
    expect(typeof ANNUAIRE_TRANSPORT).toBe('symbol')
  })
})

describe('AnnuairePublishRejectedError', () => {
  it('carries the rejection reason and a stable message/name (adapter réel, D1/D7)', () => {
    const err = new AnnuairePublishRejectedError('ligne XSD invalide')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('AnnuairePublishRejectedError')
    expect(err.reason).toBe('ligne XSD invalide')
    expect(err.message).toBe('publication annuaire rejetée: ligne XSD invalide')
  })
})
