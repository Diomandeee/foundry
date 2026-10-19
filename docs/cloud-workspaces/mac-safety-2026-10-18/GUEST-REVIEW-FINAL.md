# Final independent source review

2026-10-18. **COMMENT — source-only six original findings plus receipt metadata finding ADDRESSED. Integration: HOLD.** No new actionable finding identified in this bounded final read of the three sources below. This is a static disposition, not blanket approval or proof of execution, containment, successful build or production readiness.

## Reviewed snapshots

| Source | SHA-256 |
| --- | --- |
| `packages/build-runtime/native/mac-vm-guest.py` | `e00b5ccca4c0c3b56378096e33726a3f6a5f75fdc124b0b437fe563cc66c257f` |
| `packages/build-runtime/src/mac-vm-job.ts` | `74de8dfee1acab2c092c8752a329e6ff3450904970dc2f5d7b56456a3f51599b` |
| `packages/build-runtime/src/mac-vm.ts` | `ebd1d22ad7b183c9d952dbf9f8e2c22b2e2e9f135870c779b37ac1276edb36d1` |

Line references below refer to these snapshots. Only these product sources were read in this final pass. Applicable AGENTS/PROTOCOLS/SOUL values and earlier review dispositions were already read in this session. The helper and imported implementations remain outside scope.

## Source finding dispositions

| Finding | Final source evidence | Disposition |
| --- | --- | --- |
| Root output path-follow/reopen race | Guest 59-77,122-159: descriptor-relative no-follow component traversal; same-device checks; regular-file/type/size/stability validation on the descriptor actually copied. | ADDRESSED, static only |
| Unbounded copies/missing operation deadline | Guest 122-159,226-251,283-307,315-353: bounded same-descriptor copy/hash with growth/stability checks; shared deadline across staging, observations, build and collection. Blocking kernel operations still require the independent host bound. | ADDRESSED, static only |
| Non-idempotent stop | Client 97-107,144-148: writable-ended and stop-requested guards; stop write/end occurs once. | ADDRESSED, static only |
| Unbounded failure/EOF/close settlement | Client 91-116,151-153,162-176,180-183: unknown-settlement deadlines, stream error/EOF handling, and ten-second bound retained through journal completion. No later silent upgrade after timeout. | ADDRESSED, static only |
| Eager directory allocation/noncumulative entry limit | Guest 311-330: incremental enumeration, cumulative entry/pending count, depth/path/name limits and deadline checks. | ADDRESSED, static only |
| Unrestricted manifest/tool-output reads | Guest 85-100,162-204,235: bounded regular manifest read and streamed capped command observations. | ADDRESSED, static only |
| Receipt metadata admitted before byte check | Guest 335-347: each prospective row is encoded with the actual path, a 64-character digest placeholder and MAX_RESULT numeric bound; cumulative admission is checked before copying or retaining that row. | ADDRESSED, static only |

The metadata fix uses the same JSON sorting/separators/escaping as final serialization. The actual digest has the same encoded length as its placeholder; actual size is nonnegative and no greater than MAX_RESULT; the additional byte accounts for an array separator. Cumulative rows are capped at 900 KiB, leaving 124 KiB under the 1 MiB receipt cap for the fixed fields and container syntax. Identity, token and digest fields are bounded; guestMacos must match the capped tool-observation output. The former many-empty-files/long-path example now fails admission before retaining an oversized metadata list. No test or product execution was used to reach this conclusion.

## Final client changes

- **Private pinned policy and job binding remain intact.** Client 72-87 copies the policy and branded guest job, compares canonical job SHA-256 with configuration.guestJobSha256, directly reserves through imported HostJournal and records identity before spawning the captured pinned executable. Encoder 14-17,60-66 binds the frozen job to the same plan object through a private WeakMap. Full manifest approval remains a separate caller precondition.
- **Permit budget is source-bounded.** Client 122-139 validates challenge generation/timestamp shape and a one-second challenge interval, calls currentFence for its current remainingMs, rejects nonfinite/sub-millisecond runway, and sends integer validForMs capped at 1,000 and floored to the returned budget. The currentFence implementation must actually supply the controller's current continuous-time authority/deadline budget and cancellation check. This file does not prove that imported/caller behavior.
- **Start/stop/result meanings remain separate.** Client 140-176 requires a prior issued permit for started, and a valid terminal event, clean helper closure, no pending/invalid frame and journal completion for positive VM-stop evidence. Its result stays not-collected. reservation.finish always requests quarantined; no slot-release path is introduced, including after positive VM-stop evidence.

## Explicit integration HOLD

1. **Independent helper review:** verify actual opened input/job.json digest matching before start; exact configuration/challenge/permit compatibility; one-use permits; helper-owned continuous clock; expiry anchored to challenge creation plus the granted budget; physical-start enforcement; independent whole-VM lifetime bounds; and authoritative VZ stopped state before terminal stop evidence. The helper was not read here; none of those behaviors is attested by this report. EOF, process exit, shutdown requests and process-group kills are insufficient.
2. **Approved snapshot and host journal:** complete selected file-list equality to the independently approved immutable snapshot remains the encoder caller's documented precondition (22-24,33,59-60). Branding and matching job digests prove consistency, not snapshot approval. HostJournal durability, reservation/quarantine behavior and imported validation implementations require their own evidence.
3. **Result intake:** only after independently established actual whole-VM stop, perform approved readonly extraction and independent bounded verification of untrusted guest receipt schema, job/attempt/profile/source lineage, output allowlists, regular-file types, sizes and hashes. A stopped VM or a guest result alone is not proof of a verified successful build; this primitive remains result:not-collected and is not automatically accepted as a production RuntimeAdapter proof.
4. **Readiness/authority:** owner-provisioned secret-free images, actual installed toolchains, readonly host virtiofs, no writable hostshares/network, fixed-capacity disks and actual independent host enforcement remain required deployment assumptions. Image installation, readonly result extraction and production dispatch remain pending. Existing native/authority denial remains required; unrelated product code was not reviewed or changed.

## Verification boundary and closure

Six review lenses were applied statically: correctness, security, resources, failure/recovery, integration/lineage and content/truth. RTD: **Structure — static reviewed; Compilation — DEFERRED BY USER; Integration — static contracts only/HOLD; Content — static reviewed; User journey/runtime — DEFERRED BY USER; Deployment — DEFERRED BY USER.**

Only this final report was written, using filesystem APIs for directory creation and report metadata verification. No shell/process execution, product imports, tests/test authoring, compilation, probes, helper/VM start, installation, provider operation, credential access, spending, commit, deployment, cleanup, product edit or additional task was performed. Final source-review work is closed with the integration HOLD above.
