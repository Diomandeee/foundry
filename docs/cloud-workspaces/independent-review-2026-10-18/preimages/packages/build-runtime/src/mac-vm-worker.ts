import {BuildWorkerController,snapshotWorkerAuthority} from './controller.js';
import {MacVmRuntimeAdapter,type MacVmAdapterConfig} from './mac-vm-adapter.js';
import {NodeWorkerLiveness,type NodeLivenessConfig} from './liveness.js';
import {NodeBuildTransport} from './node-transport.js';
import {canonicalData} from './parent-profile.js';
import {check} from './plans.js';
export interface MacVmWorkerConfig extends MacVmAdapterConfig {
  transport:NodeBuildTransport;
  liveness:Omit<NodeLivenessConfig,'vm'>;
  maxInputBytes:number;
}
/** Complete inert production composition. The caller supplies actual enrolled
 * HTTPS transport and post-claim scoped storage resolvers. Explicit run/poll is
 * separately gated. No timer, discovery, service, installation or network here. */
export function createMacVmBuildWorkerController(config:MacVmWorkerConfig):BuildWorkerController {
  const authority=snapshotWorkerAuthority(config.liveness.authority);
  check(config.transport instanceof NodeBuildTransport,'vm-authenticated-node-transport-required');
  check(canonicalData(config.liveness.host)===canonicalData(config.binding.approval.host),'vm-liveness-host-binding');
  check(Number.isSafeInteger(config.maxInputBytes)&&config.maxInputBytes>0&&config.maxInputBytes<=2*1024**3,'vm-input-limit');
  // Both census and physical preparation use the exact same owner-pinned image.
  const liveness=new NodeWorkerLiveness({...config.liveness,developerDirs:[],vm:config.capability},config.transport);
  const adapter=new MacVmRuntimeAdapter(config);
  return new BuildWorkerController(config.binding,config.liveness.expectedEpoch,
    {transport:config.transport,liveness},adapter,config.maxInputBytes,authority);
}
