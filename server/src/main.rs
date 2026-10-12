use nas_sync_server::{Config, app};
#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("Server startup failed: {error}");
        std::process::exit(1)
    }
}
async fn run() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let config = Config {
        data: std::env::var("NAS_SYNC_DATA")?.into(),
        database_url: std::env::var("DATABASE_URL")?,
        admin_token: std::env::var("NAS_SYNC_ADMIN_TOKEN")?,
        max_file_bytes: std::env::var("NAS_SYNC_MAX_FILE_BYTES")
            .unwrap_or_else(|_| "52428800".into())
            .parse()?,
    };
    let port = std::env::var("NAS_SYNC_PORT")
        .unwrap_or_else(|_| "8080".into())
        .parse::<u16>()?;
    let router = app(config).await?;
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::UNSPECIFIED, port)).await?;
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let mut terminate =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("SIGTERM handler");
            tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
        })
        .await?;
    Ok(())
}
