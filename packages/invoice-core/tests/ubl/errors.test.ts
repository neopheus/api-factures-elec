import { describe, expect, it } from 'vitest'
import { UnsupportedTypeCodeError } from '../../src/ubl/errors.js'

describe('UnsupportedTypeCodeError', () => {
  it('carries the offending type code and a message', () => {
    const err = new UnsupportedTypeCodeError('325')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('UnsupportedTypeCodeError')
    expect(err.typeCode).toBe('325')
    expect(err.message).toContain('325')
  })
})
