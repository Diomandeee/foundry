# K11 Craft evidence absorbed into Foundry

Evidence cut: local files inspected on 2026-10-18. See `K11-SOURCES.json` for absolute paths and hashes. The external rollout's runtime claims remain **reported receipt evidence**, not observations rerun in this session. The Windows GUI JSON carries a UTF-8 BOM; it was read using UTF-8-sig without modifying the receipt.

K11 has two distinct responsibilities: `C:\ai-memory` is the higher-priority canonical AI-work archive; `C:\Craft` is the separate photo/film batch facility. The report describes nine pinned source archives, fifteen executable hashes, seven GUI startup checks, photo/film comparison receipts, a SYSTEM worker reboot receipt, and a private read-only Fleet Console. These support the external rollout's stated narrow acceptance scope. They do not prove complete application parity, sustained performance, current liveness, or Foundry membership.

Local source inspection confirms the reusable design: `lume.craft_job.v1`, existing photo/film bundle schemas, content-derived job IDs, immutable package/artifact hashes, one queued render at a time, explicit bounded retry, separate attempt outputs, and receipt-based interrupted-state recovery. Fetch is separate from rendering. These are useful models for Foundry's provenance and idempotency contracts.

Two boundaries prevent direct promotion into the Foundry executor:

1. The natural MotionMix watcher → bundle → K11 acknowledgment → render → verified Mac1 retrieval canary remains open in the rollout report. Manual film and client photo acceptance are not that automatic trace.
2. `runner/worker.py` uses `taskkill /T /F` on timeout and then waits for its immediate child. Recovery hashes artifacts but does not establish Foundry's durable lease fencing or containment proof for every surviving descendant. This review does not assert a demonstrated escape; it establishes that the source is not a substitute for Foundry termination attestation. Future Windows enrollment needs its own containment, credential, revocation and uncertain-restart design and acceptance.

Foundry should represent this lane as an **external reported batch facility**, with source/evidence hashes and observation time. `done` in the Craft queue stays an external status until separately admitted artifact verification. A Fleet Console green card means SSH reachability from Mac5; it is not worker eligibility or capacity. No new Windows build job kind, scheduler placement, remote command handler, automatic polling or ingestion was added here.

K11 remains unenrolled in Foundry; the memory heartbeat remains paused; existing Mac4 fallback and draft MM PRs retain their separate ownership. No external files, services, queues, credentials or automation were changed. Recording, streaming, publishing, retrying a render, changing priorities or merging the external PRs are not authorized by this absorption.

Future integration record must bind: source revision; bundle schema/digest; exact external job and attempt IDs; package digest; external receipt digest; output artifact digests; observation source/time; Foundry verifier verdict; and the explicit enrollment/dispatch approval if execution control is later added. Unknown values remain absent, never guessed. This is a documented boundary, not an implemented Windows transport.
