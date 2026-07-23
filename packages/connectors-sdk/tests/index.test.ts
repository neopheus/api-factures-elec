import { describe, expect, it } from 'vitest'
import { PACKAGE_NAME } from '../src/index.js'

describe('connectors-sdk package', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@factelec/connectors-sdk')
  })
})
