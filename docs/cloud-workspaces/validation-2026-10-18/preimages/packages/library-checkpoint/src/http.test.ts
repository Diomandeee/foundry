import {describe,it,expect,vi,afterEach} from 'vitest';
import {reconcilerHttp,type ReconcilerHttpConfig,type ReconcilerHttpPorts} from './http';
const config:ReconcilerHttpConfig={enabled:true,environment:'local',sourceAuthorityId:'compute',origin:'https://compute.fixture',credentialRef:'managed-compute-owner'};
const credential='fixture-only-owner-000000000000000000000000';
const binding={authorityId:'compute',workloadId:'job',leaseId:'lease',attemptId:'lease',capabilityDigest:'a'.repeat(64),workerId:'mac',epoch:1,generation:0,incarnation:0};
const status={ok:true,environment:'local',authorityId:'compute',epoch:1};
function setup(override:Partial<ReconcilerHttpPorts>={},cfg=config){const requests:Request[]=[];const ports={credential:vi.fn(async()=>credential),fetch:vi.fn(async(r:Request)=>{requests.push(r);return Response.json(r.url.endsWith('/v1/status')?status:{fixture:true});}),...override};return {requests,ports,http:reconcilerHttp(cfg,ports)};}
const signal=()=>new AbortController().signal;
afterEach(()=>vi.useRealTimers());
describe('fixed host authenticated recovery source transport',()=>{
 it('uses current epoch, fixed routes, exact compute binding, and managed references',async()=>{
  const h=setup();expect(await h.http.observe(binding,signal())).toEqual({fixture:true});expect(await h.http.readPage(12,signal())).toEqual({fixture:true});
  expect(h.requests.map(r=>new URL(r.url).pathname)).toEqual(['/v1/status','/v1/library/fence','/v1/status','/v1/library/fences']);
  for(const r of h.requests){expect(r.redirect).toBe('error');expect(r.headers.get('authorization')).toBe('Bearer '+credential);expect(new URL(r.url).origin).toBe(config.origin);}
  expect(await h.requests[1].json()).toEqual({expectedEpoch:1,binding});expect(await h.requests[3].json()).toEqual({expectedEpoch:1,after:12,limit:64});expect(h.ports.credential).toHaveBeenCalledWith(config.credentialRef);
 });
 it.each(['http://compute.fixture','https://a:b@compute.fixture','https://compute.fixture/path','https://compute.fixture?x=y','https://compute.fixture#x'])('rejects unsafe endpoint %s',origin=>{expect(()=>setup({}, {...config,origin})).toThrow();});
 it('is disabled by default and does not read credentials',async()=>{const {enabled,...disabled}=config;const h=setup({}, disabled);await expect(h.http.observe(binding,signal())).rejects.toThrow('DISABLED');expect(h.ports.credential).not.toHaveBeenCalled();});
 it.each([{...status,environment:'other'},{...status,authorityId:'other'},{...status,epoch:0},{...status,epoch:1.5},{...status,ok:false}])('rejects foreign status %j',async reply=>{const h=setup({fetch:async()=>Response.json(reply)});await expect(h.http.observe(binding,signal())).rejects.toThrow('SOURCE');});
 it.each([-1,1.5,Number.MAX_SAFE_INTEGER+1])('rejects cursor %s before credentials',async cursor=>{const h=setup();await expect(h.http.readPage(cursor,signal())).rejects.toThrow('CURSOR');expect(h.ports.fetch).not.toHaveBeenCalled();});
 it('rejects unavailable credentials without exposing port error values',async()=>{const h=setup({credential:async()=>''});await expect(h.http.observe(binding,signal())).rejects.toThrow('HTTP_FAILED');expect(h.ports.fetch).not.toHaveBeenCalled();});
 it.each([302,401,500])('rejects status %s and cancels body',async code=>{let cancelled=false;const h=setup({fetch:async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{status:code})});await expect(h.http.observe(binding,signal())).rejects.toThrow('HTTP_FAILED');expect(cancelled).toBe(true);});
 it('bounds JSON before parsing',async()=>{const h=setup({fetch:async()=>Response.json({data:'x'.repeat(65537)})});await expect(h.http.observe(binding,signal())).rejects.toThrow('HTTP_FAILED');});
 it('rejects redirected successful responses',async()=>{const r=Response.json(status);Object.defineProperty(r,'redirected',{value:true});await expect(setup({fetch:async()=>r}).http.observe(binding,signal())).rejects.toThrow('HTTP_FAILED');});
 it('aborts before starting work when the caller has already aborted',async()=>{const h=setup(),a=new AbortController();a.abort();await expect(h.http.observe(binding,a.signal)).rejects.toThrow('ABORT');expect(h.ports.credential).not.toHaveBeenCalled();});
 it('retains four actual outstanding fetches after timeout and releases only on settlement',async()=>{
  vi.useFakeTimers();const resolve:((r:Response)=>void)[]=[];const h=setup({fetch:async()=>new Promise<Response>(done=>resolve.push(done))});
  const pending=Array.from({length:4},()=>h.http.observe(binding,signal()).catch(e=>e.message));await vi.advanceTimersByTimeAsync(1001);expect(await Promise.all(pending)).toEqual(Array(4).fill('RECONCILER_HTTP_TIMEOUT'));
  await expect(h.http.observe(binding,signal())).rejects.toThrow('BUSY');expect(resolve).toHaveLength(4);
  for(const done of resolve)done(Response.json(status));await vi.advanceTimersByTimeAsync(1);
  const retry=h.http.observe(binding,signal()).catch(e=>e.message);await vi.advanceTimersByTimeAsync(1001);expect(await retry).toBe('RECONCILER_HTTP_TIMEOUT');expect(resolve).toHaveLength(5);resolve[4](Response.json(status));await vi.advanceTimersByTimeAsync(1);
 });
 it('sanitizes credential and fetch port exceptions',async()=>{for(const port of [{credential:async()=>{throw new Error('fixture-private-error');}},{fetch:async()=>{throw new Error('fixture-private-error');}}])await expect(setup(port).http.observe(binding,signal())).rejects.toThrow(/^RECONCILER_HTTP_FAILED$/);});
 it('retains admission while response cancellation ignores abort',async()=>{vi.useFakeTimers();const h=setup({fetch:async()=>new Response(new ReadableStream({cancel:()=>new Promise<void>(()=>{})}),{status:500})});const pending=Array.from({length:4},()=>h.http.observe(binding,signal()).catch(e=>e.message));await vi.advanceTimersByTimeAsync(1001);expect(await Promise.all(pending)).toEqual(Array(4).fill('RECONCILER_HTTP_TIMEOUT'));await expect(h.http.observe(binding,signal())).rejects.toThrow('BUSY');});
 it.each(['oversize','read-timeout'])('retains four parser cancellation promises on %s',async mode=>{vi.useFakeTimers();let unresolved=0;const releases:(()=>void)[]=[];const h=setup({fetch:async()=>new Response(new ReadableStream({start(c){if(mode==='oversize')c.enqueue(new Uint8Array(65537));},cancel:()=>{unresolved++;return new Promise<void>(done=>releases.push(done));}}),{headers:{'content-type':'application/json'}})});const pending=Array.from({length:4},()=>h.http.observe(binding,signal()).catch(e=>e.message));await vi.advanceTimersByTimeAsync(1001);expect(await Promise.all(pending)).toEqual(Array(4).fill('RECONCILER_HTTP_TIMEOUT'));expect(unresolved).toBe(4);await expect(h.http.observe(binding,signal())).rejects.toThrow('BUSY');releases.forEach(done=>done());await vi.advanceTimersByTimeAsync(1);});
 it('timeout covers credential lookup and stops a late credential from starting a fetch',async()=>{
  vi.useFakeTimers();let done!:(s:string)=>void;const h=setup({credential:()=>new Promise<string>(resolve=>{done=resolve;})});const pending=h.http.observe(binding,signal()).catch(e=>e.message);await vi.advanceTimersByTimeAsync(1001);expect(await pending).toBe('RECONCILER_HTTP_TIMEOUT');done(credential);await vi.advanceTimersByTimeAsync(1);expect(h.ports.fetch).not.toHaveBeenCalled();
 });
});
