# @foundry/library-gcs

Local, server-only immutable GCS GET adapter for `storage-broker`. No provider SDK or added runtime dependency. Construction performs no I/O. The package uses Node builtins and sibling `library-jobs` inert-data/native-byte helpers; tests use the repository's existing Vitest installation. Node 24 is used for the real in-memory SQLite broker fixture.

```ts
import { createGcsReader } from './src/index';

const provider = createGcsReader({
  origin: 'https://storage.googleapis.com',
  bucket: 'host-selected-bucket',
  projectId: 'project-a',
  credentialRef: 'host-gcs-reader',
  limits: { maxReadBytes: 1024 * 1024, maxActiveReads: 4, timeoutMs: 5000 },
}, {
  fetch: globalThis.fetch,
  getAccessToken: (credentialRef, signal) => hostTokenPort(credentialRef, signal),
});
// Supply provider.readObject as BrokerPorts.readObject on the trusted server.
// hostTokenPort is the host's managed-identity port, not implemented here.
```

`readObject(ref, maxBytes, signal)` returns `Promise<{ref, bytes}>`, directly compatible with `BrokerPorts['readObject']`. The returned ref is a copied, frozen exact reference; bytes are a fresh native, nonshared `Uint8Array`. No URL, access token, or provider response escapes in the result or error. Host configuration and trusted ports must never be supplied by a worker. Authentication, current catalog/compute authorization, durable grant accounting, revocation and replay remain the broker/host's responsibilities. The adapter itself is not an authorization authority.

References have exactly `{projectId, objectKey, generation, sha256, sizeBytes}`. They use the configured project, lowercase 64-hex SHA-256, positive safe-integer size, and positive 1–32 digit decimal generation without leading zero. Keys are exactly `projects/<projectId>/objects/<sha256>` or `projects/<projectId>/manifests/<sha256>`. Identifiers use `library-jobs`' 1–96 character inert identifier rule. Native inert-data checks reject proxies, accessors, symbols, inherited data, extra fields and unsafe prototypes without invoking user code. Like the native contracts, generation stays a string; a syntactically valid generation outside GCS's actual numeric range fails at the provider, without coercion or retry. Empty objects are deliberately rejected here because this API requires positive size, even though the broker's general ref contract permits zero.

The host origin must be exactly `https://storage.googleapis.com`, with no slash, credentials, port, path or query. The fixed bucket accepts a conservative 3–63 character lowercase alphanumeric/underscore/hyphen subset, starting and ending alphanumeric; dotted/long bucket names are intentionally unsupported. The opaque credential reference is an inert host lookup identifier. No ADC discovery, credential file/env reading, token minting, refresh, auth changes or SDK initialization occurs here. The host token port owns least-privilege identity selection, token lifetime and secure handling; the adapter uses the token only in the Authorization header. Node fetch has no ambient browser cookie jar. Do not use this package in browser/worker-facing code.

Each admitted read requests one bounded JSON metadata response, then one media response, both using `generation` and `ifGenerationMatch`. The object key is encoded as one path component. Metadata requests select only bucket/name/generation/metageneration/size/contentEncoding; bucket, name, string generation and decimal string size must match the pinned ref before the media GET. Metadata `metageneration` must be a canonical positive decimal string (no numeric coercion, sign, leading zero, whitespace or exponent); its length is bounded by the metadata response cap. The media GET additionally carries `ifMetagenerationMatch` equal to that observed string, while retaining both `generation` and `ifGenerationMatch`. Generation pins object data, but metadata such as `contentEncoding` can change without changing the data generation. This precondition ties media delivery to the encoding check; a concurrent metadata update fails closed with HTTP 412 before body consumption, with cancellation and no retry or metadata refresh. Metageneration is per-read provider state and is never added to the immutable `ObjectRef`. See Google’s [metadata/data association guidance](https://docs.cloud.google.com/storage/docs/request-preconditions#object_metadata_association) and [Objects: get preconditions](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/get). Caller-written hash metadata is not proof: actual downloaded bytes must match the pinned SHA-256 and size. The adapter ignores response links rather than following them.

Both requests use GET, manual redirects, no cache and `Accept-Encoding: identity`. Only HTTP 200 is accepted, with the exact response URL, no redirected flag or Content-Range, and absent/identity Content-Encoding. Metadata must be JSON, and stored encoded objects are rejected to avoid decompressive transcoding. Content-Length, when present, must be canonical decimal and match actual bytes; media length must also match the ref before allocation. Missing media length is accepted with streaming byte limits. The media generation header is optional because this implementation uses the JSON API's pinned query and checked JSON metadata; if supplied it must agree. The XML header reference is not treated as a guarantee that JSON media always includes that header. No range reads, uploads, sessions, arbitrary URLs, requester-pays project selection or retries are implemented. A successful call makes two GETs; a metadata failure makes at most one. Provider charges and hidden retries must be reviewed separately before any live use.

| Bound | Hard maximum/default | Behavior |
| --- | --- | --- |
| `maxReadBytes` | 8 MiB | Admission requires positive ref size ≤ caller max ≤ host cap |
| `maxActiveReads` | 8 | Reject immediately; no waiting queue |
| `maxInFlightBytes` | 32 MiB | Reserve `2 × (ref.sizeBytes + metadataBytes)` before token/fetch |
| `metadataBytes` | 16 KiB | Stream into a fixed bounded allocation, never `response.json()` |
| `timeoutMs` | 10,000 | Whole-call deadline including token, both requests and stream reads |

Host overrides can only lower positive integer caps; unknown limits fail. The byte reservation conservatively covers adapter output and native chunk copies plus bounded metadata, not transport/kernel buffers or total process RSS/GC overhead. Native chunks are checked before copying into the fixed output allocation; oversized, shared and zero-progress chunks fail. There is no concatenation of unbounded chunk lists.

Abort/timeout rejects the public promise even if the token provider, fetch or stream ignores AbortSignal. The adapter aborts the downstream signal and attempts stream cancellation. A timed-out operation retains its active/byte reservation until its underlying operation and cleanup settle; a permanently uncooperative port can therefore exhaust this reader and needs host supervision/replacement. Late fetch responses are cancelled and never delivered. Cancellation/cleanup error text is suppressed. JavaScript cannot preempt a synchronous callback, stop a dishonest port from allocating before returning, or guarantee termination of an external request that ignores cancellation. Trusted ports must use bounded native streaming transport, honor abort, avoid prebuffering and implement no implicit retries; returned results cannot retroactively repair an unsafe host port.

Run from `/Users/mohameddiomande/Developer/foundry-integration/source`:

```sh
node_modules/.bin/vitest run --config packages/library-gcs/vitest.config.mjs --configLoader native --reporter=verbose
node_modules/.bin/tsc -p packages/library-gcs/tsconfig.json
node_modules/.bin/tsc --noEmit --incremental false
```

The package-local native Vitest configuration disables test/filesystem module caches and directs Vite cache output under this package. Fixtures inject HTTP Responses and native streams without opening sockets or calling GCS; the broker journey uses only in-memory SQLite. Saved command output is in `test-results.txt`, `package-typecheck.txt` and `root-typecheck.txt`. These are local proofs, not deployment or live provider evidence.

Google primary sources reviewed 2026-10-17: [Objects: get](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/get), [Object resource](https://docs.cloud.google.com/storage/docs/json_api/v1/objects), [Request preconditions](https://docs.cloud.google.com/storage/docs/request-preconditions#object_metadata_association), [Request endpoints](https://docs.cloud.google.com/storage/docs/request-endpoints), [Decompressive transcoding](https://docs.cloud.google.com/storage/docs/transcoding), [Authentication](https://docs.cloud.google.com/storage/docs/authentication), and [XML response generation header](https://docs.cloud.google.com/storage/docs/xml-api/reference-headers#xgooggeneration).

Deployment: **NOT RUN; gated**. No installation, provider calls, spend, credential changes, commit or deployment are authorized by this package's local implementation task. Live host identity/IAM, egress restrictions, native transport behavior, generation retention, provider errors/charges and operational supervision still require separate evidence and approval.
