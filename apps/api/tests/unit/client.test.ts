import { describe, expect, it } from 'vitest'
import { APP_POOL, createPool } from '../../src/db/client.js'

describe('db/client', () => {
  it('exposes a unique DI token for the application pool', () => {
    expect(typeof APP_POOL).toBe('symbol')
  })

  it('createPool builds a pg Pool bounded to the given connection string (max 10)', async () => {
    const pool = createPool('postgres://user:pw@localhost:5432/db')
    expect(pool.options.connectionString).toBe(
      'postgres://user:pw@localhost:5432/db',
    )
    expect(pool.options.max).toBe(10)
    await pool.end()
  })
})
