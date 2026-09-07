//! argv / env 的构造与转发（契约 C1、C2）。
//!
//! 本模块是「宿主拼出来的命令行」的**唯一**产地。把它从 `process` 里独立出来，
//! 是为了让「我们发给 dsh 的东西」可以被单独断言、单独打印（`--print-argv`），
//! 而不必真的派生一个子进程。
//!
//! # argv 顺序（决定了与 dsh 行为一致）
//!
//! ```text
//! [node 自身] --expose-internals <node_entry> <dsh_entry>
//! [契约固定]  web --patch <P> --no-open --host <H> --port <N>
//! [用户透传]  <extra...>
//! ```
//!
//! 透传段**放在最后**：dsh 用 yargs 解析参数，语义是「后者胜」，因此
//! `dsh-host-cli start -- --port 5000` 与「手工跑 dsh 并追加 `--port 5000`」
//! 的结果完全一致。反过来若把透传插在契约参数之前，宿主就会静默覆盖用户意图。
//!
//! # 冲突处理
//!
//! 透传段里出现与契约参数同名的项（如 `--port`）时**不报错**，只记一条
//! warn：dsh 的参数语义由 dsh 自己定义，宿主的责任是「忠实转发 + 可观测」，
//! 不是替它做仲裁。

use std::path::PathBuf;

use crate::contracts::{HARNESS_CLI, HARNESS_HOST, HARNESS_NO_OPEN, NODE_EXPOSE_INTERNALS};
use crate::paths::{LaunchTarget, Layout};
use crate::HostResult;

/// `--print-argv` 用的纯数据快照（不含任何需要落盘的敏感信息）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArgvSnapshot {
    /// 可执行文件路径（捆绑的 node 或 sidecar）。
    pub program: PathBuf,
    /// 完整 argv。
    pub args: Vec<String>,
    /// 子进程工作目录（launch-root）。
    pub cwd: PathBuf,
}

/// C1 — 一次启动要传给 dsh 的完整参数集（含用户透传）。
#[derive(Clone, Debug)]
pub struct HarnessArgs {
    /// 目录布局（提供 patch / 入口路径 / 工作目录）。
    pub layout: Layout,
    /// 监听端口；`0` 表示 Ephemeral（由内核分配，从 stdout 回报）。
    pub port: u16,
    /// 监听地址，默认 [`HARNESS_HOST`]。
    pub host: String,
    /// 是否禁止 dsh 把 URL 交给系统浏览器，默认 `true`（C1）。
    pub no_open: bool,
    /// 用户通过 `--` 透传的原始参数，原样追加在契约参数之后。
    pub extra: Vec<String>,
}

impl HarnessArgs {
    /// 构造一份与既有行为**逐字节等价**的参数集（无透传）。
    ///
    /// GUI 走的老路径（`process::build_harness_arguments`）就是这一份。
    ///
    /// # 示例
    ///
    /// ```
    /// use std::path::Path;
    /// use dsh_host::args::HarnessArgs;
    /// use dsh_host::paths::Layout;
    ///
    /// let layout = Layout::resolve(Path::new("/res"), Path::new("/data"));
    /// let args = HarnessArgs::default_for(layout, 4173);
    /// assert_eq!(args.port, 4173);
    /// assert!(args.no_open);
    /// assert!(args.extra.is_empty());
    /// ```
    pub fn default_for(layout: Layout, port: u16) -> Self {
        Self {
            layout,
            port,
            host: HARNESS_HOST.to_string(),
            no_open: true,
            extra: Vec::new(),
        }
    }

    /// C1 — 传给 `<dsh>/lib/bin.js` 的参数（不含 node 自身的参数）。
    ///
    /// # 示例
    ///
    /// ```
    /// use std::path::Path;
    /// use dsh_host::args::HarnessArgs;
    /// use dsh_host::paths::Layout;
    ///
    /// let layout = Layout::resolve(Path::new("/res"), Path::new("/data"));
    /// let mut args = HarnessArgs::default_for(layout, 4173);
    /// args.extra = vec!["--profile".into(), "work".into()];
    ///
    /// let built = args.dsh_arguments();
    /// assert_eq!(built[0], "web");
    /// // 透传必须落在最后。
    /// assert_eq!(&built[built.len() - 2..], &["--profile", "work"]);
    /// ```
    pub fn dsh_arguments(&self) -> Vec<String> {
        let mut args = vec![HARNESS_CLI.to_string()];
        args.push("--patch".to_string());
        args.push(self.layout.patch.display().to_string());
        // 桌面窗口是唯一展示面：不交给系统浏览器打开。
        if self.no_open {
            args.push(HARNESS_NO_OPEN.to_string());
        }
        args.push("--host".to_string());
        args.push(self.host.clone());
        args.push("--port".to_string());
        args.push(self.port.to_string());
        args.extend(self.extra.iter().cloned());
        args
    }

    /// C1 — 完整的 node argv：`--expose-internals <entry> <bin.js> <dsh args>`。
    ///
    /// `--expose-internals` 是 Cordis HMR 的前提，只授予本子进程，绝不授予 webview。
    ///
    /// # 示例
    ///
    /// ```
    /// use std::path::Path;
    /// use dsh_host::args::HarnessArgs;
    /// use dsh_host::paths::Layout;
    ///
    /// let layout = Layout::resolve(Path::new("/res"), Path::new("/data"));
    /// let args = HarnessArgs::default_for(layout, 0);
    /// let built = args.node_arguments();
    /// assert_eq!(built[0], "--expose-internals");
    /// assert_eq!(built.last().map(String::as_str), Some("0"));
    /// ```
    pub fn node_arguments(&self) -> Vec<String> {
        let mut args = vec![
            NODE_EXPOSE_INTERNALS.to_string(),
            self.layout.node_entry.display().to_string(),
            self.layout.dsh_entry.display().to_string(),
        ];
        args.extend(self.dsh_arguments());
        args
    }

    /// 根据指定的 [`LaunchTarget`] 构建完整的命令参数。
    pub fn build_arguments_for_target(&self, target: &LaunchTarget) -> (PathBuf, Vec<String>) {
        match target {
            LaunchTarget::Sidecar { executable, patch } => {
                let mut args = vec![HARNESS_CLI.to_string()];
                if let Some(p) = patch {
                    args.push("--patch".to_string());
                    args.push(p.display().to_string());
                }
                if self.no_open {
                    args.push(HARNESS_NO_OPEN.to_string());
                }
                args.push("--host".to_string());
                args.push(self.host.clone());
                args.push("--port".to_string());
                args.push(self.port.to_string());
                args.extend(self.extra.iter().cloned());
                (executable.clone(), args)
            }
            LaunchTarget::Node { executable, .. } => {
                (executable.clone(), self.node_arguments())
            }
        }
    }

    /// 供 `--print-argv` 使用的快照。
    ///
    /// # 示例
    ///
    /// ```
    /// use std::path::Path;
    /// use dsh_host::args::HarnessArgs;
    /// use dsh_host::paths::Layout;
    ///
    /// let layout = Layout::resolve(Path::new("/res"), Path::new("/data"));
    /// let snapshot = HarnessArgs::default_for(layout, 4173).argv_snapshot();
    /// assert_eq!(snapshot.args[3], "web");
    /// ```
    pub fn argv_snapshot(&self) -> ArgvSnapshot {
        if let Ok(target) = self.layout.resolve_launch_target() {
            let (program, args) = self.build_arguments_for_target(&target);
            ArgvSnapshot {
                program,
                args,
                cwd: self.layout.launch_root.clone(),
            }
        } else {
            ArgvSnapshot {
                program: self.layout.node_executable.clone(),
                args: self.node_arguments(),
                cwd: self.layout.launch_root.clone(),
            }
        }
    }
}

/// C2 — 解析 `--env K=V` 覆盖项。
///
/// 按**第一个** `=` 切分，值里允许再出现 `=`（例如 `NODE_OPTIONS=--max-old-space-size=4096`）。
/// 不含 `=` 或键名为空视为非法。
///
/// # 示例
///
/// ```
/// use dsh_host::args::parse_env_overrides;
///
/// let pairs = vec!["NO_COLOR=0".to_string(), "A=b=c".to_string()];
/// let parsed = parse_env_overrides(&pairs).unwrap();
/// assert_eq!(parsed[0], ("NO_COLOR".to_string(), "0".to_string()));
/// assert_eq!(parsed[1], ("A".to_string(), "b=c".to_string()));
///
/// assert!(parse_env_overrides(&["NOEQUALS".to_string()]).is_err());
/// ```
pub fn parse_env_overrides(pairs: &[String]) -> HostResult<Vec<(String, String)>> {
    let mut parsed = Vec::with_capacity(pairs.len());
    for pair in pairs {
        let Some((key, value)) = pair.split_once('=') else {
            return Err(crate::HostError::InvalidArgument(format!(
                "--env 需要 K=V 形式，收到 `{pair}`"
            )));
        };
        let key = key.trim();
        if key.is_empty() {
            return Err(crate::HostError::InvalidArgument(format!(
                "--env 的键名不能为空：`{pair}`"
            )));
        }
        parsed.push((key.to_string(), value.to_string()));
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout() -> Layout {
        let root = if cfg!(windows) {
            PathBuf::from("C:\\t")
        } else {
            PathBuf::from("/t")
        };
        Layout::resolve(root.join("res"), root.join("data"))
    }

    /// **最关键的回归护栏**：新路径必须与 GUI 依赖的老路径逐项相等。
    #[test]
    fn matches_legacy_argv() {
        let layout = layout();
        let legacy = crate::process::build_harness_arguments(&layout, 1234);
        let new = HarnessArgs::default_for(layout.clone(), 1234).dsh_arguments();
        assert_eq!(new, legacy);

        let legacy_node = crate::process::build_node_arguments(&layout, 1234);
        let new_node = HarnessArgs::default_for(layout, 1234).node_arguments();
        assert_eq!(new_node, legacy_node);
    }

    #[test]
    fn ephemeral_mode_sends_port_zero() {
        let args = HarnessArgs::default_for(layout(), 0).dsh_arguments();
        let tail: Vec<&str> = args.iter().map(String::as_str).collect();
        assert_eq!(&tail[tail.len() - 2..], &["--port", "0"]);
    }

    #[test]
    fn extra_args_are_appended_last() {
        let mut args = HarnessArgs::default_for(layout(), 4173);
        args.extra = vec!["--profile".into(), "x".into()];
        let built = args.dsh_arguments();
        assert_eq!(&built[built.len() - 2..], &["--profile", "x"]);
        // 透传之前必须是契约的 --port。
        assert_eq!(built[built.len() - 3], "4173");
    }

    #[test]
    fn host_is_overridable() {
        let mut args = HarnessArgs::default_for(layout(), 4173);
        args.host = "127.0.0.2".to_string();
        let built = args.dsh_arguments();
        assert!(built.windows(2).any(|pair| pair == ["--host", "127.0.0.2"]));
    }

    #[test]
    fn no_open_can_be_disabled() {
        let mut args = HarnessArgs::default_for(layout(), 4173);
        args.no_open = false;
        assert!(!args.dsh_arguments().contains(&HARNESS_NO_OPEN.to_string()));
    }

    #[test]
    fn argv_snapshot_carries_program_and_cwd() {
        let layout = layout();
        let snapshot = HarnessArgs::default_for(layout.clone(), 4173).argv_snapshot();
        assert_eq!(snapshot.program, layout.node_executable);
        assert_eq!(snapshot.cwd, layout.launch_root);
    }

    #[test]
    fn env_override_rejects_malformed_pairs() {
        assert!(parse_env_overrides(&["NOEQUALS".into()]).is_err());
        assert!(parse_env_overrides(&["=value".into()]).is_err());
    }

    #[test]
    fn build_arguments_for_sidecar_target() {
        let layout = layout();
        let target = LaunchTarget::Sidecar {
            executable: layout.sidecar_executable.clone(),
            patch: Some(layout.patch.clone()),
        };
        let (prog, args) = HarnessArgs::default_for(layout.clone(), 5000).build_arguments_for_target(&target);
        assert_eq!(prog, layout.sidecar_executable);
        assert_eq!(args[0], "web");
        assert_eq!(args[1], "--patch");
        assert_eq!(args[3], "--no-open");
        assert!(args.contains(&"5000".to_string()));
    }
}
