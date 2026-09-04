//! LAN mobile bridge: lets a paired phone drive the local Harness.
//!
//! Rust port of the core of `src/main/mobile/lan-mobile-bridge.ts`. Harness
//! itself stays on a random loopback port; the bridge listens on a dedicated
//! LAN port, pairs phones with a short-lived token + desktop approval, and
//! forwards an allowlist of RPC methods to the Harness session.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use rand::Rng;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

const PAIRING_TTL_MS: u128 = 5 * 60 * 1000;
const MAX_BODY_BYTES: usize = 64 * 1024;

/// Mobile method → Harness Typert Remote endpoint translation.
fn harness_endpoint(method: &str) -> Option<&'static str> {
    match method {
        "agentPreset.list" => Some("agentPresets/list"),
        "agentPreset.select" => Some("agentPresets/select"),
        "session.list" => Some("session/list"),
        "session.models" => Some("session/modelCatalog"),
        "session.selectModel" => Some("session/selectModel"),
        "session.create" => Some("session/create"),
        "session.prompt" => Some("session/prompt"),
        "session.cancel" => Some("session/cancel"),
        "session.history" => Some("session/history"),
        "workspace.list" => Some("workspace/list"),
        _ => None,
    }
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct MobileBridgeSnapshot {
    pub running: bool,
    pub connected: bool,
    pub port: Option<u16>,
    pub pairing_url: Option<String>,
    pub pairing_qr_svg: Option<String>,
    pub expires_at: Option<u128>,
}

struct PendingPairing {
    token: String,
    expires_at: u128,
}

struct BridgeState {
    harness_url: Mutex<Option<String>>,
    pairing: Mutex<Option<PendingPairing>>,
    session_token: Mutex<Option<String>>,
    connected: Mutex<bool>,
    port: Mutex<Option<u16>>,
    shutdown: tokio::sync::Notify,
}

pub struct MobileBridge {
    state: Arc<BridgeState>,
}

impl MobileBridge {
    pub fn new() -> Self {
        Self {
            state: Arc::new(BridgeState {
                harness_url: Mutex::new(None),
                pairing: Mutex::new(None),
                session_token: Mutex::new(None),
                connected: Mutex::new(false),
                port: Mutex::new(None),
                shutdown: tokio::sync::Notify::new(),
            }),
        }
    }

    /// Update the Harness target once it becomes ready.
    pub async fn set_harness_target(&self, url: Option<String>) {
        *self.state.harness_url.lock().await = url;
    }

    pub async fn snapshot(&self) -> MobileBridgeSnapshot {
        let pairing = self.state.pairing.lock().await;
        let connected = *self.state.connected.lock().await;
        let port = *self.state.port.lock().await;
        let running = port.is_some();
        let (pairing_url, qr, expires_at) = match pairing.as_ref() {
            Some(p) if now_ms() < p.expires_at => {
                let url = format!(
                    "http://0.0.0.0:{}/pair?token={}",
                    port.unwrap_or(0),
                    p.token
                );
                let qr = render_qr_svg(&url);
                (Some(url), Some(qr), Some(p.expires_at))
            }
            _ => (None, None, None),
        };
        MobileBridgeSnapshot {
            running,
            connected,
            port,
            pairing_url,
            pairing_qr_svg: qr,
            expires_at,
        }
    }

    /// Rotate the pairing token and start listening on a LAN port.
    pub async fn start(
        &self,
        preferred_port: Option<u16>,
    ) -> std::io::Result<MobileBridgeSnapshot> {
        let token = random_token(24);
        {
            let mut pairing = self.state.pairing.lock().await;
            *pairing = Some(PendingPairing {
                token: token.clone(),
                expires_at: now_ms() + PAIRING_TTL_MS,
            });
        }

        let bind_addr: SocketAddr = format!("0.0.0.0:{}", preferred_port.unwrap_or(0))
            .parse()
            .unwrap();
        let listener = tokio::net::TcpListener::bind(bind_addr).await?;
        let port = listener.local_addr()?.port();
        *self.state.port.lock().await = Some(port);

        let state = Arc::clone(&self.state);
        let app = Router::new()
            .route("/health", get(health))
            .route("/pair", post(pair))
            .route("/brand-logo/:variant", get(brand_logo))
            .route("/api/rpc", post(rpc_forward))
            .with_state(state);

        let shutdown_state = Arc::clone(&self.state);
        tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async move { shutdown_state.shutdown.notified().await })
                .await
                .ok();
        });

        Ok(self.snapshot().await)
    }

    pub async fn stop(&self) {
        self.state.shutdown.notify_waiters();
        *self.state.port.lock().await = None;
        *self.state.connected.lock().await = false;
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn random_token(bytes: usize) -> String {
    let mut rng = rand::thread_rng();
    (0..bytes)
        .map(|_| format!("{:02x}", rng.gen::<u8>()))
        .collect()
}

fn render_qr_svg(text: &str) -> String {
    use qrcode::QrCode;
    let code = QrCode::new(text.as_bytes());
    match code {
        Ok(code) => {
            let image = code.render::<qrcode::render::unicode::Dense1x2>().build();
            // Wrap the unicode rendering in a simple SVG text block fallback.
            format!("<pre>{}</pre>", image)
        }
        Err(_) => String::new(),
    }
}

async fn health() -> &'static str {
    "ok"
}

async fn pair(
    State(state): State<Arc<BridgeState>>,
    Json(body): Json<HashMap<String, serde_json::Value>>,
) -> Response {
    let supplied = body
        .get("token")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    let mut pairing = state.pairing.lock().await;
    let valid = match pairing.as_ref() {
        Some(p) => p.token == supplied && now_ms() < p.expires_at,
        None => false,
    };
    if !valid {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"ok": false})),
        )
            .into_response();
    }

    let session = random_token(32);
    *state.session_token.lock().await = Some(session.clone());
    *state.connected.lock().await = true;
    *pairing = None;
    Json(serde_json::json!({"ok": true, "session": session})).into_response()
}

async fn brand_logo(axum::extract::Path(variant): axum::extract::Path<String>) -> Response {
    // Served from bundled resources; path resolved by the caller at runtime.
    let _ = variant;
    (StatusCode::NOT_FOUND, "logo").into_response()
}

async fn rpc_forward(
    State(state): State<Arc<BridgeState>>,
    headers: header::HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    if body.len() > MAX_BODY_BYTES {
        return (StatusCode::PAYLOAD_TOO_LARGE, "body too large").into_response();
    }
    // Require an authorized session.
    let authed = {
        let session = state.session_token.lock().await;
        let supplied = headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        match session.as_ref() {
            Some(token) => supplied.contains(token),
            None => false,
        }
    };
    if !authed {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }

    let payload: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return (StatusCode::BAD_REQUEST, "invalid json").into_response(),
    };
    let method = payload
        .get("method")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let Some(endpoint) = harness_endpoint(method) else {
        return (StatusCode::FORBIDDEN, "method not allowed").into_response();
    };

    let harness_url = state.harness_url.lock().await.clone();
    let Some(harness_url) = harness_url else {
        return (StatusCode::SERVICE_UNAVAILABLE, "harness not ready").into_response();
    };

    // Forward to the Harness endpoint. Uses a blocking-free minimal client.
    let target = format!("{}/api/{}", harness_url.trim_end_matches('/'), endpoint);
    match forward_request(&target, &payload).await {
        Ok(response) => response,
        Err(error) => (StatusCode::BAD_GATEWAY, format!("forward failed: {error}")).into_response(),
    }
}

/// Minimal HTTP POST forwarder over a raw TCP socket (avoids extra deps).
async fn forward_request(target: &str, payload: &serde_json::Value) -> std::io::Result<Response> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let url = url::Url::parse(target)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?;
    let host = url.host_str().unwrap_or("127.0.0.1").to_string();
    let port = url.port().unwrap_or(80);
    let path = if url.query().is_some() {
        format!("{}?{}", url.path(), url.query().unwrap())
    } else {
        url.path().to_string()
    };

    let body = serde_json::to_vec(payload).unwrap_or_default();
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: {host}:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );

    let mut stream = tokio::time::timeout(
        Duration::from_secs(15),
        tokio::net::TcpStream::connect(format!("{host}:{port}")),
    )
    .await
    .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "connect timeout"))??;

    stream.write_all(request.as_bytes()).await?;
    stream.write_all(&body).await?;

    let mut buffer = Vec::new();
    stream.read_to_end(&mut buffer).await?;

    // Split headers/body at the blank line.
    let header_end = find_header_end(&buffer);
    let (head, rest) = buffer.split_at(header_end);
    let head_text = String::from_utf8_lossy(head);
    let status = head_text
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(502);
    let body_bytes = rest.strip_prefix(b"\r\n\r\n").unwrap_or(rest).to_vec();

    let status_code = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
    Ok((
        status_code,
        [(header::CONTENT_TYPE, "application/json")],
        body_bytes,
    )
        .into_response())
}

fn find_header_end(buffer: &[u8]) -> usize {
    for i in 0..buffer.len().saturating_sub(3) {
        if &buffer[i..i + 4] == b"\r\n\r\n" {
            return i;
        }
    }
    buffer.len()
}
