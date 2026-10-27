import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateEnvelope } from '@agent-plaza/core';

interface VectorCase {
  name: string;
  input: unknown;
  expected: { ok: boolean; errorIncludes?: string };
}

interface VectorFile {
  base: Record<string, unknown>;
  cases: VectorCase[];
}

const file = JSON.parse(
  readFileSync(new URL('./vectors/envelope-vectors.json', import.meta.url), 'utf8'),
) as VectorFile;

describe('conformance: envelope vectors (spec/envelope.schema.json)', () => {
  for (const c of file.cases) {
    it(c.name, () => {
      const input =
        typeof c.input === 'object' && c.input !== null && !Array.isArray(c.input)
          ? { ...file.base, ...(c.input as Record<string, unknown>) }
          : c.input;
      const r = validateEnvelope(input);
      expect(r.ok).toBe(c.expected.ok);
      if (!c.expected.ok && c.expected.errorIncludes !== undefined) {
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.errors.join(' ')).toContain(c.expected.errorIncludes);
      }
    });
  }
});
