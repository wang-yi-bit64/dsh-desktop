//! 退出前的「会不会打断工作」检查（2026-10-03/04，批次 0.8-结构件）。
//!
//! # 为什么壳能问、以及问的是什么
//!
//! 上游桌面端向自己的私有 Host 进程发 Node IPC（`quit-inspection`）来问「现在有没有
//! 活」。本仓没有 Node 模式的私有 Host：Harness 就是 `dsh web` 起的普通子进程，壳无法
//! 与它建 IPC。但壳与 Harness 之间**本来就有一条已鉴权的 HTTP/RPC 通道**（契约 C5：
//! `GET /?token=` 换 `dsh-auth-*` cookie，之后 `/api/*` 全部走 cookie），手机桥一直
//! 在用同一条。因此这里把「有没有活」落到 Harness 自己的权威接口上：
//!
//! ```text
//! POST {base}/api/session/list
//!   {"type":"client-request","rpcId":"1","method":"session/list","payload":{"args":{"_request":{}}}}
//! ```
//!
//! 响应里的 `result.value.items[].running` 就是 Harness 对「该会话的 agent 是否在跑」的
//! **单一权威判断**（上游 `session-controller` 的 `summaryFor()`：
//! `running: ctx.agents.get(id)?.status === 'running'`）。壳不自己猜状态，只读它。
//!
//! # 三条不可协商的语义
//!
//! 1. **未知 = 有工作**（[`QuitInspection::Unknown`]）。握手失败、端点 404/403、
//!    响应不是预期形状，都归 Unknown——调用方**不得**据此静默退出。上游超时口径是
//!    2 秒后按「有活」处理，同一取向。
//! 2. **检查绝不阻塞退出本身**：本模块只做只读探测，最多受调用方的超时约束；
//!    Harness 未就绪（没有 endpoint）时调用方直接放行——那本来就没有可打断的东西。
//! 3. **不猜、不编造**：`items` 里没有 `running` 字段（形状变了）不算「没工作」，
//!    而是 Unknown。宁可多问一次，也不把「读不出来」说成「没事」。

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use crate::contracts::QUIT_INSPECTION_TIMEOUT_MS;
use crate::token::LaunchEndpoint;

/// 会话清单端点：常量住在 `dsh-contracts`（CX-16），这里只引用不重抄。
const SESSION_LIST_ENDPOINT: &str = crate::contracts::QUIT_INSPECTION_ENDPOINT;

/// 一次检查的结论。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QuitInspection {
    /// 没有任何会话在跑（或干脆没有会话）。
    NoWork,
    /// 有 `sessions` 个会话正在跑。
    Work { sessions: usize },
    /// 问不出来（网络 / 鉴权 / 形状不符 / 超时）。**按有工作处理。**
    Unknown,
}

/// 退出检查的往返超时（连握手 + 探测一次）。
const INSPECTION_TIMEOUT: Duration = Duration::from_millis(QUIT_INSPECTION_TIMEOUT_MS);

/// 无 GUI 地向 Harness 问一次「现在有没有会话在跑」。
///
/// # 参数
///
/// * `endpoint` — 就绪时抓到的 Harness 端点（[`crate::token::LaunchEndpoint`]）：
///   `host` / `port` 用来建连与 `Host:` 头，`token` 只用于换 `dsh-auth-*` cookie。
///   刻意收**已解析的端点**而不是 `(base_url, token_str)`：`token::extract_token` 的
///   正则只匹配 stdout 里的 `dsh web: <url>` 行，拿它解析一个裸 URL 会静默失败，
///   于是每次检查都变成 Unknown（这个坑本模块踩过）。
///
/// # 返回
///
/// 只有**成功读到权威答案**时才返回 [`QuitInspection::NoWork`] /
/// [`QuitInspection::Work`]；其余一切情况（包括 HTTP 状态码不是 2xx）都是
/// [`QuitInspection::Unknown`]。
pub fn inspect_quit(endpoint: &LaunchEndpoint) -> QuitInspection {
    // `authority` 只用于 `Host:` 头（含端口）；**套接字地址必须单独拼**——
    // 把 `authority` 再 `:{port}` 一次会得到 `127.0.0.1:53247:53247`，
    // 连接直接失败，于是任何一次检查都会变成 Unknown。
    let socket = format!("{}:{}", endpoint.host, endpoint.port);
    let authority = endpoint
        .url
        .port()
        .map(|port| format!("{}:{port}", endpoint.host))
        .unwrap_or_else(|| endpoint.host.clone());
    let token = endpoint.token.as_str();

    // 1) 握手：换鉴权 cookie（契约 C5）。
    //
    // `Host:` 必须是真实 authority：harness 的 Host/Origin 围栏会解析它，解析不出
    // 来就直接拒绝（占位符漏替换曾让整条检查恒为 Unknown）。
    let Some(handshake) = round_trip(
        &socket,
        &format!("GET /?token={token} HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\n\r\n"),
    ) else {
        return QuitInspection::Unknown;
    };
    let Some(cookie) = auth_cookie_from_headers(&handshake) else {
        return QuitInspection::Unknown;
    };

    // 2) 探测：读 Harness 自己的会话清单。
    let body = session_list_body();
    let post = format!(
        "POST /api/{endpoint} HTTP/1.1\r\nHost: {authority}\r\nContent-Type: application/json\r\nCookie: {cookie}\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n{body}",
        endpoint = SESSION_LIST_ENDPOINT,
        length = body.len(),
    );
    let Some(response) = round_trip(&socket, &post) else {
        return QuitInspection::Unknown;
    };

    match parse_running_sessions(&response) {
        Some(0) => QuitInspection::NoWork,
        Some(sessions) => QuitInspection::Work { sessions },
        None => QuitInspection::Unknown,
    }
}

/// 构造一次 `session/list` 的 client-request 封套。
///
/// 字段名是**网关的硬契约**（`dsh-client-connection` 的 `endpointFromPath` +
/// typert 的 client-request schema）：`payload.args` 必须是**唯一**的 plain-object 字段，
/// 且该端点要求 `args._request` 存在。少了 `payload` 会被判 `gateway/bad-request`，
/// 少了 `args` 会被判 `gateway/internal: Remote payload must contain exactly one
/// plain-object args field`——这两种形状错误都不是「没工作」，必须归 Unknown。
fn session_list_body() -> String {
    "{\"type\":\"client-request\",\"rpcId\":\"quit-probe\",\"method\":\"session/list\",\"payload\":{\"args\":{\"_request\":{}}}}".to_string()
}

/// 从响应头里取出 Harness 换发的 `dsh-auth-` cookie 的 `name=value`。
///
/// 只取**首个**匹配：Harness 一次只换发一个鉴权 cookie；刻意忽略同一响应里的其他
/// `Set-Cookie`（会话 cookie 等），与 `crate::contracts::AUTH_COOKIE_PREFIX` 同一个前缀口径。
fn auth_cookie_from_headers(head: &str) -> Option<String> {
    for line in head.split("\r\n") {
        let Some(value) = line
            .strip_prefix("set-cookie:")
            .or_else(|| line.strip_prefix("Set-Cookie:"))
        else {
            continue;
        };
        let pair = value.trim();
        let Some(at) = pair.find('=') else {
            continue;
        };
        let name = pair[..at].trim();
        if !name.starts_with(crate::contracts::AUTH_COOKIE_PREFIX) {
            continue;
        }
        let value = pair[at + 1..].split(';').next().unwrap_or("").trim();
        if !value.is_empty() {
            return Some(format!("{name}={value}"));
        }
    }
    None
}

/// 从原始响应里取出 JSON 主体（容忍 `Transfer-Encoding: chunked` 的框架行）。
///
/// harness 一律以 chunked 回包（`<len>\r\n{json}\r\n0\r\n\r\n`），直接把 `\r\n\r\n`
/// 之后的内容喂给 `serde_json` 会失败——这个坑曾让整条检查恒为 Unknown。做法是
/// 取「头之后第一个 `{` 到最后一个 `}` 之间」的片段：chunk 长度行与尾帧都在
/// JSON 之外，不会干扰；同时无分块（普通 Content-Length）时同样成立。
fn json_body(response: &str) -> Option<&str> {
    let body = response.split("\r\n\r\n").nth(1)?;
    let start = body.find('{')?;
    let end = body.rfind('}')?;
    (start < end).then(|| &body[start..=end])
}

/// 解析 `result.value.items[].running`，返回正在运行的会话数。
///
/// `None` = 形状不符 / 未成功（调用方归 Unknown）。
fn parse_running_sessions(response: &str) -> Option<usize> {
    let value: serde_json::Value = serde_json::from_str(json_body(response)?).ok()?;
    if !value.get("result")?.get("ok")?.as_bool()? {
        return None;
    }
    let rows = value["result"]["value"]["items"].as_array()?;
    let mut running = 0usize;
    for row in rows {
        // 形状不符（没有 running 字段）→ 整体 Unknown，而不是当成「没在跑」。
        match row.get("running").and_then(serde_json::Value::as_bool) {
            Some(true) => running += 1,
            Some(false) => {}
            None => return None,
        }
    }
    Some(running)
}

/// 一次带超时的原始 TCP 往返；任何 I/O 错误都返回 `None`（调用方归 Unknown）。
///
/// `socket` 是 `host:port` 形式的套接字地址（**不是** `Host:` 头里的 authority）。
fn round_trip(socket: &str, request: &str) -> Option<String> {
    let Ok(mut stream) = TcpStream::connect(socket) else {
        return None;
    };
    let _ = stream.set_read_timeout(Some(INSPECTION_TIMEOUT));
    let _ = stream.set_write_timeout(Some(INSPECTION_TIMEOUT));
    stream.write_all(request.as_bytes()).ok()?;
    stream.flush().ok()?;
    let mut response = String::new();
    stream.read_to_string(&mut response).ok()?;
    Some(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// 起一个 stub：按 `script` 顺序对每个请求回一条响应，服务完就退出。
    ///
    /// 三条坑，缺一条都会让测试**偶发**失败（失败方向还是"明明返回了却读到
    /// Unknown"，极难查）：
    ///
    /// 1. **必须 half-close**（`shutdown(Write)`）：被测代码用 `read_to_string` 读到
    ///    EOF；不关写端客户端会等到读超时，把「读超时」误判成结论。
    /// 2. **不能用 `listener.incoming()` 迭代器**：它 accept 到连接后不会等客户端发数据，
    ///    循环会立刻转下一次 accept，于是"第 N 条"响应的时机与客户端的第 N 个请求
    ///    不保证对齐。这里显式循环 `accept()`，**先读一个字节再回包**，时序才确定。
    /// 3. **服务满 `script.len()` 条后必须 `drop(listener)` 再返回**：否则 `join()`
    ///    永远等不到线程结束。
    fn spawn_stub(script: Vec<String>) -> (u16, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let expected = script.len();
        let handle = std::thread::spawn(move || {
            let mut turns = script.into_iter();
            for _ in 0..expected {
                let Ok((mut stream, _peer)) = listener.accept() else {
                    break;
                };
                // 等客户端把请求写出来（只读 1 字节也够：它已经发了 header）。
                let mut probe = [0u8; 1];
                if stream.read(&mut probe).is_err() {
                    continue;
                }
                let head = turns.next().unwrap_or_default();
                if stream.write_all(head.as_bytes()).is_err() {
                    continue;
                }
                let _ = stream.flush();
                let _ = stream.shutdown(std::net::Shutdown::Write);
            }
            // 关键：先释放监听端口，线程才结束（见上文坑 3）。
            drop(listener);
        });
        (port, handle)
    }

    fn ok_json(items: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{{\"type\":\"server-response\",\"rpcId\":\"1\",\"result\":{{\"ok\":true,\"value\":{{\"items\":[{items}]}}}}}}\r\n"
        )
    }

    const HANDSHAKE: &str = "HTTP/1.1 303 See Other\r\nset-cookie: dsh-auth-abc=v1.body.sig; Max-Age=2592000; Path=/; HttpOnly\r\nLocation: ./\r\nConnection: close\r\n\r\n";

    fn endpoint(port: u16) -> LaunchEndpoint {
        LaunchEndpoint {
            url: url::Url::parse(&format!("http://127.0.0.1:{port}/?token=t")).unwrap(),
            token: "t".to_string(),
            host: "127.0.0.1".to_string(),
            port,
        }
    }

    /// 权威判据：有会话在跑必须报 Work，且数量准确。
    #[test]
    fn running_sessions_are_reported_as_work() {
        let (port, handle) = spawn_stub(vec![
            HANDSHAKE.to_string(),
            ok_json(
                "{\"sessionId\":\"s1\",\"running\":true},{\"sessionId\":\"s2\",\"running\":false}",
            ),
        ]);
        let found = inspect_quit(&endpoint(port));
        assert_eq!(found, QuitInspection::Work { sessions: 1 });
        let _ = handle.join();
    }

    /// 全都没在跑 = NoWork（此时退出不该被拦）。
    #[test]
    fn idle_sessions_are_not_work() {
        let (port, handle) = spawn_stub(vec![
            HANDSHAKE.to_string(),
            ok_json("{\"sessionId\":\"s1\",\"running\":false}"),
        ]);
        let found = inspect_quit(&endpoint(port));
        assert_eq!(found, QuitInspection::NoWork);
        let _ = handle.join();
    }

    /// 空清单同样是 NoWork。
    #[test]
    fn empty_roster_is_not_work() {
        let (port, handle) = spawn_stub(vec![HANDSHAKE.to_string(), ok_json("")]);
        let found = inspect_quit(&endpoint(port));
        assert_eq!(found, QuitInspection::NoWork);
        let _ = handle.join();
    }

    /// 可证伪性：`items` 里**缺** `running` 字段 ≈ 形状变了，必须 Unknown，
    /// 绝不能读成「没工作」——否则一次上游字段改名就会让壳静默打断用户的工作。
    #[test]
    fn missing_running_field_is_unknown_not_idle() {
        let (port, handle) = spawn_stub(vec![
            HANDSHAKE.to_string(),
            ok_json("{\"sessionId\":\"s1\"}"),
        ]);
        let found = inspect_quit(&endpoint(port));
        assert_eq!(found, QuitInspection::Unknown);
        let _ = handle.join();
    }

    /// 网关把请求打回（`ok:false`）时同样是 Unknown。
    #[test]
    fn gateway_error_is_unknown() {
        let (port, handle) = spawn_stub(vec![
            HANDSHAKE.to_string(),
            "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{\"type\":\"server-response\",\"rpcId\":\"1\",\"result\":{\"ok\":false,\"error\":{\"code\":\"gateway/bad-request\",\"message\":\"invalid\"}}}\r\n".to_string(),
        ]);
        let found = inspect_quit(&endpoint(port));
        assert_eq!(found, QuitInspection::Unknown);
        let _ = handle.join();
    }

    /// 根本连不上（端口没在监听）：Unknown，且**不能**慢到让退出卡住。
    #[test]
    fn unreachable_host_is_unknown() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let found = inspect_quit(&endpoint(port));
        assert_eq!(found, QuitInspection::Unknown);
    }

    /// cookie 解析：只认 `dsh-auth-` 前缀，忽略同响应里的其他 Set-Cookie。
    #[test]
    fn auth_cookie_parsing_ignores_other_cookies() {
        let head = "HTTP/1.1 303 See Other\r\nset-cookie: session=zzz; Path=/\r\nset-cookie: dsh-auth-4173=abc; Path=/; HttpOnly\r\n\r\n";
        assert_eq!(
            auth_cookie_from_headers(head).as_deref(),
            Some("dsh-auth-4173=abc")
        );
        assert_eq!(auth_cookie_from_headers("HTTP/1.1 200 OK\r\n\r\n"), None);
    }
}
