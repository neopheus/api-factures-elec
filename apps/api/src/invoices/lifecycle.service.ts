import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common'
import { ProblemType, problem } from '../common/problem.js'
import { isUuid } from '../common/uuid.js'
// biome-ignore lint/style/useImportType: InvoicesRepository résolu par Nest via design:paramtypes.
import { InvoicesRepository } from './invoices.repository.js'
import {
  canTransition,
  type LifecycleStatus,
  requiresReason,
} from './lifecycle-status.js'

@Injectable()
export class LifecycleService {
  constructor(private readonly repo: InvoicesRepository) {}

  async transition(
    tenantId: string,
    invoiceId: string,
    toStatus: LifecycleStatus,
    actor: string,
    reason: string | undefined,
  ): Promise<{ status: LifecycleStatus }> {
    if (!isUuid(invoiceId)) throw this.notFound()
    const current = await this.repo.getLifecycleStatus(tenantId, invoiceId)
    if (!current) throw this.notFound()
    if (!canTransition(current, toStatus)) {
      throw new UnprocessableEntityException(
        problem(
          422,
          ProblemType.invalidTransition,
          'Invalid status transition',
          {
            detail: `Transition ${current} → ${toStatus} is not allowed`,
          },
        ),
      )
    }
    if (requiresReason(toStatus) && (!reason || reason.trim() === '')) {
      throw new UnprocessableEntityException(
        problem(422, ProblemType.validation, 'A reason is required', {
          errors: [
            {
              path: 'reason',
              message: `reason required for status ${toStatus}`,
            },
          ],
        }),
      )
    }
    const ok = await this.repo.recordTransition(
      tenantId,
      invoiceId,
      current,
      toStatus,
      actor,
      reason,
    )
    if (!ok) {
      throw new ConflictException(
        problem(409, ProblemType.conflict, 'Concurrent status change', {
          detail: 'The invoice status changed concurrently; retry',
        }),
      )
    }
    return { status: toStatus }
  }

  async history(
    tenantId: string,
    invoiceId: string,
  ): Promise<{ current: LifecycleStatus; events: unknown[] }> {
    if (!isUuid(invoiceId)) throw this.notFound()
    const current = await this.repo.getLifecycleStatus(tenantId, invoiceId)
    if (!current) throw this.notFound()
    const events = await this.repo.listStatusEvents(tenantId, invoiceId)
    return { current, events }
  }

  private notFound(): NotFoundException {
    return new NotFoundException(
      problem(404, ProblemType.notFound, 'Invoice not found'),
    )
  }
}
