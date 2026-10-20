# Agent fabric contracts

Schemas for `docs/AGENT-FABRIC.md`. All JSON Schema 2020-12, validated in
`packages/agent-fabric`.

| File | Record | Origin |
|---|---|---|
| `entity.schema.json` | `agent.entity.v1`: a lane's durable identity, assignment, current attachment and session history | Canonical entity + mesh lane record |
| `message.schema.json` | `agent.message.v1`: lane-to-lane message (same-machine delivery today, Foundry mailbox later) | mesh SendMessage + Canonical typed messages |
| `claim.schema.json` | `agent.claim.v1`: advisory path claim | UCTM claims board (`~/.ao/uctm-studio/data/claims/PROTOCOL.md`) |
| `handoff-packet.v1.schema.json` | the stateless handoff packet, copied verbatim from UCTM Studio `docs/uctm/handoff-packet.schema.json` | UCTM |

The handoff packet's semantic rules R1-R5 (artifacts must exist on disk, unknowns are
mandatory, "done" language without `still_false` is an OVERCLAIM) are not expressible in
JSON Schema; `packages/agent-fabric/src/handoff.ts` enforces them, behaviour-identical to
UCTM Studio `bridge/handoff/validate_handoff.py` (same violation strings). On 2026-10-20 that
engine passes 6 of the 84 packets in `bridge/parks/`: most are the older park shape without
`still_false`/`open_questions`, and many cite artifacts that no longer exist on disk.
