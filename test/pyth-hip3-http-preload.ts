/** Test-only exception: one explicit loopback HTTP server; all outgoing APIs stay blocked. */
const serve = Bun.serve.bind(Bun);
let started = false;
await import("../scripts/capacity-offline-preload");

export function serveHttpFixture(fetch: (request: Request) => Promise<Response> | Response) {
  if (started) throw new Error("ONLY_ONE_LOCAL_FIXTURE_SERVER");
  started = true;
  return serve({ hostname: "127.0.0.1", port: 0, fetch });
}
