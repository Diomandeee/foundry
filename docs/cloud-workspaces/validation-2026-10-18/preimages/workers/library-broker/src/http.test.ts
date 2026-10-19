import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonical } from '../../../packages/library-jobs/src/data';
import { createStorageBroker, type BrokerPorts, type ReadGrant } from '../../../packages/storage-broker/src/index';
import type { Delivery } from '../../../packages/library-revocation/src/index';
import { brokerHandler, type BrokerHost } from './index';

const payload = new TextEncoder().encode('immutable broker HTTP fixture');
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const executorToken = 'e'.repeat(40), ownerToken = 'o'.repeat(40), otherToken = 'x'.repeat(40);
const cleanup: (() => void)[] = [];
afterEach(() => { vi.useRealTimers(); cleanup.splice(0).reverse().forEach(close => close()); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function fixture() {
  const db = new DatabaseSync(':memory:'); cleanup.push(() => db.close());
  const grant: ReadGrant = {
    version: 1, grantId: 'grant-1', principalRef: 'worker-principal', projectId: 'project-1',
    policyVersion: 'policy-1', policyHash: 'a'.repeat(64), intentId: 'intent-1', authorizationGeneration: 1,
    operation: 'GET', compute: { authorityId: 'compute-1', workloadId: 'work-1', leaseId: 'lease-1', attemptId: 'attempt-1',
      epoch: 1, generation: 0, incarnation: 0, workerId: 'worker-1', capabilityDigest: 'b'.repeat(64) },
    object: { projectId: 'project-1', objectKey: `projects/project-1/objects/${hash(payload)}`, generation: '123', sha256: hash(payload), sizeBytes: payload.length },
    byteBudget: payload.length * 4, expiresAt: 100_000,
  };
  let revoked = false;
  const observeCurrent = vi.fn((g: ReadGrant) => ({ grant: g, status: 'authorized', revoked, observedAt: 1000, expiresAt: g.expiresAt }));
  const readObject = vi.fn<BrokerPorts['readObject']>(async ref => ({ ref, bytes: payload }));
  const broker = createStorageBroker({ db, binding: { environment: 'test', authorityId: 'broker-1' }, now: () => 1000, observeCurrent, readObject });
  broker.admin.issue(grant);
  const authConfig = JSON.stringify([
    { tokenSha256: hash(executorToken), principal: grant.principalRef, role: 'executor', environment: 'test' },
    { tokenSha256: hash(ownerToken), principal: 'owner', role: 'owner', environment: 'test' },
    { tokenSha256: hash(otherToken), principal: 'other-worker', role: 'executor', environment: 'test' },
  ]);
  const lookup = vi.fn((id: string) => { if (id !== grant.grantId) throw new Error('not found'); return grant; });
  const refresh = vi.fn<BrokerHost['refresh']>(async () => {});
  const host: BrokerHost = { environment: 'test', authorityId: 'broker-1', ownerPrincipal: 'owner', enabled: true, authConfig, broker, grant: lookup, refresh };
  return { db, grant, host, handle: brokerHandler(host), lookup, refresh, readObject, observeCurrent, revokeObservation: () => { revoked = true; } };
}
const readBody = { grantId: 'grant-1', requestId: 'request-1' };
function request(body: unknown = readBody, token = executorToken, path = '/v1/broker/read', media = 'application/json') {
  return new Request('https://broker.test' + path, { method: 'POST', headers: { 'content-type': media, authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
}
function delivery(g: ReadGrant): Delivery {
  const event: Delivery['event'] = { seq: 1, kind: 'lease-revoked', epoch: g.compute.epoch, leaseId: g.compute.leaseId,
    workloadId: g.compute.workloadId, workerId: g.compute.workerId, generation: g.compute.generation, incarnation: g.compute.incarnation };
  return { version: 1, deliveryId: 'd'.repeat(64), key: 'd'.repeat(64), revision: 1,
    evidenceId: hash(canonical({ source: g.compute.authorityId, event })), event,
    target: { version: 1, targetId: 'broker-target', kind: 'broker', environment: 'test', authorityId: 'broker-1', projectId: g.projectId,
      resourceId: g.grantId, generation: g.authorizationGeneration,
      binding: { projectId: g.projectId, policyVersion: g.policyVersion, policyHash: g.policyHash, compute: g.compute,
        content: { manifestHash: 'c'.repeat(64), objectHash: g.object.sha256, objectKey: g.object.objectKey, objectGeneration: g.object.generation, bytes: g.object.sizeBytes } } } };
}
async function failure(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ ok: false, code });
}

describe('broker HTTP with real in-memory SQLite', () => {
  it('returns only the pinned bytes for the authenticated grant principal', async () => {
    const h = fixture(), response = await h.handle(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(payload);
    expect(h.refresh).toHaveBeenCalledWith(h.grant, expect.any(AbortSignal));
    expect(h.readObject).toHaveBeenCalledWith(h.grant.object, payload.length, expect.any(AbortSignal));
    expect(h.db.prepare('SELECT state,size FROM reads').get()).toEqual({ state: 'completed', size: payload.length });
  });
  it.each(['digest', 'generation'] as const)('withholds invalid provider %s and never seals its bytes', async mismatch => {
    const h = fixture();
    h.readObject.mockImplementation(async ref => mismatch === 'digest'
      ? { ref, bytes: new Uint8Array(payload.length) }
      : { ref: { ...ref, generation: '999' }, bytes: payload });
    await failure(await h.handle(request()), 503, 'broker-unavailable');
    expect(h.db.prepare('SELECT state,bytes FROM reads').get()).toEqual({ state: 'unknown', bytes: null });
  });
  it.each([
    ['http://broker.test/v1/broker/read', 'POST', 400, 'invalid-origin'],
    ['https://broker.test/v1/broker/read?url=elsewhere', 'POST', 400, 'invalid-origin'],
    ['https://broker.test/v1/broker/read', 'GET', 405, 'post-required'],
    ['https://broker.test/v1/broker/issue', 'POST', 404, 'not-found'],
  ] as const)('rejects unsupported route %s %s', async (url, method, status, code) => {
    const h = fixture(); await failure(await h.handle(new Request(url, { method })), status, code);
    expect(h.lookup).not.toHaveBeenCalled(); expect(h.refresh).not.toHaveBeenCalled();
  });
  it('refreshes and rechecks cached replay without a second provider read', async () => {
    const h = fixture(); expect((await h.handle(request())).status).toBe(200);
    const observations = h.observeCurrent.mock.calls.length;
    const replay = await h.handle(request());
    expect(new Uint8Array(await replay.arrayBuffer())).toEqual(payload);
    expect(h.refresh).toHaveBeenCalledTimes(2); expect(h.readObject).toHaveBeenCalledTimes(1);
    expect(h.observeCurrent.mock.calls.length).toBeGreaterThan(observations);
    h.refresh.mockImplementationOnce(async () => h.revokeObservation());
    await failure(await h.handle(request()), 503, 'broker-unavailable');
    expect(h.refresh).toHaveBeenCalledTimes(3); expect(h.readObject).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['missing bearer', '', '/v1/broker/read', 401, 'unauthorized'],
    ['owner cannot read', ownerToken, '/v1/broker/read', 403, 'role-forbidden'],
    ['executor cannot administer', executorToken, '/v1/broker/revocations', 403, 'role-forbidden'],
  ])('%s', async (_name, token, path, status, code) => {
    const h = fixture(); await failure(await h.handle(request(readBody, token, path)), Number(status), String(code));
    expect(h.refresh).not.toHaveBeenCalled(); expect(h.readObject).not.toHaveBeenCalled();
  });
  it('rejects a non-owned grant before privileged refresh', async () => {
    const h = fixture(); await failure(await h.handle(request(readBody, otherToken)), 403, 'grant-principal');
    expect(h.refresh).not.toHaveBeenCalled(); expect(h.readObject).not.toHaveBeenCalled();
  });
  it('requires the configured owner principal as well as the owner role', async () => {
    const h = fixture(); h.host.ownerPrincipal = 'different-owner';
    await failure(await h.handle(request({ delivery: delivery(h.grant) }, ownerToken, '/v1/broker/revocations')), 403, 'role-forbidden');
  });
  it.each(['context', 'role', 'principalRef', 'grant'])('rejects forged body %s', async field => {
    const h = fixture(); await failure(await h.handle(request({ ...readBody, [field]: field === 'grant' ? h.grant : 'owner' })), 400, 'invalid-request');
    expect(h.lookup).not.toHaveBeenCalled(); expect(h.refresh).not.toHaveBeenCalled();
  });
  it.each([null, 1, '', '../secret', 'a\n', 'a'.repeat(97)])('rejects malformed read IDs %j as 400 before lookup', async id => {
    const h = fixture();
    for (const field of ['requestId', 'grantId']) await failure(await h.handle(request({ ...readBody, [field]: id })), 400, 'invalid-read');
    expect(h.lookup).not.toHaveBeenCalled(); expect(h.refresh).not.toHaveBeenCalled();
  });
  it('blocks media type and streamed oversized bodies before lookup', async () => {
    const h = fixture(); await failure(await h.handle(request(readBody, executorToken, '/v1/broker/read', 'text/plain')), 415, 'json-required');
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(32769)); c.close(); } });
    const req = new Request('https://broker.test/v1/broker/read', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + executorToken }, body, duplex: 'half' } as RequestInit);
    await failure(await h.handle(req), 413, 'request-too-large'); expect(h.lookup).not.toHaveBeenCalled();
  });
  it.each(['auth', 'enabled', 'authorization'] as const)('withholds bytes if %s is revoked while provider is in flight', async fence => {
    const h = fixture(), entered = deferred<void>(), wait = deferred<Awaited<ReturnType<BrokerPorts['readObject']>>>();
    h.readObject.mockImplementation(() => { entered.resolve(); return wait.promise; });
    const response = h.handle(request()); await entered.promise;
    if (fence === 'auth') h.host.authConfig = '[]';
    else if (fence === 'enabled') h.host.enabled = false;
    else h.revokeObservation();
    wait.resolve({ ref: h.grant.object, bytes: payload });
    await failure(await response, 503, fence === 'enabled' ? 'broker-disabled' : 'broker-unavailable');
  });
  it('defaults disabled and rechecks feature state after refresh', async () => {
    const h = fixture(); delete h.host.enabled;
    await failure(await h.handle(request()), 503, 'broker-disabled'); expect(h.lookup).not.toHaveBeenCalled();
    h.host.enabled = true; h.refresh.mockImplementationOnce(async () => { h.host.enabled = false; });
    await failure(await h.handle(request()), 503, 'broker-disabled'); expect(h.readObject).not.toHaveBeenCalled();
  });
  it('rechecks authentication after a yielding refresh', async () => {
    const h = fixture(); h.refresh.mockImplementationOnce(async () => { h.host.authConfig = '[]'; });
    await failure(await h.handle(request()), 503, 'broker-unavailable'); expect(h.readObject).not.toHaveBeenCalled();
  });
  it('applies a real delivery using the exported grant binding, replays its receipt, and fences cached bytes', async () => {
    const h = fixture(); expect((await h.handle(request())).status).toBe(200);
    const d = delivery(h.grant), post = () => h.handle(request({ delivery: d }, ownerToken, '/v1/broker/revocations'));
    const first = await post(); expect(first.status).toBe(200);
    const receipt = { version: 1, deliveryId: d.deliveryId, targetId: d.target.targetId, evidenceId: d.evidenceId, status: 'revoked' };
    expect(await first.json()).toEqual(receipt); expect(await (await post()).json()).toEqual(receipt);
    await failure(await h.handle(request()), 503, 'broker-unavailable'); expect(h.readObject).toHaveBeenCalledTimes(1);
  });
  it.each(['target', 'evidence', 'grant'] as const)('rejects mismatched revocation %s without revoking the grant', async field => {
    const h = fixture(), d = delivery(h.grant);
    if (field === 'target') d.target.authorityId = 'wrong';
    else if (field === 'evidence') d.evidenceId = '0'.repeat(64);
    else d.target.binding.content.objectGeneration = '999';
    await failure(await h.handle(request({ delivery: d }, ownerToken, '/v1/broker/revocations')), 409, field + '-binding');
    expect((await h.handle(request())).status).toBe(200);
  });
});


it('retains refresh capacity for abort-ignoring adapters while owner revocation remains available',async()=>{
 vi.useFakeTimers();const h=fixture();h.refresh.mockImplementation(()=>new Promise(()=>{}));
 for(let n=0;n<4;n++){const pending=h.handle(request({...readBody,requestId:'stalled-'+n}));await vi.advanceTimersByTimeAsync(5001);expect((await pending).status).toBe(503);}
 expect((await h.handle(request())).status).toBe(429);expect(h.refresh).toHaveBeenCalledTimes(4);
 expect((await h.handle(request({delivery:delivery(h.grant)},ownerToken,'/v1/broker/revocations'))).status).toBe(200);
});
