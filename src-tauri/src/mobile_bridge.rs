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
//!
//! ## 对抗性审计（V2，2026-10-28）
//!
//! 八条判据的结论、逐条证据（代码位置 + 测试名）、CORS/CSRF 边界与未解风险
//! 登记在 `docs/incidents/mobile-bridge-audit.md`。本头只记**改过语义**的三条：
//!
//! 1. **监听绑定只有一处、且在 [`MobileBridge::start`] 内**——「桥默认不监听」
//!    靠这一点成立；测试 `v2_1_tcp_listener_bind_is_confined_to_start` 静态守着
//!    （带植入夹具，扫描器失效时会报红）。
//! 2. **`/api/rpc` 的鉴权是精确 Bearer 匹配 + 常数时间比较**，不是子串包含；
//!    未授权一律 401，且 401 先于方法白名单（不泄漏「哪些方法被放行」）。
//! 3. **转发链每一步都有上限**：建连 / 写出 / 单次读空闲 / 整链总时长 /
//!    响应体字节数（CX-18）；并发上限 4，超出直接 429 而不是排队。

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use dsh_contracts::constants::{
    AUTH_COOKIE_PREFIX, MOBILE_BRIDGE_FORWARD_CONNECT_TIMEOUT, MOBILE_BRIDGE_FORWARD_READ_TIMEOUT,
    MOBILE_BRIDGE_FORWARD_TOTAL_TIMEOUT, MOBILE_BRIDGE_FORWARD_WRITE_TIMEOUT,
    MOBILE_BRIDGE_HANDSHAKE_TIMEOUT, MOBILE_BRIDGE_MAX_CONCURRENT_FORWARDS,
    MOBILE_BRIDGE_MAX_REQUEST_BYTES, MOBILE_BRIDGE_MAX_RESPONSE_BYTES,
    MOBILE_BRIDGE_MAX_RESPONSE_HEAD_BYTES, MOBILE_BRIDGE_PAIRING_TTL_MS,
};
use rand::Rng;
use serde::Serialize;
use tokio::sync::{Mutex, Semaphore};

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
    /// 停止信号（V2-1 的同族缺陷修复）。
    ///
    /// 原实现是 `tokio::sync::Notify` + `notify_waiters()`：**通知不存许可**，
    /// 若 `stop()` 发生在 serve 任务第一次 `notified().await` 之前（`start()`
    /// 里 spawn 之后紧跟握手，无目标时握手立刻失败返回，窗口只有微秒级），
    /// 这次通知就丢了——监听器永远不关，端口一直占着，而 `port` 字段已被置
    /// `None`，快照上看不出任何异常（§7.1 规则 3 的无声降级）。
    /// `watch` 保存**最新值**，接收方无论何时开始等都不会漏掉已经发生的翻转。
    shutdown: Mutex<Option<tokio::sync::watch::Sender<bool>>>,
    /// 转发并发闸门（CX-18 的 `MOBILE_BRIDGE_MAX_CONCURRENT_FORWARDS`）。
    ///
    /// 放在状态里而不是每次请求新建：上限的意义是**全桥共享**，一次一新建
    /// 等于没有上限。`Arc` 是为了让 `try_acquire_owned` 能把许可带过 `await`
    /// 边界（借用式许可撑不住 axum 处理器的生命周期）。
    forward_slots: Arc<Semaphore>,
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
        // 锁中毒时恢复 guard 而不是静默放弃：状态翻转已发生，若因为一次历史
        // panic 让此后所有配对状态变化都失联，就是 §7.1 规则 3 禁的无声降级
        // （D10 同族缺陷，见 crate::poison）。
        let listener = crate::poison::lock_or_recover(&self.listener);
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
                shutdown: Mutex::new(None),
                forward_slots: Arc::new(Semaphore::new(MOBILE_BRIDGE_MAX_CONCURRENT_FORWARDS)),
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
        // 同理：中毒时照常注册（恢复 guard），不让监听器因一次历史 panic 永久缺席。
        let mut slot = crate::poison::lock_or_recover(&self.state.listener);
        *slot = Some(Box::new(listener));
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
                expires_at: now_ms() + MOBILE_BRIDGE_PAIRING_TTL_MS,
            });
        }

        // `0.0.0.0:<port>` 由本行自己拼出、端口是 u16 字面量，解析不可能失败。
        // 用带归因的 expect 而不是裸 unwrap（S4-4 判据：生产 unwrap 计数为 0，
        // 或每一处都有就地注释说明为何不可能失败）。
        let bind_addr: SocketAddr = format!("0.0.0.0:{}", preferred_port.unwrap_or(0))
            .parse()
            .expect("bind address is always a valid `0.0.0.0:<u16 port>` socket address");
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

        // 每轮 start 一条独立通道：上一轮的「已停止」值不会被下一轮继承
        // ——继承的后果是新监听器一挂上就自己关掉。
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::watch::channel(false);
        *self.state.shutdown.lock().await = Some(shutdown_tx);
        tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    // 先看一次当前值：`stop()` 可能已经发生在注册之前。
                    if *shutdown_rx.borrow() {
                        return;
                    }
                    while shutdown_rx.changed().await.is_ok() {
                        if *shutdown_rx.borrow() {
                            return;
                        }
                    }
                })
                .await
                .ok();
        });

        // 尽力握手：失败只记日志，不阻断配对流程。
        //
        // 走 `log` 门面而不是 `eprintln!`：`eprintln!` 写的是**无人接管**的
        // stderr（打包后的 GUI 进程根本没有控制台），因此「握手失败」这件事
        // 在用户机器上既不可见也**不可测**——V2-7 的判据（日志里不得出现完整
        // token / cookie）需要能捕获日志的观察点，而 `eprintln!` 没有任何
        // 可注入的观察点。错误文本先过 [`scrub_secrets`]：握手失败的原始
        // 错误可能夹带 `?token=…`（URL 解析失败时由底层错误回显）。
        if let Err(error) = self.ensure_auth_cookie().await {
            log::warn!(
                "[mobile-bridge] auth cookie handshake deferred: {}",
                scrub_secrets(&error)
            );
        }

        Ok(self.snapshot().await)
    }

    /// 停止监听并**吊销**配对/会话凭据。
    ///
    /// 不保留凭据是有意的：停止菜单是「现在不要局域网暴露」的表达，
    /// 若保留 `session_token`，已配对的手机在下次启动后仍可继续调用。
    pub async fn stop(&self) {
        // 先取走 sender 再发信号：这样重复 stop 是 no-op，也不会给下一轮留下
        // 「已停止」的许可（老实现用 `notify_waiters`，在无人等待时**直接丢失**）。
        let sender = self.state.shutdown.lock().await.take();
        if let Some(sender) = sender {
            let _ = sender.send(true);
        }
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

// Harness 鉴权 cookie 前缀来自 `dsh_contracts::constants::AUTH_COOKIE_PREFIX`
// （CONTRACT C5 的唯一产地）。本模块**刻意不再抄一份字面量**：此前这里有一份
// `const AUTH_COOKIE_PREFIX: &str = "dsh-auth-";`，而 `state.rs` / `quit_probe.rs`
// 用的是契约库那份——两处 `dsh-auth-` 各自演进时不会报错，只会让「清 cookie」
// 与「读 cookie」默默认不同的前缀（AGENTS.md §3.2 明令禁止的重复定义）。

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
        MOBILE_BRIDGE_HANDSHAKE_TIMEOUT,
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
    // 写与读同样要有超时：`connect` 成功不代表对端会读/会写。只给建连加超时
    // 时，一条「连上了但永不响应」的连接会让 `start()` 永远停在握手上——
    // 而 `start()` 是在菜单点击的调用链上跑的（V2-6 的同族问题）。
    tokio::time::timeout(
        MOBILE_BRIDGE_HANDSHAKE_TIMEOUT,
        stream.write_all(request.as_bytes()),
    )
    .await
    .map_err(|_| "handshake write timeout".to_string())?
    .map_err(|e| format!("handshake write failed: {e}"))?;

    let mut buffer = Vec::new();
    // 只需要响应头；响应体可能很大（HTML 首页），因此限制读取量。
    let mut chunk = [0u8; 8192];
    while buffer.len() < MOBILE_BRIDGE_MAX_RESPONSE_HEAD_BYTES {
        let read = tokio::time::timeout(MOBILE_BRIDGE_HANDSHAKE_TIMEOUT, stream.read(&mut chunk))
            .await
            .map_err(|_| "handshake read timeout".to_string())?
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
    if body.len() > MOBILE_BRIDGE_MAX_REQUEST_BYTES {
        return (StatusCode::PAYLOAD_TOO_LARGE, "body too large").into_response();
    }

    // 鉴权先于一切语义判断（V2-8）。
    //
    // 顺序不是风格问题：若先查方法白名单再查鉴权，未授权者就能靠 401 / 403
    // 的差异逐条枚举「桥到底放行了哪些方法」。旧测试正是在这一点上写错的
    // （未鉴权却断言 403），它把**缺陷**当成了契约。
    let supplied = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok());
    let authed = {
        let session = state.session_token.lock().await;
        match session.as_ref() {
            Some(token) => bearer_matches(supplied, token),
            None => false,
        }
    };
    if !authed {
        // 只记**方案名 + 长度**，绝不记内容：这条日志会被用户贴进 issue（V2-7）。
        log::warn!(
            "[mobile-bridge] /api/rpc rejected 401 (authorization: {})",
            describe_authorization(supplied)
        );
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

    // 并发闸门（V2-6）。`try_acquire` 而不是 `acquire`：排队只会把过载转成
    // 延迟（手机侧看到的是「转圈直到总超时」），而 429 能让调用方明确退避。
    let _slot = match Arc::clone(&state.forward_slots).try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => {
            log::warn!("[mobile-bridge] /api/rpc rejected 429 (forward slots exhausted)");
            return (
                StatusCode::TOO_MANY_REQUESTS,
                "too many concurrent forwards",
            )
                .into_response();
        }
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
            // 同样过一遍擦除：握手失败的原始错误可能回显 `?token=…`。
            log::warn!(
                "[mobile-bridge] forward aborted 503 (handshake: {})",
                scrub_secrets(&error)
            );
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                format!("harness auth handshake failed: {}", scrub_secrets(&error)),
            )
                .into_response();
        }
        cookie = state.auth_cookie.lock().await.clone();
    }

    // Forward to the Harness endpoint.
    let target = format!("{}/api/{}", harness_url.trim_end_matches('/'), endpoint);
    match forward_request(&target, &payload, cookie.as_deref()).await {
        Ok(response) => response,
        Err(error) => {
            log::warn!(
                "[mobile-bridge] forward to {endpoint} failed: {}",
                scrub_secrets(&error.to_string())
            );
            (StatusCode::BAD_GATEWAY, format!("forward failed: {error}")).into_response()
        }
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

/// 转发链路的时间/体积上限。
///
/// 做成结构体而不是直接读常量，唯一目的是**测试可注入**：慢连接与超大响应这
/// 两条判据若只能等生产的 10 s / 4 MiB，测试就得跑十几秒或分配 4 MiB——那种
/// 测试的结局是被人注释掉。生产路径只用 [`ForwardLimits::default`]，它逐字段
/// 取自 `dsh-contracts` 的 CX-18，因此「调参」仍然只有一个产地。
#[derive(Clone, Copy, Debug)]
pub(crate) struct ForwardLimits {
    pub connect: Duration,
    pub write: Duration,
    pub read: Duration,
    pub total: Duration,
    pub max_response_bytes: usize,
}

impl Default for ForwardLimits {
    fn default() -> Self {
        Self {
            connect: MOBILE_BRIDGE_FORWARD_CONNECT_TIMEOUT,
            write: MOBILE_BRIDGE_FORWARD_WRITE_TIMEOUT,
            read: MOBILE_BRIDGE_FORWARD_READ_TIMEOUT,
            total: MOBILE_BRIDGE_FORWARD_TOTAL_TIMEOUT,
            max_response_bytes: MOBILE_BRIDGE_MAX_RESPONSE_BYTES,
        }
    }
}

/// 超时类的 `io::Error`（统一构造，避免各处各写一种 `ErrorKind`）。
fn timeout_error(message: &str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::TimedOut, message.to_string())
}

/// 协议/体积违规的 `io::Error`。
fn protocol_error(message: String) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, message)
}

/// Minimal HTTP POST forwarder over a raw TCP socket (avoids extra deps).
///
/// 整条链的每一步都有各自的上限（V2-6）：建连、写出、单次读的空闲、以及
/// **总时长**。缺任何一步都能被一条构造出来的上游拖死：
///
/// | 缺口 | 后果 |
/// |---|---|
/// | 无建连超时 | 对端丢包时卡到 OS 的 SYN 重传上限（Windows 约 21 s） |
/// | 无写超时 | 对端只连不读，`write_all` 卡在发送窗口满 |
/// | 无读超时 | 对端连上不发字节，`read_to_end` 无限等 |
/// | 只有单次读超时 | 「每 9 秒吐 1 字节」可无限延长（故另有总超时） |
/// | 无响应体上限 | 上游吐 1 GiB → 桥进程 OOM（桥是**本机**进程，可被远程触发） |
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
    forward_request_with_limits(target, payload, cookie, ForwardLimits::default()).await
}

/// [`forward_request`] 的可注入上限版本（生产只经 `default()` 调用）。
async fn forward_request_with_limits(
    target: &str,
    payload: &serde_json::Value,
    cookie: Option<&str>,
    limits: ForwardLimits,
) -> std::io::Result<Response> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let deadline = Instant::now() + limits.total;

    let url = url::Url::parse(target)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?;
    let host = url.host_str().unwrap_or("127.0.0.1").to_string();
    let port = url.port().unwrap_or(80);
    // query 可选（目标 URL 由 Harness 端点拼出，通常带 token 查询参数）：
    // 用 match 直接取，而不是「先 is_some() 再 unwrap()」——后者把保证拆成
    // 两步写，unwrap 仍留在生产路径上（S4-4）。
    let path = match url.query() {
        Some(query) => format!("{}?{}", url.path(), query),
        None => url.path().to_string(),
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
        limits.connect,
        tokio::net::TcpStream::connect(format!("{host}:{port}")),
    )
    .await
    .map_err(|_| timeout_error("connect timeout"))??;

    // 头与体共用一次写超时：分两次给超时只会让「头写完了、体卡住」这条路径
    // 拿到 2 倍预算。
    tokio::time::timeout(limits.write, async {
        stream.write_all(request.as_bytes()).await?;
        stream.write_all(&body).await
    })
    .await
    .map_err(|_| timeout_error("write timeout"))??;

    // 响应读取：单次读受「空闲超时」约束，整体受 `deadline` 约束；体积在
    // **读的过程中**就设上限，而不是读完再比长度——后者对 OOM 毫无帮助。
    let head_cap = MOBILE_BRIDGE_MAX_RESPONSE_HEAD_BYTES;
    let hard_cap = limits
        .max_response_bytes
        .saturating_add(head_cap)
        .saturating_add(4);
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        if buffer.len() >= hard_cap {
            return Err(protocol_error(format!(
                "upstream response exceeds {} bytes (head cap {} + body cap {})",
                hard_cap, head_cap, limits.max_response_bytes
            )));
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(timeout_error("total timeout"));
        }
        let slice = limits.read.min(remaining);
        let read = tokio::time::timeout(slice, stream.read(&mut chunk))
            .await
            .map_err(|_| {
                if slice < remaining {
                    timeout_error("read idle timeout")
                } else {
                    timeout_error("total timeout")
                }
            })??;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }

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
    if body_bytes.len() > limits.max_response_bytes {
        return Err(protocol_error(format!(
            "upstream body {} bytes exceeds cap {}",
            body_bytes.len(),
            limits.max_response_bytes
        )));
    }

    let status_code = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
    Ok((
        status_code,
        [(header::CONTENT_TYPE, "application/json")],
        body_bytes,
    )
        .into_response())
}

/// 授权头的方案名（RFC 7235：方案名大小写不敏感）。
const BEARER_SCHEME: &str = "Bearer";

/// 精确 Bearer 匹配（V2-2）。
///
/// 旧实现是 `supplied.contains(token)`——它把「任何**包含**令牌子串的字符串」
/// 都当成合法凭据：`Authorization: x<token>y`、`Bearer <token>extra`、
/// 甚至 `Authorization: Basic <base64 里恰好含 token>` 全部通过。这类判定
/// 等价于把令牌降级成「口令的一个片段」，任何能读出部分历史响应的攻击者
/// 都可能拼出可用的头。
///
/// 现在的形状：方案名必须是 `Bearer`（大小写不敏感），后接**恰好**一个空格，
/// 值与令牌**等长且逐字节相同**。
fn bearer_matches(supplied: Option<&str>, token: &str) -> bool {
    let Some(raw) = supplied else {
        return false;
    };
    let Some((scheme, presented)) = raw.split_once(' ') else {
        return false;
    };
    if !scheme.eq_ignore_ascii_case(BEARER_SCHEME) {
        return false;
    }
    // 只裁尾部空白。`Bearer  <token>`（双空格）在这里得到 `" <token>"`，与
    // 令牌不等——刻意不做 `trim()`：宽松解析只会扩大可接受形状。
    ct_eq(presented.trim_end().as_bytes(), token.as_bytes())
}

/// 等长时逐字节比较，**不提前返回**。
///
/// 为什么手写：`==` 在首个不同字节处短路，同网段攻击者理论上可用计时差
/// 逐字节恢复会话令牌。长度本身仍然泄漏（长度不同立即返回），这不构成实际
/// 风险——令牌长度是固定常量，而「长度正确、内容错误」的那部分已经常数时间。
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// 把疑似凭据折叠成「长度」——日志里只留这个（V2-7）。
///
/// 为什么连前几位都不留：短令牌（如 8 位配对令牌）留 4 位就等于泄漏一半，
/// 而「前 4 位」对排查没有任何价值。长度足够回答「头到底带没带东西」。
pub(crate) fn redact_secret(secret: &str) -> String {
    if secret.is_empty() {
        return "<empty>".to_string();
    }
    format!("<redacted:{}B>", secret.len())
}

/// 授权头的一句话描述：方案名 + 脱敏后的值。
fn describe_authorization(raw: Option<&str>) -> String {
    match raw {
        None => "absent".to_string(),
        Some(value) => match value.split_once(' ') {
            Some((scheme, rest)) => format!("{scheme} {}", redact_secret(rest.trim_end())),
            None => format!("malformed {}", redact_secret(value)),
        },
    }
}

/// 兜底擦除：把文本里的 `token=…` 与 `dsh-auth-…=…` 的值替换掉。
///
/// 面向**错误文本**而不是结构化字段：底层错误（URL 解析、TLS、上游回显）的
/// 措辞不受本模块控制，唯一稳妥的做法是在写日志前统一过一遍。保守地多擦
/// 一点是可接受的（日志少一点可读性），漏擦一次则是一条永久泄漏。
pub(crate) fn scrub_secrets(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    loop {
        let next = match (rest.find("token="), rest.find(AUTH_COOKIE_PREFIX)) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        let Some(position) = next else {
            out.push_str(rest);
            return out;
        };
        out.push_str(&rest[..position]);
        let tail = &rest[position..];
        let Some(value_start) = tail.find('=').map(|index| index + 1) else {
            // 裸前缀无 `=`（例如文档正文里提到 `dsh-auth-`）：跳过前缀本身，
            // 避免在同一个位置反复匹配造成死循环。
            let skip = AUTH_COOKIE_PREFIX.len().min(tail.len());
            out.push_str(&tail[..skip]);
            rest = &tail[skip..];
            continue;
        };
        let (key, value_and_tail) = tail.split_at(value_start);
        let end = value_and_tail
            .find(|c: char| c.is_whitespace() || c == ';' || c == '&')
            .unwrap_or(value_and_tail.len());
        out.push_str(key);
        out.push_str("<redacted>");
        rest = &value_and_tail[end..];
        if rest.is_empty() {
            return out;
        }
    }
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

    use std::sync::{Mutex as StdMutex, OnceLock};

    use axum::body::Bytes;
    use axum::http::HeaderValue;

    // -----------------------------------------------------------------
    // 测试基建
    // -----------------------------------------------------------------

    /// 日志捕获器（V2-7 的观察点）。
    ///
    /// 为什么要在测试里装一个全局 logger：本模块在被测的日志路径上必须先
    /// **可观察**，否则「日志不含令牌」就只能靠人眼 review 断言——那不是测试。
    /// 这里捕获的是 `log` 门面的输出，因此断言与生产代码走同一条路径（若哪天
    /// 有人把 `log::warn!` 改回 `eprintln!`，断言会因为**一条都抓不到**而失败）。
    struct CaptureLogger {
        lines: &'static StdMutex<Vec<String>>,
    }

    impl log::Log for CaptureLogger {
        fn enabled(&self, _: &log::Metadata<'_>) -> bool {
            true
        }

        fn log(&self, record: &log::Record<'_>) {
            if let Ok(mut lines) = self.lines.lock() {
                lines.push(format!("{}: {}", record.level(), record.args()));
            }
        }

        fn flush(&self) {}
    }

    fn captured_log() -> &'static StdMutex<Vec<String>> {
        static LINES: OnceLock<StdMutex<Vec<String>>> = OnceLock::new();
        let lines = LINES.get_or_init(|| StdMutex::new(Vec::new()));
        static INSTALL: std::sync::Once = std::sync::Once::new();
        INSTALL.call_once(|| {
            // 装不上就让它失败在断言里，而不是静默跳过：`-D warnings` 环境下
            // 任何「看不见」的测试都是假绿。lib 测试里没有别的 logger（
            // `tauri-plugin-log` 只在运行时初始化）。
            if log::set_boxed_logger(Box::new(CaptureLogger { lines })).is_ok() {
                log::set_max_level(log::LevelFilter::Trace);
            }
        });
        lines
    }

    fn auth_headers(token: &str) -> header::HeaderMap {
        let mut headers = header::HeaderMap::new();
        let value = HeaderValue::from_str(&format!("Bearer {token}"))
            .expect("Bearer <token> 一定是合法 header 值");
        headers.insert(header::AUTHORIZATION, value);
        headers
    }

    /// 本地 stub upstream 的应答脚本（V2-4 / V2-5 / V2-6）。
    ///
    /// 为什么不用真实 Harness：这些判据要验证的是**转发层**（状态码透传、超时、
    /// 体积上限），把它绑到「Node 运行时能不能起来」上，等于让一个转发层红灯
    /// 同时可能是运行时红灯——分不清是谁坏了。
    #[derive(Clone)]
    enum StubReply {
        /// 固定状态码 + 可选 `Set-Cookie` + 固定响应体。
        Canned {
            status: u16,
            set_cookie: Option<&'static str>,
            body: Vec<u8>,
        },
        /// 接受连接，但**一个字节都不发**（慢连接判据）。
        Silent,
        /// 先发头声明总长，再发 `size` 字节（体积上限判据）。
        Oversized(usize),
    }

    /// stub 的句柄：端口 + 收到的请求头（供「cookie 确实被转发」这类断言用）。
    struct StubHandle {
        port: u16,
        requests: Arc<StdMutex<Vec<String>>>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for StubHandle {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    impl StubHandle {
        fn base_url(&self) -> String {
            format!("http://127.0.0.1:{}", self.port)
        }

        fn requests(&self) -> Vec<String> {
            self.requests.lock().expect("stub 请求记录未被毒化").clone()
        }
    }

    async fn spawn_stub<F>(script: F) -> StubHandle
    where
        F: Fn(&str) -> StubReply + Send + Sync + 'static,
    {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("stub 绑定回环临时端口");
        let port = listener.local_addr().expect("stub 端口一定可读").port();
        let script = Arc::new(script);
        let requests: Arc<StdMutex<Vec<String>>> = Arc::new(StdMutex::new(Vec::new()));
        let recorded = Arc::clone(&requests);
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                let script = Arc::clone(&script);
                let recorded = Arc::clone(&recorded);
                tokio::spawn(async move {
                    let mut request = Vec::new();
                    let mut chunk = [0u8; 1024];
                    loop {
                        let Ok(read) = stream.read(&mut chunk).await else {
                            return;
                        };
                        if read == 0 {
                            break;
                        }
                        request.extend_from_slice(&chunk[..read]);
                        if find_header_end(&request) < request.len() {
                            break;
                        }
                    }
                    let head = String::from_utf8_lossy(&request).to_string();
                    let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
                    if let Ok(mut log) = recorded.lock() {
                        log.push(head.clone());
                    }
                    // 显式解引用：`Arc<F>` 本身不实现 `Fn`，`script(&path)` 这种写法
                    // 依赖自动解引用的调用规则，换编译器版本容易翻车。
                    match (*script)(&path) {
                        StubReply::Silent => {
                            // 连接保持打开、不发任何字节：被测方必须靠自己的
                            // 超时收场（这里用一次阻塞读把连接留住）。
                            let _ = stream.read(&mut chunk).await;
                        }
                        StubReply::Canned {
                            status,
                            set_cookie,
                            body,
                        } => {
                            let mut head = format!(
                                "HTTP/1.1 {status} STUB\r\nContent-Type: application/json\r\nContent-Length: {}\r\n",
                                body.len()
                            );
                            if let Some(cookie) = set_cookie {
                                head.push_str(&format!("Set-Cookie: {cookie}\r\n"));
                            }
                            head.push_str("Connection: close\r\n\r\n");
                            if stream.write_all(head.as_bytes()).await.is_err() {
                                return;
                            }
                            let _ = stream.write_all(&body).await;
                        }
                        StubReply::Oversized(size) => {
                            let head = format!(
                                "HTTP/1.1 200 STUB\r\nContent-Type: application/json\r\nContent-Length: {size}\r\nConnection: close\r\n\r\n"
                            );
                            if stream.write_all(head.as_bytes()).await.is_err() {
                                return;
                            }
                            let block = vec![b'x'; 8192];
                            let mut sent = 0usize;
                            while sent < size {
                                let take = (size - sent).min(block.len());
                                if stream.write_all(&block[..take]).await.is_err() {
                                    return;
                                }
                                sent += take;
                            }
                        }
                    }
                    let _ = stream.flush().await;
                });
            }
        });
        StubHandle {
            port,
            requests,
            task: handle,
        }
    }

    /// 桥自己的 HTTP 客户端（V2-5 / V2-8：直接打真实监听端口，
    /// 而不是绕开 axum 去调处理器——绕过去就测不到路由与提取器）。
    async fn http_call(
        port: u16,
        method: &str,
        path: &str,
        headers: &[(&str, String)],
        body: &[u8],
    ) -> (u16, String) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("连接桥的监听端口");
        let mut request = format!(
            "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: {}\r\nConnection: close\r\n",
            body.len()
        );
        for (name, value) in headers {
            request.push_str(&format!("{name}: {value}\r\n"));
        }
        request.push_str("\r\n");
        stream
            .write_all(request.as_bytes())
            .await
            .expect("写出请求头");
        stream.write_all(body).await.expect("写出请求体");
        let mut response = Vec::new();
        stream.read_to_end(&mut response).await.expect("读响应");
        let text = String::from_utf8_lossy(&response).to_string();
        let status = text
            .split_whitespace()
            .nth(1)
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(0);
        let body = text
            .split_once("\r\n\r\n")
            .map(|(_, rest)| rest.to_string())
            .unwrap_or_default();
        (status, body)
    }

    /// 从配对 URL 里取 token（与桌面菜单把 URL 变成二维码是同一条来源）。
    fn pairing_token(snapshot: &MobileBridgeSnapshot) -> String {
        let url = snapshot
            .pairing_url
            .as_deref()
            .expect("监听后必须有配对 URL");
        url::Url::parse(url)
            .expect("配对 URL 必须可解析")
            .query_pairs()
            .find(|(key, _)| key == "token")
            .map(|(_, value)| value.to_string())
            .expect("配对 URL 必须带 token")
    }

    /// 取一个「确定没人监听」的端口：绑一次再立刻释放。
    ///
    /// 不用硬编码端口（例如 1 或 9）：那类端口在部分环境里**有人监听**，
    /// 于是「死端口」测试会静默变成「连上了一个陌生服务」。
    fn dead_port() -> u16 {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("取临时端口");
        let port = listener.local_addr().expect("临时端口可读").port();
        drop(listener);
        port
    }

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

    // =================================================================
    // V2-1 — 端口生命周期：绑定只在 start，stop 后端口必须真的可重绑
    // =================================================================

    /// 生产段 = 首个顶格 `#[cfg(test)]` 之前的部分。
    ///
    /// 静态守卫只看生产段是**必须的**：测试里自己也会写 `TcpListener::bind`
    /// 字面量（stub 与对照），不切出去就等于让守卫去数自己。
    fn production_source() -> &'static str {
        include_str!("mobile_bridge.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap_or_default()
    }

    /// 每一处 `TcpListener::bind` 的宿主函数名。
    fn bind_call_sites(source: &str) -> Vec<String> {
        source
            .match_indices("TcpListener::bind")
            .map(|(index, _)| enclosing_fn_name(source, index))
            .collect()
    }

    fn enclosing_fn_name(source: &str, index: usize) -> String {
        let head = &source[..index];
        let start = match head.rfind("fn ") {
            Some(position) => position + "fn ".len(),
            None => return "<top-level>".to_string(),
        };
        let tail = &head[start..];
        let end = tail.find('(').unwrap_or(tail.len());
        tail[..end].trim().to_string()
    }

    /// V2-1（静态）：「桥默认不监听」这条安全语义，靠的是**全模块只有一处**
    /// 监听绑定，且它写在用户显式动作的 `start()` 里。
    ///
    /// 这类断言的失效方式是「写法变了，扫描器不认」（AGENTS.md §7.3），因此
    /// 下面同时给出植入夹具：把同样的扫描器指到一个「绑定写在 stop 里」的
    /// 合成源上，它必须报出 `stop`——否则这条断言只是装饰。
    #[test]
    fn v2_1_tcp_listener_bind_is_confined_to_start() {
        assert_eq!(
            bind_call_sites(production_source()),
            vec!["start".to_string()],
            "监听绑定必须恰好一处、且在 start() 里；多出来的绑定意味着某条路径会自己开端口"
        );

        let planted =
            "async fn stop() {\n    let _ = tokio::net::TcpListener::bind(addr).await;\n}\n";
        assert_eq!(
            bind_call_sites(planted),
            vec!["stop".to_string()],
            "扫描器连植入的违规都看不见——它没在检查"
        );
    }

    /// V2-1（运行时）：`stop()` 之后端口必须能被**别人**重新绑定。
    ///
    /// 为什么不能只断言 `snapshot.port == None`：那个字段是桥自己写的，
    /// 把它置空与「内核真的释放了端口」是两件事——老实现用
    /// `Notify::notify_waiters()`，在 serve 任务注册等待之前调用会丢通知，
    /// 端口就一直被占着，而快照看起来完全正常。
    #[tokio::test]
    async fn v2_1_stop_releases_the_port_for_rebinding() {
        let bridge = MobileBridge::new();
        let port = bridge
            .start(None)
            .await
            .expect("绑定临时端口")
            .port
            .expect("监听后必须拿到端口");

        // 探测地址必须是**通配 `0.0.0.0`**，不能是 `127.0.0.1`。
        //
        // 这是 2026-10-28 CI 实证出来的（PR #14 首跑：windows-latest 与
        // macos-latest 在同一条断言上红）：桥监听 `0.0.0.0:<port>`，若用
        // `127.0.0.1:<port>` 去探测，**绑定会成功**——Windows 与 BSD 都允许
        // 「具体地址覆盖通配地址」的并存绑定（Windows 只要首个 socket 没设
        // `SO_EXCLUSIVEADDRUSE`），于是「应当绑不上」被写成了「绑上了」。
        // 通配探测则相反：任何平台下 `0.0.0.0:<port>` 都与该端口的**任意**
        // 既有绑定冲突，因此它才是「这个端口被占着」的可移植判据。
        let probe = ("0.0.0.0", port);

        // 负例（对照组）：**监听中**的端口必须绑不上。没有这一条，下面的
        // 「能绑定」可能只是因为这个端口本来就没被占用。
        assert!(
            std::net::TcpListener::bind(probe).is_err(),
            "桥还在监听 {port}，该端口却可被再次绑定——断言对象选错了"
        );

        bridge.stop().await;

        // 优雅关闭发生在后台任务上，允许一个收敛窗口；但必须有上界，
        // 否则真正泄漏时这条测试会挂住而不是失败。
        let mut rebound = None;
        for _ in 0..50 {
            if let Ok(listener) = std::net::TcpListener::bind(probe) {
                rebound = Some(listener);
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(
            rebound.is_some(),
            "stop() 之后 5 秒内端口 {port} 仍不可绑定——监听器泄漏"
        );
    }

    // =================================================================
    // V2-2 — Bearer 精确匹配（旧实现是 contains）
    // =================================================================

    #[test]
    fn v2_2_bearer_token_must_match_exactly() {
        let token = "0123456789abcdef";
        assert!(bearer_matches(Some("Bearer 0123456789abcdef"), token));
        assert!(
            bearer_matches(Some("bearer 0123456789abcdef"), token),
            "方案名大小写不敏感（RFC 7235）"
        );
        assert!(
            bearer_matches(Some("Bearer 0123456789abcdef "), token),
            "尾空白可容忍"
        );

        // 以下每一条在 `supplied.contains(token)` 下**都会通过**：
        assert!(
            !bearer_matches(Some("Bearer 0123456789abcdef00"), token),
            "令牌是前缀也不行"
        );
        assert!(
            !bearer_matches(Some("Bearer fa0123456789abcdef"), token),
            "令牌在中间也不行"
        );
        assert!(
            !bearer_matches(Some("Basic 0123456789abcdef"), token),
            "方案不是 Bearer"
        );
        assert!(
            !bearer_matches(Some("0123456789abcdef"), token),
            "没有方案名"
        );
        assert!(
            !bearer_matches(Some("Bearer  0123456789abcdef"), token),
            "双空格不放宽"
        );
        assert!(!bearer_matches(Some("Bearer "), token));
        assert!(!bearer_matches(Some(""), token));
        assert!(!bearer_matches(None, token));
        assert!(
            !bearer_matches(Some("Bearer 0123456789ABCDEF"), token),
            "令牌比较区分大小写"
        );
    }

    /// V2-2 的端到端负例：走真实处理器，三种「包含令牌」的头都必须 401。
    #[tokio::test]
    async fn v2_2_substring_authorization_is_rejected_over_the_handler() {
        let bridge = MobileBridge::new();
        let token = "v2-2-session-token";
        *bridge.state.session_token.lock().await = Some(token.to_string());

        for bad in [
            format!("Bearer {token}extra"),
            format!("x{token}"),
            format!("Bearer x{token}"),
        ] {
            let mut headers = header::HeaderMap::new();
            headers.insert(
                header::AUTHORIZATION,
                HeaderValue::from_str(&bad).expect("构造的授权头是合法 header 值"),
            );
            let response = rpc_forward(
                State(Arc::clone(&bridge.state)),
                headers,
                Bytes::from_static(br#"{"method":"session.list"}"#),
            )
            .await;
            assert_eq!(
                response.status(),
                StatusCode::UNAUTHORIZED,
                "以 `{bad}` 通过了鉴权"
            );
        }
    }

    // =================================================================
    // V2-3 — 请求体上限与形状（白名单外的两种拒绝）
    // =================================================================

    #[tokio::test]
    async fn v2_3_oversized_body_is_413_and_malformed_json_is_400() {
        let bridge = MobileBridge::new();
        let token = "v2-3-session";
        *bridge.state.session_token.lock().await = Some(token.to_string());

        let oversized = vec![b' '; MOBILE_BRIDGE_MAX_REQUEST_BYTES + 1];
        let response = rpc_forward(
            State(Arc::clone(&bridge.state)),
            auth_headers(token),
            Bytes::from(oversized),
        )
        .await;
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);

        let response = rpc_forward(
            State(Arc::clone(&bridge.state)),
            auth_headers(token),
            Bytes::from_static(b"{not json"),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);

        // 负例：合法请求不得落在 400 / 413（否则上面两条只是「什么都拒」）。
        let response = rpc_forward(
            State(Arc::clone(&bridge.state)),
            auth_headers(token),
            Bytes::from_static(br#"{"method":"session.list"}"#),
        )
        .await;
        assert_eq!(
            response.status(),
            StatusCode::SERVICE_UNAVAILABLE,
            "没有 Harness 目标时应当走到 503，而不是被参数校验拦下"
        );
    }

    // =================================================================
    // V2-4 — 转发状态码透传；死端口不得断言 200
    // =================================================================

    #[tokio::test]
    async fn v2_4_forward_returns_the_upstream_status_verbatim() {
        let ok = spawn_stub(|_| StubReply::Canned {
            status: 200,
            set_cookie: None,
            body: br#"{"stub":"ok"}"#.to_vec(),
        })
        .await;
        let response = forward_request(
            &format!("{}/api/session/list", ok.base_url()),
            &serde_json::json!({"method": "session.list"}),
            Some("dsh-auth-1=abc"),
        )
        .await
        .expect("200 上游必须成功");
        assert_eq!(response.status(), StatusCode::OK);

        let boom = spawn_stub(|_| StubReply::Canned {
            status: 500,
            set_cookie: None,
            body: b"internal".to_vec(),
        })
        .await;
        let response = forward_request(
            &format!("{}/api/session/list", boom.base_url()),
            &serde_json::json!({}),
            None,
        )
        .await
        .expect("上游 500 仍是一次成功的转发（状态码交给调用方看）");
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    /// 死端口：必须 502。**不得**断言 200——那正是被删掉的那条错误测试。
    #[tokio::test]
    async fn v2_4_dead_upstream_is_502_never_200() {
        let port = dead_port();
        let bridge = MobileBridge::new();
        bridge
            .set_harness_target(Some(HarnessTarget {
                base_url: format!("http://127.0.0.1:{port}"),
                launch_token: None,
            }))
            .await;
        // 直接给一个已握手的 cookie：本条的判据是**转发失败**，不是握手失败。
        *bridge.state.auth_cookie.lock().await = Some("dsh-auth-1=stub".to_string());
        let token = "v2-4-session";
        *bridge.state.session_token.lock().await = Some(token.to_string());

        let response = rpc_forward(
            State(Arc::clone(&bridge.state)),
            auth_headers(token),
            Bytes::from_static(br#"{"method":"session.list"}"#),
        )
        .await;
        assert_eq!(
            response.status(),
            StatusCode::BAD_GATEWAY,
            "上游拒绝连接必须翻译成 502"
        );
        assert_ne!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "鉴权是通过的：502 不能与 401 混淆"
        );
    }

    // =================================================================
    // V2-5 — 端到端必须操作 bridge.state，而不是另建一份状态
    // =================================================================

    /// 真实链路：start（含握手）→ `POST /pair` → `POST /api/rpc` → stub 上游。
    ///
    /// 这条测试走的是**真实监听端口**与 `bridge.state`，因此它同时钉住三件事：
    /// 握手拿到的 cookie 真的被转发、配发出来的 session 真的能鉴权、
    /// 处理器用的确实是桥自己的状态（另建一份状态的写法会在这里 401）。
    #[tokio::test]
    async fn v2_5_round_trip_through_the_bridge_state() {
        let stub = spawn_stub(|path| {
            if path.starts_with("/api/") {
                StubReply::Canned {
                    status: 200,
                    set_cookie: None,
                    body: br#"{"stub":"ok"}"#.to_vec(),
                }
            } else {
                StubReply::Canned {
                    status: 200,
                    set_cookie: Some("dsh-auth-4173=stub-cookie; Path=/; HttpOnly"),
                    body: b"<html>pair</html>".to_vec(),
                }
            }
        })
        .await;

        let bridge = MobileBridge::new();
        bridge
            .set_harness_target(Some(HarnessTarget {
                base_url: stub.base_url(),
                launch_token: Some("launch-token".to_string()),
            }))
            .await;

        let snapshot = bridge.start(None).await.expect("绑定临时端口");
        assert!(snapshot.authenticated, "start 应完成首航握手");
        let port = snapshot.port.expect("监听后必须拿到端口");
        let token = pairing_token(&snapshot);

        // 请求头/体先落到局部变量：临时值跨 `await` 只靠语句级延长，读起来脆。
        let json_header = [("Content-Type", "application/json".to_string())];
        let pair_body = format!("{{\"token\":\"{token}\"}}");
        let (status, body) =
            http_call(port, "POST", "/pair", &json_header, pair_body.as_bytes()).await;
        assert_eq!(status, 200, "配对失败: {body}");
        let parsed: serde_json::Value = serde_json::from_str(&body).expect("配对响应必须是 JSON");
        let session = parsed
            .get("session")
            .and_then(|value| value.as_str())
            .expect("配对响应必须带 session")
            .to_string();

        let rpc_headers = [
            ("Content-Type", "application/json".to_string()),
            ("Authorization", format!("Bearer {session}")),
        ];
        let (status, body) = http_call(
            port,
            "POST",
            "/api/rpc",
            &rpc_headers,
            br#"{"method":"session.list"}"#,
        )
        .await;
        assert_eq!(status, 200, "转发失败: {body}");
        assert!(body.contains(r#""stub":"ok""#), "响应体没有透传: {body}");

        // 证据：握手得到的 cookie 确实进了转发请求（否则 `authenticated`
        // 只是一个没人读的字段）。
        let forwarded = stub.requests();
        assert!(
            forwarded
                .iter()
                .any(|head| head.contains("Cookie: dsh-auth-4173=stub-cookie")),
            "转发请求没带 cookie: {forwarded:?}"
        );

        bridge.stop().await;
    }

    /// V2-5 的负例：把状态换成新建的一份，同一个会话令牌必然 401。
    #[tokio::test]
    async fn v2_5_a_fresh_state_rejects_the_session_bridge_state_accepts() {
        let token = "v2-5-session";
        let bridge = MobileBridge::new();
        *bridge.state.session_token.lock().await = Some(token.to_string());
        let accepted = rpc_forward(
            State(Arc::clone(&bridge.state)),
            auth_headers(token),
            Bytes::from_static(br#"{"method":"session.list"}"#),
        )
        .await;
        assert_ne!(
            accepted.status(),
            StatusCode::UNAUTHORIZED,
            "会话就存在 bridge.state 里，用它鉴权却失败"
        );

        let fresh = MobileBridge::new();
        let rejected = rpc_forward(
            State(Arc::clone(&fresh.state)),
            auth_headers(token),
            Bytes::from_static(br#"{"method":"session.list"}"#),
        )
        .await;
        assert_eq!(rejected.status(), StatusCode::UNAUTHORIZED);
    }

    // =================================================================
    // V2-6 — 全链超时 / 响应体上限 / 并发上限
    // =================================================================

    /// 慢连接：上游接受连接但一个字节都不发。必须有上界地失败。
    #[tokio::test]
    async fn v2_6_slow_upstream_trips_the_read_idle_timeout() {
        let stub = spawn_stub(|_| StubReply::Silent).await;
        let limits = ForwardLimits {
            connect: Duration::from_secs(2),
            write: Duration::from_secs(1),
            read: Duration::from_millis(150),
            total: Duration::from_secs(1),
            max_response_bytes: 1024,
        };
        let started = Instant::now();
        let outcome = forward_request_with_limits(
            &format!("{}/api/session/list", stub.base_url()),
            &serde_json::json!({}),
            None,
            limits,
        )
        .await;
        let error = match outcome {
            Ok(_) => panic!("上游一个字节都没发，转发却成功了"),
            Err(error) => error,
        };
        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut, "{error}");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "超时没有生效，耗时 {:?}",
            started.elapsed()
        );
    }

    /// 超大响应：必须在读的过程中被截断，而不是先缓冲完再比长度。
    #[tokio::test]
    async fn v2_6_oversized_response_is_rejected_instead_of_buffered() {
        let stub = spawn_stub(|_| StubReply::Oversized(200_000)).await;
        let limits = ForwardLimits {
            max_response_bytes: 512,
            ..ForwardLimits::default()
        };
        let outcome = forward_request_with_limits(
            &format!("{}/api/session/list", stub.base_url()),
            &serde_json::json!({}),
            None,
            limits,
        )
        .await;
        let error = match outcome {
            Ok(_) => panic!("200000 字节的响应在 512 字节上限下竟然成功"),
            Err(error) => error,
        };
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData, "{error}");
        assert!(error.to_string().contains("exceeds"), "{error}");
    }

    /// N+1 个并发：第 N+1 个必须 429，且释放一个许可后立刻恢复。
    #[tokio::test]
    async fn v2_6_the_n_plus_first_concurrent_forward_is_429() {
        let bridge = MobileBridge::new();
        let token = "v2-6-session";
        *bridge.state.session_token.lock().await = Some(token.to_string());

        let mut held = Vec::new();
        for _ in 0..MOBILE_BRIDGE_MAX_CONCURRENT_FORWARDS {
            let permit = Arc::clone(&bridge.state.forward_slots)
                .try_acquire_owned()
                .expect("许可数应当等于配置上限");
            held.push(permit);
        }

        let response = rpc_forward(
            State(Arc::clone(&bridge.state)),
            auth_headers(token),
            Bytes::from_static(br#"{"method":"session.list"}"#),
        )
        .await;
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);

        // 负例：放掉一个许可后不再 429——证明 429 来自闸门本身。
        held.pop();
        let response = rpc_forward(
            State(Arc::clone(&bridge.state)),
            auth_headers(token),
            Bytes::from_static(br#"{"method":"session.list"}"#),
        )
        .await;
        assert_ne!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    }

    // =================================================================
    // V2-7 — 日志与 401 响应体不得含完整 token / cookie
    // =================================================================

    #[test]
    fn v2_7_scrub_secrets_removes_token_and_cookie_values() {
        let scrubbed = scrub_secrets(
            "GET http://127.0.0.1:1/?token=deadbeef failed; Set-Cookie: dsh-auth-4173=cookieval; Path=/",
        );
        assert!(!scrubbed.contains("deadbeef"), "{scrubbed}");
        assert!(!scrubbed.contains("cookieval"), "{scrubbed}");
        assert!(scrubbed.contains("token=<redacted>"), "{scrubbed}");
        assert!(scrubbed.contains("dsh-auth-4173=<redacted>"), "{scrubbed}");
        // 反向对照：无密钥的部分必须保留，否则「擦除」等于「什么都看不见」。
        assert!(scrubbed.contains("failed"), "{scrubbed}");
    }

    #[tokio::test]
    async fn v2_7_logs_and_401_body_never_carry_the_secret() {
        let lines = captured_log();
        lines.lock().expect("日志缓冲未被毒化").clear();

        let bridge = MobileBridge::new();
        let secret = "v2-7-session-6f1c2b3a4d5e6f708192";
        *bridge.state.session_token.lock().await = Some(secret.to_string());

        // 用**真令牌**但错误的方案名：脱敏一旦失效，日志就会原样出现它。
        let mut headers = header::HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Token {secret}")).expect("合法 header 值"),
        );
        let response = rpc_forward(
            State(Arc::clone(&bridge.state)),
            headers,
            Bytes::from_static(br#"{"method":"session.list"}"#),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        let body = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("读取 401 响应体");
        let body = String::from_utf8_lossy(&body).to_string();
        assert!(!body.contains(secret), "401 响应体泄漏会话令牌: {body}");

        let log = lines.lock().expect("日志缓冲未被毒化").join("\n");
        assert!(
            log.contains("<redacted"),
            "日志里没有脱敏标记——这条路径没走 log 门面: {log}"
        );
        assert!(!log.contains(secret), "日志泄漏会话令牌: {log}");
    }

    // =================================================================
    // V2-8 — 鉴权先于方法白名单：未鉴权 401，鉴权后才 403
    // =================================================================

    #[tokio::test]
    async fn v2_8_401_before_403_and_403_only_after_auth() {
        let bridge = MobileBridge::new();
        let body = Bytes::from(serde_json::json!({"method": "admin.dropEverything"}).to_string());

        // 未鉴权 → 401，而**不是** 403。旧测试在这里断言 403，等于把
        // 「未授权者可以探测方法白名单」当成契约固定下来。
        let response = rpc_forward(
            State(Arc::clone(&bridge.state)),
            header::HeaderMap::new(),
            body.clone(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        let token = "v2-8-session";
        *bridge.state.session_token.lock().await = Some(token.to_string());

        // 鉴权之后，白名单外的方法才 403。
        let response =
            rpc_forward(State(Arc::clone(&bridge.state)), auth_headers(token), body).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        // 反例：白名单内的方法不得 403（证明 403 真的来自白名单）。
        let response = rpc_forward(
            State(Arc::clone(&bridge.state)),
            auth_headers(token),
            Bytes::from_static(br#"{"method":"session.list"}"#),
        )
        .await;
        assert_ne!(response.status(), StatusCode::FORBIDDEN);
    }
}
