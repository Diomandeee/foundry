# Delegated authority: how Mohamed's phone becomes the only root key

Status: design under scrutiny, 2026-10-20 night. Nothing built. Companion to
`docs/AGENT-FABRIC.md`. Written against the fleet as it is tonight (verified, not assumed).

## 0. The claim being tested

"Do passwords once, then delegate forever, without deciding in advance what the system will
need to do." The claim survives, but only in one form: delegate **authority to act**, held by a
key that cannot leave the phone, verified by a tiny root service on each machine, under a
**policy** that decides how much friction each action gets. Delegating the **password** does
not survive scrutiny, and we are currently doing exactly that in three places (§1).

## 1. Findings: what the fleet looks like to an attacker tonight

The attacker that matters is not a stranger. It is **a compromised or confused agent**: a
Claude Code or Codex session that reads a poisoned file, a prompt injection in a web page or
a repo, or plain error. Six lanes run on Mac1 as the login user with permissions skipped
(`--dangerously-skip-permissions` in `~/.claude/lanes/lanes.json`), and more on Mac4/Mac5. So:

| # | Finding | Severity | Why it matters |
|---|---|---|---|
| F1 | **Mac5 grants the login user `NOPASSWD: ALL`** (`/etc/sudoers.d/nopasswd`, pre-existing). Mac4 and Mac1 do not. | critical | Every agent on Mac5 is root already. Mac5 is the music machine, the build host, the camera host. Today's password ceremonies on Mac5 proved nothing. |
| F2 | **The `approve` tool is user-writable** (`~/.local/bin/approve`, owned by the login user). | high | An agent can rewrite it so that the next password you type runs anything. The trust root sits in the territory the attacker controls. |
| F3 | **Your Mac password is stored in an iPhone shortcut** (`WFSSHPassword` in the Shortcuts database, synced via iCloud to every device). | high | Anyone who can read that database, or a shortcut exported by mistake, holds full admin on Mac5. |
| F4 | **Secrets readable by agents**: a Supabase service key in `~/.zshenv`, the eero session token in `~/.config/eero/token`, 12 SSH key pairs in `~/.ssh` (including the Pi, the VM guest, GitHub), `.env` files committed in Comp-Core's history. | high | A compromised lane can push to GitHub, change the home router, write to production databases, and log into every node. |
| F5 | **On the Pi, `mo` is in the `docker` group**, which is root-equivalent; today's `sudoers` rule was installed through it. | medium | Same as F1 for the Pi. Also proves the point: any "narrow" rule is bypassable when a root-equivalent group exists. |
| F6 | **The Canonical guard and all hooks are user-space scripts** under `~/.codex` and `~/.claude`. | medium | They are good *advisory* controls for an honest agent; they are not a security boundary. An agent can edit them (I edited them today). |
| F7 | **FileVault off on Mac4/Mac5** (for auto-login). | accepted | Physical theft reads the disk. Accepted for in-home machines; it is why nothing durable may live only on them. |
| F8 | **The VM guest has passwordless sudo** (`admin`). | accepted | Correct: the guest is disposable, offline during jobs, and the host stops it. |

Conclusion: the account the agents run as must be treated as **untrusted**. Anything the
fleet relies on for authority must live where that account cannot write: root-owned on the
Mac, in the phone's Secure Enclave, or in Foundry's Cloudflare authority.

## 2. Threat model

| Adversary | Can | Cannot (after this design) |
|---|---|---|
| **Compromised agent** (same user as you, on any Mac) | read user files, run user-level commands, alter hooks, send misleading text, stage approval requests | obtain root, forge an approval, alter what the daemon shows you, read the daemon's keys |
| **Stolen phone, locked** | nothing (Face ID + Secure Enclave) | sign anything |
| **Stolen phone, unlocked** | read the app's screens | sign a Tier 2/3 action without Face ID (biometry is required per signature, not per unlock) |
| **Rogue device on the tailnet** | talk to services that accept tailnet traffic | approve anything (needs the phone key); reach daemons not ACL'd to it |
| **Stolen Mac4/Mac5 disk** | read everything on that disk (F7) | approve anything (no phone key on disk); impersonate another node (per-node keys) |
| **Our own code** (supply chain: hooks, scripts, this design) | be wrong | escape the policy once installed, because policy changes are themselves Tier 3 |

Out of scope: Apple, Cloudflare and Tailscale themselves; physical access with a screwdriver.

## 3. Principles (each one closes a finding)

1. **Authority is a signature, never a secret** (F2, F3). What crosses the network is "yes to
   fingerprint X on host H, nonce N, before time T", signed by a key that physically cannot
   leave the phone. There is nothing to steal that is usable twice.
2. **The verifier is root-owned and tiny** (F2, F6). The daemon that checks the signature and
   runs the script is a LaunchDaemon owned by root, in a root-only directory, with its own hash
   recorded at install. Nothing the login user can write is on the path from "approved" to
   "running".
3. **You approve what the daemon will run, not what the agent says it will run** (F6). The
   text you see on the phone is computed by the daemon from the staged bytes, and the signature
   covers those bytes. The agent's description is shown as a labelled hint, never as the thing
   being approved.
4. **Friction is a policy, not a code path.** The mechanism is one generic "run this exact
   script as root". The *tier* (auto, tap, Face ID) is decided by a signed policy the daemon
   holds. Changing the policy is a Tier 3 action. That is what lets the system "hold the
   capacity of the future": new needs change rules, not mechanisms.
5. **Blast radius is one machine.** Each node has its own daemon key and its own enrollment.
   Nothing on Mac5 lets you act on Mac4.
6. **Every decision is a receipt** in an append-only, hash-chained log that is mirrored off the
   machine (Foundry D1 or Supabase), so a compromised node cannot rewrite its own history.
7. **No preconceived screens.** The daemon emits typed events; the app renders by type with a
   generic fallback. Approval cards are the one exception: their rendering is fixed and
   boring on purpose, because that is the moment of authority.
8. **Fail closed, recover by a second key.** If anything is unverifiable, nothing runs. If
   the phone is lost, a second enrolled authority (Mac1 Touch ID, or a sealed recovery key)
   revokes it.

## 4. Architecture

```
  iPhone (Pebble successor)                              each Mac (Mac1, Mac4, Mac5)
  ┌──────────────────────────────┐                        ┌────────────────────────────────┐
  │ Secure Enclave P-256 key     │   signed approval       │ fleet-authority (LaunchDaemon, │
  │  Face ID per signature       │ ──────────────────────► │  root, /Library/FleetAuthority) │
  │ App Attest at enrollment     │  {host, fp, nonce,      │  • verifies signature + policy │
  │ Actionable push (APNs)       │   tier, expires}        │  • runs the exact staged bytes │
  │ Renders typed events         │ ◄────────────────────── │  • hash-chained receipts       │
  └───────▲──────────────────────┘   events, cards, feeds  │  • unix socket for staging     │
          │ Tailscale (ACL: phone ↔ daemons only)          └───────────▲────────────────────┘
          │                                                            │ stage (no authority)
  ┌───────┴──────────────────────┐                        ┌────────────┴────────────────────┐
  │ fleet-signal (Cloudflare     │                        │ agents (Claude Code / Codex),   │
  │  Worker in Foundry):         │◄── events, enrolled ───┤ user space, untrusted:          │
  │  push, receipt mirror,       │    per node             │  stage requests, view-agent     │
  │  policy registry             │                        │  (accessibility + screen feed)  │
  └──────────────────────────────┘                        └─────────────────────────────────┘
```

### 4.1 `fleet-authority` daemon (per Mac)

- **Where:** `/Library/FleetAuthority/{bin/fleet-authority, policy.json, keys/, log/}`, all
  root:wheel, `0700` on `keys/` and `log/`. Loaded by `/Library/LaunchDaemons/com.fleet.authority.plist`.
- **Language:** Swift (CryptoKit for P-256 verification, Security.framework, no third-party
  code). Small: staging intake, policy, verification, execution, receipts. Target under 1,500
  lines so it can be read in one sitting and reviewed by an independent pass before install.
- **Interfaces:**
  - `unix:/var/run/fleet-authority.sock` (mode 0666, but the socket accepts only **stage** and
    **show**; nothing on it can execute). Agents and `fleet` CLI use it.
  - `tcp` bound to the **Tailscale interface only**, TLS with a per-node key, accepting
    **approve**, **deny**, **enroll**, **policy-update** from enrolled phone keys. Tailscale ACL
    restricts the port to the phone (and Mac1 as recovery authority).
- **Staging:** the daemon copies the request bytes into `/Library/FleetAuthority/pending/<id>/`
  (root-only), computes `fp = sha256(canonical(host, script, env, runAs, cwd, timeout))`, derives
  the tier from policy, and emits an event. From this moment the staged bytes are immutable.
- **Approval message** (what the phone signs), canonical JSON:
  `{v:1, host, request_id, fp, tier, nonce, issued_at, expires_at, decision: approve|deny}`.
  `nonce` is minted by the daemon per request; `expires_at` ≤ 10 min. Replay is impossible
  (nonce single-use, request single-use); downgrade is impossible (tier is inside the signed
  message and must equal the daemon's own derivation).
- **Execution:** `/bin/bash` on the staged file, as the requested user (root by default),
  clean environment, no stdin, cgroup-less but with a hard timeout and output cap; stdout/err
  captured to the receipt. The daemon refuses if the staged file's hash changed, if the policy
  file's hash changed since the tier was derived, or if its own binary hash does not match the
  install receipt (self-check at start).
- **Receipts:** `log/receipts.jsonl`, each entry `sha256(prev + canonical(entry))`; every entry
  also POSTed to `fleet-signal` with the node's enrollment credential (Foundry's existing
  worker-enrollment pattern: credential digest + monotonic sequence, so a replayed or
  rewound log is detectable).
- **Self-protection:** policy and enrolled keys change only through Tier 3 approvals signed by
  the current key set; the daemon rejects any policy whose `min_tier_for_policy_change` < 3.

### 4.2 Policy (the part that evolves)

```json
{
  "v": 1, "host": "mac5", "signed_by": ["phone-key-id"], "issued_at": "...",
  "default_tier": 3,
  "rules": [
    {"match": {"template": "lane.restart"},            "tier": 0, "rate": "10/h"},
    {"match": {"template": "vm.start|vm.stop"},        "tier": 0},
    {"match": {"template": "service.restart", "arg": "com.lume.*"}, "tier": 1},
    {"match": {"template": "pkg.install"},             "tier": 2},
    {"match": {"paths_touch": ["/etc/sudoers*", "/Library/LaunchDaemons/*", "/Library/FleetAuthority/*"]}, "tier": 3},
    {"match": {"free_form_script": true},              "tier": 3}
  ],
  "tiers": {
    "0": {"approval": "none", "notify": "digest"},
    "1": {"approval": "tap",  "notify": "push"},
    "2": {"approval": "face_id", "notify": "push"},
    "3": {"approval": "face_id", "notify": "push", "show_full_script": true, "cooldown_s": 30}
  },
  "kill_switch": {"paused": false}
}
```

- **Templates** are the way routine work stops needing you: a template is a root-owned script
  with typed arguments (`lane.restart <eid>`), validated by the daemon, and a rule can grant it
  Tier 0. Free-form scripts are always Tier 3 with the full text shown.
- A new kind of action starts as free-form (Tier 3). When it recurs, it becomes a template.
  When it is trusted, its rule drops a tier. The mechanism never changes; only the rules do.
- **Kill switch:** one Tier 2 action pauses all Tier 0 automation fleet-wide (via `fleet-signal`).

### 4.3 The phone (Pebble's successor)

- Key: P-256 in the **Secure Enclave**, access control `biometryCurrentSet` for Tier 2/3
  signatures (any re-enrolled face invalidates the key), `userPresence` for Tier 1 taps.
- Enrollment: App Attest assertion + the key's public half, delivered to each daemon through a
  Tier 3 ceremony that bootstraps from the **install ceremony** (the last time a password is
  typed, §6).
- Notifications: APNs actionable categories (`Approve`, `Deny`, `Show`). The push payload is
  **untrusted transport**: tapping Approve opens the app, which fetches the canonical request
  from the daemon over Tailscale, verifies it is the daemon talking (pinned per-node TLS
  identity), renders it, then signs. Push content can wake you; it can never approve.
- The app holds **no secrets** besides the Secure Enclave key reference. The Shortcuts-stored
  password (F3) is deleted at cut-over.

### 4.4 `fleet-signal` (Cloudflare Worker, in Foundry)

- Receives events and receipts from enrolled nodes; sends APNs pushes (the APNs auth key is a
  Worker secret, never on a Mac); mirrors receipts into D1 (immutable, like Foundry's
  `verification_receipts` trigger); serves the policy registry (read) and records policy
  updates (write, only with a Tier 3 signature verified again server-side).
- It is **not** an authority: it cannot approve, and daemons never trust it for decisions.
  If it is down, pushes stop; approvals still work directly over Tailscale.

### 4.5 Views (the expressive part, deliberately powerless)

- A user-space **view-agent** on each Mac (not root) provides: text feeds of lanes (from
  tmux, cheap and crisp), **screen feeds** via ScreenCaptureKit, and **generated controls** from
  the focused window's accessibility tree (real buttons, fields, values), rendered natively on
  the phone; a tap becomes a user-level accessibility action on the Mac.
- Hard limit (Apple's, and ours): synthetic input never answers a security prompt, and the
  view-agent has no path to the daemon's execute. If the view-agent lies, you see a wrong
  picture; you still cannot be tricked into approving, because the approval card always comes
  from the daemon, not from a view.
- Rendering rule: events carry a `kind` and a schema version; the app has renderers for known
  kinds (`approval`, `lane.waiting`, `build.result`, `feed.text`, `feed.screen`, `controls`)
  and a generic card for unknown ones. New backend capabilities ship without app changes
  until they deserve a better renderer.

## 5. Scrutiny: attacks against the design, and the answer

| Attack | Answer |
|---|---|
| Agent stages a script whose displayed description is innocent but whose body is not | The phone shows the daemon's rendering of the **bytes** (Tier 3 shows the full script); the description is a labelled hint. Templates (Tier 0-2) have no free-form body at all. |
| Agent swaps the staged file between "show" and "approve" (TOCTOU) | Staged bytes are root-owned and immutable; the signature covers `fp`; the daemon re-hashes before running. |
| Replay of an old approval | Per-request nonce, single use, 10-minute expiry, host-bound. |
| Tier downgrade (agent asks for Tier 0 on a Tier 3 action) | Tier is derived by the daemon from its policy and is inside the signed message; mismatch = refuse. |
| Agent edits the policy to make everything Tier 0 | Policy is root-owned and only changes via Tier 3 signature; the daemon enforces `min_tier_for_policy_change ≥ 3` on itself. |
| Agent edits the daemon binary | Root-owned, 0555; the daemon verifies its own hash against the install receipt at start; the receipt is mirrored off-box. |
| Rogue tailnet device posts approvals | Needs an enrolled phone key; Tailscale ACL limits who can even reach the port. |
| Phone unlocked in someone's hand | Tier 2/3 require Face ID per signature; Tier 1 taps are rate-limited and limited to template actions. |
| Phone lost | Mac1 (Touch ID, FileVault on) holds a second enrolled key with **revoke-only** rights; a sealed paper recovery key is the last resort. Revocation is a Tier 3 action signed by the recovery key. |
| Mac5 disk stolen (F7) | Node key is per-node; stolen key lets the thief impersonate *Mac5's receipts* until revoked, nothing more. No phone key, no approvals. |
| `fleet-signal` compromised | Can spam pushes and lie in the dashboard; cannot approve; receipts there are a mirror, the local chain is primary. Pins + App Attest limit spoofed enrollments. |
| Daemon bug | Fail closed on any verification error; no fallback to "run anyway". The transitional path (§6) stays installed as a manual alternative. |
| Automation runs amok at Tier 0 | Rate limits per rule, a fleet-wide kill switch, and digests of Tier 0 actions. |
| We lock ourselves out | Physical access always works (local admin at the Mac). Recovery mode is Apple's. |

What this design does **not** fix: a root compromise of a Mac by other means (kernel exploit,
malicious installer) owns that Mac. Per-node keys keep it to that Mac.

## 6. The install ceremony: the last passwords

One per Mac, in person or via the existing shortcut, in this order, so the dangerous state
(F1, F2, F3) is closed before anything else:

1. Install `fleet-authority` (root), enrol the phone key and the Mac1 recovery key, write the
   initial policy (`default_tier: 3`, no Tier 0 rules yet).
2. **Remove `/etc/sudoers.d/nopasswd` on Mac5** (F1). Remove the Pi `docker` group
   membership once the Pi's daemon (Linux port) exists; until then, know it is root.
3. Delete the password from the iPhone shortcut; keep the shortcut but switch it to an SSH
   key that reaches only a forced command (`fleet show`/`fleet approve-legacy`, root-owned),
   as the manual fallback (F3).
4. Replace `~/.local/bin/approve` with `/Library/FleetAuthority/bin/fleet` (F2).
5. Move agent-reachable secrets (F4): Supabase service key and eero token into the daemon's
   root-only store, exposed to agents only through templates (`eero.reserve`, `supabase.query`)
   that run under policy; rotate the keys that were in Comp-Core's `.env` history; keep in
   `~/.ssh` only keys that are forced-command or read-only (library relay style); move the
   GitHub push key behind a template or a short-lived token.
6. Verify: an agent on each Mac tries to escalate (sudo, edit policy, replay an approval) and
   every attempt is refused and logged.

After step 6, no password is typed again for fleet operations. Apple's own prompts (Screen
Recording, Accessibility, Camera for the view-agent; FileVault; recovery) remain in person,
once per Mac.

## 7. Build order

| Phase | Builds | Done when |
|---|---|---|
| S0 | Harden now, no new code: remove F1 (Mac5 sudoers), rotate F4 keys, delete the shortcut password after S1 | `sudo -n true` fails on every Mac; old keys revoked |
| S1 | `fleet-authority` daemon (Swift) + `fleet` CLI + install ceremony on Mac5; transitional approval = Shortcuts **SSH key** → forced command (no password anywhere) | an agent stages, you approve from the phone with no password; replay and tamper tests refuse |
| S2 | `fleet-signal` Worker: enrollment, receipts mirror, APNs | a staged request produces a push within seconds; receipts visible in D1 |
| S3 | Phone app v1 (Pebble codebase): enrollment, approval cards, Face ID, Secure Enclave signing; cut-over from the SSH-key fallback | Tier 2/3 approvals only via the app; shortcut demoted to fallback |
| S4 | Policy tiers + first templates (`lane.restart`, `vm.start/stop`, `service.restart`, `disk.prune`); kill switch | a day passes with zero taps for routine work and every action receipted |
| S5 | Mac4, Mac1, Pi daemons (Linux port in Python/stdlib or Go), GCP VM via its own path | every node enrolled; per-node keys; Pi `docker` group removed |
| S6 | View-agent: text feeds, screen feeds, generated controls; app renderers | you steer a lane and press a button in a Mac window from the phone; no path to execute |
| S7 | Convergence: chat, lanes, Captain/autopilot (Pebble), terminals (MeshControl) under the same event model | one app, one notification stream |

Each phase ends with an adversarial check performed by a different lane than the one that built it.

## 8. What I would decide if asked

- Build S0 **tomorrow morning**, before anything else; F1 is a standing root grant to every agent
  on Mac5.
- Write the daemon in Swift, not a scripting language, so the trust root is a signed binary
  with no interpreter on the path.
- Keep the policy in the daemon, not in the cloud: the cloud is a mirror and a messenger.
- Keep the shortcut as the fallback forever; it costs nothing and it is what works when the
  app is broken.
