import {DatabaseSync} from 'node:sqlite';
import {lstat} from 'node:fs/promises';
import {dirname} from 'node:path';
import {canonicalPath} from '../../packages/worker-runtime/src/node.js';
import {privateDirectory, credential} from '../foundry-pilot/private-state.js';
import {createClaimInputResolver, createClaimResultResolver, type ClaimNamespaceTemplate} from '../../workers/library-broker/src/claim-inputs.js';
import {projectObjectReader} from '../../packages/build-storage/src/project-input-io.js';
import type {StorageWorkerConfig} from '../../packages/build-runtime/src/storage-integration.js';
import type {GcsWritePorts} from '../../packages/build-storage/src/types.js';
import type {RuntimePlan} from '../../packages/build-runtime/src/types.js';
import * as v from '../../packages/build-jobs/src/validation.js';
import {parseOwnerConfig,type OwnerConfig,type NamespaceConfig} from './config.js';
import {assertBuildAttemptContext,assertBuildResponseSource,type BuildAttemptContext} from '../../packages/build-runtime/src/controller.js';
import {check} from '../../packages/build-runtime/src/plans.js';

/** Only physical boundaries are injectable; production always uses these defaults. */
export interface StorageBoundaries {
  openDatabase(path:string,signal:AbortSignal):Promise<DatabaseSync>;
  credential(reference:string):string;
  fetch:typeof fetch;
  providerFetch:GcsWritePorts['fetch'];
}
async function existingDatabase(path:string,signal:AbortSignal):Promise<DatabaseSync> {
  const alive=()=>check(!signal.aborted,'database-open-aborted');
  alive();await privateDirectory(dirname(path));alive();await canonicalPath(path);alive();
  const before=await lstat(path);alive();
  check(before.isFile()&&before.nlink===1&&before.uid===process.getuid?.()&&(before.mode&0o077)===0,'private-existing-database-required');
  // Require an existing file before invoking Node's SQLite open.
  const db=new DatabaseSync(path,{open:false});
  try {
    // Node's constructor has no create:false switch. The identity check before and
    // after opening plus private ancestors excludes untrusted path replacement.
    alive();db.open();alive();const after=await lstat(path);alive();
    check(after.dev===before.dev&&after.ino===before.ino&&after.nlink===1,'database-identity-changed');return db;
  }catch(error){try{db.close();}catch{}throw error;}
}
export const nativeStorageBoundaries:StorageBoundaries={
  openDatabase:existingDatabase,credential,
  fetch:(url,init)=>fetch(url,init),
  providerFetch:(url,init)=>fetch(url,{...init,body:init.body===undefined?undefined:Uint8Array.from(init.body).buffer}),
};
/** Lazy post-claim assembly. Construction opens no DB and resolves no reference.
 * Handles remain owned until process exit: late provider work must not lose them.
 * No DB reset, unlink, namespace rollover, listener, or journal cleanup exists. */
export function composeStorage(raw:Readonly<OwnerConfig>,ports:StorageBoundaries=nativeStorageBoundaries){
  const c=parseOwnerConfig(raw),p=c.claimPolicy;
  const handles:DatabaseSync[]=[];
  let inputReady:Promise<ReturnType<typeof createClaimInputResolver>>|undefined;
  let resultReady:Promise<ReturnType<typeof createClaimResultResolver>>|undefined;
  function admit(inputHash:string,projectId:string,plan:RuntimePlan,context:BuildAttemptContext,signal:AbortSignal){
    assertBuildAttemptContext(context);check(!signal.aborted,'storage-aborted');
    assertBuildResponseSource(context.source,{environment:p.environment,authorityId:p.authorityId,workerId:p.workerId},p.epoch);
    const b=context.compute;
    check(inputHash===p.inputHash&&projectId===p.projectId&&context.inputHash===p.inputHash&&context.projectId===p.projectId&&
      plan.jobId===p.jobId&&context.serverProfileHash===p.serverProfileHash&&context.localRecipeHash===p.localRecipeHash&&plan.profileHash===p.localRecipeHash&&
      b.authorityId===p.authorityId&&b.workerId===p.workerId&&b.workloadId===p.jobId&&b.epoch===p.epoch&&b.generation===p.generation&&b.incarnation===p.incarnation&&
      b.attemptId===plan.attemptId&&b.leaseId===plan.attemptId,'exact-claim-policy-required-before-database-open');
  }
  async function template(n:NamespaceConfig,signal:AbortSignal):Promise<ClaimNamespaceTemplate>{
    const alive=()=>check(!signal.aborted,'storage-assembly-aborted');
    alive();const controlDb=await ports.openDatabase(n.controlDbPath,signal);handles.push(controlDb);alive();
    const brokerDb=await ports.openDatabase(n.brokerDbPath,signal);handles.push(brokerDb);alive();
    return {environment:p.environment,authorityId:p.authorityId,ownerPrincipal:c.ownerPrincipal,
      approval:n.approval,controlDb,brokerDb,now:Date.now,
      access:{origin:c.origin,environment:p.environment,authorityId:p.authorityId,
        credential:()=>ports.credential(c.accessCredentialRef),transport:ports.fetch},
      // No HTTP handler is exposed. Direct ports retain immutable scope checks.
      authConfig:()=>{throw new Error('broker-http-not-exposed');},enabled:()=>true,
      gcs:n.gcs,provider:{getAccessToken:async(ref,signal)=>{check(!signal.aborted,'provider-aborted');return ports.credential(ref);},fetch:ports.providerFetch}};
  }
  async function inputAssembly(signal:AbortSignal){
    const namespaces:ClaimNamespaceTemplate[]=[];
    for(const n of c.inputNamespaces){check(!signal.aborted,'storage-assembly-aborted');namespaces.push(await template(n,signal));check(!signal.aborted,'storage-assembly-aborted');}
    return createClaimInputResolver([{policy:p,namespaces}]);
  }
  async function resultAssembly(signal:AbortSignal){
    const namespace=await template(c.resultNamespace,signal);check(!signal.aborted,'storage-assembly-aborted');
    return createClaimResultResolver([{policy:p,namespaces:[namespace]}]);
  }
  const resolveInputStorage:NonNullable<StorageWorkerConfig['projectInputs']>['resolve']=async(input,plan,context,signal)=>{
    v.input(input);admit(v.hash(input),input.projectId,plan,context,signal);
    const resolve=await (inputReady??=inputAssembly(signal)); // Failed promises stay failed.
    admit(v.hash(input),input.projectId,plan,context,signal);return resolve(input,plan,context,signal);
  };
  const resolveResultStorage:NonNullable<StorageWorkerConfig['resolveResultStorage']>=async(job,plan,context,signal)=>{
    v.job(job);check(job.id===p.jobId&&job.profileHash===p.serverProfileHash,'exact-result-job-required');
    admit(job.inputHash,job.projectId,plan,context,signal);
    const resolve=await (resultReady??=resultAssembly(signal));
    admit(job.inputHash,job.projectId,plan,context,signal);return resolve(job,plan,context,signal);
  };
  const readInput:StorageWorkerConfig['readInput']=async(ref,context,signal)=>{
    check(context.attempt,'actual-claim-required');
    const resolved=await resolveInputStorage(context.input,context.plan,context.attempt,signal);
    const reader=projectObjectReader(resolved.scope,resolved.routing,signal);
    const bytes=await reader.read(ref);await reader.finish();return bytes;
  };
  return {resolveInputStorage,resolveResultStorage,readInput};
}
