import {DatabaseSync} from 'node:sqlite';
import {readdir} from 'node:fs/promises';
import {boundedStep,type JournalState,type HostPorts} from '../../../packages/worker-client/src/index';
import {validateProfile,profileDigest} from '../../../packages/worker-runtime/src/index';
import {decodeContractLog} from '../../../packages/stacks-events/src/index';
import {planEventJob,executeEventSummary} from '../../../packages/epoch-jobs/src/index';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe,it,expect} from 'vitest';
import {localRuntime} from '../test-support/runtime';
const token=(name:string)=>'fixture-enrollment-'+name+'-00000000000000000000000000000000';
const approvedHash=()=>profileDigest(validateProfile({image:'local/vetted@sha256:'+'a'.repeat(64),cpu:1,ramMib:64,pids:16,tmpMib:4,maxOutputBytes:4096,timeoutMs:100},['local/vetted@sha256:'+'a'.repeat(64)]));
const digest=(name:string)=>createHash('sha256').update(token(name)).digest('hex');
const config=['owner','verifier','executor'].map(role=>({tokenSha256:digest(role),principal:role,role,environment:'enrolled'}));
const fixture=`
import entry from './workers/compute/src/index.ts';
import {ComputeAuthority} from './workers/compute/src/authority.ts';
const cfg={COMPUTE_ENVIRONMENT:'enrolled',COMPUTE_ISSUER_ID:'fixture-issuer',COMPUTE_ISSUER_KEY:'fixture-issuer-key-00000000000000000000000',COMPUTE_AUTHORITY_NAME:'enrolled',COMPUTE_AUTH_CONFIG:${JSON.stringify(JSON.stringify(config))},COMPUTE_TRANSPORT_ENABLED:'true',COMPUTE_ENROLLMENT_ENABLED:'true',COMPUTE_EXECUTION_IMAGES:JSON.stringify(['local/vetted@sha256:'+'a'.repeat(64)])};
export class TestFabricAuthority extends ComputeAuthority{
 constructor(ctx,env){let fail=false,clock=Date.now();const state={id:ctx.id,storage:{sql:{exec:(q,...b)=>{const r=ctx.storage.sql.exec(q,...b);if(fail&&q.startsWith('INSERT INTO outbox')){fail=false;throw Error('fixture SQL fault');}return r;}},transactionSync:fn=>ctx.storage.transactionSync(fn)}};super(state,{...env,...cfg},{now:()=>clock});this.advance=ms=>{clock+=ms;return clock;};this.arm=()=>{fail=true;};this.storageFixture=ctx.storage;}
 async fetch(r){
 const path=new URL(r.url).pathname;
 if(path==='/__breakSchema'){
  const b=await r.json();
  if(b.kind==='missing-meta')this.storageFixture.sql.exec('DROP TABLE compute_fleet_meta');
  else if(b.kind==='partial')this.storageFixture.sql.exec('DROP TABLE compute_worker_poll_heads');
  else {this.storageFixture.sql.exec('DROP TRIGGER compute_fleet_binding');if(b.kind==='version')this.storageFixture.sql.exec('UPDATE compute_fleet_meta SET schema_version=99');if(b.kind==='environment')this.storageFixture.sql.exec("UPDATE compute_fleet_meta SET environment='wrong'");if(b.kind==='authority')this.storageFixture.sql.exec("UPDATE compute_fleet_meta SET authority='wrong'");}
  return Response.json({ok:true});
 }
 if(path==='/__advance'){const b=await r.json();return Response.json({now:this.advance(b.ms)});}
 if(path==='/__expire'){this.storageFixture.sql.exec("UPDATE leases SET expires_ms=0 WHERE state='RUNNING'");return Response.json({ok:true});}
 if(path==='/__fillHeads'){for(let n=1;n<4096;n++)this.storageFixture.sql.exec("INSERT INTO compute_worker_poll_heads VALUES(?,1,1,'','fixture','fixture','{}')",'historical-'+n);return Response.json({ok:true});}
 if(path==='/__poisonQueue'){
  for(let n=0;n<100;n++)this.storageFixture.sql.exec("INSERT INTO workloads(id,principal,specification,spec_hash,policy_hash,expected_hash,max_bytes,exit_code,cpu,ram_mib,gpu_kind,gpu_vram,pure,reconstructible,max_attempts,status) SELECT ?,principal,?,spec_hash,policy_hash,expected_hash,max_bytes,exit_code,cpu,ram_mib,gpu_kind,gpu_vram,pure,reconstructible,max_attempts,'QUEUED' FROM workloads WHERE id='event-job'",'aaa-'+String(n).padStart(3,'0'),JSON.stringify({template:'epoch-event-summary-v1'}));
  return Response.json({ok:true});
 }
 if(path==='/__held')return Response.json({held:!!this.release});
 if(path==='/__release'){this.release?.();this.release=null;return Response.json({ok:true});}
 if(path==='/__pollCount')return Response.json({count:this.storageFixture.sql.exec('SELECT count(*) n FROM compute_worker_poll_heads').one().n});
 if(path==='/__slow'){
  const input=await r.json();const self=this;
  const stream=new ReadableStream({start(c){self.release=()=>{c.enqueue(new TextEncoder().encode(JSON.stringify(input.body)));c.close();};}});
  return super.fetch(new Request('https://fixture.test'+input.path,{method:'POST',headers:r.headers,body:stream}));
 }
 if(new URL(r.url).pathname==='/__fault'){this.arm();return Response.json({ok:true});}return super.fetch(r);}
}
export default{fetch(r,env){return entry.fetch(r,{...env,...cfg});}};
`;
async function using(run:(h:any)=>Promise<void>,script=fixture){
 const dir=await mkdtemp(join(tmpdir(),'foundry-enrollment-'));let runtime=await localRuntime(script,dir,'enrollment');let key=0;
 const req=async(path:string,body:any,who='owner')=>{const r=await runtime.dispatchFetch('https://fixture.test'+path,{method:'POST',headers:{authorization:'Bearer '+token(who),'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json() as any};};
 const cmd=async(op:string,body:any,who='owner',id='cmd-'+(++key))=>(await req('/v1/commands',{expectedEpoch:1,command:{operation:op,key:id,body}},who));
 const enroll=async(id='mac',who='mac',extra={})=>{
  const body={key:'enroll-'+id,...identity(id,who),tokenSha256:digest(who),expiresAt:Date.now()+3600000,expectedRevision:0,incarnation:0,...extra};
  const result=await req('/v1/enrollment/enroll',{expectedEpoch:1,request:body});
  if(result.body.ok&&body.workerClass==='general')await req('/v1/enrollment/profile',{expectedEpoch:1,request:{workerId:id,revision:result.body.status.revision,profile:{image:'local/vetted@sha256:'+'a'.repeat(64),cpu:1,ramMib:64,pids:16,tmpMib:4,maxOutputBytes:4096,timeoutMs:100}}});
  return result;
 };
 const beat=async(id='mac',who='mac',extra={})=>req('/v1/enrollment/heartbeat',{expectedEpoch:1,request:{key:'beat-'+(++key),sequence:1,observedIdentity:identity(id,who),...extra}},who);
 try{await run({req,cmd,enroll,beat,hostFetch:async(url:any,init:any)=>runtime.dispatchFetch(String(url),init),evidence:async()=>{
  await runtime.dispose();let proof:any=null;
  for(const file of await readdir(dir,{recursive:true})){if(!file.endsWith('.sqlite'))continue;const db=new DatabaseSync(join(dir,file),{readOnly:true});try{if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='enrollment_workers'").get())continue;
   proof={workers:db.prepare('SELECT worker_id,principal,identity FROM enrollment_workers ORDER BY worker_id').all(),events:createHash('sha256').update(JSON.stringify(db.prepare('SELECT * FROM enrollment_events ORDER BY seq').all())).digest('hex'),profiles:createHash('sha256').update(JSON.stringify(db.prepare('SELECT * FROM compute_worker_profiles ORDER BY worker_id,revision').all())).digest('hex')};
  }finally{db.close();}}
  runtime=await localRuntime(script,dir,'enrollment');if(!proof)throw Error('fixture SQLite evidence not found');return proof;
 },restart:async(next=script)=>{await runtime.dispose();script=next;runtime=await localRuntime(script,dir,'enrollment');}});}finally{await runtime.dispose();await rm(dir,{recursive:true,force:true});}
}
const identity=(workerId='mac',principal='mac')=>({workerId,principal,workerClass:'general' as const,cpu:1,ramMib:128,devices:[]});
const submit={workloadId:'job',specification:'fixed-fixture-summary',resources:{cpu:1,ramMib:64},policy:{sha256:createHash('sha256').update('ok').digest('hex'),maxBytes:100,exitCode:0},pure:true,reconstructible:true,maxAttempts:3};
async function start(h:any){await h.cmd('setQuota',{principal:'owner',maxActive:5,allowedClass:'general'});expect((await h.enroll()).body.ok).toBe(true);expect((await h.beat()).body.ok).toBe(true);await h.cmd('submit',eventJob().submitBody);return h.req('/v1/worker/poll',{expectedEpoch:1,request:{key:'start',sequence:1,ttlMs:30000,profileHash:approvedHash()}},'mac');}
describe('managed worker enrollment actual workerd/HTTP',()=>{
 it('enrolls immutable worker, requires heartbeat, scopes credentials and persists restart',()=>using(async h=>{
  expect((await h.enroll()).status).toBe(200);
  expect((await h.cmd('claim',{workloadId:'job',workerId:'mac',expectedGeneration:0,incarnation:0,ttlMs:30000},'mac')).body.code).toBe('heartbeat-stale');
  expect((await h.beat()).body.status.freshness).toBe('fresh');await h.restart();
  const status=await h.req('/v1/enrollment/status',{expectedEpoch:1,request:{afterWorkerId:null,limit:10}});
  expect(status.body.workers[0]).toMatchObject({workerId:'mac',revision:1,freshness:'fresh'});
  expect((await h.cmd('claim',{workloadId:'job',workerId:'other',expectedGeneration:0,incarnation:0,ttlMs:30000},'mac')).status).toBe(403);
  expect((await h.req('/v1/enrollment/status',{expectedEpoch:1,request:{afterWorkerId:null,limit:10}},'mac')).status).toBe(403);
  expect((await h.cmd('registerWorker',identity())).status).toBe(403);
  expect((await h.cmd('claim',{workloadId:'job',workerId:'mac',expectedGeneration:0,incarnation:0,ttlMs:30000},'executor')).status).toBe(401);
 }));
 it('revocation fences active lease and retains resources; old credential cannot replay after restart',()=>using(async h=>{
  const started=await start(h);expect(started.body.ok).toBe(true);const l=started.body.lease;
  const request={expectedEpoch:1,request:{key:'revoke',workerId:'mac',revision:1}};
  expect((await h.req('/v1/enrollment/revoke',request)).body.status.revokedAt).not.toBeNull();await h.restart();
  expect((await h.beat()).status).toBe(401);
  expect((await h.req('/v1/artifacts',{expectedEpoch:1,key:'late',fence:{leaseId:l.id,epoch:l.epoch,generation:l.generation,incarnation:l.incarnation,capability:l.capability},bytesBase64:'b2s=',exitCode:0},'mac')).status).toBe(401);
  const snap=(await h.req('/v1/snapshot',{expectedEpoch:1})).body;
  expect(snap.workers[0]).toMatchObject({incarnation:1,quarantined:1});expect(snap.reservations[0].state).toBe('quarantined');expect(snap.leases[0].state).toBe('REVOKED');
  expect((await h.req('/v1/enrollment/revoke',request)).body.replayed).toBe(true);
  expect((await h.enroll('mac','mac',{key:'next',tokenSha256:digest('mac-next'),expectedRevision:1,incarnation:1})).body.ok).toBe(true);
  expect((await h.req('/v1/enrollment/revoke',request)).body.replayed).toBe(true);
  expect((await h.req('/v1/snapshot',{expectedEpoch:1})).body.workers[0].incarnation).toBe(1);
 }));
 it('atomically rolls enrollment and revocation back on compute audit fault',()=>using(async h=>{
  await h.req('/__fault',{});expect((await h.enroll()).status).toBe(503);
  expect((await h.req('/v1/enrollment/status',{expectedEpoch:1,request:{afterWorkerId:null,limit:10}})).body.workers).toHaveLength(0);
  await start(h);await h.req('/__fault',{});
  expect((await h.req('/v1/enrollment/revoke',{expectedEpoch:1,request:{key:'fail-revoke',workerId:'mac',revision:1}})).status).toBe(503);
  expect((await h.req('/v1/snapshot',{expectedEpoch:1})).body.workers[0]).toMatchObject({incarnation:0,quarantined:0});
  expect((await h.req('/v1/enrollment/status',{expectedEpoch:1,request:{afterWorkerId:null,limit:10}})).body.workers[0].revokedAt).toBeNull();
 }));
 it('enforces heartbeat-only edge class and rejects owner credential reuse and stale epoch',()=>using(async h=>{
  expect((await h.enroll('edge','edge',{workerClass:'edge',cpu:0,ramMib:0})).body.ok).toBe(true);
  expect((await h.beat('edge','edge',{observedIdentity:{...identity('edge','edge'),workerClass:'edge',cpu:0,ramMib:0}})).body.ok).toBe(true);
  expect((await h.enroll('bad','bad',{workerClass:'edge',cpu:1})).status).toBe(409);
  expect((await h.enroll('owner-reuse','owner')).body.code).toBe('credential-role-conflict');
  expect((await h.req('/v1/enrollment/status',{expectedEpoch:2,request:{afterWorkerId:null,limit:10}})).status).toBe(409);
  expect((await h.beat('edge','edge',{sequence:2,observedIdentity:identity('edge','edge')})).body.code).toBe('observed-identity-mismatch');
 }));
});

function eventJob(workloadId='event-job',ramMib:64|128=64){
 const contract='ST000000000000000000002AMW42H.epoch';
 const block={index_block_hash:'0x'+'a'.repeat(64),hash:'0x'+'b'.repeat(64),parent_index_block_hash:'0x'+'c'.repeat(64),parent_block_hash:'0x'+'d'.repeat(64),height:12,burn_block_hash:'0x'+'e'.repeat(64),burn_block_height:5,tenure_height:3,canonical:true};
 const tx={tx_id:'0x'+'f'.repeat(64),block_hash:block.hash,parent_block_hash:block.parent_block_hash,block_height:12,tx_status:'success',is_unanchored:false,microblock_hash:'',canonical:true,microblock_canonical:true,event_count:1,events:[{event_index:0,tx_id:'0x'+'f'.repeat(64),event_type:'smart_contract_log',contract_log:{contract_id:contract,topic:'print',value:{hex:'0x0102',repr:'u1'}}}]};
 const event=decodeContractLog({block,transaction:tx,eventIndex:0},{network:'stacks-testnet',allowedContracts:[contract]});
 const scope={environment:'enrolled',authorityId:'fixture',sourceId:'hiro',network:'stacks-testnet' as const};
 return planEventJob({...scope,workloadId},JSON.stringify([scope.sourceId,event.network,event.blockHash,event.transactionId,event.eventIndex]),event,1,{...scope,profile:'hiro-nakamoto-contract-log/v1',allowedContracts:[contract],ramMib,maxOutputBytes:4096});
}
describe('managed worker recoverable polling',()=>{
 it('polls exact approved job once across restart, seals bytes and independently verifies',()=>using(async h=>{
  await h.cmd('setQuota',{principal:'owner',maxActive:5,allowedClass:'general'});await h.enroll();await h.beat();
  const job=eventJob();expect((await h.cmd('submit',job.submitBody)).body.ok).toBe(true);
  const request={expectedEpoch:1,request:{key:'poll-1',sequence:1,ttlMs:30000,profileHash:approvedHash()}};
  const first=await h.req('/v1/worker/poll',request,'mac');expect(first.body.kind).toBe('work');await h.restart();
  expect((await h.req('/v1/worker/poll',request,'mac')).body).toEqual(first.body);
  expect((await h.req('/v1/snapshot',{expectedEpoch:1})).body.leases).toHaveLength(1);
  const l=first.body.lease;const fence={leaseId:l.id,epoch:l.epoch,generation:l.generation,incarnation:l.incarnation,capability:l.capability};
  const bytes=executeEventSummary(first.body.workload.specification);
  expect((await h.req('/v1/artifacts',{expectedEpoch:1,key:'poll-output',fence,bytesBase64:Buffer.from(bytes).toString('base64'),exitCode:0},'mac')).body.ok).toBe(true);
  expect((await h.req('/v1/verify',{expectedEpoch:1,request:{key:'poll-verify',leaseId:l.id,epoch:l.epoch,generation:l.generation,incarnation:l.incarnation}},'verifier')).body.ok).toBe(true);
  expect((await h.req('/v1/snapshot',{expectedEpoch:1})).body.receipts).toHaveLength(1);
 }));
 it('requires monotonic per-credential poll sequence and bounds idle state without starving another worker',()=>using(async h=>{
  await h.enroll();await h.beat();
  for(let sequence=1;sequence<=60;sequence++)expect((await h.req('/v1/worker/poll',{expectedEpoch:1,request:{key:'idle-'+sequence,sequence,ttlMs:30000,profileHash:approvedHash()}},'mac')).body.kind).toBe('idle');
  expect((await h.req('/v1/worker/poll',{expectedEpoch:1,request:{key:'old',sequence:1,ttlMs:30000,profileHash:approvedHash()}},'mac')).status).toBe(409);
  expect((await h.req('/v1/worker/poll',{expectedEpoch:1,request:{key:'changed',sequence:60,ttlMs:30000,profileHash:approvedHash()}},'mac')).status).toBe(409);
  expect((await h.req('/__pollCount',{})).body.count).toBe(1);
  await h.enroll('mac2','mac2');await h.beat('mac2','mac2');
  expect((await h.req('/v1/worker/poll',{expectedEpoch:1,request:{key:'other',sequence:1,ttlMs:30000,profileHash:approvedHash()}},'mac2')).body.kind).toBe('idle');
  await h.restart();expect((await h.req('/v1/worker/poll',{expectedEpoch:1,request:{key:'idle-60',sequence:60,ttlMs:30000,profileHash:approvedHash()}},'mac')).body.kind).toBe('idle');
 }));
});

describe('body-stream revocation race',()=>{
 it('reauthenticates an executor after the awaited body before heartbeat mutation',()=>using(async h=>{
  await h.enroll();await h.beat();
  const pending=h.req('/__slow',{path:'/v1/enrollment/heartbeat',body:{expectedEpoch:1,request:{key:'held-beat',sequence:2,observedIdentity:identity()}}},'mac');
  let held=false;for(let n=0;n<20;n++){if((await h.req('/__held',{})).body.held){held=true;break;}}
  expect(held).toBe(true);
  expect((await h.req('/v1/enrollment/revoke',{expectedEpoch:1,request:{key:'revoke-during-read',workerId:'mac',revision:1}})).body.ok).toBe(true);
  await h.req('/__release',{});expect((await pending).status).toBe(401);
 }));
});

describe('poll admission review counterexamples',()=>{
 it('commits credential revoke when its active lease has just expired',()=>using(async h=>{await start(h);await h.req('/__expire',{});expect((await h.req('/v1/enrollment/revoke',{expectedEpoch:1,request:{key:'expired-revoke',workerId:'mac',revision:1}})).body.applied).toBe(true);expect((await h.beat()).status).toBe(401);expect((await h.req('/v1/snapshot',{expectedEpoch:1})).body.workers[0].incarnation).toBe(1);}));
 it('continues existing polling at full historical-head capacity',()=>using(async h=>{await h.enroll();await h.beat();expect((await h.req('/v1/worker/poll',{expectedEpoch:1,request:{key:'one',sequence:1,ttlMs:30000,profileHash:approvedHash()}},'mac')).body.kind).toBe('idle');await h.req('/__fillHeads',{});expect((await h.req('/v1/worker/poll',{expectedEpoch:1,request:{key:'two',sequence:2,ttlMs:30000,profileHash:approvedHash()}},'mac')).body.kind).toBe('idle');expect((await h.req('/__pollCount',{})).body.count).toBe(4096);}));
 it('rotates past100 invalid summaries to later valid queued work',()=>using(async h=>{await h.cmd('setQuota',{principal:'owner',maxActive:5,allowedClass:'general'});await h.enroll();await h.beat();await h.cmd('submit',eventJob().submitBody);await h.req('/__poisonQueue',{});expect((await h.req('/v1/worker/poll',{expectedEpoch:1,request:{key:'scan-one',sequence:1,ttlMs:30000,profileHash:approvedHash()}},'mac')).body.kind).toBe('idle');expect((await h.req('/v1/worker/poll',{expectedEpoch:1,request:{key:'scan-two',sequence:2,ttlMs:30000,profileHash:approvedHash()}},'mac')).body.kind).toBe('work');}));
 it('rejects quarantined successor before attempting speculative claims',()=>using(async h=>{await start(h);await h.req('/v1/enrollment/revoke',{expectedEpoch:1,request:{key:'revoke-current',workerId:'mac',revision:1}});await h.enroll('mac','mac',{key:'next-after-revoke',tokenSha256:digest('next'),expectedRevision:1,incarnation:1});await h.beat('mac','next',{observedIdentity:identity()});expect((await h.req('/v1/worker/poll',{expectedEpoch:1,request:{key:'must-not-scan',sequence:1,ttlMs:30000,profileHash:approvedHash()}},'next')).body.code).toBe('worker-quarantined');}));
});

describe('actual bounded host client against managed authority',()=>{
 it('recovers a lost heartbeat reply after liveness expires without changing pending poll identity',()=>using(async h=>{
  await h.enroll();let state:JournalState|null=null;let lost=true;let now=Date.now();
  const image='local/vetted@sha256:'+'a'.repeat(64);
  const profile=validateProfile({image,cpu:1,ramMib:64,pids:16,tmpMib:4,maxOutputBytes:4096,timeoutMs:100},[image]);
  const config={origin:'https://fixture.test',credentialReference:'fixture-reference',environment:'enrolled',authorityId:'compute',identity:identity(),expectedEpoch:1,revision:1,incarnation:0,stepKey:'recover-liveness',profile,ttlMs:60000,httpDeadlineMs:5000};
  const ports:HostPorts={now:()=>now,credential:async()=>token('mac'),journal:{exclusive:async fn=>fn({load:async()=>structuredClone(state),save:async s=>{state=structuredClone(s);}})},runtime:{runBoundedJob:async()=>{throw Error('idle must not execute');}},fetch:async(url,init)=>{const response=await h.hostFetch(url,init);if(lost&&String(url).endsWith('/heartbeat')){lost=false;throw Error('lost fixture response');}return response;}};
  const first=await boundedStep(config,ports);expect(first.kind).toBe('retry');
  const advanced=await h.req('/__advance',{ms:90000});now=advanced.body.now;
  const second=await boundedStep(config,ports);expect(second.kind).toBe('idle');
  const status=(await h.req('/v1/enrollment/status',{expectedEpoch:1,request:{afterWorkerId:null,limit:10}})).body.workers[0];
  expect(status.sequence).toBe(2);expect(status.freshness).toBe('fresh');
 }));
});

describe('approved profile before dispatch',()=>{
 it('skips a valid incompatible size and drives matching job through actual client and sealed verification',()=>using(async h=>{
  await h.cmd('setQuota',{principal:'owner',maxActive:5,allowedClass:'general'});await h.enroll();
  await h.cmd('submit',eventJob('aaa-incompatible',128).submitBody);await h.cmd('submit',eventJob().submitBody);
  const image='local/vetted@sha256:'+'a'.repeat(64),profile=validateProfile({image,cpu:1,ramMib:64,pids:16,tmpMib:4,maxOutputBytes:4096,timeoutMs:100},[image]);
  let state:JournalState|null=null,runs=0;
  const ports:HostPorts={credential:async()=>token('mac'),fetch:h.hostFetch,journal:{exclusive:async fn=>fn({load:async()=>structuredClone(state),save:async s=>{state=structuredClone(s);}})},runtime:{runBoundedJob:async plan=>{runs++;return {outcome:'completed',output:executeEventSummary(plan.specification),stop:{identity:plan.identity,containerId:'b'.repeat(64),stopped:true,reason:'inspect-stopped'}};}}};
  const config={origin:'https://fixture.test',credentialReference:'fixture-reference',environment:'enrolled',authorityId:'compute',identity:identity(),expectedEpoch:1,revision:1,incarnation:0,stepKey:'matching-profile',profile,ttlMs:60000,httpDeadlineMs:5000};
  expect((await boundedStep(config,ports)).kind).toBe('uploaded');expect(runs).toBe(1);
  const snap=(await h.req('/v1/snapshot',{expectedEpoch:1})).body;
  expect(snap.workloads.find((w:any)=>w.id==='aaa-incompatible').status).toBe('QUEUED');expect(snap.leases).toHaveLength(1);
  const l=snap.leases[0];expect(l.workload_id).toBe('event-job');
  expect((await h.req('/v1/verify',{expectedEpoch:1,request:{key:'client-profile-verify',leaseId:l.id,epoch:l.epoch,generation:l.generation,incarnation:l.incarnation}},'verifier')).body.ok).toBe(true);
 }));
 it('does not claim without an approved profile and limits profile authority to owner and host image allowlist',()=>using(async h=>{
  const raw={key:'no-profile',...identity(),tokenSha256:digest('mac'),expiresAt:Date.now()+3600000,expectedRevision:0,incarnation:0};
  await h.req('/v1/enrollment/enroll',{expectedEpoch:1,request:raw});await h.beat();
  expect((await h.req('/v1/worker/poll',{expectedEpoch:1,request:{key:'missing-profile',sequence:1,ttlMs:30000,profileHash:approvedHash()}},'mac')).body).toMatchObject({kind:'idle',reason:'execution-profile-required'});
  const profile={image:'local/unapproved@sha256:'+'b'.repeat(64),cpu:1,ramMib:64,pids:16,tmpMib:4,maxOutputBytes:4096,timeoutMs:100};
  expect((await h.req('/v1/enrollment/profile',{expectedEpoch:1,request:{workerId:'mac',revision:1,profile}},'mac')).status).toBe(403);
  expect((await h.req('/v1/enrollment/profile',{expectedEpoch:1,request:{workerId:'mac',revision:1,profile}})).status).toBe(400);
 }));
});

describe('pre-claim admission and persistent fleet binding',()=>{
 it('denies direct claims and wrong local profile/runway before creating attempts',()=>using(async h=>{
  await h.cmd('setQuota',{principal:'owner',maxActive:5,allowedClass:'general'});await h.enroll();await h.beat();await h.cmd('submit',eventJob().submitBody);
  expect((await h.cmd('claim',{workloadId:'event-job',workerId:'mac',expectedGeneration:0,incarnation:0,ttlMs:30000},'mac')).body.code).toBe('approved-poll-required');
  const wrong=profileDigest(validateProfile({image:'local/vetted@sha256:'+'a'.repeat(64),cpu:1,ramMib:128,pids:16,tmpMib:4,maxOutputBytes:4096,timeoutMs:100},['local/vetted@sha256:'+'a'.repeat(64)]));
  expect((await h.req('/v1/worker/poll',{expectedEpoch:1,request:{key:'wrong-local',sequence:1,ttlMs:30000,profileHash:wrong}},'mac')).body.code).toBe('execution-profile-mismatch');
  expect((await h.req('/v1/worker/poll',{expectedEpoch:1,request:{key:'short',sequence:1,ttlMs:1000,profileHash:approvedHash()}},'mac')).body.code).toBe('lease-runway');
  const snap=(await h.req('/v1/snapshot',{expectedEpoch:1})).body;expect(snap.leases).toHaveLength(0);expect(snap.attempts).toHaveLength(0);expect(snap.reservations).toHaveLength(0);
 }));
 it.each(['missing-meta','partial','version','environment','authority'])('refuses incompatible fleet state %s after restart without repairing it',kind=>using(async h=>{
  await h.enroll();const before=await h.evidence();await h.req('/__breakSchema',{kind});await h.restart();
  const denied=await h.hostFetch('https://fixture.test/v1/status',{method:'POST',headers:{authorization:'Bearer '+token('owner'),'content-type':'application/json'},body:'{}'}).then((r:any)=>r.status).catch(()=>500);
  expect(denied).toBeGreaterThanOrEqual(500);expect(await h.evidence()).toEqual(before);
 }));
 it('supports explicit unmanaged-to-managed promotion and refuses later disablement',()=>using(async h=>{
  expect((await h.req('/v1/status',{})).status).toBe(200);
  await h.restart(fixture);expect((await h.req('/v1/status',{})).status).toBe(200);
  await h.restart(fixture.replace("COMPUTE_ENROLLMENT_ENABLED:'true'","COMPUTE_ENROLLMENT_ENABLED:'false'"));
  const denied=await h.hostFetch('https://fixture.test/v1/status',{method:'POST',headers:{authorization:'Bearer '+token('owner'),'content-type':'application/json'},body:'{}'}).then((r:any)=>r.status).catch(()=>500);expect(denied).toBeGreaterThanOrEqual(500);
 },fixture.replace("COMPUTE_ENROLLMENT_ENABLED:'true'","COMPUTE_ENROLLMENT_ENABLED:'false'")));
});

describe('profile lifecycle admission',()=>{
 const profile={image:'local/vetted@sha256:'+'a'.repeat(64),cpu:1,ramMib:64,pids:16,tmpMib:4,maxOutputBytes:4096,timeoutMs:100};
 it('rejects fractional CPU before insertion and accepts a later valid profile',()=>using(async h=>{
  await h.req('/v1/enrollment/enroll',{expectedEpoch:1,request:{key:'fractional-profile',...identity(),tokenSha256:digest('mac'),expiresAt:Date.now()+3600000,expectedRevision:0,incarnation:0}});
  expect((await h.req('/v1/enrollment/profile',{expectedEpoch:1,request:{workerId:'mac',revision:1,profile:{...profile,cpu:0.5}}})).body.code).toBe('profile-cpu-integer');
  expect((await h.req('/v1/enrollment/profile',{expectedEpoch:1,request:{workerId:'mac',revision:1,profile}})).body.profileHash).toBe(approvedHash());
 }));
 it('replays identical approval and rejects changed approval across restart',()=>using(async h=>{
  await h.enroll();const body={expectedEpoch:1,request:{workerId:'mac',revision:1,profile}};
  const original=await h.req('/v1/enrollment/profile',body);await h.restart();expect((await h.req('/v1/enrollment/profile',body)).body).toEqual(original.body);
  expect((await h.req('/v1/enrollment/profile',{expectedEpoch:1,request:{workerId:'mac',revision:1,profile:{...profile,ramMib:128}}})).body.code).toBe('profile-immutable');
 }));
 it('does not let a successor credential inherit its prior profile',()=>using(async h=>{
  await h.enroll();await h.req('/v1/enrollment/revoke',{expectedEpoch:1,request:{key:'rotate-credential',workerId:'mac',revision:1}});
  await h.req('/v1/enrollment/enroll',{expectedEpoch:1,request:{key:'successor-without-profile',...identity(),tokenSha256:digest('successor'),expiresAt:Date.now()+3600000,expectedRevision:1,incarnation:1}});
  const proof=await h.evidence();expect(proof.workers).toHaveLength(1);
  expect((await h.req('/v1/enrollment/profile',{expectedEpoch:1,request:{workerId:'mac',revision:1,profile}})).body.code).toBe('profile-worker');
  expect((await h.req('/v1/enrollment/profile',{expectedEpoch:1,request:{workerId:'mac',revision:2,profile:{...profile,ramMib:128}}})).body.ok).toBe(true);
 }));
});
