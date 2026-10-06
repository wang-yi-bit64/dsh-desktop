//! 退出守卫：退出前问 Harness「现在有没有会话在跑」，问完弹模态确认。
//!
//! # 为什么需要
//!
//! 关窗即隐藏（批次 0.2-B1）之后，**窗口里看得见的会话不会因为关窗而中断**——但
//! 「退出」会真停机。用户习惯性点 Quit 时，很可能里边还有一个 agent 在跑。上游桌面端
//! 为此向私有 Host 发 IPC 问一次；本仓没有 Node IPC，但有一条**已鉴权的 HTTP/RPC**
//! 通道，于是落到 [`dsh_host::quit_probe`]（读 `session/list` 的 `running` 字段，
//! 那是 Harness 自己的权威判断）。
//!
//! # 三条语义（缺一不可）
//!
//! 1. **问不出来 = 有工作**。握手失败 / 端点不可达 / 响应形状变了都是
//!    [`QuitInspection::Unknown`]，一律按"会打断"处理——绝不在未知时静默退出。
//! 2. **Harness 没在跑 = 直接放行**。那时没有任何可打断的东西（`launch_endpoint()` 为
//!    `None`），不做无意义的探测、不弹框。
//! 3. **退出永远可行**：模态框本身就是用户的显式答复——"退出"放行，"取消"留下。
//!    探测与对话框是两条独立路径，任何一条出错都不会把用户锁在进程里。
//!
//! # 为什么现在有 `tauri-plugin-dialog` 了
//!
//! 本仓曾因 `directory_picker_open`（已删除）短暂依赖该插件，随后摘除，AGENTS.md 里
//! 因此长期写着"刻意不引入 dialog 依赖"。2026-10-05 该结论被修订：退出确认是**真实
//! 的、必须二选一的产品语义**（"要不要中断正在跑的会话"），而此前用"第二次显式退出
//! 强制生效"的计数器来近似它——那是个 hack：用户第一次点 Quit 时看到的不是选择，
//! 而是一次"没反应 + 窗口被弹回来"。现在改成原生模态框，计数器随之删除。

use std::sync::Arc;

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::DialogExt;

use dsh_host::quit_probe::QuitInspection;

use crate::state::AppState;

/// 一次退出的裁决。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QuitDecision {
    /// 可以退（没有活动工作，或用户在模态框里选了「退出」）。
    Proceed,
    /// 用户取消了，或探测后决定不打断（未弹框的场景由调用方自行处理）。
    Cancelled,
}

impl QuitDecision {
    /// 是否放行这次退出。
    pub fn is_proceed(self) -> bool {
        matches!(self, Self::Proceed)
    }
}

/// 判断这次显式退出是否放行；需要打断时会弹模态框问用户。
///
/// # 参数
///
/// * `app` — 应用句柄（取状态、唤回窗口、弹框）。
/// * `force` — 调用方已经自己确认过（例如崩溃恢复的退出路径），跳过检查直接放行。
///
/// # 形态
///
/// * `force` → 直接放行（不探测、不弹框）。
/// * 拿不到应用状态 / Harness 没在跑 → 直接放行（语义 2）。
/// * 探测到 `NoWork` → 直接放行。
/// * 探测到 `Work` / `Unknown` → 弹模态框；"退出"放行，"取消"返回 [`QuitDecision::Cancelled`]。
pub async fn decide<R: Runtime>(app: &AppHandle<R>, force: bool) -> QuitDecision {
    if force {
        return QuitDecision::Proceed;
    }
    let Some(state) = app.try_state::<Arc<AppState>>() else {
        // 应用状态都还没就绪：此时不可能有用户会话在跑。
        return QuitDecision::Proceed;
    };

    // 语义 2：Harness 没在跑 → 没有可打断的东西。
    let Some(endpoint) = state.supervisor.launch_endpoint() else {
        return QuitDecision::Proceed;
    };

    match dsh_host::quit_probe::inspect_quit(&endpoint) {
        QuitInspection::NoWork => {
            log::info!("quit inspection: no running session; quitting proceeds");
            QuitDecision::Proceed
        }
        QuitInspection::Work { sessions } => {
            log::warn!("quit inspection: {sessions} session(s) running; asking the user");
            confirm(app, &prompt_running(sessions)).await
        }
        QuitInspection::Unknown => {
            log::warn!("quit inspection: roster unreadable; asking the user before interrupting");
            confirm(app, PROMPT_UNKNOWN).await
        }
    }
}

/// 弹一次模态确认；用户选「退出」才放行。
///
/// 弹框前先把主窗口唤回来：关窗即隐藏意味着窗口可能根本不在屏幕上，用户需要看见
/// 「到底哪个会话在跑」再做决定。弹框失败（无窗口系统）时按**取消**处理——
/// 宁可让用户再点一次 Quit，也不在没有明确答复的情况下停机。
async fn confirm<R: Runtime>(app: &AppHandle<R>, message: &str) -> QuitDecision {
    crate::window::reveal_main_window(app);
    let quit = app
        .dialog()
        .message(message)
        .title("Quit DSH Desktop?")
        .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancel)
        .kind(tauri_plugin_dialog::MessageDialogKind::Warning);
    if quit.blocking_show() {
        QuitDecision::Proceed
    } else {
        log::info!("quit cancelled by the user; the shell keeps running");
        QuitDecision::Cancelled
    }
}

/// 「有 N 个会话在跑」的正文。`sessions` 为 0 表示"问不出来"（走 [`PROMPT_UNKNOWN`]）。
fn prompt_running(sessions: usize) -> String {
    if sessions == 0 {
        return PROMPT_UNKNOWN.to_string();
    }
    format!(
        "{sessions} session(s) are still running in Harness. Quitting stops them.\n\n\
         Choose \"Quit\" to stop anyway, or \"Cancel\" to go back."
    )
}

/// 探测不出结论时的正文：宁可多问一次，也不在未知时静默停机。
const PROMPT_UNKNOWN: &str = "Harness is still running, but the shell could not read its session \
     list — some work may be in progress.\n\nChoose \"Quit\" to stop anyway, or \"Cancel\" to \
     go back and check.";

#[cfg(test)]
mod tests {
    use super::*;

    /// 文案必须随会话数变化，且 N=0 不得出现"0 session(s)"这种可笑文案
    /// （N=0 在 `Unknown` 路径上被复用，走专用文案）。
    #[test]
    fn prompt_text_tracks_session_count() {
        assert_eq!(prompt_running(0), PROMPT_UNKNOWN);
        let one = prompt_running(1);
        assert!(one.contains("1 session(s) are still running"), "{one}");
        let many = prompt_running(3);
        assert!(many.contains("3 session(s) are still running"), "{many}");
        // 三种情形两两不同。
        assert_ne!(one, many);
    }

    /// 只放行"确认退出"：取消不是放行。这条钉住 `is_proceed` 的判据本身——
    /// 调用方（菜单 / 命令）据此决定是否继续 `shutdown()`，判反了就是"点了取消也退出"。
    #[test]
    fn only_confirmation_proceeds() {
        assert!(QuitDecision::Proceed.is_proceed());
        assert!(!QuitDecision::Cancelled.is_proceed());
        assert_ne!(QuitDecision::Proceed, QuitDecision::Cancelled);
    }
}
