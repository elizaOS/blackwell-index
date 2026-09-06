// Synthetic in-memory recovery chains only. No provider, signer or network access.
import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ARCHIVE_TABLES, archiveDescriptorHash, signArchiveDescriptor, signArchiveSeal, type ArchiveDescriptor } from "../src/archive-protocol";
import { ChunkedJournal } from "../src/chunked-journal";
import { collectorSchedule } from "../src/collection-control";
import { hash } from "../src/crypto";
import { RECOVERY_PROVENANCE_FORMAT } from "../src/local-backup-metadata";
import { archivePythRuntimeState, PYTH_RUNTIME_SQL } from "../src/pyth/recovery-state";
import { Store } from "../src/store";
import { verifyStreamDatabase } from "../src/stream-recovery";
import { environment, NOW } from "./helpers";

const RELEASE="ab".repeat(20),PUBLISHER="a".repeat(64),stores:Store[]=[];
afterEach(()=>{for(const store of stores.splice(0))store.close();});
function fixture() {
  const store=new Store(":memory:");stores.push(store);
  const journal=new ChunkedJournal(store.db),e=environment(),identity=e.identities[0]!;
  journal.saveConfiguration(e.registry);journal.saveConfiguration(e.methodology);
  collectorSchedule(journal,"isolated-recovery-chain",NOW);
  const options={expectedNodeId:identity.nodeId,expectedRelease:RELEASE};
  function root(amount:number,updatedAt=NOW):string {
    journal.db.exec(PYTH_RUNTIME_SQL);
    journal.db.query("INSERT INTO pyth_submission_state VALUES(?,?,?,?,?,?,?)").run(PUBLISHER,1,NOW*1000+amount,0,`attempt-${amount}`,"DELIVERY_UNCONFIRMED",updatedAt);
    return archivePythRuntimeState(journal,updatedAt)!;
  }
  function descriptor(createdAt:number,parent?:string,pythStateHash?:string):ArchiveDescriptor {
    return signArchiveDescriptor({format:"SBX_CHECKPOINT_V2",checkpointId:randomUUID(),createdAt,expiresAt:createdAt+60_000,
      source:{nodeId:identity.nodeId,publicKey:identity.publicKey,nodeName:"local",operatorGroup:"isolated-recovery-chain",release:RELEASE},
      configuration:{network:e.registry.network,intervalMs:300000,registryHash:hash(e.registry),methodologyHash:hash(e.methodology)},
      cutoff:0,counts:ARCHIVE_TABLES.map(table=>(journal.db.query(`SELECT COUNT(*) AS count FROM ${table.name}`).get() as {count:number}).count),snapshotHead:null,
      ...(parent===undefined?{}:{recoveryProvenanceHash:parent}),...(pythStateHash===undefined?{}:{pythStateHash})},identity);
  }
  function receipt(source:ArchiveDescriptor):string {
    return journal.saveConfiguration({format:RECOVERY_PROVENANCE_FORMAT,descriptor:source,
      seal:signArchiveSeal({format:"SBX_CHECKPOINT_SEAL_V2",checkpointId:source.payload.checkpointId,descriptorHash:archiveDescriptorHash(source),
        blockCount:0,totalBytes:0,counts:source.payload.counts,finalHash:null},source,identity),archiveSha256:"c".repeat(64),archiveBytes:1000});
  }
  return {journal,options,root,descriptor,receipt};
}

test("V2 reader rejects an intermediate missing Pyth root instead of erasing its ancestor's signed floor",async()=>{
  const f=fixture(),a=f.receipt(f.descriptor(NOW,undefined,f.root(100))),b=f.receipt(f.descriptor(NOW+1000,a));
  await expect(verifyStreamDatabase(f.journal,f.descriptor(NOW+2000,b),f.options)).rejects.toThrow("PYTH_RECOVERY_INHERITED_STATE_MISSING");
});

test("V2 reader rejects ancestral 100 to 50 rollback even when the newest generation recovers to 100",async()=>{
  const f=fixture(),a=f.receipt(f.descriptor(NOW,undefined,f.root(100))),b=f.receipt(f.descriptor(NOW+1000,a,f.root(50,NOW+1000)));
  const c=f.descriptor(NOW+2000,b,f.root(100,NOW+2000));
  await expect(verifyStreamDatabase(f.journal,c,f.options)).rejects.toThrow("PYTH_RECOVERY_INHERITED_HIGHWATER_ROLLBACK");
});

test("V2 reader validates an ancestral Pyth root at its own signed time, not a later recovery time",async()=>{
  const f=fixture();
  // The isolated producer can construct a root whose state is valid at +500 ms,
  // but binding it into a descriptor signed for NOW is still invalid history.
  const a=f.receipt(f.descriptor(NOW,undefined,f.root(100,NOW+500)));
  const b=f.receipt(f.descriptor(NOW+2000,a,f.root(200,NOW+1500)));
  const c=f.descriptor(NOW+3000,b,f.root(300,NOW+2500));
  await expect(verifyStreamDatabase(f.journal,c,f.options)).rejects.toThrow("PYTH_RECOVERY_HIGHWATER_INVALID");
});

test("V2 reader accepts three signed generations with advancing inherited Pyth high-water marks",async()=>{
  const f=fixture(),a=f.receipt(f.descriptor(NOW,undefined,f.root(100))),b=f.receipt(f.descriptor(NOW+1000,a,f.root(200,NOW+1000)));
  const c=f.descriptor(NOW+2000,b,f.root(300,NOW+2000));
  const result=await verifyStreamDatabase(f.journal,c,f.options);
  expect(result.pythRecovery).toEqual({present:true,states:1,receipts:0,locks:0,upstreamPublication:"NOT_PROVEN"});
  expect(result.recoveryProvenance).toEqual({records:2,linkedRecords:2,ciphertextVerification:"NOT_PERFORMED"});
  expect(result.history).toEqual({valid:true,count:0});
});
