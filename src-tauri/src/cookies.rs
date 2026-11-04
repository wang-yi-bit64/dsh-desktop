//! Cookie 清理（任务 1.5，对齐原仓库 `window-navigation.ts` 的 431 防护）。
//!
//! 问题：harness 的 `dsh-auth-*` cookie 按 `127.0.0.1` 域存储（端口无关），
//! 每次重启换端口就多一枚，最终请求头膨胀到 Node 返回 **HTTP 431**。
//! 原仓库在每次重启导航前主动清理陈旧 cookie。
//!
//! # 实现与可观测性（CD01：不许伪造回执）
//!
//! 只有一条路径：向当前页面 `eval` 一段脚本，把 `prefix*` cookie 逐条置为过期。
//! `WebviewWindow::eval` 是**单向投递**——它只把脚本交给 webview，不回传执行
//! 结果，因此「实际删了几条」在本实现里**不可观测**。`CookieCleanup::removed`
//! 据此是 `Option<usize>`：
//!
//! * `None` —— 脚本已投递，但删除条数不可观测（当前实现的**唯一**产出）；
//! * `Some(n)` —— 留给真正可观测的实现（Windows `ICoreWebView2CookieManager`
//!   `GetCookies` 枚举，或脚本 + IPC 回传），本仓库尚未落地。
//!
//! `eval_with_callback` 看似能观测，但它依赖页面侧 `__TAURI_INTERNALS__` IPC：
//! harness 是**远程源**、没有 remote capability（任务 1.4），而清理发生在导航到
//! 该源**之前**，回调还会与随后的 `navigate` 抢时序 ⇒ 不采用。
//!
//! 唯一能确定区分的是「投递失败」：`eval` 返回 `Err` 时清理必然没发生，调用方
//! 拿到 `Err`，而不是一条伪造成 `removed: 0` 的假回执。

use serde::Serialize;
use tauri::{Runtime, WebviewWindow};

/// 清理结果（记日志用）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct CookieCleanup {
    /// 观测到的删除条数。
    ///
    /// 三种语义**不可互换**：`None` = 不知道（脚本已投递但结果不可观测），
    /// `Some(0)` = 观测到确实没有陈旧 cookie，`Some(n)` = 观测到并删了 n 条。
    /// 旧实现把「不知道」写成 `0`，正是 CD01。
    pub removed: Option<usize>,
    /// 本次是否走平台 cookie 桥接（如 WebView2 `CookieManager`）。
    /// 当前只有 JS `eval` 一条路径 ⇒ 恒为 `false`。
    pub bridged: bool,
}

/// 脚本投递的注入点。
///
/// 生产实现就是 [`WebviewWindow`]；测试用假实现模拟 `eval` 失败——真实失败
/// 场景（webview 已销毁、分发器关闭）无法在单测里稳定构造，只能注入。
trait ScriptSink {
    /// 把脚本投递给页面。`Err` = 投递失败（清理必然没发生）。
    fn dispatch(&self, script: &str) -> Result<(), String>;
}

impl<R: Runtime> ScriptSink for WebviewWindow<R> {
    fn dispatch(&self, script: &str) -> Result<(), String> {
        self.eval(script).map_err(|error| error.to_string())
    }
}

/// 清理 `127.0.0.1` 域下所有 `prefix*` cookie（在导航到 harness 之前调用）。
///
/// # 参数
///
/// * `webview` — 主窗口。
/// * `prefix` — cookie 名前缀（契约上为 `dsh-auth-`）。
///
/// # 返回
///
/// * `Err(..)` —— 脚本没投递出去，清理**没有发生**；
/// * `Ok(CookieCleanup { removed: None, .. })` —— 脚本已投递，删除条数不可观测。
///
/// 绝不返回 `removed: Some(0)` 去冒充「一条都没删」。
pub fn clear_auth_cookies<R: Runtime>(
    webview: &WebviewWindow<R>,
    prefix: &str,
) -> Result<CookieCleanup, String> {
    clear_with_sink(webview, prefix)
}

/// [`clear_auth_cookies`] 的实现体，依赖注入点而非具体 webview。
fn clear_with_sink<S: ScriptSink>(sink: &S, prefix: &str) -> Result<CookieCleanup, String> {
    sink.dispatch(&expire_cookies_script(prefix))
        .map_err(|error| format!("cookie cleanup script dispatch failed: {error}"))?;

    Ok(CookieCleanup {
        removed: None,
        bridged: false,
    })
}

/// 生成「逐条让 `prefix*` cookie 过期」的脚本。
fn expire_cookies_script(prefix: &str) -> String {
    format!(
        r#"(function() {{
            try {{
                var prefix = "{prefix}";
                var cookies = document.cookie ? document.cookie.split(';') : [];
                for (var i = 0; i < cookies.length; i++) {{
                    var cookie = cookies[i].trim();
                    var eqPos = cookie.indexOf('=');
                    var name = eqPos > -1 ? cookie.substr(0, eqPos) : cookie;
                    if (name.indexOf(prefix) === 0) {{
                        document.cookie = name + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;';
                        document.cookie = name + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=127.0.0.1;';
                        document.cookie = name + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=localhost;';
                    }}
                }}
            }} catch(e) {{}}
        }})();"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 投递成功：脚本进页面，但结果没有任何回程通道。
    struct OkSink;

    impl ScriptSink for OkSink {
        fn dispatch(&self, _script: &str) -> Result<(), String> {
            Ok(())
        }
    }

    /// 注入失败夹具：`eval` 必然报错（模拟 webview 已销毁 / 分发器关闭）。
    struct FailingSink;

    impl ScriptSink for FailingSink {
        fn dispatch(&self, _script: &str) -> Result<(), String> {
            Err("webview dispatcher is closed".to_string())
        }
    }

    /// 捕获投递内容，断言脚本真的针对 prefix。
    struct CapturingSink(std::cell::RefCell<String>);

    impl ScriptSink for CapturingSink {
        fn dispatch(&self, script: &str) -> Result<(), String> {
            *self.0.borrow_mut() = script.to_string();
            Ok(())
        }
    }

    #[test]
    fn cleanup_report_serializes() {
        let report = CookieCleanup {
            removed: Some(3),
            bridged: true,
        };
        let json = serde_json::to_value(report).unwrap();
        assert_eq!(json["removed"], 3);
        assert_eq!(json["bridged"], true);
    }

    /// CD01 硬要求①：`None` 与 `Some(0)` 在序列化后必须**可区分**。
    /// `Option` 的 `None` 序列化为 `"removed": null`（键仍在），与字段缺失不同，
    /// 也与 `Some(0)` 的 `0` 不同。
    #[test]
    fn unobserved_and_observed_zero_are_distinguishable_in_json() {
        let unobserved = serde_json::to_value(CookieCleanup {
            removed: None,
            bridged: false,
        })
        .unwrap();
        let observed_zero = serde_json::to_value(CookieCleanup {
            removed: Some(0),
            bridged: false,
        })
        .unwrap();

        assert!(
            unobserved.get("removed").is_some(),
            "键必须存在（缺失≠null）：{unobserved}"
        );
        assert!(
            unobserved["removed"].is_null(),
            "None 必须是 null：{unobserved}"
        );
        assert_eq!(observed_zero["removed"], 0, "观测到 0 条必须是 0");
        assert_ne!(
            unobserved["removed"], observed_zero["removed"],
            "未观测 ≠ 观测到 0 条"
        );
    }

    /// 注入 eval 失败 ⇒ 返回 `Err`，而不是伪造 `removed: Some(0)` 的成功。
    #[test]
    fn dispatch_failure_is_reported_not_faked_as_zero() {
        let outcome = clear_with_sink(&FailingSink, "dsh-auth-");
        let success = clear_with_sink(&OkSink, "dsh-auth-").expect("投递成功");

        assert!(
            outcome.is_err(),
            "投递失败必须报错，而不是伪造回执：{outcome:?}"
        );
        // 失败路径与成功路径的返回值必须不同（这正是旧实现丢掉的信息）。
        assert_ne!(outcome, Ok(success), "失败与成功不得返回同一份回执");

        let error = outcome.unwrap_err();
        assert!(
            error.contains("webview dispatcher is closed"),
            "错误必须带上底层原因：{error}"
        );
        assert!(
            error.contains("dispatch failed"),
            "错误必须能识别为投递失败：{error}"
        );
    }

    #[test]
    fn successful_dispatch_reports_unobservable_not_zero() {
        let report = clear_with_sink(&OkSink, "dsh-auth-").expect("投递成功");
        assert_eq!(
            report.removed, None,
            "eval 无回程通道 ⇒ 只能报不可观测，不得报 0"
        );
        assert!(!report.bridged, "当前实现没有平台 cookie 桥接");
    }

    #[test]
    fn script_targets_prefixed_cookies() {
        let sink = CapturingSink(std::cell::RefCell::new(String::new()));
        clear_with_sink(&sink, "dsh-auth-").expect("投递成功");
        let script = sink.0.borrow().clone();

        assert!(
            script.contains("var prefix = \"dsh-auth-\";"),
            "脚本必须带上前缀：{script}"
        );
        assert!(
            script.contains("expires=Thu, 01 Jan 1970"),
            "必须把命中项置为过期：{script}"
        );
        assert!(script.contains("path=/"), "过期必须落在根路径：{script}");
    }
}
