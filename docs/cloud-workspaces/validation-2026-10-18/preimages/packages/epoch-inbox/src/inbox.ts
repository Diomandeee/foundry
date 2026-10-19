import { SCHEMA, SCHEMA_VERSION } from './schema';
export type SqlValue = string | number | null | ArrayBuffer;
export interface TransactionPort { sql: { exec(query:string,...bindings:SqlValue[]):Iterable<Record<string,unknown>> }; transactionSync<T>(callback:()=>T):T }
export interface TrustedContext { environment:string; principal:string; role:'owner'|'observer'|'projector' }
export interface InboxOptions { environment:string; authorityId:string; now?:()=>number }
export interface InboxEvent { network:string; blockHeight:number; blockHash:string; parentHash:string; transactionId:string; eventIndex:number; payload:unknown }
export type Envelope = { key:string } & (
 | {operation:'registerSource';body:{sourceId:string;network:string;observerPrincipal:string}}
 | {operation:'ingest';body:{sourceId:string;expectedCursor:number;event:InboxEvent}}
 | {operation:'readOutbox';body:{after:number;limit:number}}
 | {operation:'ackOutbox';body:{through:number}});
type Row = Record<string,unknown>;
const encoder = new TextEncoder();
const bytes = (s:string)=>encoder.encode(s).byteLength;
export class InboxRejected extends Error {
 constructor(public readonly code:string,public readonly status:400|403|409|507,message=code){super(message);this.name='InboxRejected';}
}
function ensure(ok:unknown,message:string):asserts ok {
 if(ok)return;
 const status = /capacity/.test(message)?507:/permission|required|environment mismatch|invalid role/.test(message)?403:/collision|immutable|cursor mismatch|quarantined|binding mismatch|ack beyond|acknowledged prefix|network mismatch/.test(message)?409:400;
 throw new InboxRejected(message.toUpperCase().replace(/[^A-Z0-9]+/g,'_'),status,message);
}
function fields(value:unknown,names:string[]):asserts value is Row {
 ensure(value!==null && typeof value==='object' && !Array.isArray(value) && Object.getPrototypeOf(value)===Object.prototype,'expected plain object');
 ensure(Reflect.ownKeys(value).length===names.length && names.every(n=>Object.hasOwn(value,n)),'unknown or missing field');
 for(const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) ensure('value' in descriptor,'accessor rejected');
}
function id(value:unknown):asserts value is string {ensure(typeof value==='string' && /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/.test(value),'invalid identifier');}
function integer(value:unknown,max=10000):asserts value is number {ensure(Number.isSafeInteger(value) && (value as number)>=0 && (value as number)<=max,'invalid integer');}
/** Bounded traversal before encoding: rejects cycles, exotic objects and non-JSON coercions. */
export function canonical(value:unknown):string {
 let nodes=0, budget=0; const active=new Set<object>();
 function visit(v:unknown,depth:number):string {
  ensure(++nodes<=8192 && depth<=32,'JSON complexity');
  let result:string;
  if(v===null || typeof v==='boolean') result=String(v);
  else if(typeof v==='number'){ensure(Number.isFinite(v),'nonfinite JSON');result=JSON.stringify(v);}
  else if(typeof v==='string'){ensure(bytes(v)<=32768,'JSON bytes');result=JSON.stringify(v);}
  else {
   ensure(typeof v==='object' && v!==null && !active.has(v),'invalid JSON');active.add(v);
   const descriptors=Object.getOwnPropertyDescriptors(v);
   ensure(Object.values(descriptors).every(d=>'value' in d),'accessor rejected');
   if(Array.isArray(v)) {
    ensure(v.length<=8192 && Reflect.ownKeys(v).length===v.length+1 && Array.from({length:v.length},(_,i)=>Object.hasOwn(v,i)).every(Boolean),'invalid JSON array');
    result='['+v.map(x=>visit(x,depth+1)).join(',')+']';
   } else {
    ensure(Object.getPrototypeOf(v)===Object.prototype && Reflect.ownKeys(v).every(k=>typeof k==='string'),'invalid JSON object');
    ensure(Object.values(descriptors).every(d=>d.enumerable),'nonenumerable JSON field');
    const keys=Object.keys(v).sort();ensure(keys.length<=8192,'JSON complexity');
    result='{'+keys.map(k=>{ensure(bytes(k)<=32768,'JSON key bytes');return JSON.stringify(k)+':'+visit((v as Row)[k],depth+1);}).join(',')+'}';
   }
   active.delete(v);
  }
  budget+=bytes(result);ensure(budget<=1048576 && bytes(result)<=32768,'JSON bytes');return result;
 }
 return visit(value,0);
}
export class EpochInbox {
 private readonly options:InboxOptions;
 constructor(private readonly port:TransactionPort,options:InboxOptions){
  id(options.environment);id(options.authorityId);this.options={...options};
  port.transactionSync(()=>{
   // Inspect an existing version before applying any schema statements.
   const exists=this.rows("SELECT name FROM sqlite_master WHERE type='table' AND name='epoch_inbox_meta'");
   if(exists.length) this.binding();
   for(const sql of SCHEMA) this.rows(sql);
   if(!exists.length) this.rows('INSERT INTO epoch_inbox_meta(id,environment,authority_id,schema_version) VALUES(1,?,?,?)',options.environment,options.authorityId,SCHEMA_VERSION);
   this.binding();
  });
 }
 private rows(sql:string,...args:SqlValue[]):Row[]{return [...this.port.sql.exec(sql,...args)].map(row=>({...row}));}
 private binding():Row {
  const m=this.rows('SELECT * FROM epoch_inbox_meta WHERE id=1')[0];
  ensure(m && m.environment===this.options.environment && m.authority_id===this.options.authorityId && m.schema_version===SCHEMA_VERSION,'inbox binding mismatch');return m;
 }
 private context(ctx:TrustedContext){fields(ctx,['environment','principal','role']);id(ctx.principal);ensure(ctx.environment===this.options.environment,'environment mismatch');ensure(['owner','observer','projector'].includes(ctx.role),'invalid role');this.binding();}
 private count(table:string):number {return Number(this.rows(`SELECT count(*) AS n FROM epoch_inbox_${table}`)[0].n);}
 private authorize(ctx:TrustedContext,op:string,body:Row){
  if(op==='registerSource') ensure(ctx.role==='owner','owner required');
  else if(op==='ingest') {
   ensure(ctx.role==='observer','observer required');
   const source=this.rows('SELECT * FROM epoch_inbox_sources WHERE source_id=?',body.sourceId as string)[0];
   ensure(source && source.observer_principal===ctx.principal,'source permission');
   ensure(source.network===(body.event as Row).network,'source network mismatch');
  } else ensure(ctx.role==='owner'||ctx.role==='projector','projector required');
 }
 execute(ctx:TrustedContext,envelope:Envelope):Row {
  // Snapshot mutable caller data before entering the transaction.
  const request=canonical({context:ctx,envelope});ensure(bytes(request)<=32768,'request bytes');
  const copy=JSON.parse(request);ctx=copy.context;envelope=copy.envelope;
  fields(envelope,['operation','key','body']);id(envelope.key);
  const b=envelope.body as unknown as Row;
  switch(envelope.operation){
   case 'registerSource':fields(b,['sourceId','network','observerPrincipal']);id(b.sourceId);id(b.network);id(b.observerPrincipal);break;
   case 'ingest':{
    fields(b,['sourceId','expectedCursor','event']);id(b.sourceId);integer(b.expectedCursor);
    fields(b.event,['network','blockHeight','blockHash','parentHash','transactionId','eventIndex','payload']);
    const e=b.event;id(e.network);integer(e.blockHeight,Number.MAX_SAFE_INTEGER);integer(e.eventIndex,Number.MAX_SAFE_INTEGER);
    for(const name of ['blockHash','parentHash','transactionId']) ensure(typeof e[name]==='string' && /^[0-9a-f]{64}$/.test(e[name] as string),'invalid hash');
    ensure(bytes(canonical(e.payload))<=16384,'payload bytes');break;
   }
   case 'readOutbox':fields(b,['after','limit']);integer(b.after,11128);integer(b.limit,100);ensure(b.limit>0,'invalid limit');break;
   case 'ackOutbox':fields(b,['through']);integer(b.through,11128);break;
   default:throw new InboxRejected('UNKNOWN_OPERATION',400);
  }
  return this.port.transactionSync(()=>{
   this.context(ctx);this.authorize(ctx,envelope.operation,b);
   const cursorProtocol=envelope.operation==='readOutbox'||envelope.operation==='ackOutbox';
   const old=cursorProtocol?undefined:this.rows('SELECT request,response FROM epoch_inbox_commands WHERE principal=? AND role=? AND key=?',ctx.principal,ctx.role,envelope.key)[0];
   if(old){ensure(old.request===request,'idempotency collision');return JSON.parse(old.response as string);}
   const firstQuarantine=envelope.operation==='ingest' && this.isFirstQuarantine(b);
   if(!cursorProtocol) ensure(this.count('commands')<(firstQuarantine?20128:20000),'command capacity');
   let result:Row;
   if(envelope.operation==='registerSource'){
    const existing=this.rows('SELECT * FROM epoch_inbox_sources WHERE source_id=?',b.sourceId as string)[0];
    if(existing) ensure(existing.network===b.network && existing.observer_principal===b.observerPrincipal,'source immutable');
    else {ensure(this.count('sources')<128,'source capacity');this.rows('INSERT INTO epoch_inbox_sources(source_id,network,observer_principal) VALUES(?,?,?)',b.sourceId as string,b.network as string,b.observerPrincipal as string);this.emit(ctx,'source-registered',b.sourceId as string,canonical(['source',b.sourceId]));}
    result={ok:true,sourceId:b.sourceId,cursor:existing?.cursor??0};
   } else if(envelope.operation==='ingest') result=this.ingest(ctx,b);
   else if(envelope.operation==='readOutbox'){
    const m=this.binding();ensure(b.after===m.ack,'read must start at acknowledged prefix');
    const candidates=this.rows('SELECT * FROM epoch_inbox_outbox WHERE seq>? ORDER BY seq LIMIT ?',b.after as number,b.limit as number);
    const items:Row[]=[];let used=2;
    for(const row of candidates){
     const item:Row={...row};
     const audit=this.rows('SELECT actor,at_ms FROM epoch_inbox_audit WHERE seq=?',row.seq as number)[0];
     if(audit)item.audit=audit;
     if(row.kind==='source-registered')item.source=this.rows('SELECT network,observer_principal FROM epoch_inbox_sources WHERE source_id=?',row.source_id as string)[0];
     const observed=this.rows('SELECT content,cursor FROM epoch_inbox_events WHERE event_id=?',row.event_id as string)[0];
     if(observed) item.event={eventId:row.event_id,cursor:observed.cursor,content:JSON.parse(observed.content as string)};
     if(row.kind==='conflict') {
      const evidence=this.rows('SELECT content FROM epoch_inbox_quarantines WHERE source_id=? AND event_id=?',row.source_id as string,row.event_id as string)[0];
      if(evidence)item.conflict={content:JSON.parse(evidence.content as string)};
     }
     const size=bytes(JSON.stringify(item))+1;if(used+size>131072)break;items.push(item);used+=size;
    }
    const delivered=Math.max(Number(m.delivered),Number(items.at(-1)?.seq??m.ack));
    this.rows('UPDATE epoch_inbox_meta SET delivered=? WHERE id=1',delivered);
    result={ok:true,items,acknowledged:m.ack,delivered};
   } else {
    const m=this.binding();ensure((b.through as number)>=Number(m.ack) && (b.through as number)<=Number(m.delivered),'ack beyond delivered prefix');
    this.rows('UPDATE epoch_inbox_meta SET ack=? WHERE id=1',b.through as number);result={ok:true,acknowledged:b.through};
   }
   if(!cursorProtocol)this.rows('INSERT INTO epoch_inbox_commands(principal,role,key,request,response) VALUES(?,?,?,?,?)',ctx.principal,ctx.role,envelope.key,request,canonical(result));return result;
  });
 }
 private nextEvidence():number {return Number(this.rows('SELECT COALESCE(max(evidence_seq),0)+1 AS n FROM (SELECT evidence_seq FROM epoch_inbox_quarantines UNION ALL SELECT evidence_seq FROM epoch_inbox_conflicts)')[0].n);}
 private isFirstQuarantine(b:Row):boolean {
  const e=b.event as Row, sourceId=b.sourceId as string;
  if(this.rows('SELECT source_id FROM epoch_inbox_quarantines WHERE source_id=?',sourceId).length)return false;
  const eventId=canonical([sourceId,e.network,e.blockHash,e.transactionId,e.eventIndex]);
  const original=this.rows('SELECT content FROM epoch_inbox_events WHERE event_id=?',eventId)[0];
  return !!original && original.content!==canonical(e);
 }
 private ingest(ctx:TrustedContext,b:Row):Row {
  const e=b.event as Row, sourceId=b.sourceId as string;
  const eventId=canonical([sourceId,e.network,e.blockHash,e.transactionId,e.eventIndex]);
  const content=canonical(e);
  const original=this.rows('SELECT * FROM epoch_inbox_events WHERE event_id=?',eventId)[0];
  const source=this.rows('SELECT * FROM epoch_inbox_sources WHERE source_id=?',sourceId)[0];
  if(original){
   if(original.content===content) return {ok:true,status:'duplicate',eventId,cursor:original.cursor};
   const quarantine=this.rows('SELECT * FROM epoch_inbox_quarantines WHERE source_id=?',sourceId)[0];
   const known=(quarantine?.event_id===eventId && quarantine.content===content) || this.rows('SELECT id FROM epoch_inbox_conflicts WHERE event_id=? AND content=?',eventId,content)[0];
   if(!known){
    if(!quarantine){
     this.rows('INSERT INTO epoch_inbox_quarantines(source_id,evidence_seq,event_id,content) VALUES(?,?,?,?)',sourceId,this.nextEvidence(),eventId,content);
     this.rows('UPDATE epoch_inbox_sources SET quarantined=1 WHERE source_id=?',sourceId);
     this.emit(ctx,'conflict',sourceId,eventId,true);
    } else {
     ensure(this.count('conflicts')<1000,'conflict capacity');
     this.rows('INSERT INTO epoch_inbox_conflicts(evidence_seq,event_id,content) VALUES(?,?,?)',this.nextEvidence(),eventId,content);
    }
   }
   return {ok:false,status:'conflict',eventId,cursor:original.cursor};
  }
  ensure(!source.quarantined,'source quarantined');ensure(source.cursor===b.expectedCursor,'cursor mismatch');
  ensure(this.count('events')<10000,'event capacity');
  const cursor=Number(source.cursor)+1;
  this.rows('INSERT INTO epoch_inbox_events(event_id,source_id,network,cursor,content) VALUES(?,?,?,?,?)',eventId,sourceId,e.network as string,cursor,content);
  this.rows('UPDATE epoch_inbox_sources SET cursor=? WHERE source_id=?',cursor,sourceId);
  this.emit(ctx,'observed',sourceId,eventId);return {ok:true,status:'accepted',eventId,cursor};
 }
 private emit(ctx:TrustedContext,kind:string,source:string,eventId:string,reserved=false){
  const ceiling=reserved?11128:11000;
  ensure(this.count('audit')<ceiling && this.count('outbox')<ceiling,'outbox capacity');
  const seq=this.count('audit')+1;const now=this.options.now?.()??Date.now();integer(now,Number.MAX_SAFE_INTEGER);
  this.rows('INSERT INTO epoch_inbox_audit(seq,kind,source_id,event_id,actor,at_ms) VALUES(?,?,?,?,?,?)',seq,kind,source,eventId,ctx.principal,now);
  this.rows('INSERT INTO epoch_inbox_outbox(seq,kind,source_id,event_id) VALUES(?,?,?,?)',seq,kind,source,eventId);
 }
 snapshot(ctx:TrustedContext):Row {
  return this.port.transactionSync(()=>{
   this.context(ctx);ensure(ctx.role==='owner','owner required');const meta=this.binding();const totals:Row={},hasMore:Row={},result:Row={ok:true,meta,totals,hasMore};
   // At most 8 content rows (<=256KiB) per content-bearing page; all other pages <=100 small rows.
   for(const table of ['sources','events','conflicts','audit','outbox','commands']){
    totals[table]=this.count(table)+(table==='conflicts'?this.count('quarantines'):0);const limit=['events','conflicts','commands'].includes(table)?8:100;
    const columns=table==='commands'?'principal,role,key': '*';
    result[table]=table==='conflicts'?this.rows('SELECT evidence_seq,event_id,content FROM (SELECT evidence_seq,event_id,content FROM epoch_inbox_quarantines UNION ALL SELECT evidence_seq,event_id,content FROM epoch_inbox_conflicts) ORDER BY evidence_seq DESC,event_id DESC LIMIT ?',limit):this.rows(`SELECT ${columns} FROM epoch_inbox_${table} ORDER BY rowid DESC LIMIT ?`,limit);
    hasMore[table]=Number(totals[table])>(result[table] as Row[]).length;
   }return result;
  });
 }
}
