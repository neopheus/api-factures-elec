import { UnprocessableEntityException } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { parseBody } from '../../src/common/validation.js'

const schema = z.object({ email: z.email(), age: z.number().min(0) })

describe('parseBody', () => {
  it('returns the parsed data on a valid body', () => {
    expect(parseBody(schema, { email: 'a@b.com', age: 30 })).toEqual({
      email: 'a@b.com',
      age: 30,
    })
  })

  it('throws a 422 problem+json UnprocessableEntityException listing path + message on an invalid body', () => {
    try {
      parseBody(schema, { email: 'not-an-email', age: -1 })
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(UnprocessableEntityException)
      const response = (e as UnprocessableEntityException).getResponse() as {
        status: number
        type: string
        errors: Array<{ path: string; message: string }>
      }
      expect(response.status).toBe(422)
      expect(response.type).toBe('urn:factelec:problem:validation-error')
      expect(response.errors.some((err) => err.path === 'email')).toBe(true)
      expect(response.errors.some((err) => err.path === 'age')).toBe(true)
    }
  })
})
