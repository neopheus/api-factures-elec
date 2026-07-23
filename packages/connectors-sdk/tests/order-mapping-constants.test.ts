import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  BUSINESS_PROCESS_TYPES,
  INVOICE_LINE_NATURES,
  INVOICE_TYPE_CODES,
  VAT_CATEGORIES,
} from '../src/order-mapping.js'

// Garde anti-dérive : les constantes runtime exportées par order-mapping.ts
// (utilisables par un connecteur TS pour construire une UI, valider un choix
// utilisateur, etc.) doivent rester EXACTEMENT les mêmes listes que les
// `enum` du JSON Schema — les deux sont des transcriptions indépendantes du
// zod réel d'invoice-core (motif du fichier : connectors-sdk ne DÉPEND PAS
// d'invoice-core). Sans ce test, un ajout de valeur dans l'un des deux
// fichiers sans l'autre passerait inaperçu.
const schema = JSON.parse(
  readFileSync(
    new URL('../schema/order-mapping.schema.json', import.meta.url),
    'utf8',
  ),
) as {
  properties: {
    typeCode: { enum: string[] }
    businessProcessType: { enum: string[] }
  }
  $defs: {
    invoiceLine: {
      properties: {
        vatCategory: { enum: string[] }
        nature: { enum: string[] }
      }
    }
  }
}

describe('order-mapping.ts constants ↔ order-mapping.schema.json enums (no drift)', () => {
  it('VAT_CATEGORIES == schema lines.vatCategory.enum', () => {
    expect([...VAT_CATEGORIES].sort()).toEqual(
      [...schema.$defs.invoiceLine.properties.vatCategory.enum].sort(),
    )
  })

  it('INVOICE_TYPE_CODES == schema typeCode.enum', () => {
    expect([...INVOICE_TYPE_CODES].sort()).toEqual(
      [...schema.properties.typeCode.enum].sort(),
    )
  })

  it('BUSINESS_PROCESS_TYPES == schema businessProcessType.enum', () => {
    expect([...BUSINESS_PROCESS_TYPES].sort()).toEqual(
      [...schema.properties.businessProcessType.enum].sort(),
    )
  })

  it('INVOICE_LINE_NATURES == schema lines.nature.enum', () => {
    expect([...INVOICE_LINE_NATURES].sort()).toEqual(
      [...schema.$defs.invoiceLine.properties.nature.enum].sort(),
    )
  })
})
