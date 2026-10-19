# Epoch persistent pipeline integration

Owns only epoch-dispatch and epoch-pipeline. Parent: root lock, full suite and review.

`EpochPipeline(port, {chain,jobPolicy,coordinatorPrincipal})` composes real EpochInbox,
EpochChain and strict Hiro decoder on one depth-aware synchronous SQL port.
`ingest(observer,{key,expectedCursor,block,transaction,eventIndex})` atomically records
actual inbox observation, normalized header/ref and immutable frozen event/policy.
`register(owner,key)`, `observeHeader(observer,raw)`, `bootstrap(owner,input)`,
`reconcile(owner,input)`, `snapshot(owner)` expose bounded application operations.
Host derives identities; owner explicitly selects checkpoint. No provider flag grants eligibility.

`dispatch()` asynchronously pages/claims real chain intents and uses host-fixed compute
HTTP Fetcher+target, separate submitter/owner bearer references and authenticated owner epoch discovery.
Authenticated owner status determines current epoch; bounded owner workload lookup supplies generation. Submit body
is reconstructed from durable approved event/policy and exact chain ID/generation; hashes
must match chain template. Compute calls are outside application transactions. Command
keys bind intent+epoch (cancel also generation). Cancellation NOT_FOUND remains pending;
only successful cancel or an authenticated existing terminal workload is acknowledged.
Lost response retries stable IDs. Chain late-response fencing creates compensation.
No quota provisioning, distributed transaction, physical-stop or live pilot claim.

Plan rows <=256, frozen JSON <=32KiB, generated specification <=16KiB. Binding includes
schema/environment/authority/source/network/chain policy/job policy/coordinator. No Map
is authoritative. Bounded delivery journal contains codes only, never credentials.

The pipeline binding schema is 2. It composes the inbox at schema 2 and the chain
at schema 3; these are separate version domains. Chain schema 3 supplies
compute-safe 64-character IDs, and integration uses them verbatim. No migration
from an older chain schema is implemented; reopening one fails closed. See
`packages/epoch-chain/API.md` for the chain compatibility boundary.
Owner /v1/status discovers current epoch. Submit uses it directly; cancel calls
/v1/workload for only its workload, never the whole compute snapshot. A concurrent
epoch bump fails closed for retry.

Dispatch scan position persists separately to avoid starvation by earlier retrying
intents. At most 20 delivery attempts per default call (configurable 1..100).
Unexpected claim SQL exceptions propagate; only typed lease/CAS races are skipped.

Pipeline binding schema2 includes durable delivery blocked/retry_at/recovery_generation.
Permanent HTTP/domain denials release the lease then remain blocked without new
claims. Owner-only recover({intentId}) clears the block/backoff and increments an
explicit command recovery generation; workload IDs remain unchanged. No automatic
nonce after quota denial. Transient failures persist exponential backoff (1s..60s).
No lifetime cancellation cutoff. Unknown submission/cancellation stays pending.
Journal entries must reference actual chain intents, are unique and <=3072.
Binding has INSERT replacement guards; partial namespaces fail before core DDL.

Unexpected local plan-read and response/ack persistence exceptions abort the batch
and propagate to the host's redacted 503 mapping. Only call() converts unexpected
fetch/stream exceptions to transient delivery failures. Stable replay after lease
expiry resolves already committed compute admission/cancellation without inventing
an outcome or admitting duplicate work. Explicit typed chain fences remain the
only recoverable chain exceptions in dispatch.

`readDecisions(owner,{after,limit})` delegates to actual EpochChain.readDecisions
with the authenticated owner context. HTTP POST /v1/pipeline/decisions accepts
exactly after and limit: safe integer after 0..2050, limit 1..100, enforced by the
chain API. Returns {revision,items,hasMore,nextAfter}, byte-bounded to 512KiB, with immutable historical actor, path/checkpoint,
policy binding and generation transition receipts. No role is read from the body;
projector/observer cannot read this privileged history.
