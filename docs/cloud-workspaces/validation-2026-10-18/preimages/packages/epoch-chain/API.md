# Epoch chain API — local schema v3

`EpochChain(port, options)`; `TransactionPort` is the synchronous serialized atomic
`{sql:{exec(query,...bindings):Iterable<Record<string,unknown>>},transactionSync<T>(fn:()=>T):T}` used by inbox/compute.
No HTTP, compute calls, secrets, execution, or consensus validation.

Options: `{environment,authorityId,sourceId,network,observerPrincipal,policy:{version,minTenureTransitions?,minBitcoinConfirmations?},now?}`.
Policy defaults 2 tenure transitions and 1 Bitcoin confirmation; both minima enforced.
Binding includes exact normalized policy and environment/authority/source/network; schema version is checked separately.
TrustedContext: `{environment,principal,role:'owner'|'reconciler'|'observer'|'dispatcher'}` supplied by authenticated host.
All methods synchronous, strict exact input shapes. Owner can call any privileged method;
observer may only observe headers, assigned principal; event projection requires owner/reconciler.

- `observeHeader(context, header): {status:'accepted'|'duplicate'|'conflict',revision}`
  header `{id,hash,parentId,parentHash,height,burnHash,burnHeight,tenureHeight,providerCanonical}`;
  hashes normalized lowercase 64 hex; indexed id and plain hash remain distinct.
- `observeEvent(context, {eventId,headerId,contentHash,template:{id,manifestHash,expectedOutputHash}}): {status,revision}`.
  Parent projects immutable inbox refs after validating decoded/header/inbox association and independently preparing allowlisted read-only template policy. Event id <=1024 UTF8 bytes; template id <=128 safe ASCII; hashes 64 hex.
- `bootstrap(context, {expectedRevision,rootId}): {revision}` owner only; immutable explicit root checkpoint (header must exist).
- `reconcile(context, {expectedRevision,tipId,checkpoint:{anchoredThroughId,anchorHash,anchorHeight,checkpointBitcoinTip},bitcoinHeaders:[{hash,parentHash,height}]}): {revision}` owner/reconciler only.
  Max 512 contiguous Bitcoin headers in ascending order; anchor and tip must be present and linked. Confirmations derive as tip height - anchor height + 1. Full selected Stacks path must reach bound root. Candidate must be ancestor of anchoredThroughId and have >= policy tenure-height transitions through anchor. No source observer can supply finality.
- `quarantine(context, {expectedRevision,reason}): {revision}` owner/reconciler; irreversible source conflict quarantine; suppresses pending submits and enqueues cancellations for possibly submitted work.
- `snapshot(context): {revision,quarantined,rootId,tipId,events,generations,intents,headers}` privileged only; bounded inspection, includes explicit `gaps`.
- `readIntents(context, {after,limit}): {revision,items}` owner/dispatcher; ordinal pagination (after >=0; limit 1..100), includes all statuses.
- `claimIntent(context, {intentId,expectedDeliveryRevision,leaseMs}): Intent | null` owner/dispatcher; host time, max 60s lease; increments deliveryRevision, attempt counter saturates at the safe-integer ceiling; no lifetime retry cutoff; returns null for suppressed/acked/not-current submit. Expired lease can retry stable intent/workload IDs. Re-read/claim immediately before external send.
- `markSubmissionResponse(context, {intentId,expectedEligibilityGeneration,deliveryRevision,workloadId}): {revision,stale,cancelIntentId}` owner/dispatcher; records successful submit even if reorg happened while in flight, and atomically creates compensating CANCEL. Workload id must equal deterministic intent payload id. Generation/issued lease fenced, same exact response replay idempotent.
- `acknowledgeDelivery(context, {intentId,expectedDeliveryRevision}): {revision}` acknowledges CANCEL only; submit requires markSubmissionResponse. Exact ack replay succeeds.
- `retryIntent(context, {intentId,expectedDeliveryRevision}): {revision}` releases current lease for retry; never resurrects suppressed submit.

Intent fields: `{seq,intentId,kind:'SUBMIT'|'CANCEL',eventId,generation,workloadId,headerId,contentHash,template,status:'pending'|'leased'|'suppressed'|'acked',deliveryRevision,leaseUntil,attempts}`.
Generation rows preserve `{eventId,generation,eligible,submitted,workloadId,...}`; a reactivated event gets a new generation and workload id. Each generation reserves one submit and two cancel slots (withdrawal and late-response compensation); no arbitrary executable payloads. Parent owns quota/reservation/admission and exact compute request replay using workloadId. Cancellation receipt is logical only, never physical stop proof. Lease expiry/response loss means at-least-once delivery attempts, never exactly-once execution. The host dispatcher must persist capped backoff and permanent-failure blocking; unresolved cancellation is not abandoned after a fixed lifetime retry count.

`ChainRejected` exposes `code,status` (400 input,403 role,409 state/binding/CAS,507 capacity). Unexpected adapter exceptions propagate. All projection changes and intents commit together. Limits: 512 headers,256 events,1024 generations,3072 intents; bounded payloads and schema checks, no pruning/migration. At generation capacity reconciliation may withdraw eligibility/cancel, but cannot grant more work. New observations fail closed at capacity. Quarantine retains originals and disables new eligibility. No automatic root replacement.

Checkpoint is **trusted reconciler attestation** of Bitcoin anchoring. This checks bounded parent linkage and host eligibility policy only: no PoW, SPV, Bitcoin/Stacks consensus validation or mathematical finality claim. Provider canonical flags are inert observations. Missing parent/discontinuity fails closed. Parent must authenticate reconciliation and independently validate the source/header/event linkage and template allowlist; never expose these methods directly to untrusted HTTP bodies.

Implementation storage: scalar meta + separate relational generation and intent rows; no authoritative whole-state JSON. Header/event immutable bodies are bounded per-row JSON. Snapshot retains all <=256 event refs and <=512 headers; generation/intents inspection is latest64/latest100 with totals/hasMore. Use readIntents ordinal paging for complete intent inspection. `getEvent(context,{eventId}): EventRef|null` is privileged exact lookup.

Workload IDs are `epoch-` + the first 58 hexadecimal characters of SHA-256(binding/eventId/generation), exactly 64 compute-safe ASCII characters, supplied verbatim to parent; no duplicated parent algorithm. Requires node:crypto compatibility in runtime adapter. `markSubmitted` aliases markSubmissionResponse. Response accepts any issued positive lease revision <= current, because all issued attempts share the exact immutable workload; this permits delayed responses after lease reclaim and never authorizes a different job. Parent must correlate authenticated submit response. Late response uses separate `:cancel-response` intent ID (independent compute command key) even if an earlier cancellation was acknowledged. At most three intents per generation.

`providerCanonical` is validated but advisory: header equality excludes this mutable flag. Flag-only updates return duplicate without a revision/quarantine/job; the first observed flag is retained for inspection only. Structural ancestry/hash/burn/tenure conflicts still quarantine. No provider flags belong in the immutable event contentHash prepared by parent. `metadata(context)` returns small `{revision,quarantined,reason,rootId,tipId,checkpoint,policy}` for owner/reconciler/dispatcher.

Schema v3 rejects v1/v2 before DDL repair (`BINDING_MISMATCH`); missing historical authorizations cannot be reconstructed honestly. No migration is implemented. Parent integration/HTTP fixtures that assert schema v2 must change explicitly; all existing method signatures and workload binding/ID derivation remain compatible.

## Immutable decision recovery

`readDecisions(context, {after:number,limit:number}): {revision:number,items:Decision[],hasMore:boolean,nextAfter:number}` is **owner only**, supplied by the authenticated host. `after` is an exclusive ordinal (0..2050), `limit` is 1..100. Both count and **complete JSON response envelope <=524288 UTF8 bytes** bound each page. A legal row is <=196608 bytes and always fits alone. Resume with `after: nextAfter`; `nextAfter` is the last returned ordinal, or the supplied cursor when empty. `hasMore` indicates additional rows in the serialized read transaction; new decisions may subsequently appear. HTTP routing/authentication belongs to parent; this package has no HTTP side effects.

Exported `Decision` fields:
- `seq`, `kind: 'BOOTSTRAP'|'GRANT'|'WITHDRAW'|'QUARANTINE'`, `key` (root/source or workload ID).
- `actor: TrustedContext`, `binding` (canonical options/policy JSON string), `beforeRevision`, `revision`, `rootId`, `reason`.
- `evidence`: reconciliation retains exact checkpoint and full normalized contiguous Bitcoin path, selected Stacks path IDs in tip-to-root order, completeness, confirmation count and quarantine state. Stacks IDs resolve to immutable retained header bodies. Bootstrap retains selected root. Conflict retains original and conflicting normalized objects; parent-discontinuity retains the arriving header (other headers remain immutable).
- `transition`: null for BOOTSTRAP/QUARANTINE, otherwise `{generation:Generation,fromEligible,toEligible,cancelIntentIds:string[]}`. Generation embeds immutable event/template refs and the submitted/eligibility state at decision time. Reasons distinguish eligibility grant, selected path/finality failure, and quarantine causes. Multiple affected generations produce individual records at the same committed revision. Delivery receipts remain in retained intents rather than the decision journal.

Decisions, eligibility transitions, quarantine, checkpoint and intent outbox commit atomically. SQL UPDATE/DELETE/REPLACE of decision rows are rejected. Evidence is immutable local audit data, not externally signed evidence or protection against a privileged database administrator removing triggers.

Capacity proof: at most **1024 GRANT +1024 WITHDRAW +1 first QUARANTINE +1 BOOTSTRAP =2050** retained rows, each <=196608 bytes (<=403046400 content bytes total, excluding SQLite/index overhead). Each generation is granted once and monotonically withdraws once; fresh eligibility requires a fresh generation. Separate SQL per-kind caps prevent grants consuming safety/root capacity. At generation/grant cap, reconciliation skips admission while still withdrawing stale work. Existing delivery/late-response/cancel progress appends no decision rows. Intent reserve remains three per generation. There is no pruning.

No-op reconciliation, same-root bootstrap repeat and repeated quarantine append no decisions. Reconciliation metadata can advance without a decision when no eligibility/quarantine/root control transition occurs; this is a decision journal, not a complete observation/request/delivery log. The first conflict that quarantines retains both original and conflicting normalized bytes. Once quarantined, new structural conflict variants are **rejected** with SOURCE_QUARANTINED, not accepted without evidence. Exact original duplicates (and advisory provider flag flips) remain duplicates. Later rejected variants are outside the retained conflict-evidence scope.

Reserve is a logical capacity guarantee under package-mediated state transitions, not a physical storage guarantee: SQLite write/storage faults propagate and roll back the complete transaction, including withdrawal and decisions. The host must fail closed on such faults. No Bitcoin/Stacks consensus verification or physical stop guarantee is introduced.
