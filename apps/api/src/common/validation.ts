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

// Les query params HTTP sont un objet `unknown` au même titre qu'un body —
// réutilise EXACTEMENT la même validation zod (422 problem+json). Nommé
// distinctement pour la lisibilité au point d'appel des contrôleurs
// (`@Query() query: unknown` vs `@Body() body: unknown`, Task 7 annuaire).
export const parseQuery = parseBody
