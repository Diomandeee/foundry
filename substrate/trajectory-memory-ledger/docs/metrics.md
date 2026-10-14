# Metrics

`trajectory-ledgerd` exports Prometheus text metrics when `--metrics` is provided.

Example:

```text
trajectory_ledgerd_lines_read_total 4
trajectory_ledgerd_malformed_json_total 0
trajectory_ledgerd_envelopes_consumed_total 4
trajectory_ledgerd_envelopes_skipped_cursor_total 0
trajectory_ledgerd_envelopes_without_seq_total 0
trajectory_ledgerd_flow_cards_built_total 1
trajectory_ledgerd_flow_cards_written_total 1
trajectory_ledgerd_flow_cards_skipped_existing_total 0
trajectory_ledgerd_cursor_seq 4
trajectory_ledgerd_last_date_info{date="2026-06-03"} 1
```

Use these metrics to detect:

- malformed gateway lines
- cursor drops
- duplicate card skips
- whether new flow cards are actually being written
- date rollover behavior

