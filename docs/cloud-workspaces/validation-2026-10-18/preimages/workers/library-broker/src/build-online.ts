import {randomBytes,createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {canonical} from '../../../packages/library-jobs/src/data';
import type {ReadGrant,ObjectRef} from '../../../packages/storage-broker/src/index';
import * as v from '../../../packages/build-jobs/src/validation';

export interface BuildAccessConfig {
  origin:string;environment:string;authorityId:string;
  /** Server-only managed credential resolver. Never passed to a build process. */
  credential():string;
  transport?:typeof fetch;
}
export interface BuildAccessDecision {authorized:boolean;permanentlyRevoked:boolean;evidenceHash:string}
export interface BuildAccessExpectation {compute:ReadGrant['compute'];projectId:string;policyHash:string;object:ObjectRef|null}
/** Fresh nonce-bound online observation, NOT a synchronous authority mirror. No
 * retries, redirects, cached observations, clock-domain substitution or poll loop. */
export function createBuildAccessClient(config:BuildAccessConfig){
  const origin=new URL(config.origin);
  if(origin.protocol!=='https:'||origin.origin!==config.origin||origin.username||origin.password)throw new Error('build-access-origin');
  const endpoint=origin.origin+'/v1/builds/access',environment=config.environment,authorityId=config.authorityId,credential=config.credential,transport=config.transport??fetch;
  let active=0;
  return async(input:BuildAccessExpectation,signal:AbortSignal):Promise<BuildAccessDecision>=>{
    const grant=JSON.parse(canonical(input)) as BuildAccessExpectation;
    v.exact(grant,['compute','projectId','policyHash','object']);v.id(grant.projectId);v.digest(grant.policyHash);
    v.exact(grant.compute,['authorityId','workloadId','leaseId','epoch','generation','attemptId','capabilityDigest','workerId','incarnation']);
    for(const id of [grant.compute.authorityId,grant.compute.workloadId,grant.compute.leaseId,grant.compute.attemptId,grant.compute.workerId])v.id(id);
    v.uint(grant.compute.epoch,1);v.uint(grant.compute.generation);v.uint(grant.compute.incarnation);v.digest(grant.compute.capabilityDigest);
    if(grant.object!==null)v.ref(grant.object);
    if(signal.aborted||active>=4||grant.compute.authorityId!==authorityId)throw new Error('build-access-admission');
    active++;
    const abort=new AbortController();let rejectAbort!:(error:Error)=>void;
    const cancelled=new Promise<never>((_,reject)=>{rejectAbort=reject;});
    const cancel=()=>{abort.abort();rejectAbort(new Error('build-access-interrupted'));};
    signal.addEventListener('abort',cancel,{once:true});
    const timer=setTimeout(cancel,5000),nonce=randomBytes(32).toString('hex'),started=performance.now();
    if(signal.aborted)cancel();
    let response:Response|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
    const operation=(async()=>{try{
      if(abort.signal.aborted)throw new Error('build-access-interrupted');
      const token=credential();if(!/^[A-Za-z0-9._~+/-]{32,}=*$/.test(token))throw new Error('build-access-credential');
      response=await transport(endpoint,{method:'POST',redirect:'error',cache:'no-store',credentials:'omit',signal:abort.signal,
        headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({expectedEpoch:grant.compute.epoch,attemptId:grant.compute.attemptId,nonce})});
      if(response.status!==200||response.redirected||!response.body||!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')??''))throw new Error('build-access-unavailable');
      reader=response.body.getReader();const buffer=new Uint8Array(65536);let used=0;
      for(let count=0;;count++){
        if(count>=65536||abort.signal.aborted)throw new Error('build-access-interrupted');
        const chunk=await reader.read();if(chunk.done)break;
        if(chunk.value.length>buffer.length-used)throw new Error('build-access-response-bound');buffer.set(chunk.value,used);used+=chunk.value.length;
      }
      const elapsed=performance.now()-started;
      if(abort.signal.aborted||signal.aborted||elapsed<0||elapsed>=5000||credential()!==token)throw new Error('build-access-deadline-or-identity');
      const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,used)));
      if(value.ok!==true||value.nonce!==nonce||value.source?.environment!==environment||value.source?.authorityId!==authorityId||value.source?.epoch!==grant.compute.epoch||
        !Number.isSafeInteger(value.observedAt)||!Number.isSafeInteger(value.expiresAt)||typeof value.valid!=='boolean'||typeof value.resultReadable!=='boolean'||typeof value.permanentlyRevoked!=='boolean'||
        !Array.isArray(value.retainedArtifacts)||value.retainedArtifacts.length>32)throw new Error('build-access-binding');
      const bound=value.projectId===grant.projectId&&value.profileHash===grant.policyHash&&canonical(value.compute)===canonical(grant.compute);
      const retained=grant.object!==null&&value.resultReadable&&value.retainedArtifacts.some((ref:unknown)=>canonical(ref)===canonical(grant.object));
      const live=value.valid&&value.expiresAt-value.observedAt>elapsed;
      // A short remaining lease is uncertainty, not an authenticated revocation:
      // renewal may have advanced while this response travelled. Deny this read
      // without permanently tombstoning a still-renewable immutable grant.
      if(bound&&value.valid&&!live&&!retained)throw new Error('build-access-lifetime-unconfirmed');
      return {authorized:bound&&(live||retained),permanentlyRevoked:!bound||value.permanentlyRevoked,evidenceHash:createHash('sha256').update(canonical(value)).digest('hex')};
    }catch{throw new Error('build-access-unconfirmed');}
    finally{
      abort.abort();
      try{if(reader){await reader.cancel();reader.releaseLock();}else await response?.body?.cancel();}catch{}
      active--;
    }})();
    try{return await Promise.race([operation,cancelled]);}
    finally{clearTimeout(timer);signal.removeEventListener('abort',cancel);}
  };
}
