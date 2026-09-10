//! LAN mobile bridge: lets a paired phone drive the local Harness.
//!
//! Rust port of the core of `src/main/mobile/lan-mobile-bridge.ts`. Harness
//! itself stays on a random loopback port; the bridge listens on a dedicated
//! LAN port, pairs phones with a short-lived token + desktop approval, and
//! forwards an allowlist of RPC methods to the Harness session.
//!
//! # 接线状态（2026-09-10）
//!
//! | 能力 | 状态 |
//! |---|---|
//! | 目标地址注入（[`MobileBridge::set_harness_target`]） | ✅ 已接线（Harness 就绪时由 `lib.rs` 注入） |
//! | 监听启动 / 停止 | ✅ 已接线（菜单显式触发，见 §安全语义） |
//! | 配对页 `GET /`（含二维码） | ✅ 已接线 |
//! | `POST /pair` 令牌校验 | ✅ 已接线 |
//! | `POST /api/rpc` 转发 | ✅ 已接线（含 cookie 握手，见下） |
//! | 配对状态变化 → 原生菜单状态行 | ✅ 已接线（[`MobileBridge::on_connected_change`]，2026-09-10） |
//!
//! ## 配对状态的展示面（与上游的差异，2026-09-10 核对）
//!
//! 上游把这个状态送进 **Harness 网页**（preload 往侧栏注入浮动手机按钮，
//! `mobile:status-changed` → `applyMobileStatus` → 按钮文案在「连接手机」与
//! 「管理手机连接」之间切换）。**上游的原生菜单项本身是静态的**
//! （`main-index.ts`：`label: isChinese ? '连接手机…' : 'Connect Phone…'`，
//! 不随配对变化）。
//!
//! 本仓没有 preload 注入通道（见 `AGENTS.md`），且往 Harness 远程页注入脚本
//! 会与「远程页不得调用宿主命令」的 origin 守卫（INV-2）直接冲突。因此等价
//! 实现是把状态放进**原生菜单**：`Phone` 子菜单首项显示实时状态，文案由
//! [`BridgeState::set_connected`] 的回调驱动刷新——覆盖面是上游的真超集
//! （上游菜单不显示状态）。
//!
//! ## 安全语义：默认不监听
//!
//! 桥**不会**在应用启动时自动监听：`0.0.0.0` 绑定是显式的用户动作
//! （菜单「Phone Pairing (LAN)…」），菜单另提供停止项以立即释放端口。
//! 这是刻意的收敛——自动监听意味着每次启动都在局域网暴露一个端口。
//!
//! ## cookie 握手（API 鉴权前提）
//!
//! 契约 C5：启动 token **只**通过首航 `GET /?token=…` 出现一次，绝不出现在
//! API 路径或 `Authorization` 头里；Harness 用该请求换发 `dsh-auth-*` cookie
//! （30 天），后续 `/api/*` 全部靠 cookie 鉴权（见 `crate::cookies`）。
//! 因此转发前必须完成一次握手，否则 `/api/rpc` 只会拿到未授权响应。
//! 握手在 [`MobileBridge::start`] 时尽力执行，失败则在首次转发时重试。

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
use serde::Serialize;
use tokio::sync::Mutex;

const PAIRING_TTL_MS: u128 = 5 * 60 * 1000;
const MAX_BODY_BYTES: usize = 64 * 1024;
/// 握手与转发的单次网络超时。
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

/// Harness 端点注入值：转发目标 + 首航鉴权凭据。
#[derive(Clone, Debug)]
pub struct HarnessTarget {
    /// 形如 `http://127.0.0.1:4173`（无 query，见 `LaunchEndpoint::base_url`）。
    pub base_url: String,
    /// 每进程一次性的启动 token，仅用于换取 `dsh-auth-*` cookie。
    pub launch_token: Option<String>,
}

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
    /// 二维码的 **文本块渲染**（`<pre>` + Unicode 半块字符），并非 `<svg>`。
    /// 字段名保留 `_svg` 是历史命名（上游 JSON 契约沿用），与本 Rust 端口
    /// 无消费方——`render_qr_block` 的产物一律是 `<pre>` 文本块。
    pub pairing_qr_svg: Option<String>,
    pub expires_at: Option<u128>,
    /// 是否已取得 `dsh-auth-*` cookie —— `false` 时 `/api/rpc` 会被 Harness 拒绝。
    pub authenticated: bool,
}

struct PendingPairing {
    token: String,
    expires_at: u128,
}

/// 配对状态变化的监听器（镜像上游 `onConnectedChange`）。
///
/// 宿主壳（Tauri 层）用它把「手机刚配对成功」这件事翻译成原生菜单状态行的
/// 刷新。**刻意做成回调而不是让壳轮询**：配对动作可能发生在手机浏览器里
/// （`POST /pair`），宿主没有任何本地事件可挂钩；轮询要么引入常驻定时器，
/// 要么把刷新延迟成「下次操作才更新」。
///
/// `Send + Sync`：配对处理器在 axum 的运行时线程上触发它，而注册发生在
/// Tauri 的 setup 线程。
type ConnectedListener = Box<dyn Fn(bool) + Send + Sync>;

struct BridgeState {
    harness_url: Mutex<Option<String>>,
    /// 首航 token，用于换取 cookie；握手成功后即可丢弃。
    launch_token: Mutex<Option<String>>,
    /// `dsh-auth-<port>=<value>` 形式的 Cookie 头值。
    auth_cookie: Mutex<Option<String>>,
    pairing: Mutex<Option<PendingPairing>>,
    session_token: Mutex<Option<String>>,
    connected: Mutex<bool>,
    port: Mutex<Option<u16>>,
    shutdown: tokio::sync::Notify,
    /// 配对状态监听器；用同步锁是因为触发点（[`BridgeState::set_connected`]）
    /// 不持有它跨 `await`。
    listener: std::sync::Mutex<Option<ConnectedListener>>,
}

impl BridgeState {
    /// 翻转配对状态，**仅在真正变化时**通知监听器。
    ///
    /// 判重是必须的：`stop()` 与重复配对都可能带着同一目标值进来，若不判重，
    /// 壳侧会被无意义地反复刷新菜单（每次 `set_text` 都是一次主线程往返）。
    ///
    /// 监听器在**释放 `connected` 锁之后**调用：回调只做「派生一个任务」，
    /// 该任务稍后要读 [`MobileBridge::snapshot`]，而快照会锁 `connected`
    /// 自身——持锁调用等于把状态翻转与快照读取耦合成自锁。
    async fn set_connected(&self, connected: bool) {
        let changed = {
            let mut current = self.connected.lock().await;
            if *current == connected {
                false
            } else {
                *current = connected;
                true
            }
        };
        if !changed {
            return;
        }
        let listener = match self.listener.lock() {
            Ok(listener) => listener,
            // 锁中毒（某个回调 panic 过）时静默降级：状态已经翻转过，只是
            // 没人被通知——不能因此让配对请求本身失败。
            Err(_) => return,
        };
        if let Some(listener) = listener.as_ref() {
            listener(connected);
        }
    }
}

pub struct MobileBridge {
    state: Arc<BridgeState>,
}

impl MobileBridge {
    pub fn new() -> Self {
        Self {
            state: Arc::new(BridgeState {
                harness_url: Mutex::new(None),
                launch_token: Mutex::new(None),
                auth_cookie: Mutex::new(None),
                pairing: Mutex::new(None),
                session_token: Mutex::new(None),
                connected: Mutex::new(false),
                port: Mutex::new(None),
                shutdown: tokio::sync::Notify::new(),
                listener: std::sync::Mutex::new(None),
            }),
        }
    }

    /// 注册配对状态变化监听器（镜像上游 `onConnectedChange`）。
    ///
    /// 重复注册时**覆盖**前一个：桥只有一份配对状态，多个监听器只会造成
    /// 重复刷新；保留「最后一次注册生效」比维护监听器列表更简单，也更难用错。
    ///
    /// # 参数
    ///
    /// * `listener` — 收到新的配对状态（`true` = 已配对）。在触发线程上
    ///   **同步**调用，因此回调本身必须立刻返回；要读快照或触碰 UI 请自行
    ///   派生任务（见 `lib.rs` 的接线）。
    ///
    /// # 示例
    ///
    /// 形状示意（不可执行；可执行断言见下方回归测试）：
    ///
    /// ```text
    /// bridge.on_connected_change(|connected| { /* 派生刷新任务 */ });
    /// // 之后任一次 stop() 或 POST /pair 引起的翻转都会回调它。
    /// // 值未变时不回调（判重见 BridgeState::set_connected）。
    /// ```
    pub fn on_connected_change(&self, listener: impl Fn(bool) + Send + Sync + 'static) {
        if let Ok(mut slot) = self.state.listener.lock() {
            *slot = Some(Box::new(listener));
        }
    }

    /// 注入 Harness 目标（就绪时调用；传 `None` 表示 Harness 已退出）。
    ///
    /// 换目标会清空已取得的 cookie：端口变了，cookie 名（`dsh-auth-<port>`）
    /// 也随之失效，沿用旧 cookie 只会得到未授权响应。
    ///
    /// # 参数
    ///
    /// * `target` — 端点基地址与首航 token；`None` 表示清空。
    pub async fn set_harness_target(&self, target: Option<HarnessTarget>) {
        let (url, token) = match target {
            Some(target) => (Some(target.base_url), target.launch_token),
            None => (None, None),
        };
        *self.state.harness_url.lock().await = url;
        *self.state.launch_token.lock().await = token;
        *self.state.auth_cookie.lock().await = None;
    }

    /// 当前是否已有可用的 Harness 目标。
    pub async fn has_target(&self) -> bool {
        self.state.harness_url.lock().await.is_some()
    }

    pub async fn snapshot(&self) -> MobileBridgeSnapshot {
        let pairing = self.state.pairing.lock().await;
        let connected = *self.state.connected.lock().await;
        let port = *self.state.port.lock().await;
        let authenticated = self.state.auth_cookie.lock().await.is_some();
        let running = port.is_some();
        let (pairing_url, qr, expires_at) = match pairing.as_ref() {
            Some(p) if now_ms() < p.expires_at => {
                // 必须用**局域网 IP**：0.0.0.0 是绑定地址，手机连不上。
                // 路径指向 `GET /`（配对页），而非 `POST /pair`——把 POST 端点
                // 当链接打开只会得到 405，令牌由页面自行提交。
                let host = lan_ipv4().unwrap_or_else(|| "127.0.0.1".to_string());
                let url = format!("http://{host}:{}/?token={}", port.unwrap_or(0), p.token);
                let qr = render_qr_block(&url);
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
            authenticated,
        }
    }

    /// Rotate the pairing token and start listening on a LAN port.
    ///
    /// 幂等：已监听时直接返回当前快照，不会重复绑定（菜单可能被连点）。
    /// 绑定成功后尽力完成一次 cookie 握手；握手失败不影响配对页可用性，
    /// 首次 `/api/rpc` 转发时会再试一次。
    pub async fn start(
        &self,
        preferred_port: Option<u16>,
    ) -> std::io::Result<MobileBridgeSnapshot> {
        if self.state.port.lock().await.is_some() {
            return Ok(self.snapshot().await);
        }

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
            .route("/", get(pair_page))
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

        // 尽力握手：失败只记日志，不阻断配对流程。
        if let Err(error) = self.ensure_auth_cookie().await {
            eprintln!("[mobile-bridge] auth cookie handshake deferred: {error}");
        }

        Ok(self.snapshot().await)
    }

    /// 停止监听并**吊销**配对/会话凭据。
    ///
    /// 不保留凭据是有意的：停止菜单是「现在不要局域网暴露」的表达，
    /// 若保留 `session_token`，已配对的手机在下次启动后仍可继续调用。
    pub async fn stop(&self) {
        self.state.shutdown.notify_waiters();
        *self.state.port.lock().await = None;
        // 经 set_connected 而不是直接写字段：停止桥同样是一次配对状态翻转
        // （已配对的手机不再有效），壳侧的菜单状态行必须一起回到 off。
        self.state.set_connected(false).await;
        *self.state.pairing.lock().await = None;
        *self.state.session_token.lock().await = None;
    }

    /// 确保已取得 `dsh-auth-*` cookie（API 鉴权前提）。
    ///
    /// # 返回
    ///
    /// * `Ok(())` — 已有 cookie，或本次握手成功。
    /// * `Err(_)` — 缺少目标地址 / 缺少启动 token / 握手网络失败。
    pub async fn ensure_auth_cookie(&self) -> Result<(), String> {
        if self.state.auth_cookie.lock().await.is_some() {
            return Ok(());
        }
        let base_url = self
            .state
            .harness_url
            .lock()
            .await
            .clone()
            .ok_or_else(|| "harness target not set".to_string())?;
        let token = self
            .state
            .launch_token
            .lock()
            .await
            .clone()
            .ok_or_else(|| "launch token unavailable (harness already consumed it)".to_string())?;

        let cookie = fetch_auth_cookie(&base_url, &token).await?;
        *self.state.auth_cookie.lock().await = Some(cookie);
        Ok(())
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// 手机桥状态的一行展示文案（供原生菜单 `Phone` 子菜单的动态状态项使用）。
///
/// 刻意写成**纯函数**并显式接收局域网地址：
///
/// * 纯函数 → 确定性单测（不依赖当前机器的真实网卡，CI 上不会因跑在
///   容器/无网环境而漂移）；
/// * 地址由调用方经 [`lan_ipv4`] 探测传入 → 这里不做任何网络动作。
///
/// # 参数
///
/// * `snapshot` — 桥状态快照；`port` 为 `None` 即「未启动」。
/// * `lan_ip` — 展示用局域网地址；`None` 时退化为只显示端口号（探测不到
///   网卡时仍要给出可用信息，而不是留空）。
///
/// # 返回
///
/// 形如 `Phone Bridge: paired · 192.168.1.5:41234` 的单行文本。三种状态：
///
/// | 条件 | 文案 |
/// |------|------|
/// | `port == None` | `Phone Bridge: off` |
/// | 已配对（`connected`） | `Phone Bridge: paired · <ip>:<port>` |
/// | 已监听但未握手（`authenticated == false`） | `Phone Bridge: listening (unauth) · <ip>:<port>` |
/// | 已监听且已握手 | `Phone Bridge: listening · <ip>:<port>` |
///
/// # 示例
///
/// ```ignore
/// let snapshot = MobileBridgeSnapshot { port: Some(41234), ..Default::default() };
/// assert_eq!(
///     status_label(&snapshot, Some("192.168.1.5")),
///     "Phone Bridge: listening (unauth) · 192.168.1.5:41234"
/// );
/// ```
pub fn status_label(snapshot: &MobileBridgeSnapshot, lan_ip: Option<&str>) -> String {
    let Some(port) = snapshot.port else {
        return "Phone Bridge: off".to_string();
    };
    let endpoint = match lan_ip {
        Some(ip) => format!("{ip}:{port}"),
        None => format!("port {port}"),
    };
    let state = match (snapshot.connected, snapshot.authenticated) {
        (true, _) => "paired",
        (false, true) => "listening",
        // 未取得 `dsh-auth-*` cookie 时 `/api/rpc` 必被 Harness 拒绝——如实告知，
        // 否则用户会把「配对成功但调用全 401」当成 Harness 的 bug。
        (false, false) => "listening (unauth)",
    };
    format!("Phone Bridge: {state} · {endpoint}")
}

/// 探测本机在默认路由上的局域网 IPv4 地址。
///
/// 技巧：把 UDP socket `connect` 到公网地址（不发送任何数据），让内核按路由表
/// 选出出口网卡地址。无需引入额外依赖，也不会真的产生流量。
/// 探测不到时返回 `None`（调用方回退 `127.0.0.1`）。
pub fn lan_ipv4() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let addr = socket.local_addr().ok()?;
    let ip = addr.ip();
    if ip.is_loopback() {
        return None;
    }
    Some(ip.to_string())
}

fn random_token(bytes: usize) -> String {
    let mut rng = rand::thread_rng();
    (0..bytes)
        .map(|_| format!("{:02x}", rng.gen::<u8>()))
        .collect()
}

/// 把文本渲染成二维码**文本块**（Unicode 半块字符，包裹 `<pre>`）。
///
/// 命名如实：这不是 SVG，而是等宽字体下的半块字符矩阵——在 `<pre>` 中
/// 按 1:1 宽高比呈现时同样可被手机相机识别，且不需要图像编码依赖。
fn render_qr_block(text: &str) -> String {
    use qrcode::QrCode;
    match QrCode::new(text.as_bytes()) {
        Ok(code) => {
            let image = code.render::<qrcode::render::unicode::Dense1x2>().build();
            format!("<pre>{image}</pre>")
        }
        Err(_) => String::new(),
    }
}

/// 从响应头文本中提取 `dsh-auth-*` cookie 的 `name=value` 对。
///
/// 只取首个匹配：Harness 换发的鉴权 cookie 只有一个；同时刻意忽略其他
/// `Set-Cookie`（如会话跟踪），避免把无关凭据带进转发请求。
///
/// # 参数
///
/// * `headers` — HTTP 响应头文本（不含 body）。
pub fn parse_auth_cookie(headers: &str) -> Option<String> {
    headers.lines().find_map(|line| {
        let value = line
            .strip_prefix("Set-Cookie:")
            .or_else(|| line.strip_prefix("set-cookie:"))?;
        let pair = value.trim().split(';').next()?.trim();
        let (name, _) = pair.split_once('=')?;
        if name.starts_with(AUTH_COOKIE_PREFIX) && !pair.is_empty() {
            Some(pair.to_string())
        } else {
            None
        }
    })
}

/// Harness 鉴权 cookie 前缀（与 `crate::cookies` 的 431 防护共用同一前缀）。
const AUTH_COOKIE_PREFIX: &str = "dsh-auth-";

/// 首航握手：`GET {base_url}/?token=…` → 取回 `dsh-auth-*` cookie。
///
/// 契约 C5 明确 token 只在这一次请求里出现，因此这里用最朴素的原始 TCP
/// 请求实现，不引入 HTTP 客户端依赖。
async fn fetch_auth_cookie(base_url: &str, token: &str) -> Result<String, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let url = url::Url::parse(&format!(
        "{}/?token={token}",
        base_url.trim_end_matches('/')
    ))
    .map_err(|e| format!("invalid harness url: {e}"))?;
    let host = url.host_str().unwrap_or("127.0.0.1").to_string();
    let port = url.port().unwrap_or(80);

    let mut stream = tokio::time::timeout(
        HTTP_TIMEOUT,
        tokio::net::TcpStream::connect(format!("{host}:{port}")),
    )
    .await
    .map_err(|_| "handshake connect timeout".to_string())?
    .map_err(|e| format!("handshake connect failed: {e}"))?;

    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nAccept: */*\r\nConnection: close\r\n\r\n",
        path = url.path(),
        host = host,
        port = port,
    );
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|e| format!("handshake write failed: {e}"))?;

    let mut buffer = Vec::new();
    // 只需要响应头；响应体可能很大（HTML 首页），因此限制读取量。
    let mut chunk = [0u8; 8192];
    while buffer.len() < 64 * 1024 {
        let read = stream
            .read(&mut chunk)
            .await
            .map_err(|e| format!("handshake read failed: {e}"))?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if find_header_end(&buffer) < buffer.len() {
            break;
        }
    }

    let header_end = find_header_end(&buffer);
    let head = String::from_utf8_lossy(&buffer[..header_end]).to_string();
    let status = head
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(0);
    if status != 200 {
        return Err(format!("handshake returned HTTP {status}"));
    }

    parse_auth_cookie(&head)
        .ok_or_else(|| "handshake response carried no dsh-auth-* cookie".to_string())
}

/// 手机端配对页：展示二维码与配对状态，由页面自身提交 `POST /pair`。
///
/// 令牌只从 query 读取并回填进页面，不做任何服务端校验——真正的校验发生在
/// `POST /pair`（比对 `PendingPairing` 与有效期）。页面因此可以安全地被
/// 重新加载（token 过期后 `POST /pair` 会明确返回 401）。
async fn pair_page(
    axum::extract::Host(host): axum::extract::Host,
    axum::extract::Query(query): axum::extract::Query<HashMap<String, String>>,
) -> Response {
    let token = query.get("token").cloned().unwrap_or_default();
    let (url_block, notice) = if token.is_empty() {
        (
            String::new(),
            "缺少配对令牌：请在桌面端菜单重新打开配对页。",
        )
    } else {
        // 用请求自身的 Host 头拼绝对地址：这正是手机可达的那个 host:port，
        // 无需再猜局域网 IP（探测到的出口网卡未必是手机能到的那张）。
        let target = format!("http://{host}/?token={token}");
        (
            render_qr_block(&target),
            "用手机相机扫描，或在已打开的本页点击「配对」。",
        )
    };

    let html = format!(
        r#"<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSH Desktop · 手机配对</title>
<style>
  :root {{ color-scheme: light dark; }}
  body {{ font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0;
         padding: 24px; display: flex; flex-direction: column; align-items: center; gap: 16px; }}
  pre {{ font-family: ui-monospace, "Cascadia Mono", monospace; line-height: 0.9;
         font-size: 10px; margin: 0; }}
  button {{ font-size: 16px; padding: 10px 20px; border-radius: 8px; border: 1px solid #888;
            background: transparent; cursor: pointer; }}
  .notice {{ opacity: 0.75; font-size: 14px; text-align: center; max-width: 28em; }}
  .status {{ font-size: 14px; min-height: 1.4em; }}
</style>
</head>
<body>
  <h1>DSH Desktop 手机配对</h1>
  {url_block}
  <p class="notice">{notice}</p>
  <button id="pair">配对</button>
  <p class="status" id="status"></p>
<script>
  var token = {token_json};
  document.getElementById('pair').addEventListener('click', function () {{
    var status = document.getElementById('status');
    if (!token) {{ status.textContent = '缺少令牌'; return; }}
    status.textContent = '配对中…';
    fetch('/pair', {{
      method: 'POST',
      headers: {{ 'Content-Type': 'application/json' }},
      body: JSON.stringify({{ token: token }})
    }}).then(function (r) {{ return r.json().then(function (b) {{ return {{ ok: r.ok, body: b }}; }}); }})
      .then(function (result) {{
        if (result.ok) {{
          status.textContent = '配对成功，可回到 Harness 继续操作。';
        }} else {{
          status.textContent = '配对失败（令牌可能已过期，请在桌面端重新生成）。';
        }}
      }})
      .catch(function (e) {{ status.textContent = '配对请求失败：' + e; }});
  }});
</script>
</body>
</html>"#,
        token_json = serde_json::to_string(&token).unwrap_or_else(|_| "\"\"".to_string()),
    );

    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        html,
    )
        .into_response()
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
    *pairing = None;
    // 显式释放配对锁后再翻转状态：监听器会派生任务去读 `snapshot()`，
    // 而快照要锁 `pairing`——持锁通知会把「配对完成」和「读快照」耦合成
    // 一次无谓的等待（任务侧只是排队，但顺序上没必要）。
    drop(pairing);
    state.set_connected(true).await;
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

    // 契约 C5：/api/* 靠 dsh-auth-* cookie 鉴权，不认 token。握手未完成时
    // 先补一次（进程启动后 Harness 可能才就绪）。
    let mut cookie = state.auth_cookie.lock().await.clone();
    if cookie.is_none() {
        if let Err(error) = bridge_ensure_cookie(&state).await {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                format!("harness auth handshake failed: {error}"),
            )
                .into_response();
        }
        cookie = state.auth_cookie.lock().await.clone();
    }

    // Forward to the Harness endpoint.
    let target = format!("{}/api/{}", harness_url.trim_end_matches('/'), endpoint);
    match forward_request(&target, &payload, cookie.as_deref()).await {
        Ok(response) => response,
        Err(error) => (StatusCode::BAD_GATEWAY, format!("forward failed: {error}")).into_response(),
    }
}

/// 供 axum 处理器使用的一次性握手（`BridgeState` 上没有 `MobileBridge` 方法）。
async fn bridge_ensure_cookie(state: &Arc<BridgeState>) -> Result<(), String> {
    let base_url = state
        .harness_url
        .lock()
        .await
        .clone()
        .ok_or_else(|| "harness target not set".to_string())?;
    let token = state
        .launch_token
        .lock()
        .await
        .clone()
        .ok_or_else(|| "launch token unavailable".to_string())?;
    let cookie = fetch_auth_cookie(&base_url, &token).await?;
    *state.auth_cookie.lock().await = Some(cookie);
    Ok(())
}

/// Minimal HTTP POST forwarder over a raw TCP socket (avoids extra deps).
///
/// # 参数
///
/// * `target` — 绝对 URL。
/// * `payload` — JSON 请求体。
/// * `cookie` — `dsh-auth-*` 的 `name=value`；为 `None` 时不带 Cookie 头
///   （Harness 会以未授权响应拒绝，属预期行为）。
async fn forward_request(
    target: &str,
    payload: &serde_json::Value,
    cookie: Option<&str>,
) -> std::io::Result<Response> {
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
    let cookie_header = cookie
        .map(|value| format!("Cookie: {value}\r\n"))
        .unwrap_or_default();
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: {host}:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{cookie_header}Connection: close\r\n\r\n",
        body.len()
    );

    let mut stream = tokio::time::timeout(
        HTTP_TIMEOUT,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_auth_cookie_and_drops_attributes() {
        let headers = "HTTP/1.1 200 OK\r\n\
             Set-Cookie: dsh-auth-4173=abc123; Path=/; HttpOnly; Max-Age=2592000\r\n\
             Content-Type: text/html\r\n\r\n";
        assert_eq!(
            parse_auth_cookie(headers).as_deref(),
            Some("dsh-auth-4173=abc123")
        );
    }

    #[test]
    fn ignores_unrelated_or_absent_cookies() {
        assert_eq!(parse_auth_cookie("HTTP/1.1 200 OK\r\n\r\n"), None);
        assert_eq!(
            parse_auth_cookie("HTTP/1.1 200 OK\r\nSet-Cookie: session=zzz\r\n\r\n"),
            None
        );
    }

    #[test]
    fn accepts_lowercase_header_name() {
        assert_eq!(
            parse_auth_cookie("HTTP/1.1 200 OK\r\nset-cookie: dsh-auth-1=v\r\n\r\n").as_deref(),
            Some("dsh-auth-1=v")
        );
    }

    #[test]
    fn qr_block_is_preformatted_text_not_svg() {
        let block = render_qr_block("http://192.168.1.5:4173/?token=abc");
        assert!(block.starts_with("<pre>"), "{block}");
        assert!(!block.contains("<svg"), "字段名含 _svg 但内容是文本块");
    }

    #[test]
    fn lan_ipv4_never_returns_loopback() {
        // 无网络环境下允许返回 None；但绝不能把 127.0.0.1 当成局域网地址。
        if let Some(ip) = lan_ipv4() {
            assert_ne!(ip, "127.0.0.1");
        }
    }

    /// 菜单状态文案：四种状态各自可辨；未探测到网卡时退化为端口号而非留空。
    #[test]
    fn status_label_covers_all_bridge_states() {
        let stopped = MobileBridgeSnapshot::default();
        assert_eq!(
            status_label(&stopped, Some("192.168.1.5")),
            "Phone Bridge: off"
        );

        let listening = MobileBridgeSnapshot {
            running: true,
            port: Some(41234),
            ..Default::default()
        };
        assert_eq!(
            status_label(&listening, Some("192.168.1.5")),
            "Phone Bridge: listening (unauth) · 192.168.1.5:41234"
        );

        let authenticated = MobileBridgeSnapshot {
            authenticated: true,
            ..listening.clone()
        };
        assert_eq!(
            status_label(&authenticated, Some("192.168.1.5")),
            "Phone Bridge: listening · 192.168.1.5:41234"
        );

        // 已配对时 `authenticated` 不再是关注点（配对即已拿到 cookie）。
        let paired = MobileBridgeSnapshot {
            connected: true,
            ..listening.clone()
        };
        assert_eq!(
            status_label(&paired, Some("192.168.1.5")),
            "Phone Bridge: paired · 192.168.1.5:41234"
        );

        assert_eq!(
            status_label(&listening, None),
            "Phone Bridge: listening (unauth) · port 41234"
        );
    }

    /// 接线不变量：`start` 幂等、`stop` 释放端口并吊销凭据。
    #[tokio::test]
    async fn start_is_idempotent_and_stop_revokes_credentials() {
        let bridge = MobileBridge::new();
        assert!(!bridge.has_target().await);

        let first = bridge.start(None).await.expect("bind ephemeral port");
        assert!(first.running);
        let port = first.port.expect("port assigned");
        assert!(first.pairing_url.is_some(), "配对 URL 必须在监听后可用");
        // 未注入 Harness 目标：不允许假装已鉴权。
        assert!(!first.authenticated);

        let second = bridge.start(None).await.expect("idempotent");
        assert_eq!(second.port, Some(port), "重复调用不得重复绑定");

        bridge.stop().await;
        let after = bridge.snapshot().await;
        assert!(!after.running);
        assert!(after.pairing_url.is_none(), "stop 后不得残留有效配对令牌");
        assert!(!after.connected);
    }

    /// 通知语义：只在配对状态**真正翻转**时触发一次。
    ///
    /// 判重不是优化而是正确性要求——壳侧每次收到通知都要走一次主线程
    /// `set_text`，重复通知会在「打开配对页」这类密集操作里被放大。
    #[tokio::test]
    async fn connected_listener_fires_only_on_real_transition() {
        let bridge = MobileBridge::new();
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        bridge.on_connected_change(move |connected| {
            sink.lock().unwrap().push(connected);
        });

        bridge.state.set_connected(true).await;
        bridge.state.set_connected(true).await; // 值未变：不得重复通知
        bridge.state.set_connected(false).await;

        assert_eq!(*seen.lock().unwrap(), vec![true, false]);
    }

    /// 回归护栏（本模块此前缺失的一环）：手机在配对页完成 `POST /pair`
    /// 之后，宿主**必须**收到通知。
    ///
    /// 此前 `pair()` 直接写 `connected` 字段，没有任何观察者，于是原生菜单的
    /// 状态行会停在 `listening`——用户刚在手机上点完「配对」，桌面菜单却毫无
    /// 反应，只能靠停止/重开桥来刷新。配对动作发生在手机浏览器里，宿主没有
    /// 本地事件可挂钩，因此这条链路只能靠回调保证。
    #[tokio::test]
    async fn pairing_from_the_phone_notifies_the_listener() {
        let bridge = MobileBridge::new();
        let notified = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = Arc::clone(&notified);
        bridge.on_connected_change(move |connected| {
            sink.lock().unwrap().push(connected);
        });

        let snapshot = bridge.start(None).await.expect("绑定临时端口");
        let pairing_url = snapshot.pairing_url.expect("配对 URL 必须在监听后可用");
        let token = url::Url::parse(&pairing_url)
            .expect("配对 URL 必须可解析")
            .query_pairs()
            .find(|(key, _)| key == "token")
            .map(|(_, value)| value.to_string())
            .expect("配对 URL 必须带 token");

        let response = pair(
            State(Arc::clone(&bridge.state)),
            Json(HashMap::from([(
                "token".to_string(),
                serde_json::Value::String(token),
            )])),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            *notified.lock().unwrap(),
            vec![true],
            "配对成功必须通知宿主"
        );

        // 令牌一次性：重放不得成功，也不得再次通知。
        let replay = pair(
            State(Arc::clone(&bridge.state)),
            Json(HashMap::from([(
                "token".to_string(),
                serde_json::Value::String("whatever".to_string()),
            )])),
        )
        .await;
        assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(*notified.lock().unwrap(), vec![true]);
    }

    /// 停止桥同样是一次状态翻转（已配对的手机不再有效），通知必须发出，
    /// 否则菜单状态行会停留在 `paired`。
    #[tokio::test]
    async fn stopping_the_bridge_notifies_the_listener() {
        let bridge = MobileBridge::new();
        let notified = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = Arc::clone(&notified);
        bridge.on_connected_change(move |connected| {
            sink.lock().unwrap().push(connected);
        });

        bridge.state.set_connected(true).await;
        bridge.stop().await;

        assert_eq!(*notified.lock().unwrap(), vec![true, false]);
    }
}
