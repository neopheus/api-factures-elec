import type { InvoiceInput } from '../src/model/schema.js'

export const simpleInvoiceInput: InvoiceInput = {
  number: 'FA-2026-001',
  issueDate: '2026-07-12',
  dueDate: '2026-08-11',
  typeCode: '380',
  currency: 'EUR',
  businessProcessType: 'S1', // BT-23 : prestation de service seule (conseil)
  seller: {
    name: 'AV Digital',
    siren: '123456789',
    vatId: 'FR32123456789',
    address: {
      streetName: '1 rue de la Paix',
      city: 'Paris',
      postalCode: '75002',
      countryCode: 'FR',
    },
  },
  buyer: {
    name: 'Client SARL',
    siren: '987654321',
    vatId: 'FR40987654321',
    address: {
      streetName: '5 avenue des Champs',
      city: 'Lyon',
      postalCode: '69001',
      countryCode: 'FR',
    },
  },
  lines: [
    {
      id: '1',
      name: 'Prestation de développement',
      quantity: '1',
      unitCode: 'C62',
      unitPrice: '1000.00',
      vatCategory: 'S',
      vatRate: '20.00',
    },
  ],
}

export const creditNoteInput: InvoiceInput = {
  ...simpleInvoiceInput,
  number: 'AV-2026-001',
  typeCode: '381',
}

export const multiRateInvoiceInput: InvoiceInput = {
  ...simpleInvoiceInput,
  number: 'FA-2026-002',
  businessProcessType: 'M1', // BT-23 : facture double (biens + services)
  lines: [
    {
      id: '1',
      name: 'Livre',
      quantity: '3',
      unitCode: 'C62',
      unitPrice: '19.99',
      vatCategory: 'S',
      vatRate: '5.50',
    },
    {
      id: '2',
      name: 'Abonnement SaaS',
      quantity: '1',
      unitCode: 'C62',
      unitPrice: '49.90',
      vatCategory: 'S',
      vatRate: '20.00',
    },
    {
      id: '3',
      name: 'Formation exonérée',
      quantity: '2',
      unitCode: 'C62',
      unitPrice: '150.00',
      vatCategory: 'E',
      vatRate: '0.00',
      exemptionReasonCode: 'VATEX-EU-132-1I',
    },
  ],
}
