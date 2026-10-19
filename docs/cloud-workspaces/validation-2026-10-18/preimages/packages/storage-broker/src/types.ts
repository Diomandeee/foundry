import type { DatabaseSync } from 'node:sqlite';
import type { ComputeBinding, ObjectRef } from '../../library-jobs/src/types';
export type { ComputeBinding, ObjectRef } from '../../library-jobs/src/types';

/** Issued only by a trusted role after current project/compute/catalog authorization. */
export interface ReadGrant {
  readonly version: 1;
  readonly grantId: string;
  readonly principalRef: string;
  readonly projectId: string;
  readonly policyVersion: string;
  readonly policyHash: string;
  readonly intentId: string;
  readonly authorizationGeneration: number;
  readonly compute: ComputeBinding;
  readonly operation: 'GET';
  readonly object: ObjectRef;
  readonly byteBudget: number;
  readonly expiresAt: number;
}
/** CURRENT host observation, not an acceptance or context supplied by a worker. */
export interface CurrentAuthorization {
  readonly grant: ReadGrant;
  readonly status: 'authorized';
  readonly revoked: false;
  readonly observedAt: number;
  /** Minimum of current grant, policy, catalog authorization and compute lease expiry. */
  readonly expiresAt: number;
}
export interface ReadRequest { readonly grantId: string; readonly requestId: string }
export type GrantRevocationBinding = Pick<ReadGrant, 'projectId' | 'authorizationGeneration' | 'compute' | 'policyHash'>;
export interface RevokeGrantCommand {
  readonly key: string;
  readonly grantId: string;
  readonly expectedBinding: GrantRevocationBinding;
  readonly evidenceId: string;
  readonly reason: string;
}
export interface RevocationReceipt {
  readonly status: 'revoked' | 'already-revoked' | 'superseded';
  readonly key: string;
  readonly grantId: string;
  readonly evidenceId: string;
}
export interface Limits {
  readonly maxGrants: number;
  readonly maxReads: number;
  readonly maxStoredBytes: number;
  readonly maxReadBytes: number;
  readonly maxActiveReads: number;
  readonly maxAdmittedCalls: number;
  readonly timeoutMs: number;
  readonly maxGrantLifetimeMs: number;
  readonly maxPreemptiveRevocations: number;
  readonly maxRevocationCommands: number;
}
export interface BrokerPorts {
  readonly db: DatabaseSync;
  /** Stable environment + authority identity; persisted together with limits. */
  readonly binding: { readonly environment: string; readonly authorityId: string };
  readonly limits?: Partial<Limits>;
  now(): number;
  /** Synchronous, fresh authoritative observation of EVERY field and current authorization. */
  observeCurrent(expected: ReadGrant): unknown;
  /** Must bound allocation/transport before receiving bytes; no URL/session returned. */
  readObject(ref: ObjectRef, maxBytes: number, signal: AbortSignal): Promise<{ ref: ObjectRef; bytes: Uint8Array }>;
}
/** Explicit distributed mode. Local policy/tombstones remain synchronous; compute
 * authorization is checked online at each asynchronous read boundary. A remote
 * response is never represented as a synchronous CurrentAuthorization mirror. */
export interface OnlineBrokerPorts extends Omit<BrokerPorts,'observeCurrent'> {
  readonly namespaceId:string;
  observeLocal(expected: ReadGrant): unknown;
  authorizeRemote(expected: ReadGrant, signal: AbortSignal): Promise<void>;
}
export interface OnlineBroker extends Omit<Broker,'admin'|'reader'> {
  readonly reader:{read(principal:string,request:unknown,signal:AbortSignal):Promise<Uint8Array>};
  readonly admin: {
    issue(grant: unknown,signal:AbortSignal): Promise<ReadGrant>;
    revokeGrant(command: RevokeGrantCommand): RevocationReceipt;
  };
}
export interface Broker {
  /** Keep this object out of worker reach. Authentication/role routing is the host's responsibility. */
  readonly admin: {
    issue(grant: unknown): ReadGrant;
    /** Preemptive unknown-ID revocation is supported in a separately bounded safety pool. */
    revokeGrant(command: RevokeGrantCommand): RevocationReceipt;
  };
  readonly reader: {
    /** principalRef MUST come from host authentication, never from body/header claims alone. */
    read(authenticatedPrincipalRef: string, request: unknown): Promise<Uint8Array>;
  };
}
