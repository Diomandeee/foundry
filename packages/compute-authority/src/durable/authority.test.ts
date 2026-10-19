import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { DurableAuthority, type TrustedContext, type CommandEnvelope, type TransactionPort } from './authority';
const bytes=new TextEncoder().encode('durable-result');
const sha=createHash('sha256').update(bytes).digest('hex');
const owner:TrustedContext={principal:'owner',role:'owner',expectedEpoch:1};
const executor:TrustedContext={principal:'executor',role:'executor',expectedEpoch:1};
const verifier:TrustedContext={principal:'verifier',role:'verifier',expectedEpoch:1};
function fixture(){
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');let time=1000,fail=false,inTransaction=false,reads=0;let read:()=>Promise<Uint8Array>=async()=>bytes;
 const storage:TransactionPort={sql:{exec(sql,...bindings){const stmt=db.prepare(sql);const rows=stmt.all(...bindings as any[]);if(fail&&/^INSERT INTO outbox/.test(sql)){fail=false;throw new Error('outbox fault');}return rows as Record<string,unknown>[];}},transactionSync(fn){db.exec('BEGIN IMMEDIATE');inTransaction=true;try{const x=fn();db.exec('COMMIT');return x;}catch(e){db.exec('ROLLBACK');throw e;}finally{inTransaction=false;}}};
 const options={environment:'test',authorityId:'local',issuerId:'fixture',issuerKey:'local-fixture-key-000000000000000000000',now:()=>time,maxLeaseLifetimeMs:100,verificationDeadlineMs:200,readArtifact:async()=>{expect(inTransaction).toBe(false);reads++;return read();}};
 let core=new DurableAuthority(storage,options);let sequence=0;
 const run=(operation:string,body:unknown,c=owner,key=`k${++sequence}`)=>core.execute(c,{operation,body,key} as CommandEnvelope) as any;
 const table=(name:string)=>db.prepare(`SELECT * FROM ${name}`).all() as any[];
 const worker=(id='w',extra={})=>run('registerWorker',{workerId:id,principal:'executor',workerClass:'general',cpu:4,ramMib:100,devices:[{id:'gpu',kind:'cuda',vramMib:16}],...extra});
 const submit=(id='job',extra={})=>run('submit',{workloadId:id,specification:'fixed-cpu-v1',resources:{cpu:2,ramMib:20},policy:{sha256:sha,maxBytes:100,exitCode:0},pure:true,reconstructible:true,maxAttempts:3,...extra});
 const claim=(id='job',wid='w',extra={},key?:string)=>run('claim',{workloadId:id,workerId:wid,expectedGeneration:0,incarnation:0,ttlMs:50,...extra},executor,key);
 const start=()=>{run('setQuota',{principal:'owner',maxActive:10,allowedClass:'general'});worker();submit();return claim().lease;};
 const fence=(l:any)=>({leaseId:l.id,epoch:l.epoch,generation:l.generation,incarnation:l.incarnation,capability:l.capability});
 const stage=(l:any,extra={})=>run('stageResult',{...fence(l),artifactRef:'artifact',sha256:sha,bytes:bytes.length,exitCode:0,...extra},executor);
 const verify=(l:any,key='verify')=>core.verifyAndFinalize(verifier,{key,leaseId:l.id,epoch:l.epoch,generation:l.generation,incarnation:l.incarnation}) as Promise<any>;
 return {db,run,table,worker,submit,claim,start,fence,stage,verify,get core(){return core;},restart(){core=new DurableAuthority(storage,options);},at(n:number){time=n;},fault(){fail=true;},reader(fn:()=>Promise<Uint8Array>){read=fn;},get reads(){return reads;}};
}
describe('durable SQL authority (Node adapter, not workerd proof)',()=>{
 it('commits actual-byte journey and replays receipt after restart without rereading bytes',async()=>{
  const f=fixture(),l=f.start();expect(l.capability).toHaveLength(64);expect(f.stage(l).ok).toBe(true);const result=await f.verify(l);expect(result.ok).toBe(true);f.restart();expect(await f.verify(l)).toEqual(result);expect(f.reads).toBe(1);
  expect(f.table('receipts')).toHaveLength(1);expect(f.table('workloads')[0].winner).toBe(l.id);expect(f.table('reservations')[0].state).toBe('quarantined');expect(f.table('workers')[0].quarantined).toBe(1);
  expect(f.run('requeue',{workloadId:'job',expectedGeneration:0,requestId:'r'}).ok).toBe(false);
 });
 it('retries transient artifact reads with the same key across restart',async()=>{
  const f=fixture(),l=f.start();f.stage(l);const before=f.table('commands');
  f.reader(async()=>{throw new Error('temporary read failure');});
  expect(await f.verify(l)).toEqual({ok:false,code:'artifact-unavailable'});
  expect(f.table('commands')).toEqual(before);expect(f.table('receipts')).toEqual([]);
  f.restart();f.reader(async()=>bytes);expect((await f.verify(l)).ok).toBe(true);expect(f.reads).toBe(2);
 });
 it('propagates SQL faults while persisting oversize rejection and allows same-key retry',async()=>{
  const f=fixture(),l=f.start();f.stage(l);f.reader(async()=>new Uint8Array(101));
  const before=f.table('commands');
  f.db.exec("CREATE TRIGGER fail_verify_command BEFORE INSERT ON commands WHEN NEW.operation='verify' BEGIN SELECT RAISE(ABORT,'verify SQL fault'); END");
  await expect(f.verify(l)).rejects.toThrow('verify SQL fault');
  expect(f.table('commands')).toEqual(before);expect(f.table('receipts')).toEqual([]);
  f.db.exec('DROP TRIGGER fail_verify_command');
  expect(await f.verify(l)).toEqual({ok:false,code:'artifact-too-large'});
  f.reader(async()=>bytes);expect(await f.verify(l)).toEqual({ok:false,code:'artifact-too-large'});expect(f.reads).toBe(2);
 });
 it('rolls back finalization on outbox SQL faults and retries the same key',async()=>{
  const f=fixture(),l=f.start();f.stage(l);
  const tables=['workloads','leases','attempts','workers','reservations','receipts','commands','events','outbox'];
  const before=tables.map(t=>f.table(t));f.fault();await expect(f.verify(l)).rejects.toThrow('outbox fault');
  tables.forEach((t,i)=>expect(f.table(t)).toEqual(before[i]));expect((await f.verify(l)).ok).toBe(true);
 });
 it('projects winning and reconciled reservation/device facts using stable lease IDs',async()=>{
  const f=fixture();f.run('setQuota',{principal:'owner',maxActive:10,allowedClass:'general'});f.worker();
  f.submit('gpu-job',{resources:{cpu:2,ramMib:20,gpu:{kind:'cuda',minVramMib:16}}});
  const l=f.claim('gpu-job').lease;f.submit('peer');const peer=f.claim('peer').lease;
  f.stage(l);expect((await f.verify(l)).ok).toBe(true);
  const success=f.run('readOutbox',{after:0,limit:100}).events;
  const win=success.find((e:any)=>e.kind==='lease-succeeded');
  expect(win.entity).toBe(l.id);expect(win.payload.lease).toMatchObject({id:l.id,state:'SUCCEEDED'});
  expect(win.payload.reservation).toMatchObject({lease_id:l.id,state:'quarantined'});
  expect(win.payload.deviceReservations).toEqual([expect.objectContaining({lease_id:l.id,worker_id:'w',device_id:'gpu',state:'quarantined'})]);
  expect(win.seq).toBeGreaterThan(success.find((e:any)=>e.kind==='worker-quarantined').seq);
  expect(win.payload.receipt.lease_id).toBe(l.id);
  f.run('reconcileStop',{workerId:'w',incarnation:1,stopReceipt:'stopped'});
  const events=f.run('readOutbox',{after:0,limit:100}).events;
  const release=events.find((e:any)=>e.kind==='reservation-released'&&e.entity===l.id);
  expect(release.entity).toBe(l.id);expect(release.payload.reservation).toEqual(f.table('reservations').find(r=>r.lease_id===l.id));
  expect(release.payload.deviceReservations).toEqual(f.table('device_reservations'));
  expect(release.payload.deviceReservations[0].state).toBe('released');
  const releases=events.filter((e:any)=>e.kind==='reservation-released');
  expect(releases.map((e:any)=>e.entity).sort()).toEqual([l.id,peer.id].sort());
  for(const e of releases){expect(e.payload.reservation).toEqual(f.table('reservations').find(r=>r.lease_id===e.entity));expect(e.payload.reservation.state).toBe('released');}
  expect(releases.find((e:any)=>e.entity===peer.id).payload.lease.state).toBe('REVOKED');
  expect(events.find((e:any)=>e.kind==='lease-succeeded')).toEqual(win);
 });
 it('reconstructs same scoped capability on lost claim response and restart; stores no bearer',()=>{
  const f=fixture();f.run('setQuota',{principal:'owner',maxActive:10,allowedClass:'general'});f.worker();f.submit();const a=f.claim('job','w',{},'claim');f.restart();const b=f.claim('job','w',{},'claim');expect(b).toEqual(a);
  for(const table of ['commands','events','outbox','placements','leases'])expect(JSON.stringify(f.table(table))).not.toContain(a.lease.capability);
  expect(f.claim('job','w',{ttlMs:40},'claim').code).toBe('idempotency-conflict');expect(f.table('attempts')).toHaveLength(1);
 });
 it('rolls back domain, command response, events, outbox together',()=>{
  const f=fixture();f.run('setQuota',{principal:'owner',maxActive:10,allowedClass:'general'});f.worker();f.submit();const before=Object.fromEntries(['workloads','commands','events','outbox','leases','placements','reservations'].map(t=>[t,f.table(t)]));f.fault();expect(()=>f.claim('job','w',{},'retry')).toThrow('outbox fault');for(const [t,rows]of Object.entries(before))expect(f.table(t)).toEqual(rows);expect(f.claim('job','w',{},'retry').ok).toBe(true);
 });
 it('enforces CPU RAM and exclusive individual GPU without pooling',()=>{
  const f=fixture();f.run('setQuota',{principal:'owner',maxActive:10,allowedClass:'general'});f.worker();f.submit('a',{resources:{cpu:1,ramMib:20,gpu:{kind:'cuda',minVramMib:16}}});f.submit('b',{resources:{cpu:1,ramMib:20,gpu:{kind:'cuda',minVramMib:16}}});expect(f.claim('a').ok).toBe(true);expect(f.claim('b').code).toBe('insufficient-capacity');f.submit('c',{resources:{cpu:4,ramMib:20}});expect(f.claim('c').ok).toBe(false);f.submit('d',{resources:{cpu:1,ramMib:90}});expect(f.claim('d').ok).toBe(false);
  f.worker('other',{devices:[{id:'x',kind:'cuda',vramMib:8},{id:'y',kind:'cuda',vramMib:8}]});expect(f.claim('b','other').ok).toBe(false);
 });
 it('sweeps expiry on failed mutation and reads, retains quarantined capacity until trusted stop',()=>{
  const f=fixture(),l=f.start();f.at(1050);expect(f.run('renew',{...f.fence(l),sequence:1,ttlMs:50},executor).ok).toBe(false);expect(f.table('workloads')[0].generation).toBe(1);expect(f.table('reservations')[0].state).toBe('quarantined');expect(f.claim('job','w',{expectedGeneration:1,incarnation:1}).ok).toBe(false);
  expect(f.run('reconcileStop',{workerId:'w',incarnation:1,stopReceipt:'stopped'},executor).code).toBe('forbidden');expect(f.run('reconcileStop',{workerId:'w',incarnation:1,stopReceipt:'stopped'}).ok).toBe(true);expect(f.claim('job','w',{expectedGeneration:1,incarnation:1}).ok).toBe(true);
 });
 it('renewal is sequence-idempotent and capped; persisted monotonic clock rejects rollback',()=>{
  const f=fixture(),l=f.start();f.at(1040);const body={...f.fence(l),sequence:1,ttlMs:50};expect(f.run('renew',body,executor).expiresAt).toBe(1090);f.at(1070);expect(f.run('renew',body,executor).expiresAt).toBe(1090);expect(f.run('renew',{...body,ttlMs:40},executor).code).toBe('sequence-conflict');expect(f.run('renew',{...body,sequence:2},executor).expiresAt).toBe(1100);f.restart();f.at(100);f.core.snapshot();expect(f.table('authority_meta')[0].clock_ms).toBe(1070);f.at(1100);expect((f.core.snapshot().workloads as any[])[0].generation).toBe(1);
 });
 it('verification has separate bounded deadline and rechecks fences after async reader',async()=>{
  const f=fixture(),l=f.start();expect(f.stage(l).verificationDeadline).toBe(1200);f.at(1100);expect((f.core.snapshot().workloads as any[])[0].status).toBe('VERIFYING');f.reader(async()=>{f.run('cancel',{workloadId:'job',expectedGeneration:0});return bytes;});expect((await f.verify(l)).code).toBe('verification-fenced');expect(f.table('receipts')).toHaveLength(0);
 });
 it('rejects wrong independently retrieved bytes; times verification out on snapshot',async()=>{
  const f=fixture(),l=f.start();f.stage(l);f.reader(async()=>new Uint8Array([1]));expect((await f.verify(l)).code).toBe('verification-mismatch');f.at(1200);f.core.snapshot();expect(f.table('leases')[0].state).toBe('REVOKED');expect(f.table('receipts')).toHaveLength(0);
 });
 it('epoch recovery fences old context before replay and old capability',()=>{
  const f=fixture(),l=f.start();expect(f.run('bumpEpoch',{expectedEpoch:1}).epoch).toBe(2);expect(f.run('renew',{...f.fence(l),sequence:1,ttlMs:50},executor).code).toBe('stale-epoch');expect(f.run('sweep',{},owner,'anything').code).toBe('stale-epoch');
 });
 it('edge zero-resource enrollment never claims and schema inputs are bounded',()=>{
  const f=fixture();expect(f.worker('pi',{workerClass:'edge',cpu:0,ramMib:0,devices:[]}).ok).toBe(true);f.run('setQuota',{principal:'owner',maxActive:10,allowedClass:'general'});f.submit();expect(f.claim('job','pi').code).toBe('worker-unavailable');expect(()=>f.submit('x',{policy:{maxBytes:20,exitCode:0}})).toThrow();expect(()=>f.worker('bad',{cpu:NaN})).toThrow();expect(()=>f.run('registerWorker',{bad:1})).toThrow();
 });
 it('outbox delivers ordered durable history, rejects gaps and acknowledges only delivered prefix',()=>{
  const f=fixture();f.start();expect(f.run('ackOutbox',{through:3}).code).toBe('ack-not-delivered');const first=f.run('readOutbox',{after:0,limit:2});expect(first.events).toHaveLength(2);f.restart();expect(f.run('readOutbox',{after:0,limit:2}).events).toEqual(first.events);expect(f.run('ackOutbox',{through:first.through}).ok).toBe(true);expect(f.run('readOutbox',{after:0,limit:2}).ok).toBe(false);expect(f.run('readOutbox',{after:first.through,limit:100}).events[0].seq).toBe(first.through+1);
 });
 it('immutable specs/receipts/events and winner schema backstops reject direct corruption',async()=>{
  const f=fixture(),l=f.start();expect(()=>f.db.exec("UPDATE workloads SET winner='missing' WHERE id='job'")).toThrow('winner receipt mismatch');expect(()=>f.db.exec("UPDATE workloads SET specification='other' WHERE id='job'")).toThrow('immutable workload');f.stage(l);await f.verify(l);expect(()=>f.db.exec('DELETE FROM receipts')).toThrow();expect(()=>f.db.exec('DELETE FROM artifacts')).toThrow();expect(()=>f.db.exec('UPDATE events SET reason=\'changed\'')).toThrow();expect(()=>f.db.exec("UPDATE workloads SET status='QUEUED',winner=NULL")).toThrow();
 });
 it('requeue expected generation and request ID replay cannot fence replacement',()=>{
  const f=fixture();f.start();const req={workloadId:'job',expectedGeneration:0,requestId:'rq'};expect(f.run('requeue',req).generation).toBe(1);f.run('reconcileStop',{workerId:'w',incarnation:1,stopReceipt:'stop'});const replacement=f.claim('job','w',{expectedGeneration:1,incarnation:1}).lease;expect(f.run('requeue',req).generation).toBe(1);expect(f.table('leases').find(x=>x.id===replacement.id).state).toBe('RUNNING');
 });
 it('failed device update cannot leave a partial CPU capacity write',()=>{
  const f=fixture();f.worker();const before=f.table('workers');expect(f.worker('w',{cpu:99,devices:[]}).code).toBe('device-registry-immutable');expect(f.table('workers')).toEqual(before);
 });
 it('quota, immutable intake, principal scope and class policy fail closed',()=>{
  const f=fixture();expect(f.submit().code).toBe('quota-required');f.run('setQuota',{principal:'owner',maxActive:1,allowedClass:'general'});expect(f.submit().ok).toBe(true);expect(f.submit('other').code).toBe('quota-exceeded');expect(f.submit('job',{specification:'mutated'}).code).toBe('workload-identity-conflict');f.worker();expect(f.run('claim',{workloadId:'job',workerId:'w',expectedGeneration:0,incarnation:0,ttlMs:50},{...executor,principal:'imposter'}).code).toBe('forbidden');expect(f.table('leases')).toHaveLength(0);
 });
 it('stale epoch cannot replay any operation and new epoch cannot reuse old key',()=>{
  const f=fixture();expect(f.run('setQuota',{principal:'owner',maxActive:10,allowedClass:'general'},owner,'fixed').ok).toBe(true);f.run('bumpEpoch',{expectedEpoch:1});expect(f.run('setQuota',{principal:'owner',maxActive:10,allowedClass:'general'},owner,'fixed').code).toBe('stale-epoch');expect(f.run('setQuota',{principal:'owner',maxActive:10,allowedClass:'general'},{...owner,expectedEpoch:2},'fixed').code).toBe('idempotency-conflict');
 });
 it('projection facts retain quotas, resource vectors and monotonically versioned immutable events',()=>{
  const f=fixture();const l=f.start();const events=f.run('readOutbox',{after:0,limit:100}).events;expect(events.find((e:any)=>e.kind==='quota-set').payload.quota.max_active).toBe(10);const lease=events.find((e:any)=>e.kind==='lease-issued');expect(lease.payload.reservation.cpu).toBe(2);expect(JSON.parse(lease.payload.placement.snapshot).candidates[0].reasons).toEqual([]);expect(lease.payload.lease.id).toBe(l.id);for(let i=1;i<events.length;i++)expect(events[i].entity_version).toBeGreaterThan(events[i-1].entity_version);
 });
 it('caps large historical outbox batches without losing the contiguous remainder',()=>{
  const f=fixture();f.run('setQuota',{principal:'owner',maxActive:100,allowedClass:'general'});for(let i=0;i<55;i++)f.submit(`large${i}`,{specification:'x'.repeat(16000)});
  const first=f.run('readOutbox',{after:0,limit:100});expect(first.ok).toBe(true);expect(first.events.length).toBeLessThan(56);expect(JSON.stringify(first).length).toBeLessThan(1000000);f.run('ackOutbox',{through:first.through});const next=f.run('readOutbox',{after:first.through,limit:100});expect(next.ok).toBe(true);expect(next.events.length+first.events.length).toBe(56);
 });
 it('never retries work unless both pure and reconstructible',()=>{
  const f=fixture();f.run('setQuota',{principal:'owner',maxActive:10,allowedClass:'general'});f.worker();f.submit('unsafe',{pure:false});f.claim('unsafe');f.at(1100);f.core.snapshot();expect(f.table('workloads')[0].status).toBe('FAILED');expect(f.run('requeue',{workloadId:'unsafe',expectedGeneration:0,requestId:'unsafe'}).ok).toBe(false);
 });
});

describe('owner worker quarantine for enrollment revocation',()=>{
 it('fences an active attempt without releasing physical reservations and replays safely',()=>{
  const f=fixture(),lease=f.start();
  const revoked=f.run('quarantineWorker',{workerId:'w',expectedIncarnation:0},owner,'revoke-device');
  expect(revoked.ok).toBe(true);expect(revoked.worker).toMatchObject({incarnation:1,quarantined:1});
  expect(f.table('leases')[0].state).toBe('REVOKED');expect(f.table('reservations')[0].state).toBe('quarantined');
  expect(f.stage(lease).ok).toBe(false);f.restart();
  expect(f.run('quarantineWorker',{workerId:'w',expectedIncarnation:0},owner,'revoke-device')).toEqual(revoked);
  expect(f.run('quarantineWorker',{workerId:'w',expectedIncarnation:0}).ok).toBe(false);
  expect(f.run('quarantineWorker',{workerId:'w',expectedIncarnation:1}).worker.incarnation).toBe(1);
 });
 it('rejects executor revocation and rolls back fencing on audit failure',()=>{
  const f=fixture();f.start();expect(f.run('quarantineWorker',{workerId:'w',expectedIncarnation:0},executor).ok).toBe(false);
  f.fault();expect(()=>f.run('quarantineWorker',{workerId:'w',expectedIncarnation:0})).toThrow('outbox fault');
  expect(f.table('workers')[0]).toMatchObject({incarnation:0,quarantined:0});expect(f.table('leases')[0].state).toBe('RUNNING');
 });
});

describe('quarantine expiry ordering and speculative poll admission',()=>{
 it('revokes an expired active lease in the same command without self-stale rollback',()=>{const f=fixture();f.start();f.at(1050);const r=f.run('quarantineWorker',{workerId:'w',expectedIncarnation:0});expect(r.ok).toBe(true);expect(f.table('workers')[0]).toMatchObject({incarnation:1,quarantined:1});expect(f.table('leases')[0].state).toBe('REVOKED');});
 it('does not retain rejected speculative claims while ordinary command replay remains unchanged',()=>{const f=fixture();f.worker();const before=f.table('commands').length;const r=f.core.claimCandidate(executor,{key:'probe',operation:'claim',body:{workerId:'w',workloadId:'missing',expectedGeneration:0,incarnation:0,ttlMs:10}});expect(r.ok).toBe(false);expect(f.table('commands')).toHaveLength(before);});
});
