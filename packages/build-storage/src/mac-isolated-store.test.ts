import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {MacIsolatedStoreConfig} from './mac-isolated-store';

const deps = vi.hoisted(() => ({spawn:vi.fn(), access:vi.fn(), lstat:vi.fn(), open:vi.fn()}));
vi.mock('node:child_process', () => ({spawn:deps.spawn}));
vi.mock('node:fs/promises', () => ({access:deps.access, lstat:deps.lstat, open:deps.open}));

const bytes = Buffer.from('synthetic installed payload, never read from disk');
const digest = createHash('sha256').update(bytes).digest('hex');
const config:MacIsolatedStoreConfig = {
  python:{path:'/Library/Foundry/bin/cas-python',sha256:digest},
  helper:{path:'/Library/Foundry/bin/mac-cas.py',sha256:digest},
};
const signal = () => new AbortController().signal;
const metadata = () => ({uid:0,mode:0o755,nlink:1,size:bytes.length,
  isFile:() => true,isDirectory:() => true,isSymbolicLink:() => false});
const handles:Array<{close:ReturnType<typeof vi.fn>}> = [];
function fileHandle() {
  const fd = {stat:vi.fn(async () => metadata()),close:vi.fn(async () => {}),
    read:vi.fn(async (buffer:Buffer, offset:number, length:number, position:number) => {
      const bytesRead = bytes.copy(buffer,offset,position,position+length);
      return {bytesRead,buffer};
    })};
  handles.push(fd);
  return fd;
}
interface FakeChild extends EventEmitter {
  stdin:EventEmitter & {end:ReturnType<typeof vi.fn>};
  stdout:EventEmitter; stderr:EventEmitter; kill:ReturnType<typeof vi.fn>;
  request:Record<string,unknown>; reply:(value:unknown,code?:number) => void;
}
const children:FakeChild[] = [];
function receipt(child:FakeChild) {
  return {version:1,ok:true,nonce:child.request.nonce,root:'/Library/Foundry/CAS/objects',
    complete:true,pythonSha256:digest,helperSha256:digest,cacheBytes:123,objectCount:2,freeBytes:4096};
}
function makeChild():FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = vi.fn(() => true);
  child.stdin = Object.assign(new EventEmitter(),{end:vi.fn((raw:Buffer) => {child.request = JSON.parse(raw.toString());})});
  child.reply = (value,code=0) => {child.stdout.emit('data',Buffer.from(JSON.stringify(value)));child.emit('close',code);};
  children.push(child);
  return child;
}
// Only settle promise jobs: no real clocks, helper, filesystem, or subprocess.
async function drain() {for(let i=0;i<100;i++) await Promise.resolve();}
async function store() {return (await import('./mac-isolated-store')).createMacIsolatedContentStore(config);}

beforeEach(() => {
  vi.resetModules();vi.resetAllMocks();vi.useFakeTimers();children.length=0;handles.length=0;
  vi.spyOn(process,'platform','get').mockReturnValue('darwin');
  vi.spyOn(process,'getuid').mockReturnValue(501);vi.spyOn(process,'geteuid').mockReturnValue(501);
  deps.lstat.mockImplementation(async () => metadata());
  deps.access.mockRejectedValue(Object.assign(new Error('denied'),{code:'EACCES'}));
  deps.open.mockImplementation(async () => fileHandle());deps.spawn.mockImplementation(makeChild);
});
afterEach(() => {vi.useRealTimers();vi.restoreAllMocks();});

describe('Mac isolated CAS client with synthetic installed files and child protocol', () => {
  it('binds fresh census nonces, validates installed pins, and preserves nonzero retained bytes', async () => {
    const cas = await store();
    for(let i=0;i<2;i++) {
      const pending = cas.census(signal());await drain();
      expect(children).toHaveLength(i+1);
      const child = children[i]!;
      expect(child.request).toEqual({version:1,op:'census',nonce:expect.stringMatching(/^[a-f0-9]{32}$/)});
      child.reply(receipt(child));
      expect(await pending).toEqual({complete:true,cacheBytes:123,objectCount:2,freeBytes:4096});
    }
    expect(children[0]!.request.nonce).not.toBe(children[1]!.request.nonce);
    expect(deps.spawn).toHaveBeenCalledWith(config.python.path,['-I','-S',config.helper.path,'client'],
      {shell:false,env:{LANG:'C',LC_ALL:'C'},stdio:['pipe','pipe','pipe']});
    expect(handles).toHaveLength(4);for(const handle of handles) expect(handle.close).toHaveBeenCalledOnce();
    expect(deps.open.mock.calls.map(call => call[0])).toEqual([config.python.path,config.helper.path,config.python.path,config.helper.path]);
  });

  it.each([
    ['replayed nonce',{nonce:'0'.repeat(32)}],['wrong root',{root:'/tmp/objects'}],
    ['incomplete scan',{complete:false}],['python receipt pin',{pythonSha256:'0'.repeat(64)}],
    ['helper receipt pin',{helperSha256:'0'.repeat(64)}],['unexpected field',{extra:true}],
  ])('rejects census %s', async (_label,patch) => {
    const pending = (await store()).census(signal());
    const rejected = expect(pending).rejects.toThrow('cas-census-receipt');await drain();
    children[0]!.reply({...receipt(children[0]!),...patch});await rejected;
  });

  it.each([
    ['negative bytes',{cacheBytes:-1}],['fractional bytes',{cacheBytes:0.5}],
    ['over budget',{cacheBytes:20*1024**3+1}],['too many objects',{objectCount:200001}],
    ['unsafe free bytes',{freeBytes:Number.MAX_SAFE_INTEGER+1}],['unknown free bytes',{freeBytes:null}],
  ])('rejects invalid census counts: %s', async (_label,patch) => {
    const pending = (await store()).census(signal());
    const rejected = expect(pending).rejects.toThrow('cas-census-count');await drain();
    children[0]!.reply({...receipt(children[0]!),...patch});await rejected;
  });

  it('rejects bytes exceeding the declared object capacity', async () => {
    const pending = (await store()).census(signal());
    const rejected = expect(pending).rejects.toThrow('cas-census-size');await drain();
    children[0]!.reply({...receipt(children[0]!),objectCount:0});await rejected;
  });

  it('rejects changed on-disk bytes before any helper invocation and closes the pin fd', async () => {
    const fd = fileHandle();fd.read.mockImplementation(async (buffer,offset,length) => {
      buffer.fill(0,offset,offset+length);return {bytesRead:length,buffer};
    });deps.open.mockResolvedValueOnce(fd);
    await expect((await store()).census(signal())).rejects.toThrow('cas-helper-pin');
    expect(deps.spawn).not.toHaveBeenCalled();expect(fd.close).toHaveBeenCalledOnce();
  });

  it.each(['writable','symlink','unknown-access'] as const)('rejects unsafe installed path: %s', async failure => {
    if(failure==='writable') deps.access.mockResolvedValue(undefined);
    if(failure==='symlink') deps.lstat.mockResolvedValue({...metadata(),isSymbolicLink:() => true});
    if(failure==='unknown-access') deps.access.mockRejectedValue(Object.assign(new Error('I/O'),{code:'EIO'}));
    await expect((await store()).census(signal())).rejects.toThrow(
      failure==='writable'?'cas-helper-writable':failure==='symlink'?'cas-helper-ownership':'cas-access-unknown');
    expect(deps.spawn).not.toHaveBeenCalled();expect(deps.open).not.toHaveBeenCalled();
  });

  it('shares one installed endpoint and refuses changed configuration pins', async () => {
    const module = await import('./mac-isolated-store');const cas = module.createMacIsolatedContentStore(config);
    expect(module.createMacIsolatedContentStore(structuredClone(config))).toBe(cas);
    expect(() => module.createMacIsolatedContentStore({...config,helper:{...config.helper,sha256:'0'.repeat(64)}})).toThrow('cas-installed-pins-changed');
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it('removes an aborted waiter without spawning it or blocking the next waiter', async () => {
    const cas = await store(), first = cas.census(signal());await drain();
    const cancel = new AbortController();const queued = cas.census(cancel.signal);
    const rejected = expect(queued).rejects.toThrow('cas-aborted');
    const next = cas.census(signal());cancel.abort();await rejected;await drain();
    expect(children).toHaveLength(1);children[0]!.reply(receipt(children[0]!));await first;await drain();
    expect(children).toHaveLength(2);children[1]!.reply(receipt(children[1]!));await next;
  });

  it('bounds the queue at four waiters and recovers capacity when a waiter aborts', async () => {
    const cas = await store(), first = cas.census(signal());await drain();
    const controllers = Array.from({length:4},() => new AbortController());
    const queued = controllers.map(c => cas.census(c.signal));
    const rejected = queued.map(p => expect(p).rejects.toThrow('cas-aborted'));
    await expect(cas.census(signal())).rejects.toThrow('cas-client-queue-full');
    controllers.forEach(c => c.abort());await Promise.all(rejected);
    const next = cas.census(signal());await drain();expect(children).toHaveLength(1);
    children[0]!.reply(receipt(children[0]!));await first;await drain();
    expect(children).toHaveLength(2);children[1]!.reply(receipt(children[1]!));await next;
  });

  it('keeps the lane occupied after a child deadline until actual close, including factory reuse', async () => {
    const cas = await store(), first = cas.census(signal());
    const rejected = expect(first).rejects.toThrow('cas-aborted-or-deadline');await drain();
    await vi.advanceTimersByTimeAsync(20000);await rejected;
    expect(children[0]!.kill).toHaveBeenCalledWith('SIGKILL');
    const next = (await store()).census(signal());await drain();
    expect(children).toHaveLength(1);expect(deps.open).toHaveBeenCalledTimes(2);
    children[0]!.emit('close',null);await drain();expect(children).toHaveLength(2);
    children[1]!.reply(receipt(children[1]!));await next;
  });

  it('keeps the lane occupied after abort while a physical pin read remains unresolved', async () => {
    let finishRead!:(value:{bytesRead:number;buffer:Buffer}) => void;
    let heldBuffer!:Buffer;
    const fd = fileHandle();fd.read.mockImplementationOnce(buffer => {
      heldBuffer=buffer;return new Promise(resolve => {finishRead=resolve;});
    });deps.open.mockResolvedValueOnce(fd);
    const cas = await store(), cancel = new AbortController(), first = cas.census(cancel.signal);
    const rejected = expect(first).rejects.toThrow('cas-aborted-or-deadline');await drain();
    expect(fd.read).toHaveBeenCalledOnce();cancel.abort();await rejected;
    const next = cas.census(signal());await drain();
    expect(deps.open).toHaveBeenCalledTimes(1);expect(deps.spawn).not.toHaveBeenCalled();expect(fd.close).not.toHaveBeenCalled();
    bytes.copy(heldBuffer);finishRead({bytesRead:bytes.length,buffer:heldBuffer});await drain();
    expect(fd.close).toHaveBeenCalledOnce();expect(children).toHaveLength(1);
    children[0]!.reply(receipt(children[0]!));await next;
  });

  it('kills an oversized response but does not release physical occupancy before close', async () => {
    const cas = await store(), first = cas.census(signal());
    const rejected = expect(first).rejects.toThrow('cas-response-bound');await drain();
    children[0]!.stdout.emit('data',Buffer.alloc(1450001));
    expect(children[0]!.kill).toHaveBeenCalledWith('SIGKILL');
    const next = cas.census(signal());await drain();expect(children).toHaveLength(1);
    children[0]!.emit('close',null);await rejected;await drain();expect(children).toHaveLength(2);
    children[1]!.reply(receipt(children[1]!));await next;
  });
});
