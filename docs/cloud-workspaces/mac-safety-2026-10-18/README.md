# Mac safety source batch — 2026-10-18

Read `ARCHITECTURE.md`, then the independent review reports, then `SOURCE-REVIEW.md`, `FINDINGS.json` and `CHANGE-RECEIPT.json`. `BASELINE.json` and inert `preimages/` preserve the entry candidate. The older continuation freeze is unchanged.

The concrete change is denial of incomplete native launch, plus an experimental whole-macOS-VM containment implementation and a separate kernel-read-only filesystem guard. This is not a completed production Mac build worker. There are no invented installed binaries, image receipts, mounted volumes, guest toolchains or successful build results.

## Exact source journey

1. An owner-branded local recipe/plan and actual claim context can produce a branded guest-job description. It contains structured unsigned Xcode settings and selected source metadata, not operator credentials or browser shell commands.
2. The experimental VM client verifies private owner configuration, guest-job digest and the actual pinned installed native helper, then reserves the real durable host slot before starting that helper. Its one-use control permits carry a bounded actual remaining lease/deadline budget.
3. The Swift source verifies protected artifacts and the staged job bytes and configures the actual Apple VZ lifecycle. No writable host folders or network devices are exposed. Expired or uncertain control closes admission; stop evidence waits for the entire VM and callback drain.
4. The guest runner source bounds staging, toolchain observations, build output, copying and receipt metadata, executes as a standard guest account, and requests guest shutdown. These outputs are unverified.
5. The read-only storage client/guard can protect already provisioned immutable trees for v1/v2 source capture and output collection. It cannot mount output disks or authorize mutable restores/CAS writes.
6. Production snapshot staging, stop-gated output intake and controller/adapter composition remain local engineering work. No successful-build publication is implemented by the experimental VM session; it always reports `not-collected` and retains quarantine.

## Next ordered tasks

- **M1:** Verify exact immutable snapshot → complete guest file list equality, guest recipe/resource policy and per-attempt artifact staging. Keep root/input namespace immutable for the entire lifetime. No owner credentials enter the image.
- **M2 (depends M1 and stopped VM):** Implement concrete stop-gated output-disk intake, approved read-only mount/extraction boundary and independent receipt/output/lineage verification through the existing immutable publication/verifier flow. Treat every guest byte as untrusted.
- **M3 (depends M1/M2):** Compose production VM adapter, truthful guest capabilities and controller lease/cancel/recovery. Review the full path before changing Xcode eligibility. Generic writable CAS/materialization isolation and inherited integration HOLD findings remain explicit prerequisites.
- **M4:** Only after separate approval, compile and execute deferred validation. Installation, image provisioning, VM starts, spending, identities, secret changes, merge/deploy and cleanup have their own matching approvals.

This batch does not request or infer those approvals. R7 remains unstarted. All three-Mac catalog activation, Linux execution, Mac execution, demonstrated recovery and approved bounded retention remain the end goal; this patch closes only the documented source substeps.
