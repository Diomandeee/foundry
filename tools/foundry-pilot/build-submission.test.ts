import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {chmod, lstat, mkdtemp, readFile, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import * as handlers from './build-submission';
import {validateOperatorConfig, type OperatorConfig} from './operator-config';
import {AuthorityTransport} from './transport';
import {safeError} from './private-state';

const inputHash = '1'.repeat(64);
const profileHash = '2'.repeat(64);
const otherProfile = '3'.repeat(64);
const ownerToken = 'synthetic-owner-only-'.repeat(3);
const submitterToken = 'synthetic-submitter-only-'.repeat(3);
const capability = 'synthetic-capability-never-for-browser';
const selection = {projectId: 'fixture-project', inputHash, profileHash};
const identity = {requestId: 'request-original', jobId: 'job-original'};
const submission = {...identity, ...selection, repeat: false};
const recovery = {...identity, ...selection};
type Command = {
  expectedEpoch: number;
  command: {operation: string; key: string; body: {
    id: string; projectId: string; inputHash: string; profileHash: string; maxAttempts: number;
  }};
};
type Journal = {version: number; binding: string; intents: Array<{
  requestId: string; jobId: string; epoch: number; selection: string;
  body: Command['command']['body']; key: string; phase: string; aliases: string[];
}>};

// This fake models accepted commands and lost replies, not actual authority
// execution. No fetch, helper, worker, Docker, VM, or credential file is used.
class FakeAuthority extends AuthorityTransport {
  epoch = 7;
  loseReply = false;
  placementBusy = false;
  replyOverride: unknown;
  calls: Array<{path: string; body: unknown}> = [];
  persistedAtDispatch: Journal[] = [];
  constructor(readonly config: Readonly<OperatorConfig>, readonly accepted = new Map<string, Command>()) {
    super(config);
  }
  override async status(...args: Parameters<AuthorityTransport['status']>) {
    if (args[0] !== this.config.ownerCredentialReference || args[2] !== ownerToken) {
      throw new Error('fake-status-credential-mismatch');
    }
    return {environment: this.config.environment, authorityId: this.config.authorityId, epoch: this.epoch};
  }
  override async request(...args: Parameters<AuthorityTransport['request']>): Promise<unknown> {
    const [reference, path, body, , , , token] = args;
    this.calls.push({path, body: structuredClone(body)});
    if (reference !== this.config.ownerCredentialReference || token !== ownerToken) {
      throw new Error('fake-command-credential-mismatch');
    }
    if (path === '/v1/builds/preview') return {ok: true, eligible: !this.placementBusy, reason: this.placementBusy ? 'busy' : null};
    if (path !== '/v1/builds/commands') throw new Error('unexpected-authority-route');
    this.persistedAtDispatch.push(await readJournal(this.config));
    const command = structuredClone(body) as Command;
    const prior = this.accepted.get(command.command.key);
    if (prior && !isDeepStrictEqual(prior, command)) throw new Error('fake-idempotency-conflict');
    this.accepted.set(command.command.key, command);
    if (this.loseReply) {
      this.loseReply = false;
      throw new Error('synthetic-lost-reply ' + capability);
    }
    return this.replyOverride ?? {
      ok: true,
      source: {environment: this.config.environment, authorityId: this.config.authorityId, epoch: this.epoch},
      capability, ownerToken, commandKey: command.command.key,
    };
  }
}

async function readJournal(config: Readonly<OperatorConfig>): Promise<Journal> {
  return JSON.parse(await readFile(join(config.stateRoot, 'build-submissions.json'), 'utf8'));
}
async function journalBytes(config: Readonly<OperatorConfig>) {
  return readFile(join(config.stateRoot, 'build-submissions.json'), 'utf8');
}
async function reloadHandlers() {
  vi.resetModules();
  return import('./build-submission');
}

describe('build submission handlers with real private journals', () => {
  let config: Readonly<OperatorConfig>;
  let authority: FakeAuthority;
  let environmentNames: string[] = [];

  beforeEach(async () => {
    // Unique environment names cannot resolve any host-managed credentials.
    // Never inspect process.env or credential files to build this fixture.
    const suffix = randomUUID().replaceAll('-', '').toUpperCase();
    environmentNames = ['OWNER', 'SUBMITTER'].map(role => `FOUNDRY_SUBMISSION_TEST_${role}_${suffix}`);
    process.env[environmentNames[0]] = ownerToken;
    process.env[environmentNames[1]] = submitterToken;
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('network-forbidden-in-submission-tests'); }));
    // Resolve macOS /var aliases before exercising canonicalPath. The real
    // private-state module still checks ownership and all ancestor permissions.
    const stateRoot = await mkdtemp(join(await realpath(tmpdir()), 'foundry-submission-test-'));
    await chmod(stateRoot, 0o700);
    config = validateOperatorConfig({
      version: 1, origin: 'https://authority.invalid', environment: 'fixture', authorityId: 'fixture-authority',
      sourceMode: 'local-authority', port: 32100,
      operatorCredentialReference: `FOUNDRY_SUBMISSION_TEST_OPERATOR_${suffix}`,
      ownerCredentialReference: environmentNames[0], submitterCredentialReference: environmentNames[1],
      submitterPrincipal: 'fixture-submitter', verifierPrincipal: 'fixture-verifier', inputAuthorityId: 'fixture-input',
      stateRoot, inputFile: join(stateRoot, 'unused-input.json'), inputSha256: inputHash,
      allowedWorkloadIds: ['fixture-workload'], actionsEnabled: false,
      buildActionsEnabled: true, allowedBuildProfileHashes: [profileHash, otherProfile],
    });
    authority = new FakeAuthority(config);
  });

  afterEach(() => {
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    for (const name of environmentNames) delete process.env[name];
    // Retain only newly created fixture directories: this authorized run does
    // not perform filesystem cleanup, including on failed tests.
  });

  async function leavePending() {
    authority.loseReply = true;
    await expect(handlers.submitBuild(config, authority, submission)).rejects.toMatchObject({
      code: 'build-submit-uncertain-recover-same-selection', status: 503,
    });
    expect((await readJournal(config)).intents[0].phase).toBe('pending');
    return journalBytes(config);
  }

  it('lists a fresh empty journal without submitting anything', async () => {
    expect(await handlers.listBuildIntents(config, authority)).toEqual({ok: true, epoch: 7, limit: 64, intents: []});
    expect(authority.calls).toEqual([]);
    expect(authority.accepted.size).toBe(0);
    await expect(readJournal(config)).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('persists before dispatch and recovers the exact lost-reply identity after module reload, even when placement is busy', async () => {
    await leavePending();
    const original = await readJournal(config);
    expect(authority.persistedAtDispatch).toEqual([original]);
    expect(original.intents).toHaveLength(1);
    expect(original.intents[0]).toMatchObject({...identity, epoch: 7, aliases: [identity.requestId], phase: 'pending'});
    expect((await lstat(config.stateRoot)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(config.stateRoot, 'build-submissions.json'))).mode & 0o777).toBe(0o600);

    const reloaded = await reloadHandlers();
    const freshAuthority = new FakeAuthority(config, authority.accepted);
    freshAuthority.placementBusy = true;
    const listed = await reloaded.listBuildIntents(config, freshAuthority);
    expect(listed).toEqual({ok: true, epoch: 7, limit: 64, intents: [
      {...identity, ...selection, epoch: 7, phase: 'pending', blockedReason: null},
    ]});
    expect(await reloaded.recoverBuild(config, freshAuthority, recovery)).toEqual({
      ok: true, ...identity, replayed: true, ackRequired: true,
    });
    expect(freshAuthority.calls).toEqual(authority.calls);
    expect(freshAuthority.calls.map(call => call.path)).toEqual(['/v1/builds/commands']);
    expect(freshAuthority.accepted.size).toBe(1);
    expect(await readJournal(config)).toEqual({...original, intents: [{...original.intents[0], phase: 'submitted'}]});
    expect(freshAuthority.calls[0].body).toEqual({expectedEpoch: 7, command: {
      operation: 'submit', key: original.intents[0].key,
      body: {id: identity.jobId, ...selection, maxAttempts: 1},
    }});
    await reloaded.recoverBuild(config, freshAuthority, recovery);
    expect(freshAuthority.calls).toHaveLength(1);
  });

  it('a new page request for the same unacknowledged selection reuses the original job and key', async () => {
    await leavePending();
    const before = await readJournal(config);
    const reloaded = await reloadHandlers();
    const freshAuthority = new FakeAuthority(config, authority.accepted);
    expect(await reloaded.submitBuild(config, freshAuthority, {
      ...submission, requestId: 'request-reloaded', jobId: 'job-must-not-be-created', repeat: true,
    })).toEqual({ok: true, ...identity, replayed: true, ackRequired: true});
    expect(freshAuthority.calls).toEqual(authority.calls);
    expect(freshAuthority.accepted.size).toBe(1);
    expect((await readJournal(config)).intents).toEqual([{
      ...before.intents[0], phase: 'submitted', aliases: [identity.requestId, 'request-reloaded'],
    }]);
  });

  it.each([
    {requestId: 'unknown-request'}, {jobId: 'unknown-job'},
    {requestId: 'unknown-request', jobId: 'unknown-job'},
  ])('rejects recovery with unknown or changed IDs %j without allocating an intent', async change => {
    const before = await leavePending();
    await expect(handlers.recoverBuild(config, authority, {...recovery, ...change})).rejects.toMatchObject({
      code: 'build-recovery-not-found', status: 404,
    });
    expect(await journalBytes(config)).toBe(before);
    expect(authority.calls).toHaveLength(1);
  });

  it('does not fall back to submit for recovery against an empty journal', async () => {
    await expect(handlers.recoverBuild(config, authority, recovery)).rejects.toMatchObject({code: 'build-recovery-not-found', status: 404});
    expect(authority.calls).toEqual([]);
    await expect(readJournal(config)).rejects.toMatchObject({code: 'ENOENT'});
  });

  it.each([{projectId: 'other-project'}, {inputHash: '4'.repeat(64)}, {profileHash: otherProfile}])(
    'rejects changed recovery selection %j without changing private state', async change => {
      const before = await leavePending();
      await expect(handlers.recoverBuild(config, authority, {...recovery, ...change})).rejects.toMatchObject({
        code: 'build-recovery-selection-conflict', status: 409,
      });
      expect(await journalBytes(config)).toBe(before);
      expect(authority.calls).toHaveLength(1);
    },
  );

  it('rejects reuse of a submit request ID for a changed selection', async () => {
    const before = await leavePending();
    await expect(handlers.submitBuild(config, authority, {...submission, inputHash: '4'.repeat(64)})).rejects.toMatchObject({
      code: 'build-request-conflict', status: 409,
    });
    expect(await journalBytes(config)).toBe(before);
    expect(authority.calls).toHaveLength(1);
  });

  it('lists an epoch change as blocked and rejects recovery and resubmit without redispatch', async () => {
    const before = await leavePending();
    authority.epoch = 8;
    expect(await handlers.listBuildIntents(config, authority)).toEqual({ok: true, epoch: 8, limit: 64, intents: [
      {...identity, ...selection, epoch: 7, phase: 'pending', blockedReason: 'build-pending-epoch-changed'},
    ]});
    await expect(handlers.recoverBuild(config, authority, recovery)).rejects.toMatchObject({code: 'build-pending-epoch-changed', status: 409});
    await expect(handlers.submitBuild(config, authority, submission)).rejects.toMatchObject({code: 'build-pending-epoch-changed', status: 409});
    expect(await journalBytes(config)).toBe(before);
    expect(authority.calls).toHaveLength(1);
  });

  it.each([
    {buildActionsEnabled: false}, {allowedBuildProfileHashes: [otherProfile]},
  ])('rejects recovery when build policy gates the recorded selection %j', async change => {
    const before = await leavePending();
    await expect(handlers.recoverBuild({...config, ...change}, authority, recovery)).rejects.toMatchObject({code: 'build-actions-gated', status: 403});
    expect(await journalBytes(config)).toBe(before);
    expect(authority.calls).toHaveLength(1);
  });

  it('rejects a changed profile policy binding even if the selected profile remains allowed', async () => {
    const before = await leavePending();
    const changed = {...config, allowedBuildProfileHashes: [profileHash]};
    await expect(handlers.recoverBuild(changed, authority, recovery)).rejects.toMatchObject({code: 'build-journal-binding', status: 409});
    await expect(handlers.listBuildIntents(changed, authority)).rejects.toMatchObject({code: 'build-journal-binding', status: 409});
    expect(await journalBytes(config)).toBe(before);
    expect(authority.calls).toHaveLength(1);
  });

  it('rejects repeat or extra capability fields on the recovery-only endpoint', async () => {
    const before = await leavePending();
    for (const extra of [{repeat: true}, {capability}]) {
      await expect(handlers.recoverBuild(config, authority, {...recovery, ...extra})).rejects.toMatchObject({code: 'pilot-invalid-fields', status: 400});
    }
    expect(await journalBytes(config)).toBe(before);
    expect(authority.calls).toHaveLength(1);
  });

  it.each(['environment', 'authorityId', 'epoch'] as const)('keeps an uncertain intent pending when reply %s is wrong', async field => {
    const source = {environment: config.environment, authorityId: config.authorityId, epoch: 7};
    authority.replyOverride = {ok: true, source: {...source, [field]: field === 'epoch' ? 8 : 'other'}, capability};
    await expect(handlers.submitBuild(config, authority, submission)).rejects.toMatchObject({code: 'build-submit-authority-binding', status: 409});
    expect((await readJournal(config)).intents[0].phase).toBe('pending');
  });

  it('rejects acknowledgment of pending or unknown identity without dropping the intent', async () => {
    const before = await leavePending();
    for (const ids of [identity, {...identity, requestId: 'unknown'}, {...identity, jobId: 'unknown'}]) {
      await expect(handlers.acknowledgeBuild(config, authority, ids)).rejects.toMatchObject({code: 'build-ack-not-submitted', status: 409});
    }
    expect(await journalBytes(config)).toBe(before);
    expect(authority.calls).toHaveLength(1);
  });

  it('acknowledgment can be retried after a lost UI receipt and reload without redispatch or new identity', async () => {
    expect(await handlers.submitBuild(config, authority, submission)).toEqual({ok: true, ...identity, replayed: false, ackRequired: true});
    // Discard the first response as a browser would if its connection closed.
    await handlers.acknowledgeBuild(config, authority, identity);
    const acknowledged = await journalBytes(config);
    const reloaded = await reloadHandlers();
    const freshAuthority = new FakeAuthority(config, authority.accepted);
    expect(await reloaded.acknowledgeBuild(config, freshAuthority, identity)).toEqual({ok: true, jobId: identity.jobId});
    expect(await journalBytes(config)).toBe(acknowledged);
    expect(await reloaded.recoverBuild(config, freshAuthority, recovery)).toEqual({ok: true, ...identity, replayed: true, ackRequired: false});
    expect(await reloaded.submitBuild(config, freshAuthority, submission)).toEqual({ok: true, ...identity, replayed: true, ackRequired: false});
    expect(await reloaded.listBuildIntents(config, freshAuthority)).toEqual({ok: true, epoch: 7, limit: 64, intents: [
      {...identity, ...selection, epoch: 7, phase: 'acknowledged', blockedReason: null},
    ]});
    expect(freshAuthority.calls).toEqual([]);
    expect(freshAuthority.accepted.size).toBe(1);
    expect((await readJournal(config)).intents).toHaveLength(1);
  });

  it.each(['epoch', 'disabled', 'profile-policy'] as const)('rejects acknowledgment after %s changes', async change => {
    await handlers.submitBuild(config, authority, submission);
    const before = await journalBytes(config);
    let changed = config;
    if (change === 'epoch') authority.epoch = 8;
    if (change === 'disabled') changed = {...config, buildActionsEnabled: false};
    if (change === 'profile-policy') changed = {...config, allowedBuildProfileHashes: [otherProfile]};
    await expect(handlers.acknowledgeBuild(changed, authority, identity)).rejects.toMatchObject({
      code: change === 'epoch' ? 'build-pending-epoch-changed' : 'build-journal-binding', status: 409,
    });
    expect(await journalBytes(config)).toBe(before);
    expect(authority.calls).toHaveLength(1);
  });

  it('exposes only public receipts and intent fields, never capabilities, command keys, aliases or credential bindings', async () => {
    authority.loseReply = true;
    const error = await handlers.submitBuild(config, authority, submission).catch(safeError);
    expect(error).toEqual({code: 'build-submit-uncertain-recover-same-selection', status: 503});
    const receipts = [error,
      await handlers.listBuildIntents(config, authority),
      await handlers.recoverBuild(config, authority, recovery),
      await handlers.submitBuild(config, authority, {...submission, requestId: 'private-alias', jobId: 'unused-job'}),
      await handlers.acknowledgeBuild(config, authority, identity),
      await handlers.listBuildIntents(config, authority),
    ];
    const journal = await readJournal(config);
    expect(journal.intents[0].aliases).toContain('private-alias');
    const publicJson = JSON.stringify(receipts);
    for (const secret of [ownerToken, submitterToken, capability, journal.binding, journal.intents[0].key,
      journal.intents[0].selection, 'private-alias', ...environmentNames]) {
      expect(publicJson).not.toContain(secret);
    }
    expect(publicJson).not.toMatch(/"(?:key|aliases|binding|capability|ownerToken|commandKey|body)"/);
    expect(await journalBytes(config)).not.toContain(ownerToken);
    expect(await journalBytes(config)).not.toContain(submitterToken);
    expect(authority.calls).toHaveLength(2);
    expect(authority.accepted.size).toBe(1);
  });
});
