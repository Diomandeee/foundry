import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {AuthorityTransport} from './transport';
import {safeError} from './private-state';

const origin = 'https://authority.invalid';
const pins = {origin, environment: 'fixture', authorityId: 'fixture-authority'};
const observed = {environment: pins.environment, authorityId: pins.authorityId, epoch: 7};
const workerToken = 'synthetic-worker-status-'.repeat(3);
const ownerToken = 'synthetic-owner-status-'.repeat(3);
const rotatedOwnerToken = 'synthetic-rotated-owner-status-'.repeat(3);
const capability = 'synthetic-private-upstream-capability';

describe('AuthorityTransport worker and owner status routes', () => {
  let workerReference: string;
  let ownerReference: string;
  let transport: AuthorityTransport;

  beforeEach(() => {
    const suffix = randomUUID().replaceAll('-', '').toUpperCase();
    workerReference = `FOUNDRY_TRANSPORT_TEST_WORKER_${suffix}`;
    ownerReference = `FOUNDRY_TRANSPORT_TEST_OWNER_${suffix}`;
    // Only these new, synthetic references are used. No host credential lookup.
    process.env[workerReference] = workerToken;
    process.env[ownerReference] = ownerToken;
    transport = new AuthorityTransport(pins);
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () => {
      throw new Error('unconfigured-fetch-fixture');
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env[workerReference];
    delete process.env[ownerReference];
  });

  function reply(value: unknown = {ok: true, ...observed}, status = 200) {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(value, {status}));
  }

  it('uses the worker-only status route and synthetic worker authorization, returning only validated pins and epoch', async () => {
    reply({ok: true, ...observed, capability, credential: workerToken, workers: ['private-inventory']});
    expect(await transport.workerStatus(workerReference)).toEqual(observed);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(origin + '/v1/worker/status', {
      method: 'POST', redirect: 'error', credentials: 'omit', signal: expect.any(AbortSignal),
      headers: {authorization: 'Bearer ' + workerToken, 'content-type': 'application/json'}, body: '{}',
    });
  });

  it('keeps the owner status route and captured-token read request unchanged', async () => {
    reply({ok: true, ...observed, capability, credential: ownerToken});
    expect(await transport.status(ownerReference, undefined, ownerToken)).toEqual(observed);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(origin + '/v1/status', {
      method: 'POST', redirect: 'error', credentials: 'omit', signal: expect.any(AbortSignal),
      headers: {authorization: 'Bearer ' + ownerToken, 'content-type': 'application/json'}, body: '{}',
    });
  });

  it('keeps discovery on owner status while requiring a pin for worker status', async () => {
    const discovery = new AuthorityTransport({origin, environment: pins.environment});
    await expect(discovery.workerStatus(workerReference)).rejects.toMatchObject({code: 'pilot-authority-pin-required'});
    await expect(discovery.status(ownerReference)).rejects.toMatchObject({code: 'pilot-authority-pin-required'});
    expect(fetch).not.toHaveBeenCalled();
    reply({ok: true, ...observed, schemaVersion: 1});
    expect(await discovery.discover(ownerReference)).toEqual({...observed, schemaVersion: 1});
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(origin + '/v1/status');
  });

  it.each([
    {environment: 'stale-environment'}, {authorityId: 'stale-authority'}, {ok: false},
  ])('rejects stale or changed worker status binding %j', async change => {
    reply({ok: true, ...observed, ...change, capability});
    await expect(transport.workerStatus(workerReference)).rejects.toMatchObject({code: 'pilot-authority-binding'});
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(origin + '/v1/worker/status');
  });

  it.each([undefined, null, 0, -1, 1.5, '7', Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid worker status epoch %j', async epoch => {
      reply({ok: true, ...observed, epoch});
      await expect(transport.workerStatus(workerReference)).rejects.toMatchObject({code: 'pilot-invalid-integer'});
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it('revalidates the binding on every worker status response after a successful call', async () => {
    reply();
    expect(await transport.workerStatus(workerReference)).toEqual(observed);
    reply({ok: true, ...observed, authorityId: 'replacement-authority'});
    await expect(transport.workerStatus(workerReference)).rejects.toMatchObject({code: 'pilot-authority-binding'});
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
      origin + '/v1/worker/status', origin + '/v1/worker/status',
    ]);
  });

  it('copies and freezes the configured target so caller mutation cannot repin worker status', async () => {
    const supplied = {...pins};
    const pinned = new AuthorityTransport(supplied);
    supplied.origin = 'https://replacement.invalid';
    supplied.environment = 'replacement';
    supplied.authorityId = 'replacement-authority';
    expect(Object.isFrozen(pinned.target)).toBe(true);
    expect(pinned.target).toEqual(pins);
    reply({ok: true, environment: supplied.environment, authorityId: supplied.authorityId, epoch: 7});
    await expect(pinned.workerStatus(workerReference)).rejects.toMatchObject({code: 'pilot-authority-binding'});
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(origin + '/v1/worker/status');
  });

  it.each([401, 403, 409])('rejects worker status HTTP %i without falling back to owner status or exposing response details', async status => {
    reply({ok: false, code: 'stale-epoch', detail: capability, credential: workerToken}, status);
    expect(await transport.workerStatus(workerReference).catch(safeError)).toEqual({
      code: 'pilot-upstream-' + status, status,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(origin + '/v1/worker/status');
  });

  it('owner status still rejects stale captured credentials before fetching', async () => {
    process.env[ownerReference] = rotatedOwnerToken;
    expect(await transport.status(ownerReference, undefined, ownerToken).catch(safeError)).toEqual({
      code: 'pilot-credential-binding-changed', status: 409,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([{environment: 'other'}, {authorityId: 'other'}, {epoch: 0}])(
    'owner status preserves existing binding and epoch checks %j', async change => {
      reply({ok: true, ...observed, ...change});
      await expect(transport.status(ownerReference)).rejects.toMatchObject({
        code: 'epoch' in change ? 'pilot-invalid-integer' : 'pilot-authority-binding',
      });
      expect(vi.mocked(fetch).mock.calls[0][0]).toBe(origin + '/v1/status');
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it('honors an already aborted worker status signal before any fetch', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(transport.workerStatus(workerReference, controller.signal)).rejects.toMatchObject({code: 'pilot-aborted', status: 408});
    expect(fetch).not.toHaveBeenCalled();
  });
});
