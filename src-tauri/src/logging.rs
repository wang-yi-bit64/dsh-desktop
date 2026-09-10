//! 桌面壳层结构化日志接线（`tauri-plugin-log`）。
//!
//! 与宿主面日志的分工：
//!
//! | 文件 | 生产者 | 内容 |
//! |---|---|---|
//! | `harness.log` | `dsh_host::logs::LogRing` | Harness 子进程 stdout/stderr |
//! | `app.log` | `dsh_host::logging` | 宿主面事件（派生、就绪、退出） |
//! | `desktop.log` | 本模块 | **壳自身**：启动、导航、菜单动作、panic |
//!
//! # INV-1 约束
//!
//! 落盘目录必须取 [`dsh_host::paths::Layout::app_data_dir`]，
//! **不得**改用 `TargetKind::LogDir`：后者映射到平台日志根目录
//! （Windows 为 `LocalAppData`），与 Tauri 的 `app_data_dir`
//! （`RoamingAppData`）不是同一棵树，会把可变状态写到应用数据目录之外。
//!
//! # 为什么在 `setup` 里注册而不是在 Builder 链上
//!
//! 日志目录来自 [`crate::layout::resolve_layout`]，它需要 `AppHandle` 才能解析
//! 出 `app_data_dir`；`setup` 是能同时拿到 `AppHandle` 与解析结果的最早点。

use tauri::Runtime;
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

use dsh_contracts::{DESKTOP_LOG_FILE, DESKTOP_LOG_MAX_BYTES, DESKTOP_LOG_ROTATIONS};

// 契约值必须在编译期就满足轮转前提：上限 > 0 且保留份数 ≥ 1，否则
// `tauri-plugin-log` 的 RotatingFile 会在运行期才报错（那时已无从补救）。
const _: () = assert!(DESKTOP_LOG_MAX_BYTES > 0);
const _: () = assert!(DESKTOP_LOG_ROTATIONS >= 1);

/// 注册桌面壳层日志插件。
///
/// # 参数
///
/// * `app` — 应用句柄，用于动态注册插件。
/// * `log_dir` — 落盘目录，必须来自 [`dsh_host::paths::Layout::app_data_dir`]。
///
/// # 返回
///
/// 插件注册失败时返回 Tauri 错误（通常意味着重复注册）。
///
/// 日志同时写文件与 stdout：GUI 发布版看不到 stdout，但开发内环与 CI 烟雾测试
/// 依赖它（见 `scripts/smoke-launch.mjs`）。
pub fn init<R: Runtime>(app: &tauri::AppHandle<R>, log_dir: &std::path::Path) -> tauri::Result<()> {
    let file_target = Target::new(TargetKind::Folder {
        path: log_dir.to_path_buf(),
        file_name: Some(DESKTOP_LOG_FILE.to_string()),
    });

    app.plugin(
        tauri_plugin_log::Builder::new()
            .targets([file_target, Target::new(TargetKind::Stdout)])
            .level(log::LevelFilter::Info)
            .max_file_size(DESKTOP_LOG_MAX_BYTES)
            .rotation_strategy(RotationStrategy::KeepSome(DESKTOP_LOG_ROTATIONS))
            .timezone_strategy(TimezoneStrategy::UseLocal)
            .build(),
    )
}

#[cfg(test)]
mod tests {
    /// 日志文件名必须带 `.log` 后缀：轮转实现据此派生历史文件名。
    #[test]
    fn desktop_log_file_has_log_suffix() {
        assert!(dsh_contracts::DESKTOP_LOG_FILE.ends_with(".log"));
    }
}
