import {describe,it,expect} from 'vitest';
import {withInbox,register,ingestBody,event} from '../test-support/client';
describe('EPOCH durable inbox through actual authenticated Worker and SQLite',()=>{
 it('persists receipt/cursor/outbox and replays a lost response after runtime restart',()=>withInbox(async h=>{
  await register(h);
  const first=await h.command('ingest',ingestBody(),'observer','lost-response');expect(first.body.ok,JSON.stringify(first)).toBe(true);
  const before=await h.snapshot();expect(before.body.events).toHaveLength(1);
  await h.restart();expect((await h.command('ingest',ingestBody(),'observer','lost-response')).body).toEqual(first.body);
  expect((await h.snapshot()).body).toEqual(before.body);
 }));
 it('twenty duplicate deliveries create one event and one observation outbox row',()=>withInbox(async h=>{
  await register(h);const before=(await h.snapshot()).body;
  const results=await Promise.all(Array.from({length:20},(_,i)=>h.command('ingest',ingestBody(),'observer',`duplicate-${i}`)));
  expect(results.every(r=>r.body.ok),JSON.stringify(results)).toBe(true);
  const after=(await h.snapshot()).body;
  expect(after.events).toHaveLength(1);expect(after.outbox.length-before.outbox.length).toBe(1);
 }));
 it('serializes competing cursor writers without skipping source positions',()=>withInbox(async h=>{
  await register(h);
  const results=await Promise.all(Array.from({length:20},(_,i)=>h.command('ingest',ingestBody(i,0),'observer',`compete-${i}`)));
  expect(results.filter(r=>r.body.ok)).toHaveLength(1);
  expect((await h.snapshot()).body.events).toHaveLength(1);
 }));
 it('rolls back all coupled state on an injected outbox failure and permits same-key retry',()=>withInbox(async h=>{
  await register(h);const before=(await h.snapshot()).body;
  await h.request('/__test/fault',{});
  expect((await h.command('ingest',ingestBody(),'observer','atomic')).status).toBe(503);
  expect((await h.snapshot()).body).toEqual(before);
  expect((await h.command('ingest',ingestBody(),'observer','atomic')).body.ok).toBe(true);
 }));
 it('quarantines conflicting identity without replacing original content or moving cursor',()=>withInbox(async h=>{
  await register(h);expect((await h.command('ingest',ingestBody(),'observer')).body.ok).toBe(true);
  const original=(await h.snapshot()).body;
  const conflict=await h.command('ingest',ingestBody(0,1,{kind:'different'}),'observer','conflict');expect(conflict.body.ok).toBe(false);
  const after=(await h.snapshot()).body;expect(after.events).toEqual(original.events);expect(after.conflicts).toHaveLength(1);
  expect((await h.command('ingest',ingestBody(1,1),'observer')).body.ok).toBe(false);
  await h.restart();expect((await h.command('ingest',ingestBody(0,1,{kind:'different'}),'observer','conflict')).body).toEqual(conflict.body);
  expect((await h.snapshot()).body.conflicts).toHaveLength(1);
 }));
 it('rejects wrong source principal/network and forged context without granting authority',()=>withInbox(async h=>{
  await register(h);
  const unauthorized=await h.command('ingest',ingestBody(),'foreign');expect(unauthorized.status).toBe(403);expect(unauthorized.body.code).toBe('SOURCE_PERMISSION');
  expect((await h.command('ingest',{...ingestBody(),event:{...event(),network:'other-network'}},'observer')).body.ok).toBe(false);
  expect((await h.command('registerSource',{sourceId:'evil',network:'fixture-network',observerPrincipal:'observer'},'observer')).body.ok).toBe(false);
  expect((await h.request('/v1/epoch/snapshot',{},'observer',{'x-role':'owner'})).status).toBe(403);
  expect((await h.request('/v1/epoch/commands',{operation:'ingest',key:'forged',body:ingestBody(),actor:{role:'owner'}},'observer')).status).toBe(400);
  expect((await h.command('ingest',ingestBody(),'wrongenv')).status).toBe(401);
  expect((await h.snapshot()).body.events).toHaveLength(0);
 }));
 it('keeps outbox delivery and contiguous acknowledgement durable across restart',()=>withInbox(async h=>{
  await register(h);await h.command('ingest',ingestBody(),'observer');
  expect((await h.command('ackOutbox',{through:999},'projector')).body.ok).toBe(false);
  const batch=await h.command('readOutbox',{after:0,limit:1},'projector');expect(batch.body.ok).toBe(true);
  expect((await h.command('ackOutbox',{through:batch.body.delivered},'projector')).body.ok).toBe(true);
  await h.restart();
  const next=await h.command('readOutbox',{after:batch.body.delivered,limit:100},'projector');expect(next.body.ok).toBe(true);
 }));
 it('does not infer finality or create compute jobs from observed payloads',()=>withInbox(async h=>{
  await register(h);const input=ingestBody(0,0,{instruction:'execute me',canonical:true,finality:'confirmed'});
  expect((await h.command('ingest',input,'observer')).body.ok).toBe(true);
  const snapshot=(await h.snapshot()).body;expect(snapshot.events).toHaveLength(1);
  expect(JSON.stringify(snapshot)).not.toContain('SUCCEEDED');
  expect((await h.command('ingest',{...ingestBody(1,1),event:{...event(1),finality:'confirmed'}},'observer')).status).toBe(400);
 }));
 it('rejects malformed/oversized envelopes before storing an observation',()=>withInbox(async h=>{
  await register(h);
  for(const payload of [null,[],1])expect((await h.request('/v1/epoch/commands',payload,'observer')).status).toBe(400);
  expect((await h.command('ingest',ingestBody(0,0,{text:'x'.repeat(50000)}),'observer')).status).toBe(413);
  expect((await h.snapshot()).body.events).toHaveLength(0);
 }));
 it('bounds outbox reply bytes for long source identities and keeps prefixes drainable',()=>withInbox(async h=>{
  const sourceId='s'.repeat(128),network='n'.repeat(128);
  expect((await h.command('registerSource',{sourceId,network,observerPrincipal:'observer'})).body.ok).toBe(true);
  for(let i=0;i<60;i++)expect((await h.command('ingest',{sourceId,expectedCursor:i,event:{...event(i),network}},'observer')).body.ok).toBe(true);
  let after=0,seen=0;
  for(let i=0;i<100;i++){
   const batch=await h.command('readOutbox',{after,limit:100},'projector');
   expect(batch.body.ok,JSON.stringify(batch)).toBe(true);
   expect(Buffer.byteLength(JSON.stringify(batch.body))).toBeLessThanOrEqual(132096);
   if(batch.body.items.length===0)break;
   const through=batch.body.items.at(-1).seq;seen+=batch.body.items.length;
   expect(through).toBeGreaterThan(after);
   expect((await h.command('ackOutbox',{through},'projector')).body.ok).toBe(true);after=through;
  }
  expect(seen).toBeGreaterThanOrEqual(60);
 }));
 it('replays equivalent canonical payloads and keeps distinct conflict evidence bounded and immutable',()=>withInbox(async h=>{
  await register(h);
  expect((await h.command('ingest',ingestBody(0,0,{z:1,a:2}),'observer','canonical-first')).body.ok).toBe(true);
  const replay=await h.command('ingest',ingestBody(0,0,{a:2,z:1}),'observer','canonical-first');expect(replay.body.ok).toBe(true);
  const first=await h.command('ingest',ingestBody(0,0,{a:3}),'observer','variant');expect(first.body.ok).toBe(false);
  const before=(await h.snapshot()).body;
  expect((await h.command('ingest',ingestBody(0,0,{a:3}),'observer','variant-again')).body.ok).toBe(false);
  const after=(await h.snapshot()).body;expect(after.events).toEqual(before.events);expect(after.conflicts).toEqual(before.conflicts);expect(after.outbox).toEqual(before.outbox);
 }));

 it('distinguishes permanent cursor/idempotency rejection from transient storage failure',()=>withInbox(async h=>{
  await register(h);
  expect((await h.command('ingest',ingestBody(),'observer','original')).body.ok).toBe(true);
  const collision=await h.command('ingest',ingestBody(0,0,{changed:true}),'observer','original');
  expect(collision.status).toBe(409);expect(collision.body.code).toBe('IDEMPOTENCY_COLLISION');
  const stale=await h.command('ingest',ingestBody(1,0),'observer');expect(stale.status).toBe(409);expect(stale.body.code).toBe('CURSOR_MISMATCH');
 }));

 it('blocks SQL replacement of namespace, source, event and coupled records on real workerd',()=>withInbox(async h=>{
  await register(h);await h.command('ingest',ingestBody(),'observer');
  await h.command('ingest',ingestBody(0,1,{different:true}),'observer');
  await h.command('ingest',ingestBody(0,1,{anotherVariant:true}),'observer');
  const before=(await h.snapshot()).body;
  const guarded=await h.request('/__test/immutability',{});expect(guarded.body.denied).toEqual([true,true,true,true,true,true,true]);
  expect((await h.snapshot()).body).toEqual(before);
 }));

 it('can drain pending outbox notifications after mutation-command capacity and restart',()=>withInbox(async h=>{
  await register(h);await h.command('ingest',ingestBody(),'observer');
  expect((await h.request('/__test/fill-commands',{})).body.ok).toBe(true);await h.restart();
  const batch=await h.command('readOutbox',{after:0,limit:100},'projector');expect(batch.body.ok,JSON.stringify(batch)).toBe(true);
  expect(batch.body.items.length).toBeGreaterThan(0);const through=batch.body.items.at(-1).seq;
  expect((await h.command('ackOutbox',{through},'projector')).body.ok).toBe(true);
  expect((await h.command('readOutbox',{after:through,limit:100},'projector')).body.items).toHaveLength(0);
 }));
 it('quarantines a newly conflicting source even when normal conflict evidence is full',()=>withInbox(async h=>{
  await register(h);await h.command('ingest',ingestBody(),'observer');
  await h.command('registerSource',{sourceId:'source-b',network:'fixture-network',observerPrincipal:'observer'});
  await h.command('ingest',{...ingestBody(),sourceId:'source-b'},'observer');
  expect((await h.request('/__test/fill-conflicts',{})).body.ok).toBe(true);
  const conflict=await h.command('ingest',{...ingestBody(0,1,{contradiction:true}),sourceId:'source-b'},'observer');expect(conflict.body.ok).toBe(false);
  await h.restart();const snapshot=(await h.snapshot()).body;
  expect(snapshot.sources.find((s:any)=>s.source_id==='source-b').quarantined).toBe(1);
  expect(snapshot.conflicts.some((c:any)=>JSON.parse(c.content).payload?.contradiction===true)).toBe(true);
  expect((await h.command('ingest',{...ingestBody(1,1),sourceId:'source-b'},'observer')).body.ok).toBe(false);
 }));

 it('keeps transport disabled by default and rejects invalid authentication before state reads',()=>withInbox(async h=>{
  expect((await h.request('/__test/disabled',{},'owner')).status).toBe(503);
  expect((await h.request('/v1/epoch/snapshot',{},'owner',{authorization:''})).status).toBe(401);
  expect((await h.request('/v1/epoch/snapshot',{},'owner',{authorization:'Bearer fixture-invalid-0000000000000000000000000000'})).status).toBe(401);
 }));

 it('lets projector credentials recover older observed content after snapshot truncation and restart',()=>withInbox(async h=>{
  await register(h);
  for(let i=0;i<12;i++)expect((await h.command('ingest',ingestBody(i,i,{older:i}),'observer')).body.ok).toBe(true);
  expect((await h.snapshot()).body.events).toHaveLength(8);await h.restart();
  const batch=await h.command('readOutbox',{after:0,limit:100},'projector');expect(batch.body.ok).toBe(true);
  const observed=batch.body.items.filter((r:any)=>r.kind==='observed');
  expect(observed.map((r:any)=>r.event.content.payload.older)).toEqual(Array.from({length:12},(_,i)=>i));
 }));

});
