import {BuildWorkerController,snapshotWorkerAuthority} from './controller.js';
import {LinuxIsolatedRuntimeAdapter,type LinuxIsolatedAdapterConfig} from './linux-isolated-adapter.js';
import {NodeWorkerLiveness,type NodeLivenessConfig} from './liveness.js';
import {NodeBuildTransport} from './node-transport.js';
import {canonicalData} from './parent-profile.js';
import {check} from './plans.js';
export interface LinuxIsolatedWorkerConfig extends LinuxIsolatedAdapterConfig {
  transport:NodeBuildTransport;liveness:Omit<NodeLivenessConfig,'vm'|'linuxIsolation'>;
}
/** Inert composition. Real enrolled HTTPS transport and real post-claim broker
 * readers/writers are required. No installation, daemon start or activation. */
export function createLinuxIsolatedBuildWorkerController(c:LinuxIsolatedWorkerConfig):BuildWorkerController{
  check(c.transport instanceof NodeBuildTransport,'linux-authenticated-node-transport');
  check(canonicalData(c.liveness.host)===canonicalData(c.binding.approval.host),'linux-liveness-host-binding');
  const authority=snapshotWorkerAuthority(c.liveness.authority);
  const adapter=new LinuxIsolatedRuntimeAdapter(c);
  const liveness=new NodeWorkerLiveness({...c.liveness,developerDirs:[],linuxIsolation:{profileHash:c.binding.localRecipeHash,
    helperSha256:c.isolation.helperSha256,pythonSha256:c.isolation.pythonSha256}},c.transport);
  return new BuildWorkerController(c.binding,c.liveness.expectedEpoch,{transport:c.transport,liveness},adapter,c.maxInputBytes,authority);
}
