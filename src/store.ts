import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { Journal, type SqlDriver } from "./journal";

export class Store extends Journal {
  constructor(path:string) {
    if(path!==":memory:")mkdirSync(dirname(path),{recursive:true,mode:0o700});
    const database=new Database(path,{create:true,strict:true});
    if(path!==":memory:")chmodSync(path,0o600);
    database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    super(database as unknown as SqlDriver);
  }
}
