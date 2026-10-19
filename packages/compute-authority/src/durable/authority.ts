import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { SCHEMA, SCHEMA_VERSION } from './schema';
import type { CommandEnvelope, CommandResult, DurableAuthorityOptions, SqlValue, TransactionPort, TrustedContext, VerificationRequest } from './contracts';
export * from './contracts';
type Row = Record<string, any>;
const ID = /^[A-Za-z0-9._-]{1,64}$/;
const SHA = /^[a-f0-9]{64}$/;
const hash = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
function canonical(v: unknown, depth=0): string {
  if(depth>12) throw new Error('invalid schema depth');
  if(v===null || typeof v==='boolean' || typeof v==='string') return JSON.stringify(v);
  if(typeof v==='number' && Number.isSafeInteger(v)) return String(v);
  if(Array.isArray(v)) { if(v.length>256)throw new Error('invalid array'); return `[${v.map(x=>canonical(x,depth+1)).join(',')}]`; }
  if(v && typeof v==='object' && Object.getPrototypeOf(v)===Object.prototype) return `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical((v as Row)[k],depth+1)}`).join(',')}}`;
  throw new Error('invalid schema');
}
const copy = <T>(x:T):T => structuredClone(x);
function id(v: unknown): asserts v is string { if(typeof v!=='string'||!ID.test(v))throw new Error('invalid identifier'); }
function int(v: unknown,min=0,max=Number.MAX_SAFE_INTEGER): asserts v is number { if(typeof v!=='number'||!Number.isSafeInteger(v)||v<min||v>max)throw new Error('invalid integer'); }
function keys(v: Row, names: string[]) { if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!names.includes(k))||names.some(k=>!Object.hasOwn(v,k)))throw new Error('invalid fields'); }
class Rejected extends Error { constructor(readonly code:string){super(code);} }
function requireDomain(condition:unknown, code:string): asserts condition { if(!condition)throw new Rejected(code); }
/** One instance per host-bound SQL authority. No authoritative state is cached. */
export class DurableAuthority {
  private readonly now:()=>number;
  private readonly lifetime:number;
  private readonly deadline:number;
  constructor(private readonly storage:TransactionPort, private readonly options:DurableAuthorityOptions) {
    id(options.environment);id(options.authorityId);id(options.issuerId);
    if(typeof options.issuerKey!=='string'||options.issuerKey.length<32||options.issuerKey.length>1024)throw new Error('invalid issuer key');
    this.now=options.now??Date.now; this.lifetime=options.maxLeaseLifetimeMs??3600000; this.deadline=options.verificationDeadlineMs??60000;
    int(this.lifetime,1,604800000);int(this.deadline,1,300000);
    storage.transactionSync(()=>{
      for(const sql of SCHEMA)this.q(sql);
      const check=this.mac('issuer-check');
      this.q('INSERT OR IGNORE INTO authority_meta(singleton,environment,authority_id,epoch,schema_version,clock_ms,issuer_id,issuer_check) VALUES(1,?,?,1,?,0,?,?)',options.environment,options.authorityId,SCHEMA_VERSION,options.issuerId,check);
      const m=this.meta();
      if(m.environment!==options.environment||m.authority_id!==options.authorityId||m.schema_version!==SCHEMA_VERSION||m.issuer_id!==options.issuerId||m.issuer_check!==check)throw new Error('authority binding mismatch');
    });
  }
  private q(sql:string,...args:SqlValue[]):Row[]{return [...this.storage.sql.exec(sql,...args)].map(row=>({...row}));}
  private one(sql:string,...args:SqlValue[]):Row|undefined{return this.q(sql,...args)[0];}
  private meta():Row{return this.one('SELECT * FROM authority_meta WHERE singleton=1')!;}
  private mac(s:string):string{return createHmac('sha256',this.options.issuerKey).update(s).digest('hex');}
  private tick():number{const t=this.now();int(t,0,Number.MAX_SAFE_INTEGER-604800000);const n=Math.max(t,this.meta().clock_ms);this.q('UPDATE authority_meta SET clock_ms=? WHERE singleton=1',n);return n;}
  private token(l:Row):string{return this.mac(canonical({environment:this.options.environment,authority:this.options.authorityId,issuer:l.issuer_id,id:l.id,epoch:l.epoch,generation:l.generation,incarnation:l.incarnation,worker:l.worker_id,issued:l.issued_ms,cap:l.cap_ms}));}
  private context(c:TrustedContext){id(c.principal);int(c.expectedEpoch,1);if(!['owner','executor','verifier','projector','submitter'].includes(c.role))throw new Error('invalid role');}
  private event(kind:string,entity:string,c:TrustedContext,t:number,reason=kind){
    const m=this.meta();
    // Historical projection facts are copied now; no bearer or request is included.
    const lease=this.one('SELECT id,workload_id,worker_id,epoch,generation,incarnation,expires_ms,state,verify_deadline FROM leases WHERE id=?',entity)??null;
    const workload=this.one('SELECT * FROM workloads WHERE id=?',lease?.workload_id??entity)??null;
    const worker=this.one('SELECT * FROM workers WHERE id=?',entity)??null;
    const payload=canonical({version:1,actor:{principal:c.principal,role:c.role},workload,worker,lease,
      quota:this.one('SELECT * FROM quotas WHERE principal=?',entity)??null,
      devices:worker?this.q('SELECT * FROM devices WHERE worker_id=? ORDER BY id',entity):[],
      reservation:lease?this.one('SELECT * FROM reservations WHERE lease_id=?',entity)??null:null,
      deviceReservations:lease?this.q('SELECT * FROM device_reservations WHERE lease_id=? ORDER BY device_id',entity):[],
      placement:lease?this.one('SELECT * FROM placements WHERE id=?',entity)??null:null,
      artifact:lease?this.one('SELECT * FROM artifacts WHERE lease_id=?',entity)??null:null,
      receipt:this.one('SELECT * FROM receipts WHERE workload_id=?',workload?.id??entity)??null});
    if(payload.length>262144)throw new Error('projection payload limit');
    this.q('INSERT INTO events(epoch,at_ms,kind,entity,actor,entity_version,reason,payload) VALUES(?,?,?,?,?,?,?,?)',m.epoch,t,kind,entity,c.principal,this.one('SELECT COALESCE(max(seq),0)+1 version FROM events')!.version,reason,payload);
    this.q('INSERT INTO outbox(seq) VALUES((SELECT max(seq) FROM events))');
  }
  private advance(w:Row,c:TrustedContext,t:number){
    if(!['RUNNING','VERIFYING','QUEUED'].includes(w.status))return;
    const retry=w.pure===1&&w.reconstructible===1&&w.attempts_used<w.max_attempts;
    this.q('UPDATE workloads SET status=?,generation=generation+? WHERE id=?',retry?'QUEUED':'FAILED',retry?1:0,w.id);
    this.event(retry?'workload-requeued':'workload-failed',w.id,c,t);
  }
  private fenceWorker(workerId:string,c:TrustedContext,t:number){
    const active=this.q("SELECT * FROM leases WHERE worker_id=? AND state IN ('RUNNING','VERIFYING')",workerId);
    this.q('UPDATE workers SET quarantined=1,incarnation=incarnation+1 WHERE id=?',workerId);
    this.q("UPDATE reservations SET state='quarantined' WHERE worker_id=? AND state!='released'",workerId);
    this.q("UPDATE device_reservations SET state='quarantined' WHERE worker_id=? AND state!='released'",workerId);
    for(const l of active){
      this.q("UPDATE leases SET state='REVOKED' WHERE id=?",l.id);this.q("UPDATE attempts SET state='REVOKED' WHERE id=?",l.id);
      this.advance(this.one('SELECT * FROM workloads WHERE id=?',l.workload_id)!,c,t);
      this.event('lease-revoked',l.id,c,t);
    }
    this.event('worker-quarantined',workerId,c,t);
  }
  private sweep(c:TrustedContext,t:number){
    const workers=this.q("SELECT DISTINCT worker_id FROM leases WHERE (state='RUNNING' AND expires_ms<=?) OR (state='VERIFYING' AND verify_deadline<=?)",t,t);
    for(const w of workers)this.fenceWorker(w.worker_id,c,t);
  }
  private validate(e:CommandEnvelope){
    id(e.key);if(canonical(e).length>65536)throw new Error('request too large');keys(e as Row,['key','operation','body']);
    const b=e.body as Row;
    const shapes:Record<string,string[]>={quarantineWorker:['workerId','expectedIncarnation'],registerWorker:['workerId','principal','workerClass','cpu','ramMib','devices'],setQuota:['principal','maxActive','allowedClass'],submit:['workloadId','specification','resources','policy','pure','reconstructible','maxAttempts'],claim:['workloadId','workerId','expectedGeneration','incarnation','ttlMs'],renew:['leaseId','epoch','generation','incarnation','capability','sequence','ttlMs'],stageResult:['leaseId','epoch','generation','incarnation','capability','artifactRef','sha256','bytes','exitCode'],requeue:['workloadId','expectedGeneration','requestId'],cancel:['workloadId','expectedGeneration'],reconcileStop:['workerId','incarnation','stopReceipt'],bumpEpoch:['expectedEpoch'],sweep:[],readOutbox:['after','limit'],ackOutbox:['through']};
    if(!shapes[e.operation])throw new Error('unknown operation');keys(b,shapes[e.operation]);
    for(const k of ['workerId','workloadId','principal','leaseId','requestId','artifactRef','stopReceipt'])if(k in b)id(b[k]);
    for(const k of ['expectedGeneration','expectedIncarnation','generation','incarnation','after','through'])if(k in b)int(b[k]);
    for(const k of ['epoch','expectedEpoch','sequence'])if(k in b)int(b[k],1);
    if('capability'in b && (typeof b.capability!=='string'||!SHA.test(b.capability)))throw new Error('invalid capability');
    if('ttlMs'in b)int(b.ttlMs,1,this.lifetime);
    switch(e.operation){
      case 'registerWorker':{
        if(!['general','edge'].includes(b.workerClass))throw new Error('invalid class');int(b.cpu,b.workerClass==='edge'?0:1,65536);int(b.ramMib,b.workerClass==='edge'?0:1,2**30);
        if(!Array.isArray(b.devices)||b.devices.length>64)throw new Error('invalid devices');
        const seen=new Set();for(const d of b.devices){keys(d,['id','kind','vramMib']);id(d.id);if(seen.has(d.id)||!['cuda','metal'].includes(d.kind))throw new Error('invalid device');seen.add(d.id);int(d.vramMib,1,2**30);}
        if(b.workerClass==='edge'&&(b.cpu!==0||b.ramMib!==0||b.devices.length))throw new Error('edge cannot execute');break;
      }
      case 'setQuota':int(b.maxActive,1,10000);if(b.allowedClass!=='general')throw new Error('invalid class');break;
      case 'submit':{
        if(typeof b.specification!=='string'||b.specification.length<1||b.specification.length>16384||typeof b.pure!=='boolean'||typeof b.reconstructible!=='boolean')throw new Error('invalid workload');int(b.maxAttempts,1,1000);
        keys(b.policy,['sha256','maxBytes','exitCode']);if(!SHA.test(b.policy.sha256)||typeof b.policy.sha256!=='string')throw new Error('content hash required');int(b.policy.maxBytes,1,4194304);int(b.policy.exitCode,0,255);
        const r=b.resources;keys(r,r?.gpu===undefined?['cpu','ramMib']:['cpu','ramMib','gpu']);int(r.cpu,1,65536);int(r.ramMib,1,2**30);
        if(r.gpu!==undefined){keys(r.gpu,['kind','minVramMib']);if(!['cuda','metal'].includes(r.gpu.kind))throw new Error('invalid GPU');int(r.gpu.minVramMib,1,2**30);}break;
      }
      case 'stageResult':if(typeof b.sha256!=='string'||!SHA.test(b.sha256))throw new Error('invalid hash');int(b.bytes,0,4194304);int(b.exitCode,0,255);break;
      case 'readOutbox':int(b.limit,1,100);break;
    }
  }
  private allowed(c:TrustedContext,op:string){
    const roles:Record<string,string[]>={quarantineWorker:['owner'],registerWorker:['owner'],setQuota:['owner'],submit:['owner','submitter'],claim:['executor'],renew:['executor'],stageResult:['executor'],requeue:['owner'],cancel:['owner'],reconcileStop:['owner'],bumpEpoch:['owner'],sweep:['owner'],readOutbox:['projector','owner'],ackOutbox:['projector','owner'],verify:['verifier']};
    return roles[op]?.includes(c.role)??false;
  }
  private command(c:TrustedContext,op:string,key:string,request:unknown,fn:(t:number)=>CommandResult,retainRejection=true):CommandResult{
    return this.storage.transactionSync(()=>{
      const meta=this.meta();
      if(c.expectedEpoch!==meta.epoch)return {ok:false,code:'stale-epoch'};
      if(!this.allowed(c,op))return {ok:false,code:'forbidden'};
      const t=this.tick();if(op!=='quarantineWorker')this.sweep(c,t);
      const digest=hash(canonical({role:c.role,expectedEpoch:c.expectedEpoch,request}));
      const prior=this.one('SELECT * FROM commands WHERE environment=? AND principal=? AND operation=? AND request_key=?',meta.environment,c.principal,op,key);
      if(prior)return prior.request_hash===digest?this.present(JSON.parse(prior.response)):{ok:false,code:'idempotency-conflict'};
      let result:CommandResult;
      try{result=fn(t);}catch(e){if(!(e instanceof Rejected))throw e;result={ok:false,code:e.code};}
      if(op==='quarantineWorker')this.sweep(c,t);
      if(result.ok||retainRejection)this.q('INSERT INTO commands(environment,principal,operation,request_key,request_hash,response) VALUES(?,?,?,?,?,?)',meta.environment,c.principal,op,key,digest,canonical(result));
      return this.present(result);
    });
  }
  private present(result:CommandResult):CommandResult{
    const out=copy(result);
    if(out.ok && out.lease){const l=out.lease as Row; l.leaseId=l.id;l.capability=this.token(l);}
    return out;
  }
  execute(c:TrustedContext,e:CommandEnvelope):CommandResult{
    this.context(c);this.validate(e);
    return this.command(c,e.operation,e.key,e.body,t=>this.apply(c,e,t));
  }
  /** Host-only bounded poll probing; failed candidates do not grow replay history. */
  claimCandidate(c:TrustedContext,e:Extract<CommandEnvelope,{operation:'claim'}>):CommandResult {
    this.context(c);this.validate(e);
    if(e.operation!=='claim')throw new Error('invalid candidate operation');
    return this.command(c,'claim',e.key,e.body,t=>this.apply(c,e,t),false);
  }
  private lease(c:TrustedContext,b:Row,state='RUNNING'):Row{
    const l=this.one('SELECT * FROM leases WHERE id=?',b.leaseId);
    requireDomain(l,'unknown-lease');
    const worker=this.one('SELECT * FROM workers WHERE id=?',l.worker_id)!;
    const w=this.one('SELECT * FROM workloads WHERE id=?',l.workload_id)!;
    const supplied=hash(b.capability),expected=l.capability_hash;
    requireDomain(supplied.length===expected.length&&timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)),'bad-capability');
    requireDomain(worker.principal===c.principal,'forbidden');
    requireDomain(l.state===state&&w.status===state&&worker.quarantined===0&&worker.incarnation===l.incarnation&&w.generation===l.generation&&l.epoch===this.meta().epoch&&b.epoch===l.epoch&&b.generation===l.generation&&b.incarnation===l.incarnation,'stale-fence');return l;
  }
  private apply(c:TrustedContext,e:CommandEnvelope,t:number):CommandResult{
    const b=e.body as Row;
    switch(e.operation){
      case 'quarantineWorker':{
        const worker=this.one('SELECT * FROM workers WHERE id=?',b.workerId);
        requireDomain(worker&&worker.incarnation===b.expectedIncarnation,'stale-incarnation');
        if(!worker.quarantined)this.fenceWorker(b.workerId,c,t);
        return {ok:true,worker:this.one('SELECT * FROM workers WHERE id=?',b.workerId)};
      }
      case 'setQuota':{
        this.q('INSERT INTO quotas(principal,max_active,allowed_class) VALUES(?,?,?) ON CONFLICT(principal) DO UPDATE SET max_active=excluded.max_active,allowed_class=excluded.allowed_class',b.principal,b.maxActive,b.allowedClass);this.event('quota-set',b.principal,c,t);return {ok:true};
      }
      case 'registerWorker':{
        const prior=this.one('SELECT * FROM workers WHERE id=?',b.workerId);
        requireDomain(!prior||prior.class===b.workerClass&&prior.principal===b.principal,'worker-identity-conflict');
        const used=this.one("SELECT COALESCE(sum(cpu),0) cpu,COALESCE(sum(ram_mib),0) ram FROM reservations WHERE worker_id=? AND state!='released'",b.workerId)!;
        requireDomain(used.cpu<=b.cpu&&used.ram<=b.ramMib,'capacity-below-reservations');
        const devices=this.q('SELECT * FROM devices WHERE worker_id=? ORDER BY id',b.workerId);
        const busy=this.q("SELECT device_id FROM device_reservations WHERE worker_id=? AND state!='released'",b.workerId);
        requireDomain(busy.every(d=>{const old=devices.find(x=>x.id===d.device_id),n=b.devices.find((x:Row)=>x.id===d.device_id);return n&&old&&n.kind===old.kind&&n.vramMib===old.vram_mib;}),'device-in-use');
        requireDomain(!prior||canonical(devices.map(d=>({id:d.id,kind:d.kind,vramMib:d.vram_mib})))===canonical([...b.devices].sort((a:Row,z:Row)=>a.id.localeCompare(z.id))),'device-registry-immutable');
        if(prior)this.q('UPDATE workers SET cpu=?,ram_mib=? WHERE id=?',b.cpu,b.ramMib,b.workerId);
        else this.q('INSERT INTO workers(id,principal,class,cpu,ram_mib) VALUES(?,?,?,?,?)',b.workerId,b.principal,b.workerClass,b.cpu,b.ramMib);
        // Retain historical devices referenced by released reservations; capacity matching uses current registry.
        if(!prior)for(const d of b.devices)this.q('INSERT INTO devices(worker_id,id,kind,vram_mib) VALUES(?,?,?,?)',b.workerId,d.id,d.kind,d.vramMib);
        this.event('worker-registered',b.workerId,c,t);return {ok:true,worker:this.one('SELECT * FROM workers WHERE id=?',b.workerId)};
      }
      case 'submit':{
        const specHash=hash(canonical(b)),prior=this.one('SELECT * FROM workloads WHERE id=?',b.workloadId);
        if(prior){requireDomain(prior.principal===c.principal&&prior.spec_hash===specHash,'workload-identity-conflict');return {ok:true,workload:prior};}
        const quota=this.one('SELECT * FROM quotas WHERE principal=?',c.principal);requireDomain(quota,'quota-required');
        const count=this.one("SELECT count(*) n FROM workloads WHERE principal=? AND status IN ('QUEUED','RUNNING','VERIFYING')",c.principal)!.n;requireDomain(count<quota.max_active,'quota-exceeded');
        this.q("INSERT INTO workloads(id,principal,specification,spec_hash,policy_hash,expected_hash,max_bytes,exit_code,cpu,ram_mib,gpu_kind,gpu_vram,pure,reconstructible,max_attempts,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'QUEUED')",b.workloadId,c.principal,b.specification,specHash,hash(canonical(b.policy)),b.policy.sha256,b.policy.maxBytes,b.policy.exitCode,b.resources.cpu,b.resources.ramMib,b.resources.gpu?.kind??null,b.resources.gpu?.minVramMib??null,b.pure?1:0,b.reconstructible?1:0,b.maxAttempts);
        this.event('workload-submitted',b.workloadId,c,t);return {ok:true,workload:this.one('SELECT * FROM workloads WHERE id=?',b.workloadId)};
      }
      case 'claim':return this.claim(c,b,t);
      case 'renew':{
        const l=this.lease(c,b);const digest=hash(canonical(b));
        const previous=this.one('SELECT * FROM renewals WHERE lease_id=? AND sequence=?',l.id,b.sequence);
        if(previous){requireDomain(previous.request_hash===digest,'sequence-conflict');return {ok:true,expiresAt:previous.expires_ms};}
        requireDomain(b.sequence===l.sequence+1,'sequence-conflict');
        const expiry=Math.min(Math.max(l.expires_ms,t+b.ttlMs),l.cap_ms);requireDomain(expiry>t,'lifetime-exhausted');
        this.q('INSERT INTO renewals(lease_id,sequence,request_hash,expires_ms) VALUES(?,?,?,?)',l.id,b.sequence,digest,expiry);
        this.q('UPDATE leases SET sequence=?,expires_ms=? WHERE id=?',b.sequence,expiry,l.id);this.event('lease-renewed',l.id,c,t);return {ok:true,expiresAt:expiry};
      }
      case 'stageResult':{
        const l=this.lease(c,b),w=this.one('SELECT * FROM workloads WHERE id=?',l.workload_id)!;
        requireDomain(b.sha256===w.expected_hash&&b.bytes<=w.max_bytes&&b.exitCode===w.exit_code,'policy-mismatch');
        this.q('INSERT INTO artifacts(lease_id,reference,sha256,bytes,exit_code,staged_ms) VALUES(?,?,?,?,?,?)',l.id,b.artifactRef,b.sha256,b.bytes,b.exitCode,t);
        this.q("UPDATE leases SET state='VERIFYING',verify_deadline=? WHERE id=?",t+this.deadline,l.id);this.q("UPDATE attempts SET state='VERIFYING' WHERE id=?",l.id);this.q("UPDATE workloads SET status='VERIFYING' WHERE id=?",w.id);this.event('result-staged',l.id,c,t);this.event('workload-verifying',w.id,c,t);return {ok:true,leaseId:l.id,verificationDeadline:t+this.deadline};
      }
      case 'cancel':{
        const w=this.one('SELECT * FROM workloads WHERE id=?',b.workloadId);requireDomain(w&&w.generation===b.expectedGeneration&&['QUEUED','RUNNING','VERIFYING'].includes(w.status),'stale-generation');
        this.q("UPDATE workloads SET status='CANCELLED' WHERE id=?",w.id);
        for(const l of this.q("SELECT worker_id FROM leases WHERE workload_id=? AND state IN ('RUNNING','VERIFYING')",w.id))this.fenceWorker(l.worker_id,c,t);
        this.event('workload-cancelled',w.id,c,t);return {ok:true};
      }
      case 'requeue':{
        const old=this.one('SELECT * FROM requeues WHERE workload_id=? AND request_id=?',b.workloadId,b.requestId);
        if(old){requireDomain(old.expected_generation===b.expectedGeneration,'request-conflict');return JSON.parse(old.response);}
        const w=this.one('SELECT * FROM workloads WHERE id=?',b.workloadId);requireDomain(w&&w.generation===b.expectedGeneration&&['QUEUED','RUNNING','VERIFYING'].includes(w.status),'stale-generation');requireDomain(w.pure&&w.reconstructible&&w.attempts_used<w.max_attempts,'unsafe-retry');
        const leases=this.q("SELECT worker_id FROM leases WHERE workload_id=? AND state IN ('RUNNING','VERIFYING')",w.id);
        if(leases.length)for(const l of leases)this.fenceWorker(l.worker_id,c,t);else this.advance(w,c,t);
        const result={ok:true,generation:this.one('SELECT generation FROM workloads WHERE id=?',w.id)!.generation};this.q('INSERT INTO requeues(workload_id,request_id,expected_generation,response) VALUES(?,?,?,?)',w.id,b.requestId,b.expectedGeneration,canonical(result));return result;
      }
      case 'reconcileStop':{
        const w=this.one('SELECT * FROM workers WHERE id=?',b.workerId);requireDomain(w&&w.incarnation===b.incarnation&&w.quarantined===1,'stale-incarnation');
        this.q('INSERT INTO stop_receipts(worker_id,incarnation,receipt,stopped_ms) VALUES(?,?,?,?)',w.id,w.incarnation,b.stopReceipt,t);
        const released=this.q("SELECT lease_id FROM reservations WHERE worker_id=? AND state!='released' ORDER BY lease_id",w.id);
        this.q("UPDATE reservations SET state='released' WHERE worker_id=?",w.id);this.q("UPDATE device_reservations SET state='released' WHERE worker_id=?",w.id);this.q('UPDATE workers SET quarantined=0 WHERE id=?',w.id);for(const r of released)this.event('reservation-released',r.lease_id,c,t);this.event('worker-reconciled',w.id,c,t);return {ok:true,incarnation:w.incarnation};
      }
      case 'bumpEpoch':{
        requireDomain(b.expectedEpoch===this.meta().epoch,'stale-epoch');
        for(const w of this.q("SELECT DISTINCT worker_id FROM reservations WHERE state!='released'"))this.fenceWorker(w.worker_id,c,t);
        this.q('UPDATE authority_meta SET epoch=epoch+1 WHERE singleton=1');this.event('epoch-bumped',this.options.authorityId,c,t);return {ok:true,epoch:this.meta().epoch};
      }
      case 'sweep':return {ok:true};
      case 'readOutbox':{
        const m=this.meta();requireDomain(b.after===m.ack_seq,'cursor-not-acknowledged-prefix');
        const pending=this.q('SELECT e.* FROM events e JOIN outbox o ON o.seq=e.seq WHERE o.acknowledged=0 AND e.seq>? ORDER BY e.seq LIMIT ?',b.after,b.limit);
        const events:Row[]=[];let budget=0;
        for(const row of pending){const size=canonical({...row,payload:JSON.parse(row.payload)}).length;if(budget+size>750000)break;events.push(row);budget+=size;}
        const through=events.at(-1)?.seq??b.after;this.q('UPDATE authority_meta SET delivered_seq=max(delivered_seq,?) WHERE singleton=1',through);return {ok:true,events:events.map(x=>({...x,payload:JSON.parse(x.payload)})),through};
      }
      case 'ackOutbox':{
        const m=this.meta();requireDomain(b.through>=m.ack_seq&&b.through<=m.delivered_seq,'ack-not-delivered');
        const n=this.one('SELECT count(*) n FROM outbox WHERE seq>? AND seq<=?',m.ack_seq,b.through)!.n;requireDomain(n===b.through-m.ack_seq,'ack-gap');this.q('UPDATE outbox SET acknowledged=1 WHERE seq<=?',b.through);this.q('UPDATE authority_meta SET ack_seq=? WHERE singleton=1',b.through);return {ok:true,through:b.through};
      }
    }
  }
  private claim(c:TrustedContext,b:Row,t:number):CommandResult{
    const w=this.one('SELECT * FROM workloads WHERE id=?',b.workloadId),worker=this.one('SELECT * FROM workers WHERE id=?',b.workerId);
    requireDomain(w&&worker,'unknown-entity');requireDomain(worker.principal===c.principal,'forbidden');
    requireDomain(w.status==='QUEUED'&&w.generation===b.expectedGeneration&&w.attempts_used<w.max_attempts,'stale-generation');
    requireDomain(worker.class==='general'&&worker.quarantined===0&&worker.incarnation===b.incarnation,'worker-unavailable');
    const quota=this.one('SELECT * FROM quotas WHERE principal=?',w.principal);requireDomain(quota?.allowed_class===worker.class,'class-policy');
    const candidates=this.q('SELECT * FROM workers ORDER BY id LIMIT 129');requireDomain(candidates.length<=128,'candidate-limit');
    const facts=candidates.map(candidate=>{
      const used=this.one("SELECT COALESCE(sum(cpu),0) cpu,COALESCE(sum(ram_mib),0) ram FROM reservations WHERE worker_id=? AND state!='released'",candidate.id)!;
      const devices=this.q("SELECT d.*,CASE WHEN EXISTS(SELECT 1 FROM device_reservations r WHERE r.worker_id=d.worker_id AND r.device_id=d.id AND r.state!='released') THEN 1 ELSE 0 END busy FROM devices d WHERE worker_id=? ORDER BY id",candidate.id);
      const reasons:string[]=[];if(candidate.class!=='general')reasons.push('edge');if(candidate.quarantined)reasons.push('quarantined');if(candidate.cpu-used.cpu<w.cpu)reasons.push('cpu');if(candidate.ram_mib-used.ram<w.ram_mib)reasons.push('ram');if(w.gpu_kind&&!devices.some(d=>!d.busy&&d.kind===w.gpu_kind&&d.vram_mib>=w.gpu_vram))reasons.push('gpu');
      return {worker:candidate,used,devices,reasons};
    });
    const chosen=facts.find(x=>x.worker.id===worker.id)!;requireDomain(chosen.reasons.length===0,'insufficient-capacity');
    const device=w.gpu_kind?chosen.devices.find(d=>!d.busy&&d.kind===w.gpu_kind&&d.vram_mib>=w.gpu_vram):undefined;
    const epoch=this.meta().epoch;
    const leaseId=`l-${hash(canonical({env:this.options.environment,principal:c.principal,workload:w.id,generation:w.generation,epoch})).slice(0,48)}`;
    const placementSnapshot=canonical({policyVersion:'vector-exclusive-v1',resources:{cpu:w.cpu,ramMib:w.ram_mib,gpuKind:w.gpu_kind,gpuVram:w.gpu_vram},candidates:facts,selected:worker.id,reason:'requested-feasible-worker'});requireDomain(placementSnapshot.length<=65536,'placement-snapshot-limit');
    const l:Row={id:leaseId,workload_id:w.id,worker_id:worker.id,epoch,generation:w.generation,incarnation:worker.incarnation,issuer_id:this.options.issuerId,issued_ms:t,expires_ms:t+b.ttlMs,cap_ms:t+this.lifetime,sequence:0,state:'RUNNING',verify_deadline:null};
    l.capability_hash=hash(this.token(l));
    this.q('INSERT INTO placements(id,workload_id,worker_id,generation,epoch,created_ms,policy_version,snapshot) VALUES(?,?,?,?,?,?,?,?)',leaseId,w.id,worker.id,w.generation,epoch,t,'vector-exclusive-v1',placementSnapshot);
    this.q("INSERT INTO attempts(id,workload_id,placement_id,generation,state) VALUES(?,?,?,?,'RUNNING')",leaseId,w.id,leaseId,w.generation);
    this.q("INSERT INTO leases(id,workload_id,worker_id,epoch,generation,incarnation,issuer_id,capability_hash,issued_ms,expires_ms,cap_ms,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,'RUNNING')",leaseId,w.id,worker.id,epoch,w.generation,worker.incarnation,l.issuer_id,l.capability_hash,t,l.expires_ms,l.cap_ms);
    this.q("INSERT INTO reservations(lease_id,worker_id,cpu,ram_mib,state) VALUES(?,?,?,?,'held')",leaseId,worker.id,w.cpu,w.ram_mib);
    if(device)this.q("INSERT INTO device_reservations(lease_id,worker_id,device_id,state) VALUES(?,?,?,'held')",leaseId,worker.id,device.id);
    this.q("UPDATE workloads SET status='RUNNING',attempts_used=attempts_used+1 WHERE id=?",w.id);this.event('lease-issued',leaseId,c,t);this.event('workload-running',w.id,c,t);
    // This internal descriptor contains only non-secret fields; present() reconstructs the bearer.
    return {ok:true,lease:l};
  }
  snapshot():Record<string,unknown>{
    return this.storage.transactionSync(()=>{
      const m=this.meta(),c:TrustedContext={principal:'authority-sweep',role:'owner',expectedEpoch:m.epoch};const t=this.tick();this.sweep(c,t);
      const {issuer_check:_,...meta}=this.meta();
      return copy({epoch:meta.epoch,meta,workers:this.q('SELECT * FROM workers ORDER BY id'),workloads:this.q('SELECT * FROM workloads ORDER BY id'),leases:this.q('SELECT id,workload_id,worker_id,epoch,generation,incarnation,issued_ms,expires_ms,cap_ms,sequence,state,verify_deadline FROM leases ORDER BY id'),devices:this.q('SELECT * FROM devices ORDER BY worker_id,id'),attempts:this.q('SELECT * FROM attempts ORDER BY id'),placements:this.q('SELECT * FROM placements ORDER BY id'),artifacts:this.q('SELECT * FROM artifacts ORDER BY lease_id'),deviceReservations:this.q('SELECT * FROM device_reservations ORDER BY lease_id,device_id'),quotas:this.q('SELECT * FROM quotas ORDER BY principal'),reservations:this.q('SELECT * FROM reservations ORDER BY lease_id'),receipts:this.q('SELECT * FROM receipts ORDER BY workload_id')});
    });
  }
  async verifyAndFinalize(c:TrustedContext,r:VerificationRequest):Promise<CommandResult>{
    this.context(c);keys(r as unknown as Row,['key','leaseId','epoch','generation','incarnation']);id(r.key);id(r.leaseId);int(r.epoch,1);int(r.generation);int(r.incarnation);
    if(c.role!=='verifier')return {ok:false,code:'forbidden'};
    // Read immutable staging metadata in SQL, then leave the transaction before byte retrieval.
    const prepared=this.storage.transactionSync(()=>{
      if(c.expectedEpoch!==this.meta().epoch)return null;
      const t=this.tick();this.sweep(c,t);
      return this.one('SELECT a.*,w.max_bytes,w.expected_hash,w.policy_hash,w.exit_code expected_exit,l.epoch,l.generation,l.incarnation,l.state,w.status FROM artifacts a JOIN leases l ON l.id=a.lease_id JOIN workloads w ON w.id=l.workload_id WHERE l.id=?',r.leaseId)??null;
    });
    if(!prepared)return this.command(c,'verify',r.key,r,()=>({ok:false,code:'not-staged'}));
    // Replay a successful verification without requiring the staging store to remain available.
    const old=this.storage.transactionSync(()=>this.one('SELECT response,request_hash FROM commands WHERE environment=? AND principal=? AND operation=? AND request_key=?',this.options.environment,c.principal,'verify',r.key));
    if(old)return this.command(c,'verify',r.key,r,()=>{throw new Error('unreachable');});
    if(prepared.state!=='VERIFYING'||prepared.status!=='VERIFYING')return this.command(c,'verify',r.key,r,()=>({ok:false,code:'stale-fence'}));
    if(prepared.epoch!==r.epoch||prepared.generation!==r.generation||prepared.incarnation!==r.incarnation)return this.command(c,'verify',r.key,r,()=>({ok:false,code:'stale-fence'}));
    if(!this.options.readArtifact)return this.command(c,'verify',r.key,r,()=>({ok:false,code:'artifact-reader-required'}));
    let loaded:Uint8Array;
    try{loaded=await this.options.readArtifact(prepared.reference,prepared.max_bytes,{leaseId:r.leaseId});}catch{return {ok:false,code:'artifact-unavailable'};}
    if(!(loaded instanceof Uint8Array)||loaded.byteLength>prepared.max_bytes)return this.command(c,'verify',r.key,r,()=>({ok:false,code:'artifact-too-large'}));
    const bytes=Uint8Array.from(loaded);
    const actual=hash(bytes);
    return this.command(c,'verify',r.key,r,t=>{
      const l=this.one('SELECT * FROM leases WHERE id=?',r.leaseId)!,w=this.one('SELECT * FROM workloads WHERE id=?',l.workload_id)!,worker=this.one('SELECT * FROM workers WHERE id=?',l.worker_id)!;
      requireDomain(l.state==='VERIFYING'&&w.status==='VERIFYING'&&w.winner===null&&l.epoch===r.epoch&&l.epoch===this.meta().epoch&&w.generation===r.generation&&l.generation===r.generation&&l.incarnation===r.incarnation&&worker.incarnation===r.incarnation&&!worker.quarantined&&t<l.verify_deadline,'verification-fenced');
      requireDomain(actual===prepared.sha256&&actual===w.expected_hash&&bytes.byteLength===prepared.bytes&&prepared.exit_code===w.exit_code&&prepared.policy_hash===w.policy_hash,'verification-mismatch');
      this.q('INSERT INTO receipts(workload_id,lease_id,reference,sha256,bytes,policy_hash,epoch,generation,incarnation,verifier,verified_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)',w.id,l.id,prepared.reference,actual,bytes.byteLength,w.policy_hash,l.epoch,l.generation,l.incarnation,c.principal,t);
      this.q("UPDATE workloads SET status='SUCCEEDED',winner=? WHERE id=?",l.id,w.id);this.q("UPDATE leases SET state='SUCCEEDED' WHERE id=?",l.id);this.q("UPDATE attempts SET state='SUCCEEDED' WHERE id=?",l.id);
      this.fenceWorker(l.worker_id,c,t);this.event('lease-succeeded',l.id,c,t);this.event('workload-succeeded',w.id,c,t);
      return {ok:true,receipt:this.one('SELECT * FROM receipts WHERE workload_id=?',w.id)};
    });
  }
}
