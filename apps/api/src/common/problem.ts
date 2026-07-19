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
  invalidTransition: `${BASE}:invalid-status-transition`,
  rateLimited: `${BASE}:rate-limited`,
  internal: `${BASE}:internal-error`,
  // Billing (phase 5, spec Stripe 2026-07-19) : `paymentRequired` réservé au
  // garde d'enforcement (BillingGuard, câblé sur invoices/ereporting depuis
  // la phase 5 Task 8) ; `billingDisabled` couvre les 2 endpoints POST de ce
  // module quand BILLING_DRIVER=none (BillingDisabledError, 503 — le driver
  // n'est pas configuré, pas une faute du client).
  paymentRequired: `${BASE}:subscription-required`,
  billingDisabled: `${BASE}:billing-disabled`,
  // Suspension opérateur (phase 5 it.2, posé par SuspensionGuard — Task 4) :
  // 403 dédié, JAMAIS 402 (contrairement à `paymentRequired` ci-dessus, la
  // suspension n'est pas une affaire commerciale mais une décision
  // opérateur — motif distinct pour ne pas confondre les deux blocages
  // côté client/dashboard).
  tenantSuspended: `${BASE}:tenant-suspended`,
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
