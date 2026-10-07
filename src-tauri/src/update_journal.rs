//! 更新 journal：把「一次更新链路里发生了什么」写成可核对的 JSONL 行。
//!
//! # 为什么需要它
//!
//! 更新失败是**最难远程排查**的一类问题：用户看到的只有页面上一个分类
//! （check/download/install × network …），而真正决定性的信息——版本比较结果、
//! 跳过哪个版本、检查间隔初始化失败、下载中断在百分之几——此前只存在于进程
//! 内存里，随应用退出消失。反馈页因此无法回答「你的更新到底卡在哪一步」。
//!
//! # 三条硬规矩（AGENTS.md §7.1 规则 3 的延伸）
//!
//! 1. **只记事实，不记猜测**：每条记录的 `action` 来自固定枚举，`version` 是
//!    本次链路实际出现的版本字符串；没有的信息留空，不填「unknown」凑数。
//! 2. **失败也记**：比失败本身更糟的是「失败了但没有痕迹」。检查/分类/下载/
//!    安装四个失败点都记，并带上稳定错误码。
//! 3. **写不进不阻塞更新**：journal 是观测设施。磁盘满、目录不可写时只记一条
//!    `log::warn`，更新链路本身照常继续。
//!
//! # 隐私
//!
//! journal **不写** URL、Token、请求头或系统路径：版本号与错误码足以定位问题，
//! 而下载地址本身只与通道路由有关（通道名单独记录，见 `UpdateChannel`）。

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use dsh_host::contracts::{
    UPDATE_JOURNAL_DIR, UPDATE_JOURNAL_MAX_BYTES, UPDATE_JOURNAL_SCHEMA_VERSION,
};
use serde::Serialize;

/// journal 一行记录的动作枚举。
///
/// 派生 `Serialize` 后写入 JSON 的 `action` 字段；新增取值必须追加在末尾，
/// 已发布的名字不得改名或复用（它们会出现在用户导出的诊断包供人比对）。
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum JournalAction {
    /// 拉起更新管理器（含轮询间隔初始化结果）。
    Started,
    /// 用户或定时器发起检查。
    Check,
    /// 检查完成：有可用版本 / 已是最新 / 被跳过。
    CheckResult,
    /// 用户确认下载，或自动下载开始。
    Download,
    /// 下载完成（含进度百分比）。
    Downloaded,
    /// 用户确认安装（重启交接）。
    Install,
    /// 任一环节失败。
    Failed,
    /// 卸载/清理已下载的更新（如跳过版本）。
    Discarded,
}

/// 一条 journal 记录的负载。
#[derive(Clone, Debug, Serialize)]
pub struct JournalRecord {
    /// ISO-8601 UTC 时间戳。
    pub ts: String,
    /// 记录的 schema 版本。
    pub schema: u8,
    /// 本次记录的归属通道（`rc` / `alpha`），用于把现象对齐到正确的更新源。
    #[serde(rename = "channel")]
    pub channel: String,
    /// 动作（见 [`JournalAction`]）。
    pub action: JournalAction,
    /// 相关版本：当前已装版本、目标版本或失败时的候选版本。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// 稳定错误码（失败时）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// 一行人类可读摘要（**不得**含 URL / Token / 绝对路径）。
    pub summary: String,
}

/// journal 写入器：单文件 + 超限轮转。
pub struct UpdateJournal {
    /// `update-journal/updates.jsonl`。
    path: PathBuf,
    channel: String,
}

impl UpdateJournal {
    /// 在 `app_data_dir` 下建好目录并返回写入器。
    ///
    /// 目录创建失败时以 `None` 返回，调用方照常继续（规矩 3）。
    pub fn open(app_data_dir: &Path, channel: impl Into<String>) -> Option<Self> {
        let dir = app_data_dir.join(UPDATE_JOURNAL_DIR);
        if let Err(error) = fs::create_dir_all(&dir) {
            log::warn!("update journal directory unavailable: {error}");
            return None;
        }
        Some(Self {
            path: dir.join("updates.jsonl"),
            channel: channel.into(),
        })
    }

    /// 追加一条记录。
    pub fn record(
        &self,
        action: JournalAction,
        version: Option<String>,
        code: Option<String>,
        summary: impl Into<String>,
    ) {
        let line = JournalRecord {
            ts: utc_now(),
            schema: UPDATE_JOURNAL_SCHEMA_VERSION,
            channel: self.channel.clone(),
            action,
            version,
            code,
            summary: summary.into(),
        };
        self.append(&line);
    }

    fn append(&self, record: &JournalRecord) {
        let serialized = match serde_json::to_string(record) {
            Ok(line) => line,
            Err(error) => {
                log::warn!("update journal: cannot serialise record: {error}");
                return;
            }
        };
        if let Err(error) = self.append_line(&serialized) {
            log::warn!("update journal: append failed: {error}");
        }
    }

    fn append_line(&self, line: &str) -> std::io::Result<()> {
        if let Ok(meta) = fs::metadata(&self.path) {
            if meta.len() > UPDATE_JOURNAL_MAX_BYTES {
                // 轮转只保留一份历史（`.1`）；观察更新问题只需要最近一次现场。
                let rotated = self.path.with_extension("jsonl.1");
                let _ = fs::remove_file(&rotated);
                fs::rename(&self.path, &rotated)?;
            }
        }
        let mut file: File = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        writeln!(file, "{line}")?;
        Ok(())
    }
}

/// 秒级 ISO-8601 UTC 时间戳（`2026-10-03T08:12:31Z`）。
fn utc_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = secs / 86_400;
    let time = secs % 86_400;
    let (year, month, day) = civil_from_days(days as i64);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        time / 3600,
        (time % 3600) / 60,
        time % 60
    )
}

/// 由 UNIX 日起算的天数推出公历日期（Howard Hinnant 的 days→civil 算法）。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_serialises_one_line_without_urls() {
        // ⚠️ 目录名里**不能**直接放 `utc_now()`：它产出 ISO-8601
        // （`2026-10-06T14:34:29Z`），而 Windows 的文件名不允许 `:`——
        // `create_dir_all` 在 Windows 上直接失败（Linux/macOS 允许，所以只有
        // Windows job 红）。这里只把 `:` 换成 `-`，不影响被测逻辑。
        let stamp = utc_now().replace(':', "-");
        let dir = std::env::temp_dir().join(format!(
            "dsh-update-journal-{}-{}",
            std::process::id(),
            stamp
        ));
        // 显式判 open：它是**静默降级**路径（create_dir_all 失败只 warn 后返 None）。
        // 测试若也用 expect 一把梭， CI 上就会得到一条与真实原因无关的 panic
        // （2026-10-06 windows/ubuntu/macos 三平台同时红就是这么来的）。
        let Some(journal) = UpdateJournal::open(&dir, "rc") else {
            panic!(
                "open failed for {}（create_dir_all 失败；注意 Windows 文件名不允许 `:`）",
                dir.display()
            );
        };
        journal.record(
            JournalAction::CheckResult,
            Some("0.7.2-rc.2".into()),
            None,
            "update available",
        );
        journal.record(
            JournalAction::Failed,
            Some("0.7.2-rc.2".into()),
            Some("E1005".into()),
            "check failed: network unreachable",
        );

        // record() 也是静默降级（append 失败只 warn）。因此读盘后必须**先证明写进去了**，
        // 而不是直接 unwrap 两行——否则「一行都没写」会表现成 lines.next() 的 panic，
        // 把真实原因（磁盘/权限）掩盖成断言失败。
        let text = match fs::read_to_string(&journal.path) {
            Ok(text) => text,
            Err(error) => panic!("journal {} unreadable: {error}", journal.path.display()),
        };
        assert!(
            text.lines().count() >= 2,
            "journal 应至少有 2 行，实得 {} 行（{}）——record 静默降级了",
            text.lines().count(),
            journal.path.display(),
        );
        let mut lines = text.lines();
        let first = lines.next().unwrap();
        let second = lines.next().unwrap();

        // 可证伪性：单行 JSON、schemaVersion 在、动作名稳定。
        assert!(serde_json::from_str::<serde_json::Value>(first).is_ok());
        assert!(second.contains("\"action\":\"failed\""));
        assert!(second.contains("\"code\":\"E1005\""));

        // 隐私：行内不得出现任何 http(s) URL。
        assert!(!text.contains("http://"));
        assert!(!text.contains("https://"));

        // 轮转：写爆上限后 `.1` 必须存在且当前文件重新变小。
        //
        // ⚠️ 循环次数必须由**上限反推**，不能拍脑袋。单条记录约 100~120 字节，
        // 而 CX-15 的上限是 512 KiB——拍 2000 条只写 ~230 KB，永远不轮转。
        // 2026-10-06 三平台 CI 同时红就是踩了这个：断言本身没错，是写入量不够。
        // 这里按「上限 ÷ 单行字节」取 2 倍余量，且用足够长的 summary 保证能超限。
        let per_line = text.lines().map(|l| l.len()).max().unwrap_or(0).max(64) + 1;
        let needed = (UPDATE_JOURNAL_MAX_BYTES as usize / per_line + 1) * 2;
        for index in 0..needed {
            journal.record(
                JournalAction::Download,
                Some("0.7.2-rc.2".into()),
                None,
                format!("chunk {index} {}", "x".repeat(per_line)),
            );
        }
        assert!(
            journal.path.with_extension("jsonl.1").exists(),
            "写满 {} 字节上限后应轮转出 .1（{}）；本次写入 {needed} 行、每行约 {per_line} 字节",
            UPDATE_JOURNAL_MAX_BYTES,
            journal.path.display(),
        );
        // 轮转后当前文件必须比上限小——否则「轮转」只是复制，日志会无限增长。
        let after = fs::metadata(&journal.path).expect("轮转后的 journal 应可读");
        assert!(
            after.len() <= UPDATE_JOURNAL_MAX_BYTES,
            "轮转后当前文件仍超上限：{} > {}",
            after.len(),
            UPDATE_JOURNAL_MAX_BYTES,
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// `civil_from_days` 对已知日期的往返正确性（1970-01-01 与 2000-01-01）。
    #[test]
    fn civil_from_days_matches_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(10_957), (2000, 1, 1));
    }
}
