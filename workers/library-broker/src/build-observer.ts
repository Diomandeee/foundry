import {performance} from 'node:perf_hooks';
import {canonical} from '../../../packages/library-jobs/src/data';
import type {ReadGrant,CurrentAuthorization} from '../../../packages/storage-broker/src/types';
/** Trusted host ports pin compute authority and owner authentication. A network refresh
 * is NOT a substitute for the broker core's synchronous current-authority port. */
export interface BuildObservationPort {
 authorityId:string;
 observe(attemptId:string,signal:AbortSignal):Promise<{ok:boolean;observedAt:number;valid:boolean;resultReadable:boolean;projectId:string;profileHash:string;expiresAt:number;compute:unknown;retainedArtifacts:unknown[]}>;
 /** Actual authoritative local state/mirror with revocation/recovery fencing. It must
  * observe EVERY grant field at call time, not re-label a cached HTTP snapshot as fresh. */
 current(grant:ReadGrant):CurrentAuthorization;
 now():number;
}
/** Does not manufacture grants, cache authorization, reset budgets or erase tombstones.
 * A host unable to provide a real current() MUST NOT activate this broker adapter. */
export function createBuildGrantRefresh(port:BuildObservationPort){
 return {
  async refresh(grant:ReadGrant,signal:AbortSignal){
   if(grant.compute.authorityId!==port.authorityId)throw new Error('build-authority-binding');
   const sent=performance.now(),o=await port.observe(grant.compute.attemptId,signal),elapsed=performance.now()-sent,now=port.now();
   if(signal.aborted||!o.ok||!Number.isSafeInteger(o.observedAt)||elapsed>5000||o.projectId!==grant.projectId||o.profileHash!==grant.policyHash||canonical(o.compute)!==canonical(grant.compute))throw new Error('build-observation-binding');
   const retained=o.resultReadable&&o.retainedArtifacts.some(ref=>canonical(ref)===canonical(grant.object));
   if((!(o.valid&&Number.isSafeInteger(o.expiresAt)&&o.expiresAt-o.observedAt>elapsed)&&!retained)||grant.expiresAt<=now)throw new Error('build-grant-fenced');
  },
  observeCurrent(grant:ReadGrant){
   const before=port.now(),o=port.current(grant),after=port.now();
   if(o.status!=='authorized'||o.revoked!==false||canonical(o.grant)!==canonical(grant)||o.observedAt<before||o.observedAt>after||o.expiresAt<=after||o.expiresAt>grant.expiresAt)throw new Error('fresh-build-observation-required');
   return o;
  },
 };
}
