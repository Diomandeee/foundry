use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{self, File};
use std::io::Write;
use std::path::Path;

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct CursorState {
    pub date: Option<String>,
    pub seq: u64,
}

pub fn read_cursor(path: &Path) -> Result<CursorState> {
    if !path.exists() {
        return Ok(CursorState::default());
    }
    let raw =
        fs::read_to_string(path).with_context(|| format!("read cursor {}", path.display()))?;
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(CursorState::default());
    }
    if raw.starts_with('{') {
        let parsed: Value = serde_json::from_str(raw)
            .with_context(|| format!("parse cursor JSON {}", path.display()))?;
        return Ok(CursorState {
            date: parsed
                .get("date")
                .and_then(Value::as_str)
                .map(str::to_string),
            seq: parsed.get("seq").and_then(Value::as_u64).unwrap_or(0),
        });
    }
    Ok(CursorState {
        date: None,
        seq: raw.parse::<u64>().unwrap_or(0),
    })
}

pub fn write_cursor(path: &Path, date: &str, seq: u64) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create cursor dir {}", parent.display()))?;
    }
    let tmp = path.with_extension("tmp");
    let mut file =
        File::create(&tmp).with_context(|| format!("create cursor tmp {}", tmp.display()))?;
    serde_json::to_writer(
        &mut file,
        &CursorState {
            date: Some(date.to_string()),
            seq,
        },
    )
    .with_context(|| format!("write cursor JSON {}", tmp.display()))?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    drop(file);
    fs::rename(&tmp, path)
        .with_context(|| format!("rename cursor {} -> {}", tmp.display(), path.display()))?;
    Ok(())
}

pub fn cursor_consumed(cursor: &CursorState, date: &str, seq: u64) -> bool {
    cursor.date.as_deref() == Some(date) && seq <= cursor.seq
}
