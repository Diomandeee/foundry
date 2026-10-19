import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe,it,expect} from 'vitest';
import {localRuntime} from '../test-support/runtime';
const token=(role:string)=>`fixture-only-${role}-bearer-00000000000000000000000`;
const config=['owner','executor','verifier','projector','submitter','other'].map(role=>({tokenSha256:createHash('sha256').update(token(role)).digest('hex'),principal:role==='other'?'other-tenant':role==='executor'?'worker-principal':role,role:role==='other'?'submitter':role,environment:'local-http'}));
const fixture=`
 import entry from './workers/compute/src/index.ts';
 import {ComputeAuthority} from './workers/compute/src/authority.ts';
 const bindings={COMPUTE_ENVIRONMENT:'local-http',COMPUTE_ISSUER_ID:'fixture-issuer',COMPUTE_ISSUER_KEY:'fixture-only-issuer-00000000000000000000000000',COMPUTE_TRANSPORT_ENABLED:'true',COMPUTE_AUTHORITY_NAME:'fixed',COMPUTE_AUTH_CONFIG:${JSON.stringify(JSON.stringify(config))}};
 export class TestFabricAuthority extends ComputeAuthority {
  constructor(ctx,env){
   const fault={enabled:false};
   const state={id:ctx.id,storage:{sql:{exec:(query,...args)=>{const result=ctx.storage.sql.exec(query,...args);if(fault.enabled && /^INSERT INTO outbox/.test(query)){fault.enabled=false;throw new Error('fixture rollback fault');}return result;}},transactionSync:fn=>ctx.storage.transactionSync(fn)}};
   super(state,{...env,...bindings});this.testContext=ctx;this.testFault=fault;
  }
  async fetch(request){
   if(new URL(request.url).pathname!=='/__test')return super.fetch(request);
   const input=await request.json();
   if(input.action==='hostCommand')return Response.json(this.execute(input.actor,input.command));
   if(input.action==='fault'){this.testFault.enabled=true;return Response.json({ok:true});}
   if(input.action==='sealed')return Response.json(this.testContext.storage.sql.exec('SELECT ref,size FROM compute_artifact_bytes').toArray());
   if(input.action==='immutability'){
    const denied=[];
    for(const sql of ["UPDATE compute_artifact_bytes SET bytes=zeroblob(1)","DELETE FROM compute_artifact_bytes"]){
     try{this.testContext.storage.transactionSync(()=>this.testContext.storage.sql.exec(sql));denied.push(false);}catch{denied.push(true);}
    }
    return Response.json(denied);
   }
   return Response.json({ok:false});
  }
 }

 export default {fetch(request,env){return entry.fetch(request,{...env,...bindings});}};
`;
async function client(run:(h:any)=>Promise<void>){
 const directory=await mkdtemp(join(tmpdir(),'foundry-http-'));let runtime=await localRuntime(fixture,directory,'foundry-http-artifacts');let serial=0;
 const request=async(path:string,body:any,role='owner',headers={})=>{
  const response=await runtime.dispatchFetch('https://local.test'+path,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token(role)}`,...headers},body:JSON.stringify(body)});
  return {status:response.status,body:response.headers.get('content-type')?.includes('application/json')?await response.json():await response.text()};
 };
 const command=async(role:string,operation:string,body:any,key=`http-${++serial}`)=>request('/v1/commands',{expectedEpoch:1,command:{key,operation,body}},role);
 try{await run({request,command,restart:async()=>{await runtime.dispose();runtime=await localRuntime(fixture,directory,'foundry-http-artifacts');}});}finally{await runtime.dispose();await rm(directory,{recursive:true,force:true});}
}
const bytes=Buffer.from('499500\n');const sha256=createHash('sha256').update(bytes).digest('hex');
async function seed(h:any,id='job'){
 expect((await h.command('owner','setQuota',{principal:'submitter',maxActive:10,allowedClass:'general'})).body.ok).toBe(true);
 expect((await h.command('owner','registerWorker',{workerId:'worker',principal:'worker-principal',workerClass:'general',cpu:2,ramMib:1024,devices:[]})).body.ok).toBe(true);
 expect((await h.command('submitter','submit',{workloadId:id,specification:'fixed-cpu-v1',resources:{cpu:1,ramMib:64},policy:{sha256,maxBytes:1024,exitCode:0},pure:true,reconstructible:true,maxAttempts:3})).body.ok).toBe(true);
 const grant=await h.command('executor','claim',{workloadId:id,workerId:'worker',expectedGeneration:0,incarnation:0,ttlMs:60000});expect(grant.body.ok,JSON.stringify(grant)).toBe(true);return grant.body.lease;
}
const fence=(l:any)=>({leaseId:l.id,epoch:l.epoch,generation:l.generation,incarnation:l.incarnation,capability:l.capability});
const upload=(l:any,key='upload',data=bytes)=>({expectedEpoch:1,key,fence:fence(l),bytesBase64:data.toString('base64'),exitCode:0});
describe('authenticated production entry + sealed SQLite artifacts on workerd',()=>{
 it('runs upload through restart to verified receipt and immutable readable bytes',()=>client(async h=>{
  const l=await seed(h);const sealed=await h.request('/v1/artifacts',upload(l),'executor');expect(sealed.body.ok,JSON.stringify(sealed)).toBe(true);
  await h.restart();expect((await h.request('/v1/artifacts',upload(l),'executor')).body).toEqual(sealed.body);
  const request={key:'verify',leaseId:l.id,epoch:l.epoch,generation:l.generation,incarnation:l.incarnation};
  const verified=await h.request('/v1/verify',{expectedEpoch:1,request},'verifier');expect(verified.body.ok,JSON.stringify(verified)).toBe(true);
  expect((await h.request('/v1/verify',{expectedEpoch:1,request},'verifier')).body).toEqual(verified.body);
  expect((await h.request('/v1/artifacts/read',{expectedEpoch:1,reference:sealed.body.artifact.reference},'verifier')).body).toBe(bytes.toString());
  expect((await h.request('/v1/artifacts',upload(l,'overwrite',Buffer.from('altered')),'executor')).body.ok).not.toBe(true);
  expect((await h.request('/v1/snapshot',{expectedEpoch:1})).body.receipts).toHaveLength(1);
 }));
 it('rejects missing/forged auth and client-selected trusted context',()=>client(async h=>{
  expect((await h.request('/v1/snapshot',{expectedEpoch:1},'owner',{authorization:''})).status).toBe(401);
  expect((await h.request('/v1/snapshot',{expectedEpoch:1},'submitter',{'x-role':'owner','x-principal':'owner'})).status).toBe(403);
  expect((await h.request('/v1/commands',{expectedEpoch:1,actor:{role:'owner'},command:{}},'submitter')).status).toBe(400);
  expect((await h.command('submitter','setQuota',{principal:'submitter',maxActive:1,allowedClass:'general'})).body.ok).toBe(false);
 }));
 it('refuses mutable references, foreign readers and invalid fenced uploads without poisoning later success',()=>client(async h=>{
  const l=await seed(h);
  expect((await h.command('executor','stageResult',{...fence(l),artifactRef:'arbitrary-pointer',sha256,bytes:bytes.length,exitCode:0})).status).toBe(403);
  const forged=upload(l);forged.fence.capability='0'.repeat(64);
  expect((await h.request('/v1/artifacts',forged,'executor')).body.ok).toBe(false);
  const sealed=await h.request('/v1/artifacts',upload(l),'executor');expect(sealed.body.ok).toBe(true);
  expect((await h.request('/v1/artifacts/read',{expectedEpoch:1,reference:sealed.body.artifact.reference},'other')).status).toBe(403);
  expect((await h.request('/v1/artifacts',upload(l),'submitter')).status).toBe(403);
  expect((await h.request('/v1/artifacts/read',{expectedEpoch:2,reference:sealed.body.artifact.reference},'owner')).status).toBe(409);
 }));
 it('rolls back wrong-byte staging and rejects oversized bodies',()=>client(async h=>{
  const l=await seed(h);
  expect((await h.request('/v1/artifacts',upload(l,'same',Buffer.from('wrong')),'executor')).body.ok).toBe(false);
  expect((await h.request('/v1/artifacts',upload(l,'same'),'executor')).body.ok).toBe(true);
  expect((await h.request('/v1/artifacts',{...upload(l),bytesBase64:'A'.repeat(1500000)},'executor')).status).toBe(413);
 }));
 it('seals bytes and command response atomically under injected outbox fault',()=>client(async h=>{
  const l=await seed(h);await h.request('/__test',{action:'fault'});
  expect((await h.request('/v1/artifacts',upload(l),'executor')).status).toBe(503);
  expect((await h.request('/__test',{action:'sealed'})).body).toHaveLength(0);
  expect((await h.request('/v1/artifacts',upload(l),'executor')).body.ok).toBe(true);
  expect((await h.request('/__test',{action:'sealed'})).body).toHaveLength(1);
  expect((await h.request('/__test',{action:'immutability'})).body).toEqual([true,true]);
 }));
 it('binds each upload to its own lease and permits only one concurrent same-key seal',()=>client(async h=>{
  const l=await seed(h);const results=await Promise.all(Array.from({length:20},()=>h.request('/v1/artifacts',upload(l),'executor')));
  expect(results.every(r=>r.body.ok)).toBe(true);expect(new Set(results.map(r=>r.body.artifact.reference)).size).toBe(1);
  expect((await h.request('/__test',{action:'sealed'})).body).toHaveLength(1);
  expect((await h.request('/v1/snapshot',{expectedEpoch:1},'other')).status).toBe(403);
 }));

 it('reserves retained and future result bytes atomically before admitting competing jobs',()=>client(async h=>{
  expect((await h.command('owner','setQuota',{principal:'submitter',maxActive:100,allowedClass:'general'})).body.ok).toBe(true);
  const spec=(i:number)=>({workloadId:`budget-${i}`,specification:'fixed',resources:{cpu:1,ramMib:1},policy:{sha256,maxBytes:1048576,exitCode:0},pure:true,reconstructible:true,maxAttempts:16});
  const results=await Promise.all(Array.from({length:20},(_,i)=>h.command('submitter','submit',spec(i))));
  expect(results.filter(r=>r.body.ok)).toHaveLength(4);
  expect(results.filter(r=>r.status===507)).toHaveLength(16);
  expect((await h.request('/v1/snapshot',{expectedEpoch:1})).body.workloads).toHaveLength(4);
  await h.restart();expect((await h.command('submitter','submit',spec(21))).status).toBe(507);
  for(const command of [null,[],{},1])expect((await h.request('/v1/commands',{expectedEpoch:1,command},'owner')).status).toBe(400);
 }));
 it('accepts the exact 1 MiB sealed-output boundary on workerd',()=>client(async h=>{
  const data=Buffer.alloc(1048576,7),digest=createHash('sha256').update(data).digest('hex');
  await h.command('owner','setQuota',{principal:'submitter',maxActive:1,allowedClass:'general'});
  await h.command('owner','registerWorker',{workerId:'worker',principal:'worker-principal',workerClass:'general',cpu:1,ramMib:64,devices:[]});
  expect((await h.command('submitter','submit',{workloadId:'large',specification:'fixed',resources:{cpu:1,ramMib:1},policy:{sha256:digest,maxBytes:1048576,exitCode:0},pure:true,reconstructible:true,maxAttempts:1})).body.ok).toBe(true);
  const l=(await h.command('executor','claim',{workloadId:'large',workerId:'worker',expectedGeneration:0,incarnation:0,ttlMs:60000})).body.lease;
  expect((await h.request('/v1/artifacts',upload(l,'oversized',Buffer.alloc(1048577)),'executor')).status).toBe(413);
  expect((await h.request('/v1/artifacts',upload(l,'large',data),'executor')).body.ok).toBe(true);
  const result=await h.request('/v1/verify',{expectedEpoch:1,request:{key:'large-verify',leaseId:l.id,epoch:l.epoch,generation:l.generation,incarnation:l.incarnation}},'verifier');expect(result.body.ok).toBe(true);
 }));

 it('independent reader refuses a foreign lease pointer even through trusted-host staging',()=>client(async h=>{
  const first=await seed(h,'first');const sealed=await h.request('/v1/artifacts',upload(first),'executor');expect(sealed.body.ok).toBe(true);
  const second=await seed(h,'second');
  const staged=await h.request('/__test',{action:'hostCommand',actor:{principal:'worker-principal',role:'executor',expectedEpoch:1},command:{key:'foreign',operation:'stageResult',body:{...fence(second),artifactRef:sealed.body.artifact.reference,sha256,bytes:bytes.length,exitCode:0}}});expect(staged.body.ok).toBe(true);
  const verification=await h.request('/v1/verify',{expectedEpoch:1,request:{key:'foreign-verify',leaseId:second.id,epoch:second.epoch,generation:second.generation,incarnation:second.incarnation}},'verifier');expect(verification.body).toEqual({ok:false,code:'artifact-unavailable'});
  expect((await h.request('/v1/snapshot',{expectedEpoch:1})).body.receipts).toHaveLength(0);
 }));

 it('counts legacy active unsealed leases before admitting new retained-byte commitments',()=>client(async h=>{
  await h.command('owner','setQuota',{principal:'submitter',maxActive:100,allowedClass:'general'});
  await h.command('owner','registerWorker',{workerId:'worker',principal:'worker-principal',workerClass:'general',cpu:2,ramMib:128,devices:[]});
  const spec=(id:string,maxBytes:number,maxAttempts:number)=>({workloadId:id,specification:'fixed',resources:{cpu:1,ramMib:1},policy:{sha256,maxBytes,exitCode:0},pure:true,reconstructible:true,maxAttempts});
  const host=async(operation:string,body:any,role:string,key:string)=>h.request('/__test',{action:'hostCommand',actor:{principal:role==='executor'?'worker-principal':'submitter',role,expectedEpoch:1},command:{key,operation,body}});
  expect((await host('submit',spec('legacy',1048576,1),'submitter','legacy-submit')).body.ok).toBe(true);
  const l=(await host('claim',{workloadId:'legacy',workerId:'worker',expectedGeneration:0,incarnation:0,ttlMs:60000},'executor','legacy-claim')).body.lease;
  await h.restart();
  const results=await Promise.all(Array.from({length:4},(_,i)=>h.command('submitter','submit',spec(`new-${i}`,1048576,16))));
  expect(results.filter(r=>r.body.ok)).toHaveLength(3);expect(results.filter(r=>r.status===507)).toHaveLength(1);
  expect((await h.request('/v1/artifacts',upload(l),'executor')).body.ok).toBe(true);
  expect((await h.command('submitter','submit',spec('remaining',1048576,15))).body.ok).toBe(true);
  expect((await h.command('submitter','submit',spec('overbook',1,1))).status).toBe(507);
 }));

 it('lets only authenticated owners discover the current epoch without stale-write authority',()=>client(async h=>{
  const initial=await h.request('/v1/status',{});expect(initial.status).toBe(200);expect(initial.body.epoch).toBe(1);
  expect(Object.keys(initial.body).sort()).toEqual(['authorityId','environment','epoch','ok','schemaVersion']);
  expect((await h.request('/v1/status',{},'submitter')).status).toBe(403);
  expect((await h.request('/v1/status',{},'owner',{authorization:''})).status).toBe(401);
  expect((await h.command('owner','bumpEpoch',{expectedEpoch:1})).body.ok).toBe(true);
  await h.restart();const recovered=await h.request('/v1/status',{});expect(recovered.body.epoch).toBe(2);
  expect((await h.request('/v1/snapshot',{expectedEpoch:1})).status).toBe(409);
  expect((await h.request('/v1/snapshot',{expectedEpoch:2})).status).toBe(200);
  expect((await h.request('/v1/status',{expectedEpoch:1})).status).toBe(400);
 }));

 it('bounds authenticated workload lookup independently of retained authority history',()=>client(async h=>{
  await seed(h);
  const lookup=await h.request('/v1/workload',{expectedEpoch:1,workloadId:'job'});expect(lookup.status).toBe(200);expect(lookup.body.workload.id).toBe('job');
  expect((await h.request('/v1/workload',{expectedEpoch:1,workloadId:'missing'})).body.workload).toBeNull();
  expect((await h.request('/v1/workload',{expectedEpoch:1,workloadId:'job'},'submitter')).status).toBe(403);
  expect((await h.request('/v1/workload',{expectedEpoch:2,workloadId:'job'})).status).toBe(409);
  expect((await h.request('/v1/workload',{expectedEpoch:1,workloadId:'../job'})).status).toBe(400);
 }));

});
