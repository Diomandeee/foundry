//! orchestratord — headless pane orchestrator daemon.
//!
//! Replaces the Python pane orchestrator (controller.py) with a Rust binary.
//! 5-phase heartbeat loop (sense→select→mutate→check→adapt) that dispatches
//! work through meshd HTTP endpoints across the mesh. No AppleScript, no
//! Terminal.app dependency.
//!
//! Config: ~/.orchestratord/orchestratord.toml
//! API:    http://0.0.0.0:<port>/health | /status | /autopilot

mod autopilot;
mod backlog;
mod config;
mod dispatch;
mod heartbeat;
mod http;
mod state;

use anyhow::Result;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::RwLock;

use config::Config;
use dispatch::Dispatcher;
use heartbeat::HeartbeatLoop;
use state::OrchestratorState;

#[tokio::main]
async fn main() -> Result<()> {
    // Init tracing
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "orchestratord=info".into()),
        )
        .init();

    // Load config
    let config_path = std::env::args()
        .nth(1)
        .map(std::path::PathBuf::from)
        .unwrap_or_else(Config::default_path);

    let config = Config::load(&config_path)?;
    tracing::info!(
        port = config.api_port,
        interval = config.interval_secs,
        nodes = config.mesh_nodes.len(),
        "orchestratord starting"
    );

    // Build shared state
    let orch_state = Arc::new(RwLock::new(OrchestratorState::new(
        config.interval_secs as f64,
    )));

    // Build dispatcher
    let dispatcher = Arc::new(Dispatcher::new(config.clone()));

    // Shutdown channel
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);

    // Signal handler
    let tx_signal = shutdown_tx.clone();
    tokio::spawn(async move {
        tokio::signal::ctrl_c().await.ok();
        tracing::info!("received SIGINT, shutting down");
        tx_signal.send(true).ok();
    });

    // SIGTERM handler (for launchd)
    #[cfg(unix)]
    {
        let tx_term = shutdown_tx.clone();
        tokio::spawn(async move {
            let mut sigterm =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("failed to register SIGTERM");
            sigterm.recv().await;
            tracing::info!("received SIGTERM, shutting down");
            tx_term.send(true).ok();
        });
    }

    // Start heartbeat loop in background
    let hb_config = config.clone();
    let hb_state = orch_state.clone();
    let hb_dispatcher = dispatcher.clone();
    let hb_shutdown = shutdown_rx.clone();
    tokio::spawn(async move {
        let mut hb = HeartbeatLoop::new(hb_config, hb_state, hb_dispatcher);
        hb.run(hb_shutdown).await;
    });

    // HTTP server
    let app_state = http::AppState {
        orchestrator: orch_state.clone(),
        config: config.clone(),
    };
    let app = http::router(app_state);

    let addr = format!("0.0.0.0:{}", config.api_port);
    let listener = TcpListener::bind(&addr).await?;
    tracing::info!(addr = %addr, "HTTP server listening");

    // Run HTTP server with graceful shutdown
    let mut shutdown_for_http = shutdown_rx.clone();
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            shutdown_for_http.changed().await.ok();
        })
        .await?;

    tracing::info!("orchestratord stopped");
    Ok(())
}
