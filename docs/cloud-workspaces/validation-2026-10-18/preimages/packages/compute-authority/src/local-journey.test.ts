import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ComputeAuthority } from './authority.js';
import { execBounded, REFERENCE_EXECUTION } from './executor.js';
import { WorkerRegistry } from './registry.js';
import { place } from './placer.js';
import { snapshotFor } from './dashboard.js';

describe('local disposable CPU reference journey (not a remote pilot)',()=>{
 it('submits, explains placement, leases, executes, stages actual bytes, verifies and audits once',async()=>{
  const staged=new Map<string,Uint8Array>();
  const expected=Buffer.from('499500\n');
  const expectedHash=createHash('sha256').update(expected).digest('hex');
  const auth=new ComputeAuthority(Date.now,60000,{readArtifact:ref=>staged.get(ref)??null});
  const registry=new WorkerRegistry();
  const worker=registry.register({workerId:'local-worker',displayName:'Disposable local worker',workerClass:'general',capabilities:{arch:'arm64',os:'darwin',logicalCores:1,reservableCores:1,totalMib:256,reservableMib:128,gpus:[],runtimes:['node'],maxParallelAttempts:1}});
  auth.registerWorker(worker.workerId,1,worker.workerClass,{cpuCores:1,ramMib:128,gpus:[]});
  const spec={workloadId:'cpu-demo',kind:'cpu-job' as const,reconstructible:true,requires:{runtimes:['node'],minRamMib:64}};
  const placement=place(registry.list(),spec,{}, {policyVersion:'reference-v1',reservations:[]});
  expect(placement.workerId).toBe(worker.workerId);expect(placement.reasonCodes).toContain('compatible');
  auth.submitWorkload(spec.workloadId,1,'retry-new-attempt',1,{kind:'cpu-job',exitCode:0,stdoutSha256:expectedHash},{cpuCores:1,ramMib:64});
  const lease=auth.claim(worker.workerId,spec.workloadId,0,'local-attempt')!;
  const executed=await execBounded({leaseId:lease.leaseId,...REFERENCE_EXECUTION,timeoutMs:5000}, {
    executablePath:realpathSync(process.execPath),managedCwd:realpathSync(process.cwd()),
    authorize:req=>req.leaseId===lease.leaseId&&auth.renew(lease.leaseId,lease.capability),
    stageStdout:bytes=>{const ref=createHash('sha256').update(bytes).digest('hex');staged.set(ref,Uint8Array.from(bytes));return ref;},
  });
  expect(executed.outcome).toBe('exited');expect(staged.get(executed.artifactRef!)).toEqual(Uint8Array.from(expected));
  expect(auth.complete(lease.leaseId,lease.capability,executed)).toEqual({accepted:true,reason:'committed'});
  expect(auth.complete(lease.leaseId,lease.capability,executed)).toEqual({accepted:true,reason:'committed'});
  expect(auth.getCompletion(spec.workloadId)?.artifactSha256).toBe(expectedHash);
  expect(auth.audit.all().filter(e=>e.kind==='result-committed')).toHaveLength(1);
  const snapshot=snapshotFor(auth,registry);expect(snapshot.liveLeases).toHaveLength(0);
  expect(snapshot.watermark.pendingOutbox).toBe(auth.audit.pendingOutbox);
  expect(JSON.stringify(snapshot)).not.toContain(lease.capability);
 });
});
