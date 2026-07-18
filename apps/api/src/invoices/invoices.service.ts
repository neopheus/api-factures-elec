import {
  buildInvoice,
  type InvoiceInput,
  parseInvoiceInput,
  validateBusinessRules,
} from '@factelec/invoice-core'
import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common'
import { ProblemType, problem } from '../common/problem.js'
import { isUuid } from '../common/uuid.js'
// biome-ignore lint/style/useImportType: InvoiceGenerationQueue résolu par Nest via design:paramtypes.
import { InvoiceGenerationQueue } from '../queue/invoice-generation.queue.js'
import type { FormatKind } from './format-generator.port.js'
import type { InvoiceDetail, RoutingStatus } from './invoices.repository.js'
// biome-ignore lint/style/useImportType: InvoicesRepository est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { InvoicesRepository } from './invoices.repository.js'
// biome-ignore lint/style/useImportType: RecipientRoutingService est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { RecipientRoutingService } from './recipient-routing.service.js'

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
//
// Hardening (task-8, suite à la revue du plan) : on exige EN PLUS que
// `.constraint` soit `invoices_tenant_number_unique` — sans cette vérification,
// N'IMPORTE QUELLE violation d'unicité 23505 survenant dans la même
// transaction (ex: une future contrainte sur invoice_formats) serait
// faussement mappée en 409 "Invoice already exists" au lieu de remonter
// l'erreur réelle. `constraint` est un champ standard des erreurs pg
// (DatabaseError) pour ce SQLSTATE — présent au même niveau que `.code`.
function isUniqueViolation(e: unknown): boolean {
  let current: unknown = e
  for (
    let depth = 0;
    depth < 5 && current !== null && current !== undefined;
    depth++
  ) {
    if (
      typeof current === 'object' &&
      (current as { code?: string }).code === '23505' &&
      (current as { constraint?: string }).constraint ===
        'invoices_tenant_number_unique'
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
    private readonly queue: InvoiceGenerationQueue,
    private readonly routing: RecipientRoutingService,
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

    // 3) Persistance immédiate au statut `received` (idempotence 23505 → 409).
    let id: string
    try {
      ;({ id } = await this.repo.insertReceived(tenantId, invoice))
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

    // 4) Enfilement de la génération (hors-bande). Payload minimal (ids only).
    // Si Redis est indisponible, l'appel échoue (500) mais la facture reste
    // persistée en `received` et re-traitable (réconciliation différée, notée
    // au reprise) ; la readiness Redis prévient ce cas en amont.
    await this.queue.enqueue(tenantId, id)
    return { id, status: 'received' }
  }

  async get(
    tenantId: string,
    id: string,
  ): Promise<InvoiceDetail & { availableFormats: FormatKind[] }> {
    if (!isUuid(id)) throw this.notFound()
    const invoice = await this.repo.findById(tenantId, id)
    if (!invoice) throw this.notFound()
    const availableFormats = await this.repo.listFormatKinds(tenantId, id)
    return { ...invoice, availableFormats }
  }

  list(
    tenantId: string,
    limit: number,
    cursor?: string,
    routingStatus?: RoutingStatus,
  ) {
    return this.repo.list(tenantId, limit, cursor, routingStatus)
  }

  async getFormat(tenantId: string, id: string, kind: FormatKind) {
    if (!isUuid(id)) throw this.notFound()
    const format = await this.repo.findFormat(tenantId, id, kind)
    if (!format) throw this.notFound()
    return format
  }

  // Re-résolution opérateur d'un routage `ambiguous` (Task 4, plan 3.5, D6) :
  // garde `ambiguous`-ONLY (409 sinon, miroir exact du 409
  // `noRectifiableInitialTransmission` de `EreportingRetransmissionService`),
  // 404 anti-fuite byte-identique (inconnue/cross-tenant/`:id` malformé
  // indiscernables, motif `notFound()` ci-dessous), `resolveAndRecord`
  // réutilisé VERBATIM (best-effort strict, D2 — ne relève jamais). Le 200
  // rapporte l'état RELU (`findRoutingState` après l'appel) — JAMAIS une
  // promesse fabriquée : si l'annuaire n'a pas été nettoyé (ou panne
  // opérationnelle pendant le best-effort), la réponse reporte fidèlement
  // l'état obtenu (`ambiguous`/`unaddressable`), pas un succès inventé.
  async resolveRouting(
    tenantId: string,
    id: string,
  ): Promise<{
    invoiceId: string
    routingStatus: string
    recipientPlatform: string | null
  }> {
    if (!isUuid(id)) throw this.notFound()
    const state = await this.repo.findRoutingState(tenantId, id)
    if (!state) throw this.notFound()
    if (state.status !== 'ambiguous') {
      throw new ConflictException(
        problem(409, ProblemType.conflict, 'Routing not in ambiguous state'),
      )
    }
    const invoice = await this.repo.loadCanonical(tenantId, id)
    if (!invoice) throw this.notFound()
    await this.routing.resolveAndRecord(tenantId, id, invoice)
    // Relecture défensive (motif `loadCanonical` ci-dessus) : la facture
    // pourrait en théorie disparaître entre la garde et cette relecture —
    // jamais un cas réel observé, mais un 404 explicite reste plus honnête
    // qu'un throw non-géré sur un `next` qui serait `null`.
    const next = await this.repo.findRoutingState(tenantId, id)
    if (!next) throw this.notFound()
    return {
      invoiceId: id,
      routingStatus: next.status,
      recipientPlatform: next.platform,
    }
  }

  private notFound(): NotFoundException {
    return new NotFoundException(
      problem(404, ProblemType.notFound, 'Invoice not found'),
    )
  }
}
