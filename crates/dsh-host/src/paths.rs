//! 目录布局解析（契约 C8）。
//!
//! 不变量 **INV-1（资源只读）**：`resource_dir` 下的一切在运行时零写入，
//! 所有可变状态（DSH_HOME、launch-root、日志、pidfile）都落在
//! `app_data_dir`（userData）。本模块是这条不变量的唯一实现点。
//!
//! 资源目录布局（由 `scripts/prepare-harness.mjs` 产出）：
//!
//! ```text
//! <resource_dir>/
//!   node/node(.exe)                       捆绑的 Node.js 运行时
//!   harness-node-entry.mjs                Node 包装入口
//!   windows-child-process-hide.mjs        包装入口的兄弟文件
//!   dsh-desktop.patch.yml                 --patch 层
//!   MANIFEST.json                         组装清单（任务 0.3）
//!   harness/node_modules/...              完整 @deepseek-ai/dsh 依赖树
//! ```
//!
//! userData 布局：
//!
//! ```text
//! <app_data_dir>/
//!   harness/              DSH_HOME：profiles / sessions / settings / credentials
//!   launch-root/          子进程 cwd（同时存放 harness.pid）
//!   logs/harness.log      Harness 诊断日志（滚动）
//!   logs/app.log          宿主应用日志（阶段 2 引入）
//! ```

use std::path::{Path, PathBuf};

use crate::contracts::{
    DSH_ENTRY_RELATIVE, DSH_HOME_DIR, HARNESS_LOG_FILE, HARNESS_MODULES_DIR, LAUNCH_ROOT_DIR,
    LOG_DIR, MANIFEST_FILE, NODE_ENTRY_FILE, NODE_RESOURCE_DIR, PATCH_FILE, PID_FILE,
    WINDOWS_HIDE_FILE,
};

/// 一次启动所需的全部路径。
///
/// 该结构在启动早期一次性解析完成，之后只读传递，避免各处自行拼路径导致
/// 「写到了资源目录」这类 INV-1 违规。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Layout {
    /// 只读的捆绑资源目录（`resource_dir()`）。
    pub resource_dir: PathBuf,
    /// 可写的用户数据目录（`app_data_dir()`）。
    pub app_data_dir: PathBuf,
    /// 捆绑的 Node.js 可执行文件。
    pub node_executable: PathBuf,
    /// Node 包装入口（`harness-node-entry.mjs`）。
    pub node_entry: PathBuf,
    /// Windows 子进程窗口隐藏补丁（包装入口的兄弟文件）。
    pub windows_hide_entry: PathBuf,
    /// Harness CLI 入口（`<dsh>/lib/bin.js`）。
    pub dsh_entry: PathBuf,
    /// 桌面 patch 层（`--patch` 参数值）。
    pub patch: PathBuf,
    /// 资源组装清单（运行时 warning 级校验用）。
    pub manifest: PathBuf,
    /// DSH_HOME：profiles / sessions / settings / credentials。
    pub dsh_home: PathBuf,
    /// 子进程工作目录（cwd），同时存放 `harness.pid`。
    pub launch_root: PathBuf,
    /// Harness 诊断日志落盘路径。
    pub log_path: PathBuf,
    /// 宿主应用日志落盘路径（阶段 2）。
    pub app_log_path: PathBuf,
    /// 陈旧进程清扫用的 pidfile。
    pub pid_file: PathBuf,
}

impl Layout {
    /// 由资源目录与 userData 目录推导出完整布局。
    ///
    /// # 参数
    ///
    /// * `resource_dir` — Tauri 的 `resource_dir()`（生产：安装目录内的资源区；
    ///   开发：`src-tauri/`）。只读。
    /// * `app_data_dir` — Tauri 的 `app_data_dir()`。可写。
    ///
    /// # 示例
    ///
    /// ```
    /// use std::path::Path;
    /// use dsh_host::paths::Layout;
    ///
    /// let layout = Layout::resolve(Path::new("/res"), Path::new("/data"));
    /// assert!(layout.dsh_home.ends_with("harness"));
    /// assert!(layout.app_data_dir == Path::new("/data"));
    /// ```
    pub fn resolve(resource_dir: impl AsRef<Path>, app_data_dir: impl AsRef<Path>) -> Self {
        let resource_dir = resource_dir.as_ref().to_path_buf();
        let app_data_dir = app_data_dir.as_ref().to_path_buf();

        let node_name = crate::contracts::node_binary_name();
        let modules = resource_dir.join(HARNESS_MODULES_DIR);

        Self {
            node_executable: resource_dir.join(NODE_RESOURCE_DIR).join(node_name),
            node_entry: resource_dir.join(NODE_ENTRY_FILE),
            windows_hide_entry: resource_dir.join(WINDOWS_HIDE_FILE),
            dsh_entry: modules.join(DSH_ENTRY_RELATIVE),
            patch: resource_dir.join(PATCH_FILE),
            manifest: resource_dir.join(MANIFEST_FILE),
            dsh_home: app_data_dir.join(DSH_HOME_DIR),
            launch_root: app_data_dir.join(LAUNCH_ROOT_DIR),
            log_path: app_data_dir.join(LOG_DIR).join(HARNESS_LOG_FILE),
            app_log_path: app_data_dir
                .join(LOG_DIR)
                .join(crate::contracts::APP_LOG_FILE),
            pid_file: app_data_dir.join(LAUNCH_ROOT_DIR).join(PID_FILE),
            resource_dir,
            app_data_dir,
        }
    }

    /// 依赖树根目录（`resources/harness/node_modules`）。
    pub fn modules_dir(&self) -> PathBuf {
        self.resource_dir.join(HARNESS_MODULES_DIR)
    }

    /// 创建所有可写目录（DSH_HOME / launch-root / logs）。
    ///
    /// 只创建 `app_data_dir` 下的目录——INV-1 的运行时体现。
    ///
    /// `logs` 目录显式创建（而不是靠 `LogFile::open` 顺手建父目录）：
    /// `app.log` 与 `harness.log` 两个消费者都依赖它，语义上它属于
    /// 「布局的一部分」，不该由某个写入方隐式补齐。
    pub fn ensure_dirs(&self) -> crate::HostResult<()> {
        create_dir(&self.dsh_home)?;
        create_dir(&self.launch_root)?;
        create_dir(&self.log_path.parent().unwrap_or(&self.app_data_dir))?;
        Ok(())
    }

    /// 列出缺失的必需资源条目（INV-1：资源缺失只能报错，不能就地生成）。
    ///
    /// 返回 `(契约名, 路径)` 列表；空向量表示资源齐备。
    pub fn missing_resources(&self) -> Vec<(&'static str, &Path)> {
        let required: [(&'static str, &Path); 4] = [
            ("node_executable", self.node_executable.as_path()),
            ("node_entry", self.node_entry.as_path()),
            ("dsh_entry", self.dsh_entry.as_path()),
            ("patch", self.patch.as_path()),
        ];
        required
            .into_iter()
            .filter(|(_, path)| !path.exists())
            .collect()
    }

    /// Unix 下为捆绑的 Node.js 二进制补上执行位。
    ///
    /// 资源解包（AppImage / tar / NSIS 之外的分发方式）可能丢掉执行位，
    /// 直接 spawn 会拿到 EACCES。Windows 无执行位概念，是空操作。
    pub fn ensure_exec_bits(&self) -> crate::HostResult<()> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for path in [&self.node_executable] {
                if path.exists() {
                    let mut permissions = std::fs::metadata(path)
                        .map_err(|error| crate::HostError::CreateDir(path.clone(), error))?
                        .permissions();
                    let mode = permissions.mode();
                    if mode & 0o111 == 0 {
                        permissions.set_mode(mode | 0o755);
                        std::fs::set_permissions(path, permissions)
                            .map_err(|error| crate::HostError::CreateDir(path.clone(), error))?;
                    }
                }
            }
        }
        Ok(())
    }
}

fn create_dir(path: &Path) -> crate::HostResult<()> {
    std::fs::create_dir_all(path)
        .map_err(|error| crate::HostError::CreateDir(path.to_path_buf(), error))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout(root: &Path) -> Layout {
        Layout::resolve(root.join("res"), root.join("data"))
    }

    #[test]
    fn derives_electron_compatible_layout() {
        let root = Path::new(if cfg!(windows) {
            "C:\\tmp\\dsh"
        } else {
            "/tmp/dsh"
        });
        let layout = layout(root);
        assert_eq!(layout.dsh_home, root.join("data").join("harness"));
        assert_eq!(layout.launch_root, root.join("data").join("launch-root"));
        assert_eq!(
            layout.log_path,
            root.join("data").join("logs").join("harness.log")
        );
        assert_eq!(
            layout.app_log_path,
            root.join("data").join("logs").join("app.log")
        );
        assert_eq!(
            layout.pid_file,
            root.join("data").join("launch-root").join("harness.pid")
        );
    }

    #[test]
    fn resources_stay_under_resource_dir() {
        let root = Path::new(if cfg!(windows) {
            "C:\\tmp\\dsh"
        } else {
            "/tmp/dsh"
        });
        let layout = layout(root);
        // INV-1：所有只读资源都在 resource_dir 下，所有可写路径都在 app_data_dir 下。
        for path in [
            &layout.node_executable,
            &layout.node_entry,
            &layout.dsh_entry,
            &layout.patch,
            &layout.manifest,
        ] {
            assert!(
                path.starts_with(&layout.resource_dir),
                "{path:?} 必须位于资源目录"
            );
        }
        for path in [
            &layout.dsh_home,
            &layout.launch_root,
            &layout.log_path,
            &layout.pid_file,
        ] {
            assert!(
                path.starts_with(&layout.app_data_dir),
                "{path:?} 必须位于 userData"
            );
        }
    }

    #[test]
    fn node_entry_points_at_wrapper() {
        let root = Path::new(if cfg!(windows) {
            "C:\\tmp\\dsh"
        } else {
            "/tmp/dsh"
        });
        let layout = layout(root);
        assert!(layout.node_entry.ends_with("harness-node-entry.mjs"));
        assert!(layout.dsh_entry.ends_with("@deepseek-ai/dsh/lib/bin.js"));
        assert!(layout.patch.ends_with("dsh-desktop.patch.yml"));
    }

    #[test]
    fn missing_resources_reports_every_absent_entry() {
        let root = Path::new(if cfg!(windows) {
            "C:\\tmp\\dsh-missing"
        } else {
            "/tmp/dsh-missing"
        });
        let layout = layout(root);
        let missing = layout.missing_resources();
        assert_eq!(
            missing.len(),
            4,
            "临时目录下四个必需资源都不存在：{missing:?}"
        );
        let names: Vec<&str> = missing.iter().map(|(name, _)| *name).collect();
        assert_eq!(
            names,
            vec!["node_executable", "node_entry", "dsh_entry", "patch"]
        );
    }

    #[test]
    fn ensure_dirs_creates_only_writable_tree() {
        let unique = format!(
            "dsh-host-paths-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or(0)
        );
        let root = std::env::temp_dir().join(unique);
        let layout = layout(&root);
        layout.ensure_dirs().expect("目录应可创建");
        assert!(layout.dsh_home.is_dir());
        assert!(layout.launch_root.is_dir());
        assert!(layout.log_path.parent().unwrap().is_dir());
        // INV-1：绝不创建资源目录。
        assert!(
            !layout.resource_dir.exists(),
            "ensure_dirs 不应创建资源目录"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn ensure_exec_bits_restores_missing_bits() {
        use std::os::unix::fs::PermissionsExt;

        let unique = format!("dsh-host-exec-{}", std::process::id());
        let root = std::env::temp_dir().join(unique);
        let layout = layout(&root);
        std::fs::create_dir_all(layout.node_executable.parent().unwrap()).unwrap();
        std::fs::write(&layout.node_executable, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(
            &layout.node_executable,
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();

        layout.ensure_exec_bits().expect("补执行位应成功");
        let mode = std::fs::metadata(&layout.node_executable)
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o111, 0o111, "执行位应已补上");

        let _ = std::fs::remove_dir_all(&root);
    }
}
