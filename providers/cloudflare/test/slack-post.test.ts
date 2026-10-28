import { describe, it, expect } from 'vitest';
import {
  postSlackMessage,
  type FetchLike,
} from '@agent-plaza/cloudflare';

interface CapturedCall {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string };
}

function fakeFetch(response: unknown, calls: CapturedCall[]): FetchLike {
  return async (url, init) => {
    calls.push({ url, init });
    return { json: async () => response };
  };
}

describe('postSlackMessage', () => {
  it('posts to chat.postMessage with the bot token and maps the ts', async () => {
    const calls: CapturedCall[] = [];
    const result = await postSlackMessage(
      'xoxb-test-token',
      { channel: 'C1', text: 'hello' },
      fakeFetch({ ok: true, ts: '1793100000.000100' }, calls),
    );
    expect(result).toEqual({ ok: true, ts: '1793100000.000100' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://slack.com/api/chat.postMessage');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.headers?.authorization).toBe(
      'Bearer xoxb-test-token',
    );
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({
      channel: 'C1',
      text: 'hello',
    });
  });

  it('includes thread_ts only when a thread is given', async () => {
    const calls: CapturedCall[] = [];
    const result = await postSlackMessage(
      'xoxb-test-token',
      { channel: 'C1', text: 'reply', threadTs: '1793100000.000100' },
      fakeFetch({ ok: true, ts: '1793100001.000200' }, calls),
    );
    expect(result.ok).toBe(true);
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({
      channel: 'C1',
      text: 'reply',
      thread_ts: '1793100000.000100',
    });
  });

  it('maps a Slack error answer to a failure result', async () => {
    const result = await postSlackMessage(
      'xoxb-test-token',
      { channel: 'C9', text: 'hello' },
      fakeFetch({ ok: false, error: 'channel_not_found' }, []),
    );
    expect(result).toEqual({ ok: false, error: 'channel_not_found' });
  });

  it('maps a transport failure to a failure result instead of throwing', async () => {
    const failing: FetchLike = async () => {
      throw new Error('network down');
    };
    const result = await postSlackMessage(
      'xoxb-test-token',
      { channel: 'C1', text: 'hello' },
      failing,
    );
    expect(result).toEqual({ ok: false, error: 'slack_request_failed' });
  });
});
