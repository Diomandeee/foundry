import { fileURLToPath, URL } from 'node:url';
import { spawnBounded } from './process';
import { describe, it, expect } from 'vitest';
import { planEventJob, EVENT_PROFILE, type EventScope } from '../../epoch-jobs/src/index';
import { canonical } from '../../epoch-jobs/src/canonical';
import { buildPlan, validateProfile, WorkerRuntime, identityKey, allowedArgv, type RuntimePort, type CliResult, type ExecuteOptions, type ProfileConfig, type Job, type ExecutionPlan } from './index';
const image = `local/vetted@sha256:${'a'.repeat(64)}`;
const config: ProfileConfig = {image,cpu:1,ramMib:128,pids:16,tmpMib:4,maxOutputBytes:4096,timeoutMs:100};
function fixture() {
  const scope: EventScope = {environment:'local',authorityId:'chain',sourceId:'hiro',network:'stacks-testnet'};
  const contract = 'ST000000000000000000002AMW42H.epoch';
  const event = {network:scope.network,blockHeight:12,blockHash:'a'.repeat(64),parentHash:'c'.repeat(64),transactionId:'f'.repeat(64),eventIndex:0,payload:{schema:EVENT_PROFILE,contractId:contract,topic:'print',value:{hex:'0x0102',repr:'private'},block:{id:'a'.repeat(64),hash:'b'.repeat(64),parentId:'c'.repeat(64),parentHash:'d'.repeat(64),height:12,burnHash:'e'.repeat(64),burnHeight:5,tenureHeight:3}}};
  const eventId = canonical([scope.sourceId,event.network,event.blockHash,event.transactionId,0]);
  const summary = planEventJob({...scope,workloadId:'approved'},eventId,event,1,{...scope,profile:EVENT_PROFILE,allowedContracts:[contract],ramMib:128,maxOutputBytes:4096});
  const profile = validateProfile({...config},[image]);
  const job: Job = {workerClass:'general',leaseId:'lease-1',epoch:1,generation:0,incarnation:0,workloadId:'approved',specification:summary.submitBody.specification};
  return {profile,job,plan:buildPlan(profile,job),bytes:summary.expectedOutputBytes};
}
const id = 'b'.repeat(64);
function reply(value: unknown, code = 0): CliResult { return {code,stdout:Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),stderr:new Uint8Array(),truncated:false,interrupted:false}; }
class Fake implements RuntimePort {
  info: Record<string, unknown> = {OSType:'linux',CgroupVersion:'2',SecurityOptions:['name=seccomp,profile=builtin'],Warnings:null,CpuCfsQuota:true,MemoryLimit:true,PidsLimit:true};
  calls: readonly string[][] = []; running = false; stale = false; unavailable = false; unsupported = false; volumes = false; killFails = false; inspectFails = false; createAmbiguous = false;
  start: (options: ExecuteOptions) => Promise<CliResult>;
  constructor(readonly plan: ExecutionPlan, bytes: Uint8Array) { this.start = async () => { this.running = false; return {...reply(''),stdout:bytes}; }; }
  async execute(argv: readonly string[], options: ExecuteOptions): Promise<CliResult> {
    this.calls = [...this.calls,[...argv]];
    if (argv[0] === 'info') { if(this.unavailable) throw Error('Bearer private-token'); return reply({...this.info,...(this.unsupported ? {SecurityOptions:[]} : {})}); }
    if (argv[0] === 'image') return reply([{RepoDigests:[image],Config:{Volumes:this.volumes ? {'/evil':{}} : null}}]);
    if (argv[0] === 'create') return reply(this.createAmbiguous ? 'partial' : id);
    if (argv[0] === 'inspect') { if(this.inspectFails) throw Error('Bearer secret'); return reply([{Id:this.stale ? 'c'.repeat(64) : id,Config:{Labels:{'foundry.identity':identityKey(this.plan.identity)}},State:{Running:this.running,Status:this.running ? 'running':'exited',ExitCode:0}}]); }
    if (argv[0] === 'start') { this.running = true; return this.start(options); }
    if (argv[0] === 'kill') { if(!this.killFails) this.running = false; return reply(''); }
    throw Error('unexpected');
  }
}
function runtime(f = fixture()) { const port = new Fake(f.plan,f.bytes), reserved = new Set<string>(); const staging = {reserve:async (key: string) => {if(reserved.has(key)) throw Error('EEXIST'); reserved.add(key);}}; return {...f,port,staging,runtime:new WorkerRuntime(f.profile,port,staging)}; }
describe('host profile and deterministic command boundary',() => {
  it('builds immutable plans with all security bounds and no input command interpolation',() => {
    const f = fixture(), argv = f.plan.createArgv;
    expect(buildPlan(f.profile,f.job)).toEqual(f.plan); expect(Object.isFrozen(f.profile)).toBe(true); expect(Object.isFrozen(argv)).toBe(true);
    for (const flag of ['--pull=never','--network=none','--read-only','--privileged=false','--cap-drop=ALL','--security-opt=no-new-privileges=true','--user=65532:65532','--runtime=runc','--log-driver=none']) expect(argv).toContain(flag);
    expect(argv).toContain('--cpus'); expect(argv).toContain('--pids-limit'); expect(argv).toContain('--memory-swap'); expect(argv).toContain('--tmpfs');
    expect(argv.join(' ')).not.toContain(f.job.specification); expect(argv.some(x => /--(mount|volume|gpus|device|publish)/.test(x))).toBe(false);
    expect(allowedArgv(argv)).toBe(true); expect(allowedArgv([...argv])).toBe(false);
  });
  it.each(['cpu','ramMib','pids','tmpMib','maxOutputBytes','timeoutMs'] as const)('rejects adversarial %s',field => {
    for(const value of [-1,0,Infinity,NaN,1e10]) expect(() => validateProfile({...config,[field]:value},[image])).toThrow();
  });
  it('rejects unpinned/unallowlisted images, command/mount/url extras and forged profiles',() => {
    for(const bad of ['node:latest','https://x/image',`${image};echo evil`]) expect(() => validateProfile({...config,image:bad},[bad])).toThrow();
    expect(() => validateProfile({...config},[])).toThrow();
    for(const extra of ['command','mounts','url','script','env']) expect(() => validateProfile({...config,[extra]:'evil'} as ProfileConfig,[image])).toThrow();
    const f = fixture(); expect(() => buildPlan({...f.profile},f.job)).toThrow('untrusted-profile');
    expect(() => buildPlan(f.profile,{...f.job,mounts:['/']} as Job)).toThrow();
  });
  it('rejects edge, malformed/fenced identity, workload mismatch, bearer parse errors and mutated specs',() => {
    const f = fixture(); expect(() => buildPlan(f.profile,{...f.job,workerClass:'edge'})).toThrow('edge-heartbeat-only');
    for(const leaseId of ['../escape','/absolute','x\0y','x;echo evil','Bearer secret']) expect(() => buildPlan(f.profile,{...f.job,leaseId})).toThrow();
    for(const field of ['epoch','generation','incarnation']) expect(() => buildPlan(f.profile,{...f.job,[field]:-1})).toThrow();
    expect(() => buildPlan(f.profile,{...f.job,workloadId:'wrong'})).toThrow();
    expect(() => buildPlan(f.profile,{...f.job,specification:'Bearer secret'})).toThrow('invalid-specification');
    expect(identityKey({...f.job,incarnation:1})).not.toBe(identityKey(f.job));
  });
  it('rejects arbitrary CLI commands even before invoking the adapter',() => {
    for(const argv of [['run','evil'],['exec',id,'sh'],['inspect','-a'],['kill','--signal=TERM',id],['start','--attach','--interactive','short']]) expect(allowedArgv(argv)).toBe(false);
  });
});
describe('bounded job lifecycle and truthful physical stop',() => {
  it('executes the fixed image handler source as a benign local child and rejects malformed input',async () => {
    const f = fixture(), handler = fileURLToPath(import.meta.url).replace('runtime.test.ts','image-handler.ts');
    const args = ['--import',fileURLToPath(new URL('../../../node_modules/tsx/dist/loader.mjs',import.meta.url)),handler];
    // Resolve the already installed loader from the source root; no install or image build.
    const valid = await spawnBounded(process.execPath,args,{stdin:f.job.specification,maxBytes:4096,timeoutMs:3000});
    expect(valid.code).toBe(0); expect(Uint8Array.from(valid.stdout)).toEqual(f.bytes);
    const bad = await spawnBounded(process.execPath,args,{stdin:'Bearer fixture-private',maxBytes:4096,timeoutMs:3000});
    expect(bad.code).toBe(1); expect(Buffer.from(bad.stderr).toString()).toBe('summary-rejected\n'); expect(bad.stdout.length).toBe(0);
  });
  // Contract fixture follows moby api/types/system/info.go JSON tags and nil slices.
  it.each([null, []])('accepts official CpuCfsQuota JSON and empty warnings %j',async warnings => {
    const f = runtime(); f.port.info.Warnings = warnings;
    expect((await f.runtime.runBoundedJob(f.plan)).outcome).toBe('completed');
  });
  it.each([
    {CpuCfsQuota:undefined,CPUCfsQuota:true}, {CpuCfsQuota:false},
    {Warnings:undefined}, {Warnings:['warning']}, {Warnings:{}},
    {SecurityOptions:null}, {SecurityOptions:[]}, {SecurityOptions:['name=seccomp,profile=builtin',null]},
  ])('fails closed on malformed or unsupported daemon contract %j',async patch => {
    const f = runtime(); Object.assign(f.port.info,patch);
    expect((await f.runtime.runBoundedJob(f.plan)).outcome).toBe('rejected');
    expect(f.port.calls.some(a => a[0] === 'create')).toBe(false);
  });
  it('runs pure summary through fake container, verifies actual bytes and confirms inspect',async () => {
    const f = runtime(), result = await f.runtime.runBoundedJob(f.plan);
    expect(result.outcome).toBe('completed'); expect(result.output).toEqual(f.bytes); expect(result.stop.stopped).toBe(true);
    expect(f.port.calls.filter(a => a[0] === 'create')).toHaveLength(1);
    await expect(f.runtime.runBoundedJob(f.plan)).rejects.toThrow('identity-already-used');
  });
  it.each(['unavailable','unsupported','volumes'] as const)('fails closed on %s before activation without leaking bearer values',async flag => {
    const f = runtime(); f.port[flag] = true; const result = await f.runtime.runBoundedJob(f.plan);
    expect(result.outcome).toBe('rejected'); expect(result.stop.stopped).toBe(false); expect(f.port.calls.some(a => a[0] === 'create')).toBe(false); expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('reserves one identity across runtime instances; disk pressure fails before process',async () => {
    const f = runtime(); await f.runtime.runBoundedJob(f.plan); const second = new WorkerRuntime(f.profile,f.port,f.staging);
    const before = f.port.calls.length; const result = await second.runBoundedJob(f.plan); expect(result.stop.stopped).toBe(false); expect(f.port.calls.length).toBe(before);
    const disk = new WorkerRuntime(f.profile,f.port,{reserve:async () => {throw Error('ENOSPC Bearer private');}});
    expect((await disk.runBoundedJob(f.plan)).outcome).toBe('rejected'); expect(f.port.calls.length).toBe(before);
  });
  it('kills midrun after timeout and requires actual postkill inspect',async () => {
    const f = runtime(); f.port.start = async () => ({...reply('partial'),interrupted:true});
    const result = await f.runtime.runBoundedJob(f.plan); expect(result.outcome).toBe('interrupted'); expect(result.output.length).toBe(0); expect(result.stop.stopped).toBe(true);
    const kill = f.port.calls.findIndex(a => a[0] === 'kill'); expect(kill).toBeGreaterThan(0); expect(f.port.calls[kill+1]).toEqual(['inspect',id]);
  });
  it('cannot attest stop while activation is in flight; cancellation request alone is not stop',async () => {
    const f = runtime(), abort = new AbortController(); let release!: () => void; let started!: () => void;
    const ready = new Promise<void>(r => {started=r;});
    f.port.start = async () => {started(); await new Promise<void>(r => {release=r;}); return {...reply(''),interrupted:true};};
    const pending = f.runtime.runBoundedJob(f.plan,abort.signal); await ready; abort.abort();
    expect((await f.runtime.stopEvidence(f.job)).stopped).toBe(false); release(); expect((await pending).stop.stopped).toBe(true);
  });
  it('refuses stale container IDs and unknown lease/incarnation evidence',async () => {
    const f = runtime(); f.port.stale = true; const result = await f.runtime.runBoundedJob(f.plan);
    expect(result.stop.stopped).toBe(false); expect(f.port.calls.some(a => a[0] === 'kill')).toBe(false);
    expect((await f.runtime.stopEvidence({...f.job,incarnation:2})).stopped).toBe(false);
  });
  it('retains unknown stop when kill fails or inspection is unavailable',async () => {
    for(const fail of ['killFails','inspectFails'] as const) {
      const f = runtime(); f.port.start = async () => { f.port[fail] = true; return {...reply(''),interrupted:true}; };
      expect((await f.runtime.runBoundedJob(f.plan)).stop.stopped).toBe(false);
    }
  });
  it('recovers ambiguous create by exact label inspection without calling start',async () => {
    const f = runtime(); f.port.createAmbiguous = true; const result = await f.runtime.runBoundedJob(f.plan);
    expect(result.outcome).toBe('rejected'); expect(result.stop.stopped).toBe(true); expect(f.port.calls.some(a => a[0] === 'start')).toBe(false);
  });
  it('rejects partial, excessive, mismatched or nonzero output',async () => {
    for(const mode of ['partial','truncated','nonzero','overlimit']) {
      const f = runtime(); f.port.start = async () => {f.port.running = false; return {...reply(mode === 'overlimit' ? 'x'.repeat(5000) : 'partial'),code:mode === 'nonzero' ? 1:0,truncated:mode === 'truncated'};};
      const result = await f.runtime.runBoundedJob(f.plan); expect(result.outcome).toBe('failed'); expect(result.output.length).toBe(0);
    }
  });
  it('does not attest a created container after an ambiguous start that might still reach the daemon',async () => {
    const f = runtime(); f.port.start = async () => {f.port.running = false; return {...reply(''),interrupted:true};};
    const execute = f.port.execute.bind(f.port);
    f.port.execute = async (argv,options) => {
      const result = await execute(argv,options);
      if(argv[0] === 'inspect' && f.port.calls.some(a => a[0] === 'start')) {
        const row = JSON.parse(Buffer.from(result.stdout).toString()); row[0].State.Status = 'created'; return reply(row);
      }
      return result;
    };
    expect((await f.runtime.runBoundedJob(f.plan)).stop.stopped).toBe(false);
  });
  it('rejects forged plans and aborted activation before any port call',async () => {
    const f = runtime(); await expect(f.runtime.runBoundedJob({...f.plan})).rejects.toThrow('untrusted-plan');
    const signal = AbortSignal.abort(); const result = await f.runtime.runBoundedJob(f.plan,signal);
    expect(result.outcome).toBe('interrupted'); expect(f.port.calls).toHaveLength(0); expect(result.stop.stopped).toBe(false);
  });
});
