# Linux pilot: first job through the isolation broker (2026-10-21 02:43 UTC)

Host: `foundry-linux-pilot-01` (GCP, us-east1-b, e2-standard-2, Ubuntu, IAP SSH only,
stopped after the run). Broker `/usr/local/libexec/foundry-linux-isolation.py`
sha `5a77888a…` run as `/usr/bin/python3.12 -I -S … serve` under
`systemd-run --unit foundry-broker-attempt1`. Controller: `tools/foundry-linux-host/run-attempt.py`
as `foundry-ctl` (uid/gid 1100). Policy written by `tools/foundry-linux-host/write-policy.py`.

## Result

| | |
|---|---|
| attemptId | `a1-calibrate-001` |
| identity | `990b0aaa71c8b06b567d48cbe05565bc6ce34deb99fbe9bb49fa56a2defc8232` |
| profileHash (pilot key, sha256 of canonical profile.json) | `123aca510510c22a6eaf5cb59b0cedf682a229e43670f7b37c019e3628513fa6` |
| input | Comp-Core `cc-echelon/tools/calibrate_extrinsics` (A1 multi-camera calibration, branch feat/a1-multicam-extrinsics) + 6 offline wheels (numpy 2.2.6, pytest 9.1.1 and deps): 60 files, 18,548,925 bytes |
| filesHash / inputHash | `e60940ab…` / `b3175b23…` (receipt.json) |
| image | `python@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1` (amd64) |
| phases | 0: `pip install --no-index --find-links /work/source/wheels --target /work/site numpy pytest`; 1: `pytest -q -p no:cacheprovider --junitxml=/work/out/junit.xml /work/source/calibrate_extrinsics` |
| container | network none, read-only rootfs, uid 1200 (host 101200 via userns-remap), cap-drop ALL, no-new-privileges, AppArmor `foundry-linux-build-v1` (compiled `cdb754cf…`), cgroup `/foundry-builds/<identity>`, 2 cpu, 3072 MiB, 512 pids, /tmp tmpfs 512 MiB noexec, /work = 2 GiB loop ext4 |
| outcome | **PASS**: 42 passed, 2 skipped (opencv-only tests) in 59.8 s; exitCode 0 |
| output | `out/junit.xml` 5946 bytes sha `99b1e6bc…`; log 747 bytes sha `3e063371…`; both re-hashed on the controller side after `read` |
| timings | begin 0.2 s (2 GiB fallocate+mke2fs+mount), 60 files streamed and sealed at 1.36 s, start 1.64 s, terminal 70.8 s, capture+fetch 70.9 s; 247 protocol requests |
| after | cgroup `frozen 1 populated 0`; `slot.json` held; `work.ext4` still mounted read-only; both containers `Exited (0)`; census `complete:true slotFree:false` |

Files here: `receipt.json` (controller), `log`, `junit.xml`, `events.jsonl` (broker journal),
`census.json`, `slot.json`, `policy-receipt.json`, `policy.sha256`, `profile.json`.

The same two phases were dry-run first with plain `docker run` under the same flags
(42 passed, 2 skipped) so a wrong command would not burn the host's single slot: a failed
attempt keeps no build log (`failure()` journals only the operation name).

## Findings

1. **Zero-length install files.** The 2026-10-20 host install wrote `/etc/apparmor.d/foundry-linux-build-v1`
   and `/usr/local/libexec/foundry-linux-isolation.py` with `install(1)` and the VM was stopped
   two minutes later; both came back 0 bytes after the reboot (ext4 delayed allocation, no fsync).
   The kernel still held the correctly compiled profile (`raw_sha256` unchanged after reload),
   so the broker's AppArmor source check refused until the source was restored. Fixed:
   both restored from the repo copies (sha `95222d83…`, `5a77888a…`), `install-host.sh`
   now `sync -f`s what it pins. The install receipt's `broker` hash was taken from the
   in-memory file and is correct; only the on-disk copies were lost.
2. **Launch the broker as `/usr/bin/python3.12`, not `python3`.** `trusted(sys.executable)`
   refuses the `/usr/bin/python3` symlink; the unit exits 1 silently (by design: no text on stdout).
3. **Client EOF is journaled as `operation-failed / tick`.** After capture the controller
   closes the socket; the server's `require(b)` on recv raises while `operation` still reads
   `tick`, so events.jsonl ends with `{"event":"operation-failed","operation":"tick",
   "containmentConfirmed":true,"captureComplete":true}`. Harmless (containment and capture
   flags are true) but misleading; a fix changes the pinned broker and needs re-review.
4. **The TypeScript controller cannot express this recipe.** `plans.ts` accepts only
   `npm | cargo | cmake` for `linux-build-v1`, one phase (two for cmake) and a fixed env.
   This job is Python with two phases, so its profile is keyed by the sha256 of the profile
   itself (`write-policy.py` default), not by a `localRecipeHash` from `foundry-build-pilot prepare`.
   A `python` tool (or a generic `imageExecutables` phase list) in `plans.ts` is the real fix.
5. **One attempt per host install.** The pilot retains slot, loop mount, cgroup and containers
   on purpose. A second attempt needs a root reset (below) or a fresh VM.

## Reset for the next attempt (root, deliberate)

```
systemctl stop foundry-broker-attempt1 2>/dev/null; systemctl reset-failed
umount /var/lib/foundry-linux/attempts/a1-calibrate-001/work
docker rm $(docker ps -aq --filter label=foundry.isolated)
rmdir /sys/fs/cgroup/foundry-builds/*          # frozen+empty; rmdir is allowed
mv /var/lib/foundry-linux/attempts/a1-calibrate-001 /var/lib/foundry-linux/archive-a1-calibrate-001
rm /var/lib/foundry-linux/slot.json /run/foundry-linux/broker.sock
```
The policy stays. `write-policy.py` refuses to touch a policy while `slot.json` exists.
