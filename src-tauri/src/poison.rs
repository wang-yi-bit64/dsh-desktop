//! `std::sync::Mutex` 锁中毒（poison）的处置策略。
//!
//! # 为什么需要这个模块（缺陷治理 D10 / S4-4）
//!
//! `std::sync::Mutex` 的 poison 语义是「一个 panic 污染所有人」：持锁期间
//! 任何线程 panic，之后**每一次** `lock()` 都返回 `Err`。本仓两个持锁点都在
//! 用户可感知的主链路上：
//!
//! * [`crate::state`] 的状态机——每个 IPC 命令（`snapshot` / `logs_tail` /
//!   `harness_port` …）都要读它；
//! * [`crate::mobile_bridge`] 的配对状态监听器。
//!
//! 一旦 `lock().unwrap()` 撞上 poison，panic 会从「一次事故」升级成「整个壳
//! 此后每个命令都 panic」——这就是 D10 登记的崩溃面（`state.rs` 15 处生产
//! unwrap 的核心风险，2026-10-02 收敛）。
//!
//! # 策略：恢复 guard、如实记录、继续服务
//!
//! 1. [`lock_or_recover`]：中毒时恢复 guard 而不是再 panic。代价是可能读到
//!    半更新状态——但 poison 本身就说明状态已被某次 panic 打断，拒绝服务并不
//!    会让它变好；可观测性由 `error` 日志兜住（与托盘 / 菜单等处的降级日志
//!    同一口径，见 AGENTS.md §7.1 规则 3）。
//! 2. [`try_lock_or_recover`]：区分 `WouldBlock` 与 `Poisoned`。同步回调
//!    （launch 事件）刻意不阻塞启动链路，忙时放弃本次事件是既有语义；但若把
//!    **中毒**误判成「忙」，状态机会在 poison 后静默丢掉全部后续事件——那是
//!    §7.1 规则 3 禁止的无声降级，因此中毒必须恢复后照常处理。
//!
//! 生产路径零 `.unwrap()` 由新守卫 `verify:unwrap-hygiene`（S4-4 判据）守着；
//! 本模块的三个测试钉住上述两条规则，含「恢复后数据仍可读」与「中毒不被
//! 误判成忙」。

use std::sync::{Mutex, MutexGuard, TryLockError};

/// 加锁；锁中毒时恢复 guard 而不是再 panic（理由见模块文档）。
pub(crate) fn lock_or_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            log::error!(
                "std mutex poisoned by an earlier panic; recovering the guard instead of panicking every later caller"
            );
            poisoned.into_inner()
        }
    }
}

/// [`lock_or_recover`] 的非阻塞版本。
///
/// `WouldBlock` → `None`（忙，调用方放弃本次事件——同步回调的既有语义）；
/// `Poisoned` → `Some(恢复后的 guard)`（绝不静默丢事件）。
pub(crate) fn try_lock_or_recover<T>(mutex: &Mutex<T>) -> Option<MutexGuard<'_, T>> {
    match mutex.try_lock() {
        Ok(guard) => Some(guard),
        Err(TryLockError::WouldBlock) => None,
        Err(TryLockError::Poisoned(poisoned)) => {
            log::error!(
                "std mutex poisoned by an earlier panic; recovering the guard instead of dropping every later event"
            );
            Some(poisoned.into_inner())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 制造一次**真实**中毒：持锁期间 panic。随后断言锁确实处于中毒态——
    /// 否则后续测试只是在验证未中毒路径，是装饰性绿。
    fn poison_a_test_mutex(mutex: &Mutex<&'static str>) {
        std::thread::scope(|scope| {
            let probe = scope.spawn(|| {
                let _guard = mutex.lock().expect("fixture: first lock must succeed");
                panic!("fixture: deliberate panic while holding the lock");
            });
            // join 的 Err 正是「该线程 panic 了」的证据，不需要传播。
            assert!(probe.join().is_err(), "fixture 线程必须真的 panic");
        });
        assert!(
            mutex.lock().is_err(),
            "fixture 必须先把锁弄中毒，否则测的是未中毒路径"
        );
    }

    /// 修复前这里是 `.lock().unwrap()` → 本用例（以及真实壳里的每个命令）panic。
    #[test]
    fn lock_or_recover_returns_the_guard_instead_of_panicking() {
        let mutex = Mutex::new("payload");
        poison_a_test_mutex(&mutex);
        let guard = lock_or_recover(&mutex);
        assert_eq!(*guard, "payload", "中毒后也必须仍能读到数据");
    }

    #[test]
    fn try_lock_or_recover_recovers_a_poisoned_lock() {
        let mutex = Mutex::new("payload");
        poison_a_test_mutex(&mutex);
        assert!(
            try_lock_or_recover(&mutex).is_some(),
            "中毒必须被恢复；误判成「忙」会让状态机静默丢掉全部后续事件"
        );
    }

    #[test]
    fn try_lock_or_recover_still_drops_the_event_while_busy() {
        let mutex = Mutex::new("payload");
        let held = mutex.lock().expect("fixture: hold the lock");
        assert!(
            try_lock_or_recover(&mutex).is_none(),
            "忙时放弃是同步回调的既有语义，不能改"
        );
        drop(held);
        assert!(try_lock_or_recover(&mutex).is_some());
    }
}
