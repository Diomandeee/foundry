import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {canonical,identifier,integer,hash,record,boundedBytes} from '../../../packages/library-jobs/src/data';
import {createOnlineStorageBroker,validateGrant,grantRevocationBinding,HARD_LIMITS,type ReadGrant,type ObjectRef,type RevokeGrantCommand,type CurrentAuthorization} from '../../../packages/storage-broker/src/index';
import type {GrantScope,PublicationReservation,TrustedWriter,TrustedGrantIssuer,TrustedPublicationCapacity} from '../../../packages/build-storage/src/types';
import {brokerHandler,type BrokerHost} from './index';
import {ref as validateBuildRef} from '../../../packages/build-jobs/src/validation';
import {createBuildAccessClient,type BuildAccessConfig,type BuildAccessExpectation} from './build-online';

/** One immutable, explicitly approved durable namespace. No automatic namespace
 * creation/rollover, credential cloning, budget reset, or environment fallback. */
export interface BuildNamespaceApproval {
  version:1;namespaceRef:string;scope:GrantScope;profileHash:string;policyVersion:string;
  intentId:string;authorizationGeneration:number;expiresAt:number;
  publication:boolean;approvedObjects:ObjectRef[];
}
export interface BuildBrokerConfig {
  environment:string;authorityId:string;ownerPrincipal:string;approval:BuildNamespaceApproval;
  /** Distinct owner-provisioned durable databases; never ephemeral or shared replicas. */
  controlDb:DatabaseSync;brokerDb:DatabaseSync;
  now():number;access:BuildAccessConfig;
  authConfig():string;enabled():boolean;
  providerRead(ref:ObjectRef,maxBytes:number,signal:AbortSignal):Promise<{ref:ObjectRef;bytes:Uint8Array}>;
  providerWriter:TrustedWriter;
}
const need=(v:unknown,code:string):void=>{if(!v)throw new Error('build-broker: '+code);};
const copy=<T>(v:T):T=>JSON.parse(canonical(v));
const digest=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
const ddl=`
CREATE TABLE host_binding(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL) STRICT;
CREATE TABLE host_clock(id INTEGER PRIMARY KEY CHECK(id=1),at_ms INTEGER NOT NULL) STRICT;
CREATE TABLE host_reservations(id TEXT PRIMARY KEY,operation_key TEXT UNIQUE NOT NULL,need TEXT NOT NULL,body TEXT NOT NULL) STRICT;
CREATE TABLE host_objects(id TEXT PRIMARY KEY,reservation_id TEXT NOT NULL,kind TEXT NOT NULL,digest TEXT NOT NULL,size INTEGER NOT NULL,ref TEXT) STRICT;
CREATE TABLE host_grants(id TEXT PRIMARY KEY,object_id TEXT UNIQUE NOT NULL,body TEXT NOT NULL,issued INTEGER NOT NULL CHECK(issued IN(0,1))) STRICT;
CREATE TABLE host_denied(id TEXT PRIMARY KEY,body TEXT NOT NULL) STRICT;
CREATE TABLE host_revocations(id TEXT PRIMARY KEY,grant_id TEXT NOT NULL,command TEXT NOT NULL,delivered INTEGER NOT NULL CHECK(delivered IN(0,1))) STRICT;
CREATE TABLE host_reconcile(id INTEGER PRIMARY KEY CHECK(id=1),sequence INTEGER NOT NULL,body TEXT NOT NULL) STRICT;
CREATE TRIGGER clock_monotonic BEFORE UPDATE ON host_clock WHEN NEW.id!=OLD.id OR NEW.at_ms<OLD.at_ms BEGIN SELECT RAISE(ABORT,'clock regression'); END;
CREATE TRIGGER object_seal BEFORE UPDATE ON host_objects WHEN NEW.id!=OLD.id OR NEW.reservation_id!=OLD.reservation_id OR NEW.kind!=OLD.kind OR NEW.digest!=OLD.digest OR NEW.size!=OLD.size OR OLD.ref IS NOT NULL OR NEW.ref IS NULL BEGIN SELECT RAISE(ABORT,'object immutable'); END;
CREATE TRIGGER grant_seal BEFORE UPDATE ON host_grants WHEN NEW.id!=OLD.id OR NEW.object_id!=OLD.object_id OR NEW.body!=OLD.body OR OLD.issued!=0 OR NEW.issued!=1 BEGIN SELECT RAISE(ABORT,'grant immutable'); END;
CREATE TRIGGER revoke_seal BEFORE UPDATE ON host_revocations WHEN NEW.id!=OLD.id OR NEW.grant_id!=OLD.grant_id OR NEW.command!=OLD.command OR OLD.delivered!=0 OR NEW.delivered!=1 BEGIN SELECT RAISE(ABORT,'revocation immutable'); END;
CREATE TRIGGER reconcile_forward BEFORE UPDATE ON host_reconcile WHEN NEW.id!=OLD.id OR NEW.sequence!=OLD.sequence+1 BEGIN SELECT RAISE(ABORT,'reconcile sequence'); END;
`+['host_binding','host_clock','host_reservations','host_objects','host_grants','host_denied','host_revocations','host_reconcile'].map(t=>`
CREATE TRIGGER ${t}_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT,'retained history'); END;
CREATE TRIGGER ${t}_replace BEFORE INSERT ON ${t} WHEN EXISTS(SELECT 1 FROM ${t} WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'retained identity'); END;
${['host_binding','host_reservations','host_denied'].includes(t)?`CREATE TRIGGER ${t}_update BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT,'immutable'); END;`:''}`).join('');

/** Construction opens no service, resolves no credential and makes no provider call.
 * The supplied DB handles are initialized only on explicit trusted host construction.
 * Every public member below is HOST ONLY except the authenticated request handler. */
export function createBuildBrokerHost(config:BuildBrokerConfig){
  need(config.controlDb!==config.brokerDb,'distinct-databases-required');
  const approval=copy(config.approval),db=config.controlDb;
  record(approval,['version','namespaceRef','scope','profileHash','policyVersion','intentId','authorizationGeneration','expiresAt','publication','approvedObjects']);
  need(approval.version===1&&typeof approval.publication==='boolean','approval-shape');
  for(const id of [config.environment,config.authorityId,config.ownerPrincipal,approval.namespaceRef,approval.policyVersion,approval.intentId])identifier(id);
  hash(approval.profileHash);integer(approval.authorizationGeneration,Number.MAX_SAFE_INTEGER,1);integer(approval.expiresAt);
  need(approval.scope.namespaceRef===approval.namespaceRef&&approval.scope.compute.authorityId===config.authorityId,'approval-authority');
  need(config.access.environment===config.environment&&config.access.authorityId===config.authorityId,'access-authority');
  const validateRef=(ref:ObjectRef)=>{validateBuildRef(ref);need(ref.projectId===approval.scope.projectId,'object-project');};
  record(approval.scope,['projectId','principalRef','compute','namespaceRef']);
  identifier(approval.scope.projectId);identifier(approval.scope.principalRef);
  need(Array.isArray(approval.approvedObjects)&&approval.approvedObjects.length<=32,'approved-object-budget');
  for(const ref of approval.approvedObjects)validateRef(ref);
  // Validate compute even for a publication namespace with no initial objects.
  record(approval.scope.compute,['authorityId','workloadId','leaseId','epoch','generation','attemptId','capabilityDigest','workerId','incarnation']);
  for(const k of ['authorityId','workloadId','leaseId','attemptId','workerId'] as const)identifier(approval.scope.compute[k]);
  for(const k of ['epoch','generation','incarnation'] as const)integer(approval.scope.compute[k],Number.MAX_SAFE_INTEGER,k==='epoch'?1:0);
  hash(approval.scope.compute.capabilityDigest);
  const binding=canonical({version:1,environment:config.environment,authorityId:config.authorityId,ownerPrincipal:config.ownerPrincipal,approval});
  const one=(sql:string,...args:(string|number)[])=>db.prepare(sql).get(...args) as Record<string,any>|undefined;
  const transaction=<T>(fn:()=>T):T=>{db.exec('BEGIN IMMEDIATE');try{const v=fn();db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}};
  const schema=(d:DatabaseSync)=>canonical(d.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all());
  const reference=new DatabaseSync(':memory:');let expected:string;try{reference.exec(ddl);expected=schema(reference);}finally{reference.close();}
  const empty=one('SELECT count(*) n FROM sqlite_schema')!.n===0;
  if(!empty){need(schema(db)===expected&&one('SELECT body FROM host_binding WHERE id=1')?.body===binding,'recovery-binding');need(one('PRAGMA quick_check')?.quick_check==='ok','recovery-integrity');}
  db.exec('PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON; PRAGMA busy_timeout=50;');
  if(empty)transaction(()=>{db.exec(ddl);db.prepare('INSERT INTO host_binding VALUES(1,?)').run(binding);db.exec('INSERT INTO host_clock VALUES(1,0)');db.exec("INSERT INTO host_reconcile VALUES(1,0,'{}')");});
  function now(){const t=config.now();integer(t);need(t>=one('SELECT at_ms FROM host_clock WHERE id=1')!.at_ms,'clock-regression');db.prepare('UPDATE host_clock SET at_ms=? WHERE id=1').run(t);return t;}
  function active(){need(config.enabled()===true&&approval.expiresAt>now(),'host-disabled-or-expired');}
  function local(grant:ReadGrant):CurrentAuthorization{
    active();validateGrant(grant);
    need(!one('SELECT id FROM host_denied WHERE id=?',grant.grantId),'revoked');
    need(one('SELECT body FROM host_grants WHERE id=?',grant.grantId)?.body===canonical(grant),'grant-intent-binding');
    const t=now();need(grant.expiresAt>t,'grant-expired');
    return {grant,status:'authorized',revoked:false,observedAt:t,expiresAt:Math.min(grant.expiresAt,approval.expiresAt)};
  }
  const inspect=createBuildAccessClient(config.access);
  const expectation=(object:ObjectRef|null):BuildAccessExpectation=>({projectId:approval.scope.projectId,policyHash:approval.profileHash,compute:approval.scope.compute,object});
  let broker:ReturnType<typeof createOnlineStorageBroker>;
  /** Durable local deny precedes delivery to broker DB. If the second transaction
   * fails, all local read/issue paths already deny; retry retains the same command. */
  function revoke(command:RevokeGrantCommand){
    const c=copy(command);record(c,['key','grantId','expectedBinding','evidenceId','reason']);
    for(const value of [c.key,c.grantId,c.evidenceId,c.reason])identifier(value);
    const row=one('SELECT body FROM host_grants WHERE id=?',c.grantId);need(row,'unknown-grant');
    const grant=validateGrant(JSON.parse(row!.body));need(canonical(grantRevocationBinding(grant))===canonical(c.expectedBinding),'revocation-binding');
    transaction(()=>{
      const old=one('SELECT command FROM host_revocations WHERE id=?',c.key);
      if(old){need(old.command===canonical(c),'revocation-key-conflict');return;}
      const first=!one('SELECT id FROM host_denied WHERE id=?',c.grantId);
      need(one('SELECT count(*) n FROM host_revocations')!.n<128||first,'revocation-journal-capacity');
      if(first)db.prepare('INSERT INTO host_denied VALUES(?,?)').run(c.grantId,canonical(c));
      db.prepare('INSERT INTO host_revocations VALUES(?,?,?,0)').run(c.key,c.grantId,canonical(c));
    });
    const receipt=broker.admin.revokeGrant(c);
    if(!one('SELECT delivered FROM host_revocations WHERE id=?',c.key)!.delivered)db.prepare('UPDATE host_revocations SET delivered=1 WHERE id=?').run(c.key);
    return receipt;
  }
  function deny(grant:ReadGrant,evidenceId:string){return revoke({key:digest({grant:grant.grantId,evidenceId}),grantId:grant.grantId,expectedBinding:grantRevocationBinding(grant),evidenceId,reason:'build-authority-denied'});}
  async function authorize(grant:ReadGrant,signal:AbortSignal){
    local(grant);const decision=await inspect(expectation(grant.object),signal);local(grant);
    if(!decision.authorized){if(decision.permanentlyRevoked)deny(grant,decision.evidenceHash);throw new Error('build-broker: compute-currently-denied');}
  }
  broker=createOnlineStorageBroker({db:config.brokerDb,namespaceId:approval.namespaceRef,binding:{environment:config.environment,authorityId:config.authorityId},now,
    observeLocal:local,authorizeRemote:authorize,readObject:config.providerRead});
  const grantLookup=(id:string)=>{identifier(id);const row=one('SELECT body,issued FROM host_grants WHERE id=?',id);need(row?.issued===1,'unissued-grant');return validateGrant(JSON.parse(row!.body));};
  const host:BrokerHost={environment:config.environment,authorityId:config.authorityId,ownerPrincipal:config.ownerPrincipal,
    get authConfig(){return config.authConfig();},get enabled(){return config.enabled();},read:(principal,request,signal)=>broker.reader.read(principal,request,signal),broker:{reader:{read:(principal,request)=>broker.reader.read(principal,request,new AbortController().signal)},admin:{revokeGrant:revoke}},
    grant:grantLookup,refresh:async(grant,signal)=>authorize(grant,signal)};
  let operations=0;
  const scopeMatches=(scope:GrantScope)=>need(canonical(scope)===canonical(approval.scope),'namespace-scope');
  const reservationCurrent=(r:PublicationReservation)=>{active();need(one('SELECT body FROM host_reservations WHERE id=?',r.reservationId)?.body===canonical(r),'reservation-binding');};
  const capacity:TrustedPublicationCapacity={
    reserve:async(needInput,signal,operationKey)=>{
      active();need(!signal.aborted&&operations===0,'reservation-busy');
      hash(operationKey);
      const n=copy(needInput);record(n,['projectId','namespaceRef','artifacts','bytes']);
      need(n.projectId===approval.scope.projectId&&n.namespaceRef===approval.namespaceRef,'reservation-scope');integer(n.artifacts,32,1);integer(n.bytes,8*1048576,1);
      const check=await inspect(expectation(null),signal);active();need(check.authorized&&!signal.aborted&&operations===0,'reservation-compute');
      const receipt=transaction(()=>{
        const old=one('SELECT need,body FROM host_reservations WHERE operation_key=?',operationKey!);
        if(old){need(old.need===canonical(n),'reservation-key-conflict');return JSON.parse(old.body) as PublicationReservation;}
        const totals=db.prepare('SELECT body FROM host_reservations').all() as Array<{body:string}>;
        const used=totals.reduce((a,r)=>{const b=JSON.parse(r.body);return {artifacts:a.artifacts+b.artifacts,bytes:a.bytes+b.bytes};},{artifacts:0,bytes:0});
        need(used.artifacts+n.artifacts<=32&&used.bytes+n.bytes<=8*1048576,'namespace-capacity-exhausted');
        const value={...n,reservationId:randomUUID()};db.prepare('INSERT INTO host_reservations VALUES(?,?,?,?)').run(value.reservationId,operationKey!,canonical(n),canonical(value));return value;
      });return copy(receipt);
    },
    assertCurrent:async(receipt,signal)=>{const r=copy(receipt);reservationCurrent(r);const observed=await inspect(expectation(null),signal);reservationCurrent(r);need(observed.authorized&&!signal.aborted,'reservation-fenced');},
  };
  const objectId=(kind:string,sha256:string)=>digest({kind,sha256});
  function charge(kind:'objects'|'manifests',sha256:string,size:number,reservation:PublicationReservation|undefined){
    active();need(reservation,'explicit-reservation-required');const r=copy(reservation!);reservationCurrent(r);
    const id=objectId(kind,sha256),existing=one('SELECT * FROM host_objects WHERE id=?',id);
    if(existing){need(existing.size===size,'content-identity');return existing;}
    return transaction(()=>{
      const usage=one('SELECT count(*) n,coalesce(sum(size),0) bytes FROM host_objects WHERE reservation_id=?',r.reservationId)!;
      need(usage.n+1<=r.artifacts&&usage.bytes+size<=r.bytes,'reservation-capacity');
      need(one('SELECT count(*) n FROM host_objects')!.n<32,'namespace-object-capacity');
      db.prepare('INSERT INTO host_objects VALUES(?,?,?,?,?,NULL)').run(id,r.reservationId,kind,sha256,size);
      return one('SELECT * FROM host_objects WHERE id=?',id)!;
    });
  }
  const writer:TrustedWriter={write:async(projectId,kind,bytes,signal,reservation)=>{
    active();need(approval.publication&&projectId===approval.scope.projectId&&!signal.aborted&&operations===0,'publication-denied');
    const immutable=boundedBytes(bytes,1048576);integer(immutable.length,1048576,1);need(kind==='objects'||kind==='manifests','object-kind');
    const sha256=createHash('sha256').update(immutable).digest('hex'),row=charge(kind,sha256,immutable.length,reservation);operations++;
    try{
      const decision=await inspect(expectation(null),signal);active();need(decision.authorized&&!signal.aborted,'publication-compute');
      // ProviderWriter must perform create-only, pinned-generation byte readback.
      const ref=copy(await config.providerWriter.write(projectId,kind,immutable,signal));validateRef(ref);active();
      need(!signal.aborted&&ref.objectKey===`projects/${projectId}/${kind}/${sha256}`&&ref.sha256===sha256&&ref.sizeBytes===immutable.length,'publication-byte-binding');
      const after=await inspect(expectation(ref),signal);active();need(after.authorized&&!signal.aborted,'publication-fenced');
      const old=one('SELECT ref FROM host_objects WHERE id=?',row.id)!;
      if(old.ref)need(old.ref===canonical(ref),'immutable-generation-conflict');else db.prepare('UPDATE host_objects SET ref=? WHERE id=?').run(canonical(ref),row.id);
      return ref;
    }finally{operations--;}
  }};
  const issuer:TrustedGrantIssuer={now,issue:async(input,scope,signal,reservation)=>{
    active();scopeMatches(scope);need(!signal.aborted&&operations===0,'issuer-busy');
    const ref=copy(input);validateRef(ref);const kind=ref.objectKey.includes('/manifests/')?'manifests':'objects';
    const object=charge(kind,ref.sha256,ref.sizeBytes,reservation);
    need(object.ref===canonical(ref)||approval.approvedObjects.some(o=>canonical(o)===canonical(ref)),'object-not-approved-or-published');
    operations++;
    try{
      let row=one('SELECT body FROM host_grants WHERE object_id=?',object.id);
      if(!row){
        const t=now(),grant:ReadGrant={version:1,grantId:randomUUID(),principalRef:scope.principalRef,projectId:scope.projectId,policyVersion:approval.policyVersion,
          policyHash:approval.profileHash,intentId:approval.intentId,authorizationGeneration:approval.authorizationGeneration,compute:copy(scope.compute),operation:'GET',object:ref,byteBudget:ref.sizeBytes,expiresAt:Math.min(approval.expiresAt,t+HARD_LIMITS.maxGrantLifetimeMs)};
        validateGrant(grant);db.prepare('INSERT INTO host_grants VALUES(?,?,?,0)').run(grant.grantId,object.id,canonical(grant));row={body:canonical(grant)};
      }
      const grant=validateGrant(JSON.parse(row!.body));need(canonical(grant.object)===canonical(ref),'grant-object-conflict');local(grant);
      const issued=await broker.admin.issue(grant,signal);need(!signal.aborted,'issuance-interrupted');local(issued);
      if(!one('SELECT issued FROM host_grants WHERE id=?',issued.grantId)!.issued)db.prepare('UPDATE host_grants SET issued=1 WHERE id=?').run(issued.grantId);
      return issued;
    }finally{operations--;}
  },observeCurrent:async(grant,signal)=>{await authorize(grant,signal);return local(grant);}};
  let reconciling=false;
  /** Explicit bounded sweep, not a daemon. Online reads do NOT depend on sweep
   * freshness. Negative authenticated observations produce durable deny+delivery;
   * network failures preserve uncertainty and never become false revocations. */
  async function reconcileOnce(signal:AbortSignal){
    active();need(!reconciling&&!signal.aborted,'reconciler-busy');reconciling=true;
    let observed=0,revoked=0,pending=0;const sequence=one('SELECT sequence FROM host_reconcile WHERE id=1')!.sequence+1;
    try{
      const deliveries=db.prepare('SELECT command FROM host_revocations WHERE delivered=0 ORDER BY id LIMIT 161').all() as Array<{command:string}>;
      need(deliveries.length<=160,'delivery-bound');
      for(const delivery of deliveries){if(signal.aborted)throw new Error('build-broker: reconciliation-interrupted');try{revoke(JSON.parse(delivery.command));}catch{pending++;}}
      const rows=db.prepare('SELECT body FROM host_grants ORDER BY id LIMIT 33').all() as Array<{body:string}>;need(rows.length<=32,'grant-bound');
      for(const row of rows){
        if(signal.aborted)throw new Error('build-broker: reconciliation-interrupted');
        const grant=validateGrant(JSON.parse(row.body));const old=one('SELECT id FROM host_denied WHERE id=?',grant.grantId);
        try{if(old){revoked++;continue;}
          const value=await inspect(expectation(grant.object),signal);observed++;
          if(!value.authorized){if(value.permanentlyRevoked){deny(grant,value.evidenceHash);revoked++;}else pending++;}
        }catch{pending++;}
      }
      const receipt={sequence,observed,revoked,pending,at:now(),complete:pending===0&&!signal.aborted};
      db.prepare('UPDATE host_reconcile SET sequence=?,body=? WHERE id=1').run(sequence,canonical(receipt));return receipt;
    }finally{reconciling=false;}
  }
  function admission(artifacts:number,bytes:number){
    active();integer(artifacts,32,1);integer(bytes,8*1048576,1);
    const reservations=db.prepare('SELECT body FROM host_reservations').all() as Array<{body:string}>;
    const used=reservations.reduce((a,row)=>{const r=JSON.parse(row.body);return {artifacts:a.artifacts+r.artifacts,bytes:a.bytes+r.bytes};},{artifacts:0,bytes:0});
    return Object.freeze({eligible:operations===0&&used.artifacts+artifacts<=32&&used.bytes+bytes<=8*1048576,
      reservedArtifacts:used.artifacts,reservedBytes:used.bytes});
  }
  const reservation=(operationKey:string):PublicationReservation|null=>{
    hash(operationKey);const row=one('SELECT id,need,body FROM host_reservations WHERE operation_key=?',operationKey);if(!row)return null;
    const receipt=JSON.parse(row.body) as PublicationReservation;record(receipt,['projectId','namespaceRef','artifacts','bytes','reservationId']);
    identifier(receipt.reservationId);integer(receipt.artifacts,32,1);integer(receipt.bytes,8*1048576,1);
    const {reservationId,...needBody}=receipt;
    need(reservationId===row.id&&receipt.projectId===approval.scope.projectId&&receipt.namespaceRef===approval.namespaceRef&&canonical(needBody)===row.need,'reservation-history-corrupt');
    return receipt;
  };
  const isActive=()=>{const time=now();return config.enabled()===true&&approval.expiresAt>time;};
  const allowsRef=(ref:ObjectRef)=>{active();validateRef(ref);const kind=ref.objectKey.includes('/manifests/')?'manifests':'objects';return approval.approvedObjects.some(o=>canonical(o)===canonical(ref))||one('SELECT ref FROM host_objects WHERE id=?',objectId(kind,ref.sha256))?.ref===canonical(ref);};
  return Object.freeze({scope:copy(approval.scope),reservation,isActive,allowsRef,handler:brokerHandler(host),writer,issuer,capacity,reconcileOnce,admission,
    reader:Object.freeze({readArtifact:async(claim:{grantId:string;ref:ObjectRef},scope:GrantScope,signal:AbortSignal)=>{
      scopeMatches(scope);need(!signal.aborted,'read-aborted');const grant=grantLookup(claim.grantId);need(canonical(grant.object)===canonical(claim.ref),'read-reference');
      const bytes=await broker.reader.read(scope.principalRef,{grantId:grant.grantId,requestId:digest({grantId:grant.grantId,object:grant.object})},signal);need(!signal.aborted,'read-aborted');return {ref:grant.object,bytes};
    }}),
  });
}
