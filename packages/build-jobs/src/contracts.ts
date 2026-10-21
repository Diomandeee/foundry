import type {TransactionPort} from '../../compute-authority/src/durable/contracts';
export type {TransactionPort};
export type BuildKind='linux-build-v1'|'xcode-build-v1';
export interface ObjectRef {projectId:string;objectKey:string;generation:string;sha256:string;sizeBytes:number}
export interface InputApproval {projectId:string;snapshotHash:string;manifest:ObjectRef;git:{remote:string|null;revision:string|null;historyPreserved:boolean};requiredInputs:string[];missingInputs:string[];reconstructable:boolean}
export interface Limits {cpu:number;ramMib:number;estimatedAdditionalBytes:number;timeoutMs:number;maxOutputBytes:number}
export interface XcodeRecipe {projectPath:string;workspace:boolean;scheme:string;configuration:string;sdk:string;destination:string;developerDir:string;xcodeBuild:string;macos:string}
export interface LinuxRecipe {image:string;architecture:'arm64'|'x64';tool:'npm'|'cargo'|'cmake'|'python';args:string[];network:'none'|'approved-dependencies';installArgs?:string[]}
/** Owner-approved recipes are immutable; submitters select hashes rather than commands. */
export interface BuildProfile {version:1;projectId:string;kind:BuildKind;limits:Limits;recipe:XcodeRecipe|LinuxRecipe;outputPaths:string[];trustedProject:true;workerOptInRequired:boolean}
export interface BuildJob {id:string;projectId:string;inputHash:string;profileHash:string;maxAttempts:number}
export interface Census {workerId:string;sequence:number;os:'linux'|'darwin';architecture:'arm64'|'x64';freeBytes:number;availableRamMib:number;xcodeBuilds:string[];sdks:string[];macos:string;optedIn:boolean;activeJobs:number;storage:{cacheBytes:number|null;workspaceBytes:number|null;complete:boolean};vm?:import('./mac-vm-capability').MacVmCapability}
export interface BuildFence {attemptId:string;epoch:number;generation:number;incarnation:number;capability:string}
export interface BuildActor {role:'owner'|'executor'|'submitter'|'verifier';principal:string;expectedEpoch:number;workerId?:string;incarnation?:number;revision?:number}
export interface ArtifactClaim {grantId:string;ref:ObjectRef}
export interface ResultManifest {version:1;jobId:string;attemptId:string;inputHash:string;profileHash:string;exitCode:number;outputs:{path:string;format:'file'|'tar';sha256:string;sizeBytes:number;chunks:ArtifactClaim[]}[];logs:ArtifactClaim[]}
export interface BuildPorts {
 now?:()=>number;
 /** Private issuer secret, host-selected; no capability persists in plaintext. */
 issuerKey:string;
 /** Independently authorized broker reads. Must enforce grant principal/fence/object binding and byte bounds. */
 readArtifact?:(claim:ArtifactClaim,scope:{attemptId:string;workerId:string;projectId:string},signal:AbortSignal)=>Promise<Uint8Array>;
}
export type BuildCommand=
 |{operation:'approveVm';key:string;body:{workerId:string;revision:number;profileHash:string;capability:import('./mac-vm-capability').MacVmCapability;activationEvidenceHash:string}}
 |{operation:'approveInput';key:string;body:InputApproval}
 |{operation:'approveProfile';key:string;body:BuildProfile}
 |{operation:'approveWorker';key:string;body:{workerId:string;revision:number;profileHash:string;preference:number}}
 |{operation:'census';key:string;body:Census}
 |{operation:'submit';key:string;body:BuildJob}
 |{operation:'claim';key:string;body:{jobId:string}}
 |{operation:'renew';key:string;body:BuildFence&{sequence:number}}
 |{operation:'stage';key:string;body:BuildFence&{manifest:ArtifactClaim}}
 |{operation:'stopped';key:string;body:BuildFence&{proofHash:string;confirmed:boolean;outcome:'completed'|'failed'|'cancelled'|'lease-lost'|'timeout'|'quarantined'}}
 |{operation:'cancel';key:string;body:{jobId:string}}
 |{operation:'reconcile';key:string;body:{attemptId:string;proofHash:string}}
 |{operation:'requeue';key:string;body:{jobId:string;expectedGeneration:number}};
