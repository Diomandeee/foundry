import {performance} from 'node:perf_hooks';
import * as v from '../../packages/build-jobs/src/validation.js';
import {canonicalData} from '../../packages/build-runtime/src/parent-profile.js';
import {credential,readJsonFile} from '../foundry-pilot/private-state.js';
import {origin,reference} from './config.js';
export interface VerifyConfig {
  version:1;origin:string;environment:string;authorityId:string;expectedEpoch:number;attemptId:string;jobId:string;
  verifierCredentialRef:string;otherCredentialRefs:string[];approvalReceiptSha256:string;
}
export function parseVerifyConfig(raw:unknown):Readonly<VerifyConfig>{
  const c=JSON.parse(canonicalData(raw)) as VerifyConfig;
  v.exact(c,['version','origin','environment','authorityId','expectedEpoch','attemptId','jobId','verifierCredentialRef','otherCredentialRefs','approvalReceiptSha256']);
  v.need(c.version===1,'verify-config-version');origin(c.origin);v.id(c.environment);v.id(c.authorityId);v.uint(c.expectedEpoch,1);v.id(c.attemptId);v.id(c.jobId);
  reference(c.verifierCredentialRef);v.digest(c.approvalReceiptSha256);
  v.need(Array.isArray(c.otherCredentialRefs)&&c.otherCredentialRefs.length>=3&&c.otherCredentialRefs.length<=35,'other-role-references-required');
  c.otherCredentialRefs.forEach(reference);
  v.need(!c.otherCredentialRefs.includes(c.verifierCredentialRef)&&new Set(c.otherCredentialRefs).size===c.otherCredentialRefs.length,'separate-verifier-reference-required');
  Object.freeze(c.otherCredentialRefs);return Object.freeze(c);
}
export async function loadVerifyConfig(path:string){return parseVerifyConfig(await readJsonFile(path,16384,true));}
export interface VerifierBoundaries {credential(reference:string):string;fetch:typeof fetch}
/** One authenticated exact-attempt request. No worker capability, owner credential,
 * automatic retries or worker-finalized success. Server enforces verifier role. */
export async function verifyAttempt(raw:unknown,receipt:string,signal:AbortSignal,
  ports:VerifierBoundaries={credential,fetch:(url,init)=>fetch(url,init)}){
  const c=parseVerifyConfig(raw);
  v.need(receipt===c.approvalReceiptSha256&&!signal.aborted,'explicit-verification-gated');
  const abort=new AbortController(),cancel=()=>abort.abort(),deadline=performance.now()+35000;
  signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
  const timer=setTimeout(cancel,35000);
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  const fence=()=>v.need(!abort.signal.aborted&&performance.now()<deadline,'verification-interrupted-outcome-unknown');
  // Native fetch honors this deadline. Await physical stream settlement; never
  // print success on timeout or turn an uncertain outcome into a retry.
  try{
    fence();const token=ports.credential(c.verifierCredentialRef);
    v.need(typeof token==='string'&&token.length<=8192&&/^[A-Za-z0-9._~+/-]{32,}=*$/.test(token),'verifier-credential-unavailable');
    const init={method:'POST',redirect:'error' as const,cache:'no-store' as const,credentials:'omit' as const,signal:abort.signal,
      headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({environment:c.environment,authorityId:c.authorityId,jobId:c.jobId,expectedEpoch:c.expectedEpoch,attemptId:c.attemptId})};
    const response=await ports.fetch(c.origin+'/v1/builds/verify-target',init);
    reader=response.body?.getReader();fence();
    v.need(response.status===200&&!response.redirected&&reader&&/^application\/json(?:;|$)/i.test(response.headers.get('content-type')??''),'verification-unconfirmed');
    const length=response.headers.get('content-length');v.need(length===null||(/^[0-9]+$/.test(length)&&Number(length)<=16384),'verification-response-limit');
    const buffer=new Uint8Array(16384);let size=0;
    for(let chunks=0;;chunks++){
      fence();v.need(chunks<1024,'verification-chunk-limit');const part=await reader.read();fence();if(part.done)break;
      v.need(part.value.byteLength<=buffer.length-size,'verification-response-limit');buffer.set(part.value,size);size+=part.value.byteLength;
    }
    v.need(length===null||Number(length)===size,'verification-response-length');
    const reply=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(buffer.subarray(0,size)));
    v.exact(reply,['ok','verified','jobId','attemptId','source',...(Object.hasOwn(reply,'replayed')?['replayed']:[])]);
    v.need(reply.ok===true&&reply.verified===true&&reply.jobId===c.jobId&&reply.attemptId===c.attemptId&&
      (!Object.hasOwn(reply,'replayed')||reply.replayed===true),'verification-receipt-mismatch');
    v.exact(reply.source,['environment','authorityId','epoch']);
    v.need(reply.source.environment===c.environment&&reply.source.authorityId===c.authorityId&&reply.source.epoch===c.expectedEpoch,'verification-source-mismatch');
    fence();v.need(ports.credential(c.verifierCredentialRef)===token,'verifier-reference-changed');
    return {state:'verified' as const,jobId:c.jobId,attemptId:c.attemptId,source:reply.source as {environment:string;authorityId:string;epoch:number},expectedEpoch:c.expectedEpoch,replayed:reply.replayed===true};
  }catch{throw new Error('verification-unconfirmed-outcome-unknown');}
  finally{abort.abort();clearTimeout(timer);signal.removeEventListener('abort',cancel);if(reader){try{await reader.cancel();}finally{reader.releaseLock();}}}
}
