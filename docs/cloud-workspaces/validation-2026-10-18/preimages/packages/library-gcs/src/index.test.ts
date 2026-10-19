import { test } from 'vitest';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { createGcsReader, HARD_LIMITS } from './index';
import type { GcsHostConfig, GcsTrustedPorts, ObjectRef } from './index';
import { sha256 } from '../../library-jobs/src/data';
import { createStorageBroker } from '../../storage-broker/src/index';
import type { BrokerPorts, ReadGrant } from '../../storage-broker/src/types';
const content = new TextEncoder().encode('bounded immutable fixture');
const baseRef: ObjectRef = { projectId: 'project-a', objectKey: `projects/project-a/objects/${sha256(content)}`,
  generation: '1234567890123456', sha256: sha256(content), sizeBytes: content.length };
const config: GcsHostConfig = { origin: 'https://storage.googleapis.com', bucket: 'fixture-bucket',
  projectId: 'project-a', credentialRef: 'host-gcs-reader' };
const signal = () => new AbortController().signal;
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function response(url: string, body: ConstructorParameters<typeof Response>[0], init: ResponseInit = {}) {
  const r = new Response(body, init); Object.defineProperty(r, 'url', { value: url }); return r;
}
function meta(ref = baseRef) { return { bucket: config.bucket, name: ref.objectKey, generation: ref.generation, metageneration: '1', size: String(ref.sizeBytes) }; }
function fixture(options: { config?: GcsHostConfig; ref?: ObjectRef; metadata?: Record<string, unknown>;
  intercept?: (url: string, media: boolean) => Response | Promise<Response> | undefined } = {}) {
  const ref = options.ref ?? baseRef;
  const calls: { url: string; init: Parameters<GcsTrustedPorts['fetch']>[1] }[] = [];
  let tokens = 0;
  const ports: GcsTrustedPorts = {
    async getAccessToken(key, s) { tokens++; assert.equal(key, config.credentialRef); assert.equal(s.aborted, false); return 'fixture-access-token'; },
    async fetch(url, init) {
      calls.push({ url, init });
      const media = new URL(url).searchParams.get('alt') === 'media';
      const intercepted = options.intercept?.(url, media); if (intercepted) return intercepted;
      return media ? response(url, content, { headers: { 'content-length': String(content.length), 'x-goog-generation': ref.generation } })
        : response(url, JSON.stringify(options.metadata ?? meta(ref)), { headers: { 'content-type': 'application/json' } });
    }
  };
  return { ports, calls, reader: createGcsReader(options.config ?? config, ports), get tokens() { return tokens; } };
}

test('exact immutable two-GET journey, native broker read port and immutable snapshot', async () => {
  const f = fixture(); const read: BrokerPorts['readObject'] = f.reader.readObject;
  const input = { ...baseRef }; const pending = read(input, content.length, signal()); input.generation = '999';
  const result = await pending;
  assert.deepEqual(result.bytes, content); assert.deepEqual(result.ref, baseRef); assert.ok(Object.isFrozen(result.ref));
  assert.deepEqual(Object.keys(result).sort(), ['bytes', 'ref']); assert.equal(f.tokens, 1); assert.equal(f.calls.length, 2);
  for (const { url, init } of f.calls) {
    const u = new URL(url); assert.equal(u.origin, config.origin);
    assert.equal(decodeURIComponent(u.pathname), `/storage/v1/b/${config.bucket}/o/${baseRef.objectKey}`);
    assert.equal(u.searchParams.get('generation'), baseRef.generation); assert.equal(u.searchParams.get('ifGenerationMatch'), baseRef.generation);
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual'); assert.equal(init.cache, 'no-store');
    assert.equal(init.headers['Accept-Encoding'], 'identity'); assert.ok(init.signal instanceof AbortSignal);
  }
});
for (const metageneration of ['1', '9007199254740993', '9'.repeat(32)])
  test(`unchanged metadata metageneration ${metageneration} succeeds with all generation fences`, async () => {
    const f = fixture({ metadata: { ...meta(), metageneration, contentEncoding: 'identity' } });
    const result = await f.reader.readObject(baseRef, content.length, signal());
    assert.deepEqual(result.bytes, content); assert.deepEqual(result.ref, baseRef);
    assert.equal(Object.hasOwn(result.ref, 'metageneration'), false);
    assert.equal(f.tokens, 1); assert.equal(f.calls.length, 2);
    const metadata = new URL(f.calls[0].url), media = new URL(f.calls[1].url);
    assert.equal(metadata.searchParams.get('fields'), 'bucket,name,generation,metageneration,size,contentEncoding');
    assert.equal(metadata.searchParams.has('ifMetagenerationMatch'), false);
    assert.equal(media.searchParams.has('fields'), false);
    assert.equal(media.searchParams.get('alt'), 'media');
    assert.equal(media.searchParams.get('ifMetagenerationMatch'), metageneration);
    for (const url of [metadata, media]) {
      assert.equal(url.searchParams.get('generation'), baseRef.generation);
      assert.equal(url.searchParams.get('ifGenerationMatch'), baseRef.generation);
    }
  });
for (const value of [undefined, null, 1, 0, true, {}, [], '', '0', '00', '01', '-1', '+1',
  '1.0', '1e3', ' 1', '1 ', '1\n', '1\r\n', '1\t', '１', '١'])
  test(`missing/malformed metadata metageneration ${JSON.stringify(value)} rejects before media`, async () => {
    // JSON serialization omits undefined, covering an actually missing property.
    const f = fixture({ metadata: { ...meta(), metageneration: value } });
    await assert.rejects(f.reader.readObject(baseRef, content.length, signal()), /^Error: library-gcs: read failed$/);
    assert.equal(f.tokens, 1); assert.equal(f.calls.length, 1);
  });
test('metadata encoding changes at unchanged generation: media 412 rejects without body read or retry', async () => {
  let metageneration = '1', contentEncoding: string | undefined;
  let pulls = 0, cancels = 0, readers = 0;
  const f = fixture({ intercept: (url, media) => {
    if (!media) {
      const observed = { ...meta(), metageneration, contentEncoding };
      // Concurrent metadata-only update: stored bytes and generation do not change.
      metageneration = '2'; contentEncoding = 'gzip';
      return response(url, JSON.stringify(observed), { headers: { 'content-type': 'application/json' } });
    }
    const u = new URL(url);
    assert.equal(u.searchParams.get('generation'), baseRef.generation);
    assert.equal(u.searchParams.get('ifGenerationMatch'), baseRef.generation);
    assert.equal(u.searchParams.get('ifMetagenerationMatch'), '1');
    assert.notEqual(u.searchParams.get('ifMetagenerationMatch'), metageneration);
    assert.equal(contentEncoding, 'gzip');
    const body = new ReadableStream<Uint8Array>({
      pull() { pulls++; throw new Error('provider body must not be read'); },
      cancel() { cancels++; },
    }, { highWaterMark: 0 });
    const getReader = body.getReader.bind(body);
    body.getReader = (() => { readers++; return getReader(); }) as typeof body.getReader;
    return response(url, body, { status: 412 });
  } });
  await assert.rejects(f.reader.readObject(baseRef, content.length, signal()), /^Error: library-gcs: read failed$/);
  assert.equal(f.tokens, 1); assert.equal(f.calls.length, 2);
  assert.equal(readers, 0); assert.equal(pulls, 0); assert.equal(cancels, 1);
});
test('manifest namespace and 32-digit generation preserved without number coercion', async () => {
  const ref = { ...baseRef, objectKey: `projects/project-a/manifests/${baseRef.sha256}`, generation: '9'.repeat(32) };
  assert.deepEqual((await fixture({ ref }).reader.readObject(ref, content.length, signal())).ref, ref);
});
for (const patch of [
  { projectId: 'other' }, { projectId: 'project-a\n' }, { objectKey: 'https://evil.test/x' },
  { objectKey: '../x' }, { objectKey: `projects/other/objects/${baseRef.sha256}` },
  { objectKey: baseRef.objectKey + '\n' }, { objectKey: baseRef.objectKey + '?x=1' },
  { objectKey: 'projects/project-a/%2e%2e/x' }, { generation: '0' }, { generation: '01' },
  { generation: '1\n' }, { generation: '9'.repeat(33) }, { sha256: 'A'.repeat(64) },
  { sha256: baseRef.sha256 + '\n' }, { sizeBytes: 0 }, { sizeBytes: -1 }, { sizeBytes: 1.5 },
  { sizeBytes: HARD_LIMITS.maxReadBytes + 1 }, { url: 'https://evil.test' }
]) test(`invalid ref ${JSON.stringify(patch)} rejected before credentials/fetch`, async () => {
  const f = fixture(); await assert.rejects(f.reader.readObject({ ...baseRef, ...patch }, HARD_LIMITS.maxReadBytes, signal()));
  assert.equal(f.tokens, 0); assert.equal(f.calls.length, 0);
});
test('reject getters, proxies, symbols and inherited/decorated references without invoking code', async () => {
  let traps = 0;
  for (const ref of [new Proxy(baseRef, { ownKeys() { traps++; throw Error(); } }),
    Object.defineProperty({ ...baseRef }, 'generation', { get() { traps++; return '1'; }, enumerable: true }),
    Object.assign(Object.create(baseRef), {}), { ...baseRef, [Symbol('extra')]: 1 }]) {
    const f = fixture(); await assert.rejects(f.reader.readObject(ref, content.length, signal())); assert.equal(f.tokens, 0);
  }
  assert.equal(traps, 0);
});
for (const max of [0, -1, NaN, Infinity, 1.5, content.length - 1, HARD_LIMITS.maxReadBytes + 1])
  test(`reject maxBytes ${max}`, async () => { const f = fixture(); await assert.rejects(f.reader.readObject(baseRef, max, signal())); assert.equal(f.tokens, 0); });
for (const patch of [{ origin: 'https://evil.test' }, { origin: 'http://storage.googleapis.com' },
  { origin: 'https://storage.googleapis.com/' }, { bucket: '../other' }, { bucket: 'bucket/path' },
  { credentialRef: 'token\nsecret' }, { limits: { maxActiveReads: 9 } }, { limits: { timeoutMs: 0 } }, { extra: 1 }])
  test(`reject host config ${JSON.stringify(patch)}`, () => { assert.throws(() => fixture({ config: { ...config, ...patch } as GcsHostConfig })); });
for (const [field, value] of [['bucket','other'], ['name','other'], ['generation','1'], ['generation',123], ['size',content.length], ['size','999'], ['contentEncoding','gzip']] as const)
  test(`reject metadata mismatch ${field}=${value} before media`, async () => {
    const f = fixture({ metadata: { ...meta(), [field]: value } });
    await assert.rejects(f.reader.readObject(baseRef, content.length, signal())); assert.equal(f.calls.length, 1);
  });
for (const status of [206, 301, 302, 307, 308, 401, 403, 404, 412, 429, 500, 503])
  test(`status ${status} rejected with no retry/body leakage`, async () => {
    let pulled = 0;
    const f = fixture({ intercept: url => response(url, new ReadableStream({ pull() { pulled++; } }, { highWaterMark: 0 }), { status }) });
    await assert.rejects(f.reader.readObject(baseRef, content.length, signal()), /^Error: library-gcs:/);
    assert.equal(f.calls.length, 1); assert.equal(pulled, 0);
  });
for (const headers of <Record<string, string>[]>[{ 'content-length': '999' }, { 'content-length': '025' }, { 'content-encoding': 'gzip' },
  { 'content-range': 'bytes 0-24/25' }, { 'x-goog-generation': '999' }])
  test(`reject media headers ${JSON.stringify(headers)} before pulling`, async () => {
    let pulled = 0;
    const f = fixture({ intercept: (url, media) => media ? response(url,
      new ReadableStream({ pull() { pulled++; } }, { highWaterMark: 0 }), { headers }) : undefined });
    await assert.rejects(f.reader.readObject(baseRef, content.length, signal())); assert.equal(pulled, 0);
  });
for (const kind of ['redirected', 'wrong-url', 'bad-json', 'oversize-metadata', 'metadata-length', 'encoded-metadata', 'short', 'long', 'wrong-hash', 'empty-chunk', 'shared-chunk', 'stream-error', 'missing-body'])
  test(`reject bounded fixture ${kind}`, async () => {
    const f = fixture({ intercept: (url, media) => {
      if (!media) {
        if (kind === 'redirected') { const r = response(url, '{}'); Object.defineProperty(r, 'redirected', { value: true }); return r; }
        if (kind === 'wrong-url') return response('https://evil.test/', '{}');
        if (kind === 'bad-json') return response(url, '{', { headers: { 'content-type': 'application/json' } });
        if (kind === 'oversize-metadata') return response(url, 'x'.repeat(HARD_LIMITS.metadataBytes + 1), { headers: { 'content-type': 'application/json' } });
        if (kind === 'metadata-length') return response(url, '{}', { headers: { 'content-type': 'application/json', 'content-length': '9999999' } });
        if (kind === 'encoded-metadata') return response(url, '{}', { headers: { 'content-encoding': 'gzip' } });
        return undefined;
      }
      if (kind === 'short') return response(url, content.subarray(1));
      if (kind === 'long') return response(url, new Uint8Array(content.length + 1));
      if (kind === 'wrong-hash') return response(url, new Uint8Array(content.length));
      if (kind === 'empty-chunk') return response(url, new ReadableStream({ start(c) { c.enqueue(new Uint8Array()); } }));
      if (kind === 'shared-chunk') return response(url, new ReadableStream({ start(c) { c.enqueue(new Uint8Array(new SharedArrayBuffer(1))); } }));
      if (kind === 'stream-error') return response(url, new ReadableStream({ start(c) { c.error(new Error('sensitive provider body')); } }));
      if (kind === 'missing-body') return response(url, null);
      return undefined;
    } });
    await assert.rejects(f.reader.readObject(baseRef, content.length, signal()), /^Error: library-gcs: read failed$/);
  });
test('pre-abort makes no credential or HTTP call', async () => {
  const f = fixture(), c = new AbortController(); c.abort();
  await assert.rejects(f.reader.readObject(baseRef, content.length, c.signal)); assert.equal(f.tokens, 0);
});
test('aggregate byte admission and concurrency reject before credentials; successful reads release reservations', async () => {
  const hold = deferred<Response>();
  const c = { ...config, limits: { maxActiveReads: 1, maxInFlightBytes: 2 * (content.length + HARD_LIMITS.metadataBytes) } };
  const f = fixture({ config: c, intercept: url => f.calls.length === 1 ? hold.promise : undefined });
  const first = f.reader.readObject(baseRef, content.length, signal()); await delay(0);
  await assert.rejects(f.reader.readObject(baseRef, content.length, signal()), /capacity/); assert.equal(f.tokens, 1);
  hold.resolve(response(f.calls[0].url, JSON.stringify(meta()), { headers: { 'content-type': 'application/json' } }));
  await first; await f.reader.readObject(baseRef, content.length, signal()); assert.equal(f.tokens, 2);
  const tiny = fixture({ config: { ...config, limits: { maxInFlightBytes: 1 } } });
  await assert.rejects(tiny.reader.readObject(baseRef, content.length, signal()), /capacity/); assert.equal(tiny.tokens, 0);
});
test('timeout rejects even when token provider ignores signal; occupied slot stays quarantined', async () => {
  const wait = deferred<string>(); let calls = 0;
  const f = fixture(); const reader = createGcsReader({ ...config, limits: { timeoutMs: 20, maxActiveReads: 1 } },
    { ...f.ports, getAccessToken: () => { calls++; return wait.promise; } });
  await assert.rejects(reader.readObject(baseRef, content.length, signal()), /timed out/);
  await assert.rejects(reader.readObject(baseRef, content.length, signal()), /capacity/); assert.equal(calls, 1);
  wait.resolve('fixture-access-token'); await delay(0); assert.equal(f.calls.length, 0);
});
test('fetch ignoring abort rejects promptly; late body is cancelled and capacity recovers', async () => {
  const wait = deferred<Response>(); let cancelled = false;
  const f = fixture({ config: { ...config, limits: { timeoutMs: 20, maxActiveReads: 1 } },
    intercept: () => wait.promise });
  await assert.rejects(f.reader.readObject(baseRef, content.length, signal()), /timed out/);
  assert.equal(f.calls[0].init.signal.aborted, true);
  await assert.rejects(f.reader.readObject(baseRef, content.length, signal()), /capacity/);
  wait.resolve(response(f.calls[0].url, new ReadableStream({ cancel() { cancelled = true; } })));
  await delay(0); assert.equal(cancelled, true);
});
test('abort cancels stalled stream, and timeout handles stream ignoring read AND cancel', async () => {
  let cancelled = false; const ready = deferred<void>();
  const f = fixture({ intercept: (url, media) => media ? response(url, new ReadableStream({
    pull() { ready.resolve(); return new Promise(() => {}); }, cancel() { cancelled = true; }
  }, { highWaterMark: 0 })) : undefined });
  const c = new AbortController(), pending = f.reader.readObject(baseRef, content.length, c.signal);
  await ready.promise; c.abort(); await assert.rejects(pending, /aborted/); await delay(0); assert.equal(cancelled, true);
  let cancelCalled = false;
  const g = fixture({ config: { ...config, limits: { timeoutMs: 20, maxActiveReads: 1 } }, intercept: (url, media) => {
    if (!media) return undefined;
    const r = response(url, null);
    Object.defineProperty(r, 'body', { value: { getReader: () => ({ read: () => new Promise(() => {}),
      cancel: () => { cancelCalled = true; return new Promise(() => {}); }, releaseLock() {} }) } });
    return r;
  } });
  await assert.rejects(g.reader.readObject(baseRef, content.length, signal()), /timed out/);
  assert.equal(cancelCalled, true); await assert.rejects(g.reader.readObject(baseRef, content.length, signal()), /capacity/);
});
test('token/fetch failures are sanitized and never retried', async () => {
  const f = fixture(); let calls = 0;
  const reader = createGcsReader(config, { ...f.ports, getAccessToken: async () => { calls++; throw Error('sensitive token'); } });
  await assert.rejects(reader.readObject(baseRef, content.length, signal()), /^Error: library-gcs: read failed$/);
  assert.equal(calls, 1); assert.equal(f.calls.length, 0);
  for (const token of ['', 'abc\r\nInjected: true']) {
    await assert.rejects(createGcsReader(config, { ...f.ports, getAccessToken: async () => token }).readObject(baseRef, content.length, signal()));
  }
});
test('real storage broker authorizes, verifies, seals and replays without extra provider GETs', async () => {
  const f = fixture(), db = new DatabaseSync(':memory:');
  const grant: ReadGrant = { version: 1, grantId: 'grant-a', principalRef: 'worker-a', projectId: 'project-a',
    policyVersion: 'policy-a', policyHash: 'a'.repeat(64), intentId: 'intent-a', authorizationGeneration: 1,
    operation: 'GET', object: baseRef, byteBudget: content.length, expiresAt: 100000,
    compute: { authorityId: 'compute-a', workloadId: 'work-a', leaseId: 'lease-a', epoch: 1, generation: 0,
      attemptId: 'attempt-a', capabilityDigest: 'b'.repeat(64), workerId: 'worker-a', incarnation: 0 } };
  try {
    const broker = createStorageBroker({ db, binding: { environment: 'fixture', authorityId: 'broker-a' }, now: () => 1000,
      observeCurrent: g => ({ grant: g, status: 'authorized', revoked: false, observedAt: 1000, expiresAt: g.expiresAt }),
      readObject: f.reader.readObject });
    broker.admin.issue(grant);
    await assert.rejects(broker.reader.read('other', { grantId: 'grant-a', requestId: 'read-a' })); assert.equal(f.calls.length, 0);
    assert.deepEqual(await broker.reader.read('worker-a', { grantId: 'grant-a', requestId: 'read-a' }), content);
    assert.deepEqual(await broker.reader.read('worker-a', { grantId: 'grant-a', requestId: 'read-a' }), content);
    assert.equal(f.calls.length, 2);
    assert.equal(db.prepare('SELECT count(*) AS n FROM reads').get()!.n, 1);
    const sealed = db.prepare('SELECT state,bytes FROM reads').get()!;
    assert.equal(sealed.state, 'completed');
    assert.deepEqual(new Uint8Array(sealed.bytes as Uint8Array), content);
  } finally { db.close(); }
});

test('metadata advertised length mismatch rejected', async () => {
  const f = fixture({ intercept: url => response(url, JSON.stringify(meta()),
    { headers: { 'content-type': 'application/json', 'content-length': '2' } }) });
  await assert.rejects(f.reader.readObject(baseRef, content.length, signal())); assert.equal(f.calls.length, 1);
});
test('stream split into native chunks verifies without requiring Content-Length or generation echo', async () => {
  const f = fixture({ intercept: (url, media) => media ? response(url, new ReadableStream({
    start(c) { c.enqueue(content.subarray(0, 3)); c.enqueue(content.subarray(3)); c.close(); }
  })) : undefined });
  assert.deepEqual((await f.reader.readObject(baseRef, content.length, signal())).bytes, content);
});
test('host configuration is copied and trusted port failures remain sanitized without retry', async () => {
  const mutable = { ...config }, f = fixture({ config: mutable }); mutable.bucket = 'other';
  await f.reader.readObject(baseRef, content.length, signal()); assert.ok(f.calls[0].url.includes('/fixture-bucket/'));
  let calls = 0;
  const reader = createGcsReader(config, { ...f.ports, fetch: async () => { calls++; throw Error('sensitive provider error'); } });
  await assert.rejects(reader.readObject(baseRef, content.length, signal()), /^Error: library-gcs: read failed$/); assert.equal(calls, 1);
});
test('aggregate budget limits simultaneous requests independently of concurrency cap', async () => {
  const hold = deferred<Response>(), c = new AbortController();
  const f = fixture({ config: { ...config, limits: { maxActiveReads: 8, maxInFlightBytes: 2 * (content.length + HARD_LIMITS.metadataBytes) } },
    intercept: () => hold.promise });
  const first = f.reader.readObject(baseRef, content.length, c.signal); await delay(0);
  await assert.rejects(f.reader.readObject(baseRef, content.length, signal()), /capacity/); assert.equal(f.tokens, 1);
  c.abort(); await assert.rejects(first, /aborted/);
  hold.resolve(response(f.calls[0].url, null)); await delay(0);
});

test('whole-call deadline includes metadata body; no media request follows a stalled metadata stream', async () => {
  let cancelled = false;
  const f = fixture({ config: { ...config, limits: { timeoutMs: 20 } }, intercept: url => response(url,
    new ReadableStream({ pull: () => new Promise(() => {}), cancel() { cancelled = true; } }, { highWaterMark: 0 }),
    { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(f.reader.readObject(baseRef, content.length, signal()), /timed out/);
  await delay(0); assert.equal(cancelled, true); assert.equal(f.calls.length, 1);
});
test('lingering response cancellation retains capacity until cleanup settles', async () => {
  const cleanup = deferred<void>(); let cancels = 0;
  const f = fixture({ config: { ...config, limits: { timeoutMs: 20, maxActiveReads: 1 } }, intercept: url => {
    if (f.calls.length !== 1) return undefined;
    return response(url, new ReadableStream({ cancel() { cancels++; return cleanup.promise; } }, { highWaterMark: 0 }), { status: 503 });
  } });
  await assert.rejects(f.reader.readObject(baseRef, content.length, signal()), /timed out/);
  assert.equal(cancels, 1);
  await assert.rejects(f.reader.readObject(baseRef, content.length, signal()), /capacity/);
  cleanup.resolve(); await delay(0);
  assert.deepEqual((await f.reader.readObject(baseRef, content.length, signal())).bytes, content);
});
