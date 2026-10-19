import {createHash} from 'node:crypto';
import {describe, expect, it, vi} from 'vitest';
import type {BuildJob, InputApproval, ObjectRef} from '../../build-jobs/src/contracts.js';
import {segmentCounts, type ProjectInputFile, type ProjectInputSegment, type ProjectInputSnapshot} from '../../build-storage/src/project-input-format.js';
import type {BuildAttemptContext} from './controller.js';
import type {LinuxIsolationClient} from './linux-isolated-client.js';
import {prepareLinuxInput, streamLinuxInput, type LinuxInputPlan} from './linux-isolated-input.js';
import {canonicalData} from './parent-profile.js';
import type {StorageWorkerConfig} from './storage-integration.js';
import type {ExecutionScope, RuntimePlan} from './types.js';

const MiB = 1048576;
const projectId = 'linux-input-regression';
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const git = {remote: null, revision: null, historyPreserved: false};
const plan: RuntimePlan = {attemptId: 'attempt', jobId: 'job', kind: 'linux-build-v1', profileHash: 'a'.repeat(64),
  inputRoot: '/unused/input', workRoot: '/unused/work', timeoutMs: 1000, cpu: 1, ramMib: 128, argv: [], env: {}, outputPaths: []};
const context: BuildAttemptContext = {compute: {authorityId: 'authority', workloadId: 'job', leaseId: 'lease', epoch: 1,
  generation: 1, attemptId: 'attempt', capabilityDigest: 'b'.repeat(64), workerId: 'worker', incarnation: 1},
  source: {environment: 'test', authorityId: 'authority', epoch: 1}, serverProfileHash: plan.profileHash,
  localRecipeHash: plan.profileHash, inputHash: 'c'.repeat(64), projectId};

function ref(bytes: Uint8Array, kind: 'objects' | 'manifests' = 'objects'): ObjectRef {
  const sha256 = digest(bytes);
  return {projectId, objectKey: `projects/${projectId}/${kind}/${sha256}`, generation: '1', sha256, sizeBytes: bytes.length};
}

function scopeFixture() {
  const abort = new AbortController();
  const scope: ExecutionScope = {signal: abort.signal, assertLease: vi.fn(), remainingMs: () => 1000,
    reservation: {recordIdentity: vi.fn(), observeStop: vi.fn(), finish: vi.fn()}};
  return {scope, abort};
}

// In-memory object storage only. Metadata still goes through the real decoder,
// path/range/reference validators, approval binding and content hashing.
function fixture(segments: ProjectInputSegment[], objects: Map<string, Uint8Array>) {
  const put = (bytes: Uint8Array) => {const r = ref(bytes, 'manifests'); objects.set(r.objectKey, bytes); return r;};
  const pages = segments.map(s => ({ref: put(Buffer.from(JSON.stringify(s))), ...segmentCounts(s)}));
  const totals = {files: 0, chunks: 0, bytes: 0, required: 0, missing: 0};
  for (const page of pages) for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += page[key];
  const root: ProjectInputSnapshot = {version: 2, kind: 'segmented-input', projectId, segments: pages, totals, git, historyEvidence: null};
  const manifest = put(Buffer.from(JSON.stringify(root)));
  const input: InputApproval = {projectId, manifest, snapshotHash: manifest.sha256, git,
    requiredInputs: segments.flatMap(s => s.requiredInputs), missingInputs: [], reconstructable: true};
  const job: BuildJob = {id: 'job', projectId, inputHash: digest(canonicalData(input)), profileHash: plan.profileHash, maxAttempts: 1};
  const read = vi.fn<StorageWorkerConfig['readInput']>(async r => {
    const bytes = objects.get(r.objectKey);
    if (!bytes) throw new Error('fake-object-missing');
    return bytes;
  });
  const {scope, abort} = scopeFixture();
  const request = vi.fn(async (_body: object, _signal: AbortSignal) => ({identity: 'session'}));
  // The production client is nominal (private fields/constructor). Only its
  // request boundary is used; connect/spawn is never called.
  const client = {request} as unknown as LinuxIsolationClient;
  const prepare = (maxBytes = 2 * 1024 ** 3) => prepareLinuxInput(input, job, plan, context, read, scope, maxBytes);
  const stream = (prepared: LinuxInputPlan) => streamLinuxInput(prepared, client, 'session', input, plan, context, read, scope);
  return {segments, objects, root, input, job, read, scope, abort, request, prepare, stream};
}

function mixedFixture(packedIndex: number, pageCount = 1, mutate?: (segment: ProjectInputSegment) => void) {
  const objects = new Map<string, Uint8Array>(), expected = new Map<string, Buffer>(), segments: ProjectInputSegment[] = [];
  for (let index = 0; index < pageCount; index++) {
    const fullA = Buffer.alloc(MiB, 11 + index), fullB = Buffer.alloc(MiB, 31 + index);
    const tailA = Buffer.from(`tail-a-${index}`), small = Buffer.from(`small-${index}`), tailB = Buffer.from(`tail-b-${index}`);
    const packed = Buffer.concat([tailA, small, tailB]), independent = Buffer.alloc(40 * 1024, 51 + index);
    const blobs: Buffer[] = [fullA, fullB, independent]; blobs.splice(packedIndex, 0, packed);
    const refs = blobs.map(bytes => {const r = ref(bytes); objects.set(r.objectKey, bytes); return r;});
    const makeFile = (name: string, bytes: Buffer, chunks: ProjectInputFile['chunks']): ProjectInputFile => {
      const path = `page-${index}/${name}`; expected.set(path, bytes);
      return {path, classification: 'source-input', retention: 'retain', mode: 0o644, sizeBytes: bytes.length, sha256: digest(bytes), chunks};
    };
    const whole = (bytes: Buffer) => ({object: blobs.indexOf(bytes), offset: 0, sizeBytes: bytes.length});
    const files = [
      makeFile('large-a', Buffer.concat([fullA, tailA]), [whole(fullA), {object: packedIndex, offset: 0, sizeBytes: tailA.length}]),
      makeFile('independent', independent, [whole(independent)]),
      makeFile('small', small, [{object: packedIndex, offset: tailA.length, sizeBytes: small.length}]),
      makeFile('large-b', Buffer.concat([fullB, tailB]), [whole(fullB), {object: packedIndex, offset: tailA.length + small.length, sizeBytes: tailB.length}]),
      makeFile('empty', Buffer.alloc(0), []),
    ];
    const segment: ProjectInputSegment = {version: 2, kind: 'input-segment', projectId, index, objects: refs, files,
      requiredInputs: files.map(f => f.path), missingInputs: []};
    mutate?.(segment); segments.push(segment);
  }
  return {...fixture(segments, objects), expected};
}

function operations(f: ReturnType<typeof fixture>) {
  return f.request.mock.calls.map(([body]) => body as {op: string; path?: string; offset?: number; data?: string});
}

describe('Linux packed input grouping and bounded reads', () => {
  it.each([0, 2, 3])('streams exact bytes once per declared object with final blob index %i', async packedIndex => {
    const f = mixedFixture(packedIndex, 2), prepared = await f.prepare();
    expect(f.read).toHaveBeenCalledTimes(3); // root and two metadata pages only
    const ordered = [0, 1].flatMap(i => ['large-a', 'small', 'large-b', 'independent', 'empty'].map(name => `page-${i}/${name}`));
    expect(prepared.files.map(file => file.path)).toEqual(ordered);
    expect(prepared.filesHash).toBe(digest(JSON.stringify(ordered.map(path => [path, digest(f.expected.get(path)!), f.expected.get(path)!.length, 0o644]))));
    expect(prepared.bytes).toBe([...f.expected.values()].reduce((n, bytes) => n + bytes.length, 0));
    await f.stream(prepared);
    expect(f.read).toHaveBeenCalledTimes(1 + f.root.segments.length + f.root.totals.chunks);
    for (const segment of f.segments) for (const object of segment.objects) {
      expect(f.read.mock.calls.filter(([r]) => r.objectKey === object.objectKey)).toHaveLength(1);
    }
    const restored = new Map<string, Buffer>(); let current: string | undefined;
    for (const op of operations(f)) {
      if (op.op === 'file') {expect(current).toBeUndefined(); current = op.path!; restored.set(current, Buffer.alloc(0));}
      else if (op.op === 'append') {
        expect(current).toBeDefined(); const prior = restored.get(current!)!;
        expect(op.offset).toBe(prior.length); restored.set(current!, Buffer.concat([prior, Buffer.from(op.data!, 'base64')]));
      } else if (op.op === 'end') {expect(current).toBeDefined(); current = undefined;}
      else {expect(op.op).toBe('seal'); expect(current).toBeUndefined();}
    }
    expect([...restored.keys()]).toEqual(ordered);
    for (const [path, bytes] of f.expected) expect(restored.get(path), path).toEqual(bytes);
    expect(operations(f).filter(op => op.op === 'end')).toHaveLength(10);
    expect(operations(f).filter(op => op.op === 'seal')).toHaveLength(1);
    expect(operations(f).at(-1)).toEqual({op: 'seal'});
    for (const [, readContext, signal] of f.read.mock.calls) {
      expect(readContext).toMatchObject({input: f.input, plan, attempt: context}); expect(signal).toBe(f.scope.signal);
    }
  }, 120_000); // CPU-heavy hashing; hit the 30 s default only under heavy host load (load avg 75, 2026-10-18)

  it('fits the 8,705-operation ceiling at 512 segments and 8,192 objects/files', async () => {
    const bytes = Buffer.from('x'), object = ref(bytes), objects = new Map([[object.objectKey, bytes]]);
    const segments: ProjectInputSegment[] = Array.from({length: 512}, (_, index) => ({
      version: 2, kind: 'input-segment', projectId, index, objects: Array.from({length: 16}, () => ({...object})),
      files: Array.from({length: 16}, (_, i) => ({path: `p-${index}/f-${i}`, classification: 'source-input', retention: 'retain',
        mode: 0o644, sizeBytes: 1, sha256: object.sha256, chunks: [{object: i, offset: 0, sizeBytes: 1}]})),
      requiredInputs: [], missingInputs: [],
    }));
    const f = fixture(segments, objects), prepared = await f.prepare(8192);
    expect(prepared.files).toHaveLength(8192); expect(prepared.bytes).toBe(8192);
    expect(f.read).toHaveBeenCalledTimes(513);
    await f.stream(prepared);
    expect(f.read).toHaveBeenCalledTimes(8705);
    expect(operations(f).filter(op => op.op === 'append')).toHaveLength(8192);
    expect(operations(f).at(-1)).toEqual({op: 'seal'});
  });
});

describe('Linux input rejects untrusted bytes, references and interrupted leases', () => {
  it('rejects an approval change before reading', async () => {
    const f = mixedFixture(2); f.input.reconstructable = false;
    await expect(f.prepare()).rejects.toThrow('linux-input-approval'); expect(f.read).not.toHaveBeenCalled();
  });
  it('rejects a byte cap before reading metadata pages or source objects', async () => {
    const f = mixedFixture(2);
    await expect(f.prepare(f.root.totals.bytes - 1)).rejects.toThrow('linux-project-input-cap');
    expect(f.read).toHaveBeenCalledTimes(1); expect(f.request).not.toHaveBeenCalled();
  });
  it.each(['root', 'segment', 'data'] as const)('rejects tampered %s bytes without sealing', async kind => {
    const f = mixedFixture(2);
    const target = kind === 'root' ? f.input.manifest : kind === 'segment' ? f.root.segments[0]!.ref : f.segments[0]!.objects[0]!;
    const bytes = Buffer.from(f.objects.get(target.objectKey)!); bytes[0] ^= 1; f.objects.set(target.objectKey, bytes);
    if (kind === 'data') await expect(f.stream(await f.prepare())).rejects.toThrow('bound-object-invalid');
    else await expect(f.prepare()).rejects.toThrow('bound-object-invalid');
    expect(operations(f).some(op => op.op === 'seal')).toBe(false);
    if (kind !== 'data') expect(f.request).not.toHaveBeenCalled();
  });
  it.each([
    ['foreign project', (s: ProjectInputSegment) => {
      const object = s.objects[0]!; object.projectId = 'other'; object.objectKey = `projects/other/objects/${object.sha256}`;
    }, 'project-binding'],
    ['invalid generation', (s: ProjectInputSegment) => {s.objects[0]!.generation = '0';}, 'invalid-generation'],
    ['overlapping packed ranges', (s: ProjectInputSegment) => {s.files[2]!.chunks[0]!.offset = 0;}, 'project-data-range-overlap-or-gap'],
    ['required file missing', (s: ProjectInputSegment) => {s.requiredInputs.push('missing'); s.missingInputs.push('missing');}, 'snapshot-incomplete'],
    ['case collision', (s: ProjectInputSegment) => {s.files[2]!.path = s.files[0]!.path.toUpperCase();}, 'project-path-collision'],
  ] as const)('rejects %s during metadata preparation', async (_name, mutate, error) => {
    const f = mixedFixture(2, 1, mutate);
    await expect(f.prepare()).rejects.toThrow(error);
    expect(f.read).toHaveBeenCalledTimes(2); expect(f.request).not.toHaveBeenCalled();
  });
  it('detects a whole-file digest mismatch even when object hashes are valid', async () => {
    const f = mixedFixture(2, 1, s => {s.files[0]!.sha256 = '0'.repeat(64);});
    await expect(f.stream(await f.prepare())).rejects.toThrow('linux-stream-file-hash');
    expect(operations(f).map(op => op.op)).toEqual(['file', 'append', 'append']);
  });
  it('rechecks ranges at the streaming boundary', async () => {
    const f = mixedFixture(2), prepared = await f.prepare(); prepared.files[0]!.parts[0]!.offset = MiB;
    await expect(f.stream(prepared)).rejects.toThrow('linux-input-range');
    expect(operations(f).map(op => op.op)).toEqual(['file']);
  });
  it.each(['before-read', 'after-read'] as const)('stops metadata reads on lease loss %s', async when => {
    const f = mixedFixture(2); let lost = when === 'before-read';
    f.scope.assertLease = () => {if (lost) throw new Error('test-lease-lost');};
    const original = f.read.getMockImplementation()!;
    f.read.mockImplementation(async (...args) => {const bytes = await original(...args); lost = true; return bytes;});
    await expect(f.prepare()).rejects.toThrow('test-lease-lost');
    expect(f.read).toHaveBeenCalledTimes(when === 'before-read' ? 0 : 1); expect(f.request).not.toHaveBeenCalled();
  });
  it('stops before sending bytes when the lease is lost during a data read', async () => {
    const f = mixedFixture(2), prepared = await f.prepare(); let lost = false;
    f.scope.assertLease = () => {if (lost) throw new Error('test-lease-lost');};
    const original = f.read.getMockImplementation()!;
    f.read.mockImplementation(async (...args) => {const bytes = await original(...args); lost = true; return bytes;});
    await expect(f.stream(prepared)).rejects.toThrow('test-lease-lost');
    expect(operations(f).map(op => op.op)).toEqual(['file']);
  });
  it('rechecks the lease after broker responses', async () => {
    const f = mixedFixture(2), prepared = await f.prepare(); let lost = false;
    f.scope.assertLease = () => {if (lost) throw new Error('test-lease-lost');};
    f.request.mockImplementation(async () => {lost = true; return {identity: 'session'};});
    await expect(f.stream(prepared)).rejects.toThrow('test-lease-lost');
    expect(f.read).toHaveBeenCalledTimes(2); expect(f.request).toHaveBeenCalledTimes(1);
  });
  it('honors abort before a source read even if the fake broker acknowledges a file', async () => {
    const f = mixedFixture(2), prepared = await f.prepare(); f.abort.abort();
    await expect(f.stream(prepared)).rejects.toThrow('linux-input-read-scope');
    expect(f.read).toHaveBeenCalledTimes(2); expect(operations(f).map(op => op.op)).toEqual(['file']);
  });
  it.each(['file', 'seal'])('rejects a wrong session identity on %s', async target => {
    const f = mixedFixture(2), prepared = await f.prepare();
    f.request.mockImplementation(async body => ({identity: (body as {op: string}).op === target ? 'other' : 'session'}));
    await expect(f.stream(prepared)).rejects.toThrow('linux-input-session');
    if (target === 'file') {expect(f.request).toHaveBeenCalledTimes(1); expect(f.read).toHaveBeenCalledTimes(2);}
    else expect(operations(f).at(-1)).toEqual({op: 'seal'});
  });
});
