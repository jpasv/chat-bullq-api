import { createHmac, timingSafeEqual } from 'crypto';

/**
 * HMAC-SHA256 sobre o corpo cru da requisição, nos dois sentidos do canal
 * MEMBERS. Formato do header: `sha256=<hex minúsculo>`.
 */
export function signMembersBody(body: string | Buffer, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export function verifyMembersSignature(
  header: string | string[] | undefined,
  rawBody: Buffer | string,
  secret: string | null | undefined,
): boolean {
  if (!secret) return false;
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string' || !value.startsWith('sha256=')) return false;

  const expected = Buffer.from(signMembersBody(rawBody, secret));
  const received = Buffer.from(value.trim().toLowerCase());
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}
