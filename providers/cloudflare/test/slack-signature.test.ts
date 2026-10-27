import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifySlackSignature } from '@agent-plaza/cloudflare';

/**
 * The expected signatures here are computed with node:crypto's HMAC, an
 * implementation independent of the WebCrypto one under test, so the two
 * must agree byte for byte.
 */

const SECRET = 'synthetic-signing-secret';
const BODY = 'token=x&team_id=T000&event=message';
const NOW = 1_793_100_000;

function sign(secret: string, timestamp: string, body: string): string {
  const mac = createHmac('sha256', secret)
    .update(`v0:${timestamp}:${body}`)
    .digest('hex');
  return `v0=${mac}`;
}

describe('verifySlackSignature', () => {
  it('accepts a correctly signed, fresh request', async () => {
    const timestamp = String(NOW);
    await expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp,
        body: BODY,
        signature: sign(SECRET, timestamp, BODY),
        nowSeconds: NOW,
      }),
    ).resolves.toBe(true);
  });

  it('rejects a tampered body', async () => {
    const timestamp = String(NOW);
    await expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp,
        body: `${BODY}&injected=1`,
        signature: sign(SECRET, timestamp, BODY),
        nowSeconds: NOW,
      }),
    ).resolves.toBe(false);
  });

  it('rejects a signature made with a different secret', async () => {
    const timestamp = String(NOW);
    await expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp,
        body: BODY,
        signature: sign('another-secret', timestamp, BODY),
        nowSeconds: NOW,
      }),
    ).resolves.toBe(false);
  });

  it('rejects a stale timestamp (replay window) and a far-future one', async () => {
    const stale = String(NOW - 301);
    await expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp: stale,
        body: BODY,
        signature: sign(SECRET, stale, BODY),
        nowSeconds: NOW,
      }),
    ).resolves.toBe(false);
    const future = String(NOW + 301);
    await expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp: future,
        body: BODY,
        signature: sign(SECRET, future, BODY),
        nowSeconds: NOW,
      }),
    ).resolves.toBe(false);
  });

  it('accepts a timestamp exactly at the tolerance boundary', async () => {
    const edge = String(NOW - 300);
    await expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp: edge,
        body: BODY,
        signature: sign(SECRET, edge, BODY),
        nowSeconds: NOW,
      }),
    ).resolves.toBe(true);
  });

  it('rejects malformed signatures and timestamps', async () => {
    const timestamp = String(NOW);
    for (const signature of ['v0=zz', 'v1=abcd', 'abcd', 'v0=abc']) {
      await expect(
        verifySlackSignature({
          signingSecret: SECRET,
          timestamp,
          body: BODY,
          signature,
          nowSeconds: NOW,
        }),
      ).resolves.toBe(false);
    }
    await expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp: 'not-a-number',
        body: BODY,
        signature: sign(SECRET, timestamp, BODY),
        nowSeconds: NOW,
      }),
    ).resolves.toBe(false);
  });
});
