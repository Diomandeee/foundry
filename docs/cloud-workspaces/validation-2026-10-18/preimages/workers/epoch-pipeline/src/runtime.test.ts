import {describe,it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runtime,token,contract} from '../test-support/runtime';
const H=(n:number)=>n.toString(16).padStart(64,'0');const raw=(n:number)=>'0x'+H(n);
function block(n:number,parent=n-1){return {index_block_hash:raw(n),hash:raw(n+100),parent_index_block_hash:raw(parent),parent_block_hash:raw(parent+100),height:n,burn_block_hash:raw(n+200),burn_block_height:n,tenure_height:n,canonical:false};}
function observation(b=block(1),key='observe',expectedCursor=0){return {key,expectedCursor,block:b,transaction:{tx_id:raw(500),block_hash:b.hash,parent_block_hash:b.parent_block_hash,block_height:b.height,tx_status:'success',is_unanchored:false,microblock_hash:'',canonical:false,microblock_canonical:false,event_count:1,events:[{event_index:0,event_type:'smart_contract_log',tx_id:raw(500),contract_log:{contract_id:contract,topic:'print',value:{hex:'0x03',repr:'true'}}}]},eventIndex:0};}
async function fixture(fn:(h:any)=>Promise<void>){
 const dir=await mkdtemp(join(tmpdir(),'epoch-pipeline-local-'));let mf=await runtime(dir);let serial=0;
 const req=async(path:string,body:any={},role='owner',extra={})=>{const r=await mf.dispatchFetch('https://local.invalid'+path,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token(role),...extra},body:JSON.stringify(body)});return {status:r.status,body:r.headers.get('content-type')?.includes('application/json')?await r.json():await r.text()};};
 const pipe=async(op:string,b={},role='owner'):Promise<any>=>{const r=await req('/v1/pipeline/'+op,b,role);expect(r.status,JSON.stringify(r)).toBe(200);return r.body;};
 const command=async(operation:string,body:any,role='owner',epoch=1):Promise<any>=>{const r=await req('/v1/commands',{expectedEpoch:epoch,command:{operation,body,key:'cmd-'+ ++serial}},role);expect(r.status,JSON.stringify(r)).toBe(200);return r.body as any;};
 const snapshot=async()=>pipe('snapshot');
 const reconcile=async(tip=3)=>{const s=await snapshot();return pipe('reconcile',{expectedRevision:s.chain.revision,tipId:H(tip),checkpoint:{anchoredThroughId:H(tip),anchorHash:H(tip+200),anchorHeight:tip,checkpointBitcoinTip:H(tip+200)},bitcoinHeaders:Array.from({length:tip},(_,i)=>({hash:H(i+201),parentHash:H(i+200),height:i+1}))});};
 const seed=async(eligible=true)=>{
  await pipe('register',{key:'register'});await pipe('header',{block:block(0,99)},'submitter');await pipe('observe',observation(),'submitter');
  await pipe('bootstrap',{expectedRevision:(await snapshot()).chain.revision,rootId:H(0)});
  await pipe('header',{block:block(2)},'submitter');await pipe('header',{block:block(3)},'submitter');
  if(eligible)await reconcile();
  expect((await command('setQuota',{principal:'submitter',maxActive:20,allowedClass:'general'})).ok).toBe(true);
 };
 const cs=async(epoch=1)=>(await req('/v1/snapshot',{expectedEpoch:epoch})).body;
 try{await fn({req,pipe,command,snapshot,reconcile,seed,cs,restart:async(wait=true)=>{await mf.dispose();mf=await runtime(dir);if(wait)await req('/fixture/config',{advanceClockMs:1100});}});}finally{await mf.dispose();await rm(dir,{recursive:true,force:true});}
}
describe('actual pipeline + compute HTTP/SQLite DO boundary',()=>{
 it('persists decoder/inbox/frozen plan; gates before checkpoint; submits once across duplicate/restart/lost response',()=>fixture(async h=>{
  await h.seed(false);expect((await h.pipe('dispatch')).results).toEqual([]);expect((await h.cs()).workloads).toHaveLength(0);
  await h.reconcile();await h.req('/fixture/config',{lost:true});expect((await h.pipe('dispatch')).results[0].code).toBe('RETRY_UNKNOWN');expect((await h.cs()).workloads).toHaveLength(1);
  await h.restart();expect((await h.pipe('observe',observation(),'submitter')).status).toBe('accepted');
  expect((await h.pipe('dispatch')).results[0].code).toBe('SUBMITTED');expect((await h.cs()).workloads).toHaveLength(1);
  const s=await h.snapshot();expect(s.inbox.totals.events).toBe(1);expect(s.chain.generations).toHaveLength(1);expect(s.chain.quarantined).toBe(false);
 }));
 it('provider flag updates are duplicate immutable content and do not select a head or grant eligibility',()=>fixture(async h=>{
  await h.seed(false);const o=observation(block(1),'flags',999);o.block.canonical=true;o.transaction.canonical=true;o.transaction.microblock_canonical=true;
  expect((await h.pipe('observe',o,'submitter')).status).toBe('duplicate');const s=await h.snapshot();expect(s.chain.quarantined).toBe(false);expect(s.inbox.totals.events).toBe(1);expect(s.chain.generations).toHaveLength(0);
  await h.reconcile();await h.pipe('dispatch');await h.pipe('observe',{...o,key:'flags-again'},'submitter');await h.pipe('dispatch');expect((await h.cs()).workloads).toHaveLength(1);
 }));
 it('rolls back actual inbox cursor/audit/command plus frozen plan/header/ref on projection fault',()=>fixture(async h=>{
  await h.pipe('register',{key:'register'});const before=await h.snapshot();await h.req('/fixture/config',{fault:true});
  expect((await h.req('/v1/pipeline/observe',observation(),'submitter')).status).toBe(503);expect(await h.snapshot()).toEqual(before);
  expect((await h.pipe('observe',observation(),'submitter')).cursor).toBe(1);
 }));
 it('rejects forged observer, wrong network/contract and untrusted owner operations',()=>fixture(async h=>{
  await h.pipe('register',{key:'register'});
  expect((await h.req('/v1/pipeline/observe',observation(),'other',{'x-role':'owner'})).status).toBe(403);
  const o=observation();o.transaction.events[0].contract_log.contract_id='ST000000000000000000002AMW42H.other';expect((await h.req('/v1/pipeline/observe',o,'submitter')).status).toBe(400);
  expect((await h.req('/v1/pipeline/bootstrap',{expectedRevision:0,rootId:H(1)},'submitter')).status).toBe(403);
  expect((await h.req('/v1/pipeline/dispatch',{},'submitter')).status).toBe(403);
  expect((await h.req('/v1/pipeline/snapshot',{},'owner',{authorization:''})).status).toBe(401);
 }));
 it('suppresses same-height orphan before dispatch, recanonicalization creates distinct generation/ID',()=>fixture(async h=>{
  await h.seed();
  for(let n=1;n<=3;n++){const b={...block(n),index_block_hash:raw(n+10),hash:raw(n+110),parent_index_block_hash:raw(n===1?0:n+9),parent_block_hash:raw(n===1?100:n+109)};await h.pipe('header',{block:b},'submitter');}
  await h.pipe('reconcile',{expectedRevision:(await h.snapshot()).chain.revision,tipId:H(13),checkpoint:{anchoredThroughId:H(13),anchorHash:H(203),anchorHeight:3,checkpointBitcoinTip:H(203)},bitcoinHeaders:[{hash:H(201),parentHash:H(200),height:1},{hash:H(202),parentHash:H(201),height:2},{hash:H(203),parentHash:H(202),height:3}]});
  await h.pipe('dispatch');expect((await h.cs()).workloads).toHaveLength(0);
  await h.reconcile();await h.pipe('dispatch');const s=await h.snapshot();expect(s.chain.generations).toHaveLength(2);expect(new Set(s.chain.generations.map((g:any)=>g.workloadId)).size).toBe(2);expect((await h.cs()).workloads).toHaveLength(1);
 }));
 it('reorg cancels queued work and source content conflict quarantines without overwriting observations',()=>fixture(async h=>{
  await h.seed();await h.pipe('dispatch');await h.reconcile(1);await h.pipe('dispatch');expect((await h.cs()).workloads[0].status).toBe('CANCELLED');
  await h.reconcile();await h.pipe('dispatch');const o=observation(block(1),'conflict');o.transaction.events[0].contract_log.value.repr='false';
  expect((await h.pipe('observe',o,'submitter')).status).toBe('conflict');await h.pipe('dispatch');const s=await h.snapshot();expect(s.chain.quarantined).toBe(true);expect(s.inbox.totals.events).toBe(1);expect((await h.cs()).workloads.every((w:any)=>w.status==='CANCELLED')).toBe(true);
 }));
 it('retains cancel NOT_FOUND when submit is paused before create; late response creates compensation and actual job is cancelled',()=>fixture(async h=>{
  await h.seed();await h.req('/fixture/config',{pause:true});const pending=h.pipe('dispatch');
  let waiting=false;for(let i=0;i<200;i++){if((await h.req('/fixture/config')).body.waiting){waiting=true;break;}await new Promise(r=>setTimeout(r,5));}expect(waiting).toBe(true);
  await h.reconcile(1);const cancellation=await h.pipe('dispatch');expect(cancellation.results.some((r:any)=>r.code==='RETRY_NOT_FOUND')).toBe(true);
  expect((await h.snapshot()).chain.intents.filter((i:any)=>i.kind==='CANCEL').every((i:any)=>i.status!=='acked')).toBe(true);
  await h.req('/fixture/config',{release:true});expect((await pending).results[0].code).toBe('SUBMITTED');await h.pipe('dispatch');
  const s=await h.snapshot();expect(s.chain.intents.some((i:any)=>i.intentId.endsWith('cancel-response')&&i.status==='acked')).toBe(true);expect((await h.cs()).workloads[0].status).toBe('CANCELLED');
 }));
 it('executes pure handler from actual claimed specification, sealed upload, independent verify, restart; completed receipt stays on reorg',()=>fixture(async h=>{
  await h.seed();await h.pipe('dispatch');const w=(await h.cs()).workloads[0];
  expect((await h.command('registerWorker',{workerId:'fixture-cpu',principal:'executor',workerClass:'general',cpu:1,ramMib:128,devices:[]})).ok).toBe(true);
  const grant=await h.command('claim',{workloadId:w.id,workerId:'fixture-cpu',expectedGeneration:0,incarnation:0,ttlMs:60000},'executor');expect(grant.ok).toBe(true);const l=grant.lease;
  const result=await h.req('/fixture/handler',{specification:w.specification});expect(typeof result.body).toBe('string');
  const sealed=await h.req('/v1/artifacts',{expectedEpoch:1,key:'sealed-output',fence:{leaseId:l.id,epoch:l.epoch,generation:l.generation,incarnation:l.incarnation,capability:l.capability},bytesBase64:Buffer.from(result.body).toString('base64'),exitCode:0},'executor');expect(sealed.body.ok,JSON.stringify(sealed)).toBe(true);
  await h.restart();const verified=await h.req('/v1/verify',{expectedEpoch:1,request:{key:'independent-verify',leaseId:l.id,epoch:l.epoch,generation:l.generation,incarnation:l.incarnation}},'verifier');expect(verified.body.ok,JSON.stringify(verified)).toBe(true);
  const receipt=(await h.cs()).receipts;expect(receipt).toHaveLength(1);await h.reconcile(1);const delivery=await h.pipe('dispatch');expect(delivery.results.some((r:any)=>r.code==='SUPERSEDED_SUCCEEDED')).toBe(true);expect((await h.cs()).receipts).toEqual(receipt);
 }));
 it('running cancellation fences the actual lease and quarantines physical worker resources',()=>fixture(async h=>{
  await h.seed();await h.pipe('dispatch');const w=(await h.cs()).workloads[0];
  await h.command('registerWorker',{workerId:'fixture-cpu',principal:'executor',workerClass:'general',cpu:1,ramMib:128,devices:[]});
  const grant=await h.command('claim',{workloadId:w.id,workerId:'fixture-cpu',expectedGeneration:0,incarnation:0,ttlMs:60000},'executor');expect(grant.ok).toBe(true);
  await h.reconcile(1);await h.pipe('dispatch');const s=await h.cs();expect(s.workloads[0].status).toBe('CANCELLED');expect(s.workers[0].quarantined).toBe(1);expect(s.leases[0].state).toBe('REVOKED');
 }));
 it('requires preinstalled quota and retries same workload after authority epoch recovery',()=>fixture(async h=>{
  await h.pipe('register',{key:'register'});await h.pipe('observe',observation(),'submitter');await h.pipe('bootstrap',{expectedRevision:(await h.snapshot()).chain.revision,rootId:H(1)});await h.pipe('header',{block:block(2)},'submitter');await h.pipe('header',{block:block(3)},'submitter');await h.reconcile();
  expect((await h.pipe('dispatch')).results[0].code).toBe('BLOCKED_HTTP_200_QUOTA_REQUIRED');expect((await h.cs()).workloads).toHaveLength(0);
  await h.command('setQuota',{principal:'submitter',maxActive:20,allowedClass:'general'});
  await h.pipe('recover',{intentId:(await h.snapshot()).chain.intents[0].intentId});
  await h.command('bumpEpoch',{expectedEpoch:1});await h.req('/fixture/config',{epoch:2});
  await h.req('/fixture/config',{lost:true});await h.pipe('dispatch');const original=(await h.cs(2)).workloads[0].id;
  await h.command('bumpEpoch',{expectedEpoch:2},'owner',2);await h.req('/fixture/config',{epoch:3});await h.req('/fixture/config',{advanceClockMs:2100});
  expect((await h.pipe('dispatch')).results[0].code).toBe('SUBMITTED');const s=await h.cs(3);expect(s.workloads).toHaveLength(1);expect(s.workloads[0].id).toBe(original);
 }));
 it('rejects a same-network contract outside host allowlist without observing it',()=>fixture(async h=>{
  await h.pipe('register',{key:'register'});const o=observation();o.transaction.events[0].contract_log.contract_id='SP000000000000000000002Q6VF78.unapproved';expect((await h.req('/v1/pipeline/observe',o,'submitter')).status).toBe(400);expect((await h.snapshot()).inbox.totals.events).toBe(0);
 }));

 it('recovers when epoch changes between status discovery and snapshot',()=>fixture(async h=>{
  await h.seed();await h.req('/fixture/config',{epochRace:true});expect((await h.pipe('dispatch')).results[0].code).toBe('RETRY_HTTP_200_STALE_EPOCH');expect((await h.cs(2)).workloads).toHaveLength(0);await h.req('/fixture/config',{advanceClockMs:1100});
  expect((await h.pipe('dispatch')).results[0].code).toBe('SUBMITTED');expect((await h.cs(2)).workloads).toHaveLength(1);
 }));
 it('surfaces unexpected claim SQL faults and preserves the transaction for retry',()=>fixture(async h=>{
  await h.seed();await h.req('/fixture/config',{claimFault:true});expect((await h.req('/v1/pipeline/dispatch')).status).toBe(503);const s=await h.snapshot();expect(s.chain.intents[0].attempts).toBe(0);expect((await h.cs()).workloads).toHaveLength(0);
  expect((await h.pipe('dispatch')).results[0].code).toBe('SUBMITTED');
 }));

 it('persists dispatch scan progress so earlier retrying admissions cannot starve later intents',()=>fixture(async h=>{
  await h.seed(false);await h.command('setQuota',{principal:'submitter',maxActive:1,allowedClass:'general'});
  for(let i=1;i<22;i++){const o=observation(block(1),'event-'+i,i);o.transaction.tx_id=raw(500+i);o.transaction.events[0].tx_id=raw(500+i);await h.pipe('observe',o,'submitter');}
  await h.reconcile();const first=await h.pipe('dispatch');expect(first.results).toHaveLength(20);expect(first.results.filter((r:any)=>r.code==='BLOCKED_HTTP_200_QUOTA_EXCEEDED')).toHaveLength(19);
  await h.restart();const second=await h.pipe('dispatch');expect(second.results).toHaveLength(2);const prior=new Set(first.results.map((r:any)=>r.intentId));expect(second.results.every((r:any)=>!prior.has(r.intentId))).toBe(true);expect((await h.cs()).workloads).toHaveLength(1);
 }));

 it('genuine structural header conflicts preserve original and quarantine/cancel actual work',()=>fixture(async h=>{
  await h.seed();await h.pipe('dispatch');const changed={...block(1),hash:raw(999)};expect((await h.pipe('header',{block:changed},'submitter')).status).toBe('conflict');
  await h.pipe('dispatch');const s=await h.snapshot();expect(s.chain.quarantined).toBe(true);expect(s.chain.headers.find((b:any)=>b.id===H(1)).hash).toBe(H(101));expect((await h.cs()).workloads[0].status).toBe('CANCELLED');
 }));

 it('blocks permanent 403 without burning more claims; only owner recovery permits a new command generation',()=>fixture(async h=>{
  await h.seed();await h.req('/fixture/config',{statusFailure:403});expect((await h.pipe('dispatch')).results[0].code).toBe('BLOCKED_HTTP_403_RESPONSE');const before=await h.snapshot();const intentId=before.chain.intents[0].intentId;
  await h.req('/fixture/config',{statusFailure:0});for(let i=0;i<3;i++)expect((await h.pipe('dispatch')).results).toHaveLength(0);expect((await h.snapshot()).chain.intents[0].attempts).toBe(1);
  expect((await h.req('/v1/pipeline/recover',{intentId},'projector')).status).toBe(403);await h.pipe('recover',{intentId});expect((await h.pipe('dispatch')).results[0].code).toBe('SUBMITTED');expect((await h.cs()).workloads).toHaveLength(1);
 }));
 it('persists transient 503 exponential backoff across restart',()=>fixture(async h=>{
  await h.seed();await h.req('/fixture/config',{statusFailure:503});expect((await h.pipe('dispatch')).results[0].code).toBe('RETRY_HTTP_503_RESPONSE');expect((await h.pipe('dispatch')).results).toHaveLength(0);expect((await h.snapshot()).chain.intents[0].attempts).toBe(1);
  await h.restart(false);expect((await h.pipe('dispatch')).results).toHaveLength(0);await h.req('/fixture/config',{advanceClockMs:1100});expect((await h.pipe('dispatch')).results[0].code).toBe('SUBMITTED');expect((await h.cs()).workloads).toHaveLength(1);
 }));
 it('cancels using bounded workload lookup with over 1MiB unrelated workload history',()=>fixture(async h=>{
  await h.seed();await h.pipe('dispatch');await h.command('setQuota',{principal:'other',maxActive:100,allowedClass:'general'});
  for(let i=0;i<65;i++)expect((await h.command('submit',{workloadId:'unrelated-'+i,specification:'x'.repeat(16384),resources:{cpu:1,ramMib:1},policy:{sha256:'0'.repeat(64),maxBytes:64,exitCode:0},pure:true,reconstructible:true,maxAttempts:1},'other')).ok).toBe(true);
  const before=await h.cs();expect(Buffer.byteLength(JSON.stringify(before))).toBeGreaterThan(1048576);const target=before.workloads.find((w:any)=>w.principal==='submitter').id;
  await h.reconcile(1);expect((await h.pipe('dispatch')).results.some((r:any)=>r.code==='CANCELLED_LOGICAL')).toBe(true);const lookup=await h.req('/v1/workload',{expectedEpoch:1,workloadId:target});expect(lookup.body.workload.status).toBe('CANCELLED');
 }));

 it('continues cancellation beyond 100 attempts after late creation and lost submit response',()=>fixture(async h=>{
  await h.seed();await h.req('/fixture/config',{pause:true,lost:true});const pending=h.pipe('dispatch');
  let waiting=false;for(let i=0;i<200;i++){if((await h.req('/fixture/config')).body.waiting){waiting=true;break;}await new Promise(r=>setTimeout(r,5));}expect(waiting).toBe(true);
  await h.reconcile(1);await h.req('/fixture/config',{cancelAttempts100:true});expect((await h.pipe('dispatch')).results.some((r:any)=>r.code==='RETRY_NOT_FOUND')).toBe(true);
  expect((await h.snapshot()).chain.intents.find((i:any)=>i.kind==='CANCEL').attempts).toBe(101);
  await h.req('/fixture/config',{release:true});expect((await pending).results[0].code).toBe('RETRY_UNKNOWN');await h.restart(false);
  expect((await h.pipe('dispatch')).results).toHaveLength(0);await h.req('/fixture/config',{advanceBackoff:true});expect((await h.pipe('dispatch')).results.some((r:any)=>r.code==='CANCELLED_LOGICAL')).toBe(true);
  const s=await h.snapshot();expect(s.chain.intents.find((i:any)=>i.kind==='CANCEL').attempts).toBe(102);expect((await h.cs()).workloads[0].status).toBe('CANCELLED');
 }));

 it('propagates retryIntent SQL failures instead of reporting a successful retry',()=>fixture(async h=>{
  await h.seed();await h.req('/fixture/config',{statusFailure:503,retryFault:true});expect((await h.req('/v1/pipeline/dispatch')).status).toBe(503);const s=await h.snapshot();expect(s.chain.intents[0].status).toBe('leased');expect(s.delivery).toHaveLength(0);expect((await h.cs()).workloads).toHaveLength(0);
  await h.req('/fixture/config',{statusFailure:0,expireLease:true});expect((await h.pipe('dispatch')).results[0].code).toBe('SUBMITTED');
 }));

 it('propagates plan SQL reads as 503 and stops before sending or claiming the next intent',()=>fixture(async h=>{
  await h.seed(false);const o=observation(block(1),'second',1);o.transaction.tx_id=raw(501);o.transaction.events[0].tx_id=raw(501);await h.pipe('observe',o,'submitter');await h.reconcile();
  await h.req('/fixture/config',{planFault:true});const failure=await h.req('/v1/pipeline/dispatch');expect(failure).toEqual({status:503,body:{ok:false,code:'temporarily-unavailable'}});
  const s=await h.snapshot();expect(s.chain.intents.map((i:any)=>[i.status,i.attempts])).toEqual([['leased',1],['pending',0]]);expect(s.delivery).toHaveLength(0);expect((await h.cs()).workloads).toHaveLength(0);
  await h.req('/fixture/config',{expireLease:true});await h.pipe('dispatch');expect((await h.cs()).workloads).toHaveLength(2);
 }));
 it('returns 503 and stops batch when actual submit succeeds but local response persistence fails',()=>fixture(async h=>{
  await h.seed(false);const o=observation(block(1),'second',1);o.transaction.tx_id=raw(501);o.transaction.events[0].tx_id=raw(501);await h.pipe('observe',o,'submitter');await h.reconcile();
  await h.req('/fixture/config',{responseFault:true});expect(await h.req('/v1/pipeline/dispatch')).toEqual({status:503,body:{ok:false,code:'temporarily-unavailable'}});
  const s=await h.snapshot();expect(s.chain.intents.map((i:any)=>[i.status,i.attempts])).toEqual([['leased',1],['pending',0]]);expect(s.chain.generations.every((g:any)=>!g.submitted)).toBe(true);expect(s.delivery).toHaveLength(0);const admitted=(await h.cs()).workloads;expect(admitted).toHaveLength(1);
  await h.restart(false);await h.req('/fixture/config',{expireLease:true});await h.pipe('dispatch');const recovered=(await h.cs()).workloads;expect(recovered).toHaveLength(2);expect(recovered.filter((w:any)=>w.id===admitted[0].id)).toHaveLength(1);
 }));
 it('returns 503 and stops batch when actual cancellation succeeds but local acknowledgement fails',()=>fixture(async h=>{
  await h.seed(false);const o=observation(block(1),'second',1);o.transaction.tx_id=raw(501);o.transaction.events[0].tx_id=raw(501);await h.pipe('observe',o,'submitter');await h.reconcile();await h.pipe('dispatch');await h.reconcile(1);
  await h.req('/fixture/config',{ackFault:true});expect(await h.req('/v1/pipeline/dispatch')).toEqual({status:503,body:{ok:false,code:'temporarily-unavailable'}});
  const s=await h.snapshot();expect(s.chain.intents.filter((i:any)=>i.kind==='CANCEL').map((i:any)=>[i.status,i.attempts])).toEqual([['leased',1],['pending',0]]);expect((await h.cs()).workloads.map((w:any)=>w.status).sort()).toEqual(['CANCELLED','QUEUED']);expect(s.delivery.every((d:any)=>d.code==='SUBMITTED')).toBe(true);
  await h.restart(false);await h.req('/fixture/config',{expireLease:true});const recovered=await h.pipe('dispatch');expect(recovered.results.some((r:any)=>r.code==='SUPERSEDED_CANCELLED')).toBe(true);expect((await h.cs()).workloads.every((w:any)=>w.status==='CANCELLED')).toBe(true);
 }));

 it('serves owner-only bounded historical decision receipts with authentic actors and paths across restart',()=>fixture(async h=>{
  await h.seed();const bootstrap=await h.pipe('decisions',{after:0,limit:1});expect(bootstrap).toMatchObject({hasMore:true,nextAfter:1,items:[{seq:1,kind:'BOOTSTRAP',actor:{environment:'local',principal:'owner',role:'owner'},rootId:H(0),reason:'root-selected',evidence:{rootId:H(0)},transition:null}]});
  const first=await h.pipe('decisions',{after:bootstrap.nextAfter,limit:1});expect(first.items).toHaveLength(1);expect(first).toMatchObject({hasMore:false,nextAfter:2});const grant=first.items[0];
  expect(grant).toMatchObject({seq:2,kind:'GRANT',actor:{environment:'local',principal:'owner',role:'owner'},rootId:H(0),reason:'eligibility-granted',evidence:{tipId:H(3),path:[H(3),H(2),H(1),H(0)],complete:true},transition:{fromEligible:false,toEligible:true,generation:{generation:1}}});
  expect(grant.revision).toBe(grant.beforeRevision+1);expect(JSON.parse(grant.binding)).toMatchObject({environment:'local',authorityId:'pipeline',sourceId:'hiro',network:'stacks-mainnet'});
  await h.pipe('dispatch');expect((await h.cs()).workloads).toHaveLength(1);await h.reconcile(1);await h.pipe('dispatch');
  const withdrawal=await h.pipe('decisions',{after:first.nextAfter,limit:1});expect(withdrawal.items).toHaveLength(1);expect(withdrawal.items[0]).toMatchObject({seq:3,kind:'WITHDRAW',actor:{principal:'owner',role:'owner'},evidence:{tipId:H(1),path:[H(1),H(0)]},transition:{fromEligible:true,toEligible:false,generation:{workloadId:grant.transition.generation.workloadId}}});expect(withdrawal.items[0].transition.cancelIntentIds).toHaveLength(1);
  const conflicting=observation(block(1),'receipt-conflict');conflicting.transaction.events[0].contract_log.value.repr='false';await h.pipe('observe',conflicting,'submitter');
  const before=await h.pipe('decisions',{after:0,limit:100});expect(before.items.map((d:any)=>d.kind)).toEqual(['BOOTSTRAP','GRANT','WITHDRAW','QUARANTINE']);expect(before.items[3]).toMatchObject({actor:{environment:'local',principal:'pipeline-internal',role:'owner'},reason:'inbox-conflict',evidence:{quarantineReason:'inbox-conflict'}});expect(before.items[0]).toEqual(bootstrap.items[0]);expect(before.items[1]).toEqual(grant);expect(before).toMatchObject({hasMore:false,nextAfter:4});expect(Buffer.byteLength(JSON.stringify(before))).toBeLessThanOrEqual(524288);
  for(const role of ['submitter','projector','other'])expect((await h.req('/v1/pipeline/decisions',{after:0,limit:1},role,{'x-role':'owner','x-principal':'owner'})).status).toBe(403);
  expect((await h.req('/v1/pipeline/decisions',{after:0,limit:1},'owner',{authorization:''})).status).toBe(401);
  for(const input of [{after:-1,limit:1},{after:2051,limit:1},{after:0,limit:0},{after:0,limit:101},{after:0.5,limit:1},{after:'0',limit:1},{after:0,limit:1,actor:{role:'owner'}}])expect((await h.req('/v1/pipeline/decisions',input)).status).toBe(400);
  await h.restart(false);expect(await h.pipe('decisions',{after:0,limit:100})).toEqual(before);expect((await h.pipe('decisions',{after:3,limit:1})).items).toEqual([before.items[3]]);expect(await h.pipe('decisions',{after:4,limit:1})).toMatchObject({items:[],hasMore:false,nextAfter:4});expect(await h.pipe('decisions',{after:2050,limit:1})).toMatchObject({items:[],hasMore:false,nextAfter:2050});
 }));

});
