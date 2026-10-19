import {HttpFailure} from '../../../workers/compute/src/http';
import {canonical,freeze} from '../../library-jobs/src/data';
import type {Delivery,FencePage,DeliveryPort,RevocationContext} from './types';
import {RevocationRelay} from './index';
interface Endpoint {origin:string;credentialRef:string}
interface TargetEndpoint extends Endpoint {kind:'catalog'|'broker';projectId:string;authorityId:string}
export interface RelayHttpConfig {enabled?:boolean;environment:string;sourceAuthorityId:string;compute:Endpoint;targets:TargetEndpoint[]}
export interface RelayHttpPorts {
 credential(reference:string,signal:AbortSignal):Promise<string>;
 fetch(request:Request):Promise<Response>;
}
// Process-wide occupancy: constructing another relay cannot bypass a hung call.
const MAX_INFLIGHT=4;let inflight=0;
async function responseJson(response:Response,signal:AbortSignal,expiresAt:number,quarantine:()=>void):Promise<unknown>{
 if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??'')){
  await response.body?.cancel().catch(()=>quarantine());throw new HttpFailure(415,'relay-json-required');
 }
 const reader=response.body?.getReader();if(!reader)throw new HttpFailure(400,'relay-body-required');
 let cancelling:Promise<void>|undefined;
 const abort=()=>{cancelling??=reader.cancel().catch(()=>quarantine());};
 signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
 const bytes=new Uint8Array(65536);let used=0;
 try{
  for(let reads=0;;reads++){
   if(signal.aborted||Date.now()>=expiresAt)throw new Error('relay timeout');
   if(reads>=65536)throw new HttpFailure(413,'relay-chunks');
   // No inner logical race: the outer caller can time out, while this operation
   // retains its slot until the actual read AND cancellation have settled.
   const {value,done}=await reader.read();if(signal.aborted)throw new Error('relay timeout');
   if(done)break;if(value.byteLength>bytes.length-used)throw new HttpFailure(413,'relay-body-limit');
   bytes.set(value,used);used+=value.byteLength;
  }
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes.subarray(0,used)));}
  catch{throw new HttpFailure(400,'relay-invalid-json');}
 }catch(e){abort();throw e;}
 finally{signal.removeEventListener('abort',abort);if(cancelling)await cancelling;reader.releaseLock();}
}
/** Host-fixed origins and credential references only. No request may select a URL or bearer. */
export function relayHttp(config:RelayHttpConfig,ports:RelayHttpPorts):DeliveryPort&{readPage(after:number):Promise<FencePage>}{
 const policy=freeze(JSON.parse(canonical(config)) as RelayHttpConfig);
 if(!policy.compute||!Array.isArray(policy.targets)||policy.targets.length>128)throw new Error('invalid relay config');
 for(const e of [policy.compute,...policy.targets]){
  const url=new URL(e.origin);if(url.protocol!=='https:'||url.pathname!=='/'||url.username||url.password||url.search||url.hash||typeof e.credentialRef!=='string'||!/^[A-Za-z0-9_-]{1,96}(?![\s\S])/.test(e.credentialRef))throw new Error('invalid relay endpoint');
 }
 const names=new Set<string>();for(const t of policy.targets){const name=canonical([t.kind,t.projectId,t.authorityId]);if(names.has(name)||!['catalog','broker'].includes(t.kind)||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?![\s\S])/.test(t.projectId))throw new Error('invalid target');names.add(name);}
 async function post(e:Endpoint,path:string,body:unknown):Promise<any>{
  if(policy.enabled!==true)throw new Error('relay disabled');
  // Deny excess work before any credential, fetch or body operation starts.
  if(inflight>=MAX_INFLIGHT)throw new Error('relay busy');
  inflight++;let uncertain=false;const quarantine=()=>{uncertain=true;};
  const abort=new AbortController(),expiresAt=Date.now()+5000,timer=setTimeout(()=>abort.abort(),5000);
  const deadline=new Promise<never>((_,reject)=>{abort.signal.addEventListener('abort',()=>reject(new Error('relay timeout')),{once:true});});
  const head=(async()=>{
   const credential=await ports.credential(e.credentialRef,abort.signal);
   if(abort.signal.aborted)throw new Error('relay timeout');
   if(typeof credential!=='string'||!/^[A-Za-z0-9._~+/-]{32,}=*(?![\s\S])/.test(credential))throw new Error('credential unavailable');
   const response=await ports.fetch(new Request(new URL(path,e.origin),{method:'POST',redirect:'error',signal:abort.signal,headers:{'content-type':'application/json',authorization:'Bearer '+credential},body:canonical(body)}));
   if(abort.signal.aborted){await response.body?.cancel().catch(()=>quarantine());throw new Error('relay timeout');}
   if(response.status!==200){await response.body?.cancel().catch(()=>quarantine());throw new HttpFailure(response.status,'relay-target-response');}
   return response;
  })();
  // The admission slot is released only when the underlying operation (including
  // late body cleanup) actually settles, never when the logical deadline returns.
  const operation=(async()=>{
   try{
    const response=await head;
    return await responseJson(response,abort.signal,expiresAt,quarantine);
   }finally{if(!uncertain)inflight--;}
  })();
  void operation.catch(()=>{});
  try{
   return await Promise.race([operation,deadline]);
  }finally{abort.abort();clearTimeout(timer);}
 }
 return {
  async readPage(after){
   const status=await post(policy.compute,'/v1/status',{});
   if(status.ok!==true||status.environment!==policy.environment||status.authorityId!==policy.sourceAuthorityId||!Number.isSafeInteger(status.epoch)||status.epoch<1)throw new Error('source binding');
   return await post(policy.compute,'/v1/library/fences',{expectedEpoch:status.epoch,after,limit:64}) as FencePage;
  },
  async deliver(d:Delivery){
   const e=policy.targets.find(x=>x.authorityId===d.target.authorityId&&x.projectId===d.target.projectId&&x.kind===d.target.kind);
   if(!e||d.target.environment!==policy.environment)throw new Error('target not configured');
   return post(e,e.kind==='catalog'?`/v1/library/${e.projectId}/revocations`:'/v1/broker/revocations',{delivery:d});
  }
 };
}
/** Pending cancellation can proceed even while the source is temporarily unavailable. */
export async function relayStep(relay:RevocationRelay,context:RevocationContext,http:ReturnType<typeof relayHttp>){
 const delivered=await relay.deliverOne(context,http);
 let page:FencePage;try{page=await http.readPage(relay.cursor(context));}catch{return {source:'unavailable' as const,delivery:delivered.status};}
 // Persistence errors are not classified as transport errors.
 relay.ingest(context,page);
 const next=delivered.status==='idle'?await relay.deliverOne(context,http):delivered;
 return {source:page.through===page.head?'caught-up' as const:'partial' as const,through:relay.cursor(context),head:page.head,delivery:next.status};
}
