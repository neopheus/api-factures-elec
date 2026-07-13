import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common'
import type { Response } from 'express'
import { isProblem, type Problem, ProblemType, problem } from './problem.js'

const TITLE_BY_STATUS: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
}
const TYPE_BY_STATUS: Record<number, string> = {
  401: ProblemType.unauthorized,
  403: ProblemType.forbidden,
  404: ProblemType.notFound,
  409: ProblemType.conflict,
  422: ProblemType.validation,
  429: ProblemType.rateLimited,
}

// Filtre attrape-tout : toute réponse d'erreur est un application/problem+json,
// et AUCUNE information interne (stack, message d'exception non maîtrisé) ne fuit.
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name)

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>()
    let body: Problem

    if (exception instanceof HttpException) {
      const status = exception.getStatus()
      const payload = exception.getResponse()
      if (isProblem(payload)) {
        body = payload
      } else {
        const detail =
          typeof payload === 'string'
            ? payload
            : typeof (payload as { message?: unknown }).message === 'string'
              ? (payload as { message: string }).message
              : undefined
        body = problem(
          status,
          TYPE_BY_STATUS[status] ?? ProblemType.internal,
          TITLE_BY_STATUS[status] ?? 'Error',
          detail ? { detail } : undefined,
        )
      }
    } else {
      // Non maîtrisé : log serveur, réponse générique — jamais de fuite.
      this.logger.error(
        exception instanceof Error ? exception.stack : String(exception),
      )
      body = problem(500, ProblemType.internal, 'Internal Server Error')
    }

    res.status(body.status).type('application/problem+json').send(body)
  }
}
