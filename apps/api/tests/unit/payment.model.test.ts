import { describe, expect, it } from 'vitest'
import {
  paymentCaptureSchema,
  paymentSubtotalCaptureSchema,
} from '../../src/payments/payment.model.js'

describe('payment.model (capture, D5)', () => {
  it('accepte une capture valide (référence + sous-totaux 1..n)', () => {
    const result = paymentCaptureSchema.safeParse({
      invoiceId: '11111111-1111-4111-8111-111111111111',
      paymentDate: '20260716',
      currency: 'EUR',
      reference: 'REF-1',
      subtotals: [{ taxPercent: '20.00', amount: '120.00' }],
    })
    expect(result.success).toBe(true)
  })

  it('currency est optionnel (défaut porté par la colonne DB, pas par le schéma)', () => {
    const result = paymentCaptureSchema.safeParse({
      invoiceId: '11111111-1111-4111-8111-111111111111',
      paymentDate: '20260716',
      reference: 'REF-1',
      subtotals: [{ taxPercent: '20.00', amount: '120.00' }],
    })
    expect(result.success).toBe(true)
  })

  it('rejette un invoiceId qui n’est pas un UUID', () => {
    const result = paymentCaptureSchema.safeParse({
      invoiceId: 'not-a-uuid',
      paymentDate: '20260716',
      reference: 'REF-1',
      subtotals: [{ taxPercent: '20.00', amount: '120.00' }],
    })
    expect(result.success).toBe(false)
  })

  it('rejette une référence vide (porte l’idempotence de capture, D5)', () => {
    const result = paymentCaptureSchema.safeParse({
      invoiceId: '11111111-1111-4111-8111-111111111111',
      paymentDate: '20260716',
      reference: '',
      subtotals: [{ taxPercent: '20.00', amount: '120.00' }],
    })
    expect(result.success).toBe(false)
  })

  it('rejette des sous-totaux vides (au moins 1 taux exigé)', () => {
    const result = paymentCaptureSchema.safeParse({
      invoiceId: '11111111-1111-4111-8111-111111111111',
      paymentDate: '20260716',
      reference: 'REF-1',
      subtotals: [],
    })
    expect(result.success).toBe(false)
  })

  it('rejette un sous-total avec un montant vide', () => {
    const result = paymentSubtotalCaptureSchema.safeParse({
      taxPercent: '20.00',
      amount: '',
    })
    expect(result.success).toBe(false)
  })
})
