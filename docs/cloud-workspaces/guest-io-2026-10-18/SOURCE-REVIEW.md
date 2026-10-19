# Source review — M1/M2

Verdict: **local source implementation reviewed; operational/production HOLD.** Six inline passes were performed by the implementing agent. This is not an independent reviewer verdict, compilation, static-analysis-tool result, test result or runtime proof. The scope/diff/hash receipt identifies reviewed bytes; earlier independent reviews concern their older freezes.

## 1. Structure and trust boundaries

Traced index exports through input verifier → branded job → staging request/acceptance → private guarded launcher → real stopped binding → intake request/acceptance → publication. Private WeakMap/WeakSet brands are required at each acceptance step. Existing real controller claim minting now includes inputHash/projectId; a separately self-consistent fake input/job cannot reuse another claim. Input-to-job reverse import is type-only. No module-import startup or installer is added. Existing native adapter denial and authority placement refusal remain.

## 2. Language/API contract inspection (no compiler)

Read the TS interfaces/call sites and the Python/C/Swift boundaries. Corrected readonly fsid tuple typing, aligned TS host limits with native limits, and changed native input admission to the separate readonly image. Reviewed Python descriptor ownership/cleanup, bounded child capture, and exact canonical ASCII request/provenance fields. Consulted installed Darwin `sys/fcntl.h` and `sys/acl.h` declarations: FILESEC_ACL=5, ACL_FIRST_ENTRY=0, _FILESEC_REMOVE_ACL=(void*)1; repaired the sentinel before completion. Read installed hdiutil manpage for UDRO/srcfolder, owners, readonly, mountpoint, volume mode and raw-image options. Compiler/ABI/tool availability and actual image semantics remain unverified.

## 3. Integration and failure paths

Reviewed guard lifetime across launch/stop and collection. Repaired possible late launch/continuing publication after guard failure by propagating an internal abort signal. Guard postflight is part of the public stop promise. Unknown observations cannot be promoted after a later success. Real stop now also records whether startup was observed; result requests require it. Request-wide publication latching prevents separately accepted handles from replaying one intake. Creation markers and receipts are fsynced; partial operations do not overwrite, retry, detach or delete evidence. Existing HostJournal remains quarantined, including after collection.

## 4. Bytes, filesystem and resource limits

Verified source checks cover whole-file AND underlying v1/v2 object bytes; metadata budget is admitted before segment reads. Staging helper copies through held descriptors, checks expected digests, and constructs readonly images in root-controlled paths. Native input scan and concrete guard agree on ownership/modes, device and byte envelope. Intake uses a copied raw image bound to the actual stop/request SHA, not an arbitrary mounted directory or original writable disk. Sanitization preserves only bounded regular files/directories and executable bits, strips incidental metadata by fresh creation, and rejects links/special nodes. The host validates exact collected membership and provenance independently. Named OS metadata is explicitly excluded from the result envelope and never read.

## 5. User/operator journey

The complete source-level journey is documented in README. Preparing a request performs no assembly; accepting output requires actual operation receipts plus a concrete guard. The root helper requires explicit exact-request authorization and never installs itself or accepts arbitrary shell commands/destinations. It is an offline operator tool; automated production privilege brokering is not claimed. Empty bundles, modes, failed/limited results, old result versions, incomplete trees and byte/TAR overhead are accounted for. Real artifact claims require actual provider objects/grants and current compute scope. Accepted upload is never represented as authority-verified success.

## 6. Activation/governance

No tests, test authoring, compiler/typecheck/lint, runtime imports/probes or operations were used. Old evidence snapshots and unrelated dirty files are preserved. No credentials, real object generations, mount receipts or helper hashes are fabricated. Readonly capability is not adapted into a fake writable seal. M3/M4/R7 remain explicit open/gated stages. Pi and merge-gate authority boundaries are unchanged.

## Contrarian pass and closure

Challenged: forged context/file lists; valid whole-file but inconsistent packed-object digests; immutable-source proof used after guard release; input image rejected by old same-device rule; positive stop before observed start; live disk mounted directly; duplicate acceptance/publish; empty bundle omission; executable-bit loss; guard timeout during pending launch/provider I/O; mismatched Python/C ACL sentinel; guard deadline shorter than the advertised job lifetime; TAR overhead hidden by raw byte budgets; root-helper receipts mistaken for successful authority verification.

Repairs are recorded in FINDINGS.json. Re-read the changed boundaries after those repairs. No known unfinished M1/M2 source stub remains within the stated experimental/offline-operator scope. This does not exclude undiscovered defects: compile/ABI/filesystem/VZ/provider behavior and operational recovery are explicitly pending. Production automation, authority submission, writable storage isolation and inherited integration HOLD are not reclassified as completed by these source changes.
