import { readFile } from "node:fs/promises";
import type { Snapshot } from "../types";
import { PYTH_SYMBOLS_URL, preparePythPublication, submitToPythAgent, validatePythManifest, validatePythSymbols } from "./index";

async function main(): Promise<void> {
  const [command, manifestPath, snapshotPath] = process.argv.slice(2);
  if (!["prepare", "publish"].includes(command ?? "") || !manifestPath || !snapshotPath) {
    throw new Error("Usage: bun src/pyth/cli.ts prepare|publish <protected-manifest.json> <snapshot.json>");
  }
  const manifest = validatePythManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as Snapshot;
  const response = await fetch(PYTH_SYMBOLS_URL, { redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Pyth catalog returned HTTP ${response.status}`);
  const catalog = validatePythSymbols(await response.json());
  const publication = preparePythPublication(snapshot, manifest, catalog);
  if (command === "prepare") console.log(JSON.stringify(publication, null, 2));
  else console.log(JSON.stringify(await submitToPythAgent(publication, manifest.agentUrl), null, 2));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Pyth publication failed");
    process.exitCode = 1;
  });
}
