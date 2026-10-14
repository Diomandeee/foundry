# substrate/ — vendored upstream sources

Foundry stands on four existing systems. They are vendored here (not
submodules) so a clean clone builds and judges offline. Each keeps its own
README and license; nothing under `substrate/` is edited except by
re-vendoring from its source.

Nothing in `substrate/` is imported by Foundry's own build — it is reference
material and the authority for ports that live in `packages/`.

Vendored 2026-10-14. File lists verified identical to sources (diff -r).

| Dir | Source | License | Excluded |
|---|---|---|---|
| `cc-kernel/` | `Developer/Comp-Core-motionmix-revival-20260901/core/runtime/cc-kernel` — Rust admissibility kernel; the spec `packages/gate-ts` ports | MIT (declared in `Cargo.toml`) | — (full copy, 188K) |
| `live-knowledge-graphs/` | `Desktop/live-knowledge-graphs` — `cc-graph-kernel` (deterministic context slicer) + `python/` client + eval results | MIT (`LICENSE`) | `.git/` only |
| `trajectory-memory-ledger/` | `Desktop/trajectory-memory-ledger` — `trajectory-ledgerd` daemon + schema-v2 + docs | MIT (`LICENSE`) | `.git/`, `output/` (regenerable), `cache/`, `benchmarks/` (dated eval JSON) |
| `spatial-git/` | `Desktop/spatial-git` — 3D history view (`cli.js` + `index.html` + `git-to-json.sh`) | MIT (declared in `package.json`; text in `LICENSE-MIT`) | `.git/` |

How Foundry uses each:

- `cc-kernel/src/admissibility.rs` is the authority for
  `packages/gate-ts/src/gate.ts` (12 ordered rules). `cargo check --tests`
  is green (2026-10-14; two stale-test fixes: `ToolSchema` re-export,
  `MockSyscall::execute`); full `cargo test` runs in CI.
- `live-knowledge-graphs/crates/graph-kernel` is the authority behind
  `packages/lkg-client` (triple shapes in `src/triples.ts`).
- `trajectory-memory-ledger/examples/trajectory-card.schema-v2.json`
  is the schema the why-trail follows; `packages/evidence` is its
  standalone TS companion (unwired — see README layout).
- `spatial-git/` feeds `GET /history.json` (see `workers/api`);
  `web/` remains the Phase-3 board that renders it.
- `orchestratord` (headless pane-orchestrator daemon) is the pattern
  `workers/orchestrator/src/tasks.ts` follows — fork, ticket, scope,
  dispatch. **It is not vendored:** upstream declares no license, so its
  code is not redistributed in this MIT repository. The pattern is
  described in prose only.
