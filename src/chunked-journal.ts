import { createHash } from "node:crypto";
import { canonical } from "./crypto";
import { Journal, type SqlDriver } from "./journal";
import type { EvidenceRecord, Observation } from "./types";

export const EVIDENCE_CHUNK_BYTES = 512 * 1024;
export const CHUNKED_JOURNAL_VERSION = "SBX_CHUNKED_JOURNAL_V1";

/** Portable physical representation shared by hosted nodes and reviewed local restores. */
export class ChunkedJournal extends Journal {
  constructor(driver: SqlDriver) {
    super(driver);
    this.db.exec("CREATE TABLE IF NOT EXISTS evidence_chunks (hash TEXT NOT NULL, part INTEGER NOT NULL, body BLOB NOT NULL, PRIMARY KEY(hash,part)); CREATE TABLE IF NOT EXISTS evidence_sizes (hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL, parts INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS collection_captures (id INTEGER PRIMARY KEY, collected_at INTEGER NOT NULL)");
  }
  override async archive(record: EvidenceRecord): Promise<void> {
    if (createHash("sha256").update(record.body).digest("hex") !== record.hash) throw new Error("Evidence digest mismatch");
    this.db.transaction(() => {
      if (this.db.query("SELECT hash FROM evidence WHERE hash=?").get(record.hash)) return;
      const parts = Math.ceil(record.body.byteLength / EVIDENCE_CHUNK_BYTES);
      this.db.query("INSERT INTO evidence(hash,source,url,received_at,content_type,body) VALUES(?,?,?,?,?,?)")
        .run(record.hash, record.source, record.url, record.receivedAt, record.contentType, new Uint8Array());
      this.registerArchiveRow("evidence",record.hash,0);
      for (let part = 0; part < parts; part++) {
        this.db.query("INSERT INTO evidence_chunks(hash,part,body) VALUES(?,?,?)")
          .run(record.hash, part, record.body.subarray(part * EVIDENCE_CHUNK_BYTES, (part + 1) * EVIDENCE_CHUNK_BYTES));
        this.registerArchiveRow("evidence_chunks",record.hash,part);
      }
      this.db.query("INSERT INTO evidence_sizes(hash,bytes,parts) VALUES(?,?,?)").run(record.hash, record.body.byteLength, parts);
      this.registerArchiveRow("evidence_sizes",record.hash,0);
    })();
  }
  /** Incremental verified evidence access; callers must consume to completion. */
  *evidenceParts(digest: string): Generator<Uint8Array> {
    const size = this.db.query("SELECT bytes,parts FROM evidence_sizes WHERE hash=?").get(digest) as {bytes:number;parts:number}|null;
    if (!size || !Number.isSafeInteger(size.bytes) || size.bytes < 0 || size.parts !== Math.ceil(size.bytes / EVIDENCE_CHUNK_BYTES)) throw new Error("EVIDENCE_SIZE_INVALID");
    let part = 0, bytes = 0;
    const hasher = createHash("sha256");
    for (const row of this.db.query("SELECT part,body FROM evidence_chunks WHERE hash=? ORDER BY part").iterate(digest) as Iterable<{part:number;body:ArrayBuffer|Uint8Array}>) {
      const body = row.body instanceof ArrayBuffer ? new Uint8Array(row.body) : row.body;
      if (row.part !== part) throw new Error("EVIDENCE_CHUNK_MISSING");
      if (body.byteLength !== Math.min(EVIDENCE_CHUNK_BYTES, size.bytes - bytes) || part >= size.parts) throw new Error("EVIDENCE_CHUNK_INVALID");
      hasher.update(body); bytes += body.byteLength; part++; yield body;
    }
    if (part !== size.parts || bytes !== size.bytes) throw new Error("EVIDENCE_CHUNK_MISSING");
    if (hasher.digest("hex") !== digest) throw new Error("EVIDENCE_HASH_MISMATCH");
  }
  /** Bounded single-object compatibility access. Recovery uses evidenceParts instead. */
  evidenceBody(digest: string): Uint8Array | null {
    const size = this.db.query("SELECT bytes FROM evidence_sizes WHERE hash=?").get(digest) as {bytes:number}|null;
    if (!size) return null;
    if (!Number.isSafeInteger(size.bytes) || size.bytes < 0 || size.bytes > 32 * 1024 * 1024) throw new Error("EVIDENCE_BODY_REQUIRES_STREAMING");
    const body = new Uint8Array(size.bytes);
    let offset = 0;
    for (const part of this.evidenceParts(digest)) { body.set(part, offset); offset += part.byteLength; }
    return body;
  }
  override capture(observations: Observation[], errors: string[], now: number): void {
    this.db.transaction(() => {
      let batch: Observation[] = [], bytes = 2, first = true;
      for (const observation of observations) {
        const length = Buffer.byteLength(canonical(observation)) + 1;
        if (length > EVIDENCE_CHUNK_BYTES) throw new Error("CAPTURE_OBSERVATION_TOO_LARGE");
        if (bytes + length > EVIDENCE_CHUNK_BYTES) { super.capture(batch, first ? errors : [], now); first = false; batch = []; bytes = 2; }
        batch.push(observation); bytes += length;
      }
      super.capture(batch, first ? errors : [], now);
      this.db.query("INSERT INTO collection_captures(collected_at) VALUES(?)").run(now);
      const cycle=this.db.query("SELECT last_insert_rowid() AS id").get() as {id:number};
      this.registerArchiveRow("collection_captures","",cycle.id);
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
