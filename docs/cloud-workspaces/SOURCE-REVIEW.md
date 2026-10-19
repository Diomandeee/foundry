# Cumulative static source review

Verdict: **local implementation candidate; HOLD operational acceptance and integration**. Current extension and scoped evidence: [2026-10-18 continuation](continuation-2026-10-18/README.md); root-level source hashes remain the prior frozen candidate. This receipt is source inspection, not compilation or runtime evidence. Final source hashes and the task-scoped patch define the candidate. Inherited integration findings remain in `R1-FINDINGS.json`; no feature completion closes them.

## Independent review dispositions

| ID | Initial issue | Source disposition |
| --- | --- | --- |
| B01 | Historical `stopped` could fail a successor/alter a terminal attempt | Allowed-state/held-slot checks and generation-conditioned job updates; terminal states retained. |
| B02 | Verifier could accept a success manifest missing required outputs | Exact required output set plus actual chunk/full-file hash and byte checks. |
| B03 | Rejected operations rolled back clock/expiry, permitting later revival | Separate committed high-water/expiry maintenance before requested mutation. |
| B04 | Frequent renew/census records could exhaust stop/recovery journal capacity | Bounded latest sequence heads; recovery transitions retain independent capacity path; no census/renew immutable event flood. |
| B05 | One-MiB reference bound prevented larger valid outputs | Explicit bounded chunks, full-file SHA/size and actual pinned reads; archive bundle format is explicit. |
| O01 | New build UI retained protected data after logout | Shared session event, DOM/state clearing and generation guards for asynchronous callbacks/downloads. |
| O02 | Reload/lost submit response could create duplicate build intent | Durable host journal precedes dispatch; recover pending/submitted exact selection; explicit client acknowledgment. |
| O03 | Bridge's 64KiB accepted-result limit could reject valid receipts | Bounded upstream result allowance raised to 1MiB; smaller credential-free browser projection. |
| S01 | Known incomplete output set could publish before rejection | Complete required output selection checked before capacity admission/writes. Empty files are explicitly represented, not silently omitted. |

These are source fixes, not passing regression claims. Required future cases appear in `DEFERRED-VALIDATION.md`. Later reviewer checkpoints and residual findings follow below.

## Parent static passes

- **Structure:** new packages/exports, route families, actual manifests, protected snapshot boundaries, isolated artifact roots, and task-scoped preimages.
- **Correctness:** exact owner-approved selection; deterministic eligible worker preference; expiry/high-water/idempotency; stop/quarantine; complete artifact lineage and verification. No silent fallback to another architecture, Xcode, source generation or command.
- **Security:** identity from authentication/enrollment; recheck after awaits; no browser credentials/grants; private bounded broker reads; no raw capability persistence; no same-user hostile-code sandbox claim.
- **Data/recovery:** originals/variants preserved; missing inputs remain unknown; snapshot approvals do not prove builds/history; archive generation and actual-byte hashes; uncertain attempts/HTTP outcomes retained.
- **User journey:** source-followed browser→host journal→authority→worker controller→runtime→publisher→verifier→download. UI disables unavailable actions and labels bounded/truncated observations. No browser journey was exercised.
- **Governance/operations:** all new activation flags remain disabled/unset; no provisioning/install/spend/secret/merge/deployment/cleanup approval inferred; exact next gate recorded.

Contrarian challenge: source code and hashing can expose bugs and bind review bytes, but cannot demonstrate filesystem semantics, physical stop containment, toolchain compatibility, actual GCS behavior, grant authority freshness or UI usability. Therefore neither this review nor absent further static findings can produce a READY verdict.

## Explicit prerequisites and limitations

- Native Xcode now has actual ES observer collection source and a signed process-journal client/verifier, but complete descendant/shared-service termination remains unimplemented. Placement explicitly denies current Xcode profiles with `native-termination-attestation-not-supported`; even a zero-exit direct native invocation retains quarantine. A separate user account/process group is not a hostile-code sandbox or Linux cgroup equivalent. Hard native CPU/RAM containment is not claimed.
- The continuation implements actual durable scope approvals, issuance/capacity/tombstones and command-key revocation delivery in an explicit online broker mode. Compute checks use nonce-bound authenticated online observations before/after async operations, distinct from synchronous local policy state. Legacy synchronous mode is preserved. Real deployment identities, durable DB provisioning, provider permissions and operational acceptance remain gated; no old HTTP observation is presented as a current synchronous mirror.
- Fleet archives require published chunk packages and explicitly reviewed durable namespace capacity. Local preparation/session planning does not publish objects, create namespaces or reset lifetime budgets.
- Legacy v1 inputs retain the bounded pilot format. V2 adds segmented manifests, packed small files and sharded local CAS; structural ceilings are 8,192 selected files/4GiB data/64MiB per file, further constrained by a finite approved namespace set (32 grants/8MiB each). The existing approval contract still limits required paths to 128. Dependency/asset/history completeness is not inferred, and larger required-path sets cannot silently truncate into an approval.
- Provider/credential/identity/installation and tree sealing are trusted host prerequisites. The GCS writer and host composition are concrete source adapters, but no account, provider transport, root, account or credential was configured or called.
- Current observed Mac disk headroom is below the 50GiB policy. Accepted reclaimable bytes are zero. Source-code offload by itself is insufficient evidence that headroom can be met; further authorized inventory/cleanup or approved storage capacity is required.
- Linux dependencies are preloaded/offline in the initial runtime. Profiles requesting a network dependency policy without configured enforcement are refused. No SDK, simulator, dependency or signing installation is implicit.
- Original R2 HOLD and the remaining inherited findings are still integration blockers. No gate check was executed and no merge occurred.

## Exact stop

Stop after local source implementation, cumulative source review and receipt preparation. Before operational work, review unresolved native/current-authority/project-scale prerequisites and obtain the matching approvals. Tests, typechecks, trial builds/restores, service starts, installation/provisioning, provider operations/spend, secret changes, merge/deployment and all cleanup remain gated. R7 is not executed.

## Second review source dispositions

- B06: negative stop evidence is recorded at most once per attempt; a new key cannot flood safety recovery history. A later confirmed stop remains possible.
- B07: stored census now includes enrollment revision/incarnation; replacement credentials cannot reuse an earlier incarnation's fresh opt-in/toolchain/capacity report.
- B08: final verification maintenance commits independently, and its captured timestamp is used in the subsequent atomic acceptance transaction. Requested commands likewise avoid a later rolled-back clock observation.
- B09: renewal rate checks use explicit persisted `renew_ms`, independent of clipped lease expiry.
- B10: initial portable output profiles are capped at 7MiB/24 required paths, with 31 total result chunks plus a manifest, fitting a fresh 32-grant/8MiB broker namespace. Actual namespace occupancy still requires real capacity admission; old history is never reset. Generic storage hard ceilings are not promised usable capacity.
- B11: remote refresh uses monotonic round-trip duration and authority-relative remaining lifetime, rather than comparing clocks across hosts. Broker grant expiry/current observations remain in the broker's own declared clock domain; the actual synchronous current-authority port is still required.
- O04: recovery request aliases are persisted before responding, so request B recovering intent A stays bound to A even after a lost acknowledgment response. Alias and intent histories are bounded, retained and never reset automatically.
- O05: placement revisions invalidate stale success/failure callbacks after a selection or feed change.
- O06: downloads have abort controllers tied to session clearing and generation checks before every request and after every body read.
- L01/L02: independent review identified filesystem-alias ancestry and trickling-response deadline issues in snapshot/broker reads; final library receipt records the implemented fixes or remaining limits.

No item above is a passing regression test. Later validation must reproduce the counterexample scenarios against frozen source bytes.

## Final bounded review checkpoints

The independent authority reviewer found no remaining actionable bug in the bounded pass over B06–B11, while retaining activation blockers. The independent operator reviewer accepted the reviewed recovery/session/placement/download source fixes, including the explicit repeat control; this is not approval to activate. The independent library reviewer accepted the filesystem-alias/deadline contract fixes at the observed source checkpoint; the concrete bounded transport is a subsequent source addition and its implementation limits are recorded in LIBRARY-REVIEW.md.

O07: default submission now recovers the latest matching receipt even after acknowledgment; a new execution requires the separate explicit-repeat choice. Thus an unrecorded fresh browser request after a lost acknowledgment cannot silently create another job.

Additional parent inspections: exact wrapper environment/authority/epoch source pins on worker commands/next/census, cache-completeness admission, immutable worker-preference conflict rejection, and live-fence checks on renewal replay. All await compilation/runtime evidence.

The parent recovered 19 exact pre-edit files using baseline SHA equality, allowing a task-specific patch despite the dirty/untracked checkout. Recovery output uses inert .before suffixes. The parent also guards Linux phased stop/inspection against a changed active-phase identity across an await; prior-phase proof cannot release a successor phase.

Final parent source inspection also records candidate/rejected placement reasons and facts before slot allocation in immutable claim/event history, renders effective expiry/fencing and attempt stop state, and adds private verified log-chunk retrieval using the same accepted-receipt reader as output chunks. These additions were inspected locally after the bounded independent checkpoints and have not been executed.
