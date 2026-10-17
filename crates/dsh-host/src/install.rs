//! 安装形态判定：当前可执行文件是**安装器落盘的安装版**，还是**用户解压的便携版**。
//!
//! # 为什么这段逻辑在无头 crate 里
//!
//! 判据是纯 `std::path` 运算，不碰 Tauri、不碰窗口系统 ⇒ 按 `AGENTS.md` §3 的
//! 分流判据（「能不能在没有窗口系统的机器上被测试？」）它属于 `dsh-host`。
//! 放在 `src-tauri` 的代价是**测试只能在 CI 跑**：本机 GNU 工具链加载不了壳层
//! 测试二进制（`docs/incidents/local-toolchain-limits.md`），等于这条判据在本地
//! 无法被证伪——而它恰好是 2026-10-17 事故的现场。
//!
//! # 判据为什么不能是「路径里有没有 `Program Files`」
//!
//! 原实现用 `app.path().executable_dir()` 取「exe 所在目录」，再匹配路径字符串。
//! 但 `executable_dir()` 的语义是**用户的可执行文件目录**（类 Unix 的
//! `~/.local/bin`），`tauri` 直接转调 `dirs`：
//!
//! - `tauri-2.12.0/src/path/desktop.rs`：`dirs::executable_dir().ok_or(Error::UnknownPath)`
//! - `dirs-7.0.0/src/win.rs` / `src/mac.rs`：`pub fn executable_dir() -> Option<PathBuf> { None }`
//!
//! 于是 Windows / macOS 上恒定取不到值，调用方的 `.unwrap_or(true)` 兜底把它判成
//! 「便携版」——**装在 `Program Files` 的 NSIS 安装版同样被判成便携版**：自动更新
//! 轮询从不启动，更新页永远显示「便携版不检查更新」。路径字符串还有第二个坑：
//! `bundle.windows.nsis.installMode = "both"` 允许「仅为我安装」，其落点
//! （`%LOCALAPPDATA%\...`）本来就不含 `Program Files`，即便取对了目录也会误判。
//!
//! 现在只认**正向信号**：卸载器文件 / `.app` 结构。
//!
//! # 已知边界（刻意接受，不要当成缺陷）
//!
//! Linux 的 `deb` 与 AppImage 都不写 `uninstall.exe`（卸载由包管理器负责），因此
//! 归为 [`InstallMode::Portable`]、不轮询自动更新。这与修复前的实际行为一致
//! （那条路径在 Linux 上同样恒返回 `true`）；单独支持 AppImage 自更新属另一件事。

use std::path::Path;

use serde::Serialize;

/// NSIS 安装器写在安装目录里的卸载器文件名。
///
/// `installMode` 取 `both` 时，per-machine 与 per-user 两种落点都会写它——
/// 这正是它比「安装目录叫什么」可靠的**唯一**理由。
pub const UNINSTALLER_NAME: &str = "uninstall.exe";

/// 安装形态：**正向判据**得出的结论，不是对路径形态的猜测。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallMode {
    /// 由安装器落盘：NSIS 安装目录（任何落点）或 macOS `.app` 包。
    Installed,
    /// 便携 zip / 开发构建：既没有卸载器，也没有 `.app` 结构。
    Portable,
    /// 取不到自身路径。**不得**静默按便携处理（`AGENTS.md` §7.1 规则 3）。
    Unknown,
}

impl InstallMode {
    /// 线上名（与 `src-tauri/frontend/updates.html` 的判据同源；改这里必须同步那边）。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Installed => "installed",
            Self::Portable => "portable",
            Self::Unknown => "unknown",
        }
    }

    /// 该形态是否具备「由 updater 自己替换自己」的落点。
    ///
    /// 只有安装版有：便携版没有卸载器/安装器，取不到 NSIS passive-update 的落点。
    pub fn is_self_updatable(self) -> bool {
        matches!(self, Self::Installed)
    }
}

/// 由 exe 路径判定安装形态（纯函数：不读环境、不碰全局状态，便于夹具）。
///
/// 判据按顺序：
/// 1. **macOS `.app` 结构**（`X.app/Contents/MacOS/<exe>`）⇒ 安装版。`dmg` 装出来的
///    就是这个形态，updater 替换的是整个 bundle。
/// 2. **exe 同目录存在 `uninstall.exe`** ⇒ 安装版。NSIS 必写该文件，且与落点无关。
/// 3. 其余 ⇒ 便携版：便携 zip 只装 `target/release` 的 app 目录，不含卸载器；
///    开发构建（`cargo build` 产物）同理。
///
/// 路径没有父目录时返回 [`InstallMode::Unknown`]——「取不到」与「取到且不是安装版」
/// 必须可区分，否则调用方又会退化成静默兜底。
pub fn classify(exe: &Path) -> InstallMode {
    let Some(dir) = exe.parent() else {
        return InstallMode::Unknown;
    };
    if is_macos_app_bundle(exe) || dir.join(UNINSTALLER_NAME).is_file() {
        return InstallMode::Installed;
    }
    InstallMode::Portable
}

/// 当前进程的安装形态。
///
/// 取不到自身路径时返回 `Err`，由调用方决定如何降级并**记账**——本函数不替它
/// 决定「未知就当便携」。
///
/// # Errors
///
/// `std::env::current_exe()` 失败（进程映像不可解析）时返回其 `io::Error`。
pub fn classify_current() -> std::io::Result<InstallMode> {
    Ok(classify(&std::env::current_exe()?))
}

/// exe 是否位于 `<name>.app/Contents/MacOS/` 内（macOS 安装形态）。
///
/// 做成纯路径判断而非 `#[cfg(target_os = "macos")]`：这样 Windows / Linux 上的
/// 测试与 CI 也能用夹具覆盖 macOS 分支，不必等 macOS runner。
fn is_macos_app_bundle(exe: &Path) -> bool {
    let Some(macos) = exe.parent() else {
        return false;
    };
    let Some(contents) = macos.parent() else {
        return false;
    };
    let Some(bundle) = contents.parent() else {
        return false;
    };
    macos.file_name().is_some_and(|name| name == "MacOS")
        && contents.file_name().is_some_and(|name| name == "Contents")
        && bundle
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("app"))
}

#[cfg(test)]
mod tests {
    use std::fs::{create_dir_all, write};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    /// 每次调用得到一个独立目录；不引入 `tempfile`（本 crate 没有该 dev-dependency）。
    fn scratch_dir(label: &str) -> PathBuf {
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "dsh-install-mode-{}-{}-{label}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    /// 清理夹具；失败不影响判定（临时目录由系统回收）。
    fn cleanup(dir: &Path) {
        let _ = std::fs::remove_dir_all(dir);
    }

    /// 安装形态只认**正向信号**，与安装目录叫什么无关。
    ///
    /// 可证伪性：把判据改回修复前的形态（「父目录含 `Program Files`，否则按便携」），
    /// `per_user` 与 `portable` 两条断言立刻变红——旧判据对 per-user 落点与便携
    /// 目录**给出同一个答案**，这正是 2026-10-17 缺陷的可复现形态。
    #[test]
    fn install_mode_follows_positive_signals() {
        let root = scratch_dir("install-signals");
        // 安装版：per-machine 落点（旧判据在这里**碰巧**能过，所以它不是有效判据）
        let machine = root.join("Program Files").join("DSH Desktop");
        // 安装版：per-user 落点（`installMode: "both"`，旧判据在这里必然判错）
        let per_user = root
            .join("AppData")
            .join("Local")
            .join("Programs")
            .join("DSH Desktop");
        // 便携版：用户手动解压的目录
        let portable = root.join("Downloads").join("DSH-Desktop-portable");
        for dir in [&machine, &per_user, &portable] {
            create_dir_all(dir).expect("create fixture dir");
        }
        for dir in [&machine, &per_user] {
            write(dir.join(UNINSTALLER_NAME), b"MZ").expect("write uninstaller");
        }

        assert_eq!(
            classify(&machine.join("dsh-desktop.exe")),
            InstallMode::Installed
        );
        assert_eq!(
            classify(&per_user.join("dsh-desktop.exe")),
            InstallMode::Installed
        );
        // 便携 zip 只装 `target/release` 的 app 目录，不带任何卸载器。
        assert_eq!(
            classify(&portable.join("dsh-desktop.exe")),
            InstallMode::Portable
        );
        cleanup(&root);
    }

    /// macOS 的 `.app` 结构即安装形态：`dmg` 装出来的目录里没有 `uninstall.exe`。
    #[test]
    fn macos_app_bundle_counts_as_installed() {
        let root = scratch_dir("app-bundle");
        let macos = root.join("DSH Desktop.app").join("Contents").join("MacOS");
        create_dir_all(&macos).expect("create bundle dir");
        assert_eq!(classify(&macos.join("dsh-desktop")), InstallMode::Installed);

        // 负例：路径里含 `Contents/MacOS` 但外层不是 `.app` ⇒ 不得误判为安装版。
        let loose = root.join("Contents").join("MacOS");
        create_dir_all(&loose).expect("create loose dir");
        assert_eq!(classify(&loose.join("dsh-desktop")), InstallMode::Portable);
        cleanup(&root);
    }

    /// 「取不到路径」必须与「取到且不是安装版」可区分。
    #[test]
    fn unknown_is_reserved_for_unresolvable_paths() {
        assert_eq!(classify(Path::new("")), InstallMode::Unknown);
        // 相对路径有父目录（空路径），因此落到「无卸载器 ⇒ 便携」这一支。
        assert_eq!(classify(Path::new("dsh-desktop")), InstallMode::Portable);
    }

    /// 线上名与自更新判定是前后端契约：`updates.html` 按这三个字符串分派，改名即断线。
    #[test]
    fn wire_names_and_updatable_flag_are_stable() {
        for (mode, wire, updatable) in [
            (InstallMode::Installed, "\"installed\"", true),
            (InstallMode::Portable, "\"portable\"", false),
            (InstallMode::Unknown, "\"unknown\"", false),
        ] {
            assert_eq!(serde_json::to_string(&mode).unwrap(), wire);
            assert_eq!(format!("\"{}\"", mode.as_str()), wire);
            assert_eq!(mode.is_self_updatable(), updatable);
        }
    }
}
