//! Tauri 路径 → [`dsh_host::paths::Layout`] 的适配层。
//!
//! dsh-host 不依赖 Tauri（INV-6），所以「Tauri 的 resource_dir / app_data_dir
//! 怎么来」这层胶水放在这里。同时处理开发内环的 **mock 模式**（ADR-2）：
//! 设 `DSH_MOCK=1` 后，node 包装入口与 dsh 入口都指向
//! `scripts/mock-harness.mjs`，`cargo tauri dev` 无需 300MB 真实依赖树即可
//! 跑通「splash → spawn → 就绪 → 导航」全链路。

use tauri::{Manager, Runtime};

use dsh_host::paths::Layout;

/// 解析应用布局。
///
/// # 参数
///
/// * `app` — Tauri AppHandle（提供 `resource_dir()` 与 `app_data_dir()`）。
pub fn resolve_layout<R: Runtime>(app: &tauri::AppHandle<R>) -> dsh_host::HostResult<Layout> {
    let resource_dir = app.path().resource_dir().map_err(|error| {
        dsh_host::HostError::MissingResource("resource_dir", format!("{error}").into())
    })?;
    let data_dir = app.path().app_data_dir().map_err(|error| {
        dsh_host::HostError::MissingResource("app_data_dir", format!("{error}").into())
    })?;

    // Tauri 2 的资源映射：tauri.conf.json 中的 "resources/…" 条目按相对路径
    // 原样安装（Windows 上 resource_dir() == exe 目录，资源实际位于
    // exe_dir/resources/ 下）。因此布局根优先取 resource_dir 的 resources
    // 子目录；个别平台布局不同（资源直接位于 resource_dir）时回退。
    let resource_root = {
        let joined = resource_dir.join("resources");
        if joined.join(dsh_host::contracts::NODE_ENTRY_FILE).exists() {
            joined
        } else {
            resource_dir
        }
    };

    let mut layout = Layout::resolve(resource_root, data_dir);
    if mock_enabled() {
        apply_mock(&mut layout);
    }
    Ok(layout)
}

/// mock 模式是否启用（开发内环，`DSH_MOCK=1`）。
pub fn mock_enabled() -> bool {
    std::env::var("DSH_MOCK")
        .map(|value| value == "1")
        .unwrap_or(false)
}

/// 把入口替换成 mock-harness（见 `scripts/mock-harness.mjs` 的契约说明）。
fn apply_mock(layout: &mut Layout) {
    // 开发态 resource_dir 是 `src-tauri/`，mock 脚本在仓库根 `scripts/` 下。
    let mock = layout
        .resource_dir
        .join("..")
        .join("scripts")
        .join("mock-harness.mjs");
    // canonicalize 会消解 `..`，但 Windows 上返回 `\\?\` verbatim 路径——node 的
    // CJS loader 无法把它当主入口（EISDIR lstat 'D:'），必须剥回普通盘符形式。
    let mock = dsh_host::paths::canonicalize_plain(&mock);

    // argv 变形为：node --expose-internals <mock> <mock> web --port N …
    // mock 只解析 `--port` / `--delay` / `--fail`，其余参数忽略。
    layout.node_entry = mock.clone();
    layout.dsh_entry = mock;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mock_flag_follows_environment() {
        // 只验证「读环境变量不 panic」；具体值取决于运行环境。
        let _ = mock_enabled();
    }

    #[test]
    fn mock_rewrites_entries_only() {
        let mut layout = Layout::resolve("/res", "/data");
        layout.dsh_home = std::path::PathBuf::from("/data/harness");
        apply_mock(&mut layout);
        // INV-1：mock 只替换入口，绝不触碰可写目录的推导。
        assert_eq!(layout.dsh_home, std::path::PathBuf::from("/data/harness"));
        assert!(layout.node_entry.ends_with("mock-harness.mjs"));
        assert!(layout.dsh_entry.ends_with("mock-harness.mjs"));
    }
}
