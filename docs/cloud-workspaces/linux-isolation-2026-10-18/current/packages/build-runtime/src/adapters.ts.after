import {approvalFor,check} from './plans.js';
import {NativeDescendantAttestor} from './mac-attestation.js';
import type {RuntimeAdapter,RuntimePlan,Running} from './types.js';
export {NativeDescendantAttestor} from './mac-attestation.js';
/** Shared native-host execution has no complete containment boundary. */
export class NativeMacAdapter implements RuntimeAdapter {
  constructor(attestor?:NativeDescendantAttestor){check(!attestor||attestor instanceof NativeDescendantAttestor,'native-concrete-attestor-required');}
  async prepare(plan:RuntimePlan):Promise<void>{approvalFor(plan);throw new Error('native-full-containment-unavailable');}
  async start(plan:RuntimePlan,_recordIdentity:(id:string)=>Promise<void>,_beforeStart:()=>void):Promise<Running>{
    approvalFor(plan);throw new Error('native-full-containment-unavailable');
  }
}
/** Historical configuration remains a source-compatible type, never an activation grant. */
export interface DockerHostConfig {executable:string;socketPath:string;privateConfigPath:string}
/** Deliberately deny the old shared-UID bind-mount path at every public entry.
 * Use createLinuxIsolatedBuildWorkerController and its narrow root broker instead.
 * Removing the unsafe implementation also prevents reflective JS access to old
 * private methods from accidentally bypassing this boundary. */
export class LinuxContainerAdapter implements RuntimeAdapter {
  constructor(_config:DockerHostConfig){}
  async prepare(plan:RuntimePlan):Promise<void>{
    approvalFor(plan);throw new Error('legacy-linux-writable-host-isolation-unavailable-use-isolated-adapter');
  }
  async start(plan:RuntimePlan,_recordIdentity:(id:string)=>Promise<void>,_beforeStart:()=>void):Promise<Running>{
    approvalFor(plan);throw new Error('legacy-linux-writable-host-isolation-unavailable-use-isolated-adapter');
  }
}
