// Actual workerd/SQLite domain acceptance, not a synchronous Map race simulation.
import {createHash} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {TestClient,owner,submitter,projector,verifier,executor,type Row} from '../test-support/client.js';
const output=Buffer.from('499500\n');
const hash=createHash('sha256').update(output).digest('hex');
const policy={sha256:hash,maxBytes:4096,exitCode:0};
const submission=(workloadId='job',resources:Row={cpu:1,ramMib:64})=>({workloadId,specification:JSON.stringify({template:'reference-cpu',version:1,inputHash:hash}),resources,policy,pure:true,reconstructible:true,maxAttempts:3});
async function withClient(run:(h:TestClient)=>Promise<void>) {const h=await TestClient.create();try{await run(h);}finally{await h.dispose();}}
async function register(h:TestClient,id='worker-a',cpu=2,ramMib=4096,devices:Row[]=[]) {
 const r=await h.command(owner,'registerWorker',{workerId:id,principal:`principal-${id}`,workerClass:'general',cpu,ramMib,devices});
 expect(r.ok,JSON.stringify(r)).toBe(true);
}
async function seed(h:TestClient,id='job') {
 expect((await h.command(owner,'setQuota',{principal:submitter.principal,maxActive:100,allowedClass:'general'})).ok).toBe(true);
 await register(h);const s=await h.command(submitter,'submit',submission(id));expect(s.ok,JSON.stringify(s)).toBe(true);
}
async function claim(h:TestClient,key?:string,id='job',worker='worker-a',generation=0,incarnation=0) {
 return h.command(executor(worker),'claim',{workloadId:id,workerId:worker,expectedGeneration:generation,incarnation,ttlMs:1000},key);
}
function leaseOf(response:Row):Row {expect(response.ok,JSON.stringify(response)).toBe(true);expect(response.lease).toBeTruthy();return response.lease;}
function fence(lease:Row):Row {return {leaseId:lease.leaseId??lease.id,epoch:lease.epoch,generation:lease.generation,incarnation:lease.incarnation,capability:lease.capability};}

describe('durable authority on actual local workerd SQLite',()=>{
 it('persists one idempotent grant and capability across runtime recreation/lost-response replay',()=>withClient(async h=>{
  await seed(h);const first=leaseOf(await claim(h,'lost-claim'));
  await h.restart();const replay=leaseOf(await claim(h,'lost-claim'));
  expect(replay).toEqual(first);
  for(const table of ['placements','attempts','leases','reservations']) expect(await h.dump(table)).toHaveLength(1);
  const stored=JSON.stringify(await Promise.all(['commands','events','outbox','leases','authority_meta'].map(t=>h.dump(t))));
  expect(stored).not.toContain(first.capability);expect(stored).not.toContain('fixture-only-issuer-key');
 }));
 it('twenty simultaneous real runtime claimants produce one attempt/reservation',()=>withClient(async h=>{
  await seed(h);const responses=await Promise.all(Array.from({length:20},(_,i)=>claim(h,`claim-${i}`)));
  expect(responses.filter(r=>r.ok&&r.lease)).toHaveLength(1);
  expect(await h.dump('attempts')).toHaveLength(1);expect(await h.dump('reservations')).toHaveLength(1);
 }));
 it('twenty jobs cannot overspend one CPU and concurrent same-key redelivery is a no-op',()=>withClient(async h=>{
  await seed(h);await register(h,'worker-one',1,128);
  for(let i=0;i<20;i++)expect((await h.command(submitter,'submit',submission(`j${i}`))).ok).toBe(true);
  const results=await Promise.all(Array.from({length:20},(_,i)=>claim(h,`jclaim${i}`,`j${i}`,'worker-one')));
  expect(results.filter(r=>r.ok&&r.lease)).toHaveLength(1);
  expect((await h.dump('reservations')).filter(r=>r.worker_id==='worker-one'&&r.state!=='released').reduce((n,r)=>n+r.cpu,0)).toBe(1);
  const replay=await Promise.all(Array.from({length:20},()=>claim(h,'duplicate','job')));
  expect(new Set(replay.filter(r=>r.ok&&r.lease).map(r=>r.lease.leaseId??r.lease.id)).size).toBe(1);
 }));
 it('rolls back state, events, outbox and command response after an injected post-outbox fault',()=>withClient(async h=>{
  await seed(h);
  const tables=['placements','attempts','leases','reservations','commands','events','outbox'];
  const before=await Promise.all(tables.map(t=>h.dump(t)));await h.configure({failNextOutbox:true});
  const failed=await claim(h,'rollback-claim');expect(failed.ok).not.toBe(true);
  expect(await Promise.all(tables.map(t=>h.dump(t)))).toEqual(before);
  const retried=leaseOf(await claim(h,'rollback-claim'));expect(retried.capability).toBeTruthy();
 }));
 it('rejects conflicting identity/idempotency and scope replay',()=>withClient(async h=>{
  await seed(h);const first=await h.command(submitter,'submit',submission('same'),'same-key');expect(first.ok).toBe(true);
  expect((await h.command(submitter,'submit',submission('other'),'same-key')).ok).toBe(false);
  expect((await h.command(submitter,'submit',{...submission('same'),resources:{cpu:2,ramMib:64}})).ok).toBe(false);
  const l=leaseOf(await claim(h,'scoped'));expect((await h.command(executor('other'),'renew',{...fence(l),sequence:1,ttlMs:1000})).ok).toBe(false);
 }));
 it('renews each sequence once across restart without replay extending expiry',()=>withClient(async h=>{
  await seed(h);const l=leaseOf(await claim(h));await h.configure({now:1000500});
  const request={...fence(l),sequence:1,ttlMs:1000};const first=await h.command(executor(),'renew',request,'renew-first');expect(first.ok).toBe(true);
  const expires=(await h.dump('leases'))[0].expires_ms;
  await h.restart();await h.configure({now:1000750});
  expect((await h.command(executor(),'renew',request,'different-retry-key')).ok).toBe(true);
  expect((await h.dump('leases'))[0].expires_ms).toBe(expires);
  expect((await h.command(executor(),'renew',{...request,ttlMs:500},'sequence-conflict')).ok).toBe(false);
 }));
 it('fences expiry, quarantines physical reservations and safely re-places on another worker',()=>withClient(async h=>{
  await seed(h);await register(h,'worker-b');const l=leaseOf(await claim(h));await h.configure({now:1001000});
  expect((await h.command(owner,'sweep',{})).ok).toBe(true);
  const old=(await h.dump('workers')).find(r=>r.id==='worker-a')!;expect(old.quarantined).toBe(1);
  expect((await h.dump('reservations')).find(r=>r.worker_id==='worker-a')!.state).toBe('quarantined');
  expect((await h.command(executor(),'renew',{...fence(l),sequence:1,ttlMs:1000})).ok).toBe(false);
  expect((await claim(h,'blocked','job','worker-a',1,old.incarnation)).ok).toBe(false);
  const replacement=leaseOf(await claim(h,'replacement','job','worker-b',1));expect(replacement.generation).toBe(1);
  expect((await h.command(owner,'reconcileStop',{workerId:'worker-a',incarnation:old.incarnation,stopReceipt:'confirmed-stop'})).ok).toBe(true);
  expect((await h.dump('reservations')).find(r=>r.worker_id==='worker-a')!.state).toBe('released');
 }));
 it('checks independent immutable bytes outside transactions and persists one winning receipt',()=>withClient(async h=>{
  await seed(h);const l=leaseOf(await claim(h));const artifactRef=await h.stageArtifact(output);
  expect((await h.command(executor(),'stageResult',{...fence(l),artifactRef,sha256:hash,bytes:output.length,exitCode:0})).ok).toBe(true);
  await h.restart();await h.configure({now:1001001});
  const request={key:'verification',leaseId:fence(l).leaseId,epoch:l.epoch,generation:l.generation,incarnation:l.incarnation};
  expect((await h.verify(verifier,request)).ok).toBe(true);
  expect((await h.verify(verifier,request)).ok).toBe(true);
  expect(await h.dump('receipts')).toHaveLength(1);expect((await h.dump('workloads'))[0].status).toBe('SUCCEEDED');
  expect((await h.configure({})).artifactReads).toBeGreaterThan(0);
  expect((await h.command(submitter,'submit',submission())).ok).toBe(true);
  expect(await h.dump('receipts')).toHaveLength(1);
 }));
 it('never verifies wrong artifact bytes',()=>withClient(async h=>{
  await seed(h);const l=leaseOf(await claim(h));const artifactRef=await h.stageArtifact(Buffer.from('wrong'));
  const staged=await h.command(executor(),'stageResult',{...fence(l),artifactRef,sha256:hash,bytes:output.length,exitCode:0});
  expect(staged.ok).toBe(true);
  const request={key:'bad-verification',leaseId:fence(l).leaseId,epoch:l.epoch,generation:l.generation,incarnation:l.incarnation};
  expect((await h.verify(verifier,request)).ok).toBe(false);expect(await h.dump('receipts')).toHaveLength(0);
 }));
 it('retains outbox delivery/ack position across restart and rejects skipped acknowledgements',()=>withClient(async h=>{
  await seed(h);await claim(h);
  expect((await h.command(projector,'ackOutbox',{through:999})).ok).toBe(false);
  const delivered=await h.command(projector,'readOutbox',{after:0,limit:2});expect(delivered.ok).toBe(true);
  expect((await h.command(projector,'ackOutbox',{through:3})).ok).toBe(false);
  expect((await h.command(projector,'ackOutbox',{through:2})).ok).toBe(true);
  await h.restart();expect((await h.dump('authority_meta'))[0].ack_seq).toBe(2);
  expect((await h.command(projector,'readOutbox',{after:2,limit:100})).ok).toBe(true);
 }));
 it('recovery epoch fences old contexts and old capabilities across restart',()=>withClient(async h=>{
  await seed(h);const l=leaseOf(await claim(h,'original'));
  expect((await h.command(owner,'bumpEpoch',{expectedEpoch:1},'recover')).ok).toBe(true);
  await h.restart();expect(await h.epoch()).toBe(2);
  expect((await h.command(owner,'sweep',{},'old-context',1)).ok).toBe(false);
  expect((await h.command(executor(),'renew',{...fence(l),sequence:1,ttlMs:1000})).ok).toBe(false);
  expect((await h.dump('reservations'))[0].state).toBe('quarantined');
 }));
 for (const mode of ['cancel','timeout']) it(`rejects ${mode} during independent verification deadline`,()=>withClient(async h=>{
  await seed(h);const l=leaseOf(await claim(h));const artifactRef=await h.stageArtifact(output);
  expect((await h.command(executor(),'stageResult',{...fence(l),artifactRef,sha256:hash,bytes:output.length,exitCode:0})).ok).toBe(true);
  if(mode==='cancel') expect((await h.command(owner,'cancel',{workloadId:'job',expectedGeneration:0})).ok).toBe(true);
  else await h.configure({now:1120001});
  expect((await h.verify(verifier,{key:'late',leaseId:fence(l).leaseId,epoch:l.epoch,generation:l.generation,incarnation:l.incarnation})).ok).toBe(false);
  expect(await h.dump('receipts')).toHaveLength(0);
 }));

 for(const mode of ['cancel','timeout','epoch']) it(`rechecks ${mode} after suspended artifact I/O on workerd`,()=>withClient(async h=>{
  await seed(h);const l=leaseOf(await claim(h));const artifactRef=await h.stageArtifact(output);
  expect((await h.command(executor(),'stageResult',{...fence(l),artifactRef,sha256:hash,bytes:output.length,exitCode:0})).ok).toBe(true);
  await h.configure({pauseRead:true});
  const pending=h.verify(verifier,{key:'suspended',leaseId:fence(l).leaseId,epoch:l.epoch,generation:l.generation,incarnation:l.incarnation});
  for(let i=0;i<100;i++){if((await h.configure({})).artifactReads>0)break;}
  expect((await h.configure({})).artifactReads).toBe(1);
  if(mode==='cancel') expect((await h.command(owner,'cancel',{workloadId:'job',expectedGeneration:0})).ok).toBe(true);
  if(mode==='timeout') await h.configure({now:1120001});
  if(mode==='epoch') expect((await h.command(owner,'bumpEpoch',{expectedEpoch:1})).ok).toBe(true);
  await h.configure({releaseRead:true});expect((await pending).ok).toBe(false);
  expect(await h.dump('receipts')).toHaveLength(0);
  expect((await h.dump('reservations'))[0].state).toBe('quarantined');
 }));

});
