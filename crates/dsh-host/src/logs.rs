//! 日志缓冲、落盘与失败归因（契约 C7）。
//!
//! 三件事：
//!
//! 1. **控制台清洗**：子进程输出先过 ANSI 过滤与编码容错（Windows 上 UTF-8
//!    解码失败时回退系统本地代码页 GBK/CP936），再进入日志与 token 解析。
//!    没有这一步，带颜色的输出会让 `\bdsh web:\s*(\S+)` 正则抓到带转义的脏
//!    URL，中文路径在 GBK 控制台下则整行变豆腐块。
//!
//!    清洗拆成两步，顺序固定：[`decode_line`] 只解码不脱敏（供解析用），
//!    [`LineRedactor::scrub`] 在解码之后再抹掉凭据（供记录用）。首航 token 与
//!    `dsh-auth-*` cookie 因此**在生成阶段**就不会进入内存日志或落盘文件；
//!    跨行形态（PEM 私钥块）靠 [`LineRedactor`] 持有的行间状态处理。
//! 2. **日志环形缓冲**：内存保留最近 200 行（对齐原仓库），带
//!    `[desktop]` / `[stdout]` / `[stderr]` 前缀；同时滚动落盘（5MB × 3 份）。
//! 3. **失败归因**：把「本次尝试」的日志切片喂给模式表，产出结构化的
//!    [`FailureCause`]，供错误页区分「第三方插件故障 / 核心故障」。

use std::collections::VecDeque;
use std::fmt;
use std::fs::{File, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use crate::contracts::{
    ANSI_ESCAPE_PATTERN, LOG_FILE_MAX_BACKUPS, LOG_FILE_MAX_BYTES, LOG_LEVEL_DEBUG,
    LOG_LEVEL_ERROR, LOG_LEVEL_INFO, LOG_LEVEL_WARN, LOG_LINE_MAX_BYTES, LOG_PREFIX_DESKTOP,
    LOG_PREFIX_STDERR, LOG_PREFIX_STDOUT, LOG_RING_CAPACITY, LOG_STARTING_MARKER,
    PATTERN_DSH_ENTRY_FAILED, PATTERN_PLUGIN_FAULT, PATTERN_PORT_IN_USE,
    PATTERN_UNCAUGHT_EXCEPTION, PATTERN_UNHANDLED_REJECTION, PATTERN_WORKER_FAULT,
};

/// 日志级别。
///
/// **级别用文本前缀承载，不进 [`LogLine`] 结构**：`LogLine` 是 GUI 直接依赖的
/// 公开结构（`state.rs` 里按两参构造并序列化给前端），加字段会破坏它的
/// serde 形状。前缀方案的代价是解析时要切字符串，收益是 GUI、日志回放、
/// `latest_attempt` 全部零改动。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogLevel {
    /// 错误：可预期的失败路径。
    Error,
    /// 警告：行为异常但不阻断启动（如端口被 dsh 自行改写）。
    Warn,
    /// 信息：常规诊断行（默认级别）。
    #[default]
    Info,
    /// 调试：排障才需要看的高频细节。
    Debug,
}

impl LogLevel {
    /// 文本前缀（固定 5 字符，便于按列对齐与 `cut` 切片）。
    pub fn prefix(self) -> &'static str {
        match self {
            LogLevel::Error => LOG_LEVEL_ERROR,
            LogLevel::Warn => LOG_LEVEL_WARN,
            LogLevel::Info => LOG_LEVEL_INFO,
            LogLevel::Debug => LOG_LEVEL_DEBUG,
        }
    }
}

impl fmt::Display for LogLevel {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.prefix())
    }
}

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
    /// 已清洗（去 ANSI、编码容错、截断）并**脱敏**的文本。
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

    /// 追加一条宿主诊断行（默认 [`LogLevel::Info`]，不带级别前缀）。
    pub fn push_desktop(&mut self, text: impl Into<String>) {
        self.push(LogLine::new(LogSource::Desktop, text));
    }

    /// 追加一条**带级别前缀**的日志行。
    ///
    /// 渲染结果形如 `[desktop] WARN  port mismatch: reserved 4173, reported 5000`。
    /// 现有 [`Self::push`] / [`Self::push_desktop`] 的语义保持不变（无级别前缀），
    /// 因此 GUI 与日志回放链路无需任何改动。
    ///
    /// # 示例
    ///
    /// ```
    /// use dsh_host::logs::{LogLevel, LogRing, LogSource};
    ///
    /// let mut ring = LogRing::new();
    /// ring.push_with(LogLevel::Warn, LogSource::Desktop, "something odd");
    /// let tail = ring.tail(1);
    /// assert_eq!(tail[0], "[desktop] WARN  something odd");
    /// ```
    pub fn push_with(&mut self, level: LogLevel, source: LogSource, text: impl Into<String>) {
        self.push(LogLine::new(source, format!("{level} {}", text.into())));
    }

    /// 追加一条带级别的宿主诊断行（[`Self::push_with`] 的便捷形式）。
    pub fn push_desktop_with(&mut self, level: LogLevel, text: impl Into<String>) {
        self.push_with(level, LogSource::Desktop, text);
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

    /// 「本次尝试」的日志切片：最后一个 [`LOG_STARTING_MARKER`] 之后的所有行。
    ///
    /// 重启会在同一个缓冲区里追加新日志，归因时必须只看本次，否则上一次的
    /// 错误会污染本次的失败原因。
    ///
    /// 判定必须用契约常量而不是硬编码字符串：两者一旦漂移，归因会**静默失效**
    /// （看起来在用上次尝试的错误行，却不报错）。
    pub fn latest_attempt(&self) -> Vec<&LogLine> {
        let start = self
            .lines
            .iter()
            .enumerate()
            .filter(|(_, line)| {
                line.source == LogSource::Desktop
                    && line.to_string().starts_with(LOG_STARTING_MARKER)
            })
            .map(|(index, _)| index + 1)
            .next_back()
            .unwrap_or(0);
        self.lines.iter().skip(start).collect()
    }

    /// 全部日志行的克隆（Vec 形式，供诊断分析等场景使用）。
    pub fn to_vec(&self) -> Vec<LogLine> {
        self.lines.iter().cloned().collect()
    }

    /// 清空缓冲。
    pub fn clear(&mut self) {
        self.lines.clear();
    }
}

/// 去掉 ANSI 转义序列（颜色 / 光标控制）。
///
/// # 性能
///
/// 正则**只编译一次**（[`OnceLock`] 缓存），不在每行重编译。
/// [`sanitize_line`] 对子进程的**每一行**都会走到这里，而日志泵是启动期
/// 与运行期最高频的路径；实测每行重编译约 68.9 µs，复用后约 0.4 µs。
///
/// 语义与原先的「编译失败则原样返回」保持一致：常量模式编译失败时
/// [`OnceLock::get_or_init`] 会 panic，因此这里显式捕获为 [`None`]，
/// 退化成原样返回——契约常量编译不过属于构建期缺陷，不该在运行时炸掉日志泵。
///
/// # 示例
///
/// ```
/// use dsh_host::logs::strip_ansi;
/// assert_eq!(strip_ansi("\u{1b}[32mok\u{1b}[0m"), "ok");
/// ```
pub fn strip_ansi(input: &str) -> String {
    match ansi_escape_pattern() {
        Some(pattern) => pattern.replace_all(input, "").into_owned(),
        None => input.to_string(),
    }
}

/// ANSI 转义正则的单次编译缓存。
///
/// 返回 `None` 而非 panic：与优化前「`Regex::new` 失败则原样返回」的
/// 降级语义逐字对齐（见 [`strip_ansi`] 的说明）。
fn ansi_escape_pattern() -> Option<&'static regex::Regex> {
    static PATTERN: OnceLock<Option<regex::Regex>> = OnceLock::new();
    PATTERN
        .get_or_init(|| regex::Regex::new(ANSI_ESCAPE_PATTERN).ok())
        .as_ref()
}

/// 把子进程的一行原始字节解码成**未经脱敏**的文本。
///
/// 处理顺序：
///
/// 1. 先按 UTF-8 解码（有损）；
/// 2. 若出现替换字符（U+FFFD），Windows 上回退系统本地代码页（GBK/CP936）
///    再解一次，取替换字符更少的结果；
/// 3. 去掉 ANSI 转义序列；
/// 4. 按 [`LOG_LINE_MAX_BYTES`] 截断（按字符边界，避免切出非法 UTF-8）。
///
/// **本函数不脱敏，凭据原样保留**。它服务于「需要读原文」的调用方：
/// 启动握手要从 `dsh web: <url>?token=<值>` 里提取端点与 token
/// （`launch.rs::parse_launch_line`），脱敏后再解析就拿不到 token 了。
/// 需要「可以拿出来看 / 落盘」的文本请用 [`sanitize_line`]。
///
/// # 示例
///
/// ```
/// use dsh_host::logs::decode_line;
/// assert_eq!(decode_line(b"\x1b[32mdsh web: http://127.0.0.1:1/?token=abcdefgh12345"), "dsh web: http://127.0.0.1:1/?token=abcdefgh12345");
/// ```
pub fn decode_line(raw: &[u8]) -> String {
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

/// 逐行脱敏器：在 [`sanitize_line`] 的单行脱敏之上，额外维护**跨行状态**
/// ——当前是否正处在一个 PEM 私钥块的内部。
///
/// # 为什么需要它
///
/// 脱敏规则表里的 PEM 私钥块是**跨行**形态
/// （`(?s)-----BEGIN … PRIVATE KEY-----.*?-----END … PRIVATE KEY-----`），
/// 而日志泵是逐行喂入的：`-----BEGIN RSA PRIVATE KEY-----` 单独一行时看不到
/// 对应的 `END`，规则不命中；随后的 base64 正文每行也都不匹配任何规则。
/// 结果是**私钥整块原样落进 `harness.log`**——这不是"未命中形态"的留白，
/// 而是"声明覆盖了 PEM 却没覆盖"。状态只能由调用方跨行持有，所以单行函数
/// 解决不了它，必须由本类型承担。
///
/// # 为什么保持逐行一进一出
///
/// 每个输入行仍产出**恰好一个**结果，行数不被改写。内存环、落盘文件与子进程
/// 输出的行号因此一一对应；若把整块折叠成一行，排障时行号全部错位，代价比
/// 多吞几行更大。
///
/// # 示例
///
/// ```
/// use dsh_host::logs::LineRedactor;
///
/// let mut redactor = LineRedactor::new();
/// assert_eq!(redactor.scrub(b"-----BEGIN RSA PRIVATE KEY-----"), "<redacted>");
/// assert_eq!(redactor.scrub(b"MIIEowIBAAKCAQEA7h1s"), "<redacted>");
/// assert!(redactor.in_private_key_block());
/// assert_eq!(redactor.scrub(b"-----END RSA PRIVATE KEY-----"), "<redacted>");
/// assert!(!redactor.in_private_key_block());
/// ```
#[derive(Debug, Default)]
pub struct LineRedactor {
    /// 已看到 `-----BEGIN … PRIVATE KEY-----` 且还没看到对应的 `END`。
    in_pem: bool,
}

impl LineRedactor {
    /// 新建（初始不在私钥块内）。
    pub fn new() -> Self {
        Self::default()
    }

    /// 清洗**一行**，并跨行维护 PEM 私钥块状态。返回值已是可记录文本。
    ///
    /// 规则（顺序即优先级，**不可调换**）：
    ///
    /// 1. 本行含 `-----END … PRIVATE KEY-----` ⇒ 整行替换为 `<redacted>` 并复位，
    ///    **与当前是否在块内无关**。这一条必须排最前：放在块内判定之后、或让
    ///    任何"分界判据"先跑，都可能把 `END` 行打回普通行，导致"头抹了、尾留着"
    ///    的不对称。
    /// 2. 已在块内 ⇒ 本行若**像 PEM 正文**（纯 base64 字符或空白）则继续整行替换；
    ///    否则视为块已截断，复位后按普通行处理（见下）。
    /// 3. 本行开启私钥块 ⇒ 整行替换并置位。
    /// 4. 其余 ⇒ 走规则表（与 [`sanitize_line`] 逐字节一致，不另写一份规则）。
    ///
    /// # 块内的"像不像正文"判据：只看字符集，不看长度
    ///
    /// 判据是「含 base64 之外的可打印字符」。**不能用长度下限**：PEM 正文按 64
    /// 字符折行，但末行常是余数（可能只有 4 个字符），长度阈值会把合法末行当成
    /// 噪声、提前复位，正好在密钥块尾部开一个口子。字符集判据同时能挡住误吞：
    /// 正常日志行几乎必然含空格以外的符号（`dsh web: http://…`、`[desktop] …`、
    /// `2026-10-30 12:00:00 …`），必然触发复位。
    ///
    /// 空白（含 `\r`）不算"非 base64"：Windows 子进程输出是 CRLF，`read_until`
    /// 会把 `\r` 留在行尾；若把它当噪声，每行正文都会立刻复位。
    ///
    /// **已知代价**：未闭合的块若后面紧跟纯 base64 形态的行（例如一串无分隔的
    /// 十六进制），会被多吞几行；而正常日志行会立刻复位，不会无限吞下去。
    pub fn scrub(&mut self, raw: &[u8]) -> String {
        let text = decode_line(raw);

        // 规则 1：END 行无条件抹掉——避免"头抹了、尾留着"的不对称。
        if closes_private_key_block(&text) {
            self.in_pem = false;
            return crate::diagnostics_export::REDACTED.to_string();
        }

        // 规则 2：块内。像正文就继续吞；不像正文说明块已截断，复位后按普通行处理。
        if self.in_pem {
            if looks_like_private_key_body(&text) {
                return crate::diagnostics_export::REDACTED.to_string();
            }
            self.in_pem = false;
        }

        // 规则 3：跨行的 BEGIN 行。
        if opens_private_key_block(&text) {
            self.in_pem = true;
            return crate::diagnostics_export::REDACTED.to_string();
        }

        // 规则 4：普通行仍走同一份规则表。
        crate::diagnostics_export::redact_stream(&text)
    }

    /// 是否正处在被吞掉的私钥块内（供测试断言与诊断用）。
    pub fn in_private_key_block(&self) -> bool {
        self.in_pem
    }
}

/// 本行是否开启了 PEM 私钥块（`-----BEGIN … PRIVATE KEY-----`）。
///
/// 只认**私钥**：`-----BEGIN CERTIFICATE-----` / `PUBLIC KEY` 属可公开材料，
/// 抹掉只会让排障失去上下文。
fn opens_private_key_block(text: &str) -> bool {
    text.contains("-----BEGIN ") && text.contains("PRIVATE KEY-----")
}

/// 本行是否结束了 PEM 私钥块（`-----END … PRIVATE KEY-----`）。
fn closes_private_key_block(text: &str) -> bool {
    text.contains("-----END ") && text.contains("PRIVATE KEY-----")
}

/// 本行是否**像** PEM 私钥正文：只有 base64 字符与空白。
///
/// 判据刻意不设长度下限（见 [`LineRedactor::scrub`] 的说明）。`-` 与 `_` 一并
/// 放行是为了容忍 base64url 变体；放宽它们只会让"多吞"更容易发生，不会让正文
/// 漏出，方向是安全侧。
fn looks_like_private_key_body(text: &str) -> bool {
    text.chars().all(|c| {
        c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=' | '-' | '_') || c.is_whitespace()
    })
}

/// 把子进程的一行原始字节清洗成**可以记录**的文本（[`decode_line`] + 脱敏）。
///
/// **脱敏放在这里而不是放在落盘处**，因为本函数的调用方要的就是「可以拿出来
/// 看 / 可以写文件」的文本：内存日志缓冲（`LogRing`）、`push_live` 的实时环
/// 形缓冲、`harness.log` 的滚动落盘、诊断包导出的日志尾巴，全都直接消费它。
/// 若脱敏放在最后一环（比如只在写文件前做），任何一个新增的消费者都会重新
/// 把 token / cookie 原样泄漏出去——这是 CD09 在源头堵住的理由。
///
/// 脱敏规则由 [`crate::diagnostics_export::redact_stream`] 统一提供：token /
/// cookie / API key（含 `x-api-key` 头）/ Bearer / `Authorization: Basic`
/// 凭据段 / 代理口令 / PEM 私钥块 / JWT / 平台 token / 非常规 query key。
/// 它**不**抹本地路径里的用户名：本地日志要保留真实路径才便于排障。
///
/// # 跨行形态必须用 [`LineRedactor`]
///
/// 本函数**无跨行状态**：一整块 PEM 私钥被逐行喂进来时，单行视角看不出块边界，
/// 抹不掉（本函数只能抹掉「本行内自带 `BEGIN` 或 `END`」的行，正文行无从判断）。
/// 处理日志流（如 [`crate::launch`] 的行泵）必须逐行调用
/// [`LineRedactor::scrub`]，而不是对每行独立调用本函数。
///
/// 需要未脱敏原文（例如提取启动端点）的调用方必须改用 [`decode_line`]。
///
/// # 示例
///
/// ```
/// use dsh_host::logs::sanitize_line;
/// assert_eq!(sanitize_line(b"\x1b[32mdsh web: http://127.0.0.1:1/?token=abcdefgh12345"), "dsh web: http://127.0.0.1:1/?token=<redacted>");
/// ```
pub fn sanitize_line(raw: &[u8]) -> String {
    LineRedactor::new().scrub(raw)
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
    /// C7 — `[dsh-plugin-fault]`：插件重复注册/崩溃故障。
    PluginFault { detail: String },
    /// C7 — `[dsh-worker-fault]`：插件 Worker 隔离沙盒故障。
    WorkerFault { detail: String },
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
            FailureCause::PluginFault { .. } => "plugin_fault",
            FailureCause::WorkerFault { .. } => "worker_fault",
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
                | FailureCause::PluginFault { .. }
                | FailureCause::WorkerFault { .. }
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
            FailureCause::PluginFault { detail } => {
                write!(formatter, "Harness 插件注册/运行故障：{detail}")
            }
            FailureCause::WorkerFault { detail } => {
                write!(formatter, "Harness 插件 Worker 隔离沙盒故障：{detail}")
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
    if let Some(detail) = first_capture(&stderr, PATTERN_PLUGIN_FAULT) {
        return Some(FailureCause::PluginFault { detail });
    }
    if let Some(detail) = first_capture(&stderr, PATTERN_WORKER_FAULT) {
        return Some(FailureCause::WorkerFault { detail });
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

    /// 性能回归护栏：ANSI 正则必须**只编译一次**。
    ///
    /// 优化前 [`strip_ansi`] 每次调用都 `Regex::new`（实测 68.9 µs/行，
    /// 而日志泵对子进程**每一行**都会调用它）。判据用「缓存是否已初始化」
    /// 这一可观测事实，而不是墙钟阈值——后者在负载下的 CI 上必然抖动。
    #[test]
    fn strip_ansi_compiles_pattern_only_once() {
        // 先跑一次，确保缓存已建立。
        let _ = strip_ansi("warmup");
        // 第二次起必须命中同一个 OnceLock 实例。
        let first = ansi_escape_pattern().map(|re| re.as_str().to_owned());
        let second = ansi_escape_pattern().map(|re| re.as_str().to_owned());
        assert_eq!(
            first, second,
            "两次调用必须返回同一个缓存的正则，而非各自重新编译"
        );
        assert!(first.is_some(), "契约常量正则必须能编译");
    }

    /// 并发护栏：多线程同时清洗时结果必须与单线程一致。
    ///
    /// 共享 `OnceLock<Regex>` 后，`Regex` 需满足跨线程只读共享的约束；
    /// 本测试把它变成可证伪的断言，而不是靠文档承诺。
    #[test]
    fn strip_ansi_is_deterministic_under_concurrency() {
        // 用 `static` 而非局部数组：数组因此是 `'static`，每个线程都能
        // 直接引用，无需 per-thread 遮蔽（clippy::redundant_locals）。
        static LINES: [&str; 4] = [
            "\u{1b}[32mgreen\u{1b}[0m",
            "plain text without escapes",
            "\u{1b}[1;31;40mred on black\u{1b}[0m tail",
            "",
        ];
        let expected: Vec<String> = LINES.iter().map(|line| strip_ansi(line)).collect();

        let handles: Vec<_> = (0..8)
            .map(|_| {
                std::thread::spawn(|| {
                    LINES
                        .iter()
                        .map(|line| strip_ansi(line))
                        .collect::<Vec<_>>()
                })
            })
            .collect();

        for handle in handles {
            assert_eq!(
                handle.join().expect("清洗线程不应 panic"),
                expected,
                "并发清洗结果必须与单线程逐字一致"
            );
        }
    }

    /// 去 ANSI 必须发生在 token 解析之前；而**记录用的**文本必须已脱敏。
    ///
    /// 这是 CD09 的核心分界：解析走 [`decode_line`]（拿得到 token 原文），
    /// 记录走 [`sanitize_line`]（token 已换成 `<redacted>`）。
    #[test]
    fn sanitize_line_strips_ansi_before_token_parsing() {
        let raw = b"\x1b[36mdsh web:\x1b[0m http://127.0.0.1:4173/?token=abcdefgh12345";
        // 解析路径：去 ANSI 在先，token 仍可被提取。
        let decoded = decode_line(raw);
        assert_eq!(
            decoded,
            "dsh web: http://127.0.0.1:4173/?token=abcdefgh12345"
        );
        assert!(decoded.contains("token=abcdefgh12345"));
        // 记录路径：同样的字节，token 必须已被替换。
        let sanitized = sanitize_line(raw);
        assert!(
            sanitized.contains("token=<redacted>"),
            "记录用的文本必须脱敏：{sanitized}"
        );
        assert!(
            !sanitized.contains("abcdefgh12345"),
            "token 原文不得出现在记录里：{sanitized}"
        );
    }

    /// 源头脱敏：首航 token 与 `dsh-auth-*` cookie 都不得以原文进入日志。
    #[test]
    fn sanitize_line_redacts_token_and_auth_cookie() {
        let token_line = sanitize_line(b"dsh web: http://127.0.0.1:4173/?token=abcdefgh12345");
        assert!(token_line.contains("token=<redacted>"), "{token_line}");
        assert!(!token_line.contains("abcdefgh12345"), "{token_line}");

        let cookie_line = sanitize_line(b"Cookie: dsh-auth-session=supersecretvalue123");
        assert!(
            cookie_line.contains("dsh-auth-session=<redacted>"),
            "{cookie_line}"
        );
        assert!(!cookie_line.contains("supersecretvalue123"), "{cookie_line}");
    }

    /// 解析路径必须拿得到原文：脱敏只能发生在写日志那一侧。
    #[test]
    fn decode_line_keeps_credentials_for_parsing() {
        let decoded = decode_line(b"dsh web: http://127.0.0.1:4173/?token=abcdefgh12345");
        assert!(
            decoded.contains("token=abcdefgh12345"),
            "解析路径必须能读到 token 原文：{decoded}"
        );
        assert!(!decoded.contains("<redacted>"), "{decoded}");

        let cookie = decode_line(b"Cookie: dsh-auth-session=supersecretvalue123");
        assert!(cookie.contains("dsh-auth-session=supersecretvalue123"), "{cookie}");
        assert!(!cookie.contains("<redacted>"), "{cookie}");
    }

    /// 反例：普通诊断行不得被误伤（否则排障信息会被抹掉）。
    #[test]
    fn sanitize_line_leaves_ordinary_lines_intact() {
        for line in [
            "dsh harness 1.2.3 (build 4567)",
            "listening on 127.0.0.1:4173",
            "error code E1005: invalid profile name",
        ] {
            let sanitized = sanitize_line(line.as_bytes());
            assert_eq!(sanitized, line, "普通行不该被改写：{line}");
            assert!(!sanitized.contains("<redacted>"), "{sanitized}");
        }
    }

    /// 跨行护栏（CD09-b 补丁）：整块 PEM 私钥逐行喂入时，**每一行**都必须被吞。
    ///
    /// 改前这条是红的：逐行调用 `sanitize_line` 时看不到 `END`，跨行规则不命中，
    /// 头行 / base64 正文 / 尾行全部原样通过（改前实测输出见修复报告）。
    #[test]
    fn line_redactor_redacts_whole_private_key_block() {
        const BODY: &str = "MIIEowIBAAKCAQEA7h1s2w3xY9z0aBcDeFgHiJkLmNoPqRsTuVwXyZ01";
        let mut redactor = LineRedactor::new();

        let header = redactor.scrub(b"-----BEGIN RSA PRIVATE KEY-----");
        assert_eq!(header, "<redacted>");
        assert!(redactor.in_private_key_block(), "BEGIN 之后必须置位");

        let body = redactor.scrub(BODY.as_bytes());
        assert_eq!(body, "<redacted>", "正文行必须被吞");
        assert!(redactor.in_private_key_block());
        assert!(!body.contains(BODY), "base64 正文不得出现在记录里");

        // Windows 子进程输出是 CRLF，`read_until` 会在行尾留下 `\r`；
        // 它属于空白，不得被当成"不像正文"而提前复位。
        let crlf_body = redactor.scrub(b"MIIEowIBAAKCAQEA7h1s\r");
        assert_eq!(crlf_body, "<redacted>", "行尾 \\r 不得导致复位");
        assert!(redactor.in_private_key_block());

        let footer = redactor.scrub(b"-----END RSA PRIVATE KEY-----");
        assert_eq!(footer, "<redacted>");
        assert!(!redactor.in_private_key_block(), "END 之后必须复位");

        for out in [&header, &body, &crlf_body, &footer] {
            assert!(!out.contains("PRIVATE KEY"), "块标记不得留下：{out}");
        }
    }

    /// 尾部短行不得复位：PEM 正文按 64 字符折行，**末行常只有 4~8 个字符**。
    ///
    /// 用长度下限做"像不像正文"的判据会在这里提前复位，把随后的 `END` 行放出去
    /// ——这正是本测试存在的理由：判据只能是字符集，不能是长度。
    #[test]
    fn line_redactor_keeps_short_tail_line_inside_block() {
        let mut redactor = LineRedactor::new();
        assert_eq!(
            redactor.scrub(b"-----BEGIN RSA PRIVATE KEY-----"),
            "<redacted>"
        );
        assert_eq!(
            redactor.scrub(b"MIIEowIBAAKCAQEA7h1s2w3xY9z0aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcd"),
            "<redacted>"
        );
        assert_eq!(
            redactor.scrub(b"AbCd"),
            "<redacted>",
            "4 字符的合法末行不得触发复位"
        );
        assert!(
            redactor.in_private_key_block(),
            "短末行之后仍应处于块内，否则 END 行会漏出"
        );
        assert_eq!(
            redactor.scrub(b"-----END RSA PRIVATE KEY-----"),
            "<redacted>"
        );
        assert!(!redactor.in_private_key_block(), "复位必须发生在 END 之后");
    }

    /// `END` 行与状态无关：即便当前不在块内（块被截断、或只看到尾行），也必须抹掉。
    ///
    /// 否则会出现"头抹了、尾留着"的不对称，且 `redact_stream` 的跨行规则对孤立的
    /// `END` 行并不命中。
    #[test]
    fn line_redactor_redacts_end_line_even_outside_block() {
        let mut redactor = LineRedactor::new();
        assert!(!redactor.in_private_key_block());

        assert_eq!(
            redactor.scrub(b"-----END RSA PRIVATE KEY-----"),
            "<redacted>",
            "孤立 END 行必须被抹掉"
        );
        assert!(!redactor.in_private_key_block());

        // 即便前后夹着普通文本，也整行替换（保留片段只会留下尾行痕迹）。
        let mixed = redactor.scrub(b"tail: -----END OPENSSH PRIVATE KEY----- done");
        assert_eq!(mixed, "<redacted>");

        // 无状态入口同样生效，证明这一点不依赖跨行上下文。
        assert_eq!(sanitize_line(b"-----END EC PRIVATE KEY-----"), "<redacted>");
    }

    /// 复位有效性：块结束之后的普通行必须照常记录（别把后续日志一起吞掉）。
    ///
    /// 这条最容易漏——`in_pem` 只置不复位时，前面三条断言仍然全绿。
    #[test]
    fn line_redactor_resumes_after_private_key_block() {
        let mut redactor = LineRedactor::new();
        let _ = redactor.scrub(b"-----BEGIN OPENSSH PRIVATE KEY-----");
        let _ = redactor.scrub(b"MIIEowIBAAKCAQEA7h1s");
        let _ = redactor.scrub(b"-----END OPENSSH PRIVATE KEY-----");
        assert!(!redactor.in_private_key_block());

        let line = redactor.scrub(b"dsh web: http://127.0.0.1:4173/?token=abcdefgh12345");
        assert!(line.contains("dsh web:"), "块结束后的普通行不得被吞：{line}");
        assert!(!line.contains("abcdefgh12345"), "{line}");
    }

    /// 单行 PEM（BEGIN 与 END 同在一行）仍被整行抹掉，且不留跨行状态。
    #[test]
    fn line_redactor_redacts_single_line_private_key() {
        let mut redactor = LineRedactor::new();
        let out = redactor
            .scrub(b"-----BEGIN RSA PRIVATE KEY-----MIIEowIBAAKCAQEA7h1s-----END RSA PRIVATE KEY-----");
        assert_eq!(out, "<redacted>");
        assert!(
            !redactor.in_private_key_block(),
            "单行 PEM 不应留下跨行状态，否则会误吞后续日志"
        );
    }

    /// 增量护栏：不含 PEM 的行必须与 `sanitize_line` **逐字节一致**，
    /// 证明引入跨行状态没有改变既有脱敏语义。
    #[test]
    fn line_redactor_matches_sanitize_line_outside_private_key_blocks() {
        let lines: [&[u8]; 5] = [
            b"dsh harness 1.2.3 (build 4567)",
            b"listening on 127.0.0.1:4173",
            b"error code E1005: invalid profile name",
            b"dsh web: http://127.0.0.1:4173/?token=abcdefgh12345",
            b"Cookie: dsh-auth-session=supersecretvalue123",
        ];
        let mut redactor = LineRedactor::new();
        for raw in lines {
            assert_eq!(
                redactor.scrub(raw),
                sanitize_line(raw),
                "无 PEM 的行必须与 sanitize_line 逐字节一致"
            );
        }
        assert!(!redactor.in_private_key_block());
    }

    /// 未闭合的块：正文继续被吞，但**碰到不像正文的普通行就复位**，不无限吞。
    ///
    /// 取舍：漏出的私钥不可撤销，所以块内宁可多吞；但日志被截断导致 `END` 缺失是
    /// 常态，若一直吞到进程结束，失败归因（C7）会彻底失去证据。判据用字符集，
    /// 正常日志行必然含 `:`、`.`、`[`、空格外的符号，能可靠地把状态放回来。
    #[test]
    fn line_redactor_unclosed_block_resets_on_ordinary_line() {
        let mut redactor = LineRedactor::new();
        assert_eq!(
            redactor.scrub(b"-----BEGIN RSA PRIVATE KEY-----"),
            "<redacted>"
        );
        for body in [
            &b"MIIEowIBAAKCAQEA7h1s2w3xY9z0"[..],
            // 纯十六进制/字母数字的行看起来就是正文，继续吞（宁可多吞）。
            &b"aBcDeFgHiJkLmNoPqRsTuVwXyZ012"[..],
        ] {
            assert_eq!(redactor.scrub(body), "<redacted>", "块内正文必须继续吞");
            assert!(redactor.in_private_key_block());
        }

        // 普通日志行（含 `:` 与 `.`）⇒ 判定块已截断，复位并照常记录。
        let line = redactor.scrub(b"dsh web: http://127.0.0.1:4173/?token=abcdefgh12345");
        assert!(
            line.contains("dsh web:"),
            "块截断后的普通行不得被吞：{line}"
        );
        assert!(!line.contains("abcdefgh12345"), "{line}");
        assert!(
            !redactor.in_private_key_block(),
            "遇到不像正文的行必须复位，否则会吞掉整份日志"
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
    fn cause_detects_plugin_fault() {
        let lines = stderr_lines(&[
            "[arness-node] boot",
            "[dsh-plugin-fault] Tool \"recall\" already registered by custom-plugin",
        ]);
        let cause = extract_failure_cause(&lines).unwrap();
        assert_eq!(cause.kind(), "plugin_fault");
        assert!(cause.is_plugin_fault());
        assert!(cause
            .to_string()
            .contains("Tool \"recall\" already registered"));
    }

    #[test]
    fn cause_detects_worker_fault() {
        let lines = stderr_lines(&[
            "[arness-node] boot",
            "[dsh-worker-fault] Worker crashed with exit code 1",
        ]);
        let cause = extract_failure_cause(&lines).unwrap();
        assert_eq!(cause.kind(), "worker_fault");
        assert!(cause.is_plugin_fault());
        assert!(cause
            .to_string()
            .contains("Worker crashed with exit code 1"));
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
        let root = crate::test_support::scratch_dir("logs-rotate");
        let path = root.join("harness.log");

        let mut log = LogFile::with_limits(path.clone(), 64, 3).unwrap();
        for index in 0..10 {
            log.append_line(&format!("line {index} padding padding padding"))
                .unwrap();
        }
        drop(log);

        assert!(backup_path(&path, 1).exists(), "应产生 .1 备份");
        assert!(std::fs::metadata(&path).unwrap().len() < 64);

        crate::test_support::cleanup(&root);
    }
}
