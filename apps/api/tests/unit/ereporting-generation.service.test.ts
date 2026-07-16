import { buildInvoice } from '@factelec/invoice-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EreportingGenerationJob } from '../../src/queue/ereporting-generation.job.js'

// La validation XSD (impureté d'exécution : subprocess xmllint) est mockée
// ici — testée pour elle-même dans ereporting-xsd-validator.test.ts, et de
// bout en bout (real xmllint) dans ereporting-generation.e2e.test.ts (tests
// 1 et 5) et ereporting-payments.e2e.test.ts. Motif ereporting-sweep.service
// .test.ts (mock de period.js) : tester l'ORCHESTRATION (repo/port/branches)
// en isolation de l'impureté. Nom préfixé `mock` requis par Vitest pour être
// référencé dans la factory hoistée.
const mockValidate = vi.fn()
vi.mock('../../src/ereporting/ereporting-xsd-validator.js', () => ({
  validateEreportingXml: (...args: unknown[]) => mockValidate(...args),
}))

const {
  EreportingGenerationService,
  periodDateToIso,
  buildTransmissionRef,
  formatIssueDateTime,
} = await import('../../src/ereporting/ereporting-generation.service.js')

// Facture B2C domestique (10.3) minimale, réutilisée pour tout test qui doit
// dépasser le stade « à blanc » — aggregateTransactions/generateEreportingXml
// restent RÉELS (purs, déjà testés unitairement ailleurs) : seule
// l'impureté (validation XSD) est mockée ici.
const invoice = buildInvoice({
  number: 'FA-1',
  issueDate: '2026-09-05',
  typeCode: '380',
  currency: 'EUR',
  businessProcessType: 'B1',
  seller: { name: 'V', siren: '111111111', address: { countryCode: 'FR' } },
  buyer: { name: 'A', address: { countryCode: 'FR' } },
  lines: [
    {
      id: '1',
      name: 'x',
      quantity: '1',
      unitCode: 'C62',
      unitPrice: '1000.00',
      vatCategory: 'S',
      vatRate: '20.00',
      nature: 'goods',
    },
  ],
} as never)

// Facture SERVICES pure (100 % services) — nécessaire pour dépasser le
// filtre services-only de `aggregatePayments` (note 119, ratio=1 partout).
const servicesInvoice = buildInvoice({
  number: 'FA-PAY-1',
  issueDate: '2026-09-05',
  typeCode: '380',
  currency: 'EUR',
  businessProcessType: 'S1',
  seller: { name: 'V', siren: '111111111', address: { countryCode: 'FR' } },
  buyer: { name: 'A', address: { countryCode: 'FR' } },
  lines: [
    {
      id: '1',
      name: 'prestation',
      quantity: '1',
      unitCode: 'C62',
      unitPrice: '1000.00',
      vatCategory: 'S',
      vatRate: '20.00',
      nature: 'services',
    },
  ],
} as never)

const job: EreportingGenerationJob = {
  tenantId: 'tenant-1',
  declarantId: 'decl-1',
  siren: '111111111',
  role: 'SE',
  fluxKind: 'transactions',
  periodStart: '20260901',
  periodEnd: '20260910',
  type: 'IN',
}

const paymentsJob: EreportingGenerationJob = {
  ...job,
  fluxKind: 'payments',
}

const declarant = {
  id: 'decl-1',
  siren: '111111111',
  name: 'Vendeur SARL',
  role: 'SE' as const,
  vatRegime: 'simplifie' as const,
  active: true,
  createdAt: new Date(0),
}

const paymentRow = {
  id: 'pay-1',
  invoiceId: 'inv-1',
  paymentDate: '20260905',
  currency: 'EUR',
  reference: 'REF-1',
  subtotals: [{ taxPercent: '20.00', amount: '1200.00' }],
  createdAt: new Date(0),
  updatedAt: new Date(0),
}

function fakeRepo(overrides: Record<string, unknown> = {}) {
  return {
    invoicesForPeriod: vi.fn().mockResolvedValue([invoice]),
    findDeclarant: vi.fn().mockResolvedValue(declarant),
    insertTransmission: vi
      .fn()
      .mockResolvedValue({ id: 'tr-1', created: true }),
    findTransmissionStatus: vi.fn().mockResolvedValue('prepared'),
    markTransmitted: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function fakePaymentsRepo(overrides: Record<string, unknown> = {}) {
  return {
    listPaymentsForPeriod: vi.fn().mockResolvedValue([paymentRow]),
    ...overrides,
  }
}

function fakeInvoicesRepo(overrides: Record<string, unknown> = {}) {
  return {
    loadCanonical: vi.fn().mockResolvedValue(servicesInvoice),
    ...overrides,
  }
}

function fakePort(overrides: Record<string, unknown> = {}) {
  return {
    transmit: vi
      .fn()
      .mockResolvedValue({ trackingId: 'TRACK-1', location: 'mem://x' }),
    status: vi.fn(),
    ...overrides,
  }
}

const fakeConfig = {
  get: (key: string) =>
    ({
      EREPORTING_PA_ID: 'PA00',
      EREPORTING_PA_SCHEME_ID: '0238',
      EREPORTING_PA_NAME: 'Factelec PA',
    })[key],
}

function build(
  repoOverrides = {},
  portOverrides = {},
  paymentsRepoOverrides = {},
  invoicesRepoOverrides = {},
) {
  const repo = fakeRepo(repoOverrides)
  const paymentsRepo = fakePaymentsRepo(paymentsRepoOverrides)
  const invoicesRepo = fakeInvoicesRepo(invoicesRepoOverrides)
  const port = fakePort(portOverrides)
  const service = new EreportingGenerationService(
    repo as never,
    paymentsRepo as never,
    invoicesRepo as never,
    port as never,
    fakeConfig as never,
  )
  return { service, repo, paymentsRepo, invoicesRepo, port }
}

describe('périodDateToIso / buildTransmissionRef / formatIssueDateTime (pures)', () => {
  it('periodDateToIso convertit AAAAMMJJ -> AAAA-MM-JJ', () => {
    expect(periodDateToIso('20260905')).toBe('2026-09-05')
  })

  it('buildTransmissionRef est déterministe, ≤ 50 caractères', () => {
    const ref = buildTransmissionRef(
      '11111111-2222-3333-4444-555555555555',
      '20260901',
      'IN',
    )
    expect(ref).toBe('ER-11111111-20260901-IN')
    expect(ref.length).toBeLessThanOrEqual(50)
    expect(buildTransmissionRef('abc-declarant', '20260101', 'RE')).toBe(
      buildTransmissionRef('abc-declarant', '20260101', 'RE'),
    )
  })

  it('formatIssueDateTime sérialise AAAAMMJJHHMMSS en UTC', () => {
    expect(formatIssueDateTime(new Date(Date.UTC(2026, 8, 21, 8, 5, 9)))).toBe(
      '20260921080509',
    )
  })
})

describe('EreportingGenerationService.generate — transactions', () => {
  beforeEach(() => {
    mockValidate.mockReset()
    mockValidate.mockResolvedValue({ valid: true, errors: '' })
  })

  it('rejette un fluxKind inconnu (garde défensive, payload Redis non typé) sans lire ni les factures ni les paiements', async () => {
    const { service, repo, paymentsRepo } = build()
    await expect(
      service.generate({
        ...job,
        fluxKind: 'bogus' as EreportingGenerationJob['fluxKind'],
      }),
    ).rejects.toThrow(/non pris en charge/)
    expect(repo.invoicesForPeriod).not.toHaveBeenCalled()
    expect(paymentsRepo.listPaymentsForPeriod).not.toHaveBeenCalled()
  })

  it('à blanc (aucune opération 10.3) : ZÉRO écriture, ZÉRO appel port (injection #1, D6)', async () => {
    const { service, repo, port } = build({
      invoicesForPeriod: vi.fn().mockResolvedValue([]),
    })
    await service.generate(job)
    expect(repo.findDeclarant).not.toHaveBeenCalled()
    expect(repo.insertTransmission).not.toHaveBeenCalled()
    expect(port.transmit).not.toHaveBeenCalled()
  })

  it('déclarant disparu entre enfilement et traitement : no-op idempotent', async () => {
    const { service, repo, port } = build({
      findDeclarant: vi.fn().mockResolvedValue(null),
    })
    await service.generate(job)
    expect(repo.insertTransmission).not.toHaveBeenCalled()
    expect(port.transmit).not.toHaveBeenCalled()
  })

  it('XML valide, création fraîche : insertTransmission -> transmit -> markTransmitted', async () => {
    const { service, repo, port } = build()
    await service.generate(job)

    expect(repo.insertTransmission).toHaveBeenCalledTimes(1)
    const arg = repo.insertTransmission.mock.calls[0]![1]
    expect(arg.rejectMotif).toBeUndefined()
    expect(typeof arg.xml).toBe('string')
    expect(arg.invoiceCount).toBe(1)

    expect(port.transmit).toHaveBeenCalledTimes(1)
    expect(port.transmit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        fluxKind: 'transactions',
        transmissionRef: buildTransmissionRef('decl-1', '20260901', 'IN'),
      }),
    )
    expect(repo.markTransmitted).toHaveBeenCalledWith(
      'tenant-1',
      'tr-1',
      'TRACK-1',
    )
    // Création fraîche (created:true) : aucune relecture de statut requise.
    expect(repo.findTransmissionStatus).not.toHaveBeenCalled()
  })

  it('XML XSD-invalide : rejet local REJ_SEMAN persisté, port JAMAIS appelé (injection #6)', async () => {
    mockValidate.mockResolvedValue({ valid: false, errors: 'boom' })
    const { service, repo, port } = build({
      insertTransmission: vi
        .fn()
        .mockResolvedValue({ id: 'tr-2', created: true }),
    })
    await service.generate(job)

    expect(repo.insertTransmission).toHaveBeenCalledTimes(1)
    const arg = repo.insertTransmission.mock.calls[0]![1]
    expect(arg.rejectMotif).toBe('REJ_SEMAN')
    expect(typeof arg.xml).toBe('string')
    expect(port.transmit).not.toHaveBeenCalled()
    expect(repo.markTransmitted).not.toHaveBeenCalled()
  })

  it('rejeu d’un XML XSD-invalide déjà rejeté (created:false) : no-op, port toujours jamais appelé', async () => {
    mockValidate.mockResolvedValue({ valid: false, errors: 'boom' })
    const { service, repo, port } = build({
      insertTransmission: vi
        .fn()
        .mockResolvedValue({ id: 'tr-2', created: false }),
    })
    await service.generate(job)
    expect(port.transmit).not.toHaveBeenCalled()
    expect(repo.findTransmissionStatus).not.toHaveBeenCalled()
  })

  it("erreur d'outillage (XsdToolingError) : PROPAGÉE (throw -> retry BullMQ), jamais persistée en rejetee (injection #6)", async () => {
    mockValidate.mockRejectedValue(new Error('xmllint introuvable'))
    const { service, repo } = build()
    await expect(service.generate(job)).rejects.toThrow('xmllint introuvable')
    expect(repo.insertTransmission).not.toHaveBeenCalled()
  })

  it("rejeu déjà transmis (created:false, statut != 'prepared') : SKIP total, port jamais rappelé (injection #4)", async () => {
    const { service, repo, port } = build({
      insertTransmission: vi
        .fn()
        .mockResolvedValue({ id: 'tr-3', created: false }),
      findTransmissionStatus: vi.fn().mockResolvedValue('transmitted'),
    })
    await service.generate(job)
    expect(repo.findTransmissionStatus).toHaveBeenCalledWith('tenant-1', 'tr-3')
    expect(port.transmit).not.toHaveBeenCalled()
    expect(repo.markTransmitted).not.toHaveBeenCalled()
  })

  it("reprise après crash (created:false, statut 'prepared') : transmit + markTransmitted rejoués (injection #4)", async () => {
    const { service, repo, port } = build({
      insertTransmission: vi
        .fn()
        .mockResolvedValue({ id: 'tr-4', created: false }),
      findTransmissionStatus: vi.fn().mockResolvedValue('prepared'),
    })
    await service.generate(job)
    expect(port.transmit).toHaveBeenCalledTimes(1)
    expect(repo.markTransmitted).toHaveBeenCalledWith(
      'tenant-1',
      'tr-4',
      'TRACK-1',
    )
  })

  it('CAS périmé sur markTransmitted (concurrent) : capturée, no-op, generate ne lève pas (injection #5)', async () => {
    const { service, repo } = build({
      markTransmitted: vi
        .fn()
        .mockRejectedValue(
          new Error("transmission tr-1 is not in 'prepared' status"),
        ),
    })
    await expect(service.generate(job)).resolves.toBeUndefined()
    expect(repo.markTransmitted).toHaveBeenCalledTimes(1)
  })
})

describe('EreportingGenerationService.generate — payments (Task 8, plan 3.2)', () => {
  beforeEach(() => {
    mockValidate.mockReset()
    mockValidate.mockResolvedValue({ valid: true, errors: '' })
  })

  it('à blanc (aucun encaissement e-reportable) : ZÉRO écriture, ZÉRO appel port, journalisé (D6)', async () => {
    const { service, repo, port, paymentsRepo } = build(
      {},
      {},
      { listPaymentsForPeriod: vi.fn().mockResolvedValue([]) },
    )
    await service.generate(paymentsJob)
    expect(paymentsRepo.listPaymentsForPeriod).toHaveBeenCalledWith(
      'tenant-1',
      '20260901',
      '20260910',
    )
    expect(repo.findDeclarant).not.toHaveBeenCalled()
    expect(repo.insertTransmission).not.toHaveBeenCalled()
    expect(port.transmit).not.toHaveBeenCalled()
  })

  it('facture liée 100% biens (aucune part services) : encaissement exclu -> à blanc', async () => {
    const { service, repo, port } = build(
      {},
      {},
      {},
      { loadCanonical: vi.fn().mockResolvedValue(invoice) },
    )
    await service.generate(paymentsJob)
    expect(repo.insertTransmission).not.toHaveBeenCalled()
    expect(port.transmit).not.toHaveBeenCalled()
  })

  it('déclarant disparu entre enfilement et traitement (payments) : no-op idempotent', async () => {
    const { service, repo, port } = build({
      findDeclarant: vi.fn().mockResolvedValue(null),
    })
    await service.generate(paymentsJob)
    expect(repo.insertTransmission).not.toHaveBeenCalled()
    expect(port.transmit).not.toHaveBeenCalled()
  })

  it('XML valide, création fraîche : loader scopé tenant, Report{payments} XOR transactions, insertTransmission -> transmit -> markTransmitted', async () => {
    const { service, repo, port, invoicesRepo } = build()
    await service.generate(paymentsJob)

    expect(invoicesRepo.loadCanonical).toHaveBeenCalledWith('tenant-1', 'inv-1')

    expect(repo.insertTransmission).toHaveBeenCalledTimes(1)
    const arg = repo.insertTransmission.mock.calls[0]![1]
    expect(arg.fluxKind).toBe('payments')
    expect(arg.rejectMotif).toBeUndefined()
    expect(typeof arg.xml).toBe('string')
    expect(arg.xml).toContain('PaymentsReport')
    expect(arg.xml).not.toContain('TransactionsReport')
    expect(arg.invoiceCount).toBe(1)

    expect(port.transmit).toHaveBeenCalledTimes(1)
    expect(port.transmit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        fluxKind: 'payments',
        transmissionRef: buildTransmissionRef('decl-1', '20260901', 'IN'),
      }),
    )
    expect(repo.markTransmitted).toHaveBeenCalledWith(
      'tenant-1',
      'tr-1',
      'TRACK-1',
    )
  })

  it('XML XSD-invalide (payments) : rejet local REJ_SEMAN persisté, port JAMAIS appelé', async () => {
    mockValidate.mockResolvedValue({ valid: false, errors: 'boom' })
    const { service, repo, port } = build({
      insertTransmission: vi
        .fn()
        .mockResolvedValue({ id: 'tr-p-2', created: true }),
    })
    await service.generate(paymentsJob)

    expect(repo.insertTransmission).toHaveBeenCalledTimes(1)
    const arg = repo.insertTransmission.mock.calls[0]![1]
    expect(arg.fluxKind).toBe('payments')
    expect(arg.rejectMotif).toBe('REJ_SEMAN')
    expect(port.transmit).not.toHaveBeenCalled()
    expect(repo.markTransmitted).not.toHaveBeenCalled()
  })

  it("erreur d'outillage (XsdToolingError, payments) : PROPAGÉE, jamais persistée en rejetee", async () => {
    mockValidate.mockRejectedValue(new Error('xmllint introuvable'))
    const { service, repo } = build()
    await expect(service.generate(paymentsJob)).rejects.toThrow(
      'xmllint introuvable',
    )
    expect(repo.insertTransmission).not.toHaveBeenCalled()
  })

  it("rejeu déjà transmis (created:false, statut != 'prepared', payments) : SKIP total", async () => {
    const { service, repo, port } = build({
      insertTransmission: vi
        .fn()
        .mockResolvedValue({ id: 'tr-p-3', created: false }),
      findTransmissionStatus: vi.fn().mockResolvedValue('transmitted'),
    })
    await service.generate(paymentsJob)
    expect(repo.findTransmissionStatus).toHaveBeenCalledWith(
      'tenant-1',
      'tr-p-3',
    )
    expect(port.transmit).not.toHaveBeenCalled()
  })
})
