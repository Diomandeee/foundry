use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::Write;
use std::path::Path;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Metrics {
    pub lines_read: u64,
    pub malformed_json: u64,
    pub envelopes_consumed: u64,
    pub envelopes_skipped_cursor: u64,
    pub envelopes_without_seq: u64,
    pub flow_cards_built: u64,
    pub flow_cards_written: u64,
    pub flow_cards_skipped_existing: u64,
    pub cursor_seq: u64,
    pub last_date: Option<String>,
}

impl Metrics {
    pub fn render_prometheus(&self) -> String {
        let mut out = String::new();
        out.push_str("# HELP trajectory_ledgerd_lines_read_total Event lines read.\n");
        out.push_str("# TYPE trajectory_ledgerd_lines_read_total counter\n");
        out.push_str(&format!(
            "trajectory_ledgerd_lines_read_total {}\n",
            self.lines_read
        ));
        out.push_str("# TYPE trajectory_ledgerd_malformed_json_total counter\n");
        out.push_str(&format!(
            "trajectory_ledgerd_malformed_json_total {}\n",
            self.malformed_json
        ));
        out.push_str("# TYPE trajectory_ledgerd_envelopes_consumed_total counter\n");
        out.push_str(&format!(
            "trajectory_ledgerd_envelopes_consumed_total {}\n",
            self.envelopes_consumed
        ));
        out.push_str("# TYPE trajectory_ledgerd_envelopes_skipped_cursor_total counter\n");
        out.push_str(&format!(
            "trajectory_ledgerd_envelopes_skipped_cursor_total {}\n",
            self.envelopes_skipped_cursor
        ));
        out.push_str("# TYPE trajectory_ledgerd_envelopes_without_seq_total counter\n");
        out.push_str(&format!(
            "trajectory_ledgerd_envelopes_without_seq_total {}\n",
            self.envelopes_without_seq
        ));
        out.push_str("# TYPE trajectory_ledgerd_flow_cards_built_total counter\n");
        out.push_str(&format!(
            "trajectory_ledgerd_flow_cards_built_total {}\n",
            self.flow_cards_built
        ));
        out.push_str("# TYPE trajectory_ledgerd_flow_cards_written_total counter\n");
        out.push_str(&format!(
            "trajectory_ledgerd_flow_cards_written_total {}\n",
            self.flow_cards_written
        ));
        out.push_str("# TYPE trajectory_ledgerd_flow_cards_skipped_existing_total counter\n");
        out.push_str(&format!(
            "trajectory_ledgerd_flow_cards_skipped_existing_total {}\n",
            self.flow_cards_skipped_existing
        ));
        out.push_str("# TYPE trajectory_ledgerd_cursor_seq gauge\n");
        out.push_str(&format!(
            "trajectory_ledgerd_cursor_seq {}\n",
            self.cursor_seq
        ));
        if let Some(date) = &self.last_date {
            out.push_str(&format!(
                "trajectory_ledgerd_last_date_info{{date=\"{}\"}} 1\n",
                date
            ));
        }
        out
    }

    pub fn write_prometheus(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("create metrics dir {}", parent.display()))?;
        }
        let tmp = path.with_extension("tmp");
        let mut file =
            File::create(&tmp).with_context(|| format!("create metrics tmp {}", tmp.display()))?;
        file.write_all(self.render_prometheus().as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)
            .with_context(|| format!("rename metrics {} -> {}", tmp.display(), path.display()))?;
        Ok(())
    }
}
