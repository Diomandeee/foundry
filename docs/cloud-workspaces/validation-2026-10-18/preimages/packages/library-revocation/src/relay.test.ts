import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { canonical } from '../../library-jobs/src/data';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RevocationRelay, type Delivery, type DeliveryReceipt, type FenceEvent, type FencePage, type RevocationContext, type RevocationOptions, type RevocationTarget, type TransactionPort, type TransferBinding } from './index';

const H = 'a'.repeat(64);
const options: RevocationOptions = { environment: 'test', authorityId: 'relay', sourceAuthorityId: 'compute', ownerPrincipal: 'owner', dispatcherPrincipal: 'dispatcher' };
const owner: RevocationContext = { environment: 'test', principal: 'owner', role: 'owner' };
const dispatcher: RevocationContext = { environment: 'test', principal: 'dispatcher', role: 'dispatcher' };
const cleanups: (() => void)[] = [];
afterEach(() => { vi.useRealTimers(); for (const close of cleanups.splice(0).reverse()) close(); });

function validTransferBinding(compute: Partial<TransferBinding['compute']> = {}): TransferBinding {
  return { projectId: 'project', policyVersion: 'p1', policyHash: H,
    compute: { authorityId: 'compute', workloadId: 'work', leaseId: 'lease', attemptId: 'attempt', capabilityDigest: H, workerId: 'worker', epoch: 1, generation: 1, incarnation: 1, ...compute },
    content: { manifestHash: H, objectHash: H, objectKey: `projects/project/objects/${H}`, objectGeneration: '1', bytes: 100 } };
}
function target(targetId = 'target', compute: Partial<TransferBinding['compute']> = {}, kind: RevocationTarget['kind'] = 'catalog'): RevocationTarget {
  return { version: 1, targetId, kind, environment: 'test', authorityId: kind, projectId: 'project', resourceId: 'transfer', generation: 1, binding: validTransferBinding(compute) };
}
function event(seq = 1, overrides: Partial<FenceEvent> = {}): FenceEvent {
  return { seq, kind: 'lease-revoked', epoch: 1, leaseId: 'lease', workloadId: 'work', workerId: 'worker', generation: 1, incarnation: 1, ...overrides };
}
function noop(seq: number): FenceEvent {
  return event(seq, { kind: 'noop', leaseId: null, workloadId: null, workerId: null, generation: null, incarnation: null });
}
function page(events: FenceEvent[], after = 0, overrides: Partial<FencePage> = {}): FencePage {
  return { version: 1, environment: 'test', authorityId: 'compute', epoch: 10, after, through: after + events.length, head: after + events.length, events, ...overrides };
}
function receipt(d: Delivery, overrides: Partial<DeliveryReceipt> = {}): DeliveryReceipt {
  return { version: 1, deliveryId: d.deliveryId, evidenceId: d.evidenceId, targetId: d.target.targetId, status: 'revoked', ...overrides };
}
function setup() {
  const db = new DatabaseSync(':memory:'); cleanups.push(() => db.close());
  let clock = 100, fault: string | undefined;
  const port: TransactionPort = {
    sql: { exec(q, ...bindings) {
      if (fault && q.startsWith(fault)) { fault = undefined; throw new Error('injected storage failure'); }
      return db.prepare(q).all(...bindings) as Record<string, unknown>[];
    } },
    transactionSync(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const result = fn(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
  const reopen = (config: RevocationOptions = options) => new RevocationRelay(port, { ...config, now: () => clock });
  const relay = reopen();
  const seed = () => { relay.register(owner, target()); relay.ingest(dispatcher, page([event()])); };
  return { db, port, relay, reopen, seed, snap: () => relay.snapshot(owner), time: (n: number) => { clock = n; }, fail: (prefix: string) => { fault = prefix; } };
}
function ack(relay: RevocationRelay, d: Delivery) {
  return relay.settle(dispatcher, { deliveryId: d.deliveryId, revision: d.revision, outcome: 'ack', receipt: receipt(d) });
}

describe('revocation relay: source and target boundaries', () => {
  it('owns an independent contiguous cursor, including noops and empty head polls', () => {
    const h = setup();
    h.db.exec('CREATE TABLE compute_projection_outbox(cursor INTEGER); INSERT INTO compute_projection_outbox VALUES(91)');
    expect(h.relay.ingest(dispatcher, page([noop(1), event(2), noop(3)]))).toEqual({ cursor: 3, replayed: false });
    expect(h.relay.ingest(dispatcher, page([], 3, { head: 9 }))).toEqual({ cursor: 3, replayed: false });
    expect(h.snap().events).toEqual([event(2)]);
    expect(h.db.prepare('SELECT cursor FROM compute_projection_outbox').get()).toEqual({ cursor: 91 });
    expect(h.reopen().cursor(dispatcher)).toBe(3);
  });
  it('replays an identical feed and rejects a conflicting duplicate without changing evidence', () => {
    const h = setup(), p = page([event()]); h.relay.ingest(dispatcher, p);
    expect(h.relay.ingest(dispatcher, p)).toEqual({ cursor: 1, replayed: true });
    const before = h.snap();
    expect(() => h.relay.ingest(dispatcher, page([event(1, { leaseId: 'other' })]))).toThrow('SOURCE_CURSOR');
    expect(h.snap()).toEqual(before);
  });
  it.each([
    ['gap', () => page([event(2)]) , 'SOURCE_GAP'],
    ['cursor skip', () => page([event(3)], 2), 'SOURCE_CURSOR'],
    ['wrong authority', () => page([event()], 0, { authorityId: 'impostor' }), 'SOURCE_BINDING'],
    ['wrong environment', () => page([event()], 0, { environment: 'prod' }), 'SOURCE_BINDING'],
  ] as const)('rejects %s atomically', (_name, input, code) => {
    const h = setup(), before = h.snap(); expect(() => h.relay.ingest(dispatcher, input())).toThrow(code); expect(h.snap()).toEqual(before);
  });
  it.each(['before', 'after'] as const)('registers targets %s revocation, deduplicates registration and retains one delivery', when => {
    const h = setup(), t = target();
    if (when === 'before') h.relay.register(owner, t);
    h.relay.ingest(dispatcher, page([event(), event(2)]));
    if (when === 'after') h.relay.register(owner, t);
    expect(h.relay.register(owner, t)).toEqual({ registered: true, replayed: true });
    expect(() => h.relay.register(owner, { ...t, resourceId: 'changed' })).toThrow('TARGET_CONFLICT');
    expect(h.snap().deliveries).toHaveLength(1);
    expect(h.relay.claim(dispatcher)).toMatchObject({ target: t, event: event() });
  });
  it.each(['leaseId', 'workloadId', 'workerId', 'epoch', 'generation', 'incarnation'] as const)('lease revocation requires matching %s', field => {
    const h = setup(); h.relay.register(owner, target('matching'));
    const different = { [field]: typeof validTransferBinding().compute[field] === 'number' ? 2 : 'different' };
    h.relay.register(owner, target('different', different));
    h.relay.ingest(dispatcher, page([event()]));
    expect(h.snap().deliveries.map(d => d.target_id)).toEqual(['matching']);
  });
  it('does not revoke a newer attempt with a new lease', () => {
    const h = setup(); h.relay.register(owner, target('old')); h.relay.register(owner, target('new', { attemptId: 'attempt-2', leaseId: 'lease-2' }));
    h.relay.ingest(dispatcher, page([event()])); expect(h.snap().deliveries.map(d => d.target_id)).toEqual(['old']);
  });
  it.each([
    ['epoch', event(1, { ...noop(1), kind: 'epoch-bumped', epoch: 2 }), [{ epoch: 1 }, { epoch: 2 }, { epoch: 3 }], ['t0']],
    ['worker', event(1, { ...noop(1), kind: 'worker-quarantined', workerId: 'worker', incarnation: 2 }), [{ incarnation: 1 }, { incarnation: 2 }, { workerId: 'other' }], ['t0']],
    ['workload', event(1, { ...noop(1), kind: 'workload-cancelled', workloadId: 'work', generation: 2 }), [{ generation: 1 }, { generation: 2 }, { generation: 3 }, { workloadId: 'other' }], ['t0', 't1']],
  ] as const)('applies %s scopes at their exact boundary', (_name, e, bindings, expected) => {
    const h = setup(); bindings.forEach((binding, i) => h.relay.register(owner, target(`t${i}`, binding)));
    h.relay.ingest(dispatcher, page([e])); expect(h.snap().deliveries.map(d => d.target_id).sort()).toEqual(expected);
  });
  it('validates the full binding and source before retaining a target', () => {
    const h = setup(), bad = target(); bad.binding.policyHash = 'invalid';
    expect(() => h.relay.register(owner, bad)).toThrow();
    expect(() => h.relay.register(owner, target('wrong', { authorityId: 'other' }))).toThrow('SOURCE_BINDING');
    expect(h.snap().targets).toEqual([]);
  });
  it('binds roles to principal and environment rather than trusting role labels', () => {
    const h = setup();
    for (const c of [{ ...owner, principal: 'dispatcher' }, { ...owner, environment: 'prod' }, { ...dispatcher, principal: 'owner' }]) {
      expect(() => h.relay.cursor(c)).toThrow('PERMISSION');
      expect(() => h.relay.ingest(c, page([event()]))).toThrow('PERMISSION');
    }
    expect(() => h.relay.register(dispatcher, target())).toThrow('PERMISSION');
    expect(() => h.relay.snapshot(dispatcher)).toThrow('PERMISSION');
    expect(h.snap().cursor).toBe(0);
  });
});

describe('revocation relay: delivery and recovery', () => {
  it('binds evidence to the canonical source event and shares it across destination kinds', () => {
    const h = setup(); h.relay.register(owner, target('catalog-target'));
    h.relay.register(owner, target('broker-target', {}, 'broker'));
    h.relay.ingest(dispatcher, page([event()]));
    const first = h.relay.claim(dispatcher)!, second = h.relay.claim(dispatcher)!;
    const expected = createHash('sha256').update(canonical({ source: options.sourceAuthorityId, event: event() })).digest('hex');
    expect(first.evidenceId).toBe(expected); expect(second.evidenceId).toBe(expected);
    expect(first.deliveryId).not.toBe(second.deliveryId);
    expect(new Set([first.target.kind, second.target.kind])).toEqual(new Set(['catalog', 'broker']));
    expect(first.key).toBe(first.deliveryId); expect(second.key).toBe(second.deliveryId);
  });
  it('returns idle without invoking the destination when no delivery is pending', async () => {
    const h = setup(), deliver = vi.fn();
    expect(await h.relay.deliverOne(dispatcher, { deliver })).toEqual({ status: 'idle' }); expect(deliver).not.toHaveBeenCalled();
  });
  it('rejects a wrong direct acknowledgement without altering the claim', () => {
    const h = setup(); h.seed(); const d = h.relay.claim(dispatcher)!, before = h.snap();
    expect(() => h.relay.settle(dispatcher, { deliveryId: d.deliveryId, revision: d.revision, outcome: 'ack', receipt: receipt(d, { targetId: 'other' }) })).toThrow('ACK_BINDING');
    expect(h.snap()).toEqual(before); expect(ack(h.relay, d)).toEqual({ settled: true });
  });
  it('20 competing relay instances claim exactly one delivery', async () => {
    const h = setup(); h.seed();
    const clients = Array.from({ length: 20 }, () => h.reopen());
    const claims = await Promise.all(clients.map(client => Promise.resolve().then(() => client.claim(dispatcher))));
    expect(claims.filter(d => d !== null)).toHaveLength(1);
    expect(h.snap().deliveries[0]).toMatchObject({ state: 'leased', attempts: 1, revision: 1 });
  });
  it('replays a lost destination response with a stable key after relay reconstruction', async () => {
    const h = setup(); h.seed(); const received: Delivery[] = [], applied = new Set<string>();
    const destination = { async deliver(d: Delivery) {
      received.push(d); const duplicate = applied.has(d.key); applied.add(d.key);
      if (!duplicate) throw new Error('response lost after destination commit');
      return receipt(d, { status: 'already-revoked' });
    } };
    expect(await h.relay.deliverOne(dispatcher, destination)).toEqual({ status: 'retry' });
    h.time(1100); expect(await h.reopen().deliverOne(dispatcher, destination)).toEqual({ status: 'acked' });
    expect(received).toHaveLength(2); expect(applied.size).toBe(1);
    expect(received[1].key).toBe(received[0].key); expect(received[1].evidenceId).toBe(received[0].evidenceId);
    expect(received[1].revision).toBeGreaterThan(received[0].revision);
    expect(h.snap().deliveries[0].state).toBe('acked');
  });
  it('refences an expired claim and rejects both expired and stale acknowledgements', () => {
    const h = setup(); h.seed(); const old = h.relay.claim(dispatcher, 1000)!;
    h.time(1100); expect(() => ack(h.relay, old)).toThrow('DELIVERY_EXPIRED');
    const current = h.reopen().claim(dispatcher, 1000)!;
    expect(current.key).toBe(old.key); expect(current.revision).toBe(old.revision + 1);
    expect(() => ack(h.relay, old)).toThrow('DELIVERY_FENCE');
    expect(ack(h.relay, current)).toEqual({ settled: true });
    expect(ack(h.relay, current)).toEqual({ settled: true });
    expect(h.relay.claim(dispatcher)).toBeNull();
  });
  it.each(['deliveryId', 'evidenceId', 'targetId', 'status', 'version'] as const)('blocks a wrong %s acknowledgement until owner recovery', async field => {
    const h = setup(); h.seed();
    expect(await h.relay.deliverOne(dispatcher, { async deliver(d) { return { ...receipt(d), [field]: field === 'version' ? 2 : 'wrong' }; } })).toEqual({ status: 'blocked' });
    const row = h.snap().deliveries[0]; expect(row.state).toBe('blocked'); expect(h.relay.claim(dispatcher)).toBeNull();
    expect(() => h.relay.recover(dispatcher, row.id)).toThrow('PERMISSION');
    expect(h.relay.recover(owner, row.id)).toEqual({ recovered: true });
    expect(await h.relay.deliverOne(dispatcher, { async deliver(d) { return receipt(d); } })).toEqual({ status: 'acked' });
    expect(h.snap().deliveries[0].attempts).toBe(2);
  });
  it('propagates acknowledgement storage failure and leaves the claim replayable', async () => {
    const h = setup(); h.seed();
    await expect(h.relay.deliverOne(dispatcher, { async deliver(d) { h.fail('UPDATE library_revoke_deliveries SET state='); return receipt(d); } })).rejects.toThrow('injected storage failure');
    expect(h.snap().deliveries[0]).toMatchObject({ state: 'leased', attempts: 1 });
    h.time(10100); expect(h.reopen().claim(dispatcher)?.revision).toBe(2);
  });
  it('propagates retry storage failure rather than reporting a persisted retry', async () => {
    const h = setup(); h.seed();
    await expect(h.relay.deliverOne(dispatcher, { async deliver() { h.fail('UPDATE library_revoke_deliveries SET state='); throw new Error('transport failed'); } })).rejects.toThrow('injected storage failure');
    expect(h.snap().deliveries[0].state).toBe('leased');
  });
  it('bounds an unresponsive transport at five seconds without acknowledging it', async () => {
    vi.useFakeTimers(); const h = setup(); h.seed();
    const delivery = h.relay.deliverOne(dispatcher, { deliver: () => new Promise(() => {}) });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await delivery).toEqual({ status: 'retry' }); expect(h.snap().deliveries[0].state).toBe('pending');
  });
  it('caps owner recovery at a 1024 lifetime budget without erasing attempts', () => {
    const h = setup(); h.seed();
    for (let budget = 32; budget <= 1024; budget += 32) {
      const d = h.relay.claim(dispatcher)!;
      h.relay.settle(dispatcher, { deliveryId: d.deliveryId, revision: d.revision, outcome: 'blocked', receipt: null });
      if (budget < 1024) h.relay.recover(owner, d.deliveryId);
      else {
        const before = h.snap(); expect(() => h.relay.recover(owner, d.deliveryId)).toThrow('RETRY_CAPACITY');
        expect(h.snap()).toEqual(before); expect(before.deliveries[0]).toMatchObject({ attempts: 32, budget: 1024, state: 'blocked' });
      }
    }
  });
  it('retains lifetime attempts and adds 32 owner-authorized attempts after exhaustion', () => {
    const h = setup(); h.seed();
    for (let i = 0; i < 32; i++) { h.time(100 + i * 1000); expect(h.relay.claim(dispatcher, 1000)).not.toBeNull(); }
    h.time(32100); expect(h.relay.claim(dispatcher, 1000)).toBeNull();
    const row = h.snap().deliveries[0]; expect(row).toMatchObject({ state: 'blocked', attempts: 32, budget: 32 });
    h.relay.recover(owner, row.id); expect(h.snap().deliveries[0]).toMatchObject({ attempts: 32, budget: 64 });
    expect(h.relay.claim(dispatcher, 1000)?.revision).toBe(33);
    expect(h.snap().deliveries[0].attempts).toBe(33);
  });
});

describe('revocation relay: transactional storage and retained evidence', () => {
  it('rolls back the whole feed on a delivery insert failure', () => {
    const h = setup(); h.relay.register(owner, target()); const before = h.snap(); h.fail('INSERT INTO library_revoke_deliveries');
    expect(() => h.relay.ingest(dispatcher, page([event()]))).toThrow('injected storage failure'); expect(h.snap()).toEqual(before);
    expect(h.relay.ingest(dispatcher, page([event()]))).toEqual({ cursor: 1, replayed: false });
  });
  it('rolls back late target registration if creating its delivery fails', () => {
    const h = setup(); h.relay.ingest(dispatcher, page([event()])); const before = h.snap(); h.fail('INSERT INTO library_revoke_deliveries');
    expect(() => h.relay.register(owner, target())).toThrow('injected storage failure'); expect(h.snap()).toEqual(before);
    expect(h.relay.register(owner, target()).registered).toBe(true);
  });
  it('rolls back a claim if leasing fails, including the persisted clock', () => {
    const h = setup(); h.seed(); h.fail("UPDATE library_revoke_deliveries SET state='leased'");
    expect(() => h.relay.claim(dispatcher)).toThrow('injected storage failure');
    expect(h.db.prepare('SELECT clock FROM library_revoke_meta').get()).toEqual({ clock: 0 });
    expect(h.snap().deliveries[0]).toMatchObject({ state: 'pending', attempts: 0, revision: 0 });
  });
  it('rejects constructor binding drift while preserving existing evidence', () => {
    const h = setup(); h.seed(); const before = h.snap();
    expect(() => h.reopen({ ...options, sourceAuthorityId: 'other' })).toThrow('BINDING_MISMATCH'); expect(h.snap()).toEqual(before);
  });
  it('rejects schema drift while preserving existing evidence', () => {
    const h = setup(); h.seed(); const before = h.snap();
    h.db.exec('CREATE TABLE library_revoke_unrecognized(evidence TEXT); INSERT INTO library_revoke_unrecognized VALUES(\'keep\')');
    expect(() => h.reopen()).toThrow('SCHEMA_MISMATCH'); expect(h.snap()).toEqual(before);
    expect(h.db.prepare('SELECT evidence FROM library_revoke_unrecognized').get()).toEqual({ evidence: 'keep' });
  });
  it('rolls back partially created schema if constructor storage fails', () => {
    const h = setup(); const fresh = new DatabaseSync(':memory:'); cleanups.push(() => fresh.close());
    const port: TransactionPort = {
      sql: { exec(q, ...b) { if (q.startsWith('CREATE TABLE library_revoke_events')) throw new Error('schema storage failure'); return fresh.prepare(q).all(...b) as Record<string, unknown>[]; } },
      transactionSync(fn) { fresh.exec('BEGIN IMMEDIATE'); try { const result = fn(); fresh.exec('COMMIT'); return result; } catch (e) { fresh.exec('ROLLBACK'); throw e; } },
    };
    expect(() => new RevocationRelay(port, options)).toThrow('schema storage failure');
    expect(fresh.prepare("SELECT name FROM sqlite_master WHERE name GLOB 'library_revoke_*'").all()).toEqual([]);
    expect(h.snap().cursor).toBe(0);
  });
  it.each(['pages', 'events', 'targets', 'deliveries', 'meta'])('prevents INSERT OR REPLACE of retained %s identities', table => {
    const h = setup(); h.seed(); const before = h.snap();
    expect(() => h.db.exec(`INSERT OR REPLACE INTO library_revoke_${table} SELECT * FROM library_revoke_${table}`)).toThrow();
    expect(h.snap()).toEqual(before);
  });
  it('target capacity failure preserves evidence and still permits existing delivery work', async () => {
    const h = setup(); for (let i = 0; i < 128; i++) h.relay.register(owner, target(`t${i}`));
    h.relay.ingest(dispatcher, page([event()])); const before = h.snap();
    expect(() => h.relay.register(owner, target('overflow'))).toThrow('revocation capacity'); expect(h.snap()).toEqual(before);
    expect(await h.relay.deliverOne(dispatcher, { async deliver(d) { return receipt(d); } })).toEqual({ status: 'acked' });
    expect(h.snap().deliveries.filter(d => d.state === 'acked')).toHaveLength(1);
    expect(h.snap().deliveries.filter(d => d.state === 'pending')).toHaveLength(127);
  });
  it('page capacity preserves the cursor and allows pending work to settle', () => {
    const h = setup(); h.seed();
    for (let after = 1; after < 1024; after++) h.relay.ingest(dispatcher, page([noop(after + 1)], after));
    const before = h.snap(); expect(() => h.relay.ingest(dispatcher, page([noop(1025)], 1024))).toThrow('revocation capacity');
    expect(h.snap()).toEqual(before); expect(ack(h.relay, h.relay.claim(dispatcher)!)).toEqual({ settled: true });
  });
  it('event capacity fails atomically and retains pending deliveries for claiming', () => {
    const h = setup(); h.relay.register(owner, target());
    for (let after = 0; after < 512; after += 64) h.relay.ingest(dispatcher, page(Array.from({ length: 64 }, (_, i) => event(after + i + 1)), after));
    const before = h.snap(); expect(() => h.relay.ingest(dispatcher, page([event(513)], 512))).toThrow('revocation capacity');
    expect(h.snap()).toEqual(before); expect(h.relay.claim(dispatcher)).not.toBeNull();
  });
});
