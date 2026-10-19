import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { DurableAuthority } from '../../compute-authority/src/durable/authority';
import type { CommandEnvelope, TrustedContext } from '../../compute-authority/src/durable/contracts';
import { WorkerEnrollment, type ApprovedIdentity } from '../../worker-enrollment/src/index';
import { BuildAuthority } from './authority';
import type { ArtifactClaim, BuildActor, BuildCommand, BuildFence, BuildPorts, BuildProfile, Census, InputApproval, ResultManifest, TransactionPort } from './contracts';
import { bytesHash, hash } from './validation';

const GiB = 1024 ** 3;
const owner: BuildActor = { role: 'owner', principal: 'owner', expectedEpoch: 1 };
const enrollmentOwner = { role: 'owner' as const, principal: 'owner' };
const verifier: BuildActor = { role: 'verifier', principal: 'verifier', expectedEpoch: 1 };
const issuerKey = 'local-build-test-fixture-only-not-a-real-credential';
const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });

function profile(): BuildProfile {
  return {
    version: 1, projectId: 'project', kind: 'linux-build-v1',
    limits: { cpu: 2, ramMib: 2048, estimatedAdditionalBytes: GiB, timeoutMs: 120000, maxOutputBytes: 1048576 },
    recipe: { image: `fixture/build@sha256:${hash('image')}`, architecture: 'x64', tool: 'npm', args: ['run', 'build'], network: 'none' },
    outputPaths: ['dist/result.txt'], trustedProject: true, workerOptInRequired: true,
  };
}

function artifact(bytes: Uint8Array, projectId = 'project'): ArtifactClaim {
  const sha256 = bytesHash(bytes);
  return { grantId: `fixture-${sha256.slice(0,16)}`, ref: { projectId, objectKey: `projects/${projectId}/objects/${sha256}`, generation: '1', sha256, sizeBytes: bytes.length } };
}

function census(workerId = 'worker-a', overrides: Partial<Census> = {}): Census {
  return { workerId, sequence: 1, os: 'linux', architecture: 'x64', freeBytes: 80 * GiB, availableRamMib: 8192,
    xcodeBuilds: [], sdks: [], macos: 'not-applicable', optedIn: true, activeJobs: 0,
    storage: { cacheBytes: 0, workspaceBytes: 0, complete: true }, ...overrides };
}

// Same real SQLite BEGIN/COMMIT/ROLLBACK adapter pattern as library-checkpoint's
// test-support and worker-enrollment's fixture. All SQL goes to Node SQLite;
// no query matching or simulated result rows. Keep this task's helper in its owned file.
function fixture(p = profile()) {
  const db = new DatabaseSync(':memory:');
  closes.push(() => db.close());
  db.exec('PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=OFF');
  let time = 1000, depth = 0, serial = 0;
  const port: TransactionPort = {
    sql: { exec(sql, ...bindings) { return db.prepare(sql).all(...bindings as SQLInputValue[]); } },
    transactionSync(fn) {
      if (depth) return fn();
      db.exec('BEGIN IMMEDIATE'); depth++;
      try { const result = fn(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
      finally { depth--; }
    },
  };
  const now = () => time;
  // Initialize inherited production schemas and seed through their real APIs,
  // including enrollment audit, digest authentication and heartbeat constraints.
  const legacy = new DurableAuthority(port, { environment: 'test', authorityId: 'local', issuerId: 'fixture', issuerKey, now });
  const enrollment = new WorkerEnrollment(port, { environment: 'test', authorityId: 'local', now });
  const bytes = new Map<string, Uint8Array>();
  let duringRead: (() => void) | undefined;
  const readArtifact: NonNullable<BuildPorts['readArtifact']> = async (claim, scope, signal) => {
    expect(depth).toBe(0);
    expect(signal.aborted).toBe(false);
    expect(scope.projectId).toBe(claim.ref.projectId);
    expect(row('build_attempts', scope.attemptId)?.worker).toBe(scope.workerId);
    duringRead?.();
    const value = bytes.get(claim.ref.sha256);
    if (!value) throw new Error('fixture-object-unavailable');
    return value;
  };
  let core = new BuildAuthority(port, 'test', 'local', { issuerKey, now, readArtifact });
  const run = <O extends BuildCommand['operation']>(operation: O, body: Extract<BuildCommand, { operation: O }>['body'], actor = owner, key = `command-${++serial}`) =>
    core.execute(actor, { operation, key, body } as BuildCommand);
  const legacyRun = (command: CommandEnvelope, actor: TrustedContext = owner) => legacy.execute(actor, command);
  const rows = (table: string) => db.prepare(`SELECT * FROM ${table}`).all();
  const row = (table: string, id: string) => db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
  const input: InputApproval = { projectId: 'project', snapshotHash: hash('snapshot'),
    manifest: artifact(new TextEncoder().encode('fixture input manifest')).ref,
    git: { remote: null, revision: null, historyPreserved: false }, requiredInputs: ['package.json'], missingInputs: [], reconstructable: true };
  const profileHash = run('approveProfile', p).profileHash as string;
  const inputHash = run('approveInput', input).inputHash as string;
  const addWorker = (id = 'worker-a', preference = 50, changes: Partial<ApprovedIdentity> = {}, report: Partial<Census> = {}) => {
    const identity: ApprovedIdentity = { workerId: id, principal: `executor-${id}`, workerClass: 'general', cpu: 4, ramMib: 8192, devices: [], ...changes };
    expect(legacyRun({ operation: 'registerWorker', key: `register-${id}`, body: identity }).ok).toBe(true);
    const digest = hash(['fixture-enrollment', id]);
    enrollment.enroll(enrollmentOwner, { ...identity, key: `enroll-${id}`, tokenSha256: digest, expiresAt: 10000000, expectedRevision: 0, incarnation: 0 });
    const binding = enrollment.authenticateDigest(digest)!;
    expect(binding).not.toBeNull();
    enrollment.heartbeat(binding, { key: `heartbeat-${id}`, sequence: 1, observedIdentity: identity });
    const actor: BuildActor = { ...binding, expectedEpoch: 1 };
    run('approveWorker', { workerId: id, revision: 1, profileHash, preference });
    if (identity.workerClass === 'general') run('census', census(id, report), actor);
    return actor;
  };
  const executor = addWorker();
  const submit = (id = 'job') => run('submit', { id, projectId: 'project', profileHash, inputHash, maxAttempts: 3 });
  const claim = (id = 'job', actor = executor, key?: string) => run('claim', { jobId: id }, actor, key).attempt;
  const fence = (a: Record<string, any>): BuildFence => ({ attemptId: a.id, epoch: a.epoch, generation: a.generation, incarnation: a.incarnation, capability: a.capability });
  const stop = (a: Record<string, any>, confirmed = true, outcome: Extract<BuildCommand, {operation:'stopped'}>['body']['outcome'] = 'completed', key?: string) =>
    run('stopped', { ...fence(a), confirmed, outcome, proofHash: hash(['fixture-stop', a.id, confirmed, outcome]) }, executor, key);
  const put = (value: Uint8Array) => { const claim = artifact(value); bytes.set(claim.ref.sha256, value); return claim; };
  const manifest = (a: Record<string, any>) => {
    const output = new TextEncoder().encode('actual fixture artifact bytes');
    const body: ResultManifest = { version: 1, jobId: a.jobId, attemptId: a.id, inputHash, profileHash, exitCode: 0,
      outputs: [{ path: 'dist/result.txt', format: 'file', sha256: bytesHash(output), sizeBytes: output.length, chunks: [put(output)] }], logs: [] };
    return put(new TextEncoder().encode(JSON.stringify(body)));
  };
  return { db, port, legacyRun, enrollment, executor, profileHash, inputHash, input, run, rows, row, addWorker, submit, claim, fence, stop, manifest,
    get core() { return core; }, at(value: number) { time = value; },
    restart() { core = new BuildAuthority(port, 'test', 'local', { issuerKey, now, readArtifact }); },
    onRead(fn: () => void) { duringRead = fn; } };
}

describe('BuildAuthority with inherited authority/enrollment and actual local SQLite', () => {
  it.each([
    {environment:'wrong',authorityId:'local',jobId:'job'},
    {environment:'test',authorityId:'wrong',jobId:'job'},
    {environment:'test',authorityId:'local',jobId:'other-job'},
  ])('rejects a mismatched verification target before any mutation or artifact read: %j',async target=>{
    const f=fixture();f.submit();const a=f.claim();f.stop(a);
    f.run('stage',{...f.fence(a),manifest:f.manifest(a)},f.executor);
    const tables=['build_meta','build_attempts','build_jobs','build_receipts','build_events'];
    const before=tables.map(t=>f.rows(t));let reads=0;f.onRead(()=>{reads++;});f.at(1100);
    await expect(f.core.verify(verifier,a.id,()=>{},target)).rejects.toThrow(/verification-(authority|job)-mismatch/);
    expect(reads).toBe(0);expect(tables.map(t=>f.rows(t))).toEqual(before);
  });
  it('binds successful verification and its replay to the exact target',async()=>{
    const f=fixture();f.submit();const a=f.claim();f.stop(a);
    f.run('stage',{...f.fence(a),manifest:f.manifest(a)},f.executor);
    const target={environment:'test',authorityId:'local',jobId:'job'};
    expect(await f.core.verify(verifier,a.id,()=>{},target)).toMatchObject({verified:true,jobId:'job',attemptId:a.id});
    expect(await f.core.verify(verifier,a.id,()=>{},target)).toMatchObject({verified:true,replayed:true});
    const before=f.rows('build_receipts');
    await expect(f.core.verify(verifier,a.id,()=>{},{...target,jobId:'wrong'})).rejects.toThrow('verification-job-mismatch');
    expect(f.rows('build_receipts')).toEqual(before);
  });
  it('snapshots the approved verification target across artifact awaits',async()=>{
    const f=fixture();f.submit();const a=f.claim();f.stop(a);
    f.run('stage',{...f.fence(a),manifest:f.manifest(a)},f.executor);
    const target={environment:'test',authorityId:'local',jobId:'job'};
    f.onRead(()=>{target.jobId='changed-by-caller';});
    expect(await f.core.verify(verifier,a.id,()=>{},target)).toMatchObject({verified:true,jobId:'job'});
  });

  it('seeds real enrollment and preserves legacy tables while initializing build tables', () => {
    const f = fixture();
    expect(f.db.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 });
    expect(f.rows('authority_meta')).toEqual([expect.objectContaining({ epoch: 1, environment: 'test', authority_id: 'local' })]);
    expect(f.rows('enrollment_credentials')).toEqual([expect.objectContaining({ worker_id: 'worker-a', revision: 1, incarnation: 0, sequence: 1, last_seen: 1000 })]);
    expect(f.rows('enrollment_events')).toHaveLength(1);
    const before = f.rows('workers'); f.restart(); expect(f.rows('workers')).toEqual(before);
    expect(f.rows('build_profiles')).toHaveLength(1);
    expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('replays a claim across authority reconstruction with one attempt/event and no persisted capability', () => {
    const f = fixture(); f.submit(); const a = f.claim('job', f.executor, 'claim');
    const events = f.rows('build_events'); f.restart();
    expect(f.claim('job', f.executor, 'claim')).toEqual(a);
    expect(f.rows('build_events')).toEqual(events);
    expect(f.rows('build_attempts')).toHaveLength(1);
    expect(f.row('build_jobs', 'job')).toMatchObject({ attempts: 1, generation: 0, state: 'RUNNING' });
    for (const table of ['build_commands', 'build_events', 'build_attempts']) expect(JSON.stringify(f.rows(table))).not.toContain(a.capability);
    expect(JSON.stringify(f.core.feed(owner))).not.toContain(a.capability);
    expect(() => f.claim('job')).toThrow('job-not-queued');
    expect(() => f.claim('another-job', f.executor, 'claim')).toThrow('build-key-conflict');
    expect(f.rows('build_attempts')).toHaveLength(1);
  });

  it('makes submit idempotent, rejects conflicting content and rolls back a rejected new command', () => {
    const f = fixture();
    const job = { id: 'job', projectId: 'project', profileHash: f.profileHash, inputHash: f.inputHash, maxAttempts: 3 };
    const reply = f.run('submit', job, owner, 'submit');
    expect(f.run('submit', job, owner, 'submit')).toEqual(reply);
    expect(() => f.run('submit', { ...job, maxAttempts: 2 }, owner, 'submit')).toThrow('build-key-conflict');
    const before = ['build_jobs', 'build_commands', 'build_events'].map(t => f.rows(t));
    expect(() => f.run('submit', { ...job, id: 'bad', projectId: 'other' }, owner, 'retry')).toThrow('project-input-profile-binding');
    expect(['build_jobs', 'build_commands', 'build_events'].map(t => f.rows(t))).toEqual(before);
    expect(f.run('submit', { ...job, id: 'good' }, owner, 'retry')).toEqual({ ok: true });
  });

  it('caps sequential renewals and commits expiry even when the triggering renewal rejects', () => {
    const f = fixture(); f.submit(); const a = f.claim();
    expect(a).toMatchObject({ issuedAt: 1000, expiresAt: 61000, capAt: 121000, sequence: 0 });
    f.at(31000);
    const body = { ...f.fence(a), sequence: 1 };
    expect(f.run('renew', body, f.executor, 'renew-1')).toEqual({ ok: true, expiresAt: 91000, sequence: 1 });
    f.at(41000);
    expect(f.run('renew', body, f.executor, 'renew-1').expiresAt).toBe(91000);
    expect(() => f.run('renew', { ...body, sequence: 2 }, f.executor, 'renew-1')).toThrow('build-key-conflict');
    f.at(81000);
    expect(f.run('renew', { ...body, sequence: 2 }, f.executor, 'renew-2').expiresAt).toBe(121000);
    expect(() => f.run('renew', body, f.executor, 'renew-1')).toThrow('renewal-sequence');
    expect(f.rows('build_live_commands').filter(r => r.operation === 'renew')).toHaveLength(1);
    f.at(121000);
    expect(() => f.run('renew', { ...body, sequence: 3 }, f.executor)).toThrow('expired-build-lease');
    expect(f.row('build_attempts', a.id)).toMatchObject({ state: 'EXPIRED', slot_held: 1, stopped: 0, expires_ms: 121000 });
    expect(f.row('build_jobs', 'job')).toMatchObject({ state: 'FAILED', attempts: 1 });
    f.at(1100); f.restart();
    expect(f.rows('build_meta')[0].clock_ms).toBe(121000);
    expect(f.core.observeFence(owner, a.id)).toMatchObject({ valid: false, permanentlyRevoked: true, observedAt: 121000 });
    expect(() => f.claim('job', f.executor, 'claim-after-expiry')).toThrow('job-not-queued');
    expect(() => f.run('renew', body, f.executor, 'renew-1')).toThrow('expired-build-lease');
    expect(f.rows('build_events').filter(r => r.kind === 'expired-stop-required')).toHaveLength(1);
  });

  it('shows effective expiry at the exact TTL boundary and persists it before rejecting claim replay', () => {
    const f = fixture(); f.submit(); const a = f.claim('job', f.executor, 'claim');
    f.at(60999); expect(f.core.observeFence(owner, a.id).permanentlyRevoked).toBe(false);
    f.at(61000);
    expect(f.core.feed(owner).attempts[0]).toMatchObject({ state: 'RUNNING', effectiveState: 'EXPIRED', slotHeld: true });
    expect(() => f.claim('job', f.executor, 'claim')).toThrow('claim-replay-expired');
    f.at(1000); f.restart();
    expect(() => f.claim('job', f.executor, 'claim')).toThrow('claim-replay-expired');
    expect(f.row('build_attempts', a.id)).toMatchObject({ state: 'EXPIRED', stopped: 0, slot_held: 1 });
  });

  it('cancellation remains terminal on clock rollback and holds the slot until explicit stop', () => {
    const f = fixture(); f.submit(); const a = f.claim('job', f.executor, 'claim');
    f.at(2000); f.run('cancel', { jobId: 'job' }, owner, 'cancel');
    const events = f.rows('build_events');
    f.at(1000); f.restart();
    expect(f.run('cancel', { jobId: 'job' }, owner, 'cancel')).toEqual({ ok: true });
    expect(f.rows('build_events')).toEqual(events);
    expect(f.row('build_attempts', a.id)).toMatchObject({ state: 'CANCELLED', slot_held: 1, stopped: 0 });
    expect(f.core.observeFence(owner, a.id)).toMatchObject({ valid: false, permanentlyRevoked: true });
    expect(() => f.claim('job', f.executor, 'claim')).toThrow('claim-replay-expired');
    expect(() => f.run('renew', { ...f.fence(a), sequence: 1 }, f.executor)).toThrow('expired-build-lease');
    expect(() => f.run('stage', { ...f.fence(a), manifest: f.manifest(a) }, f.executor)).toThrow('expired-build-lease');
    f.submit('next'); expect(() => f.claim('next')).toThrow('host-slot-occupied');
    f.stop(a, true, 'cancelled');
    expect(f.row('build_jobs', 'job')?.state).toBe('CANCELLED');
    expect(() => f.run('requeue', { jobId: 'job', expectedGeneration: 0 })).toThrow('requeue-state');
    expect(f.claim('next').jobId).toBe('next');
  });

  it('requires confirmed stop before staging; staging alone produces no accepted result', async () => {
    const f = fixture(); f.submit(); const a = f.claim(), manifest = f.manifest(a);
    const body = { ...f.fence(a), manifest };
    expect(() => f.run('stage', body, f.executor, 'stage')).toThrow('confirmed-stop-required');
    expect(f.row('build_attempts', a.id)).toMatchObject({ state: 'RUNNING', manifest: null, stopped: 0, slot_held: 1 });
    f.stop(a, true, 'completed', 'stop');
    expect(f.row('build_attempts', a.id)).toMatchObject({ state: 'RUNNING', stopped: 1, slot_held: 0 });
    expect(f.run('stage', body, f.executor, 'stage')).toEqual({ ok: true, staged: true, verified: false });
    expect(f.run('stage', body, f.executor, 'stage')).toEqual({ ok: true, staged: true, verified: false });
    expect(f.rows('build_receipts')).toEqual([]);
    expect(() => f.core.accepted(owner, 'job')).toThrow('verified-result-unavailable');
    expect(await f.core.verify(verifier, a.id, () => {})).toMatchObject({ verified: true, jobId: 'job', attemptId: a.id });
    expect(f.core.accepted(owner, 'job')).toMatchObject({ verifier: 'verifier', manifest: { attemptId: a.id, inputHash: f.inputHash, profileHash: f.profileHash } });
    expect(f.rows('build_receipts')).toHaveLength(1);
    expect(await f.core.verify(verifier, a.id, () => {})).toMatchObject({ verified: true, replayed: true });
  });

  it('retains uncertain-stop occupancy, forbids duplicate/reassigned attempts, then fences the reconciled generation', () => {
    const f = fixture(), other = f.addWorker('worker-b', 40);
    f.submit(); const a = f.claim(); f.stop(a, false, 'lease-lost', 'uncertain');
    const events = f.rows('build_events');
    expect(f.stop(a, false, 'lease-lost', 'uncertain')).toEqual({ ok: true });
    expect(f.rows('build_events')).toEqual(events);
    expect(() => f.stop(a, false, 'lease-lost', 'duplicate')).toThrow('uncertain-stop-already-recorded');
    expect(f.row('build_attempts', a.id)).toMatchObject({ state: 'EXPIRED', slot_held: 1, stopped: 0, negative_reported: 1 });
    expect(() => f.claim('job', other)).toThrow('job-not-queued');
    expect(() => f.run('requeue', { jobId: 'job', expectedGeneration: 0 })).toThrow('stop-reconciliation-required');
    expect(() => f.run('stage', { ...f.fence(a), manifest: f.manifest(a) }, f.executor)).toThrow('expired-build-lease');
    f.submit('other-job'); expect(() => f.claim('other-job')).toThrow('host-slot-occupied');
    expect(f.rows('build_attempts')).toHaveLength(1);
    // Independent jobs can use other hosts; the uncertain job cannot be duplicated.
    expect(f.core.next(other, f.profileHash).job.id).toBe('other-job');
    const reconciliation = { attemptId: a.id, proofHash: hash('owner-observed-stop-fixture') };
    expect(() => f.run('reconcile', reconciliation, f.executor)).toThrow('build-operation-forbidden');
    f.run('reconcile', reconciliation, owner, 'reconcile');
    expect(f.run('reconcile', reconciliation, owner, 'reconcile')).toEqual({ ok: true });
    f.run('requeue', { jobId: 'job', expectedGeneration: 0 }, owner, 'requeue');
    expect(f.run('requeue', { jobId: 'job', expectedGeneration: 0 }, owner, 'requeue')).toEqual({ ok: true });
    expect(f.row('build_jobs', 'job')).toMatchObject({ generation: 1, attempts: 1, state: 'QUEUED' });
    const b = f.claim(); expect(b).toMatchObject({ generation: 1, slotHeld: true }); expect(b.id).not.toBe(a.id);
    expect(() => f.run('renew', { ...f.fence(a), sequence: 1 }, f.executor)).toThrow('expired-build-lease');
    expect(f.rows('build_attempts')).toHaveLength(2);
    expect(f.row('build_attempts', a.id)).toMatchObject({ stopped: 1, slot_held: 0, state: 'EXPIRED' });
  });

  it('enforces the attempt limit after three independently stopped failures', () => {
    const f = fixture(); f.submit();
    for (let generation = 0; generation < 3; generation++) {
      const a = f.claim(); expect(a.generation).toBe(generation); f.stop(a, true, 'failed');
      if (generation < 2) f.run('requeue', { jobId: 'job', expectedGeneration: generation });
    }
    expect(() => f.run('requeue', { jobId: 'job', expectedGeneration: 2 })).toThrow('attempt-limit');
    expect(f.row('build_jobs', 'job')).toMatchObject({ attempts: 3, generation: 2, state: 'FAILED' });
    expect(f.rows('build_attempts').every(a => a.slot_held === 0)).toBe(true);
  });

  it('uses a separate verification deadline and prevents resurrection after its exact boundary', async () => {
    const f = fixture(); f.submit(); const a = f.claim(); f.stop(a);
    f.run('stage', { ...f.fence(a), manifest: f.manifest(a) }, f.executor);
    f.at(61000); expect(f.core.observeFence(owner, a.id)).toMatchObject({ state: 'VERIFYING', valid: true, expiresAt: 901000 });
    f.at(901000); await expect(f.core.verify(verifier, a.id, () => {})).rejects.toThrow('verification-state');
    f.at(1000); f.restart();
    expect(f.row('build_attempts', a.id)).toMatchObject({ state: 'EXPIRED', stopped: 1, slot_held: 0 });
    expect(f.core.observeFence(owner, a.id)).toMatchObject({ valid: false, permanentlyRevoked: true });
    expect(f.rows('build_receipts')).toEqual([]);
  });

  it('rechecks cancellation after actual artifact reads and cannot publish a winner', async () => {
    const f = fixture(); f.submit(); const a = f.claim(); f.stop(a);
    f.run('stage', { ...f.fence(a), manifest: f.manifest(a) }, f.executor);
    f.onRead(() => { f.run('cancel', { jobId: 'job' }, owner, 'during-read-cancel'); });
    await expect(f.core.verify(verifier, a.id, () => {})).rejects.toThrow('verification-fenced');
    expect(f.row('build_jobs', 'job')).toMatchObject({ state: 'CANCELLED', winner: null });
    expect(f.rows('build_receipts')).toEqual([]);
  });

  it.each([
    ['disk reserve', { freeBytes: 51 * GiB - 1 }, 'disk-headroom-below-50GiB'],
    ['available RAM', { availableRamMib: 2047 }, 'available-memory-insufficient'],
    ['opt-in', { optedIn: false }, 'worker-opt-in-required'],
    ['active job', { activeJobs: 1 }, 'host-busy'],
    ['OS', { os: 'darwin' }, 'linux-required'],
    ['architecture', { architecture: 'arm64' }, 'architecture-mismatch'],
    ['incomplete inventory', { storage: { cacheBytes: 0, workspaceBytes: 0, complete: false } }, 'managed-storage-inventory-incomplete'],
    ['unknown cache', { storage: { cacheBytes: null, workspaceBytes: 0, complete: true } }, 'managed-storage-inventory-incomplete'],
    ['oversized cache', { storage: { cacheBytes: 20 * GiB + 1, workspaceBytes: 0, complete: true } }, 'managed-cache-exceeds-20GiB'],
  ] as const)('matches %s in both read-only preview and transactional admission', (_label, report, reason) => {
    const f = fixture(); f.at(2000); f.run('census', census('worker-a', { ...report, sequence: 2 }), f.executor); f.submit();
    const before = f.rows('build_meta');
    expect(f.core.preview(owner, 'job')[0]).toMatchObject({ eligible: false, reasons: expect.arrayContaining([reason]) });
    expect(f.core.previewDraft(owner, f.profileHash, f.inputHash)[0]).toMatchObject({ eligible: false, reasons: expect.arrayContaining([reason]) });
    expect(f.rows('build_meta')).toEqual(before);
    expect(f.core.next(f.executor, f.profileHash).job).toBeNull();
    expect(() => f.claim()).toThrow(reason); expect(f.rows('build_attempts')).toEqual([]);
  });

  it('accepts exact disk/RAM/cache boundaries and honors preference with lexical ties', () => {
    const f = fixture(); const preferred = f.addWorker('worker-b', 80, {}, { freeBytes: 51 * GiB, availableRamMib: 2048, storage: { cacheBytes: 20 * GiB, workspaceBytes: 0, complete: true } });
    const tied = f.addWorker('worker-c', 80); f.submit();
    expect(f.core.preview(owner, 'job').every(w => w.eligible)).toBe(true);
    expect(f.core.next(f.executor, f.profileHash).job).toBeNull();
    expect(f.core.next(tied, f.profileHash).job).toBeNull();
    expect(f.core.next(preferred, f.profileHash).job.id).toBe('job');
    expect(() => f.claim()).toThrow('higher-preference-worker-eligible');
    const result = f.run('claim', { jobId: 'job' }, preferred);
    expect(result.placement).toMatchObject({ selectedWorker: 'worker-b', selectedPreference: 80, policy: 'owner-preference-v1', observedAt: 1000 });
    expect(result.attempt.workerId).toBe('worker-b');
    expect(result.placement.candidates.find((c: any) => c.workerId === 'worker-b')).toMatchObject({ eligible: true, facts: { freeBytes: 51 * GiB, availableRamMib: 2048 } });
  });

  it.each(['cpu', 'ramMib'] as const)('does not substitute census capacity for owner-approved %s', field => {
    const p = profile(); p.limits[field] = field === 'cpu' ? 5 : 8193;
    const f = fixture(p); f.at(2000); f.run('census', census('worker-a', { sequence: 2, availableRamMib: 65536 }), f.executor); f.submit();
    expect(f.core.preview(owner, 'job')[0]).toMatchObject({ eligible: false, reasons: ['approved-capacity-insufficient'] });
    expect(() => f.claim()).toThrow('approved-capacity-insufficient');
  });

  it('excludes edge workers and rejects census at the exact 30-second freshness boundary', () => {
    const f = fixture(); f.addWorker('edge', 100, { workerClass: 'edge', cpu: 0, ramMib: 0 }); f.submit();
    expect(f.core.preview(owner, 'job').find(w => w.workerId === 'edge')).toMatchObject({ eligible: false, reasons: expect.arrayContaining(['edge-heartbeat-only']) });
    f.at(30999); expect(f.core.next(f.executor, f.profileHash).job.id).toBe('job');
    f.at(31000); expect(f.core.next(f.executor, f.profileHash).job).toBeNull();
    expect(() => f.claim()).toThrow('census-stale-or-incarnation-mismatch');
    f.run('census', census('worker-a', { sequence: 2 }), f.executor);
    expect(f.claim().workerId).toBe('worker-a');
  });

  it('requires a fresh unrevoked enrollment even with a fresh build census', () => {
    const f = fixture(); f.submit(); f.at(61000);
    f.run('census', census('worker-a', { sequence: 2 }), f.executor);
    expect(() => f.claim()).toThrow('profile-not-approved');
    f.enrollment.revoke(enrollmentOwner, { key: 'revoke', workerId: 'worker-a', revision: 1 });
    expect(f.core.preview(owner, 'job')[0]).toMatchObject({ eligible: false, reasons: ['profile-not-approved'] });
    expect(() => f.claim()).toThrow('profile-not-approved');
    expect(f.rows('build_attempts')).toEqual([]);
  });

  it('respects real legacy reservations and prevents legacy placement on an occupied build host', () => {
    const f = fixture(); f.submit();
    expect(f.legacyRun({ operation: 'setQuota', key: 'quota', body: { principal: 'owner', maxActive: 10, allowedClass: 'general' } }).ok).toBe(true);
    const submitLegacy = (id: string) => f.legacyRun({ operation: 'submit', key: `submit-${id}`, body: { workloadId: id, specification: 'fixed-cpu-v1', resources: { cpu: 1, ramMib: 128 }, policy: { sha256: hash('legacy-output'), maxBytes: 100, exitCode: 0 }, pure: true, reconstructible: true, maxAttempts: 3 } });
    const claimLegacy = (id: string) => f.legacyRun({ operation: 'claim', key: `claim-${id}`, body: { workloadId: id, workerId: 'worker-a', expectedGeneration: 0, incarnation: 0, ttlMs: 60000 } }, { role: 'executor', principal: f.executor.principal, expectedEpoch: 1 });
    expect(submitLegacy('legacy').ok).toBe(true); expect(claimLegacy('legacy').ok).toBe(true);
    expect(f.rows('reservations')).toEqual([expect.objectContaining({ worker_id: 'worker-a', state: 'held' })]);
    expect(() => f.claim()).toThrow('host-slot-occupied');
    expect(f.rows('build_attempts')).toEqual([]);
    const g = fixture(); g.submit(); g.claim();
    expect(g.legacyRun({ operation: 'setQuota', key: 'quota', body: { principal: 'owner', maxActive: 10, allowedClass: 'general' } }).ok).toBe(true);
    expect(g.legacyRun({ operation: 'submit', key: 'submit-legacy', body: { workloadId: 'legacy', specification: 'fixed-cpu-v1', resources: { cpu: 1, ramMib: 128 }, policy: { sha256: hash('legacy-output'), maxBytes: 100, exitCode: 0 }, pure: true, reconstructible: true, maxAttempts: 3 } }).ok).toBe(true);
    expect(() => g.legacyRun({ operation: 'claim', key: 'claim-legacy', body: { workloadId: 'legacy', workerId: 'worker-a', expectedGeneration: 0, incarnation: 0, ttlMs: 60000 } }, { role: 'executor', principal: g.executor.principal, expectedEpoch: 1 })).toThrow('build host occupied');
    expect(g.rows('reservations')).toEqual([]); expect(g.rows('leases')).toEqual([]);
    expect(g.rows('build_attempts')).toHaveLength(1);
    expect(g.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
