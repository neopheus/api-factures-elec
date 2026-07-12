import { describe, expect, it } from 'vitest'
import { PACKAGE_NAME } from '../src/index.js'

describe('invoice-core package', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@factelec/invoice-core')
  })
})
