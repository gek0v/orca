use clap::Parser;
use orcad::{Server, ServerConfig};
use std::path::PathBuf;
use std::time::Duration;

#[derive(Parser, Debug)]
#[command(name = "orcad", version = "1.4.214", about = "Orca execution daemon")]
struct Cli {
    #[arg(long, help = "Named pipe path (Windows)")]
    pipe: Option<String>,

    #[arg(long, help = "Unix domain socket path (Unix)")]
    socket: Option<String>,

    #[arg(long, default_value = "30", help = "Idle timeout in seconds")]
    idle_timeout: u64,

    #[arg(long, help = "Path to last-status.json file")]
    status_path: Option<PathBuf>,

    #[arg(long, default_value = "orcad-native", help = "Runtime ID")]
    runtime_id: String,

    #[arg(long, help = "Port (compatibility)")]
    port: Option<u16>,

    #[arg(long, help = "JSON output (compatibility)")]
    json: bool,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let cli = Cli::parse();

    let endpoint = if cfg!(windows) {
        cli.pipe
            .unwrap_or_else(|| format!(r"\\.\pipe\orcad-default-{}", std::process::id()))
    } else {
        cli.socket
            .unwrap_or_else(|| format!("/tmp/orcad-default-{}.sock", std::process::id()))
    };

    let status_path = cli.status_path.unwrap_or_else(|| {
        std::env::temp_dir().join(format!("orcad-status-{}.json", std::process::id()))
    });

    let config = ServerConfig {
        endpoint: endpoint.clone(),
        idle_timeout: Duration::from_secs(cli.idle_timeout),
        status_path,
        runtime_id: cli.runtime_id,
    };

    tracing::info!("Starting orcad daemon on endpoint: {}", endpoint);
    let server = Server::start_with_config(config).await?;

    if cli.json {
        let port = cli.port.unwrap_or(0);
        let ready_payload = serde_json::json!({
            "type": "orca_server_ready",
            "advertisedEndpoint": format!("ipc://{}", endpoint),
            "pairing": {
                "url": format!("http://127.0.0.1:{}/?code=orcad-{}", port, std::process::id())
            }
        });
        println!("{}", serde_json::to_string(&ready_payload)?);
    }

    let mut shutdown_rx = server.subscribe_shutdown();
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            tracing::info!("Received Ctrl+C, shutting down orcad daemon cleanly...");
        }
        _ = shutdown_rx.recv() => {
            tracing::info!("Received idle exit signal, shutting down orcad daemon cleanly...");
        }
    }
    server.shutdown().await?;

    Ok(())
}
