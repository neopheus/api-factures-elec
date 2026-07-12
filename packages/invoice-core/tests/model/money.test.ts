import { describe, expect, it } from 'vitest'
import { big, round2 } from '../../src/model/money.js'

describe('round2', () => {
  it('rounds half up to 2 decimals', () => {
    expect(round2(big('1.005'))).toBe('1.01')
    expect(round2(big('1.004'))).toBe('1.00')
    expect(round2(big('2.675'))).toBe('2.68')
  })

  it('formats integers with 2 decimals', () => {
    expect(round2(big('1000'))).toBe('1000.00')
  })

  it('multiplies without float drift', () => {
    expect(round2(big('3').times(big('19.99')))).toBe('59.97')
  })
})
