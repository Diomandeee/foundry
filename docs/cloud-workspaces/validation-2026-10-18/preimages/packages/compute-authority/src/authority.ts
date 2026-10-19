// In-memory sequential protocol reference only. Restart loses state.
// No transport/enrollment authentication or durable transaction is implemented here.
// The caller is a trusted control-plane adapter; worker payloads never select policy
// or the artifact reader. Expiry fences results, not physical execution.
import { createHash, randomUUID } from 'node:crypto';
import { AuditLog } from './verifier.js';

export interface WorkerResources { cpuCores: number; ramMib: number; gpus: {id: string; kind: "cuda" | "metal"; vramMib: number}[] }
export interface WorkloadResources { cpuCores: number; ramMib: number; gpu?: {kind: "cuda" | "metal"; minVramMib: number} }
export interface ResourceReservation { cpuCores: number; ramMib: number; gpuIds: string[] }
export interface AuthorityWorker {
  id: string; workerClass: 'general' | 'edge'; slots: number;
  incarnation: number; quarantined: boolean; resources: WorkerResources;
}
export type WorkloadStatus = 'open' | 'committed' | 'failed' | 'cancelled';
export interface VerificationPolicy {
  kind: string; exitCode?: number; stdoutSha256?: string; minBytes?: number;
}
export interface AuthorityWorkload {
  id: string; generation: number; slotsNeeded: number; status: WorkloadStatus;
  winnerLeaseId: string | null; replayPolicy: 'retry-new-attempt' | 'fail';
  maxAttempts: number; attemptsUsed: number;
  specificationSha256: string; policySha256: string | null;
  verificationPolicy: Readonly<VerificationPolicy> | null; resources: WorkloadResources;
}
export interface AuthorityLease {
  leaseId: string; workerId: string; workloadId: string; generation: number;
  incarnation: number; capability: string; claimScope: string; slots: number;
  issuedAt: number; expiresAt: number; ttlMs: number; maxLifetimeMs: number; live: boolean; reservation: ResourceReservation;
}
export interface SubmittedResult {
  outcome: string; exitCode: number | null; stdoutSha256: string; stdoutBytes: number;
  artifactRef?: string;
}
export interface CompletionReceipt { verified: boolean; reason: string }
export interface AuthorityResult { accepted: boolean; reason: string }
export interface CommittedResult {
  workloadId: string; leaseId: string; generation: number; incarnation: number;
  artifactRef: string; artifactSha256: string; bytes: number; policySha256: string;
  submittedSha256: string; verifiedAt: number;
}
export interface VerificationDependencies {
  // Independently authorized, bounded immutable staging reader. Must not use
  // worker-supplied credentials, callbacks or bytes as the trusted source.
  readArtifact: (reference: string) => Uint8Array | null;
}
const ID = /^[A-Za-z0-9._-]{1,64}$/;
const SHA = /^[a-f0-9]{64}$/;
const digest = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') { for (const child of Object.values(v)) deepFreeze(child); Object.freeze(v); }
  return v;
}
const frozen = <T extends object>(o: T): T => deepFreeze(structuredClone(o));
function identifier(v: string): void { if (typeof v !== 'string' || !ID.test(v)) throw new Error('invalid identifier'); }
function integer(v: number, min: number, max: number, name: string): void {
  if (!Number.isSafeInteger(v) || v < min || v > max) throw new Error(`invalid ${name}`);
}
function policyCopy(p?: VerificationPolicy): Readonly<VerificationPolicy> | null {
  if (p === undefined) return null; // intake allowed, but completion fails closed
  if (!p || typeof p.kind !== 'string' || !ID.test(p.kind)) throw new Error('invalid policy');
  if (p.exitCode !== undefined) integer(p.exitCode, 0, 255, 'exit code');
  if (p.stdoutSha256 !== undefined && !SHA.test(p.stdoutSha256)) throw new Error('invalid policy hash');
  if (p.minBytes !== undefined) integer(p.minBytes, 1, 4 * 1024 * 1024, 'min bytes');
  if (p.exitCode === undefined && p.stdoutSha256 === undefined && p.minBytes === undefined) throw new Error('no-policy');
  return frozen({kind:p.kind, ...(p.exitCode === undefined ? {} : {exitCode:p.exitCode}),
    ...(p.stdoutSha256 === undefined ? {} : {stdoutSha256:p.stdoutSha256}),
    ...(p.minBytes === undefined ? {} : {minBytes:p.minBytes})});
}

function workerResources(r: WorkerResources): WorkerResources {
  if(!r||typeof r!=='object'||!Array.isArray(r.gpus))throw new Error('invalid worker resources');
  integer(r.cpuCores,0,65536,'cpu cores');integer(r.ramMib,0,2**30,'ram MiB');
  if(r.gpus.length>256)throw new Error('too many GPU devices');
  const gpus=[...r.gpus].map(g=>{if(!g||!['cuda','metal'].includes(g.kind))throw new Error('invalid GPU');identifier(g.id);integer(g.vramMib,1,2**30,'VRAM');return {id:g.id,kind:g.kind,vramMib:g.vramMib};}).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  if(new Set(gpus.map(g=>g.id)).size!==gpus.length)throw new Error('duplicate GPU');
  return frozen({cpuCores:r.cpuCores,ramMib:r.ramMib,gpus});
}
function workloadResources(r: WorkloadResources): WorkloadResources {
  if(!r||typeof r!=='object')throw new Error('invalid workload resources');
  integer(r.cpuCores,1,65536,'cpu cores');integer(r.ramMib,0,2**30,'ram MiB');
  if(r.gpu!==undefined){if(!r.gpu||typeof r.gpu!=='object'||Array.isArray(r.gpu)||!['cuda','metal'].includes(r.gpu.kind))throw new Error('invalid GPU kind');integer(r.gpu.minVramMib,1,2**30,'VRAM');}
  return frozen({cpuCores:r.cpuCores,ramMib:r.ramMib,...(r.gpu?{gpu:{kind:r.gpu.kind,minVramMib:r.gpu.minVramMib}}:{})});
}

export class ComputeAuthority {
  private workers = new Map<string, AuthorityWorker>();
  private workloads = new Map<string, AuthorityWorkload>();
  private leases = new Map<string, AuthorityLease>();
  private liveByWorkload = new Map<string, string>();
  private requeueRequests = new Map<string, {generation:number; result:boolean}>();
  private completions = new Map<string, Readonly<CommittedResult>>();
  private eventRows: string[] = [];
  readonly audit = new AuditLog();
  private lastTime = 0;
  constructor(private now: () => number = Date.now, private maxLifetimeMs = 3_600_000,
    private verification?: VerificationDependencies) {
    integer(maxLifetimeMs, 1, 7 * 86400_000, 'max lifetime');
  }
  get events(): readonly string[] { return Object.freeze([...this.eventRows]); }
  private clock(): number {
    const t = this.now(); integer(t, 0, Number.MAX_SAFE_INTEGER - 7 * 86400_000, 'server time');
    this.lastTime = Math.max(this.lastTime, t); return this.lastTime;
  }
  private emit(kind: string, detail: string): void {
    this.eventRows.push(`${kind} ${detail}`);
    this.audit.append(kind, detail, this.clock());
  }
  registerWorker(id: string, slots: number, workerClass: 'general' | 'edge', resources?: WorkerResources): AuthorityWorker {
    identifier(id); integer(slots, 0, 65536, 'slots');
    if (workerClass !== 'general' && workerClass !== 'edge') throw new Error('invalid worker class');
    const capacity=workerResources(resources??{cpuCores:slots,ramMib:0,gpus:[]});
    const prior = this.workers.get(id);
    if (prior && prior.workerClass !== workerClass) throw new Error('worker class conflict');
    if (prior && this.usedSlots(id) > slots) throw new Error('capacity below reservations');
    if(prior){
      const live=[...this.leases.values()].filter(l=>l.live&&l.workerId===id);
      if(live.reduce((v,l)=>v+l.reservation.cpuCores,0)>capacity.cpuCores||live.reduce((v,l)=>v+l.reservation.ramMib,0)>capacity.ramMib||live.some(l=>l.reservation.gpuIds.some(g=>JSON.stringify(prior.resources.gpus.find(x=>x.id===g))!==JSON.stringify(capacity.gpus.find(x=>x.id===g)))))throw new Error('capacity below reservations');
    }
    const w: AuthorityWorker = {id, slots:workerClass === 'edge' ? 0 : slots, workerClass, resources:capacity,
      incarnation:prior?.incarnation ?? 0, quarantined:prior?.quarantined ?? false};
    this.workers.set(id,w);this.emit('worker-registered',`${id} class=${w.workerClass} slots=${w.slots}`);return frozen(w);
  }
  submitWorkload(id: string, slotsNeeded: number, replayPolicy: AuthorityWorkload['replayPolicy']='retry-new-attempt',
    maxAttempts=3, policy?: VerificationPolicy, resources?: WorkloadResources): AuthorityWorkload {
    identifier(id);integer(slotsNeeded,1,65536,'slots needed');integer(maxAttempts,1,1000,'max attempts');
    if (replayPolicy !== 'retry-new-attempt' && replayPolicy !== 'fail') throw new Error('invalid replay policy');
    const expectation=policyCopy(policy);
    if(!expectation?.stdoutSha256)throw new Error("bound content policy required");
    const needs=workloadResources(resources??{cpuCores:slotsNeeded,ramMib:0});
    const specificationSha256=digest(JSON.stringify({id,slotsNeeded,replayPolicy,maxAttempts,policy:expectation,resources:needs}));
    const prior=this.workloads.get(id);
    if(prior){if(prior.specificationSha256!==specificationSha256)throw new Error('workload identity conflict');return frozen(prior);}
    const w: AuthorityWorkload={id,slotsNeeded,replayPolicy,maxAttempts,generation:0,status:'open',winnerLeaseId:null,
      attemptsUsed:0,resources:needs,specificationSha256,policySha256:expectation?digest(JSON.stringify(expectation)):null,verificationPolicy:expectation};
    this.workloads.set(id,w);this.emit('workload-submitted',id);return frozen(w);
  }
  listWorkers(): AuthorityWorker[] {return [...this.workers.values()].map(frozen);}
  getWorkload(id: string): AuthorityWorkload | null {const w=this.workloads.get(id);return w?frozen(w):null;}
  getCompletion(id: string): Readonly<CommittedResult> | null {return this.completions.get(id)??null;}
  private usedSlots(workerId: string): number {
    let used=0;for(const l of this.leases.values())if(l.live&&l.workerId===workerId)used+=l.slots;return used;
  }
  private reservationFor(worker: AuthorityWorker, workload: AuthorityWorkload): ResourceReservation | null {
    const leases=[...this.leases.values()].filter(l=>l.live&&l.workerId===worker.id);
    const r=workload.resources;
    if(leases.reduce((n,l)=>n+l.reservation.cpuCores,0)+r.cpuCores>worker.resources.cpuCores||
       leases.reduce((n,l)=>n+l.reservation.ramMib,0)+r.ramMib>worker.resources.ramMib)return null;
    const gpuIds:string[]=[];
    if(r.gpu){
      const used=new Set(leases.flatMap(l=>l.reservation.gpuIds));
      const device=worker.resources.gpus.find(g=>!used.has(g.id)&&g.kind===r.gpu!.kind&&g.vramMib>=r.gpu!.minVramMib);
      if(!device)return null;gpuIds.push(device.id);
    }
    return frozen({cpuCores:r.cpuCores,ramMib:r.ramMib,gpuIds});
  }
  private closeLease(l: AuthorityLease): void {
    l.live=false;
    const key=`${l.workloadId}#${l.generation}`;
    if(this.liveByWorkload.get(key)===l.leaseId)this.liveByWorkload.delete(key);
  }
  private advance(w: AuthorityWorkload, reason: string): void {
    if(w.status!=='open')return;
    if(w.replayPolicy==='fail'||w.attemptsUsed>=w.maxAttempts){w.status='failed';this.emit('workload-failed',`${w.id} ${reason}`);}
    else {w.generation++;this.emit('workload-requeued',`${w.id} gen=${w.generation} ${reason}`);}
  }
  /** Logical revocation quarantines ALL processes on the worker pending trusted stop reconciliation. */
  private revokeWorkers(workerIds: Set<string>, reason: string): void {
    for(const id of workerIds){
      const worker=this.workers.get(id);if(!worker)continue;
      worker.incarnation++;worker.quarantined=true;
      this.emit('worker-fenced',`${id} incarnation=${worker.incarnation} quarantined ${reason}`);
    }
    for(const l of this.leases.values()){
      if(!workerIds.has(l.workerId)||!l.live)continue;
      this.closeLease(l);this.emit('lease-revoked',`${l.leaseId} ${reason}`);
      const w=this.workloads.get(l.workloadId);if(w&&w.generation===l.generation)this.advance(w,reason);
    }
  }
  private revokeWorker(workerId: string, reason: string): void {this.revokeWorkers(new Set([workerId]),reason);}
  expireLeases(): number {
    const t=this.clock();let count=0;const workers=new Set<string>();
    for(const l of this.leases.values())if(l.live&&t>=l.expiresAt){count++;this.emit('lease-expired',l.leaseId);workers.add(l.workerId);}
    if(workers.size)this.revokeWorkers(workers,'lease-expired');return count;
  }
  claim(workerId: string, workloadId: string, incarnation: number, claimScope: string, ttlMs=60_000): AuthorityLease | null {
    identifier(workerId);identifier(workloadId);identifier(claimScope);integer(incarnation,0,Number.MAX_SAFE_INTEGER,'incarnation');
    integer(ttlMs,1,7*86400_000,'ttl');this.expireLeases();
    const worker=this.workers.get(workerId),w=this.workloads.get(workloadId);
    if(!worker||!w||worker.workerClass==='edge'||worker.quarantined||incarnation!==worker.incarnation||w.status!=='open')return null;
    const key=`${workloadId}#${w.generation}`,existingId=this.liveByWorkload.get(key);
    if(existingId){const l=this.leases.get(existingId);return l?.live&&l.workerId===workerId&&l.claimScope===claimScope?frozen(l):null;}
    if(w.attemptsUsed>=w.maxAttempts||this.usedSlots(workerId)+w.slotsNeeded>worker.slots)return null;
    const reservation=this.reservationFor(worker,w);if(!reservation)return null;
    const t=this.clock();const l: AuthorityLease={leaseId:`lease-${randomUUID()}`,workerId,workloadId,generation:w.generation,
      incarnation:worker.incarnation,capability:randomUUID(),claimScope,slots:w.slotsNeeded,reservation,issuedAt:t,
      expiresAt:t+Math.min(ttlMs,this.maxLifetimeMs),ttlMs,maxLifetimeMs:this.maxLifetimeMs,live:true};
    this.leases.set(l.leaseId,l);this.liveByWorkload.set(key,l.leaseId);w.attemptsUsed++;
    this.emit('lease-issued',`${l.leaseId} ${workerId} ${workloadId} gen=${w.generation}`);return frozen(l);
  }
  renew(leaseId: string, capability: string): boolean {
    const l=this.leases.get(leaseId);if(!l||l.capability!==capability)return false;
    this.expireLeases();const w=this.workloads.get(l.workloadId),worker=this.workers.get(l.workerId);
    if(!l.live||!w||w.status!=='open'||!worker||worker.quarantined||l.generation!==w.generation||l.incarnation!==worker.incarnation)return false;
    l.expiresAt=Math.min(this.clock()+l.ttlMs,l.issuedAt+l.maxLifetimeMs);this.emit('lease-renewed',l.leaseId);return true;
  }
  listLiveLeases(): AuthorityLease[] {this.expireLeases();return [...this.leases.values()].filter(l=>l.live).map(frozen);}
  fenceWorker(workerId: string): void {identifier(workerId);this.revokeWorker(workerId,'manual-fence');}
  /** Trusted control-plane call only: incarnation is a fence, not authentication or proof of stop. */
  reconcileWorker(workerId: string, incarnation: number): boolean {
    identifier(workerId);integer(incarnation,0,Number.MAX_SAFE_INTEGER,'incarnation');
    const w=this.workers.get(workerId);if(!w||incarnation!==w.incarnation)return false;
    w.quarantined=false;this.emit('worker-reconciled',workerId);return true;
  }
  requeue(workloadId: string, expectedGeneration: number, requestId: string): boolean {
    identifier(workloadId); identifier(requestId);
    integer(expectedGeneration,0,Number.MAX_SAFE_INTEGER,'expected generation');
    const key=`${workloadId}#${requestId}`;
    const prior=this.requeueRequests.get(key);
    if(prior)return prior.generation===expectedGeneration&&prior.result;
    const w=this.workloads.get(workloadId);
    if(!w||w.generation!==expectedGeneration||w.status!=='open'||w.replayPolicy!=='retry-new-attempt')return false;
    const l=this.leases.get(this.liveByWorkload.get(`${workloadId}#${w.generation}`)??'');
    if(l?.live)this.revokeWorker(l.workerId,'manual-requeue');else this.advance(w,'manual-requeue');
    this.requeueRequests.set(key,{generation:expectedGeneration,result:true});return true;
  }
  cancel(workloadId: string): boolean {
    const w=this.workloads.get(workloadId);if(!w||w.status!=='open')return false;w.status='cancelled';
    const l=this.leases.get(this.liveByWorkload.get(`${workloadId}#${w.generation}`)??'');
    if(l?.live)this.revokeWorker(l.workerId,'workload-cancelled');this.emit('workload-cancelled',workloadId);return true;
  }
  complete(leaseId: string, capability: string, result: SubmittedResult, legacyPolicy?: VerificationPolicy): AuthorityResult {
    const validId=typeof leaseId==='string'&&leaseId.length<=64&&ID.test(leaseId);
    const l=validId?this.leases.get(leaseId):undefined;
    const reject=(reason:string):AuthorityResult=>{this.emit('result-rejected',`${l?.leaseId??'[unknown-lease]'} ${reason}`);return {accepted:false,reason};};
    if(!l)return reject('unknown-lease');
    if(l.capability!==capability)return reject('bad-capability');
    const w=this.workloads.get(l.workloadId),worker=this.workers.get(l.workerId);
    if(!w||!worker)return reject('unknown-refs');
    if(!result||typeof result!=='object'||typeof result.outcome!=='string'||result.outcome.length>32||
      typeof result.stdoutSha256!=='string'||result.stdoutSha256.length>64||
      (result.exitCode!==null&&(typeof result.exitCode!=='number'||!Number.isSafeInteger(result.exitCode)||result.exitCode<0||result.exitCode>255))||
      !Number.isSafeInteger(result.stdoutBytes)||result.stdoutBytes<0||result.stdoutBytes>4*1024*1024||
      (result.artifactRef!==undefined&&(typeof result.artifactRef!=='string'||!ID.test(result.artifactRef))))return reject('invalid-result');
    result=frozen({outcome:result.outcome,exitCode:result.exitCode,stdoutSha256:result.stdoutSha256,stdoutBytes:result.stdoutBytes,artifactRef:result.artifactRef});
    const submittedSha256=digest(JSON.stringify({outcome:result.outcome,exitCode:result.exitCode,
      stdoutSha256:result.stdoutSha256,stdoutBytes:result.stdoutBytes,artifactRef:result.artifactRef}));
    const receipt=this.completions.get(w.id);
    if(receipt){return receipt.leaseId===leaseId&&receipt.submittedSha256===submittedSha256&&!legacyPolicy?
      {accepted:true,reason:'committed'}:reject('workload-terminal');}
    const expired=l.live&&this.clock()>=l.expiresAt;this.expireLeases();
    if(expired)return reject('lease-expired');
    if(w.status!=='open')return reject('workload-terminal');if(!l.live)return reject('lease-not-live');
    if(l.generation!==w.generation)return reject('stale-generation');
    if(l.incarnation!==worker.incarnation||worker.quarantined)return reject('stale-incarnation');
    if(legacyPolicy)return reject('policy-override');
    const policy=w.verificationPolicy;if(!policy||!w.policySha256)return reject('unverified:no-bound-policy');
    if(!policy.stdoutSha256)return reject('unverified:no-content-policy');
    if(result.outcome!=='exited'||typeof result.exitCode!=='number'||!Number.isSafeInteger(result.exitCode)||result.exitCode<0||result.exitCode>255)return reject('unverified:outcome');
    if(!Number.isSafeInteger(result.stdoutBytes)||result.stdoutBytes<0||result.stdoutBytes>4*1024*1024||!SHA.test(result.stdoutSha256))return reject('unverified:metadata');
    if(typeof result.artifactRef!=='string'||!ID.test(result.artifactRef))return reject('unverified:artifact-reference');
    if(!this.verification)return reject('unverified:no-artifact-reader');
    let bytes: Uint8Array | null;
    try {const loaded=this.verification.readArtifact(result.artifactRef);bytes=loaded instanceof Uint8Array&&loaded.byteLength<=4*1024*1024?Uint8Array.from(loaded):null;}
    catch{return reject('unverified:artifact-read');}
    if(!bytes||bytes.byteLength>4*1024*1024)return reject('unverified:artifact-unavailable');
    const actual=digest(bytes);
    if(actual!==result.stdoutSha256||bytes.byteLength!==result.stdoutBytes)return reject('unverified:artifact-mismatch');
    if(policy.exitCode!==undefined&&result.exitCode!==policy.exitCode)return reject('unverified:exit-code');
    if(policy.stdoutSha256!==undefined&&actual!==policy.stdoutSha256)return reject('unverified:sha-mismatch');
    if(policy.minBytes!==undefined&&bytes.byteLength<policy.minBytes)return reject('unverified:too-few-bytes');
    // The injected reader is trusted but may re-enter. Re-check all mutable fences
    // after reading, before the one serial in-memory commit.
    this.expireLeases();
    if(w.status!=='open'||!l.live||w.generation!==l.generation||worker.quarantined||worker.incarnation!==l.incarnation)return reject('verification-fenced');
    const committed=frozen({workloadId:w.id,leaseId,generation:l.generation,incarnation:l.incarnation,
      artifactRef:result.artifactRef,artifactSha256:actual,bytes:bytes.byteLength,policySha256:w.policySha256,
      submittedSha256,verifiedAt:this.clock()});
    this.completions.set(w.id,committed);w.status='committed';w.winnerLeaseId=leaseId;this.closeLease(l);
    this.emit('result-committed',`${leaseId} gen=${l.generation} artifact=${actual}`);return {accepted:true,reason:'committed'};
  }
}
