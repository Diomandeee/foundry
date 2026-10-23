---
status: draft
describes: [docs/app-fleet/, tools/app-fleet/ (to be built)]
verified_at: 2026-10-22
owner_lane: claude-authority (security lane, now also app-fleet + storage)
---

# App fleet into Foundry, storage off the Macs, security last

Mohamed, 2026-10-22 ~03:30Z: "get in tune with the app fleet ... incorporate all of those apps into Foundry ... cleaning up the disk ... no more are my files being saved on my desktop or Mac4, Mac5 ... three different lanes. The security will be at the end."

Everything below was measured on 2026-10-22 between 03:00Z and 04:00Z. No secret values were read or printed.

## 1. What the app fleet actually is today

The March-April 2026 fleet was 59 iOS apps in four waves (10 flagship, 17 Trajectory Bloom, 18 Wave 3, 14 Fleet 3), scaffolded on `OpenClawKit`, pushed to private GitHub, and most of them put through TestFlight between Mar 2 and Mar 8. The authoritative per-app table (bundle id, repo, App Store Connect category, TestFlight state) is `~/.claude/projects/-Users-mohameddiomande/memory/ios-apps.md`. The lifecycle machinery around it (app-as-entity, Pane Awareness and Evolution, the Fleet Evolution pipeline in MeshControl) lived in Supabase tables `app_entities`, `app_evolution_queue`, `app_evolution_states`, `revenue_events` on project `aaqbofotpchgpyuohmmz`. That project was Comp Core. It was deleted in the 10-21 rotation, and no local dump of those tables exists. The registry is gone; the apps are not.

"Muse" is not an app tracker. It is the coding-agent harness under `~/.local/share/muse` (sessions, fleet-manager state, relay). The app tracking Mohamed remembers is the entity/evolution tables above plus MeshControl's Fleet Evolution tab.

Where the 50 app repos named in ios-apps.md are now:

| Location | Count | Evidence |
|---|---|---|
| GitHub `Diomandeee/<Name>` (private) | 50 of 50 | `gh repo list`, 303 repos total on the account |
| Drive/GCS archive `Fleet-Backup/mac1/2026-10-18/Desktop/<Name>.tar.zst` | 48 of 50 | `~/.fleet-backup/manifest.tsv`, status ok |
| Foundry library catalog r3 (GCS `foundry-library-pilot-648527652351`) | 48 of 50 | `~/Developer/Foundry-Library/catalogs/r3/catalog.json`, 585 entries |
| Mac1 disk | 3 (Spore, PrintWorlds, TeleprompterPro) | the other ~570 Desktop/Developer folders were archived and deleted 10-18 to 10-21 |

FeedDeck and FleetCommand never had a source directory (ios-apps.md already says so); they exist only as GitHub repos. OpenClawKit is in the library with no delivered source.

Size: all 50 repos together are 53 MB on GitHub (largest, Ledger, 4.3 MB). Last pushes: 35 in April, 13 in June, 2 in March. They are dormant. The 2026-05-17 triage (`portfolio-final-keepers-2026-05-17.md`) kept only MFP as Apple work and dropped FirstDate, Pebble, BWB, Cali Lights, LinkIt, Serenity Soother, Creator Shield.

Beyond the 50 iOS apps, the account holds about 250 other repos (BWB, Coltivare, MotionMix, MotionMixApp, MeshControl, Comp-Core with its 25 sub-apps, lume-commerce, nko-*, Koatji, Milk Men, Serenity, MFP, chain-* and so on). "All of our apps" is that whole set, not 70. A first registry pass should cover 303 GitHub repos plus the 585 library entries, de-duplicated by origin.

Draft registry for the 50 iOS apps: `docs/app-fleet/registry-draft-2026-10-22.csv` (name, bundle, GitHub size, last push, archive path, library presence).

## 2. What Foundry can hold today

Verified in `lockfix` source and by `wrangler artifacts repos list` (read-only):

- A base is a Cloudflare Artifacts git repo in namespace `foundry-staging`. There is no production namespace yet.
- Seeding is manual, one repo at a time: `wrangler artifacts repos create <name>`, then `FOUNDRY_SEED=<name> ~/.config/foundry/bin/foundry-push <name> main:main`, then `tools/subscribe-repo.sh staging <name>`, then add the name to `tools/foundry-audit/base-ref-audit.py` `EXTRA_REPOS` (hard-coded list, line 22).
- 16 repos exist: 2 real bases (`airdeck`, `nko-speech`), 7 spike bases, 7 forks.
- The gate is text-only, 8 MiB per merge, fatal on non-UTF-8 files. A seed push bypasses the gate, so binaries can enter at seed time but can never be changed through a gated task afterwards.
- Identity: wrangler OAuth as Mohamed (scopes verified present today: workers, d1, queues, artifacts). It has silently dropped scopes before and only Mohamed can re-login.
- There is no app registry, no batch tool, no archive tier for bases, no binary sidecar convention. Storage tiers are documented (hot = local, index = Supabase, cold = `gs://fleet-backup-648527652351`, media = Drive MotionMix-Central) but nothing maps a library entry to a base or says when a base goes cold.

## 3. Lane A: app fleet into Foundry

Goal: every app is addressable in Foundry with one identity, one tier, one owner, and a path to run a gated task on it. Order:

A1. **Registry as a gated artifact, not a Supabase table that can be deleted again.** `fleet/apps.v1.json` in the `foundry` base (so changes go through the gate and the audit). One record per app: `id`, `title`, `kind` (ios, web, service, monorepo-sub-app, library), `origin` (GitHub URL), `bundle_id`, `asc_app_id`, `library_id` (catalog r3 id), `archive` (Drive/GCS tar path + md5 from manifest.tsv), `tier` (hot | warm | cold), `owner_lane`, `allowed_roots`, `binary_policy` (exclude globs or Drive bundle), `foundry_base` (name or null). Seed it from: ios-apps.md (59), gh-repos (303), catalog r3 (585), manifest.tsv (434), keepers doc for tier defaults. Index copy into Supabase Memory `fleet_apps` for querying, but the file is the authority.

A2. **Batch onboarding tool** `tools/app-fleet/onboard.py`: reads the registry, for each record with `tier != cold` and `foundry_base == null`: clone from GitHub into a scratch dir, run the binary lint (`snapshot_policy.py` rules: 4 MiB per file, UTF-8), move offenders to a Drive bundle + `fetch-assets.sh` stub, `repos create`, `FOUNDRY_SEED` push, subscribe, write back `foundry_base`, append to the audit list (make `EXTRA_REPOS` read the registry instead of a hard-coded list). Dry-run mode prints the plan; no network without `--apply`. Receipts per repo in `receipts/app-fleet/<name>.json`.

A3. **Tier defaults.** Hot: the keepers plus everything with a push in the last 60 days (AirDeck, MotionMix, MotionMixApp, Fabric, bwb-site, Coltivare, nko-speech, SharedServices, foundry, Comp-Core, lume-commerce, MotionMix-Ableton). Warm: MFP, Spore, Aura, CreativeDirector, SecuriClaw, SpeakFlow, NKo apps. Cold: the other ~40 scaffold apps and the ~200 non-app repos. Cold apps still get a registry record, a library id and an archive md5, but no base until someone opens a task on them. Seeding all 50 iOS apps as bases anyway is cheap (53 MB) if Mohamed wants them visible in Foundry on day one; the registry makes that a flag flip.

A4. **Comp-Core sub-apps.** 25 apps inside one monorepo (`apps/ios`, `apps/web`, `apps/trajectory`...). They get registry records with `origin = Comp-Core#apps/<path>` and ride on one base with `allowed_roots` per sub-app, not 25 bases.

A5. **Production namespace.** The whole fleet should not be seeded into `foundry-staging` and then moved. Decide the namespace name first (`foundry-fleet` or activate `foundry` production per the R7 hold) and seed once.

A6. **Dry run done 2026-10-22 ~04:10Z** (`tools/app-fleet/onboard.py --tiers hot,warm`, receipts in `receipts/app-fleet/*.dry-run.json`, no network writes): 48 of 49 hot+warm repos are plannable (SkateForge's GitHub repo is empty). 40 carry binaries that must go to a Drive bundle before seeding (bwb-site 511 files / 86 MB, lume-commerce 3,368 files / 1.6 GB, meaning-full-power 802 / 2.2 GB, spore 142 / 279 MB, motionmixapp 112 / 249 MB, comp-core 198 / 244 MB). 24 exceed the 8 MiB text cap for a single gated merge (seed bypasses it, later merges will not, so those repos need `allowed_roots` narrowed per task). `homebase` is the home directory itself on GitHub (19,436 files) and must be excluded from Foundry, not seeded. The 50 scaffold iOS apps are all small (largest 4.3 MB) and seed clean.

A7. **Seeding started 2026-10-22 17:25Z** (lane defaults after Mohamed re-sent the three questions: namespace `foundry-staging`, scaffold portfolio first; MotionMix family left to fleet-supervisor-plan). Rules agreed with the supervisor: one orphan text-only commit per base, binaries and >4 MiB files stripped into `.foundry/assets.json` pointing at the GitHub origin sha, `FOUNDRY-SEED.md` in the tree, subscribe per base, never push onto a base that already exists, repos over 2,000 text files skipped (gate limit M7: milk-men-, agent-orchestrator, lume-commerce, uctm-harness, comp-core, meshcontrol, foundry, bwb). Batch 1: 51 scaffold iOS apps seeded, 0 errors (receipts `receipts/app-fleet/seed.*.json`, registry commit 3d81a58). Batch 2 (42 hot/warm repos) launched 18:40Z. Batch 3 = the remaining cold repos.

Blockers that need Mohamed: none for A1 and the dry run. A2 `--apply` needs the wrangler OAuth to still hold `artifacts` (it does today) and the namespace decision in A5.

## 3b. App Store Connect as the reverse source, and the OpenClaw renames

Mohamed (04:40Z): connect App Store Connect, "reverse everything" from what is on the store, and change the names that carry OpenClaw.

Pulled 2026-10-22 ~04:50Z with the existing API key (`tools/app-fleet/asc_sync.py`, GET only; key id in `~/.appstoreconnect/config`, App Manager role, verified in March as GET/PATCH but no app-record CREATE):

- **80 app records** on the account. **None is on the App Store and none is in review.** Across every version of every app the states are: 45 prepare-for-submission, 20 rejected, 15 developer-rejected. The fleet reached TestFlight (builds exist on all but one record) and stopped there.
- 56 of 80 carry OpenClaw in the bundle id or name. 15 localizations carry it in the display name itself: Anvil, Arbor, Beacon, BodyBeat, Cipher, Flux, Helix, NKoScribe, Nimbus, Prism, Quill, Rune, Torrent, Wren (all "— OpenClaw") plus VisionClaw AI.
- Joined onto the registry by bundle id with an alias map: 84 registry records now carry `asc_app_id`, `asc_name`, `asc_store_versions`, `asc_latest_build` (a few ASC apps match two checkouts, e.g. the two Coltivare dirs). 3 ASC apps have no repo anywhere: LineSkip City, ParkSight City, NKo Bridge. Output: `docs/app-fleet/asc.v1.json`.
- Not in ASC at all: only Meridian and Morph (Fleet 3) have no app record; every other fleet app does. 7 ASC apps match two registry records each (a GitHub repo plus its library-only or second-checkout twin); the registry keeps both until the dedupe pass.
- Rename dry run (`asc_rename.py`, no suffix): 14 localizations go from "<Name> — OpenClaw" to the bare name, all under the 30-character limit. VisionClaw AI is left alone (the name is the product, and the repo is a fork of someone else's project). Receipt: `receipts/app-fleet/asc-rename.dry-run.json`.

What "reverse" means in practice: the registry's `asc_*` fields are the truth for name, bundle id, SKU, build history and review state. ios-apps.md and the memory notes become history.

What can be renamed:

| Thing | Changeable? | How |
|---|---|---|
| Display name, subtitle | Yes | `tools/app-fleet/asc_rename.py` PATCHes `appInfoLocalizations`; dry run written, `--apply` needs Mohamed's words |
| Bundle id (`com.openclaw.*`) | No, immutable once a build was uploaded (all have builds) | only a new app record + new bundle id; the key cannot create records (web UI), and nothing is live so there is nothing to migrate users from |
| SKU | No | same |
| GitHub repo names (OpenClawHub, OpenClawKit, OpenClawSDK, OpenClawPayments) | Yes | `gh repo rename`, old names redirect |
| Code: the `OpenClawKit` SPM package every Bloom app imports, `com.openclaw` in `project.yml` | Yes, but it is a code change per repo | through Foundry gate tasks once the repos are bases |

Constraint: App Store names are unique store-wide. The bare words (Anvil, Prism, Flux, Helix, Nimbus, Quill, Rune, Torrent, Wren, Cipher, Arbor, Beacon) are almost certainly taken, which is why "— OpenClaw" was appended. The rename needs a replacement brand word; `asc_rename.py --suffix "<brand>"` builds the proposals and the apply step records any 409 name-taken result per app. Mohamed chooses the brand word.

**Done 2026-10-22 16:00Z-16:20Z on Mohamed's "we need to change all of that and remove it":**
- ASC display names: bare names were refused by Apple with `DUPLICATE.DIFFERENT_ACCOUNT` (another account owns Anvil, Prism, Flux and the rest), so 13 apps are now "<Name> by Diomande" (BodyBeat, Anvil, Wren, Torrent, Rune, Quill, Prism, Nimbus, Helix, Flux, Cipher, Beacon, Arbor) and NKoScribe is the bare "NKoScribe". The suffix was the lane's choice, consistent with the `com.diomande.*` bundle ids; one command swaps it. Receipts: `receipts/app-fleet/asc-rename.*.json`.
- ASC text fields: Command Hub description rewritten ("OpenClaw Hub" to "Command Hub") and support URL repointed; BodyBeat marketing and support URLs moved off `openclaw.com` to bufbarista.com and the BodyBeat repo. VisionClaw AI untouched. No other ASC description, keyword, promo text or URL carries the word.
- GitHub repos renamed with redirects: OpenClawKit to DiomandeKit, OpenClawSDK to DiomandeSDK, OpenClawPayments to DiomandePayments, OpenClawHub to CommandHub. Old clone URLs keep working.

**What cannot be removed on the existing records:** 56 bundle ids (`com.openclaw.*`, plus `com.openclaw.MotionMixApp` with its 90 TestFlight builds and `com.openclaw.AirDeck`). Apple fixes the bundle id at the first build upload. Removing it means a new app record with a new bundle id, created in the ASC web UI (this key cannot create records), and for MotionMixApp a fresh TestFlight history. Nothing is live, so there are no users to migrate; it is a cost in your time per app, not a migration. Recommendation: leave bundle ids as they are for the 50 scaffold apps, and open new records only for apps that will actually ship (MotionMixApp, AirDeck, Spore, MFP, Coltivare already use non-OpenClaw ids except the first two).

**What remains, and is code work through Foundry:** every Bloom app imports the `OpenClawKit` SPM package by URL and name, and local checkouts carry it too (MotionMixApp 33 files, Spore 22, PrintWorlds 9, Coltivare 8, TeleprompterPro 8, AirDeck 5, SharedServices 3; identifiers `OpenClawKit`, `OpenClawHub`, `OpenClawCore`, `OpenClawSupabase`, `openclaw-ios-bootstrap.sh`). The package rename (DiomandeKit, matching the repo) is one gated task per repo once the repos are Foundry bases, which is lane A2. On GitHub, 49 of the 52 fleet app repos carry OpenClaw in `project.yml` (the kit dependency and the bundle id); only kinetic-theater and trajectory-search do not. Per-repo counts: `receipts/app-fleet/openclaw-code-refs.json`.

Security note for lane C: the ASC private key `.p8` sits in three agent-readable places (`~/.appstoreconnect/private_keys`, `~/private_keys`, `~/.openclaw/vault/keys`). Logged in the rotation ledger; it can PATCH every app's metadata.

## 4. Lane B: files off the Macs

Measured 2026-10-22:

| Mac | Data volume | Used | Free | Home | Biggest items |
|---|---|---|---|---|---|
| Mac1 | 460 GiB | 395 GiB (95%) | 23 GiB | 264 GB: Library 71 (App Support 31, Developer 11), Developer 33, Desktop 16, Documents 12 (Codex 11), `.local` 14 (muse 6, opencode 3), `.claude` 13 (prompt-logs 7), `.lume` 11, `.git` 7 (homebase), `.codex` 7, `.cache` 7, `.rustup` 5, `.openclaw` 5 | Developer/MotionMix 12 GB, ai-memory-runtime 10 GB, Comp-Core 8 GB, BWB 3 GB; Desktop is mostly transcript/tiktok-frame leftovers. Outside home: `/private/var/folders` 21 GB (temp caches), `/opt/homebrew` 21, System 31, Applications 13, usr 10. Accounted: 383 of 395 GiB. |
| Mac4 | 460 GiB | 417 GiB (97%) | 17 GiB | 271 GB | `~/sa3_motionmix` 79 GB, Developer 55 GB (lume-commerce 17, nko-encoder-pilot 15, nko-ablation 9, MotionMix 8), `~/comp-core-data` 19 GB, `.cache` 18 GB, Library 13, `uctm-fork-target-internal` 12, Downloads 11, `.codex` 9, `.lume` 8, `mac1-offload` 6, Applications 31 |
| Mac5 | 460 GiB | 382 GiB (91%) | 41 GiB | 273 GB: Library 52 (App Support 24), `.cache` 35, Developer 33, `sa3_motionmix` 29, Downloads 21, Pictures 16, `motionmix-stable-audio-coreai-stage` 13, `nko-v3` 10, `.colima` 10, MotionMixData 7, projects 6, archived-offloads 6, MotionMixBuilds 5, `.ollama` 4 | Developer/MotionMix-mac1-snapshot 11 GB, MotionMix 9, nko-bench 4, mo-tts-local 4. Externals: HD2 210/231 GiB (MotionMixLanding 54, mac1-root-relocations 35, cold-archive 21, hf-cache 15, dance-lesson-ingestion 15, MotionMix 15, MotionMix-archive 12, Mac4-offload-20261020 11), HD5 52/58 GiB (MotionMix.gitdir 27, codex 14), FoundryBuild 67/931 GiB (405 free) |

No local APFS snapshots on Mac1 or Mac4, so the numbers are real files. Mac5's FoundryBuild volume has 405 GiB free; it is a local staging disk, not a home for files (Mohamed's rule is cloud storage), but it can hold tar+md5 bundles while they upload.

Rule Mohamed set: nothing lives only on a Mac. Every folder gets one of four fates, recorded in the same registry (`fleet/storage.v1.json`, one record per folder per Mac):

1. **Code with a remote**: verify `git status` clean and pushed (the 10-19 Section B method: unpushed work to `backup/<date>/<mac>/` branches), then delete the local checkout unless it is hot. Hot checkouts stay, but they are reproducible from GitHub + Foundry.
2. **Data** (captures, datasets, model weights, renders: `sa3_motionmix`, `comp-core-data`, `nko-*` training dirs, `MotionMixData`): md5 manifest, `rclone copy` to Drive (media) or `gsutil` to the cold bucket, verify remote md5, then delete local. The 10-18 fleet backup script already does the tar+md5+verify loop; reuse it with a data-folder allowlist.
3. **Caches and build products** (`.cache`, `.codex` session dirs, `.lume`, `DerivedData`, `Library/Caches`, Downloads): delete after a 7-day listing is posted for Mohamed to veto.
4. **Unknown**: listed, not touched, until classified.

Deletions need Mohamed's words per batch. The ledger for this lane is `docs/STORAGE-2026-10-22.md` (append-only, same style as the rotation ledger).

Target after lane B: Mac1 and Mac4 under 60% used, every surviving folder with a remote or a verified cold copy.

## 5. Lane C: security, at the end

Open from the review and the rotation, in the order they should close:

1. participation-coordinator C1 kill switch (commit 8901867) still not deployed; the public hole is live.
2. Daemon 1.4 rollout to Mac5/Mac1/Mac4 (phone approvals + Mac5 FDA re-grant).
3. Provider key deletions at dashboards: Gemini #dbb5f9 (now also in Comp-Core GitHub history), fal, W&B, Ollama, Together, ElevenLabs old keys; Vast key + instance 56197013; TrajectoryOS Supabase service key before any unpause; Comp-Core unclassified values (Supabase PAT, DB password, PyPI, Cloudinary).
4. BWB Prisma string via computer use; `vercel login`; row 8 logins; Cloudflare token; SSH phase 3; F9 Mac4 root LaunchDaemon.
5. H2 bearers out of `~`, gate-only base tokens, H10, M5, H11.
6. Comp-Core pre-push hook (f7 holding until Mohamed approves): `--not --remotes` scope plus glob pathspecs for every `.env`.
7. **F12 (2026-10-22 20:30Z): the first seeder copied secret files into 18 bases.** Found by the supervisor's `tools/app-fleet/base-secret-scan.py`; fixed in `onboard.py` 8778e5a (name + content rules, path and rule only in `.foundry/assets.json`); batch 3 restarted on the fixed code; the 17 seed-only bases with hits deleted and reseeded. Every exposed value was tested from its GitHub origin (ledger 20:30Z): LIVE and for Mohamed's batch: a Supabase service_role key for project `wovknbcvxjvayfdflxkn` (milkmendelivery; the project belongs to neither known Supabase account), the Gemini key already deferred, and a Google key (`milkmendelivery`, `dlm`, `cc-trajectory`; Places answers 403, restricted not proven dead). Dead: BWB legacy JWTs, both OpenAI keys. Low: birthday-pass CSR key. False positives: jeli-nko, the .npmrc and .env placeholders. GitHub-side cleanup (the same values sit in those private repos' history) is rotation, not history rewriting.

**Mohamed's batch (console or spend, needs him present):** Supabase account for `wovknbcvxjvayfdflxkn` (disable legacy JWT keys), Gemini key delete at AI Studio, Google key `#8e4ac6` delete at Cloud console, the row 5 provider deletions, Vast key + instance 56197013, BWB Prisma string, `vercel login`, Hugging Face re-login (unblocks deleting the 48 GB of HF caches on Mac4/Mac5), the Mac5 reboot test (SonoBus reconnect), and the data-dir deletions listed in `docs/STORAGE-2026-10-22.md` (now reproducible from GCS: Mac4 30 GB, Mac5 33 GB, HD2 69 GB when its job verifies).

## 6. State at 2026-10-23 00:45Z (lane closed) and what happens next

Done: registry (290 records with a Foundry base), every seedable repo seeded into `foundry-staging` on the secret-withholding seeder and scanned clean, OpenClaw removed where Apple and GitHub allow, caches cleared on all three Macs, every archive job verified in the cold bucket (Mac4 30 GB, Mac5 33 GB, HD2 69 GB, MotionMixData batch 2 ~9 GB on all three Macs, sa3_motionmix recipes on Mac4 and Mac5), ledgers and receipts committed on fix/lockfile-sync-20261020. Nothing but caches and temp was deleted.

Lane closed 2026-10-23 00:45Z by session 6c with Mohamed away. Every deletion in `docs/STORAGE-2026-10-22.md` waits for his own words: first the sa3 audio (118 GB, `~/.fleet-backup/sa3_delete_audio.sh` on Mac4 and Mac5, refuses without `APPROVED=`), then the archived local copies (132 GB + batch 2). Disks at close: Mac1 33 GB free, Mac4 12 GB (its Developer tree grew 55 to 71 GB during the evening, owner unknown to this lane), Mac5 45 GB. `docs/app-fleet/apps.v1.json` carries an uncommitted write-back for participation-coordinator from the lanetest lane; left for that lane to commit.

Next, in order:
1. Mohamed's batch (§5): the live service_role key for `wovknbcvxjvayfdflxkn`, Gemini and Google key deletes, the exo AWS key id, provider leftovers, Hugging Face re-login, then the data-dir deletions in `docs/STORAGE-2026-10-22.md` (Mac4 30 GB, Mac5 33 GB, HD2 69 GB once verified).
2. Owner lanes name live subtrees for uctm-harness and meshcontrol (`seed_paths`); HyEvo seeded from a tarball.
3. The registry moves from lockfix docs into the `foundry` base through the gate, and `fleet_apps` lands in Supabase Memory as an index.
4. Per-repo gate tasks: the `DiomandeKit` package rename across the 49 Bloom apps, then real work.
5. Next storage batches: Mac1 Library/Application Support 31 GB and `.local`/`.claude`/`.lume` state, Mac4 `uctm-fork-target-internal` and Downloads, Mac5 Downloads and Pictures, each with an owner check like f7's.
