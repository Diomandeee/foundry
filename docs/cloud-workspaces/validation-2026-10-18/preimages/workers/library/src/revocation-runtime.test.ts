import {describe,it,expect} from 'vitest';
import {withResilience} from '../test-support/resilience';
describe('actual compute → durable relay → catalog/broker boundaries',()=>{
 it('reads bounded immutable bytes, then fences cached reads and publication through durable delivery',()=>withResilience(async h=>{
  await h.issue();h.register();const bytes=await h.read();expect(bytes.status).toBe(200);expect((await bytes.arrayBuffer()).byteLength).toBe(h.grant.object.sizeBytes);expect(h.reads).toBe(1);
  const before=(await h.req('/__test/outbox')).body;expect(before.every((x:any)=>x.acknowledged===0)).toBe(true);
  const attestationId='e'.repeat(64);expect((await h.library('attestTransfer',{version:1,intentId:'transfer',generation:1,binding:h.binding,manifestHash:h.binding.content.manifestHash,bytes:h.binding.content.bytes,attestationId,hostAttestation:'f'.repeat(64),attestedAt:1000000,expiresAt:1010000},'verifier')).status).toBe(200);
  expect((await h.cancel()).body.ok).toBe(true);
  for(let n=0;n<4;n++)await h.step();
  const state=h.relay.snapshot(h.owner);expect(state.deliveries).toHaveLength(2);expect(state.deliveries.every((d:any)=>d.state==='acked')).toBe(true);
  expect((await h.req('/v1/library/project-a/snapshot')).body.records.some((r:any)=>r.kind==='cancellation')).toBe(true);
  expect((await h.read()).status).toBe(503);expect(h.reads).toBe(1);
  expect((await h.library('publishSnapshot',{version:1,snapshotId:'late',intentId:'transfer',generation:1,attestationId,provenance:{source:'fixture',parentSnapshotId:null}})).body.code).toBe('TRANSFER_CANCELLED');
  expect((await h.req('/v1/library/project-a/snapshot')).body.records.some((r:any)=>r.kind==='snapshot')).toBe(false);
  const after=(await h.req('/__test/outbox')).body;expect(after.every((x:any)=>x.acknowledged===0)).toBe(true);
 }));
 it('recovers lost cancellation replies across independent relay and authority restart',()=>withResilience(async h=>{
  await h.issue();h.register();await h.cancel();h.loseCatalogReply=true;
  for(let n=0;n<3;n++)await h.step();
  expect(h.relay.snapshot(h.owner).deliveries.some((d:any)=>d.state==='pending')).toBe(true);
  const keys=h.relay.snapshot(h.owner).deliveries.map((d:any)=>d.id);
  h.restartRelay();await h.restartAuthorities();h.clock+=1100;
  for(let n=0;n<4;n++)await h.step();
  expect(h.relay.snapshot(h.owner).deliveries.map((d:any)=>d.id)).toEqual(keys);
  expect(h.relay.snapshot(h.owner).deliveries.every((d:any)=>d.state==='acked')).toBe(true);
  const state=(await h.req('/v1/library/project-a/snapshot')).body;expect(state.records.filter((r:any)=>r.kind==='cancellation')).toHaveLength(1);
 }));
 it('delivers already-durable cancellation even while the source is offline',()=>withResilience(async h=>{
  await h.issue();h.register();await h.cancel();h.relay.ingest(h.dispatcher,await h.http.readPage(0));h.sourceOffline=true;
  expect((await h.step()).source).toBe('unavailable');expect((await h.step()).source).toBe('unavailable');
  expect(h.relay.snapshot(h.owner).deliveries.every((d:any)=>d.state==='acked')).toBe(true);
 }));
 it('rejects bytes when actual compute revocation lands during the provider read',()=>withResilience(async h=>{
  await h.issue();h.duringRead=async()=>{h.duringRead=undefined;await h.cancel();};
  const response=await h.read();expect(response.status).toBe(503);expect(h.reads).toBe(1);
  expect((await h.read()).status).toBe(503);expect(h.reads).toBe(1);
 }));
 it('requires source owner and rejects wrong epoch/cursor without sharing projector acknowledgements',()=>withResilience(async h=>{
  expect((await h.req('/v1/library/fences',{expectedEpoch:1,after:0,limit:64},'writer')).status).toBe(403);
  expect((await h.req('/v1/library/fences',{expectedEpoch:2,after:0,limit:64})).status).toBe(409);
  expect((await h.req('/v1/library/fences',{expectedEpoch:1,after:999999,limit:64})).status).toBe(409);
  const observed=await h.req('/v1/library/fence',{expectedEpoch:1,binding:h.binding.compute});expect(observed.body.current).toBe(true);expect(observed.body.binding.generation).toBe(0);
  expect((await h.req('/v1/library/fence',{expectedEpoch:1,binding:{...h.binding.compute,capabilityDigest:'f'.repeat(64)}})).body.current).toBe(false);
 }));
});

describe('accepted results and replacement generations',()=>{
 it('keeps a successfully verified transfer eligible through worker quarantine annotations',()=>withResilience(async h=>{
  await h.issue();h.register();expect((await h.read()).status).toBe(200);
  const completed=await h.complete();expect(completed.body.ok).toBe(true);
  const observation=await h.req('/v1/library/fence',{expectedEpoch:1,binding:h.binding.compute});expect(observation.body.accepted).toBe(true);
  for(let n=0;n<3;n++)await h.step();
  expect(h.relay.snapshot(h.owner).deliveries).toHaveLength(0);
  expect((await h.req('/v1/library/project-a/snapshot')).body.records.some((r:any)=>r.kind==='cancellation')).toBe(false);
  const id='c'.repeat(64);
  expect((await h.library('attestTransfer',{version:1,intentId:'transfer',generation:1,binding:h.binding,manifestHash:h.binding.content.manifestHash,bytes:h.binding.content.bytes,attestationId:id,hostAttestation:completed.body.receipt.sha256,attestedAt:1000000,expiresAt:1010000},'verifier')).status).toBe(200);
  expect((await h.library('publishSnapshot',{version:1,snapshotId:'valid-success',intentId:'transfer',generation:1,attestationId:id,provenance:{source:'local-byte-and-compute-fixture',parentSnapshotId:null}})).status).toBe(200);
 }));
 it('spares a successor authorized for a different live compute attempt',()=>withResilience(async h=>{
  await h.issue();h.register();await h.cancel();const next=await h.replacement();
  const advanced=await h.library('authorizeTransfer',{version:1,intentId:'transfer',expectedGeneration:1,binding:{...h.binding,compute:next},expiresAt:1010000},'owner');expect(advanced.status).toBe(200);
  for(let n=0;n<4;n++)await h.step();
  const state=(await h.req('/v1/library/project-a/snapshot')).body;
  expect(state.records.some((r:any)=>r.kind==='cancellation')).toBe(false);expect(state.records.filter((r:any)=>r.kind==='authorization').at(-1).body.generation).toBe(2);
  expect(h.relay.snapshot(h.owner).deliveries.every((d:any)=>d.state==='acked')).toBe(true);
 }));
 it('cancels a later local generation that reuses the same revoked compute attempt',()=>withResilience(async h=>{
  await h.issue();h.register();await h.cancel();
  expect((await h.library('authorizeTransfer',{version:1,intentId:'transfer',expectedGeneration:1,binding:h.binding,expiresAt:1010000},'owner')).status).toBe(200);
  for(let n=0;n<4;n++)await h.step();
  expect((await h.req('/v1/library/project-a/snapshot')).body.records.some((r:any)=>r.kind==='cancellation')).toBe(true);
 }));
});

it('preserves the accepted result while revoking an active sibling lease on the same worker',()=>withResilience(async h=>{
 await h.issue();h.register();const sibling=await h.sibling(),bound={...h.binding,compute:sibling};
 expect((await h.library('stageTransfer',{version:1,intentId:'sibling-transfer',binding:bound,expiresAt:1010000})).status).toBe(200);
 h.relay.register(h.owner,{version:1,targetId:'target-sibling',kind:'catalog',environment:'local',authorityId:h.catalogId,projectId:'project-a',resourceId:'sibling-transfer',generation:1,binding:bound});
 expect((await h.complete()).body.ok).toBe(true);
 for(let n=0;n<4;n++)await h.step();
 const cancellations=(await h.req('/v1/library/project-a/snapshot')).body.records.filter((r:any)=>r.kind==='cancellation');
 expect(cancellations.map((r:any)=>r.id)).toEqual(['sibling-transfer']);
 const deliveries=h.relay.snapshot(h.owner).deliveries;expect(deliveries).toHaveLength(1);expect(deliveries[0].state).toBe('acked');
}));
it('still reads immutable revocation events after another consumer acknowledges the projection outbox',()=>withResilience(async h=>{
 await h.cancel();const projected=await h.command('readOutbox',{after:0,limit:100});expect(projected.body.ok).toBe(true);
 expect((await h.command('ackOutbox',{through:projected.body.through})).body.ok).toBe(true);
 const page=await h.http.readPage(0);expect(page.events.some(e=>e.kind==='lease-revoked')).toBe(true);
 expect((await h.req('/__test/outbox')).body.every((r:any)=>r.acknowledged===1)).toBe(true);
}));


it('retains relay-applied cancellation and exact delivery outcome through full service archive/restore and broker reopen',()=>withResilience(async h=>{
 await h.issue();h.register();expect((await h.read()).status).toBe(200);await h.cancel();h.relay.ingest(h.dispatcher,await h.http.readPage(0));
 let delivery=h.relay.claim(h.dispatcher)!;if(delivery.target.kind==='broker'){const r=await h.http.deliver(delivery);h.relay.settle(h.dispatcher,{deliveryId:delivery.deliveryId,revision:delivery.revision,outcome:'ack',receipt:r as any});delivery=h.relay.claim(h.dispatcher)!;}expect(delivery.target.kind).toBe('catalog');
 const receipt=await h.http.deliver(delivery);h.relay.settle(h.dispatcher,{deliveryId:delivery.deliveryId,revision:delivery.revision,outcome:'ack',receipt:receipt as any});
 await h.step();const archive=(await h.req('/v1/library/project-a/export')).body;
 h.restartBroker();expect((await h.restoreCatalog(archive.archive,archive.sha256)).body.quarantined).toBe(true);
 expect(await h.http.deliver({...delivery,revision:delivery.revision+1})).toEqual(receipt);
 expect((await h.req('/v1/library/project-a/snapshot')).body.records.filter((r:any)=>r.kind==='cancellation')).toHaveLength(1);
 await expect(h.broker.reader.read('worker',{grantId:'grant',requestId:'read'})).rejects.toThrow();expect(h.reads).toBe(1);
}));
it('quarantines an older backup even when the surviving relay already acknowledged its missing cancellation',()=>withResilience(async h=>{
 await h.issue();h.register();const attestationId='e'.repeat(64);
 await h.library('attestTransfer',{version:1,intentId:'transfer',generation:1,binding:h.binding,manifestHash:h.binding.content.manifestHash,bytes:h.binding.content.bytes,attestationId,hostAttestation:'f'.repeat(64),attestedAt:1000000,expiresAt:1010000},'verifier');
 const old=(await h.req('/v1/library/project-a/export')).body;await h.cancel();for(let n=0;n<4;n++)await h.step();
 expect(h.relay.snapshot(h.owner).deliveries.every((d:any)=>d.state==='acked')).toBe(true);
 expect((await h.restoreCatalog(old.archive,old.sha256)).status).toBe(200);await h.restartRestoredCatalog();await h.step();
 const state=(await h.req('/v1/library/project-a/snapshot')).body;expect(state.records.some((r:any)=>r.kind==='cancellation')).toBe(false);
 expect((await h.req('/v1/library/project-a/recovery-status')).body.quarantined).toBe(true);
 const published=await h.library('publishSnapshot',{version:1,snapshotId:'rollback-resurrection',intentId:'transfer',generation:1,attestationId,provenance:{source:'fixture',parentSnapshotId:null}});
 expect(published.body.code).toBe('recovery-quarantined');
 expect((await h.req('/v1/library/project-a/reconcile-recovery',{})).body.code).toBe('recovery-reconciler-required');
}));
it('replays a superseded outcome after a lost reply without applying that old delivery to a later authorization',()=>withResilience(async h=>{
 await h.issue();h.register();await h.cancel();const next=await h.replacement();
 await h.library('authorizeTransfer',{version:1,intentId:'transfer',expectedGeneration:1,binding:{...h.binding,compute:next},expiresAt:1010000},'owner');
 h.relay.ingest(h.dispatcher,await h.http.readPage(0));let d=h.relay.claim(h.dispatcher)!;if(d.target.kind==='broker'){const r=await h.http.deliver(d);h.relay.settle(h.dispatcher,{deliveryId:d.deliveryId,revision:d.revision,outcome:'ack',receipt:r as any});d=h.relay.claim(h.dispatcher)!;}
 const first=await h.http.deliver(d);expect((first as any).status).toBe('superseded');
 await h.library('authorizeTransfer',{version:1,intentId:'transfer',expectedGeneration:2,binding:h.binding,expiresAt:1010000},'owner');
 expect(await h.http.deliver({...d,revision:d.revision+1})).toEqual(first);
 expect((await h.req('/v1/library/project-a/snapshot')).body.records.some((r:any)=>r.kind==='cancellation')).toBe(false);
 h.relay.register(h.owner,{...d.target,targetId:'catalog-generation-3',generation:3});
 for(let n=0;n<3;n++)await h.step();
 expect((await h.req('/v1/library/project-a/snapshot')).body.records.some((r:any)=>r.kind==='cancellation')).toBe(true);
}));
