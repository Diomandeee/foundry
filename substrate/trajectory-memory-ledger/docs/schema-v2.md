# Schema V2

Schema v2 is the canonical JSONL record format for the Trajectory Memory Ledger. Each line is one normalized trajectory record.

## Top-Level Fields

```json
{
  "schema_version": 2,
  "id": "stable-record-id",
  "session_id": "session-or-flow-id",
  "source": "aura-gateway-flow",
  "channel": "flow",
  "domain": "mesh-orchestration",
  "skill": {"name": "flow:morning_brief", "domain": "mesh-orchestration"},
  "context": {},
  "trajectory": {},
  "outcome": {},
  "timing": {}
}
```

Required normalized fields:

- `schema_version`: currently `2`
- `source`: data source, for example `aura-gateway-flow`, `verbose-all`, or `archive-*`
- `channel`: `flow`, `backfill`, or another explicit channel
- `domain`: project/domain label
- `skill`: object with `name` and `domain`
- `context.prompt_text`: task prompt when available
- `trajectory.events`: canonical event list
- `trajectory.tool_sequence`: tool names, same length as `trajectory.events`
- `trajectory.total_tools`: total recovered tool slots
- `outcome.annotation_status`: `scored` or `pending`

## Event Shape

```json
{
  "tool_name": "Bash",
  "key_params": {"command": "cargo test"},
  "success": true,
  "exit_code": 0,
  "duration_ms": 1200,
  "ts": "2026-06-03T00:00:00Z"
}
```

Tool names are normalized into a common vocabulary. For example, `exec_command`, `shell_command`, and `run_shell_command` become `Bash`; `apply_patch` becomes `Edit`.

## Placeholder Events

Historical logs sometimes know that `total_tools` was larger than the retained event payload list. Schema v2 preserves length consistency by adding explicit placeholder events:

```json
{
  "tool_name": "unknown",
  "key_params": {},
  "success": null,
  "placeholder": true
}
```

This keeps `events`, `tool_sequence`, and `total_tools` consistent while separating observed events from recovered tool slots:

- `observed_event_count`
- `placeholder_event_count`
- `events_truncated`

