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

    #[arg(long, help = "Bind address (compatibility)")]
    bind: Option<String>,

    #[arg(long, help = "Pairing address (compatibility)")]
    pairing_address: Option<String>,

    #[arg(long, help = "Disable pairing (compatibility)")]
    no_pairing: bool,

    #[arg(long, help = "Mobile pairing (compatibility)")]
    mobile_pairing: bool,

    #[arg(long, help = "Recipe JSON (compatibility)")]
    recipe_json: bool,

    #[arg(long, help = "Project root (compatibility)")]
    project_root: Option<PathBuf>,

    #[arg(long, help = "Port to listen for agent hooks (HTTP)")]
    hook_port: Option<u16>,

    #[arg(long, help = "Authentication token for agent hooks")]
    hook_token: Option<String>,

    #[arg(long, help = "Path to write endpoint.json for agent hooks")]
    endpoint_file: Option<PathBuf>,
}

fn to_base64url(input: &[u8]) -> String {
    const CHARSET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    let mut i = 0;
    while i < input.len() {
        let b0 = input[i];
        let b1 = if i + 1 < input.len() { input[i + 1] } else { 0 };
        let b2 = if i + 2 < input.len() { input[i + 2] } else { 0 };

        out.push(CHARSET[(b0 >> 2) as usize] as char);
        out.push(CHARSET[(((b0 & 3) << 4) | (b1 >> 4)) as usize] as char);
        if i + 1 < input.len() {
            out.push(CHARSET[(((b1 & 15) << 2) | (b2 >> 6)) as usize] as char);
        }
        if i + 2 < input.len() {
            out.push(CHARSET[(b2 & 63) as usize] as char);
        }
        i += 3;
    }
    out
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let cli = Cli::parse();

    let endpoint = if cfg!(windows) {
        let p = cli.pipe.unwrap_or_else(|| r"\\.\pipe\orcad".to_string());
        if p.starts_with(r"\\.\pipe\") {
            p
        } else {
            format!(r"\\.\pipe\{}", p)
        }
    } else {
        cli.socket.unwrap_or_else(|| "/tmp/orcad.sock".to_string())
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

    if cli.hook_port.is_some() || cli.endpoint_file.is_some() || cli.hook_token.is_some() {
        let hook_token = cli
            .hook_token
            .unwrap_or_else(|| format!("orcad-token-{}", std::process::id()));
        let hook_port = cli.hook_port.unwrap_or(0);
        match orcad::HookServer::bind(
            server.status_store_arc(),
            hook_token,
            hook_port,
            cli.endpoint_file,
        )
        .await
        {
            Ok((hook_server, bound_port)) => {
                tracing::info!(
                    "Native HTTP hook server listening on 127.0.0.1:{}",
                    bound_port
                );
                tokio::spawn(hook_server.run());
            }
            Err(e) => {
                tracing::warn!("Failed to bind native hook server: {}", e);
            }
        }
    }

    if cli.json {
        let port = cli.port.unwrap_or(0);
        let pairing_offer = serde_json::json!({
            "v": 2,
            "endpoint": format!("http://127.0.0.1:{}", port),
            "deviceToken": format!("orcad-token-{}", std::process::id()),
            "publicKeyB64": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
        });
        let offer_bytes = serde_json::to_vec(&pairing_offer)?;
        let code = to_base64url(&offer_bytes);
        let ready_payload = serde_json::json!({
            "type": "orca_server_ready",
            "advertisedEndpoint": format!("ipc://{}", endpoint),
            "pairing": {
                "url": format!("http://127.0.0.1:{}/?code={}", port, code)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_to_base64url() {
        assert_eq!(to_base64url(b""), "");
        assert_eq!(to_base64url(b"f"), "Zg");
        assert_eq!(to_base64url(b"fo"), "Zm8");
        assert_eq!(to_base64url(b"foo"), "Zm9v");
        assert_eq!(to_base64url(b"foob"), "Zm9vYg");
        assert_eq!(to_base64url(b"fooba"), "Zm9vYmE");
        assert_eq!(to_base64url(b"foobar"), "Zm9vYmFy");
    }
}
