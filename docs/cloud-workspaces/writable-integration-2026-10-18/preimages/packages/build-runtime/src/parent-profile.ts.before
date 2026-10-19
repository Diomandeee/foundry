import { types } from 'node:util';
import type { BuildProfile, LinuxRecipe as ParentLinuxRecipe, XcodeRecipe as ParentXcodeRecipe } from '../../build-jobs/src/contracts.js';
import type { Approval, HostPolicy, Limits, Recipe } from './types.js';
import { approveRecipe, check, hash, profileDigest } from './plans.js';
/** Same sorted-key JSON encoding as build-jobs/library-jobs; no runtime package dependency. */
export function canonicalData(value:unknown):string {
  let nodes = 0;
  const active = new Set<object>();
  const visit = (v:unknown, depth:number):string => {
    check(++nodes <= 16384 && depth <= 16,'data-budget');
    if (v === null || typeof v === 'boolean' || typeof v === 'string' || typeof v === 'number') {
      if (typeof v === 'number') check(Number.isFinite(v) && !Object.is(v,-0),'invalid-json-number');
      return JSON.stringify(v);
    }
    check(typeof v === 'object' && v !== null && !types.isProxy(v) && !active.has(v),'non-inert-data');
    check(Object.getPrototypeOf(v) === (Array.isArray(v) ? Array.prototype : Object.prototype),'invalid-data-prototype');
    const d = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(v);
    check(keys.length <= 4096 && keys.every(k => typeof k === 'string' && !['__proto__','constructor','prototype'].includes(k) && 'value' in d[k]!),'non-inert-fields');
    active.add(v);
    let text:string;
    if (Array.isArray(v)) {
      check(keys.length === v.length+1,'decorated-array');
      const values:string[] = [];
      for (let i=0;i<v.length;i++) { check(d[String(i)],'sparse-array'); values.push(visit(d[String(i)]!.value,depth+1)); }
      text = `[${values.join(',')}]`;
    } else text = `{${(keys as string[]).sort().map(k => `${JSON.stringify(k)}:${visit(d[k]!.value,depth+1)}`).join(',')}}`;
    active.delete(v); return text;
  };
  const text = visit(value,0); check(Buffer.byteLength(text) <= 262144,'data-byte-budget'); return text;
}
export interface ParentProfileBinding {
  readonly serverProfileHash:string; readonly localRecipeHash:string;
  readonly approval:Readonly<Approval>; readonly profile:Readonly<BuildProfile>;
}
export interface LocalRecipePolicy {
  host:HostPolicy; pids:number; tmpMib:number; minFreeBytes:number;
  /** CMake configure flags are approved LOCALLY, never copied from the claimed job. */
  cmakeConfigureArgs?: readonly string[];
}
const bindings = new WeakSet<object>();
function freeze(value:unknown):void {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
}
/** Explicit owner configuration step. A claim response MUST NOT approve itself here. */
export function approveParentProfile(ownerProfile:BuildProfile, expectedServerHash:string, policy:LocalRecipePolicy):ParentProfileBinding {
  const encoded = canonicalData(ownerProfile);
  check(/^[0-9a-f]{64}$/.test(expectedServerHash) && hash(encoded) === expectedServerHash,'owner-server-profile-hash-mismatch');
  const p = JSON.parse(encoded) as BuildProfile;
  check(p.version === 1 && p.trustedProject === true && Array.isArray(p.outputPaths),'unsupported-parent-profile');
  // Portable admission matches the wired broker; generic runtime still allows 128MiB.
  check(p.outputPaths.length > 0 && p.outputPaths.length <= 24,'portable-required-output-count');
  check(Number.isSafeInteger(p.limits.maxOutputBytes) && p.limits.maxOutputBytes > 0 && p.limits.maxOutputBytes <= 7*1048576,'portable-output-budget');
  let recipe:Recipe;
  if (p.kind === 'linux-build-v1') {
    const r = p.recipe as ParentLinuxRecipe;
    check(r.network === 'none','approved-dependencies-not-configured');
    if (r.tool === 'cmake') check(r.args[0] === '--build' && r.args[1] === '/work/build','cmake-build-tree-must-be-work-build');
    recipe = {kind:p.kind,image:r.image,architecture:r.architecture,tool:r.tool,args:[...r.args],network:r.network,outputPaths:[...p.outputPaths],
      ...(policy.cmakeConfigureArgs ? {configureArgs:[...policy.cmakeConfigureArgs]} : {})};
  } else {
    check(p.kind === 'xcode-build-v1','unsupported-parent-kind');
    const r = p.recipe as ParentXcodeRecipe;
    check(r.workspace === r.projectPath.endsWith('.xcworkspace'),'workspace-project-mismatch');
    check(r.configuration === 'Debug' || r.configuration === 'Release','unsupported-native-configuration');
    recipe = {kind:p.kind,developerDir:r.developerDir,project:r.projectPath,scheme:r.scheme,configuration:r.configuration,sdk:r.sdk,destination:r.destination,
      xcodeBuild:r.xcodeBuild,macos:r.macos,trustedNativeProject:true,dependencyPolicy:'preloaded-offline',outputPaths:[...p.outputPaths]};
  }
  const limits:Limits = {cpu:p.limits.cpu,ramMib:p.limits.ramMib,timeoutMs:p.limits.timeoutMs,maxOutputBytes:p.limits.maxOutputBytes,
    pids:policy.pids,tmpMib:policy.tmpMib,minFreeBytes:Math.max(policy.minFreeBytes,50*1024**3+p.limits.estimatedAdditionalBytes)};
  const approval = approveRecipe({recipe,host:policy.host,limits});
  freeze(p);
  const binding = Object.freeze({serverProfileHash:expectedServerHash,localRecipeHash:profileDigest(approval),approval,profile:p});
  bindings.add(binding); return binding;
}
export function assertParentBinding(binding:ParentProfileBinding):void {
  check(bindings.has(binding) && profileDigest(binding.approval) === binding.localRecipeHash,'unbranded-parent-binding');
}
