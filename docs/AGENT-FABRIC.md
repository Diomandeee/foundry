# The agent fabric: Claude Code as the harness, UCTM absorbed, Foundry underneath

Status: design, 2026-10-20 evening. Nothing deployed. Supersedes the morning draft of this
file. Written from a read of the actual code and state: Claude Code hooks and mesh lanes on
Mac1, `~/.codex/hooks`, the Canonical registry (292 entities), UCTM Studio and its docs,
`~/Documents/UCTM` (master plan, spine, program map), meshd, fleet-dispatch, pane-awareness,
and Foundry's workers.

## 0. Decisions

1. **Claude Code is the harness.** Every machine runs Claude Code; it is the only agent runtime
   we need. Codex, Muse and UCTM Studio are downstream: a Codex session is a lane like any other,
   Muse is the phone relay into a lane, UCTM Studio is a read-only window.
2. **Identity is a durable entity, never a terminal.** Canonical had this right. We keep its
   model (entity, project, objective, gate, role, receipt) and fix the two things that made it
   unusable: identity was welded to the harness session id, and the guard blocked unassigned
   work instead of warning.
3. **What UCTM built gets absorbed as hooks, not run as a daemon.** The orientation packet,
   evidence graph, hash-chained ledger, handoff packet + validator, authority classes and recall
   grants all run inside Claude Code's hook events. The AO daemon stays retired.
4. **Sub-work has five tiers and one scheduler.** Inline, subagent, isolated subagent, child
   lane, Foundry job. A child lane is queued when the machine is full. The scheduler is a script,
   not a model.
5. **Restart is a reconciler.** A per-machine registry says which lanes should exist; a login
   agent recreates each one by resuming its Claude session into a tmux session named after the
   entity. tmux-resurrect (never saved once) is dropped.
6. **Foundry is the shared record.** Lanes, claims and the mailbox live in Foundry; handoffs and
   transcripts in Supabase Memory; gate decisions stay the receipt for code.

## 1. Names

UCTM = User-Conditioned Trajectory Model, the learning program. Its **spine** is the
non-learned control kernel (authority gate, budget enforcer, hash-chained ledger, version
registry, holdout guard; 770 lines of stdlib Python in `~/Documents/UCTM/uctm-spine`).
**Canonical** is the identity/assignment/authority layer under it (`~/.codex/hooks/canonical-entity`,
registry `Desktop/Canonical/mesh/registry.json`). The thing remembered as the "Codex Graph
Kernel" is two artifacts: **cc-graph-kernel** (Comp-Core, open-sourced as `admissibility-kernel`,
newest packaging `live-knowledge-graphs`): deterministic context slices with an HMAC
admissibility token; and the **UCTM evidence kernel** (`uctm-orient.mjs`, `uctm-graph.mjs`):
a content-addressed graph of documents, sessions, artifacts, code and tests with `--check`
("nothing moved, stop reading") and `--impact <file>` ("who must re-read").

The 15 UCTM invariants (master plan §6) are the rules this design keeps. The ones that bite
here: capability is not permission; selection is not execution; tool completion is not success;
receipts before claims; no raw-history replication between sessions; no self-crowning.

## 2. Identity

### Entity

```
eid        = <harness>-<slug>            claude-foundry, claude-airdeck, codex-nko-ops
child eid  = <parent eid>/<slug>         claude-airdeck/ipad-sync
```

The slug is chosen by whoever creates the lane (Mohamed or the head) and never changes. The
machine is NOT in the EID: a lane is bound to a machine by the rule "process where the data
lives", but that binding is an attribute, and it can move.

An entity record (one row, kept in the per-machine registry and mirrored to Foundry):

```
eid, harness, parent_eid?, machine, cwd, repo, branch?,
assignment {project, objective, gate_handle, role, lane_id},
attachment {tmux_session, claude_session_id, pid?, tty?, name?},   # current
session_history [{claude_session_id, from, to}],                   # all past attachments
status: queued|active|idle|waiting|blocked|parked|ended,
budget {model_tier, max_subagents, token_budget?}, heartbeat_seq, heartbeat_at,
last_handoff_ref, created_by
```

Today four naming schemes coexist with no shared key (tmux `agent-*` names, screen quadrants,
`<machine>:<session8>` lane ids, Canonical's Codex-only tmux names). All four become derived
views of `eid`: `tmux_session = eid` with `/` → `.`, the Claude session name = eid, the mesh
rollup keys on eid, quadrant is a display attribute.

### Canonical, fixed

Canonical's data model stays (12 roles, objectives with ordered gates, `gate://` handles, gate
receipts, `RESULT.json` with a mandatory progress delta, typed messages in a file bus, a 6 h
runtime lease). Five changes make it the identity layer for a Claude-first fleet:

| Problem (verified) | Change |
|---|---|
| `resolve_eid` = first 8 hex of the harness session id; a restart mints a new unassigned entity (`claude_runtime.py:306`, rebinding refused at `canonical_mesh.py:723`) | EID minted from the slug; `session_history[]`; SessionStart binds by a per-cwd pin file or `CANONICAL_EID`, then appends the new session id. `:723` and `:1541` accept "current session in history" |
| Unassigned research entities are denied every "protected" call with `no_exact_current_assignment_gate` (`authorize_scope` `:660-688`); it denied this lane's own read-only `ls` of the Canonical folder today | Unassigned = allow with a warning line, except writes to shared Canonical state and other entities' packets. Fail closed only for assigned entities acting outside their role |
| Bash is "protected" whenever the text contains `Canonical` or a repo path and is not one simple command; pipes, `&&`, quotes, `python3`, `node` all count as mutation (`:49-62`, `:486-547`) | Parse per pipeline segment; `python3/node` mutate only when argv writes a governed path; read chains pass |
| Assignment needs a live head whose own gate is current; the only live head covers one learned-harness objective; `register` itself is denied to the unassigned caller (circular) | One always-on local head service per machine (`service-canonical-local-head` generalized), default `head_eid` for new objectives; CLI `canonical assign` (head-checked, clear error) and `canonical claim-next` (a research entity asks for the next gate of its role) |
| Deny messages are opaque; bus lives under `~/.codex` | Deny names the missing field and the fix command; bus and registry move to `~/.canonical`, `~/.codex` paths become symlinks |

Current registry: 292 entities (165 claude, 125 codex), 35 with a gate assigned, 250 lanes
`unassigned`, 2 heads (one stale since July). This lane is `claude-041267dc`, unassigned.

## 3. Lanes, sub-lanes and where work runs

A **lane** is an entity with a mission and a terminal. Mohamed talks to lanes; lanes talk to
each other. The question "Air Deck needs another lane inside Air Deck: queue it, subagent,
cheaper model, cloud?" has one answer table:

| Tier | Use when | Identity | Model | Limit | Survives parent restart |
|---|---|---|---|---|---|
| T0 inline | minutes, needs the parent's context | none | parent's | – | n/a |
| T1 subagent (`Agent`) | bounded, parallel, reports back; search, sweep, review | none (tracked by spawn-tracker) | Sonnet by default; top tier only for judgment on protected files | fleet gauge 8 in flight | no |
| T2 isolated subagent (`Agent` + worktree, or `fork`) | edits code that must not touch the parent's tree | none | as T1 | counts in the 8 | no |
| T3 child lane | > ~1 h, needs its own inbox, must outlive the parent's compaction, or a different machine | `parent/slug` entity, own tmux + Claude session | by budget field | per-machine `max_lanes` (Mac1 4, Mac4 2 when LUME idle, Mac5 2 when not performing, VM 2) | yes, via the reconciler |
| T4 Foundry job | builds, tests, batch; output must be verified | Foundry task + `agent_id = eid` | none (compute) | compute authority leases, $ budget | yes (durable job) |

Rules that follow from the invariants: a subagent never gets its own authority (it inherits the
parent's assignment and can only propose); a child lane gets its own assignment from the head;
a Foundry job is "selection, not execution" until its verifier accepts bytes. Open-source or
local models are not an agent tier: they are tools a lane may call (Ollama on Mac5 exists), never
a runtime that holds a lane.

### The scheduler

A child-lane request is a registry row with `status: queued` plus a handoff packet (the
mission). `lane-sched` (a script run by the head service every 30 s and on demand) starts the
oldest queued lane whose machine has a free slot, respecting the LUME/performance rules; it
never starts a lane whose parent is `ended`. Account rate-limit fallback (claude-max → pro1 →
pro2, today buried in `mesh_inject`) moves here. Claude's own usage limits are a budget input:
when a lane hits its limit it goes `waiting`, not dead, and the scheduler does not start more.

## 4. Restart

What survives a reboot today: transcripts, the Canonical registry, meshd's slot config, the
`main` tmux session. What is lost: every running agent, every pane, every Claude session name.
tmux-resurrect is configured but `~/.tmux/resurrect/` has never been written.

The reconciler (`com.canonical.lane-reconciler`, at login, then every 5 min):

1. read the machine's registry rows with `status in (active, idle, waiting)`;
2. for each: `tmux new-session -d -s <eid>` if absent, then
   `claude --resume <attachment.claude_session_id>` inside it, with the entity's cwd;
3. the SessionStart hook sees the pin file, binds the (same or new) session id to the EID,
   appends history, injects the last valid handoff packet for the objective, and heartbeats;
4. a lane whose `claude_session_id` cannot be resumed (transcript gone) restarts from its last
   handoff packet, status `parked` → `active`, with a receipt saying so.

Canonical's `canonical-tmux restore --max 8` already does step 2 for Codex entities; it is
generalized rather than replaced. The 8 cap becomes the machine's `max_lanes`. meshd stops
spawning agents (its slots never map to an entity); it stays only as the cross-machine
inject/relay transport until the Foundry mailbox replaces it, with its failing Supabase heartbeat
fixed or removed.

What a restarted lane knows: its assignment, the next gate from `derive_gate`, the last handoff
packet (validated, so every evidence pointer exists), pending typed messages, and the lane
digest. It does not know what was in flight at the crash. That is by design: the Stop and
PreCompact hooks write the packet, so the loss is bounded to one turn.

## 5. What Claude Code absorbs from UCTM, as hooks

Same four roles on every machine, same code for Claude and (downstream) Codex, whose hook
engine exposes the same events.

| Hook | Event | Absorbs | From |
|---|---|---|---|
| register | SessionStart | bind EID, heartbeat, inject assignment + next gate + pending messages + lane digest; run `uctm-orient --check` and inject the ≤8 KB orientation card ("exit 0: read nothing") | Canonical, mesh-lanes, AO-F4 |
| guard | PreToolUse | Canonical scope check (fixed as in §2); spine authority classes (external_effect and authority_change always need a human gate receipt; reuse Foundry `gate-ts`, the TS port of cc-kernel's 12 rules); claims check before writing a shared path; recall grant check wrapping memory tools | spine `authority_gate.py`, claims board, RECALL_ENFORCEMENT |
| settle | Stop (one atomic pipeline, deduped by flock) | truth-claim guard; append a hash-chained receipt (`sha256(prev + canonical_json)`); run `uctm-graph --impact` on files edited this turn and surface readers; validate and write the handoff packet when parking or when the turn ends without a gate receipt ("a turn without a valid packet is a failed turn"); record `RESULT.json`; Outcome Governor decides CONTINUE | atomic-continuation, spine ledger, AO-F5, STATELESS-DEEPSEEK, Canonical |
| close | SessionEnd | final packet, lane status, release claims and lease | Canonical |

Handoff packet = UCTM `handoff-packet.schema.json` unchanged (`continuity_assumed=false`,
evidence items of claim + artifact that must exist, `still_false`, `open_questions`,
`next_prompt`, `stop_condition`); validator R1-R5 ported from `bridge/validate_handoff.py`.
Park, absorb and pane-converge emit this one format.

Not absorbed: the DeepSeek proxy, the Rust supervisor's chat UI, the seven UCTM projection
routes that return 204 (program, evaluations, adjudication: never had data), factory-collect
(never ran live). The cc-graph-kernel slice service stays a service (:8001 + Postgres); only
its client is wired in, behind a recall grant.

Hook diet that comes with it: the current UserPromptSubmit chain is ~13 hooks (nine
behavior-intel routers at ≤10 s each, prompt-logger 30 s, foundry-memory 20 s). It becomes one
mux with a 2 s budget. Unwired packages (general auto-continue, post-compact,
compact-intelligence, claim-guard, stall-detector, permission-broker, mesh-inbox, task-learner,
the registry layer) are deleted or deliberately wired.

## 6. Messages

Same-machine: `SendMessage(to=<eid>)` as today, with the name now equal to the EID so the
rollup and the address agree without a join. Cross-machine: Foundry mailbox
(`agent.message.v1`: id, from, to, kind info|request|handoff|alert, body, task_id?,
requires_ack, sent_at), delivered by the recipient's next hook run; meshd relay until then.
Typed Canonical messages (assignment, completion, …) ride the same channel. A message is never
authority; reading is not acknowledging.

## 7. Foundry

- `lanes` table (DO + D1) = the registry mirror; `/lanes` read API; `POST /tasks` writes the
  lane row and uses `agent_id = eid`, so tickets, decisions, transcripts (`sessions.harness` +
  session id) and lanes share one key.
- `claims` table with the UCTM board semantics (TTL, heartbeat, second arriver verifies).
- mailbox (§6).
- Supabase Memory: `handoffs` (packet v1) and `receipts` (the chained ledger entries);
  `memory_handoff` becomes write + read; the K11-only tools (`memory_session`,
  `memory_resume`, `orbit_record`) move to Supabase so every machine reads the same thing.
- Gate decisions stay the completion receipt for code; `RESULT.json` + gate receipt for
  everything else.

UCTM Studio = read-only observatory over `/lanes`, `/decisions`, `/handoffs` and Supabase.
`muse_relay.py` stays as the phone terminal (fix its duplicate respawn).

## 8. Rollout

Each phase needs Mohamed's go and ends with a check that it works.

| Phase | Builds | Done when |
|---|---|---|
| P0 | schemas (`contracts/agent/*.json`: entity, lane, message, claim, handoff v1), validator port, tests | validator accepts the 84 valid park packets and flags the known-invalid ones |
| P1 | Canonical fixes (§2); `~/.canonical`; local head service on Mac1; `assign` / `claim-next` | this lane assigned by the head, no false denials for 24 h, a restart keeps the EID |
| P2 | registry + reconciler on Mac1; EID-named tmux + Claude sessions; rollup keyed on EID | kill tmux, log out, log in: the four Mac1 lanes come back on their objectives |
| P3 | the four hooks (orientation card, ledger, handoff gate, impact), prompt mux | p95 UserPromptSubmit < 2 s; every turn ends with a receipt or a valid packet |
| P4 | scheduler + tiers; child-lane queue; Foundry `lanes` mirror + `/lanes` | Air Deck spawns a child lane that queues on a full Mac5 and starts when a slot frees |
| P5 | Mac4, Mac5, VM reconcilers; Codex hook parity; cross-machine mailbox | a message from Mac1 reaches a Mac5 lane; a Codex lane shows in the fleet rollup |
| P6 | claims in Foundry; handoffs + receipts in Supabase; UCTM observatory | a park on Mac1 resumes on Mac5 from the stored packet; the observatory shows the fleet |
| P7 | stall ladder + weekly lookback on fleet data | a stalled lane gets an L1 nudge |
