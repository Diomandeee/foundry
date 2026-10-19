import {describe,it,expect,vi,afterEach} from 'vitest';
import {parseOwnerConfig} from './config.js';
import {prepareHost} from './host.js';
import {parseArgs,main} from './cli.js';
import {fixture,receipt} from './test-fixtures.js';
import type {StorageBoundaries} from './storage.js';
import {BuildWorkerController} from '../../packages/build-runtime/src/controller.js';
import {createMacIsolatedContentStore,assertMacIsolatedStore} from '../../packages/build-storage/src/mac-isolated-store.js';
const noIO=()=>{throw new Error('unexpected IO');};
const ports:StorageBoundaries={openDatabase:vi.fn(noIO),credential:vi.fn(noIO),fetch:vi.fn(noIO),providerFetch:vi.fn(noIO)};
afterEach(()=>vi.restoreAllMocks());
describe('bounded owner configuration and inert composition',()=>{
  it.each(['linux','mac'] as const)('constructs actual %s factory with no IO',kind=>{
    const network=vi.spyOn(globalThis,'fetch').mockImplementation(noIO);
    const c=fixture(kind),host=prepareHost(c,ports);
    expect(host.preparation.state).toBe('prepared-not-activated');
    expect(network).not.toHaveBeenCalled();for(const fn of Object.values(ports))expect(fn).not.toHaveBeenCalled();
    if(c.runtime.kind==='mac')assertMacIsolatedStore(createMacIsolatedContentStore(c.runtime.storage));
  });
  it.each([
    (c:any)=>{delete c.runtime.isolation.helperSha256;},
    (c:any)=>{c.module='/arbitrary/module.ts';},
    (c:any)=>{c.executorCredentialRef='secret-token-value';},
    (c:any)=>{c.verifierCredentialRef=c.executorCredentialRef;},
    (c:any)=>{c.claimPolicy.generation=-1;},
    (c:any)=>{c.claimPolicy.localRecipeHash='f'.repeat(64);},
    (c:any)=>{c.resultNamespace.controlDbPath=c.inputNamespaces[0].controlDbPath;},
    (c:any)=>{c.inputNamespaces[0].approval.scope.compute={};},
    (c:any)=>{c.resultNamespace.approval.approvedObjects=[c.inputNamespaces[0].approval.approvedObjects[0]];},
    (c:any)=>{c.liveness.initialCensusSequence=undefined;},
    (c:any)=>{c.origin='https://compute.test/other';},
  ])('rejects incomplete or widened config before IO',mutate=>{
    const c=fixture();mutate(c);expect(()=>prepareHost(c,ports)).toThrow();
  });
  it('snapshots owner policy rather than retaining mutable caller data',()=>{
    const c=fixture(),parsed=parseOwnerConfig(c);c.job.id='changed';expect(parsed.job.id).toBe('test-job');expect(Object.isFrozen(parsed.job)).toBe(true);
  });
  it('does not accept flags in place of the owner activation gate',async()=>{
    const c=fixture('mac');c.localPolicy.host.allowActivation=false;
    const run=vi.spyOn(BuildWorkerController.prototype,'run');
    await expect(prepareHost(c,ports).run(receipt,new AbortController().signal)).rejects.toThrow('gated');expect(run).not.toHaveBeenCalled();
  });
  it('fails closed for mismatched receipt and pre-cancellation',async()=>{
    const c=fixture(),host=prepareHost(c,ports),cancel=new AbortController();
    await expect(host.run('c'.repeat(64),cancel.signal)).rejects.toThrow('gated');cancel.abort();
    await expect(host.run(receipt,cancel.signal)).rejects.toThrow('cancelled');
  });
  it('accepts only explicit commands, config file and receipt flag',()=>{
    expect(parseArgs(['run','--config','/private/owner.json','--approval-receipt-sha256',receipt]).command).toBe('run');
    for(const args of [[],['run','--config','/x'],['prepare','--config','/x','--browser','x'],['run','--module','/x'],['prepare','--config','relative']])expect(()=>parseArgs(args)).toThrow();
  });
  it('waits for controller settlement after cancellation and admits only one invocation',async()=>{
    const c=fixture(process.platform==='darwin'?'mac':'linux'),host=prepareHost(c,ports);
    let finish!:(value:{state:'owner-reconciliation-required'})=>void;
    const run=vi.spyOn(BuildWorkerController.prototype,'run').mockImplementation(async(_job,_key,signal)=>{
      expect(signal).toBeDefined();return new Promise(resolve=>{finish=resolve;});
    });
    const abort=new AbortController();const pending=host.run(receipt,abort.signal);abort.abort();
    let settled=false;void pending.then(()=>{settled=true;});await Promise.resolve();expect(settled).toBe(false);
    finish({state:'owner-reconciliation-required'});await expect(pending).resolves.toEqual({state:'owner-reconciliation-required'});
    await expect(host.run(receipt,new AbortController().signal)).rejects.toThrow('one-invocation');expect(run).toHaveBeenCalledTimes(1);
  });
  it('removes CLI signal handlers after invalid config, without exposing details',async()=>{
    const before=[process.listenerCount('SIGINT'),process.listenerCount('SIGTERM')];
    const stderr=vi.spyOn(process.stderr,'write').mockReturnValue(true);
    expect(await main(['invalid'])).toBe(2);expect(stderr.mock.calls[0]![0]).toMatch('build-pilot-unconfirmed');
    expect([process.listenerCount('SIGINT'),process.listenerCount('SIGTERM')]).toEqual(before);
  });
});
