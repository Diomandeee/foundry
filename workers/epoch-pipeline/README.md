# Epoch application pipeline

Default-disabled production-shaped old-style SQLite Durable Object. This slice is
local software only: no live chain listener, provisioning, deployment or real
worker pilot. Fixed namespace is environment + configured authority name.

Host configuration `EPOCH_PIPELINE_CONFIG` is a JSON PipelineOptions record. Its
chain environment/authorityId must equal EPOCH_ENVIRONMENT/EPOCH_AUTHORITY_NAME.
Source/network/observer, contract allowlist, checkpoint policy and job policy are
immutable database bindings. Schema changes require reviewed migration/recreation.
Host auth digest entries follow compute transport authentication. Configured
submitter maps to observer; owner registers/reconciles/checkpoints; projector or
owner dispatches. Internal coordinator identity is host config, never request data.

POST JSON paths: /v1/pipeline/{register,observe,header,bootstrap,reconcile,snapshot,dispatch,recover,decisions}.
Observe accepts exactly key, expectedCursor, raw Hiro block, raw transaction and
eventIndex. Header observations never select the head. Reconcile accepts actual
EpochChain checkpoint/Bitcoin indexed ancestry inputs. Eligibility is explicitly
provider/checkpoint-attested host policy, not consensus/SPV/PoW verification.

FOUNDRY is a fixed compute Fetcher binding, COMPUTE_TARGET a host-fixed HTTPS
origin. COMPUTE_OWNER_BEARER and COMPUTE_SUBMITTER_BEARER are host-provided secret
references with separate roles; COMPUTE_SUBMITTER_PRINCIPAL binds workload owner.
Declarations do not provision actual secrets. Owner-only /v1/status discovers the actual authority epoch; the authenticated
bounded owner /v1/workload validates that epoch and supplies only the targeted workload generation. An
epoch bump between these reads fails closed for retry.
Never infer epoch from event data or retry with a client-selected identity.

Preinstall tenant quota administratively. Quota denial is a durable compute
command result for that intent+epoch; dispatch never grants quota or rotates
keys to evade admission. Permanent denials durably block further claims. After host admission/auth repair,
owner-only recover({intentId}) increments an explicit recovery command generation
while retaining the exact same workload identity. Epoch recovery uses fresh owner
status, with no full compute snapshot.

Atomic application ingest includes immutable accepted inbox content, decoded
header/event refs and frozen bounded approved metadata. Cross-authority delivery
is at-least-once and outside SQL; no distributed transaction. A missing workload
cannot prove cancellation or no submission. Transient failures persist capped exponential backoff from 1s to 60s across
restart; cancellations have no lifetime attempt cutoff. Permanent blocks require
explicit owner recovery. Codes persist for owner inspection. Late successful submit
is recorded by chain fencing and creates a compensating cancel. Existing terminal
receipts remain intact with app supersession. Compute quarantines physical worker
resources; logical cancellation never proves physical stop.

Tests are disposable Miniflare 5 local fixtures: actual entry fetch -> SQLite DO
on both sides, shared host Fetcher object with fixed target, invented credentials,
persisted restart, pure handler, real sealed upload and independent verification.
Failure/pause routes exist only in test-support strings, never production imports.

Owner-only POST /v1/pipeline/decisions accepts exactly {after,limit}. It delegates
unchanged to chain readDecisions (after 0..2050, limit 1..100, safe integers) and
returns {revision,items,hasMore,nextAfter} within 512KiB. Receipts preserve the historical authenticated decision
actor, selected path/checkpoint, bound policy and eligibility transition across
restart; later reconciliation does not replace earlier evidence. An internal
source-quarantine decision records the host coordinator identity, not a forged
observer/body identity. This endpoint neither selects a head nor dispatches work.
