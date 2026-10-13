# Intake bar (2026-10-07)

A module enters Foundry only when it clears all five. No partial credit,
no docs-only inclusions.

1. **Local-only** — runs on K11/Mac hardware. No new SaaS, database, or app.
2. **No overlap** — does something parcels + LKG + FTS don't already do,
   or replaces one with measured proof.
3. **Evidence-compatible** — every answer carries recoverable pointers
   (id, source, strategy) the claim gate can re-check.
4. **Fail-open and cheap** — degrades silently, adds no gate-path latency,
   needs no GPU or API spend.
5. **Proven live** — a test showing it answers correctly. The 8-query
   parcel eval is the reference harness.

## Verdicts

| Module | Verdict | Grounds |
|---|---|---|
| Evidence recovery (`@foundry/evidence`) | IN | The read path: ticket/decision/triple/memory legs + claim gate. 6/6 tests. |
| Orbit coordination | FOLD (pending) | Live "who's doing what" has no overlap; must be rebuilt with zero dead-endpoint deps. |
| Orbit retrieval | OUT (subsumed) | K11 parcels cover the corpus; survives only as a trajectory-coordinate ranker if it beats BM25 on the eval. |
| cc-retrieval | OUT (wrong domain) | MotionPhrase motor programs for a Conductor, not text retrieval. Name-only match; nothing to port. |
| TurboQuant | HOLD | Generic packed-code vector search, local and clean — but no Tier A corpus needs it yet. Enters when vectors exceed ~100k or brute-force p95 exceeds ~500ms, within 2pp recall of exact. Silent sidecar, no API change. |
| Vault-mcp | EXTRACT, not adopt | Obsidian dependency fails #1. The backlink/neighbor/orphan graph logic is ported vault-less over K11 markdown as the notes-graph. |
| Retrieval-indexer | OUT (subsumed) | K11 FTS supersedes. Re-enters only with true incremental updates beating the weekly full rebuild. |
| RAG++ backend | OUT (blocked) | Supabase project dead. Re-enters only with a local vector backend + measured win on semantic queries. |
| Context-intelligence | HOLD (unfundable) | Needs Gemini/Claude API spend; budget is $0.11. Design-compatible later. |
| Idea-vault | OUT (adjacent) | Idea lifecycle, not Foundry core. May feed the board later. |

## Correction log

- 2026-10-07: cc-retrieval first marked "port phrase logic" from the
  filename. Reading the source showed `phrase.rs` is MotionPhrase v1
  (motor programs). Verdict corrected to OUT. Filenames are not evidence.
