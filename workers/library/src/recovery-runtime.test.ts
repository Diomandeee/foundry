import {createHash} from 'node:crypto';
import {token} from '../test-support/client';
import {describe,it,expect} from 'vitest';
import {LibraryClient,withLibrary} from '../test-support/client';
const hash='a'.repeat(64);
const transfer={version:1,intentId:'recovery-intent',binding:{projectId:'project-a',policyVersion:'v1',policyHash:hash,compute:{authorityId:'compute',workloadId:'job',leaseId:'lease',attemptId:'lease',capabilityDigest:hash,workerId:'mac',epoch:1,generation:0,incarnation:0},content:{manifestHash:hash,objectKey:`projects/project-a/manifests/${hash}`,objectGeneration:'1',objectHash:hash,bytes:12}},expiresAt:1100000};
describe('owner catalog archive over actual authenticated workerd',()=>{
 it('exports full journal and restores an empty independent SQLite runtime with exact replay',async()=>{
  const source=await LibraryClient.create();let backup:{archive:string;sha256:string},original:any,before:any;
  try{
   original=await source.command('stageTransfer',transfer,'writer','restore-stable');expect(original.status).toBe(200);
   await source.command('cancelTransfer',{version:1,intentId:'recovery-intent',reason:'before-backup'},'owner','restore-cancel');
   before=await source.snapshot();const exported=await source.request('/v1/library/project-a/export',{});expect(exported.status).toBe(200);backup=exported.body;
  }finally{await source.dispose();}
  const target=await LibraryClient.create();
  try{
   const restored=await target.restore(backup!.archive,backup!.sha256);expect(restored.status,JSON.stringify({result:restored,error:(await target.request('/__test/sql-error',{})).body})).toBe(200);expect(restored.body.metadataRestored).toBe(true);expect(restored.body.contentVerified).toBe(false);
   expect(await target.snapshot()).toEqual(before);
   expect((await target.command('stageTransfer',transfer,'writer','restore-stable')).status).toBe(409);
   expect((await target.reconcile(backup!.sha256)).status).toBe(200);
   expect(await target.command('stageTransfer',transfer,'writer','restore-stable')).toEqual(original);
   await target.restart();expect(await target.snapshot()).toEqual(before);expect(await target.command('stageTransfer',transfer,'writer','restore-stable')).toEqual(original);
   expect((await target.restore(backup!.archive,backup!.sha256)).status).toBe(400);
   expect(await target.snapshot()).toEqual(before);
  }finally{await target.dispose();}
 });
 it('protects archive endpoints and rejects a wrong external digest without initializing the target',()=>withLibrary(async h=>{
  expect((await h.restore('{}',hash,'writer')).status).toBe(403);
  expect((await h.restore('{}',hash)).status).toBe(400);
  expect((await h.restore('{}',hash,'owner','application/json')).status).toBe(415);
  expect((await h.request('/v1/library/project-a/export',{},'writer')).status).toBe(403);
  expect((await h.request('/v1/library/project-a/export',{})).status).toBe(400);
  expect((await h.command('stageTransfer',transfer,'writer')).status).toBe(200);
 }));
});


describe('exclusive restore and exact archive bytes',()=>{
 async function backup(){const source=await LibraryClient.create();try{await source.command('stageTransfer',transfer,'writer','restore-key');return (await source.request('/v1/library/project-a/export',{})).body as {archive:string;sha256:string};}finally{await source.dispose();}}
 it('blocks initialization/mutation while a restore body is held',async()=>{
  const b=await backup(),target=await LibraryClient.create();try{
   const pending=target.request('/__test/slow',{id:'restore',path:'/v1/library/project-a/restore',raw:true,body:b.archive},'owner',{'content-type':'application/vnd.foundry.catalog-recovery+json','x-catalog-archive-sha256':b.sha256});
   for(let n=0;n<100;n++){if((await target.request('/__test/held',{})).body.held)break;}
   expect((await target.snapshot()).status).toBe(429);expect((await target.command('stageTransfer',{...transfer,intentId:'interloper'},'writer')).status).toBe(429);
   await target.request('/__test/release',{});expect((await pending).status).toBe(200);
   expect((await target.snapshot()).body.records.filter((r:any)=>r.kind==='intent')).toHaveLength(1);
  }finally{await target.dispose();}
 });
 it('rejects a writer body admitted before a completed restore',async()=>{
  const b=await backup(),target=await LibraryClient.create();try{
   const pending=target.request('/__test/slow',{id:'old-write',path:'/v1/library/project-a/commands',body:{operation:'stageTransfer',key:'old-write',body:{...transfer,intentId:'interloper'}}},'writer');
   for(let n=0;n<100;n++){if((await target.request('/__test/held',{})).body.held)break;}
   expect((await target.restore(b.archive,b.sha256)).status).toBe(200);
   await target.request('/__test/release',{});expect((await pending).status).toBe(409);
   expect((await target.snapshot()).body.records.filter((r:any)=>r.kind==='intent')).toHaveLength(1);
  }finally{await target.dispose();}
 });
 it('does not normalize a BOM-prefixed archive into the pinned original',async()=>{
  const b=await backup(),target=await LibraryClient.create();try{expect((await target.restore('\ufeff'+b.archive,b.sha256)).status).toBe(400);expect((await target.restore(b.archive,b.sha256)).status).toBe(200);}finally{await target.dispose();}
 });
});


it('requires an independent matching checkpoint and fresh registered-fence observations before clearing quarantine',async()=>{
 const source=await LibraryClient.create();let b:any;try{await source.command('stageTransfer',transfer,'writer','latest-key');b=(await source.request('/v1/library/project-a/export',{})).body;}finally{await source.dispose();}
 const target=await LibraryClient.create();try{
  expect((await target.restore(b.archive,b.sha256)).body.quarantined).toBe(true);
  expect((await target.request('/v1/library/project-a/recovery-status',{})).body.quarantined).toBe(true);
  expect((await target.reconcile('f'.repeat(64))).status).toBe(409);
  expect((await target.request('/v1/library/project-a/recovery-status',{})).body.quarantined).toBe(true);
  expect((await target.reconcile(b.sha256,true)).status).toBe(200);
  expect((await target.request('/v1/library/project-a/recovery-status',{})).body.quarantined).toBe(false);
  expect((await target.snapshot()).body.records.some((r:any)=>r.kind==='cancellation')).toBe(true);
 }finally{await target.dispose();}
});


it('keeps quarantine closed when the owner credential is downgraded during host reconciliation',async()=>{
 const source=await LibraryClient.create();let b:any;try{await source.command('stageTransfer',transfer,'writer');b=(await source.request('/v1/library/project-a/export',{})).body;}finally{await source.dispose();}
 const target=await LibraryClient.create();try{
  expect((await target.restore(b.archive,b.sha256)).status).toBe(200);
  await target.request('/__test/config',{key:'FIXTURE_HOLD_RECOVERY',value:true});const pending=target.reconcile(b.sha256);
  for(let n=0;n<100;n++){if((await target.request('/__test/recovery-held',{})).body.held)break;}
  expect((await target.request('/__test/recovery-held',{})).body.held).toBe(true);
  const tokenSha256=createHash('sha256').update(token('owner')).digest('hex');
  await target.request('/__test/config',{key:'LIBRARY_AUTH_CONFIG',value:JSON.stringify([{tokenSha256,principal:'writer',role:'submitter',environment:'library-local'}])});
  await target.request('/__test/recovery-release',{});expect((await pending).status).toBe(403);
  await target.request('/__test/config',{key:'LIBRARY_AUTH_CONFIG',value:JSON.stringify([{tokenSha256,principal:'owner',role:'owner',environment:'library-local'}])});
  expect((await target.request('/v1/library/project-a/recovery-status',{})).body.quarantined).toBe(true);
 }finally{await target.dispose();}
});
it('rolls back imported history and receipts if creation of the quarantine guard fails',async()=>{
 const source=await LibraryClient.create();let b:any;try{await source.command('stageTransfer',transfer,'writer');b=(await source.request('/v1/library/project-a/export',{})).body;}finally{await source.dispose();}
 const target=await LibraryClient.create();try{
  await target.request('/__test/guard-fault',{});expect((await target.restore(b.archive,b.sha256)).status).toBe(503);
  expect((await target.request('/v1/library/project-a/export',{})).status).toBe(400);
  expect((await target.restore(b.archive,b.sha256)).status).toBe(200);
  expect((await target.request('/v1/library/project-a/recovery-status',{})).body.quarantined).toBe(true);
 }finally{await target.dispose();}
});
