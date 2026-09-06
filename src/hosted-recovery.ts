/** Convert a verified hosted snapshot into the existing encrypted, new-identity recovery format. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { collectorSchedule } from "./collection-control";
import { CloudflareJournal } from "./cloudflare/sql";
import { canonical } from "./crypto";
import { HOSTED_TABLES, parseHostedExport } from "./hosted-export";
import { backupNode } from "./recovery";
import { Store } from "./store";
import { observationSchema } from "./validation";
import type { Observation } from "./types";

const sha256=(value:Uint8Array|string)=>createHash("sha256").update(value).digest("hex");
function privateJson(path:string,value:unknown):void {writeFileSync(path,canonical(value),{mode:0o600,flag:"wx"});}

export async function backupHostedExport(encoded:string,outputPath:string,keyPath:string,expectedNodeId:string,expectedRelease:string,options:{signal?:AbortSignal}={}) {
  options.signal?.throwIfAborted();
  if(existsSync(outputPath))throw new Error("Recovery output already exists");
  const envelope=parseHostedExport(encoded,expectedNodeId,expectedRelease),{payload}=envelope;
  const directory=mkdtempSync(join(tmpdir(),"sbx-hosted-recovery-"));
  let store:Store|undefined;
  try {
    // Give a graceful process signal a cancellation point before opening the private journal.
    await setImmediate();options.signal?.throwIfAborted();
    mkdirSync(join(directory,"data"),{mode:0o700});mkdirSync(join(directory,"config"),{mode:0o700});
    store=new Store(join(directory,"data/node.sqlite"));
    const journal=new CloudflareJournal(store.db);
    collectorSchedule(store,"hosted-export",payload.exportedAt); // Initialize the known schedule schema, without a row.
    store.db.transaction(()=>{
      for(const [index,table] of payload.tables.entries()) {
        const expected=HOSTED_TABLES[index]!;
        const insert=store!.db.query(`INSERT INTO ${expected.name}(${expected.columns.join(",")}) VALUES(${expected.columns.map(()=>"?").join(",")})`);
        for(const row of table.rows)insert.run(...row.map(value=>typeof value==="object"&&value!==null?Buffer.from(value.base64,"base64"):value));
      }
      const evidence=store!.db.query("SELECT hash,body FROM evidence ORDER BY hash").all() as {hash:string;body:Uint8Array}[];
      const evidenceHashes=new Set(evidence.map(record=>record.hash));
      const sizes=store!.db.query("SELECT hash,bytes,parts FROM evidence_sizes ORDER BY hash").all() as {hash:string;bytes:number;parts:number}[];
      if(evidence.length!==sizes.length)throw new Error("HOSTED_EVIDENCE_METADATA_MISMATCH");
      const orphan=store!.db.query("SELECT COUNT(*) AS count FROM evidence_chunks LEFT JOIN evidence ON evidence_chunks.hash=evidence.hash WHERE evidence.hash IS NULL").get() as {count:number};
      if(orphan.count)throw new Error("HOSTED_EVIDENCE_ORPHAN_CHUNKS");
      for(const [index,record] of evidence.entries()) {
        const size=sizes[index]!;
        if(record.body.length!==0||size.hash!==record.hash||size.bytes<0||size.parts!==Math.ceil(size.bytes/(512*1024)))throw new Error("HOSTED_EVIDENCE_METADATA_MISMATCH");
        const chunks=store!.db.query("SELECT part,body FROM evidence_chunks WHERE hash=? ORDER BY part").all(record.hash) as {part:number;body:Uint8Array}[];
        if(chunks.length!==size.parts||chunks.some((chunk,part)=>chunk.part!==part||chunk.body.length!==Math.min(512*1024,size.bytes-part*512*1024)))throw new Error("HOSTED_EVIDENCE_CHUNK_MISMATCH");
        const body=journal.evidenceBody(record.hash);
        if(!body)throw new Error("HOSTED_EVIDENCE_MISSING");
        store!.db.query("UPDATE evidence SET body=? WHERE hash=?").run(body,record.hash);
      }
      // Restore a standard Bun journal: merge storage batches into their exact original cycles.
      const cycles=store!.db.query("SELECT id,collected_at FROM collection_captures ORDER BY id").all() as {id:number;collected_at:number}[];
      const captures=store!.db.query("SELECT id,collected_at,observations,errors FROM captures ORDER BY id").all() as {id:number;collected_at:number;observations:string;errors:string}[];
      const times=new Set<number>(),byTime=new Map<number,typeof captures>();
      for(const cycle of cycles) {
        if(!Number.isSafeInteger(cycle.id)||!Number.isSafeInteger(cycle.collected_at)||cycle.id<1||cycle.collected_at<1||cycle.collected_at>payload.exportedAt||times.has(cycle.collected_at))throw new Error("HOSTED_CAPTURE_CYCLE_AMBIGUOUS");
        times.add(cycle.collected_at);
      }
      for(const capture of captures) {
        if(capture.id<1||!times.has(capture.collected_at))throw new Error("HOSTED_CAPTURE_CYCLE_MISSING");
        const group=byTime.get(capture.collected_at)??[];group.push(capture);byTime.set(capture.collected_at,group);
      }
      store!.db.query("DELETE FROM captures").run();
      for(const cycle of cycles) {
        const batches=byTime.get(cycle.collected_at);
        if(!batches?.length)throw new Error("HOSTED_CAPTURE_BATCH_MISSING");
        const items:Observation[]=[],errors:string[]=[];
        for(const batch of batches) {
          const values:unknown=JSON.parse(batch.observations),messages:unknown=JSON.parse(batch.errors);
          if(!Array.isArray(values)||!Array.isArray(messages)||messages.some(message=>typeof message!=="string"))throw new Error("HOSTED_CAPTURE_SCHEMA_MISMATCH");
          for(const value of values) {
            const parsed=observationSchema.safeParse(value);
            if(!parsed.success||parsed.data.observedAt>cycle.collected_at)throw new Error("HOSTED_CAPTURE_OBSERVATION_INVALID");
            if(!evidenceHashes.has(parsed.data.evidenceHash))throw new Error("HOSTED_CAPTURE_EVIDENCE_MISSING");
            items.push(parsed.data as Observation);
          }
          errors.push(...messages as string[]);
        }
        store!.db.query("INSERT INTO captures(id,collected_at,observations,errors) VALUES(?,?,?,?)").run(cycle.id,cycle.collected_at,canonical(items),canonical(errors));
      }
      // Only the newly created temporary materialization is transformed. Hosted storage is never changed.
      store!.db.exec("DROP TABLE evidence_chunks; DROP TABLE evidence_sizes; DROP TABLE collection_captures;");
    })();
    await setImmediate();options.signal?.throwIfAborted();
    const record=Buffer.from(encoded);
    await store.archive({hash:sha256(record),source:"sbx-hosted-export",url:`https://${payload.source.nodeName}.blackwellindex.com/`,receivedAt:payload.exportedAt,
      contentType:"application/vnd.sbx.hosted-journal+json",body:record});
    options.signal?.throwIfAborted();
    store.close();store=undefined;
    privateJson(join(directory,"data/source-identity.json"),{nodeId:payload.source.nodeId,publicKey:payload.source.publicKey});
    privateJson(join(directory,"config/registry.local.json"),payload.configuration.registry);
    privateJson(join(directory,"config/methodology.local.json"),payload.configuration.methodology);
    privateJson(join(directory,"config/node.local.json"),{schemaVersion:1,network:payload.configuration.network,identityPath:"data/source-identity.json",databasePath:"data/node.sqlite",
      registryPath:"config/registry.local.json",methodologyPath:"config/methodology.local.json",host:"127.0.0.1",port:3410,intervalMs:payload.configuration.intervalMs,collectors:[],peers:[],allowLoopbackPeers:false});
    const result=backupNode(directory,join(directory,"config/node.local.json"),outputPath,keyPath);
    return {...result,origin:"CLOUDFLARE_SIGNED_LOGICAL_EXPORT",sourceRelease:payload.source.release,exportedAt:payload.exportedAt,exportEvidenceHash:sha256(record),
      sourceNodeName:payload.source.nodeName,note:"Verified hosted snapshot encrypted locally. Restore requires a new identity and operator review; the running hosted node was not changed."};
  } finally {try{store?.close();}finally{rmSync(directory,{recursive:true,force:true});}}
}
