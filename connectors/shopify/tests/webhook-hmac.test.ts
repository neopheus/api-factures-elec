import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifyShopifyWebhookHmac } from '../src/webhook-hmac.js'

const SECRET = 'un-secret-partage-de-test'

function sign(rawBody: Buffer, secret = SECRET): string {
  return createHmac('sha256', secret).update(rawBody).digest('base64')
}

describe('verifyShopifyWebhookHmac', () => {
  it('accepte une signature valide (vecteur calculé au vrai crypto)', () => {
    const rawBody = Buffer.from(
      JSON.stringify({ id: 12345, total_price: '42.00' }),
    )
    const signature = sign(rawBody)
    expect(verifyShopifyWebhookHmac(rawBody, SECRET, signature)).toBe(true)
  })

  it('rejette une signature invalide de même longueur', () => {
    const rawBody = Buffer.from('{"id":1}')
    const validSignature = sign(rawBody)
    // Corrompt le dernier caractère base64 tout en gardant la même longueur.
    const tampered = `${validSignature.slice(0, -1)}${validSignature.at(-1) === 'A' ? 'B' : 'A'}`
    expect(verifyShopifyWebhookHmac(rawBody, SECRET, tampered)).toBe(false)
  })

  it('rejette une signature de longueur différente (garde AVANT timingSafeEqual)', () => {
    const rawBody = Buffer.from('{"id":1}')
    expect(verifyShopifyWebhookHmac(rawBody, SECRET, 'trop-courte')).toBe(false)
    // Base64 valide mais décodant vers un buffer de longueur DIFFÉRENTE du
    // digest SHA-256 (32 octets) — doit être rejeté par la garde de
    // longueur, jamais atteindre `timingSafeEqual` (qui lèverait sinon).
    const wrongLength = Buffer.alloc(10, 7).toString('base64')
    expect(verifyShopifyWebhookHmac(rawBody, SECRET, wrongLength)).toBe(false)
  })

  it('rejette quand le corps a été modifié après signature (même secret)', () => {
    const original = Buffer.from('{"id":1,"total_price":"10.00"}')
    const tamperedBody = Buffer.from('{"id":1,"total_price":"1000.00"}')
    const signature = sign(original)
    expect(verifyShopifyWebhookHmac(tamperedBody, SECRET, signature)).toBe(
      false,
    )
  })

  it('rejette quand le secret ne correspond pas', () => {
    const rawBody = Buffer.from('{"id":1}')
    const signature = sign(rawBody, 'autre-secret')
    expect(verifyShopifyWebhookHmac(rawBody, SECRET, signature)).toBe(false)
  })

  it('rejette une signature absente', () => {
    const rawBody = Buffer.from('{"id":1}')
    expect(verifyShopifyWebhookHmac(rawBody, SECRET, undefined)).toBe(false)
  })

  it('rejette une signature vide', () => {
    const rawBody = Buffer.from('{"id":1}')
    expect(verifyShopifyWebhookHmac(rawBody, SECRET, '')).toBe(false)
  })

  it('valide un corps vide correctement signé', () => {
    const rawBody = Buffer.alloc(0)
    const signature = sign(rawBody)
    expect(verifyShopifyWebhookHmac(rawBody, SECRET, signature)).toBe(true)
  })
})
