import { readFileSync } from 'node:fs'
import type { ErrorObject } from 'ajv'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'

// Charge le schéma et les 3 fixtures RÉELLEMENT depuis le disque (pas
// d'import TS/JSON via bundler) : c'est exactement ce que consomme le
// module PHP PrestaShop (phase 4 it.1, tâches 3/4) et n'importe quel
// connecteur tiers hors de ce monorepo — le schéma et les fixtures doivent
// donc rester du JSON brut, lisible tel quel.
const SCHEMA_URL = new URL(
  '../schema/order-mapping.schema.json',
  import.meta.url,
)
const FIXTURES = [
  'b2b-siren.json',
  'b2c-sans-siren.json',
  'multi-taux-tva.json',
] as const

function loadJson(url: URL): unknown {
  return JSON.parse(readFileSync(url, 'utf8'))
}

describe('order-mapping.schema.json (JSON Schema 2020-12)', () => {
  // strict: true (défaut Ajv) — toute construction de schéma invalide (mot-clé
  // inconnu, format non enregistré, etc.) fait échouer la compilation elle-même,
  // pas seulement la validation d'une fixture.
  const ajv = new Ajv2020({ allErrors: true })
  const validate = ajv.compile(loadJson(SCHEMA_URL) as object)

  it.each(FIXTURES)('valide la fixture %s contre le schéma', (name) => {
    const fixtureUrl = new URL(`../fixtures/${name}`, import.meta.url)
    const payload = loadJson(fixtureUrl)
    const valid = validate(payload)
    expect(validate.errors, JSON.stringify(validate.errors)).toBeNull()
    expect(valid).toBe(true)
  })

  it('rejette un payload structurellement invalide (buyer manquant, typeCode hors énumération)', () => {
    const invalid = {
      number: 'X',
      issueDate: '2026-07-23',
      typeCode: '999',
      currency: 'EUR',
      seller: {
        name: 'Vendeur',
        address: { countryCode: 'FR' },
      },
      lines: [],
    }
    const valid = validate(invalid)
    expect(valid).toBe(false)
    const missingBuyer = (validate.errors ?? []).some(
      (e: ErrorObject) =>
        e.keyword === 'required' &&
        (e.params as { missingProperty?: string }).missingProperty === 'buyer',
    )
    expect(missingBuyer).toBe(true)
  })

  it('rejette une ligne sans champs requis (mapping vide)', () => {
    const invalid = {
      number: 'X',
      issueDate: '2026-07-23',
      typeCode: '380',
      currency: 'EUR',
      seller: { name: 'Vendeur', address: { countryCode: 'FR' } },
      buyer: { name: 'Acheteur', address: { countryCode: 'FR' } },
      lines: [{}],
    }
    expect(validate(invalid)).toBe(false)
  })
})
