import { describe, expect, it } from 'vitest'
import { isProblem, ProblemType, problem } from '../../src/common/problem.js'

describe('problem (RFC 9457)', () => {
  it('builds a problem document with type/title/status', () => {
    const p = problem(422, ProblemType.validation, 'Unprocessable Entity', {
      errors: [{ path: 'number', message: 'required' }],
    })
    expect(p).toMatchObject({
      type: ProblemType.validation,
      title: 'Unprocessable Entity',
      status: 422,
    })
    expect(p.errors).toHaveLength(1)
  })

  it('exposes stable urn: problem types', () => {
    expect(ProblemType.businessRule).toBe(
      'urn:factelec:problem:business-rule-violation',
    )
    expect(ProblemType.notFound).toBe('urn:factelec:problem:not-found')
  })
})

describe('isProblem', () => {
  it('recognizes a well-formed Problem document', () => {
    const p = problem(404, ProblemType.notFound, 'Not Found')
    expect(isProblem(p)).toBe(true)
  })

  it('rejects non-Problem values (null, primitives, incomplete shapes)', () => {
    expect(isProblem(null)).toBe(false)
    expect(isProblem(undefined)).toBe(false)
    expect(isProblem('not a problem')).toBe(false)
    expect(isProblem(42)).toBe(false)
    expect(isProblem({ type: 'x', status: 404 })).toBe(false) // missing title
    expect(isProblem({ title: 'x', status: 404 })).toBe(false) // missing type
    expect(isProblem({ type: 'x', title: 'x' })).toBe(false) // missing status
  })
})
