import { analyzeTransactions, backtestTransactions } from "../src/transaction-research";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args.length !== 3) {
  console.error("Usage: bun run research:transactions <private-records.json> <private-config.json> <new-private-report.json>");
  process.exit(2);
}
try {
  // Bound local inputs before parsing. Never discover credentials or access a network.
  if (Bun.file(args[0]!).size > 64*1024*1024 || Bun.file(args[1]!).size > 1024*1024) throw new Error("Input limit");
  const records = await Bun.file(args[0]!).json();
  const config = await Bun.file(args[1]!).json();
  const report = Array.isArray(config) ? backtestTransactions(records,config) : analyzeTransactions(records,config);
  writeFileSync(args[2]!,JSON.stringify(report,null,2)+"\n",{encoding:"utf8",mode:0o600,flag:"wx"});
  console.log("Private research report created. Publication remains disabled.");
  if (("status" in report && report.status === "INSUFFICIENT_DATA") || ("missingWindows" in report && report.missingWindows>0)) process.exitCode = 2;
} catch {
  // Validation errors can embed confidential inputs; never echo them in CLI logs.
  console.error("Research input rejected. Check schema, permissions, reconciliation and duplicate intervals locally.");
  process.exitCode = 1;
}
