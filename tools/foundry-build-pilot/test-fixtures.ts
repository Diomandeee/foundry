// Synthetic test data ONLY. Never an installed pin, operational config or receipt.
import {approveParentProfile} from '../../packages/build-runtime/src/parent-profile.js';
import {hash,bytesHash} from '../../packages/build-jobs/src/validation.js';
import type {OwnerConfig,NamespaceConfig} from './config.js';
import type {BuildProfile,InputApproval} from '../../packages/build-jobs/src/contracts.js';
export const digest='a'.repeat(64),receipt='b'.repeat(64);
export const inputBytes=Buffer.from('synthetic input metadata for broker boundary testing');
export const input:InputApproval={projectId:'test-project',snapshotHash:bytesHash(inputBytes),
  manifest:{projectId:'test-project',objectKey:`projects/test-project/manifests/${bytesHash(inputBytes)}`,generation:'7',sha256:bytesHash(inputBytes),sizeBytes:inputBytes.length},
  git:{remote:null,revision:null,historyPreserved:true},requiredInputs:[],missingInputs:[],reconstructable:true};
export function fixture(kind:'linux'|'mac'='linux'):OwnerConfig{
  const profile:BuildProfile={version:1,projectId:'test-project',kind:kind==='linux'?'linux-build-v1':'xcode-build-v1',
    trustedProject:true,workerOptInRequired:true,outputPaths:['result.txt'],
    limits:{cpu:2,ramMib:2048,estimatedAdditionalBytes:1048576,timeoutMs:60000,maxOutputBytes:1048576},
    recipe:kind==='linux'?{image:`test/build@sha256:${digest}`,architecture:'arm64',tool:'npm',args:['run','build'],network:'none'}:
      {projectPath:'Test.xcodeproj',workspace:false,scheme:'Test',configuration:'Debug',sdk:'macosx',destination:'generic/platform=macOS',developerDir:'/Applications/Xcode.app/Contents/Developer',xcodeBuild:'TEST1',macos:'26.0'}};
  const localPolicy={host:{uid:process.getuid!(),gid:process.getgid!(),dedicatedBuildUser:true as const,allowActivation:true,
    inputBase:'/test/input',workBase:'/test/work',journalRoot:'/test/journal',...(kind==='linux'?{imageExecutables:{npm:'/usr/bin/npm'}}:{})},
    pids:64,tmpMib:64,minFreeBytes:50*1024**3};
  const binding=approveParentProfile(profile,hash(profile),localPolicy);
  const namespace=(name:string,publication:boolean):NamespaceConfig=>({controlDbPath:`/test/${name}/control.sqlite`,brokerDbPath:`/test/${name}/broker.sqlite`,
    gcs:{origin:'https://storage.googleapis.com',bucket:'test-bucket',projectId:'test-project',credentialRef:'TEST_PROVIDER_REF'},
    approval:{version:1,namespaceRef:name,scope:{projectId:'test-project',principalRef:'test-reader',namespaceRef:name},profileHash:binding.serverProfileHash,
      policyVersion:'test-policy',intentId:'test-intent',authorizationGeneration:1,expiresAt:Date.now()+600000,publication,approvedObjects:publication?[]:[input.manifest]}});
  const seal=(path:string)=>({helper:{path:'/Library/Foundry/bin/mac-tree-guard',sha256:digest},tree:{path,mountPoint:path,filesystem:'apfs' as const,
    fsid:[1,2] as [number,number],mountSource:'/dev/disk7',volumeUuid:'11111111-1111-1111-1111-111111111111',rootDevice:'1',rootInode:'2'},maxOperationMs:60000});
  return {version:1,origin:'https://compute.test',activationReceiptSha256:receipt,
    executorCredentialRef:'TEST_EXECUTOR_REF',accessCredentialRef:'TEST_ACCESS_REF',verifierCredentialRef:'TEST_VERIFIER_REF',ownerPrincipal:'test-owner',
    profile,serverProfileHash:binding.serverProfileHash,localPolicy,
    job:{id:'test-job',projectId:'test-project',inputHash:hash(input),profileHash:binding.serverProfileHash,maxAttempts:1},claimKey:'test-claim',
    claimPolicy:{environment:'test',authorityId:'test-authority',workerId:'test-worker',jobId:'test-job',projectId:'test-project',
      inputHash:hash(input),serverProfileHash:binding.serverProfileHash,localRecipeHash:binding.localRecipeHash,epoch:4,generation:0,incarnation:0},
    liveness:{expectedEpoch:4,approvedIdentity:{workerId:'test-worker',principal:'test-executor',workerClass:'general',cpu:2,ramMib:4096,devices:[]},
      authority:{environment:'test',authorityId:'test-authority',workerId:'test-worker'},revision:1,incarnation:0,initialEnrollmentSequence:0,initialCensusSequence:0,optedIn:true,cacheRoot:'/test/cache'},
    maxInputBytes:1048576,outputs:[{path:'result.txt',classification:'build-output'}],inputNamespaces:[namespace('test-input',false)],resultNamespace:namespace('test-output',true),
    runtime:kind==='linux'?{kind,isolation:{python:'/usr/bin/python3.12',pythonSha256:digest,helper:'/usr/local/libexec/foundry-linux-isolation.py',helperSha256:digest}}:
      {kind,capability:{sha256:digest,seal:seal(`/Library/Foundry/VM/capabilities/${digest}`)},sources:[{snapshotHash:input.snapshotHash,seal:seal('/Library/Foundry/VM/sources/test')}],
        executable:'/Library/Foundry/bin/mac-vm-host',maxBootBytes:1048576,maxOutputDiskBytes:1048576,
        storage:{python:{path:'/Library/Foundry/bin/cas-python',sha256:digest},helper:{path:'/Library/Foundry/bin/mac-cas.py',sha256:digest}}}};
}
