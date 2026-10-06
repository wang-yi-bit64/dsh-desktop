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
//!   dsh-desktop-safe.patch.yml            安全模式的 --patch 层（C10）
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
    DSH_ENTRY_RELATIVE, DSH_HOME_DIR, ENV_DSH_RUNNER, HARNESS_LOG_FILE, HARNESS_MODULES_DIR,
    LAUNCH_ROOT_DIR, LOG_DIR, MANIFEST_FILE, NODE_ENTRY_FILE, NODE_RESOURCE_DIR,
    OFFICE_SKILLS_DIR, PATCH_FILE, PID_FILE, PRIMARY_RUNTIME_DIR, PRIMARY_RUNTIME_ROOT,
    SAFE_PATCH_FILE, SIDECAR_RESOURCE_DIR, WINDOWS_HIDE_FILE,
};

/// 运行目标模式：支持传统的 Node + 模块树模式，或紧凑的 Sidecar 独立单二进制模式。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LaunchTarget {
    /// 传统 Node 模式（`node --expose-internals harness-node-entry.mjs ...`）
    Node {
        executable: PathBuf,
        node_entry: PathBuf,
        windows_hide_entry: PathBuf,
        dsh_entry: PathBuf,
        patch: PathBuf,
    },
    /// Sidecar 独立二进制模式（`dsh-sidecar[.exe] web --patch ...`）
    Sidecar {
        executable: PathBuf,
        patch: Option<PathBuf>,
    },
}

/// CX-17 — 载荷满足的档位。**只描述"这份载荷承诺了多少"，不改变壳的行为**：
/// 两个档位走同一条启用路径、注入同一个环境变量。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PayloadTier {
    /// 档1.5：解释器 + office skills + 校验脚本齐备 → 模型可创建/编辑 docx/pptx/xlsx。
    Authoring,
    /// 档2：档1.5 + site-packages 含上游工具描述承诺的 8 个库。
    FullToolchain,
}

impl PayloadTier {
    /// 供 MANIFEST / 日志使用的稳定标识。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Authoring => "authoring",
            Self::FullToolchain => "full-toolchain",
        }
    }
}

/// `dsh-skill-office` 会去读的三个 skill 目录名（`SKILLS` 的逐字镜像）。
const OFFICE_SKILLS: [&str; 3] = ["office-docx", "office-pptx", "office-xlsx"];

/// 上游工具描述承诺的 8 个分布名（`numpy`/`pandas`/`python-docx`/`python-pptx`/
/// `openpyxl`/`Pillow`/`lxml`/`XlsxWriter`）在 site-packages 下的**导入名**。分布名与
/// 导入名不一致（`python-docx`→`docx`、`Pillow`→`PIL`、`XlsxWriter`→`xlsxwriter`），
/// 这里必须用导入名——判据是"目录存在"，而目录名就是导入名。
const TOOLCHAIN_PACKAGES: [&str; 8] = [
    "numpy",
    "pandas",
    "docx",
    "pptx",
    "openpyxl",
    "PIL",
    "lxml",
    "xlsxwriter",
];

/// 在 `<python>/Lib`（Windows）或 `<python>/lib/pythonX.Y`（POSIX）下定位 site-packages。
///
/// 次版本号无法在常量里写死，因此 POSIX 侧按"`python3.*` 下取第一个目录名"解析；
/// 找不到就返回 `None`（档2 判为不满足，但仍保留档1.5）。
fn site_packages_dir(python_lib: &Path, windows: bool) -> Option<PathBuf> {
    if windows {
        let candidate = python_lib.join("site-packages");
        return candidate.is_dir().then_some(candidate);
    }
    let versioned = std::fs::read_dir(python_lib)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().starts_with("python"))
                .unwrap_or(false)
        })?;
    let candidate = versioned.join("site-packages");
    candidate.is_dir().then_some(candidate)
}

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
    /// 安全模式 patch 层（安全模式下替代 [`Layout::patch`]）。
    pub safe_patch: PathBuf,
    /// 独立单二进制/Sidecar 可执行文件路径（若存在）。
    pub sidecar_executable: PathBuf,
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
    /// 桌面壳层日志落盘路径（`desktop.log`，`tauri-plugin-log` 写入）。
    pub desktop_log_path: PathBuf,
    /// 陈旧进程清扫用的 pidfile。
    pub pid_file: PathBuf,
    /// CX-17 — primary runtime 载荷根（`<resource_dir>/runtime/primary-runtime`）。
    ///
    /// **只是路径推导，不保证存在**：载荷由 `scripts/prepare-primary-runtime.mjs`
    /// 在组装期放入，缺一块（python / pnpm / office skills 任一）就整个不落。要不要
    /// 因此启用 Harness 的 office / workspace-dependencies 两行，由
    /// [`Layout::primary_runtime`] 的存在性判定决定。
    pub primary_runtime_root: PathBuf,
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
        // Tauri 的 `resource_dir()` 来自 `current_exe().canonicalize()`，Windows 上
        // 因此带 `\\?\` verbatim 前缀。这些路径会拼进 node 的 argv（入口脚本、
        // `@deepseek-ai/dsh/lib/bin.js`），而 node 的 CJS loader 会把 verbatim
        // 路径还原成盘符 `D:` 后 lstat 抛 EISDIR。在这里统一剥掉前缀，保证
        // 布局中所有派生路径都是普通形式——这是唯一入口，改一处即可。
        let resource_dir = strip_verbatim_prefix(resource_dir.as_ref().to_path_buf());
        let app_data_dir = strip_verbatim_prefix(app_data_dir.as_ref().to_path_buf());

        let node_name = crate::contracts::node_binary_name();
        let sidecar_name = crate::contracts::sidecar_binary_name();
        let modules = resource_dir.join(HARNESS_MODULES_DIR);

        Self {
            node_executable: resource_dir.join(NODE_RESOURCE_DIR).join(node_name),
            node_entry: resource_dir.join(NODE_ENTRY_FILE),
            windows_hide_entry: resource_dir.join(WINDOWS_HIDE_FILE),
            dsh_entry: modules.join(DSH_ENTRY_RELATIVE),
            patch: resource_dir.join(PATCH_FILE),
            safe_patch: resource_dir.join(SAFE_PATCH_FILE),
            sidecar_executable: resource_dir.join(SIDECAR_RESOURCE_DIR).join(sidecar_name),
            manifest: resource_dir.join(MANIFEST_FILE),
            dsh_home: app_data_dir.join(DSH_HOME_DIR),
            launch_root: app_data_dir.join(LAUNCH_ROOT_DIR),
            log_path: app_data_dir.join(LOG_DIR).join(HARNESS_LOG_FILE),
            app_log_path: app_data_dir
                .join(LOG_DIR)
                .join(crate::contracts::APP_LOG_FILE),
            desktop_log_path: app_data_dir
                .join(LOG_DIR)
                .join(crate::contracts::DESKTOP_LOG_FILE),
            pid_file: app_data_dir.join(LAUNCH_ROOT_DIR).join(PID_FILE),
            primary_runtime_root: resource_dir
                .join(PRIMARY_RUNTIME_DIR)
                .join(PRIMARY_RUNTIME_ROOT),
            resource_dir,
            app_data_dir,
        }
    }

    /// CX-17 — 随包 primary runtime 载荷根与它满足的**档位**；不满足最低档位时 `None`。
    ///
    /// # 为什么是"完整才启用"而不是"存在就启用"
    ///
    /// Harness 那两个插件行（`skill-office` / `tool-workspace-dependencies`）一旦启用，
    /// 会**立刻**去 stat 载荷里的解释器、node、pnpm 与 office skills 资产，缺任何一个
    /// 都在 Host 启动期抛错——那等于"打了个残缺的包，应用起不来"。因此这里逐项检查
    /// 上游 `validatePayloadEntries` 关心的同一条清单，任何一项缺失就返回 `None`：
    /// 两行保持 disabled，Harness 正常启动（只是没有 office skills）。
    ///
    /// 检查项与上游逐字对应（`dsh-tool-workspace-dependencies` 的
    /// `workspaceDependencyPaths` + `validatePayloadEntries`，以及 `dsh-skill-office`
    /// 的 `officeRuntime`）：
    ///
    /// | 路径 | 类型 |
    /// |------|------|
    /// | `dependencies/python/python.exe` 或 `dependencies/python/bin/python3` | 文件 |
    /// | `dependencies/python/<Lib\|lib/pythonX.Y/site-packages>` | 目录 |
    /// | `dependencies/node/bin/node[.exe]` | 文件 |
    /// | `dependencies/node/node_modules` | 目录 |
    /// | `dependencies/pnpm/bin/pnpm.mjs` | 文件 |
    /// | `<同级>/office-skills/scripts/check_office.py` | 文件 |
    /// | `<同级>/office-skills/<office-docx\|office-pptx\|office-xlsx>/SKILL.md` | 文件 |
    ///
    /// # 两个档位（2026-10-06 落地档1.5 后引入）
    ///
    /// 上面那张表是**档1.5（Authoring）**的及格线：解释器 + office skills + 校验脚本齐备，
    /// 模型即可创建/编辑 docx/pptx/xlsx。**档2（FullToolchain）**额外要求 site-packages 里
    /// 出现上游工具描述承诺的 8 个库（numpy/pandas/python-docx/python-pptx/openpyxl/
    /// Pillow/lxml/XlsxWriter）——否则模型按描述 import 会拿到 ModuleNotFoundError。
    ///
    /// 两档**同一个环境变量、同一条启用路径**：档位只决定"这份载荷承诺了多少"，不改变
    /// 壳的行为。`full_toolchain` 让 MANIFEST / 反馈页能如实区分"能创作"与"全能"。
    ///
    /// `runtime.json` 的**内容**校验（版本、平台、架构、分发包清单）由组装期脚本负责，
    /// 这里只做存在性判定——启动路径不该在每次开应用时重算一份 sha256。
    pub fn primary_runtime(&self) -> Option<(&Path, PayloadTier)> {
        let root = &self.primary_runtime_root;
        if !root.is_dir() {
            return None;
        }
        let dependencies = root.join("dependencies");
        let windows = cfg!(windows);
        let python = dependencies.join("python").join(if windows {
            "python.exe"
        } else {
            "bin/python3"
        });
        // site-packages 的确切目录名带次版本号（`python3.13`），无法在常量里写死；
        // 于是按"`Lib`（Windows）或 `lib/python*` 下任一目录"判定——未知次版本时
        // 不让整个载荷失效，但也不假装它存在。
        let python_lib = dependencies
            .join("python")
            .join(if windows { "Lib" } else { "lib" });
        // `Lib`（Windows）/ `lib/python*`（POSIX）**不是**硬要求：Windows 的
        // 可嵌入发行版（`python-3.12-embed-amd64.zip`，实测解包 21.5 MB / 35 个文件）
        // 整个包是**扁平**的——标准库在 `python312.zip` 里，没有 `Lib` 目录。
        // 上游判据（`validatePayloadEntries`）只要求 `pythonPackages` 目录存在，
        // 而 `workspaceDependencyPaths` 在 Windows 上正是把它指向 `<python>/Lib`。
        // 因此这里区分两件事：
        //   · 档1.5 只要求解释器本体（`python.exe` / `bin/python3`）；
        //   · `Lib`（或 POSIX 的 `lib/python*`）只在判档2 时用——那时它必须存在，
        //     否则 site-packages 无从查找，8 库判据必然不满足。
        let python_interp_ok = python.is_file();
        let office_skills = root.parent().unwrap_or(root).join(OFFICE_SKILLS_DIR);

        // 档1.5 及格线（缺一即整个载荷不启用）。
        let authoring_ready = [
            python_interp_ok,
            dependencies.join("node").join("bin").join(if windows {
                "node.exe"
            } else {
                "node"
            })
            .is_file(),
            dependencies.join("node").join("node_modules").is_dir(),
            dependencies.join("pnpm").join("bin").join("pnpm.mjs").is_file(),
            office_skills.join("scripts").join("check_office.py").is_file(),
        ]
        .into_iter()
        .all(|present| present);
        if !authoring_ready {
            return None;
        }

        // 档2：三个 SKILL.md + site-packages 里 8 个库可导入。
        //
        // 判据是"目录/文件存在"，不是"真的 import 成功"：启动路径不派生 python 进程
        // （那要几十毫秒，且会因解释器缺动态库而给出难读的错误）。上游自己也是这么做的
        // ——`validatePayloadEntries` 只 stat。
        let site_packages = site_packages_dir(&python_lib, windows);
        let toolchain_complete = OFFICE_SKILLS
            .iter()
            .all(|skill| office_skills.join(skill).join("SKILL.md").is_file())
            && match &site_packages {
                Some(dir) => TOOLCHAIN_PACKAGES
                    .iter()
                    .all(|package| dir.join(package).is_dir()),
                None => false,
            };
        let tier = if toolchain_complete {
            PayloadTier::FullToolchain
        } else {
            PayloadTier::Authoring
        };
        Some((root.as_path(), tier))
    }

    /// 探测并解析当前可用的运行目标（Sidecar 优先或 Node 模式）。
    ///
    /// 决策规则：
    /// 1. 若设置环境变量 `DSH_RUNNER=node`，强制使用 Node 模式。
    /// 2. 若设置环境变量 `DSH_RUNNER=sidecar`，强制使用 Sidecar 模式（若文件不存在则报错）。
    /// 3. 默认情况下，优先检查 `sidecar_executable` 是否存在；若存在则选择 Sidecar 模式；
    ///    否则回退到传统的 Node 模式。
    pub fn resolve_launch_target(&self) -> Result<LaunchTarget, Vec<(&'static str, PathBuf)>> {
        let runner_env = std::env::var(ENV_DSH_RUNNER).ok();
        let force_node = runner_env.as_deref() == Some("node");
        let force_sidecar = runner_env.as_deref() == Some("sidecar");

        if !force_node && (force_sidecar || self.sidecar_executable.exists()) {
            if !self.sidecar_executable.exists() {
                return Err(vec![(
                    "sidecar_executable",
                    self.sidecar_executable.clone(),
                )]);
            }
            let patch = if self.patch.exists() {
                Some(self.patch.clone())
            } else {
                None
            };
            Ok(LaunchTarget::Sidecar {
                executable: self.sidecar_executable.clone(),
                patch,
            })
        } else {
            let missing = self.missing_node_resources();
            if !missing.is_empty() {
                return Err(missing
                    .into_iter()
                    .map(|(k, p)| (k, p.to_path_buf()))
                    .collect());
            }
            Ok(LaunchTarget::Node {
                executable: self.node_executable.clone(),
                node_entry: self.node_entry.clone(),
                windows_hide_entry: self.windows_hide_entry.clone(),
                dsh_entry: self.dsh_entry.clone(),
                patch: self.patch.clone(),
            })
        }
    }

    /// 传统 Node 模式下的必需资源检查。
    pub fn missing_node_resources(&self) -> Vec<(&'static str, &Path)> {
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

    /// 安全模式 patch 层是否就位（C10）。
    ///
    /// 刻意**不**并进 [`Layout::missing_resources`]：安全模式 patch 只在安全
    /// 模式启动时才被使用，正常启动缺它不应阻断应用。判定权交给调用方
    /// （`Launcher` 仅在 profile 为安全模式时检查）。
    ///
    /// # 示例
    ///
    /// ```
    /// use std::path::Path;
    /// use dsh_host::paths::Layout;
    ///
    /// let layout = Layout::resolve(Path::new("/missing-res"), Path::new("/data"));
    /// assert!(!layout.has_safe_patch());
    /// ```
    pub fn has_safe_patch(&self) -> bool {
        self.safe_patch.exists()
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
        create_dir(self.log_path.parent().unwrap_or(&self.app_data_dir))?;
        Ok(())
    }

    /// 列出缺失的必需资源条目（INV-1：资源缺失只能报错，不能就地生成）。
    ///
    /// 优先根据当前运行目标进行校验。
    /// 返回 `(契约名, 路径)` 列表；空向量表示资源齐备。
    pub fn missing_resources(&self) -> Vec<(&'static str, &Path)> {
        if self.sidecar_executable.exists() {
            Vec::new()
        } else {
            self.missing_node_resources()
        }
    }

    /// Unix 下为捆绑的 Node.js / Sidecar 二进制补上执行位。
    ///
    /// 资源解包（AppImage / tar / NSIS 之外的分发方式）可能丢掉执行位，
    /// 直接 spawn 会拿到 EACCES。Windows 无执行位概念，是空操作。
    pub fn ensure_exec_bits(&self) -> crate::HostResult<()> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for path in [&self.node_executable, &self.sidecar_executable] {
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

    /// Profile 管理根目录（`userData/harness/profiles`）。
    pub fn profiles_dir(&self) -> PathBuf {
        self.dsh_home.join(crate::contracts::PROFILES_DIR_NAME)
    }

    /// 会话管理根目录（`userData/harness/sessions`）。
    pub fn sessions_dir(&self) -> PathBuf {
        self.dsh_home.join(crate::contracts::SESSIONS_DIR_NAME)
    }
}

/// 返回不带 Windows `\\?\` verbatim 前缀的规范化绝对路径。
///
/// `std::fs::canonicalize` 在 Windows 上返回扩展长度路径（`\\?\D:\…`）。把这类
/// 路径原样写进子进程 argv（例如传给 node 的入口脚本）会让 Node.js 的 CJS
/// main-path 解析崩溃（`EISDIR: illegal operation on a directory, lstat 'D:'`，
/// 实测 Node v22.22.2：verbatim 路径经 `resolveMainPath → _findPath → toRealPath`
/// 被还原成盘符 `D:` 后 lstat 抛 EISDIR）。本函数保留 canonicalize 的归一化能力
/// （消解 `..` / 符号链接），同时把 verbatim 前缀剥回普通 `D:\…` 形式；非
/// Windows 平台与 `canonicalize` 行为一致。
///
/// # 示例
///
/// ```
/// use std::path::Path;
/// use dsh_host::paths::canonicalize_plain;
///
/// let plain = canonicalize_plain(Path::new("."));
/// assert!(plain.is_absolute());
/// ```
pub fn canonicalize_plain(path: impl AsRef<Path>) -> PathBuf {
    let canonical = std::fs::canonicalize(&path).unwrap_or_else(|_| path.as_ref().to_path_buf());
    strip_verbatim_prefix(canonical)
}

/// Windows：剥掉 `\\?\` 前缀（UNC 的 `\\?\UNC\server\share` → `\\server\share`）。
#[cfg(windows)]
fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    const UNC_PREFIX: &str = r"\\?\UNC\";
    const PREFIX: &str = r"\\?\";
    let text = path.to_string_lossy();
    if let Some(unc) = text.strip_prefix(UNC_PREFIX) {
        PathBuf::from(format!(r"\\{unc}"))
    } else if let Some(rest) = text.strip_prefix(PREFIX) {
        PathBuf::from(rest)
    } else {
        path
    }
}

/// 非 Windows：canonicalize 不会加 verbatim 前缀，直接返回。
#[cfg(not(windows))]
fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    path
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

    /// CX-17 — 档位判定：档1.5 齐备 → `Authoring`；三个 SKILL.md + site-packages 8 库
    /// 也在 → `FullToolchain`。
    ///
    /// 可证伪性：逐个抽走档2 专属项，档位必须掉回 `Authoring`（不是变 None）；
    /// 再逐个抽走档1.5 及格线里的项，整个判据必须变 `None`。若有人把档位判据写成
    /// "只看目录存在"，这里会红。
    #[test]
    fn payload_tier_drops_when_any_required_entry_is_missing() {
        let root = std::env::temp_dir().join(format!(
            "dsh-tier-{}-{}",
            std::process::id(),
            crate::process::now_seconds()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let layout = layout(&root);
        let deps = layout.primary_runtime_root.join("dependencies");
        let office = layout
            .primary_runtime_root
            .parent()
            .unwrap()
            .join(OFFICE_SKILLS_DIR);

        // 档1.5 及格线。
        std::fs::create_dir_all(deps.join("node").join("bin")).unwrap();
        std::fs::create_dir_all(deps.join("node").join("node_modules")).unwrap();
        std::fs::create_dir_all(deps.join("pnpm").join("bin")).unwrap();
        std::fs::create_dir_all(office.join("scripts")).unwrap();
        let python_bin = if cfg!(windows) {
            deps.join("python").join("python.exe")
        } else {
            deps.join("python").join("bin").join("python3")
        };
        std::fs::create_dir_all(python_bin.parent().unwrap()).unwrap();
        std::fs::write(&python_bin, b"stub").unwrap();
        std::fs::write(
            deps.join("node")
                .join("bin")
                .join(if cfg!(windows) { "node.exe" } else { "node" }),
            b"stub",
        )
        .unwrap();
        std::fs::write(deps.join("pnpm").join("bin").join("pnpm.mjs"), b"stub").unwrap();
        std::fs::write(office.join("scripts").join("check_office.py"), b"stub").unwrap();

        // 档2 专属：site-packages 里的 8 个导入名 + 三个 SKILL.md。
        let site = if cfg!(windows) {
            deps.join("python").join("Lib").join("site-packages")
        } else {
            deps.join("python")
                .join("lib")
                .join("python3.13")
                .join("site-packages")
        };
        std::fs::create_dir_all(&site).unwrap();
        for package in TOOLCHAIN_PACKAGES {
            std::fs::create_dir_all(site.join(package)).unwrap();
        }
        for skill in OFFICE_SKILLS {
            std::fs::create_dir_all(office.join(skill)).unwrap();
            std::fs::write(office.join(skill).join("SKILL.md"), b"stub").unwrap();
        }

        // 全齐 → 档2。
        let (_root, tier) = layout.primary_runtime().expect("payload must qualify");
        assert_eq!(tier, PayloadTier::FullToolchain);

        // 抽走任一档2 专属项 → 掉回档1.5（不是变 None）。
        let victims: Vec<PathBuf> = OFFICE_SKILLS
            .iter()
            .map(|skill| office.join(skill).join("SKILL.md"))
            .chain(TOOLCHAIN_PACKAGES.iter().map(|pkg| site.join(pkg)))
            .collect();
        for victim in victims {
            let backup = victim.with_extension("bak");
            std::fs::rename(&victim, &backup).unwrap();
            assert_eq!(
                layout.primary_runtime().map(|(_, tier)| tier),
                Some(PayloadTier::Authoring),
                "抽走 {victim:?} 后档位应掉回 Authoring"
            );
            std::fs::rename(&backup, &victim).unwrap();
        }

        // 抽走档1.5 及格线里的项 → 整个判据变 None（载荷不启用）。
        for victim in [
            python_bin.clone(),
            deps.join("node")
                .join("bin")
                .join(if cfg!(windows) { "node.exe" } else { "node" }),
            deps.join("pnpm").join("bin").join("pnpm.mjs"),
            office.join("scripts").join("check_office.py"),
        ] {
            let backup = victim.with_extension("bak");
            std::fs::rename(&victim, &backup).unwrap();
            assert!(
                layout.primary_runtime().is_none(),
                "抽走 {victim:?} 后载荷必须整体不启用"
            );
            std::fs::rename(&backup, &victim).unwrap();
        }

        let _ = std::fs::remove_dir_all(&root);
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
            layout.desktop_log_path,
            root.join("data").join("logs").join("desktop.log"),
            "壳层日志与宿主日志必须同目录但不同文件，否则两者会互相覆盖"
        );
        assert_eq!(
            layout.pid_file,
            root.join("data").join("launch-root").join("harness.pid")
        );
    }

    #[cfg(windows)]
    #[test]
    fn layout_strips_verbatim_prefix_from_every_derived_path() {
        // Tauri 的 resource_dir() 来自 canonicalize()，Windows 上带 `\\?\`。
        // 布局必须剥掉它，否则 node 的 CJS loader 在解析入口脚本时把 verbatim
        // 路径还原成盘符 `D:` 并 lstat 失败（EISDIR）。
        let layout = Layout::resolve(
            Path::new(r"\\?\C:\tmp\dsh\res"),
            Path::new(r"\\?\C:\tmp\dsh\data"),
        );
        for path in [
            &layout.resource_dir,
            &layout.app_data_dir,
            &layout.node_executable,
            &layout.node_entry,
            &layout.dsh_entry,
            &layout.patch,
            &layout.safe_patch,
        ] {
            assert!(
                !path.to_string_lossy().starts_with(r"\\?\"),
                "{path:?} 不应保留 verbatim 前缀"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn verbatim_unc_prefix_is_unwrapped_not_mangled() {
        // `\\?\UNC\server\share` 必须还原成 `\\server\share`，而不是 `UNC\server\share`。
        let layout = Layout::resolve(
            Path::new(r"\\?\UNC\server\share\res"),
            Path::new(r"\\?\C:\tmp\dsh\data"),
        );
        assert_eq!(layout.resource_dir, Path::new(r"\\server\share\res"));
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
            &layout.safe_patch,
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
        // 两份 patch 必须落在同一资源目录、文件名互不相同：安全模式靠
        // 「换文件」实现隔离，路径写重了就会静默退化成普通启动。
        assert!(
            layout.safe_patch.ends_with("dsh-desktop-safe.patch.yml"),
            "{:?}",
            layout.safe_patch
        );
        assert_ne!(layout.patch, layout.safe_patch);
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

    #[test]
    fn resolve_launch_target_auto_detects_sidecar_and_node() {
        let unique = format!(
            "dsh-host-target-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or(0)
        );
        let root = std::env::temp_dir().join(unique);
        let layout = layout(&root);

        // 默认情况下两者皆无，应报错缺失
        let res = layout.resolve_launch_target();
        assert!(res.is_err());

        // 创建 sidecar 二进制
        std::fs::create_dir_all(layout.sidecar_executable.parent().unwrap()).unwrap();
        std::fs::write(&layout.sidecar_executable, "mock sidecar").unwrap();

        // 探测出 Sidecar 模式
        let target = layout.resolve_launch_target().expect("应解析为 Sidecar");
        match target {
            LaunchTarget::Sidecar { executable, patch } => {
                assert_eq!(executable, layout.sidecar_executable);
                assert!(patch.is_none());
            }
            _ => panic!("期望 Sidecar 目标"),
        }

        let _ = std::fs::remove_dir_all(&root);
    }
}
