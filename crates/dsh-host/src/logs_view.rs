//! 应用内日志查看器的读取端（批次 D，D10）。
//!
//! 此前壳里没有日志页：菜单「View Harness Log」只调 `opener` 打开系统文件
//! 管理器。那条路径在「应用起不来 / 界面卡住」的场景下就断了——用户要的是
//! **至少能看到日志**，而不是被丢到一个文件夹里自己找。
//!
//! # 三个来源，各自的边界
//!
//! | 来源 | 文件 | 写入方 | 特点 |
//! |------|------|--------|------|
//! | `harness` | `logs/harness.log` | Harness 子进程 stdout/stderr 的落盘 | 大、会轮转 |
//! | `desktop` | `logs/desktop.log` | 壳层（`tauri-plugin-log`） | 记录壳自身动作与 panic |
//! | `app` | `logs/app.log` | 宿主面（`dsh_host::logging`） | 派生/就绪/退出 |
//!
//! # 为什么只读尾部，且必须标记截断
//!
//! 日志文件没有硬上限（`harness.log` 尤其大），查看器只展示尾部。若超过
//! [`LOG_TAIL_MAX_BYTES`] 则只读最后一段，并在 [`LogSlice::truncated`] 里如实
//! 标记——**不得静默截断**：用户以为「这就是全部日志」而据此排障，比看不到
//! 日志更糟（`AGENTS.md` §7.1 规则 3）。

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::contracts::{APP_LOG_FILE, DESKTOP_LOG_FILE, HARNESS_LOG_FILE, LOG_TAIL_MAX_BYTES};
use crate::paths::Layout;

/// 日志**文件**标识（前端的 `source` 参数取值）。
///
/// 与 [`crate::logs::LogSource`] 的区别：后者标注**单行**的来源（stdout /
/// stderr / 宿主自身），本类型标注**文件**。两者名字相近但语义不同，故不与
/// 其共用标识符。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LogFile {
    /// Harness 子进程输出。
    Harness,
    /// 桌面壳层日志。
    Desktop,
    /// 宿主面日志。
    App,
}

impl LogFile {
    /// 从请求参数解析来源；不认识的名字返回 `None`。
    pub fn parse(input: &str) -> Option<Self> {
        match input {
            "harness" => Some(LogFile::Harness),
            "desktop" => Some(LogFile::Desktop),
            "app" => Some(LogFile::App),
            _ => None,
        }
    }

    /// 该来源对应的落盘路径。
    pub fn path(&self, layout: &Layout) -> PathBuf {
        match self {
            LogFile::Harness => layout.log_path.clone(),
            LogFile::Desktop => layout.desktop_log_path.clone(),
            LogFile::App => layout.app_log_path.clone(),
        }
    }

    /// 该来源的文件名（也是前端展示用的标签来源）。
    pub fn file_name(&self) -> &'static str {
        match self {
            LogFile::Harness => HARNESS_LOG_FILE,
            LogFile::Desktop => DESKTOP_LOG_FILE,
            LogFile::App => APP_LOG_FILE,
        }
    }
}

/// 一次读取的结果。
#[derive(Clone, Debug, Serialize)]
pub struct LogSlice {
    /// 来源标识（回显，便于前端确认自己拿到的是哪一个）。
    pub source: String,
    /// 文件名（展示用）。
    pub file: String,
    /// 尾部若干行（按时间顺序，最早的在前）。
    pub lines: Vec<String>,
    /// 文件当前总字节数。
    pub total_bytes: u64,
    /// 是否因为体积上限只读了尾部一段。
    pub truncated: bool,
    /// 文件是否还不存在（尚未写入过 / 已被清理）。
    ///
    /// 这不是错误：新装的应用可能一个日志都没有。页面据此给出「暂无内容」
    /// 而不是报错。
    pub missing: bool,
}

/// 读取日志尾部。
///
/// # 参数
///
/// * `layout` — 路径布局（唯一产地）。
/// * `source` — 来源标识字符串，取值见 [`LogFile::parse`]。
/// * `max_lines` — 最多返回多少行。
///
/// # 错误
///
/// 只对「来源名不认识」报错——那是调用方拼错了 `source`，属编程错误，必须
/// 显式暴露。文件不存在或不可读返回空切片并置 `missing = true`（页面给出
/// 「暂无内容」）。
pub fn read(layout: &Layout, source: &str, max_lines: usize) -> crate::HostResult<LogSlice> {
    let Some(source) = LogFile::parse(source) else {
        return Err(crate::HostError::InvalidArgument(format!(
            "unknown log source: {source}"
        )));
    };
    Ok(read_source(layout, source, max_lines))
}

/// 按结构化来源读取（内部复用点）。
pub fn read_source(layout: &Layout, source: LogFile, max_lines: usize) -> LogSlice {
    let path = source.path(layout);
    let (lines, total_bytes, truncated, missing) = tail_lines(&path, max_lines);
    LogSlice {
        source: match source {
            LogFile::Harness => "harness",
            LogFile::Desktop => "desktop",
            LogFile::App => "app",
        }
        .to_string(),
        file: source.file_name().to_string(),
        lines,
        total_bytes,
        truncated,
        missing,
    }
}

/// 读文件尾部：返回 `(行, 总字节数, 是否截断, 文件是否缺失)`。
fn tail_lines(path: &Path, max_lines: usize) -> (Vec<String>, u64, bool, bool) {
    let Ok(mut file) = std::fs::File::open(path) else {
        return (Vec::new(), 0, false, true);
    };
    let total_bytes = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    let offset = total_bytes.saturating_sub(LOG_TAIL_MAX_BYTES);
    let byte_truncated = offset > 0;
    if byte_truncated && file.seek(SeekFrom::Start(offset)).is_err() {
        return (Vec::new(), total_bytes, true, false);
    }
    let mut buffer = Vec::new();
    if file.read_to_end(&mut buffer).is_err() {
        return (Vec::new(), total_bytes, byte_truncated, false);
    }
    let text = String::from_utf8_lossy(&buffer);
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    // 从中间截断时首行残缺，丢掉——显示半行比不显示更误导。
    if byte_truncated && !lines.is_empty() {
        lines.remove(0);
    }
    let line_truncated = lines.len() > max_lines;
    if line_truncated {
        lines.drain(0..lines.len() - max_lines);
    }
    (lines, total_bytes, byte_truncated || line_truncated, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout_at(root: &Path) -> Layout {
        Layout::resolve(root.join("res"), root.join("data"))
    }

    fn temp_root(name: &str) -> PathBuf {
        let unique = format!(
            "dsh-logs-view-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or(0)
        );
        let root = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn unknown_source_is_a_programming_error() {
        let root = temp_root("unknown");
        let layout = layout_at(&root);
        let error = read(&layout, "harnses", 10).expect_err("typo must not silently return empty");
        assert!(error.to_string().contains("unknown log source"), "{error}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_file_is_not_an_error_but_is_reported() {
        let root = temp_root("missing");
        let layout = layout_at(&root);
        let slice = read(&layout, "desktop", 10).expect("missing file must not fail");
        assert!(slice.missing, "{slice:?}");
        assert!(slice.lines.is_empty(), "{slice:?}");
        assert!(!slice.truncated, "{slice:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn returns_the_tail_in_chronological_order() {
        let root = temp_root("tail");
        let layout = layout_at(&root);
        layout.ensure_dirs().unwrap();
        let content: String = (1..=100).map(|index| format!("line {index}\n")).collect();
        std::fs::write(&layout.log_path, &content).unwrap();

        let slice = read(&layout, "harness", 5).expect("must read");
        assert_eq!(
            slice.lines,
            vec!["line 96", "line 97", "line 98", "line 99", "line 100"]
                .into_iter()
                .map(str::to_string)
                .collect::<Vec<_>>(),
            "尾部的尾部：最早的行在前"
        );
        assert!(
            slice.truncated,
            "100 行只取了 5 行，必须标记截断：{slice:?}"
        );
        assert_eq!(slice.total_bytes, content.len() as u64);
        assert_eq!(slice.file, "harness.log");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn every_source_reads_its_own_file() {
        let root = temp_root("sources");
        let layout = layout_at(&root);
        layout.ensure_dirs().unwrap();
        std::fs::write(&layout.log_path, "harness-line\n").unwrap();
        std::fs::write(&layout.desktop_log_path, "desktop-line\n").unwrap();
        std::fs::write(&layout.app_log_path, "app-line\n").unwrap();

        for (source, expected, file) in [
            ("harness", "harness-line", "harness.log"),
            ("desktop", "desktop-line", "desktop.log"),
            ("app", "app-line", "app.log"),
        ] {
            let slice = read(&layout, source, 10).unwrap();
            assert_eq!(slice.lines, vec![expected.to_string()], "{source}");
            assert_eq!(slice.file, file, "{source}");
        }
        let _ = std::fs::remove_dir_all(&root);
    }
}
