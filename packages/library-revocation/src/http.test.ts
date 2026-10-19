import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonical } from '../../library-jobs/src/data';
import { RevocationRelay, type Delivery, type FencePage, type RevocationTarget, type TransactionPort } from './index';
import { relayHttp, relayStep, type RelayHttpConfig, type RelayHttpPorts } from './http';

const H = 'a'.repeat(64), bearer = 't'.repeat(40);
const cleanup: (() => void)[] = [];
afterEach(() => { vi.useRealTimers(); cleanup.splice(0).reverse().forEach(close => close()); });
function config(): RelayHttpConfig {
  return { enabled: true, environment: 'test', sourceAuthorityId: 'compute', compute: { origin: 'https://compute.test', credentialRef: 'compute-owner' },
    targets: [ { kind: 'broker', projectId: 'project', authorityId: 'broker', origin: 'https://broker.test', credentialRef: 'broker-owner' },
      { kind: 'catalog', projectId: 'project', authorityId: 'catalog', origin: 'https://catalog.test', credentialRef: 'catalog-owner' } ] };
}
function target(kind: 'broker' | 'catalog' = 'broker'): RevocationTarget {
  return { version: 1, targetId: kind + '-target', kind, authorityId: kind, environment: 'test', projectId: 'project', resourceId: 'grant', generation: 1,
    binding: { projectId: 'project', policyVersion: 'p1', policyHash: H,
      compute: { authorityId: 'compute', workloadId: 'work', leaseId: 'lease', attemptId: 'attempt', epoch: 1, generation: 1, incarnation: 1, workerId: 'worker', capabilityDigest: H },
      content: { manifestHash: H, objectHash: H, objectKey: `projects/project/objects/${H}`, objectGeneration: '1', bytes: 100 } } };
}
function page(): FencePage {
  return { version: 1, environment: 'test', authorityId: 'compute', epoch: 2, after: 0, through: 1, head: 1,
    events: [{ seq: 1, kind: 'lease-revoked', epoch: 1, leaseId: 'lease', workloadId: 'work', workerId: 'worker', generation: 1, incarnation: 1 }] };
}
function delivery(kind: 'broker' | 'catalog' = 'broker'): Delivery {
  return { version: 1, deliveryId: 'd'.repeat(64), key: 'd'.repeat(64), evidenceId: H, revision: 1, target: target(kind), event: page().events[0] };
}
function receipt(d: Delivery) {
  return { version: 1, deliveryId: d.deliveryId, evidenceId: d.evidenceId, targetId: d.target.targetId, status: 'revoked' };
}
function ports() {
  const credential = vi.fn<RelayHttpPorts['credential']>(async () => bearer);
  const fetch = vi.fn<RelayHttpPorts['fetch']>(async request => {
    const path = new URL(request.url).pathname;
    if (path === '/v1/status') return Response.json({ ok: true, environment: 'test', authorityId: 'compute', epoch: 2 });
    if (path === '/v1/library/fences') return Response.json(page());
    return Response.json(receipt((await request.clone().json() as { delivery: Delivery }).delivery));
  });
  return { credential, fetch };
}

describe('relay HTTP host-fixed transport', () => {
  it('uses configured credentials and canonical fixed-origin POSTs with a 64-event page limit', async () => {
    const p = ports(), http = relayHttp(config(), p);
    expect(await http.readPage(17)).toEqual(page());
    expect(p.credential.mock.calls).toEqual([['compute-owner',expect.any(AbortSignal)], ['compute-owner',expect.any(AbortSignal)]]);
    const requests = p.fetch.mock.calls.map(([r]) => r);
    expect(requests.map(r => r.url)).toEqual(['https://compute.test/v1/status', 'https://compute.test/v1/library/fences']);
    expect(await requests[0].clone().text()).toBe('{}');
    expect(await requests[1].clone().text()).toBe(canonical({ after: 17, expectedEpoch: 2, limit: 64 }));
    for (const r of requests) {
      expect(r.method).toBe('POST'); expect(r.redirect).toBe('error');
      expect(r.headers.get('authorization')).toBe('Bearer ' + bearer);
      expect(r.headers.get('content-type')).toBe('application/json');
      expect(await r.clone().text()).not.toContain(bearer);
    }
  });
  it.each(['broker', 'catalog'] as const)('routes %s deliveries only to the configured target and keeps bearer out of JSON', async kind => {
    const p = ports(), http = relayHttp(config(), p), d = delivery(kind);
    expect(await http.deliver(d)).toEqual(receipt(d));
    const r = p.fetch.mock.calls[0][0];
    expect(r.url).toBe(kind === 'broker' ? 'https://broker.test/v1/broker/revocations' : 'https://catalog.test/v1/library/project/revocations');
    expect(p.credential).toHaveBeenCalledWith(kind + '-owner',expect.any(AbortSignal));
    expect(await r.clone().text()).toBe(canonical({ delivery: d }));
    expect(await r.clone().text()).not.toContain(bearer);
  });
  it('snapshots host configuration against caller mutation', async () => {
    const c = config(), p = ports(), http = relayHttp(c, p);
    c.compute.origin = 'https://attacker.test'; c.compute.credentialRef = 'attacker'; c.targets[0].origin = 'https://attacker.test';
    await http.readPage(0); await http.deliver(delivery());
    expect(p.fetch.mock.calls.map(([r]) => new URL(r.url).origin)).toEqual(['https://compute.test', 'https://compute.test', 'https://broker.test']);
    expect(p.credential.mock.calls.flat()).not.toContain('attacker');
  });
  it('rejects non-inert JSON configuration without invoking getters, toJSON or proxy traps', () => {
    const p = ports(), trap = vi.fn();
    const accessor = Object.defineProperty(config(), 'enabled', { enumerable: true, get: trap });
    const proxy = new Proxy(config(), { ownKeys: trap });
    for (const c of [accessor, proxy, { ...config(), toJSON: trap }]) expect(() => relayHttp(c, p)).toThrow();
    expect(trap).not.toHaveBeenCalled(); expect(p.credential).not.toHaveBeenCalled();
  });
  it.each(['http://compute.test', 'https://user:password@compute.test', 'https://compute.test/path', 'https://compute.test/?url=https://attacker.test', 'https://compute.test/#fragment'])('rejects unsafe configured origin %s before transport', origin => {
    const c = config(), p = ports(); c.compute.origin = origin;
    expect(() => relayHttp(c, p)).toThrow(); expect(p.fetch).not.toHaveBeenCalled();
  });
  it('accepts credential references only, never a JSON bearer credential', () => {
    const c = config(), p = ports(); c.compute.credentialRef = 'Bearer ' + bearer;
    expect(() => relayHttp(c, p)).toThrow(); expect(p.credential).not.toHaveBeenCalled();
  });
  it('defaults disabled without resolving credentials or invoking transport', async () => {
    const c = config(), p = ports(); delete c.enabled; const http = relayHttp(c, p);
    await expect(http.readPage(0)).rejects.toThrow('relay disabled');
    await expect(http.deliver(delivery())).rejects.toThrow('relay disabled');
    expect(p.credential).not.toHaveBeenCalled(); expect(p.fetch).not.toHaveBeenCalled();
  });
  it.each([
    { environment: 'prod' }, { authorityId: 'impostor' }, { epoch: 0 }, { epoch: 1.5 }, { ok: false },
  ])('rejects wrong source status binding %j before requesting fences', async patch => {
    const p = ports(); p.fetch.mockResolvedValueOnce(Response.json({ ok: true, environment: 'test', authorityId: 'compute', epoch: 2, ...patch }));
    await expect(relayHttp(config(), p).readPage(0)).rejects.toThrow('source binding'); expect(p.fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['authorityId', 'projectId', 'environment', 'kind'] as const)('rejects unconfigured target %s without selecting a credential or URL', async field => {
    const p = ports(), d = delivery(); Object.assign(d.target, { [field]: 'unconfigured' });
    await expect(relayHttp(config(), p).deliver(d)).rejects.toThrow('target not configured');
    expect(p.credential).not.toHaveBeenCalled(); expect(p.fetch).not.toHaveBeenCalled();
  });
  it('does not let delivery URL or credential claims select transport', async () => {
    const p = ports(), d = { ...delivery(), url: 'https://attacker.test', credential: 'attacker' };
    await relayHttp(config(), p).deliver(d);
    expect(p.fetch.mock.calls[0][0].url).toBe('https://broker.test/v1/broker/revocations');
    expect(p.credential).toHaveBeenCalledExactlyOnceWith('broker-owner',expect.any(AbortSignal));
  });
  it.each(['bad token', '', 't'.repeat(31), 't'.repeat(40) + '\n'])('rejects malformed resolved credentials %j without transport', async token => {
    const p = ports(); p.credential.mockResolvedValue(token);
    await expect(relayHttp(config(), p).readPage(0)).rejects.toThrow('credential unavailable'); expect(p.fetch).not.toHaveBeenCalled();
  });
  it.each([302, 401, 503])('rejects HTTP %s without following a redirect or fetching a second URL', async status => {
    const p = ports(); p.fetch.mockResolvedValueOnce(new Response(null, { status, headers: { location: 'https://attacker.test' } }));
    await expect(relayHttp(config(), p).readPage(0)).rejects.toMatchObject({ status, code: 'relay-target-response' }); expect(p.fetch).toHaveBeenCalledTimes(1);
  });
  it('cancels a streaming 503 body and aborts its request before rejecting', async () => {
    const p = ports(), cancel = vi.fn();
    p.fetch.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('upstream unavailable')); }, cancel,
    }), { status: 503, headers: { 'content-type': 'application/json' } }));
    await expect(relayHttp(config(), p).readPage(0)).rejects.toMatchObject({ status: 503, code: 'relay-target-response' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(p.fetch.mock.calls[0][0].signal.aborted).toBe(true);
    expect(p.fetch).toHaveBeenCalledTimes(1);
  });
  it('bounds canonical outbound JSON before invoking fetch', async () => {
    const p = ports(), d = delivery(); d.target.resourceId = 'x'.repeat(262145);
    await expect(relayHttp(config(), p).deliver(d)).rejects.toThrow(/JSON.*budget/);
    expect(p.fetch).not.toHaveBeenCalled();
  });
  it.each(['media', 'oversize', 'malformed'] as const)('bounds and validates %s responses', async kind => {
    const p = ports();
    const body = kind === 'oversize' ? ' '.repeat(65537) : kind === 'malformed' ? '{' : '{}';
    p.fetch.mockResolvedValueOnce(new Response(body, { headers: { 'content-type': kind === 'media' ? 'text/plain' : 'application/json' } }));
    await expect(relayHttp(config(), p).readPage(0)).rejects.toMatchObject({ status: kind === 'oversize' ? 413 : kind === 'media' ? 415 : 400 });
    expect(p.fetch).toHaveBeenCalledTimes(1);
  });
  it('classifies invalid UTF-8 without exposing response bytes',async()=>{
    const p=ports();p.fetch.mockResolvedValueOnce(new Response(new Uint8Array([0xff,0xfe]),{headers:{'content-type':'application/json'}}));
    await expect(relayHttp(config(),p).readPage(0)).rejects.toMatchObject({status:400,message:'relay-invalid-json'});
  });
  it.each(['credential', 'fetch', 'response'] as const)('bounds a stalled %s at five seconds and aborts/cancels resources', async stage => {
    vi.useFakeTimers(); const p = ports(), cancel = vi.fn();
    if (stage === 'credential') p.credential.mockImplementation(() => new Promise(() => {}));
    if (stage === 'fetch') p.fetch.mockImplementation(() => new Promise(() => {}));
    if (stage === 'response') p.fetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'application/json' } }));
    const result = relayHttp(config(), p).readPage(0);
    const assertion = expect(result).rejects.toThrow('relay timeout');
    await vi.advanceTimersByTimeAsync(5000); await assertion;
    if (stage === 'credential') expect(p.fetch).not.toHaveBeenCalled();
    else expect(p.fetch.mock.calls[0][0].signal.aborted).toBe(true);
    if (stage === 'response') expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('relayStep offline source with real in-memory SQLite', () => {
  function fixture() {
    const db = new DatabaseSync(':memory:'); cleanup.push(() => db.close());
    const port: TransactionPort = {
      sql: { exec(query, ...bindings) { return db.prepare(query).all(...bindings) as Record<string, unknown>[]; } },
      transactionSync(fn) { db.exec('BEGIN IMMEDIATE'); try { const value = fn(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } },
    };
    const relay = new RevocationRelay(port, { environment: 'test', authorityId: 'relay', sourceAuthorityId: 'compute', ownerPrincipal: 'owner', dispatcherPrincipal: 'dispatcher', now: () => 100 });
    const owner = { environment: 'test', principal: 'owner', role: 'owner' as const };
    const context = { environment: 'test', principal: 'dispatcher', role: 'dispatcher' as const };
    relay.register(owner, target()); relay.ingest(context, page());
    return { relay, owner, context };
  }
  it.each([false, true])('attempts pending delivery before polling offline source (destination offline: %s)', async targetOffline => {
    const h = fixture(), p = ports();
    p.fetch.mockImplementation(async r => {
      if (new URL(r.url).hostname === 'compute.test' || targetOffline) throw new Error('offline');
      return Response.json(receipt((await r.json() as { delivery: Delivery }).delivery));
    });
    expect(await relayStep(h.relay, h.context, relayHttp(config(), p))).toEqual({ source: 'unavailable', delivery: targetOffline ? 'retry' : 'acked' });
    expect(p.fetch.mock.calls.map(([r]) => r.url)).toEqual(['https://broker.test/v1/broker/revocations', 'https://compute.test/v1/status']);
    expect(h.relay.cursor(h.context)).toBe(1);
    expect(h.relay.snapshot(h.owner).deliveries[0]).toMatchObject({ state: targetOffline ? 'pending' : 'acked', attempts: 1 });
  });
});
