import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { canonical } from '../../library-jobs/src/data';
import { afterEach, vi } from 'vitest';
import { checkpointStore, type CheckpointScope } from './index';
import { RevocationRelay } from '../../library-revocation/src/index';
import type { FencePage, TransactionPort, TransferBinding } from '../../library-revocation/src/types';
import type { RecoveryChallenge } from '../../../workers/library/src/recovery-guard';
import type { FenceObservation } from './reconcile';

export const H = 'a'.repeat(64), OTHER = 'b'.repeat(64);
export const scope: CheckpointScope = { environment: 'test', authorityId: 'checkpoint', catalogAuthorityId: 'catalog', sourceAuthorityId: 'compute', relayAuthorityId: 'relay', projectId: 'project', policyVersion: 'p1', policyHash: H, ownerPrincipal: 'owner' };
export const owner = { environment: 'test', principal: 'owner', role: 'owner' as const };
export const dispatcher = { environment: 'test', principal: 'dispatcher', role: 'dispatcher' as const };
const cleanup: (() => void)[] = [];
afterEach(() => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) close(); });
export function sqlite() {
  const db = new DatabaseSync(':memory:'); cleanup.push(() => db.close());
  let failure: string | undefined;let depth=0;
  const port: TransactionPort = {
    sql: { exec(q, ...bindings) { if (failure && q.startsWith(failure)) { failure = undefined; throw new Error('injected SQLite failure'); } return db.prepare(q).all(...bindings) as Record<string, unknown>[]; } },
    transactionSync(fn) { if(depth)return fn();db.exec('BEGIN IMMEDIATE');depth++; try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; }finally{depth--;} },
  };
  return { db, port, fail: (prefix: string) => { failure = prefix; } };
}
export function command(key = 'approve', expectedRevision = 0, archiveSha256: string | null = H) { return { key, expectedRevision, archiveSha256, reason: 'owner decision' }; }
export function binding(): TransferBinding {
  return { projectId: 'project', policyVersion: 'p1', policyHash: H,
    compute: { authorityId: 'compute', workloadId: 'work', leaseId: 'lease', attemptId: 'attempt', capabilityDigest: H, workerId: 'worker', epoch: 1, generation: 1, incarnation: 1 },
    content: { manifestHash: H, objectHash: H, objectKey: `projects/project/objects/${H}`, objectGeneration: '1', bytes: 100 } };
}
export function targetId(intentId = 'intent', generation = 1, restoreId = 'restore') { return createHash('sha256').update(canonical({ domain: 'library-recovery-target/v1', restoreId, authorityId: scope.catalogAuthorityId, intentId, generation })).digest('hex'); }
export function challenge(): RecoveryChallenge { return { restoreId: 'restore', archiveSha256: H, checks: [{ intentId: 'intent', generation: 1, targetId: targetId(), binding: binding() }] }; }
export function page(after = 0, overrides: Partial<FencePage> = {}): FencePage { return { version: 1, environment: 'test', authorityId: 'compute', epoch: 1, after, through: after, head: after, events: [], ...overrides }; }
export function observation(overrides: Partial<FenceObservation> = {}): FenceObservation { return { version: 1, environment: 'test', authorityId: 'compute', epoch: 1, head: 0, observedAt: 100, binding: binding().compute, current: true, accepted: false, state: 'RUNNING', expiresAt: 10000, ...overrides }; }
export function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
export function setup(approve = true) {
  const checkpointDb = sqlite(), relayDb = sqlite(); let clock = 100;
  const now = () => clock;
  const store = checkpointStore(checkpointDb.port, scope, now);
  if (approve) store.admin.execute(owner, command());
  const reopenRelay = () => new RevocationRelay(relayDb.port, { environment: 'test', authorityId: 'relay', sourceAuthorityId: 'compute', ownerPrincipal: 'owner', dispatcherPrincipal: 'dispatcher', now });
  const relay = reopenRelay();
  const source = { readPage: vi.fn(async (after: number, _signal: AbortSignal) => page(after)), observe: vi.fn(async (_binding: TransferBinding['compute'], _signal: AbortSignal): Promise<unknown> => observation({ observedAt: clock })) };
  const ports = { checkpoint: store.recovery, relay, owner, dispatcher, source, now };
  return { checkpointDb, relayDb, store, relay, reopenRelay, source, ports, now, time: (value: number) => { clock = value; } };
}
