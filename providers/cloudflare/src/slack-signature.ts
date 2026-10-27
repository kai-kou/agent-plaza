/**
 * Cloudflare provider: Slack request signature verification for the
 * Worker ingress.
 *
 * Implements Slack's v0 scheme: HMAC-SHA256 over `v0:<timestamp>:<body>`
 * with the app's signing secret, compared in constant time against the
 * `v0=<hex>` signature header. Requests whose timestamp is outside the
 * tolerance window are rejected as replays. Uses WebCrypto, which is
 * available both in Workers and in Node 20+.
 */

export interface SlackSignatureInput {
  signingSecret: string;
  /** The x-slack-request-timestamp header value (seconds since epoch). */
  timestamp: string;
  /** The exact raw request body, unparsed. */
  body: string;
  /** The x-slack-signature header value (`v0=<hex>`). */
  signature: string;
  /** Current time in seconds since epoch (injected for testability). */
  nowSeconds: number;
  /** Maximum allowed |now - timestamp| in seconds. Default 300. */
  toleranceSeconds?: number;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

export async function verifySlackSignature(
  input: SlackSignatureInput,
): Promise<boolean> {
  const tolerance = input.toleranceSeconds ?? 300;
  const ts = Number(input.timestamp);
  if (!Number.isFinite(ts) || !/^\d+$/.test(input.timestamp)) return false;
  if (Math.abs(input.nowSeconds - ts) > tolerance) return false;

  if (!input.signature.startsWith('v0=')) return false;
  const provided = hexToBytes(input.signature.slice(3));
  if (provided === null) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(input.signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`v0:${input.timestamp}:${input.body}`),
  );
  return timingSafeEqual(new Uint8Array(mac), provided);
}
