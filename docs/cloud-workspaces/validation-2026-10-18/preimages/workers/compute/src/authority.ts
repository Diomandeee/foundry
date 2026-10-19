import {BuildAuthority,BuildError,type BuildActor} from '../../../packages/build-jobs/src/index';
import {buildBrokerReader} from '../../../packages/build-jobs/src/broker-reader';
import {readLibraryFences,observeLibraryFence} from './library-feed';
import {readOperatorFeed,readOperatorResult,readOperatorWorkload} from './operator-feed';
import {validateProfile,profileDigest} from '../../../packages/worker-runtime/src/index';
import {executeEventSummaryForWorkload} from '../../../packages/epoch-jobs/src/index';
import {createHash} from 'node:crypto';
import { DurableAuthority } from '../../../packages/compute-authority/src/durable/authority';
import type { CommandEnvelope, TrustedContext, VerificationRequest, TransactionPort } from '../../../packages/compute-authority/src/durable/contracts';
import { ArtifactStore } from './artifact-store';
import { WorkerEnrollment, EnrollmentError, type ExecutorBinding } from '../../../packages/worker-enrollment/src/index';
import { authenticate, credentialDigest, type TransportActor } from './transport-auth';
import { boundedJson, exact, HttpFailure, jsonResponse } from './http';

export interface AuthorityEnvironment {
  COMPUTE_BUILDS_ENABLED?: string;
  BUILD_BROKER_ORIGIN?: string;
  BUILD_BROKER_CREDENTIAL?: string;
  COMPUTE_ENVIRONMENT: string;
  COMPUTE_ISSUER_ID: string;
  COMPUTE_ISSUER_KEY: string;
  COMPUTE_TRANSPORT_ENABLED?: string;
  COMPUTE_ENROLLMENT_ENABLED?: string;
  COMPUTE_EXECUTION_IMAGES?: string;
  COMPUTE_AUTH_CONFIG?: string;
  COMPUTE_AUTHORITY_NAME?: string;
  AUTHORITY?: DurableObjectNamespace;
}
class UploadRejected extends Error { constructor(readonly result:Record<string,unknown>){super('upload-rejected');} }

/** Credentials are verified inside the authority; forwarded client identity is never trusted. */
export class ComputeAuthority {
  private readonly builds?: BuildAuthority;
  private readonly core: DurableAuthority;
  private readonly enrollment?: WorkerEnrollment;
  private readonly artifacts: ArtifactStore;
  private readonly storage: TransactionPort;
  private readonly now:()=>number;
  constructor(private readonly state: DurableObjectState, private readonly env: AuthorityEnvironment, host?:{now?:()=>number}) {
    this.now=host?.now??Date.now;
    if (!env.COMPUTE_ENVIRONMENT || !env.COMPUTE_ISSUER_ID || !env.COMPUTE_ISSUER_KEY) throw new Error('Compute authority bindings are required');
    let depth=0;
    this.storage={
      sql:{exec:(query,...bindings)=>state.storage.sql.exec(query,...bindings)},
      transactionSync: callback => {
        if(depth) return callback();
        return state.storage.transactionSync(()=>{depth++;try{return callback();}finally{depth--;}});
      },
    };
    this.artifacts=this.storage.transactionSync(()=>new ArtifactStore(this.storage.sql));
    this.core=new DurableAuthority(this.storage,{
      environment:env.COMPUTE_ENVIRONMENT,authorityId:state.id.toString(),
      issuerId:env.COMPUTE_ISSUER_ID,issuerKey:env.COMPUTE_ISSUER_KEY,now:host?.now,
      readArtifact:async(reference,maxBytes,scope)=>{
        if(this.artifacts.getMetadata(reference).leaseId!==scope.leaseId)throw new Error('artifact scope mismatch');
        return this.artifacts.read(reference,Math.min(maxBytes,1048576));
      },
    });
    if(env.COMPUTE_ENROLLMENT_ENABLED==='true')this.enrollment=new WorkerEnrollment(this.storage,{environment:env.COMPUTE_ENVIRONMENT,authorityId:state.id.toString(),now:host?.now});
    if(env.COMPUTE_BUILDS_ENABLED==='true'){
      if(!this.enrollment)throw new Error('Build execution requires managed enrollment');
      this.builds=new BuildAuthority(this.storage,env.COMPUTE_ENVIRONMENT,state.id.toString(),{issuerKey:env.COMPUTE_ISSUER_KEY,now:host?.now,...env.BUILD_BROKER_ORIGIN&&env.BUILD_BROKER_CREDENTIAL?{readArtifact:buildBrokerReader(env.BUILD_BROKER_ORIGIN,()=>env.BUILD_BROKER_CREDENTIAL!)}:{}});
    }
    this.storage.transactionSync(()=>{
      const fleetTables=[...this.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('compute_worker_profiles','compute_worker_poll_heads','compute_fleet_meta')")];
      const hasMeta=fleetTables.some(r=>r.name==='compute_fleet_meta');
      if(fleetTables.length&&!hasMeta)throw new Error('fleet schema migration required');
      if(hasMeta){
        const meta=[...this.storage.sql.exec('SELECT * FROM compute_fleet_meta')][0];
        if(fleetTables.length!==3||!meta||meta.schema_version!==1||meta.environment!==env.COMPUTE_ENVIRONMENT||meta.authority!==state.id.toString()||(meta.managed===1&&env.COMPUTE_ENROLLMENT_ENABLED!=='true'))throw new Error('fleet schema binding mismatch');
      }
      this.storage.sql.exec('CREATE TABLE IF NOT EXISTS compute_fleet_meta(id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL,environment TEXT NOT NULL,authority TEXT NOT NULL,managed INTEGER NOT NULL CHECK(managed IN (0,1)))');
      if(!hasMeta)this.storage.sql.exec('INSERT INTO compute_fleet_meta VALUES(1,1,?,?,?)',env.COMPUTE_ENVIRONMENT,state.id.toString(),env.COMPUTE_ENROLLMENT_ENABLED==='true'?1:0);
      else if(env.COMPUTE_ENROLLMENT_ENABLED==='true')this.storage.sql.exec('UPDATE compute_fleet_meta SET managed=1 WHERE id=1');
      this.storage.sql.exec("CREATE TRIGGER IF NOT EXISTS compute_fleet_binding BEFORE UPDATE ON compute_fleet_meta WHEN NEW.schema_version!=OLD.schema_version OR NEW.environment!=OLD.environment OR NEW.authority!=OLD.authority OR NEW.managed<OLD.managed BEGIN SELECT RAISE(ABORT,'immutable fleet binding'); END");
      this.storage.sql.exec("CREATE TRIGGER IF NOT EXISTS compute_fleet_replace BEFORE INSERT ON compute_fleet_meta WHEN EXISTS(SELECT 1 FROM compute_fleet_meta) BEGIN SELECT RAISE(ABORT,'immutable fleet binding'); END");
      this.storage.sql.exec("CREATE TRIGGER IF NOT EXISTS compute_fleet_delete BEFORE DELETE ON compute_fleet_meta BEGIN SELECT RAISE(ABORT,'immutable fleet binding'); END");
      this.storage.sql.exec("CREATE TABLE IF NOT EXISTS compute_worker_profiles(worker_id TEXT NOT NULL,revision INTEGER NOT NULL,profile_hash TEXT NOT NULL,profile TEXT NOT NULL,actor TEXT NOT NULL,approved_ms INTEGER NOT NULL,PRIMARY KEY(worker_id,revision))");
      for(const op of ['UPDATE','DELETE'])this.storage.sql.exec(`CREATE TRIGGER IF NOT EXISTS compute_profiles_${op} BEFORE ${op} ON compute_worker_profiles BEGIN SELECT RAISE(ABORT,'immutable worker profile'); END`);
      this.storage.sql.exec("CREATE TRIGGER IF NOT EXISTS compute_profile_replace BEFORE INSERT ON compute_worker_profiles WHEN EXISTS(SELECT 1 FROM compute_worker_profiles WHERE worker_id=NEW.worker_id AND revision=NEW.revision) BEGIN SELECT RAISE(ABORT,'immutable worker profile'); END");
      this.storage.sql.exec("CREATE TRIGGER IF NOT EXISTS compute_profile_binding BEFORE INSERT ON compute_worker_profiles WHEN NOT EXISTS(SELECT 1 FROM enrollment_credentials WHERE worker_id=NEW.worker_id AND revision=NEW.revision) BEGIN SELECT RAISE(ABORT,'profile credential binding'); END");
      this.storage.sql.exec("CREATE TRIGGER IF NOT EXISTS compute_profile_capacity BEFORE INSERT ON compute_worker_profiles WHEN (SELECT count(*) FROM compute_worker_profiles)>=4096 BEGIN SELECT RAISE(ABORT,'profile capacity'); END");
      this.storage.sql.exec("CREATE TABLE IF NOT EXISTS compute_worker_poll_heads(worker_id TEXT NOT NULL,revision INTEGER NOT NULL,sequence INTEGER NOT NULL CHECK(sequence>0),after_workload TEXT NOT NULL,request_key TEXT NOT NULL,request_hash TEXT NOT NULL,response TEXT NOT NULL CHECK(length(response)<=65536),PRIMARY KEY(worker_id,revision))");
      this.storage.sql.exec("CREATE TRIGGER IF NOT EXISTS compute_poll_head_update BEFORE UPDATE ON compute_worker_poll_heads WHEN NEW.worker_id!=OLD.worker_id OR NEW.revision!=OLD.revision OR NEW.sequence!=OLD.sequence+1 BEGIN SELECT RAISE(ABORT,'poll sequence fence'); END");
      this.storage.sql.exec("CREATE TRIGGER IF NOT EXISTS compute_poll_head_capacity BEFORE INSERT ON compute_worker_poll_heads WHEN NOT EXISTS(SELECT 1 FROM compute_worker_poll_heads WHERE worker_id=NEW.worker_id AND revision=NEW.revision) AND (SELECT count(*) FROM compute_worker_poll_heads)>=4096 BEGIN SELECT RAISE(ABORT,'poll head capacity'); END");
      this.storage.sql.exec('CREATE TABLE IF NOT EXISTS compute_artifact_budgets(workload_id TEXT PRIMARY KEY REFERENCES workloads(id), bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 67108864))');
      this.storage.sql.exec("CREATE TRIGGER IF NOT EXISTS compute_budget_no_update BEFORE UPDATE ON compute_artifact_budgets BEGIN SELECT RAISE(ABORT,'immutable artifact budget'); END");
      this.storage.sql.exec("CREATE TRIGGER IF NOT EXISTS compute_budget_no_delete BEFORE DELETE ON compute_artifact_budgets BEGIN SELECT RAISE(ABORT,'immutable artifact budget'); END");
      this.storage.sql.exec("CREATE TRIGGER IF NOT EXISTS compute_budget_no_replace BEFORE INSERT ON compute_artifact_budgets WHEN EXISTS(SELECT 1 FROM compute_artifact_budgets WHERE workload_id=NEW.workload_id) BEGIN SELECT RAISE(ABORT,'immutable artifact budget'); END");
    });
  }
  private authenticated(request:Request,readOnly=false):TransportActor & {binding?:ExecutorBinding} {
    if(!this.enrollment)return authenticate(request,this.env.COMPUTE_AUTH_CONFIG??'',this.env.COMPUTE_ENVIRONMENT);
    const digest=credentialDigest(request), binding=this.enrollment.authenticateDigest(digest,readOnly);
    const parsed=JSON.parse(this.env.COMPUTE_AUTH_CONFIG??'[]');
    if(!Array.isArray(parsed))throw new Error('Unauthorized');
    const config=binding?[...parsed,{tokenSha256:digest,principal:binding.principal,role:'executor',environment:this.env.COMPUTE_ENVIRONMENT}]:parsed;
    const actor=authenticate(request,JSON.stringify(config),this.env.COMPUTE_ENVIRONMENT);
    if(actor.role==='executor'&&!binding)throw new Error('Unauthorized');
    return {...actor,binding:binding??undefined};
  }
  private scoped(binding:ExecutorBinding,leaseId?:string,workerId?:string){
    this.enrollment!.requireFresh(binding);
    const worker=[...this.storage.sql.exec('SELECT * FROM workers WHERE id=?',binding.workerId)][0];
    if(!worker||worker.principal!==binding.principal||worker.incarnation!==binding.incarnation)throw new HttpFailure(409,'worker-incarnation');
    if(workerId!==undefined&&workerId!==binding.workerId)throw new HttpFailure(403,'worker-scope');
    if(leaseId!==undefined){const lease=[...this.storage.sql.exec('SELECT worker_id,incarnation FROM leases WHERE id=?',leaseId)][0];if(!lease||lease.worker_id!==binding.workerId||lease.incarnation!==binding.incarnation)throw new HttpFailure(403,'lease-scope');}
  }
  private reserveArtifactBudget(workloadId:string){
    if([...this.storage.sql.exec('SELECT bytes FROM compute_artifact_budgets WHERE workload_id=?',workloadId)].length)return;
    const workload=[...this.storage.sql.exec('SELECT max_bytes,max_attempts FROM workloads WHERE id=?',workloadId)][0];
    if(!workload)throw new HttpFailure(400,'workload-not-found');
    const bytes=Number(workload.max_bytes)*Number(workload.max_attempts);
    if(Number(workload.max_bytes)>1048576)throw new HttpFailure(400,'artifact-policy-too-large');
    const reserved=Number([...this.storage.sql.exec('SELECT COALESCE(sum(bytes),0) total FROM compute_artifact_budgets')][0].total);
    // Include every legacy workload commitment, including unsealed active leases.
    // Existing overcommit fails closed pending a reviewed migration.
    const unreserved=Number([...this.storage.sql.exec('SELECT COALESCE(sum(w.max_bytes*w.max_attempts),0) total FROM workloads w LEFT JOIN compute_artifact_budgets r ON r.workload_id=w.id WHERE r.workload_id IS NULL AND w.id!=?',workloadId)][0].total);
    if(!Number.isSafeInteger(bytes)||bytes<1||reserved+unreserved+bytes>67108864)throw new HttpFailure(507,'artifact-capacity');
    this.storage.sql.exec('INSERT INTO compute_artifact_budgets(workload_id,bytes) VALUES(?,?)',workloadId,bytes);
  }
  // Host-local DI methods; old-style DO exposes only fetch, no callable RPC methods.
  execute(context:TrustedContext,command:CommandEnvelope){return this.core.execute(context,command);}
  verify(context:TrustedContext,request:VerificationRequest){return this.core.verifyAndFinalize(context,request);}
  snapshot(){return this.core.snapshot();}
  private async buildRequest(request:Request,path:string,actor:TransportActor & {binding?:ExecutorBinding}):Promise<Response>{
    if(!this.builds)throw new HttpFailure(503,'builds-disabled');
    if(!['/v1/builds/commands','/v1/builds/verify','/v1/builds/feed','/v1/builds/preview','/v1/builds/fence','/v1/builds/access','/v1/builds/result','/v1/builds/result-chunk','/v1/builds/result-log','/v1/builds/next'].includes(path))throw new HttpFailure(404,'not-found');
    const body=await boundedJson(request,70000);exact(body,path.endsWith('/access')?['expectedEpoch','attemptId','nonce']:path.endsWith('/next')?['expectedEpoch','profileHash']:path.endsWith('/commands')?['expectedEpoch','command']:path.endsWith('/verify')?['expectedEpoch','attemptId']:path.endsWith('/result-log')?['expectedEpoch','jobId','logIndex']:path.endsWith('/result-chunk')?['expectedEpoch','jobId','outputIndex','chunkIndex']:path.endsWith('/preview')?['expectedEpoch','profileHash','inputHash']:path.endsWith('/result')?['expectedEpoch','jobId']:path.endsWith('/fence')?['expectedEpoch','attemptId']:['expectedEpoch','after']);
    const current=this.authenticated(request,path.endsWith('/feed')||path.endsWith('/preview')||path.endsWith('/fence')||path.endsWith('/access')||path.endsWith('/result')||path.endsWith('/result-chunk')||path.endsWith('/result-log'));
    if(current.principal!==actor.principal||current.role!==actor.role)throw new HttpFailure(401,'identity-changed');
    if(!['owner','executor','submitter','verifier'].includes(current.role))throw new HttpFailure(403,'build-role');
    if(current.role==='executor'){if(!current.binding)throw new HttpFailure(403,'enrolled-executor-required');this.scoped(current.binding);}
    const context={...current,...current.binding,expectedEpoch:body.expectedEpoch} as BuildActor;
    if(path.endsWith('/next'))return jsonResponse({...this.builds.next(context,body.profileHash),source:{environment:this.env.COMPUTE_ENVIRONMENT,authorityId:this.state.id.toString(),epoch:body.expectedEpoch}});
    if(path.endsWith('/commands'))return jsonResponse({...this.builds.execute(context,body.command),source:{environment:this.env.COMPUTE_ENVIRONMENT,authorityId:this.state.id.toString(),epoch:body.expectedEpoch}});
    if(path.endsWith('/feed'))return jsonResponse(this.builds.feed(context,body.after));
    if(path.endsWith('/preview'))return jsonResponse({ok:true,candidates:this.builds.previewDraft(context,body.profileHash,body.inputHash)});
    if(path.endsWith('/result-chunk')||path.endsWith('/result-log')){const log=path.endsWith('/result-log');const bytes=await this.builds.readOutput(context,body.jobId,log?0:body.outputIndex,log?body.logIndex:body.chunkIndex,()=>{const fresh=this.authenticated(request,true);if(fresh.role!==current.role||fresh.principal!==current.principal)throw new HttpFailure(401,'identity-changed');},log);return new Response(bytes,{headers:{'content-type':'application/octet-stream','cache-control':'no-store','x-content-type-options':'nosniff'}});}
    if(path.endsWith('/result'))return jsonResponse(this.builds.accepted(context,body.jobId));
    if(path.endsWith('/fence'))return jsonResponse(this.builds.observeFence(context,body.attemptId));
    if(path.endsWith('/access')){
      if(typeof body.nonce!=='string'||!/^[a-f0-9]{64}$/.test(body.nonce))throw new HttpFailure(400,'invalid-access-nonce');
      return jsonResponse({...this.builds.observeFence(context,body.attemptId,true),nonce:body.nonce,source:{environment:this.env.COMPUTE_ENVIRONMENT,authorityId:this.state.id.toString(),epoch:body.expectedEpoch}});
    }
    return jsonResponse(await this.builds.verify(context,body.attemptId,()=>{const fresh=this.authenticated(request,true);if(fresh.role!==current.role||fresh.principal!==current.principal)throw new HttpFailure(401,'identity-changed');}));
  }
  async fetch(request?:Request):Promise<Response> {
    if(this.env.COMPUTE_TRANSPORT_ENABLED!=='true')return new Response('Compute transport is not enabled',{status:503});
    try {
      if(!request)throw new HttpFailure(400,'request-required');
      if(new URL(request.url).protocol!=='https:')throw new HttpFailure(400,'https-required');
      const path=new URL(request.url).pathname;
      const readOnly=['/v1/builds/feed','/v1/builds/preview','/v1/builds/fence','/v1/builds/access','/v1/builds/result','/v1/builds/result-chunk','/v1/builds/result-log','/v1/operator','/v1/operator/result','/v1/operator/workload','/v1/status','/v1/enrollment/status','/v1/workload','/v1/library/fences','/v1/library/fence','/v1/artifacts/read'].includes(path);
      let actor:TransportActor & {binding?:ExecutorBinding};
      // Read authentication observes enrollment without clock writes, retaining full static
      // config validation, dynamic executor fences and duplicate-digest rejection.
      try{actor=this.authenticated(request,readOnly);}
      catch{throw new HttpFailure(401,'unauthorized');}
      if(request.method!=='POST')throw new HttpFailure(405,'post-required');
      if(path.startsWith('/v1/builds/'))return await this.buildRequest(request,path,actor);
      if(!['/v1/operator','/v1/operator/result','/v1/operator/workload','/v1/library/fences','/v1/library/fence','/v1/worker/poll','/v1/enrollment/profile','/v1/enrollment/enroll','/v1/enrollment/revoke','/v1/enrollment/heartbeat','/v1/enrollment/status','/v1/commands','/v1/artifacts','/v1/artifacts/read','/v1/verify','/v1/snapshot','/v1/status','/v1/workload'].includes(path))throw new HttpFailure(404,'not-found');
      const input=await boundedJson(request,path==='/v1/artifacts'?1450000:70000);
      exact(input,(path.startsWith('/v1/enrollment/')||path==='/v1/worker/poll'||path==='/v1/operator')?['expectedEpoch','request']:path==='/v1/library/fences'?['expectedEpoch','after','limit']:path==='/v1/library/fence'?['expectedEpoch','binding']:(path==='/v1/workload'||path==='/v1/operator/result'||path==='/v1/operator/workload')?['expectedEpoch','workloadId']:path==='/v1/status'?[]:path==='/v1/commands'?['expectedEpoch','command']:path==='/v1/artifacts'?['expectedEpoch','key','fence','bytesBase64','exitCode']:path==='/v1/verify'?['expectedEpoch','request']:path==='/v1/artifacts/read'?['expectedEpoch','reference']:['expectedEpoch']);
      // Body streaming may yield to revocation. Reauthenticate even the epoch-discovery read.
      try{actor=this.authenticated(request,readOnly);}catch{throw new HttpFailure(401,'unauthorized');}
      if(path==='/v1/status'){
        if(actor.role!=='owner')throw new HttpFailure(403,'owner-required');
        const meta=[...this.storage.sql.exec('SELECT environment,authority_id,epoch,schema_version FROM authority_meta WHERE singleton=1')][0];
        return jsonResponse({ok:true,environment:meta.environment,authorityId:meta.authority_id,epoch:meta.epoch,schemaVersion:meta.schema_version});
      }
      if(!Number.isSafeInteger(input.expectedEpoch)||input.expectedEpoch<1)throw new HttpFailure(400,'invalid-epoch');
      const context={...actor,expectedEpoch:input.expectedEpoch} as TrustedContext;
      if(path==='/v1/operator'){
        if(actor.role!=='owner')throw new HttpFailure(403,'owner-required');
        return jsonResponse(readOperatorFeed(this.storage,input.expectedEpoch,input.request,this.now()));
      }
      if(path==='/v1/operator/result'){
        if(actor.role!=='owner')throw new HttpFailure(403,'owner-required');
        return jsonResponse(readOperatorResult(this.storage,this.artifacts,input.expectedEpoch,input.workloadId,this.now()));
      }
      if(path==='/v1/operator/workload'){
        if(actor.role!=='owner')throw new HttpFailure(403,'owner-required');
        return jsonResponse(readOperatorWorkload(this.storage,input.expectedEpoch,input.workloadId,this.now()));
      }
      if(path==='/v1/library/fences'||path==='/v1/library/fence'){
        if(actor.role!=='owner')throw new HttpFailure(403,'owner-required');
        const meta=[...this.storage.sql.exec('SELECT epoch FROM authority_meta WHERE singleton=1')][0];
        if(meta.epoch!==context.expectedEpoch)throw new HttpFailure(409,'stale-epoch');
        return jsonResponse(path==='/v1/library/fences'?readLibraryFences(this.storage,{after:input.after,limit:input.limit}):observeLibraryFence(this.storage,input.binding,this.now()));
      }
      if(path==='/v1/worker/poll'){
        if(!actor.binding)throw new HttpFailure(403,'enrolled-executor-required');
        return jsonResponse(this.storage.transactionSync(()=>{
          const binding=actor.binding!;this.scoped(binding);
          if([...this.storage.sql.exec('SELECT quarantined FROM workers WHERE id=?',binding.workerId)][0].quarantined)throw new HttpFailure(409,'worker-quarantined');
          const meta=[...this.storage.sql.exec('SELECT epoch FROM authority_meta WHERE singleton=1')][0];
          if(meta.epoch!==input.expectedEpoch)throw new HttpFailure(409,'stale-epoch');
          exact(input.request,['key','sequence','ttlMs','profileHash']);const r=input.request;
          if(typeof r.profileHash!=='string'||!/^([a-f0-9]{64})$/.test(r.profileHash)||typeof r.key!=='string'||!/^[A-Za-z0-9._-]{1,64}$/.test(r.key)||!Number.isSafeInteger(r.ttlMs)||r.ttlMs<1000||r.ttlMs>60000||!Number.isSafeInteger(r.sequence)||r.sequence<1)throw new HttpFailure(400,'invalid-poll');
          const fingerprint=createHash('sha256').update(JSON.stringify({epoch:input.expectedEpoch,binding,sequence:r.sequence,ttlMs:r.ttlMs,profileHash:r.profileHash})).digest('hex');
          const approvedProfile=[...this.storage.sql.exec('SELECT profile_hash,profile FROM compute_worker_profiles WHERE worker_id=? AND revision=?',binding.workerId,binding.revision)][0];
          if(approvedProfile){const p=JSON.parse(String(approvedProfile.profile));if(approvedProfile.profile_hash!==r.profileHash)throw new HttpFailure(409,'execution-profile-mismatch');if(r.ttlMs<=p.timeoutMs+15000)throw new HttpFailure(400,'lease-runway');}
          const prior=[...this.storage.sql.exec('SELECT * FROM compute_worker_poll_heads WHERE worker_id=? AND revision=?',binding.workerId,binding.revision)][0];
          if(prior&&prior.sequence===r.sequence){if(prior.request_key!==r.key||prior.request_hash!==fingerprint)throw new HttpFailure(409,'poll-key-conflict');return JSON.parse(String(prior.response));}
          if(r.sequence!==Number(prior?.sequence??0)+1)throw new HttpFailure(409,'poll-sequence');
          let result:any={ok:true,kind:'idle'};let afterWorkload=String(prior?.after_workload??'');
          const approved=this.enrollment!.requireFresh(binding).identity;

          if(approved.workerClass==='general'&&!approvedProfile)result={ok:true,kind:'idle',reason:'execution-profile-required'};
          if(approved.workerClass==='general'&&approvedProfile){
            const profile=JSON.parse(String(approvedProfile.profile));
            const held=[...this.storage.sql.exec("SELECT COALESCE(sum(cpu),0) cpu,COALESCE(sum(ram_mib),0) ram FROM reservations WHERE worker_id=? AND state!='released'",binding.workerId)][0];
            const find=(after:string)=>[...this.storage.sql.exec("SELECT * FROM workloads WHERE status='QUEUED' AND gpu_kind IS NULL AND cpu<=? AND ram_mib<=? AND CASE WHEN json_valid(specification) THEN json_extract(specification,'$.template') ELSE NULL END='epoch-event-summary-v1' AND id>? AND cpu=? AND ram_mib=? ORDER BY id LIMIT 100",approved.cpu-Number(held.cpu),approved.ramMib-Number(held.ram),after,profile.cpu,profile.ramMib)];
            let candidates=find(afterWorkload);if(!candidates.length&&afterWorkload)candidates=find('');
            afterWorkload=candidates.length?String(candidates.at(-1)!.id):'';
            for(const w of candidates){
              let output:Uint8Array;try{output=executeEventSummaryForWorkload(String(w.specification),String(w.id));}catch{continue;}
              if(createHash('sha256').update(output).digest('hex')!==w.expected_hash||output.byteLength>Number(w.max_bytes)||output.byteLength>profile.maxOutputBytes||w.exit_code!==0)continue;
              const claim=this.core.claimCandidate(context,{operation:'claim',key:createHash('sha256').update(JSON.stringify(['poll',binding,r.sequence,r.key,w.id,w.generation])).digest('hex'),body:{workloadId:String(w.id),workerId:binding.workerId,expectedGeneration:Number(w.generation),incarnation:binding.incarnation,ttlMs:r.ttlMs}}) as any;
              if(!claim.ok)continue;
              this.reserveArtifactBudget(String(w.id));
              result={ok:true,kind:'work',profileHash:approvedProfile.profile_hash,workload:{id:w.id,specification:w.specification,resources:{cpu:w.cpu,ramMib:w.ram_mib},expectedHash:w.expected_hash,maxBytes:w.max_bytes},lease:claim.lease};break;
            }
          }
          this.storage.sql.exec('INSERT INTO compute_worker_poll_heads VALUES(?,?,?,?,?,?,?) ON CONFLICT(worker_id,revision) DO UPDATE SET sequence=excluded.sequence,after_workload=excluded.after_workload,request_key=excluded.request_key,request_hash=excluded.request_hash,response=excluded.response',binding.workerId,binding.revision,r.sequence,afterWorkload,r.key,fingerprint,JSON.stringify(result));return result;
        }));
      }
      if(path.startsWith('/v1/enrollment/')){
        if(!this.enrollment)throw new HttpFailure(503,'enrollment-disabled');
        return jsonResponse(this.storage.transactionSync(()=>{
          const meta=[...this.storage.sql.exec('SELECT epoch FROM authority_meta WHERE singleton=1')][0];
          if(meta.epoch!==input.expectedEpoch)throw new HttpFailure(409,'stale-epoch');
          const owner={role:'owner' as const,principal:actor.principal};
          if(path==='/v1/enrollment/heartbeat'){
            if(!actor.binding)throw new HttpFailure(403,'enrolled-executor-required');
            const worker=[...this.storage.sql.exec('SELECT incarnation FROM workers WHERE id=?',actor.binding.workerId)][0];
            if(!worker||worker.incarnation!==actor.binding.incarnation)throw new HttpFailure(409,'worker-incarnation');
            return {ok:true,status:this.enrollment!.heartbeat(actor.binding,input.request)};
          }
          if(actor.role!=='owner')throw new HttpFailure(403,'owner-required');
          if(path==='/v1/enrollment/profile'){
            exact(input.request,['workerId','revision','profile']);const r=input.request;
            const status=this.enrollment!.status(owner,{afterWorkerId:null,limit:128}).workers.find(w=>w.workerId===r.workerId&&w.revision===r.revision);
            if(!status||status.revokedAt!==null||status.freshness==='inactive'||status.identity.workerClass!=='general')throw new HttpFailure(409,'profile-worker');
            let profile;try{const allowlist=JSON.parse(this.env.COMPUTE_EXECUTION_IMAGES??'[]');if(!Array.isArray(allowlist))throw Error();profile=validateProfile(r.profile,allowlist);}catch{throw new HttpFailure(400,'profile-policy');}
            if(!Number.isInteger(profile.cpu))throw new HttpFailure(400,'profile-cpu-integer');
            if(profile.cpu>status.identity.cpu||profile.ramMib>status.identity.ramMib)throw new HttpFailure(409,'profile-capacity');
            const digest=profileDigest(profile),old=[...this.storage.sql.exec('SELECT profile_hash FROM compute_worker_profiles WHERE worker_id=? AND revision=?',r.workerId,r.revision)][0];
            if(old&&old.profile_hash!==digest)throw new HttpFailure(409,'profile-immutable');
            if(!old)this.storage.sql.exec('INSERT INTO compute_worker_profiles VALUES(?,?,?,?,?,?)',r.workerId,r.revision,digest,JSON.stringify(profile),actor.principal,Date.now());
            return {ok:true,profileHash:digest};
          }
          if(path==='/v1/enrollment/status')return {ok:true,...this.enrollment!.status(owner,input.request)};
          if(path==='/v1/enrollment/enroll'){
            const body=input.request;
            const configured=JSON.parse(this.env.COMPUTE_AUTH_CONFIG??'[]');
            if(configured.some((x:any)=>x.tokenSha256===body.tokenSha256))throw new HttpFailure(409,'credential-role-conflict');
            const old=[...this.storage.sql.exec('SELECT incarnation FROM workers WHERE id=?',body.workerId)][0];
            if(body.incarnation!==(old?.incarnation??0))throw new HttpFailure(409,'worker-incarnation');
            const result=this.enrollment!.enroll(owner,body);
            if(result.applied){
              const status=result.status,identity=status.identity;
              const registered=this.execute(context,{operation:'registerWorker',key:createHash('sha256').update(JSON.stringify(['enroll',identity.workerId,status.revision])).digest('hex'),body:identity});
              if(!registered.ok)throw new HttpFailure(409,'worker-registration-rejected');
            }
            return {ok:true,...result};
          }
          const result=this.enrollment!.revoke(owner,input.request);
          if(result.applied&&result.isCurrent){
            const worker=[...this.storage.sql.exec('SELECT incarnation FROM workers WHERE id=?',result.status.workerId)][0];
            if(!worker)throw new HttpFailure(409,'worker-missing');
            if(worker.incarnation===result.status.incarnation){
              const fenced=this.execute(context,{operation:'quarantineWorker',key:createHash('sha256').update(JSON.stringify(['revoke',result.status.workerId,result.status.revision])).digest('hex'),body:{workerId:result.status.workerId,expectedIncarnation:result.status.incarnation}});
              if(!fenced.ok)throw new HttpFailure(409,'worker-fence-rejected');
            }
          }
          return {ok:true,...result};
        }));
      }
      if(path==='/v1/workload'){
        if(actor.role!=='owner')throw new HttpFailure(403,'owner-required');
        if(typeof input.workloadId!=='string'||!/^[A-Za-z0-9._-]{1,64}$/.test(input.workloadId))throw new HttpFailure(400,'invalid-workload');
        const meta=[...this.storage.sql.exec('SELECT epoch FROM authority_meta WHERE singleton=1')][0];
        if(meta.epoch!==context.expectedEpoch)throw new HttpFailure(409,'stale-epoch');
        const workload=[...this.storage.sql.exec('SELECT * FROM workloads WHERE id=?',input.workloadId)][0]??null;
        return jsonResponse({ok:true,epoch:meta.epoch,workload});
      }
      if(path==='/v1/commands'){
        exact(input.command,['key','operation','body']);
        if(!input.command.body||typeof input.command.body!=='object'||Array.isArray(input.command.body))throw new HttpFailure(400,'invalid-command');
        if(this.enrollment&&input.command?.operation==='registerWorker')throw new HttpFailure(403,'enrollment-required');
        if(input.command?.operation==='submit' && input.command.body?.policy?.maxBytes>1048576)throw new HttpFailure(400,'artifact-policy-too-large');
        if(input.command?.operation==='stageResult')throw new HttpFailure(403,'sealed-upload-required');
        return jsonResponse(this.storage.transactionSync(()=>{
          if(actor.binding)this.scoped(actor.binding,input.command.body.leaseId,input.command.operation==='claim'?input.command.body.workerId:undefined);
          if(this.enrollment&&input.command.operation==='claim')throw new HttpFailure(403,'approved-poll-required');
          const result=this.execute(context,input.command);
          if(result.ok && ['submit','claim'].includes(input.command.operation))this.reserveArtifactBudget(input.command.body.workloadId);
          return result;
        }));
      }
      if(path==='/v1/verify')return jsonResponse(await this.verify(context,input.request));
      if(path==='/v1/artifacts'){
        if(actor.role!=='executor')throw new HttpFailure(403,'executor-required');
        exact(input.fence,['leaseId','epoch','generation','incarnation','capability']);
        if(typeof input.bytesBase64!=='string'||input.bytesBase64.length>1398104||input.bytesBase64.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(input.bytesBase64))throw new HttpFailure(400,'invalid-bytes');
        const bytes=Buffer.from(input.bytesBase64,'base64');
        if(bytes.byteLength>1048576)throw new HttpFailure(413,'artifact-too-large');
        if(bytes.toString('base64')!==input.bytesBase64)throw new HttpFailure(400,'invalid-bytes');
        const result=this.storage.transactionSync(()=>{
          if(actor.binding)this.scoped(actor.binding,input.fence.leaseId);
          const lease=[...this.storage.sql.exec('SELECT workload_id FROM leases WHERE id=?',input.fence.leaseId)][0];
          if(!lease)throw new HttpFailure(400,'lease-not-found');
          this.reserveArtifactBudget(String(lease.workload_id));
          const sealed=this.artifacts.put(input.fence.leaseId,actor.principal,bytes);
          const result=this.execute(context,{operation:'stageResult',key:input.key,body:{...input.fence,artifactRef:sealed.reference,sha256:sealed.sha256,bytes:sealed.bytes,exitCode:input.exitCode}});
          if(!result.ok)throw new UploadRejected(result);
          return {...result,artifact:sealed};
        });
        return jsonResponse(result);
      }
      if(path==='/v1/snapshot'){
        if(actor.role!=='owner')throw new HttpFailure(403,'owner-required');
        const snapshot=this.snapshot();
        if(snapshot.epoch!==context.expectedEpoch)throw new HttpFailure(409,'stale-epoch');
        return jsonResponse(snapshot);
      }
      // Do not allow tenant callers to enumerate another tenant's object references.
      if(!['owner','verifier'].includes(actor.role))throw new HttpFailure(403,'artifact-read-forbidden');
      const epoch=[...this.storage.sql.exec('SELECT epoch FROM authority_meta WHERE singleton=1')][0].epoch;
      if(epoch!==context.expectedEpoch)throw new HttpFailure(409,'stale-epoch');
      if(typeof input.reference!=='string'||!/^[a-f0-9]{64}$/.test(input.reference))throw new HttpFailure(400,'invalid-reference');
      let bytes:Uint8Array;
      try{bytes=this.artifacts.read(input.reference,1048576);}catch{throw new HttpFailure(404,'artifact-not-found');}
      return new Response(bytes,{headers:{'content-type':'application/octet-stream','cache-control':'no-store','x-content-type-options':'nosniff'}});
    } catch(error) {
      if(error instanceof BuildError)return jsonResponse({ok:false,code:error.code},error.status);
      if(error instanceof EnrollmentError)return jsonResponse({ok:false,code:error.code},409);
      if(error instanceof UploadRejected)return jsonResponse(error.result);
      if(error instanceof HttpFailure)return jsonResponse({ok:false,code:error.code},error.status);
      // Details and bearer input never enter logs or responses.
      if(error instanceof Error && /^(invalid |unknown operation|request too large|content hash required|edge cannot execute)/.test(error.message))return jsonResponse({ok:false,code:'invalid-request'},400);
      if(error instanceof Error && error.message==='artifact lease conflict')return jsonResponse({ok:false,code:'artifact-conflict'},409);
      if(error instanceof Error && error.message==='artifact storage capacity exceeded')return jsonResponse({ok:false,code:'artifact-capacity'},507);
      return jsonResponse({ok:false,code:'temporarily-unavailable'},503);
    }
  }
}
