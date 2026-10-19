import { performance } from 'node:perf_hooks';
import { boundedBytes, freeze, hash, identifier, integer, record, sha256, snapshot } from '../../library-jobs/src/data';
import type { BrokerPorts, ObjectRef } from '../../storage-broker/src/types';
export type { ObjectRef } from '../../storage-broker/src/types';

export const HARD_LIMITS = Object.freeze({ maxReadBytes: 8 * 1024 * 1024, maxActiveReads: 8,
  maxInFlightBytes: 32 * 1024 * 1024, metadataBytes: 16384, timeoutMs: 10000 });
export interface GcsHostConfig {
  readonly origin: 'https://storage.googleapis.com';
  readonly bucket: string;
  readonly projectId: string;
  /** Opaque host lookup identifier, never an access token or URL. */
  readonly credentialRef: string;
  readonly limits?: Partial<{ [K in keyof typeof HARD_LIMITS]: number }>;
}
export interface GcsTrustedPorts {
  /** Server-only host port. Must not log tokens and must honor signal; no automatic retries. */
  getAccessToken(credentialRef: string, signal: AbortSignal): Promise<string>;
  /** Native streaming fetch semantics: no prebuffering, redirect following or hidden retries. */
  fetch(url: string, init: { method: 'GET'; redirect: 'manual'; cache: 'no-store';
    signal: AbortSignal; headers: Record<string, string> }): Promise<Response>;
}
export interface GcsReader { readonly readObject: BrokerPorts['readObject'] }
function requireThat(ok: unknown): asserts ok { if (!ok) throw new Error('library-gcs: rejected'); }

function exactRef(input: unknown, projectId: string, max: number): ObjectRef {
  const v = snapshot(input);
  record(v, ['projectId', 'objectKey', 'generation', 'sha256', 'sizeBytes']);
  identifier(v.projectId); requireThat(v.projectId === projectId); hash(v.sha256);
  integer(v.sizeBytes, max, 1);
  requireThat(typeof v.generation === 'string' && /^[1-9][0-9]{0,31}(?![\s\S])/.test(v.generation));
  requireThat(v.objectKey === `projects/${projectId}/objects/${v.sha256}` ||
    v.objectKey === `projects/${projectId}/manifests/${v.sha256}`);
  return freeze(v as unknown as ObjectRef);
}

/** Server-only, GET-only, no retry. The caller supplies current authorization via the broker. */
export function createGcsReader(hostConfig: GcsHostConfig, trustedPorts: GcsTrustedPorts): GcsReader {
  const c = snapshot(hostConfig);
  requireThat(c !== null && typeof c === 'object' && !Array.isArray(c));
  const config = c as Record<string, unknown>;
  requireThat(Object.keys(config).every(k => ['origin','bucket','projectId','credentialRef','limits'].includes(k)));
  requireThat(config.origin === 'https://storage.googleapis.com');
  requireThat(typeof config.bucket === 'string' && /^[a-z0-9][a-z0-9_-]{1,61}[a-z0-9](?![\s\S])/.test(config.bucket));
  identifier(config.projectId); identifier(config.credentialRef);
  const { origin, bucket, projectId, credentialRef } = config;
  const supplied = config.limits ?? {};
  requireThat(supplied !== null && typeof supplied === 'object' && !Array.isArray(supplied));
  requireThat(Object.keys(supplied).every(k => Object.hasOwn(HARD_LIMITS, k)));
  const limits = { ...HARD_LIMITS, ...supplied };
  for (const k of Object.keys(HARD_LIMITS) as (keyof typeof HARD_LIMITS)[]) integer(limits[k], HARD_LIMITS[k], 1);
  const fetchPort = trustedPorts.fetch.bind(trustedPorts);
  const tokenPort = trustedPorts.getAccessToken.bind(trustedPorts);
  let active = 0, reserved = 0;

  return Object.freeze({ async readObject(input: ObjectRef, maxBytes: number, signal: AbortSignal) {
    // All untrusted data is snapshotted before the first asynchronous boundary.
    let ref: ObjectRef;
    try { integer(maxBytes, limits.maxReadBytes, 1); ref = exactRef(input, projectId, maxBytes); }
    catch { throw new Error('library-gcs: invalid reference or bounds'); }
    if (signal.aborted) throw new Error('library-gcs: aborted');
    const charge = 2 * (ref.sizeBytes + limits.metadataBytes);
    if (active >= limits.maxActiveReads || reserved + charge > limits.maxInFlightBytes)
      throw new Error('library-gcs: capacity');
    active++; reserved += charge;
    const controller = new AbortController();
    const deadline = performance.now() + limits.timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectAbort!: (reason: Error) => void;
    const cancelled = new Promise<never>((_, reject) => { rejectAbort = reject; });
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let abortCleanup: Promise<void> | undefined;
    function abort() {
      controller.abort();
      if (reader && !abortCleanup) abortCleanup = cleanup().catch(() => {});
      rejectAbort(new Error('library-gcs: aborted or timed out'));
    }
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(abort, limits.timeoutMs);
    if (signal.aborted) abort();
    function guard() { requireThat(!controller.signal.aborted && performance.now() < deadline); }
    async function cleanup() {
      // Await physical cleanup only inside the tracked operation, never in the caller's abort path.
      if (reader) { const r = reader; reader = undefined; try { await r.cancel(); } finally { r.releaseLock(); } }
      else if (response?.body) await response.body.cancel();
      response = undefined;
    }
    async function request(url: URL, token: string) {
      guard();
      response = await fetchPort(url.href, { method: 'GET', redirect: 'manual',
        cache: 'no-store', signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, 'Accept-Encoding': 'identity' } });
      guard();
      requireThat(response.status === 200 && !response.redirected && response.url === url.href);
      requireThat(!response.headers.has('content-range'));
      const encoding = response.headers.get('content-encoding');
      requireThat(encoding === null || encoding === 'identity');
      return response;
    }
    async function consume(r: Response, bound: number, exact: boolean): Promise<Uint8Array> {
      guard();
      const length = r.headers.get('content-length');
      if (length !== null) {
        requireThat(/^(0|[1-9][0-9]*)(?![\s\S])/.test(length) && length.length <= 16);
        requireThat(exact ? length === String(bound) : Number(length) <= bound);
      }
      requireThat(r.body !== null);
      reader = r.body.getReader();
      const output = new Uint8Array(bound);
      let used = 0;
      for (;;) {
        guard(); const part = await reader.read(); guard();
        if (part.done) break;
        const chunk = boundedBytes(part.value, bound - used);
        requireThat(chunk.length > 0); // Prevent zero-progress stream CPU/allocation churn.
        output.set(chunk, used); used += chunk.length;
      }
      requireThat(!exact || used === bound);
      requireThat(length === null || length === String(used));
      reader.releaseLock(); reader = undefined; response = undefined;
      return exact ? output : output.subarray(0, used);
    }
    const operation = (async () => {
      try {
        guard(); const token = await tokenPort(credentialRef, controller.signal); guard();
        requireThat(typeof token === 'string' && token.length > 0 && token.length <= 8192 && /^[A-Za-z0-9._~+\/-]+=*(?![\s\S])/.test(token));
        const url = new URL(`/storage/v1/b/${bucket}/o/${encodeURIComponent(ref.objectKey)}`, origin);
        url.searchParams.set('generation', ref.generation);
        url.searchParams.set('ifGenerationMatch', ref.generation);
        url.searchParams.set('fields', 'bucket,name,generation,metageneration,size,contentEncoding');
        const metaResponse = await request(url, token);
        requireThat(metaResponse.headers.get('content-type')?.split(';')[0].trim() === 'application/json');
        const bytes = await consume(metaResponse, limits.metadataBytes, false);
        const meta: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
        requireThat(meta !== null && typeof meta === 'object' && !Array.isArray(meta));
        const m = meta as Record<string, unknown>;
        requireThat(m.bucket === bucket && m.name === ref.objectKey && m.generation === ref.generation && m.size === String(ref.sizeBytes));
        requireThat(typeof m.metageneration === 'string' && /^[1-9][0-9]*(?![\s\S])/.test(m.metageneration));
        requireThat(m.contentEncoding === undefined || m.contentEncoding === 'identity');
        url.searchParams.delete('fields'); url.searchParams.set('alt', 'media');
        // Data generation alone does not freeze mutable representation metadata.
        url.searchParams.set('ifMetagenerationMatch', m.metageneration);
        const media = await request(url, token);
        // JSON metadata is authoritative; if media echoes a generation it must agree.
        const generation = media.headers.get('x-goog-generation');
        requireThat(generation === null || generation === ref.generation);
        const actual = await consume(media, ref.sizeBytes, true);
        guard(); requireThat(sha256(actual) === ref.sha256); guard();
        return { ref, bytes: actual };
      } catch { throw new Error('library-gcs: read failed'); }
      finally {
        try { await abortCleanup; await cleanup(); }
        catch { /* Cleanup errors must not expose provider messages or override sanitized failures. */ }
        finally { active--; reserved -= charge; }
      }
    })();
    try { return await Promise.race([operation, cancelled]); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  } });
}
