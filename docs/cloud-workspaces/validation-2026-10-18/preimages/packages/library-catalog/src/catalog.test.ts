import { DatabaseSync } from 'node:sqlite';
import { unlinkSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { LibraryCatalog, LibraryRejected, type LibraryBodies, type LibraryCatalogOptions, type LibraryContext, type LibraryEnvelope, type LibraryOperation, type TransactionPort, type TransferBinding } from './index';

const H = 'a'.repeat(64), H2 = 'b'.repeat(64);
const base: LibraryCatalogOptions = {environment:'test',authorityId:'catalog',projectId:'project',policy:{version:'p1',ownerPrincipal:'owner',writerPrincipal:'writer',verifierPrincipal:'verifier'}};
const actor = (role: LibraryContext['role']): LibraryContext => ({environment:'test',authorityId:'catalog',projectId:'project',role,principal:role});
const owner = actor('owner'), writer = actor('writer'), verifier = actor('verifier');
const binding: TransferBinding = {projectId:'project',policyVersion:'p1',policyHash:H,compute:{authorityId:'compute',workloadId:'work',leaseId:'lease',attemptId:'attempt',capabilityDigest:H,workerId:'worker',epoch:1,generation:1,incarnation:1},content:{manifestHash:H,objectHash:H,objectKey:`projects/project/objects/${H}`,objectGeneration:'1',bytes:100}};
const cleanups: (() => void)[] = [];
afterEach(() => { for (const f of cleanups.splice(0).reverse()) f(); });
function setup(path = ':memory:', options = base) {
  const db = new DatabaseSync(path); cleanups.push(() => db.close());
  let fault: string | undefined, clock = 100, counter = 0;
  const port: TransactionPort = {
    sql:{exec(q,...b) { if (fault && q.startsWith(fault)) {fault = undefined; throw new Error('injected rollback');} return db.prepare(q).all(...b) as Record<string,unknown>[]; }},
    transactionSync(fn) { db.exec('BEGIN IMMEDIATE'); try { const out = fn(); db.exec('COMMIT'); return out; } catch (e) {db.exec('ROLLBACK'); throw e;} },
  };
  const catalog = new LibraryCatalog(port,{...options,now:()=>clock});
  const exec = <K extends LibraryOperation>(operation:K,body: LibraryBodies[K], context:LibraryContext = writer,key = 'k'+(++counter)) => catalog.execute(context,{operation,key,body} as LibraryEnvelope);
  const stage = (n='1') => exec('stageTransfer',{version:1,intentId:'i'+n,binding,expiresAt:10000});
  const attest = (n='1',generation=1,b= binding) => exec('attestTransfer',{version:1,attestationId:'a'+n,intentId:'i'+n,generation,binding:b,manifestHash:H,bytes:100,hostAttestation:H2,attestedAt:100,expiresAt:10000},verifier);
  const publish = (n='1',generation=1) => exec('publishSnapshot',{version:1,snapshotId:'s'+n,intentId:'i'+n,generation,attestationId:'a'+n,provenance:{source:'source',parentSnapshotId:null}});
  const verify = (n='1') => exec('recordVerification',{version:1,verificationId:'v'+n,snapshotId:'s'+n,hostAttestation:H2},verifier);
  const candidate = (n='1',revision=0) => exec('createCandidate',{version:1,candidateId:'c'+n,snapshotId:'s'+n,verificationId:'v'+n,expectedCanonicalRevision:revision});
  const promote = (n='1',revision=0,key?:string) => exec('promoteCandidate',{version:1,candidateId:'c'+n,expectedCanonicalRevision:revision},owner,key);
  const journey = (n='1') => {stage(n);attest(n);publish(n);verify(n);candidate(n);};
  return {db,port,catalog,exec,stage,attest,publish,verify,candidate,promote,journey,snap:()=>catalog.snapshot(owner),time:(n:number)=>{clock=n;},fault:(prefix='INSERT INTO library_catalog_commands')=>{fault=prefix;}};
}

describe('durable Library catalog', () => {
  it('separates staging, host content attestation, publication, independent verification, candidate and canonical CAS',()=>{
    const h=setup();h.stage();expect(h.snap().canonicalSnapshotId).toBeNull();
    expect(()=>h.publish()).toThrow('UNKNOWN_TRANSFERATTESTATION');h.attest();h.publish();
    expect(()=>h.candidate()).toThrow('UNKNOWN_VERIFICATION');h.verify();h.candidate();
    expect(h.snap().canonicalRevision).toBe(0);expect(h.promote()).toMatchObject({accepted:true,canonicalRevision:1});
    expect(h.snap()).toMatchObject({canonicalSnapshotId:'s1',canonicalRevision:1});
    expect(h.snap().records.find(r=>r.kind==='transferAttestation')?.body.evidenceScope).toBe('host-content-attestation');
  });
  it('20 competing immutable candidates produce exactly one canonical CAS winner',async()=>{
    const path = new URL(`../competitors-${process.pid}-${Date.now()}.sqlite`,import.meta.url).pathname;
    cleanups.push(()=>unlinkSync(path));const h=setup(path);for(let n=0;n<20;n++)h.journey(String(n));
    const clients=Array.from({length:20},()=>setup(path));
    const contenders = await Promise.all(clients.map((client,n)=>Promise.resolve().then(()=>client.promote(String(n),0,'race-'+n))));
    expect(contenders.filter(r=>r.accepted)).toHaveLength(1);
    expect(contenders.filter(r=>r.code==='CANONICAL_CONFLICT')).toHaveLength(19);
    expect(h.snap().records.filter(r=>r.kind==='candidate')).toHaveLength(20);
    expect(h.snap().canonicalRevision).toBe(1);
  });
  it('reopens disk and replays exactly without reapplying even after expiry and cancellation',()=>{
    const path = new URL(`../reopen-${process.pid}-${Date.now()}.sqlite`,import.meta.url).pathname;
    cleanups.push(()=>unlinkSync(path));const h=setup(path);
    const envelope:LibraryEnvelope={operation:'stageTransfer',key:'stable',body:{version:1,intentId:'i1',binding,expiresAt:10000}};
    const first=h.catalog.execute(writer,envelope);h.exec('cancelTransfer',{version:1,intentId:'i1',reason:'stop'});
    const second=setup(path);second.time(20000);const before=second.snap();
    expect(second.catalog.execute(writer,envelope)).toEqual(first);expect(second.snap()).toEqual(before);
    expect(()=>second.catalog.execute(writer,{...envelope,body:{...envelope.body,expiresAt:20001}})).toThrow('IDEMPOTENCY_MISMATCH');
  });
  it('digest binds request and trusted principal/role and canonicalizes key order',()=>{
    const h=setup();const e:LibraryEnvelope={operation:'stageTransfer',key:'stable',body:{version:1,intentId:'i1',binding,expiresAt:10000}};
    const first=h.catalog.execute(writer,e);
    expect(h.catalog.execute(writer,{body:e.body,key:e.key,operation:e.operation})).toEqual(first);
    expect(()=>h.catalog.execute(owner,e)).toThrow('IDEMPOTENCY_MISMATCH');
    expect(()=>h.catalog.execute(writer,{...e,key:'stable',operation:'cancelTransfer',body:{version:1,intentId:'i1',reason:'stop'}})).toThrow('IDEMPOTENCY_MISMATCH');
  });
  it.each(['INSERT INTO library_catalog_records','INSERT INTO library_catalog_commands'])('rolls back evidence/audit/reply atomically on %s fault',prefix=>{
    const h=setup();const before=h.snap();h.fault(prefix);expect(()=>h.stage()).toThrow('injected rollback');expect(h.snap()).toEqual(before);
    expect(h.db.prepare('SELECT count(*) AS n FROM library_catalog_commands').get()).toEqual({n:0});h.stage();expect(h.snap().records).toHaveLength(2);
  });
  it('rolls back a second evidence insert after first insert succeeded',()=>{
    const h=setup();h.db.exec("CREATE TRIGGER reject_authorization BEFORE INSERT ON library_catalog_records WHEN NEW.kind='authorization' BEGIN SELECT RAISE(ABORT,'authorization fault'); END");
    expect(()=>h.stage()).toThrow('authorization fault');expect(h.snap().records).toEqual([]);
    expect(h.db.prepare('SELECT count(*) AS n FROM library_catalog_commands').get()).toEqual({n:0});
  });
  it.each(['cancel','revoke','expire'])('rejects stale publish after %s with no snapshot or reply committed',action=>{
    const h=setup();h.stage();h.attest();
    if(action==='cancel')h.exec('cancelTransfer',{version:1,intentId:'i1',reason:'stop'},owner);
    if(action==='revoke')h.exec('revokePolicy',{version:1,reason:'stop'},owner);
    if(action==='expire')h.time(10000);
    const before=h.snap();expect(()=>h.publish()).toThrow(LibraryRejected);expect(h.snap()).toEqual(before);
  });
  it('fences old generation, compute attempt, digest, worker and pinned content on attestation',()=>{
    const h=setup();h.stage();const b2={...binding,compute:{...binding.compute,attemptId:'new',generation:2}};
    h.exec('authorizeTransfer',{version:1,intentId:'i1',expectedGeneration:1,binding:b2,expiresAt:10000},owner);
    expect(()=>h.attest()).toThrow('GENERATION_FENCE');
    for(const b of [binding,{...b2,compute:{...b2.compute,workerId:'other'}},{...b2,compute:{...b2.compute,capabilityDigest:H2}},{...b2,content:{...b2.content,objectGeneration:'2'}}])expect(()=>h.attest('1',2,b)).toThrow('ATTESTATION_BINDING');
    h.attest('1',2,b2);expect(()=>h.publish()).toThrow('GENERATION_FENCE');h.publish('1',2);
  });
  it('fences future and expired attestations, and publication after independent compute acceptance expiry',()=>{
    const h=setup();h.stage();
    const b:LibraryBodies['attestTransfer']={version:1,attestationId:'a1',intentId:'i1',generation:1,binding,manifestHash:H,bytes:100,hostAttestation:H2,attestedAt:100,expiresAt:150};
    expect(()=>h.exec('attestTransfer',{...b,attestedAt:101},verifier)).toThrow('ATTESTATION_EXPIRED');
    expect(()=>h.exec('attestTransfer',{...b,expiresAt:100},verifier)).toThrow('ATTESTATION_EXPIRED');
    h.exec('attestTransfer',b,verifier);h.time(150);
    expect(()=>h.publish()).toThrow('ATTESTATION_EXPIRED');expect(h.snap().records.some(r=>r.kind==='snapshot')).toBe(false);
  });
  it('does not retroactively expire published snapshots when host acceptance expires',()=>{
    const h=setup();h.stage();h.attest();h.publish();h.time(10001);h.verify();h.candidate();
    expect(h.promote()).toMatchObject({accepted:true,canonicalRevision:1});
  });
  it('accepts exact manifest refs with 32 digit provider generations and rejects mismatched manifest hash',()=>{
    const h=setup();const b={...binding,content:{...binding.content,objectKey:`projects/project/manifests/${H}`,objectGeneration:'9'.repeat(32)}};
    h.exec('stageTransfer',{version:1,intentId:'manifest',binding:b,expiresAt:10000});
    expect(()=>h.exec('stageTransfer',{version:1,intentId:'bad',binding:{...b,content:{...b.content,manifestHash:H2}},expiresAt:10000})).toThrow('OBJECT_SCOPE');
    expect(()=>h.exec('stageTransfer',{version:1,intentId:'bad',binding:{...b,content:{...b.content,objectGeneration:'9'.repeat(33)}},expiresAt:10000})).toThrow('INVALID_INPUT');
  });
  it('rejects stale content attestation after reauthorization even if bytes and manifest match',()=>{
    const h=setup();h.stage();h.attest();h.exec('authorizeTransfer',{version:1,intentId:'i1',expectedGeneration:1,binding,expiresAt:10000},owner);
    expect(()=>h.publish('1',2)).toThrow('ATTESTATION_BINDING');
  });
  it('enforces distinct owner/writer/verifier configured principals, exact project, environment and authority',()=>{
    const h=setup();h.stage();
    for(const c of [{...verifier,principal:'writer'},{...verifier,principal:'unknown'},{...verifier,projectId:'elsewhere'},{...verifier,authorityId:'other'},{...verifier,environment:'other'},owner,writer]) {
      expect(()=>h.exec('attestTransfer',{version:1,attestationId:'a1',intentId:'i1',generation:1,binding,manifestHash:H,bytes:100,hostAttestation:H,attestedAt:100,expiresAt:10000},c)).toThrow('PERMISSION');
    }
    expect(()=>h.exec('revokePolicy',{version:1,reason:'stop'},{...owner,principal:'intruder'})).toThrow('PERMISSION');
    expect(()=>new LibraryCatalog(h.port,{...base,policy:{...base.policy,verifierPrincipal:'writer'}})).toThrow('INVALID_INPUT');
    expect(()=>h.exec('publishSnapshot',{version:1,snapshotId:'s1',intentId:'i1',generation:1,attestationId:'a1',provenance:{source:'x',parentSnapshotId:null}},owner)).toThrow('PERMISSION');
  });
  it('retains stale candidates and audits replay-stable conflict replies',()=>{
    const h=setup();h.journey();h.promote();h.journey('2');
    const losing=h.promote('2',0,'loser');expect(losing).toMatchObject({accepted:false,code:'CANONICAL_CONFLICT'});
    expect(h.promote('2',0,'loser')).toEqual(losing);expect(h.snap().records.filter(r=>r.kind==='candidate')).toHaveLength(2);
    expect(h.snap().records.find(r=>r.kind==='candidate'&&r.id==='c2')?.body.expectedCanonicalRevision).toBe(0);
  });
  it('permits promotion of historically published verified snapshots after transfer expiry/cancel, but policy revocation blocks promotion',()=>{
    const h=setup();h.journey();h.time(20000);h.exec('cancelTransfer',{version:1,intentId:'i1',reason:'closed'},owner);
    expect(h.promote()).toMatchObject({accepted:true});
    const other=setup();other.journey();other.exec('revokePolicy',{version:1,reason:'revoked'},owner);expect(()=>other.promote()).toThrow('POLICY_REVOKED');
  });
  it('prevents replacement, update and delete of every evidence table including meta',()=>{
    const h=setup();h.stage();for(const table of ['meta','records','commands'])for(const query of [`UPDATE library_catalog_${table} SET ${table==='meta'?'binding=binding':table==='records'?'body=body':'reply=reply'}`,`DELETE FROM library_catalog_${table}`,`INSERT OR REPLACE INTO library_catalog_${table} SELECT * FROM library_catalog_${table}`])expect(()=>h.db.exec(query)).toThrow('immutable catalog');
  });
  it('fails on missing/wrong schema and binding before changing any evidence or repairing schema',()=>{
    const h=setup();h.stage();const before=h.snap();expect(()=>new LibraryCatalog(h.port,{...base,projectId:'other'})).toThrow('BINDING_MISMATCH');expect(h.snap()).toEqual(before);
    h.db.exec('DROP TRIGGER library_catalog_records_replace');
    const ddl=h.db.prepare("SELECT sql FROM sqlite_master ORDER BY name").all();expect(()=>new LibraryCatalog(h.port,base)).toThrow('SCHEMA_INCOMPLETE');
    expect(h.db.prepare("SELECT sql FROM sqlite_master ORDER BY name").all()).toEqual(ddl);expect(()=>h.snap()).toThrow('SCHEMA_INCOMPLETE');
    const partial=setup();partial.db.exec('DROP TABLE library_catalog_commands');expect(()=>new LibraryCatalog(partial.port,base)).toThrow('SCHEMA_INCOMPLETE');
  });
  it('rejects a preexisting partial namespace without meta; does not create missing evidence',()=>{
    const db=new DatabaseSync(':memory:');cleanups.push(()=>db.close());db.exec('CREATE TABLE library_catalog_unknown(x)');
    const port:TransactionPort={sql:{exec:(q,...b)=>db.prepare(q).all(...b) as Record<string,unknown>[]},transactionSync:fn=>fn()};
    expect(()=>new LibraryCatalog(port,base)).toThrow('SCHEMA_INCOMPLETE');expect(db.prepare("SELECT name FROM sqlite_master WHERE name='library_catalog_meta'").all()).toEqual([]);
  });
  it('does not allow data or normal-command capacity to starve terminal cancellation/revocation',()=>{
    const h=setup();for(let n=0;n<32;n++)h.stage(String(n));
    for(let n=0;n<128;n++)h.exec('authorizeTransfer',{version:1,intentId:'i0',expectedGeneration:n+1,binding,expiresAt:10000},owner);
    expect(h.snap().records).toHaveLength(192);expect(()=>h.attest()).toThrow('CAPACITY');
    expect(()=>h.attest('0',129)).toThrow('CAPACITY');
    // SQL pressure fixture fills the independent command quota while data quota is full.
    const raw=h.db.prepare('SELECT * FROM library_catalog_commands LIMIT 1').get() as Record<string,unknown>;
    for(let n=Number(h.snap().revision);n<1024;n++)h.db.prepare('INSERT INTO library_catalog_commands VALUES(?,?,?,?,?,?,?,?)').run(n+1,'capacity-'+n,H,0,raw.actor as string,raw.request as string,raw.reply as string,100);
    expect(()=>h.attest('0',129)).toThrow('CAPACITY');
    for(let n=0;n<32;n++)h.exec('cancelTransfer',{version:1,intentId:'i'+n,reason:'stop'},owner);
    h.exec('revokePolicy',{version:1,reason:'stop'},owner);
    expect(h.snap().records).toHaveLength(225);expect(h.snap().revision).toBe(1057);
    expect(Buffer.byteLength(JSON.stringify(h.snap()))).toBeLessThanOrEqual(512*1024);
    expect(()=>h.db.prepare('INSERT INTO library_catalog_records VALUES(?,?,?,?,?,?)').run(226,'verification','extra','verifier',100,'{}')).toThrow();
    expect(()=>h.db.prepare('INSERT INTO library_catalog_commands VALUES(?,?,?,?,?,?,?,?)').run(1058,'extra',H,1,'{}','{}','{}',100)).toThrow();
  });
  it('validates exact versioned shapes, terminal newlines, object project/path, decimal generations and attestation hashes',()=>{
    const h=setup();const request:LibraryEnvelope={operation:'stageTransfer',key:'k',body:{version:1,intentId:'i',binding,expiresAt:10000}};
    const bad:any[]=[{...request,extra:1},{...request,body:{...request.body,version:2}},{...request,key:'x\n'},{...request,body:{...request.body,intentId:'x\n'}}];
    for(const content of [{...binding.content,objectKey:`projects/other/objects/${H}`},{...binding.content,objectKey:'../objects/x'},{...binding.content,objectGeneration:'1\n'},{...binding.content,objectGeneration:'01'},{...binding.content,manifestHash:H+'\n'}])bad.push({...request,body:{...request.body,binding:{...binding,content}}});
    bad.push({...request,body:{...request.body,binding:{...binding,compute:{...binding.compute,incarnation:'1'}}}});
    for(const r of bad)expect(()=>h.catalog.execute(writer,r)).toThrow(LibraryRejected);
    h.stage();expect(()=>h.exec('attestTransfer',{version:1,attestationId:'a',intentId:'i1',generation:1,binding,manifestHash:H,bytes:100,hostAttestation:'raw text',attestedAt:100,expiresAt:10000} ,verifier)).toThrow('INVALID_INPUT');
  });
  it('rejects impossible max-identifier staging and reauthorization before committing a stranded intent',()=>{
    const long='x'.repeat(96);
    const options={...base,projectId:long,policy:{version:long,ownerPrincipal:'owner',writerPrincipal:'writer',verifierPrincipal:'verifier'}};
    const h=setup(':memory:',options), c={...writer,projectId:long};
    const large:TransferBinding={...binding,projectId:long,policyVersion:long,
      compute:{...binding.compute,authorityId:long,workloadId:long,leaseId:long,attemptId:long,workerId:long},
      content:{...binding.content,objectKey:`projects/${long}/objects/${H}`,objectGeneration:'9'.repeat(32)}};
    const e:LibraryEnvelope={operation:'stageTransfer',key:'max',body:{version:1,intentId:long,binding:large,expiresAt:10000}};
    const read=()=>h.catalog.snapshot({...owner,projectId:long});const before=read();
    expect(()=>h.catalog.execute(c,e)).toThrow('ATTESTATION_CAPACITY');expect(read()).toEqual(before);
    const short={...large,compute:{...binding.compute}};
    h.catalog.execute(c,{...e,key:'short',body:{...e.body,binding:short}});
    const staged=read();
    expect(()=>h.catalog.execute({...owner,projectId:long},{operation:'authorizeTransfer',key:'reauth',body:{version:1,intentId:long,expectedGeneration:1,binding:large,expiresAt:10000}})).toThrow('ATTESTATION_CAPACITY');
    expect(read()).toEqual(staged);
    h.catalog.execute({...verifier,projectId:long},{operation:'attestTransfer',key:'attest',body:{version:1,intentId:long,attestationId:long,binding:short,generation:1,manifestHash:H,bytes:100,hostAttestation:H2,attestedAt:100,expiresAt:10000}});
  });
  it('rejects accessors, proxies, hidden fields, sparse arrays and cycles without invoking code',()=>{
    const h=setup();const e:any={operation:'stageTransfer',key:'k',body:{version:1,intentId:'i',binding,expiresAt:10000}};
    let invoked=false;Object.defineProperty(e,'operation',{get(){invoked=true;throw Error('getter');},enumerable:true});
    expect(()=>h.catalog.execute(writer,e)).toThrow('INVALID_INPUT');expect(invoked).toBe(false);
    const proxy = new Proxy({}, {ownKeys(){invoked=true;throw Error('proxy');}});
    expect(()=>h.catalog.execute(writer,proxy as any)).toThrow('INVALID_INPUT');expect(invoked).toBe(false);
    const cyclic:any={};cyclic.self=cyclic;expect(()=>h.catalog.execute(writer,cyclic)).toThrow('INVALID_INPUT');
  });
  it('copies options and input evidence; returned snapshots cannot mutate durable evidence',()=>{
    const opts=structuredClone(base);const h=setup(':memory:',opts);opts.policy.writerPrincipal='other';h.stage();
    const snapshot=h.snap();snapshot.records[0].body.binding={};expect(h.snap().records[0].body.binding).toEqual(binding);
  });
});
