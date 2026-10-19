# Decoder verification — 2026-10-16

Scope: only `packages/stacks-events/**` created/edited by this task. Existing dirty files preserved; no commits, network calls, installs, deployment, spending, secrets or host changes. Parent retains state/reorg/finality/dispatch ownership.

## RTD evidence

1. Structure: package manifest, early API.md, exported implementation and tests verified with `ls -la` at their exact requested paths.
2. Strict compilation: `npm run typecheck` at source root passed after final test changes.
3. Integration: `npx vitest run packages/stacks-events packages/epoch-inbox` passed 97 tests across 2 files: 68 decoder tests plus 29 existing inbox tests. Includes actual in-memory SQLite registration, decoded InboxEvent ingestion and equal-content duplicate admission.
4. Content: all three pinned primary-source SHA-256 values match manifest.json. Indexed block identities remain distinct from plain block hashes; all event tx IDs and the transaction block/height/parent join are verified. Required profile is documented in API.md. Advisory provider flags cannot establish finality. No Clarity evaluation/checksum/deployment/SPV claim.
5. Journey: synthetic observation → bounded descriptor snapshot → verified header/transaction/event → versioned inert payload → existing inbox. Negative fixtures exercise aborted/pending/microblock observations, missing identity/schema fields, tampered join, incomplete/duplicate indexes, allowlisting, format and network policy, exact 64KiB raw boundary, depth/node limits, 4KiB hex/repr and escaped 16KiB payload bounds, active/non-JSON values, deterministic order and detached output.
6. Deployment: gated and not attempted. This decoder result does not complete the parent Stacks phase; no new full-suite result replaces the historical 505-test baseline.

## API and boundaries

Exports `decodeNakamotoBlock`, `DecodedNakamotoBlock`, `decodeContractLog`, `ContractLogPolicy`, `StacksDecodeError`. Parent imports from package `src/index.ts` or the package export. Runtime package resolution/lockfile enrollment remains parent-owned because this task may write only its package directory.

Uniform upper/lower external hash policy is explicit; all output IDs lowercase/unprefixed. Contract validation checks format/network prefix only. Extra raw response properties are bounded JSON data, discarded from selected payload; the required decoder profile is narrower than full Hiro response-schema conformance. Nonselected recognized event variants receive identity/index/type checks, not asset-body interpretation. JS Proxies are outside the passive JSON trust boundary; descriptor inspection rejects accessors without invoking them. No live-chain fixture or cryptographic proof is claimed.

Parent integration hardening after initial worker report: mutable canonical/microblock flags are now validated but excluded from immutable event content. A flag-only update is not equivocation. Added regression; original 68-test candidate count above is historical, and parent final suite supersedes it.
