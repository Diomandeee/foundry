import {exportService,importService} from './service-recovery';
import {recoveryStatus,recoveryChallenge,finishRecovery,type RecoveryChallenge,type RecoveryProof} from './recovery-guard';
import {archiveBody} from './archive-body';
import {MAX_ARCHIVE_BYTES,type RecoveryBinding} from '../../../packages/library-recovery/src/index';
import {applyCatalogRevocation} from './revocations';
import {LibraryCatalog,LibraryRejected,type LibraryContext,type LibraryEnvelope,type TransactionPort} from '../../../packages/library-catalog/src/index';
import {authenticate} from '../../compute/src/transport-auth';
import {boundedJson,exact,HttpFailure,jsonResponse} from '../../compute/src/http';
import {projects,policyDigest,route,authConfigured,type LibraryEnvironment,type ProjectPolicy} from './config';

/** One configured project per actual SQLite Durable Object. No cloud side effects. */
export class LibraryAuthority {
 private catalog?:LibraryCatalog;
 private port?:TransactionPort;
 private restoring=false;
 private restoreVersion=0;
 private binding?:string;
 private readonly reading={owner:0,writer:0,verifier:0};
 constructor(private readonly state:DurableObjectState,private readonly env:LibraryEnvironment,private readonly host:{now?:()=>number;reconcileRecovery?:(challenge:RecoveryChallenge,signal:AbortSignal)=>Promise<RecoveryProof>}={}){}
 private policy(request:Request):ProjectPolicy{
  const target=route(request);
  const policy=projects(this.env).find(p=>p.projectId===target.projectId);
  if(!policy)throw new HttpFailure(404,'project-not-configured');
  const namespace=this.env.LIBRARY_CATALOG;
  if(!namespace)throw new HttpFailure(503,'library-unconfigured');
  const expected=namespace.idFromName(`${this.env.LIBRARY_ENVIRONMENT}:${this.env.LIBRARY_AUTHORITY_NAME}:${policy.projectId}`).toString();
  if(this.state.id.toString()!==expected)throw new HttpFailure(409,'authority-project-mismatch');
  return policy;
 }
 private context(request:Request,policy:ProjectPolicy):LibraryContext{
  authConfigured(this.env);
  let actor;
  try{actor=authenticate(request,this.env.LIBRARY_AUTH_CONFIG??'',this.env.LIBRARY_ENVIRONMENT);}catch{throw new HttpFailure(401,'unauthorized');}
  const role=actor.role==='owner'?'owner':actor.role==='submitter'?'writer':actor.role==='verifier'?'verifier':undefined;
  const expected=role==='owner'?policy.ownerPrincipal:role==='writer'?policy.writerPrincipal:role==='verifier'?policy.verifierPrincipal:undefined;
  if(!role||expected!==actor.principal)throw new HttpFailure(403,'project-permission');
  return {environment:this.env.LIBRARY_ENVIRONMENT,authorityId:this.state.id.toString(),projectId:policy.projectId,principal:actor.principal,role};
 }
 async fetch(request:Request):Promise<Response>{
  if(this.env.LIBRARY_TRANSPORT_ENABLED!=='true')return jsonResponse({ok:false,code:'library-transport-disabled'},503);
  let admitted:LibraryContext['role']|undefined,restoreAdmitted=false;
  try{
   const action=route(request).action,startedVersion=this.restoreVersion;
   if(this.restoring)throw new HttpFailure(429,'restore-busy');
   const policy=this.policy(request),before=policyDigest(this.env,policy);
   const initial=this.context(request,policy);
   // Bound aggregate body buffers and reserve owner control independently of writers.
   const cap=initial.role==='owner'?2:4;
   if(action==='restore'&&initial.role!=='owner')throw new HttpFailure(403,'owner-required');
   if(action==='restore'&&[...this.state.storage.sql.exec('SELECT name FROM sqlite_master LIMIT 1')].length)throw new HttpFailure(400,'restore-target-not-empty');
   if(this.reading[initial.role]>=cap)throw new HttpFailure(429,'body-admission-full');
   admitted=initial.role;this.reading[admitted]++;
   if(action==='restore'){this.restoring=true;this.restoreVersion++;restoreAdmitted=true;}
   const input=action==='restore'?await archiveBody(request,MAX_ARCHIVE_BYTES):await boundedJson(request,65536);
   if(action!=='restore'&&(this.restoring||startedVersion!==this.restoreVersion))throw new HttpFailure(409,'restore-interleaved');
   if(this.env.LIBRARY_TRANSPORT_ENABLED!=='true')throw new HttpFailure(503,'library-transport-disabled');
   const current=this.policy(request);
   if(policyDigest(this.env,current)!==before)throw new HttpFailure(409,'policy-changed');
   const context=this.context(request,current);
   if(this.binding&&this.binding!==before)throw new HttpFailure(409,'policy-changed');
   const target=route(request);
   if(['export','restore','recovery-status','reconcile-recovery'].includes(target.action)){if(context.role!=='owner')throw new HttpFailure(403,'owner-required');if(target.action!=='restore')exact(input,[]);}
   else if(target.action==='revocations'){exact(input,['delivery']);if(context.role!=='owner')throw new HttpFailure(403,'owner-required');}
   else if(target.action==='snapshot'){
    exact(input,[]);
    if(context.role!=='owner')throw new HttpFailure(403,'owner-required');
   }else exact(input,['operation','key','body']);
   if(!this.port){
    let depth=0;
    const port:TransactionPort={sql:{exec:(query,...bindings)=>this.state.storage.sql.exec(query,...bindings)},transactionSync:fn=>{if(depth)return fn();return this.state.storage.transactionSync(()=>{depth++;try{return fn();}finally{depth--;}});}};
    this.port=port;
   }
   const options:RecoveryBinding={environment:this.env.LIBRARY_ENVIRONMENT,authorityId:this.state.id.toString(),projectId:current.projectId,policy:{version:current.policyVersion,ownerPrincipal:current.ownerPrincipal,writerPrincipal:current.writerPrincipal,verifierPrincipal:current.verifierPrincipal}};
   if(target.action==='restore'){
    const expected=request.headers.get('x-catalog-archive-sha256');if(!expected||!/^[a-f0-9]{64}(?![\s\S])/.test(expected))throw new HttpFailure(400,'archive-pin-required');
    try{const result=importService({...this.port!,storageKind:'cloudflare-sqlite'},options,context,input as string,expected);this.binding=before;return jsonResponse(result);}catch(error){if(error instanceof SyntaxError)throw new HttpFailure(400,'archive-invalid');throw error;}
   }
   if(target.action==='recovery-status')return jsonResponse(recoveryStatus(this.port!));
   if(target.action==='export')return jsonResponse(exportService(this.port!,options,context));
   if(!this.catalog){this.catalog=new LibraryCatalog(this.port!,{...options,now:this.host.now});this.binding=before;}
   if(target.action==='reconcile-recovery'){
    if(!this.host.reconcileRecovery)throw new HttpFailure(503,'recovery-reconciler-required');
    const challenge=recoveryChallenge(this.port!,this.catalog,context),abort=new AbortController(),timer=setTimeout(()=>abort.abort(),10000);
    try{const proof=await Promise.race([this.host.reconcileRecovery(challenge,abort.signal),new Promise<never>((_,reject)=>abort.signal.addEventListener('abort',()=>reject(new HttpFailure(408,'recovery-reconcile-timeout')),{once:true}))]);
     const finalContext=this.context(request,this.policy(request));if(finalContext.role!=='owner'||finalContext.principal!==context.principal)throw new HttpFailure(403,'owner-required');if(policyDigest(this.env,this.policy(request))!==before||this.env.LIBRARY_TRANSPORT_ENABLED!=='true')throw new HttpFailure(409,'policy-changed');
     return jsonResponse(finishRecovery(this.port!,this.catalog,context,challenge,proof,this.host.now?.()??Date.now()));}finally{abort.abort();clearTimeout(timer);}
   }
   if(target.action==='commands'&&recoveryStatus(this.port!).quarantined){
    const operation=(input as {operation?:unknown}).operation;if(!['cancelTransfer','revokePolicy'].includes(String(operation)))throw new HttpFailure(409,'recovery-quarantined');
   }
   if(target.action==='revocations')return jsonResponse(applyCatalogRevocation(this.port!,this.catalog,context,(input as {delivery:unknown}).delivery));
   const result=target.action==='snapshot'?this.catalog.snapshot(context):this.catalog.execute(context,input as LibraryEnvelope);
   return jsonResponse(result,'accepted'in result&&!result.accepted?409:200);
  }catch(error){
   if(error instanceof LibraryRejected)return jsonResponse({ok:false,code:error.code},error.status);
   if(error instanceof HttpFailure)return jsonResponse({ok:false,code:error.code},error.status);
   return jsonResponse({ok:false,code:'temporarily-unavailable'},503);
  }finally{if(admitted)this.reading[admitted]--;if(restoreAdmitted)this.restoring=false;}
 }
}
