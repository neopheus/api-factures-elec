import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Vérification HMAC SHA-256 des webhooks Shopify (`X-Shopify-Hmac-Sha256`,
 * base64 de HMAC-SHA256(rawBody, secret)) — motif billing-webhook it.1
 * (`apps/api/src/billing/fake-billing.driver.ts`) : `timingSafeEqual` SUR LE
 * RAW BODY, garde de longueur AVANT l'appel (`timingSafeEqual` lève si les
 * deux buffers n'ont pas la même longueur — une signature de longueur
 * différente est invalide par construction, jamais une exception qui
 * remonterait).
 */
export function verifyShopifyWebhookHmac(
  rawBody: Buffer,
  secret: string,
  headerSignature: string | undefined,
): boolean {
  if (!headerSignature) return false
  const expected = createHmac('sha256', secret).update(rawBody).digest()
  const provided = Buffer.from(headerSignature, 'base64')
  if (expected.length !== provided.length) return false
  return timingSafeEqual(expected, provided)
}
