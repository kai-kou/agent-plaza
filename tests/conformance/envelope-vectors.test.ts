import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateEnvelope } from '@agent-plaza/core';

interface VectorCase {
  name: string;
  input: unknown;
  /** Fields deleted from the merged candidate before validation. */
  remove?: string[];
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
      let input: unknown =
        typeof c.input === 'object' && c.input !== null && !Array.isArray(c.input)
          ? { ...file.base, ...(c.input as Record<string, unknown>) }
          : c.input;
      if (c.remove !== undefined && typeof input === 'object' && input !== null) {
        const copy = { ...(input as Record<string, unknown>) };
        for (const key of c.remove) delete copy[key];
        input = copy;
      }
      const r = validateEnvelope(input);
      expect(r.ok).toBe(c.expected.ok);
      if (!c.expected.ok && c.expected.errorIncludes !== undefined) {
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.errors.join(' ')).toContain(c.expected.errorIncludes);
      }
    });
  }
});
