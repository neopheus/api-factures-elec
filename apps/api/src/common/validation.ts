import { UnprocessableEntityException } from '@nestjs/common'
import type { ZodType } from 'zod'
import { ProblemType, problem } from './problem.js'

export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body)
  if (!r.success) {
    const errors = r.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    }))
    throw new UnprocessableEntityException(
      problem(422, ProblemType.validation, 'Unprocessable Entity', { errors }),
    )
  }
  return r.data
}
