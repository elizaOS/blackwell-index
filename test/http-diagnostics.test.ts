import { expect, test } from "bun:test";
import { jsonRequest } from "../src/collectors/http";
import type { CollectorContext } from "../src/types";

test("HTTP errors never reflect arbitrary Retry-After header text or response bodies", async () => {
  for (const status of [429, 503, 403]) {
    for (const retry of ["private-test-only-reference", "https://example.invalid/?token=test-only", "9".repeat(200)]) {
      let archived = false;
      const context: CollectorContext = {
        now: () => 1788652800000, env: {}, archive: async () => { archived = true; },
        fetch: async () => new Response("private-test-only-error-body", { status, headers: { "retry-after": retry } }),
      };
      try { await jsonRequest(context, "test-source", new URL("https://example.invalid/")); throw new Error("Expected failure"); }
      catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(`${status === 429 ? "RATE_LIMITED" : "HTTP_ERROR"}: test-source HTTP ${status}`);
      }
      expect(archived).toBe(false);
    }
  }
});
