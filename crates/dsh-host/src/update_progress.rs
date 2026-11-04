//! 下载进度的**接受判据**：迟到 / 乱序的进度任务不得覆盖更新的状态。
//!
//! # 为什么需要它
//!
//! 壳层的进度回调是同步闭包（拿不到 `.await`），每次上报都 `spawn` 一个小任务去
//! 锁状态并 `emit`。这条路径有两个天然的不确定性：
//!
//! 1. **执行顺序不等于投递顺序**——任务池不保证先投递的先跑，百分比会往回跳；
//! 2. **迟到的任务会覆盖更新的阶段**——下载已经失败（`Error`）或已经进入
//!    `Installing` 之后，一个还没跑到的进度任务仍会在锁里写下
//!    `phase = Downloading` 与旧百分比，页面于是显示「正在下载」，而真相是
//!    「已经失败了」。
//!
//! 两者都是「窗口极窄但后果是错误归因」的缺陷：CD06 的整个目的就是让用户
//! 能分辨「卡在下载」还是「卡在安装」，被一个迟到任务覆盖回去等于修复失效。
//!
//! # 修法
//!
//! 每次下载开始递增一个 **epoch**（`AtomicU64`），进度任务带着自己的 epoch 上来；
//! 落盘前用本函数判定三件事：epoch 仍是当前这次、阶段仍是 `Downloading`、百分比
//! **严格前进**。三者任一不成立就不写、不 emit。
//!
//! 判据住在无头 crate 而不是壳层，理由同 [`crate::update_failure`]：本机 GNU 工具链
//! 下 `src-tauri` 的测试二进制加载即失败，判据留在壳层就等于不可证伪（INV-6）。

/// 一次进度上报是否应当生效。
///
/// - `task_epoch`：该任务被投递时所属的下载轮次。
/// - `current_epoch`：状态里当前轮次（每次 `download()` 开始递增）。
/// - `phase_is_downloading`：锁内当前阶段是否仍是 Downloading。
/// - `shown_percent`：已展示的百分比；`None` 表示还没有任何进度被接受。
/// - `next_percent`：本次要写入的百分比。
///
/// 返回 `true` 表示「可以写并 emit」。等值也算不前进：重复的百分比没有信息量，
/// 而允许等值写入会让「进度不动」与「进度被旧任务改写」在日志里长得一样。
pub fn accepts_progress(
    task_epoch: u64,
    current_epoch: u64,
    phase_is_downloading: bool,
    shown_percent: Option<f64>,
    next_percent: f64,
) -> bool {
    // ① 旧轮次的迟到任务：即使是「同一阶段」的下载，也不能污染新一轮。
    if task_epoch != current_epoch {
        return false;
    }
    // ② 阶段已经推进（Installing / Downloaded / Error）：进度不再有话语权。
    if !phase_is_downloading {
        return false;
    }
    // ③ 百分比只许前进。
    match shown_percent {
        Some(shown) => next_percent > shown,
        None => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 同一轮次、仍在下载、百分比前进 ⇒ 接受。
    #[test]
    fn forward_progress_in_the_current_download_is_accepted() {
        assert!(accepts_progress(7, 7, true, Some(10.0), 20.0));
        assert!(accepts_progress(7, 7, true, Some(99.9), 100.0));
        // 首次上报（还没有任何进度被接受）。
        assert!(accepts_progress(7, 7, true, None, 0.5));
    }

    /// 迟到的旧轮次任务必须被丢弃：新一轮的进度条不得跳回上一轮的数字。
    #[test]
    fn stale_epoch_is_rejected_even_while_downloading() {
        assert!(!accepts_progress(6, 7, true, Some(10.0), 90.0));
        assert!(!accepts_progress(0, 7, true, None, 5.0));
        // 反向（比当前还新的 epoch）同样不可能成立，一并拒绝。
        assert!(!accepts_progress(8, 7, true, Some(10.0), 20.0));
    }

    /// 阶段已推进后，进度任务不得把页面改回「正在下载」。
    #[test]
    fn progress_is_ignored_once_the_phase_moved_on() {
        assert!(!accepts_progress(7, 7, false, Some(10.0), 50.0));
        assert!(!accepts_progress(7, 7, false, None, 50.0));
    }

    /// 百分比只许前进：等值不写（无信息量），倒退必须拒绝（进度条不跳回）。
    #[test]
    fn percentages_never_move_backwards() {
        assert!(!accepts_progress(7, 7, true, Some(42.0), 41.9));
        assert!(!accepts_progress(7, 7, true, Some(42.0), 42.0));
        assert!(accepts_progress(7, 7, true, Some(42.0), 42.1));
    }
}
