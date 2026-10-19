# Epoch inbox API (schema v2)

Import `EpochInbox`, `InboxRejected`, `TransactionPort`, `TrustedContext`, `Envelope`, `InboxEvent`, `InboxOptions` from `src/inbox` (also re-exported by `src/index`).

Constructor: `new EpochInbox(port, {environment, authorityId, now?})`. Options are host configuration. Port is structurally identical to compute durable: `sql.exec(query, ...bindings)` returns iterable records; `transactionSync(callback)` is synchronous, serialized and atomically rolls back exceptions. Host owns adapters, authentication and runtime wrappers. Production issues no BEGIN/SAVEPOINT.

`execute(context, {operation, key, body})` is synchronous. Trusted context is exactly `{environment, principal, role: 'owner' | 'observer' | 'projector'}`. Never derive context from client input. Every operation/replay checks environment/authority/schema and current role/source binding.

| Operation | Role | Exact body |
| --- | --- | --- |
| registerSource | owner | `{sourceId, network, observerPrincipal}` |
| ingest | configured observer principal | `{sourceId, expectedCursor, event:{network, blockHeight, blockHash, parentHash, transactionId, eventIndex, payload}}` |
| readOutbox | owner or projector | `{after, limit}` |
| ackOutbox | owner or projector | `{through}` |

Source enrollment is immutable and starts at cursor 0. First enrollment emits `source-registered` audit/outbox; exact re-enrollment creates neither. Enrollment returns `{ok:true,sourceId,cursor}`.

New observations advance only their source cursor by one. Event identity is canonical tuple JSON `[sourceId,network,blockHash,transactionId,eventIndex]`, excluding height/parent/payload/time. Full canonical event content, including height and parent, determines equality. Hashes/transaction IDs are 64 lowercase hex characters; heights/indices are nonnegative safe integers. No observedAt, finality or extra event fields are accepted.

Ingest returns `{ok:true,status:'accepted'|'duplicate',eventId,cursor}`. Duplicate content returns the original accepted cursor even with a different key and stale expectedCursor, without another cursor/audit/outbox write. Differing content returns committed `{ok:false,status:'conflict',eventId,cursor}`; original data remains immutable. First conflict **per source** persists reserved evidence, quarantines that source and emits one conflict notification. Further distinct conflicting content is retained in the bounded variant store without additional notifications. Identical conflict evidence is deduplicated. Quarantined sources reject new identities but permit original-content duplicates and evidence processing. Evidence across both stores has a shared increasing `evidence_seq` for latest-page ordering.

Mutation keys (`registerSource`, `ingest`) are scoped to environment/principal/role and cannot be reused across operations. Exact canonical request plus context replays the persisted response; collisions reject. Mutation response, observation, cursor, audit and outbox commit together. Normal new keys fail closed at command capacity; existing replays work. Up to 128 additional command slots are reserved exclusively for first source quarantine, independent of normal command/variant/audit/outbox capacity.

Read/ack use the durable monotonic prefix protocol **without command records or per-key response replay**. Keys are still validated envelope fields but may be reused. Reads require `after === acknowledged prefix`, limit 1..100, and return `{ok:true,items,acknowledged,delivered}`. Items form a contiguous prefix from `after+1`, capped at **128KiB canonical UTF-8 JSON bytes for the item array**. The response envelope adds less than 1KiB. Delivery high-water tracking persists transactionally across restart. Retrying a read may return already delivered, unacknowledged items. Ack requires `acknowledged <= through <= delivered`; repeating the current ack succeeds, while an older ack rejects with 409. Prefix bounds include reserved entries: 0..11128. Read/ack remain usable at full command capacity.

Outbox item shape:

```
{seq, kind, source_id, event_id,
 audit: {actor, at_ms},
 source?: {network, observer_principal},
 event?: {eventId, cursor, content: <full parsed immutable event>},
 conflict?: {content: <full parsed first-quarantine conflicting event>}}
```

`source` is included for enrollment, `event` for observed/conflict entries, and `conflict` for first-quarantine entries. Immutable binding/audit data is used, never live cursor or quarantine state. Historical event content remains projectable after it leaves snapshot pages. Observation time comes only from host `now` (default Date.now), never event identity.

`snapshot(context)` is owner-only and read-only. Returns `{ok:true,meta,sources,events,conflicts,audit,outbox,commands,totals,hasMore}`. Arrays are bounded latest pages: 8 events/conflicts/command metadata rows; 100 sources/audit/outbox rows. `totals` and `hasMore` are per-array; conflict totals combine reserved first evidence and normal variants. Commands omit request/response. Content-bearing arrays stay below 512KiB. This is latest-page inspection, not historical pagination or bulk export. Snapshot outbox rows are compact references; use readOutbox for complete projection.

All requests reject unknown fields, accessors, nonenumerable/symbol fields, exotic values, cycles and nonfinite numbers. Payload accepts plain JSON objects, arrays and scalars; object keys sort canonically. Limits use UTF-8 bytes: payload 16KiB, canonical context+envelope 32KiB; JSON depth 32, nodes 8192. IDs/principals/network/environment/key are 1..128 ASCII safe characters. Limits: 128 sources, 10000 events, 1000 normal conflict variants plus 128 reserved first-quarantine records, 20000 normal commands plus 128 first-quarantine commands, 11000 normal audit/outbox rows plus 128 reserved quarantine rows. Shared ceilings can cause a normal write to fail before its individual resource ceiling. Reserved safety writes still fail atomically on unexpected storage faults. No credentials or capability secrets are issued or stored.

All tables/triggers are `epoch_inbox_` namespaced. A database binds permanently to environment/authority/schema. **Schema v2 rejects existing v1 and unknown versions before any DDL; no migration is implemented or claimed.** Deployment/migration remains a parent gate.

Expected input/permission/state/capacity rejections throw exported `InboxRejected` with stable `code` (uppercase snake case) and HTTP `status` 400/403/409/507. Examples: `SOURCE_PERMISSION` 403, `CURSOR_MISMATCH` 409, `COMMAND_CAPACITY` 507. Unexpected adapter/SQLite errors remain unwrapped for host mapping to 503. A committed conflict is a result, not an exception. No networking, automatic jobs, canonicality, finality, contract recovery or phase reconciliation occurs.
