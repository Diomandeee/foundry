import {createMacReadonlyTreeSeal,type MacReadonlySealConfig} from '../../build-storage/src/mac-readonly-seal.js';
import {validateMacVmCapability,type MacVmCapability} from '../../build-jobs/src/mac-vm-capability.js';
import {readMacVmMetadata} from './mac-vm-tree.js';
import {canonicalData} from './parent-profile.js';
import {check,hash} from './plans.js';
export interface MacVmCapabilityConfig {sha256:string;seal:MacReadonlySealConfig}
/** Owner-pinned, read-only image inventory. No guest is booted for census. The
 * owner's separate acceptance links this descriptor to an actually observed
 * guest and exact boot bytes. This is not remote hardware attestation. */
export async function readMacVmCapability(config:MacVmCapabilityConfig,signal:AbortSignal):Promise<Readonly<MacVmCapability>> {
  const c=JSON.parse(canonicalData(config)) as MacVmCapabilityConfig;
  check(/^[0-9a-f]{64}$/.test(c.sha256)&&c.seal.tree.path===`/Library/Foundry/VM/capabilities/${c.sha256}`,'vm-capability-root');
  const guard=createMacReadonlyTreeSeal(c.seal);
  const result=await guard.withReadonlyTrees([c.seal.tree.path],async()=>{
    const bytes=await readMacVmMetadata(c.seal.tree.path,'capability.json',16384,signal);
    const value=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes)) as MacVmCapability;
    validateMacVmCapability(value);
    check(hash(canonicalData(value))===c.sha256&&value.treeGuardSha256===c.seal.helper.sha256,'vm-capability-pin');
    Object.freeze(value.sdks);return Object.freeze(value);
  },signal);
  check(!signal.aborted,'vm-capability-aborted');return result;
}
