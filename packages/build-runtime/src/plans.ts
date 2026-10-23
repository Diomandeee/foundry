import { createHash } from 'node:crypto';
import { isAbsolute, normalize, relative, sep } from 'node:path';
import type { Approval, Attempt, RuntimePlan } from './types.js';

export function check(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }
export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export function absolute(p: string): void {
  check(typeof p === 'string' && isAbsolute(p) && normalize(p) === p && !p.includes('\0') && !p.includes(',') && !p.includes('\n'), 'noncanonical-path');
}
export function within(base: string, path: string): void {
  absolute(base); absolute(path);
  const r = relative(base, path);
  check(r.length > 0 && r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r), 'path-outside-base');
}
export function localPath(p: string): void {
  check(typeof p === 'string' && /^[A-Za-z0-9_./-]{1,240}$/.test(p) && !p.startsWith('-') && !isAbsolute(p) && normalize(p) === p && p !== '.' && !p.split('/').includes('..'), 'invalid-relative-path');
}
function token(s: string): void { check(typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(s), 'invalid-recipe-token'); }
const approved = new WeakMap<object, Readonly<Approval>>();
const plans = new WeakMap<object, Readonly<Approval>>();
const phases = new WeakMap<object, readonly (readonly string[])[]>();
/** Owner-only API. NEVER feed this function the remote job body or its recipes/limits. */
export function approveRecipe(value: Approval): Readonly<Approval> {
  // Snapshot plain JSON into private memory; caller must supply data, not accessor objects.
  const a = JSON.parse(JSON.stringify(value)) as Approval;
  const { host: h, limits: l, recipe: r } = a;
  check(h.dedicatedBuildUser === true && typeof h.allowActivation === 'boolean' && Number.isSafeInteger(h.uid) && h.uid > 0 && Number.isSafeInteger(h.gid) && h.gid > 0, 'dedicated-user-required');
  [h.inputBase,h.workBase,h.journalRoot].forEach(absolute);
  const roots = [h.inputBase,h.workBase,h.journalRoot];
  for (const x of roots) for (const y of roots) if (x !== y) check(!y.startsWith(`${x}/`), 'overlapping-host-roots');
  check(new Set(roots).size === 3, 'overlapping-host-roots');
  for (const [k,min,max] of [['cpu',1,256],['ramMib',128,1048576],['pids',16,4096],['timeoutMs',1,86400000],['maxOutputBytes',1,134217728],['tmpMib',1,8192],['minFreeBytes',1048576,Number.MAX_SAFE_INTEGER]] as const) {
    check(Number.isSafeInteger(l[k]) && l[k] >= min && l[k] <= max, 'invalid-limits');
  }
  check(Array.isArray(r.outputPaths) && r.outputPaths.length <= 64, 'invalid-outputs');
  r.outputPaths.forEach(localPath);
  if (r.kind === 'linux-build-v1') {
    check(/^[a-z0-9][a-z0-9./:_-]{0,200}@sha256:[0-9a-f]{64}$/.test(r.image), 'digest-required');
    check((r.architecture === 'x64' || r.architecture === 'arm64') && ['npm','cargo','cmake','python'].includes(r.tool), 'unsupported-linux-recipe');
    check(r.network === 'none','approved-dependencies-not-configured');
    check(Array.isArray(r.args) && r.args.length <= 32 && r.args.every(s => typeof s === 'string' && s.length > 0 && s.length <= 256 && !/[\x00-\x1f\x7f]/.test(s)), 'invalid-owner-tool-args');
    if (r.configureArgs) {
      check(r.tool === 'cmake' && r.configureArgs.length <= 32 && r.configureArgs.every(s => typeof s === 'string' && s.length <= 256 && !/[\x00-\x1f\x7f]/.test(s)), 'invalid-configure-args');
      Object.freeze(r.configureArgs);
    }
    if (r.installArgs) {
      check(r.tool === 'python' && Array.isArray(r.installArgs) && r.installArgs.length > 0 && r.installArgs.length <= 32 && r.installArgs.every(s => typeof s === 'string' && s.length > 0 && s.length <= 256 && !/[\x00-\x1f\x7f]/.test(s)), 'invalid-install-args');
      Object.freeze(r.installArgs);
    }
    const executable = h.imageExecutables?.[r.tool]; check(executable,'image-executable-mapping-required'); absolute(executable);
    Object.freeze(r.args);
  } else {
    check(r.kind === 'xcode-build-v1' && r.trustedNativeProject === true, 'trusted-native-only');
    check(r.dependencyPolicy === 'preloaded-offline' && (r.configuration === 'Debug' || r.configuration === 'Release'), 'unsupported-native-configuration');
    token(r.xcodeBuild); check(/^\d+(\.\d+){1,2}$/.test(r.macos), 'explicit-macos-version-required');
    absolute(r.developerDir); localPath(r.project); token(r.scheme); token(r.sdk);
    check(/^(generic\/platform=(iOS|macOS|iOS Simulator)|platform=macOS,arch=(arm64|x86_64))$/.test(r.destination), 'explicit-destination-required');
    check(/\.(xcodeproj|xcworkspace)$/.test(r.project), 'invalid-xcode-project');
  }
  Object.freeze(r.outputPaths); Object.freeze(r); Object.freeze(l); if (h.imageExecutables) Object.freeze(h.imageExecutables); Object.freeze(h); Object.freeze(a);
  approved.set(a,a); return a;
}
export function profileDigest(a: Readonly<Approval>): string {
  check(approved.has(a), 'unapproved-recipe');
  // Explicit fields; field insertion order in the owner's object is immaterial.
  const r = a.recipe, l = a.limits, h = a.host;
  return hash(JSON.stringify([r.kind,[...r.outputPaths],
    r.kind === 'linux-build-v1' ? [r.image,r.architecture,r.tool,[...r.args],r.configureArgs ?? [],r.network,h.imageExecutables?.[r.tool],r.installArgs ?? []] : [r.configuration,r.dependencyPolicy,r.developerDir,r.project,r.scheme,r.sdk,r.destination,r.trustedNativeProject,r.xcodeBuild,r.macos],
    l.cpu,l.ramMib,l.pids,l.timeoutMs,l.maxOutputBytes,l.tmpMib,l.minFreeBytes,
    h.uid,h.gid,h.dedicatedBuildUser,h.inputBase,h.workBase,h.journalRoot]));
}
export function buildPlan(a: Readonly<Approval>, attempt: Attempt): RuntimePlan {
  check(approved.has(a), 'unapproved-recipe');
  const i = {...attempt}; token(i.attemptId); token(i.jobId);
  within(a.host.inputBase,i.inputRoot); within(a.host.workBase,i.workRoot);
  const r = a.recipe;
  const env: Record<string,string> = { PATH:'/usr/bin:/bin', LANG:'C', LC_ALL:'C', HOME:`${i.workRoot}/home`, TMPDIR:`${i.workRoot}/tmp` };
  let argv: string[];
  if (r.kind === 'linux-build-v1') {
    argv = [a.host.imageExecutables![r.tool]!,...r.args];
    env.HOME = '/work'; env.TMPDIR = '/tmp'; env.CMAKE_BUILD_PARALLEL_LEVEL = String(a.limits.cpu);
    env.NPM_CONFIG_OFFLINE = 'true'; env.NPM_CONFIG_CACHE = '/work/npm-cache';
    env.NPM_CONFIG_USERCONFIG = '/dev/null'; env.NPM_CONFIG_GLOBALCONFIG = '/dev/null';
    env.CARGO_HOME = '/work/cargo'; env.CARGO_TARGET_DIR = '/work/target'; env.CARGO_NET_OFFLINE = 'true';
    if (r.tool === 'python') {
      env.PYTHONPATH = '/work/site:/work/source'; env.PYTHONDONTWRITEBYTECODE = '1'; env.PYTHONHASHSEED = '0';
      env.PIP_NO_INDEX = '1'; env.PIP_NO_CACHE_DIR = '1'; env.PIP_DISABLE_PIP_VERSION_CHECK = '1';
    }
  } else {
    env.DEVELOPER_DIR = r.developerDir;
    env.CLANG_MODULE_CACHE_PATH = `${i.workRoot}/modules`;
    env.SWIFT_MODULECACHE_PATH = `${i.workRoot}/swift-modules`;
    argv = [`${r.developerDir}/usr/bin/xcodebuild`,r.project.endsWith('.xcworkspace') ? '-workspace' : '-project',`${i.inputRoot}/${r.project}`,
      '-scheme',r.scheme,'-configuration',r.configuration,'-sdk',r.sdk,'-destination',r.destination,
      '-derivedDataPath',`${i.workRoot}/DerivedData`,'-clonedSourcePackagesDirPath',`${i.workRoot}/dependencies`,
      '-disableAutomaticPackageResolution','-onlyUsePackageVersionsFromResolvedFile','-skipPackageUpdates',
      '-jobs',String(a.limits.cpu),'CODE_SIGNING_ALLOWED=NO','CODE_SIGNING_REQUIRED=NO','CODE_SIGN_IDENTITY=',
      'DEVELOPMENT_TEAM=','COMPILER_INDEX_STORE_ENABLE=NO','build'];
  }
  const p: RuntimePlan = Object.freeze({ ...i,kind:r.kind,profileHash:profileDigest(a),timeoutMs:a.limits.timeoutMs,cpu:a.limits.cpu,ramMib:a.limits.ramMib,
    argv:Object.freeze(argv),env:Object.freeze(env),...(r.kind === 'linux-build-v1' ? {image:r.image} : {}),outputPaths:Object.freeze([...r.outputPaths]) });
  plans.set(p,a);
  const commands = r.kind === 'linux-build-v1' && r.tool === 'cmake'
    ? [[argv[0]!,'-S','/input','-B','/work/build',...(r.configureArgs ?? [])],argv]
    : r.kind === 'linux-build-v1' && r.tool === 'python' && r.installArgs
    ? [[argv[0]!,'-m','pip','install','--no-index','--no-cache-dir','--target','/work/site',...r.installArgs],argv]
    : [argv];
  phases.set(p,Object.freeze(commands.map(command => Object.freeze([...command]))));
  return p;
}
export function phasesFor(plan:RuntimePlan): readonly (readonly string[])[] {
  approvalFor(plan); return phases.get(plan)!;
}
export function approvalFor(plan: RuntimePlan): Readonly<Approval> {
  const a = plans.get(plan); check(a, 'untrusted-plan'); return a;
}
