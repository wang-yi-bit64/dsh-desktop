//! 子进程环境变量组装（契约 C2）。
//!
//! 原实现（Electron）在 Windows 上起一个 PowerShell 进程（UTF-8 固定、15s 超时、
//! 结果 memoize）来捕获 shell 环境。本项目改为**注册表优先**：
//!
//! * Windows：直接读 `HKLM\...\Environment` 与 `HKCU\Environment` 合并 PATH
//!   （machine 在前、user 追加、大小写不敏感去重），省掉 1–3s 冷启动开销；
//!   只有在注册表结果明显异常（PATH 为空）时才回退 PowerShell。
//! * macOS / Linux：`$SHELL -l -c env`（10s 超时，失败退回继承环境）。
//!
//! 所有可单测的逻辑（PATH 合并、变量展开、快照组装）都抽成了纯函数，
//! 平台 I/O 只是薄薄一层。

use std::collections::BTreeMap;
use std::path::Path;

use crate::contracts::{
    ENV_DSH_HOME, ENV_FORCE_COLOR, ENV_NODE_OPTIONS, ENV_NO_COLOR, ENV_NPM_SIDE_EFFECTS_CACHE,
    ENV_PATH, ENV_PNPM_SIDE_EFFECTS_CACHE, ENV_PYTHONIOENCODING, ENV_SYSTEM_ROOT,
};
use crate::paths::Layout;
use crate::HostResult;

/// Windows PATH 分隔符。
pub const PATH_SEPARATOR_WINDOWS: char = ';';

/// POSIX PATH 分隔符。
pub const PATH_SEPARATOR_UNIX: char = ':';

/// 当前平台的 PATH 分隔符。
pub fn path_separator() -> char {
    if cfg!(windows) {
        PATH_SEPARATOR_WINDOWS
    } else {
        PATH_SEPARATOR_UNIX
    }
}

/// 合并后的 Harness 子进程环境（有序、确定性——便于快照测试）。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HarnessEnv {
    entries: BTreeMap<String, String>,
}

impl HarnessEnv {
    /// 从键值对迭代器构造（同名后写覆盖先写）。
    pub fn from_pairs<I, K, V>(pairs: I) -> Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<String>,
        V: Into<String>,
    {
        Self {
            entries: pairs
                .into_iter()
                .map(|(key, value)| (key.into(), value.into()))
                .collect(),
        }
    }

    /// 读取一个环境变量（Windows 语义下大小写不敏感）。
    pub fn get(&self, name: &str) -> Option<&String> {
        if cfg!(windows) {
            self.entries
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .map(|(_, value)| value)
        } else {
            self.entries.get(name)
        }
    }

    /// 覆盖 / 写入一个环境变量。
    pub fn set(&mut self, name: impl Into<String>, value: impl Into<String>) {
        let name = name.into();
        if cfg!(windows) {
            // BTreeMap 的键大小写敏感，先摘掉同名的其它写法，避免出现 `Path` 与 `PATH` 两份。
            let existing = self
                .entries
                .keys()
                .find(|key| key.eq_ignore_ascii_case(&name))
                .cloned();
            if let Some(existing) = existing {
                self.entries.remove(&existing);
            }
        }
        self.entries.insert(name, value.into());
    }

    /// 遍历全部环境变量（按名字排序，输出稳定）。
    pub fn iter(&self) -> impl Iterator<Item = (&String, &String)> {
        self.entries.iter()
    }

    /// PATH 的当前值。
    pub fn path(&self) -> Option<&String> {
        self.get(ENV_PATH)
    }

    /// 交给 `Command::envs` 的切片视图。
    pub fn as_pairs(&self) -> Vec<(&str, &str)> {
        self.entries
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect()
    }
}

/// 合并多段 PATH：machine 在前、user 追加、继承环境兜底。
///
/// * 空段被忽略；
/// * Windows 下按**大小写不敏感**去重（原实现就是这么做的，避免
///   `C:\Windows` 与 `c:\windows` 各占一份），其它平台精确去重；
/// * 保留首次出现的顺序。
///
/// # 参数
///
/// * `machine` — 系统级 PATH（Windows 注册表 HKLM）。
/// * `user` — 用户级 PATH（Windows 注册表 HKCU）。
/// * `inherited` — 从宿主进程继承的 PATH。
///
/// # 示例
///
/// 合并顺序与去重规则是 Windows 专属（machine/user PATH、`;` 分隔、
/// 大小写不敏感），故示例只在 Windows 上断言。
///
/// ```
/// use dsh_host::env::merge_path;
///
/// #[cfg(windows)]
/// {
///     let merged =
///         merge_path(Some("C:\\Windows;C:\\Bin"), Some("C:\\Bin;C:\\Users\\me"), None);
///     assert_eq!(merged, "C:\\Windows;C:\\Bin;C:\\Users\\me");
/// }
/// ```
pub fn merge_path(machine: Option<&str>, user: Option<&str>, inherited: Option<&str>) -> String {
    let separator = path_separator();
    let mut seen: Vec<String> = Vec::new();
    let mut merged: Vec<String> = Vec::new();

    for segment in [machine, user, inherited].into_iter().flatten() {
        for entry in segment.split(separator) {
            let entry = entry.trim();
            if entry.is_empty() {
                continue;
            }
            let duplicate = if cfg!(windows) {
                seen.iter()
                    .any(|existing| existing.eq_ignore_ascii_case(entry))
            } else {
                seen.iter().any(|existing| existing == entry)
            };
            if duplicate {
                continue;
            }
            seen.push(entry.to_string());
            merged.push(entry.to_string());
        }
    }

    merged.join(&separator.to_string())
}

/// 展开 Windows 风格的 `%VAR%` 引用。
///
/// 未定义的变量保留原样（与 `ExpandEnvironmentStrings` 一致），避免把
/// `%UNDEFINED%` 静默抹掉掩盖配置错误。
///
/// # 参数
///
/// * `value` — 待展开的字符串。
/// * `resolver` — 变量名 → 值的查表函数。
///
/// # 示例
///
/// ```
/// use std::collections::BTreeMap;
/// use dsh_host::env::expand_windows;
///
/// let mut table = BTreeMap::new();
/// table.insert("SystemRoot".to_string(), "C:\\Windows".to_string());
/// let expanded = expand_windows("%SystemRoot%\\System32;%Missing%", &|name| table.get(name).cloned());
/// assert_eq!(expanded, "C:\\Windows\\System32;%Missing%");
/// ```
pub fn expand_windows(value: &str, resolver: &dyn Fn(&str) -> Option<String>) -> String {
    let bytes: Vec<char> = value.chars().collect();
    let mut output = String::with_capacity(value.len());
    let mut index = 0usize;

    while index < bytes.len() {
        if bytes[index] == '%' {
            if let Some(close) = bytes[index + 1..].iter().position(|c| *c == '%') {
                let name_end = index + 1 + close;
                let name: String = bytes[index + 1..name_end].iter().collect();
                match resolver(&name) {
                    Some(resolved) => {
                        output.push_str(&resolved);
                        index = name_end + 1;
                        continue;
                    }
                    // 未定义：原样保留 `%NAME%`。
                    None => {
                        output.push('%');
                        output.push_str(&name);
                        output.push('%');
                        index = name_end + 1;
                        continue;
                    }
                }
            }
        }
        output.push(bytes[index]);
        index += 1;
    }

    output
}

/// 解析 `KEY=VALUE` 形式的 `env` 输出。
///
/// 只按**第一个** `=` 切分，值里允许再出现 `=`（PATH 之外的场景常见）。
/// 没有 `=` 的行（多行值的续行）被忽略。
pub fn parse_env_output(output: &str) -> Vec<(String, String)> {
    output
        .lines()
        .filter_map(|line| {
            let line = line.trim_end_matches('\r');
            let separator = line.find('=')?;
            if separator == 0 {
                return None;
            }
            Some((
                line[..separator].to_string(),
                line[separator + 1..].to_string(),
            ))
        })
        .collect()
}

/// 组装 Harness 子进程的完整环境（契约 C2 的可执行快照）。
///
/// # 参数
///
/// * `layout` — 目录布局，提供 DSH_HOME。
/// * `shell` — 捕获到的 shell 环境键值对（通常来自 [`capture_shell_environment`]）。
/// * `inherited_path` — 宿主进程的 PATH，作为合并兜底段。
///
/// # 示例
///
/// ```
/// use std::path::Path;
/// use dsh_host::env::{harness_env, HarnessEnv};
/// use dsh_host::paths::Layout;
///
/// let layout = Layout::resolve(Path::new("/res"), Path::new("/data"));
/// let env = harness_env(&layout, &HarnessEnv::default(), Some("/usr/bin"));
/// assert_eq!(env.get("NO_COLOR").map(String::as_str), Some("1"));
/// assert_eq!(env.get("DSH_HOME").map(String::as_str), Some(layout.dsh_home.to_str().unwrap()));
/// ```
pub fn harness_env(
    layout: &Layout,
    shell: &HarnessEnv,
    inherited_path: Option<&str>,
) -> HarnessEnv {
    harness_env_with_overrides(layout, shell, inherited_path, &[])
}

/// C2 — 组装子进程环境，并允许调用方覆盖任意条目（`--env K=V`）。
///
/// 覆盖项写在**契约项之后**，因此 `--env NO_COLOR=0` 能覆盖契约值 `1`。
/// 覆盖 `PATH` 时走 [`merge_path`] 而不是整体替换——直接替换会把系统 PATH
/// 整个冲掉，导致 pnpm / pwsh 之类的子进程起不来。
///
/// # 参数
///
/// * `layout` — 目录布局（提供 `DSH_HOME`）。
/// * `shell` — shell 环境快照。
/// * `inherited_path` — 宿主继承的 PATH（通常传 `None`，内部从 shell 取）。
/// * `overrides` — 覆盖项；可用 [`crate::args::parse_env_overrides`] 从命令行解析。
///
/// # 示例
///
/// ```
/// use std::path::Path;
/// use dsh_host::env::{harness_env_with_overrides, HarnessEnv};
/// use dsh_host::paths::Layout;
///
/// let layout = Layout::resolve(Path::new("/res"), Path::new("/data"));
/// let shell = HarnessEnv::default();
/// let env = harness_env_with_overrides(
///     &layout,
///     &shell,
///     None,
///     &[("NO_COLOR".to_string(), "0".to_string())],
/// );
/// assert_eq!(env.get("NO_COLOR").map(String::as_str), Some("0"));
/// ```
pub fn harness_env_with_overrides(
    layout: &Layout,
    shell: &HarnessEnv,
    inherited_path: Option<&str>,
    overrides: &[(String, String)],
) -> HarnessEnv {
    harness_env_inner(layout, shell, inherited_path, overrides)
}

fn harness_env_inner(
    layout: &Layout,
    shell: &HarnessEnv,
    inherited_path: Option<&str>,
    overrides: &[(String, String)],
) -> HarnessEnv {
    let mut entries: BTreeMap<String, String> = shell
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .filter(|(key, _)| !is_path_key(key))
        .collect();

    let merged = merge_path(shell.path().map(String::as_str), None, inherited_path);
    if !merged.is_empty() {
        entries.insert(path_key().to_string(), merged);
    }

    // C2 契约项：逐条写入，注释对应契约表。
    entries.insert(
        ENV_DSH_HOME.to_string(),
        layout.dsh_home.display().to_string(),
    );
    entries.insert(ENV_NO_COLOR.to_string(), "1".to_string());
    entries.insert(ENV_FORCE_COLOR.to_string(), "0".to_string());
    entries.insert(ENV_NPM_SIDE_EFFECTS_CACHE.to_string(), "false".to_string());
    entries.insert(ENV_PNPM_SIDE_EFFECTS_CACHE.to_string(), "false".to_string());
    // 加固补充：稳定跨语言控制台输出编码 + 可读的崩溃栈。
    entries.insert(ENV_PYTHONIOENCODING.to_string(), "utf-8".to_string());
    entries.insert(
        ENV_NODE_OPTIONS.to_string(),
        "--enable-source-maps".to_string(),
    );

    // SystemRoot 兜底：缺失时很多 Windows 子进程（pwsh / pnpm）直接起不来。
    if cfg!(windows) && !has_key(&entries, ENV_SYSTEM_ROOT) {
        if let Some(system_root) = std::env::var(ENV_SYSTEM_ROOT)
            .ok()
            .filter(|v| !v.is_empty())
        {
            entries.insert(ENV_SYSTEM_ROOT.to_string(), system_root);
        } else {
            entries.insert(ENV_SYSTEM_ROOT.to_string(), "C:\\Windows".to_string());
        }
    }

    // 覆盖项最后写入，因此能盖掉上面的契约值。
    apply_overrides(&mut entries, overrides);

    HarnessEnv { entries }
}

/// 把 `--env K=V` 覆盖项写入环境表。
///
/// `PATH` 特殊处理：走 [`merge_path`] 合并而不是整体替换，避免冲掉系统 PATH。
fn apply_overrides(entries: &mut BTreeMap<String, String>, overrides: &[(String, String)]) {
    for (key, value) in overrides {
        if is_path_key(key) {
            let current = entries
                .iter()
                .find(|(existing, _)| is_path_key(existing))
                .map(|(_, existing)| existing.clone())
                .or_else(|| std::env::var(ENV_PATH).ok());
            let merged = merge_path(current.as_deref(), None, Some(value));
            if !merged.is_empty() {
                entries.insert(path_key().to_string(), merged);
            }
            continue;
        }
        entries.insert(key.clone(), value.clone());
    }
}

/// 当前平台的 PATH 键名（Windows 上 PowerShell 与注册表都可能写成 `Path`）。
pub fn path_key() -> &'static str {
    ENV_PATH
}

fn is_path_key(key: &str) -> bool {
    if cfg!(windows) {
        key.eq_ignore_ascii_case(ENV_PATH)
    } else {
        key == ENV_PATH
    }
}

fn has_key(entries: &BTreeMap<String, String>, key: &str) -> bool {
    if cfg!(windows) {
        entries
            .keys()
            .any(|existing| existing.eq_ignore_ascii_case(key))
    } else {
        entries.contains_key(key)
    }
}

/// 从注册表读取 Windows 的 machine / user 两级 PATH。
///
/// 返回 `(machine, user)`；任一项缺失则为 `None`。合并前的 `%VAR%` 展开由
/// 调用方用 [`expand_windows`] 完成，这里保留原始值以便单测。
#[cfg(windows)]
pub fn windows_registry_path() -> HostResult<(Option<String>, Option<String>)> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    const MACHINE_KEY: &str = "SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";
    const USER_KEY: &str = "Environment";

    let machine = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey(MACHINE_KEY)
        .ok()
        .and_then(|key| key.get_value::<String, _>("Path").ok());

    let user = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(USER_KEY)
        .ok()
        .and_then(|key| key.get_value::<String, _>("Path").ok());

    Ok((machine, user))
}

/// 捕获当前平台的 shell 环境。
///
/// * Windows：注册表优先（[`windows_registry_path`]），PATH 为空时回退 PowerShell。
/// * macOS / Linux：`$SHELL -l -c env`，失败退回宿主进程环境。
///
/// # 示例
///
/// ```no_run
/// use dsh_host::env::capture_shell_environment;
/// let env = capture_shell_environment().expect("环境捕获不应失败");
/// assert!(env.path().is_some());
/// ```
pub fn capture_shell_environment() -> HostResult<HarnessEnv> {
    #[cfg(windows)]
    {
        capture_windows_environment()
    }
    #[cfg(not(windows))]
    {
        capture_unix_environment()
    }
}

/// Windows：注册表 PATH + 宿主环境其余变量；注册表 PATH 为空才起 PowerShell。
#[cfg(windows)]
fn capture_windows_environment() -> HostResult<HarnessEnv> {
    let mut environment = HarnessEnv::from_pairs(
        std::env::vars_os()
            .filter_map(|(key, value)| {
                let key = key.to_string_lossy().to_string();
                let value = value.to_string_lossy().to_string();
                if is_path_key(&key) {
                    None
                } else {
                    Some((key, value))
                }
            })
            .collect::<Vec<_>>(),
    );

    let (machine, user) = windows_registry_path()?;
    let inherited = std::env::var(ENV_PATH).ok();
    let registry_path = merge_path(machine.as_deref(), user.as_deref(), None);

    let path = if registry_path.trim().is_empty() {
        // 回退路径（对齐原仓库）：起 PowerShell 捕获 login 环境。
        match capture_powershell_environment() {
            Ok(shell) => {
                for (key, value) in shell.iter() {
                    if !is_path_key(key) {
                        environment.set(key.clone(), value.clone());
                    }
                }
                shell.path().cloned().or(inherited).unwrap_or_default()
            }
            Err(_) => inherited.unwrap_or_default(),
        }
    } else {
        // `%SystemRoot%` 之类要展开成真实路径才可用。
        let resolver = |name: &str| {
            if name.eq_ignore_ascii_case(ENV_SYSTEM_ROOT) {
                std::env::var(ENV_SYSTEM_ROOT).ok()
            } else {
                std::env::var(name).ok()
            }
        };
        let expanded = expand_windows(&registry_path, &resolver);
        merge_path(Some(&expanded), None, inherited.as_deref())
    };

    if !path.is_empty() {
        environment.set(ENV_PATH, path);
    }
    Ok(environment)
}

/// PowerShell 兜底捕获（UTF-8 固定，15s 超时）。
#[cfg(windows)]
fn capture_powershell_environment() -> HostResult<HarnessEnv> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-ChildItem Env: | ForEach-Object { \"$($_.Name)=$($_.Value)\" }",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|error| crate::HostError::Environment(error.to_string()))?;

    if !output.status.success() {
        return Err(crate::HostError::Environment(
            "powershell env capture failed".to_string(),
        ));
    }

    let text = String::from_utf8_lossy(&output.stdout);
    Ok(HarnessEnv::from_pairs(parse_env_output(&text)))
}

/// macOS / Linux：`$SHELL -l -c env`（10s 超时，失败退回宿主环境）。
#[cfg(not(windows))]
fn capture_unix_environment() -> HostResult<HarnessEnv> {
    use std::process::{Command, Stdio};

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let output = Command::new(&shell)
        .args(["-l", "-c", "env"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output();

    let environment = match output {
        Ok(output) if output.status.success() => {
            HarnessEnv::from_pairs(parse_env_output(&String::from_utf8_lossy(&output.stdout)))
        }
        _ => HarnessEnv::from_pairs(std::env::vars().collect::<Vec<_>>()),
    };

    if environment
        .path()
        .map(|path| path.is_empty())
        .unwrap_or(true)
    {
        let mut fallback = HarnessEnv::from_pairs(std::env::vars().collect::<Vec<_>>());
        if fallback.path().is_none() {
            fallback.set(ENV_PATH, "/usr/local/bin:/usr/bin:/bin".to_string());
        }
        return Ok(fallback);
    }

    Ok(environment)
}

/// 判断某个目录是否出现在 PATH 中（Windows 大小写不敏感比较）。
pub fn path_contains(path: &str, candidate: &Path) -> bool {
    let candidate = candidate.display().to_string();
    path.split(path_separator())
        .map(|entry| entry.trim().trim_end_matches(['/', '\\']).to_string())
        .any(|entry| {
            if cfg!(windows) {
                entry.eq_ignore_ascii_case(candidate.trim_end_matches(['/', '\\']))
            } else {
                entry == candidate.trim_end_matches(['/', '\\'])
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overrides_win_over_contract_values() {
        let layout = Layout::resolve(
            std::path::Path::new("/res-override"),
            std::path::Path::new("/data-override"),
        );
        let shell = HarnessEnv::default();
        let env = harness_env_with_overrides(
            &layout,
            &shell,
            None,
            &[("NO_COLOR".to_string(), "0".to_string())],
        );
        assert_eq!(env.get("NO_COLOR").map(String::as_str), Some("0"));
    }

    #[test]
    fn three_arg_harness_env_is_unchanged() {
        let layout = Layout::resolve(
            std::path::Path::new("/res-plain"),
            std::path::Path::new("/data-plain"),
        );
        let shell = HarnessEnv::default();
        let legacy = harness_env(&layout, &shell, None);
        let delegated = harness_env_with_overrides(&layout, &shell, None, &[]);
        assert_eq!(legacy.entries, delegated.entries);
    }

    #[test]
    fn env_override_does_not_clobber_path() {
        let layout = Layout::resolve(
            std::path::Path::new("/res-path"),
            std::path::Path::new("/data-path"),
        );
        let mut shell = HarnessEnv::default();
        shell.set(path_key(), "/usr/bin");
        let env = harness_env_with_overrides(
            &layout,
            &shell,
            None,
            &[(path_key().to_string(), "/extra/bin".to_string())],
        );
        let merged = env.path().map(String::as_str).unwrap_or_default();
        assert!(merged.contains("/usr/bin"), "系统 PATH 被冲掉了：{merged}");
        assert!(merged.contains("/extra/bin"), "覆盖项没进去：{merged}");
    }

    /// Windows PATH 合并：machine 优先 + `;` 分隔 + 精确去重。该语义是
    /// Windows 专属（machine/user PATH、大小写不敏感），POSIX 上分隔符是
    /// `:` 且无 machine/user 概念，故整组用例仅 Windows 编译运行。
    #[test]
    #[cfg(windows)]
    fn merge_path_puts_machine_first_and_dedupes() {
        let merged = merge_path(
            Some("C:\\Windows;C:\\Bin"),
            Some("C:\\Bin;C:\\Users\\me"),
            Some("C:\\Windows;C:\\Extra"),
        );
        assert_eq!(merged, "C:\\Windows;C:\\Bin;C:\\Users\\me;C:\\Extra");
    }

    #[test]
    #[cfg(windows)]
    fn merge_path_is_case_insensitive_on_windows() {
        let merged = merge_path(
            Some("C:\\Windows"),
            Some("c:\\windows"),
            Some("C:\\WINDOWS"),
        );
        assert_eq!(merged, "C:\\Windows");
    }

    #[test]
    fn merge_path_skips_empty_segments() {
        assert_eq!(merge_path(None, Some(""), Some("/usr/bin")), "/usr/bin");
        assert_eq!(merge_path(None, None, None), "");
    }

    #[test]
    fn merge_path_drops_blank_entries() {
        let separator = path_separator();
        let input = format!("/usr/bin{separator}{separator}/bin");
        let expected = format!("/usr/bin{separator}/bin");
        assert_eq!(merge_path(Some(&input), None, None), expected);
    }

    #[test]
    fn expand_windows_resolves_known_and_keeps_unknown() {
        let table: BTreeMap<String, String> =
            [("SystemRoot".to_string(), "C:\\Windows".to_string())]
                .into_iter()
                .collect();
        let expanded = expand_windows("%SystemRoot%\\System32;%Nope%", &|name| {
            table.get(name).cloned()
        });
        assert_eq!(expanded, "C:\\Windows\\System32;%Nope%");
    }

    #[test]
    fn expand_windows_handles_unterminated_percent() {
        let expanded = expand_windows("C:\\100%\\bin", &|_| None);
        assert_eq!(expanded, "C:\\100%\\bin");
    }

    #[test]
    fn parse_env_output_splits_on_first_equals_only() {
        let parsed = parse_env_output("PATH=/usr/bin\nWEIRD=a=b=c\nNOEQUALS\n");
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0], ("PATH".to_string(), "/usr/bin".to_string()));
        assert_eq!(parsed[1], ("WEIRD".to_string(), "a=b=c".to_string()));
    }

    #[test]
    fn harness_env_snapshot_matches_contract_c2() {
        let layout = Layout::resolve(
            Path::new(if cfg!(windows) { "C:\\res" } else { "/res" }),
            Path::new(if cfg!(windows) { "C:\\data" } else { "/data" }),
        );
        let shell = HarnessEnv::from_pairs([
            ("HOME", "/home/me"),
            ("LANG", "zh_CN.UTF-8"),
            ("PATH", "/usr/local/bin:/usr/bin"),
        ]);
        let env = harness_env(&layout, &shell, Some("/bin"));

        assert_eq!(
            env.get(ENV_DSH_HOME).unwrap(),
            &layout.dsh_home.display().to_string()
        );
        assert_eq!(env.get(ENV_NO_COLOR).map(String::as_str), Some("1"));
        assert_eq!(env.get(ENV_FORCE_COLOR).map(String::as_str), Some("0"));
        assert_eq!(
            env.get(ENV_NPM_SIDE_EFFECTS_CACHE).map(String::as_str),
            Some("false")
        );
        assert_eq!(
            env.get(ENV_PNPM_SIDE_EFFECTS_CACHE).map(String::as_str),
            Some("false")
        );
        assert_eq!(
            env.get(ENV_PYTHONIOENCODING).map(String::as_str),
            Some("utf-8")
        );
        assert_eq!(
            env.get(ENV_NODE_OPTIONS).map(String::as_str),
            Some("--enable-source-maps")
        );
        // shell 变量透传。
        assert_eq!(env.get("HOME").map(String::as_str), Some("/home/me"));
        assert_eq!(env.get("LANG").map(String::as_str), Some("zh_CN.UTF-8"));
    }

    #[test]
    fn harness_env_merges_path_without_duplicating() {
        let separator = path_separator();
        let root = if cfg!(windows) { "C:\\res" } else { "/res" };
        let data = if cfg!(windows) { "C:\\data" } else { "/data" };
        let layout = Layout::resolve(Path::new(root), Path::new(data));
        let first = if cfg!(windows) {
            "C:\\bin"
        } else {
            "/usr/local/bin"
        };
        let second = if cfg!(windows) { "C:\\win" } else { "/bin" };
        let shell = HarnessEnv::from_pairs([(path_key(), first)]);
        let inherited = format!("{first}{separator}{second}");
        let env = harness_env(&layout, &shell, Some(&inherited));
        assert_eq!(env.path().map(String::as_str), Some(inherited.as_str()));
    }

    #[test]
    fn harness_env_is_deterministic() {
        let layout = Layout::resolve(Path::new("/res"), Path::new("/data"));
        let first = harness_env(&layout, &HarnessEnv::default(), Some("/bin"));
        let second = harness_env(&layout, &HarnessEnv::default(), Some("/bin"));
        assert_eq!(first, second);
    }

    #[test]
    fn harness_env_sets_system_root_fallback_on_windows() {
        if !cfg!(windows) {
            return;
        }
        let layout = Layout::resolve(Path::new("C:\\res"), Path::new("C:\\data"));
        let env = harness_env(&layout, &HarnessEnv::default(), Some("C:\\Windows"));
        assert!(!env.get(ENV_SYSTEM_ROOT).unwrap().is_empty());
    }

    #[test]
    fn set_is_case_insensitive_on_windows() {
        let mut env = HarnessEnv::from_pairs([("Path", "C:\\Windows")]);
        env.set("PATH", "C:\\Bin");
        if cfg!(windows) {
            let path_keys: Vec<&String> = env.iter().map(|(key, _)| key).collect();
            assert_eq!(
                path_keys.len(),
                1,
                "不应同时存在 Path 与 PATH：{path_keys:?}"
            );
            assert_eq!(env.path().map(String::as_str), Some("C:\\Bin"));
        }
    }

    #[test]
    fn path_contains_detects_directory() {
        let path = if cfg!(windows) {
            "C:\\Program Files\\nodejs;C:\\Windows"
        } else {
            "/usr/local/bin:/usr/bin"
        };
        assert!(path_contains(
            path,
            Path::new(if cfg!(windows) {
                "C:\\Windows"
            } else {
                "/usr/bin"
            })
        ));
        assert!(!path_contains(
            path,
            Path::new(if cfg!(windows) { "C:\\Nope" } else { "/nope" })
        ));
    }

    #[test]
    fn captured_environment_always_has_path() {
        let env = capture_shell_environment().expect("环境捕获应成功");
        assert!(env.path().map(|path| !path.is_empty()).unwrap_or(false));
    }
}
