import { createHash } from "node:crypto";
import { canonical, hash, verifyBatch } from "./crypto";
import type { EvidenceRecord, Observation, SignedBatch, Snapshot } from "./types";
import { signedBatchSchema } from "./validation";
import { ARCHIVE_TABLES } from "./archive-protocol";

export const JOURNAL_LIMITS = Object.freeze({
  candidateIdentities: 512, candidateBytes: 256 * 1024, candidatesTotalBytes: 16 * 1024 * 1024,
  reportBytes: 512 * 1024, reportRows: 500_000,
  proofRows: 1024, proofsTotalBytes: 128 * 1024 * 1024, proofPageBytes: 6_000_000, proofPageRows: 32,
});
export interface EquivocationProof { first: SignedBatch; second: SignedBatch }
export interface EquivocationRecord extends EquivocationProof { sequence: number; detectedAt: number }
export interface EquivocationPage { proofs: EquivocationRecord[]; hasMore: boolean; nextAfter: number | null }

/** Signatures, not a peer's accusation, must prove two different statements at one nonce. */
export function validateEquivocationProof(proof: EquivocationProof): void {
  const first = signedBatchSchema.parse(proof.first) as SignedBatch, second = signedBatchSchema.parse(proof.second) as SignedBatch;
  if (!verifyBatch(first) || !verifyBatch(second)) throw new Error("INVALID_EQUIVOCATION_SIGNATURE");
  const a = first.payload, b = second.payload;
  if (a.nodeId !== b.nodeId || a.publicKey !== b.publicKey || a.network !== b.network || a.sequence !== b.sequence || hash(a) === hash(b)) throw new Error("INVALID_EQUIVOCATION_PAIR");
  if (Buffer.byteLength(canonical(first)) > JOURNAL_LIMITS.reportBytes || Buffer.byteLength(canonical(second)) > JOURNAL_LIMITS.reportBytes) throw new Error("EQUIVOCATION_PROOF_TOO_LARGE");
}

export interface SqlStatement {
  run(...values:unknown[]):unknown;
  get(...values:unknown[]):unknown;
  all(...values:unknown[]):unknown[];
  iterate(...values:unknown[]):Iterable<unknown>;
}
export interface SqlDriver {
  exec(sql:string):unknown;
  query(sql:string):SqlStatement;
  transaction<T>(fn:()=>T):()=>T;
  close():void;
}
const immutableNames=ARCHIVE_TABLES.filter(table=>!table.mutable).map(table=>table.name).join("|");
const immutableSqlName=`(?:(?:main|"main")\\s*\\.\\s*)?["\x60\\[]?(?:${immutableNames})\\b`;
const immutableMutation=new RegExp(`\\b(?:UPDATE(?:\\s+OR\\s+(?:ROLLBACK|ABORT|REPLACE|FAIL|IGNORE))?|DELETE\\s+FROM|REPLACE\\s+INTO|INSERT\\s+OR\\s+REPLACE\\s+INTO|DROP\\s+TABLE(?:\\s+IF\\s+EXISTS)?|ALTER\\s+TABLE)\\s+${immutableSqlName}`,"i");
const immutableUpsert=new RegExp(`\\bINSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+${immutableSqlName}[\\s\\S]*\\bDO\\s+UPDATE\\b`,"i");
function immutableWrite(sql:string):boolean {
  // SQL text is application-owned. Compute once per prepared statement, never per row.
  return /\b(?:UPDATE|DELETE|REPLACE|DROP|ALTER)\b/i.test(sql)&&(immutableMutation.test(sql)||immutableUpsert.test(sql));
}
/** Shared journal for Bun SQLite and Durable Object SQLite drivers. */
export class Journal {
  readonly db: SqlDriver;
  private archiveRegistration = false;
  constructor(database:SqlDriver) {
    // Reviewed application write boundary, not an SQL authorization boundary. The raw
    // runtime/database handle must not be used to mutate a checkpoint-enabled journal.
    const guard=(forbidden:boolean)=>{if(this.archiveRegistration&&forbidden)throw new Error("ARCHIVE_IMMUTABLE_MUTATION_REJECTED");};
    this.db={exec:sql=>{guard(immutableWrite(sql));return database.exec(sql);},query:sql=>{
      const forbidden=immutableWrite(sql),statement=database.query(sql);return {run:(...values)=>{guard(forbidden);return statement.run(...values);},get:(...values)=>{guard(forbidden);return statement.get(...values);},all:(...values)=>{guard(forbidden);return statement.all(...values);},iterate:(...values)=>{guard(forbidden);return statement.iterate(...values);}};
    },transaction:fn=>database.transaction(fn),close:()=>database.close()};
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS counters (id TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS reports (hash TEXT PRIMARY KEY, node_id TEXT NOT NULL, sequence INTEGER NOT NULL, received_at INTEGER NOT NULL, payload TEXT NOT NULL, UNIQUE(node_id, sequence));
      CREATE INDEX IF NOT EXISTS report_node ON reports(node_id,sequence);
      CREATE TABLE IF NOT EXISTS candidates (node_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, received_at INTEGER NOT NULL, hash TEXT NOT NULL, payload TEXT NOT NULL, payload_bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS equivocations (node_id TEXT PRIMARY KEY, detected_at INTEGER NOT NULL, conflicting_payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS equivocation_proofs (id INTEGER PRIMARY KEY, node_id TEXT UNIQUE NOT NULL, detected_at INTEGER NOT NULL, first_payload TEXT NOT NULL, second_payload TEXT NOT NULL, payload_bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS evidence (hash TEXT PRIMARY KEY, source TEXT NOT NULL, url TEXT NOT NULL, received_at INTEGER NOT NULL, content_type TEXT NOT NULL, body BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS captures (id INTEGER PRIMARY KEY, collected_at INTEGER NOT NULL, observations TEXT NOT NULL, errors TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY, calculated_at INTEGER NOT NULL, hash TEXT UNIQUE NOT NULL, previous_hash TEXT, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS configurations (hash TEXT PRIMARY KEY, payload TEXT NOT NULL);
    `);
  }
  /** Called only after the versioned membership migration is complete. */
  enableArchiveRegistration():void {this.archiveRegistration=true;}
  /** Must share the surrounding immutable INSERT transaction, including exclusions. */
  registerArchiveRow(tableName:string,keyText:string,keyInteger:number):void {
    if(!this.archiveRegistration)return;
    const table=ARCHIVE_TABLES.find(table=>table.name===tableName);
    if(!table||table.mutable||!Number.isSafeInteger(keyInteger)||keyInteger<0)throw new Error("ARCHIVE_MEMBERSHIP_KEY_INVALID");
    this.db.query("INSERT OR IGNORE INTO archive_entries(table_code,key_text,key_integer) VALUES(?,?,?)").run(table.code,keyText,keyInteger);
  }
  close(): void { this.db.close(); }
  nextSequence(nodeId: string): number {
    return this.db.transaction(() => {
      this.db.query("INSERT INTO counters(id,value) VALUES(?,1) ON CONFLICT(id) DO UPDATE SET value=value+1").run(nodeId);
      return (this.db.query("SELECT value FROM counters WHERE id=?").get(nodeId) as {value:number}).value;
    })();
  }
  accept(batch: SignedBatch, now: number, trusted: boolean): "ACCEPTED" | "DUPLICATE" {
    signedBatchSchema.parse(batch);
    if (!verifyBatch(batch)) throw new Error("INVALID_SIGNATURE");
    const serialized = canonical(batch), bytes = Buffer.byteLength(serialized), p = batch.payload;
    const digest = createHash("sha256").update(serialized).digest("hex");
    if (bytes > (trusted ? JOURNAL_LIMITS.reportBytes : JOURNAL_LIMITS.candidateBytes)) throw new Error(trusted ? "REPORT_TOO_LARGE" : "CANDIDATE_TOO_LARGE");
    // Persist signed conflict evidence outside the acceptance transaction so a throw cannot roll it back.
    const existing = this.db.query("SELECT payload FROM reports WHERE node_id=? AND sequence=?").get(p.nodeId,p.sequence) as {payload:string}|null;
    if(existing && hash((JSON.parse(existing.payload) as SignedBatch).payload)!==hash(p)) {
      this.recordEquivocation({first:JSON.parse(existing.payload) as SignedBatch,second:batch},now);
      throw new Error("EQUIVOCATION");
    }
    const pending = this.db.query("SELECT sequence,payload FROM candidates WHERE node_id=?").get(p.nodeId) as {sequence:number;payload:string}|null;
    if(pending?.sequence===p.sequence && hash((JSON.parse(pending.payload) as SignedBatch).payload)!==hash(p)) {
      if(trusted) this.recordEquivocation({first:JSON.parse(pending.payload) as SignedBatch,second:batch},now);
      throw new Error("CANDIDATE_EQUIVOCATION");
    }
    if(this.db.query("SELECT node_id FROM equivocations WHERE node_id=?").get(p.nodeId)) throw new Error("OPERATOR_QUARANTINED_FOR_EQUIVOCATION");
    return this.db.transaction(() => {
      const previous = this.db.query("SELECT MAX(sequence) AS sequence FROM reports WHERE node_id=?").get(p.nodeId) as {sequence:number|null};
      const candidate = this.db.query("SELECT sequence,payload,payload_bytes FROM candidates WHERE node_id=?").get(p.nodeId) as {sequence:number;payload:string;payload_bytes:number}|null;
      const maximum = Math.max(previous.sequence ?? 0,candidate?.sequence ?? 0);
      if (p.sequence < maximum) throw new Error("REPLAY");
      if (candidate?.sequence === p.sequence && hash((JSON.parse(candidate.payload) as SignedBatch).payload) !== hash(p)) throw new Error("CANDIDATE_EQUIVOCATION");
      if (existing) return "DUPLICATE";
      if (!trusted) {
        if(candidate?.sequence === p.sequence) return "DUPLICATE";
        const usage = this.candidateUsage();
        if(!candidate && usage.identities >= JOURNAL_LIMITS.candidateIdentities) throw new Error("CANDIDATE_CAPACITY");
        if(usage.bytes - (candidate?.payload_bytes ?? 0) + bytes > JOURNAL_LIMITS.candidatesTotalBytes) throw new Error("CANDIDATE_BYTE_CAPACITY");
        this.db.query("INSERT INTO candidates(node_id,sequence,received_at,hash,payload,payload_bytes) VALUES(?,?,?,?,?,?) ON CONFLICT(node_id) DO UPDATE SET sequence=excluded.sequence,received_at=excluded.received_at,hash=excluded.hash,payload=excluded.payload,payload_bytes=excluded.payload_bytes").run(p.nodeId,p.sequence,now,digest,serialized,bytes);
        return "ACCEPTED";
      }
      const count = this.db.query("SELECT COUNT(*) AS count FROM reports").get() as {count:number};
      if (count.count >= JOURNAL_LIMITS.reportRows) throw new Error("JOURNAL_CAPACITY_ARCHIVE_REQUIRED");
      this.db.query("INSERT INTO reports(hash,node_id,sequence,received_at,payload) VALUES(?,?,?,?,?)").run(digest,p.nodeId,p.sequence,now,serialized);
      this.registerArchiveRow("reports",digest,0);
      // Admission never resets the candidate's nonce, and its old observations do not enter historical replay.
      this.db.query("DELETE FROM candidates WHERE node_id=?").run(p.nodeId);
      return "ACCEPTED";
    })();
  }
  candidateUsage(): {identities:number;bytes:number} {
    return this.db.query("SELECT COUNT(*) AS identities,COALESCE(SUM(payload_bytes),0) AS bytes FROM candidates").get() as {identities:number;bytes:number};
  }
  /** The caller may use its own candidate for submission, never as an index vote. */
  latestReport(nodeId:string): SignedBatch|null {
    if(this.db.query("SELECT node_id FROM equivocations WHERE node_id=?").get(nodeId)) return null;
    const row=this.db.query("SELECT payload FROM (SELECT payload,sequence FROM reports WHERE node_id=? UNION ALL SELECT payload,sequence FROM candidates WHERE node_id=?) ORDER BY sequence DESC LIMIT 1").get(nodeId,nodeId) as {payload:string}|null;
    return row ? JSON.parse(row.payload) as SignedBatch : null;
  }
  recordEquivocation(proof:EquivocationProof,now:number): "RECORDED"|"DUPLICATE" {
    validateEquivocationProof(proof);
    if(!Number.isSafeInteger(now)||now<=0) throw new Error("INVALID_PROOF_RECEIPT_TIME");
    const p=proof.first.payload;
    // Exclusion remains durable even when the bounded full-proof archive needs operator attention.
    this.db.transaction(()=>{
      this.db.query("INSERT OR IGNORE INTO equivocations(node_id,detected_at,conflicting_payload) VALUES(?,?,?)").run(p.nodeId,now,canonical({sequence:p.sequence,first:hash(proof.first),second:hash(proof.second)}));
      this.registerArchiveRow("equivocations",p.nodeId,0);
    })();
    return this.db.transaction(()=>{
      if(this.db.query("SELECT id FROM equivocation_proofs WHERE node_id=?").get(p.nodeId)) return "DUPLICATE";
      const first=canonical(proof.first),second=canonical(proof.second),bytes=Buffer.byteLength(first)+Buffer.byteLength(second);
      const usage=this.db.query("SELECT COUNT(*) AS count,COALESCE(SUM(payload_bytes),0) AS bytes FROM equivocation_proofs").get() as {count:number;bytes:number};
      if(usage.count>=JOURNAL_LIMITS.proofRows||usage.bytes+bytes>JOURNAL_LIMITS.proofsTotalBytes) throw new Error("EQUIVOCATION_PROOF_CAPACITY_ARCHIVE_REQUIRED");
      this.db.query("INSERT INTO equivocation_proofs(node_id,detected_at,first_payload,second_payload,payload_bytes) VALUES(?,?,?,?,?)").run(p.nodeId,now,first,second,bytes);
      this.registerArchiveRow("equivocation_proofs","",(this.db.query("SELECT id FROM equivocation_proofs WHERE node_id=?").get(p.nodeId) as {id:number}).id);
      return "RECORDED";
    })();
  }
  equivocationPage(after=0,limit:number=JOURNAL_LIMITS.proofPageRows): EquivocationPage {
    if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>JOURNAL_LIMITS.proofPageRows) throw new Error("INVALID_PROOF_PAGINATION");
    // Select small row headers first, then load only the payloads that fit the response budget.
    // This also avoids leaving a partially consumed cached Bun SQLite statement active.
    const proofs:EquivocationRecord[]=[],rows=this.db.query("SELECT id,payload_bytes FROM equivocation_proofs WHERE id>? ORDER BY id LIMIT ?").all(after,limit+1) as Array<{id:number;payload_bytes:number}>;
    let bytes=0,hasMore=false;
    for(const row of rows) {
      if(proofs.length===limit||bytes+row.payload_bytes>JOURNAL_LIMITS.proofPageBytes) {hasMore=true;break;}
      const payload=this.db.query("SELECT detected_at,first_payload,second_payload FROM equivocation_proofs WHERE id=?").get(row.id) as {detected_at:number;first_payload:string;second_payload:string};
      proofs.push({sequence:row.id,detectedAt:payload.detected_at,first:JSON.parse(payload.first_payload) as SignedBatch,second:JSON.parse(payload.second_payload) as SignedBatch});bytes+=row.payload_bytes;
    }
    return {proofs,hasMore,nextAfter:proofs.at(-1)?.sequence??null};
  }
  latestReports(limit=1000): SignedBatch[] {
    const rows = this.db.query("SELECT r.payload FROM reports r JOIN (SELECT node_id,MAX(sequence) AS seq FROM reports GROUP BY node_id) l ON r.node_id=l.node_id AND r.sequence=l.seq WHERE r.node_id NOT IN (SELECT node_id FROM equivocations) ORDER BY r.node_id LIMIT ?").all(limit) as {payload:string}[];
    return rows.map(r=>JSON.parse(r.payload) as SignedBatch);
  }
  reportsAt(at: number): SignedBatch[] {
    const rows = this.db.query("SELECT r.payload FROM reports r JOIN (SELECT node_id,MAX(sequence) AS seq FROM reports WHERE received_at<=? GROUP BY node_id) l ON r.node_id=l.node_id AND r.sequence=l.seq WHERE r.node_id NOT IN (SELECT node_id FROM equivocations WHERE detected_at<=?) ORDER BY r.node_id").all(at,at) as {payload:string}[];
    return rows.map(r=>JSON.parse(r.payload) as SignedBatch);
  }
  async archive(record: EvidenceRecord): Promise<void> {
    if (createHash("sha256").update(record.body).digest("hex") !== record.hash) throw new Error("Evidence digest mismatch");
    this.db.transaction(()=>{
      this.db.query("INSERT OR IGNORE INTO evidence(hash,source,url,received_at,content_type,body) VALUES(?,?,?,?,?,?)").run(record.hash,record.source,record.url,record.receivedAt,record.contentType,record.body);
      this.registerArchiveRow("evidence",record.hash,0);
    })();
  }
  capture(observations: Observation[], errors: string[], now: number): void {
    this.db.transaction(()=>{
      this.db.query("INSERT INTO captures(collected_at,observations,errors) VALUES(?,?,?)").run(now,canonical(observations),canonical(errors));
      this.registerArchiveRow("captures","",(this.db.query("SELECT last_insert_rowid() AS id").get() as {id:number}).id);
    })();
  }
  snapshot(snapshot: Snapshot): string {
    return this.db.transaction(() => {
      const previous = this.db.query("SELECT hash FROM snapshots ORDER BY id DESC LIMIT 1").get() as {hash:string}|null;
      const digest = hash({ previousHash: previous?.hash ?? null, snapshot });
      this.db.query("INSERT INTO snapshots(calculated_at,hash,previous_hash,payload) VALUES(?,?,?,?)").run(snapshot.calculatedAt,digest,previous?.hash ?? null,canonical(snapshot));
      this.registerArchiveRow("snapshots","",(this.db.query("SELECT id FROM snapshots WHERE hash=?").get(digest) as {id:number}).id);
      return digest;
    })();
  }
  saveConfiguration(value:unknown):string {
    const payload=canonical(value),digest=hash(value);
    if(Buffer.byteLength(payload)>1_000_000) throw new Error("CONFIGURATION_TOO_LARGE");
    this.db.transaction(()=>{
      this.db.query("INSERT OR IGNORE INTO configurations(hash,payload) VALUES(?,?)").run(digest,payload);
      this.registerArchiveRow("configurations",digest,0);
    })();
    return digest;
  }
  configuration(digest:string):unknown|null {
    if(!/^[a-f0-9]{64}$/.test(digest)) throw new Error("INVALID_CONFIGURATION_HASH");
    const row=this.db.query("SELECT payload FROM configurations WHERE hash=?").get(digest) as {payload:string}|null;
    if(!row)return null;
    const value:unknown=JSON.parse(row.payload);
    if(hash(value)!==digest)throw new Error("CONFIGURATION_HASH_MISMATCH");
    return value;
  }
  getSnapshot(sequence:number):Snapshot|null {
    if(!Number.isSafeInteger(sequence)||sequence<1) throw new Error("INVALID_SNAPSHOT_SEQUENCE");
    const row=this.db.query("SELECT payload FROM snapshots WHERE id=?").get(sequence) as {payload:string}|null;
    return row ? JSON.parse(row.payload) as Snapshot : null;
  }
  captureCounts():{count:number;earliest:number|null;latest:number|null} {
    return this.db.query("SELECT COUNT(*) AS count,MIN(collected_at) AS earliest,MAX(collected_at) AS latest FROM captures").get() as {count:number;earliest:number|null;latest:number|null};
  }
  history(after: number, limit: number): { records: unknown[]; hasMore: boolean; nextAfter: number|null } {
    const rows = this.db.query("SELECT id,hash,previous_hash,payload FROM snapshots WHERE id>? ORDER BY id LIMIT ?").all(after,limit+1) as {id:number;hash:string;previous_hash:string|null;payload:string}[];
    const records = rows.slice(0,limit).map(r=>({sequence:r.id,hash:r.hash,previousHash:r.previous_hash,snapshot:JSON.parse(r.payload) as Snapshot}));
    return { records, hasMore:rows.length>limit, nextAfter:records.at(-1)?.sequence ?? null };
  }
  counts(): Record<string,number> {
    const counts=Object.fromEntries(["reports","candidates","equivocations","equivocation_proofs","evidence","captures","snapshots","configurations"].map(table => [table,(this.db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as {count:number}).count]));
    counts.candidateBytes=this.candidateUsage().bytes;
    counts.proofBytes=(this.db.query("SELECT COALESCE(SUM(payload_bytes),0) AS bytes FROM equivocation_proofs").get() as {bytes:number}).bytes;
    return counts;
  }
  verifyHistory(): { valid: boolean; count: number; error?: string } {
    let previous: string|null=null, count=0;
    for (const row of this.db.query("SELECT hash,previous_hash,payload FROM snapshots ORDER BY id").iterate() as Iterable<{hash:string;previous_hash:string|null;payload:string}>) {
      if (row.previous_hash !== previous || hash({previousHash:previous,snapshot:JSON.parse(row.payload)}) !== row.hash) return {valid:false,count,error:"HISTORY_HASH_MISMATCH"};
      previous=row.hash; count++;
    }
    return {valid:true,count};
  }
}
