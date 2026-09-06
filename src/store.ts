import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { Journal, type SqlDriver } from "./journal";
import { ChunkedJournal, CHUNKED_JOURNAL_VERSION } from "./chunked-journal";

export class Store extends Journal {
  private readonly chunked: ChunkedJournal | null;
  constructor(path:string) {
    if(path!==":memory:")mkdirSync(dirname(path),{recursive:true,mode:0o700});
    const database=new Database(path,{create:true,strict:true});
    if(path!==":memory:")chmodSync(path,0o600);
    database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    super(database as unknown as SqlDriver);
    const versionTable=database.query("SELECT name FROM sqlite_master WHERE type='table' AND name='local_journal_storage'").get();
    if(versionTable) {
      try {
        const versions=database.query("SELECT id,version FROM local_journal_storage LIMIT 2").all() as {id:number;version:string}[];
        if(versions.length!==1||versions[0]?.id!==1||versions[0]?.version!==CHUNKED_JOURNAL_VERSION)throw new Error("LOCAL_JOURNAL_STORAGE_REVIEW_REQUIRED");
        for(const table of ["evidence_chunks","evidence_sizes","collection_captures"])if(!database.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))throw new Error("LOCAL_JOURNAL_STORAGE_INCOMPLETE");
        this.chunked=new ChunkedJournal(this.db);
      } catch(error) {database.close();throw error;}
    } else this.chunked=null;
  }
  override archive(...args:Parameters<Journal["archive"]>):ReturnType<Journal["archive"]> {return this.chunked?this.chunked.archive(...args):super.archive(...args);}
  override capture(...args:Parameters<Journal["capture"]>):ReturnType<Journal["capture"]> {return this.chunked?this.chunked.capture(...args):super.capture(...args);}
  override counts():Record<string,number> {return this.chunked?this.chunked.counts():super.counts();}
  override captureCounts():ReturnType<Journal["captureCounts"]> {return this.chunked?this.chunked.captureCounts():super.captureCounts();}
}
