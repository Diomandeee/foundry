import { lstat, realpath, mkdir, open, statfs, mkdtemp, readdir } from 'node:fs/promises';
import { isAbsolute, normalize, join, parse } from 'node:path';
import type { RuntimePort, StagingPort, ExecuteOptions, CliResult } from './index';
import { allowedArgv } from './index';
import { spawnBounded } from './process';
function check(ok: unknown, code: string): asserts ok { if (!ok) throw new Error(code); }
function trustedOwner(uid: number): boolean { return uid === 0 || uid === process.getuid?.(); }
/** Root and current UID are trusted administrators; no shared/sticky writable ancestors.
 * These checks do not defend against those administrators or the daemon. */
/** Reject aliases, traversal, NUL, symlinks in every existing component. */
export async function canonicalPath(path: string): Promise<void> {
  check(typeof path === 'string' && isAbsolute(path) && normalize(path) === path && !path.includes('\0') && path !== parse(path).root, 'unsafe-path');
  let cursor = parse(path).root;
  const rootStat = await lstat(cursor);
  check(rootStat.isDirectory() && trustedOwner(rootStat.uid) && (rootStat.mode & 0o022) === 0,'unsafe-ancestor');
  const parts = path.slice(cursor.length).split('/');
  for (const part of path.slice(cursor.length).split('/')) {
    check(part !== '' && part !== '.' && part !== '..','unsafe-path');
    cursor = join(cursor,part);
    const entry = await lstat(cursor);
    check(!entry.isSymbolicLink(),'symlink-path');
    if (cursor !== path) check(entry.isDirectory() && trustedOwner(entry.uid) && (entry.mode & 0o022) === 0,'unsafe-ancestor');
  }
  check(await realpath(path) === path,'noncanonical-path');
}
/** Host must provision root as an owner-only directory. No path ever becomes a container mount. */
export class NodeStagingPort implements StagingPort {
  constructor(private readonly root: string, private readonly minFreeBytes = 64 * 1024 * 1024) {
    check(Number.isSafeInteger(minFreeBytes) && minFreeBytes >= 1024 * 1024,'invalid-disk-reserve');
  }
  async reserve(key: string): Promise<void> {
    check(/^[0-9a-f]{64}$/.test(key),'invalid-identity');
    await canonicalPath(this.root);
    const stat = await lstat(this.root);
    check(stat.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0,'staging-not-private');
    const disk = await statfs(this.root);
    check(disk.bavail * disk.bsize >= this.minFreeBytes,'disk-pressure');
    const directory = join(this.root,key);
    await mkdir(directory,{mode:0o700}); // Exclusive identity reservation, including across restarts.
    await canonicalPath(directory);
    const run = await mkdtemp(join(directory,'run-'));
    const marker = await open(join(run,'identity.json'),'wx',0o600);
    try { await marker.writeFile(JSON.stringify({identityKey:key})); await marker.sync(); } finally { await marker.close(); }
  }
}
export interface NodeCliConfig { executable: string; socketPath: string; privateConfigPath: string; allowActivation: boolean }
/** Local Docker only, explicit host gate; never inherits DOCKER_HOST, config, bearer or proxy values. */
export class NodeCliAdapter implements RuntimePort {
  private readonly config: Readonly<NodeCliConfig>;
  constructor(config: NodeCliConfig) { this.config = Object.freeze({...config}); }
  async execute(argv: readonly string[], options: ExecuteOptions): Promise<CliResult> {
    check(this.config.allowActivation === true,'owner-activation-gated');
    check(allowedArgv(argv),'unsafe-cli-plan');
    // Preserve the original branded-create check above, then never reread caller state.
    const args = Object.freeze([...argv]);
    const snapshot: ExecuteOptions = Object.freeze({stdin:options.stdin,maxBytes:options.maxBytes,timeoutMs:options.timeoutMs,...(options.signal === undefined ? {} : {signal:options.signal}),...(options.beforeSpawn === undefined ? {} : {beforeSpawn:options.beforeSpawn})});
    check(typeof snapshot.stdin === 'string' && Number.isSafeInteger(snapshot.maxBytes) && snapshot.maxBytes > 0 && snapshot.maxBytes <= 65536 && Number.isSafeInteger(snapshot.timeoutMs) && snapshot.timeoutMs > 0 && snapshot.timeoutMs <= 30000 && Buffer.byteLength(snapshot.stdin) <= 16384,'unsafe-cli-bounds');
    await canonicalPath(this.config.executable); await canonicalPath(this.config.socketPath);
    await canonicalPath(this.config.privateConfigPath);
    const exe = await lstat(this.config.executable), socket = await lstat(this.config.socketPath);
    check(exe.isFile() && (exe.mode & 0o022) === 0 && trustedOwner(exe.uid) && socket.isSocket() && trustedOwner(socket.uid) && (socket.mode & 0o022) === 0,'unsafe-local-runtime');
    const config = await lstat(this.config.privateConfigPath);
    check(config.isDirectory() && config.uid === process.getuid?.() && (config.mode & 0o777) === 0o700,'unsafe-cli-config');
    // Reject every entry, including config.json, contexts, helpers and cli-plugins.
    check((await readdir(this.config.privateConfigPath)).length === 0,'unsafe-cli-config');
    // No await between this local fence/runway check and the synchronous spawn path.
    // This cannot attest remote revocation or bound OS/daemon scheduling latency.
    check(!snapshot.signal?.aborted,'cancelled');
    snapshot.beforeSpawn?.();
    return spawnBounded(this.config.executable,['--config',this.config.privateConfigPath,'--host',`unix://${this.config.socketPath}`,...args],snapshot);
  }
}
