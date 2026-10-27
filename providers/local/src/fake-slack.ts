/**
 * Local provider: a fake Slack workspace.
 *
 * Bodies live here, in "Slack"; the ledger only ever carries a reference
 * (bodyRef) and the body's SHA-256, mirroring the real design where message
 * content stays in the platform and the hub stores references. Timestamps
 * are synthetic, zero-padded counters in the shape of Slack ts values.
 */

export interface FakeSlackMessage {
  ts: string;
  channelId: string;
  senderId: string;
  bodyText: string;
}

export class FakeSlack {
  readonly #messages: FakeSlackMessage[] = [];
  #seq = 0;

  /** The ts the next posted message will receive (does not advance). */
  peekTs(): string {
    return `${String(this.#seq + 1).padStart(10, '0')}.000100`;
  }

  postMessage(input: {
    channelId: string;
    senderId: string;
    bodyText: string;
  }): FakeSlackMessage {
    this.#seq += 1;
    const message: FakeSlackMessage = {
      ts: `${String(this.#seq).padStart(10, '0')}.000100`,
      channelId: input.channelId,
      senderId: input.senderId,
      bodyText: input.bodyText,
    };
    this.#messages.push(message);
    return message;
  }

  messages(): FakeSlackMessage[] {
    return this.#messages.map((m) => ({ ...m }));
  }

  /** Resolve a ledger bodyRef (fake-slack://<channelId>/<ts>) to its body. */
  bodyByRef(bodyRef: string): string | null {
    const match = /^fake-slack:\/\/[^/]+\/(.+)$/.exec(bodyRef);
    if (match === null) return null;
    const found = this.#messages.find((m) => m.ts === match[1]);
    return found === undefined ? null : found.bodyText;
  }
}
