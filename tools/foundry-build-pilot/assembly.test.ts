import {DatabaseSync} from 'node:sqlite';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {prepareHost} from './host.js';
import {composeStorage,type StorageBoundaries} from './storage.js';
import {fixture,input,inputBytes,receipt,digest} from './test-fixtures.js';
import {NodeWorkerLiveness} from '../../packages/build-runtime/src/liveness.js';
import {HostJournal} from '../../packages/build-runtime/src/host.js';
import {LinuxIsolatedRuntimeAdapter,type LinuxIsolatedAdapterConfig} from '../../packages/build-runtime/src/linux-isolated-adapter.js';
import {publishLinuxCapture} from '../../packages/build-runtime/src/linux-isolated-publication.js';
import {projectObjectReader} from '../../packages/build-storage/src/project-input-io.js';
import type {BuildAttemptContext} from '../../packages/build-runtime/src/controller.js';
import type {GcsWritePorts} from '../../packages/build-storage/src/types.js';
import {bytesHash} from '../../packages/build-jobs/src/validation.js';
const originalPlatform=Object.getOwnPropertyDescriptor(process,'platform')!;
const handles:DatabaseSync[]=[];
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();Object.defineProperty(process,'platform',originalPlatform);for(const db of handles.splice(0))db.close();});
function setup(options:{cancel?:boolean;deny?:boolean}={}){
  Object.defineProperty(process,'platform',{...originalPlatform,value:'linux'});
  const c=fixture(),source={environment:'test',authorityId:'test-authority',epoch:4};
  const commands:string[]=[],objects=new Map<string,{bytes:Uint8Array;generation:string}>([[input.manifest.objectKey,{bytes:inputBytes,generation:'7'}]]);
  let context:BuildAttemptContext|undefined,readBack:Uint8Array|undefined;
  let retryInput:((signal:AbortSignal)=>Promise<unknown>)|undefined;
  let independentResult:((ports:StorageBoundaries)=>Promise<unknown>)|undefined;
  const record=vi.fn(async()=>{}),finish=vi.fn(async()=>{}),stop=vi.fn(async()=>({stopped:true,basis:'host-containment-inspect' as const,identity:'test-containment'}));
  // Filesystem journaling, host observation, and physical execution are boundaries.
  // Factories, controller/supervisor, transport, claim resolvers, broker SQL,
  // reservations/grants, GCS adapters, publication and receipt validation are real.
  vi.spyOn(HostJournal.prototype,'controllerIntent').mockResolvedValue({record,finish});
  vi.spyOn(HostJournal.prototype,'inventory').mockResolvedValue({slotPresent:false,restartPolicy:'quarantine-never-replay',entries:[]});
  vi.spyOn(HostJournal.prototype,'reserve').mockResolvedValue({recordIdentity:async()=>{},observeStop:async()=>{},finish:async()=>{}});
  vi.spyOn(NodeWorkerLiveness.prototype,'refreshLiveness').mockResolvedValue(source);
  const workerFetch=vi.fn(async(_url:unknown,init?:RequestInit)=>{
    const {command}=JSON.parse(init!.body as string);commands.push(command.operation);
    if(command.operation==='claim')return Response.json({ok:true,source,job:c.job,input,profile:c.profile,
      attempt:{id:'test-attempt',jobId:c.job.id,workerId:'test-worker',profileHash:c.serverProfileHash,epoch:4,generation:0,incarnation:0,capability:digest,vmCapabilityHash:null}});
    if(command.operation==='renew')return Response.json({ok:true,source,sequence:command.body.sequence,expiresAt:Date.now()+60000});
    if(command.operation==='stage')return Response.json({ok:true,source,staged:true,verified:false});
    return Response.json({ok:true,source});
  });vi.stubGlobal('fetch',workerFetch);
  const accessFetch:typeof fetch=vi.fn(async(_url,init)=>{
    expect(context).toBeDefined();const body=JSON.parse(init!.body as string);
    expect(body.attemptId).toBe('test-attempt');expect(body.expectedEpoch).toBe(4);
    return Response.json({ok:true,nonce:body.nonce,source,observedAt:Date.now(),expiresAt:Date.now()+60000,
      valid:!options.deny,resultReadable:false,permanentlyRevoked:false,retainedArtifacts:[],projectId:c.job.projectId,profileHash:c.job.profileHash,compute:context!.compute});
  });
  const providerFetch:GcsWritePorts['fetch']=vi.fn(async(url,init)=>{
    const u=new URL(url);let name=u.searchParams.get('name')??decodeURIComponent(u.pathname.split('/o/')[1]!);
    if(init.method==='POST'){
      expect(u.searchParams.get('ifGenerationMatch')).toBe('0');expect(init.body).toBeInstanceOf(Uint8Array);
      objects.set(name,{bytes:Uint8Array.from(init.body!),generation:'8'});
    }
    const o=objects.get(name);expect(o).toBeDefined();
    const r=u.searchParams.get('alt')==='media'?new Response(o!.bytes as BodyInit):Response.json({bucket:'test-bucket',name,generation:o!.generation,metageneration:'1',size:String(o!.bytes.length)});
    Object.defineProperty(r,'url',{value:url});return r;
  });
  const ports:StorageBoundaries={credential:vi.fn(()=> 't'.repeat(40)),fetch:accessFetch,providerFetch,
    openDatabase:vi.fn(async()=>{const db=new DatabaseSync(':memory:');handles.push(db);return db;})};
  vi.spyOn(LinuxIsolatedRuntimeAdapter.prototype,'prepareAttempt').mockImplementation(async function(this:LinuxIsolatedRuntimeAdapter,i,_job,plan,ctx,scope){
    context=ctx;const config=(this as unknown as {c:LinuxIsolatedAdapterConfig}).c;
    retryInput=signal=>config.resolveInputStorage(i,plan,ctx,signal);
    independentResult=other=>composeStorage(c,other).resolveResultStorage(c.job,plan,ctx,new AbortController().signal);
    const resolved=await config.resolveInputStorage(i,plan,ctx,scope.signal);
    expect(handles).toHaveLength(2); // Input resolution must never open publication DBs.
    expect(resolved.scope.compute).toEqual(ctx.compute);expect(resolved.scope.compute.attemptId).toBe('test-attempt');
    const reader=projectObjectReader(resolved.scope,resolved.routing,scope.signal);readBack=await reader.read(i.manifest);await reader.finish();
  });
  vi.spyOn(LinuxIsolatedRuntimeAdapter.prototype,'prepare').mockResolvedValue();
  vi.spyOn(LinuxIsolatedRuntimeAdapter.prototype,'start').mockImplementation(async()=>({identity:'test-containment',stop,inspectStopped:stop,
    completion:options.cancel?new Promise(()=>{}):Promise.resolve({code:0,signal:null,limited:false,output:new Uint8Array()})}));
  vi.spyOn(LinuxIsolatedRuntimeAdapter.prototype,'publishAttempt').mockImplementation(async function(this:LinuxIsolatedRuntimeAdapter,job,plan,_result,ctx,signal){
    const config=(this as unknown as {c:LinuxIsolatedAdapterConfig}).c;
    const resolved=await config.resolveResultStorage(job,plan,ctx,signal),bytes=Buffer.from('actual test output bytes');
    return publishLinuxCapture(job,plan,ctx,resolved.scope,config.outputs,[{path:'result.txt',bytes,sizeBytes:bytes.length,sha256:bytesHash(bytes)}],new Uint8Array(),resolved.ports,1048576,signal);
  });
  return {c,ports,commands,objects,record,finish,stop,workerFetch,readBack:()=>readBack,retryInput:(signal:AbortSignal)=>retryInput!(signal),independentResult:(other:StorageBoundaries)=>independentResult!(other)};
}
describe('real factory -> controller -> post-claim broker composition',()=>{
  it('reads pinned input, writes/reads back actual bytes, issues durable grants, and stages without verification',async()=>{
    const t=setup(),host=prepareHost(t.c,t.ports);
    expect(t.ports.openDatabase).not.toHaveBeenCalled();expect(t.ports.credential).not.toHaveBeenCalled();
    const result=await host.run(receipt,new AbortController().signal);
    expect(result.state).toBe('staged-awaiting-verifier');expect(t.readBack()).toEqual(Uint8Array.from(inputBytes));
    expect(t.commands.filter(x=>x==='claim')).toHaveLength(1);expect(t.commands).toContain('stage');expect(t.commands).not.toContain('verify');
    expect(handles).toHaveLength(4);
    expect(handles[2]!.prepare('SELECT count(*) n FROM host_grants WHERE issued=1').get()!.n).toBe(2);
    expect(t.objects.size).toBe(3);expect(t.finish).toHaveBeenCalledOnce();
  });
  it('waits for containment stop on cancellation and never stages',async()=>{
    const t=setup({cancel:true}),host=prepareHost(t.c,t.ports),abort=new AbortController();
    const running=host.run(receipt,abort.signal);
    await vi.waitFor(()=>expect(LinuxIsolatedRuntimeAdapter.prototype.start).toHaveBeenCalled(),{interval:5,timeout:3000});abort.abort();
    const result=await running;expect(result.state).toBe('stopped-without-result');expect(result.runtime?.stop.stopped).toBe(true);
    expect(t.stop).toHaveBeenCalled();expect(t.commands).not.toContain('stage');expect(t.commands.filter(x=>x==='claim')).toHaveLength(1);
  });
  it('quarantines denied storage access without staging or retrying the claim',async()=>{
    const t=setup({deny:true}),result=await prepareHost(t.c,t.ports).run(receipt,new AbortController().signal);
    expect(result.state).toBe('owner-reconciliation-required');expect(t.commands).not.toContain('stage');expect(t.finish).not.toHaveBeenCalled();
    expect(t.commands.filter(x=>x==='claim')).toHaveLength(1);expect(t.ports.providerFetch).not.toHaveBeenCalled();
  });
  it('rejects a genuine controller claim with a different approved generation before any open',async()=>{
    const t=setup();t.c.claimPolicy.generation=1;
    const result=await prepareHost(t.c,t.ports).run(receipt,new AbortController().signal);
    expect(result.state).toBe('owner-reconciliation-required');expect(t.ports.openDatabase).not.toHaveBeenCalled();
  });
  it('cancellation during the first pending open prevents all subsequent opens and retains the failure',async()=>{
    const t=setup(),abort=new AbortController();let release!:(db:DatabaseSync)=>void;
    t.ports.openDatabase=vi.fn(async()=>new Promise<DatabaseSync>(resolve=>{release=resolve;}));
    const run=prepareHost(t.c,t.ports).run(receipt,abort.signal);
    await vi.waitFor(()=>expect(t.ports.openDatabase).toHaveBeenCalledOnce(),{interval:5,timeout:3000});
    abort.abort();const db=new DatabaseSync(':memory:');handles.push(db);release(db);
    expect((await run).state).toBe('owner-reconciliation-required');expect(t.ports.openDatabase).toHaveBeenCalledOnce();
    await expect(t.retryInput(new AbortController().signal)).rejects.toThrow('assembly-aborted');
    expect(t.ports.openDatabase).toHaveBeenCalledOnce();
  });
  it('retains failed input initialization and never retries a failed database open',async()=>{
    const t=setup();t.ports.openDatabase=vi.fn(async()=>{throw new Error('test unavailable DB');});
    expect((await prepareHost(t.c,t.ports).run(receipt,new AbortController().signal)).state).toBe('owner-reconciliation-required');
    await expect(t.retryInput(new AbortController().signal)).rejects.toThrow('unavailable DB');expect(t.ports.openDatabase).toHaveBeenCalledOnce();
  });
  it('publication-only resolution opens only the publication namespace',async()=>{
    const t=setup();await prepareHost(t.c,t.ports).run(receipt,new AbortController().signal);
    const openDatabase=vi.fn(async()=>{const db=new DatabaseSync(':memory:');handles.push(db);return db;});
    await t.independentResult({...t.ports,openDatabase});
    expect(openDatabase.mock.calls).toHaveLength(2);
    expect(openDatabase).toHaveBeenNthCalledWith(1,t.c.resultNamespace.controlDbPath,expect.any(AbortSignal));
    expect(openDatabase).toHaveBeenNthCalledWith(2,t.c.resultNamespace.brokerDbPath,expect.any(AbortSignal));
  });
  it('rejects an untrusted context before opening any SQLite handle',async()=>{
    const t=setup(),storage=composeStorage(t.c,t.ports);
    await expect(storage.resolveInputStorage(input,{} as never,{} as never,new AbortController().signal)).rejects.toThrow('untrusted');
    expect(t.ports.openDatabase).not.toHaveBeenCalled();
  });
});
