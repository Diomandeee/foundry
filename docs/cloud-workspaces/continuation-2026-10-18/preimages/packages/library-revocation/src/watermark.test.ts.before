import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { RevocationRelay, type FenceEvent, type FencePage, type RevocationContext, type TransactionPort } from './index';

const owner: RevocationContext = {environment:'test',principal:'owner',role:'owner'};
const options = {environment:'test',authorityId:'relay',sourceAuthorityId:'compute',ownerPrincipal:'owner',dispatcherPrincipal:'dispatcher'};
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function page(after: number, count = 1, head = after + count, epoch = 1, kind: FenceEvent['kind'] = 'epoch-bumped'): FencePage {
 return {version:1,environment:'test',authorityId:'compute',after,through:after+count,head,epoch,
  events:Array.from({length:count},(_,i)=>({seq:after+i+1,kind,epoch,leaseId:null,workloadId:null,workerId:null,generation:null,incarnation:null}))};
}
function setup() {
 const db = new DatabaseSync(':memory:'); databases.push(db);
 const port: TransactionPort = {
  sql:{exec(q,...bindings){return db.prepare(q).all(...bindings) as Record<string,unknown>[];}},
  transactionSync(fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}},
 };
 const reopen=()=>new RevocationRelay(port,options);
 return {db,reopen,relay:reopen()};
}
function retained(db: DatabaseSync) {
 return ['pages','events','deliveries'].map(table=>db.prepare(`SELECT * FROM library_revoke_${table} ORDER BY rowid`).all());
}
function rejectsRollback(relay: RevocationRelay, after: number, head: number, epoch: number) {
 expect(()=>relay.ingest(owner,page(after,0,head-1,epoch))).toThrow('SOURCE_ROLLBACK');
 expect(()=>relay.ingest(owner,page(after,0,head,epoch-1))).toThrow('SOURCE_ROLLBACK');
 expect(()=>relay.observeSource(owner,{head:head-1,epoch})).toThrow('SOURCE_ROLLBACK');
 expect(()=>relay.observeSource(owner,{head,epoch:epoch-1})).toThrow('SOURCE_ROLLBACK');
}

describe('durable source knowledge independent of event retention',()=>{
 it.each(['pages','events','deliveries','cursor'] as const)('retains a validated watermark across SQLite %s failure and reconstruction',stage=>{
  const h=setup();
  // A real target makes delivery insertion part of the event transaction.
  const hash='a'.repeat(64);
  h.relay.register(owner,{version:1,targetId:'target',kind:'catalog',environment:'test',authorityId:'catalog',projectId:'project',resourceId:'transfer',generation:1,
   binding:{projectId:'project',policyVersion:'p1',policyHash:hash,compute:{authorityId:'compute',workloadId:'work',leaseId:'lease',attemptId:'attempt',capabilityDigest:hash,workerId:'worker',epoch:1,generation:1,incarnation:1},content:{manifestHash:hash,objectHash:hash,objectKey:`projects/project/objects/${hash}`,objectGeneration:'1',bytes:100}}});
  const before=retained(h.db), p=page(0,2,10,2);
  const operation=stage==='cursor'?'UPDATE OF cursor ON library_revoke_meta':`INSERT ON library_revoke_${stage}`;
  h.db.exec(`CREATE TEMP TRIGGER fail_retention BEFORE ${operation} BEGIN SELECT RAISE(ABORT,'injected SQLite retention failure'); END`);
  expect(()=>h.relay.ingest(owner,p)).toThrow('injected SQLite retention failure');
  expect(h.relay.sourceWatermark(owner)).toEqual({head:10,epoch:2});
  expect(h.relay.cursor(owner)).toBe(0); expect(retained(h.db)).toEqual(before);
  rejectsRollback(h.relay,0,10,2);
  const reopened=h.reopen(); expect(reopened.sourceWatermark(owner)).toEqual({head:10,epoch:2}); rejectsRollback(reopened,0,10,2);
  h.db.exec('DROP TRIGGER fail_retention');
  expect(reopened.ingest(owner,p)).toEqual({cursor:2,replayed:false});
  expect(reopened.snapshot(owner).events).toEqual(p.events);
  expect(reopened.snapshot(owner).deliveries).toHaveLength(1);
  expect(reopened.ingest(owner,p)).toEqual({cursor:2,replayed:true});
 });
 it.each(['pages','events'] as const)('retains source head and epoch when actual %s capacity is exhausted',table=>{
  const h=setup(), capacity=table==='pages'?1024:512;
  if(table==='pages')for(let after=0;after<capacity;after++)h.relay.ingest(owner,page(after,1,after+1,1,'noop'));
  else for(let after=0;after<capacity;after+=64)h.relay.ingest(owner,page(after,64));
  const before=retained(h.db), high=page(capacity,1,capacity+10,2);
  expect(()=>h.relay.ingest(owner,high)).toThrow('revocation capacity');
  expect(h.relay.cursor(owner)).toBe(capacity); expect(retained(h.db)).toEqual(before);
  expect(h.relay.sourceWatermark(owner)).toEqual({head:capacity+10,epoch:2});
  rejectsRollback(h.relay,capacity,capacity+10,2);
  const reopened=h.reopen(); expect(reopened.sourceWatermark(owner)).toEqual({head:capacity+10,epoch:2}); rejectsRollback(reopened,capacity,capacity+10,2);
  // Original exact evidence is still replayable despite the higher watermark.
  const historical=table==='pages'?page(0,1,1,1,'noop'):page(0,64);
  expect(reopened.ingest(owner,historical)).toEqual({cursor:capacity,replayed:true});
  expect(reopened.sourceWatermark(owner)).toEqual({head:capacity+10,epoch:2});
 });
 it('keeps historical exact replay read-only and rejects changed or future-cursor pages without learning',()=>{
  const h=setup(), old=page(0); h.relay.ingest(owner,old); h.relay.ingest(owner,page(1,1,10,2));
  h.db.exec("CREATE TEMP TRIGGER reject_learning BEFORE UPDATE OF seen_head,seen_epoch ON library_revoke_meta BEGIN SELECT RAISE(ABORT,'unexpected source learning'); END");
  expect(h.relay.ingest(owner,old)).toEqual({cursor:2,replayed:true});
  expect(()=>h.relay.ingest(owner,{...old,head:100,epoch:3})).toThrow('SOURCE_CURSOR');
  expect(()=>h.relay.ingest(owner,page(3,1,100,3))).toThrow('SOURCE_CURSOR');
  expect(h.relay.sourceWatermark(owner)).toEqual({head:10,epoch:2});
 });
 it('validates every event before learning and does not retain partially validated source knowledge',()=>{
  const h=setup(), p=page(0,2,100,3); p.events[1].seq=9;
  expect(()=>h.relay.ingest(owner,p)).toThrow('SOURCE_GAP');
  expect(()=>h.relay.ingest({...owner,principal:'impostor'},page(0,1,100,3))).toThrow('PERMISSION');
  expect(()=>h.relay.ingest(owner,{...page(0,1,100,3),authorityId:'other'})).toThrow('SOURCE_BINDING');
  expect(h.reopen().sourceWatermark(owner)).toEqual({head:0,epoch:0}); expect(h.relay.cursor(owner)).toBe(0);
 });
 it('fails before event retention if persisting source knowledge itself fails',()=>{
  const h=setup(); h.db.exec("CREATE TEMP TRIGGER fail_source BEFORE UPDATE OF seen_head,seen_epoch ON library_revoke_meta BEGIN SELECT RAISE(ABORT,'source storage failure'); END");
  expect(()=>h.relay.ingest(owner,page(0,1,10,2))).toThrow('source storage failure');
  expect(h.relay.cursor(owner)).toBe(0); expect(retained(h.db)).toEqual([[],[],[]]);
  expect(h.reopen().sourceWatermark(owner)).toEqual({head:0,epoch:0});
 });
 it('retains fully validated empty polls without moving the event cursor',()=>{
  const h=setup(); expect(h.relay.ingest(owner,page(0,0,10,2))).toEqual({cursor:0,replayed:false});
  expect(h.reopen().sourceWatermark(owner)).toEqual({head:10,epoch:2}); rejectsRollback(h.reopen(),0,10,2);
 });
});
