import {createHash} from 'node:crypto';
import {canonical as inert} from '../../library-jobs/src/data';
import {fields,identifier,integer,hash,validateBinding} from '../../library-catalog/src/validation';
import {RevocationRejected,type RevocationContext,type RevocationOptions,type RevocationTarget,type FenceEvent,type FencePage,type Delivery,type DeliveryReceipt,type DeliveryPort,type TransactionPort} from './types';
export * from './types';
const need=(v:unknown,code='INVALID_INPUT',status=400):void=>{if(!v)throw new RevocationRejected(code,status);};
function clean<T>(v:unknown):T{return JSON.parse(inert(v));}
const digest=(v:unknown)=>createHash('sha256').update(inert(v)).digest('hex');
const ddl=[
 `CREATE TABLE library_revoke_meta(id INTEGER PRIMARY KEY CHECK(id=1),binding TEXT NOT NULL,cursor INTEGER NOT NULL CHECK(cursor>=0),clock INTEGER NOT NULL CHECK(clock>=0),seen_head INTEGER NOT NULL CHECK(seen_head>=cursor),seen_epoch INTEGER NOT NULL CHECK(seen_epoch>=0))`,
 `CREATE TABLE library_revoke_pages(through INTEGER PRIMARY KEY,after_pos INTEGER NOT NULL,head_pos INTEGER NOT NULL,digest TEXT NOT NULL)`,
 `CREATE TABLE library_revoke_events(seq INTEGER PRIMARY KEY,content TEXT NOT NULL CHECK(length(CAST(content AS BLOB))<=2048))`,
 `CREATE TABLE library_revoke_targets(id TEXT PRIMARY KEY,content TEXT NOT NULL CHECK(length(CAST(content AS BLOB))<=8192))`,
 `CREATE TABLE library_revoke_deliveries(id TEXT PRIMARY KEY,target_id TEXT UNIQUE NOT NULL,event_seq INTEGER NOT NULL,evidence_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','leased','acked','blocked')),revision INTEGER NOT NULL,attempts INTEGER NOT NULL,budget INTEGER NOT NULL CHECK(budget BETWEEN 32 AND 1024),until_ms INTEGER NOT NULL,retry_at INTEGER NOT NULL,settle TEXT)`,
 ...['pages','events','targets'].flatMap(t=>[
  ...['UPDATE','DELETE'].map(op=>`CREATE TRIGGER library_revoke_${t}_${op.toLowerCase()} BEFORE ${op} ON library_revoke_${t} BEGIN SELECT RAISE(ABORT,'immutable revocation evidence'); END`),
  `CREATE TRIGGER library_revoke_${t}_replace BEFORE INSERT ON library_revoke_${t} WHEN EXISTS(SELECT 1 FROM library_revoke_${t} WHERE ${t==='pages'?'through=NEW.through':t==='events'?'seq=NEW.seq':'id=NEW.id'}) BEGIN SELECT RAISE(ABORT,'immutable revocation identity'); END`,
  `CREATE TRIGGER library_revoke_${t}_capacity BEFORE INSERT ON library_revoke_${t} WHEN (SELECT count(*) FROM library_revoke_${t})>=${t==='pages'?1024:t==='events'?512:128} BEGIN SELECT RAISE(ABORT,'revocation capacity'); END`]),
 `CREATE TRIGGER library_revoke_meta_update BEFORE UPDATE ON library_revoke_meta WHEN NEW.id!=OLD.id OR NEW.binding!=OLD.binding OR NEW.cursor<OLD.cursor OR NEW.clock<OLD.clock OR NEW.seen_head<OLD.seen_head OR NEW.seen_epoch<OLD.seen_epoch BEGIN SELECT RAISE(ABORT,'revocation fence'); END`,
 `CREATE TRIGGER library_revoke_meta_replace BEFORE INSERT ON library_revoke_meta WHEN EXISTS(SELECT 1 FROM library_revoke_meta) BEGIN SELECT RAISE(ABORT,'immutable revocation binding'); END`,
 `CREATE TRIGGER library_revoke_meta_delete BEFORE DELETE ON library_revoke_meta BEGIN SELECT RAISE(ABORT,'immutable revocation binding'); END`,
 `CREATE TRIGGER library_revoke_delivery_replace BEFORE INSERT ON library_revoke_deliveries WHEN EXISTS(SELECT 1 FROM library_revoke_deliveries WHERE id=NEW.id OR target_id=NEW.target_id) BEGIN SELECT RAISE(ABORT,'immutable delivery identity'); END`,
 `CREATE TRIGGER library_revoke_delivery_update BEFORE UPDATE ON library_revoke_deliveries WHEN NEW.id!=OLD.id OR NEW.target_id!=OLD.target_id OR NEW.event_seq!=OLD.event_seq OR NEW.evidence_id!=OLD.evidence_id OR NEW.revision<OLD.revision OR NEW.attempts<OLD.attempts OR NEW.budget<OLD.budget OR OLD.state='acked' BEGIN SELECT RAISE(ABORT,'delivery fence'); END`,
 `CREATE TRIGGER library_revoke_delivery_delete BEFORE DELETE ON library_revoke_deliveries BEGIN SELECT RAISE(ABORT,'retained delivery'); END`,
 `CREATE TRIGGER library_revoke_delivery_capacity BEFORE INSERT ON library_revoke_deliveries WHEN (SELECT count(*) FROM library_revoke_deliveries)>=128 BEGIN SELECT RAISE(ABORT,'delivery capacity'); END`,
];
export function eventCheck(e:FenceEvent){
 fields(e,['seq','kind','epoch','leaseId','workloadId','workerId','generation','incarnation']);integer(e.seq);integer(e.epoch);need(e.seq>0&&e.epoch>0);
 need(['noop','lease-revoked','epoch-bumped','worker-quarantined','workload-cancelled'].includes(e.kind));
 for(const key of ['leaseId','workloadId','workerId'] as const)if(e[key]!==null)identifier(e[key]);
 for(const key of ['generation','incarnation'] as const)if(e[key]!==null)integer(e[key]);
 if(e.kind==='lease-revoked')need(e.leaseId!==null&&e.workloadId!==null&&e.workerId!==null&&e.generation!==null&&e.incarnation!==null);
 if(e.kind==='worker-quarantined')need(e.workerId!==null&&e.incarnation!==null);
 if(e.kind==='workload-cancelled')need(e.workloadId!==null&&e.generation!==null);
 if(e.kind==='noop'||e.kind==='epoch-bumped')need([e.leaseId,e.workloadId,e.workerId,e.generation,e.incarnation].every(x=>x===null));
}
export function applies(e:FenceEvent,t:RevocationTarget){const c=t.binding.compute;
 return e.kind==='epoch-bumped'?c.epoch<e.epoch:e.kind==='lease-revoked'?c.leaseId===e.leaseId&&c.workloadId===e.workloadId&&c.workerId===e.workerId&&c.epoch===e.epoch&&c.generation===e.generation&&c.incarnation===e.incarnation:e.kind==='worker-quarantined'?c.workerId===e.workerId&&c.incarnation<e.incarnation!:e.kind==='workload-cancelled'?c.workloadId===e.workloadId&&c.generation<=e.generation!:false;
}
/** Independent source cursor and durable target deliveries. Never acknowledges the compute projection outbox. */
export class RevocationRelay{
 private readonly options:Omit<RevocationOptions,'now'>;private readonly clock:()=>number;private readonly binding:string;
 constructor(private readonly port:TransactionPort,options:RevocationOptions){
  const {now,...config}=options;this.options=clean(config);fields(this.options,['environment','authorityId','sourceAuthorityId','ownerPrincipal','dispatcherPrincipal']);Object.values(this.options).forEach(identifier);need(config.ownerPrincipal!==config.dispatcherPrincipal);this.clock=now??Date.now;this.binding=inert(this.options);
  this.port.transactionSync(()=>{const objects=this.rows("SELECT name,sql FROM sqlite_master WHERE name GLOB 'library_revoke_*'");if(objects.length){need(objects.length===ddl.length&&ddl.every(sql=>objects.some(r=>r.name===sql.split(' ')[2].split('(')[0]&&r.sql===sql)),'SCHEMA_MISMATCH',409);need(this.meta().binding===this.binding,'BINDING_MISMATCH',409);}else{for(const sql of ddl)this.rows(sql);this.rows('INSERT INTO library_revoke_meta VALUES(1,?,0,0,0,0)',this.binding);}});
 }
 private rows(q:string,...b:(string|number|null)[]):Record<string,any>[]{return [...this.port.sql.exec(q,...b)];}
 private meta(){return this.rows('SELECT * FROM library_revoke_meta')[0];}
 private context(input:RevocationContext,roles:RevocationContext['role'][]){const c=clean<RevocationContext>(input);fields(c,['environment','principal','role']);need(c.environment===this.options.environment&&roles.includes(c.role)&&c.principal===(c.role==='owner'?this.options.ownerPrincipal:this.options.dispatcherPrincipal),'PERMISSION',403);return c;}
 private tick(){const n=this.clock();integer(n,Number.MAX_SAFE_INTEGER-60000);const t=Math.max(this.meta().clock,n);this.rows('UPDATE library_revoke_meta SET clock=?',t);return t;}
 sourceWatermark(c:RevocationContext){this.context(c,['owner','dispatcher']);const m=this.meta();return {head:Number(m.seen_head),epoch:Number(m.seen_epoch)};}
 private retainSource(p:{head:number;epoch:number}){const m=this.meta();need(p.head>=m.seen_head&&p.epoch>=m.seen_epoch,'SOURCE_ROLLBACK',409);this.rows('UPDATE library_revoke_meta SET seen_head=?,seen_epoch=?',p.head,p.epoch);return {head:p.head,epoch:p.epoch};}
 observeSource(c:RevocationContext,input:{head:number;epoch:number}){this.context(c,['owner','dispatcher']);const p=clean<typeof input>(input);fields(p,['head','epoch']);integer(p.head);integer(p.epoch);need(p.epoch>=1);return this.port.transactionSync(()=>this.retainSource(p));}
 identity(c:RevocationContext){this.context(c,['owner','dispatcher']);return clean(this.options) as Omit<RevocationOptions,'now'>;}
 cursor(c:RevocationContext){this.context(c,['owner','dispatcher']);return this.meta().cursor as number;}
 snapshot(c:RevocationContext){this.context(c,['owner']);return {version:1,cursor:this.meta().cursor,targets:this.rows('SELECT content FROM library_revoke_targets ORDER BY id').map(x=>JSON.parse(x.content)),deliveries:this.rows('SELECT * FROM library_revoke_deliveries ORDER BY id'),events:this.rows('SELECT content FROM library_revoke_events ORDER BY seq').map(x=>JSON.parse(x.content))};}
 private pending(target:RevocationTarget,event:FenceEvent){
  if(this.rows('SELECT id FROM library_revoke_deliveries WHERE target_id=?',target.targetId).length)return;
  const evidenceId=digest({source:this.options.sourceAuthorityId,event});const id=digest({domain:'library-revocation/v1',source:this.binding,target,event:evidenceId});
  this.rows("INSERT INTO library_revoke_deliveries VALUES(?,?,?,?,'pending',0,0,32,0,0,NULL)",id,target.targetId,event.seq,evidenceId);
 }
 register(c:RevocationContext,input:RevocationTarget){
  this.context(c,['owner']);const t=clean<RevocationTarget>(input);fields(t,['version','targetId','kind','environment','authorityId','projectId','resourceId','generation','binding']);need(t.version===1&&['catalog','broker'].includes(t.kind));for(const k of ['targetId','environment','authorityId','projectId','resourceId'] as const)identifier(t[k]);integer(t.generation);need(t.generation>=1&&t.environment===this.options.environment);validateBinding(t.binding,t.projectId,t.binding.policyVersion);need(t.binding.compute.authorityId===this.options.sourceAuthorityId,'SOURCE_BINDING',409);
  return this.port.transactionSync(()=>{const previous=this.rows('SELECT content FROM library_revoke_targets WHERE id=?',t.targetId)[0];if(previous){need(previous.content===inert(t),'TARGET_CONFLICT',409);return {registered:true,replayed:true};}this.rows('INSERT INTO library_revoke_targets VALUES(?,?)',t.targetId,inert(t));for(const row of this.rows('SELECT content FROM library_revoke_events ORDER BY seq')){const e=JSON.parse(row.content);if(applies(e,t)){this.pending(t,e);break;}}return {registered:true,replayed:false};});
 }
 ingest(c:RevocationContext,input:FencePage){
  this.context(c,['owner','dispatcher']);const p=clean<FencePage>(input);fields(p,['version','environment','authorityId','epoch','after','through','head','events']);need(p.version===1&&p.environment===this.options.environment&&p.authorityId===this.options.sourceAuthorityId,'SOURCE_BINDING',409);for(const k of ['epoch','after','through','head'] as const)integer(p[k]);need(p.epoch>=1&&p.after<=p.through&&p.through<=p.head&&Array.isArray(p.events)&&p.events.length<=64&&p.events.length===p.through-p.after);
  p.events.forEach((e,i)=>{eventCheck(e);need(e.seq===p.after+i+1&&e.epoch<=p.epoch,'SOURCE_GAP',409);});
  const d=digest(p);
  // Commit fully validated source knowledge before bounded evidence retention can fail.
  // Historical exact replay is evidence lookup only: it must never learn a new watermark.
  const observed=this.port.transactionSync(()=>{const cursor=this.meta().cursor;if(p.after!==cursor){const old=this.rows('SELECT * FROM library_revoke_pages WHERE through=?',p.through)[0];need(p.after<cursor&&old&&old.after_pos===p.after&&old.digest===d,'SOURCE_CURSOR',409);return {cursor,replayed:true};}this.retainSource({head:p.head,epoch:p.epoch});return null;});
  if(observed)return observed;
  return this.port.transactionSync(()=>{const m=this.meta(),cursor=m.cursor;
   // Recheck both fences after the independent knowledge commit.
   need(p.after===cursor,'SOURCE_CURSOR',409);need(p.head>=m.seen_head&&p.epoch>=m.seen_epoch,'SOURCE_ROLLBACK',409);if(p.through===cursor)return {cursor,replayed:false};
   this.rows('INSERT INTO library_revoke_pages VALUES(?,?,?,?)',p.through,p.after,p.head,d);
   const targets=this.rows('SELECT content FROM library_revoke_targets ORDER BY id').map(x=>JSON.parse(x.content) as RevocationTarget);
   for(const e of p.events)if(e.kind!=='noop'){this.rows('INSERT INTO library_revoke_events VALUES(?,?)',e.seq,inert(e));for(const t of targets)if(applies(e,t))this.pending(t,e);}
   this.rows('UPDATE library_revoke_meta SET cursor=?',p.through);return {cursor:p.through,replayed:false};});
 }
 claim(c:RevocationContext,ttlMs=10000):Delivery|null{
  this.context(c,['owner','dispatcher']);integer(ttlMs,30000);need(ttlMs>=1000);
  return this.port.transactionSync(()=>{const now=this.tick(),r=this.rows("SELECT * FROM library_revoke_deliveries WHERE (state='pending' AND retry_at<=?) OR (state='leased' AND until_ms<=?) ORDER BY rowid LIMIT 1",now,now)[0];if(!r)return null;
   if(r.attempts>=r.budget){this.rows("UPDATE library_revoke_deliveries SET state='blocked' WHERE id=?",r.id);return null;}
   const revision=r.revision+1;this.rows("UPDATE library_revoke_deliveries SET state='leased',revision=?,attempts=attempts+1,until_ms=?,settle=NULL WHERE id=?",revision,now+ttlMs,r.id);
   return {version:1,deliveryId:r.id,revision,target:JSON.parse(this.rows('SELECT content FROM library_revoke_targets WHERE id=?',r.target_id)[0].content),event:JSON.parse(this.rows('SELECT content FROM library_revoke_events WHERE seq=?',r.event_seq)[0].content),evidenceId:r.evidence_id,key:r.id};});
 }
 settle(c:RevocationContext,input:{deliveryId:string;revision:number;outcome:'ack'|'retry'|'blocked';receipt:DeliveryReceipt|null}){
  this.context(c,['owner','dispatcher']);const s=clean<typeof input>(input);fields(s,['deliveryId','revision','outcome','receipt']);hash(s.deliveryId);integer(s.revision);need(['ack','retry','blocked'].includes(s.outcome));
  return this.port.transactionSync(()=>{const r=this.rows('SELECT * FROM library_revoke_deliveries WHERE id=?',s.deliveryId)[0];need(r&&r.revision===s.revision,'DELIVERY_FENCE',409);if(r.settle!==null){need(r.settle===inert(s),'SETTLE_CONFLICT',409);return {settled:true};}need(r.state==='leased','DELIVERY_FENCE',409);const now=this.tick();need(now<r.until_ms,'DELIVERY_EXPIRED',409);
   if(s.outcome==='ack'){const a=s.receipt;need(!!a);fields(a,['version','deliveryId','evidenceId','targetId','status']);need(a!.version===1&&a!.deliveryId===r.id&&a!.evidenceId===r.evidence_id&&a!.targetId===r.target_id&&['revoked','already-revoked','superseded'].includes(a!.status),'ACK_BINDING',409);}else need(s.receipt===null);
   const state=s.outcome==='ack'?'acked':s.outcome==='blocked'?'blocked':'pending';this.rows('UPDATE library_revoke_deliveries SET state=?,retry_at=?,settle=? WHERE id=?',state,now+Math.min(60000,1000*2**Math.min(r.attempts-1,6)),inert(s),r.id);return {settled:true};});
 }
 recover(c:RevocationContext,id:string){this.context(c,['owner']);hash(id);return this.port.transactionSync(()=>{const r=this.rows('SELECT * FROM library_revoke_deliveries WHERE id=?',id)[0];need(r&&r.state==='blocked','NOT_BLOCKED',409);need(r.budget<1024,'RETRY_CAPACITY',409);this.rows("UPDATE library_revoke_deliveries SET state='pending',budget=budget+32,retry_at=0 WHERE id=?",id);return {recovered:true};});}
 async deliverOne(c:RevocationContext,port:DeliveryPort):Promise<{status:'idle'|'acked'|'retry'|'blocked'}>{
  const delivery=this.claim(c);if(!delivery)return {status:'idle'};
  let timer:ReturnType<typeof setTimeout>|undefined;
  let receipt:unknown;try{receipt=await Promise.race([port.deliver(delivery),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('delivery timeout')),5000);})]);}catch{this.settle(c,{deliveryId:delivery.deliveryId,revision:delivery.revision,outcome:'retry',receipt:null});return {status:'retry'};}finally{if(timer)clearTimeout(timer);}
  // Invalid acknowledgements never advance delivery; they require owner recovery.
  let valid=false;try{const r=clean<DeliveryReceipt>(receipt);fields(r,['version','deliveryId','evidenceId','targetId','status']);valid=r.version===1&&r.deliveryId===delivery.deliveryId&&r.evidenceId===delivery.evidenceId&&r.targetId===delivery.target.targetId&&['revoked','already-revoked','superseded'].includes(r.status);}catch{}
  if(!valid){this.settle(c,{deliveryId:delivery.deliveryId,revision:delivery.revision,outcome:'blocked',receipt:null});return {status:'blocked'};}
  this.settle(c,{deliveryId:delivery.deliveryId,revision:delivery.revision,outcome:'ack',receipt:receipt as DeliveryReceipt});return {status:'acked'};
 }
}
