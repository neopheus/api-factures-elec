import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'

const VALID_ENV: Record<string, string> = {
  SHOPIFY_SHOP: 'ma-boutique.myshopify.com',
  SHOPIFY_ACCESS_TOKEN: 'shpat_'.padEnd(24, 'a'),
  SHOPIFY_WEBHOOK_SECRET: 'a'.repeat(16),
  PUBLIC_WEBHOOK_URL: 'https://connector.example.com',
  FACTELEC_API_URL: 'https://api.factelec.example.com',
  FACTELEC_API_KEY: 'b'.repeat(16),
  SELLER_NAME: 'Ma Boutique SARL',
  SELLER_SIREN: '123456789',
}

describe('loadConfig', () => {
  it('accepte un environnement valide et applique les défauts', () => {
    const config = loadConfig(VALID_ENV)
    expect(config.shopify.shop).toBe('ma-boutique.myshopify.com')
    expect(config.shopify.topic).toBe('orders/paid')
    expect(config.seller.siren).toBe('123456789')
    expect(config.seller.address.countryCode).toBe('FR')
    expect(config.port).toBe(3100)
    expect(config.linkDbPath).toBe('./var/links.sqlite')
    expect(config.retryEveryMs).toBe(300_000)
  })

  it('accepte SHOPIFY_TOPIC=orders/fulfilled explicite', () => {
    const config = loadConfig({ ...VALID_ENV, SHOPIFY_TOPIC: 'orders/fulfilled' })
    expect(config.shopify.topic).toBe('orders/fulfilled')
  })

  it('rejette un SHOPIFY_TOPIC hors énumération', () => {
    expect(() => loadConfig({ ...VALID_ENV, SHOPIFY_TOPIC: 'orders/cancelled' })).toThrow()
  })

  it('rejette un SHOPIFY_SHOP qui n\'est pas un domaine *.myshopify.com', () => {
    expect(() => loadConfig({ ...VALID_ENV, SHOPIFY_SHOP: 'ma-boutique.example.com' })).toThrow()
  })

  it('rejette un SHOPIFY_ACCESS_TOKEN trop court (< 20)', () => {
    expect(() => loadConfig({ ...VALID_ENV, SHOPIFY_ACCESS_TOKEN: 'short' })).toThrow()
  })

  it('accepte un SHOPIFY_ACCESS_TOKEN exactement à la borne (20)', () => {
    const config = loadConfig({ ...VALID_ENV, SHOPIFY_ACCESS_TOKEN: 'a'.repeat(20) })
    expect(config.shopify.accessToken).toHaveLength(20)
  })

  it('rejette un SHOPIFY_WEBHOOK_SECRET trop court (< 16)', () => {
    expect(() => loadConfig({ ...VALID_ENV, SHOPIFY_WEBHOOK_SECRET: 'a'.repeat(15) })).toThrow()
  })

  it('rejette FACTELEC_API_URL en http hors localhost', () => {
    expect(() => loadConfig({ ...VALID_ENV, FACTELEC_API_URL: 'http://api.factelec.example.com' })).toThrow()
  })

  it('accepte FACTELEC_API_URL en http pour localhost', () => {
    const config = loadConfig({ ...VALID_ENV, FACTELEC_API_URL: 'http://localhost:3000' })
    expect(config.factelec.apiUrl).toBe('http://localhost:3000')
  })

  it('accepte FACTELEC_API_URL en http pour 127.0.0.1', () => {
    const config = loadConfig({ ...VALID_ENV, FACTELEC_API_URL: 'http://127.0.0.1:3000' })
    expect(config.factelec.apiUrl).toBe('http://127.0.0.1:3000')
  })

  it('rejette FACTELEC_API_URL absente/malformée', () => {
    expect(() => loadConfig({ ...VALID_ENV, FACTELEC_API_URL: 'not-a-url' })).toThrow()
  })

  it('rejette FACTELEC_API_KEY trop courte (< 16)', () => {
    expect(() => loadConfig({ ...VALID_ENV, FACTELEC_API_KEY: 'a'.repeat(15) })).toThrow()
  })

  it('rejette PUBLIC_WEBHOOK_URL en http', () => {
    expect(() => loadConfig({ ...VALID_ENV, PUBLIC_WEBHOOK_URL: 'http://connector.example.com' })).toThrow()
  })

  it('rejette SELLER_SIREN qui n\'est pas 9 chiffres', () => {
    expect(() => loadConfig({ ...VALID_ENV, SELLER_SIREN: '12345678' })).toThrow()
    expect(() => loadConfig({ ...VALID_ENV, SELLER_SIREN: '1234567890' })).toThrow()
    expect(() => loadConfig({ ...VALID_ENV, SELLER_SIREN: 'abcdefghi' })).toThrow()
  })

  it('rejette SELLER_NAME vide', () => {
    expect(() => loadConfig({ ...VALID_ENV, SELLER_NAME: '' })).toThrow()
  })

  it('porte les champs vendeur optionnels quand fournis', () => {
    const config = loadConfig({
      ...VALID_ENV,
      SELLER_VAT_ID: 'FR12345678901',
      SELLER_STREET: '1 rue de la Paix',
      SELLER_CITY: 'Paris',
      SELLER_POSTAL_CODE: '75002',
      SELLER_COUNTRY: 'BE',
    })
    expect(config.seller.vatId).toBe('FR12345678901')
    expect(config.seller.address.streetName).toBe('1 rue de la Paix')
    expect(config.seller.address.city).toBe('Paris')
    expect(config.seller.address.postalCode).toBe('75002')
    expect(config.seller.address.countryCode).toBe('BE')
  })

  it('laisse les champs vendeur optionnels absents à undefined', () => {
    const config = loadConfig(VALID_ENV)
    expect(config.seller.vatId).toBeUndefined()
    expect(config.seller.address.streetName).toBeUndefined()
    expect(config.seller.address.city).toBeUndefined()
    expect(config.seller.address.postalCode).toBeUndefined()
  })

  it('applique les défauts PORT/LINK_DB_PATH/RETRY_EVERY_MS et coerce PORT', () => {
    const config = loadConfig({ ...VALID_ENV, PORT: '4000' })
    expect(config.port).toBe(4000)
  })

  it('rejette PORT non positif', () => {
    expect(() => loadConfig({ ...VALID_ENV, PORT: '0' })).toThrow()
    expect(() => loadConfig({ ...VALID_ENV, PORT: '-1' })).toThrow()
  })

  it('rejette RETRY_EVERY_MS non positif', () => {
    expect(() => loadConfig({ ...VALID_ENV, RETRY_EVERY_MS: '0' })).toThrow()
  })

  it('ne fuite aucune valeur de secret dans le message d\'erreur, seulement les clés', () => {
    const secretToken = 'shpat_SUPER_SECRET_TOKEN_VALUE'
    const secretWebhook = 'WEBHOOK_SECRET_VALUE_XYZ'
    const secretApiKey = 'FACTELEC_API_KEY_VALUE_XYZ'
    try {
      loadConfig({
        ...VALID_ENV,
        SHOPIFY_ACCESS_TOKEN: 'short', // invalide, mais on veut aussi vérifier qu'aucun AUTRE secret valide ne fuite
        SHOPIFY_WEBHOOK_SECRET: secretWebhook,
        FACTELEC_API_KEY: secretApiKey,
      })
      expect.unreachable('loadConfig aurait dû lever')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).not.toContain(secretToken)
      expect(message).not.toContain(secretWebhook)
      expect(message).not.toContain(secretApiKey)
      expect(message).toContain('SHOPIFY_ACCESS_TOKEN')
    }
  })
})
