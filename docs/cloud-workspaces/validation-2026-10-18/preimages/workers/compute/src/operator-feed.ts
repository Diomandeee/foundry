import type {TransactionPort, SqlValue} from '../../../packages/compute-authority/src/durable/contracts';
import type {ArtifactStore} from './artifact-store';
import {createHash} from 'node:crypto';
import {exact, HttpFailure} from './http';

export interface OperatorRequest {afterEvent:number; limit:number}
export interface OperatorWindow {total:number; returned:number; truncated:boolean}
export interface OperatorResources {cpu:number; ramMib:number; gpuKind:'cuda'|'metal'|null; gpuVram:number|null}
export interface OperatorDevice {id:string; kind:'cuda'|'metal'; vramMib:number; busy:boolean|null}
export interface OperatorEnrollment {
  revision:number; incarnation:number; expiresAt:number; revokedAt:number|null;
  lastSeen:number|null; sequence:number; freshnessMs:number;
  freshness:'never-seen'|'fresh'|'stale'|'inactive';
}
export interface OperatorWorker {
  id:string; principal:string; workerClass:'general'|'edge'; incarnation:number;
  quarantined:boolean; cpu:number; ramMib:number;
  enrollment:OperatorEnrollment|null; devices:OperatorDevice[]; deviceWindow:OperatorWindow;
}
export interface OperatorWorkload {
  id:string; principal:string; status:'QUEUED'|'RUNNING'|'VERIFYING'|'SUCCEEDED'|'FAILED'|'CANCELLED';
  generation:number; attemptsUsed:number; maxAttempts:number; winner:string|null;
  resources:OperatorResources; maxBytes:number; exitCode:number; pure:boolean; reconstructible:boolean;
}
export interface OperatorLease {
  id:string; workloadId:string; workerId:string; epoch:number; generation:number; incarnation:number;
  issuedAt:number; expiresAt:number; capAt:number; sequence:number;
  state:'RUNNING'|'VERIFYING'|'SUCCEEDED'|'REVOKED'; verificationDeadline:number|null;
}
export interface OperatorAttempt {
  id:string; workloadId:string; placementId:string; generation:number; state:OperatorLease['state'];
}
export type OperatorRejection = 'edge'|'quarantined'|'cpu'|'ram'|'gpu';
export interface OperatorCandidate {
  worker:Pick<OperatorWorker,'id'|'principal'|'workerClass'|'incarnation'|'quarantined'|'cpu'|'ramMib'>;
  used:{cpu:number; ramMib:number}; devices:OperatorDevice[]; deviceWindow:OperatorWindow;
  reasons:OperatorRejection[]; reasonWindow:OperatorWindow;
}
export interface OperatorPlacement {
  id:string; workloadId:string; workerId:string; generation:number; epoch:number; createdAt:number;
  policyVersion:'vector-exclusive-v1'; selected:string; reason:'requested-feasible-worker';
  resources:OperatorResources; candidates:OperatorCandidate[]; candidateWindow:OperatorWindow;
  omittedCandidates:number;
}
export interface OperatorReceipt {
  workloadId:string; leaseId:string; bytes:number; epoch:number; generation:number;
  incarnation:number; verifier:string; verifiedAt:number;
}
export interface OperatorResultRequest {expectedEpoch:number; workloadId:string}
export interface OperatorWorkloadObservation {
  version:1; ok:true; environment:string; authorityId:string; observedAt:number;
  workload:OperatorWorkload|null; lease:OperatorLease|null; receipt:OperatorReceipt|null;
}
export interface OperatorResultWorkload {
  id:string; principal:string; specification:string; expectedHash:string; maxBytes:number; cpu:number; ramMib:number;
}
export interface OperatorAcceptedResult {
  version:1; ok:true; environment:string; authorityId:string; observedAt:number;
  workload:OperatorResultWorkload; receipt:OperatorReceipt & {sha256:string}; bytesBase64:string;
}
export interface OperatorEvent {
  seq:number; epoch:number; at:number; kind:string; entity:string; actor:string;
  entityVersion:number; reason:string|null; metadataRedacted:boolean;
}
export interface OperatorView {
  version:1;
  source:{environment:string; authorityId:string; epoch:number; observedAt:number; head:number};
  workers:OperatorWorker[]; workloads:OperatorWorkload[]; leases:OperatorLease[];
  attempts:OperatorAttempt[]; placements:OperatorPlacement[]; receipts:OperatorReceipt[];
  events:{after:number; through:number; head:number; hasMore:boolean; items:OperatorEvent[]};
  windows:Record<'workers'|'workloads'|'leases'|'attempts'|'placements'|'receipts'|'events',OperatorWindow>;
}

type Row = Record<string,unknown>;
const unavailable = ():never => {throw new HttpFailure(503,'operator-view-unavailable');};
const record = (v:unknown):Row => {
  if(!v||typeof v!=='object'||Array.isArray(v))return unavailable();
  return v as Row;
};
const number = (v:unknown):number => {
  if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0)return unavailable();
  return v;
};
const nullableNumber = (v:unknown):number|null => v===null?null:number(v);
const id = (v:unknown):string => {
  if(typeof v!=='string'||!/^[A-Za-z0-9._-]{1,64}(?![\s\S])/.test(v))return unavailable();
  return v;
};
const nullableId = (v:unknown):string|null => v===null?null:id(v);
function choice<T extends string>(v:unknown,values:readonly T[]):T {
  if(typeof v!=='string'||!values.includes(v as T))return unavailable();
  return v as T;
}
const flag = (v:unknown):boolean => {
  if(v!==0&&v!==1)return unavailable();
  return v===1;
};
const array = (v:unknown):unknown[] => Array.isArray(v)?v:unavailable();
const window = (total:number,returned:number):OperatorWindow => {
  if(total<returned)return unavailable();
  return {total,returned,truncated:returned<total};
};
const states = ['RUNNING','VERIFYING','SUCCEEDED','REVOKED'] as const;
const rejections = ['edge','quarantined','cpu','ram','gpu'] as const;
const eventKinds = [
  'workload-requeued','workload-failed','lease-revoked','worker-quarantined','quota-set',
  'worker-registered','workload-submitted','lease-renewed','result-staged','workload-verifying',
  'workload-cancelled','reservation-released','worker-reconciled','epoch-bumped','lease-issued',
  'workload-running','lease-succeeded','workload-succeeded',
] as const;
const resources = (r:Row):OperatorResources => ({
  cpu:number(r.cpu),ramMib:number(r.ramMib),
  gpuKind:r.gpuKind===null?null:choice<'cuda'|'metal'>(r.gpuKind,['cuda','metal']),gpuVram:nullableNumber(r.gpuVram),
});
// Shared column lists and projectors keep point reads identical to feed array elements.
const workloadColumns=`id,principal,status,generation,attempts_used,max_attempts,winner,
  cpu,ram_mib AS ramMib,gpu_kind AS gpuKind,gpu_vram AS gpuVram,max_bytes,exit_code,pure,reconstructible`;
const leaseColumns=`id,workload_id,worker_id,epoch,generation,incarnation,issued_ms,expires_ms,
  cap_ms,sequence,state,verify_deadline`;
const receiptColumns=`workload_id,lease_id,bytes,epoch,generation,incarnation,verifier,verified_ms`;
const workloadProjection=(r:Row):OperatorWorkload=>({
  id:id(r.id),principal:id(r.principal),status:choice(r.status,['QUEUED','RUNNING','VERIFYING','SUCCEEDED','FAILED','CANCELLED']),
  generation:number(r.generation),attemptsUsed:number(r.attempts_used),maxAttempts:number(r.max_attempts),winner:nullableId(r.winner),
  resources:resources(r),maxBytes:number(r.max_bytes),exitCode:number(r.exit_code),pure:flag(r.pure),reconstructible:flag(r.reconstructible),
});
const leaseProjection=(r:Row):OperatorLease=>({
  id:id(r.id),workloadId:id(r.workload_id),workerId:id(r.worker_id),epoch:number(r.epoch),generation:number(r.generation),
  incarnation:number(r.incarnation),issuedAt:number(r.issued_ms),expiresAt:number(r.expires_ms),capAt:number(r.cap_ms),
  sequence:number(r.sequence),state:choice(r.state,states),verificationDeadline:nullableNumber(r.verify_deadline),
});
const receiptProjection=(r:Row):OperatorReceipt=>({
  workloadId:id(r.workload_id),leaseId:id(r.lease_id),bytes:number(r.bytes),epoch:number(r.epoch),generation:number(r.generation),
  incarnation:number(r.incarnation),verifier:id(r.verifier),verifiedAt:number(r.verified_ms),
});
const worker = (r:Row):OperatorCandidate['worker'] => ({
  id:id(r.id),principal:id(r.principal),workerClass:choice(r.class,['general','edge']),
  incarnation:number(r.incarnation),quarantined:flag(r.quarantined),cpu:number(r.cpu),ramMib:number(r.ram_mib),
});
const device = (r:Row):OperatorDevice => ({
  id:id(r.id),kind:choice(r.kind,['cuda','metal']),vramMib:number(r.vram_mib),
  busy:r.busy===undefined?null:flag(r.busy),
});

/** Project historical core placement facts, never current fleet guesses or raw snapshot keys. */
function placement(r:Row):OperatorPlacement {
  if(typeof r.snapshot!=='string'||r.snapshot.length>65536)return unavailable();
  let parsed:unknown;
  try{parsed=JSON.parse(r.snapshot);}catch{return unavailable();}
  const s=record(parsed), facts=array(s.candidates);
  if(facts.length>128)return unavailable();
  const candidates=facts.slice(0,16).map(value=>{
    const f=record(value),used=record(f.used),devices=array(f.devices),reasons=array(f.reasons);
    if(devices.length>64||reasons.length>5)return unavailable();
    return {
      worker:worker(record(f.worker)),used:{cpu:number(used.cpu),ramMib:number(used.ram)},
      devices:devices.slice(0,8).map(v=>device(record(v))),deviceWindow:window(devices.length,Math.min(devices.length,8)),
      reasons:reasons.map(v=>choice(v,rejections)),reasonWindow:window(reasons.length,reasons.length),
    };
  });
  const selected=id(s.selected),workerId=id(r.worker_id);
  if(selected!==workerId||s.policyVersion!==r.policy_version)return unavailable();
  return {
    id:id(r.id),workloadId:id(r.workload_id),workerId,generation:number(r.generation),epoch:number(r.epoch),
    createdAt:number(r.created_ms),policyVersion:choice(s.policyVersion,['vector-exclusive-v1']),selected,
    reason:choice(s.reason,['requested-feasible-worker']),resources:resources(record(s.resources)),
    candidates,candidateWindow:window(facts.length,candidates.length),omittedCandidates:facts.length-candidates.length,
  };
}

/** All SQL is SELECT-only, in one synchronous transaction; independent of all outbox consumers. */
export function readOperatorFeed(storage:TransactionPort,expectedEpoch:number,input:unknown,observedAt:number):OperatorView {
  exact(input,['afterEvent','limit']);
  const {afterEvent,limit}=input;
  if(!Number.isSafeInteger(expectedEpoch)||expectedEpoch<1)throw new HttpFailure(400,'invalid-epoch');
  if(!Number.isSafeInteger(afterEvent)||afterEvent<0||!Number.isSafeInteger(limit)||limit<1||limit>64)
    throw new HttpFailure(400,'invalid-operator-request');
  try{return storage.transactionSync(()=>{
    const q=(sql:string,...bindings:SqlValue[]):Row[]=>[...storage.sql.exec(sql,...bindings)];
    const one=(sql:string,...bindings:SqlValue[]):Row=>q(sql,...bindings)[0]??unavailable();
    const meta=one('SELECT environment,authority_id,epoch,clock_ms FROM authority_meta WHERE singleton=1');
    if(number(meta.epoch)!==expectedEpoch)throw new HttpFailure(409,'stale-epoch');
    const head=number(one('SELECT COALESCE(max(seq),0) n FROM events').n);
    if(afterEvent>head)throw new HttpFailure(409,'source-cursor-ahead');
    // Observe persisted clocks without tick()/UPDATE; backward wall clocks cannot freshen a worker.
    const time=Math.max(number(observedAt),number(meta.clock_ms));
    const enrollmentExists=q("SELECT name FROM sqlite_master WHERE type='table' AND name='enrollment_meta'").length>0;
    const em=enrollmentExists?one('SELECT schema_version,environment,authority_id,freshness_ms,clock_ms FROM enrollment_meta WHERE singleton=1'):null;
    if(em&&(em.schema_version!==2||em.environment!==meta.environment||em.authority_id!==meta.authority_id))return unavailable();
    const enrollmentTime=em?Math.max(time,number(em.clock_ms)):time;
    const workers:OperatorWorker[]=q('SELECT id,principal,class,incarnation,quarantined,cpu,ram_mib FROM workers ORDER BY id LIMIT 32').map(r=>{
      const base=worker(r);
      const c=em?q('SELECT revision,incarnation,expires_ms,revoked_ms,last_seen,sequence FROM enrollment_credentials WHERE worker_id=? ORDER BY revision DESC LIMIT 1',base.id)[0]:undefined;
      let enrollment:OperatorEnrollment|null=null;
      if(c&&em){
        const expiresAt=number(c.expires_ms),revokedAt=nullableNumber(c.revoked_ms),lastSeen=nullableNumber(c.last_seen),freshnessMs=number(em.freshness_ms);
        enrollment={revision:number(c.revision),incarnation:number(c.incarnation),expiresAt,revokedAt,lastSeen,
          sequence:number(c.sequence),freshnessMs,
          freshness:revokedAt!==null||expiresAt<=enrollmentTime?'inactive':lastSeen===null?'never-seen':enrollmentTime-lastSeen<freshnessMs?'fresh':'stale'};
      }
      // Supported registration/enrollment admits <=64 devices. Bound even malformed legacy data.
      const total=number(one('SELECT count(*) n FROM (SELECT id FROM devices WHERE worker_id=? LIMIT 65)',base.id).n);
      if(total>64)return unavailable();
      const devices=q('SELECT id,kind,vram_mib FROM devices WHERE worker_id=? ORDER BY id LIMIT 8',base.id).map(device);
      return {...base,enrollment,devices,deviceWindow:window(total,devices.length)};
    });
    const workloads=q(`SELECT ${workloadColumns} FROM workloads INDEXED BY operator_workload_order
      ORDER BY CASE WHEN status IN ('QUEUED','RUNNING','VERIFYING') THEN 0 ELSE 1 END,id LIMIT 32`).map(workloadProjection);
    const leases=q(`SELECT ${leaseColumns} FROM leases INDEXED BY operator_lease_order
      ORDER BY issued_ms DESC,id LIMIT 64`).map(leaseProjection);
    // Bound placement selection before joining its unique attempt; any final sort is <=64 rows.
    const attempts:OperatorAttempt[]=q(`SELECT a.id,a.workload_id,a.placement_id,a.generation,a.state
      FROM (SELECT id,created_ms FROM placements INDEXED BY operator_placement_order ORDER BY created_ms DESC,id LIMIT 64) p
      CROSS JOIN attempts a ON a.placement_id=p.id ORDER BY p.created_ms DESC,p.id LIMIT 64`).map(r=>({
      id:id(r.id),workloadId:id(r.workload_id),placementId:id(r.placement_id),generation:number(r.generation),state:choice(r.state,states),
    }));
    const placements=q(`SELECT id,workload_id,worker_id,generation,epoch,created_ms,policy_version,snapshot
      FROM placements INDEXED BY operator_placement_order ORDER BY created_ms DESC,id LIMIT 8`).map(placement);
    // Receipt identity/size/fences only: artifact references, hashes and contents stay outside this feed.
    const receipts=q(`SELECT ${receiptColumns} FROM receipts INDEXED BY operator_receipt_order
      ORDER BY verified_ms DESC,workload_id LIMIT 32`).map(receiptProjection);
    const items:OperatorEvent[]=q(`SELECT seq,epoch,at_ms,kind,entity,actor,entity_version,reason
      FROM events WHERE seq>? ORDER BY seq LIMIT ?`,afterEvent,limit).map((r,index)=>{
      const seq=number(r.seq);
      if(seq!==afterEvent+index+1)throw new HttpFailure(409,'source-event-gap');
      const known=(v:unknown):v is typeof eventKinds[number]=>typeof v==='string'&&eventKinds.includes(v as typeof eventKinds[number]);
      return {seq,epoch:number(r.epoch),at:number(r.at_ms),kind:known(r.kind)?r.kind:'unknown',entity:id(r.entity),actor:id(r.actor),
        entityVersion:number(r.entity_version),reason:known(r.reason)?r.reason:null,metadataRedacted:!known(r.kind)||!known(r.reason)};
    });
    const through=items.at(-1)?.seq??afterEvent;
    if(through<head&&items.length<limit)throw new HttpFailure(409,'source-event-gap');
    const total=(family:string)=>number(one('SELECT total n FROM operator_feed_counts WHERE family=?',family).n);
    // Unique integer seq, positive minimum and count=head establish a gap-free immutable
    // sequence. Only then is head-after an exact suffix count, without a suffix scan.
    if(total('events')!==head||(head>0&&number(one('SELECT min(seq) n FROM events').n)!==1))
      throw new HttpFailure(409,'source-event-gap');
    const view:OperatorView={version:1,source:{environment:id(meta.environment),authorityId:id(meta.authority_id),epoch:expectedEpoch,observedAt:enrollmentTime,head},
      workers,workloads,leases,attempts,placements,receipts,events:{after:afterEvent,through,head,hasMore:through<head,items},
      windows:{
        workers:window(total('workers'),workers.length),workloads:window(total('workloads'),workloads.length),
        leases:window(total('leases'),leases.length),attempts:window(total('attempts'),attempts.length),
        placements:window(total('placements'),placements.length),receipts:window(total('receipts'),receipts.length),
        events:window(head-afterEvent,items.length),
      }};
    if(new TextEncoder().encode(JSON.stringify(view)).byteLength>256*1024)throw new HttpFailure(503,'operator-view-capacity');
    return view;
  });}catch(error){
    if(error instanceof HttpFailure)throw error;
    // SQL/schema/JSON/provider details must never reach the transport caller.
    throw new HttpFailure(503,'operator-view-unavailable');
  }
}

/** Scoped SELECT-only observation; unrelated feed windows/events cannot hide this workload. */
export function readOperatorWorkload(
  storage:TransactionPort,expectedEpoch:number,workloadId:unknown,observedAt:number,
):OperatorWorkloadObservation {
  if(!Number.isSafeInteger(expectedEpoch)||expectedEpoch<1)throw new HttpFailure(400,'invalid-epoch');
  if(typeof workloadId!=='string'||!/^[A-Za-z0-9._-]{1,64}(?![\s\S])/.test(workloadId))
    throw new HttpFailure(400,'invalid-workload');
  try{return storage.transactionSync(()=>{
    const q=(sql:string,...bindings:SqlValue[]):Row[]=>[...storage.sql.exec(sql,...bindings)];
    const meta=q('SELECT environment,authority_id,epoch,clock_ms FROM authority_meta WHERE singleton=1')[0]??unavailable();
    if(number(meta.epoch)!==expectedEpoch)throw new HttpFailure(409,'stale-epoch');
    const row=q(`SELECT ${workloadColumns} FROM workloads WHERE id=?`,workloadId)[0];
    const workload=row?workloadProjection(row):null;
    // attempts has UNIQUE(workload_id,generation); leases.id is its primary-key binding.
    const leaseRow=workload?q(`SELECT ${leaseColumns} FROM leases WHERE id=(
      SELECT id FROM attempts WHERE workload_id=? AND generation=?)`,workloadId,workload.generation)[0]:undefined;
    const lease=leaseRow?leaseProjection(leaseRow):null;
    const receiptRow=workload?q(`SELECT ${receiptColumns} FROM receipts WHERE workload_id=?`,workloadId)[0]:undefined;
    const receipt=receiptRow?receiptProjection(receiptRow):null;
    if(lease&&(lease.workloadId!==workloadId||lease.generation!==workload!.generation))return unavailable();
    if(receipt&&(receipt.workloadId!==workloadId||receipt.generation!==workload!.generation||
      workload!.status!=='SUCCEEDED'||receipt.leaseId!==workload!.winner||!lease||lease.state!=='SUCCEEDED'||receipt.leaseId!==lease.id||
      receipt.epoch!==lease.epoch||receipt.incarnation!==lease.incarnation))return unavailable();
    return {version:1,ok:true,environment:id(meta.environment),authorityId:id(meta.authority_id),
      observedAt:Math.max(number(observedAt),number(meta.clock_ms)),workload,lease,receipt};
  });}catch(error){
    if(error instanceof HttpFailure)throw error;
    throw new HttpFailure(503,'operator-view-unavailable');
  }
}

/** Owner point read: derive the private seal reference only from an immutable accepted receipt. */
export function readOperatorResult(
  storage:TransactionPort,artifacts:Pick<ArtifactStore,'getMetadata'|'read'>,
  expectedEpoch:number,workloadId:unknown,observedAt:number,
):OperatorAcceptedResult {
  if(!Number.isSafeInteger(expectedEpoch)||expectedEpoch<1)throw new HttpFailure(400,'invalid-epoch');
  if(typeof workloadId!=='string'||!/^[A-Za-z0-9._-]{1,64}(?![\s\S])/.test(workloadId))
    throw new HttpFailure(400,'invalid-workload');
  const malformed=():never=>{throw new HttpFailure(503,'operator-result-data-malformed');};
  const hash=(v:unknown):string=>typeof v==='string'&&/^[a-f0-9]{64}(?![\s\S])/.test(v)?v:malformed();
  const binding=(matched:boolean)=>{if(!matched)throw new HttpFailure(409,'operator-result-binding');};
  try{return storage.transactionSync(()=>{
    const q=(sql:string,...bindings:SqlValue[]):Row[]=>[...storage.sql.exec(sql,...bindings)];
    const meta=q('SELECT environment,authority_id,epoch,clock_ms FROM authority_meta WHERE singleton=1')[0];
    if(!meta)return malformed();
    if(number(meta.epoch)!==expectedEpoch)throw new HttpFailure(409,'stale-epoch');
    const w=q(`SELECT id,principal,specification,status,winner,generation,expected_hash,policy_hash,max_bytes,exit_code,cpu,ram_mib
      FROM workloads WHERE id=?`,workloadId)[0];
    if(!w||w.status!=='SUCCEEDED')throw new HttpFailure(404,'operator-result-not-accepted');
    if(typeof w.specification!=='string'||w.specification.length<1||w.specification.length>16384)return malformed();
    const workload:OperatorResultWorkload={id:id(w.id),principal:id(w.principal),specification:w.specification,
      expectedHash:hash(w.expected_hash),maxBytes:number(w.max_bytes),cpu:number(w.cpu),ramMib:number(w.ram_mib)};
    const r=q(`SELECT workload_id,lease_id,reference,sha256,bytes,policy_hash,epoch,generation,incarnation,verifier,verified_ms
      FROM receipts WHERE workload_id=?`,workloadId)[0];
    if(!r)throw new HttpFailure(404,'operator-result-not-accepted');
    const receipt:OperatorAcceptedResult['receipt']={
      workloadId:id(r.workload_id),leaseId:id(r.lease_id),sha256:hash(r.sha256),bytes:number(r.bytes),
      epoch:number(r.epoch),generation:number(r.generation),incarnation:number(r.incarnation),
      verifier:id(r.verifier),verifiedAt:number(r.verified_ms),
    };
    const reference=hash(r.reference);
    binding(id(w.id)===workloadId&&receipt.workloadId===workloadId&&id(w.winner)===receipt.leaseId&&
      number(w.generation)===receipt.generation&&hash(w.expected_hash)===receipt.sha256&&hash(w.policy_hash)===hash(r.policy_hash));
    if(receipt.bytes>4096)throw new HttpFailure(503,'operator-result-too-large');
    binding(receipt.bytes<=number(w.max_bytes));
    const l=q('SELECT id,workload_id,worker_id,epoch,generation,incarnation,state FROM leases WHERE id=?',receipt.leaseId)[0];
    const a=q('SELECT lease_id,reference,sha256,bytes,exit_code FROM artifacts WHERE lease_id=?',receipt.leaseId)[0];
    if(!l||!a)throw new HttpFailure(409,'operator-result-binding');
    binding(id(l.id)===receipt.leaseId&&id(l.workload_id)===workloadId&&l.state==='SUCCEEDED'&&
      number(l.epoch)===receipt.epoch&&number(l.generation)===receipt.generation&&number(l.incarnation)===receipt.incarnation&&
      id(a.lease_id)===receipt.leaseId&&hash(a.reference)===reference&&hash(a.sha256)===receipt.sha256&&
      number(a.bytes)===receipt.bytes&&number(a.exit_code)===number(w.exit_code));
    const worker=q('SELECT principal FROM workers WHERE id=?',id(l.worker_id))[0];
    if(!worker)throw new HttpFailure(503,'operator-result-scope');
    // getMetadata also hashes its bytes (up to1MiB). Inspect size first so neither store call
    // can materialize an over-pilot-limit blob, even if receipt metadata is inconsistent.
    const seal=q(`SELECT ref,lease_id,principal,sha256,size,length(bytes) actual_size,typeof(bytes) byte_type
      FROM compute_artifact_bytes WHERE ref=?`,reference)[0];
    if(!seal)throw new HttpFailure(503,'operator-result-unavailable');
    const size=number(seal.size),actualSize=number(seal.actual_size);
    if(size>4096||actualSize>4096)throw new HttpFailure(503,'operator-result-too-large');
    if(seal.byte_type!=='blob')return malformed();
    binding(hash(seal.ref)===reference&&id(seal.lease_id)===receipt.leaseId&&id(seal.principal)===id(worker.principal)&&
      hash(seal.sha256)===receipt.sha256&&size===receipt.bytes&&actualSize===receipt.bytes);
    const sealed=artifacts.getMetadata(reference);
    binding(sealed.reference===reference&&sealed.leaseId===receipt.leaseId&&sealed.principal===worker.principal&&
      sealed.sha256===receipt.sha256&&sealed.bytes===receipt.bytes);
    const bytes=artifacts.read(reference,4096);
    // ArtifactStore.read independently checks actual digest, length and lease-derived reference.
    binding(bytes.byteLength===receipt.bytes&&createHash('sha256').update(bytes).digest('hex')===receipt.sha256);
    const finalMeta=q('SELECT environment,authority_id,epoch FROM authority_meta WHERE singleton=1')[0];
    if(!finalMeta)return malformed();
    if(number(finalMeta.epoch)!==expectedEpoch)throw new HttpFailure(409,'stale-epoch');
    if(finalMeta.environment!==meta.environment||finalMeta.authority_id!==meta.authority_id)
      throw new HttpFailure(503,'operator-result-scope');
    return {version:1,ok:true,environment:id(meta.environment),authorityId:id(meta.authority_id),
      observedAt:Math.max(number(observedAt),number(meta.clock_ms)),workload,receipt,bytesBase64:Buffer.from(bytes).toString('base64')};
  });}catch(error){
    if(error instanceof HttpFailure){
      if(error.code==='operator-view-unavailable')throw new HttpFailure(503,'operator-result-data-malformed');
      throw error;
    }
    throw new HttpFailure(503,'operator-result-unavailable');
  }
}
