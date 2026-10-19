# Epoch event jobs API v1

Pure synchronous Node functions, exported from `src/index.ts`. No dispatch, I/O,
credentials, URLs, scripts, process execution or live chain access.

```ts
interface EventScope {
  environment: string; authorityId: string; sourceId: string;
  network: 'stacks-mainnet' | 'stacks-testnet';
}
interface JobScope extends EventScope { workloadId: string }
interface EventJobPolicy extends EventScope {
  profile: 'hiro-nakamoto-contract-log/v1';
  allowedContracts: string[]; ramMib: 64 | 128; maxOutputBytes: number;
}
prepareEventSummary(scope: EventScope, eventId: string, event: InboxEvent,
  policy: EventJobPolicy): PreparedEventSummary
planEventJob(scope: JobScope, eventId: string, event: InboxEvent,
  eligibilityGeneration: number, policy: EventJobPolicy): EventJobPlan
executeEventSummary(specification: string): Uint8Array
```

`PreparedEventSummary = {policyHash, expectedOutputHash, expectedOutputBytes}`.
`EventJobPlan` adds `submitBody`, typed directly from compute durable `Command`.
The body has exactly `{workloadId,specification,resources:{cpu:1,ramMib},
policy:{sha256,maxBytes,exitCode:0},pure:true,reconstructible:true,maxAttempts:3}`.
`maxBytes` is the host policy limit (1..4096); too small to fit the output rejects.

**Host boundary:** parent supplies scope, policy and the exact trusted chain
`intent.workloadId`. No second ID derivation or overrides from payload exist.
Workload IDs match compute's 1..64 ASCII `[A-Za-z0-9._-]` grammar. Parent must
bind ID/generation/intent, authorize eligibility, and own epoch-bound command keys.
`eligibilityGeneration` is a positive safe integer. Supplying the same ID across
generations is a parent error: specifications differ and compute rejects collision.

Before `chain.observeEvent`, call `prepareEventSummary` with immutable inbox data.
Use template `{id:'epoch-event-summary-v1',manifestHash:prepared.policyHash,
expectedOutputHash:prepared.expectedOutputHash}`. The host policy hash covers its
exact normalized configuration (allowlist order sorted). It is not compute's
separate verification-policy hash. Output bytes/hash depend only on immutable
event and host policy; workload ID and generation affect only the specification.

Inbox event IDs are checked against canonical
`[sourceId,network,blockHash,transactionId,eventIndex]`. Exact decoder profile,
normalized hashes, contract/network grammar, parent/height/header joins, Clarity
bounds and unknown fields are checked. Host network/contract/profile allowlists
grant permission; payload assertions never grant it. Provider canonical flags
are validated upstream but excluded from immutable payloads, event hashes and
job output; legacy flag-bearing payloads reject. Finality and authentic
source/header association remain parent gates.

Specification is canonical JSON <=16KiB UTF-8 containing frozen identity/policy
and stripped event facts: immutable event/payload/hex/repr SHA256, byte counts,
contract and inbox identity/header facts. Raw Clarity repr/hex is never retained.
Handler validates schema, input hash, whole-spec hash, allowlist and context joins,
then computes fresh canonical output bytes (hashes/counts plus fixed template ID).
No expected bytes are embedded or cached. No filesystem/network is required.
Inputs must be bounded JSON data; accessors, hidden/symbol properties, exotic
prototypes, unsafe keys, sparse arrays, cycles and nonfinite numbers reject.
Proxies are outside the trust boundary. Invalid inputs throw `Error`.

Hashes detect mutation, not malicious re-signing/authentication: the parent must
bind the exact approved specification and expected byte hash to compute. A party
rewriting a valid specification and all its checksums creates a new candidate;
it cannot authorize itself. Compute independently verifies actual output bytes.
This package is a pure function demonstration, not a physical executor, sandbox,
pilot, consensus/finality proof or deployment. Deployment remains gated.
