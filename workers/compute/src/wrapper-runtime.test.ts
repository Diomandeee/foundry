import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { localRuntime } from '../test-support/runtime';

it('bundles the production entry and instantiates its SQLite wrapper with fail-closed HTTP', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'foundry-wrapper-'));
  const runtime = await localRuntime(`
    import entry from './workers/compute/src/index.ts';
    import { ComputeAuthority } from './workers/compute/src/authority.ts';
    export class TestFabricAuthority extends ComputeAuthority {
      constructor(ctx, env) { super(ctx, {
        COMPUTE_ENVIRONMENT:'local-wrapper', COMPUTE_ISSUER_ID:'test-issuer',
        COMPUTE_ISSUER_KEY:'fixture-key-not-production-00000000000000000000',
        COMPUTE_ARTIFACTS:env.TEST_ARTIFACTS,
      }); }
      async fetch(request) {
        if(new URL(request.url).pathname !== '/host-test') return super.fetch();
        const input=await request.json();
        return Response.json(input.action==='snapshot'?this.snapshot():input.action==='verify'?await this.verify(input.actor,input.request):this.execute(input.actor,input.command));
      }
    }
    export default { async fetch(request,env) {
      if (new URL(request.url).pathname === '/internal-test' || new URL(request.url).pathname === '/host-test') {
        return env.AUTHORITY.get(env.AUTHORITY.idFromName('fixed-local-authority')).fetch(request);
      }
      return entry.fetch(request,env);
    }};
  `, directory, 'foundry-production-wrapper-test');
  try {
    const actor={principal:'host-owner',role:'owner',expectedEpoch:1};
    const call=async (body:unknown)=>await (await runtime.dispatchFetch('https://local.test/host-test',{method:'POST',body:JSON.stringify(body)})).json() as Record<string,any>;
    let serial=0;
    const command=async(operation:string,body:unknown)=>call({actor:{...actor,role:['claim','stageResult'].includes(operation)?'executor':actor.role},command:{operation,body,key:`host-${++serial}`}});
    expect((await command('setQuota',{principal:actor.principal,maxActive:2,allowedClass:'general'})).ok).toBe(true);
    expect((await command('registerWorker',{workerId:'worker',principal:actor.principal,workerClass:'general',cpu:2,ramMib:1024,devices:[]})).ok).toBe(true);
    const sha256='0'.repeat(64);
    expect((await command('submit',{workloadId:'job',specification:'fixed-cpu-v1',resources:{cpu:1,ramMib:64},policy:{sha256,maxBytes:100,exitCode:0},pure:true,reconstructible:true,maxAttempts:2})).ok).toBe(true);
    const grant=await command('claim',{workloadId:'job',workerId:'worker',expectedGeneration:0,incarnation:0,ttlMs:10000});
    expect(grant.ok).toBe(true);const l=grant.lease;
    expect((await command('stageResult',{leaseId:l.id,epoch:l.epoch,generation:l.generation,incarnation:l.incarnation,capability:l.capability,artifactRef:'untrusted-pointer',sha256,bytes:1,exitCode:0})).ok).toBe(true);
    const verification=await call({action:'verify',actor:{...actor,role:'verifier'},request:{key:'verify',leaseId:l.id,epoch:l.epoch,generation:l.generation,incarnation:l.incarnation}});
    expect(verification.code).toBe('artifact-unavailable');
    expect((await call({action:'snapshot'})).receipts).toHaveLength(0);
    for (const path of ['/submit','/internal-test']) {
      const response = await runtime.dispatchFetch('https://local.test'+path, {method:'POST',body:'{}'});
      expect(response.status).toBe(503);
      expect(await response.text()).toBe('Compute transport is not enabled');
    }
  } finally { await runtime.dispose(); await rm(directory,{recursive:true,force:true}); }
});
