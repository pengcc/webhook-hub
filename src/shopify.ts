import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifies Shopify's `X-Shopify-Hmac-Sha256` header: base64(HMAC-SHA256(secret,
 * raw body)). The comparison is constant-time and rejects anything that is not
 * a well-formed 32-byte digest before comparing.
 */
export function verifyShopifyHmac(
  rawBody: Buffer,
  headerValue: string | undefined,
  secret: string
): boolean {
  if (!headerValue) return false;
  const received = Buffer.from(headerValue, 'base64');
  // Re-encoding rejects input that only partially decodes as base64.
  if (received.length !== 32 || received.toString('base64') !== headerValue) {
    return false;
  }
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return timingSafeEqual(received, expected);
}

export function signShopifyBody(
  rawBody: Buffer | string,
  secret: string
): string {
  return createHmac('sha256', secret).update(rawBody).digest('base64');
}
