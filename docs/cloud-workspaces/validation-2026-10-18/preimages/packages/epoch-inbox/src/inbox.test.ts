import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { unlinkSync } from 'node:fs';
import { EpochInbox, InboxRejected, canonical, type Envelope, type InboxEvent, type TransactionPort, type TrustedContext } from './inbox';
const owner:TrustedContext={environment:'test',principal:'admin',role:'owner'};
const observer:TrustedContext={environment:'test',principal:'observer',role:'observer'};
const projector:TrustedContext={environment:'test',principal:'projector',role:'projector'};
const options={environment:'test',authorityId:'inbox-a',now:()=>123};
const event:InboxEvent={network:'fixture-network',blockHeight:1,blockHash:'a'.repeat(64),parentHash:'b'.repeat(64),transactionId:'c'.repeat(64),eventIndex:0,payload:{a:1,b:2}};
const resources:Array<()=>void>=[];
afterEach(()=>{for(const close of resources.splice(0).reverse())close();});
function setup(path=':memory:'){
 const db=new DatabaseSync(path);resources.push(()=>db.close());let fail=false;
 const port:TransactionPort={sql:{exec(sql,...bindings){const rows=db.prepare(sql).all(...bindings as any[]) as Record<string,unknown>[];if(fail&&sql.startsWith('INSERT INTO epoch_inbox_outbox')){fail=false;throw new Error('injected storage fault');}return rows;}},transactionSync(fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}};
 const inbox=new EpochInbox(port,options);
 const register=(sourceId='source-a',network='fixture-network',principal='observer')=>inbox.execute(owner,{operation:'registerSource',key:'reg-'+sourceId.slice(0,100),body:{sourceId,network,observerPrincipal:principal}});
 const ingest=(key='e1',expectedCursor=0,e=event,sourceId='source-a',ctx=observer)=>inbox.execute(ctx,{operation:'ingest',key,body:{sourceId,expectedCursor,event:e}});
 return {db,port,inbox,register,ingest,fault:()=>{fail=true;}};
}
function rejection(fn:()=>unknown,status:number){try{fn();throw new Error('expected rejection');}catch(error){expect(error).toBeInstanceOf(InboxRejected);expect((error as InboxRejected).status).toBe(status);}}
describe('EpochInbox SQLite domain',()=>{
 it('registers immutable source and atomically accepts observation + audit + outbox + command',()=>{
  const h=setup();h.register();expect(h.ingest()).toMatchObject({ok:true,status:'accepted',cursor:1});
  expect(h.inbox.snapshot(owner)).toMatchObject({totals:{sources:1,events:1,audit:2,outbox:2,commands:2},sources:[{cursor:1}]});
  rejection(()=>h.inbox.execute(owner,{operation:'registerSource',key:'change',body:{sourceId:'source-a',network:'other',observerPrincipal:'observer'}}),409);
 });
 it('deduplicates canonical content across keys and stale cursor, preserves exact replay',()=>{
  const h=setup();h.register();const accepted=h.ingest();expect(h.ingest()).toEqual(accepted);
  expect(h.ingest('other',999,{...event,payload:{b:2,a:1}})).toEqual({...accepted,status:'duplicate'});
  expect(h.inbox.snapshot(owner)).toMatchObject({totals:{events:1,outbox:2,audit:2,commands:3}});
  rejection(()=>h.ingest('e1',1),409);
 });
 it('height, parent and payload conflicts preserve original and emit conflict once',()=>{
  const h=setup();h.register();const original=h.ingest();
  for(const [i,e] of [{...event,blockHeight:2},{...event,parentHash:'d'.repeat(64)},{...event,payload:{a:3}}].entries()){
   expect(h.ingest('conflict'+i,999,e)).toEqual({...original,ok:false,status:'conflict'});
  }
  h.ingest('same-conflict',0,{...event,blockHeight:2});
  expect(h.inbox.snapshot(owner)).toMatchObject({totals:{events:1,conflicts:3,outbox:3,audit:3},sources:[{quarantined:1,cursor:1}]});
  expect(h.ingest('original-again',999)).toMatchObject({status:'duplicate'});
  rejection(()=>h.ingest('new',1,{...event,eventIndex:1}),409);
 });
 it('rolls back every write when adapter fails after outbox insertion',()=>{
  const h=setup();h.register();const before=h.inbox.snapshot(owner);h.fault();
  expect(()=>h.ingest()).toThrow('injected storage fault');expect(h.inbox.snapshot(owner)).toEqual(before);
  expect(h.ingest()).toMatchObject({cursor:1});
  const accepted=h.inbox.snapshot(owner);h.fault();expect(()=>h.ingest('conflict',0,{...event,blockHeight:2})).toThrow();expect(h.inbox.snapshot(owner)).toEqual(accepted);
 });
 it('source enrollment rollback includes enrollment audit/outbox',()=>{const h=setup();const before=h.inbox.snapshot(owner);h.fault();expect(()=>h.register()).toThrow();expect(h.inbox.snapshot(owner)).toEqual(before);});
 it('rechecks roles, principal, environment, network and source on replay',()=>{
  const h=setup();h.register();h.ingest();
  rejection(()=>h.ingest('e1',0,event,'source-a',{...observer,environment:'other'}),403);
  rejection(()=>h.ingest('e1',0,event,'source-a',{...observer,principal:'intruder'}),403);
  rejection(()=>h.ingest('e1',0,event,'source-a',owner),403);
  rejection(()=>h.ingest('badnet',0,{...event,network:'other'}),409);
  rejection(()=>h.inbox.snapshot(observer),403);
  rejection(()=>h.inbox.execute(observer,{operation:'readOutbox',key:'read',body:{after:0,limit:10}}),403);
 });
 it('rejects unknown fields, bad numbers, non-JSON and UTF8 oversize atomically',()=>{
  const h=setup();h.register();const before=h.inbox.snapshot(owner);
  for(const e of [{...event,observedAt:1},{...event,eventIndex:-1},{...event,blockHeight:Infinity},{...event,payload:'😀'.repeat(4096)},{...event,payload:{secret:undefined}}]) expect(()=>h.ingest('bad',0,e as InboxEvent)).toThrow(InboxRejected);
  expect(()=>canonical(new Date())).toThrow(InboxRejected);const cycle:any={};cycle.self=cycle;expect(()=>canonical(cycle)).toThrow(InboxRejected);
  expect(h.inbox.snapshot(owner)).toEqual(before);
 });
 it('accepts payload byte boundary and rejects request >32KiB',()=>{
  const h=setup();h.register();expect(h.ingest('edge',0,{...event,payload:'é'.repeat(8191)})).toMatchObject({status:'accepted'});
  expect(()=>h.ingest('too-big',1,{...event,payload:'é'.repeat(8192)})).toThrow(InboxRejected);
  expect(()=>h.inbox.execute(owner,{operation:'registerSource',key:'x',body:{sourceId:'x'.repeat(32768),network:'n',observerPrincipal:'o'}})).toThrow(InboxRejected);
 });
 it('sequential competing writers fence source cursors (not a race proof)',()=>{
  const h=setup();h.register();const second=new EpochInbox(h.port,options);h.ingest();
  rejection(()=>second.execute(observer,{operation:'ingest',key:'loser',body:{sourceId:'source-a',expectedCursor:0,event:{...event,eventIndex:1}}}),409);
  expect(second.execute(observer,{operation:'ingest',key:'retry',body:{sourceId:'source-a',expectedCursor:1,event:{...event,eventIndex:1}}})).toMatchObject({cursor:2});
 });
 it('source-scopes identical chain tuple and cursor',()=>{const h=setup();h.register();h.register('source-b');const a=h.ingest();const b=h.ingest('b',0,event,'source-b');expect(a.eventId).not.toEqual(b.eventId);expect(b.cursor).toBe(1);});
 it('persists binding, delivery prefix, replay and acknowledgment across reopen',()=>{
  const path=new URL(`../test-${process.pid}-${Date.now()}.sqlite`,import.meta.url).pathname;
  resources.push(()=>unlinkSync(path));const h=setup(path);h.register();const accepted=h.ingest();
  const read=h.inbox.execute(projector,{operation:'readOutbox',key:'r1',body:{after:0,limit:1}});expect(read.delivered).toBe(1);
  const second=setup(path);expect(second.ingest()).toEqual(accepted);
  rejection(()=>second.inbox.execute(projector,{operation:'ackOutbox',key:'bad',body:{through:2}}),409);
  second.inbox.execute(projector,{operation:'ackOutbox',key:'ack',body:{through:1}});
  expect(second.inbox.execute(projector,{operation:'readOutbox',key:'r2',body:{after:1,limit:100}})).toMatchObject({acknowledged:1,delivered:2,items:[{seq:2}]});
  expect(()=>new EpochInbox(second.port,{...options,authorityId:'other'})).toThrow(InboxRejected);
  expect(()=>new EpochInbox(second.port,{...options,environment:'other'})).toThrow(InboxRejected);
 });
 it('rejects future schema before attempting schema repair',()=>{
  const h=setup();h.db.exec('DROP TRIGGER epoch_inbox_binding; UPDATE epoch_inbox_meta SET schema_version=3');
  expect(()=>new EpochInbox(h.port,options)).toThrow(InboxRejected);expect(h.db.prepare("SELECT name FROM sqlite_master WHERE name='epoch_inbox_binding'").all()).toEqual([]);
  rejection(()=>h.inbox.snapshot(owner),409);
 });
 it('uses namespaced tables and immutable triggers including REPLACE with recursive triggers off',()=>{
  const h=setup();h.db.exec('CREATE TABLE events(id TEXT); INSERT INTO events VALUES (\'untouched\'); PRAGMA recursive_triggers=OFF');h.register();h.ingest();h.ingest('c',0,{...event,blockHeight:2});h.ingest('c2',0,{...event,blockHeight:3});
  for(const table of ['meta','sources','events','conflicts','audit','outbox','commands','quarantines']){
   const row=h.db.prepare(`SELECT * FROM epoch_inbox_${table} LIMIT 1`).get()!;const cols=Object.keys(row);const vals=Object.values(row) as any[];
   expect(()=>h.db.prepare(`INSERT OR REPLACE INTO epoch_inbox_${table}(${cols.join(',')}) VALUES(${cols.map(()=>'?').join(',')})`).run(...vals)).toThrow();
   expect(()=>h.db.exec(`DELETE FROM epoch_inbox_${table}`)).toThrow();
  }
  for(const table of ['events','conflicts','audit','outbox','commands'])expect(()=>h.db.exec(`UPDATE epoch_inbox_${table} SET rowid=rowid`)).toThrow();
  expect(()=>h.db.exec("UPDATE epoch_inbox_sources SET network='other'")).toThrow();
  expect(h.db.prepare('SELECT * FROM events').all()).toEqual([{id:'untouched'}]);
 });
 it('fails closed at command capacity but existing replay remains usable',()=>{
  const h=setup();h.register();const result=h.ingest();h.port.transactionSync(()=>{const stmt=h.db.prepare("INSERT INTO epoch_inbox_commands(principal,role,key,request,response) VALUES('seed','owner',?,'{}','{}')");for(let i=2;i<20000;i++)stmt.run('seed'+i);});
  expect(h.ingest()).toEqual(result);rejection(()=>h.ingest('new-duplicate'),507);
  expect(h.inbox.snapshot(owner)).toMatchObject({totals:{commands:20000,events:1,outbox:2}});
 });
 it('bounds source enrollment and snapshot pages',()=>{
  const h=setup();for(let i=0;i<128;i++)h.register('source-'+i);rejection(()=>h.register('overflow'),507);
  const s=h.inbox.snapshot(owner);expect((s.sources as unknown[]).length).toBe(100);expect(s).toMatchObject({totals:{sources:128},hasMore:{sources:true}});
 });
 it('bounds readOutbox bytes and retains contiguous delivered prefix',()=>{
  const h=setup();const source='s'.repeat(128),network='n'.repeat(128);h.register(source,network);
  for(let i=0;i<100;i++)h.ingest('e'+i,i,{...event,network,eventIndex:i},source);
  const result=h.inbox.execute(projector,{operation:'readOutbox',key:'read',body:{after:0,limit:100}});
  const items=result.items as Array<{seq:number}>;expect(items.length).toBeLessThan(100);expect(Buffer.byteLength(JSON.stringify(items))).toBeLessThanOrEqual(131072);
  expect(items.map(i=>i.seq)).toEqual(Array.from({length:items.length},(_,i)=>i+1));expect(result.delivered).toBe(items.length);
 });
});

describe('capacity and SQL backstops',()=>{
 it('reserves first quarantine evidence when normal conflict variants are full',()=>{
  const h=setup();h.register();const accepted=h.ingest();
  h.port.transactionSync(()=>{const insert=h.db.prepare('INSERT INTO epoch_inbox_conflicts(event_id,content) VALUES(?,?)');for(let i=0;i<1000;i++)insert.run(accepted.eventId as string,canonical({...event,blockHeight:i+2}));});
  expect(h.ingest('first',0,{...event,blockHeight:2000})).toMatchObject({status:'conflict'});
  const before=h.inbox.snapshot(owner);rejection(()=>h.ingest('over',0,{...event,blockHeight:2001}),507);expect(h.inbox.snapshot(owner)).toEqual(before);
  expect(h.ingest('still-duplicate',999)).toMatchObject({status:'duplicate'});
 });
 it('outbox capacity rolls event and cursor back',()=>{
  const h=setup();h.register();
  h.port.transactionSync(()=>{const a=h.db.prepare("INSERT INTO epoch_inbox_audit VALUES(?,'observed','source-a','fixture','observer',123)");const o=h.db.prepare("INSERT INTO epoch_inbox_outbox VALUES(?,'observed','source-a','fixture')");for(let i=2;i<=11000;i++){a.run(i);o.run(i);}});
  const before=h.inbox.snapshot(owner);rejection(()=>h.ingest(),507);expect(h.inbox.snapshot(owner)).toEqual(before);
 });
 it('event count capacity is global, not only per-source cursor',()=>{
  const h=setup();h.register();h.register('source-b');
  h.port.transactionSync(()=>{const insert=h.db.prepare("INSERT INTO epoch_inbox_events(event_id,source_id,network,cursor,content) VALUES(?,'source-a','fixture-network',?,'{}')");const update=h.db.prepare("UPDATE epoch_inbox_sources SET cursor=? WHERE source_id='source-a'");for(let i=1;i<=10000;i++){insert.run('fixture'+i,i);update.run(i);}});
  const before=h.inbox.snapshot(owner);rejection(()=>h.ingest('over',0,event,'source-b'),507);expect(h.inbox.snapshot(owner)).toEqual(before);
 });
 it('enforces SQL source/network and alternate unique replacement identities',()=>{
  const h=setup();h.register();const accepted=h.ingest();h.ingest('conflict',0,{...event,blockHeight:2});h.ingest('variant',0,{...event,blockHeight:3});
  expect(()=>h.db.prepare('INSERT INTO epoch_inbox_events VALUES(?,?,?,?,?)').run('bad','source-a','wrong-network',2,'{}')).toThrow();
  expect(()=>h.db.prepare('INSERT OR REPLACE INTO epoch_inbox_events VALUES(?,?,?,?,?)').run('other','source-a','fixture-network',1,'{}')).toThrow();
  const conflict=h.db.prepare('SELECT * FROM epoch_inbox_conflicts').get()!;
  expect(()=>h.db.prepare('INSERT OR REPLACE INTO epoch_inbox_conflicts(id,event_id,content) VALUES(?,?,?)').run(999,accepted.eventId as string,conflict.content as string)).toThrow();
  expect(()=>h.db.exec('UPDATE epoch_inbox_meta SET delivered=100')).toThrow();
 });
 it('rejects hidden fields, sparse/symbol arrays and accessors without invoking them',()=>{
  const h=setup();h.register();const hidden={...event};Object.defineProperty(hidden,'observedAt',{value:123});expect(()=>h.ingest('hidden',0,hidden)).toThrow(InboxRejected);
  const array=new Array(1);(array as any)[Symbol('x')]=1;expect(()=>canonical(array)).toThrow(InboxRejected);
  let touched=false;const payload={get value(){touched=true;return 1;}};expect(()=>h.ingest('getter',0,{...event,payload})).toThrow(InboxRejected);expect(touched).toBe(false);
 });
 it('keys cannot cross operations but principal and role scopes are distinct',()=>{
  const h=setup();h.register();rejection(()=>h.inbox.execute(owner,{operation:'registerSource',key:'reg-source-a',body:{sourceId:'other',network:'n',observerPrincipal:'o'}}),409);
  expect(h.inbox.execute(owner,{operation:'readOutbox',key:'reg-source-a',body:{after:0,limit:1}})).toMatchObject({ok:true});
  expect(h.inbox.execute(projector,{operation:'readOutbox',key:'reg-source-a',body:{after:0,limit:1}})).toMatchObject({ok:true});
 });
 it('snapshot content pages stay below 512KiB with maximum-size payloads',()=>{
  const h=setup();h.register();for(let i=0;i<10;i++)h.ingest('large'+i,i,{...event,eventIndex:i,payload:'x'.repeat(16382)});
  const s=h.inbox.snapshot(owner);expect((s.events as unknown[]).length).toBe(8);expect(s.hasMore).toMatchObject({events:true});expect(Buffer.byteLength(JSON.stringify(s.events))).toBeLessThan(512*1024);
 });
});

describe('reserved recovery and complete projection',()=>{
 it('quarantines a healthy second source despite full command, variant and normal outbox capacities',()=>{
  const h=setup();h.register();h.register('source-b');h.ingest();h.ingest('b',0,event,'source-b');
  const id=h.ingest('duplicate').eventId as string;
  h.port.transactionSync(()=>{
   const conflict=h.db.prepare('INSERT INTO epoch_inbox_conflicts(event_id,content) VALUES(?,?)');for(let i=0;i<1000;i++)conflict.run(id,canonical({...event,blockHeight:i+2}));
   const command=h.db.prepare("INSERT INTO epoch_inbox_commands(principal,role,key,request,response) VALUES('seed','owner',?,'{}','{}')");for(let i=5;i<20000;i++)command.run('seed'+i);
   const a=h.db.prepare("INSERT INTO epoch_inbox_audit VALUES(?,'observed','source-a','fixture','observer',123)");const o=h.db.prepare("INSERT INTO epoch_inbox_outbox VALUES(?,'observed','source-a','fixture')");for(let i=5;i<=11000;i++){a.run(i);o.run(i);}
  });
  const result=h.ingest('safety',999,{...event,blockHeight:2000},'source-b');expect(result).toMatchObject({status:'conflict'});expect(h.ingest('safety',999,{...event,blockHeight:2000},'source-b')).toEqual(result);
  expect(h.db.prepare("SELECT quarantined FROM epoch_inbox_sources WHERE source_id='source-b'").get()).toMatchObject({quarantined:1});
  expect(h.inbox.snapshot(owner)).toMatchObject({totals:{commands:20001,conflicts:1001,outbox:11001}});
  const restarted=new EpochInbox(h.port,options);
  // Drain to the reserved entry. read/ack remain uncached and do not grow the command ledger.
  let through=0;
  while(through<11001){const read=restarted.execute(projector,{operation:'readOutbox',key:'drain',body:{after:through,limit:100}});through=read.delivered as number;restarted.execute(projector,{operation:'ackOutbox',key:'ack',body:{through}});}
  expect(restarted.snapshot(owner)).toMatchObject({meta:{ack:11001},totals:{commands:20001}});
 });
 it('rolls reserved quarantine back on storage failure even when command capacity is full',()=>{
  const h=setup();h.register();h.ingest();h.port.transactionSync(()=>{const c=h.db.prepare("INSERT INTO epoch_inbox_commands(principal,role,key,request,response) VALUES('seed','owner',?,'{}','{}')");for(let i=2;i<20000;i++)c.run('s'+i);});
  const before=h.inbox.snapshot(owner);h.fault();expect(()=>h.ingest('quarantine',0,{...event,blockHeight:2})).toThrow('injected storage fault');expect(h.inbox.snapshot(owner)).toEqual(before);
  expect(h.ingest('quarantine',0,{...event,blockHeight:2})).toMatchObject({status:'conflict'});
 });
 it('drains at command capacity after closing and reopening SQLite',()=>{
  const path=new URL(`../recovery-${process.pid}-${Date.now()}.sqlite`,import.meta.url).pathname;resources.push(()=>unlinkSync(path));const h=setup(path);h.register();h.ingest();
  h.port.transactionSync(()=>{const c=h.db.prepare("INSERT INTO epoch_inbox_commands(principal,role,key,request,response) VALUES('seed','owner',?,'{}','{}')");for(let i=2;i<20000;i++)c.run('s'+i);});
  const reopened=setup(path);const read=reopened.inbox.execute(projector,{operation:'readOutbox',key:'fresh',body:{after:0,limit:100}});expect(read.delivered).toBe(2);
  expect(reopened.inbox.execute(projector,{operation:'ackOutbox',key:'fresh',body:{through:2}})).toMatchObject({acknowledged:2});
  expect(reopened.inbox.snapshot(owner)).toMatchObject({totals:{commands:20000}});
 });
 it('projects historical payload, immutable enrollment and audit plus first evidence in bounded pages',()=>{
  const h=setup();h.register();for(let i=0;i<10;i++)h.ingest('e'+i,i,{...event,eventIndex:i,payload:'x'.repeat(16382)});
  h.ingest('conflict',999,{...event,payload:'y'.repeat(16382)});
  let after=0;const all:any[]=[];
  while(after<12){const read=h.inbox.execute(projector,{operation:'readOutbox',key:'same-key',body:{after,limit:100}});expect(Buffer.byteLength(JSON.stringify(read.items))).toBeLessThanOrEqual(131072);all.push(...read.items as any[]);after=read.delivered as number;h.inbox.execute(projector,{operation:'ackOutbox',key:'same-key',body:{through:after}});}
  expect(all[0]).toMatchObject({source:{network:'fixture-network',observer_principal:'observer'},audit:{actor:'admin',at_ms:123}});
  expect(all[1].event.content.payload).toBe('x'.repeat(16382));expect(all.at(-1).conflict.content.payload).toBe('y'.repeat(16382));expect(all.at(-1).event.content.payload).toBe('x'.repeat(16382));
 });
});

describe('schema and conflict ordering',()=>{
 it('rejects legacy v1 before applying DDL, without claiming a migration',()=>{
  const h=setup();h.db.exec('DROP TRIGGER epoch_inbox_binding; UPDATE epoch_inbox_meta SET schema_version=1');
  expect(()=>new EpochInbox(h.port,options)).toThrow(InboxRejected);
  expect(h.db.prepare("SELECT name FROM sqlite_master WHERE name='epoch_inbox_binding'").all()).toHaveLength(0);
 });
 it('orders latest evidence globally across first quarantine and variant stores',()=>{
  const h=setup();h.register();h.register('source-b');h.ingest();h.ingest('b',0,event,'source-b');
  h.ingest('first',0,{...event,blockHeight:2});for(let i=0;i<10;i++)h.ingest('variant'+i,0,{...event,blockHeight:i+3});
  const later=h.ingest('second-source',0,{...event,blockHeight:100},'source-b');
  const conflicts=h.inbox.snapshot(owner).conflicts as any[];expect(conflicts[0]).toMatchObject({event_id:later.eventId,evidence_seq:12});
  expect(conflicts.map(c=>c.evidence_seq)).toEqual([12,11,10,9,8,7,6,5]);
 });
});
