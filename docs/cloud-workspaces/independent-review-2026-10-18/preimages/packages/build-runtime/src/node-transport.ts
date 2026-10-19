import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import { canonicalData } from './parent-profile.js';
import { check } from './plans.js';
export type WorkerRoute = '/v1/builds/commands'|'/v1/builds/next'|'/v1/enrollment/heartbeat';
export interface WorkerRequestPort { request(path:WorkerRoute,body:unknown,signal:AbortSignal):Promise<unknown> }
export interface FixedOriginConfig { origin:string; credentialRef:string }
/** Host credential reference resolver only; no env/files/config credential discovery. */
export interface BearerReferencePort { resolve(reference:string,signal:AbortSignal):Promise<string> }
/** Inert bounded HTTPS transport. Requests serialize through at most eight occupied
 * slots, including expired work waiting for settlement. No retry or late success. */
export class NodeBuildTransport implements WorkerRequestPort {
  private readonly origin:string; private readonly credentialRef:string;
  private pending = 0;
  private tail:Promise<void> = Promise.resolve();
  constructor(config:FixedOriginConfig,private readonly credentials:BearerReferencePort) {
    const url = new URL(config.origin);
    check(url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash,'fixed-https-origin-required');
    check(typeof config.credentialRef === 'string' && config.credentialRef.length > 0,'credential-reference-required');
    this.origin = url.origin; this.credentialRef = config.credentialRef;
  }
  async request(path:WorkerRoute,body:unknown,parent:AbortSignal):Promise<unknown> {
    const deadlineAt = performance.now()+8000;
    check(!parent.aborted,'request-aborted');
    check(this.pending < 8,'worker-transport-occupied');
    check(path === '/v1/builds/commands' || path === '/v1/builds/next' || path === '/v1/enrollment/heartbeat','route-not-allowed');
    // Snapshot before the first await; queued callers cannot mutate outbound JSON.
    const encoded = canonicalData(body);check(Buffer.byteLength(encoded) <= 70000,'request-byte-limit');
    const previous = this.tail;let release!:()=>void;
    this.tail = new Promise<void>(resolve => {release = resolve;});this.pending++;
    const abort = new AbortController();
    let rejectStop!:(reason:Error)=>void;
    const stopped = new Promise<never>((_,reject) => {rejectStop = reject;});
    const cancel = () => {abort.abort();rejectStop(new Error('worker-request-aborted'));};
    const fence = () => {check(!parent.aborted && !abort.signal.aborted && performance.now() < deadlineAt,'worker-request-deadline');};
    parent.addEventListener('abort',cancel,{once:true});
    if (parent.aborted) cancel();
    const timer = setTimeout(cancel,Math.max(1,deadlineAt-performance.now()));
    // This promise owns occupancy, including cancellation/reader cleanup. The outward
    // deadline race can reject sooner without admitting another underlying request.
    const work = (async ():Promise<unknown> => {
      await previous;fence();
      const bearer = await this.credentials.resolve(this.credentialRef,abort.signal);fence();
      check(typeof bearer === 'string' && bearer.length > 0 && bearer.length <= 8192 && !/[\r\n\0]/.test(bearer),'invalid-host-bearer');
      const response = await fetch(this.origin+path,{method:'POST',redirect:'error',credentials:'omit',cache:'no-store',signal:abort.signal,
        headers:{'content-type':'application/json',authorization:`Bearer ${bearer}`},body:encoded});
      // Always settle/cancel the actual response stream before releasing occupancy.
      const reader = response.body?.getReader();
      try {
        fence();check(response.ok && reader,'worker-request-failed');
        const media = (response.headers.get('content-type') ?? '').split(';',1)[0]!.trim().toLowerCase();
        check(/^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)$/.test(media),'json-media-required');
        const length = response.headers.get('content-length');
        check(length === null || (/^[0-9]+$/.test(length) && Number(length) <= 262144),'response-byte-limit');
        let size = 0, count = 0;const chunks:Buffer[] = [];
        for (;;) {
          fence();const next = await reader.read();fence();if (next.done) break;
          check(types.isUint8Array(next.value) && !types.isProxy(next.value),'native-response-chunk-required');
          check(++count <= 1024 && next.value.byteLength <= 262144 && (size += next.value.byteLength) <= 262144,'response-stream-limit');
          chunks.push(Buffer.from(next.value));
        }
        fence();const parsed:unknown = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size)));fence();return parsed;
      } finally {
        if (reader) {await reader.cancel().catch(() => {});reader.releaseLock();}
      }
    })();
    // Both handlers consume settlement even if Promise.race already rejected.
    const settled = () => {this.pending--;release();};
    void work.then(settled,settled);
    try {const value = await Promise.race([work,stopped]);fence();return value;}
    catch {throw new Error('worker-transport-unavailable');}
    finally {clearTimeout(timer);parent.removeEventListener('abort',cancel);abort.abort();}
  }
}
