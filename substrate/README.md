# substrate/ — vendored upstream sources

Foundry stands on four existing systems. They are vendored here (not
submodules) so a clean clone builds and judges offline. Each keeps its own
README and license. The intent is that nothing under `substrate/` is edited
except by re-vendoring — the deviations from that intent are enumerated under
"Local modifications" below, so the rule and the reality are both on the page.

Nothing in `substrate/` is imported by Foundry's own build — it is reference
material and the authority for ports that live in `packages/`.

Vendored 2026-10-14. File lists were verified identical to sources (`diff -r`)
at that date. Four local patches have since been applied by hand — they are
listed under "Local modifications" below, and they are the only differences.
Nothing here pins an upstream *revision* (see "Provenance" below), which is the
open gap: a `diff -r` against a moving source cannot be reproduced later.

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

## Local modifications

The header above says vendored code is edited only by re-vendoring. In practice
Foundry holds four hand-edits, all of them ours, all of them here so a re-vendor
does not silently lose them. Each is marked `LOCAL PATCH` at the site.

| File | Date | Change | Why |
|---|---|---|---|
| `cc-kernel/src/types/scope.rs` | 2026-10-15 | `allows_path` canonicalises `.`/`..` before comparing, via a new private `canonicalize_path` | Upstream compared raw components, so `src/allowed/../secret.txt` — which resolves outside the root — was admitted. It also disagreed with the TypeScript port on `src//allowed/x` (Rust: allowed, TS: refused). Both sides now share one behaviour. |
| `cc-kernel/src/admissibility.rs`, `cc-kernel/src/functiongemma/*` | 2026-10-14 | Two stale-test fixes: `ToolSchema` re-export, `MockSyscall::execute` | Upstream had not been built against its own pinned deps; `cargo check --tests` did not compile. |
| `cc-kernel/Cargo.toml` | 2026-10-15 | `serde_json`, `async-trait`, `anyhow` added to `[dev-dependencies]` | An integration test links only against the crate plus its dev-dependencies. All three are already normal dependencies of the same crate, so `Cargo.lock` is unchanged. |
| `cc-kernel/tests/parity.rs` | 2026-10-15 | New file — Foundry's cross-language parity suite | Upstream has no shared case set. See `fixtures/kernel-parity.json`. |

`packages/` is not vendored and is not covered by this table.

## Provenance

Every row above records *where* a system came from and *when* it was copied. None
records *which revision* it was copied from: no upstream commit SHA, tag or
release is pinned for any of the four systems, and the sources live outside this
repository. That makes "the vendored copy equals the source" unverifiable later,
and makes any future re-vendor a manual diff against a moving target.

Recording a revision per system (and, where a port exists, asserting the port
against it) is tracked in `docs/INTEGRATION-STATUS.md` §8. Until then, treat the
`diff -r` note as a claim from the vendoring date, not as current evidence.
