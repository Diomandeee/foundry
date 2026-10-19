# Cumulative source review and exact stop

Verdict: **source-reviewed containment primitives; production/integration HOLD.** The intended outcome of this batch is safer local source boundaries and concrete candidate implementations. It is not an enabled Mac build service.

## What changed and why

The prior native adapter could still execute directly even though authority placement was denied; its descendants/services were not contained. Both NativeMacAdapter methods and NativeDescendantAttestor.start now reject before callbacks or process invocation. Historical signed ES recovery-journal inspection remains diagnostic.

The new Swift host owns a real Apple VZ lifecycle. The TypeScript client requires branded owner job data, pins a native installed executable, observes actual host resource admission in source, and reserves the concrete durable journal before launch. Continuous-time, one-use challenge budgets constrain physical start; terminal state cannot reopen. Whole-VM stop, helper closure and durable record completion are separate from guest output. The slot remains quarantined and results remain not-collected.

The one-shot guest source uses exact unsigned offline Xcode settings, a standard build UID/GID, descriptor-relative no-follow reads/copies, byte/time/traversal limits and pre-admitted receipt metadata. Staged job bytes share a 262,144-byte ceiling across encoder/client/helper/guest. Native source, guest/runtime installation, actual images and owner approvals are separate prerequisites.

The new filesystem implementation relies on a real root-mounted kernel-read-only local volume, not on metadata checks or flock as writer exclusion. Exact identity/ACL/namespace checks bracket a held-FD lifetime. Read-side capability is distinct from writable isolation. Optional readSeal is wired into collectOutputs and v1/v2 source capture; CAS puts/restores still need their separate writable seal.

## Independent review trail

- `GUEST-REVIEW.md`: six initial guest/client defects, plus early mutable executable selection caught and repaired concurrently.
- `GUEST-REVIEW-ROUND2.md`: original six closed statically; one additional receipt-metadata admission defect.
- `GUEST-REVIEW-FINAL.md`: six plus metadata repaired by source inspection. It predates the small explicit 256 KiB constant/reader alignment and host resource-admission delta; the containment follow-up covers those separately.
- `CONTAINMENT-INDEPENDENT-REVIEW.md`: challenge duration mismatch repaired concurrently; ACL interpretation, native format admission and readonly preflight settlement required repair.
- `CONTAINMENT-REVIEW-FINAL.md`: prior four source findings closed; explicit job-byte-contract mismatch identified. It also reads the final host capacity admission and changed permit protocol.
- `CONTAINMENT-REVIEW-CLOSURE.md`: final narrow byte-contract disposition and final snapshots. See its actual verdict; no blanket execution approval is implied.
- `FILESYSTEM-REVIEW.md` and `VM-HOST-REVIEW.md`: implementer source assessments/protocols and exact prerequisites, not independent operational certificates.

`FINDINGS.json` keeps these source dispositions separate from surviving integration prerequisites and inherited findings. The old broker/input review freeze is preserved. One filesystem implementer was stopped by the parent after its source and report were present; no final agent receipt was obtained from it. The independent containment reviewer subsequently inspected the filesystem implementation and parent repair, so the implementer's missing final message is not silently treated as an independent approval.

## Parent review lenses

| Lens | Source conclusion and limit |
| --- | --- |
| Structure | New exported primitives have concrete Swift/C/TS/Python sources and no import-time process launch. Evidence copies use inert suffixes. No third-party dependency or installer was added. |
| Correctness | Protocol fields, digest/identity bindings, explicit byte ceilings, one-use permits and stop/channel state were compared. Unknown states cannot become successful builds or free the slot. Compilation is still unknown. |
| Security | Native execution fallback denied; no browser shell/credential payload, writable host folder share or network device. Root/ACL/private namespace and reviewed binary prerequisites remain explicit trusted-host assumptions. |
| Resources | Actual statfs/freemem admission calls exist in source; they were not called. Fixed-capacity raw disks and guest limits are separate from durable physical capacity reservations. Work-volume and image-volume headroom are observed at admission, not guaranteed against later unrelated work. |
| Failure/recovery | Durable marker precedes launch. Unknown start/stop/channel/journal states quarantine without rerun. Readonly verification/callback uncertainty is retained and poisoned. Timeouts bound observations, not every blocked kernel call; actual VM lifecycle validation remains essential. |
| Journey/truth | Traced owner plan → branded job → helper pins/journal → physical VM lifecycle → untrusted guest outputs. The path deliberately stops before result intake/publication and production adapter eligibility. No claim of successful build, actual mounted readonly tree or all-device activation is made. |

Contrarian check: a correct-looking helper and positive message schema do not prove actual VZ timing, callback semantics, framework cancellation, mounted-volume immutability, guest image contents, hostile-code safety, compilation or recoverability. The source architecture therefore remains HOLD. This batch must not be used to clear inherited integration findings, synthesize missing owner receipts or bypass the gate.

## Exact stop and remaining sequence

Stopped after local code implementation, bounded independent static repair/review, route/checklist updates and scoped evidence preparation. No testing, typechecking, compilation, product import/probe, helper/VM/service start, trial restore/build, installation, image preparation, cloud/provider request, provisioning, spend, secret change, commit/push/merge, deployment, publication or cleanup occurred.

M1: verified immutable snapshot-to-guest staging. M2: stop-gated read-only output-disk intake and independent actual artifact/receipt verification. M3: production VM adapter/controller/guest capabilities plus writable CAS/restore isolation and inherited HOLD resolution. M4: separately approved compilation/acceptance and progressively approved activation. Production Xcode placement stays denied. R7 stays unstarted.
