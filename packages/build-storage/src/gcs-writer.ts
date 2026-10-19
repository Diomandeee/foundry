import {performance} from 'node:perf_hooks';
import {createGcsReader} from '../../library-gcs/src/index';
import {identifier} from '../../library-jobs/src/data';
import {alive, boundedBytes, canonical, check, CHUNK_BYTES, exactRef, freeze, sha256, snapshot} from './checks';
import type {GcsWritePorts, GcsWriterConfig, TrustedWriter} from './types';

/** Construction only validates config/captures private ports. No network or token lookup.
 * No overwrite, retry, delete, list, SDK, signed URL, ambient fetch or ambient credentials. */
export function createGcsWriter(config:GcsWriterConfig, ports:GcsWritePorts):TrustedWriter {
  const c=freeze(snapshot(config) as GcsWriterConfig);
  // Reuse the existing streaming reader for independent pinned-generation byte readback.
  const reader=createGcsReader(c,{
    getAccessToken:(ref,signal)=>ports.getAccessToken(ref,signal),
    fetch:(url,init)=>ports.fetch(url,{...init,credentials:'omit'}),
  });
  const fetchPort=ports.fetch.bind(ports), tokenPort=ports.getAccessToken.bind(ports);
  const timeoutMs=c.limits?.timeoutMs ?? 10000;
  let active=0;
  return Object.freeze({async write(projectId:string,kind:'objects'|'manifests',input:Uint8Array,signal:AbortSignal) {
    identifier(projectId); check(projectId===c.projectId,'writer-project');
    check(kind==='objects'||kind==='manifests','writer-kind');
    const bytes=boundedBytes(input,Math.min(CHUNK_BYTES,c.limits?.maxReadBytes??CHUNK_BYTES)); check(bytes.length>0,'empty-object');
    alive(signal); check(active<Math.min(2,c.limits?.maxActiveReads??2),'writer-capacity'); active++;
    const digest=sha256(bytes), objectKey=`projects/${projectId}/${kind}/${digest}`;
    const abort=new AbortController(), deadline=performance.now()+timeoutMs;
    let response:Response|undefined, stream:ReadableStreamDefaultReader<Uint8Array>|undefined;
    let rejectAbort!:(e:Error)=>void;
    const cancelled=new Promise<never>((_,reject)=>{rejectAbort=reject;});
    const cancel=()=>{abort.abort(); rejectAbort(new Error('build-storage: write-aborted-outcome-unknown'));};
    signal.addEventListener('abort',cancel,{once:true});
    const timer=setTimeout(cancel,timeoutMs);
    if(signal.aborted) cancel();
    const guard=()=>check(!abort.signal.aborted&&performance.now()<deadline,'write-deadline');
    const operation=(async()=>{
      try {
        guard(); const token=await tokenPort(c.credentialRef,abort.signal); guard();
        check(typeof token==='string'&&token.length<=8192&&/^[A-Za-z0-9._~+/-]+=*$/.test(token),'credential-unavailable');
        const url=new URL(`/upload/storage/v1/b/${c.bucket}/o`,c.origin);
        url.searchParams.set('uploadType','media'); url.searchParams.set('name',objectKey);
        url.searchParams.set('ifGenerationMatch','0');
        url.searchParams.set('fields','bucket,name,generation,size,contentEncoding');
        response=await fetchPort(url.href,{method:'POST',redirect:'manual',cache:'no-store',credentials:'omit',
          signal:abort.signal,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/octet-stream','Accept-Encoding':'identity'},body:bytes});
        guard();
        check(!response.redirected&&response.url===url.href,'create-response-origin');
        if(response.status===412) {
          // Content-addressed deduplication is allowed ONLY after independent metadata
          // discovery and pinned actual-byte readback. A conflict itself proves nothing.
          await response.body?.cancel(); response=undefined; guard();
          const existing=new URL(`/storage/v1/b/${c.bucket}/o/${encodeURIComponent(objectKey)}`,c.origin);
          existing.searchParams.set('fields','bucket,name,generation,size,contentEncoding');
          response=await fetchPort(existing.href,{method:'GET',redirect:'manual',cache:'no-store',credentials:'omit',
            signal:abort.signal,headers:{Authorization:`Bearer ${token}`,'Accept-Encoding':'identity'}});
          guard(); check(!response.redirected&&response.url===existing.href,'existing-response-origin');
        }
        check(response.status===200,'create-not-confirmed');
        check(response.headers.get('content-type')?.split(';')[0].trim()==='application/json','create-response');
        check(!response.headers.has('content-range')&&[null,'identity'].includes(response.headers.get('content-encoding')),'create-encoding');
        const limit=c.limits?.metadataBytes??16384, length=response.headers.get('content-length');
        if(length!==null) check(/^(0|[1-9][0-9]{0,5})$/.test(length)&&Number(length)<=limit,'create-response-size');
        check(response.body,'create-response-body'); stream=response.body.getReader();
        const metadata=new Uint8Array(limit); let used=0;
        for(let reads=0;;reads++) {
          guard(); check(reads<16385,'create-response-chunks');
          const part=await stream.read(); guard(); if(part.done) break;
          const b=boundedBytes(part.value,limit-used); check(b.length>0,'create-response-progress');
          metadata.set(b,used); used+=b.length;
        }
        if(length!==null) check(length===String(used),'create-response-length');
        stream.releaseLock(); stream=undefined; response=undefined;
        const meta=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(metadata.subarray(0,used))) as Record<string,unknown>;
        check(meta&&typeof meta==='object'&&!Array.isArray(meta)&&meta.bucket===c.bucket&&meta.name===objectKey&&meta.size===String(bytes.length),'create-metadata');
        check(meta.contentEncoding===undefined||meta.contentEncoding==='identity','object-encoding');
        const ref=exactRef({projectId,objectKey,generation:meta.generation,sha256:digest,sizeBytes:bytes.length},projectId,kind);
        guard(); const actual=await reader.readObject(ref,bytes.length,abort.signal); guard();
        check(canonical(actual.ref)===canonical(ref)&&actual.bytes.length===bytes.length&&sha256(actual.bytes)===digest,'write-byte-readback');
        return ref;
      } catch {throw new Error('build-storage: create-or-byte-readback-failed-outcome-unknown');}
      finally {
        try {if(stream) {await stream.cancel(); stream.releaseLock();} else await response?.body?.cancel();} catch { /* No upstream error/token propagation. */ }
        active--; // Held until even an uncooperative private provider actually settles.
      }
    })();
    try {return await Promise.race([operation,cancelled]);}
    finally {clearTimeout(timer); signal.removeEventListener('abort',cancel);}
  }});
}
