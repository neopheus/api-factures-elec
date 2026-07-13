export interface Problem {
  type: string
  title: string
  status: number
  detail?: string
  errors?: unknown
}

const BASE = 'urn:factelec:problem'
export const ProblemType = {
  validation: `${BASE}:validation-error`,
  businessRule: `${BASE}:business-rule-violation`,
  unauthorized: `${BASE}:unauthorized`,
  forbidden: `${BASE}:forbidden`,
  notFound: `${BASE}:not-found`,
  conflict: `${BASE}:conflict`,
  rateLimited: `${BASE}:rate-limited`,
  internal: `${BASE}:internal-error`,
} as const

export function problem(
  status: number,
  type: string,
  title: string,
  extra?: Partial<Pick<Problem, 'detail' | 'errors'>>,
): Problem {
  return { type, title, status, ...extra }
}

export function isProblem(x: unknown): x is Problem {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as Problem).type === 'string' &&
    typeof (x as Problem).status === 'number' &&
    typeof (x as Problem).title === 'string'
  )
}
