import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, chmod, symlink, mkdir, readdir, lstat, rm } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { join } from 'node:path';
import { NodeStagingPort, canonicalPath, NodeCliAdapter } from './node';
import { spawnBounded } from './process';
const owned: string[] = [];
async function directory() { const path = await mkdtemp(join(fileURLToPath(new URL('..',import.meta.url)),'.test-')); owned.push(path); await chmod(path,0o700); return path; }
afterAll(async () => { for(const path of owned) await rm(path,{recursive:true,force:true}); });
const key = 'a'.repeat(64);
describe('private local staging',() => {
  it('creates private unique run directories and permanently reserves the identity',async () => {
    const root = await directory(), staging = new NodeStagingPort(root,1048576);
    await staging.reserve(key); const runs = await readdir(join(root,key)); expect(runs).toHaveLength(1);
    expect((await lstat(join(root,key,runs[0]!))).mode & 0o077).toBe(0);
    await expect(new NodeStagingPort(root).reserve(key)).rejects.toThrow();
    await staging.reserve('b'.repeat(64)); expect(await readdir(root)).toHaveLength(2);
  });
  it('rejects relative, escaped, noncanonical and NUL paths',async () => {
    const root = await directory();
    for(const bad of ['relative',root+'/../escape',root+'/',root+'/./x',root+'\0']) await expect(canonicalPath(bad)).rejects.toThrow();
    await expect(new NodeStagingPort(root).reserve('../escape')).rejects.toThrow('invalid-identity');
  });
  it('rejects symlinks in root or any ancestor and world-readable roots',async () => {
    const root = await directory(), target = join(root,'target'); await mkdir(target,{mode:0o700}); await symlink(target,join(root,'alias'));
    await expect(new NodeStagingPort(join(root,'alias')).reserve(key)).rejects.toThrow('symlink-path');
    await mkdir(join(target,'nested'),{mode:0o700}); await expect(canonicalPath(join(root,'alias','nested'))).rejects.toThrow('symlink-path');
    await chmod(target,0o755); await expect(new NodeStagingPort(target).reserve(key)).rejects.toThrow('staging-not-private');
  });
  it('rejects writable ancestors and insufficient disk before creating the identity directory',async () => {
    const root = await directory(), child = join(root,'private'); await mkdir(child,{mode:0o700}); await chmod(root,0o777);
    await expect(new NodeStagingPort(child).reserve(key)).rejects.toThrow('unsafe-ancestor'); await chmod(root,0o700);
    await expect(new NodeStagingPort(root,Number.MAX_SAFE_INTEGER).reserve(key)).rejects.toThrow('disk-pressure');
    expect(await readdir(root)).toEqual(['private']);
  });
  it('races identity reservation without admitting two runs',async () => {
    const root = await directory(); const results = await Promise.allSettled([new NodeStagingPort(root,1048576).reserve(key),new NodeStagingPort(root,1048576).reserve(key)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  });
});
describe('actual benign child process termination, no Docker',() => {
  it('times out, kills the disposable child and awaits actual close',async () => {
    const result = await spawnBounded(process.execPath,['-e','process.stdout.write(String(process.pid)); setInterval(()=>{},1000)'],{stdin:'',maxBytes:128,timeoutMs:500});
    expect(result.interrupted).toBe(true); const pid = Number(Buffer.from(result.stdout).toString()); expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid,0)).toThrow(); expect(result.code).toBe(null);
  });
  it('cancels a running disposable child and waits for actual close',async () => {
    const abort = new AbortController(); const timer = setTimeout(() => abort.abort(),500);
    const result = await spawnBounded(process.execPath,['-e','process.stdout.write(String(process.pid)); setInterval(()=>{},1000)'],{stdin:'',maxBytes:128,timeoutMs:5000,signal:abort.signal}); clearTimeout(timer);
    const pid = Number(Buffer.from(result.stdout).toString()); expect(pid).toBeGreaterThan(0); expect(result.interrupted).toBe(true); expect(() => process.kill(pid,0)).toThrow();
  });
  it('bounds both output streams and terminates the writer on overflow',async () => {
    for(const stream of ['stdout','stderr']) {
      const result = await spawnBounded(process.execPath,['-e',`process.${stream}.write('x'.repeat(100000)); setInterval(()=>{},1000)`],{stdin:'',maxBytes:64,timeoutMs:2000});
      expect(result.truncated).toBe(true); expect(result.interrupted).toBe(true); expect(result.stdout.length).toBeLessThanOrEqual(64); expect(result.stderr.length).toBeLessThanOrEqual(64);
    }
  });
  it('reports missing executable and preaborted child without raw errors',async () => {
    const missing = await spawnBounded('/nonexistent/foundry-cli',[],{stdin:'',maxBytes:64,timeoutMs:100}); expect(missing.code).not.toBe(0); expect(missing.stderr.length).toBe(0);
    const cancelled = await spawnBounded(process.execPath,['-e','throw Error("must not run")'],{stdin:'',maxBytes:64,timeoutMs:100,signal:AbortSignal.abort()}); expect(cancelled.interrupted).toBe(true); expect(cancelled.stdout.length).toBe(0);
  });
  it('does not inherit parent environment',async () => {
    process.env.FOUNDRY_TEST_SENTINEL = 'private-fixture';
    try { const result = await spawnBounded(process.execPath,['-e','process.stdout.write(String(process.env.FOUNDRY_TEST_SENTINEL === undefined))'],{stdin:'',maxBytes:64,timeoutMs:2000}); expect(Buffer.from(result.stdout).toString()).toBe('true'); }
    finally { delete process.env.FOUNDRY_TEST_SENTINEL; }
  });
  it('keeps actual Docker adapter gated and rejects arbitrary commands before checking runtime',async () => {
    const options = {stdin:'',maxBytes:64,timeoutMs:100};
    const inert = new NodeCliAdapter({executable:'/missing/docker',socketPath:'/missing/socket',privateConfigPath:'/missing/config',allowActivation:false});
    await expect(inert.execute(['info'],options)).rejects.toThrow('owner-activation-gated');
    const enabled = new NodeCliAdapter({executable:'/missing/docker',socketPath:'/missing/socket',privateConfigPath:'/missing/config',allowActivation:true});
    await expect(enabled.execute(['run','evil'],options)).rejects.toThrow('unsafe-cli-plan');
  });
});
