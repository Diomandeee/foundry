import {describe,it,expect} from 'vitest';
import {withLibrary} from '../test-support/client';
import type {LibraryClient} from '../test-support/client';
import type {TransferBinding} from '../../../packages/library-catalog/src/index';
const H='a'.repeat(64);
export const binding=():TransferBinding=>({projectId:'project-a',policyVersion:'v1',policyHash:H,compute:{authorityId:'compute-local',workloadId:'job',leaseId:'lease',attemptId:'attempt',capabilityDigest:H,workerId:'mac',epoch:1,generation:1,incarnation:1},content:{manifestHash:H,objectKey:`projects/project-a/objects/${H}`,objectGeneration:'7',objectHash:H,bytes:12}});
const stage=(id='transfer')=>({version:1,intentId:id,binding:binding(),expiresAt:1100000});
async function accepted(h:LibraryClient,op:string,body:unknown,actor:string,key?:string){const r=await h.command(op,body,actor,key);expect(r.status,JSON.stringify(r)).toBe(200);expect(r.body.accepted,JSON.stringify(r)).toBe(true);return r;}
async function candidate(h:LibraryClient,n=0){
 const id=`transfer-${n}`,snapshotId=`snapshot-${n}`,verificationId=`verification-${n}`,candidateId=`candidate-${n}`;
 await accepted(h,'stageTransfer',stage(id),'writer');
 await accepted(h,'attestTransfer',{version:1,attestationId:`attestation-${n}`,intentId:id,generation:1,attestedAt:1000000,expiresAt:1100000,binding:binding(),manifestHash:H,bytes:12,hostAttestation:H},'verifier');
 await accepted(h,'publishSnapshot',{version:1,snapshotId,intentId:id,generation:1,attestationId:`attestation-${n}`,provenance:{source:'fixture-read',parentSnapshotId:null}},'writer');
 await accepted(h,'recordVerification',{version:1,verificationId,snapshotId,hostAttestation:H},'verifier');
 await accepted(h,'createCandidate',{version:1,candidateId,snapshotId,verificationId,expectedCanonicalRevision:0},'writer');
 return candidateId;
}
describe('actual Library authority and durable SQLite',()=>{
 it('persists publication/verification/canonical decision and replays after runtime restart',()=>withLibrary(async h=>{
  const candidateId=await candidate(h);
  const body={version:1,candidateId,expectedCanonicalRevision:0};
  const promoted=await accepted(h,'promoteCandidate',body,'owner','lost-promotion');
  const before=await h.snapshot();expect(before.body.canonicalRevision).toBe(1);expect(before.body.canonicalSnapshotId).toBe('snapshot-0');
  await h.restart();expect(await h.command('promoteCandidate',body,'owner','lost-promotion')).toEqual(promoted);expect(await h.snapshot()).toEqual(before);
 }));
 it('allows one winner from twenty promotions and retains all candidates',()=>withLibrary(async h=>{
  const ids=[];for(let n=0;n<20;n++)ids.push(await candidate(h,n));
  const results=await Promise.all(ids.map(async(candidateId,n)=>{
   // Admission backpressure is transient; replay the exact same identity.
   for(let retry=0;retry<40;retry++){const result=await h.command('promoteCandidate',{version:1,candidateId,expectedCanonicalRevision:0},'owner',`race-${n}`);if(result.status!==429)return result;}
   throw new Error('bounded admission retry exhausted');
  }));
  expect(results.filter(r=>r.body.accepted)).toHaveLength(1);
  expect(results.filter(r=>r.status===409)).toHaveLength(19);
  const snap=(await h.snapshot()).body;expect(snap.canonicalRevision).toBe(1);expect(snap.records.filter((r:any)=>r.kind==='candidate')).toHaveLength(20);
 }));
 it('fences late attestation/publication after durable cancellation and after expiry',()=>withLibrary(async h=>{
  await accepted(h,'stageTransfer',stage(),'writer');
  await accepted(h,'attestTransfer',{version:1,attestationId:'attestation',intentId:'transfer',generation:1,attestedAt:1000000,expiresAt:1100000,binding:binding(),manifestHash:H,bytes:12,hostAttestation:H},'verifier');
  await accepted(h,'cancelTransfer',{version:1,intentId:'transfer',reason:'owner-cancel'},'owner');
  const publish={version:1,snapshotId:'late',intentId:'transfer',generation:1,attestationId:'attestation',provenance:{source:'fixture',parentSnapshotId:null}};
  expect((await h.command('publishSnapshot',publish,'writer')).status).toBe(409);
  await accepted(h,'stageTransfer',stage('expires'),'writer');await h.request('/__test/clock',{now:1200000});
  expect((await h.command('attestTransfer',{version:1,attestationId:'late-attest',intentId:'expires',generation:1,attestedAt:1000000,expiresAt:1100000,binding:binding(),manifestHash:H,bytes:12,hostAttestation:H},'verifier')).status).toBe(409);
  expect((await h.snapshot()).body.records.filter((r:any)=>r.kind==='snapshot')).toHaveLength(0);
 }));
 it('rolls back a post-write fault and permits the same command identity to retry',()=>withLibrary(async h=>{
  const before=await h.snapshot();await h.request('/__test/fault',{});
  expect((await h.command('stageTransfer',stage(),'writer','atomic')).status).toBe(503);
  expect(await h.snapshot()).toEqual(before);
  await accepted(h,'stageTransfer',stage(),'writer','atomic');
 }));
 it('rejects cross-project identities, forged context, executor and unconfigured projects',()=>withLibrary(async h=>{
  for(const actor of ['foreign','owner-b','writer-b','verifier-b','executor'])expect((await h.snapshot('project-a',actor)).status).toBe(403);
  expect((await h.snapshot('project-b','owner-b')).status).toBe(200);
  expect((await h.snapshot('missing')).status).toBe(404);
  expect((await h.snapshot('project-a','wrongenv')).status).toBe(401);
  expect((await h.request('/v1/library/project-a/commands',{operation:'stageTransfer',key:'forge',body:stage(),actor:{principal:'owner',role:'owner'}},'writer')).status).toBe(400);
  expect((await h.command('recordVerification',{version:1,verificationId:'forged',snapshotId:'fake',hostAttestation:H},'writer')).status).toBe(403);
 }));
 it('keeps transport disabled by default and bounds malformed/oversized input',()=>withLibrary(async h=>{
  expect((await h.request('/__test/disabled',{})).status).toBe(503);
  for(const body of [null,[],{operation:'no',key:'x',body:{}}])expect((await h.request('/v1/library/project-a/commands',body,'writer')).status).toBe(400);
  expect((await h.request('/v1/library/project-a/commands',{text:'x'.repeat(66000)},'writer')).status).toBe(413);
 }));
 it('rechecks authentication after a held streaming body',()=>withLibrary(async h=>{
  const pending=h.request('/__test/slow',{path:'/v1/library/project-a/commands',body:{operation:'stageTransfer',key:'held',body:stage()}},'writer');
  for(let n=0;n<100;n++){if((await h.request('/__test/held',{})).body.held)break;}
  expect((await h.request('/__test/held',{})).body.held).toBe(true);
  await h.request('/__test/auth-revoke',{});await h.request('/__test/release',{});
  expect((await pending).status).toBe(401);
  await h.restart();expect((await h.snapshot()).body.records).toHaveLength(0);
 }));
});

describe('project namespace and host configuration races',()=>{
 it('rejects a project-B route delivered directly to project-A object',()=>withLibrary(async h=>{
  const before=await h.snapshot();
  expect((await h.request('/__test/direct',{path:'/v1/library/project-b/snapshot',body:{}},'owner-b')).body.code).toBe('authority-project-mismatch');
  expect(await h.snapshot()).toEqual(before);
 }));
 it('rejects a changed policy on reopen without rewriting original evidence',()=>withLibrary(async h=>{
  await accepted(h,'stageTransfer',stage(),'writer');const before=await h.snapshot();
  const {policies}=await import('../test-support/client');
  await h.restart(policies.map(p=>({...p,policyVersion:'v2'})));
  expect((await h.snapshot()).status).toBe(409);
  await h.restart();expect(await h.snapshot()).toEqual(before);
 }));
 it.each(['LIBRARY_PROJECTS','LIBRARY_AUTHORITY_NAME','LIBRARY_ENVIRONMENT','LIBRARY_TRANSPORT_ENABLED'])('rejects %s changes during body read with no domain mutation',key=>withLibrary(async h=>{
  const before=await h.snapshot();
  const pending=h.request('/__test/slow',{path:'/v1/library/project-a/commands',body:{operation:'stageTransfer',key:'config-race',body:stage()}},'writer');
  for(let n=0;n<100;n++){if((await h.request('/__test/held',{})).body.held)break;}
  expect((await h.request('/__test/held',{})).body.held).toBe(true);
  const {policies}=await import('../test-support/client');
  const value=key==='LIBRARY_PROJECTS'?JSON.stringify(policies.map(p=>({...p,policyVersion:'v2'}))):key==='LIBRARY_TRANSPORT_ENABLED'?'false':'other';
  await h.request('/__test/config',{key,value});await h.request('/__test/release',{});
  expect((await pending).status).toBeGreaterThanOrEqual(400);
  await h.restart();expect(await h.snapshot()).toEqual(before);
 }));
});

describe('aggregate body admission and reserved controls',()=>{
 it('bounds held writer requests and permits owner revocation while writer slots are full',()=>withLibrary(async h=>{
  const pending=Array.from({length:4},(_,n)=>h.request('/__test/slow',{id:`held-${n}`,path:'/v1/library/project-a/commands',body:{operation:'stageTransfer',key:`held-${n}`,body:stage(`held-${n}`)}},'writer'));
  for(let n=0;n<100;n++){if((await h.request('/__test/held',{})).body.count===4)break;}
  expect((await h.request('/__test/held',{})).body.count).toBe(4);
  expect((await h.command('stageTransfer',stage('overflow'),'writer')).status).toBe(429);
  expect((await h.command('revokePolicy',{version:1,reason:'control-under-load'},'owner')).status).toBe(200);
  await h.request('/__test/release',{});
  const replies=await Promise.all(pending);expect(replies.every(r=>r.status===409)).toBe(true);
  expect((await h.snapshot()).body.records.filter((r:any)=>r.kind==='intent')).toHaveLength(0);
  expect((await h.command('stageTransfer',stage('after'),'writer')).status).toBe(409);
 }));
});
