/**
 * The shared response contract of the person and observer routes (`shared/contract/compute-responses.ts`;
 * epic #2005 review, ADR 0118): like the admin responses, every schema must accept and keep a key it does
 * not know, at the top level and in every object below, so a released reader survives the Worker adding
 * one; and a malformed answer is refused, not guessed. The real routes' output is parsed by
 * `backend/test/compute-person-responses.test.ts` and `backend/test/compute-observer.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import * as responses from "../shared/contract/compute-responses";

const VALID: Record<string, unknown> = {
  ComputeCancelResponseSchema: { ok: true, state: "running", outcome: "cancel_requested" },
  ComputeLinksResponseSchema: {
    links: [{ path: "a/b.csv", size: 12, url: "https://example.invalid/x" }],
    expires_at: "2026-11-13T10:00:00.000Z",
    total: 1,
    truncated: false,
    next_after: null,
  },
  ComputeObserverIngestResponseSchema: {
    ok: true,
    snapshots: 4,
    sacct_rows: 3,
    matched: 2,
    settled: 2,
    mismatched: 0,
    unmatched: 1,
    skipped: 0,
    truncated: true,
    settlement_failed: true,
  },
};

function withUnknownEverywhere(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) return value.map((v) => withUnknownEverywhere(v, depth + 1));
  if (value !== null && typeof value === "object") {
    return {
      ...Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, withUnknownEverywhere(v, depth + 1)]),
      ),
      [`future_key_${depth}`]: { added: "by a newer worker" },
    };
  }
  return value;
}

const schemas = () =>
  Object.entries(responses).filter((e): e is [string, z.ZodTypeAny] => e[1] instanceof z.ZodType);

describe("compute-responses", () => {
  test("every schema it exports is classified here, and nothing here is gone", () => {
    expect(
      schemas()
        .map(([n]) => n)
        .sort(),
    ).toEqual(Object.keys(VALID).sort());
  });

  for (const name of Object.keys(VALID)) {
    test(`${name} accepts the valid document, and the same with an unknown key on every object, kept`, () => {
      const schema = (responses as Record<string, unknown>)[name] as z.ZodTypeAny;
      expect(schema.safeParse(VALID[name]).success).toBe(true);
      const extended = withUnknownEverywhere(VALID[name]);
      const parsed = schema.safeParse(extended);
      expect([name, parsed.success]).toEqual([name, true]);
      if (parsed.success) expect(parsed.data).toEqual(extended);
    });
  }

  test("a malformed answer is refused, and the old camelCase observer keys are not accepted as the new ones", () => {
    expect(
      responses.ComputeCancelResponseSchema.safeParse({ ok: false, state: null, outcome: "x" })
        .success,
    ).toBe(false);
    expect(
      responses.ComputeLinksResponseSchema.safeParse({
        ...(VALID.ComputeLinksResponseSchema as object),
        next_after: 3,
      }).success,
    ).toBe(false);
    const { sacct_rows: _drop, ...old } = VALID.ComputeObserverIngestResponseSchema as Record<
      string,
      unknown
    >;
    expect(
      responses.ComputeObserverIngestResponseSchema.safeParse({ ...old, sacctRows: 3 }).success,
    ).toBe(false);
  });

  test("the file declares no closed schema and imports no strict compute schema", () => {
    const text = readFileSync(
      join(import.meta.dir, "..", "shared", "contract", "compute-responses.ts"),
      "utf8",
    );
    expect(text.includes(".strict(")).toBe(false);
    expect(/from "\.\/compute(-launch)?\.js"/.test(text)).toBe(false);
  });
});
