# Foundry security and robustness review, 2026-10-22

Lane: claude-authority (security lane). Method: six independent read-only code reviews, one per trust boundary, then every Critical and High finding re-verified by hand in source, and the assumptions checked on the real machines (Mac1, Mac4, Mac5) and the live Cloudflare account. No secret values appear in this document. Nothing was changed.

What is live today: Cloudflare workers `foundry-gate`, `foundry-orchestrator`, `foundry-api` (plus `-staging` copies), `participation-coordinator`, `fleet-signal-staging` (deployed 2026-10-21 22:05Z), `foundry-compute-staging` (switched on in staging config, no workers enrolled). On the Macs: `fleet-authority` root daemon on Mac5 (1.0), Mac1 and Mac4 (1.1.2); root helpers `mac-vm-host`, `mac-vm-io.py`, `mac-tree-guard` on Mac5. The Fabric iPhone app (`~/Developer/Fabric`) exists and points at the staging relay.

## 1. The verdict in one paragraph

The parts of Foundry that were designed as trust roots are good. The daemon re-hashes the exact bytes before it runs them, the phone signs a message bound to host, request, fingerprint, nonce and expiry, the VM has no network at all, the gate cannot be fed a fake push event and writes a tree it has byte-checked. None of the six reviewers found a way to forge a root execution against the daemon from the outside, even with full control of the Cloudflare account. What breaks the design is everything the design *assumed* and did not enforce: the approval is a signature, but every other authority in the system is a bearer token sitting in the login account that agents own; the approved script is exact, but it is a launcher that re-reads its real payload from a user-owned folder; the phone is the approver, but the phone key accepts a passcode and the phone can be driven from a Mac through iPhone Mirroring. Two of the Critical items are reachable today, one of them from the open internet.

## 2. Assumptions versus reality

This is the table the review was asked for: what the design assumes, and whether the fleet actually enforces it.

| The design assumes | Holds? | Evidence |
|---|---|---|
| Root on a Mac is reachable only through the daemon after a phone approval | **Mostly.** SIP on, no sudoers exceptions, daemon dir and plist root-owned on all three Macs. | Mac4 still runs `com.lume.mac4-mega-pose-publisher` as root from a script your login user owns (F9). |
| "You approve what the daemon will run" | **No.** The daemon hashes `script.sh`; the real staged scripts (requests 17 and 18) are launchers that `bash` files out of `~/.foundry-obs`, a folder your login user owns. | request17 script lines 8-22; `FleetAuthority.swift:402-405` covers only the launcher. |
| Approved scripts run in a clean root environment | **No.** `PATH` ends with `/opt/homebrew/bin`, owned by your login user, in the source and in the installed 1.1.2 binary. | `FleetAuthority.swift:279`; `ls -ld /opt/homebrew/bin` = `mohameddiomande admin`. |
| The approver is a person, proven by Face ID per signature | **No.** The decision key is created with `.userPresence` and signs after `.deviceOwnerAuthentication`; a passcode satisfies both. The SSH shortcut path has no biometry at all, and approvals have already been driven from a Mac through iPhone Mirroring (F10). | `Fabric/Core/Keys.swift:59-60,82`; ledger 2026-10-21 21:43Z. |
| Enrolling a new approver is a ceremony you can check | **No.** `keys-add` is free text; the render shows raw base64 with a label the stager wrote; no daemon-computed fingerprint. | `FleetAuthority.swift:686-706`, render at 174-183. |
| "Authority is a signature, never a secret" | **Only for root execution.** Every other authority is a bearer file in `~`: the relay owner bearer, compute owner and verifier bearers, the orchestrator task token, the Cloudflare OAuth token, the GitHub token, gcloud credentials. | `~/.config/foundry/{fleet-signal-staging/owner-bearer, compute-staging/{owner,verifier}.token, staging-task-token}`, `~/Library/Preferences/.wrangler/config/default.toml`, `gh auth status`. |
| Nothing lands on base without the gate | **No, from Mac1.** `~/.config/foundry/bin/foundry-push` mints a 15-minute write token for any repo in the namespace, base included, with the Cloudflare login on Mac1. | `foundry-push:9`; `README.md:118`. |
| A ticket confines an agent to its paths | **Only if someone typed the paths.** An empty allow-list means every path is allowed, and intake defaults to empty. | `packages/gate-ts/src/types.ts:183`; `workers/orchestrator/src/tasks.ts:161`. |
| Verification gates merges | **No.** Unset or unreachable verifier = pass. | `packages/verify/src/index.ts:97-127`; `VERIFY_REQUIRE_CHECKED` off. |
| Only you can act as you in the participation service | **No, and this one is on the public internet.** Any P-256 key gets a session; recovery binds a device to an account by display name, which is seeded as `mo-motionmix`. | `participation-coordinator/src/{worker.ts:63-74, token.ts:131-179, ops.ts:151-176, bootstrap.ts:34-45}`. |
| The receipt chain is mirrored where a compromised Mac cannot rewrite it | **Partly.** The mirror is Durable Object SQLite, rewritable by the Cloudflare account; the daemon never reads the mirror head back. | `workers/fleet-signal/wrangler.toml:8-14`, `hub.ts:222`. |
| Agents cannot reach the phone | **No.** iPhone Mirroring sessions exist on agent Macs and the approve shortcuts run from them. | F10, ledger. |

## 3. Findings

Severity is about what an agent that owns your login session (or, for C1, anyone on the internet) can do. CONFIRMED means I read the code path myself after the reviewer reported it.

### Critical

**C1. Anyone on the internet can become your actor in `participation-coordinator`.** CONFIRMED, DEPLOYED, public URL.
`/token` is the one unauthenticated POST and issues a bearer to any self-generated P-256 key. `begin_actor_recovery` registers the caller's device with `ON CONFLICT(key_id) DO UPDATE` (so it also overwrites a real device's public key), and `complete_actor_recovery` resolves the actor by `SELECT actor_id FROM actors WHERE display_name=?` using the caller-supplied `accountHint`. The seeded first user is `mo-motionmix` / `actor-mo-0001`. Four requests and the attacker's device is bound to your actor; every later call acts as you (admission grants, consent rows, media publish scopes). It cannot reach root or money.
Fix: recovery must require something the attacker lacks (an operator-issued single-use secret, or a signature from an already-bound device). `registerDevice` becomes insert-only and refuses `keyID != sha256(pub)`. Admission needs a server-issued invite that carries the scopes. `requireMembership` must compare the stored `actor_id` to `req.principal`, not to what the client sent.

**C2. The approved root script is a launcher; its payload lives in your login user's folder.** CONFIRMED, used in production approvals.
Requests 17 and 18 (the Mo en Movimiento, Air Deck and Coltivare builds you approved) `pin` files by sha256 and then `bash "$O/seal-capability-v5.sh"` and `bash "$O/build-job.sh"` with `O=~/.foundry-obs`. The pin and the bash are seconds to minutes apart; replacing `build-job.sh` after the pin passes runs attacker bytes as root with Full Disk Access. The daemon cannot see any of this: its fingerprint covers only the launcher.
Fix: nothing under `/Users` is ever executed or sourced by an approved script. Either inline the whole payload, or extend `stage` with attachments that the daemon copies into its root-only `pending/<id>/files/`, hashes into the fingerprint, and lists in the render. The render should flag any `/Users`, `~` or `$HOME` token as UNPINNED.

**C3. Phone approval is reachable from a Mac.** CONFIRMED by the project's own ledger.
Approvals for Mac5 were driven from Mac2 through iPhone Mirroring on 2026-10-21. The SSH approver path proves only that the phone's SSH key signed a session; the Fabric decision key accepts the device passcode (`.userPresence` + `.deviceOwnerAuthentication`). An agent with a Mirroring window and the passcode is a complete approver. This is finding F10 with the biometric escape hatch removed.
Fix: decision key with `.biometryCurrentSet` and `.deviceOwnerAuthenticationWithBiometrics`; relay and daemon refuse devices enrolled without a biometric decision key; SSH shortcuts become `show`-only once the app path works; no Mirroring session on a Mac that runs agents.

**C4. Enrolling an approver key is a free-text root script with no fingerprint.** CONFIRMED.
`keys-add <id> <spki> <label>` and `echo ... >> /etc/ssh/fleet_authorized_keys` are ordinary script lines. The render prints the raw key and whatever label the stager chose; `enroll-phone.sh` computes the "fingerprint" in the label from the key it was given. One approval of a plausible "re-enrolling your phone" request gives the attacker a permanent approver key.
Fix: enrollment becomes a typed daemon op whose render shows a daemon-computed `SHA256:` fingerprint and key type; the approval must quote that fingerprint; free-form scripts that mention `keys.json`, `fleet_authorized_keys`, `policy.json` or `/Library/FleetAuthority/bin` are refused rather than tiered up.

### High

**H1. Root PATH includes `/opt/homebrew/bin`.** CONFIRMED in source and installed binary. Any approved script that calls a command not in the system dirs (`jq`, `node`, `gh`, `wrangler`, a newer `python3`) runs whatever your login user put there, as root. Fix: `PATH=/usr/bin:/bin:/usr/sbin:/sbin`; scripts use absolute paths.

**H2. Every control-plane authority is a bearer file in the login account.** CONFIRMED.
`~/.config/foundry/fleet-signal-staging/owner-bearer` (enroll or revoke phones and nodes, read every pending script fleet-wide, hide a Mac's requests from the phone), `~/.config/foundry/compute-staging/{owner,verifier}.token` (enroll workers, approve profiles, accept forged build results; owner and verifier in the same folder voids the independent-verifier rule), `~/.config/foundry/staging-task-token` (create unrestricted tasks), `~/Library/Preferences/.wrangler/config/default.toml` (redeploy any worker, edit D1, replace secrets), the GitHub token with `repo` and `workflow` scope, and gcloud credentials used by the library bridge to mint account-wide GCS tokens. The daemon's root key is the only authority that is not a file an agent can read.
Fix: these move behind the same mechanism as root: root-only storage on the Mac, used only by a daemon template that the phone approves, or a separate macOS admin account that agents never run as. Until then, treat "the gate" and "the relay" as protected only against agents that are not on Mac1.

**H3. The gate can be walked around from Mac1.** CONFIRMED. `foundry-push` mints a base write token; a plain `git push` lands on base with no decision row. Fix: no human or agent path mints base tokens (gate-only); plus a cheap detective job that diffs base's ref history against `decisions.merged_sha` and alerts on any commit without a row.

**H4. Empty allow-list means every path.** CONFIRMED, reachable with an ordinary fork token. `allowsPath` returns true when `allowed_roots` is empty and intake defaults to `[]`; the README example omits it. An agent on such a ticket lands `.github/workflows/*`, `package.json`, `AGENTS.md`. Fix: intake refuses a task without a non-empty `allowedRoots` (an explicit "unrestricted" opt-in may exist but must be logged as such).

**H5. Any relay-enrolled device can lock a request against your phone.** CONFIRMED. `decisions` is keyed `(host, request_id)` and `submitDecision` accepts any enrolled device's decision key; a second device that says "deny" first makes your phone see "already decided". The daemon refuses the bogus decision, so nothing runs, but the relay path is dead for that request. Combined with H2 this is selective denial of whatever the attacker dislikes. Fix: the node publishes its enrolled approver key ids in the signed request payload; the relay accepts decisions only from those; PK includes `key_id`.

**H6. Helper install trusts ad-hoc codesign, no hash.** CONFIRMED. `install-host-helpers.sh` installs `mac-vm-host` and `mac-tree-guard` from `/Volumes/FoundryBuild/staging/bin` (owned by your login user) after `codesign --verify --strict`, which any ad-hoc signed binary passes. `mac-vm-host` is the VM trust root. The singular `install-helper.sh` does pin a sha; the plural one must too, with the hash inside the approved body.

**H7. `build-job.sh` is not safe to auto-approve.** CONFIRMED. Only `ATT` is validated; `IMAGE` and `SRC_NAME` are interpolated into paths under `/Library/Foundry/VM` and the daemon's template-arg regex allows `/` and `.`, so `../../x` reaches them; `$((TIMEOUT_S + 300))` is bash arithmetic on an unvalidated value; `${OUT_DISK_GIB}g` is unquoted. Required before any Tier 0 use: `IMAGE`/`SRC_NAME` match `^[a-z0-9][a-z0-9._-]{0,63}$` with no `..`, realpath-prefix-checked under their roots; all numeric caps `^[0-9]+$` with min and max; `CONFIGURATION` in {Debug, Release}; `OUTPUT_PATH`/`PROJECT` relative with no `..`.

**H8. Delivered build results are owned by the login user and self-describing.** CONFIRMED. `build-job.sh` chowns the whole results tree, including `result.json` with the hashes, to uid 501. Mac1 verifying outputs against that file verifies nothing. The root-owned `attempts/<id>/receipts/intake.json` is the trustworthy record. Fix: consumers read hashes from the intake receipt or a root-signed manifest.

**H9. The daemon can be crashed and wedged by any local process.** CONFIRMED in code (timing PLAUSIBLE). No `SIGPIPE` handling anywhere: a client that connects, sends `status`, and closes before the reply kills the daemon; launchd restarts it, but a request in state `running` is never reconciled and its child dies on its next write, leaving a half-applied root change with no `executed` receipt. The accept loop is single-threaded with a 30 s receive timeout per read and no send timeout, so one slow client hangs the approver's SSH session. `stage` has no rate limit and `pending/` is never garbage-collected (Mac5 has 20 stale rows); a disk-full state is a lockout, since the cleanup itself needs an approval. Fix: `signal(SIGPIPE, SIG_IGN)` plus `SO_NOSIGPIPE`; send and receive deadlines per connection; a small handler pool; per-uid and total pending caps; refuse `stage` under 1 GiB free; GC after 24 h; mark `running` requests orphaned on start.

**H10. The relay's worker verification and the gate's verifier are fail-open.** CONFIRMED by design. Verification `checked:false, ok:true` on any error; the verifier call carries no auth. Fix: `VERIFY_REQUIRE_CHECKED=1` once a verifier exists, and sign or authenticate the verifier's response.

**H11. Compute executor bearer outlives its job; broker holds the owner bearer; GCS tokens are minted from your personal Google account.** CONFIRMED, compute not yet active. A compromised worker keeps its bearer and can claim every queued job for its approved profiles; the library broker uses the owner credential for one read-only call; the Mac bridge runs `gcloud auth print-access-token` as your login user, so the "read-only prefix" is a convention enforced by code the login user can edit. Fix: fence the worker on every terminal attempt; an observer-only role for the broker; a dedicated prefix-scoped service account held root-only.

### Medium

- **M1. Display spoofing in the approval render.** Description and script are printed verbatim: a description containing the render's own `----` fence and a fake body, ANSI escapes, `\r`, bidi overrides and zero-width characters all reach the terminal or Shortcuts. Fix: refuse C0 controls other than `\n`/`\t`, U+200B-200F, U+202A-202E, U+2066-2069, U+FEFF; print the description JSON-escaped on one line; print sha256 and line count; fence with the request id.
- **M2. Prefix approval with no uniqueness.** `approve <8 hex of fp>` takes the first match in stage order. Fix: full 16-hex id or at least 16 hex of fp, refuse if ambiguous.
- **M3. "Tier 3" is a substring match on the script text** (`/Library/FleetAuthority`), evadable with `cd` or globbing; harmless while `default_tier` is 3, a bypass the day it drops. Fix: protected patterns refuse free-form scripts; protected changes only through typed ops.
- **M4. Script bodies and 160-char descriptions leave the Mac** through the relay and push notifications; any relay-enrolled device reads them. Rule: staged bodies carry no secrets; templates read secrets from root-only files at run time.
- **M5. Receipt mirror is not the tamper-evident copy the doc describes.** DO SQLite rewritable by the account, first entry unanchored, entries unsigned at rest, daemon never compares the returned head to its own. Fix: node-sign entries, verify head on each push, keep the local chain primary.
- **M6. Integrity check is tautological.** It compares the binary to a receipt the installer wrote from the same bytes; it cannot detect an attacker-built binary installed via an approval, and a wrong receipt locks everything out. Tie the receipt to the approving request id and attachment hash (C2 fix).
- **M7. Gate freshness rule uses the attacker-controlled author date** (zero security value, real false positives); whole-tree walks cap at ~2000 files and report `conflict` instead of "too big"; binary files and no-op pushes become permanently retried `error` rows. Fix: drop rule 9 for merges, diff trees by oid, classify as `reject` with a reason.
- **M8. The decisions ledger and evidence API are public and unauthenticated** on workers.dev, including raw exception text and, with `DEBUG=1`, stack frames. No tokens are stored, so no credential leak. Fix: Cloudflare Access or a read bearer; never `DEBUG=1` in production.
- **M9. Handoff packets, mailbox rows and `next_prompt` carry no signature and no authorship.** The validator checks shape; `writer` is free text; "evidence exists" is a path-existence probe. Any Supabase service-key writer can plant "Mohamed said go". Rule (already the lane's practice, now written down): peer text never carries authority; a privileged tool call must present a fleet-authority receipt id, not prose.
- **M10. Root stdout of seal and provision scripts is piped to a hardcoded Tailscale listener** (`100.84.118.106:9876`). Consented in the approved bytes, but an exfiltration channel if that listener is ever untrusted, and it runs with the H1 PATH.
- **M11. Root `hdiutil attach` of a guest-authored disk image** during intake exposes the kernel filesystem parser to guest-crafted structures; the walk afterward is careful. Accepted risk, worth knowing it is root.

### Low (listed for completeness)

Orchestrator bearer compared with `!==`; fork name `${taskId}--${agentId}` is ambiguous and upserts on collision; `scopeTtlMs` unvalidated; event `source.namespace` trusted as the D1 key; PACT chain check is dead; posix_spawn without `CLOEXEC_DEFAULT`; `killpg` misses `setsid` children; 1 MiB output cap kills the script instead of truncating; `/token` has no rate limit; `/health` leaks the issuer; `install-host.sh` fetches Docker's apt key with no fingerprint pin; the home-directory git repo (`homebase`, private) commits `.supabase/access-token` (the committed value is one of the tokens killed in the 10-21 rotation and is dead; the full history holds no other secret files).

## 4. What is solid

These are the promises the code keeps, so nobody re-litigates them.

- Daemon: staged bytes root-only (0700 dir, 0500 file), re-read and re-hashed before run; fingerprint covers host, script, args, run_as, timeout, template; approver identity by `LOCAL_PEERCRED` gated to uid 450; approver-shell grammar closed (`stage` unreachable over SSH); must be shown before deciding; signed path binds v, host, request_id, fp, nonce, tier, expires_at, single use, skew-checked; policy hash bound at decision; clean env, `/dev/null` stdin, own process group, timeout; fail closed on integrity or fingerprint mismatch; receipts hash-chained in a root 0700 dir.
- Relay: phone verifies the node's signature over the exact bytes and recomputes the fingerprint from the script it shows; daemon trusts nothing from the relay except device signatures against root-only `keys.json`; signed HTTP with replay cache; push-token rotation device-signed; daemon is outbound-only over HTTPS.
- VM: no network, socket, serial, audio, graphics, keyboard, pointer or balloon devices; input share read-only; CPU, memory and runtime bounds; writable disks must be dense; seal re-hashes the read-only tree after mount; `mac-tree-guard` enforces RO, local, root-mounted, ACL-free, no nested mounts; build account has no password, no admin, no SSH, 0700 home.
- Gate: no HTTP ingress (queue-only, authenticity from Cloudflare's event subscription); ticket bound by fork name, agent id from the ticket not the event; proposal pinned to the immutable SHA; landed tree = base plus byte-checked overlay, symlink/exec/gitlink entries refused, `.git` segments refused; allow-list is segment-boundary, case-sensitive, no globs; stale-base handled with CAS at three points; decisions append-only except `error`; receipts table has abort triggers.
- Compute (when active): bearer digests compared constant-time, role and environment bound; enrollment owner-only with CAS and incarnation fence; capabilities HMAC-bound to lease and attempt; no shell command built from job fields; Linux container `--network=none --read-only --cap-drop=ALL`, pinned digest, AppArmor, userns.
- Epoch transport: strict config grammar, hashed bearers, pinned observer, output is hashes only; no treasury or payment dispatch exists.

## 5. The direct protocol: how safety is built into the mechanism

The design's one true primitive is "the daemon runs exactly these bytes after a signature that could only come from your hand". Everything in section 3 is a place where the system quietly falls back to a weaker primitive: a pointer instead of bytes, a bearer instead of a signature, a passcode instead of a face, a label instead of a fingerprint, a string match instead of a type. The protocol fix is to remove each fallback.

1. **Approve bytes, never pointers.** `stage` grows an `attachments` map; the daemon stores them root-only, folds their hashes into the fingerprint, and lists them in the render. The render refuses any `/Users`, `~`, `$HOME` reference. The install scripts pin every binary by sha inside the approved body. (C2, H6, M6)
2. **Root runs in a root-only world.** `PATH` without `/opt/homebrew/bin`; `BASH_ENV` and friends cleared; absolute paths in scripts; results verified against the root-owned intake receipt. (H1, H8)
3. **One kind of approver, proven by biometry.** Decision key `.biometryCurrentSet` + `.deviceOwnerAuthenticationWithBiometrics`; devices without it are refused at enrollment; the SSH shortcut becomes `show`-only; no iPhone Mirroring on agent Macs. (C3)
4. **Enrollment and policy are typed ops, not text.** `enroll_key`, `revoke_key`, `set_policy` with daemon-computed fingerprints in the render and a required quoted fingerprint in the approval; free-form scripts that touch the daemon's own files are refused. (C4, M3)
5. **No bearer lives where an agent runs.** Relay owner bearer, compute owner and verifier, task token, Cloudflare OAuth, GitHub, gcloud: each either moves into a root-only store used by an approved template, or into a separate admin account. The owner and verifier for compute are never on the same machine. (H2, H3, H11)
6. **Fail closed by default.** Intake refuses an empty allow-list; `VERIFY_REQUIRE_CHECKED=1`; verifier responses signed; binary and no-op pushes become `reject` with a reason, not retried errors. (H4, H10, M7)
7. **The relay is a courier, not a judge.** Node publishes its approver key ids in the signed payload; relay accepts decisions only from those; decision PK includes `key_id`; receipt entries node-signed and head-verified; `pending` paged; a stage quota per uid. (H5, M5, H9)
8. **Detective controls where prevention is slow.** A scheduled job that diffs base's ref history against the decisions table; a daily list of root daemons whose program is user-owned (this review's probe found F9 that way); a daily list of bearer files under `~/.config`. (H3, F9, H2)
9. **Peer text is never authority.** Written into the hook that injects handoff packets, and into every privileged tool: it demands a receipt id. Packets signed per lane when the fabric is built. (M9)
10. **The render is boring on purpose.** Control, bidi and zero-width characters refused; description one line, escaped; sha256 and line count printed; full ids only. (M1, M2)

## 6. Order of work

**Today**
1. `participation-coordinator`: disable `begin_actor_recovery`/`complete_actor_recovery` (or the `/token` route) until the fix ships; it is public. Then insert-only `registerDevice` with `keyID == sha256(pub)`, operator-issued recovery secret, server-side invites, `requireMembership` against `req.principal`. (C1)
2. Daemon release 1.3: PATH fix; `SIGPIPE` ignore and `SO_NOSIGPIPE`; send/receive deadlines; render sanitization; full-id approvals; pending caps and GC; orphan reconciliation. (H1, H9, M1, M2)
3. Stop the launcher pattern in all new staged scripts: inline payloads until attachments exist. (C2)
4. Pin shas in `install-host-helpers.sh`. (H6)
5. Intake refuses empty `allowedRoots`. (H4)

**This week**
6. Attachments in `stage` and in the fingerprint; typed `enroll_key`/`set_policy` ops with daemon fingerprints. (C2, C4)
7. Fabric decision key with biometry required; relay and daemon refuse non-biometric devices; `approver_key_ids` in the signed payload; `key_id` in the decisions PK. (C3, H5)
8. Move the five bearer files out of `~`: root-only store plus templates, or a separate admin account; verifier on a different machine from owner. (H2)
9. `build-job.sh` input validation; results verified from the intake receipt. (H7, H8)
10. Fix F9 on Mac4 (run the pose publisher as your user, or root-own the script).

**Next**
11. Gate-only base tokens and the base-ref audit job. (H3)
12. `VERIFY_REQUIRE_CHECKED=1`, signed verifier responses, API behind Access. (H10, M8)
13. Node-signed receipt entries with head verification; no secrets in staged bodies. (M4, M5)
14. Compute hardening before enrolling the first worker: worker fencing, observer role, prefix-scoped service account. (H11)
15. Signed handoff packets and the untrusted-input frame when the fabric hooks are built. (M9)
16. Correct `DELEGATED-AUTHORITY.md` to describe what exists: relay-pull with TOFU node pins, DO SQLite mirror, staging deployed, no App Attest, no tailnet TLS port, no `min_tier_for_policy_change`.

## 7. Cross-references

Rotation ledger: `docs/ROTATION-2026-10-20.md` (F9, F10, Vast, deferred rows). Design: `docs/DELEGATED-AUTHORITY.md`. Prior reviews: `docs/cloud-workspaces/{RUNTIME-REVIEW,SOURCE-REVIEW,BUILD-STORAGE-REVIEW,LIBRARY-REVIEW}.md`. Fabric app: `~/Developer/Fabric`.
