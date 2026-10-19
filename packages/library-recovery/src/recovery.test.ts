import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { LibraryCatalog } from '../../library-catalog/src/catalog';
import { canonical } from '../../library-catalog/src/validation';
import { schemaObjects } from '../../library-catalog/src/schema';
import type { LibraryBodies, LibraryContext, LibraryEnvelope, LibraryOperation, TransactionPort, TransferBinding } from '../../library-catalog/src/types';
import { manifestBytes } from '../../library-jobs/src/index';
import type { ObjectRef } from '../../library-jobs/src/types';
import { archiveSha256, exportCatalog, importCatalog, MAX_ARCHIVE_BYTES, rehearseContentRecovery, type RecoveryBinding } from './index';

const H = 'a'.repeat(64), H2 = 'b'.repeat(64);
const binding: RecoveryBinding = {environment:'test',authorityId:'catalog',projectId:'project',policy:{version:'p1',ownerPrincipal:'owner',writerPrincipal:'writer',verifierPrincipal:'verifier'}};
const actor = (role: LibraryContext['role']): LibraryContext => ({environment:'test',authorityId:'catalog',projectId:'project',role,principal:role});
const owner = actor('owner'), writer = actor('writer'), verifier = actor('verifier');
const transfer: TransferBinding = {projectId:'project',policyVersion:'p1',policyHash:H,compute:{authorityId:'compute',workloadId:'work',leaseId:'lease',attemptId:'attempt',capabilityDigest:H,workerId:'worker',epoch:1,generation:1,incarnation:1},content:{manifestHash:H,objectHash:H,objectKey:`projects/project/objects/${H}`,objectGeneration:'1',bytes:100}};
const cleanups: (()=>void)[] = [];
afterEach(()=> { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function sql(path = ':memory:') {
  const db = new DatabaseSync(path); let closed = false;
  const close = () => { if (!closed) { db.close(); closed = true; } };
  cleanups.push(close);
  const port: TransactionPort = {
    sql:{exec:(q,...args)=>db.prepare(q).all(...args) as Record<string,unknown>[]},
    transactionSync(fn) { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } },
  };
  return {db,port,close};
}
function source(path = ':memory:') {
  const s = sql(path); let clock = 100, counter = 0;
  const catalog = new LibraryCatalog(s.port,{...binding,now:()=>clock});
  const exec = <K extends LibraryOperation>(operation:K, body:LibraryBodies[K], context = writer, key = 'key'+(++counter)) => {
    clock += 1;
    return catalog.execute(context,{operation,body,key} as LibraryEnvelope);
  };
  const stage = (id='i', b=transfer) => exec('stageTransfer',{version:1,intentId:id,binding:b,expiresAt:10000});
  const attest = (id='i',generation=1,b=transfer) => exec('attestTransfer',{version:1,attestationId:'a'+id,intentId:id,generation,binding:b,manifestHash:b.content.manifestHash,bytes:b.content.bytes,hostAttestation:H2,attestedAt:100,expiresAt:10000},verifier);
  const publish = (id='i',generation=1) => exec('publishSnapshot',{version:1,snapshotId:'s'+id,intentId:id,generation,attestationId:'a'+id,provenance:{source:'source',parentSnapshotId:null}});
  const journey = () => { stage(); attest(); publish(); exec('recordVerification',{version:1,verificationId:'v',snapshotId:'si',hostAttestation:H2},verifier); exec('createCandidate',{version:1,candidateId:'c',snapshotId:'si',verificationId:'v',expectedCanonicalRevision:0}); };
  const backup = () => exportCatalog(s.port,binding,owner);
  return {...s,catalog,exec,stage,attest,publish,journey,backup};
}
function restore(archive:string, dest = sql(), expected = archiveSha256(archive)) {
  return {dest,receipt:importCatalog(dest.port,binding,owner,archive,expected)};
}
function edit(archive:string, fn:(a:any)=>void):string { const a = JSON.parse(archive); fn(a); return JSON.stringify(a); }
function evidence(s:ReturnType<typeof sql>) {
  return [...s.port.sql.exec('SELECT * FROM sqlite_master ORDER BY name')];
}
function paths() {
  const root = new URL('../.fixtures/',import.meta.url).pathname;
  mkdirSync(root,{recursive:true});
  const dir = mkdtempSync(root+'recovery-');
  cleanups.push(()=>rmSync(dir,{recursive:true}));
  return {source:dir+'/source.sqlite',destination:dir+'/destination.sqlite'};
}

describe('full catalog recovery',()=>{
  it('file source -> export -> separate file destination -> restart preserves all rows and exact lost replies, rejected CAS, cancellation and revoked policy',()=>{
    const p = paths(), s = source(p.source);
    s.journey();
    const promotion = s.exec('promoteCandidate',{version:1,candidateId:'c',expectedCanonicalRevision:0},owner,'won');
    const rejected = s.exec('promoteCandidate',{version:1,candidateId:'c',expectedCanonicalRevision:0},owner,'lost');
    expect(rejected.accepted).toBe(false);
    s.stage('cancelled'); s.exec('cancelTransfer',{version:1,intentId:'cancelled',reason:'stop'},owner,'cancel');
    s.stage('stale'); s.attest('stale');
    const successor = {...transfer,compute:{...transfer.compute,attemptId:'new',generation:2,incarnation:2}};
    s.exec('authorizeTransfer',{version:1,intentId:'stale',expectedGeneration:1,binding:successor,expiresAt:10000},owner);
    const beforeRevoke = s.backup();
    const firstDest = sql(); restore(beforeRevoke.archive, firstDest);
    const firstCatalog = new LibraryCatalog(firstDest.port,{...binding,now:()=>500});
    expect(()=>firstCatalog.execute(verifier,{operation:'attestTransfer',key:'staleAttempt',body:{version:1,attestationId:'old',intentId:'stale',generation:1,binding:transfer,manifestHash:H,bytes:100,hostAttestation:H2,attestedAt:100,expiresAt:10000}})).toThrow('GENERATION_FENCE');
    expect(()=>firstCatalog.execute(writer,{operation:'publishSnapshot',key:'stalePublish',body:{version:1,snapshotId:'stale',intentId:'stale',generation:2,attestationId:'astale',provenance:{source:'source',parentSnapshotId:null}}})).toThrow('ATTESTATION_BINDING');
    expect(()=>firstCatalog.execute(writer,{operation:'publishSnapshot',key:'cancelledPublish',body:{version:1,snapshotId:'cancelled',intentId:'cancelled',generation:1,attestationId:'none',provenance:{source:'source',parentSnapshotId:null}}})).toThrow('TRANSFER_CANCELLED');
    s.exec('revokePolicy',{version:1,reason:'stop'},owner,'revoke');
    const backup = s.backup(); const d = sql(p.destination);
    expect(importCatalog(d.port,binding,owner,backup.archive,backup.sha256)).toMatchObject({metadataRestored:true,contentVerified:false});
    expect(exportCatalog(d.port,binding,owner)).toEqual(backup);
    const snapshot = s.catalog.snapshot(owner); s.close(); d.close();
    const restarted = sql(p.destination), catalog = new LibraryCatalog(restarted.port,{...binding,now:()=>20000});
    expect(catalog.snapshot(owner)).toEqual(snapshot);
    expect(catalog.execute(owner,{operation:'promoteCandidate',key:'won',body:{version:1,candidateId:'c',expectedCanonicalRevision:0}})).toEqual(promotion);
    expect(catalog.execute(owner,{operation:'promoteCandidate',key:'lost',body:{version:1,candidateId:'c',expectedCanonicalRevision:0}})).toEqual(rejected);
    for (const row of JSON.parse(backup.archive).commands) expect(catalog.execute(JSON.parse(row.actor),JSON.parse(row.request))).toEqual(JSON.parse(row.reply));
    expect(()=>catalog.execute(writer,{operation:'stageTransfer',key:'new',body:{version:1,intentId:'new',binding:transfer,expiresAt:21000}})).toThrow('POLICY_REVOKED');
    expect(()=>catalog.execute(writer,{operation:'publishSnapshot',key:'blocked',body:{version:1,snapshotId:'bad',intentId:'stale',generation:2,attestationId:'astale',provenance:{source:'source',parentSnapshotId:null}}})).toThrow('POLICY_REVOKED');
    expect(exportCatalog(restarted.port,binding,owner)).toEqual(backup);
  });
  it('preserves owner sys-revoke cancellation keys through export, restore and lost-reply replay',()=>{
    const s=source();s.stage();
    const command:LibraryEnvelope={operation:'cancelTransfer',key:'sys-revoke-cancel',body:{version:1,intentId:'i',reason:'compute revoked'}};
    expect(()=>s.catalog.execute(writer,command)).toThrow('RESERVED_CONTROL_KEY');
    const reply=s.catalog.execute(owner,command), b=s.backup(), {dest}=restore(b.archive);
    const catalog=new LibraryCatalog(dest.port,{...binding,now:()=>20000});
    expect(catalog.execute(owner,command)).toEqual(reply);
    expect(()=>catalog.execute(writer,command)).toThrow('RESERVED_CONTROL_KEY');
    expect(exportCatalog(dest.port,binding,owner)).toEqual(b);
  });
  it('preserves entirely empty catalog with schema and binding',()=>{
    const s=source(), b=s.backup(), {dest}=restore(b.archive);
    expect(exportCatalog(dest.port,binding,owner)).toEqual(b);
  });
  it.each(['actor','digest','reply','request','at','control','record','dropRecord','dropCommand','extraRecord'])('rejects semantic %s tampering even with freshly recomputed external digest and rolls back DDL/data',kind=>{
    const s=source();s.journey(); const original=s.backup();
    const archive=edit(original.archive,a=>{
      const c=a.commands[0];
      if(kind==='actor') c.actor=canonical(owner,1024);
      if(kind==='digest') c.digest=H;
      if(kind==='reply') c.reply=canonical({...JSON.parse(c.reply),revision:44},1024);
      if(kind==='request') c.request=canonical({...JSON.parse(c.request),body:{...JSON.parse(c.request).body,expiresAt:1}});
      if(kind==='at') c.at=20000;
      if(kind==='control') c.control=1;
      if(kind==='record') a.records[0].body=canonical({...JSON.parse(a.records[0].body),intentId:'tampered'});
      if(kind==='dropRecord') a.records.pop();
      if(kind==='dropCommand') a.commands.pop();
      if(kind==='extraRecord') a.records.push({...a.records[0],seq:a.records.length+1,id:'extra'});
    });
    const d=sql(); expect(()=>restore(archive,d)).toThrow(); expect(evidence(d)).toEqual([]);
    expect(s.backup()).toEqual(original);
  });
  it('rejects a self-consistent forged command/record with recomputed command digest and archive digest',()=>{
    const s=source();s.stage();
    const archive=edit(s.backup().archive,a=>{
      const row=a.commands[0], request=JSON.parse(row.request), context=JSON.parse(row.actor);
      request.body.expiresAt=1;
      row.request=canonical(request);
      row.digest=archiveSha256(canonical({binding:canonical(binding,2048),context,envelope:request},16384));
      const authorization=a.records.find((r:any)=>r.kind==='authorization');
      authorization.body=canonical({...JSON.parse(authorization.body),expiresAt:1},1792);
    });
    const d=sql();expect(()=>restore(archive,d)).toThrow('EXPIRY');expect(evidence(d)).toEqual([]);
  });
  it.each(['table','index','view','trigger','temp','initialized','userVersion','applicationId','attached'])('rejects any nonempty dedicated destination (%s) and preserves its exact evidence',kind=>{
    const s=source();s.stage(); const d=sql();
    if(kind==='initialized') new LibraryCatalog(d.port,binding);
    else if(kind==='userVersion') d.db.exec('PRAGMA user_version=12');
    else if(kind==='applicationId') d.db.exec('PRAGMA application_id=17');
    else if(kind==='attached') d.db.exec("ATTACH DATABASE ':memory:' AS other");
    else if(kind==='temp') d.db.exec('CREATE TEMP TABLE evidence (body TEXT); INSERT INTO evidence VALUES(\'keep\')');
    else { d.db.exec('CREATE TABLE evidence (body TEXT); INSERT INTO evidence VALUES(\'keep\')');
      if(kind==='index')d.db.exec('CREATE INDEX proof ON evidence(body)');
      if(kind==='view')d.db.exec('CREATE VIEW proof AS SELECT * FROM evidence');
      if(kind==='trigger')d.db.exec("CREATE TRIGGER proof BEFORE DELETE ON evidence BEGIN SELECT RAISE(ABORT,'keep'); END");
    }
    const before=evidence(d), temp=[...d.port.sql.exec('SELECT * FROM sqlite_temp_master')];
    expect(()=>restore(s.backup().archive,d)).toThrow('RECOVERY_DESTINATION_NOT_EMPTY');
    expect(evidence(d)).toEqual(before); expect([...d.port.sql.exec('SELECT * FROM sqlite_temp_master')]).toEqual(temp);
    if(!['initialized','userVersion','applicationId','attached'].includes(kind))expect([...d.port.sql.exec('SELECT * FROM evidence')]).toEqual([{body:'keep'}]);
  });
  it('rejects owner spoof and wrong project/environment/authority/policy without source or destination mutation',()=>{
    const s=source();s.stage();const b=s.backup(),d=sql();
    for(const context of [writer,{...owner,principal:'attacker'},{...owner,projectId:'other'}]) {
      expect(()=>exportCatalog(s.port,binding,context)).toThrow('RECOVERY_OWNER_REQUIRED');
      expect(()=>importCatalog(d.port,binding,context,b.archive,b.sha256)).toThrow('RECOVERY_OWNER_REQUIRED');
    }
    for(const changed of [{...binding,environment:'other'},{...binding,authorityId:'other'},{...binding,projectId:'other'},{...binding,policy:{...binding.policy,version:'p2'}},{...binding,policy:{...binding.policy,writerPrincipal:'different'}}]) {
      expect(()=>importCatalog(d.port,changed,{...owner,environment:changed.environment,authorityId:changed.authorityId,projectId:changed.projectId},b.archive,b.sha256)).toThrow('RECOVERY_BINDING');
    }
    expect(evidence(d)).toEqual([]);expect(s.backup()).toEqual(b);
  });
  it.each(['truncated','invalid','oversize','extra','namespace','schema','missingField','badDigest','duplicate','whitespace','badField','badSeq','tooMany'])('rejects malformed archive %s before writing',kind=>{
    const s=source();s.stage();const b=s.backup(),d=sql();let archive=b.archive;
    if(kind==='truncated')archive=archive.slice(0,-1);
    if(kind==='invalid')archive='null';
    if(kind==='oversize')archive=' '.repeat(MAX_ARCHIVE_BYTES+1);
    if(kind==='extra')archive=edit(archive,a=>{a.extra=true;});
    if(kind==='namespace')archive=edit(archive,a=>{a.namespace='other';});
    if(kind==='schema')archive=edit(archive,a=>{a.schema[0].sql+=' ';});
    if(kind==='missingField')archive=edit(archive,a=>{delete a.commands[0].actor;});
    if(kind==='duplicate')archive=archive.replace('"namespace":"library_catalog"','"namespace":"bad","namespace":"library_catalog"');
    if(kind==='whitespace')archive+=' ';
    if(kind==='badField')archive=edit(archive,a=>{a.commands[0].request='x'.repeat(8193);});
    if(kind==='badSeq')archive=edit(archive,a=>{a.commands[0].seq=0;});
    if(kind==='tooMany')archive=edit(archive,a=>{a.commands=Array.from({length:1058},(_,i)=>({...a.commands[0],seq:i+1}));});
    expect(()=>restore(archive,d,kind==='badDigest'?H:archiveSha256(archive))).toThrow();expect(evidence(d)).toEqual([]);
  });
  it('supports only explicit trusted DO port selection; authorizer failures never weaken default SQLite checks',()=>{
    const s=source();s.stage();const b=s.backup(),d=sql();
    const authorizer:TransactionPort={...d.port,sql:{exec(q,...args){
      if(q.startsWith('PRAGMA') || q.includes('sqlite_temp_master'))throw new Error('authorizer denied');
      return d.port.sql.exec(q,...args);
    }}};
    expect(()=>importCatalog(authorizer,binding,owner,b.archive,b.sha256)).toThrow('authorizer denied');expect(evidence(d)).toEqual([]);
    expect(importCatalog({...authorizer,storageKind:'cloudflare-sqlite'},binding,owner,b.archive,b.sha256)).toMatchObject({metadataRestored:true,commands:1});
    expect(exportCatalog(d.port,binding,owner)).toEqual(b);
    expect(()=>importCatalog({...authorizer,storageKind:'cloudflare-sqlite'},binding,owner,b.archive,b.sha256)).toThrow('RECOVERY_DESTINATION_NOT_EMPTY');
  });
  it('rolls back schema constructor failure and journal insertion failure without repair',()=>{
    const s=source();s.stage();const b=s.backup();
    for(const failure of ['CREATE TRIGGER','INSERT INTO library_catalog_meta','INSERT INTO library_catalog_commands']) {
      const d=sql();const faulty:TransactionPort={...d.port,sql:{exec(q,...args){if(q.startsWith(failure))throw new Error('injected failure');return d.port.sql.exec(q,...args);}}};
      expect(()=>importCatalog(faulty,binding,owner,b.archive,b.sha256)).toThrow('injected failure');expect(evidence(d)).toEqual([]);
    }
  });
  it('export refuses altered or partial schema without constructor side effects',()=>{
    const d=sql();d.db.exec(schemaObjects[0].sql);const before=evidence(d);
    expect(()=>exportCatalog(d.port,binding,owner)).toThrow('RECOVERY_SCHEMA');expect(evidence(d)).toEqual(before);
    expect(()=>new LibraryCatalog(d.port,binding)).toThrow('SCHEMA_INCOMPLETE');expect(evidence(d)).toEqual(before);
  });
  it('export is transaction consistent and rejects corrupt oversized row fields before materialization',()=>{
    const s=source();s.stage();let tx=0,queries=0;
    const port:TransactionPort={sql:{exec(q,...args){expect(tx).toBe(1);queries++;return s.port.sql.exec(q,...args);}},transactionSync(fn){return s.port.transactionSync(()=>{tx++;try{return fn();}finally{tx--;}});}};
    expect(exportCatalog(port,binding,owner)).toEqual(s.backup());expect(queries).toBeGreaterThan(3);
    s.db.exec('DROP TRIGGER library_catalog_commands_update; PRAGMA ignore_check_constraints=ON');
    s.db.prepare('UPDATE library_catalog_commands SET request=?').run('x'.repeat(8193));
    // Restore trigger SQL exactly, so schema check succeeds and byte-budget check is exercised.
    s.db.exec(schemaObjects.find(o=>o.name==='library_catalog_commands_update')!.sql);
    expect(()=>s.backup()).toThrow('RECOVERY_FIELD_BUDGET');
  });
  it('archives all 1024 normal commands plus 33 controls, not a capped owner projection',()=>{
    const full=source();
    for(let i=0;i<32;i++) {
      const id='i'+i;full.stage(id);full.attest(id);full.publish(id);
      full.exec('recordVerification',{version:1,verificationId:'v'+i,snapshotId:'s'+id,hostAttestation:H2},verifier);
      full.exec('createCandidate',{version:1,candidateId:'c'+i,snapshotId:'s'+id,verificationId:'v'+i,expectedCanonicalRevision:1});
    }
    for(let i=160;i<1024;i++)full.exec('promoteCandidate',{version:1,candidateId:'c0',expectedCanonicalRevision:0},owner);
    for(let i=0;i<32;i++)full.exec('cancelTransfer',{version:1,intentId:'i'+i,reason:'stop'},owner);
    full.exec('revokePolicy',{version:1,reason:'stop'},owner);
    const b=full.backup();expect(JSON.parse(b.archive).commands).toHaveLength(1057);expect(Buffer.byteLength(b.archive)).toBeLessThan(MAX_ARCHIVE_BYTES);
    const {dest,receipt}=restore(b.archive);expect(receipt.commands).toBe(1057);expect(receipt.records).toBe(225);expect(exportCatalog(dest.port,binding,owner)).toEqual(b);
  },180000);
});

describe('independent content recovery rehearsal',()=>{
  function fixture() {
    const bytes=new TextEncoder().encode('actual bytes');const hash=archiveSha256(bytes);
    const object:ObjectRef={projectId:'project',objectKey:`projects/project/objects/${hash}`,generation:'19',sha256:hash,sizeBytes:bytes.length};
    const manifest=manifestBytes({version:1,projectId:'project',objects:[object]});const mh=archiveSha256(manifest);
    const ref:ObjectRef={projectId:'project',objectKey:`projects/project/manifests/${mh}`,generation:'29',sha256:mh,sizeBytes:manifest.length};
    const s=source();s.stage('i',{...transfer,content:{manifestHash:mh,objectHash:mh,objectKey:ref.objectKey,objectGeneration:ref.generation,bytes:manifest.length}});
    const {dest,receipt}=restore(s.backup().archive);const reads:ObjectRef[]=[];
    const readObject=(r:ObjectRef,max:number)=>{reads.push(r);expect(max).toBe(r.sizeBytes);return {ref:r,bytes:r.objectKey===ref.objectKey?manifest:bytes};};
    return {s,dest,receipt,object,ref,manifest,bytes,reads,readObject};
  }
  it('reads every exact generation manifest and object and hashes actual bytes independently after restore',()=>{
    const f=fixture();expect(f.receipt.contentVerified).toBe(false);
    const proof=rehearseContentRecovery(f.dest.port,binding,owner,{readObject:f.readObject});
    expect(proof).toMatchObject({contentVerified:true,checkedRefs:2,verifiedBytes:f.bytes.length+f.manifest.length,failures:[]});
    expect(f.reads).toEqual([f.ref,f.object]);
  });
  it.each(['missing','corrupt','wrongGeneration','truncated','corruptManifest'])('keeps metadata restored but never declares content verified for %s bytes',kind=>{
    const f=fixture();const before=exportCatalog(f.dest.port,binding,owner);
    const proof=rehearseContentRecovery(f.dest.port,binding,owner,{readObject(r,max){
      const result=f.readObject(r,max);
      if(kind==='corruptManifest' && r.objectKey===f.ref.objectKey)return {...result,bytes:new Uint8Array(result.bytes.length)};
      if(r.objectKey!==f.object.objectKey)return result;
      if(kind==='missing')throw new Error('missing');
      if(kind==='wrongGeneration')return {...result,ref:{...r,generation:'20'}};
      if(kind==='truncated')return {...result,bytes:result.bytes.slice(1)};
      return {...result,bytes:new Uint8Array(result.bytes.length)};
    }});
    expect(proof.contentVerified).toBe(false);expect(proof.failures.length).toBeGreaterThan(0);
    expect(f.receipt.metadataRestored).toBe(true);expect(exportCatalog(f.dest.port,binding,owner)).toEqual(before);
  });
  it('requires owner and refuses to claim empty-catalog content proof',()=>{
    const s=source();const readObject=()=>{throw new Error('unexpected');};
    expect(rehearseContentRecovery(s.port,binding,owner,{readObject}).contentVerified).toBe(false);
    expect(()=>rehearseContentRecovery(s.port,binding,writer,{readObject})).toThrow('RECOVERY_OWNER_REQUIRED');
  });
});
