import { describe, expect, it, vi } from 'vitest';
import { recoveryReconciler, type FenceObservation } from './reconcile';
import { checkpointStore } from './index';
import type { FencePage } from '../../library-revocation/src/types';
import { challenge, command, deferred, H, observation, OTHER, owner, page, scope, setup, sqlite, targetId } from './test-support';

const signal = () => new AbortController().signal;
function secondCheck() { return { ...challenge().checks[0], intentId: 'second', targetId: targetId('second') }; }
function revokedPage(): FencePage { return page(0, { through: 1, head: 1, events: [{ seq: 1, kind: 'lease-revoked', epoch: 1, workloadId: 'work', leaseId: 'lease', workerId: 'worker', generation: 1, incarnation: 1 }] }); }

describe('checkpoint reconciler: authority and admission', () => {
  it('returns a bound proof using the real checkpoint and SQLite relay without writing approval', async () => {
    const h = setup(), before = h.store.reader.latest(), input = challenge();
    const proof = await recoveryReconciler(scope, h.ports)(input, signal());
    expect(proof).toMatchObject({ restoreId: 'restore', approvedArchiveSha256: H, observedAt: 100, checks: [{ ...input.checks[0], valid: true, sourceHead: 0, relayCursor: 0 }] });
    expect(h.store.reader.latest()).toEqual(before); expect(h.relay.snapshot(owner).targets).toHaveLength(1);
    expect(h.source.observe).toHaveBeenCalledWith(input.checks[0].binding.compute, expect.any(AbortSignal));
    expect(h.checkpointDb.db.prepare('SELECT count(*) AS n FROM library_checkpoint_decisions').get()).toEqual({ n: 1 });
  });
  it.each(['environment', 'relayAuthorityId', 'sourceAuthorityId'] as const)('rejects wrong relay %s at construction', field => {
    const h = setup(); expect(() => recoveryReconciler({ ...scope, [field]: 'other' }, h.ports)).toThrow('RECONCILER_RELAY_SCOPE');
    expect(h.source.readPage).not.toHaveBeenCalled();
  });
  it.each(['absent', 'withdrawn', 'mismatch'] as const)('cannot self approve a checkpoint that is %s', async state => {
    const h = setup(state !== 'absent');
    if (state === 'withdrawn') h.store.admin.execute(owner, command('withdraw', 1, null));
    const input = challenge(); if (state === 'mismatch') input.archiveSha256 = OTHER;
    const before = h.store.reader.latest();
    await expect(recoveryReconciler(scope, h.ports)(input, signal())).rejects.toThrow(state === 'absent' ? 'RECONCILER_CHECKPOINT_ABSENT' : state === 'mismatch' ? 'RECOVERY_CHECKPOINT_MISMATCH' : 'INVALID_INPUT');
    expect(h.store.reader.latest()).toEqual(before); expect(h.source.readPage).not.toHaveBeenCalled(); expect(h.relay.snapshot(owner).targets).toEqual([]);
  });
  it.each(Object.keys(scope) as (keyof typeof scope)[])('rejects an independent SQLite checkpoint with different %s', async field => {
    const h = setup(), other = sqlite();
    const otherScope = { ...scope, [field]: field === 'policyHash' ? OTHER : 'other' };
    const store = checkpointStore(other.port, otherScope, () => 100);
    store.admin.execute({ ...owner, environment: otherScope.environment, principal: otherScope.ownerPrincipal }, command());
    await expect(recoveryReconciler(scope, { ...h.ports, checkpoint: store.recovery })(challenge(), signal())).rejects.toThrow('RECONCILER_CHECKPOINT_SCOPE');
    expect(h.source.readPage).not.toHaveBeenCalled();
  });
  it('rejects an actual SQLite checkpoint approved in the logical future', async () => {
    const h = setup(); h.time(99);
    await expect(recoveryReconciler(scope, h.ports)(challenge(), signal())).rejects.toThrow('RECONCILER_CHECKPOINT_TIME');
    expect(h.source.readPage).not.toHaveBeenCalled();
  });
  it.each(['intent', 'target'] as const)('rejects duplicate %s checks before source or relay work', async duplicate => {
    const h = setup(), input = challenge(), next = secondCheck();
    if (duplicate === 'intent') { next.intentId = input.checks[0].intentId; next.targetId = input.checks[0].targetId; } else next.targetId = input.checks[0].targetId;
    input.checks.push(next);
    await expect(recoveryReconciler(scope, h.ports)(input, signal())).rejects.toThrow(duplicate === 'intent' ? 'RECONCILER_DUPLICATE_CHECK' : 'RECONCILER_TARGET_BINDING');
    expect(h.source.readPage).not.toHaveBeenCalled(); expect(h.relay.snapshot(owner).targets).toEqual([]);
  });
  it.each(['projectId', 'policyVersion', 'policyHash', 'authorityId', 'epoch', 'generation'] as const)('rejects challenge binding drift: %s', async field => {
    const h = setup(), input = challenge(), c = input.checks[0];
    if (field === 'authorityId') c.binding.compute.authorityId = 'other';
    else if (field === 'epoch') c.binding.compute.epoch = 0;
    else if (field === 'generation') c.generation = 0;
    else c.binding[field] = field === 'policyHash' ? OTHER : 'other';
    await expect(recoveryReconciler(scope, h.ports)(input, signal())).rejects.toThrow(); expect(h.source.readPage).not.toHaveBeenCalled();
  });
  it('accepts exactly 32 distinct checks and rejects 33 before registration', async () => {
    const h = setup(), input = challenge(); input.checks = Array.from({ length: 32 }, (_, i) => ({ ...challenge().checks[0], intentId: `intent-${i}`, targetId: targetId(`intent-${i}`) }));
    expect((await recoveryReconciler(scope, h.ports)(input, signal())).checks).toHaveLength(32);
    const other = setup(); input.checks.push(secondCheck());
    await expect(recoveryReconciler(scope, other.ports)(input, signal())).rejects.toThrow('RECONCILER_CHECK_CAPACITY'); expect(other.source.readPage).not.toHaveBeenCalled();
  });
  it('allows an empty challenge only with independent approval and source catch-up', async () => {
    const h = setup(); const input = { ...challenge(), checks: [] };
    expect((await recoveryReconciler(scope, h.ports)(input, signal())).checks).toEqual([]);
    expect(h.source.readPage).toHaveBeenCalledTimes(1); expect(h.source.observe).not.toHaveBeenCalled();
  });
  it.each(['withdraw', 'replace', 'same-archive-revision'] as const)('rejects checkpoint %s during an awaited source observation', async action => {
    const h = setup(), held = deferred<unknown>(); h.source.observe.mockReturnValueOnce(held.promise);
    const reconcile = recoveryReconciler(scope, h.ports), work = reconcile(challenge(), signal());
    await vi.waitFor(() => expect(h.source.observe).toHaveBeenCalledTimes(1));
    h.store.admin.execute(owner, command('change', 1, action === 'withdraw' ? null : action === 'replace' ? OTHER : H));
    held.resolve(observation()); await expect(work).rejects.toThrow(action === 'withdraw' ? 'INVALID_INPUT' : 'RECONCILER_CHECKPOINT_CHANGED');
    expect(h.store.reader.latest().revision).toBe(2);
  });
  it.each((['readPage', 'observe'] as const).flatMap(method => (['resolve', 'reject'] as const).map(outcome => [method, outcome] as const)))('keeps admission while abort-ignoring %s remains unresolved, then releases it after %s', async (method, outcome) => {
    vi.useFakeTimers(); const h = setup(), held = deferred<FencePage>();
    h.source[method].mockReturnValueOnce(held.promise);
    const reconcile = recoveryReconciler(scope, h.ports), work = reconcile(challenge(), signal());
    const rejection = expect(work).rejects.toThrow('RECONCILER_ABORTED');
    await vi.advanceTimersByTimeAsync(4000); await rejection;
    expect(h.source[method].mock.calls[0][1].aborted).toBe(true);
    await expect(reconcile(challenge(), signal())).rejects.toThrow('RECONCILER_BUSY');
    if (outcome === 'reject') held.reject(new Error('late source failure')); else held.resolve(page());
    await vi.advanceTimersByTimeAsync(0);
    expect((await reconcile(challenge(), signal())).checks[0].valid).toBe(true);
    expect(h.store.reader.latest().revision).toBe(1);
  });
  it('external abort returns promptly and retains admission until the actual port settles', async () => {
    const h = setup(), held = deferred<FencePage>(); h.source.readPage.mockReturnValueOnce(held.promise);
    const controller = new AbortController(), reconcile = recoveryReconciler(scope, h.ports), work = reconcile(challenge(), controller.signal);
    controller.abort(); await expect(work).rejects.toThrow('RECONCILER_ABORTED');
    await expect(reconcile(challenge(), signal())).rejects.toThrow('RECONCILER_BUSY');
    held.resolve(page()); await vi.waitFor(async () => { await expect(reconcile(challenge(), signal())).resolves.toHaveProperty('checks'); });
  });
  it('pre-aborted requests perform no source or registration work', async () => {
    const h = setup(), controller = new AbortController(); controller.abort();
    await expect(recoveryReconciler(scope, h.ports)(challenge(), controller.signal)).rejects.toThrow();
    expect(h.source.readPage).not.toHaveBeenCalled(); expect(h.relay.snapshot(owner).targets).toEqual([]);
  });
});

describe('checkpoint reconciler: source evidence and fence outcomes', () => {
  it.each([
    ['accepted', { current: false, accepted: true, state: 'SUCCEEDED', expiresAt: 0 }, true],
    ['running', {}, true], ['verifying', { state: 'VERIFYING' }, true],
    ['invalid', { current: false, state: 'CANCELLED' }, false],
  ] as const)('reports %s evidence with the correct validity', async (_label, overrides, valid) => {
    const h = setup(); h.source.observe.mockResolvedValue(observation(overrides));
    const proof = await recoveryReconciler(scope, h.ports)(challenge(), signal()); expect(proof.checks[0].valid).toBe(valid);
  });
  it.each([
    ['environment', { environment: 'prod' }, 'RECONCILER_SOURCE_SCOPE'], ['authority', { authorityId: 'other' }, 'RECONCILER_SOURCE_SCOPE'],
    ['binding', { binding: { ...observation().binding, leaseId: 'other' } }, 'RECONCILER_SOURCE_SCOPE'],
    ['version', { version: 2 }, 'RECONCILER_SOURCE_SCOPE'],
    ['old', { observedAt: 0 }, 'RECONCILER_SOURCE_STALE'], ['future', { observedAt: 1101 }, 'RECONCILER_SOURCE_STALE'],
    ['both flags', { current: true, accepted: true }, 'RECONCILER_SOURCE_SHAPE'], ['flag type', { current: 'true' }, 'RECONCILER_SOURCE_SHAPE'],
    ['oversize state', { state: 'x'.repeat(33) }, 'RECONCILER_SOURCE_SHAPE'],
    ['bad current state', { state: 'SUCCEEDED' }, 'RECONCILER_SOURCE_INVALID'],
    ['bad accepted state', { current: false, accepted: true, state: 'RUNNING' }, 'RECONCILER_SOURCE_INVALID'],
    ['expired', { observedAt:1100, expiresAt: 1100 }, 'RECONCILER_SOURCE_INVALID'],
    ['past expiry', { observedAt:1100, expiresAt: 1099 }, 'RECONCILER_SOURCE_INVALID'],
    ['wrong current epoch', { epoch: 2 }, 'RECONCILER_SOURCE_INVALID'],
    ['wrong accepted epoch', { epoch: 2, current: false, accepted: true, state: 'SUCCEEDED' }, 'RECONCILER_SOURCE_INVALID'],
    ['fractional head', { head: 0.5 }, 'INVALID_INPUT'],
  ] as const)('rejects %s observation', async (_label, overrides, error) => {
    const h = setup(); h.time(1100); h.source.observe.mockResolvedValue(observation(overrides as Partial<FenceObservation>));
    await expect(recoveryReconciler(scope, h.ports)(challenge(), signal())).rejects.toThrow(error);
  });
  it('accepts observation freshness at exactly 1000ms', async () => {
    const h = setup(); h.time(1100); h.source.observe.mockResolvedValue(observation({ observedAt: 100 }));
    expect((await recoveryReconciler(scope, h.ports)(challenge(), signal())).checks[0].valid).toBe(true);
  });
  it.each(['readPage', 'observe'] as const)('propagates source %s outage, preserves approval and permits retry', async method => {
    const h = setup(); h.source[method].mockRejectedValueOnce(new Error('source offline'));
    const reconcile = recoveryReconciler(scope, h.ports);
    await expect(reconcile(challenge(), signal())).rejects.toThrow('source offline');
    expect(h.store.reader.latest().revision).toBe(1); expect((await reconcile(challenge(), signal())).checks[0].valid).toBe(true);
  });
  it('registration storage failure performs no source reads and can retry without phantom targets', async () => {
    const h = setup(); h.relayDb.fail('INSERT INTO library_revoke_targets'); const reconcile = recoveryReconciler(scope, h.ports);
    await expect(reconcile(challenge(), signal())).rejects.toThrow('injected SQLite failure');
    expect(h.relay.snapshot(owner).targets).toEqual([]); expect(h.source.readPage).not.toHaveBeenCalled();
    expect((await reconcile(challenge(), signal())).checks[0].valid).toBe(true);
  });
  it('fails closed on conflicting existing registration', async () => {
    const h = setup(), c = challenge().checks[0]; h.relay.register(owner, { version: 1, targetId: c.targetId, kind: 'catalog', environment: 'test', authorityId: 'catalog', projectId: 'project', resourceId: 'other', generation: 1, binding: c.binding });
    await expect(recoveryReconciler(scope, h.ports)(challenge(), signal())).rejects.toThrow('TARGET_CONFLICT'); expect(h.source.readPage).not.toHaveBeenCalled();
  });
  it.each(['before', 'during'] as const)('retained revocation %s registration overrides a positive source observation', async when => {
    const h = setup(); if (when === 'before') h.relay.ingest(h.ports.dispatcher, revokedPage());
    else h.source.readPage.mockResolvedValueOnce(revokedPage());
    h.source.observe.mockResolvedValue(observation({ head: 1, current: false, accepted: true, state: 'SUCCEEDED' }));
    const reconcile = recoveryReconciler(scope, h.ports);
    expect((await reconcile(challenge(), signal())).checks[0]).toMatchObject({ valid: false, sourceHead: 1, relayCursor: 1 });
    expect((await reconcile(challenge(), signal())).checks[0].valid).toBe(false);
    expect(h.relay.snapshot(owner).deliveries).toHaveLength(1); expect(h.relay.snapshot(owner).targets).toHaveLength(1);
  });
  it('catches up to an observation head ahead of the relay before issuing proof', async () => {
    const h = setup(); h.source.readPage.mockResolvedValueOnce(page()).mockResolvedValueOnce(page(0, { through: 1, head: 1, events: [{ seq: 1, kind: 'noop', epoch: 1, leaseId: null, workloadId: null, workerId: null, generation: null, incarnation: null }] }));
    h.source.observe.mockResolvedValue(observation({ head: 1 }));
    expect((await recoveryReconciler(scope, h.ports)(challenge(), signal())).checks[0]).toMatchObject({ valid: true, sourceHead: 1, relayCursor: 1 });
    expect(h.source.readPage).toHaveBeenCalledTimes(2); expect(h.source.observe).toHaveBeenCalledTimes(2);
  });
  it('rejects lagging observation head behind the persisted relay cursor', async () => {
    const h = setup(); h.relay.ingest(h.ports.dispatcher, revokedPage());
    await expect(recoveryReconciler(scope, h.ports)(challenge(), signal())).rejects.toThrow('RECONCILER_SOURCE_ROLLBACK');
  });
  it.each(['head', 'epoch'] as const)('rejects source page %s rollback after observation', async field => {
    const h = setup(); h.source.observe.mockResolvedValue(observation({ head: 1, epoch: field === 'epoch' ? 2 : 1, current: false, state: 'CANCELLED' }));
    h.source.readPage.mockResolvedValueOnce(page()).mockResolvedValueOnce(page(0, { head: field === 'head' ? 0 : 1 }));
    await expect(recoveryReconciler(scope, h.ports)(challenge(), signal())).rejects.toThrow('RECONCILER_SOURCE_ROLLBACK');
  });
  it('rejects epoch rollback between observations within a pass', async () => {
    const h = setup(), input = challenge(); input.checks.push(secondCheck());
    h.source.observe.mockResolvedValueOnce(observation({ epoch: 2, current: false, state: 'CANCELLED' })).mockResolvedValueOnce(observation());
    await expect(recoveryReconciler(scope, h.ports)(input, signal())).rejects.toThrow('RECONCILER_SOURCE_ROLLBACK');
  });
  it.each(['authorityId', 'environment'] as const)('rejects wrong source page %s through the real relay', async field => {
    const h = setup(); h.source.readPage.mockResolvedValueOnce(page(0, { [field]: 'other' }));
    await expect(recoveryReconciler(scope, h.ports)(challenge(), signal())).rejects.toThrow('SOURCE_BINDING'); expect(h.relay.cursor(h.ports.dispatcher)).toBe(0);
  });
  it('bounds a source that never advances through its advertised head to sixteen pages', async () => {
    const h = setup(); h.source.readPage.mockResolvedValue(page(0, { head: 1 }));
    await expect(recoveryReconciler(scope, h.ports)(challenge(), signal())).rejects.toThrow('RECONCILER_PAGE_CAPACITY');
    expect(h.source.readPage).toHaveBeenCalledTimes(16); expect(h.source.observe).not.toHaveBeenCalled();
  });
  it('bounds a moving observation head to eight rounds without approving stale proof', async () => {
    const h = setup(); h.source.readPage.mockResolvedValue(page(0, { head: 1 }));
    // Each round catches up to the last head; observation immediately reveals the next one.
    let head = 0;
    h.source.readPage.mockImplementation(async after => page(after, { through: head, head, events: Array.from({ length: head - after }, (_, i) => ({ seq: after + i + 1, kind: 'noop' as const, epoch: 1, leaseId: null, workloadId: null, workerId: null, generation: null, incarnation: null })) }));
    h.source.observe.mockImplementation(async () => observation({ head: ++head }));
    await expect(recoveryReconciler(scope, h.ports)(challenge(), signal())).rejects.toThrow('RECONCILER_UNSTABLE_SOURCE'); expect(h.source.observe).toHaveBeenCalledTimes(8);
  });
  it('marks a current lease invalid if it expires while awaiting another check', async () => {
    const h = setup(), input = challenge(); input.checks.push(secondCheck());
    h.source.observe.mockResolvedValueOnce(observation({ expiresAt: 200 })).mockImplementationOnce(async () => { h.time(200); return observation({ observedAt: 200 }); });
    const proof = await recoveryReconciler(scope, h.ports)(input, signal()); expect(proof.checks.map(c => c.valid)).toEqual([false, true]);
  });
  it('rejects a previously fresh observation that ages out while awaiting another check', async () => {
    const h = setup(), input = challenge(); input.checks.push(secondCheck());
    h.source.observe.mockResolvedValueOnce(observation()).mockImplementationOnce(async () => { h.time(1101); return observation({ observedAt: 1101 }); });
    await expect(recoveryReconciler(scope, h.ports)(input, signal())).rejects.toThrow('RECONCILER_SOURCE_STALE');
  });
  it.each([99, 4101])('rejects logical clock rollback or deadline overrun at %i', async time => {
    const h = setup(); h.source.readPage.mockImplementationOnce(async () => { h.time(time); return page(); });
    await expect(recoveryReconciler(scope, h.ports)(challenge(), signal())).rejects.toThrow('RECONCILER_TIMEOUT'); expect(h.source.observe).not.toHaveBeenCalled();
  });
  it('copies the challenge before awaiting source work', async () => {
    const h = setup(), held = deferred<FencePage>(); h.source.readPage.mockReturnValueOnce(held.promise);
    const input = challenge(), work = recoveryReconciler(scope, h.ports)(input, signal()); input.restoreId = 'changed'; input.checks[0].intentId = 'changed'; input.checks[0].binding.compute.leaseId = 'changed';
    held.resolve(page()); const proof = await work;
    expect(proof.restoreId).toBe('restore'); expect(proof.checks[0]).toMatchObject({ intentId: 'intent', binding: { compute: { leaseId: 'lease' } } });
  });
  it.each(['restoreId', 'intentId', 'generation', 'targetId'] as const)('rejects a target derived for a different %s', async field => {
    const h = setup(), input = challenge();
    if (field === 'restoreId') input.restoreId = 'other-restore';
    else if (field === 'intentId') input.checks[0].intentId = 'other-intent';
    else if (field === 'generation') input.checks[0].generation = 2;
    else input.checks[0].targetId = OTHER;
    await expect(recoveryReconciler(scope, h.ports)(input, signal())).rejects.toThrow('RECONCILER_TARGET_BINDING');
    expect(h.source.readPage).not.toHaveBeenCalled(); expect(h.relay.snapshot(owner).targets).toEqual([]);
  });
  it('rejects accessor source pages without invoking their getters', async () => {
    const h = setup(), getter = vi.fn(() => 0);
    const input = { ...page(), get head() { return getter(); } };
    h.source.readPage.mockResolvedValueOnce(input);
    await expect(recoveryReconciler(scope, h.ports)(challenge(), signal())).rejects.toThrow(); expect(getter).not.toHaveBeenCalled();
    expect(h.source.observe).not.toHaveBeenCalled(); expect(h.relay.cursor(h.ports.dispatcher)).toBe(0);
  });
  it('rejects accessor source observations without invoking their getters', async () => {
    const h = setup(), getter = vi.fn(() => true);
    h.source.observe.mockResolvedValueOnce({ ...observation(), get current() { return getter(); } });
    await expect(recoveryReconciler(scope, h.ports)(challenge(), signal())).rejects.toThrow(); expect(getter).not.toHaveBeenCalled();
  });
  it('retains revocation after a delivery ACK and reconciler reconstruction', async () => {
    const h = setup(); h.source.readPage.mockResolvedValueOnce(revokedPage());
    h.source.observe.mockResolvedValue(observation({ head: 1 }));
    const reconcile = recoveryReconciler(scope, h.ports);
    expect((await reconcile(challenge(), signal())).checks[0].valid).toBe(false);
    const d = h.relay.claim(h.ports.dispatcher)!;
    h.relay.settle(h.ports.dispatcher, { deliveryId: d.deliveryId, revision: d.revision, outcome: 'ack', receipt: { version: 1, deliveryId: d.deliveryId, evidenceId: d.evidenceId, targetId: d.target.targetId, status: 'revoked' } });
    expect(h.relay.snapshot(owner).deliveries[0].state).toBe('acked');
    const reconstructed = recoveryReconciler(scope, h.ports);
    expect((await reconstructed(challenge(), signal())).checks[0].valid).toBe(false);
    expect(h.relay.snapshot(owner).deliveries).toHaveLength(1);
  });
  it('rejects an observation head rollback between checks', async () => {
    const h = setup(), input = challenge(); input.checks.push(secondCheck());
    h.source.observe.mockResolvedValueOnce(observation({ head: 1 })).mockResolvedValueOnce(observation({ head: 0 }));
    await expect(recoveryReconciler(scope, h.ports)(input, signal())).rejects.toThrow('RECONCILER_SOURCE_ROLLBACK');
  });
  it('rejects source head and epoch rollback across passes after incomplete catch-up', async () => {
    const h = setup(), reconcile = recoveryReconciler(scope, h.ports);
    h.source.readPage.mockResolvedValue(page(0, { head: 1, epoch: 2 }));
    await expect(reconcile(challenge(), signal())).rejects.toThrow('RECONCILER_PAGE_CAPACITY');
    expect(h.relay.cursor(h.ports.dispatcher)).toBe(0);
    h.source.readPage.mockImplementation(async after => page(after));
    await expect(reconcile(challenge(), signal())).rejects.toThrow('RECONCILER_SOURCE_ROLLBACK');
  });

  it('retains a zero-progress page watermark in SQLite after relay and reconciler reconstruction', async () => {
    const h = setup(); h.source.readPage.mockResolvedValue(page(0, { head: 5, epoch: 3 }));
    await expect(recoveryReconciler(scope, h.ports)(challenge(), signal())).rejects.toThrow('RECONCILER_PAGE_CAPACITY');
    expect(h.relayDb.db.prepare('SELECT cursor,seen_head,seen_epoch FROM library_revoke_meta').get()).toEqual({ cursor: 0, seen_head: 5, seen_epoch: 3 });
    const relay = h.reopenRelay(); expect(relay.sourceWatermark(h.ports.dispatcher)).toEqual({ head: 5, epoch: 3 });
    h.source.readPage.mockImplementation(async after => page(after));
    await expect(recoveryReconciler(scope, { ...h.ports, relay })(challenge(), signal())).rejects.toThrow('RECONCILER_SOURCE_ROLLBACK');
    expect(relay.sourceWatermark(h.ports.dispatcher)).toEqual({ head: 5, epoch: 3 });
    expect(h.source.observe).not.toHaveBeenCalled();
  });
  it('retains a validated observation watermark across a failed pass and relay reconstruction', async () => {
    const h = setup(); h.source.observe.mockResolvedValueOnce(observation({ head: 2, epoch: 3, current: false, state: 'CANCELLED' }));
    await expect(recoveryReconciler(scope, h.ports)(challenge(), signal())).rejects.toThrow('RECONCILER_SOURCE_ROLLBACK');
    const relay = h.reopenRelay(); expect(relay.sourceWatermark(h.ports.dispatcher)).toEqual({ head: 2, epoch: 3 });
    expect(relay.cursor(h.ports.dispatcher)).toBe(0);
    await expect(recoveryReconciler(scope, { ...h.ports, relay })(challenge(), signal())).rejects.toThrow('RECONCILER_SOURCE_ROLLBACK');
    expect(h.source.observe).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['head', { head: 4, epoch: 3 }], ['epoch', { head: 5, epoch: 2 }],
  ] as const)('rejects independent %s rollback after rebuilding relay from SQLite', async (_field, watermark) => {
    const h = setup(); h.relay.observeSource(h.ports.dispatcher, { head: 5, epoch: 3 });
    const relay = h.reopenRelay(); h.source.readPage.mockResolvedValueOnce(page(0, watermark));
    await expect(recoveryReconciler(scope, { ...h.ports, relay })(challenge(), signal())).rejects.toThrow('RECONCILER_SOURCE_ROLLBACK');
    expect(relay.sourceWatermark(h.ports.dispatcher)).toEqual({ head: 5, epoch: 3 });
  });
  it.each(['ALTER TABLE library_revoke_meta ADD COLUMN unexpected TEXT', 'DROP TRIGGER library_revoke_meta_update'])('rejects persisted watermark schema mutation on relay reopen: %s', sql => {
    const h = setup(); h.relay.observeSource(h.ports.dispatcher, { head: 5, epoch: 3 }); h.relayDb.db.exec(sql);
    expect(() => h.reopenRelay()).toThrow('SCHEMA_MISMATCH');
    expect(h.relayDb.db.prepare('SELECT cursor,seen_head,seen_epoch FROM library_revoke_meta').get()).toEqual({ cursor: 0, seen_head: 5, seen_epoch: 3 });
  });
  it.each(['seen_head', 'seen_epoch'])('blocks SQL rollback of retained %s', column => {
    const h = setup(); h.relay.observeSource(h.ports.dispatcher, { head: 5, epoch: 3 });
    expect(() => h.relayDb.db.exec(`UPDATE library_revoke_meta SET ${column}=0`)).toThrow('revocation fence');
    expect(h.reopenRelay().sourceWatermark(h.ports.dispatcher)).toEqual({ head: 5, epoch: 3 });
  });
  it.each([
    { head: 9, epoch: 9, observedAt: 101 },
    { head: 9, epoch: 9, current: true, accepted: true },
    { head: 9, epoch: 9 },
  ])('does not persist an observation watermark before full validation: %j', async overrides => {
    const h = setup(); h.source.observe.mockResolvedValueOnce(observation(overrides));
    await expect(recoveryReconciler(scope, h.ports)(challenge(), signal())).rejects.toThrow();
    expect(h.reopenRelay().sourceWatermark(h.ports.dispatcher)).toEqual({ head: 0, epoch: 1 });
  });

});
