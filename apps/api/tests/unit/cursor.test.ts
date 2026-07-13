import { describe, expect, it } from 'vitest'
import { decodeCursor, encodeCursor } from '../../src/invoices/cursor.js'

describe('keyset cursor', () => {
  it('round-trips createdAt + id', () => {
    const c = encodeCursor(
      new Date('2026-07-13T10:00:00.000Z'),
      '11111111-1111-1111-1111-111111111111',
    )
    expect(decodeCursor(c)).toEqual({
      createdAt: '2026-07-13T10:00:00.000Z',
      id: '11111111-1111-1111-1111-111111111111',
    })
  })
  it('returns null on malformed cursor', () => {
    expect(decodeCursor('not-base64!!')).toBeNull()
    expect(
      decodeCursor(Buffer.from('nofield').toString('base64url')),
    ).toBeNull()
  })
})
