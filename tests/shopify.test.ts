import { describe, expect, it } from 'vitest';
import { signShopifyBody, verifyShopifyHmac } from '../src/shopify.js';

const secret = 'test-secret';
const body = Buffer.from('{"id":1}');

describe('verifyShopifyHmac', () => {
  it('accepts a correct signature', () => {
    expect(verifyShopifyHmac(body, signShopifyBody(body, secret), secret)).toBe(
      true
    );
  });

  it('rejects a signature made with another secret', () => {
    expect(
      verifyShopifyHmac(body, signShopifyBody(body, 'other'), secret)
    ).toBe(false);
  });

  it('rejects a body that was altered after signing', () => {
    const signature = signShopifyBody(body, secret);
    expect(verifyShopifyHmac(Buffer.from('{"id":2}'), signature, secret)).toBe(
      false
    );
  });

  it('rejects missing, empty, malformed and wrong-length signatures', () => {
    expect(verifyShopifyHmac(body, undefined, secret)).toBe(false);
    expect(verifyShopifyHmac(body, '', secret)).toBe(false);
    expect(verifyShopifyHmac(body, 'not base64 !!!', secret)).toBe(false);
    expect(verifyShopifyHmac(body, 'c2hvcnQ=', secret)).toBe(false);
  });
});
