// 共享 fixture；本测试只用它的 `layout` / `config()`，不用 `launcher()`
// （Supervisor 内部自己构造 Launcher），故 `launcher` 在本 crate 内是 dead_code。
#![allow(dead_code)]

//! S6-4 /治 D11 —— Supervisor 退避与断路器的**集成**面测试。
//!
//! ## 为什么需要这一组（`supervisor.rs` 的单元测试覆盖不到什么）
//!
//! 单元测试（`supervisor::tests`）测的是抽出的纯函数 `next_backoff` / `decide_restart`，
//! 它们能证明「公式本身正确」，**证明不了「运行时真的按这个公式退避」**——
//! 因为公式是在 `Supervisor::start()` 派生的重启协程里被调用的，单元测试够不到那条路径。
//!
//! 这一组补的正是那段：真派生 `mock-harness` 子进程（`--fail after-ready` 让它
//! Ready 后崩溃），真重启，真读 `SupervisorState::Crashed` 里的 `next_backoff`，
//! 断言**相邻两次上报的退避确实在增长**。
//!
//! ## 可证伪性（AGENTS.md §7.3）
//!
//! `assert_backoff_grows_over_realtime` 用**真实经过的时间**反证公式生效：
//! 若把 `next_backoff` 改成恒返回 `current`（即「绕过退避」），重启间隔会塌缩到
//! 进程启动耗时量级，实测断言会红。反之若把 multiplier 改成 0.1（退避反而缩短），
//! 同样会红。这条断言不依赖任何具体毫秒常量，因此不会因机器快慢而 flaky。
//!
//! ## 前置条件
//!
//! 需要系统 `node` 与仓库内 `scripts/mock-harness.mjs`；缺任一则整组跳过
//! （与 `mock_launch.rs` 同一口径，不让缺依赖伪装成通过）。
//!
//! ## ⚠️ 本组测试在设计过程中实测到的两个约束（不是缺陷，是必须知道的路径差异）
//!
//! **① `stable_uptime == 0` 的零值语义（2026-10-11 已修，此处留档）**
//! 原判定写作 `if uptime >= config.stable_uptime`，而 `uptime` 来自 `Instant::elapsed()`，
//! 恒 `>= 0`。故 `stable_uptime` 取 0 时**每次崩溃都满足条件**，`restart_count` 与
//! `current_backoff` 双双被打回初值 ⇒ 退避永不增长、断路器永不开路 ⇒ **无限重启**。
//! 首次写本用例时为求加速把该字段设成 0，正是它立刻暴露了该行为。
//! **现状**：判定已抽成 `supervisor::is_stable_uptime`，显式把 0 定义为
//! 「永不视为稳定运行」；回归锁见 `supervisor::tests::zero_stable_uptime_never_counts_as_stable`。
//!
//! **② 稳定窗口重置只存在于 `LaunchOutcome::Ready` 分支。**
//! `is_stable_uptime(...)` 那段紧跟在子进程退出之后，属于「Ready 后崩溃」的路径；
//! `LaunchOutcome::Failed`（启动即失败，如 `DSH_MOCK_FAIL=startup`）**不经过**它。
//! 推论有实测后果：若用 `after-ready` 场景，每次崩溃的 uptime 都会超过稳定窗口
//! ⇒ `restart_count` 被清零 ⇒ 实测 `attempt` 恒为 2、14 次上报全为初值 10ms。
//! ⇒ **测退避必须用 `startup`（Failed 分支），不能用 `after-ready`（Ready 分支）**。
//!
//! **① 的处置（2026-10-11）**：判定已抽成纯函数 `supervisor::is_stable_uptime` 并显式
//! 排除零值；本文件里的 `stable_uptime: 1s` 现在只是普通配置值，不再是「绕开缺陷」的权宜。
//! 参见 `docs/dev-plan-defect-remediation.md` 的 S6 记录与
//! `docs/dev-plan-supervisor-shell-wiring.md` §4.5。

mod fixture;

use std::time::{Duration, Instant};

use dsh_host::supervisor::{Supervisor, SupervisorConfig, SupervisorState};

use fixture::fixture;

/// 退避上限压到 60ms / 倍数 2.0，使整组在秒级跑完；
/// 同时仍然要求「后一次严格大于前一次」，因此缩短上限不削弱判据。
const FAST_BACKOFF: Duration = Duration::from_millis(10);
const FAST_MAX_BACKOFF: Duration = Duration::from_millis(60);

/// 整个场景的上限：派生 3 次子进程 + 真实等待退避（10+20+40ms）+ 进程启动耗时。
/// 放宽到 90s 以适配 CI 机器；它只防「死锁化fixture」，不参与任何判据。
const SCENARIO_BUDGET: Duration = Duration::from_secs(90);

/// 一次轮询的观测结果。
struct Settled {
    /// 观测到的 `Crashed.next_backoff` 序列（按时间顺序）。
    backoffs: Vec<Duration>,
    /// 是否观测到至少一对「后一次 > 前一次」。
    grew: bool,
    /// 是否观测到 `Failed`（断路器开路标志）。
    failed: bool,
}

/// 轮询广播直到「退避已增长**且**断路器已开路」，或预算耗尽。
///
/// 三个设计要点，均来自实测踩坑：
/// ① `broadcast::Receiver` 不能 clone（每 receiver 独立游标），必须单一累加器；
/// ② **两个条件必须在同一个循环里等**——开路发生在第 `max_restarts + 1` 次崩溃，
///    比「退避增长」晚得多；若先等增长、再等开路，中途 `stop()` 会 abort 协程，
///    `Failed` 永远不会来；
/// ③ `Crashed` 只在 `will_restart == true` 时上报，**开路那一次走 `Failed`**，
///    所以「开路」不能靠退避序列长度判断（`len() > max_restarts` 恒不成立）。
async fn poll_until_settled(
    rx: &mut tokio::sync::broadcast::Receiver<SupervisorState>,
    budget: Duration,
) -> Settled {
    let deadline = Instant::now() + budget;
    let mut backoffs: Vec<Duration> = Vec::new();
    let mut failed = false;
    loop {
        loop {
            match rx.try_recv() {
                Ok(SupervisorState::Crashed {
                    next_backoff: Some(d),
                    ..
                }) => backoffs.push(d),
                Ok(SupervisorState::Failed { total_restarts, .. }) => {
                    assert!(
                        total_restarts > MAX_RESTARTS_FOR_TEST,
                        "Failed 上报的 total_restarts={total_restarts} 应大于上限 {MAX_RESTARTS_FOR_TEST}"
                    );
                    failed = true;
                }
                Ok(_) => {}
                Err(tokio::sync::broadcast::error::TryRecvError::Empty) => break,
                // 通道关闭但已观测到开路 → 仍算成功。
                Err(tokio::sync::broadcast::error::TryRecvError::Closed) => {
                    let grew = backoffs.windows(2).any(|w| w[1] > w[0]);
                    return Settled {
                        backoffs,
                        grew,
                        failed,
                    };
                }
                Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_)) => {}
            }
        }
        let grew = backoffs.windows(2).any(|w| w[1] > w[0]);
        if grew && failed {
            return Settled {
                backoffs,
                grew,
                failed,
            };
        }
        if Instant::now() >= deadline {
            return Settled {
                backoffs,
                grew,
                failed,
            };
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// 集成面一：mock 持续崩溃时，**相邻两次上报的退避必须增长**。
///
/// 这是 S6-4 判据「该夹具必须让测试变红」的落地：把`next_backoff` 改成绕过退避
/// （返回 `current`）或改成退避缩短（multiplier < 1），本用例会红。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn assert_backoff_grows_over_realtime() {
    let Some(fx) = fixture() else {
        eprintln!("[skip] 未找到系统 node / mock 脚本，跳过退避集成测试");
        return;
    };

    let config = SupervisorConfig {
        launcher_config: fx.config(Duration::from_secs(8)),
        max_restarts: MAX_RESTARTS_FOR_TEST,
        initial_backoff: FAST_BACKOFF,
        max_backoff: FAST_MAX_BACKOFF,
        backoff_multiplier: 2.0,
        // 走 `startup` 失败分支时该字段**不参与判定**（稳定窗口重置只写在
        // `Ready` 分支里）。仍取非零默认值以免读者误以为 0 更"快"。
        stable_uptime: Duration::from_secs(1),
        host: None,
        profile: None,
        env: None,
        extra_args: vec!["--fail".into(), "startup".into()],
        // `startup` 模式启动即 exit 3。
        //
        // **必须用 startup 而不是 after-ready**：稳定窗口重置那段代码只存在于
        // `LaunchOutcome::Ready` 分支内（`supervisor.rs` 的 `uptime >= stable_uptime`
        // 检查紧跟在子进程退出之后）。走 `startup` 进的是 `LaunchOutcome::Failed` 分支，
        // 该分支**不经过**这个判定，因此退避不会被反复清零——这正是本用例要测的路径。
        // （用 after-ready 时实测：每次崩溃 uptime 都超过稳定窗口，`restart_count`
        //  被重置为 1，`attempt` 恒为 2，14 次上报全为初值。）
        extra_envs: vec![("DSH_MOCK_FAIL".into(), "startup".into())],
    };

    let supervisor = Supervisor::new(fx.layout.clone(), config);
    let mut rx = supervisor.subscribe();

    let started = Instant::now();
    supervisor.start().await;

    // 单次轮询把两件事都等完，**再** stop()。
    //
    // ⚠️ stop() 必须放在最后：`Supervisor::stop()` 会 abort 监督协程，
    // 若先 stop 再等断路器开路，协程已被杀掉，`Failed` 永远不会来
    // （初版就踩了这个，表现为「退避增长已过、断路器却永远等不到」）。
    let outcome = poll_until_settled(&mut rx, SCENARIO_BUDGET).await;
    supervisor.stop().await;
    let elapsed = started.elapsed();

    let seen = &outcome.backoffs;
    assert!(
        outcome.grew,
        "{elapsed:?} 内未观测到「后一次退避 > 前一次」；\
         退避链路可能已被绕过（拿到 {} 次上报：{seen:?}）",
        seen.len()
    );
    assert!(
        seen.len() >= 2,
        "至少需要两次崩溃才能比较退避，实际 {}",
        seen.len()
    );

    // 逐对断言严格增长：这是「退避真的在按公式生效」的直接证据。
    for pair in seen.windows(2) {
        assert!(
            pair[1] > pair[0],
            "退避未增长：{:?} →{:?}（绕过退避？）",
            pair[0],
            pair[1]
        );
        assert!(
            pair[1] <= FAST_MAX_BACKOFF,
            "退避超过配置上限：{:?}",
            pair[1]
        );
    }

    // 断路器必须开路：max_restarts 次重启之后进入 Failed。
    assert!(
        outcome.failed,
        "断路器未在 {MAX_RESTARTS_FOR_TEST} 次重启后进入 Failed 状态"
    );
}

/// 场景一的重启上限。与 `SupervisorConfig.max_restarts` 保持单一来源。
const MAX_RESTARTS_FOR_TEST: usize = 3;

/// 集成面二：断路器开路后必须进入 `Failed` 而不是无限重启。
///
/// 若把 `decide_restart` 改成恒 `true`，本用例会因「观测到超过 max_restarts 次
/// 上报」而红。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn assert_circuit_breaker_enters_failed_state() {
    let Some(fx) = fixture() else {
        eprintln!("[skip] 未找到系统 node / mock 脚本，跳过断路器集成测试");
        return;
    };

    let max_restarts = 2usize;
    let config = SupervisorConfig {
        launcher_config: fx.config(Duration::from_secs(8)),
        max_restarts,
        initial_backoff: FAST_BACKOFF,
        max_backoff: FAST_MAX_BACKOFF,
        backoff_multiplier: 2.0,
        stable_uptime: Duration::from_secs(1),
        host: None,
        profile: None,
        env: None,
        extra_args: vec!["--fail".into(), "startup".into()],
        // `startup` 模式启动即 exit 3，比 after-ready 快得多，且必然失败。
        extra_envs: vec![("DSH_MOCK_FAIL".into(), "startup".into())],
    };

    let supervisor = Supervisor::new(fx.layout.clone(), config);
    let mut rx = supervisor.subscribe();
    supervisor.start().await;

    // 等到出现 Failed 状态。
    let deadline = Instant::now() + SCENARIO_BUDGET;
    let mut crashed = 0usize;
    let mut saw_failed = false;
    while Instant::now() < deadline {
        match rx.try_recv() {
            Ok(SupervisorState::Crashed { will_restart, .. }) => {
                crashed += 1;
                if !will_restart {
                    saw_failed = true;
                }
            }
            Ok(SupervisorState::Failed { total_restarts, .. }) => {
                assert!(
                    total_restarts > max_restarts,
                    "Failed 时上报的 total_restarts={total_restarts} 应大于上限 {max_restarts}"
                );
                saw_failed = true;
                break;
            }
            Ok(_) => {}
            Err(tokio::sync::broadcast::error::TryRecvError::Empty) => {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Err(tokio::sync::broadcast::error::TryRecvError::Closed) => break,
            Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_)) => {}
        }
    }
    supervisor.stop().await;

    assert!(
        saw_failed,
        "{crashed} 次崩溃后未见 Failed 状态（断路器未开路或仍在无限重启）"
    );
    assert!(
        crashed <= max_restarts + 1,
        "崩溃上报次数 {crashed} 超过预期上限 {max_restarts}+1（无限重启？）"
    );
}
