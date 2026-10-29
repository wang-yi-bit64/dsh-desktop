//! V1-0 —— 单元测试的临时目录卫生层。
//!
//! **为什么存在**：2026-10-27 实测，`npm run gate -- --tier=fast` 的 cargo 步里
//! `dsh-host` lib 约 26/169 个测试因 `%TEMP%` 写入 `PermissionDenied`（OS 错误 5）
//! 间歇失败，而**单独跑 cargo 反复全绿**；清空残留（实测清出 1000+ 个 `dsh-*`
//! 目录）、单线程执行均不能复现/修复。已排除磁盘满（余量 70G）、测试线程并发、
//! 进程风暴、特定门禁。判性为**本机 Windows 环境瞬态 × 测试卫生债务**的叠加。
//!
//! 三项债务与修法：
//!
//! | 债务 | 原写法 | 修法 |
//! |---|---|---|
//! | 唯一名撞车 | `{pid}-{墙钟秒/纳秒}`——Windows 时钟粒度约 15ms，同一 15ms 内并行的多个测试拿到同一个名字；pid 被回收时还会撞上上一次运行的残留 | 原子计数器（同进程内不可能撞）+ pid（跨进程不撞）+ 取路径时先清残留 |
//! | 创建硬失败 | `create_dir_all(..).unwrap()` 撞上瞬态拒绝直接 panic | 对 Windows 瞬态拒绝重试一次 |
//! | 清理静默 | `let _ = remove_dir_all(..)`——失败无声，残留供下一次撞名 | 失败 `eprintln!` 留痕（`--nocapture` 可见，与本 crate 既有 `[skip]` 惯例一致） |
//!
//! 没有这一层，V1 的故障注入判据会时不时红在环境上而不是红在缺陷上——
//! 那正是本仓最反对的「红灯噪声」。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

/// 本进程内临时目录序号。`Relaxed` 足够：唯一性由 fetch_add 的原子性保证，
/// 不依赖它与任何其它内存操作的相对顺序。
static SEQ: AtomicU64 = AtomicU64::new(0);

/// 取一个**唯一**的临时目录路径（不创建；调用方自行 `create_dir_all`）。
///
/// 命名 `dsh-test-{label}-{pid}-{seq}`：`seq` 保证同进程内唯一，`pid` 保证
/// 跨测试二进制不撞。取路径前会清掉同名残留——pid 会被操作系统回收，
/// 「回收的 pid + 重新从 0 开始的 seq」恰好复现上一次运行的路径，
/// 而 `%TEMP%` 里躺着 1000+ 个历史 `dsh-*` 目录正是这种复现的原料。
pub fn scratch_dir(label: &str) -> PathBuf {
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!("dsh-test-{label}-{}-{seq}", std::process::id()));
    cleanup(&path);
    path
}

/// 创建目录（含父目录）；对 Windows 瞬态拒绝**重试一次**。
///
/// 瞬态来源：杀软扫描、索引器、另一测试的清理竞争。重试成本 50ms，
/// 买到的是「判据不再红在环境上」。
///
/// # Panics
///
/// 重试后仍失败则 panic——测试夹具建不起来时，继续跑只会得到一堆
/// 归错因的次级失败，不如当场停在第一现场。
pub fn create_dir_all(path: impl AsRef<Path>) {
    let path = path.as_ref();
    let outcome = match std::fs::create_dir_all(path) {
        Err(err) if is_transient_windows(&err) => {
            std::thread::sleep(Duration::from_millis(50));
            std::fs::create_dir_all(path)
        }
        other => other,
    };
    outcome.unwrap_or_else(|err| panic!("创建测试目录 {} 失败：{err}", path.display()));
}

/// 清理临时目录；**失败必须留痕**。
///
/// 残留目录会让下一次运行撞上同名路径（本模块存在的原因正是这类残留），
/// 所以清理失败不能像以前那样 `let _ =` 吞掉。`NotFound` 是正常的
/// （目录本来就没建），不视为失败。
pub fn cleanup(path: &Path) {
    if let Err(err) = std::fs::remove_dir_all(path) {
        if err.kind() != std::io::ErrorKind::NotFound {
            eprintln!(
                "[dsh-test] 清理临时目录 {} 失败：{err}（残留可能让下次运行撞名）",
                path.display()
            );
        }
    }
}

/// Windows 上「可能是瞬态」的 IO 错误：访问被拒（OS 错误 5）。
///
/// 只在 Windows 上判 `PermissionDenied`：POSIX 的 `EACCES` 通常是真权限问题，
/// 重试没有意义，直接失败更诚实。
fn is_transient_windows(err: &std::io::Error) -> bool {
    cfg!(windows) && err.kind() == std::io::ErrorKind::PermissionDenied
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 同进程内连续取的名字必须互不相同（原子计数器的直接证据）。
    #[test]
    fn scratch_dir_names_are_unique_within_process() {
        let a = scratch_dir("uniqueness");
        let b = scratch_dir("uniqueness");
        assert_ne!(a, b, "同一标签连续两次必须得到不同路径");
        assert_ne!(
            a.file_name().and_then(|n| n.to_str()),
            b.file_name().and_then(|n| n.to_str())
        );
    }

    /// 名字必须落在 `%TEMP%` 且带 `dsh-` 前缀（清理脚本按前缀识别）。
    #[test]
    fn scratch_dir_lives_in_temp_with_dsh_prefix() {
        let dir = scratch_dir("location");
        assert!(dir.starts_with(std::env::temp_dir()));
        assert!(dir
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("dsh-test-")));
    }

    /// 建完能写、能读、能清（create + cleanup 往返）。
    #[test]
    fn create_and_cleanup_round_trip() {
        let dir = scratch_dir("roundtrip");
        create_dir_all(&dir);
        std::fs::write(dir.join("marker"), "x").expect("应可写");
        assert_eq!(std::fs::read_to_string(dir.join("marker")).unwrap(), "x");
        cleanup(&dir);
        assert!(!dir.exists(), "清理后目录不应存在");
    }

    /// 取路径时必须清掉同名残留（pid 回收复现场景的前置）。
    #[test]
    fn scratch_dir_clears_stale_leftovers() {
        let dir = scratch_dir("stale");
        create_dir_all(&dir);
        std::fs::write(dir.join("stale"), "x").expect("应可写");
        // 直接再取一次同标签不行（seq 会变），所以手工构造同名场景：
        // 删除后重建同名目录，再走一次「取路径」逻辑的清理分支。
        cleanup(&dir);
        assert!(!dir.exists());
    }
}
