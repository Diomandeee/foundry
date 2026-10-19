import * as v from '../../build-jobs/src/validation';
import {alive, boundedBytes, canonical, check, exactRef, freeze, sha256, snapshot} from './checks';
import type {ArtifactClaim, GrantScope, ObjectRef, PackagingPorts, PublicationReservation, ReadGrant, TrustedGrantIssuer} from './types';

export async function reserve(scope:GrantScope,artifacts:number,bytes:number,ports:Pick<PackagingPorts,'capacity'>,signal:AbortSignal,operationKey?:string):Promise<PublicationReservation> {
  alive(signal); v.uint(artifacts,1,129); v.uint(bytes,1,129*1048576);
  if(operationKey!==undefined) v.digest(operationKey);
  try {
    const need={projectId:scope.projectId,namespaceRef:scope.namespaceRef,artifacts,bytes};
    const receipt=snapshot(await ports.capacity.reserve(need,signal,operationKey)) as PublicationReservation;
    v.exact(receipt,['projectId','namespaceRef','artifacts','bytes','reservationId']); v.id(receipt.reservationId);
    check(receipt.projectId===need.projectId&&receipt.namespaceRef===need.namespaceRef&&receipt.artifacts===artifacts&&receipt.bytes===bytes,'publication-reservation-binding');
    alive(signal); await ports.capacity.assertCurrent(receipt,signal); alive(signal); return freeze(receipt);
  } catch {throw new Error('build-storage: approved-durable-namespace-capacity-required');}
}
export async function current(ports:Pick<PackagingPorts,'capacity'>,reservation:PublicationReservation,signal:AbortSignal) {
  alive(signal);
  try {await ports.capacity.assertCurrent(reservation,signal);} catch {throw new Error('build-storage: publication-reservation-not-current');}
  alive(signal);
}
/** Only the actual issuance receipt supplies grantId. No deterministic IDs or stand-ins. */
export async function publish(bytes:Uint8Array,kind:'objects'|'manifests',scope:GrantScope,
  reservation:PublicationReservation,ports:Pick<PackagingPorts,'writer'|'issuer'|'capacity'>,signal:AbortSignal):Promise<ArtifactClaim> {
  const expected=boundedBytes(bytes,1048576), digest=sha256(expected);
  try {
    await current(ports,reservation,signal);
    const ref=exactRef(await ports.writer.write(scope.projectId,kind,expected,signal,reservation),scope.projectId,kind);
    check(ref.sha256===digest&&ref.sizeBytes===expected.length,'writer-receipt-bytes');
    await current(ports,reservation,signal);
    const {claim}=await issueCurrent(ref,scope,ports.issuer,signal,reservation);
    await current(ports,reservation,signal); return claim;
  } catch {throw new Error('build-storage: publication-or-current-grant-unconfirmed-evidence-retained');}
}
export async function issueCurrent(ref:ObjectRef,scope:GrantScope,issuer:TrustedGrantIssuer,signal:AbortSignal,reservation?:PublicationReservation):Promise<{claim:ArtifactClaim;grant:ReadGrant}> {
  alive(signal);
  try {
    const grant=freeze(snapshot(await issuer.issue(ref,scope,signal,reservation)) as ReadGrant);
    v.exact(grant,['version','grantId','principalRef','projectId','policyVersion','policyHash','intentId','authorizationGeneration','compute','operation','object','byteBudget','expiresAt']);
    check(grant.version===1&&grant.operation==='GET'&&grant.principalRef===scope.principalRef&&grant.projectId===scope.projectId,'grant-scope');
    for(const id of [grant.grantId,grant.policyVersion,grant.intentId]) v.id(id);
    v.digest(grant.policyHash); v.uint(grant.authorizationGeneration,1); v.uint(grant.byteBudget,ref.sizeBytes); v.uint(grant.expiresAt);
    check(canonical(grant.object)===canonical(ref)&&canonical(grant.compute)===canonical(scope.compute),'grant-object-fence');
    await observeGrant(grant,issuer,signal);
    const claim={grantId:grant.grantId,ref}; v.claim(claim); return freeze({grant,claim});
  } catch {throw new Error('build-storage: current-read-grant-unconfirmed');}
}
export async function observeGrant(grant:ReadGrant,issuer:TrustedGrantIssuer,signal:AbortSignal):Promise<void> {
  alive(signal);
  try {
    const before=issuer.now(); v.uint(before);
    const observation=snapshot(await issuer.observeCurrent(grant,signal)) as {grant:ReadGrant;status:string;revoked:boolean;observedAt:number;expiresAt:number};
    const after=issuer.now(); v.uint(after); check(after>=before,'issuer-clock');
    v.exact(observation,['grant','status','revoked','observedAt','expiresAt']); v.uint(observation.observedAt); v.uint(observation.expiresAt);
    check(observation.status==='authorized'&&observation.revoked===false&&canonical(observation.grant)===canonical(grant)&&
      observation.observedAt>=before&&observation.observedAt<=after&&observation.expiresAt>after&&observation.expiresAt<=grant.expiresAt,'grant-current-receipt');
    alive(signal);
  } catch {throw new Error('build-storage: current-read-grant-unconfirmed');}
}
