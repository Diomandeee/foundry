import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WorkerEnrollment, type ApprovedIdentity, type EnrollRequest, type ExecutorBinding, type Options, type TransactionPort } from './index';
const owner = {role:'owner' as const,principal:'owner'};
// Digests only; no raw bearer fixtures are generated, persisted, returned or logged.
const sha = (n:number) => createHash('sha256').update(`enrollment-digest-fixture-${n}`).digest('hex');
const approved:ApprovedIdentity={workerId:'device-1',principal:'executor-1',workerClass:'general',cpu:4,ramMib:8192,devices:[{id:'gpu0',kind:'metal',vramMib:4096}]};
const request = (extra:Partial<EnrollRequest>={}):EnrollRequest => ({...approved,key:'enroll-1',tokenSha256:sha(1),expiresAt:1000000,expectedRevision:0,incarnation:0,...extra});
function fixture(options:Partial<Options>={}, file=':memory:') {
  let db = new DatabaseSync(file), time=1000, depth=0, auditFault=false;
  db.exec('PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=OFF');
  const port:TransactionPort={sql:{exec(sql,...args){
    if(auditFault && (sql.startsWith('INSERT INTO enrollment_events') || /^(INSERT INTO|UPDATE) enrollment_liveness/.test(sql))) throw new Error('audit-fault');
    return db.prepare(sql).all(...args as any[]) as Record<string,unknown>[];
  }},transactionSync(fn){
    if(depth) return fn();
    db.exec('BEGIN IMMEDIATE'); depth++;
    try {const result=fn(); db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}finally{depth--;}
  }};
  const config={environment:'test',authorityId:'local',now:()=>time,heartbeatMinIntervalMs:1,...options};
  let store = new WorkerEnrollment(port,config);
  return {get db(){return db;},get store(){return store;},port,config,at(n:number){time=n;},fault(value:boolean){auditFault=value;},
    reopen(){db.close();db=new DatabaseSync(file);db.exec('PRAGMA foreign_keys=ON');store=new WorkerEnrollment(port,config);},
    restart(){store=new WorkerEnrollment(port,config);},close(){db.close();},
    enroll(extra:Partial<EnrollRequest>={}){return store.enroll(owner,request(extra));},
    auth(n=1){return store.authenticateDigest(sha(n));},
    heartbeat(binding:ExecutorBinding,sequence=1,key=`hb-${sequence}`,observedIdentity=approved){return store.heartbeat(binding,{key,sequence,observedIdentity});},
    rows(table:string){return db.prepare(`SELECT * FROM ${table}`).all();}
  };
}
function rejects(fn:()=>unknown, code:string){expect(fn).toThrow(code);}
describe('worker enrollment: actual Node SQLite domain',()=>{
  it('owner enroll, authenticate, heartbeat and bounded owner read; never claims connected',()=>{
    const f=fixture(); const enrolled=f.enroll();expect(enrolled).toMatchObject({applied:true,replayed:false,isCurrent:true,status:{revision:1,incarnation:0,freshness:'never-seen',lastSeen:null}});
    const binding=f.auth()!;expect(binding).toEqual({role:'executor',workerId:approved.workerId,principal:approved.principal,revision:1,incarnation:0});
    rejects(()=>f.store.requireFresh(binding),'heartbeat-stale');
    expect(f.heartbeat(binding)).toMatchObject({freshness:'fresh',lastSeen:1000,sequence:1});
    expect(f.store.requireFresh(binding).freshness).toBe('fresh');
    const status=f.store.status(owner,{afterWorkerId:null,limit:1});expect(status.workers).toHaveLength(1);expect(status.heartbeatFreshnessMs).toBe(60000);
    expect(JSON.stringify(status)).not.toContain(sha(1));expect(JSON.stringify(status)).not.toContain('connected');
    expect(f.store.status(owner,{afterWorkerId:approved.workerId,limit:1}).workers).toEqual([]);f.close();
  });
  it('persists file-backed identities, audit, revocation and replays across an actual database close/reopen',()=>{
    const base=fileURLToPath(new URL('../.test-state/',import.meta.url).href);mkdirSync(base,{recursive:true}); const dir=mkdtempSync(`${base}restart-`);
    const f=fixture({},`${dir}/enrollment.sqlite`);
    try {
      f.enroll();const b=f.auth()!;f.heartbeat(b);f.reopen();expect(f.auth()).toEqual(b);expect(f.heartbeat(b).lastSeen).toBe(1000);expect(f.store.requireFresh(b).lastSeen).toBe(1000);
      const r={key:'revoke',workerId:b.workerId,revision:1};expect(f.store.revoke(owner,r).applied).toBe(true);
      f.reopen();expect(f.auth()).toBeNull();expect(f.store.revoke(owner,r)).toMatchObject({applied:false,replayed:true});
      rejects(()=>f.heartbeat(b,2),'inactive-credential');rejects(()=>f.enroll(),'inactive-credential');
      expect(f.rows('enrollment_events')).toHaveLength(2);
    } finally {f.close();rmSync(dir,{recursive:true});}
  });
  it('expiry, freshness boundary, recovery heartbeat and backward clock after restart fail closed',()=>{
    const f=fixture({heartbeatFreshnessMs:100});f.enroll({expiresAt:2000});const b=f.auth()!;f.heartbeat(b);
    f.at(1099);expect(f.store.requireFresh(b).freshness).toBe('fresh');
    f.at(1100);rejects(()=>f.store.requireFresh(b),'heartbeat-stale');expect(f.auth()).toEqual(b);
    f.heartbeat(b,2);expect(f.store.requireFresh(b).lastSeen).toBe(1100);
    f.at(2000);expect(f.auth()).toBeNull();rejects(()=>f.heartbeat(b,3),'inactive-credential');
    f.at(1001);f.restart();expect(f.auth()).toBeNull();f.close();
  });
  it('cannot resurrect revoked or superseded credentials; old revoke replay never applies to next version',()=>{
    const f=fixture();f.enroll();const b=f.auth()!;const revoke={key:'revoke',workerId:b.workerId,revision:1};
    f.store.revoke(owner,revoke);rejects(()=>f.enroll({key:'other',expectedRevision:1,incarnation:1}),'credential-already-used');
    const v2=f.enroll({key:'enroll-2',expectedRevision:1,incarnation:1,tokenSha256:sha(2)});
    expect(v2.status.revision).toBe(2);expect(f.auth()).toBeNull();expect(f.auth(2)?.revision).toBe(2);
    expect(f.store.revoke(owner,revoke)).toMatchObject({applied:false,replayed:true,isCurrent:false,status:{revision:1}});
    rejects(()=>f.store.revoke(owner,{...revoke,key:'other-revoke'}),'already-revoked');
    rejects(()=>f.enroll(),'identity-fence');rejects(()=>f.heartbeat(b),'identity-fence');
    rejects(()=>f.enroll({workerId:'other',principal:'other',key:'rebind'}),'credential-already-used');f.close();
  });
  it('new version supersedes an unrevoked digest and old-version revocation is explicitly non-current',()=>{
    const f=fixture();f.enroll();f.enroll({key:'v2',expectedRevision:1,incarnation:2,tokenSha256:sha(2)});
    expect(f.auth()).toBeNull();expect(f.store.revoke(owner,{key:'old',workerId:approved.workerId,revision:1})).toMatchObject({applied:true,isCurrent:false});
    expect(f.auth(2)?.incarnation).toBe(2);f.close();
  });
  it('canonicalizes device order; rejects immutable geometry/class/principal changes and cross-principal heartbeats',()=>{
    const f=fixture();f.enroll();const b=f.auth()!;
    for(const changed of [{cpu:5},{ramMib:9},{devices:[]},{workerClass:'edge' as const,cpu:0,ramMib:0,devices:[]},{principal:'another'}]){
      rejects(()=>f.enroll({...changed,key:'v2',expectedRevision:1,incarnation:1,tokenSha256:sha(2)}),'immutable-approved-identity');
      rejects(()=>f.heartbeat(b,1,'hb',{...approved,...changed}),'observed-identity-mismatch');
    }
    rejects(()=>f.heartbeat({...b,principal:'executor-2'}),'identity-fence');
    rejects(()=>f.heartbeat({...b,incarnation:1}),'identity-fence');
    rejects(()=>f.enroll({workerId:'device-2',key:'second',tokenSha256:sha(2)}),'immutable worker binding');
    expect(f.rows('enrollment_credentials')).toHaveLength(1);f.close();
  });
  it('strict exact schemas, finite bounded geometry, per-device uniqueness and zero edge vectors',()=>{
    const f=fixture();
    for(const changed of [{cpu:NaN},{cpu:Infinity},{cpu:1.5},{ramMib:-1},{cpu:65537},{devices:[approved.devices[0],approved.devices[0]]},{workerClass:'edge',cpu:1,ramMib:0,devices:[]},{workerClass:'edge',cpu:0,ramMib:0,devices:approved.devices},{role:'owner'},{tokenSha256:'raw-not-a-digest'}]) expect(()=>f.enroll(changed as any)).toThrow();
    const edge=f.enroll({workerClass:'edge',cpu:0,ramMib:0,devices:[]});expect(edge.status.identity.cpu).toBe(0);
    expect(()=>f.store.enroll({role:'executor',principal:'bad'} as any,request())).toThrow('forbidden');
    expect(()=>f.store.status({role:'executor',principal:'bad'} as any,{afterWorkerId:null,limit:1})).toThrow('forbidden');
    expect(()=>f.store.status(owner,{afterWorkerId:null,limit:129})).toThrow('invalid-integer');
    expect(()=>f.store.authenticateDigest('A'.repeat(64))).toThrow('invalid-digest');f.close();
  });
  it('heartbeat CAS and idempotency do not advance freshness on lost-response replay',()=>{
    const f=fixture({heartbeatFreshnessMs:10});f.enroll();const b=f.auth()!;const first=f.heartbeat(b);
    f.at(1010);expect(f.heartbeat(b)).toEqual(first);rejects(()=>f.store.requireFresh(b),'heartbeat-stale');
    rejects(()=>f.heartbeat(b,2,'hb-1'),'idempotency-conflict');
    rejects(()=>f.heartbeat(b,1,'different'),'sequence-conflict');
    expect(f.heartbeat(b,2).lastSeen).toBe(1010);expect(f.rows('enrollment_events')).toHaveLength(1);f.close();
  });
  it('serializes twenty same-revision contenders with exactly one CAS winner, including independent instances',async()=>{
    const f=fixture();const peers=Array.from({length:20},()=>new WorkerEnrollment(f.port,f.config));
    const results=await Promise.allSettled(peers.map((store,n)=>Promise.resolve().then(()=>store.enroll(owner,request({key:`race-${n}`,tokenSha256:sha(n+20)})))));
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(19);
    expect(f.rows('enrollment_credentials')).toHaveLength(1);expect(f.rows('enrollment_events')).toHaveLength(1);
    const status=f.store.status(owner,{afterWorkerId:null,limit:1}).workers[0];const binding={role:'executor' as const,workerId:status.workerId,principal:status.principal,revision:status.revision,incarnation:status.incarnation};
    const heartbeats=await Promise.allSettled(peers.map((store,n)=>Promise.resolve().then(()=>store.heartbeat(binding,{key:`race-hb-${n}`,sequence:1,observedIdentity:approved}))));
    expect(heartbeats.filter(r=>r.status==='fulfilled')).toHaveLength(1);f.close();
  });
  it('same enroll replay is marked and changed payload conflicts; namespace and persisted policy cannot be switched',()=>{
    const f=fixture();f.enroll();expect(f.enroll()).toMatchObject({applied:false,replayed:true});
    rejects(()=>f.enroll({expiresAt:999999}),'idempotency-conflict');
    for(const option of [{authorityId:'other'},{environment:'other'},{heartbeatFreshnessMs:1},{maxWorkers:1}]) rejects(()=>new WorkerEnrollment(f.port,{...f.config,...option}),'namespace-or-policy-mismatch');
    expect(f.rows('enrollment_credentials')).toHaveLength(1);f.close();
  });
  it('rolls back mutation, audit, idempotency and clock on audit failure or parent core rejection',()=>{
    const f=fixture();f.fault(true);expect(()=>f.enroll()).toThrow('audit-fault');expect(f.rows('enrollment_workers')).toEqual([]);expect(f.rows('enrollment_credentials')).toEqual([]);
    f.fault(false);f.enroll();const b=f.auth()!;const before=f.rows('enrollment_events');
    f.fault(true);expect(()=>f.heartbeat(b)).toThrow('audit-fault');expect(f.rows('enrollment_credentials')[0]).toMatchObject({last_seen:null,sequence:0});
    expect(()=>f.store.revoke(owner,{key:'r',workerId:b.workerId,revision:1})).toThrow('audit-fault');f.fault(false);expect(f.auth()).toEqual(b);
    expect(()=>f.port.transactionSync(()=>{f.store.revoke(owner,{key:'r',workerId:b.workerId,revision:1});f.db.exec('CREATE TABLE parent_probe(value TEXT)');throw new Error('parent-quarantine-rejected');})).toThrow('parent-quarantine-rejected');
    expect(f.auth()).toEqual(b);expect(f.rows('enrollment_events')).toEqual(before);
    expect(()=>f.port.transactionSync(()=>{f.enroll({workerId:'second',principal:'second',key:'second',tokenSha256:sha(2)});throw new Error('parent-register-rejected');})).toThrow('parent-register-rejected');
    expect(f.auth(2)).toBeNull();expect(f.rows('enrollment_workers')).toHaveLength(1);f.close();
  });
  it('busy worker cannot exhaust another worker heartbeat/enrollment capacity; storage stays bounded',()=>{
    const f=fixture({maxWorkers:3,maxCredentials:3,maxEvents:6});f.enroll();const busy=f.auth()!;
    for(let n=1;n<=1000;n++){f.at(1000+n);f.heartbeat(busy,n);}
    expect(f.rows('enrollment_events')).toHaveLength(1);expect(f.rows('enrollment_liveness')).toHaveLength(1);
    f.enroll({workerId:'second',principal:'second',key:'second',tokenSha256:sha(2)});
    const second=f.auth(2)!;expect(f.heartbeat(second,1,'second-hb',{...approved,workerId:'second',principal:'second'}).freshness).toBe('fresh');
    f.enroll({workerId:'third',principal:'third',key:'third',tokenSha256:sha(3)});
    // Permanent non-revocation journal budget is now full. Heartbeats remain independent.
    f.at(2001);f.heartbeat(busy,1001);f.heartbeat(second,2,'second-hb2',{...approved,workerId:'second',principal:'second'});
    expect(f.rows('enrollment_events')).toHaveLength(3);expect(f.rows('enrollment_liveness')).toHaveLength(2);
    for(const workerId of [busy.workerId,'second','third']) f.store.revoke(owner,{key:`revoke-${workerId}`,workerId,revision:1});
    expect(f.rows('enrollment_events')).toHaveLength(6);expect(f.auth()).toBeNull();expect(f.auth(2)).toBeNull();expect(f.auth(3)).toBeNull();
    rejects(()=>f.enroll({key:'v2',expectedRevision:1,incarnation:1,tokenSha256:sha(4)}),'credential capacity');f.close();
  });
  it('per-worker admission throttles only that worker and exact latest replay survives restart',()=>{
    const f=fixture({heartbeatMinIntervalMs:10});f.enroll();const b=f.auth()!;const first=f.heartbeat(b);
    f.restart();expect(f.heartbeat(b)).toEqual(first);
    f.at(1009);rejects(()=>f.heartbeat(b,2),'heartbeat-rate-limited');
    expect(f.rows('enrollment_liveness')).toHaveLength(1);
    f.at(1010);f.heartbeat(b,2);rejects(()=>f.heartbeat(b,1,'hb-1'),'sequence-conflict');
    f.restart();expect(f.heartbeat(b,2).lastSeen).toBe(1010);expect(f.rows('enrollment_events')).toHaveLength(1);f.close();
  });
  it('schema 1 is explicitly rejected instead of silently pruning or migrating evidence',()=>{
    const f=fixture();f.db.exec('DROP TRIGGER enrollment_meta_guard; PRAGMA ignore_check_constraints=ON; UPDATE enrollment_meta SET schema_version=1; PRAGMA ignore_check_constraints=OFF');
    rejects(()=>f.restart(),'namespace-or-policy-mismatch');expect(f.rows('enrollment_meta')[0]).toMatchObject({schema_version:1});f.close();
  });
  it('SQL prevents overwrite/replace/delete of identities, credential digests, namespace and immutable audit',()=>{
    const f=fixture();f.enroll();f.heartbeat(f.auth()!);
    for(const table of ['enrollment_meta','enrollment_workers','enrollment_credentials','enrollment_events','enrollment_liveness']){
      expect(()=>f.db.exec(`DELETE FROM ${table}`)).toThrow();
      const columns=f.db.prepare(`PRAGMA table_info(${table})`).all().map(r=>r.name).join(',');
      expect(()=>f.db.exec(`INSERT OR REPLACE INTO ${table}(${columns}) SELECT ${columns} FROM ${table}`)).toThrow();
    }
    expect(()=>f.db.exec("UPDATE enrollment_events SET actor='spoof'")).toThrow();
    expect(()=>f.db.exec("UPDATE enrollment_liveness SET request_key='spoof'")).toThrow();
    expect(()=>f.db.exec("UPDATE enrollment_workers SET identity='{}'")).toThrow();
    expect(()=>f.db.exec("UPDATE enrollment_credentials SET digest='"+sha(3)+"'")).toThrow();
    expect(()=>f.db.exec('UPDATE enrollment_credentials SET revision=2')).toThrow();
    f.store.revoke(owner,{key:'revoke',workerId:approved.workerId,revision:1});
    expect(()=>f.db.exec('UPDATE enrollment_credentials SET revoked_ms=NULL')).toThrow();
    expect(()=>f.db.exec('UPDATE enrollment_credentials SET last_seen=1001,sequence=2')).toThrow();f.close();
  });
  it('SQL guards edge geometry, monotonic versions and credential uniqueness even with direct writes',()=>{
    const f=fixture();f.enroll();
    const insert=f.db.prepare('INSERT INTO enrollment_workers VALUES(?,?,?)');
    expect(()=>insert.run('edge','edge',JSON.stringify({...approved,workerId:'edge',principal:'edge',workerClass:'edge'}))).toThrow('class geometry');
    expect(()=>f.db.prepare('INSERT INTO enrollment_credentials(worker_id,revision,incarnation,digest,issued_ms,expires_ms) VALUES(?,?,?,?,?,?)').run(approved.workerId,3,3,sha(3),1000,2000)).toThrow('credential revision fence');
    expect(()=>f.db.prepare('INSERT INTO enrollment_credentials(worker_id,revision,incarnation,digest,issued_ms,expires_ms) VALUES(?,?,?,?,?,?)').run(approved.workerId,2,0,sha(3),1000,2000)).toThrow();f.close();
  });
  it('canonical device ordering and binding key order preserve exact idempotency',()=>{
    const f=fixture();const devices=[approved.devices[0],{id:'gpu1',kind:'cuda' as const,vramMib:8192}];
    f.enroll({devices});expect(f.enroll({devices:[...devices].reverse()}).replayed).toBe(true);
    const binding=f.auth()!;const observedIdentity={...approved,devices:[...devices].reverse()};
    const first=f.heartbeat(binding,1,'hb',observedIdentity);
    const reordered={incarnation:binding.incarnation,revision:binding.revision,principal:binding.principal,workerId:binding.workerId,role:binding.role};
    expect(f.heartbeat(reordered,1,'hb',{...approved,devices})).toEqual(first);f.close();
  });
  it('SQL blocks missing class, stale-version reassertion and expiry bypass',()=>{
    const f=fixture();f.enroll({expiresAt:1100});
    const bad={...approved,workerId:'bad',principal:'bad'} as any;delete bad.workerClass;
    expect(()=>f.db.prepare('INSERT INTO enrollment_workers VALUES(?,?,?)').run('bad','bad',JSON.stringify(bad))).toThrow('invalid geometry');
    f.at(1100);expect(f.auth()).toBeNull();
    expect(()=>f.db.exec('UPDATE enrollment_credentials SET last_seen=1100,sequence=1')).toThrow();
    f.enroll({key:'v2',expectedRevision:1,incarnation:1,tokenSha256:sha(2)});
    expect(()=>f.db.exec('UPDATE enrollment_credentials SET last_seen=1100,sequence=1 WHERE revision=1')).toThrow();f.close();
  });

});
