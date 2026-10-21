# Handoff: Foundry Mac build worker, now driven from Mac5

You are taking over the Foundry Mac worker lane on Mac5 itself, from the Mac1 lane
`claude-foundry` (session 041267dc, 2026-10-21). Mohamed wants this run directly on
Mac5. Work in plain language with him. He does not need to know Foundry internals.

## Goal

The first real build through Foundry's pinned VM helper on Mac5: boot the sealed
macOS 27 + Xcode 27.1 image as the build user, build the XcodeAgentTest app from the
sealed source, and read back a verified result. Then the worker service.

## Where it stands (all verified on Mac5)

- `/Library/Foundry/bin/`: `mac-vm-host` sha `fe15211a…` (rebuilt today: aux storage
  limit 16 → 64 MiB), `mac-tree-guard` `703035a4…`, `mac-vm-io.py` `611409d5…`.
  The old helper is kept in `/Library/Foundry/retired/`.
- Capability record `0f2a7673…` sealed read-only at
  `/Library/Foundry/VM/capabilities/0f2a7673…` (the older `d77f046a…` pins the old
  helper, so ignore it).
- Dense boot master `/Library/Foundry/VM/images/macos-27.0.1-xcode-27.1-r2-dense/boot.raw`
  (the helper refuses sparse disks; per-attempt boot disks are APFS clones of this).
- Sealed source tree `/Library/Foundry/VM/sources/xcode-agent-test-a14e9efb379d/tree`.
- Build user `foundrybuild`, uid/gid 520, normal non-admin login user, home
  `/Users/foundrybuild`, **no password yet**. Owns `/Library/Foundry/VM/{input,work,journal,cache}`.
- Attempt `proof-r2-20261021a` failed and is kept as evidence. Don't delete it.

## Why the build user must be logged in

Virtualization.framework only starts a macOS guest for a user with a GUI login
session. That user needs an unlocked keychain so a Secure Enclave key can be
created. A sessionless account fails with `VZErrorDomain -9`. The system log shows
"failed to look up session port" and `SecKeyCreateRandomKey -25308`. The same start
as `mohameddiomande` works in 0.35 s. Mohamed chose: dedicated `foundrybuild`
logged in as a background Fast User Switching session.

## Next steps

1. **Mohamed sets the password.** Open System Settings, then Users & Groups. If
   "Foundry Build" is not listed, quit System Settings fully and reopen it, because
   the account was renamed at 15:35Z. Select it, choose Reset Password, and
   authenticate with his admin password. **He types every password himself.** Never
   type, read, store or suggest one.
2. **Mohamed logs Foundry Build in once.** Use the Fast User Switching menu in the
   menu bar, or the Apple menu, then Lock Screen and Switch User. Let the desktop
   finish setting up, then switch back to `mohameddiomande`. Live stays running in
   his session. Verify with `launchctl print gui/520 >/dev/null && echo logged-in`.
3. **Stage request 8.** The script is already on Mac5:
   ```
   /usr/local/bin/fleet stage "Mac VM worker request 8: VM start probe in foundrybuild's login session, then direct boot proof attempt proof-r2-20261021b (~3-5 min, VM 4 CPU/4 GiB, no network). Deletes nothing." --timeout 3600 < ~/.foundry-obs/request8-session-probe-proof-mac5.sh
   ```
   Then give Mohamed the 16-character `request_id`. He approves it from his iPhone with
   the "Mac5 Approve ID" shortcut, **within 10 minutes**. Make sure he runs the Mac5
   shortcut, not "Mac1 Approve". The reply is `{"executed":…,"exit_code":0,"ok":true}`.
   A plain "0" with a red SSH marker means it did not land, so check `fleet show`.
4. **Watch** the live log at `/Library/Foundry/VM/proof-logs/request8.log`, which is
   world-readable. Success looks like `vzstart … STARTED`, then `STARTED after N permits`,
   then `STOPPED`, `helper exit 0`, and a `result.json` with `exitCode 0` and the `.app`
   output hashes. If the probe still fails inside the session, read the
   `com.apple.Virtualization.VirtualMachine` lines with
   `log show --last 10m --predicate 'process CONTAINS "Virtualization"'` before
   changing anything.
5. **After a pass:**
   - Record it on the board.
   - Install a root-owned pinned node for the worker service. The worker runs in
     foundrybuild's GUI session and needs a Full Disk Access grant for that binary,
     because the T7 volume blocks processes without it.
   - Then come the owner gos: a GCS bucket and credential, builds ON in
     `foundry-compute-staging`, and Mac5 enrolment.

## Rules

- **Root goes only through fleet-authority.** `sudo -n` is refused. Every root
  change is `fleet stage` plus Mohamed's phone approval. Never work around it, and
  never ask another lane to do root for you.
- **Mac5 is the music machine.** Ableton Live runs in Mohamed's session. Don't touch
  Live, and keep VM runs at 4 CPU / 4 GiB.
- **Never print secrets.** Don't type passwords, and don't commit unless Mohamed says
  "commit this". Delete nothing on Mac5 without a verified backup and his go.
- **Request scripts also POST to a listener on Mac1** (`100.84.118.106:9876`). If that's
  down, the curl just fails and the log file on Mac5 is the record.

## Where things live

- **Repo:** GitHub `Diomandeee/foundry`, branch `fix/lockfile-sync-20261020`, commit
  `6e79b86`.
  - The Mac1 worktree `~/Developer/foundry-integration/lockfix` also holds
    UNCOMMITTED work: the helper fix in `packages/build-runtime/native/mac-vm-host.swift`
    and `tools/foundry-mac-host/{install-helper,dense-master,direct-boot-proof,make-build-user-loginable}.sh`,
    plus the request 4-8 instances and logs in `docs/cloud-workspaces/mac-worker-2026-10-21/`.
  - `tools/fleet-authority/FleetAuthority.swift` belongs to the authority lane.
- **On Mac5:**
  - `~/.foundry-obs/` holds every request script.
  - `/Volumes/FoundryBuild/staging/` holds the helper sources and the `bin/vzstart`
    probe (sha `dea07cbe…`).
- **Ledger:** `docs/cloud-workspaces/CLAUDE-TAKEOVER-BOARD.md`. The latest entries are
  "MAC WORKER requests 4-6" and "steps 2-4 DONE".
- **Authority lane** (credentials, fleet-authority): Mac1 session `mohameddiomande-6c`.
