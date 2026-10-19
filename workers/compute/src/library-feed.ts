import {canonical} from '../../../packages/library-jobs/src/data';
import {fields,integer,identifier,hash} from '../../../packages/library-catalog/src/validation';
import type {ComputeBinding} from '../../../packages/library-jobs/src/types';
import type {FencePage,FenceEvent} from '../../../packages/library-revocation/src/types';
import type {TransactionPort} from '../../../packages/compute-authority/src/durable/contracts';
import {HttpFailure} from './http';
/** Independent immutable event cursor. Never changes projection acknowledgements. */
export function readLibraryFences(storage:TransactionPort,input:unknown):FencePage{
 const p=JSON.parse(canonical(input)) as {after:number;limit:number};fields(p,['after','limit']);integer(p.after);integer(p.limit,64);if(p.limit<1)throw new HttpFailure(400,'invalid-limit');
 return storage.transactionSync(()=>{
  const meta=[...storage.sql.exec('SELECT environment,authority_id,epoch FROM authority_meta WHERE singleton=1')][0];
  const head=Number([...storage.sql.exec('SELECT COALESCE(max(seq),0) AS n FROM events')][0].n);
  if(p.after>head)throw new HttpFailure(409,'source-cursor-ahead');
  const rows=[...storage.sql.exec(`SELECT seq,epoch,kind,
   json_extract(payload,'$.lease.id') lease_id,json_extract(payload,'$.lease.workload_id') lease_workload,
   json_extract(payload,'$.lease.worker_id') lease_worker,json_extract(payload,'$.lease.epoch') lease_epoch,
   json_extract(payload,'$.lease.generation') lease_generation,json_extract(payload,'$.lease.incarnation') lease_incarnation,
   json_extract(payload,'$.worker.id') worker_id,json_extract(payload,'$.worker.incarnation') worker_incarnation,
   json_extract(payload,'$.workload.id') workload_id,json_extract(payload,'$.workload.generation') workload_generation
   FROM events WHERE seq>? ORDER BY seq LIMIT ?`,p.after,p.limit)];
  const events:FenceEvent[]=rows.map((r,index)=>{
   if(r.seq!==p.after+index+1)throw new HttpFailure(409,'source-event-gap');
   const e:FenceEvent={seq:Number(r.seq),epoch:Number(r.epoch),kind:'noop',leaseId:null,workloadId:null,workerId:null,generation:null,incarnation:null};
   if(r.kind==='epoch-bumped')e.kind='epoch-bumped';
   if(r.kind==='lease-revoked'){e.kind='lease-revoked';e.epoch=Number(r.lease_epoch);e.leaseId=String(r.lease_id);e.workloadId=String(r.lease_workload);e.workerId=String(r.lease_worker);e.generation=Number(r.lease_generation);e.incarnation=Number(r.lease_incarnation);}
   // Quarantine also follows successful verification. Active sibling leases get
   // individual lease-revoked events; accepted results must not be invalidated by
   // a broad worker annotation. Retain its cursor position as a noop.
   if(r.kind==='workload-cancelled'){e.kind='workload-cancelled';e.workloadId=String(r.workload_id);e.generation=Number(r.workload_generation);}
   return e;
  });
  return {version:1,environment:String(meta.environment),authorityId:String(meta.authority_id),epoch:Number(meta.epoch),after:p.after,through:events.at(-1)?.seq??p.after,head,events};
 });
}
/** Exact current compute fence for trusted host broker/verifier adapters; no raw capability. */
export function observeLibraryFence(storage:TransactionPort,input:unknown,now:number){
 const b=JSON.parse(canonical(input)) as ComputeBinding;
 fields(b,['authorityId','workloadId','leaseId','attemptId','capabilityDigest','workerId','epoch','generation','incarnation']);
 for(const k of ['authorityId','workloadId','leaseId','attemptId','workerId'] as const)identifier(b[k]);hash(b.capabilityDigest);integer(b.epoch);integer(b.generation);integer(b.incarnation);integer(now);
 return storage.transactionSync(()=>{
  const meta=[...storage.sql.exec('SELECT environment,authority_id,epoch FROM authority_meta WHERE singleton=1')][0];
  const head=Number([...storage.sql.exec('SELECT COALESCE(max(seq),0) AS n FROM events')][0].n);
  const l=[...storage.sql.exec('SELECT * FROM leases WHERE id=?',b.leaseId)][0];
  const w=l?[...storage.sql.exec('SELECT generation,status FROM workloads WHERE id=?',String(l.workload_id))][0]:undefined;
  const matched=!!l&&b.authorityId===meta.authority_id&&b.epoch===meta.epoch&&b.attemptId===l.id&&b.workloadId===l.workload_id&&b.workerId===l.worker_id&&b.epoch===l.epoch&&b.generation===l.generation&&b.incarnation===l.incarnation&&b.capabilityDigest===l.capability_hash&&w?.generation===l.generation;
  const state=matched?String(l!.state):'MISMATCH';
  const expiresAt=matched?Number(state==='VERIFYING'?l!.verify_deadline:l!.expires_ms):0;
  const current=matched&&(state==='RUNNING'||state==='VERIFYING')&&Number.isSafeInteger(expiresAt)&&expiresAt>now;
  const accepted=matched&&l!.state==='SUCCEEDED'&&w?.status==='SUCCEEDED';
  return {version:1,environment:String(meta.environment),authorityId:String(meta.authority_id),epoch:Number(meta.epoch),head,observedAt:now,binding:b,current,accepted,state,expiresAt};
 });
}
