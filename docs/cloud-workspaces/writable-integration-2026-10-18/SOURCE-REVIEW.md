# Source review

Verdict: **bounded Mac VM storage path and listed integration repairs implemented; validation pending; cumulative production HOLD**. Six inline passes were performed by the implementing agent, followed by a counterexample pass and corrections. This is not independent review and no compiler, test, helper or runtime was executed.

## 1. Structure and authority

The new native service is a separate root-owned immutable object API. It does not implement or pretend to implement `ManagedTreeSeal`. The adapter constructs `createMacIsolatedContentStore` from fixed installed pins; intake checks its private factory brand. The broker's actual writer, issuer and capacity are selected explicitly after claim. Root image IO remains the existing owner-mediated path. Mutable restoration retains its required seal; generic Linux materialization is still unsupported without a concrete isolation implementation.

CAS requests contain no filesystem path, command, mount or destination. Namespace ancestry, descriptors, UID, device, type, links and ACLs are checked. Root administration and the approved interpreter/stdlib are explicit trust assumptions. Peer UID controls access; this is one trusted controller's local store, not a multi-tenant storage authorization service. Pi, stock Codex, N'Ko, SpaceFS, original projects and external infrastructure were not changed.

## 2. Source/API compatibility

Read all new service/client/receipt source and changed storage, adapter, gate and relay paths. Checked call-site signatures and local installed dependency declarations by reading source only. Packaging's optional exclusive seal is guarded by an explicit readonly-or-exclusive requirement. Writable materialization APIs still require a seal. The production VM config now uses `storage` pins, so a caller passing the old injected `packaging` config needs an explicit source update; no installed caller was modified.

The local Cloudflare types declare tree mode/type/hash; isomorphic-git's declarations expose `hashBlob`, `readTree`, `listServerRefs`, and structured push acknowledgment. The source now checks the destination acknowledgment instead of assuming any resolved push succeeded. Compilation and old test compatibility remain unproved. There are no executable source copies in evidence folders: preimages/after-images carry `.before`/`.after` suffixes.

## 3. Integration and persistence

Traced guest success through authenticated stop, immutable intake, concrete CAS, post-claim broker publication and separate authority verifier. No route promotes a local CAS receipt into cloud generation, lease permission or verified result. Abort after an admitted local write can leave a private immutable object; publication still requires current broker authorization.

Gate reads are pinned to the event proposal. Complete tree enumeration includes every intersection edit, mode/type change, addition and deletion. Enumeration failure becomes unknown. Merger source independently proves actual proposal objects against the admitted UTF-8 text and compares the complete landed overlay. Existing base entries outside the admitted set remain identical. Unsupported modes/binary transport fail explicitly.

Verification receipts persist before merge, bind content/event/base/policy/result, and read back exactly. Decision rows retain the receipt. Missing migration/column/store is a refusal; no synthetic persistence fallback remains. New strict verification policy is implemented but not enabled. It records a trusted verifier response rather than proving external execution.

## 4. Failure, concurrency and recovery

Reviewed: same-UID direct mutation; wrong peer UID; forged reference; hash mismatch; hardlinks/symlinks/ACLs; oversized frames; quota; partial create; client abort; stale socket; startup inventory; a stalled syscall; reply loss; guest stop uncertainty; stale broker fence; remote outages; incomplete Git trees; base movement; genesis; replay after a pushed commit; rejected push; unresolved relay credentials/read/cancellation; failed cancellation acknowledgment.

The CAS serializes service operations, retains partial immutable evidence and never overwrites. Client occupancy ends on actual child close, not promise rejection. Server restart requires explicit stale-socket reconciliation; no automatic deletion exists. Disk free-space checks do not reserve space against unrelated writers. Authorized callers can exhaust their configured quota; guest code is not authorized to invoke the socket.

Local genesis explicitly creates the proposal-parent wrapper. Production genesis requires positive empty-ref evidence. Replays require exact current-head lineage and whole-tree evidence. Later-head/ambiguous cases hold. Local Git uses exact expected-ref push leases. Production checks ref freshness before push, uses non-force receive-pack behavior, and checks returned status; real concurrent server behavior is deferred acceptance, not a claimed transaction proof.

Relay occupancy is process-wide. A pending credential, response read or cancellation retains its slot. A rejected cancellation quarantines the slot because physical cessation is uncertain. Four unresolved/quarantined slots hold the process closed. Only separately approved reconciliation/restart can restore capacity; no silent reset was added.

## 5. Content and operator journey

Read K11's local rollout and receipt files, inspected source schema/queue/recovery/timeout paths, and recorded hashes. The reported Windows rollout does not provide Foundry lease/whole-process termination evidence. Its natural automatic MotionMix canary remains open. The external Fleet Console is observation only. No enrollment, Windows executor, dispatch, polling, recording, publishing or service operation was added.

The Mac source journey is connected. The installed/running/validated/approved states remain absent. Source catalog entries are still not complete buildable backups. Required assets/history and capacity claims require per-project evidence. Authority required paths above 128 and generic Linux writable materialization remain explicit unsupported cases.

## 6. Governance, deployment and evidence

All actual commands in this batch were source/document reads, text edits, metadata/hash/diff generation and public documentation reading. No tests authored or executed, compilation, application imports, trial builds/restores, helper/VM/service starts, installations, migrations, network control-plane changes, spending, secrets, Git commits/pushes/merges, publication or cleanup.

Original M1–M3 evidence remains unchanged. Current route points here; old R1 findings remain historical evidence, with current dispositions in `FINDINGS.json`. Code must not deploy before independently reviewed validation, actual schema preflight and matching operational approvals.

## Counterexamples corrected during review

- A readonly collector still required a meaningless writable seal: made read-side selection explicit while retaining mutable restore requirements.
- A result resolver could supply extra runtime properties through object spread: now selects writer/issuer/capacity explicitly alongside the private CAS.
- A reply could carry substituted CAS references/bytes: exact keys, canonical ref, base64, size and actual SHA are checked.
- CAS quota could be forgotten on restart: inventory counts retained incomplete entries; per-shard count and disk-before-shard checks were added.
- A new relay instance could bypass hung operations, or rejected cancellation could free capacity: process-wide occupancy plus quarantine now retains them.
- A mixed add/edit tree could omit intersection changes: whole bounded object/type/mode comparison replaces the shortcut.
- A failed lookup could become a deletion/empty base: positive absence only; successful complete tree/ref reads distinguish it.
- Genesis `git merge` could fast-forward and violate the promised parent shape: explicit wrapper commit fixes local genesis.
- A repeated merge could fail its own parent check or accept unrelated identical text: replay now checks lineage plus complete expected tree; generic no-op success removed.
- Production push could resolve with a rejected ref result: exact destination acknowledgment is required.
- Verification results could remain only in memory: pre-merge immutable receipt and durable readback now required.
- Unbounded aggregate admission text/receipt could exceed practical worker storage: 2,000 paths/1,024-character paths, 8 MiB admitted text, 256 KiB receipt limits refuse oversized work.

- Final review found CR-2 still incomplete in the direct short-job client: the pilot wrapper observed authority, but `boundedStep` itself only journal-bound configured pins. Added actual status checks inside the client before work, execution and upload, plus process-wide request occupancy held through actual reads/cancellation; adjusted the finding attribution.

## Primary API reference

Cloudflare documents `log` as first-parent history with an empty array for an unresolved ref, and `readTree`/`readCommit`/`readFile` return null for their documented absence cases. This supports removing error-message-based absence inference; it does not establish live binding acceptance. Reference read 2026-10-18: https://developers.cloudflare.com/artifacts/api/workers-binding/ . Installed TypeScript declarations were also inspected. No API request against the user's Cloudflare resources occurred.
