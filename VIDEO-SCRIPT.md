# Foundry — the demo video

The submitted demo is `out/foundry-demo-narrated.mp4`: **5:13** (313.3 s),
1920×1080, h264, with an AAC narration track. It lives in the video project
(`../foundry-video`), not in this repository, which holds the system the demo
shows.

Everything on screen is real output captured from the live system on 2026-10-14 —
the same verdict rows the staging board serves, the same test run the CI runs.
Terminal panels are rendered from captured output rather than recorded screen
pixels, because the desktop held private session windows.

Run the system yourself instead of watching it:

```bash
npm ci && npm run typecheck && npx vitest run
npx tsx tools/graphvc-demo.ts --root /tmp/foundry-demo   # fork → ticket → push → verdict, locally
```

To rebuild the video: `cd ../foundry-video && npx remotion render src/index.ts FoundryDemo out/foundry-demo.mp4`.

## Narration, beat by beat

| Time | Scene | Narration |
|---|---|---|
| 0:00 | Title plate — every push is reviewed before it lands | Foundry is a merge gate for teams of AI agents working on one codebase. Agents push freely to their own forks. Nothing reaches the shared branch unless a deterministic checker approves it — and every approval and refusal is written down with its reason, so you can always ask why a commit exists. |
| 0:21 | Problem plate — git push is a trust fall (human merges: 0) | When hundreds of agents share one codebase, a plain git push is a trust fall. You hope the agent started from the right commit, changed the right files, and didn't collide with anyone else. Hope is not a merge strategy. Foundry replaces trust with a gate that keeps score — and shows its work. |
| 0:42 | Flow animation — push → event → queue → gate → D1, then the five checks | Follow one push. The agent pushes to its own fork, so nothing is shared yet. That push fires an event, and a Cloudflare Queue delivers it to the gate worker. The gate loads the task ticket for that fork and diffs it against base in memory. Then five checks run in a fixed order: a ticket must exist, the diff must be non-empty, the fork point must be fresh, every file must sit inside the task's allowed paths, and no file may be changed on both sides. First failure wins, and it is recorded. Pass everything, and the gate merges the change itself, then writes the approval, the merge hash, and the file list into the database. Every commit on the shared branch points back to the decision that allowed it. |
| 1:30 | Chart — staging merges 7 · staging refusals 21 · production refusals 4 | Tonight's record, counted live from the database. Seven merges on staging. Twenty-one refusals on staging. Four refusals in production. The gate refuses more than it merges — that is the job. And every one of those refusals carries a reason, because a refusal you can read is a refusal you can act on. |
| 1:53 | Plate — no ticket, no merge (refused: 25) | Rule zero, and the whole film in one number. Twenty-five refusals across both environments. An unticketed push can never merge. That rejection is the feature, not the failure mode. |
| 2:08 | Verdict close-up — verdict 18, seed refused, reason recorded | Look at one up close. Verdict eighteen, on staging. Someone pushed to the seed repository. There is no task ticket for that fork, so the gate refused it — and wrote the commit hash, the timestamp, and the reason into the database. A rejection at two in the morning never needs an investigation, because it is already documented. |
| 2:32 | Agent card — agent-parser, parser/parse.ts, 6/6 | Tonight, three agents built a real project in parallel. First builder: the message parser. One file, six tests green, pushed to its own fork — and then it waited, because agents don't merge here. The gate does. |
| 2:50 | Agent card — agent-router, router/route.ts, 5/5 | Second builder: the lane router. Seventy-one insertions in a single file, five tests green. Fleet fan-out, status commands, and context attached to every route. Pushed to its fork. Same deal: nobody merges their own work. |
| 3:09 | Agent card — agent-overview, overview/digest.ts, 2/2 | Third builder: the digest formatter. Two tests green, one file. So that is three agents, three forks, and three pushes — with, at this point in the night, not a single line merged. That is the discipline. |
| 3:26 | Suite — 136 tests green · 19 files · 0 type errors | Behind every one of those merges stands the suite. One hundred thirty-six tests across nineteen files, zero type errors — and every test pushes through real git, not a mock. |
| 3:41 | Merge timeline — seed then three agent merges landing on base | Now watch the shared branch grow. The seed lands first: the contract and the tests. Then three merges arrive on base, one per agent — overview, parser, router. Each carries its verdict number. Each touched exactly one file. Each was judged independently, on its own diff. Three agents, three forks, three merges, zero human commits. Nobody touched base directly — and any one of those merges can be replayed, because each commit on base points back to the verdict that allowed it. |
| 4:16 | Live board — every decision, newest first, reason in the open | This is the human view: the live board. Every decision, newest first, green and red, with the reason in the open. It refreshes every five seconds — and the same rows are served as JSON, so a machine can read them too. |
| 4:33 | Rule cards — rules 0, 1 and 2 | Three rules run everything. Rule zero: no ticket, no merge. Rule one: fresh, scoped, non-empty — forks cut from current code, files inside the task's paths. Rule two: conflicts route with both sides attached, never merged silently and never dropped quietly. |
| 4:55 | Closing plate — deterministic core, receipts everywhere | The repo is on GitHub, MIT licensed, with run instructions a stranger can follow cold — and so is the dispatcher the agents built. Deterministic core, receipts everywhere. Every push is a proposal. Thank you. |
| 5:13 | end | |

The full script with per-scene windows is in `../foundry-video/VOICEOVER-SCRIPT.md`;
`../foundry-video/CUES.md` has the cue sheet and the submission checklist.
