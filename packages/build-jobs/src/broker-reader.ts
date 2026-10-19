import type {BuildPorts,ArtifactClaim} from './contracts';
import {BuildError,need,hash} from './validation';
/** Server-only credential; no provider credential or raw upstream error enters an artifact. */
export function buildBrokerReader(origin:string,credential:()=>string,transport:typeof fetch=fetch):NonNullable<BuildPorts['readArtifact']>{
 const url=new URL(origin);need(url.protocol==='https:'&&url.origin===origin&&!url.username&&!url.password,'build-broker-origin');
 let active=0;
 return async(claim:ArtifactClaim,scope,signal)=>{
  need(active<4,'build-broker-busy',429);active++;
  let response:Response|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  try{
   const token=credential();need(/^[A-Za-z0-9._~+/-]{32,}=*$/.test(token),'build-broker-credential');
   response=await transport(origin+'/v1/broker/build-read',{method:'POST',redirect:'error',credentials:'omit',signal,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({grantId:claim.grantId,requestId:hash({grantId:claim.grantId,scope}),scope,ref:claim.ref})} as RequestInit);
   need(response.status===200&&!response.redirected&&/^application\/octet-stream(?:;|$)/i.test(response.headers.get('content-type')??'')&&response.body,'build-broker-unavailable',503);
   const bytes=new Uint8Array(claim.ref.sizeBytes);let size=0;reader=response.body!.getReader();
   for(let chunks=0;;chunks++){need(chunks<65536&&!signal.aborted,'build-broker-interrupted',503);const p=await reader.read();if(p.done)break;need(p.value.byteLength<=bytes.length-size,'build-broker-size');bytes.set(p.value,size);size+=p.value.byteLength;}
   need(size===bytes.length,'build-broker-size');return bytes;
  }catch(e){if(e instanceof BuildError)throw e;throw new BuildError('build-broker-unavailable',503);}
  finally{try{if(reader){await reader.cancel();reader.releaseLock();}else await response?.body?.cancel();}catch{}active--;}
 };
}
