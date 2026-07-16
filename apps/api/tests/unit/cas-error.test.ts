import { describe, expect, it } from 'vitest'
import { CasStaleError } from '../../src/common/cas-error.js'

describe('CasStaleError', () => {
  it('est une Error nommée CasStaleError, avec entity/id/expectedStatus en lecture seule', () => {
    const err = new CasStaleError({
      entity: 'transmission',
      id: 'tx-1',
      expectedStatus: 'transmitted',
      message:
        "appendStatusEvent: transmission tx-1 is not in 'transmitted' status (concurrent transition or unknown id)",
    })

    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(CasStaleError)
    expect(err.name).toBe('CasStaleError')
    expect(err.entity).toBe('transmission')
    expect(err.id).toBe('tx-1')
    expect(err.expectedStatus).toBe('transmitted')
    expect(err.message).toBe(
      "appendStatusEvent: transmission tx-1 is not in 'transmitted' status (concurrent transition or unknown id)",
    )
  })

  it('conserve le message EXACT passé en entrée (logs inchangés, D8) quel que soit le contenu', () => {
    const message =
      "markPublished: ligne x is not in 'draft' status (concurrent transition or unknown id)"
    const err = new CasStaleError({
      entity: 'ligne',
      id: 'x',
      expectedStatus: 'draft',
      message,
    })

    expect(err.message).toBe(message)
    expect(String(err)).toBe(`CasStaleError: ${message}`)
  })
})
