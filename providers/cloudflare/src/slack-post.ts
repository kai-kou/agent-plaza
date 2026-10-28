/**
 * Cloudflare provider: posting to Slack as the hub bot.
 *
 * A thin adapter over Slack's chat.postMessage Web API method, using
 * the hub app's Bot User OAuth Token. The token is a Worker secret; it
 * is used only as the Authorization header here and is never logged,
 * stored in the ledger, or returned to callers.
 *
 * Failures are values, not exceptions: a Slack error answer maps to
 * { ok: false, error: <slack error code> } and a transport failure to
 * { ok: false, error: 'slack_request_failed' }.
 */

export interface SlackPostInput {
  channel: string;
  text: string;
  /** Slack thread_ts to reply under; omitted for top-level posts. */
  threadTs?: string;
}

export type SlackPostResult =
  | { ok: true; ts: string }
  | { ok: false; error: string };

/** The slice of fetch this adapter needs (injectable for tests). */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{ json(): Promise<unknown> }>;

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

export async function postSlackMessage(
  botToken: string,
  input: SlackPostInput,
  fetchImpl: FetchLike = defaultFetch,
): Promise<SlackPostResult> {
  let data: unknown;
  try {
    const res = await fetchImpl('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${botToken}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        channel: input.channel,
        text: input.text,
        ...(input.threadTs === undefined
          ? {}
          : { thread_ts: input.threadTs }),
      }),
    });
    data = await res.json();
  } catch {
    return { ok: false, error: 'slack_request_failed' };
  }
  const parsed = data as { ok?: unknown; ts?: unknown; error?: unknown };
  if (parsed.ok === true && typeof parsed.ts === 'string') {
    return { ok: true, ts: parsed.ts };
  }
  return {
    ok: false,
    error: typeof parsed.error === 'string' ? parsed.error : 'unknown_error',
  };
}
