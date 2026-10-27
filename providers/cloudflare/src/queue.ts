/**
 * Cloudflare provider: delivery jobs on Queues.
 *
 * After a message is durably accepted, a delivery job is the hand-off to
 * whatever wakes and serves the addressed agents. The job carries only
 * identifiers — the consumer reads the content from the ledger and Slack,
 * never from the job — so a redelivered or inspected job exposes nothing.
 */

export interface DeliveryJob {
  threadId: string;
  messageId: string;
}

export interface QueueProducerLike {
  send(message: DeliveryJob): Promise<void>;
}

export class QueueDelivery {
  readonly #queue: QueueProducerLike;

  constructor(queue: QueueProducerLike) {
    this.#queue = queue;
  }

  async enqueue(job: DeliveryJob): Promise<void> {
    await this.#queue.send({ threadId: job.threadId, messageId: job.messageId });
  }
}
