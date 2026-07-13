import type { ArgumentsHost } from '@nestjs/common'
import { HttpException, HttpStatus, NotFoundException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import { ProblemDetailsFilter } from '../../src/common/http-exception.filter.js'
import { ProblemType, problem } from '../../src/common/problem.js'

function mockHost() {
  const res = {
    status: vi.fn().mockReturnThis(),
    type: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  }
  const host = {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => ({}),
    }),
  } as unknown as ArgumentsHost
  return { res, host }
}

describe('ProblemDetailsFilter (RFC 9457, unit)', () => {
  it('passes through an already-built Problem payload unchanged (validation shape)', () => {
    const filter = new ProblemDetailsFilter()
    const { res, host } = mockHost()
    const payload = problem(
      422,
      ProblemType.validation,
      'Unprocessable Entity',
      {
        errors: [{ path: 'number', message: 'required' }],
      },
    )
    filter.catch(new HttpException(payload, 422), host)

    expect(res.status).toHaveBeenCalledWith(422)
    expect(res.type).toHaveBeenCalledWith('application/problem+json')
    expect(res.send).toHaveBeenCalledWith(payload)
  })

  it('maps a 404 HttpException with a string response to a not-found problem', () => {
    const filter = new ProblemDetailsFilter()
    const { res, host } = mockHost()
    filter.catch(new NotFoundException('Invoice 42 not found'), host)

    expect(res.status).toHaveBeenCalledWith(404)
    const body = res.send.mock.calls[0]?.[0]
    expect(body).toMatchObject({
      type: ProblemType.notFound,
      title: 'Not Found',
      status: 404,
      detail: 'Invoice 42 not found',
    })
  })

  it('maps a default Nest HttpException object response ({message}) to detail', () => {
    const filter = new ProblemDetailsFilter()
    const { res, host } = mockHost()
    filter.catch(new HttpException('Bad payload', HttpStatus.BAD_REQUEST), host)

    const body = res.send.mock.calls[0]?.[0]
    expect(body).toMatchObject({
      status: 400,
      title: 'Bad Request',
      detail: 'Bad payload',
    })
  })

  it('omits detail when the exception response carries no string message', () => {
    const filter = new ProblemDetailsFilter()
    const { res, host } = mockHost()
    filter.catch(
      new HttpException({ some: 'thing' }, HttpStatus.BAD_REQUEST),
      host,
    )

    const body = res.send.mock.calls[0]?.[0]
    expect(body.detail).toBeUndefined()
    expect(body.status).toBe(400)
  })

  it('falls back to a generic type/title for an unmapped HTTP status', () => {
    const filter = new ProblemDetailsFilter()
    const { res, host } = mockHost()
    filter.catch(new HttpException('I am a teapot', 418), host)

    const body = res.send.mock.calls[0]?.[0]
    expect(body).toMatchObject({
      status: 418,
      type: ProblemType.internal,
      title: 'Error',
    })
  })

  it('never leaks an unmanaged Error stack/message — generic 500 problem', () => {
    const filter = new ProblemDetailsFilter()
    const { res, host } = mockHost()
    filter.catch(new Error('db password xyz — internal detail'), host)

    expect(res.status).toHaveBeenCalledWith(500)
    const body = res.send.mock.calls[0]?.[0]
    expect(body).toEqual(
      problem(500, ProblemType.internal, 'Internal Server Error'),
    )
    expect(JSON.stringify(body)).not.toContain('db password')
  })

  it('never leaks a non-Error thrown value — generic 500 problem', () => {
    const filter = new ProblemDetailsFilter()
    const { res, host } = mockHost()
    filter.catch('raw string throw with secret token abc', host)

    expect(res.status).toHaveBeenCalledWith(500)
    const body = res.send.mock.calls[0]?.[0]
    expect(body).toEqual(
      problem(500, ProblemType.internal, 'Internal Server Error'),
    )
    expect(JSON.stringify(body)).not.toContain('secret token abc')
  })
})
