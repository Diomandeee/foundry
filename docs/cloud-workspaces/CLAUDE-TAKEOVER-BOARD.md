
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
- TODO (cost, from the Air Deck lane's Cloudflare read): Artifacts operations are the only metered part and the gate's history reads per check drive them. Make the gate loop cheaper (read the fork's commit range once per check instead of walking history per file).
