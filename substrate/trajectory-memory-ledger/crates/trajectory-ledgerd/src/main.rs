use anyhow::Result;
use clap::{Parser, Subcommand};
use std::path::PathBuf;
use trajectory_ledgerd::ingest::{run_loop, run_once, LedgerConfig};

#[derive(Debug, Parser)]
#[command(name = "trajectory-ledgerd")]
#[command(about = "Rust daemon for the Trajectory Memory Ledger")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Consume aura gateway event files and append scored schema-v2 trajectory cards.
    Run {
        #[arg(long, default_value = "./events")]
        events_dir: String,
        #[arg(long, default_value = "./trajectory-ledgerd.cursor")]
        cursor: String,
        #[arg(long, default_value = "./trajectories.jsonl")]
        store: String,
        #[arg(long)]
        metrics: Option<String>,
        #[arg(long)]
        date: Option<String>,
        #[arg(long, default_value_t = 1000)]
        poll_ms: u64,
        #[arg(long)]
        once: bool,
    },
}

fn expand_tilde(path: &str) -> PathBuf {
    if path == "~" {
        return dirs_home();
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return dirs_home().join(rest);
    }
    PathBuf::from(path)
}

fn dirs_home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Run {
            events_dir,
            cursor,
            store,
            metrics,
            date,
            poll_ms,
            once,
        } => {
            let config = LedgerConfig {
                events_dir: expand_tilde(&events_dir),
                cursor_path: expand_tilde(&cursor),
                store_path: expand_tilde(&store),
                metrics_path: metrics.as_deref().map(expand_tilde),
                date,
                poll_ms,
                once,
            };
            if once {
                let metrics = run_once(&config)?;
                println!("{}", serde_json::to_string_pretty(&metrics)?);
            } else {
                run_loop(config)?;
            }
        }
    }
    Ok(())
}
