import {canonical,freeze,boundedBytes} from '../../library-jobs/src/data';
import {identifier,need} from '../../library-catalog/src/validation';
import type {ComputeBinding} from '../../library-jobs/src/types';
import {performance} from 'node:perf_hooks';
export interface ReconcilerHttpConfig {enabled?:boolean;environment:string;sourceAuthorityId:string;origin:string;credentialRef:string}
export interface ReconcilerHttpPorts {credential(reference:string):Promise<string>;fetch(request:Request):Promise<Response>}
/** Owner credential stays in the host. No inbound value selects a URL or credential reference. */
export function reconcilerHttp(input:ReconcilerHttpConfig,ports:ReconcilerHttpPorts){
 const c=freeze(JSON.parse(canonical(input)) as ReconcilerHttpConfig);identifier(c.environment);identifier(c.sourceAuthorityId);identifier(c.credentialRef);
 const origin=new URL(c.origin);need(origin.protocol==='https:'&&origin.pathname==='/'&&!origin.username&&!origin.password&&!origin.search&&!origin.hash,'RECONCILER_HTTP_CONFIG');
 let active=0;
 async function post(path:string,body:unknown,outer:AbortSignal):Promise<any>{
  need(c.enabled===true,'RECONCILER_HTTP_DISABLED',503);need(active<4,'RECONCILER_HTTP_BUSY',429);need(!outer.aborted,'RECONCILER_HTTP_ABORT');active++;
  const abort=new AbortController(),cancel=()=>abort.abort();outer.addEventListener('abort',cancel,{once:true});
  const timer=setTimeout(cancel,1000);
  const interrupted=new Promise<never>((_,reject)=>abort.signal.addEventListener('abort',()=>reject(new Error('RECONCILER_HTTP_TIMEOUT')),{once:true}));
  const deadline=performance.now()+1000;
  const work=(async()=>{
   let response:Response|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined,cancelling:Promise<void>|undefined;
   const guard=()=>need(!abort.signal.aborted&&performance.now()<deadline,'RECONCILER_HTTP_ABORT');
   const cleanup=()=>{if(!cancelling&&reader)cancelling=reader.cancel();return cancelling;};
   abort.signal.addEventListener('abort',()=>{void cleanup()?.catch(()=>{});},{once:true});
   try{
    const credential=await ports.credential(c.credentialRef);need(!abort.signal.aborted,'RECONCILER_HTTP_ABORT');
    need(typeof credential==='string'&&/^[A-Za-z0-9._~+/-]{32,}=*(?![\s\S])/.test(credential),'RECONCILER_HTTP_CREDENTIAL');
    response=await ports.fetch(new Request(new URL(path,origin),{method:'POST',redirect:'error',signal:abort.signal,headers:{'content-type':'application/json',authorization:'Bearer '+credential},body:canonical(body)}));
    need(!abort.signal.aborted&&!response.redirected&&response.status===200,'RECONCILER_HTTP_RESPONSE');
    need(/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??'')&&response.body!==null,'RECONCILER_HTTP_JSON');
    const length=response.headers.get('content-length');if(length!==null)need(/^(0|[1-9][0-9]{0,5})(?![\s\S])/.test(length)&&Number(length)<=65536,'RECONCILER_HTTP_BYTES');
    reader=response.body!.getReader();const bytes=new Uint8Array(65536);let count=0;
    for(let chunks=0;;chunks++){guard();need(chunks<65536,'RECONCILER_HTTP_CHUNKS');const {value,done}=await reader.read();guard();if(done)break;const part=boundedBytes(value,65536-count);bytes.set(part,count);count+=part.length;}
    need(length===null||length===String(count),'RECONCILER_HTTP_LENGTH');const reply=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes.subarray(0,count)));guard();return reply;
   }catch{throw new Error('RECONCILER_HTTP_FAILED');}finally{try{if(reader){try{await cleanup();}finally{reader.releaseLock();}}else await response?.body?.cancel();}catch{/* Suppress provider details; retain original cleanup promise in work. */}}

  })();
  void work.then(()=>{active--;},()=>{active--;});
  try{return await Promise.race([work,interrupted]);}finally{clearTimeout(timer);outer.removeEventListener('abort',cancel);abort.abort();}
 }
 async function epoch(signal:AbortSignal){const s=await post('/v1/status',{},signal);need(s.ok===true&&s.environment===c.environment&&s.authorityId===c.sourceAuthorityId&&Number.isSafeInteger(s.epoch)&&s.epoch>=1,'RECONCILER_HTTP_SOURCE');return s.epoch as number;}
 return {
  async observe(binding:ComputeBinding,signal:AbortSignal):Promise<unknown>{return post('/v1/library/fence',{expectedEpoch:await epoch(signal),binding},signal);},
  async readPage(after:number,signal:AbortSignal):Promise<unknown>{need(Number.isSafeInteger(after)&&after>=0,'RECONCILER_HTTP_CURSOR');return post('/v1/library/fences',{expectedEpoch:await epoch(signal),after,limit:64},signal);}
 };
}
