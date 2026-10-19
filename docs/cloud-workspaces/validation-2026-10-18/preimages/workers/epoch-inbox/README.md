# EPOCH observation inbox

Local-only Worker adapter for the application-owned event inbox. Disabled by default. No deployment configuration, source listener, polling service, chain RPC, signer, compute dispatcher or model call is created.

## Boundary

An authenticated observation is evidence that a configured source identity submitted bounded content. It is not evidence that the asserted block is canonical or finalized. The inbox never accepts client-selected finality or creates an executable Foundry job. Future reconciliation and proposal dispatch must be separate, versioned components with their own tests and authority.

The inbox owns source registration, accepted event identity/content, a logical source cursor, conflict quarantine, audit, notification outbox and scoped idempotency. Its transaction does not extend into the compute database or Memory. Outbox deliveries are at least once; a future consumer must use stable identities when submitting downstream work.

## Local transport

Host bindings: EPOCH_ENVIRONMENT, EPOCH_AUTHORITY_NAME, EPOCH_AUTH_CONFIG and a SQLite EPOCH_INBOX namespace exporting EpochInboxAuthority. EPOCH_TRANSPORT_ENABLED must explicitly equal true; it is absent by default. The Worker selects the object name from configured environment/name, never from the request.

Authentication reuses the configured SHA-256 bearer verifier. In this application's configuration, owner maps to inbox owner, submitter maps to source observer, and projector maps to outbox projector. Other credential roles are rejected. Observer permission additionally requires a matching source enrollment principal and network. Source registration is owner-only; role/principal headers and envelope context are not trusted. Configuration must contain credential digests only. This implementation creates only invented local test credentials.

POST /v1/epoch/commands accepts exactly `{operation,key,body}`. Operations and domain bodies are documented in packages/epoch-inbox/API.md. POST /v1/epoch/snapshot accepts `{}` and is owner-only. Only HTTPS and bounded JSON bodies are accepted. Shared parser enforces body bytes, read count and an absolute deadline. No cookie identity or CORS permission is supplied.

Source cursors count accepted observations; they are not chain block cursors or finality checkpoints. Different identities competing for one expected cursor cannot silently skip positions. Equal content under an existing event identity is a no-op; incompatible content is preserved as conflict evidence and quarantines the source. The original accepted record is never replaced.

## Evidence and deferred integration

The runtime fixture imports the actual Worker and authority class and runs only in local workerd/Miniflare with disposable SQLite directories. It checks persisted restart/replay, duplicates, competing cursors, injected transaction failure, conflict quarantine, wrong principal/network/environment, forged context and outbox acknowledgment. Test-only fault routes are absent from production code.

Still separate: chain-specific decoders, ancestry/finality reconciliation, conflict recovery policy, automatic workload proposals/dispatch, tracker service activation, external deployment and real credential lifecycle. Unknown phase definitions and the historical contract count remain unresolved until source evidence closes them. Reading a claimed status from an event does not resolve those questions.

## Recovery limits and projection contract

Outbox reads carry immutable observed event content, not just an opaque ID. A projector can therefore recover older observations after restart without owner snapshots. Deliveries are byte-bounded; acknowledgments advance only within a delivered contiguous prefix. Read/ack use the durable monotonic cursor protocol rather than consuming an immutable command row for every poll, so projection can drain at mutation-command capacity.

Observation mutation commands retain exact scoped replay records. Source count, accepted events, normal conflict variants and replay rows are bounded. Each source's first quarantine has separately reserved evidence/notification capacity; normal conflict saturation cannot leave a detected conflicting source healthy. Later variants may fail closed when their bounded evidence store is full. No automatic unquarantine or retention deletion is implemented.

Snapshot arrays expose bounded latest pages and explicit totals/hasMore; they are not a complete historical export. Payloads are raw observations, not normalized chain proofs. Network adapters must later validate exact source formats and encode precision-sensitive integer values appropriately; generic JSON numbers do not establish chain arithmetic precision. Actual listener activation, source finality reconciliation and downstream workload dispatch remain separate work.
