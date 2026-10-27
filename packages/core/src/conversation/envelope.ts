/**
 * Conversation context: the normalized message envelope.
 *
 * The envelope is the hub-internal form of one message. The body itself is
 * not embedded; it is referenced (bodyRef) with its SHA-256 (bodySha256), so
 * doorbells and ledger entries never carry message content. messageId and
 * idempotencyKey are distinct values by design: the id identifies the
 * message, the key identifies the acceptance operation.
 *
 * The normative contract is spec/envelope.schema.json; this module is its
 * TypeScript counterpart and validateEnvelope mirrors the schema's rules.
 */

export type MessageKind = 'discussion' | 'announcement' | 'emergency' | 'control';

export interface MessageEnvelope {
  messageId: string;
  idempotencyKey: string;
  tenantId: string;
  channelId: string;
  threadTs: string | null;
  senderId: string;
  recipientIds: string[];
  kind: MessageKind;
  /** Agent-to-agent hops since the last human post. */
  hopCount: number;
  /** Ledger-assigned sequence number; null before durable acceptance. */
  turnNumber: number | null;
  issuedAt: string;
  expiresAt: string;
  bodyRef: string;
  bodySha256: string;
}

export type ValidationResult =
  | { ok: true; value: MessageEnvelope }
  | { ok: false; errors: string[] };

const KINDS: readonly string[] = ['discussion', 'announcement', 'emergency', 'control'];
const SHA256_HEX = /^[0-9a-f]{64}$/;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

export function validateEnvelope(candidate: unknown): ValidationResult {
  const errors: string[] = [];
  if (typeof candidate !== 'object' || candidate === null) {
    return { ok: false, errors: ['envelope must be an object'] };
  }
  const e = candidate as Record<string, unknown>;

  for (const field of ['messageId', 'idempotencyKey', 'tenantId', 'channelId', 'senderId', 'bodyRef'] as const) {
    if (!isNonEmptyString(e[field])) {
      errors.push(`${field} must be a non-empty string`);
    }
  }
  if (e.threadTs !== null && !isNonEmptyString(e.threadTs)) {
    errors.push('threadTs must be a non-empty string or null');
  }
  if (
    !Array.isArray(e.recipientIds) ||
    e.recipientIds.some((r) => !isNonEmptyString(r))
  ) {
    errors.push('recipientIds must be an array of non-empty strings');
  }
  if (!KINDS.includes(e.kind as string)) {
    errors.push('kind must be one of discussion|announcement|emergency|control');
  }
  if (
    typeof e.hopCount !== 'number' ||
    !Number.isInteger(e.hopCount) ||
    e.hopCount < 0
  ) {
    errors.push('hopCount must be a non-negative integer');
  }
  if (
    e.turnNumber !== null &&
    (typeof e.turnNumber !== 'number' ||
      !Number.isInteger(e.turnNumber) ||
      e.turnNumber < 1)
  ) {
    errors.push('turnNumber must be null or a positive integer');
  }
  const issued = typeof e.issuedAt === 'string' ? Date.parse(e.issuedAt) : NaN;
  const expires = typeof e.expiresAt === 'string' ? Date.parse(e.expiresAt) : NaN;
  if (Number.isNaN(issued)) {
    errors.push('issuedAt must be an ISO 8601 timestamp');
  }
  if (Number.isNaN(expires) || (!Number.isNaN(issued) && expires <= issued)) {
    errors.push('expiresAt must be a timestamp after issuedAt');
  }
  if (typeof e.bodySha256 !== 'string' || !SHA256_HEX.test(e.bodySha256)) {
    errors.push('bodySha256 must be a 64-character lowercase hex SHA-256 digest');
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: candidate as MessageEnvelope };
}
