import {performance} from 'node:perf_hooks';
import {credential,need,PilotError,uint,id} from './private-state';
import {boundedBytes,canonical} from '../../packages/library-jobs/src/data';
const paths=new Set(['/v1/builds/feed','/v1/builds/preview','/v1/builds/commands','/v1/builds/result','/v1/builds/result-chunk','/v1/builds/result-log','/v1/builds/fence','/v1/status','/v1/worker/status','/v1/operator','/v1/operator/result','/v1/operator/workload','/v1/workload','/v1/commands','/v1/enrollment/enroll','/v1/enrollment/profile','/v1/enrollment/status','/v1/enrollment/heartbeat','/v1/verify','/v1/artifacts/read']);
export interface AuthorityTarget {origin:string;environment:string;authorityId:string}
/** Host-only fixed-origin transport. No retries; callers persist their intent first. */
export class AuthorityTransport {
 private active=0;private readonly origin:string;readonly target:Readonly<AuthorityTarget|{origin:string;environment:string;authorityId?:undefined}>;
 constructor(target:AuthorityTarget|{origin:string;environment:string;authorityId?:undefined},private readonly timeoutMs=5000){this.target=Object.freeze({...target});id(target.environment);if(target.authorityId!==undefined)id(target.authorityId);const u=new URL(target.origin);need(u.protocol==='https:'&&u.pathname==='/'&&!u.username&&!u.password&&!u.search&&!u.hash,'pilot-invalid-origin');this.origin=u.origin;uint(timeoutMs,100,10000);}
 async request(reference:string,path:string,body:unknown,maxBytes=262144,binary=false,outer?:AbortSignal,capturedToken?:string):Promise<unknown>{
  need(paths.has(path)&&(this.target.authorityId!==undefined||path==='/v1/status'),'pilot-route-forbidden',403);uint(maxBytes,1,1048576);need(this.active<4,'pilot-transport-busy',429);need(!outer?.aborted,'pilot-aborted',408);
  const encoded=canonical(body);need(Buffer.byteLength(encoded)<=70000,'pilot-request-too-large',413);this.active++;
  const abort=new AbortController(),expires=performance.now()+this.timeoutMs,cancel=()=>abort.abort();outer?.addEventListener('abort',cancel,{once:true});const timer=setTimeout(cancel,this.timeoutMs);
  const interrupted=new Promise<never>((_,reject)=>abort.signal.addEventListener('abort',()=>reject(new PilotError('pilot-transport-timeout',504)),{once:true}));
  const operation=(async()=>{let response:Response|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined,cleanup:Promise<void>|undefined;
   const check=()=>need(!abort.signal.aborted&&performance.now()<expires,'pilot-aborted',504);const stop=()=>{if(!cleanup&&reader)cleanup=reader.cancel();return cleanup;};abort.signal.addEventListener('abort',()=>{void stop()?.catch(()=>{});},{once:true});
   try{check();const current=credential(reference);need(capturedToken===undefined||capturedToken===current,'pilot-credential-binding-changed',409);const token=capturedToken??current;check();response=await fetch(this.origin+path,{method:'POST',redirect:'error',credentials:'omit',signal:abort.signal,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:encoded} as unknown as RequestInit);check();need(!response.redirected,'pilot-upstream-redirect');
    if(response.status!==200)throw new PilotError([401,403,409,429].includes(response.status)?'pilot-upstream-'+response.status:'pilot-upstream-failed',response.status>=400&&response.status<500?response.status:503);
    const type=response.headers.get('content-type')??'';need(binary?/^application\/octet-stream(?:;|$)/i.test(type):/^application\/json(?:;|$)/i.test(type),'pilot-upstream-media');need(response.body,'pilot-upstream-body');
    const length=response.headers.get('content-length');if(length!==null)need(/^(0|[1-9][0-9]{0,6})$/.test(length)&&Number(length)<=maxBytes,'pilot-upstream-size');reader=response.body!.getReader();const bytes=new Uint8Array(maxBytes);let count=0;
    for(let chunks=0;;chunks++){check();need(chunks<65536,'pilot-upstream-chunks');const part=await reader.read();check();if(part.done)break;const copy=boundedBytes(part.value,maxBytes-count);bytes.set(copy,count);count+=copy.byteLength;}
    need(length===null||Number(length)===count,'pilot-upstream-length');if(binary)return bytes.slice(0,count);const data=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes.subarray(0,count)));canonical(data);return data;
   }catch(e){if(e instanceof PilotError)throw e;throw new PilotError('pilot-upstream-unavailable');}finally{try{if(reader){try{await stop();}finally{reader.releaseLock();}}else await response?.body?.cancel();}catch{/* no provider text */}}
  })();void operation.then(()=>{this.active--;},()=>{this.active--;});
  try{return await Promise.race([operation,interrupted]);}finally{clearTimeout(timer);outer?.removeEventListener('abort',cancel);abort.abort();}
 }
 async discover(reference:string,signal?:AbortSignal):Promise<{environment:string;authorityId:string;epoch:number;schemaVersion:number}>{need(this.target.authorityId===undefined,'pilot-discovery-mode-required');const s=await this.request(reference,'/v1/status',{},65536,false,signal) as any;need(s?.ok===true&&s.environment===this.target.environment,'pilot-authority-binding');id(s.authorityId);uint(s.epoch,1);uint(s.schemaVersion,1);return {environment:s.environment,authorityId:s.authorityId,epoch:s.epoch,schemaVersion:s.schemaVersion};}
 async workerStatus(reference:string,signal?:AbortSignal):Promise<{environment:string;authorityId:string;epoch:number}>{
  const expected=this.target.authorityId;need(typeof expected==='string','pilot-authority-pin-required');
  const s=await this.request(reference,'/v1/worker/status',{},65536,false,signal) as any;
  need(s?.ok===true&&s.environment===this.target.environment&&s.authorityId===expected,'pilot-authority-binding');uint(s.epoch,1);
  return {environment:s.environment,authorityId:s.authorityId,epoch:s.epoch};
 }
 async status(reference:string,signal?:AbortSignal,capturedToken?:string):Promise<{environment:string;authorityId:string;epoch:number}>{const expected=this.target.authorityId;need(typeof expected==='string','pilot-authority-pin-required');const s=await this.request(reference,'/v1/status',{},65536,false,signal,capturedToken) as any;need(s?.ok===true&&s.environment===this.target.environment&&s.authorityId===expected,'pilot-authority-binding');uint(s.epoch,1);return {environment:s.environment,authorityId:s.authorityId,epoch:s.epoch};}
}
