/**
 * Cloudflare provider: the hub file-exchange store over R2.
 *
 * The exchange lets a participant with a per-participant capability
 * place and fetch files under one prefix of a bound R2 bucket:
 * `exchange/<participant-short-id>/`. It carries file bytes only —
 * never message content — and the ledger remains the source of truth
 * for the conversation itself. There is deliberately no listing and
 * no delete: a capability can read and write its own prefix, nothing
 * more.
 *
 * The bucket is reached only through the minimal {@link R2BucketLike}
 * port, so the route logic (worker.ts) can be tested against an
 * in-memory fake and the binding stays replaceable.
 */

/** The subset of an R2 object this provider reads (HEAD result). */
export interface R2ObjectLike {
  size: number;
  etag?: string;
  httpMetadata?: { contentType?: string };
}

/** An R2 object with a readable body (GET result). */
export interface R2ObjectBodyLike extends R2ObjectLike {
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** The subset of the R2 bucket binding this provider uses. */
export interface R2BucketLike {
  get(key: string): Promise<R2ObjectBodyLike | null>;
  head(key: string): Promise<R2ObjectLike | null>;
  put(
    key: string,
    value: ArrayBuffer | Uint8Array,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
}

/**
 * Minimum length for an exchange capability to take effect. Exchange
 * capabilities authorize writes, so the bar is higher than the
 * read-only doorbell's: a shorter value never takes effect
 * (fail-closed), and a too-short value inside
 * EXCHANGE_CAPABILITIES_JSON fails startup.
 */
export const MIN_EXCHANGE_CAPABILITY_LENGTH = 32;

/** Upper bound for one exchanged object: 25 MiB. Over it, PUT is 413. */
export const MAX_EXCHANGE_OBJECT_SIZE = 25 * 1024 * 1024;

/** Upper bound for the caller-supplied key suffix (after the prefix). */
export const MAX_EXCHANGE_KEY_SUFFIX_LENGTH = 512;

/**
 * The exchange prefix one participant is scoped to:
 * `exchange/<short-id>/`, where the short id is the participant id
 * after the `agent:` prefix (`agent:maro` -> `exchange/maro/`). A
 * participant id whose derived short id is empty or could break out
 * of the prefix shape throws — the map is operator configuration and
 * must fail loudly instead of scoping a capability somewhere
 * unintended.
 */
export function exchangePrefixFor(participantId: string): string {
  const shortId = participantId.startsWith('agent:')
    ? participantId.slice('agent:'.length)
    : participantId;
  if (
    shortId === '' ||
    shortId === '.' ||
    shortId === '..' ||
    shortId.includes('/') ||
    shortId.includes('\\') ||
    [...shortId].some((ch) => {
      const code = ch.codePointAt(0)!;
      return code < 0x20 || code === 0x7f;
    })
  ) {
    throw new Error(
      `EXCHANGE_CAPABILITIES_JSON participant id ${participantId} does not derive a valid exchange prefix`,
    );
  }
  return `exchange/${shortId}/`;
}

/**
 * Resolve EXCHANGE_CAPABILITIES_JSON — a JSON object mapping
 * participant id to capability — into a map from capability value to
 * the full prefix that value may touch. The map is
 * operator-maintained configuration, so malformed entries — bad
 * JSON, a non-object, an empty participant id, a non-string or
 * too-short value, a value duplicating another capability, a
 * participant id that derives no valid prefix, or two participant
 * ids deriving the same prefix (e.g. `agent:maro` and `maro`, which
 * would silently share one scope) — throw instead of silently
 * weakening the route (fail-closed, exactly like the doorbell
 * capability resolution). Unset or empty means the route is
 * not configured.
 */
export function resolveExchangeCapabilities(
  perParticipantJson: string | undefined,
): Map<string, string> {
  const capabilities = new Map<string, string>();
  const prefixes = new Map<string, string>();
  if (perParticipantJson === undefined || perParticipantJson === '') {
    return capabilities;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(perParticipantJson);
  } catch {
    throw new Error('EXCHANGE_CAPABILITIES_JSON must be valid JSON');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new Error(
      'EXCHANGE_CAPABILITIES_JSON must be a JSON object mapping participant id to capability',
    );
  }
  for (const [participantId, value] of Object.entries(parsed)) {
    if (participantId === '') {
      throw new Error(
        'EXCHANGE_CAPABILITIES_JSON has an empty participant id',
      );
    }
    if (
      typeof value !== 'string' ||
      value.length < MIN_EXCHANGE_CAPABILITY_LENGTH
    ) {
      throw new Error(
        `EXCHANGE_CAPABILITIES_JSON capability for ${participantId} must be a string of at least ${MIN_EXCHANGE_CAPABILITY_LENGTH} characters`,
      );
    }
    if (capabilities.has(value)) {
      throw new Error(
        'EXCHANGE_CAPABILITIES_JSON capability values must be unique',
      );
    }
    const prefix = exchangePrefixFor(participantId);
    const prefixHolder = prefixes.get(prefix);
    if (prefixHolder !== undefined) {
      throw new Error(
        `EXCHANGE_CAPABILITIES_JSON participant ids ${prefixHolder} and ${participantId} derive the same exchange prefix`,
      );
    }
    prefixes.set(prefix, participantId);
    capabilities.set(value, prefix);
  }
  return capabilities;
}

/**
 * Whether a caller-supplied key suffix (the part after the caller's
 * prefix) is acceptable. The stored key is always the caller's prefix
 * joined with the suffix, so a suffix can never reach another
 * participant's prefix by construction; the segment rules are
 * defense in depth for downstream consumers that treat keys as
 * paths. Rejected: an empty suffix, empty / `.` / `..` segments,
 * backslashes, control characters, and suffixes longer than
 * {@link MAX_EXCHANGE_KEY_SUFFIX_LENGTH}.
 */
export function isValidExchangeKeySuffix(suffix: string): boolean {
  if (suffix === '' || suffix.length > MAX_EXCHANGE_KEY_SUFFIX_LENGTH) {
    return false;
  }
  if (suffix.includes('\\')) {
    return false;
  }
  for (const ch of suffix) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) {
      return false;
    }
  }
  for (const segment of suffix.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      return false;
    }
  }
  return true;
}
