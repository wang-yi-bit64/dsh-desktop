//! V1 — 生命周期竞态窗口的故障注入测试（core 层）。
//!
//! `docs/dev-plan-external-assessment-response.md` §3 V1 把外部评估列的六个竞态窗口
//! 从「设计上应有」变成「测试钉住」。本文件是 core 层的那六条；壳层断言
//! （V1-2 的退出接线、V1-3 的前端端点刷新）由 CI（MSVC）执行——本机 GNU 工具链下
//! `dsh-desktop` 测试二进制无法加载（`docs/incidents/local-toolchain-limits.md`）。
//!
//! ## 覆盖矩阵（窗口 × 断言 × 负例）
//!
//! | 窗口 | 测试 | 断言 | 负例（打回旧写法必须红） |
//! |---|---|---|---|
//! | V1-1 退避等待期间 stop | `v1_1_stop_during_backoff_wait_cancels_pending_restart` | stop 立刻返回、退避醒来后不派生、到 `Stopped` | 把 `stop()` 的 `abort()` 换成干等协程 ⇒ stop 耗时 ≥ 退避；去掉醒来后的停止检查 ⇒ 退避结束后多派生一个子进程 |
//! | V1-2 退出与自动重启同时 | `v1_2_quit_during_pending_restart_after_ready_crash_cancels_it` | Ready 后崩溃 → 退避中退出 ⇒ 无重启、无新子进程 | 同 V1-1（本窗口走 Ready 分支的退避，与 V1-1 的 Failed 分支互补） |
//! | V1-3 崩溃后端口变化 | `v1_3_running_broadcast_relays_fresh_endpoint_after_port_change` | `Running` 广播中继**本次**就绪端点；端口变化时不得复用旧端点 | 广播里改存首次端点（缓存）⇒ 端口变化后中继旧端口 |
//! | V1-4 两个监管周期并发 | `v1_4_double_start_while_running_keeps_one_supervision_loop` + `v1_4_start_after_natural_termination_spawns_a_new_loop` | 运行中重复 start 幂等；自然终止后 start 真的开新一轮 | 去掉 `is_finished` 守卫 ⇒ 双循环双派生；去掉已完成句柄的清理 ⇒ 终止后 start 永远空转 |
//! | V1-5 退出但管道未结束 | `v1_5_child_exit_settles_watcher_pump_and_cleanup` | exit watcher 兑现到终态、崩溃行落盘、活跃实例被清 | 丢掉 wait 任务 ⇒ 等不到终态；泵在 EOF 前丢行 ⇒ 盘上无崩溃行；不清实例 ⇒ `is_running()` 恒真 |
//! | V1-6 启动成功但未就绪 | `v1_6_never_ready_child_terminates_and_surfaces_failure` | 就绪超时走到终态 `Failed`、子进程被回收、重试次数符合配置 | 超时分支不 terminate ⇒ 子进程残留；判据消失 ⇒ 永远等不到 `Failed` |
//!
//! ## 矩阵自校验
//!
//! `coverage_matrix_is_complete_and_falsifiable` 读本文件源码，断言每个窗口都有一条
//! 同名测试、且窗口总数就是 6——删一个场景的测试必须红（§7.3「扫出来再校验」的
//! E5-空纪律：先断言扫出数 > 0，再逐个校验）。
//!
//! ## 前置条件
//!
//! 需要系统 `node` 与仓库内 `scripts/mock-harness.mjs`；缺任一则整组跳过
//! （与 `mock_launch.rs` 同一口径，不让缺依赖伪装成通过）。

#![allow(dead_code)]

mod fixture;

use std::path::Path;
use std::time::{Duration, Instant};

use dsh_host::launch::LaunchEvent;
use dsh_host::process::is_process_alive;
use dsh_host::supervisor::{Supervisor, SupervisorConfig, SupervisorState};
use dsh_host::token::LaunchEndpoint;

use fixture::fixture;

/// 单次轮询预算的公共下限：只防「死锁化 fixture」，不参与任何判据。
const SETTLE_BUDGET: Duration = Duration::from_secs(60);

/// 观测到的状态广播累加器。
#[derive(Default)]
struct Observations {
    /// 按时间顺序的 `LaunchEvent::Spawned` pid。
    spawned_pids: Vec<u32>,
    /// 按时间顺序的 `LaunchEvent::Ready` 端点。
    ready_endpoints: Vec<LaunchEndpoint>,
    /// 按时间顺序的 `SupervisorState::Running`（端点, pid）。
    running: Vec<(LaunchEndpoint, u32)>,
    /// 观测到的「还要重启」的退避时长序列。
    pending_backoffs: Vec<Duration>,
    /// 是否见到终态 `Failed`。
    failed: bool,
    /// 是否见到 `Stopped`。
    stopped: bool,
}

/// 把广播通道里当前可读的事件全部收进累加器（非阻塞）。
fn drain(rx: &mut tokio::sync::broadcast::Receiver<SupervisorState>, obs: &mut Observations) {
    loop {
        match rx.try_recv() {
            Ok(SupervisorState::LaunchProgress(LaunchEvent::Spawned { pid, .. })) => {
                obs.spawned_pids.push(pid);
            }
            Ok(SupervisorState::LaunchProgress(LaunchEvent::Ready { endpoint })) => {
                obs.ready_endpoints.push(endpoint);
            }
            Ok(SupervisorState::Running { endpoint, pid }) => {
                obs.running.push((endpoint, pid));
            }
            Ok(SupervisorState::Crashed {
                will_restart,
                next_backoff,
                ..
            }) => {
                if will_restart {
                    if let Some(backoff) = next_backoff {
                        obs.pending_backoffs.push(backoff);
                    }
                }
            }
            Ok(SupervisorState::Failed { .. }) => obs.failed = true,
            Ok(SupervisorState::Stopped) => obs.stopped = true,
            Ok(_) => {}
            Err(tokio::sync::broadcast::error::TryRecvError::Empty) => break,
            // 通道关闭：桥/协程已退出，没有更多事件可收。
            Err(tokio::sync::broadcast::error::TryRecvError::Closed) => break,
            Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_)) => {}
        }
    }
}

/// 轮询直到 `predicate` 满足或预算耗尽；返回是否满足。
async fn collect_until(
    rx: &mut tokio::sync::broadcast::Receiver<SupervisorState>,
    obs: &mut Observations,
    budget: Duration,
    predicate: impl Fn(&Observations) -> bool,
) -> bool {
    let deadline = Instant::now() + budget;
    while Instant::now() < deadline {
        drain(rx, obs);
        if predicate(obs) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    drain(rx, obs);
    predicate(obs)
}

/// 轮询等待某 pid 消失。
async fn wait_until_gone(pid: u32, budget: Duration) -> bool {
    let deadline = Instant::now() + budget;
    while Instant::now() < deadline {
        if !is_process_alive(pid) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    !is_process_alive(pid)
}

/// 轮询等待文件里出现某行（容忍写线程的异步刷盘）。
async fn wait_file_contains(path: &Path, needle: &str, budget: Duration) -> bool {
    let deadline = Instant::now() + budget;
    while Instant::now() < deadline {
        if let Ok(content) = std::fs::read_to_string(path) {
            if content.contains(needle) {
                return true;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    std::fs::read_to_string(path)
        .map(|content| content.contains(needle))
        .unwrap_or(false)
}

/// V1-1：**退避等待期间** `stop()` 必须取消待执行的重启。
///
/// 场景走 `LaunchOutcome::Failed` 分支的退避（`DSH_MOCK_FAIL=startup`：启动即失败）。
/// 与 V1-2 互为补充——那条走 Ready 后崩溃的分支。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn v1_1_stop_during_backoff_wait_cancels_pending_restart() {
    let Some(fx) = fixture() else {
        eprintln!("[skip] 未找到系统 node / mock 脚本，跳过 V1-1");
        return;
    };

    // 退避取 5s：stop() 必须落在退避睡眠里，而不是等它自然结束。
    const BACKOFF: Duration = Duration::from_secs(5);
    let config = SupervisorConfig {
        launcher_config: fx.config(Duration::from_secs(8)),
        max_restarts: 3,
        initial_backoff: BACKOFF,
        max_backoff: Duration::from_secs(10),
        backoff_multiplier: 2.0,
        stable_uptime: Duration::from_secs(60),
        host: None,
        profile: None,
        env: None,
        extra_args: Vec::new(),
        extra_envs: vec![("DSH_MOCK_FAIL".into(), "startup".into())],
    };

    let supervisor = Supervisor::new(fx.layout.clone(), config);
    let mut rx = supervisor.subscribe();
    supervisor.start().await;

    let mut obs = Observations::default();
    let saw_crash = collect_until(&mut rx, &mut obs, Duration::from_secs(30), |obs| {
        !obs.pending_backoffs.is_empty()
    })
    .await;
    assert!(
        saw_crash,
        "startup 模式应立刻失败并进入退避等待（否则本用例没有测到目标窗口）"
    );
    let spawns_before_stop = obs.spawned_pids.len();
    assert_eq!(
        spawns_before_stop, 1,
        "进入退避前应只派生过一次，实际 {spawns_before_stop}"
    );

    // ← 关键动作：**退避睡眠期间**停止。
    let stop_started = Instant::now();
    supervisor.stop().await;
    let stop_elapsed = stop_started.elapsed();
    drain(&mut rx, &mut obs);

    assert!(
        stop_elapsed < Duration::from_secs(2),
        "stop() 耗时 {stop_elapsed:?}——它干等了 {BACKOFF:?} 退避（abort 被换成优雅等待？）"
    );
    assert!(obs.stopped, "stop() 之后必须收到 Stopped");

    // 等过整个退避窗口：醒来也不得再派生（待执行的重启已被取消）。
    let deadline = Instant::now() + BACKOFF + Duration::from_secs(2);
    while Instant::now() < deadline {
        drain(&mut rx, &mut obs);
        if obs.spawned_pids.len() > spawns_before_stop {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    drain(&mut rx, &mut obs);
    assert_eq!(
        obs.spawned_pids.len(),
        spawns_before_stop,
        "退避期内 stop 后仍派生了新子进程——待执行的重启没有被取消（醒来后的停止检查被删？）"
    );
}

/// V1-2：**退出与自动重启同时发生**（ Ready 后崩溃 → 退避中退出）。
///
/// 壳层那一半（`quit_guard` → `shutdown()` → `HarnessSupervisor::stop()`）由 CI 断言；
/// 本用例钉住 core 语义：无论重启协程睡在哪个分支的退避里，退出都取消它，
/// 且不留下新子进程。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn v1_2_quit_during_pending_restart_after_ready_crash_cancels_it() {
    let Some(fx) = fixture() else {
        eprintln!("[skip] 未找到系统 node / mock 脚本，跳过 V1-2");
        return;
    };

    const BACKOFF: Duration = Duration::from_secs(5);
    let config = SupervisorConfig {
        launcher_config: fx.config(Duration::from_secs(20)),
        max_restarts: 3,
        initial_backoff: BACKOFF,
        max_backoff: Duration::from_secs(10),
        backoff_multiplier: 2.0,
        // 崩溃就发生（500ms 后）⇒ uptime 远小于稳定窗口，不会重置计数。
        stable_uptime: Duration::from_secs(60),
        host: None,
        profile: None,
        env: None,
        extra_args: Vec::new(),
        extra_envs: vec![
            ("DSH_MOCK_FAIL".into(), "after-ready".into()),
            ("DSH_MOCK_AFTER_READY_MS".into(), "500".into()),
        ],
    };

    let supervisor = Supervisor::new(fx.layout.clone(), config);
    let mut rx = supervisor.subscribe();
    supervisor.start().await;

    let mut obs = Observations::default();
    // 先就绪、再崩溃、再进入退避——三步都等到才算进入目标窗口。
    let entered = collect_until(&mut rx, &mut obs, SETTLE_BUDGET, |obs| {
        !obs.running.is_empty() && !obs.pending_backoffs.is_empty()
    })
    .await;
    assert!(
        entered,
        "应观测到 Ready 之后的崩溃退避（running={} backoffs={:?}）",
        obs.running.len(),
        obs.pending_backoffs
    );
    let spawns_before_stop = obs.spawned_pids.len();
    assert_eq!(
        spawns_before_stop, 1,
        "崩溃重启前应只派生过一次，实际 {spawns_before_stop}"
    );

    let stop_started = Instant::now();
    supervisor.stop().await;
    let stop_elapsed = stop_started.elapsed();
    drain(&mut rx, &mut obs);

    assert!(
        stop_elapsed < Duration::from_secs(2),
        "stop() 耗时 {stop_elapsed:?}——退出路径干等了退避"
    );
    assert!(obs.stopped, "退出后必须收到 Stopped");

    let deadline = Instant::now() + BACKOFF + Duration::from_secs(2);
    while Instant::now() < deadline {
        drain(&mut rx, &mut obs);
        if obs.spawned_pids.len() > spawns_before_stop {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    drain(&mut rx, &mut obs);
    assert_eq!(
        obs.spawned_pids.len(),
        spawns_before_stop,
        "退出取消了待执行重启，但退避醒来后仍派生了一个子进程"
    );
    // 崩溃后已就绪的那个子进程也必须被退出路径收掉（不留孤儿）。
    for (_, pid) in &obs.running {
        assert!(
            wait_until_gone(*pid, Duration::from_secs(10)).await,
            "退出后 pid={pid} 仍存活——孤儿进程"
        );
    }
}

/// V1-3：**端口变化时** `Running` 广播必须中继**本次**就绪的端点。
///
/// 做法：占住一个端口并把它写进粘性端口文件（CX-14）。启动器首个尝试必然复用
/// 粘性端口、绑不上（被我们占着）才回退随机预留 ⇒ 本次就绪端口**确定**不同于
/// 被占端口。此时若广播里存的是首次端点（缓存旧值），断言当场红。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn v1_3_running_broadcast_relays_fresh_endpoint_after_port_change() {
    let Some(fx) = fixture() else {
        eprintln!("[skip] 未找到系统 node / mock 脚本，跳过 V1-3");
        return;
    };

    let holder = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("应能绑定探针端口");
    let held_port = holder.local_addr().expect("探针端口应可读").port();
    fixture::write_sticky_port(&fx.layout, held_port);

    let config = SupervisorConfig {
        launcher_config: fx.config(Duration::from_secs(20)),
        max_restarts: 0,
        initial_backoff: Duration::from_millis(50),
        max_backoff: Duration::from_millis(100),
        backoff_multiplier: 2.0,
        stable_uptime: Duration::from_secs(60),
        host: None,
        profile: None,
        env: None,
        extra_args: Vec::new(),
        extra_envs: Vec::new(),
    };

    let supervisor = Supervisor::new(fx.layout.clone(), config);
    let mut rx = supervisor.subscribe();
    supervisor.start().await;

    let mut obs = Observations::default();
    let ready = collect_until(&mut rx, &mut obs, SETTLE_BUDGET, |obs| {
        !obs.running.is_empty()
    })
    .await;
    assert!(ready, "未观测到 Running 广播（mock 应能就绪）");

    let (running_endpoint, _) = &obs.running[0];
    assert_ne!(
        running_endpoint.port, held_port,
        "被占用的端口不得成为就绪端口（粘性端口复用的前提就是可绑定）"
    );
    let ready_event = obs
        .ready_endpoints
        .last()
        .expect("Running 之前必然出现过 LaunchEvent::Ready");
    assert_eq!(
        ready_event, running_endpoint,
        "Running 广播必须中继本次启动的真实端点（端口变化时中继旧端点 = 前端停在旧端口）"
    );
    // 探针端口全程被我们占着：证明就绪端口是回退分配的新端口，不是粘性端口。
    assert_eq!(
        holder.local_addr().expect("探针端口应仍可读").port(),
        held_port
    );

    supervisor.stop().await;
}

/// V1-4a：运行中重复 `start()` 不得产生第二个监管循环。
///
/// 场景：`no-url` 让子进程活着但不就绪，稳定停在「监管协程运行中」窗口。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn v1_4_double_start_while_running_keeps_one_supervision_loop() {
    let Some(fx) = fixture() else {
        eprintln!("[skip] 未找到系统 node / mock 脚本，跳过 V1-4a");
        return;
    };

    let config = SupervisorConfig {
        launcher_config: fx.config(Duration::from_secs(15)),
        max_restarts: 0,
        initial_backoff: Duration::from_millis(50),
        max_backoff: Duration::from_millis(100),
        backoff_multiplier: 2.0,
        stable_uptime: Duration::from_secs(60),
        host: None,
        profile: None,
        env: None,
        extra_args: Vec::new(),
        extra_envs: vec![("DSH_MOCK_FAIL".into(), "no-url".into())],
    };

    let supervisor = Supervisor::new(fx.layout.clone(), config);
    let mut rx = supervisor.subscribe();
    supervisor.start().await;

    let mut obs = Observations::default();
    let spawned = collect_until(&mut rx, &mut obs, Duration::from_secs(30), |obs| {
        !obs.spawned_pids.is_empty()
    })
    .await;
    assert!(spawned, "no-url 模式应先派生子进程");
    let pid = *obs.spawned_pids.last().expect("刚断言过非空");

    // ← 关键动作：循环正在跑时再 start 一次。
    supervisor.start().await;

    // 给竞态留出时间：若守卫失效，第二个循环会紧接着派生第二个子进程。
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        drain(&mut rx, &mut obs);
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    drain(&mut rx, &mut obs);
    assert_eq!(
        obs.spawned_pids.len(),
        1,
        "运行中重复 start 必须幂等；出现第二个派生说明 is_finished 守卫失效（双监管循环）"
    );

    supervisor.stop().await;
    assert!(
        wait_until_gone(pid, Duration::from_secs(10)).await,
        "stop 后 pid={pid} 仍存活——孤儿进程"
    );
}

/// V1-4b：监管协程**自然终止**（断路器开路）之后，`start()` 必须真的开启新一轮。
///
/// 错误页的「重试」走的就是这条路。若已完成句柄不被清理，`start()` 会永久卡在
/// 「已在运行」的假象上——用户点重试毫无反应，而编译一切正常。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn v1_4_start_after_natural_termination_spawns_a_new_loop() {
    let Some(fx) = fixture() else {
        eprintln!("[skip] 未找到系统 node / mock 脚本，跳过 V1-4b");
        return;
    };

    let config = SupervisorConfig {
        launcher_config: fx.config(Duration::from_secs(8)),
        // max_restarts = 0 ⇒ 首次崩溃即开路，协程自然 break。
        max_restarts: 0,
        initial_backoff: Duration::from_millis(50),
        max_backoff: Duration::from_millis(100),
        backoff_multiplier: 2.0,
        stable_uptime: Duration::from_secs(60),
        host: None,
        profile: None,
        env: None,
        extra_args: Vec::new(),
        extra_envs: vec![("DSH_MOCK_FAIL".into(), "startup".into())],
    };

    let supervisor = Supervisor::new(fx.layout.clone(), config);
    let mut rx = supervisor.subscribe();
    supervisor.start().await;

    let mut obs = Observations::default();
    let failed = collect_until(&mut rx, &mut obs, Duration::from_secs(30), |obs| obs.failed).await;
    assert!(failed, "max_restarts=0 时应首次崩溃即进入 Failed");

    // ← 关键动作：协程已自然结束，再次启动。
    supervisor.start().await;

    let mut second = Observations::default();
    let restarted = collect_until(&mut rx, &mut second, Duration::from_secs(30), |obs| {
        !obs.spawned_pids.is_empty()
    })
    .await;
    assert!(
        restarted,
        "Failed 之后再次 start 必须派生新一轮监管循环（已退出句柄未清理 ⇒ 重试永远空转）"
    );

    supervisor.stop().await;
}

/// V1-5：子进程退出时，**wait / 日志泵 / 实例清理**三条收尾都必须真正结束。
///
/// 断言分三组，分别对应三类「静默悬挂」：
/// ① exit watcher 被丢 ⇒ 永远等不到终态（预算会炸）；
/// ② 日志泵在 EOF 前丢行 ⇒ 崩溃行不在盘上（归因证据链断头，契约 C7）；
/// ③ 活跃实例不清理 ⇒ `is_running()` 恒真（后续 stop 拿不到实例）。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn v1_5_child_exit_settles_watcher_pump_and_cleanup() {
    let Some(fx) = fixture() else {
        eprintln!("[skip] 未找到系统 node / mock 脚本，跳过 V1-5");
        return;
    };

    let config = SupervisorConfig {
        launcher_config: fx.config(Duration::from_secs(20)),
        max_restarts: 0,
        initial_backoff: Duration::from_millis(50),
        max_backoff: Duration::from_millis(100),
        backoff_multiplier: 2.0,
        stable_uptime: Duration::from_secs(60),
        host: None,
        profile: None,
        env: None,
        extra_args: Vec::new(),
        extra_envs: vec![
            ("DSH_MOCK_FAIL".into(), "after-ready".into()),
            ("DSH_MOCK_AFTER_READY_MS".into(), "1000".into()),
        ],
    };

    let supervisor = Supervisor::new(fx.layout.clone(), config);
    let mut rx = supervisor.subscribe();
    supervisor.start().await;

    let mut obs = Observations::default();
    let settled = collect_until(&mut rx, &mut obs, SETTLE_BUDGET, |obs| {
        !obs.running.is_empty() && obs.failed
    })
    .await;
    assert!(
        settled,
        "Ready 之后的崩溃必须被 exit watcher 观察到并走到终态 Failed（running={} failed={}）",
        obs.running.len(),
        obs.failed
    );

    // ③ 实例清理：崩溃后不得仍持有活跃实例。
    assert!(
        !supervisor.is_running().await,
        "子进程退出后活跃实例必须被取走（否则 stop() 终止不到它）"
    );

    // ② 日志泵：退出前的最后一行必须落盘（泵读到 EOF 才退出 ⇒ 不丢尾行）。
    let crash_line = "uncaught exception: mock crash after ready";
    let logged = wait_file_contains(&fx.layout.log_path, crash_line, Duration::from_secs(5)).await;
    assert!(
        logged,
        "崩溃行未出现在 {:?}——退出时的输出没有排空（契约 C7：落盘是归因证据链）",
        fx.layout.log_path
    );

    // 兜底：崩掉的那个子进程不得残留。
    for (_, pid) in &obs.running {
        assert!(
            wait_until_gone(*pid, Duration::from_secs(10)).await,
            "崩溃后 pid={pid} 仍存活"
        );
    }
}

/// V1-6：**进程起来了但服务没就绪**——必须走到终态并回收子进程，
/// 而不是无限等待（错误码路径由壳层 `classify_state::Terminal` 断言，CI 执行）。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn v1_6_never_ready_child_terminates_and_surfaces_failure() {
    let Some(fx) = fixture() else {
        eprintln!("[skip] 未找到系统 node / mock 脚本，跳过 V1-6");
        return;
    };

    let config = SupervisorConfig {
        // 总超时压到 2s：真实平台默认 120s 不适用于测试。
        launcher_config: fx.config(Duration::from_secs(2)),
        max_restarts: 1,
        initial_backoff: Duration::from_millis(50),
        max_backoff: Duration::from_millis(100),
        backoff_multiplier: 2.0,
        stable_uptime: Duration::from_secs(60),
        host: None,
        profile: None,
        env: None,
        extra_args: Vec::new(),
        extra_envs: vec![("DSH_MOCK_FAIL".into(), "no-url".into())],
    };

    let supervisor = Supervisor::new(fx.layout.clone(), config);
    let mut rx = supervisor.subscribe();
    supervisor.start().await;

    let mut obs = Observations::default();
    let failed = collect_until(&mut rx, &mut obs, SETTLE_BUDGET, |obs| obs.failed).await;
    assert!(
        failed,
        "不就绪必须在就绪超时后走到终态 Failed，而不是无限等待"
    );
    assert_eq!(
        obs.spawned_pids.len(),
        2,
        "max_restarts=1 应恰好重试一次（两次派生），实际 {}",
        obs.spawned_pids.len()
    );

    // 超时路径必须回收子进程（`execute()` 的超时分支 terminate + 等退出）。
    for pid in &obs.spawned_pids {
        assert!(
            wait_until_gone(*pid, Duration::from_secs(10)).await,
            "就绪超时后 pid={pid} 仍存活——超时分支没有回收子进程"
        );
    }
}

/// **覆盖矩阵自校验**：每个窗口都必须有一条同名测试，且窗口总数就是 6。
///
/// 这条本身也是可证伪的：删掉任何一个场景的测试函数，对应窗口的断言当场红；
/// 从矩阵里删掉一行窗口，总数断言红（E5-空纪律：先断言扫出数 > 0）。
#[test]
fn coverage_matrix_is_complete_and_falsifiable() {
    const MATRIX: &[(&str, &[&str])] = &[
        (
            "V1-1",
            &["v1_1_stop_during_backoff_wait_cancels_pending_restart"],
        ),
        (
            "V1-2",
            &["v1_2_quit_during_pending_restart_after_ready_crash_cancels_it"],
        ),
        (
            "V1-3",
            &["v1_3_running_broadcast_relays_fresh_endpoint_after_port_change"],
        ),
        (
            "V1-4",
            &[
                "v1_4_double_start_while_running_keeps_one_supervision_loop",
                "v1_4_start_after_natural_termination_spawns_a_new_loop",
            ],
        ),
        (
            "V1-5",
            &["v1_5_child_exit_settles_watcher_pump_and_cleanup"],
        ),
        (
            "V1-6",
            &["v1_6_never_ready_child_terminates_and_surfaces_failure"],
        ),
    ];

    assert_eq!(MATRIX.len(), 6, "V1 的竞态窗口应恰为六个");
    assert!(!MATRIX.is_empty(), "扫出的窗口数必须 > 0（E5-空纪律）");

    // `include_str!` 以本文件所在目录（`tests/`）为基准解析相对路径，
    // 因此直接用文件名即可——无需 `file!()` / `CARGO_MANIFEST_DIR` 拼接。
    // 若本文件被改名或移出 `tests/`，此路径需同步更新（此处刻意不抽象，
    // 因为迁移本身就是该改这里的时候）。
    let source = include_str!("supervisor_lifecycle_races.rs");
    // 判据必须按「文档行」匹配。写成 `source.contains("## 覆盖矩阵")` 会让针出现在
    // 本条断言自己的源码里而恒真——装饰性守卫比没有守卫更坏（E5 纪律），这里刻意
    // 用 trim 后的行首匹配，使断言只能在真的存在那段文档时通过。
    assert!(
        source
            .lines()
            .any(|line| line.trim_start_matches("//! ").starts_with("## 覆盖矩阵")),
        "矩阵表头缺失——文档矩阵与自校验必须同源"
    );
    for (window, tests) in MATRIX {
        for name in *tests {
            assert!(
                source.contains(&format!("async fn {name}(")),
                "窗口 {window} 缺少测试 {name}——删场景必须让这里红"
            );
        }
    }
}
