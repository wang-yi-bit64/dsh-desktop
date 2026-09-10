//! 往 Harness 页面注入壳层 UI 的「**preload 等价物**」。
//!
//! # 这个模块解决什么问题
//!
//! 上游（Electron）靠 `preload` 在 Harness 页里注入 UI 并接收状态推送。本仓早期
//! 据此记过一句「Tauri webview 没有 preload / 初始化脚本，因此无法复刻」——
//! **那句话是错的**，已在 `AGENTS.md` 更正。Tauri 的
//! [`WebviewWindowBuilder::initialization_script`] 会在每一次顶层文档导航之前执行
//! 脚本，与 `preload` 是同一类机制。
//!
//! 本模块负责这条链路的两半：
//!
//! | 半 | 载体 | 位置 |
//! |----|------|------|
//! | 注入（脚本进页面） | [`INJECT_SCRIPT`] | 主窗口 builder（`lib.rs`） |
//! | 推送（状态下发） | [`push_phone_status`] | 连接翻转 + 每次页面加载完成 |
//!
//! # 为什么用 `eval` 推送，而不是开一个命令
//!
//! Harness 页是一个**远程 origin**（`http://127.0.0.1:<端口>`）。让它主动向壳层
//! 拉状态，就必须为它开一个 IPC 命令并在 capability 里放行该远程 origin——那是在
//! 扩大攻击面，而本仓的命令面是收紧的（`commands.rs` 里所有命令都有
//! `ensure_local_origin`，见 `AGENTS.md` §7）。
//!
//! 壳层 → 页面的方向不需要任何命令：`webview.eval()` 是单向的。因此这里采用
//! 「壳层推、页面不拉」，与上游从轮询改为推送的取舍一致。
//!
//! 代价是**推送时机必须自己补齐**——`eval` 只作用于当前文档，页面一旦导航（含
//! 刷新），上一次推的状态就没了。所以有两个推送点：
//!
//! 1. [`push_phone_status`] 在连接状态翻转时调用（`on_connected_change`）；
//! 2. 页面加载完成时补推一次当前状态（`on_page_load`，见 `lib.rs`）。
//!
//! # 脚本的早退保护
//!
//! [`INJECT_SCRIPT`] 会在**每一个**页面执行，包括壳层自己的本地页。脚本头部按
//! origin 自我早退（见其文件注释），而 [`phone_status_script`] 生成的调用带
//! `&&` 守卫，因此在没有注入过的页面里 eval 是**空操作**，不会抛错。

use tauri::{AppHandle, Runtime};

/// 注入脚本本体（编译期内嵌，不依赖运行时资源树）。
///
/// 放在 `frontend/` 下与其它页面代码同级便于对照阅读；用 `include_str!` 内嵌而非
/// 打进 `resources/`，是为了让「脚本缺失」这一类故障在**编译期**就暴露，
/// 而不是等运行时导航到 Harness 页才发现注入是空的。
pub const INJECT_SCRIPT: &str = include_str!("../frontend/harness-ui-inject.js");

/// 壳层调用注入脚本的全局入口名（与脚本内的 `GLOBAL_KEY` 必须一致）。
pub const GLOBAL_KEY: &str = "__dshDesktopPhone";

/// 生成一次「手机桥连接状态」推送脚本。
///
/// 带 `&&` 守卫：注入脚本在非 Harness 页会自我早退，此时全局入口不存在，
/// 表达式退化为空操作而不是 `TypeError`。
///
/// # 参数
///
/// * `connected` — 手机桥是否已连接。
///
/// # 返回值
///
/// 可直接交给 `webview.eval()` 的 JS 片段。
pub fn phone_status_script(connected: bool) -> String {
    format!("window.{GLOBAL_KEY}&&window.{GLOBAL_KEY}.setStatus({connected});")
}

/// 把手机桥连接状态推给 Harness 页面。
///
/// 页面尚未加载 / 已导航走 / 主窗口不存在时，`eval` 可能失败或落在错的文档上，
/// 这两种情况都**不是错误**：状态会在页面加载完成时由 `on_page_load` 补推。
/// 因此失败只记日志，不上抛。
///
/// # 参数
///
/// * `app` — 应用句柄。
/// * `connected` — 手机桥是否已连接。
pub fn push_phone_status<R: Runtime>(app: &AppHandle<R>, connected: bool) {
    let Some(webview) = crate::window::main_window(app) else {
        return;
    };
    if let Err(error) = webview.eval(phone_status_script(connected)) {
        log::debug!("phone status push skipped (page not ready): {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_script_calls_the_injected_entry_point() {
        let script = phone_status_script(true);
        assert!(
            script.contains(GLOBAL_KEY),
            "must target the injected global"
        );
        assert!(script.contains("setStatus(true)"), "must carry the payload");
    }

    #[test]
    fn status_script_guards_against_pages_without_injection() {
        // 本地页（splash / error / updates）不注入脚本，eval 必须退化为空操作；
        // 少了这个守卫就会在这些页面上抛 TypeError。
        let script = phone_status_script(false);
        assert!(
            script.starts_with("window.__dshDesktopPhone&&"),
            "guard must come first: {script}"
        );
    }

    #[test]
    fn injected_script_is_embedded_and_non_empty() {
        assert!(
            INJECT_SCRIPT.contains(GLOBAL_KEY),
            "embedded script must define the entry point the shell calls"
        );
        assert!(
            INJECT_SCRIPT.contains("data-dsh-sidebar-settings"),
            "embedded script must anchor on the Harness sidebar settings area"
        );
    }
}
