# Cumulative source review — continuation checkpoint

Verdict: **R6 local source candidate, HOLD integration/operational acceptance.** Broker and segmented-input implementation have bounded independent source approvals after repair. Native complete termination remains an engineering blocker; no Xcode placement or stop success is claimed.

## Independent findings

| ID | Source counterexample | Disposition |
| --- | --- | --- |
| CB01 | Temporary heartbeat denial could install permanent tombstone | Current denial separated from authority-classified irreversible fencing; uncertain reads fail without tombstoning. |
| CB02 | Lost capacity receipt caused a second debit | Stable exact operation-key/need receipt replay, including namespace history search before capacity choice. |
| CB03 | Caller abort did not reach issue/read/provider work | Required online signals, linked remote/provider cancellation, no new work after abort; duplicate online flights reject busy. Physical settlement still owns occupancy. |
| CB04 | New revocation commands received substituted acknowledgments | Separate per-grant deny and exact command-key journal; actual core command receipts returned unchanged. |
| CB05 | Extra online recheck changed legacy observation schedule | Additional entry check inside online branch; legacy shared-waiter path preserved in source. |
| CB06 | Signal-aware HTTP reader was absent from host interface | Explicit optional typed method and legacy fallback. |
| CB07 | One inactive namespace prevented unrelated valid selection | Read-only immutable history across all members; inactive bound operation holds, unrelated inactive candidate skipped; uncertainty propagates. |
| CB08 | Preliminary HTTP refresh ignored request cancellation | Reject before admission/invocation, linked abort, cleanup and no-success guard; unsettled refresh keeps its slot. |
| CI01 | Constructed v2 ports needed an unknown future attempt fence | Post-claim resolver with branded actual context; concrete finite owner-approved job/generation templates; no guessed scope. |
| CI02 | Verified input tree differed from npm/cargo execution tree | Independently verify both input root and approved-recipe working-source copy against the same immutable root. |
| CI03 | Tighter controller cap applied after hydration | Controller supplies cap into concrete restore; minimum cap checks root totals before source hydration/materialization. |
| CI04 | Equal-size manifest and local roots could bind different hashes | Approved ref SHA and authenticated root bytes both equal snapshotHash before format dispatch. |

All twelve are source dispositions, not passing regression results. Initial reports remain unchanged as historical evidence. BROKER-REVIEW-FINAL.md and INPUTS-REVIEW-ROUND2.md describe their exact bounded scopes and observed hashes. No broad security, compiler, filesystem, host-stop or deployment certification is implied.

## Parent passes and late changes

- Structure: actual exports, imports/calls, additional online-mode identity, schema/retained-state boundaries, source-only native collector/protocol.
- Correctness: key/payload replay, exact compute/owner/template binding, finite capacity, complete input range/count/path checks, independent working-tree bytes, staged-versus-verified outputs.
- Security: credential resolution remains host-only; no raw capability in context/journals/artifacts; nonce/source pins and independent authorizations bracket awaits. No models/memory enter the merge decision.
- Recovery: deny commits before delivery; reservation and grant intents precede provider calls; ambiguous history never silently becomes capacity; stop uncertainty/quarantine remains retained.
- Journey: trace source from approved input/recipe through placement, claim, post-claim input and output storage resolution, restore verification, execution, packaging, broker reads and independent verification. Native placement intentionally reports unsupported.
- Governance: no tests/typechecks/imports/probes, provider operations, installs, spending, secrets, Git mutations, deployment or cleanup. All approvals and R7 activation remain closed.

Parent corrected output admission to reserve chunks plus full bounded manifest overhead before writes; staging reuses that same debit. This supersedes the storage sidecar's historical split-admission discussion. Empty regular outputs still need no zero-size provider object, only their actual result manifest.

After the bounded broker approval checkpoint, parent additionally validates existing reservation-history rows (shape, row ID, scope and exact need) so corrupt content cannot masquerade as absent history. The result-storage resolver was factored into the same finite post-claim binder; its call shape and runtime integration were then independently reviewed by the input reviewer. Those late bytes do not inherit blanket broker approval. They received parent source inspection; review coverage is recorded explicitly rather than claiming every final byte was independently audited.

Contrarian challenge: hashes identify the inspected candidate; they do not prove compilation, transport semantics, physical provider cancellation, filesystem exclusivity, job behavior, secret isolation in an installed host, or complete native service termination. Therefore there is no READY verdict and no operational stage is complete.

## Supported source versus blocked behavior

Implemented: online broker host/capacity/issuance/revocation composition; finite namespace selection/recovery; real GCS adapter composition; segmented v2 packaging/population/materialization/independent byte verification; actual post-claim scope and result-provider binding; ES raw collector and signed process-journal diagnostics. None was executed as validation.

Still blocked: native privileged companion plus complete launchd/XPC/shared-service containment and current-lease physical launch fencing; actual managed-tree sealing; host/account/provider identity and durable DB provisioning; disk headroom; finite owner-approved namespace resources; input assets/dependencies/history completeness; required-path contract above 128; all inherited integration HOLD items; all operational validation and activation. V2 structural ceilings do not promise all combinations fit a real approved namespace set. Existing GCS source snapshots/original project folders remain untouched.

Exact stop: after local implementation, source review and scoped receipt preparation. C3.2 (full native containment) is not implemented. R7 is unstarted. Next local engineering is a supported full native supervisor/containment design and implementation; operational validation, installation, provisioning, spending, secrets, merge/deployment and cleanup each require the applicable separate approval.
