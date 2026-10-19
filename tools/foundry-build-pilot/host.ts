import {approveParentProfile} from '../../packages/build-runtime/src/parent-profile.js';
import {NodeBuildTransport} from '../../packages/build-runtime/src/node-transport.js';
import {createLinuxIsolatedBuildWorkerController} from '../../packages/build-runtime/src/linux-isolated-worker.js';
import {createMacVmBuildWorkerController} from '../../packages/build-runtime/src/mac-vm-worker.js';
import {linuxIsolationProfile} from '../../packages/build-runtime/src/linux-isolated-adapter.js';
import {check} from '../../packages/build-runtime/src/plans.js';
import {parseOwnerConfig} from './config.js';
import {composeStorage,nativeStorageBoundaries,type StorageBoundaries} from './storage.js';

/** Actual factory caller; inert until its sole run() invocation. No loop/retry. */
export function prepareHost(raw:unknown,ports:StorageBoundaries=nativeStorageBoundaries){
  const c=parseOwnerConfig(raw),binding=approveParentProfile(c.profile,c.serverProfileHash,c.localPolicy);
  const storage=composeStorage(c,ports);
  const transport=new NodeBuildTransport({origin:c.origin,credentialRef:c.executorCredentialRef},
    {resolve:async(ref,signal)=>{check(!signal.aborted,'credential-aborted');return ports.credential(ref);}});
  const liveness={...c.liveness,host:binding.approval.host,developerDirs:[]};
  const common={binding,transport,liveness,maxInputBytes:c.maxInputBytes,outputs:c.outputs,resolveResultStorage:storage.resolveResultStorage};
  const controller=c.runtime.kind==='linux'
    ?createLinuxIsolatedBuildWorkerController({...common,isolation:c.runtime.isolation,resolveInputStorage:storage.resolveInputStorage})
    :createMacVmBuildWorkerController({...common,...c.runtime,readInput:storage.readInput});
  let invoked=false;
  return Object.freeze({
    preparation:Object.freeze({state:'prepared-not-activated' as const,kind:c.runtime.kind,jobId:c.job.id,
      expectedEpoch:c.claimPolicy.epoch,serverProfileHash:binding.serverProfileHash,localRecipeHash:binding.localRecipeHash,
      ...(c.runtime.kind==='linux'?{linuxPolicyProposal:linuxIsolationProfile(binding,c.maxInputBytes)}:{})}),
    async run(approvalReceiptSha256:string,signal:AbortSignal){
      check(!invoked,'one-invocation-only');
      check(approvalReceiptSha256===c.activationReceiptSha256&&c.localPolicy.host.allowActivation,'explicit-owner-activation-gated');
      check(!signal.aborted,'cancelled-before-activation');
      check(process.platform===(c.runtime.kind==='linux'?'linux':'darwin')&&
        (c.runtime.kind!=='mac'||process.arch==='arm64'),'host-platform-mismatch');
      check(process.getuid?.()===c.localPolicy.host.uid&&process.getgid?.()===c.localPolicy.host.gid&&
        process.geteuid?.()===c.localPolicy.host.uid&&process.getegid?.()===c.localPolicy.host.gid,'dedicated-host-account-mismatch');
      invoked=true;
      // Controller persists intent, obtains one exact claim, renews only that
      // attempt and waits for trusted stop/staging or quarantine. No forced exit.
      return controller.run(c.job,c.claimKey,signal);
    },
  });
}
