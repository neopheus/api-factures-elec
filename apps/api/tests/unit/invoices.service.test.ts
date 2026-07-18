import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock de @factelec/invoice-core : isole le mapping d'erreurs du service de la
// validation zod réelle. Sert notamment à prouver l'amendement A1— la détection
// de l'erreur de validation est STRUCTURELLE (name === 'ZodError' + issues[]),
// PAS `instanceof z.ZodError` : on simule ici une erreur qui a la forme d'un
// ZodError sans être une instance de la classe zod (cf. task-7-report.md, A1).
vi.mock('@factelec/invoice-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@factelec/invoice-core')>()
  return {
    ...actual,
    parseInvoiceInput: vi.fn(),
    buildInvoice: vi.fn(),
    validateBusinessRules: vi.fn(),
  }
})

const { parseInvoiceInput, buildInvoice, validateBusinessRules } = await import(
  '@factelec/invoice-core'
)
const { InvoicesService } = await import(
  '../../src/invoices/invoices.service.js'
)
const { UnprocessableEntityException, ConflictException } = await import(
  '@nestjs/common'
)

function fakeRepo() {
  return { insertReceived: vi.fn() }
}
function fakeQueue() {
  return { enqueue: vi.fn().mockResolvedValue(undefined) }
}
// `resolveRouting` (Task 4, plan 3.5) n'est exercée par aucun test de ce
// fichier (dédiés à `ingest`) — fake non-fonctionnel, requis uniquement pour
// l'arité du constructeur.
function fakeRouting() {
  return { resolveAndRecord: vi.fn() }
}

describe('InvoicesService.ingest', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('maps a structural zod-shaped validation error to 422 with mapped issue details (A1: no instanceof)', async () => {
    // Ni instance de z.ZodError, ni du package zod — uniquement la forme
    // structurelle attendue (name + issues[]).
    class NotAZodError extends Error {
      name = 'ZodError'
      issues = [{ path: ['number'], code: 'invalid_type', message: 'Required' }]
    }
    vi.mocked(parseInvoiceInput).mockImplementation(() => {
      throw new NotAZodError()
    })
    const service = new InvoicesService(
      fakeRepo() as never,
      fakeQueue() as never,
      fakeRouting() as never,
    )

    await expect(service.ingest('tenant-1', {})).rejects.toMatchObject(
      new UnprocessableEntityException(
        expect.objectContaining({
          status: 422,
          type: 'urn:factelec:problem:validation-error',
          errors: [
            { path: 'number', code: 'invalid_type', message: 'Required' },
          ],
        }),
      ),
    )
  })

  it('rethrows a non-object thrown value from parseInvoiceInput unchanged', async () => {
    vi.mocked(parseInvoiceInput).mockImplementation(() => {
      throw 'plain string failure'
    })
    const service = new InvoicesService(
      fakeRepo() as never,
      fakeQueue() as never,
      fakeRouting() as never,
    )

    await expect(service.ingest('tenant-1', {})).rejects.toBe(
      'plain string failure',
    )
  })

  it('rethrows an error shaped like an object but without the ZodError name unchanged', async () => {
    vi.mocked(parseInvoiceInput).mockImplementation(() => {
      throw new Error('boom')
    })
    const service = new InvoicesService(
      fakeRepo() as never,
      fakeQueue() as never,
      fakeRouting() as never,
    )

    await expect(service.ingest('tenant-1', {})).rejects.toThrow('boom')
  })

  it('rethrows an object named ZodError but without an issues array unchanged', async () => {
    vi.mocked(parseInvoiceInput).mockImplementation(() => {
      throw { name: 'ZodError', issues: 'not-an-array' }
    })
    const service = new InvoicesService(
      fakeRepo() as never,
      fakeQueue() as never,
      fakeRouting() as never,
    )

    await expect(service.ingest('tenant-1', {})).rejects.toEqual({
      name: 'ZodError',
      issues: 'not-an-array',
    })
  })

  it('maps business rule violations to 422 with rule ids', async () => {
    vi.mocked(parseInvoiceInput).mockReturnValue({} as never)
    vi.mocked(buildInvoice).mockReturnValue({ number: 'FA-1' } as never)
    vi.mocked(validateBusinessRules).mockReturnValue([
      { rule: 'BR-E-10', message: 'exemption reason required' },
    ])
    const service = new InvoicesService(
      fakeRepo() as never,
      fakeQueue() as never,
      fakeRouting() as never,
    )

    await expect(service.ingest('tenant-1', {})).rejects.toMatchObject(
      new UnprocessableEntityException(
        expect.objectContaining({
          status: 422,
          type: 'urn:factelec:problem:business-rule-violation',
          errors: [{ rule: 'BR-E-10', message: 'exemption reason required' }],
        }),
      ),
    )
  })

  it('persists as received then enqueues, returning { id, status: received }', async () => {
    const invoice = { number: 'FA-1' }
    vi.mocked(parseInvoiceInput).mockReturnValue({} as never)
    vi.mocked(buildInvoice).mockReturnValue(invoice as never)
    vi.mocked(validateBusinessRules).mockReturnValue([])
    const repo = fakeRepo()
    repo.insertReceived.mockResolvedValue({ id: 'invoice-1' })
    const queue = fakeQueue()
    const service = new InvoicesService(
      repo as never,
      queue as never,
      fakeRouting() as never,
    )

    const result = await service.ingest('tenant-1', { number: 'FA-1' })

    expect(repo.insertReceived).toHaveBeenCalledWith('tenant-1', invoice)
    expect(queue.enqueue).toHaveBeenCalledWith('tenant-1', 'invoice-1')
    expect(result).toEqual({ id: 'invoice-1', status: 'received' })
  })

  it('does NOT enqueue when insert fails with a duplicate (409)', async () => {
    vi.mocked(parseInvoiceInput).mockReturnValue({} as never)
    vi.mocked(buildInvoice).mockReturnValue({ number: 'FA-DUP' } as never)
    vi.mocked(validateBusinessRules).mockReturnValue([])
    const repo = fakeRepo()
    repo.insertReceived.mockRejectedValue({
      code: '23505',
      constraint: 'invoices_tenant_number_unique',
    })
    const queue = fakeQueue()
    const service = new InvoicesService(
      repo as never,
      queue as never,
      fakeRouting() as never,
    )
    await expect(service.ingest('tenant-1', {})).rejects.toMatchObject(
      new ConflictException(
        expect.objectContaining({
          status: 409,
          type: 'urn:factelec:problem:conflict',
        }),
      ),
    )
    expect(queue.enqueue).not.toHaveBeenCalled()
  })

  it('translates a unique-violation pg error (23505) from insertReceived into 409 conflict', async () => {
    vi.mocked(parseInvoiceInput).mockReturnValue({} as never)
    vi.mocked(buildInvoice).mockReturnValue({ number: 'FA-DUP' } as never)
    vi.mocked(validateBusinessRules).mockReturnValue([])
    const repo = fakeRepo()
    repo.insertReceived.mockRejectedValue({
      code: '23505',
      constraint: 'invoices_tenant_number_unique',
    })
    const service = new InvoicesService(
      repo as never,
      fakeQueue() as never,
      fakeRouting() as never,
    )

    await expect(service.ingest('tenant-1', {})).rejects.toMatchObject(
      new ConflictException(
        expect.objectContaining({
          status: 409,
          type: 'urn:factelec:problem:conflict',
          detail: expect.stringContaining('FA-DUP'),
        }),
      ),
    )
  })

  it('translates a unique-violation wrapped in a DrizzleQueryError-like cause chain into 409', async () => {
    // drizzle-orm enveloppe l'erreur pg d'origine (celle qui porte `.code`)
    // dans `.cause` — reproduit ici sans dépendre de drizzle-orm lui-même.
    vi.mocked(parseInvoiceInput).mockReturnValue({} as never)
    vi.mocked(buildInvoice).mockReturnValue({ number: 'FA-DUP' } as never)
    vi.mocked(validateBusinessRules).mockReturnValue([])
    const repo = fakeRepo()
    const wrapped = new Error('Failed query: insert into "invoices" ...')
    ;(wrapped as { cause?: unknown }).cause = {
      code: '23505',
      constraint: 'invoices_tenant_number_unique',
    }
    repo.insertReceived.mockRejectedValue(wrapped)
    const service = new InvoicesService(
      repo as never,
      fakeQueue() as never,
      fakeRouting() as never,
    )

    await expect(service.ingest('tenant-1', {})).rejects.toMatchObject(
      new ConflictException(
        expect.objectContaining({
          status: 409,
          type: 'urn:factelec:problem:conflict',
        }),
      ),
    )
  })

  it('does NOT map a 23505 with a DIFFERENT constraint name to 409 (hardening, task-8)', async () => {
    // Une violation d'unicité 23505 sur une AUTRE contrainte (ex: future
    // contrainte sur invoice_formats) ne doit jamais être faussement
    // interprétée comme un doublon (tenant, number).
    vi.mocked(parseInvoiceInput).mockReturnValue({} as never)
    vi.mocked(buildInvoice).mockReturnValue({ number: 'FA-1' } as never)
    vi.mocked(validateBusinessRules).mockReturnValue([])
    const repo = fakeRepo()
    const otherConstraintError = {
      code: '23505',
      constraint: 'invoice_formats_invoice_kind_unique',
    }
    repo.insertReceived.mockRejectedValue(otherConstraintError)
    const service = new InvoicesService(
      repo as never,
      fakeQueue() as never,
      fakeRouting() as never,
    )

    await expect(service.ingest('tenant-1', {})).rejects.toBe(
      otherConstraintError,
    )
  })

  it('rethrows a non-unique-violation persistence error unchanged', async () => {
    vi.mocked(parseInvoiceInput).mockReturnValue({} as never)
    vi.mocked(buildInvoice).mockReturnValue({ number: 'FA-1' } as never)
    vi.mocked(validateBusinessRules).mockReturnValue([])
    const repo = fakeRepo()
    const dbError = new Error('connection reset')
    repo.insertReceived.mockRejectedValue(dbError)
    const service = new InvoicesService(
      repo as never,
      fakeQueue() as never,
      fakeRouting() as never,
    )

    await expect(service.ingest('tenant-1', {})).rejects.toBe(dbError)
  })
})
