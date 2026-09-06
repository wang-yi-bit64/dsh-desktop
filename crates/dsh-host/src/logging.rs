//! 宿主日志落盘（契约 C7）。
//!
//! 分工：
//!
//! | 文件 | 内容 | 消费者 |
//! |---|---|---|
//! | `<data>/logs/harness.log` | 子进程 stdout **+ stderr**（全量） | `dsh-host-cli tail`、错误页尾部日志 |
//! | `<data>/logs/app.log` | 宿主自身诊断行（带级别前缀） | 排障（宿主做了什么、为什么这么做） |
//!
//! `APP_LOG_FILE` 早在阶段 1 就定义在 [`crate::contracts`] 里，但一直没有
//! 生产者——排障时只能看子进程说了什么，看不到宿主做了什么。本模块补上这一环。
//!
//! # 设计取舍：不引入 `tracing` / `log`
//!
//! `dsh-host` 是**库**，强制全局 subscriber 会污染下游；INV-6 也要求最小依赖面。
//! 这里的需求只是「分级 + 落盘 + 过滤」，直接用 [`crate::logs::LogFile`] 的
//! 滚动能力即可，零新增依赖。
//!
//! # 落盘始终全量
//!
//! CLI 的 `--log-level` 只过滤 **stdout 输出**；落盘不受级别过滤影响。
//! 排障时不能因为「当时日志级别设成了 error」而丢失证据。

use std::sync::Mutex;

use crate::contracts::EXIT_UNEXPECTED;
use crate::logs::{LogFile, LogLevel, LogSource};
use crate::paths::Layout;

/// 宿主日志写入器（`app.log`）。
///
/// 打开失败时**降级为丢弃**（返回 `None`）而不是让启动失败：日志是排障手段，
/// 不该成为启动的单点故障。
pub struct AppLog {
    file: Mutex<LogFile>,
    /// stdout 输出的最低级别（`--log-level`）；不影响落盘。
    stdout_level: LogLevel,
}

impl AppLog {
    /// 打开（或创建）`layout.app_log_path`。
    ///
    /// 目录不存在时自动创建；任何 IO 失败都返回 `None`。
    ///
    /// # 示例
    ///
    /// ```
    /// use std::path::Path;
    /// use dsh_host::logging::AppLog;
    /// use dsh_host::paths::Layout;
    ///
    /// let layout = Layout::resolve(
    ///     Path::new("/definitely-missing-dsh/res"),
    ///     Path::new("/definitely-missing-dsh/data"),
    /// );
    /// // 路径不可写时优雅降级为 None，而不是 panic。
    /// let _ = AppLog::open(&layout, dsh_host::logs::LogLevel::Info);
    /// ```
    pub fn open(layout: &Layout, stdout_level: LogLevel) -> Option<Self> {
        let file = LogFile::open(layout.app_log_path.clone()).ok()?;
        Some(Self {
            file: Mutex::new(file),
            stdout_level,
        })
    }

    /// 记一条日志。
    ///
    /// # 参数
    ///
    /// * `level` — 级别。
    /// * `text` — 正文（**不要**自带前缀，前缀由本方法统一加）。
    ///
    /// # 示例
    ///
    /// ```no_run
    /// use std::path::Path;
    /// use dsh_host::logs::LogLevel;
    /// use dsh_host::logging::AppLog;
    /// use dsh_host::paths::Layout;
    ///
    /// let layout = Layout::resolve(Path::new("resources"), Path::new("userdata"));
    /// if let Some(log) = AppLog::open(&layout, LogLevel::Info) {
    ///     log.log(LogLevel::Warn, "port mismatch: reserved 4173, reported 5000");
    /// }
    /// ```
    pub fn log(&self, level: LogLevel, text: impl AsRef<str>) {
        let text = text.as_ref();
        // prefix() 常量已含对齐尾空格（如 "WARN "），此处只需再补一个分隔空格。
        let line = format!("{} {} {}", LogSource::Desktop.prefix(), level.prefix(), text);

        if let Ok(mut file) = self.file.lock() {
            let _ = file.append_line(&line);
        }

        // stdout 过滤：只在级别足够低（数值足够大）时打印。
        if level >= self.stdout_level {
            println!("{line}");
        }
    }

    /// 便捷方法：warn 级。
    pub fn warn(&self, text: impl AsRef<str>) {
        self.log(LogLevel::Warn, text);
    }

    /// 便捷方法：info 级。
    pub fn info(&self, text: impl AsRef<str>) {
        self.log(LogLevel::Info, text);
    }

    /// 便捷方法：error 级。
    pub fn error(&self, text: impl AsRef<str>) {
        self.log(LogLevel::Error, text);
    }

    /// 便捷方法：debug 级。
    pub fn debug(&self, text: impl AsRef<str>) {
        self.log(LogLevel::Debug, text);
    }

    /// 关闭文件句柄（卸载 / 热更新前调用，Windows 上否则文件被锁）。
    pub fn close(&self) {
        if let Ok(mut file) = self.file.lock() {
            file.close();
        }
    }
}

/// 便捷入口：按布局打开宿主日志。
///
/// # 示例
///
/// ```no_run
/// use std::path::Path;
/// use dsh_host::logging::init_app_log;
/// use dsh_host::paths::Layout;
///
/// let layout = Layout::resolve(Path::new("resources"), Path::new("userdata"));
/// let log = init_app_log(&layout);
/// if let Some(log) = log {
///     log.info("host starting");
/// }
/// ```
pub fn init_app_log(layout: &Layout) -> Option<AppLog> {
    AppLog::open(layout, LogLevel::Info)
}

/// 退出码常量的再导出，便于 CLI 单点引用（避免各处硬编码数字）。
pub const APP_LOG_FAILURE_EXIT_CODE: i32 = EXIT_UNEXPECTED;

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_layout(name: &str) -> (std::path::PathBuf, Layout) {
        let unique = format!("dsh-host-applog-{name}-{}-{}", std::process::id(), {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        });
        let root = std::env::temp_dir().join(unique);
        (root.clone(), Layout::resolve(root.join("res"), root.join("data")))
    }

    #[test]
    fn app_log_writes_level_prefix() {
        let (root, layout) = temp_layout("prefix");
        layout.ensure_dirs().unwrap();

        {
            let log = AppLog::open(&layout, LogLevel::Error).expect("应能打开 app.log");
            log.warn("passthrough overrides contract arg: --port");
        }

        let content = std::fs::read_to_string(&layout.app_log_path).unwrap();
        assert!(
            content.contains("[desktop] WARN  passthrough overrides contract arg: --port"),
            "实际内容：{content}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn app_log_persists_every_level_regardless_of_stdout_filter() {
        let (root, layout) = temp_layout("filter");
        layout.ensure_dirs().unwrap();

        {
            // stdout 级别设成 Error：debug 不该打到 stdout，但仍要落盘。
            let log = AppLog::open(&layout, LogLevel::Error).unwrap();
            log.debug("low level detail");
        }

        let content = std::fs::read_to_string(&layout.app_log_path).unwrap();
        assert!(content.contains("DEBUG"), "落盘不应受级别过滤影响：{content}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn app_log_degrades_to_none_when_path_is_unwritable() {
        // 资源目录不存在 → ensure_dirs 未调用；app_log_path 位于 data 下，
        // 这里用一个根目录本身不可写的路径触发降级。
        let root = std::path::PathBuf::from(if cfg!(windows) {
            "C:\\definitely-missing-dsh-applog\\nope"
        } else {
            "/proc/definitely-missing-dsh-applog/nope"
        });
        let layout = Layout::resolve(root.join("res"), root.join("data"));
        // 结果是 None 或 Some 都接受，关键是**不 panic**。
        let _ = AppLog::open(&layout, LogLevel::Info);
    }
}
