import {
  buildInvoice,
  type InvoiceInput,
  parseInvoiceInput,
  validateBusinessRules,
} from '@factelec/invoice-core'
import {
  ConflictException,
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common'
import { ProblemType, problem } from '../common/problem.js'
import {
  INVOICE_FORMAT_GENERATOR,
  type InvoiceFormatGenerator,
} from './format-generator.port.js'
// biome-ignore lint/style/useImportType: InvoicesRepository est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { InvoicesRepository } from './invoices.repository.js'

interface ZodIssueLike {
  path: PropertyKey[]
  code: string
  message: string
}

// Détection STRUCTURELLE (duck-typing), pas `instanceof z.ZodError` : l'erreur
// provient de l'instance zod de @factelec/invoice-core, pas de celle d'apps/api.
// Le lockfile déduplique aujourd'hui les deux vers un seul zod@4.4.3 (donc
// `instanceof` fonctionnerait actuellement), mais cette détection reste correcte
// même si les deux packages venaient à résoudre des instances zod distinctes
// (ex. divergence de version future) — cf. task-7-report.md (amendement A1).
function isZodValidationError(e: unknown): e is { issues: ZodIssueLike[] } {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { name?: unknown }).name === 'ZodError' &&
    Array.isArray((e as { issues?: unknown }).issues)
  )
}

// drizzle-orm (>=0.36) enveloppe l'erreur pg dans une DrizzleQueryError et
// place l'erreur originale (celle qui porte le SQLSTATE `.code`) dans `.cause`
// — on remonte donc la chaîne de causes (bornée) plutôt que de ne lire que le
// niveau racine. Cf. task-7-report.md pour le détail de cette correction.
function isUniqueViolation(e: unknown): boolean {
  let current: unknown = e
  for (
    let depth = 0;
    depth < 5 && current !== null && current !== undefined;
    depth++
  ) {
    if (
      typeof current === 'object' &&
      (current as { code?: string }).code === '23505'
    ) {
      return true
    }
    current = (current as { cause?: unknown }).cause
  }
  return false
}

@Injectable()
export class InvoicesService {
  constructor(
    private readonly repo: InvoicesRepository,
    @Inject(INVOICE_FORMAT_GENERATOR)
    private readonly generator: InvoiceFormatGenerator,
  ) {}

  async ingest(
    tenantId: string,
    payload: unknown,
  ): Promise<{ id: string; status: string }> {
    // 1) Validation structurelle (zod) → 422 structuré.
    let input: InvoiceInput
    try {
      input = parseInvoiceInput(payload)
    } catch (e) {
      if (isZodValidationError(e)) {
        throw new UnprocessableEntityException(
          problem(422, ProblemType.validation, 'Invalid invoice payload', {
            errors: e.issues.map((i) => ({
              path: i.path.join('.'),
              code: i.code,
              message: i.message,
            })),
          }),
        )
      }
      throw e
    }

    // 2) Calcul canonique + règles métier EN 16931 → 422 métier.
    const invoice = buildInvoice(input)
    const violations = validateBusinessRules(invoice)
    if (violations.length > 0) {
      throw new UnprocessableEntityException(
        problem(422, ProblemType.businessRule, 'Business rule violations', {
          errors: violations,
        }),
      )
    }

    // 3) Génération synchrone des formats du socle (port).
    const formats = await this.generator.generate(invoice)

    // 4) Persistance (idempotence : unique(tenant, number) → 409).
    try {
      const { id } = await this.repo.persist(tenantId, invoice, formats)
      return { id, status: 'generated' }
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException(
          problem(409, ProblemType.conflict, 'Invoice already exists', {
            detail: `An invoice with number "${invoice.number}" already exists for this tenant`,
          }),
        )
      }
      throw e
    }
  }
}
