import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { ComputeAuthority } from './authority.js';
const bytes = Buffer.from('verified disposable output');
const hash = createHash('sha256').update(bytes).digest('hex');
const policy = {kind:'cpu-job', exitCode:0, stdoutSha256:hash};
const result = {outcome:'exited', exitCode:0, stdoutSha256:hash, stdoutBytes:bytes.length, artifactRef:'staged-output'};
function setup(lifetime=1000) {
  let t=0;
  const auth=new ComputeAuthority(()=>t,lifetime,{readArtifact:(ref:string)=>ref==='staged-output'?bytes:null});
  auth.registerWorker('vps', 2, 'general');auth.registerWorker('mac', 1, 'general');
  auth.submitWorkload('job',1,'retry-new-attempt',3,policy);
  return {auth,time:(v:number)=>{t=v;}};
}
describe('merged-slice authority counterexamples',()=>{
 it('identical resubmission preserves committed identity and receipt; conflicting intent rejects',()=>{
  const {auth}=setup();const l=auth.claim('vps','job',0,'c')!;
  expect(auth.complete(l.leaseId,l.capability,result).accepted).toBe(true);
  const repeat=auth.submitWorkload('job',1,'retry-new-attempt',3,policy);
  expect(repeat.status).toBe('committed');expect(auth.claim('mac','job',0,'c2')).toBeNull();
  expect(()=>auth.submitWorkload('job',2,'retry-new-attempt',3,policy)).toThrow('conflict');
 });
 it('worker cannot replace intake policy or forge metadata without staged bytes',()=>{
  const {auth}=setup();const l=auth.claim('vps','job',0,'c')!;
  expect(auth.complete(l.leaseId,l.capability,result,{kind:'arbitrary',minBytes:0}).accepted).toBe(false);
  expect(auth.complete(l.leaseId,l.capability,{...result,artifactRef:'missing'}).accepted).toBe(false);
  expect(auth.complete(l.leaseId,l.capability,{...result,stdoutSha256:'forged'}).accepted).toBe(false);
  expect(auth.complete(l.leaseId,l.capability,result).accepted).toBe(true);
 });
 it('edge cannot execute and malformed numeric admission fails closed',()=>{
  const {auth}=setup();auth.registerWorker('pi',0,'edge');
  for(const n of [-1,0,NaN,Infinity,0.5])expect(()=>auth.submitWorkload('invalid',n)).toThrow();
  expect(auth.claim('pi','job',0,'c')).toBeNull();
  expect(()=>(auth.registerWorker as Function)('missing-class',1)).toThrow('class');
  expect(()=>auth.registerWorker('pi',1,'general')).toThrow();
 });
 it('expiry clears stale claim, requeues once, quarantines physical capacity, and audits',()=>{
  const {auth,time}=setup();const l=auth.claim('vps','job',0,'c',10)!;
  time(10);expect(auth.renew(l.leaseId,l.capability)).toBe(false);
  expect(auth.listLiveLeases()).toHaveLength(0);
  expect(auth.claim('vps','job',0,'c')).toBeNull();
  const replacement=auth.claim('mac','job',0,'c2');expect(replacement?.generation).toBe(1);
  expect(auth.complete(l.leaseId,l.capability,result).accepted).toBe(false);
  expect(auth.events.some(e=>e.startsWith('lease-expired'))).toBe(true);
 });
 it('initial lease and renewal are capped, including the exact expiry boundary',()=>{
  const {auth,time}=setup(100);const l=auth.claim('vps','job',0,'c',1000)!;
  expect(l.expiresAt).toBe(100);time(100);
  expect(auth.complete(l.leaseId,l.capability,result).accepted).toBe(false);
 });
 it('clock-only expiry is reaped before other claims without releasing unproven worker capacity',()=>{
  const {auth,time}=setup();auth.claim('vps','job',0,'c',10);time(11);
  auth.submitWorkload('other',1,'retry-new-attempt',3,policy);
  expect(auth.claim('vps','other',0,'c2')).toBeNull();
  expect(auth.claim('mac','job',0,'c3')?.generation).toBe(1);
 });
 it('completion receipt binds artifact/policy and duplicate delivery never creates another winner',()=>{
  const {auth}=setup();const l=auth.claim('vps','job',0,'c')!;
  const first=auth.complete(l.leaseId,l.capability,result);
  expect(auth.complete(l.leaseId,l.capability,result)).toEqual(first);
  const receipt=auth.getCompletion('job');expect(receipt?.artifactSha256).toBe(hash);
  expect(receipt?.artifactRef).toBe('staged-output');expect(receipt?.policySha256).toMatch(/^[a-f0-9]{64}$/);
  expect(auth.complete(l.leaseId,l.capability,{...result,stdoutBytes:1}).accepted).toBe(false);
  expect(auth.events.filter(e=>e.startsWith('result-committed'))).toHaveLength(1);
 });
});

describe('reference vector reservations',()=>{
 it('atomically checks CPU, RAM and individual accelerator devices, not only slots',()=>{
  const a=new ComputeAuthority(()=>0);
  a.registerWorker('gpu',4,'general',{cpuCores:4,ramMib:4096,gpus:[{id:'cuda0',kind:'cuda',vramMib:8192},{id:'metal0',kind:'metal',vramMib:8192}]});
  const needs={cpuCores:1,ramMib:3000,gpu:{kind:'cuda' as const,minVramMib:4000}};
  a.submitWorkload('one',1,'retry-new-attempt',3,policy,needs);
  a.submitWorkload('two',1,'retry-new-attempt',3,policy,needs);
  const l=a.claim('gpu','one',0,'c1')!;expect(l.reservation.gpuIds).toEqual(['cuda0']);
  expect(a.claim('gpu','two',0,'c2')).toBeNull();
 });
 it('does not pool GPU memory or mix accelerator kinds',()=>{
  const a=new ComputeAuthority(()=>0);
  a.registerWorker('gpu',2,'general',{cpuCores:2,ramMib:8192,gpus:[{id:'a',kind:'cuda',vramMib:4096},{id:'b',kind:'cuda',vramMib:4096}]});
  a.submitWorkload('large',1,'retry-new-attempt',3,policy,{cpuCores:1,ramMib:1,gpu:{kind:'cuda',minVramMib:8192}});
  expect(a.claim('gpu','large',0,'c1')).toBeNull();
  a.submitWorkload('metal',1,'retry-new-attempt',3,policy,{cpuCores:1,ramMib:1,gpu:{kind:'metal',minVramMib:1}});
  expect(a.claim('gpu','metal',0,'c2')).toBeNull();
 });
});

describe('verification trust boundary and audit coupling',()=>{
 it('does not allow a self-consistent hash when the registered expected output differs',()=>{
  const wrong=Buffer.from('different');
  const a=new ComputeAuthority(()=>0,100,{readArtifact:()=>wrong});a.registerWorker('w',1,'general');
  a.submitWorkload('j',1,'retry-new-attempt',3,policy);const l=a.claim('w','j',0,'c')!;
  expect(a.complete(l.leaseId,l.capability,{...result,stdoutSha256:createHash('sha256').update(wrong).digest('hex'),stdoutBytes:wrong.length}).accepted).toBe(false);
  expect(a.getCompletion('j')).toBeNull();
  expect(a.audit.all().at(-1)?.kind).toBe('result-rejected');
 });
 it('rechecks fences after trusted artifact reading and records one coupled commit event',()=>{
  let a:ComputeAuthority;
  a=new ComputeAuthority(()=>0,100,{readArtifact:()=>{a.cancel('j');return bytes;}});
  a.registerWorker('w',1,'general');a.submitWorkload('j',1,'retry-new-attempt',3,policy);
  const l=a.claim('w','j',0,'c')!;
  expect(a.complete(l.leaseId,l.capability,result).accepted).toBe(false);
  expect(a.getCompletion('j')).toBeNull();
 });
 it('fails closed without a bound content expectation or independently authorized reader',()=>{
  const a=new ComputeAuthority(()=>0);a.registerWorker('w',1,'general');
  a.submitWorkload('j',1,'retry-new-attempt',3,policy);const l=a.claim('w','j',0,'c')!;
  expect(a.complete(l.leaseId,l.capability,result).reason).toBe('unverified:no-artifact-reader');
  const b=new ComputeAuthority(()=>0,100,{readArtifact:()=>bytes});b.registerWorker('w',1,'general');
  expect(()=>b.submitWorkload('j',1,'retry-new-attempt',3,{kind:'cpu-job',exitCode:0})).toThrow('content policy');
  expect(()=>b.submitWorkload('j',1)).toThrow('content policy');
  expect(b.claim('w','j',0,'c')).toBeNull();
 });
 it('does not reopen exhausted attempts during expiry recovery',()=>{
  let t=0;const a=new ComputeAuthority(()=>t,10);a.registerWorker('w',1,'general');
  a.submitWorkload('j',1,'retry-new-attempt',1,policy);a.claim('w','j',0,'c');t=10;a.expireLeases();
  expect(a.getWorkload('j')?.status).toBe('failed');expect(a.requeue('j', 0, "test-requeue")).toBe(false);
 });
});

describe('runtime schema rejects malformed native inputs',()=>{
 it('rejects sparse devices and malformed optional GPU requirements at intake',()=>{
  const {auth}=setup();
  expect(()=>auth.registerWorker('bad',1,'general',{cpuCores:1,ramMib:0,gpus:Array(1)})).toThrow();
  for(const gpu of [null,false,0,'']) expect(()=>auth.submitWorkload('bad',1,'retry-new-attempt',3,policy,{cpuCores:1,ramMib:0,gpu} as never)).toThrow();
 });
 it('returns a structured rejection for nonprimitive exit codes before serialization',()=>{
  const {auth}=setup();const l=auth.claim('vps','job',0,'c')!;
  for(const exitCode of [1n,()=>0,{},Infinity,NaN,-1,0.1]) expect(auth.complete(l.leaseId,l.capability,{...result,exitCode} as never).accepted).toBe(false);
 });
});

describe('reviewed recovery and redelivery journeys',()=>{
 it('delayed requeue replay cannot fence a replacement or fail its colocated job',()=>{
  const {auth}=setup();auth.registerWorker('mac',2,'general');
  auth.claim('vps','job',0,'c1');expect(auth.requeue('job',0,'retry-1')).toBe(true);
  const replacement=auth.claim('mac','job',0,'c2')!;
  auth.submitWorkload('unrelated',1,'fail',1,policy);auth.claim('mac','unrelated',0,'c3');
  expect(auth.requeue('job',0,'retry-1')).toBe(true);
  expect(auth.requeue('job',0,'different-request')).toBe(false);
  expect(auth.listLiveLeases()).toHaveLength(2);
  expect(auth.listLiveLeases().some(l=>l.leaseId===replacement.leaseId)).toBe(true);
  expect(auth.getWorkload('unrelated')?.status).toBe('open');
 });
 it('agent resumes only after trusted stop reconciliation refreshes its incarnation',async()=>{
  const {OutboundAgent}=await import('./agent.js');const {auth,time}=setup();
  const agent=new OutboundAgent(auth,'vps',0);agent.claim('job','c1');time(1000);
  expect(agent.renew()).toBe(false);expect(agent.reconcileAfterStop(0)).toBe(false);
  expect(agent.reconcileAfterStop(1)).toBe(true);expect(agent.claim('job','c2')?.incarnation).toBe(1);
 });
 it('snapshot watermark includes expiry caused by that snapshot and rejects unrelated audit',async()=>{
  const {snapshotFor}=await import('./dashboard.js');const {WorkerRegistry}=await import('./registry.js');
  const {AuditLog}=await import('./verifier.js');const {auth,time}=setup();
  auth.claim('vps','job',0,'c1',10);time(10);const snap=snapshotFor(auth,new WorkerRegistry());
  expect(snap.liveLeases).toHaveLength(0);expect(snap.watermark.pendingOutbox).toBe(auth.audit.pendingOutbox);
  expect(snap.recentEvents.some(e=>e.kind==='lease-expired')).toBe(true);
  expect(()=>snapshotFor(auth,new WorkerRegistry(),new AuditLog())).toThrow('authority audit');
 });
});

describe('bounded audit and batch expiry',()=>{
 it('never retains unknown worker-supplied lease identifier text in audit',()=>{
  const {auth}=setup();
  expect(auth.complete('x'.repeat(1024*1024),'',result).reason).toBe('unknown-lease');
  expect(auth.audit.all().at(-1)!.detail.length).toBeLessThan(128);
  expect(auth.events.at(-1)!.length).toBeLessThan(128);
 });
 it('batch expiry visits lease history a constant number of times across many workers',()=>{
  let t=0;const a=new ComputeAuthority(()=>t,10);
  for(let i=0;i<64;i++){a.registerWorker(`w${i}`,1,'general');a.submitWorkload(`j${i}`,1,'retry-new-attempt',3,policy);a.claim(`w${i}`,`j${i}`,0,`c${i}`);}
  const leases=(a as unknown as {leases:Map<string,unknown>}).leases;
  const values=leases.values.bind(leases);let visits=0;
  leases.values=function*(){for(const lease of values()){visits++;yield lease;}} as typeof leases.values;
  t=10;expect(a.expireLeases()).toBe(64);expect(visits).toBeLessThanOrEqual(128);
 });
 it('quarantine remains visible after its initial fence event leaves the recent event window',async()=>{
  const {snapshotFor}=await import('./dashboard.js');const {WorkerRegistry}=await import('./registry.js');
  const {auth,time}=setup();auth.claim('vps','job',0,'c1',10);time(10);auth.expireLeases();
  for(let i=0;i<60;i++)auth.submitWorkload(`event${i}`,1,'retry-new-attempt',3,policy);
  const snap=snapshotFor(auth,new WorkerRegistry());
  expect(snap.workers.find(w=>w.workerId==='vps')).toMatchObject({incarnation:1,quarantined:true,reconciliation:'required'});
  expect(auth.claim('vps','job',1,'c2')).toBeNull();
 });
});
