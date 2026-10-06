//! 打到**真 harness** 的退出检查探针（本地用，CI 无 env 自动 skip）。
//!
//! 为什么值得单独留一个集成测试，而不是只靠单测里的 stub：`quit_probe` 的失败模式
//! 全是"静默变成 Unknown"——stub 只能验证解析逻辑，验证不了**与真 harness 的握手、
//! chunked 响应、`Host`/cookie 围栏**这些只会在真实服务上暴露的环节。本文件踩过的三个
//! 坑全部只在真 harness 上现形：
//!
//! 1. `Host:` 头占位符漏替换 → 围栏拒绝 → 永远 Unknown；
//! 2. `token::extract_token` 的正则只认 stdout 里的 `dsh web: <url>` 行，喂裸 URL 会失败；
//! 3. 真 harness 一律以 `Transfer-Encoding: chunked` 回包，直接 `from_str` 会解析失败。
//!
//! # 用法
//!
//! ```powershell
//! # 1) 另起一个 harness（CLI 会打印 ready URL 与 token）
//! target\debug\dsh-host-cli.exe start --resource <res> --data <data>
//! # 2) 指向它并只跑这一个测试
//! $env:DSH_LIVE_URL='http://127.0.0.1:53247'; $env:DSH_LIVE_TOKEN='<token>'
//! cargo test -p dsh-host --test quit_probe_live -- --nocapture
//! ```
//!
//! 断言刻意**不预设**「一定是 NoWork / 一定是 Work」：取决于 harness 里当时有没有会话
//! 在跑。唯一不可接受的是 `Unknown`——那说明壳与 Harness 之间的通道没打通。

#[test]
fn live_probe_reaches_a_definitive_answer() {
    let Ok(url) = std::env::var("DSH_LIVE_URL") else {
        eprintln!("[skip] DSH_LIVE_URL not set — this probe only runs against a live Harness");
        return;
    };
    let token = std::env::var("DSH_LIVE_TOKEN").unwrap_or_default();
    // 经 `parse_launch_line` 构造端点（而不是手工拼 `LaunchEndpoint`）：该函数要求的
    // `dsh web: ` 前缀同时充当文档——提醒读者 token 来自 stdout 的启动行。
    let endpoint = match dsh_host::token::parse_launch_line(&format!("dsh web: {url}/?token={token}")) {
        Some(endpoint) => endpoint,
        None => panic!("cannot parse {url}/?token=<redacted>"),
    };
    let found = dsh_host::quit_probe::inspect_quit(&endpoint);
    eprintln!("[live] url={url} verdict={found:?}");
    // 唯一硬断言：必须拿到**确定性**答案。Unknown 意味着通道没打通（握手 / 围栏 /
    // chunked 响应任一环节断了），而那正是本探针存在的理由。
    assert_ne!(
        found,
        dsh_host::quit_probe::QuitInspection::Unknown,
        "the shell could not read the Harness session roster — see the three pitfalls in this file's module doc"
    );
}
