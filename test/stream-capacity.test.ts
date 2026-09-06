// Small integration smoke only. The default standalone harness runs all 31 days.
import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("capacity offline preload prevents fetch, sockets and native Bun network access", async () => {
  const preload = resolve(import.meta.dir, "../scripts/capacity-offline-preload.ts");
  const source = `import ${JSON.stringify(preload)}; import net from "node:net"; import https from "node:https";
    let denied=0;for(const action of [()=>fetch("https://example.invalid"),()=>net.connect(443,"example.invalid"),()=>https.get("https://example.invalid"),()=>Bun.connect({hostname:"example.invalid",port:443}),()=>new WebSocket("wss://example.invalid")]){
      try{await action();throw new Error("NETWORK_GUARD_MISSING");}catch(error){if(error.message!=="CAPACITY_NETWORK_FORBIDDEN")throw error;denied++;}}
    console.log(JSON.stringify({denied}));`;
  const child = Bun.spawn([process.execPath, "-e", source], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" }); expect(JSON.parse(stdout)).toEqual({ denied: 5 });
});

test("checkpoint/export/inspection/restore/study run in separate memory-measured processes", async () => {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../scripts/verify-stream-capacity.ts"), "--cycles", "3"],
    { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  const result = JSON.parse(stdout.trim().split("\n").at(-1)!) as {
    kind: string; fullThirtyOneDayCapacityPassed: boolean; memoryMeasurement: string; capturedObservations: number;
    retainedDirectory: string | null; phases: Array<{ phase: string; peakRssBytes: number; result: Record<string, unknown> }>;
  };
  expect(result.kind).toBe("SBX_SYNTHETIC_STREAM_CAPACITY_ONLY"); expect(result.fullThirtyOneDayCapacityPassed).toBe(false);
  expect(result.capturedObservations).toBe(192); expect(result.retainedDirectory).toBeNull();
  expect(result.memoryMeasurement).toBe("FRESH_PROCESS_OS_PEAK_RSS");
  expect(result.phases.map(phase => phase.phase)).toEqual(["build", "export", "inspect", "restore", "study", "local-backup", "local-restore"]);
  expect(result.phases.every(phase => phase.peakRssBytes > 0 && phase.peakRssBytes <= 384 * 1024 * 1024)).toBe(true);
  expect(result.phases[1]!.result).toMatchObject({ sourceVerified: true, sourceCapturesAfterBegin: 4, checkpointCaptures: 3, counterIncrementsFromCollectionOnly: true });
  expect(result.phases[2]!.result).toMatchObject({ reproducedSnapshots: 3, observations: 192 });
  expect(result.phases[3]!.result).toMatchObject({ status: "RECOVERY_REVIEW_REQUIRED", reproducedSnapshots: 3, observations: 192 });
  expect(result.phases[4]!.result).toMatchObject({ complete: true, independentReproducedSnapshots: 3, frozenCountersVerified: true, frozenSnapshotHeadVerified: true });
  expect(result.phases[5]!.result).toMatchObject({contentInspection:"VERIFIED",reproducedSnapshots:3,observations:192,recoveryProvenance:{records:1,linkedRecords:1}});
  expect(result.phases[6]!.result).toMatchObject({status:"RECOVERY_REVIEW_REQUIRED",reproducedSnapshots:3,observations:192});
}, 180_000);
