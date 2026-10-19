import {isAbsolute, normalize} from 'node:path';
import type {BuildJob, BuildProfile} from '../../packages/build-jobs/src/contracts.js';
import * as v from '../../packages/build-jobs/src/validation.js';
import {approveParentProfile, canonicalData, type LocalRecipePolicy} from '../../packages/build-runtime/src/parent-profile.js';
import type {NodeLivenessConfig} from '../../packages/build-runtime/src/liveness.js';
import type {LinuxIsolationConfig} from '../../packages/build-runtime/src/linux-isolated-client.js';
import type {MacVmAdapterConfig} from '../../packages/build-runtime/src/mac-vm-adapter.js';
import type {ApprovedFile} from '../../packages/build-storage/src/types.js';
import {createMacReadonlyTreeSeal} from '../../packages/build-storage/src/mac-readonly-seal.js';
import type {ClaimInputPolicy, ClaimNamespaceTemplate} from '../../workers/library-broker/src/claim-inputs.js';
import type {GcsHostConfig} from '../../packages/library-gcs/src/index.js';
import {createGcsReader} from '../../packages/library-gcs/src/index.js';
import {readJsonFile} from '../foundry-pilot/private-state.js';
import {workerIdentity} from '../foundry-pilot/worker-config.js';

export interface NamespaceConfig {
  controlDbPath:string; brokerDbPath:string;
  approval:ClaimNamespaceTemplate['approval']; gcs:GcsHostConfig;
}
export interface OwnerConfig {
  version:1; origin:string; activationReceiptSha256:string;
  executorCredentialRef:string; accessCredentialRef:string; verifierCredentialRef:string;
  ownerPrincipal:string; profile:BuildProfile; serverProfileHash:string;
  localPolicy:LocalRecipePolicy; job:BuildJob; claimKey:string; claimPolicy:ClaimInputPolicy;
  liveness:Omit<NodeLivenessConfig,'host'|'developerDirs'|'vm'|'macStorage'|'linuxIsolation'>;
  maxInputBytes:number; outputs:ApprovedFile[];
  inputNamespaces:NamespaceConfig[]; resultNamespace:NamespaceConfig;
  runtime:{kind:'linux';isolation:LinuxIsolationConfig}|({kind:'mac'} & Pick<MacVmAdapterConfig,
    'capability'|'sources'|'executable'|'maxBootBytes'|'maxOutputDiskBytes'|'storage'>);
}
export function reference(value:unknown):asserts value is string {
  v.need(typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(value),'credential-reference-name-required');
}
export function ownerPath(value:unknown):asserts value is string {
  v.need(typeof value==='string'&&value.length<=1024&&isAbsolute(value)&&normalize(value)===value&&value!=='/'&&!/[\x00-\x1f\x7f]/.test(value),'canonical-owner-path-required');
}
export function origin(value:unknown):asserts value is string {
  v.text(value,2048);const u=new URL(value);
  v.need(u.protocol==='https:'&&u.origin===value&&!u.username&&!u.password,'fixed-https-origin-required');
}
function fields(value:unknown,required:string[],optional:string[]=[]):asserts value is Record<string,any> {
  v.need(value!==null&&typeof value==='object'&&!Array.isArray(value),'object-required');
  const keys=Object.keys(value);v.need(required.every(k=>keys.includes(k))&&keys.every(k=>required.includes(k)||optional.includes(k)),'unknown-or-missing-fields');
}
function freeze<T>(value:T):T {
  if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;
}
function seal(value:unknown):void {
  fields(value,['helper','tree'],['maxOperationMs']);fields(value.helper,['path','sha256']);
  ownerPath(value.helper.path);v.digest(value.helper.sha256);
  fields(value.tree,['path','mountPoint','filesystem','fsid','mountSource','volumeUuid','rootDevice','rootInode']);
  createMacReadonlyTreeSeal(value as unknown as Parameters<typeof createMacReadonlyTreeSeal>[0]);
}
/** Pure bounded data validation. No DB open, secret resolution, helper probe or IO. */
export function parseOwnerConfig(raw:unknown):Readonly<OwnerConfig> {
  const c:unknown=JSON.parse(canonicalData(raw));
  fields(c,['version','origin','activationReceiptSha256','executorCredentialRef','accessCredentialRef','verifierCredentialRef','ownerPrincipal',
    'profile','serverProfileHash','localPolicy','job','claimKey','claimPolicy','liveness','maxInputBytes','outputs','inputNamespaces','resultNamespace','runtime']);
  v.need(c.version===1,'config-version');origin(c.origin);v.digest(c.activationReceiptSha256);
  [c.executorCredentialRef,c.accessCredentialRef,c.verifierCredentialRef].forEach(reference);
  v.need(new Set([c.executorCredentialRef,c.accessCredentialRef,c.verifierCredentialRef]).size===3,'separate-role-references-required');
  v.id(c.ownerPrincipal);v.profile(c.profile);v.job(c.job);v.id(c.claimKey);v.digest(c.serverProfileHash);
  fields(c.localPolicy,['host','pids','tmpMib','minFreeBytes'],['cmakeConfigureArgs']);
  fields(c.localPolicy.host,['uid','gid','dedicatedBuildUser','allowActivation','inputBase','workBase','journalRoot'],['imageExecutables']);
  if(c.localPolicy.host.imageExecutables)fields(c.localPolicy.host.imageExecutables,[],['npm','cargo','cmake']);
  const binding=approveParentProfile(c.profile,c.serverProfileHash,c.localPolicy as LocalRecipePolicy);
  v.need(c.job.projectId===c.profile.projectId&&c.job.profileHash===binding.serverProfileHash,'job-profile-binding');
  fields(c.claimPolicy,['environment','authorityId','workerId','jobId','projectId','inputHash','serverProfileHash','localRecipeHash','epoch','generation','incarnation']);
  const p=c.claimPolicy;
  [p.environment,p.authorityId,p.workerId,p.jobId,p.projectId].forEach(v.id);
  [p.inputHash,p.serverProfileHash,p.localRecipeHash].forEach(v.digest);
  v.uint(p.epoch,1);v.uint(p.generation);v.uint(p.incarnation);
  v.need(p.jobId===c.job.id&&p.projectId===c.job.projectId&&p.inputHash===c.job.inputHash&&p.serverProfileHash===binding.serverProfileHash&&p.localRecipeHash===binding.localRecipeHash,'exact-claim-policy-required');
  fields(c.liveness,['expectedEpoch','approvedIdentity','authority','revision','incarnation','initialEnrollmentSequence','initialCensusSequence','optedIn','cacheRoot']);
  const l=c.liveness;fields(l.authority,['environment','authorityId','workerId']);
  workerIdentity(l.approvedIdentity);
  v.need(l.approvedIdentity.workerClass==='general'&&l.approvedIdentity.devices.length===0&&l.approvedIdentity.workerId===p.workerId&&
    l.authority.environment===p.environment&&l.authority.authorityId===p.authorityId&&l.authority.workerId===p.workerId&&l.expectedEpoch===p.epoch&&l.incarnation===p.incarnation&&l.optedIn===true,'liveness-policy-binding');
  v.uint(l.revision,1);v.uint(l.initialEnrollmentSequence);v.uint(l.initialCensusSequence);ownerPath(l.cacheRoot);
  v.uint(c.maxInputBytes,1,2*1024**3);
  v.need(Array.isArray(c.outputs)&&c.outputs.length===c.profile.outputPaths.length,'output-policy');
  for(const o of c.outputs){fields(o,['path','classification']);v.relative(o.path);v.need(['build-output','debug-symbols'].includes(o.classification),'unsigned-build-output-only');}
  v.need(new Set(c.outputs.map((o:ApprovedFile)=>o.path)).size===c.outputs.length&&c.profile.outputPaths.every((s:string)=>c.outputs.some((o:ApprovedFile)=>o.path===s)),'output-selection');
  v.need(Array.isArray(c.inputNamespaces)&&c.inputNamespaces.length>0&&c.inputNamespaces.length<=32,'pilot-input-namespace-bound');
  const dbs=new Set<string>(),names=new Set<string>();
  for(const [n,publication] of [...c.inputNamespaces.map((n:unknown)=>[n,false]),[c.resultNamespace,true]] as [unknown,boolean][]){
    fields(n,['controlDbPath','brokerDbPath','approval','gcs']);
    for(const path of [n.controlDbPath,n.brokerDbPath]){ownerPath(path);v.need(!dbs.has(path),'distinct-database-paths-required');dbs.add(path);}
    fields(n.approval,['version','namespaceRef','scope','profileHash','policyVersion','intentId','authorizationGeneration','expiresAt','publication','approvedObjects']);
    const a=n.approval;fields(a.scope,['projectId','principalRef','namespaceRef']);
    [a.namespaceRef,a.policyVersion,a.intentId,a.scope.principalRef].forEach(v.id);
    v.uint(a.authorizationGeneration,1);v.uint(a.expiresAt,1);
    v.need(!names.has(a.namespaceRef),'distinct-namespaces-required');names.add(a.namespaceRef);
    v.need(a.version===1&&a.publication===publication&&a.scope.namespaceRef===a.namespaceRef&&a.scope.projectId===p.projectId&&a.profileHash===p.serverProfileHash,'namespace-policy-binding');
    v.need(Array.isArray(a.approvedObjects)&&a.approvedObjects.length<=32&&(publication?a.approvedObjects.length===0:a.approvedObjects.length>0),'explicit-object-allowlist-required');
    for(const ref of a.approvedObjects){v.ref(ref);v.need(ref.projectId===p.projectId,'approved-object-project');}
    fields(n.gcs,['origin','bucket','projectId','credentialRef'],['limits']);reference(n.gcs.credentialRef);
    v.need(![c.executorCredentialRef,c.accessCredentialRef,c.verifierCredentialRef].includes(n.gcs.credentialRef)&&n.gcs.projectId===p.projectId,'provider-credential-project-binding');
    // Existing constructor validates GCS bounds without invoking either port.
    createGcsReader(n.gcs as GcsHostConfig,{getAccessToken:async()=>{throw new Error('inert-validation');},fetch:async()=>{throw new Error('inert-validation');}});
  }
  const r=c.runtime;
  if(c.profile.kind==='linux-build-v1'){
    fields(r,['kind','isolation']);fields(r.isolation,['python','pythonSha256','helper','helperSha256']);
    v.need(r.kind==='linux'&&r.isolation.python==='/usr/bin/python3.12'&&r.isolation.helper==='/usr/local/libexec/foundry-linux-isolation.py','linux-installed-paths-required');
    v.digest(r.isolation.pythonSha256);v.digest(r.isolation.helperSha256);
  }else{
    fields(r,['kind','capability','sources','executable','maxBootBytes','maxOutputDiskBytes','storage']);
    v.need(r.kind==='mac'&&r.executable==='/Library/Foundry/bin/mac-vm-host','mac-runtime-required');
    fields(r.capability,['sha256','seal']);v.digest(r.capability.sha256);seal(r.capability.seal);
    v.need(r.capability.seal.tree.path===`/Library/Foundry/VM/capabilities/${r.capability.sha256}`,'capability-root');
    v.need(Array.isArray(r.sources)&&r.sources.length>0&&r.sources.length<=128,'source-image-required');
    for(const s of r.sources){fields(s,['snapshotHash','seal']);v.digest(s.snapshotHash);seal(s.seal);}
    fields(r.storage,['python','helper']);
    for(const [name,path] of [['python','/Library/Foundry/bin/cas-python'],['helper','/Library/Foundry/bin/mac-cas.py']]){
      fields(r.storage[name!],['path','sha256']);v.need(r.storage[name!].path===path,'cas-installed-path');v.digest(r.storage[name!].sha256);
    }
    v.uint(r.maxBootBytes,1048576,128*1024**3);v.uint(r.maxOutputDiskBytes,1048576,8*1024**3);
  }
  return freeze(c as unknown as OwnerConfig);
}
export async function loadOwnerConfig(path:string):Promise<Readonly<OwnerConfig>> {
  return parseOwnerConfig(await readJsonFile(path,262144,true));
}
