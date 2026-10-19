import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {Census} from '../../build-jobs/src/contracts';
import type {MacCasCensus} from '../../build-storage/src/mac-isolated-store';
import type {ManagedStorageInventory} from './storage-inventory';
import type {MacVmCapability} from '../../build-jobs/src/mac-vm-capability';
import type {WorkerRequestPort} from './node-transport';
import {NodeWorkerLiveness, type NodeLivenessConfig} from './liveness';

const deps = vi.hoisted(() => ({
  inventory:vi.fn(),discover:vi.fn(),census:vi.fn(),store:vi.fn(),reserve:vi.fn(),
  statfs:vi.fn(),vm:vi.fn(),linux:vi.fn(),wait:vi.fn(),spawn:vi.fn(),now:vi.fn(),
}));
vi.mock('./storage-inventory.js', () => ({managedStorageInventory:deps.inventory}));
vi.mock('./discovery.js', () => ({discoverCensus:deps.discover}));
vi.mock('../../build-storage/src/mac-isolated-store.js', () => ({createMacIsolatedContentStore:deps.store}));
vi.mock('./host.js', async importOriginal => ({...await importOriginal<typeof import('./host')>(),reserveLivenessSequence:deps.reserve}));
vi.mock('./mac-vm-capability.js', () => ({readMacVmCapability:deps.vm}));
vi.mock('./linux-isolated-census.js', () => ({readLinuxIsolationCensus:deps.linux}));
vi.mock('node:fs/promises', () => ({statfs:deps.statfs}));
vi.mock('node:child_process', () => ({spawn:deps.spawn}));
vi.mock('node:os', () => ({cpus:() => Array.from({length:8},() => ({})),totalmem:() => 16*1024**3}));
vi.mock('node:timers/promises', () => ({setTimeout:deps.wait}));
vi.mock('node:perf_hooks', () => ({performance:{now:deps.now}}));

const GiB = 1024**3;
const digest = 'a'.repeat(64);
const config:NodeLivenessConfig = {
  host:{uid:501,gid:20,dedicatedBuildUser:true,allowActivation:false,
    inputBase:'/synthetic/input',workBase:'/synthetic/work',journalRoot:'/synthetic/journal'},
  expectedEpoch:7,approvedIdentity:{workerId:'mac-test',principal:'test-owner',workerClass:'general',cpu:4,ramMib:8192,devices:[]},
  authority:{environment:'local-test',authorityId:'test-authority',workerId:'mac-test'},
  revision:2,incarnation:1,initialEnrollmentSequence:10,initialCensusSequence:20,
  developerDirs:[],optedIn:true,cacheRoot:'/synthetic/cache',
  macStorage:{python:{path:'/Library/Foundry/bin/cas-python',sha256:digest},helper:{path:'/Library/Foundry/bin/mac-cas.py',sha256:digest}},
};
const source = {environment:'local-test',authorityId:'test-authority',epoch:7};
const vm:NonNullable<NodeLivenessConfig['vm']> = {
  sha256:digest,seal:{helper:{path:'/synthetic/seal',sha256:digest},tree:{
    path:`/Library/Foundry/VM/capabilities/${digest}`,mountPoint:'/synthetic/mount',filesystem:'apfs',
    fsid:[1,2],mountSource:'/synthetic/device',volumeUuid:'00000000-0000-0000-0000-000000000001',rootDevice:'1',rootInode:'2',
  }},
};
const capability:MacVmCapability = {version:1,backend:'apple-vz-macos-v1',architecture:'arm64',
  bootSha256:digest,guestRunnerSha256:digest,vmHelperSha256:digest,treeGuardSha256:digest,
  macos:'15.0',developerDir:'/Applications/Xcode.app/Contents/Developer',xcodeBuild:'16A1',sdks:['macosx15.0']};
let inventory:ManagedStorageInventory;
let isolated:MacCasCensus;
let controllerFree:number;
let clock:number;
let commits:Array<{kind:string;commit:ReturnType<typeof vi.fn>}>;
let sent:Census[];
let request:ReturnType<typeof vi.fn<WorkerRequestPort['request']>>;
const signal = () => new AbortController().signal;
function observer(patch:Partial<NodeLivenessConfig>={}) {
  return new NodeWorkerLiveness({...config,...patch},{request});
}
beforeEach(() => {
  vi.resetAllMocks();clock=0;commits=[];sent=[];
  inventory={observedAt:0,source:'node-lstat',complete:true,cacheBytes:3*GiB,workspaceBytes:GiB,roots:[]};
  isolated={complete:true,cacheBytes:2*GiB,objectCount:2048,freeBytes:70*GiB};controllerFree=80*GiB;
  deps.now.mockImplementation(() => clock);
  deps.inventory.mockImplementation(async () => structuredClone(inventory));
  deps.census.mockImplementation(async () => ({...isolated}));
  deps.store.mockReturnValue({census:deps.census});
  deps.vm.mockResolvedValue(capability);deps.statfs.mockResolvedValue({bavail:60*GiB/4096,bsize:4096});
  deps.spawn.mockImplementation(() => {throw new Error('Real helper invocation forbidden');});
  deps.wait.mockImplementation(async (delay:number) => {clock+=delay;});
  deps.discover.mockImplementation(async (_root,_dirs,identity,storage):Promise<Census> => ({
    ...identity,os:'darwin',architecture:'arm64',freeBytes:controllerFree,availableRamMib:8192,
    macos:'15.0',xcodeBuilds:[],sdks:[],storage:{...storage},
  }));
  deps.reserve.mockImplementation(async (_host,_scope,kind:string,initial:number) => {
    const sequence=initial+1+commits.filter(row => row.kind===kind).length;
    const commit=vi.fn(async () => {});commits.push({kind,commit});return {sequence,commit};
  });
  request=vi.fn<WorkerRequestPort['request']>(async (path,body) => {
    if(path==='/v1/enrollment/heartbeat') {
      const heartbeat=body as {request:{sequence:number}};
      return {ok:true,status:{sequence:heartbeat.request.sequence,freshness:'fresh',revision:2,incarnation:1,identity:config.approvedIdentity}};
    }
    const command=body as {command:{operation:string;body:Census}};
    expect(command.command.operation).toBe('census');sent.push(structuredClone(command.command.body));
    return {ok:true,source};
  });
});

describe('NodeWorkerLiveness Mac admission with local dependency fakes', () => {
  it('adds controller and private CAS bytes once and returns the actual bound authority receipt', async () => {
    const result=await observer().refreshLiveness(0,signal());
    expect(result).toEqual(source);expect(Object.isFrozen(result)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.storage).toEqual({cacheBytes:5*GiB,workspaceBytes:GiB,complete:true});
    expect(sent[0]!.freeBytes).toBe(70*GiB);
    expect(deps.store).toHaveBeenCalledWith(config.macStorage);
    expect(deps.census).toHaveBeenCalledOnce();
    expect(deps.inventory).toHaveBeenCalledWith([
      {role:'cache',path:config.cacheRoot,uid:501},{role:'workspace',path:config.host.workBase,uid:501},
    ]);
    for(const row of commits) expect(row.commit).toHaveBeenCalledOnce();
    expect(deps.spawn).not.toHaveBeenCalled();expect(deps.linux).not.toHaveBeenCalled();
  });

  it.each(['unavailable','incomplete-controller','unknown-controller','unsafe-sum','overflow'] as const)(
    'rejects idle admission with %s accounting and publishes honest unknown/incomplete state', async failure => {
      if(failure==='unavailable') deps.census.mockRejectedValue(new Error('census unavailable'));
      if(failure==='incomplete-controller') inventory.complete=false;
      if(failure==='unknown-controller') {inventory.cacheBytes=null;inventory.complete=false;}
      if(failure==='unsafe-sum') inventory.cacheBytes=-1;
      if(failure==='overflow') inventory.cacheBytes=Number.MAX_SAFE_INTEGER;
      await expect(observer().refreshLiveness(0,signal())).rejects.toThrow('cache-inventory-or-20gib-admission-denied');
      expect(sent).toHaveLength(1);expect(sent[0]!.storage.complete).toBe(false);
      expect(sent[0]!.storage.cacheBytes).toBe(failure==='incomplete-controller'?5*GiB:null);
      expect(sent[0]!.freeBytes).toBe(failure==='unavailable'?0:70*GiB);
      // The truthful census was acknowledged even though this worker cannot admit work.
      expect(commits.find(row => row.kind==='census')!.commit).toHaveBeenCalledOnce();
    });

  it('treats a VM without installed CAS pins as unknown, never as an empty cache', async () => {
    const withoutPins={...config,vm};delete withoutPins.macStorage;
    await expect(new NodeWorkerLiveness(withoutPins,{request}).refreshLiveness(0,signal())).rejects.toThrow('cache-inventory-or-20gib-admission-denied');
    expect(deps.store).not.toHaveBeenCalled();expect(deps.census).not.toHaveBeenCalled();
    expect(sent[0]!.storage).toEqual({complete:false,cacheBytes:null,workspaceBytes:GiB});expect(sent[0]!.freeBytes).toBe(0);
  });

  it('does not replace a failed fresh CAS observation with the previous successful census', async () => {
    const live=observer();await live.refreshLiveness(0,signal());clock=1001;
    deps.census.mockRejectedValueOnce(new Error('old pins or unavailable service'));
    await expect(live.refreshLiveness(0,signal())).rejects.toThrow('cache-inventory-or-20gib-admission-denied');
    expect(deps.census).toHaveBeenCalledTimes(2);
    expect(sent.map(c => c.storage.cacheBytes)).toEqual([5*GiB,null]);
    expect(sent.map(c => c.sequence)).toEqual([21,22]);expect(sent[1]!.freeBytes).toBe(0);
  });

  it('reports unknown storage while a job is active without falsely marking it complete', async () => {
    deps.census.mockRejectedValue(new Error('unavailable'));
    await expect(observer().refreshLiveness(1,signal())).resolves.toEqual(source);
    expect(sent[0]!.activeJobs).toBe(1);expect(sent[0]!.storage.cacheBytes).toBeNull();
    expect(sent[0]!.storage.complete).toBe(false);expect(sent[0]!.freeBytes).toBe(0);
  });

  it.each([20*GiB,20*GiB+1])('enforces the combined cache limit at %s bytes', async total => {
    inventory.cacheBytes=total-isolated.cacheBytes;
    const pending=observer().refreshLiveness(0,signal());
    if(total===20*GiB) await expect(pending).resolves.toEqual(source);
    else await expect(pending).rejects.toThrow('cache-inventory-or-20gib-admission-denied');
    expect(sent[0]!.storage.cacheBytes).toBe(total);expect(sent[0]!.storage.complete).toBe(true);
  });

  it.each([
    ['same volume',60,60,60,60],['controller limiting',40,60,70,40],
    ['VM limiting',80,30,70,30],['CAS limiting',80,60,20,20],
  ])('uses minimum observed headroom without double counting: %s', async (_label,controller,vmFree,casFree,expected) => {
    controllerFree=Number(controller)*GiB;
    deps.statfs.mockResolvedValue({bavail:Number(vmFree)*GiB/4096,bsize:4096});
    isolated={...isolated,freeBytes:Number(casFree)*GiB};
    await observer({vm}).refreshLiveness(0,signal());
    expect(sent[0]!.freeBytes).toBe(Number(expected)*GiB);
    expect(deps.statfs).toHaveBeenCalledExactlyOnceWith('/Library/Foundry/VM/attempts');
    expect(deps.inventory.mock.calls[0]![0]).toContainEqual({role:'workspace',path:'/Library/Foundry/VM/attempts',uid:0,vmChildUid:501});
    expect(sent[0]!.vm).toEqual(capability);expect(deps.spawn).not.toHaveBeenCalled();
  });

  it.each(['/','/Library/Foundry/CAS','/Library/Foundry/CAS/objects','/Library/Foundry/CAS/objects/child'])('rejects controller/CAS overlap %s before store construction', path => {
    expect(() => observer({cacheRoot:path})).toThrow('mac-cas-inventory-overlap');expect(deps.store).not.toHaveBeenCalled();
  });

  it('rejects authority mismatch without committing a census sequence', async () => {
    const delegate=request.getMockImplementation()!;
    request.mockImplementation(async (path,body,abort) => path==='/v1/builds/commands'
      ? {ok:true,source:{...source,epoch:8}} : delegate(path,body,abort));
    await expect(observer().refreshLiveness(0,signal())).rejects.toThrow('build-response-source-mismatch');
    expect(commits.find(row => row.kind==='census')!.commit).not.toHaveBeenCalled();
  });

  it('does not publish a census when cancellation occurs during private storage observation', async () => {
    const cancel=new AbortController();deps.census.mockImplementation(async () => {cancel.abort();throw new Error('aborted');});
    await expect(observer().refreshLiveness(0,cancel.signal)).rejects.toThrow('census-aborted');
    expect(sent).toEqual([]);expect(request).toHaveBeenCalledTimes(1);
    expect(commits.find(row => row.kind==='census')!.commit).not.toHaveBeenCalled();
  });

  it('keeps refresh exclusive until a pending census settles, then allows recovery', async () => {
    let finish!:(value:MacCasCensus) => void;
    deps.census.mockImplementationOnce(() => new Promise(resolve => {finish=resolve;}));
    const live=observer(), first=live.refreshLiveness(0,signal());
    for(let i=0;i<30;i++) await Promise.resolve();
    expect(deps.census).toHaveBeenCalledOnce();
    await expect(live.refreshLiveness(0,signal())).rejects.toThrow('liveness-already-refreshing');
    expect(request).toHaveBeenCalledTimes(1);finish(isolated);await first;
    clock=1001;await live.refreshLiveness(0,signal());expect(sent).toHaveLength(2);
  });
});
