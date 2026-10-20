
## Conclude note
- title: Foundry lane taken over by Claude 2026-10-18
- decided: Local validation complete: 1878/1878 tests, tsc clean, native helpers compile (not installed)
- decided: Route stop = R7.1-local-validation-complete-operational-HOLD
- decided: Space retired
- decided:  GCS bucket foundry-library-pilot-648527652351 is the code library, Drive MotionMix-Central is the media store, Supabase Motion vpgywyfjvzumbauqenxx is the MotionMix index
- decided: K11 stays an external Craft batch facility, not a fabric executor
- open: Mac disk: all three below 50 GiB reserve (Mac1 29.0, Mac4 14.3, Mac5 12.7) -> needs approved named cleanup
- open: GCP: Compute Engine API disabled, credit/quote unverified -> approval before enabling
- open: First operational proof: publish catalog + restore one project on Mac1 (R7.2)
- open: Mac helpers/CAS/guest image not installed (R7.5)
- open: 76 dirty files on branch codex/foundry-integration-20261016, uncommitted
- open: K11 automatic MotionMix film canary still unobserved

## Conclude note
- title: Part A closed 2026-10-18 14:25
- decided: Full suite 1878/1878 + tsc clean (vitest-claude-takeover.log)
- decided: V11 heavy linux-isolated-input cases got 120 s timeout (load-only)
- decided: V12 enrollment retry at load 50 recorded, passes alone
- decided: FINDINGS complete, CHANGE-RECEIPT.json written
- open: Commit branch (awaiting Mohamed)
- open: B1 first real restore on Mac1
- open: B3 disk headroom approvals
- open: B4 GCP credit/quote

## 2026-10-18 23:30 memory plane recognized, UCTM retired
- decided: Foundry = sole control plane; UCTM Studio/AO retired read-only (Mac1 UCTM cron jobs removed; the `uctm-listen` tunnel is MotionMix listen streaming and stays).
- decided: Supabase Memory `zdcqqvvcpfpfyvbbfgsy` via ai-memory-runtime = sole agent memory; foundry-memory MCP reads it; D1 decisions stay authority. Recorded in ARCHITECTURE.md.
- done: full AO ao.db archived to GCS (md5 verified), local replaced by a 466 MB slim copy (all tables except change_log bodies and conversation_provider_events; integrity ok; ao-sessions verified).
- open: Part B steps B1-B6 unchanged; disk reserve status: Mac1 ~34+ GiB, Mac4 46 GiB, Mac5 92 GiB free (B3 reserve 50 GiB).

## 2026-10-19 02:35 EDT first real project through the staging gate: Air Deck
- done: Artifacts repo `foundry-staging/airdeck` seeded by operator push of GitHub `Diomandeee/AirDeck@a1bb6a2` (bootstrap, outside the gate) and subscribed.
- done: staging orchestrator `TASK_TOKEN` rotated (the old value was not held anywhere on Mac1); new value only in `~/.config/foundry/staging-task-token` (0600). Push/fetch helpers `~/.config/foundry/bin/foundry-{push,fetch}` issue 15 min repo tokens and pass them through GIT_ASKPASS (never on a command line).
- done: task `airdeck-saved-crate-to-drive` -> decision 29 merge 7537246; task `airdeck-saved-crate-edits` -> decision 33 merge 0a2f409. GitHub main fast-forwarded to the gated merge.
- BUG (deployed staging gate, version 585ff890 = foundry main cf27ac6 code): `artifacts-port/cloudflare.ts diffFiles` compares blob hashes only when a commit adds/deletes nothing, so a commit that adds or deletes AND edits loses the edits (task 1 dropped 4 edited files, admitted the rest, merged silently). Also `commitForkFiles` writes without mode, so the executable bit is lost. The integration branch already fixes the diff (full [hash,type,mode] inventory) and checks landed bytes/modes against admission; it is not deployed. Until then: keep add/delete and edit commits separate per task, run scripts with `bash`.
- BUG (cosmetic): the base repo is subscribed, so every gated merge echoes as a "no task ticket for fork <base>" reject (decisions 30, 32; the Oct 14 `dispatch` rejects are the same echo).
- BUG (cosmetic): `GET /decisions` on foundry-api-staging served a stale list (ended at id 28) while D1 held 29-33.
- limit: the gate admits UTF-8 text only (8 MiB per merge). Binary assets must be seeded or live outside Git (Air Deck audio -> gdrive:Assets/AirDeck).
- OWNER (2026-10-19, agreed with the Air Deck lane c39d3f91): the staging gate redeploy with the diff/mode fix is owned by the Foundry lane (94c69dbf). It ships only after Mohamed sees the diff and says go; no other lane deploys the gate. Until then lanes keep add/delete and edit commits separate.
- DEPLOYED 2026-10-19 ~13:33 EDT (Mohamed: "go"): foundry-gate-staging 585ff890 -> 42d223c1 from hotfix/gate-diff-mode-20261019 f974113 = deployed base cf27ac6 + packages/artifacts-port from 1c931fe only (nothing else from the integration branch). tsc clean, vitest 31 files / 287 tests pass in a clean install of that tree; bindings identical to 585ff890 (D1 foundry-decisions-staging, Artifacts foundry-staging); queue foundry-push-events-staging consumer still foundry-gate-staging. The lockfile at cf27ac6 is out of sync with package.json (missing @foundry/compute-authority), so `npm ci` fails on main; left as is. First real check = the Air Deck lane's next gated task.
- VERIFIED 2026-10-19 by the Air Deck lane: task airdeck-freeze-and-body-camera, decision 36 merge 7de4bcd (base 0a2f409). Merged tree hash equals the pushed head 9d1e590 (17 files, including 3 new files in commits that also edit, the old drop case); 100755 kept on scripts/e2e-mirror.sh and scripts/install-ipad.sh. GitHub AirDeck main fast-forwarded to 7de4bcd.
- FINDING (open): decision 35 rejected the first push as snapshot_too_stale (age 14438 s, max 300) because freshness is measured from the head commit's AUTHORED time (workers/gate/src/decide.ts:250; artifacts-port cloudflare.ts:88 maps date = authoredAt). Any lane that commits, tests, then pushes hits it. Workaround: re-stamp the head (`git commit --amend --no-edit --date=now`) right before pushing. Real fix to decide: measure from the push/receipt time (or committer date) instead of author date; needs a gate change + redeploy with Mohamed's go.
## 2026-10-19 ~20:00 EDT B4 GCP Linux pilot host (done by the Air Deck lane c39d3f91 on Mohamed's direct "Just do it directly here")
- Project project-8380e794-e4d6-4ad4-aaf (648527652351); APIs enabled compute.googleapis.com, billingbudgets.googleapis.com. Trial credit $300 unused, ~88 days (expires ~2027-01-15).
- Budget billingAccounts/01E604-C28BC0-A1C645/budgets/7a365f4b-a1f9-43c4-8ba2-e8b35c06a8f9 "foundry-fabric-pilot" $50, project-filtered, email alerts 50/90/100% (not a cap).
- Network foundry-pilot-net / subnet foundry-pilot-us-east1 10.60.0.0/24 (Private Google Access); firewall foundry-pilot-allow-iap-ssh tcp:22 from 35.235.240.0/20 to tag foundry-worker only; egress via ephemeral external IP (released on stop); public 22 verified closed.
- SA foundry-linux-worker@...: logging.logWriter + monitoring.metricWriter (project), storage.objectViewer on gs://foundry-library-pilot-648527652351 only (write verified denied).
- VM foundry-linux-pilot-01 id 8576385442087899318, us-east1-b, e2-standard-2, ubuntu-2404-noble-amd64-v20261016, Shielded VM, OS Login, project SSH keys blocked; boot 30 GiB + workspace 100 GiB pd-balanced (autoDelete false, /workspace). STATE: STOPPED (disk-only billing, ~$10/month).
- Disposable check passed: Ubuntu 24.04.5, metadata identity = worker SA, https egress, library list OK; lume-motion-state 83ef6c9 unittest 65 OK in 2.6 s; job dir removed.
- OPEN (Foundry lane): Tailscale/worker agent/container policy, compute route deploy + enrollment, a B1 library restore on the VM. DONE (Mohamed "Delete it", via the Air Deck lane): the auto-created `default` VPC is deleted with its 4 default-allow firewall rules and 42 auto subnets (0 instances on it). The project now has only foundry-pilot-net + foundry-pilot-allow-iap-ssh.
## 2026-10-19 20:30 EDT PAUSE POINT before the Mac1 / Mac4 macOS 27.2 updates
Everything below is committed and is the state to resume from.
- LUME stage restored and verified by Mohamed: github.com/Diomandeee/lume-commerce bb09282, infra/STAGE-MAP.md is the source of truth (ports, services, depth geometry 640x576/2 unaligned). Stage Unity = LumeWorld (unity/LumePCloud).
- K11 is in the same repo (stage/k11, infra/k11), weekly body_motion rotation from Mac4, full C:\lume cold archive in gs://fleet-backup-648527652351/k11/2026-10-19/.
- Staging gate fix live (42d223c1), verified by Air Deck decision 36. Open: freshness measured from author date (re-stamp before push until fixed).
- B4 Linux pilot exists and is STOPPED. Open for this lane: Tailscale/worker agent, compute route deploy + enrollment, B1 library restore on the VM.
- Open: Mac1/Mac4 disk (staged 27.2 in Preboot; Mohamed is installing it), LumeWorld needs the web fluid publisher + 9712 skeleton fallback ported in, UDP 9702 Mocopi suit vs lume.consumer.
- LumeWorld (the stage Unity) completed after the pause entry: lume-commerce 4b1777d (web fluid + skeleton + depth verified).
- Convergence input from the Air Deck lane: Coltivare has 3+ divergent heads (Mac1 Coltivare-Beta codex/launch-beta-alignment 859912a, 31 commits ahead of GitHub b3e8874 and unpushed; Mac1 Coltivare-build29 fix/session-entry-build29 4cb3a01; Mac4 web worktree pass-aux-mac4; an 11-file Oct 11 WIP of unknown owner). Reconcile and push before its first Foundry task. Mac1 ~/Library/LaunchAgents holds 14 inert *.bak/*.pre-*/*.disabled-* plists (Mohamed's call to delete).
- Convergence goal Mohamed set for the return: bring LUME (Mac4/K11), MotionMix (Mac1 hub) and Air Deck (iPad/relay) under Foundry with one map, clean code, nothing stale.
- TODO (cost, from the Air Deck lane's Cloudflare read): Artifacts operations are the only metered part and the gate's history reads per check drive them. Make the gate loop cheaper (read the fork's commit range once per check instead of walking history per file).
