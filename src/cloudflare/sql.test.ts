import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { environment } from "../../test/helpers";
import { CloudflareJournal, DurableSqlDriver } from "./sql";

const databases: Database[] = [];
function setup() {
  const db = new Database(":memory:"); databases.push(db);
  const storage = {
    sql: {exec(sql:string,...values:unknown[]) {
      // Enforce the production per-row budget for this adapter's storage test.
      const bytes = values.reduce<number>((sum,value) => sum + (typeof value === "string" ? Buffer.byteLength(value) : value instanceof ArrayBuffer ? value.byteLength : 8), 0);
      if (bytes > 2_000_000) throw new Error("SQLITE_TOOBIG");
      if (sql.includes(";") && !values.length) { db.exec(sql); return {toArray:()=>[],rowsWritten:0}; }
      const rows = db.query(sql).all(...values.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value) as never[]);
      return {toArray:()=>rows,rowsWritten:db.query("SELECT changes() AS changes").get() ? 1 : 0,[Symbol.iterator]:()=>rows[Symbol.iterator]()};
    }},
    transactionSync<T>(fn:()=>T):T {return db.transaction(fn)();},
  } as unknown as DurableObjectStorage;
  const driver = new DurableSqlDriver(storage);
  return {db,driver,store:new CloudflareJournal(driver)};
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

test("Durable SQL driver handles all, get, iterate and atomic rollback", () => {
  const {driver} = setup();
  driver.query("INSERT INTO counters(id,value) VALUES(?,?)").run("a",1);
  expect(driver.query("SELECT value FROM counters WHERE id=?").get("a")).toEqual({value:1});
  expect(driver.query("SELECT value FROM counters WHERE id=?").get("missing")).toBeNull();
  expect([...driver.query("SELECT value FROM counters").iterate()]).toEqual([{value:1}]);
  expect(() => driver.transaction(() => {driver.query("UPDATE counters SET value=2").run();throw new Error("rollback");})()).toThrow("rollback");
  expect(driver.query("SELECT value FROM counters").all()).toEqual([{value:1}]);
  expect(() => driver.query("SELECT ?").get(undefined)).toThrow("UNSUPPORTED_SQL_BINDING");
});

test("private evidence larger than a Cloudflare row round trips without loss", async () => {
  const {store,db} = setup(), body = randomBytes(3 * 1024 * 1024 + 57), hash = createHash("sha256").update(body).digest("hex");
  const record = {hash,source:"unit-test",url:"https://fixture.example",receivedAt:1,contentType:"application/octet-stream",body};
  await store.archive(record); await store.archive(record);
  expect(Buffer.from(store.evidenceBody(hash)!)).toEqual(body);
  expect(store.counts().evidence).toBe(1);
  expect(db.query("SELECT COUNT(*) AS count FROM evidence_chunks").get()).toEqual({count:7});
  await expect(store.archive({...record,hash:"a".repeat(64)})).rejects.toThrow("Evidence digest mismatch");
  db.query("DELETE FROM evidence_chunks WHERE hash=? AND part=1").run(hash);
  expect(() => store.evidenceBody(hash)).toThrow("EVIDENCE_CHUNK_MISSING");
});

test("split private captures preserve every observation and count one cycle", () => {
  const {store,db} = setup(), sample = environment().observations[0]!;
  const observations = Array.from({length:2500},(_,i)=>({...sample,sku:`test-${i}`}));
  store.capture(observations,["TEST_ONLY"],100);
  const rows = db.query("SELECT observations,errors FROM captures ORDER BY id").all() as {observations:string;errors:string}[];
  expect(rows.length).toBeGreaterThan(1);
  expect(rows.flatMap(row=>JSON.parse(row.observations))).toEqual(observations);
  expect(rows.flatMap(row=>JSON.parse(row.errors))).toEqual(["TEST_ONLY"]);
  expect(store.captureCounts()).toEqual({count:1,earliest:100,latest:100});
  expect(store.counts().captures).toBe(1);
});
