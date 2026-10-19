import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import { NodeCliAdapter, NodeStagingPort, canonicalPath } from './node';
import { spawnBounded } from './process';
vi.mock('node:fs/promises',() => ({lstat:vi.fn(),realpath:vi.fn(),readdir:vi.fn(),mkdir:vi.fn(),open:vi.fn(),statfs:vi.fn(),mkdtemp:vi.fn()}));
vi.mock('./process',() => ({spawnBounded:vi.fn()}));
const uid = process.getuid!();
const entries = new Map<string,{uid:number;mode:number;kind:string}>();
const options = () => ({stdin:'',maxBytes:64,timeoutMs:100});
const config = {executable:'/trusted/docker',socketPath:'/trusted/socket',privateConfigPath:'/trusted/empty',allowActivation:true};
beforeEach(() => {
  vi.clearAllMocks(); entries.clear();
  for(const path of ['/','/trusted','/trusted/empty']) entries.set(path,{uid,mode:0o700,kind:'dir'});
  entries.set('/trusted/docker',{uid:0,mode:0o755,kind:'file'});
  entries.set('/trusted/socket',{uid,mode:0o600,kind:'socket'});
  vi.mocked(fs.lstat).mockImplementation(async path => {
    const e = entries.get(String(path)); if(!e) throw Error('missing');
    return {...e,isSymbolicLink:()=>e.kind==='link',isDirectory:()=>e.kind==='dir',isFile:()=>e.kind==='file',isSocket:()=>e.kind==='socket'} as never;
  });
  vi.mocked(fs.realpath).mockImplementation(async path => String(path));
  vi.mocked(fs.readdir).mockResolvedValue([] as never);
  vi.mocked(spawnBounded).mockResolvedValue({code:0,stdout:new Uint8Array(),stderr:new Uint8Array(),truncated:false,interrupted:false});
});
describe('CLI security boundary (synthetic filesystem; no credential reads or Docker)',() => {
  it('always pins the exact empty config even with synthetic proxy credentials elsewhere',async () => {
    // A synthetic Docker config consumer: only the ambient fixture contains a proxy secret.
    const ambient = {proxies:{default:{httpProxy:'http://synthetic-proxy-sentinel@invalid'}}};
    vi.mocked(spawnBounded).mockImplementation(async (_exe,args) => {
      expect(args.slice(0,4)).toEqual(['--config','/trusted/empty','--host','unix:///trusted/socket']);
      const selected = args[0] === '--config' && args[1] === '/trusted/empty' ? {} : ambient;
      expect(JSON.stringify(selected)).not.toContain('synthetic-proxy-sentinel');
      return {code:0,stdout:new Uint8Array(),stderr:new Uint8Array(),truncated:false,interrupted:false};
    });
    await new NodeCliAdapter(config).execute(['info','--format','{{json .}}'],options());
    expect(spawnBounded).toHaveBeenCalledOnce();
  });
  it.each(['config.json','cli-plugins','contexts','unrecognized'])('rejects config entries %s',async entry => {
    vi.mocked(fs.readdir).mockResolvedValue([entry] as never);
    await expect(new NodeCliAdapter(config).execute(['info','--format','{{json .}}'],options())).rejects.toThrow('unsafe-cli-config');
    expect(spawnBounded).not.toHaveBeenCalled();
  });
  it.each(['', 'relative', '/trusted/../empty'])('has no config fallback for %s',async privateConfigPath => {
    await expect(new NodeCliAdapter({...config,privateConfigPath}).execute(['info','--format','{{json .}}'],options())).rejects.toThrow();
    expect(spawnBounded).not.toHaveBeenCalled();
  });
  it.each(['/','/trusted'])('checks owner and writable permissions at ancestor %s',async path => {
    for(const patch of [{uid:uid+1000,mode:0o755},{uid:0,mode:0o777},{uid:0,mode:0o1777}]) {
      entries.set(path,{...patch,kind:'dir'});
      await expect(canonicalPath('/trusted/docker')).rejects.toThrow('unsafe-ancestor');
      await expect(new NodeStagingPort('/trusted/empty').reserve('a'.repeat(64))).rejects.toThrow('unsafe-ancestor');
    }
    expect(fs.mkdir).not.toHaveBeenCalled();
  });
  it.each(['/trusted/docker','/trusted/socket','/trusted/empty'])('rejects untrusted leaf ownership and symlinks %s',async path => {
    const original = entries.get(path)!;
    for(const patch of [{uid:uid+1000},{kind:'link'},{mode:0o777}]) {
      entries.set(path,{...original,...patch});
      await expect(new NodeCliAdapter(config).execute(['info','--format','{{json .}}'],options())).rejects.toThrow();
    }
    expect(spawnBounded).not.toHaveBeenCalled();
  });
  it('snapshots argv, stdin, limits and signal before asynchronous checks',async () => {
    const argv = ['info','--format','{{json .}}'], original = new AbortController(), replacement = new AbortController();
    const opts = {...options(),signal:original.signal};
    const pending = new NodeCliAdapter(config).execute(argv,opts);
    argv.splice(0,argv.length,'run','evil'); opts.stdin='mutated'; opts.maxBytes=999999; opts.timeoutMs=999999; opts.signal=replacement.signal;
    await pending;
    expect(spawnBounded).toHaveBeenCalledWith('/trusted/docker',['--config','/trusted/empty','--host','unix:///trusted/socket','info','--format','{{json .}}'],{...options(),signal:original.signal});
  });
  it('still rejects unbranded create arrays',async () => {
    await expect(new NodeCliAdapter(config).execute(['create'],options())).rejects.toThrow('unsafe-cli-plan');
    expect(fs.lstat).not.toHaveBeenCalled();
  });
});
