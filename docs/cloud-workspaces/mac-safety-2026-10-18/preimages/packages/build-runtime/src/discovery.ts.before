import { statfs, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { freemem, release } from 'node:os';
import type { Census } from '../../build-jobs/src/contracts.js';
import { canonical } from './host.js';
import { absolute, check } from './plans.js';
import { command } from './process.js';
import type { ManagedStorageInventory } from './storage-inventory.js';
const env = Object.freeze({PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'});
/** Explicit invocation only. No discovery runs at module import, no activation or writes. */
export interface XcodeObservation {developerDir:string;observed:boolean;version?:string;buildNumber?:string|null;sdkIdentifiers?:string[];reason?:string}
export async function discover(root:string, developerDirs:readonly string[] = []) {
  absolute(root);
  const disk = await statfs(root);
  const xcodes: XcodeObservation[] = [];
  for (const developerDir of developerDirs) {
    absolute(developerDir);
    try {
      check(process.platform === 'darwin','xcode-host-unsupported');
      await canonical(developerDir,process.getuid?.() ?? -1);
      const exe = join(developerDir,'usr/bin/xcodebuild');
      await canonical(exe,process.getuid?.() ?? -1,'file');
      const explicit = {...env,DEVELOPER_DIR:developerDir};
      const version = await command(exe,['-version'],root,explicit), sdkText = await command(exe,['-showsdks'],root,explicit);
      const buildNumber = version.match(/^Build version ([A-Za-z0-9_.-]+)$/m)?.[1] ?? null;
      const sdkIdentifiers = [...sdkText.matchAll(/-sdk\s+([A-Za-z0-9_.-]+)/g)].map(match => match[1]!);
      xcodes.push({developerDir,observed:true,version,buildNumber,sdkIdentifiers});
    } catch { xcodes.push({developerDir,observed:false,reason:'unavailable-or-untrusted'}); }
  }
  return {platform:process.platform,arch:process.arch,uid:process.getuid?.() ?? null,freeBytes:disk.bavail*disk.bsize,xcodes,
    activation:'not-attempted',nativeHardCpuRamLimits:'unsupported',linuxDaemon:'not-inspected'};
}
/** Real observations only; SDK identifiers come from the explicit developer directories. */
export async function discoverCensus(root:string, developerDirs:readonly string[], identity:Pick<Census,'workerId'|'sequence'|'optedIn'|'activeJobs'>,
  storage:Pick<ManagedStorageInventory,'cacheBytes'|'workspaceBytes'|'complete'>={cacheBytes:null,workspaceBytes:null,complete:false}):Promise<Census> {
  check((process.platform === 'linux' || process.platform === 'darwin') && (process.arch === 'arm64' || process.arch === 'x64'),'unsupported-census-host');
  const observed = await discover(root,developerDirs);
  check(observed.xcodes.every(x => x.observed && x.buildNumber),'incomplete-xcode-observation');
  const macos = process.platform === 'darwin' ? (await command('/usr/bin/sw_vers',['-productVersion'],root,env)).trim() : `linux:${release()}`;
  return {...identity,os:process.platform,architecture:process.arch,freeBytes:observed.freeBytes,availableRamMib:Math.floor(freemem()/1048576),
    xcodeBuilds:[...new Set(observed.xcodes.map(x => x.buildNumber!))],sdks:[...new Set(observed.xcodes.flatMap(x => x.sdkIdentifiers ?? []))],macos,storage};
}
/** Find candidate Xcode installations by directory metadata only; never changes selection. */
export async function discoverXcodeCandidates(applications:string): Promise<string[]> {
  absolute(applications);
  const result:string[] = [];
  for (const name of await readdir(applications)) {
    if (!/^Xcode[^/]*\.app$/.test(name)) continue;
    const path = join(applications,name,'Contents/Developer');
    try { const s = await lstat(path); if (s.isDirectory() && !s.isSymbolicLink()) result.push(path); } catch { /* unavailable candidate */ }
  }
  return result;
}
/** CLI: --root PATH [--developer-dir PATH]... . No ambient project, credentials or service configuration. */
export async function discoveryCli(argv:readonly string[]): Promise<void> {
  let root:string|undefined; const dirs:string[] = [];
  for (let i=0;i<argv.length;i+=2) {
    const flag = argv[i], value = argv[i+1]; check(value,'missing-discovery-value');
    if (flag === '--root' && root === undefined) root = value;
    else if (flag === '--developer-dir') dirs.push(value);
    else throw new Error('invalid-discovery-option');
  }
  check(root,'explicit-root-required');
  process.stdout.write(`${JSON.stringify(await discover(root,dirs),null,2)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void discoveryCli(process.argv.slice(2)).catch(() => { process.stderr.write('discovery-unavailable\n'); process.exitCode = 1; });
}
