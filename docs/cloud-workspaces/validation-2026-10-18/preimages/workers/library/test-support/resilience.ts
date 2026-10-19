import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import {createStorageBroker,type ReadGrant} from '../../../packages/storage-broker/src/index';
import {brokerHandler} from '../../library-broker/src/index';
import {RevocationRelay,type RevocationContext,type RevocationTarget,type TransactionPort} from '../../../packages/library-revocation/src/index';
import {relayHttp,relayStep} from '../../../packages/library-revocation/src/http';
import type {RecoveryChallenge,RecoveryProof} from '../src/recovery-guard';
import {reconcilerHttp} from '../../../packages/library-checkpoint/src/http';
import {manifestBytes} from '../../../packages/library-jobs/src/index';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
export const token=(name:string)=>`fixture-resilience-${name}-000000000000000000000000000000`;
const sha=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const auth=JSON.stringify(['owner','writer','verifier','worker'].map(principal=>({principal,role:principal==='writer'?'submitter':principal==='worker'?'executor':principal,environment:'local',tokenSha256:sha(token(principal))})));
const fixture=`
 import compute from './workers/compute/src/index.ts';import {ComputeAuthority} from './workers/compute/src/authority.ts';
 import library from './workers/library/src/index.ts';import {LibraryAuthority} from './workers/library/src/authority.ts';
 const auth=${JSON.stringify(auth)};
 const cc={COMPUTE_ENVIRONMENT:'local',COMPUTE_AUTHORITY_NAME:'compute',COMPUTE_ISSUER_ID:'fixture',COMPUTE_ISSUER_KEY:'fixture-only-never-production-00000000000000000000',COMPUTE_AUTH_CONFIG:auth,COMPUTE_TRANSPORT_ENABLED:'true'};
 const lc={LIBRARY_ENVIRONMENT:'local',LIBRARY_AUTHORITY_NAME:'catalog',LIBRARY_TRANSPORT_ENABLED:'true',LIBRARY_AUTH_CONFIG:auth,LIBRARY_PROJECTS:JSON.stringify([{projectId:'project-a',policyVersion:'v1',ownerPrincipal:'owner',writerPrincipal:'writer',verifierPrincipal:'verifier'}])};
 export class ResilientCompute extends ComputeAuthority {constructor(ctx,env){super(ctx,{...env,...cc},{now:()=>1000000});this.fixtureState=ctx;}fetch(request){if(new URL(request.url).pathname==='/__test/outbox')return Response.json([...this.fixtureState.storage.sql.exec('SELECT * FROM outbox ORDER BY seq')]);return super.fetch(request);}}
 export class ResilientLibrary extends LibraryAuthority {constructor(ctx,env){super(ctx,{...env,...lc},{now:()=>1000000,...(env.RECOVERY_HOST?{reconcileRecovery:async(challenge,signal)=>{const response=await env.RECOVERY_HOST.fetch(new Request('https://recovery.fixture',{method:'POST',body:JSON.stringify(challenge),signal}));if(response.status!==200)throw new Error('fixture reconciler failed');return response.json();}}:{})});}}
 export default {fetch(request,env){return new URL(request.url).pathname.startsWith('/v1/library/project-a/')?library.fetch(request,{...env,...lc}):compute.fetch(request,{...env,...cc});}};
`;
async function runtime(path:string,reconcile?: (challenge:RecoveryChallenge,signal:AbortSignal)=>Promise<RecoveryProof>){
 const bundle=await build({stdin:{contents:fixture,resolveDir:root,sourcefile:'library-resilience-fixture.ts',loader:'ts'},bundle:true,write:false,format:'esm',platform:'neutral',target:'es2022',external:['node:*','cloudflare:*'],logLevel:'silent'});
 const options=convertV4MiniflareOptions({name:'foundry-library-resilience',...(reconcile?{serviceBindings:{RECOVERY_HOST:async(request:Request)=>{try{return Response.json(await reconcile(await request.json() as RecoveryChallenge,request.signal));}catch{return Response.json({ok:false},{status:503});}}}}:{}),modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-05',compatibilityFlags:['nodejs_compat'],durableObjects:{AUTHORITY:{className:'ResilientCompute',useSQLite:true},LIBRARY_CATALOG:{className:'ResilientLibrary',useSQLite:true}},logRequests:false});
 for(const worker of options.workers)worker.dev={...worker.dev,unsafeRegisterWorker:false};
 return new Miniflare({...options,resourcePersistencePath:path,telemetry:{enabled:false}});
}
export class ResilienceFixture {
 private mf!:Miniflare;private catalogMf?:Miniflare;private relayDb!:DatabaseSync;private brokerDb!:DatabaseSync;private serial=0;
 recoveryHost?: (challenge:RecoveryChallenge,signal:AbortSignal)=>Promise<RecoveryProof>;
 clock=1000000;relay!:RevocationRelay;broker!:ReturnType<typeof createStorageBroker>;brokerHttp!:ReturnType<typeof brokerHandler>;http!:ReturnType<typeof relayHttp>;
 readonly owner:RevocationContext={environment:'local',principal:'relay-owner',role:'owner'};
 readonly dispatcher:RevocationContext={environment:'local',principal:'relay-dispatcher',role:'dispatcher'};
 sourceId='';catalogId='';binding:any;private capability='';grant!:ReadGrant;reads=0;loseCatalogReply=false;sourceOffline=false;duringRead?:()=>Promise<void>;
 private observation:unknown;private objects=new Map<string,{ref:any;bytes:Uint8Array}>();
 private constructor(readonly directory:string){}
 static async create(){const h=new ResilienceFixture(await mkdtemp(join(tmpdir(),'foundry-library-resilience-')));h.mf=await runtime(h.directory);await h.seed();h.openRelay();h.openBroker();h.configureTransport();return h;}
 private port():TransactionPort{let depth=0;return {sql:{exec:(query,...params)=>this.relayDb.prepare(query).all(...params) as any},transactionSync:fn=>{if(depth)return fn();this.relayDb.exec('BEGIN IMMEDIATE');depth++;try{const value=fn();this.relayDb.exec('COMMIT');return value;}catch(e){this.relayDb.exec('ROLLBACK');throw e;}finally{depth--;}}};}
 private openRelay(){this.relayDb=new DatabaseSync(join(this.directory,'relay.sqlite'));this.relay=new RevocationRelay(this.port(),{environment:'local',authorityId:'relay',sourceAuthorityId:this.sourceId,ownerPrincipal:'relay-owner',dispatcherPrincipal:'relay-dispatcher',now:()=>this.clock});}
 private openBroker(){
  this.brokerDb=new DatabaseSync(join(this.directory,'broker.sqlite'));
  this.broker=createStorageBroker({db:this.brokerDb,binding:{environment:'local',authorityId:'broker'},now:()=>this.clock,observeCurrent:()=>this.observation,readObject:async(ref)=>{this.reads++;await this.duringRead?.();await this.refresh(this.grant);const found=this.objects.get(ref.objectKey);if(!found)throw new Error('fixture absent');return found;}});
  this.brokerHttp=brokerHandler({enabled:true,environment:'local',authorityId:'broker',ownerPrincipal:'owner',authConfig:auth,broker:this.broker,grant:id=>{if(id!==this.grant.grantId)throw new Error('fixture grant missing');return this.grant;},refresh:g=>this.refresh(g)});
 }
 private configureTransport(){this.http=relayHttp({enabled:true,environment:'local',sourceAuthorityId:this.sourceId,compute:{origin:'https://compute.local',credentialRef:'compute-owner'},targets:[{origin:'https://library.local',credentialRef:'library-owner',kind:'catalog',projectId:'project-a',authorityId:this.catalogId},{origin:'https://broker.local',credentialRef:'broker-owner',kind:'broker',projectId:'project-a',authorityId:'broker'}]},
  {credential:async()=>token('owner'),fetch:async request=>{
   if(request.url.startsWith('https://compute.local')&&this.sourceOffline)throw new Error('fixture source offline');
   if(request.url.startsWith('https://broker.local'))return this.brokerHttp(request);
   const service=request.url.includes('/v1/library/project-a/')&&this.catalogMf?this.catalogMf:this.mf;
   const response=await service.dispatchFetch(request.url,{method:request.method,headers:[...request.headers],body:await request.text()});
   if(this.loseCatalogReply&&request.url.endsWith('/revocations')){this.loseCatalogReply=false;throw new Error('fixture response loss');}return new Response(await response.arrayBuffer(),{status:response.status,headers:[...response.headers]});
  }});}
 async req(path:string,body:unknown={},identity='owner'){
  const service=path.startsWith('/v1/library/project-a/')&&this.catalogMf?this.catalogMf:this.mf;
  const response=await service.dispatchFetch('https://compute.local'+path,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token(identity)},body:JSON.stringify(body)});
  return {status:response.status,body:await response.json() as any};
 }
 async command(operation:string,body:unknown,identity='owner'){return this.req('/v1/commands',{expectedEpoch:1,command:{key:'command-'+ ++this.serial,operation,body}},identity);}
 async library(operation:string,body:unknown,identity='writer',key='library-'+ ++this.serial){return this.req('/v1/library/project-a/commands',{operation,key,body},identity);}
 private async seed(){
  this.sourceId=(await this.req('/v1/status')).body.authorityId;this.catalogId=(await this.req('/v1/library/project-a/snapshot')).body.authorityId;
  await this.command('registerWorker',{workerId:'mac',principal:'worker',workerClass:'general',cpu:2,ramMib:256,devices:[]});
  await this.command('setQuota',{principal:'writer',maxActive:4,allowedClass:'general'});
  await this.command('submit',{workloadId:'job',specification:'fixture-library-read',resources:{cpu:1,ramMib:128},policy:{sha256:sha('fixture-verified-result'),maxBytes:1024,exitCode:0},pure:true,reconstructible:true,maxAttempts:3},'writer');
  const claimed=await this.command('claim',{workloadId:'job',workerId:'mac',expectedGeneration:0,incarnation:0,ttlMs:60000},'worker');if(!claimed.body.ok)throw new Error('fixture claim failed');
  const l=claimed.body.lease;this.capability=l.capability;const data=new TextEncoder().encode('fixture immutable bytes');
  const object={projectId:'project-a',objectKey:`projects/project-a/objects/${sha(data)}`,generation:'1',sha256:sha(data),sizeBytes:data.length};
  const bytes=manifestBytes({version:1,projectId:'project-a',objects:[object]}),ref={projectId:'project-a',objectKey:`projects/project-a/manifests/${sha(bytes)}`,generation:'2',sha256:sha(bytes),sizeBytes:bytes.length};
  this.objects.set(object.objectKey,{ref:object,bytes:data});this.objects.set(ref.objectKey,{ref,bytes});
  const compute={authorityId:this.sourceId,workloadId:l.workload_id,leaseId:l.id,attemptId:l.id,capabilityDigest:sha(l.capability),workerId:l.worker_id,epoch:l.epoch,generation:l.generation,incarnation:l.incarnation};
  this.binding={projectId:'project-a',policyVersion:'v1',policyHash:'b'.repeat(64),compute,content:{manifestHash:ref.sha256,objectKey:ref.objectKey,objectGeneration:ref.generation,objectHash:ref.sha256,bytes:ref.sizeBytes}};
  this.grant={version:1,grantId:'grant',principalRef:'worker',projectId:'project-a',policyVersion:'v1',policyHash:'b'.repeat(64),intentId:'transfer',authorizationGeneration:1,compute,operation:'GET',object:ref,byteBudget:ref.sizeBytes*2,expiresAt:1010000};
  const staged=await this.library('stageTransfer',{version:1,intentId:'transfer',binding:this.binding,expiresAt:1010000});if(staged.status!==200)throw new Error('fixture stage failed');
 }
 async refresh(g:ReadGrant){
  const c=(await this.req('/v1/library/fence',{expectedEpoch:1,binding:g.compute})).body;
  const s=(await this.req('/v1/library/project-a/snapshot')).body;
  const a=s.records?.filter((r:any)=>r.kind==='authorization'&&r.body.intentId===g.intentId).at(-1)?.body;
  const recovery=(await this.req('/v1/library/project-a/recovery-status')).body;
  const valid=recovery.quarantined!==true&&c.current===true&&!s.policyRevoked&&!s.records?.some((r:any)=>r.kind==='cancellation'&&r.id===g.intentId)&&a?.generation===g.authorizationGeneration;
  this.observation={grant:g,status:valid?'authorized':'denied',revoked:!valid,observedAt:this.clock,expiresAt:Math.min(g.expiresAt,c.expiresAt??0,a?.expiresAt??0)};
 }
 async issue(){await this.refresh(this.grant);this.broker.admin.issue(this.grant);}
 register(){for(const kind of ['catalog','broker'] as const){const target:RevocationTarget={version:1,targetId:'target-'+kind,kind,environment:'local',authorityId:kind==='catalog'?this.catalogId:'broker',projectId:'project-a',resourceId:kind==='catalog'?'transfer':'grant',generation:1,binding:this.binding};this.relay.register(this.owner,target);}}
 async read(requestId='read'){return this.brokerHttp(new Request('https://broker.local/v1/broker/read',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token('worker')},body:JSON.stringify({grantId:'grant',requestId})}));}
 async complete(){const c=this.binding.compute;const sealed=await this.req('/v1/artifacts',{expectedEpoch:1,key:'verified-fixture-bytes',fence:{leaseId:c.leaseId,epoch:c.epoch,generation:c.generation,incarnation:c.incarnation,capability:this.capability},bytesBase64:Buffer.from('fixture-verified-result').toString('base64'),exitCode:0},'worker');if(sealed.status!==200)throw new Error('fixture seal failed');return this.req('/v1/verify',{expectedEpoch:1,request:{key:'independent-fixture-verifier',leaseId:c.leaseId,epoch:c.epoch,generation:c.generation,incarnation:c.incarnation}},'verifier');}
 async sibling(){
  await this.command('submit',{workloadId:'job-sibling',specification:'fixture-library-read',resources:{cpu:1,ramMib:128},policy:{sha256:sha('fixture-verified-result'),maxBytes:1024,exitCode:0},pure:true,reconstructible:true,maxAttempts:3},'writer');
  const result=await this.command('claim',{workloadId:'job-sibling',workerId:'mac',expectedGeneration:0,incarnation:0,ttlMs:60000},'worker');if(!result.body.ok)throw new Error('sibling claim failed');const l=result.body.lease;return {authorityId:this.sourceId,workloadId:l.workload_id,leaseId:l.id,attemptId:l.id,capabilityDigest:sha(l.capability),workerId:l.worker_id,epoch:l.epoch,generation:l.generation,incarnation:l.incarnation};
 }
 async replacement(){
  await this.command('registerWorker',{workerId:'replacement',principal:'worker',workerClass:'general',cpu:1,ramMib:128,devices:[]});
  await this.command('submit',{workloadId:'job-next',specification:'fixture-library-read',resources:{cpu:1,ramMib:128},policy:{sha256:sha('fixture-verified-result'),maxBytes:1024,exitCode:0},pure:true,reconstructible:true,maxAttempts:3},'writer');
  const result=await this.command('claim',{workloadId:'job-next',workerId:'replacement',expectedGeneration:0,incarnation:0,ttlMs:60000},'worker');if(!result.body.ok)throw new Error('replacement claim failed');const l=result.body.lease;return {authorityId:this.sourceId,workloadId:l.workload_id,leaseId:l.id,attemptId:l.id,capabilityDigest:sha(l.capability),workerId:l.worker_id,epoch:l.epoch,generation:l.generation,incarnation:l.incarnation};
 }
 cancel(){return this.command('cancel',{workloadId:'job',expectedGeneration:0});}
 step(){return relayStep(this.relay,this.dispatcher,this.http);}
 restartRelay(){this.relayDb.close();this.openRelay();this.configureTransport();}
 async restoreCatalog(archive:string,pin:string){this.catalogMf=await runtime(join(this.directory,'restored-catalog'),this.recoveryHost);const response=await this.catalogMf.dispatchFetch('https://library.local/v1/library/project-a/restore',{method:'POST',headers:{'content-type':'application/vnd.foundry.catalog-recovery+json','x-catalog-archive-sha256':pin,authorization:'Bearer '+token('owner')},body:archive});return {status:response.status,body:await response.json() as any};}
 sourceHttp(){return reconcilerHttp({enabled:true,environment:'local',sourceAuthorityId:this.sourceId,origin:'https://compute.local',credentialRef:'compute-owner'},{credential:async()=>token('owner'),fetch:async request=>{if(this.sourceOffline)throw new Error('fixture source offline');const r=await this.mf.dispatchFetch(request.url,{method:request.method,headers:[...request.headers],body:await request.text()});return new Response(await r.arrayBuffer(),{status:r.status,headers:[...r.headers]});}});}
 async restartRestoredCatalog(){await this.catalogMf!.dispose();this.catalogMf=await runtime(join(this.directory,'restored-catalog'),this.recoveryHost);}
 restartBroker(){this.brokerDb.close();this.openBroker();this.configureTransport();}
 async restartAuthorities(){await this.mf.dispose();this.mf=await runtime(this.directory);}
 async dispose(){await this.mf.dispose();await this.catalogMf?.dispose();this.relayDb.close();this.brokerDb.close();await rm(this.directory,{recursive:true,force:true});}
}
export async function withResilience(fn:(h:ResilienceFixture)=>Promise<void>){const h=await ResilienceFixture.create();try{await fn(h);}finally{await h.dispose();}}
