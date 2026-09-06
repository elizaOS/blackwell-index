import type { SqlDriver, SqlStatement } from "../journal";
export { ChunkedJournal as CloudflareJournal } from "../chunked-journal";

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
