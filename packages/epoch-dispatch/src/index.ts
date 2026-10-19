import {createHash} from 'node:crypto';
import {EpochInbox,canonical,type TransactionPort,type TrustedContext as InboxContext,type InboxEvent} from '../../epoch-inbox/src/inbox';
import {EpochChain,ChainRejected,type Options,type TrustedContext,type Reconciliation,type Intent} from '../../epoch-chain/src/chain';
import {decodeContractLog,decodeNakamotoBlock} from '../../stacks-events/src/index';
import {prepareEventSummary,planEventJob,EVENT_SUMMARY_TEMPLATE,type EventJobPolicy} from '../../epoch-jobs/src/index';
export interface PipelineOptions {chain:Options;jobPolicy:EventJobPolicy;coordinatorPrincipal:string}
export interface Observation {key:string;expectedCursor:number;block:unknown;transaction:unknown;eventIndex:number}
export interface ComputeTransport {fetcher:{fetch(request:Request):Promise<Response>};target:string;ownerBearer:string;submitterBearer:string;submitterPrincipal:string}
class DeliveryFailure extends Error {constructor(public code:string,public permanent:boolean){super(code);}}
export class PipelineRejected extends Error {constructor(public code:string,public status=409){super(code);}}
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
function need(v:unknown,code:string,status=409):asserts v {if(!v)throw new PipelineRejected(code,status);}
/** Nested cores participate in the same outer application transaction, never BEGIN recursively. */
export function depthAware(port:TransactionPort):TransactionPort {let depth=0;return {sql:port.sql,transactionSync(fn){if(depth)return fn();return port.transactionSync(()=>{depth++;try{return fn();}finally{depth--;}});}};}
export class EpochPipeline {
 readonly inbox:EpochInbox;readonly chain:EpochChain;private port:TransactionPort;private options:PipelineOptions;private binding:string;
 private internal:TrustedContext;
 constructor(port:TransactionPort,options:PipelineOptions){
  this.port=depthAware(port);
  // Functions are host-only and excluded from the immutable binding.
  const {now,...chain}=options.chain;
  this.options={...JSON.parse(canonical({chain,jobPolicy:options.jobPolicy,coordinatorPrincipal:options.coordinatorPrincipal})),chain:{...chain,now}};
  this.binding=canonical({schema:2,chain,jobPolicy:options.jobPolicy,coordinatorPrincipal:options.coordinatorPrincipal});
  need(/^[A-Za-z0-9._-]{1,64}$/.test(options.coordinatorPrincipal),'INVALID_COORDINATOR',400);
  for(const k of ['environment','authorityId','sourceId','network'] as const)need(chain[k]===options.jobPolicy[k],'POLICY_BINDING',400);
  this.internal={environment:chain.environment,principal:options.coordinatorPrincipal,role:'owner'};
  const cores=this.port.transactionSync(()=>{
   const tables=this.rows("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'epoch_pipeline_*'").map(r=>String(r.name));
   const expected=['epoch_pipeline_meta','epoch_pipeline_plans','epoch_pipeline_dispatch_cursor','epoch_pipeline_delivery'];
   need(!tables.length||(tables.length===expected.length&&expected.every(t=>tables.includes(t))),'PIPELINE_SCHEMA_INCOMPLETE');
   const inbox=new EpochInbox(this.port,{environment:chain.environment,authorityId:chain.authorityId,now});
   const core=new EpochChain(this.port,{...chain,now});
   this.rows('CREATE TABLE IF NOT EXISTS epoch_pipeline_meta(id INTEGER PRIMARY KEY CHECK(id=1),binding TEXT NOT NULL)');
   const old=this.rows('SELECT binding FROM epoch_pipeline_meta WHERE id=1')[0];
   need(!old||old.binding===this.binding,'PIPELINE_BINDING');
   if(!old)this.rows('INSERT INTO epoch_pipeline_meta VALUES(1,?)',this.binding);
   this.rows("CREATE TRIGGER IF NOT EXISTS epoch_pipeline_meta_replace BEFORE INSERT ON epoch_pipeline_meta WHEN EXISTS(SELECT 1 FROM epoch_pipeline_meta) BEGIN SELECT RAISE(ABORT,'immutable pipeline binding'); END");
   this.rows('CREATE TABLE IF NOT EXISTS epoch_pipeline_plans(event_id TEXT PRIMARY KEY,frozen TEXT NOT NULL CHECK(length(CAST(frozen AS BLOB))<=32768))');
   this.rows('CREATE TABLE IF NOT EXISTS epoch_pipeline_dispatch_cursor(id INTEGER PRIMARY KEY CHECK(id=1),after_seq INTEGER NOT NULL)');
   this.rows('INSERT OR IGNORE INTO epoch_pipeline_dispatch_cursor VALUES(1,0)');
   this.rows('CREATE TABLE IF NOT EXISTS epoch_pipeline_delivery(intent_id TEXT PRIMARY KEY,code TEXT NOT NULL,blocked INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0,recovery_generation INTEGER NOT NULL DEFAULT 0)');
   this.rows("CREATE TRIGGER IF NOT EXISTS epoch_pipeline_delivery_intent BEFORE INSERT ON epoch_pipeline_delivery WHEN NOT EXISTS(SELECT 1 FROM epoch_chain_intents WHERE intent_id=NEW.intent_id) BEGIN SELECT RAISE(ABORT,'delivery intent binding'); END");
   this.rows("CREATE TRIGGER IF NOT EXISTS epoch_pipeline_delivery_capacity BEFORE INSERT ON epoch_pipeline_delivery WHEN NOT EXISTS(SELECT 1 FROM epoch_pipeline_delivery WHERE intent_id=NEW.intent_id) AND (SELECT count(*) FROM epoch_pipeline_delivery)>=3072 BEGIN SELECT RAISE(ABORT,'delivery capacity'); END");
   this.rows("CREATE TRIGGER IF NOT EXISTS epoch_pipeline_delivery_identity BEFORE UPDATE OF intent_id ON epoch_pipeline_delivery BEGIN SELECT RAISE(ABORT,'immutable delivery identity'); END");
   for(const table of ['meta','plans'])for(const op of ['UPDATE','DELETE'])this.rows(`CREATE TRIGGER IF NOT EXISTS epoch_pipeline_${table}_${op} BEFORE ${op} ON epoch_pipeline_${table} BEGIN SELECT RAISE(ABORT,'immutable pipeline'); END`);
   this.rows("CREATE TRIGGER IF NOT EXISTS epoch_pipeline_plan_replace BEFORE INSERT ON epoch_pipeline_plans WHEN EXISTS(SELECT 1 FROM epoch_pipeline_plans WHERE event_id=NEW.event_id) BEGIN SELECT RAISE(ABORT,'immutable pipeline'); END");
   this.rows("CREATE TRIGGER IF NOT EXISTS epoch_pipeline_plan_capacity BEFORE INSERT ON epoch_pipeline_plans WHEN (SELECT count(*) FROM epoch_pipeline_plans)>=256 BEGIN SELECT RAISE(ABORT,'pipeline capacity'); END");
   return {inbox,core};
  });this.inbox=cores.inbox;this.chain=cores.core;
 }
 private rows(q:string,...b:(string|number|null)[]){return [...this.port.sql.exec(q,...b)];}
 private owner(c:InboxContext){need(c.environment===this.options.chain.environment&&c.role==='owner','OWNER_REQUIRED',403);}
 private observer(c:InboxContext){need(c.environment===this.options.chain.environment&&c.role==='observer'&&c.principal===this.options.chain.observerPrincipal,'OBSERVER_REQUIRED',403);}
 register(c:InboxContext,key:string){this.owner(c);const o=this.options.chain;return this.inbox.execute(c,{operation:'registerSource',key,body:{sourceId:o.sourceId,network:o.network,observerPrincipal:o.observerPrincipal}});}
 observeHeader(c:InboxContext,raw:unknown){this.observer(c);return this.chain.observeHeader({...c,role:'observer'},decodeNakamotoBlock(raw));}
 ingest(c:InboxContext,input:Observation){
  this.observer(c);need(!!input&&Object.getPrototypeOf(input)===Object.prototype&&Reflect.ownKeys(input).length===5&&Object.values(Object.getOwnPropertyDescriptors(input)).every(d=>'value'in d&&d.enumerable),'INVALID_OBSERVATION',400);need(Object.keys(input).sort().join(',')==='block,eventIndex,expectedCursor,key,transaction','INVALID_OBSERVATION',400);
  const policy=this.options.jobPolicy;
  const event=decodeContractLog({block:input.block,transaction:input.transaction,eventIndex:input.eventIndex},policy);
  const header=decodeNakamotoBlock(input.block);
  return this.port.transactionSync(()=>{
   const accepted=this.inbox.execute(c,{operation:'ingest',key:input.key,body:{sourceId:policy.sourceId,expectedCursor:input.expectedCursor,event}});
   if(accepted.status==='conflict'){
    this.chain.quarantine(this.internal,{expectedRevision:this.chain.metadata(this.internal).revision,reason:'inbox-conflict'});return accepted;
   }
   need(accepted.ok&&typeof accepted.eventId==='string','INBOX_ACCEPTANCE');
   // Actual accepted immutable inbox content is the sole projection basis.
   const stored=this.rows('SELECT content FROM epoch_inbox_events WHERE event_id=?',accepted.eventId)[0];
   need(stored&&stored.content===canonical(event),'INBOX_ASSOCIATION');
   const approved=JSON.parse(String(stored.content)) as InboxEvent;
   const prepared=prepareEventSummary(this.scope(),accepted.eventId,approved,policy);
   const frozen=canonical({event:approved,policy});
   need(Buffer.byteLength(frozen)<=32768,'PLAN_CAPACITY',507);
   const old=this.rows('SELECT frozen FROM epoch_pipeline_plans WHERE event_id=?',accepted.eventId)[0];
   if(old)need(old.frozen===frozen,'FROZEN_PLAN_CONFLICT');
   else {need(Number(this.rows('SELECT count(*) n FROM epoch_pipeline_plans')[0].n)<256,'PLAN_CAPACITY',507);this.rows('INSERT INTO epoch_pipeline_plans VALUES(?,?)',accepted.eventId,frozen);}
   const observed=this.chain.observeHeader({...c,role:'observer'},header);
   if(observed.status!=='conflict')this.chain.observeEvent(this.internal,{eventId:accepted.eventId,headerId:header.id,contentHash:hash(canonical(approved)),template:{id:EVENT_SUMMARY_TEMPLATE,manifestHash:prepared.policyHash,expectedOutputHash:prepared.expectedOutputHash}});
   return accepted;
  });
 }
 private scope(){const {environment,authorityId,sourceId,network}=this.options.jobPolicy;return {environment,authorityId,sourceId,network};}
 bootstrap(c:InboxContext,b:{expectedRevision:number;rootId:string}){this.owner(c);return this.chain.bootstrap({...c,role:'owner'},b);}
 reconcile(c:InboxContext,b:Reconciliation){this.owner(c);return this.chain.reconcile({...c,role:'owner'},b);}
 readDecisions(c:InboxContext,b:{after:number;limit:number}){this.owner(c);return this.chain.readDecisions({...c,role:'owner'},b);}
 snapshot(c:InboxContext){this.owner(c);return {inbox:this.inbox.snapshot(c),chain:this.chain.snapshot(this.internal),delivery:this.rows('SELECT * FROM epoch_pipeline_delivery ORDER BY intent_id')};}
 private plan(i:Intent){
  const row=this.rows('SELECT frozen FROM epoch_pipeline_plans WHERE event_id=?',i.eventId)[0];need(row,'MISSING_PLAN');
  const frozen=JSON.parse(String(row.frozen));need(canonical(frozen.policy)===canonical(this.options.jobPolicy),'FROZEN_POLICY');
  need(hash(canonical(frozen.event))===i.contentHash,'CONTENT_BINDING');
  const plan=planEventJob({...this.scope(),workloadId:i.workloadId},i.eventId,frozen.event,i.generation,frozen.policy);
  need(i.template.id===EVENT_SUMMARY_TEMPLATE&&i.template.manifestHash===plan.policyHash&&i.template.expectedOutputHash===plan.expectedOutputHash&&plan.submitBody.policy.sha256===i.template.expectedOutputHash,'TEMPLATE_BINDING');
  need(Buffer.byteLength(plan.submitBody.specification)<=16384,'SPEC_CAPACITY',507);return plan;
 }
 private log(i:Intent,code:string,blocked=false,retryAt=0){this.port.transactionSync(()=>this.rows('INSERT INTO epoch_pipeline_delivery(intent_id,code,blocked,retry_at) VALUES(?,?,?,?) ON CONFLICT(intent_id) DO UPDATE SET code=excluded.code,blocked=excluded.blocked,retry_at=excluded.retry_at',i.intentId,code,+blocked,retryAt));}
 recover(c:InboxContext,input:{intentId:string}){
  this.owner(c);need(Object.keys(input).join(',')==='intentId'&&typeof input.intentId==='string','INVALID_RECOVERY',400);
  return this.port.transactionSync(()=>{const old=this.rows('SELECT * FROM epoch_pipeline_delivery WHERE intent_id=?',input.intentId)[0];need(old&&this.rows('SELECT intent_id FROM epoch_chain_intents WHERE intent_id=?',input.intentId).length===1,'UNKNOWN_DELIVERY');need(Number(old.recovery_generation)<Number.MAX_SAFE_INTEGER,'RECOVERY_CAPACITY',507);this.rows("UPDATE epoch_pipeline_delivery SET blocked=0,retry_at=0,recovery_generation=recovery_generation+1,code='OWNER_RECOVERED' WHERE intent_id=?",input.intentId);return {ok:true,recoveryGeneration:Number(old.recovery_generation)+1};});
 }
 private accepted(reply:{ok:boolean;status:number;body:any}){
  if(reply.ok&&reply.body.ok===true)return;
  const raw=typeof reply.body?.code==='string'?reply.body.code:'';
  const transient=reply.status>=500&&reply.status!==507||[408,429].includes(reply.status)||['stale-epoch','stale-generation','stale-fence','verification-fenced'].includes(raw);
  const known=new Set(['stale-epoch','stale-generation','stale-fence','quota-required','quota-exceeded','workload-identity-conflict','unauthorized','role-forbidden','artifact-capacity','temporarily-unavailable','malformed-response']);
  const safe=known.has(raw)?raw.toUpperCase().replace(/-/g,'_'):'RESPONSE';
  throw new DeliveryFailure((transient?'RETRY_':'BLOCKED_')+'HTTP_'+reply.status+'_'+safe,!transient);
 }
 async dispatch(transport:ComputeTransport,limit=20){
  need(Number.isInteger(limit)&&limit>=1&&limit<=100,'INVALID_LIMIT',400);
  need(/^https:\/\/[A-Za-z0-9.-]+$/.test(transport.target),'INVALID_COMPUTE_TARGET',400);
  const ctx={...this.internal,role:'dispatcher'} as const;let visited=0,after=Number(this.rows('SELECT after_seq FROM epoch_pipeline_dispatch_cursor WHERE id=1')[0].after_seq),wrapped=false;const results:{intentId:string;code:string}[]=[];
  while(visited<limit){const page=this.chain.readIntents(ctx,{after,limit:100}).items;if(!page.length){if(after>0&&visited===0&&!wrapped){after=0;wrapped=true;continue;}break;}
   for(const candidate of page){if(visited>=limit)break;after=candidate.seq;if(!['pending','leased'].includes(candidate.status))continue;
    const delivery=this.rows('SELECT * FROM epoch_pipeline_delivery WHERE intent_id=?',candidate.intentId)[0];
    if(delivery&&(delivery.blocked||Number(delivery.retry_at)>(this.options.chain.now?.()??Date.now())))continue;
    visited++;let intent:Intent|null;
    try{intent=this.chain.claimIntent(ctx,{intentId:candidate.intentId,expectedDeliveryRevision:candidate.deliveryRevision,leaseMs:30000});}catch(error){
     if(!(error instanceof ChainRejected))throw error;
     if(['DELIVERY_LEASED','STALE_DELIVERY'].includes(error.code))continue;
     if(error.code==='RETRY_CAPACITY'){const code='BLOCKED_RETRY_CAPACITY';this.log(candidate,code,true);results.push({intentId:candidate.intentId,code});continue;}throw error;
    }
    if(!intent)continue;const i=intent;let code='RETRY_UNKNOWN',blocked=false;
    try{
     const plan=this.plan(i);const status=await this.call(transport,'/v1/status',{},true);this.accepted(status);
     need(status.body.environment===this.options.chain.environment&&typeof status.body.authorityId==='string'&&Number.isSafeInteger(status.body.schemaVersion)&&Number.isSafeInteger(status.body.epoch)&&status.body.epoch>=1,'COMPUTE_STATUS');
     const epoch=status.body.epoch,recovery=Number(delivery?.recovery_generation??0);
     if(i.kind==='SUBMIT'){
      const reply=await this.call(transport,'/v1/commands',{expectedEpoch:epoch,command:{operation:'submit',key:hash(JSON.stringify([i.intentId,epoch,recovery])),body:plan.submitBody}},false);this.accepted(reply);
      need(reply.body.workload?.id===i.workloadId&&reply.body.workload?.principal===transport.submitterPrincipal,'COMPUTE_RESPONSE_BINDING');
      this.chain.markSubmissionResponse(ctx,{intentId:i.intentId,expectedEligibilityGeneration:i.generation,deliveryRevision:i.deliveryRevision,workloadId:i.workloadId});code='SUBMITTED';
     }else{
      const lookup=await this.call(transport,'/v1/workload',{expectedEpoch:epoch,workloadId:i.workloadId},true);this.accepted(lookup);need(lookup.body.epoch===epoch,'COMPUTE_EPOCH');
      const workload=lookup.body.workload;
      if(!workload)code='RETRY_NOT_FOUND';
      else {
       need(workload.id===i.workloadId&&workload.principal===transport.submitterPrincipal,'COMPUTE_OWNER');
       need(workload.specification===plan.submitBody.specification&&workload.expected_hash===plan.expectedOutputHash,'COMPUTE_PLAN_BINDING');
       if(['SUCCEEDED','FAILED','CANCELLED'].includes(workload.status)){this.chain.acknowledgeDelivery(ctx,{intentId:i.intentId,expectedDeliveryRevision:i.deliveryRevision});code='SUPERSEDED_'+workload.status;}
       else {
        const generation=workload.generation;
        const reply=await this.call(transport,'/v1/commands',{expectedEpoch:epoch,command:{operation:'cancel',key:hash(JSON.stringify([i.intentId,epoch,generation,recovery])),body:{workloadId:i.workloadId,expectedGeneration:generation}}},true);this.accepted(reply);
        this.chain.acknowledgeDelivery(ctx,{intentId:i.intentId,expectedDeliveryRevision:i.deliveryRevision});code='CANCELLED_LOGICAL';
       }
      }
     }
    }catch(error){
     if(error instanceof DeliveryFailure){code=error.code;blocked=error.permanent;}
     else if(error instanceof PipelineRejected){blocked=!['COMPUTE_TIMEOUT','COMPUTE_RESPONSE_LIMIT','COMPUTE_RESPONSE_CAPACITY','COMPUTE_RESPONSE'].includes(error.code);code=(blocked?'BLOCKED_':'RETRY_')+error.code;}
     else if(error instanceof ChainRejected){if(!['STALE_DELIVERY','DELIVERY_FENCE','STALE_REVISION'].includes(error.code))throw error;code='RETRY_CHAIN_CAS';}
     else {throw error;}
    }
    this.port.transactionSync(()=>{
     if(code.startsWith('RETRY')||blocked){
      // Only an expected concurrent delivery fence may already have released it.
      try{this.chain.retryIntent(ctx,{intentId:i.intentId,expectedDeliveryRevision:i.deliveryRevision});}catch(error){if(!(error instanceof ChainRejected)||error.code!=='DELIVERY_FENCE')throw error;}
     }
     this.log(i,code,blocked,code.startsWith('RETRY')?(this.options.chain.now?.()??Date.now())+Math.min(60000,1000*2**Math.min(i.attempts-1,6)):0);
    });results.push({intentId:i.intentId,code});
   }
  }this.port.transactionSync(()=>this.rows('UPDATE epoch_pipeline_dispatch_cursor SET after_seq=? WHERE id=1',after));return {results};
 }
 private async call(t:ComputeTransport,path:string,input:unknown,owner:boolean){
  let timer:ReturnType<typeof setTimeout>|undefined;let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  const deadline=Date.now()+10000;
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new PipelineRejected('COMPUTE_TIMEOUT')),10000);});
  try{
   const response=await Promise.race([t.fetcher.fetch(new Request(t.target+path,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+(owner?t.ownerBearer:t.submitterBearer)},body:JSON.stringify(input)})),timeout]);
   reader=response.body?.getReader();need(reader,'COMPUTE_RESPONSE');let count=0;const parts:Uint8Array[]=[];
   for(let reads=0;;reads++){
    need(reads<65536&&Date.now()<deadline,'COMPUTE_RESPONSE_LIMIT');
    const r=await Promise.race([reader.read(),timeout]);if(r.done)break;
    count+=r.value.length;need(count<=1048576,'COMPUTE_RESPONSE_CAPACITY');parts.push(r.value);
   }
   const bytes=new Uint8Array(count);let pos=0;for(const p of parts){bytes.set(p,pos);pos+=p.length;}
   let body:any;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes));}catch{body={ok:false,code:'malformed-response'};}return {ok:response.ok,status:response.status,body};
  }catch(error){
   // Only this boundary converts unexpected fetch/stream failures into retry outcomes.
   // Local plan reads and chain persistence never pass through this catch.
   if(error instanceof PipelineRejected||error instanceof DeliveryFailure)throw error;
   throw new DeliveryFailure('RETRY_UNKNOWN',false);
  }finally{clearTimeout(timer);if(reader){void reader.cancel().catch(()=>{});reader.releaseLock();}}
 }
}
