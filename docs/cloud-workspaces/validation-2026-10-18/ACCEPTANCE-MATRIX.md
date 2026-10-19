# Local validation versus operational acceptance

This is the current acceptance ledger for the cloud workspace route. Local results are reported in this folder's final receipt. A test using a fake boundary establishes only its asserted contract; compiler success establishes only compilation. Neither establishes an installed fleet or kernel containment.

| Requirement | Evidence now available | Remaining operational acceptance |
| --- | --- | --- |
| One project revision on three Macs | Catalog/bridge integrity and no-overwrite implementation; local test coverage | Published catalog generation, independent device identities, actual new-destination restore on Mac1/Mac4/Mac5, byte verification while Mac1 is unavailable |
| Required inputs reconstructable | Explicit completeness checks and refusal reasons; verified input-reader regression coverage | Owner-selected project's Git/history/assets/submodules/LFS/configuration and dependency closure; actual fresh-workspace reconstruction |
| Linux bounded execution | Compiler, pure staging/census regressions, authority/controller contracts; concrete isolated adapter | Approved host, image, user namespace mapping, enforcing AppArmor payload, privileged broker and actual disposable build/stop evidence |
| Mac Xcode execution | Swift/C compilation, Python syntax, Mac storage/liveness tests; VM adapter and stop-gated intake source | Installed signed VM helper, guest image/toolchain/source volumes, CAS and readonly guard, operator stage/intake, actual unsigned build and whole-VM stop |
| Lease/cancellation/restart fences | Actual SQLite authority tests, mocked boundary and transport tests, durable attempt source | Host-level cancellation/renewal-loss/restart drills; real descendants/VM stop; uncertain execution stays quarantined |
| Independent successful result | Immutable publication/readback contracts and exact-attempt verifier entrypoint | Real output artifacts, provider generations and independently authenticated authority verification; app behavior separately assessed |
| Credential isolation/revocation | Local authentication role/pin/epoch/revocation regressions; scoped storage composition | Real least-privilege identities, expired/revoked provider denial, unrelated-project and signing/release refusal |
| Capacity and retention | Read-only live Mac metadata, admission/accounting source and tests | Approved named cleanup or capacity; all Macs currently below the 50 GiB reserve before job estimates; real inactive-only cache/retention acceptance |
| Safe source-copy removal | Originals retained; restore is no-overwrite | Full required-content recovery proof and explicit per-copy approval; none removed |
| Existing merge gate | Local compiler, suite, usability proof and fixture demo | G3 strictness policy choice, real target schema/backup/migration if required, required integration review and explicit merge/deployment approval |

## Current resource evidence

`CAPACITY-CURRENT.json` records observations at approximately 17:32 UTC on 2026-10-18:

- Mac1: 29.04 GiB free; Xcode 26.5 build 17F42.
- Mac4: 14.27 GiB free; Xcode 26.2 build 17C52.
- Mac5: 12.71 GiB free; Xcode 26.3 build 17C529.
- Required Foundry Mac helper/CAS/image paths checked in the per-host receipts were absent. This is a path inventory, not a blanket search for every possible installation.
- GCP instance enumeration failed because Compute Engine was unused/disabled for the selected project. This does **not** prove that no VM exists elsewhere. No API was enabled. Current credit balance/expiry, an account-specific quote and the proposed $50 pilot envelope remain unverified/unapproved.

The read-only SSH inventories executed metadata commands only. A non-login SSH PATH missing `node` is not proof that Node is absent. No cleanup, remote file mutation, provider mutation or installation followed these observations.

## Operational sequence after matching approval

1. Establish exact target identity, current billing/credit facts and a quote before a provisioning request. Enabling Compute Engine, creating a VM/disks, IAM/network changes and installs each remain explicit operations.
2. Publish the approved immutable catalog descriptor and install/activate one independent client; prove one selected project's recovery. Expand to the other Macs only after that acceptance.
3. Install and qualify one Linux host with the exact pinned image/policy/account/storage configuration. Run one approved disposable attempt, verify its output independently, and retain its state for reconciliation.
4. Establish Mac capacity through separately approved named actions. Install and qualify one Mac's signed helpers, guest/toolchain/source images and CAS. Exercise the owner-mediated stage/run/stop/intake path before enabling another Mac.
5. Execute the negative/recovery cases above. Record actual catalog generations, worker identities, epochs, helper/image hashes, attempt/stop/output receipts and rollback points.
6. Consider original-copy removal only after complete recovery and explicit per-copy approval. A successful code-only restore is insufficient for a project with missing assets or history.

No recurring agent, VM, helper, service, publication or paid pilot is activated by this ledger. A config approval digest is an implementation check, not an approval issued by this document. Native host Xcode execution remains denied; the supplied Mac build path is an Apple Silicon VM. K11 Craft evidence remains an external carried lane, not an enrolled execution worker.
