/** Shared capture path for a normal node and private research collection. */
import type { Journal } from "./journal";
import type { Registry, Observation, CollectorContext } from "./types";
import { createCollectors } from "./collectors";
import { collectorSchedule, controlledCollectorContext, type CollectionSchedule } from "./collection-control";
import { observationSchema } from "./validation";

/** Execute each source once; callers own capture storage and public error redaction. */
export async function* collectSources(collectorIds: string[], registry: Registry, store: Journal,
  context: Pick<CollectorContext, "now" | "env" | "fetch">): AsyncGenerator<{
    collector: string;
    status: "COLLECTION_NOT_APPROVED" | "BACKOFF" | "COLLECTED" | "DEGRADED" | "FAILED";
    observations: Observation[];
    errors: string[];
    rejectedObservations: number;
    schedule?: CollectionSchedule;
  }> {
  for(const collector of createCollectors(collectorIds)) {
    const provider=registry.providers.find(p=>p.id===collector.provider);
    if(!provider?.rights.collect||(provider.rights.expiresAt!==null&&provider.rights.expiresAt<=context.now())) {
      yield {collector:collector.id,status:"COLLECTION_NOT_APPROVED",observations:[],errors:[],rejectedObservations:0};
      continue;
    }
    const schedule=collectorSchedule(store,collector.id,context.now());
    if(!schedule.eligible) {
      yield {collector:collector.id,status:"BACKOFF",observations:[],errors:[],rejectedObservations:0,schedule};
      continue;
    }
    try {
      const result=await collector.collect(controlledCollectorContext(store,collector.id,{...context,archive:r=>store.archive(r)}));
      const observations:Observation[]=[];
      let rejectedObservations=0;
      for(const observation of result.observations) {
        const parsed=observationSchema.safeParse(observation);
        if(parsed.success)observations.push(observation);else rejectedObservations++;
      }
      yield {collector:collector.id,status:result.errors.length||rejectedObservations?"DEGRADED":"COLLECTED",
        observations,errors:result.errors,rejectedObservations,schedule:collectorSchedule(store,collector.id,context.now())};
    }catch {
      yield {collector:collector.id,status:"FAILED",observations:[],errors:[],rejectedObservations:0};
    }
  }
}

/** Private local captures retain collector diagnostics; hosted summaries redact them. */
export async function collectCapture(collectorIds: string[], registry: Registry, store: Journal,
  context: Pick<CollectorContext, "now" | "env" | "fetch">) {
  const observations:Observation[]=[],errors:string[]=[];
  for await (const source of collectSources(collectorIds,registry,store,context)) {
    if(source.status==="COLLECTION_NOT_APPROVED")errors.push(`${source.collector}: collection permission not configured`);
    else if(source.status==="BACKOFF")errors.push(`${source.collector}: ${source.schedule!.code}; nextAttemptAt=${source.schedule!.nextAttemptAt}`);
    else if(source.status==="FAILED")errors.push(`${source.collector}: collector failed`);
    else {
      for(const observation of source.observations)observations.push(observation);
      for(let i=0;i<source.rejectedObservations;i++)errors.push(`${source.collector}: observation schema rejected`);
      for(const error of source.errors)errors.push(error);
    }
  }
  const now=context.now();store.capture(observations,errors,now);
  return { observations, errors, now };
}
