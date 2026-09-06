import { createHash } from "node:crypto";
import { canonical } from "../crypto";
import { Journal, type SqlDriver, type SqlStatement } from "../journal";
import type { EvidenceRecord, Observation } from "../types";

const CHUNK_BYTES = 512 * 1024;

function binding(value: unknown): SqlStorageValue {
  if (value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice().buffer;
  throw new Error("UNSUPPORTED_SQL_BINDING");
}

/** All cursors are consumed synchronously; transactionSync owns commit/rollback. */
export class DurableSqlDriver implements SqlDriver {
  constructor(readonly storage: DurableObjectStorage) {}
  exec(sql: string): unknown { return this.storage.sql.exec(sql).toArray(); }
  query(sql: string): SqlStatement {
    const execute = (values: unknown[]) => this.storage.sql.exec(sql, ...values.map(binding));
    return {
      run: (...values) => { const cursor = execute(values); cursor.toArray(); return { changes: cursor.rowsWritten }; },
      get: (...values) => execute(values).toArray()[0] ?? null,
      all: (...values) => execute(values).toArray(),
      iterate: (...values) => execute(values),
    };
  }
  transaction<T>(fn: () => T): () => T { return () => this.storage.transactionSync(fn); }
  close(): void { /* Durable Object storage lifetime is runtime-managed. */ }
}

/** Raw evidence stays private. Chunking accommodates Cloudflare's 2 MB row limit. */
export class CloudflareJournal extends Journal {
  constructor(driver: SqlDriver) {
    super(driver);
    this.db.exec("CREATE TABLE IF NOT EXISTS evidence_chunks (hash TEXT NOT NULL, part INTEGER NOT NULL, body BLOB NOT NULL, PRIMARY KEY(hash,part)); CREATE TABLE IF NOT EXISTS evidence_sizes (hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL, parts INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS collection_captures (id INTEGER PRIMARY KEY, collected_at INTEGER NOT NULL)");
  }
  override async archive(record: EvidenceRecord): Promise<void> {
    if (createHash("sha256").update(record.body).digest("hex") !== record.hash) throw new Error("Evidence digest mismatch");
    this.db.transaction(() => {
      if (this.db.query("SELECT hash FROM evidence WHERE hash=?").get(record.hash)) return;
      const parts = Math.ceil(record.body.byteLength / CHUNK_BYTES);
      this.db.query("INSERT INTO evidence(hash,source,url,received_at,content_type,body) VALUES(?,?,?,?,?,?)")
        .run(record.hash, record.source, record.url, record.receivedAt, record.contentType, new Uint8Array());
      for (let part = 0; part < parts; part++) {
        this.db.query("INSERT INTO evidence_chunks(hash,part,body) VALUES(?,?,?)")
          .run(record.hash, part, record.body.subarray(part * CHUNK_BYTES, (part + 1) * CHUNK_BYTES));
      }
      this.db.query("INSERT INTO evidence_sizes(hash,bytes,parts) VALUES(?,?,?)").run(record.hash, record.body.byteLength, parts);
    })();
  }
  /** Operator-side backup tooling may call this; no public evidence route exists. */
  evidenceBody(digest: string): Uint8Array | null {
    const size = this.db.query("SELECT bytes,parts FROM evidence_sizes WHERE hash=?").get(digest) as {bytes:number;parts:number}|null;
    if (!size) return null;
    const body = new Uint8Array(size.bytes);
    const rows = this.db.query("SELECT part,body FROM evidence_chunks WHERE hash=? ORDER BY part").all(digest) as {part:number;body:ArrayBuffer}[];
    if (rows.length !== size.parts) throw new Error("EVIDENCE_CHUNK_MISSING");
    for (const row of rows) body.set(new Uint8Array(row.body), row.part * CHUNK_BYTES);
    if (createHash("sha256").update(body).digest("hex") !== digest) throw new Error("EVIDENCE_HASH_MISMATCH");
    return body;
  }
  override capture(observations: Observation[], errors: string[], now: number): void {
    // A capture row is a bounded batch, not necessarily an entire collection cycle.
    this.db.transaction(() => {
      let batch: Observation[] = [], bytes = 2, first = true;
      for (const observation of observations) {
        const length = Buffer.byteLength(canonical(observation)) + 1;
        if (length > CHUNK_BYTES) throw new Error("CAPTURE_OBSERVATION_TOO_LARGE");
        if (bytes + length > CHUNK_BYTES) {
          super.capture(batch, first ? errors : [], now); first = false; batch = []; bytes = 2;
        }
        batch.push(observation); bytes += length;
      }
      super.capture(batch, first ? errors : [], now);
      this.db.query("INSERT INTO collection_captures(collected_at) VALUES(?)").run(now);
    })();
  }
  override captureCounts(): {count:number;earliest:number|null;latest:number|null} {
    return this.db.query("SELECT COUNT(*) AS count,MIN(collected_at) AS earliest,MAX(collected_at) AS latest FROM collection_captures").get() as {count:number;earliest:number|null;latest:number|null};
  }
  override counts(): Record<string,number> {
    const counts = super.counts();
    return {...counts,captureBatches:counts.captures!,captures:this.captureCounts().count};
  }
}
