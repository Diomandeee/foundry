import {describe,it,expect} from 'vitest';
import {fixture} from '../../../packages/library-jobs/src/fixtures';
import {buildVerificationJob,buildWorkerReport,policyDigest,type VerificationPorts} from '../../../packages/library-jobs/src/index';
import {prepareTransferAttestation,transferBinding} from './evidence';
import {withLibrary} from '../test-support/client';
function journey(){
 const f=fixture(),now=1000000;
 const policy={...f.host.policy,policyVersion:'v1'};
 const host={...f.host,principalRef:'writer',policy};
 const job=buildVerificationJob({...f.body,policyVersion:'v1',policyHash:policyDigest(policy)},host);
 const report=buildWorkerReport(job);
 const ports:VerificationPorts={...f.ports,host,now:()=>now,observeAcceptance:expected=>({...expected,status:'accepted',revoked:false,observedAt:now,acceptedAt:now-100,expiresAt:now+1000})};
 return {...f,job,report,ports};
}
describe('Library job evidence to project catalog bridge',()=>{
 it('verifies immutable fixture bytes/current acceptance before authenticated catalog publication',()=>withLibrary(async h=>{
  const f=journey(),bound=transferBinding(f.job);
  expect(bound.content.objectKey).toContain('/manifests/');expect(bound.compute.capabilityDigest).toBe(f.job.compute.capabilityDigest);
  expect((await h.command('stageTransfer',{version:1,intentId:'bridge-transfer',binding:bound,expiresAt:1100000},'writer')).status).toBe(200);
  const verified=prepareTransferAttestation(f.job,f.report,f.ports,{intentId:'bridge-transfer',generation:1});
  expect(verified.attestation.publicationAuthorized).toBe(false);
  expect(verified.attestation.verifiedBytes).toBe(f.manifestRef.sizeBytes+9);
  expect((await h.command('attestTransfer',verified.body,'writer')).status).toBe(403);
  expect((await h.command('attestTransfer',verified.body,'verifier')).status).toBe(200);
  const publish={version:1,snapshotId:'bridge-snapshot',intentId:'bridge-transfer',generation:1,attestationId:verified.body.attestationId,provenance:{source:'fixture-verifier',parentSnapshotId:null}};
  const published=await h.command('publishSnapshot',publish,'writer','bridge-publish');expect(published.status).toBe(200);
  const state=(await h.snapshot()).body;
  expect(state.records.filter((r:any)=>r.kind==='snapshot')).toHaveLength(1);expect(state.canonicalRevision).toBe(0);
  // A second host verification runs after publication; a separate authenticated role records it.
  const independent=prepareTransferAttestation(f.job,f.report,f.ports,{intentId:'bridge-transfer',generation:1});
  expect(f.reads).toHaveLength(6);
  expect((await h.command('recordVerification',{version:1,verificationId:'bridge-verification',snapshotId:'bridge-snapshot',hostAttestation:independent.attestation.attestationId},'verifier')).status).toBe(200);
  for(const candidateId of ['bridge-winner','bridge-loser'])expect((await h.command('createCandidate',{version:1,candidateId,snapshotId:'bridge-snapshot',verificationId:'bridge-verification',expectedCanonicalRevision:0},'writer')).status).toBe(200);
  const promotion={version:1,candidateId:'bridge-winner',expectedCanonicalRevision:0},loser={...promotion,candidateId:'bridge-loser'};
  const winner=await h.command('promoteCandidate',promotion,'owner','bridge-promotion'),lost=await h.command('promoteCandidate',loser,'owner','bridge-losing-cas');
  expect(winner.status).toBe(200);expect(lost.status).toBe(409);
  await h.command('cancelTransfer',{version:1,intentId:'bridge-transfer',reason:'after-publication'},'owner');await h.request('/__test/clock',{now:1200000});
  expect(await h.command('publishSnapshot',publish,'writer','bridge-publish')).toEqual(published);
  expect(await h.command('promoteCandidate',promotion,'owner','bridge-promotion')).toEqual(winner);
  const before=await h.snapshot();expect(before.body.canonicalSnapshotId).toBe('bridge-snapshot');
  await h.restart();expect(await h.snapshot()).toEqual(before);
  expect(await h.command('publishSnapshot',publish,'writer','bridge-publish')).toEqual(published);
  expect(await h.command('promoteCandidate',promotion,'owner','bridge-promotion')).toEqual(winner);
  expect(await h.command('promoteCandidate',loser,'owner','bridge-losing-cas')).toEqual(lost);
 }));
 it('rejects wrong accepted attempt and corrupt bytes before producing an attestation',()=>{
  const f=journey();
  expect(()=>prepareTransferAttestation(f.job,f.report,{...f.ports,observeAcceptance:expected=>({...expected,status:'accepted',revoked:true,observedAt:1000000,acceptedAt:999900,expiresAt:1001000})},{intentId:'intent',generation:1})).toThrow();
  expect(()=>prepareTransferAttestation(f.job,f.report,{...f.ports,readObject:ref=>({ref,bytes:new Uint8Array(ref.sizeBytes)})},{intentId:'intent',generation:1})).toThrow();
 });
 it('cannot attach valid evidence from a different attempt to an existing intent',()=>withLibrary(async h=>{
  const f=journey(),bound=transferBinding(f.job);
  expect((await h.command('stageTransfer',{version:1,intentId:'other-attempt',binding:{...bound,compute:{...bound.compute,attemptId:'different'}},expiresAt:1100000},'writer')).status).toBe(200);
  const verified=prepareTransferAttestation(f.job,f.report,f.ports,{intentId:'other-attempt',generation:1});
  expect((await h.command('attestTransfer',verified.body,'verifier')).status).toBe(409);
  expect((await h.snapshot()).body.records.filter((r:any)=>r.kind==='transferAttestation')).toHaveLength(0);
 }));
 it('fences publication at accepted compute expiry even when transfer grant lasts longer',()=>withLibrary(async h=>{
  const f=journey(),bound=transferBinding(f.job);
  await h.command('stageTransfer',{version:1,intentId:'short-acceptance',binding:bound,expiresAt:1100000},'writer');
  const verified=prepareTransferAttestation(f.job,f.report,f.ports,{intentId:'short-acceptance',generation:1});
  expect((await h.command('attestTransfer',verified.body,'verifier')).status).toBe(200);
  await h.request('/__test/clock',{now:1001000});
  expect((await h.command('publishSnapshot',{version:1,snapshotId:'expired-acceptance',intentId:'short-acceptance',generation:1,attestationId:verified.body.attestationId,provenance:{source:'fixture',parentSnapshotId:null}},'writer')).status).toBe(409);
 }));
});


describe('catalog attestation identities',()=>{
 it('scopes identical host evidence to each distinct transfer intent',()=>withLibrary(async h=>{
  const f=journey(),bound=transferBinding(f.job),prepared=[];
  for(const intentId of ['same-proof-a','same-proof-b']){
   expect((await h.command('stageTransfer',{version:1,intentId,binding:bound,expiresAt:1100000},'writer')).status).toBe(200);
   const result=prepareTransferAttestation(f.job,f.report,f.ports,{intentId,generation:1});prepared.push(result);
   expect((await h.command('attestTransfer',result.body,'verifier')).status).toBe(200);
  }
  expect(prepared[0].attestation.attestationId).toBe(prepared[1].attestation.attestationId);
  expect(prepared[0].body.attestationId).not.toBe(prepared[1].body.attestationId);
 }));
 it('scopes repeated host evidence to each new local authorization generation',()=>withLibrary(async h=>{
  const f=journey(),bound=transferBinding(f.job),intentId='new-local-generation';
  await h.command('stageTransfer',{version:1,intentId,binding:bound,expiresAt:1100000},'writer');
  const first=prepareTransferAttestation(f.job,f.report,f.ports,{intentId,generation:1});
  expect((await h.command('attestTransfer',first.body,'verifier')).status).toBe(200);
  expect((await h.command('authorizeTransfer',{version:1,intentId,expectedGeneration:1,binding:bound,expiresAt:1100000},'owner')).status).toBe(200);
  const next=prepareTransferAttestation(f.job,f.report,f.ports,{intentId,generation:2});
  expect(first.attestation.attestationId).toBe(next.attestation.attestationId);
  expect(first.body.attestationId).not.toBe(next.body.attestationId);
  expect((await h.command('attestTransfer',next.body,'verifier')).status).toBe(200);
 }));
});
