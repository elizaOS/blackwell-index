// Isolated operational-state fixtures. No upstream or chain requests are made.
import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { canonical } from "../src/crypto";
import { Store } from "../src/store";
import { archivePythRuntimeState, PYTH_RECOVERY_LIMITS, PYTH_RUNTIME_SQL, resetRecoveredPythLocks, restoreArchivedPythState, validatePythRuntimeSchema, verifyArchivedPythState, verifyPythRuntimeState, verifyPythStateContinuity } from "../src/pyth/recovery-state";

const NOW=1788681600000,PUBLISHER="a".repeat(64),stores:Store[]=[];
afterEach(()=>{for(const store of stores.splice(0))store.close();});
function store() {const value=new Store(":memory:");stores.push(value);return value;}
function fixture() {
  const journal=store();journal.db.exec(PYTH_RUNTIME_SQL);
  journal.db.query("INSERT INTO pyth_submission_state VALUES(?,?,?,?,?,?,?)").run(PUBLISHER,1,NOW*1000,NOW*1000,"request-1","QUEUED_LOCAL",NOW);
  journal.db.query("INSERT INTO pyth_submission_state VALUES(?,?,?,?,?,?,?)").run(PUBLISHER,2,NOW*1000,0,"request-2","DELIVERY_UNCONFIRMED",NOW);
  journal.db.query("INSERT INTO pyth_queue_receipts VALUES(?,?,?,?)").run("request-1","b".repeat(64),NOW,JSON.stringify([{feedId:1,sourceTimestamp:NOW*1000}]));
  journal.db.query("INSERT INTO pyth_runtime_locks VALUES(?,?,?)").run(PUBLISHER,randomUUID(),NOW+30000);
  return journal;
}
test("old journals without Pyth state remain compatible",()=>{
  const journal=store();expect(verifyPythRuntimeState(journal.db,NOW)).toEqual({present:false,states:0,receipts:0,locks:0,upstreamPublication:"NOT_PROVEN"});
  expect(archivePythRuntimeState(journal,NOW)).toBeUndefined();resetRecoveredPythLocks(journal.db);
});
test("versioned state restores exact high-waters and original receipts, but no live process locks",()=>{
  const journal=fixture(),states=journal.db.query("SELECT * FROM pyth_submission_state ORDER BY feed_id").all(),receipts=journal.db.query("SELECT * FROM pyth_queue_receipts").all();
  const root=archivePythRuntimeState(journal,NOW)!;
  expect(validatePythRuntimeSchema(journal.db)).toBe(false);
  expect(verifyArchivedPythState(journal,root,NOW)).toEqual({present:true,states:2,receipts:1,locks:1,upstreamPublication:"NOT_PROVEN"});
  restoreArchivedPythState(journal,root,NOW);
  expect(journal.db.query("SELECT * FROM pyth_submission_state ORDER BY feed_id").all()).toEqual(states);
  expect(journal.db.query("SELECT * FROM pyth_queue_receipts").all()).toEqual(receipts);
  expect(journal.db.query("SELECT * FROM pyth_runtime_locks").all()).toEqual([]);
  expect(verifyPythRuntimeState(journal.db,NOW).states).toBe(2);
  expect(()=>restoreArchivedPythState(journal,root,NOW)).toThrow("RESTORE_REQUIRES_EMPTY_TABLES");
});
test("pending newer attempts, pruned old receipts and old acknowledgements remain valid",()=>{
  const journal=fixture();
  journal.db.query("UPDATE pyth_submission_state SET last_attempted_timestamp=?,last_attempt_id='new-attempt',last_status='DELIVERY_UNCONFIRMED' WHERE feed_id=1").run((NOW+1)*1000);
  expect(verifyPythRuntimeState(journal.db,NOW+1).receipts).toBe(1);
  journal.db.query("DELETE FROM pyth_queue_receipts").run();
  expect(verifyPythRuntimeState(journal.db,NOW+1).states).toBe(2);
});
test.each([
  "UPDATE pyth_submission_state SET last_queued_timestamp=last_attempted_timestamp+1",
  "UPDATE pyth_submission_state SET last_status='PUBLISHED'",
  "UPDATE pyth_submission_state SET feed_id=4294967296 WHERE feed_id=1",
  "UPDATE pyth_submission_state SET updated_at=1.5",
  "UPDATE pyth_submission_state SET publisher='not-a-hash'",
  "UPDATE pyth_submission_state SET last_attempted_timestamp=9007199254740992",
  "UPDATE pyth_submission_state SET last_queued_timestamp=0 WHERE feed_id=1",
  "UPDATE pyth_queue_receipts SET feeds='[]'",
  "UPDATE pyth_queue_receipts SET feeds='[{\"feedId\":1,\"sourceTimestamp\":1},{\"feedId\":1,\"sourceTimestamp\":1}]'",
  "UPDATE pyth_queue_receipts SET feeds='[{\"feedId\":1,\"sourceTimestamp\":1}]'",
  `UPDATE pyth_queue_receipts SET queued_at=${NOW+1}`,
  `UPDATE pyth_runtime_locks SET expires_at=${NOW+60001}`,
])("invalid Pyth runtime state is rejected: %s",sql=>{
  const journal=fixture();journal.db.exec(sql);expect(()=>archivePythRuntimeState(journal,NOW)).toThrow("PYTH_RECOVERY_");
  // Transaction rollback preserves source tables and leaves no partial archive metadata.
  expect(journal.db.query("SELECT name FROM sqlite_master WHERE name='pyth_submission_state'").get()).not.toBeNull();
  expect(journal.db.query("SELECT * FROM configurations").all()).toEqual([]);
});
test.each([
  "DROP TABLE pyth_queue_receipts",
  "ALTER TABLE pyth_submission_state ADD COLUMN unexpected TEXT",
  "CREATE TRIGGER pyth_secret_trigger AFTER INSERT ON pyth_submission_state BEGIN SELECT 1; END",
  "CREATE VIEW pyth_unknown AS SELECT * FROM pyth_submission_state",
  "CREATE TABLE pyth_unreviewed (value TEXT)",
  "CREATE INDEX pyth_unreviewed_index ON pyth_submission_state(last_status)",
  "DROP TABLE pyth_runtime_locks; CREATE TABLE pyth_runtime_locks (id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>0))",
  "DROP TABLE pyth_runtime_locks; CREATE TABLE pyth_runtime_locks (id TEXT PRIMARY KEY REFERENCES pyth_submission_state(publisher), owner TEXT NOT NULL, expires_at INTEGER NOT NULL)",
])("unreviewed runtime schemas cannot enter recovery: %s",sql=>{
  const journal=fixture();journal.db.exec(sql);expect(()=>verifyPythRuntimeState(journal.db,NOW)).toThrow("SCHEMA_REVIEW_REQUIRED");
});
test("oversized rows are rejected before decoding payloads",()=>{
  const journal=fixture();journal.db.query("UPDATE pyth_queue_receipts SET feeds=?").run("x".repeat(PYTH_RECOVERY_LIMITS.rowBytes));
  expect(()=>archivePythRuntimeState(journal,NOW)).toThrow("ROW_TOO_LARGE");
});
test("duplicate and missing root references are rejected independently of archive transport",()=>{
  const journal=fixture(),root=archivePythRuntimeState(journal,NOW)!,value=journal.configuration(root) as {format:string;rows:string[]};
  const duplicate=journal.saveConfiguration({...value,rows:[...value.rows,value.rows[0]!]});
  expect(()=>verifyArchivedPythState(journal,duplicate,NOW)).toThrow("DUPLICATE_ROW");
  const missing=journal.saveConfiguration({...value,rows:["f".repeat(64)]});
  expect(()=>verifyArchivedPythState(journal,missing,NOW)).toThrow("CONFIGURATION_MISSING");
  const reversed=journal.saveConfiguration({...value,rows:[...value.rows].reverse()});
  expect(()=>verifyArchivedPythState(journal,reversed,NOW)).toThrow("TABLE_ORDER");
  journal.db.query("UPDATE configurations SET payload=? WHERE hash=?").run(canonical({...value,rows:[]}),root);
  expect(()=>verifyArchivedPythState(journal,root,NOW)).toThrow("HASH_MISMATCH");
});
test.each(["missing-row","attempt-rollback","queued-rollback","missing-root"])("signed inherited high-water floors reject %s",change=>{
  const journal=fixture(),prior=archivePythRuntimeState(journal,NOW)!;restoreArchivedPythState(journal,prior,NOW);
  if(change==="missing-row")journal.db.query("DELETE FROM pyth_submission_state WHERE feed_id=2").run();
  if(change==="attempt-rollback")journal.db.query("UPDATE pyth_submission_state SET last_attempted_timestamp=last_attempted_timestamp-1 WHERE feed_id=2").run();
  if(change==="queued-rollback") {
    journal.db.query("DELETE FROM pyth_queue_receipts").run();
    journal.db.query("UPDATE pyth_submission_state SET last_queued_timestamp=0,last_status='DELIVERY_UNCONFIRMED' WHERE feed_id=1").run();
  }
  const current=change==="missing-root"?undefined:archivePythRuntimeState(journal,NOW);
  expect(()=>verifyPythStateContinuity(journal,current,prior,NOW)).toThrow("INHERITED_");
});
test("inherited continuity permits genuinely advancing attempts and bounded receipt pruning",()=>{
  const journal=fixture(),prior=archivePythRuntimeState(journal,NOW)!;restoreArchivedPythState(journal,prior,NOW);
  journal.db.query("UPDATE pyth_submission_state SET last_attempted_timestamp=last_attempted_timestamp+1000,last_attempt_id='new',last_status='DELIVERY_UNCONFIRMED'").run();
  journal.db.query("DELETE FROM pyth_queue_receipts").run();
  const current=archivePythRuntimeState(journal,NOW+1)!;
  expect(verifyPythStateContinuity(journal,current,prior,NOW+1).states).toBe(2);
});
test("the bounded full high-water inventory round-trips and excess rows fail before export",()=>{
  const journal=store();journal.db.exec(PYTH_RUNTIME_SQL);
  const insert=journal.db.query("INSERT INTO pyth_submission_state VALUES(?,?,?,?,?,?,?)");
  journal.db.transaction(()=>{for(let id=1;id<=PYTH_RECOVERY_LIMITS.states;id++)insert.run(PUBLISHER,id,NOW*1000,0,`attempt-${id}`,"DELIVERY_UNCONFIRMED",NOW);})();
  const root=archivePythRuntimeState(journal,NOW)!;expect(verifyArchivedPythState(journal,root,NOW).states).toBe(PYTH_RECOVERY_LIMITS.states);
  restoreArchivedPythState(journal,root,NOW);
  insert.run(PUBLISHER,PYTH_RECOVERY_LIMITS.states+1,NOW*1000,0,"overflow","DELIVERY_UNCONFIRMED",NOW);
  expect(()=>archivePythRuntimeState(journal,NOW)).toThrow("CAPACITY");
},30000);
