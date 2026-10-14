use anyhow::{Context, Result};
use fs2::FileExt;
use serde_json::Value;
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;

pub fn load_existing_ids(path: &Path) -> Result<BTreeSet<String>> {
    let mut ids = BTreeSet::new();
    if !path.exists() {
        return Ok(ids);
    }
    let file = File::open(path).with_context(|| format!("open store {}", path.display()))?;
    for line in BufReader::new(file).lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(record) = serde_json::from_str::<Value>(&line) {
            if let Some(id) = record.get("id").and_then(Value::as_str) {
                ids.insert(id.to_string());
            }
        }
    }
    Ok(ids)
}

pub fn append_jsonl_locked(path: &Path, record: &Value) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create store dir {}", parent.display()))?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .with_context(|| format!("open append store {}", path.display()))?;
    file.lock_exclusive()
        .with_context(|| format!("lock store {}", path.display()))?;
    let result = (|| -> Result<()> {
        serde_json::to_writer(&mut file, record)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        Ok(())
    })();
    let unlock = file
        .unlock()
        .with_context(|| format!("unlock store {}", path.display()));
    result.and(unlock)
}
