import {createHash} from 'node:crypto';
import {canonical,validateJob,verifyEvidence,type VerificationPorts,type VerificationJob,type HostAttestation} from '../../../packages/library-jobs/src/index';
import type {TransferBinding,LibraryBodies} from '../../../packages/library-catalog/src/index';

/** Content/lease references only. Does not dispatch work or confer catalog write permission. */
export function transferBinding(jobInput:unknown):TransferBinding{
 const job=validateJob(jobInput);
 return {projectId:job.projectId,policyVersion:job.policyVersion,policyHash:job.policyHash,
  compute:{authorityId:job.compute.authorityId,workloadId:job.compute.workloadId,leaseId:job.compute.leaseId,attemptId:job.compute.attemptId,capabilityDigest:job.compute.capabilityDigest,workerId:job.compute.workerId,epoch:job.compute.epoch,generation:job.compute.generation,incarnation:job.compute.incarnation},
  content:{manifestHash:job.manifestRef.sha256,objectKey:job.manifestRef.objectKey,objectGeneration:job.manifestRef.generation,objectHash:job.manifestRef.sha256,bytes:job.manifestRef.sizeBytes}};
}
/**
 * Host-only preparation. The caller must authenticate as this project's verifier to
 * submit the body; no report alone is accepted, and publication remains separate.
 * The catalog's bound object is the manifest; the attestation pins its object set.
 */
export function prepareTransferAttestation(jobInput:unknown,report:unknown,ports:VerificationPorts,intent:{intentId:string;generation:number}):{job:VerificationJob;attestation:HostAttestation;body:LibraryBodies['attestTransfer']} {
 const clean=JSON.parse(canonical(intent)) as {intentId:string;generation:number};
 if(Object.keys(clean).sort().join(',')!=='generation,intentId')throw new Error('invalid transfer identity');
 intent=clean;
 if(typeof intent.intentId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,95}(?![\s\S])/.test(intent.intentId)||!Number.isSafeInteger(intent.generation)||intent.generation<1)throw new Error('invalid transfer identity');
 const job=validateJob(jobInput);
 const attestation=verifyEvidence(job,report,ports);
 const catalogAttestationId=createHash('sha256').update('library-catalog-attestation/v1\n'+canonical({projectId:job.projectId,hostAttestation:attestation.attestationId,intentId:intent.intentId,generation:intent.generation})).digest('hex');
 return {job,attestation,body:{version:1,attestationId:catalogAttestationId,intentId:intent.intentId,generation:intent.generation,attestedAt:attestation.attestedAt,expiresAt:attestation.expiresAt,binding:transferBinding(job),manifestHash:job.manifestRef.sha256,bytes:job.manifestRef.sizeBytes,hostAttestation:attestation.attestationId}};
}
