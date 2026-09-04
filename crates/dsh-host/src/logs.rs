//! 日志缓冲、落盘与失败归因（契约 C7）。
//!
//! 三件事：
//!
//! 1. **控制台清洗**：子进程输出先过 ANSI 过滤与编码容错（Windows 上 UTF-8
//!    解码失败时回退系统本地代码页 GBK/CP936），再进入日志与 token 解析。
//!    没有这一步，带颜色的输出会让 `\bdsh web:\s*(\S+)` 正则抓到带转义的脏
//!    URL，中文路径在 GBK 控制台下则整行变豆腐块。
//! 2. **日志环形缓冲**：内存保留最近 200 行（对齐原仓库），带
//!    `[desktop]` / `[stdout]` / `[stderr]` 前缀；同时滚动落盘（5MB × 3 份）。
//! 3. **失败归因**：把「本次尝试」的日志切片喂给模式表，产出结构化的
//!    [`FailureCause`]，供错误页区分「第三方插件故障 / 核心故障」。

use std::collections::VecDeque;
use std::fmt;
use std::fs::{File, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::contracts::{
    ANSI_ESCAPE_PATTERN, LOG_FILE_MAX_BACKUPS, LOG_FILE_MAX_BYTES, LOG_LINE_MAX_BYTES,
    LOG_PREFIX_DESKTOP, LOG_PREFIX_STDERR, LOG_PREFIX_STDOUT, LOG_RING_CAPACITY,
    PATTERN_DSH_ENTRY_FAILED, PATTERN_PORT_IN_USE, PATTERN_UNCAUGHT_EXCEPTION,
    PATTERN_UNHANDLED_REJECTION,
};

/// 日志来源。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogSource {
    /// 宿主自身写入的诊断行。
    Desktop,
    /// 子进程 stdout。
    Stdout,
    /// 子进程 stderr。
    Stderr,
}

impl LogSource {
    /// 日志前缀（与原仓库一致，便于对照排查）。
    pub fn prefix(self) -> &'static str {
        match self {
            LogSource::Desktop => LOG_PREFIX_DESKTOP,
            LogSource::Stdout => LOG_PREFIX_STDOUT,
            LogSource::Stderr => LOG_PREFIX_STDERR,
        }
    }

    /// 由前缀反解来源。
    pub fn from_prefix(prefix: &str) -> Option<Self> {
        match prefix {
            LOG_PREFIX_DESKTOP => Some(LogSource::Desktop),
            LOG_PREFIX_STDOUT => Some(LogSource::Stdout),
            LOG_PREFIX_STDERR => Some(LogSource::Stderr),
            _ => None,
        }
    }
}

impl fmt::Display for LogSource {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.prefix())
    }
}

/// 一行日志：来源 + 已清洗的文本。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogLine {
    /// 来源。
    pub source: LogSource,
    /// 已清洗（去 ANSI、编码容错、截断）的文本。
    pub text: String,
}

impl LogLine {
    /// 构造一行日志。
    pub fn new(source: LogSource, text: impl Into<String>) -> Self {
        Self {
            source,
            text: text.into(),
        }
    }

    /// 解析 `[stdout] …` 形式的文本行（用于回放落盘日志）。
    pub fn parse(text: &str) -> Option<Self> {
        let (prefix, rest) = text.split_once(' ')?;
        LogSource::from_prefix(prefix).map(|source| Self::new(source, rest.trim_start()))
    }
}

impl fmt::Display for LogLine {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} {}", self.source.prefix(), self.text)
    }
}

/// 内存环形日志缓冲（容量 200 行，对齐原仓库）。
#[derive(Clone, Debug, Default)]
pub struct LogRing {
    lines: VecDeque<LogLine>,
    capacity: usize,
}

impl LogRing {
    /// 按契约容量（200 行）创建。
    pub fn new() -> Self {
        Self::with_capacity(LOG_RING_CAPACITY)
    }

    /// 指定容量创建（测试用）。
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            lines: VecDeque::with_capacity(capacity),
            capacity,
        }
    }

    /// 追加一行；超出容量时丢弃最旧的一行。
    pub fn push(&mut self, line: LogLine) {
        if self.lines.len() >= self.capacity {
            self.lines.pop_front();
        }
        self.lines.push_back(line);
    }

    /// 追加一条宿主诊断行。
    pub fn push_desktop(&mut self, text: impl Into<String>) {
        self.push(LogLine::new(LogSource::Desktop, text));
    }

    /// 当前行数。
    pub fn len(&self) -> usize {
        self.lines.len()
    }

    /// 是否为空。
    pub fn is_empty(&self) -> bool {
        self.lines.is_empty()
    }

    /// 全部日志行（按时间顺序）。
    pub fn lines(&self) -> impl Iterator<Item = &LogLine> {
        self.lines.iter()
    }

    /// 最后 `count` 行的文本表示（错误页 / CLI tail 用）。
    pub fn tail(&self, count: usize) -> Vec<String> {
        self.lines
            .iter()
            .rev()
            .take(count)
            .map(|line| line.to_string())
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect()
    }

    /// 「本次尝试」的日志切片：最后一个 `[desktop] starting` 之后的所有行。
    ///
    /// 重启会在同一个缓冲区里追加新日志，归因时必须只看本次，否则上一次的
    /// 错误会污染本次的失败原因。
    pub fn latest_attempt(&self) -> Vec<&LogLine> {
        let start = self
            .lines
            .iter()
            .enumerate()
            .filter(|(_, line)| {
                line.source == LogSource::Desktop && line.text.starts_with("starting")
            })
            .map(|(index, _)| index + 1)
            .next_back()
            .unwrap_or(0);
        self.lines.iter().skip(start).collect()
    }

    /// 清空缓冲。
    pub fn clear(&mut self) {
        self.lines.clear();
    }
}

/// 去掉 ANSI 转义序列（颜色 / 光标控制）。
///
/// # 示例
///
/// ```
/// use dsh_host::logs::strip_ansi;
/// assert_eq!(strip_ansi("\u{1b}[32mok\u{1b}[0m"), "ok");
/// ```
pub fn strip_ansi(input: &str) -> String {
    match regex::Regex::new(ANSI_ESCAPE_PATTERN) {
        Ok(pattern) => pattern.replace_all(input, "").into_owned(),
        Err(_) => input.to_string(),
    }
}

/// 把子进程的一行原始字节清洗成可安全解析的文本。
///
/// 处理顺序：
///
/// 1. 先按 UTF-8 解码（有损）；
/// 2. 若出现替换字符（U+FFFD），Windows 上回退系统本地代码页（GBK/CP936）
///    再解一次，取替换字符更少的结果；
/// 3. 去掉 ANSI 转义序列；
/// 4. 按 [`LOG_LINE_MAX_BYTES`] 截断（按字符边界，避免切出非法 UTF-8）。
///
/// # 示例
///
/// ```
/// use dsh_host::logs::sanitize_line;
/// assert_eq!(sanitize_line(b"\x1b[32mdsh web: http://127.0.0.1:1/?token=a"), "dsh web: http://127.0.0.1:1/?token=a");
/// ```
pub fn sanitize_line(raw: &[u8]) -> String {
    let lossy = String::from_utf8_lossy(raw);
    let mut text = lossy.into_owned();

    if text.contains('\u{FFFD}') {
        if let Some(decoded) = decode_with_system_codepage(raw) {
            if count_replacements(&decoded) < count_replacements(&text) {
                text = decoded;
            }
        }
    }

    let cleaned = strip_ansi(&text);
    truncate_chars(&cleaned, LOG_LINE_MAX_BYTES)
}

fn count_replacements(text: &str) -> usize {
    text.chars().filter(|c| *c == '\u{FFFD}').count()
}

/// 按字节上限截断，且保证落在字符边界上。
fn truncate_chars(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…[truncated]", &text[..end])
}

/// Windows：用系统本地代码页（CP_ACP，中文环境即 GBK/CP936）解码。
#[cfg(windows)]
fn decode_with_system_codepage(bytes: &[u8]) -> Option<String> {
    use windows_sys::Win32::Globalization::MultiByteToWideChar;

    if bytes.is_empty() {
        return None;
    }
    const CP_ACP: u32 = 0;

    unsafe {
        let required = MultiByteToWideChar(
            CP_ACP,
            0,
            bytes.as_ptr(),
            bytes.len() as i32,
            std::ptr::null_mut(),
            0,
        );
        if required <= 0 {
            return None;
        }
        let mut buffer = vec![0u16; required as usize];
        let written = MultiByteToWideChar(
            CP_ACP,
            0,
            bytes.as_ptr(),
            bytes.len() as i32,
            buffer.as_mut_ptr(),
            required,
        );
        if written <= 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&buffer[..written as usize]))
    }
}

#[cfg(not(windows))]
fn decode_with_system_codepage(_bytes: &[u8]) -> Option<String> {
    None
}

/// 结构化失败归因（契约 C7）。
///
/// 错误页据此区分「第三方插件故障」（可进安全模式修复）与「核心故障」。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FailureCause {
    /// C8 — 资源目录缺少必需条目（安装损坏）。
    MissingResource { name: String, path: String },
    /// 无法派生子进程。
    SpawnFailed { detail: String },
    /// C7 — `DSH entry failed:`：入口加载期失败，常见于插件不兼容。
    DshEntryFailed { detail: String },
    /// C7 — `uncaught exception:`。
    UncaughtException { detail: String },
    /// C7 — `unhandled rejection:`。
    UnhandledRejection { detail: String },
    /// 端口被占用：立即快速失败并换端口重试（任务 1.3）。
    PortInUse { detail: String },
    /// C4 — 超过就绪总超时。
    StartupTimeout { seconds: u64 },
    /// C6 — 子进程在 Ready 之后退出（exit watcher 捕获）。
    UnexpectedExit { code: Option<i32> },
    /// C7 — 兜底：stderr 末行。
    StderrTail { detail: String },
    /// 无可用线索。
    Unknown,
}

impl FailureCause {
    /// 稳定的类别标识（前端按此分派文案与按钮）。
    pub fn kind(&self) -> &'static str {
        match self {
            FailureCause::MissingResource { .. } => "missing_resource",
            FailureCause::SpawnFailed { .. } => "spawn_failed",
            FailureCause::DshEntryFailed { .. } => "dsh_entry_failed",
            FailureCause::UncaughtException { .. } => "uncaught_exception",
            FailureCause::UnhandledRejection { .. } => "unhandled_rejection",
            FailureCause::PortInUse { .. } => "port_in_use",
            FailureCause::StartupTimeout { .. } => "startup_timeout",
            FailureCause::UnexpectedExit { .. } => "unexpected_exit",
            FailureCause::StderrTail { .. } => "stderr_tail",
            FailureCause::Unknown => "unknown",
        }
    }

    /// 是否属于「第三方插件故障」（阶段 5 安全模式据此给出恢复入口）。
    ///
    /// `DshEntryFailed` 在原仓库的语义里绝大多数由插件加载失败触发；
    /// 未捕获异常 / rejection 同样常见于插件代码，因此都归入可恢复类。
    pub fn is_plugin_fault(&self) -> bool {
        matches!(
            self,
            FailureCause::DshEntryFailed { .. }
                | FailureCause::UncaughtException { .. }
                | FailureCause::UnhandledRejection { .. }
        )
    }

    /// 是否值得自动换端口重试。
    pub fn is_retryable(&self) -> bool {
        matches!(self, FailureCause::PortInUse { .. })
    }
}

impl fmt::Display for FailureCause {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FailureCause::MissingResource { name, path } => {
                write!(formatter, "缺少捆绑资源 {name}：{path}")
            }
            FailureCause::SpawnFailed { detail } => {
                write!(formatter, "无法启动 Harness 进程：{detail}")
            }
            FailureCause::DshEntryFailed { detail } => {
                write!(
                    formatter,
                    "Harness 入口加载失败（多为插件不兼容）：{detail}"
                )
            }
            FailureCause::UncaughtException { detail } => {
                write!(formatter, "Harness 抛出未捕获异常：{detail}")
            }
            FailureCause::UnhandledRejection { detail } => {
                write!(formatter, "Harness 出现未处理的 Promise 拒绝：{detail}")
            }
            FailureCause::PortInUse { detail } => {
                write!(formatter, "本地端口被占用：{detail}")
            }
            FailureCause::StartupTimeout { seconds } => {
                write!(formatter, "Harness 在 {seconds} 秒内未就绪")
            }
            FailureCause::UnexpectedExit { code } => match code {
                Some(code) => write!(formatter, "Harness 进程意外退出（退出码 {code}）"),
                None => write!(formatter, "Harness 进程被信号终止"),
            },
            FailureCause::StderrTail { detail } => write!(formatter, "{detail}"),
            FailureCause::Unknown => write!(formatter, "Harness 启动失败，原因未知"),
        }
    }
}

/// 从「本次尝试」的日志中归因失败原因（契约 C7 的可执行快照）。
///
/// 优先级：`DSH entry failed:` → `uncaught exception:` → `unhandled rejection:`
/// → 端口占用 → stderr 末行中的错误句 → stderr 末行。
///
/// # 示例
///
/// ```
/// use dsh_host::logs::{extract_failure_cause, LogLine, LogSource};
///
/// let lines = vec![LogLine::new(LogSource::Stderr, "DSH entry failed: boom")];
/// let cause = extract_failure_cause(&lines).unwrap();
/// assert_eq!(cause.kind(), "dsh_entry_failed");
/// ```
pub fn extract_failure_cause(lines: &[LogLine]) -> Option<FailureCause> {
    let stderr: Vec<&str> = lines
        .iter()
        .filter(|line| line.source == LogSource::Stderr)
        .map(|line| line.text.as_str())
        .collect();

    if let Some(detail) = first_capture(&stderr, PATTERN_DSH_ENTRY_FAILED) {
        return Some(FailureCause::DshEntryFailed { detail });
    }
    if let Some(detail) = first_capture(&stderr, PATTERN_UNCAUGHT_EXCEPTION) {
        return Some(FailureCause::UncaughtException { detail });
    }
    if let Some(detail) = first_capture(&stderr, PATTERN_UNHANDLED_REJECTION) {
        return Some(FailureCause::UnhandledRejection { detail });
    }
    if let Some(detail) = stderr
        .iter()
        .find(|line| line.contains(PATTERN_PORT_IN_USE))
        .map(|line| line.trim().to_string())
    {
        return Some(FailureCause::PortInUse { detail });
    }

    if let Some(detail) = stderr
        .iter()
        .rev()
        .find(|line| is_error_like(line))
        .map(|line| line.trim().to_string())
    {
        return Some(FailureCause::StderrTail { detail });
    }

    stderr
        .last()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .map(|detail| FailureCause::StderrTail {
            detail: detail.to_string(),
        })
}

fn first_capture(lines: &[&str], pattern: &str) -> Option<String> {
    let regex = regex::Regex::new(pattern).ok()?;
    lines.iter().find_map(|line| {
        regex
            .captures(line)
            .and_then(|captures| captures.get(1))
            .map(|matched| matched.as_str().trim().to_string())
    })
}

fn is_error_like(line: &str) -> bool {
    let line = line.trim();
    if line.is_empty() || line.len() >= 200 {
        return false;
    }
    ["error", "Error", "ERROR", "failed", "Failed", "FAILED"]
        .iter()
        .any(|needle| line.contains(needle))
}

/// 滚动落盘的 Harness 日志（5MB × 3 份）。
pub struct LogFile {
    path: PathBuf,
    max_bytes: u64,
    max_backups: usize,
    file: Option<File>,
    size: u64,
}

impl LogFile {
    /// 以追加模式打开（不存在则创建），并沿用已有文件大小。
    pub fn open(path: impl Into<PathBuf>) -> std::io::Result<Self> {
        Self::with_limits(path.into(), LOG_FILE_MAX_BYTES, LOG_FILE_MAX_BACKUPS)
    }

    /// 指定滚动阈值打开（测试用）。
    pub fn with_limits(path: PathBuf, max_bytes: u64, max_backups: usize) -> std::io::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let size = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        Ok(Self {
            path,
            max_bytes,
            max_backups,
            file: Some(file),
            size,
        })
    }

    /// 落盘路径。
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 写入一行（自动滚动）。
    pub fn append_line(&mut self, line: &str) -> std::io::Result<()> {
        let Some(file) = self.file.as_mut() else {
            return Ok(());
        };
        let bytes = format!("{line}\n").into_bytes();
        file.write_all(&bytes)?;
        file.flush()?;
        self.size += bytes.len() as u64;
        if self.size >= self.max_bytes {
            self.rotate()?;
        }
        Ok(())
    }

    /// 关闭并释放文件句柄（更新前必须调用，否则 Windows 上文件被锁，R-11）。
    pub fn close(&mut self) {
        self.file = None;
    }

    fn rotate(&mut self) -> std::io::Result<()> {
        self.file = None;

        for index in (1..self.max_backups).rev() {
            let from = backup_path(&self.path, index);
            let to = backup_path(&self.path, index + 1);
            if from.exists() {
                std::fs::rename(&from, &to)?;
            }
        }
        if self.path.exists() {
            std::fs::rename(&self.path, backup_path(&self.path, 1))?;
        }

        self.file = Some(
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.path)?,
        );
        self.size = 0;
        Ok(())
    }
}

fn backup_path(path: &Path, index: usize) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(format!(".{index}"));
    PathBuf::from(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stderr_lines(lines: &[&str]) -> Vec<LogLine> {
        lines
            .iter()
            .map(|line| LogLine::new(LogSource::Stderr, *line))
            .collect()
    }

    #[test]
    fn log_line_display_uses_contract_prefix() {
        let line = LogLine::new(LogSource::Stdout, "hello");
        assert_eq!(line.to_string(), "[stdout] hello");
        assert_eq!(LogLine::parse("[stderr] boom").unwrap().text, "boom");
        assert!(LogLine::parse("no prefix here").is_none());
    }

    #[test]
    fn ring_respects_capacity() {
        let mut ring = LogRing::with_capacity(3);
        for index in 0..5 {
            ring.push(LogLine::new(LogSource::Desktop, index.to_string()));
        }
        assert_eq!(ring.len(), 3);
        let texts: Vec<&str> = ring.lines().map(|line| line.text.as_str()).collect();
        assert_eq!(texts, vec!["2", "3", "4"]);
    }

    #[test]
    fn ring_tail_returns_chronological_order() {
        let mut ring = LogRing::new();
        for index in 0..5 {
            ring.push(LogLine::new(LogSource::Desktop, index.to_string()));
        }
        let tail = ring.tail(2);
        assert_eq!(
            tail,
            vec!["[desktop] 3".to_string(), "[desktop] 4".to_string()]
        );
    }

    #[test]
    fn latest_attempt_slices_after_last_starting_marker() {
        let mut ring = LogRing::new();
        ring.push_desktop("starting attempt 1");
        ring.push(LogLine::new(LogSource::Stderr, "old failure"));
        ring.push_desktop("starting attempt 2");
        ring.push(LogLine::new(LogSource::Stderr, "new failure"));

        let attempt: Vec<&str> = ring
            .latest_attempt()
            .iter()
            .map(|line| line.text.as_str())
            .collect();
        assert_eq!(
            attempt,
            vec!["new failure"],
            "上一次尝试的日志不应污染本次归因"
        );
    }

    #[test]
    fn strip_ansi_removes_color_codes() {
        assert_eq!(strip_ansi("\u{1b}[1;32mdone\u{1b}[0m"), "done");
        assert_eq!(strip_ansi("plain"), "plain");
    }

    #[test]
    fn sanitize_line_strips_ansi_before_token_parsing() {
        let raw = b"\x1b[36mdsh web:\x1b[0m http://127.0.0.1:4173/?token=abc";
        assert_eq!(
            sanitize_line(raw),
            "dsh web: http://127.0.0.1:4173/?token=abc"
        );
    }

    #[test]
    fn sanitize_line_truncates_huge_lines() {
        let raw = vec![b'x'; LOG_LINE_MAX_BYTES + 500];
        let sanitized = sanitize_line(&raw);
        assert!(sanitized.len() <= LOG_LINE_MAX_BYTES + 32);
        assert!(sanitized.ends_with("…[truncated]"));
    }

    #[test]
    fn sanitize_line_is_valid_utf8_for_gbk_bytes() {
        // GBK 编码的「中文用户名」在 UTF-8 下是非法序列。
        let gbk: [u8; 4] = [0xD6, 0xD0, 0xCE, 0xC4];
        let sanitized = sanitize_line(&gbk);
        assert!(!sanitized.is_empty());
        // 无论是否回退成功，结果都必须是合法 UTF-8（本函数返回 String，编译期保证）。
        assert!(sanitized.chars().all(|c| !c.is_ascii_control()));
    }

    #[test]
    fn cause_detects_dsh_entry_failure() {
        let lines = stderr_lines(&["[arness-node] boot", "DSH entry failed: plugin broke"]);
        let cause = extract_failure_cause(&lines).unwrap();
        assert_eq!(cause.kind(), "dsh_entry_failed");
        assert!(cause.is_plugin_fault());
        assert!(cause.to_string().contains("plugin broke"));
    }

    #[test]
    fn cause_detects_uncaught_and_rejection() {
        let lines = stderr_lines(&["uncaught exception: boom"]);
        assert_eq!(
            extract_failure_cause(&lines).unwrap().kind(),
            "uncaught_exception"
        );

        let lines = stderr_lines(&["unhandled rejection: nope"]);
        assert_eq!(
            extract_failure_cause(&lines).unwrap().kind(),
            "unhandled_rejection"
        );
    }

    #[test]
    fn cause_detects_port_in_use_and_is_retryable() {
        let lines =
            stderr_lines(&["Error: listen EADDRINUSE: address already in use 127.0.0.1:4173"]);
        let cause = extract_failure_cause(&lines).unwrap();
        assert_eq!(cause.kind(), "port_in_use");
        assert!(cause.is_retryable());
    }

    #[test]
    fn cause_prefers_specific_pattern_over_stderr_tail() {
        let lines = stderr_lines(&["random noise", "DSH entry failed: specific"]);
        assert_eq!(
            extract_failure_cause(&lines).unwrap().kind(),
            "dsh_entry_failed"
        );
    }

    #[test]
    fn cause_falls_back_to_stderr_tail() {
        let lines = stderr_lines(&["loading", "Something failed to start"]);
        assert_eq!(extract_failure_cause(&lines).unwrap().kind(), "stderr_tail");
    }

    #[test]
    fn cause_returns_none_without_stderr() {
        let lines = vec![LogLine::new(LogSource::Stdout, "all good")];
        assert!(extract_failure_cause(&lines).is_none());
    }

    #[test]
    fn log_file_rotates_by_size() {
        let unique = format!(
            "dsh-host-logs-{}-{}",
            std::process::id(),
            LOG_LINE_MAX_BYTES
        );
        let path = std::env::temp_dir().join(unique).join("harness.log");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());

        let mut log = LogFile::with_limits(path.clone(), 64, 3).unwrap();
        for index in 0..10 {
            log.append_line(&format!("line {index} padding padding padding"))
                .unwrap();
        }
        drop(log);

        assert!(backup_path(&path, 1).exists(), "应产生 .1 备份");
        assert!(std::fs::metadata(&path).unwrap().len() < 64);

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
