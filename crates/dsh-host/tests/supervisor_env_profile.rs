//! P1 —— `SupervisorConfig` 的 `env` / `extra_envs` / `profile` 三条通道的集成面证据。
//!
//! ## 守的是哪一类缺陷
//!
//! `SupervisorConfig.extra_envs` 在 2026-10-11 之前是**死字段**：声明了、在 `Default`
//! 里初始化了、**从未被任何代码读取**。这类字段比「没有该功能」更坏——它让调用方
//! 以为环境注入已经生效，而实际什么都没发生，且**编译与测试都不会报错**。
//! 同理，`profile` 通道缺失会让安全模式静默退化成普通启动。
//!
//! 所以这两条不能只做「构造函数里赋了个值」的断言——那种断言在字段被忽略时**照样绿**。
//! 这里的判据是**子进程真的看到了它**：
//!
//! | 通道 | 观测方式 | 为什么能证伪 |
//! |------|---------|-------------|
//! | `extra_envs` | 只经环境变量注入 `DSH_MOCK_FAIL=startup`（**不传 `--fail` argv**），断言启动**失败** | 若环境没送到子进程，mock 会正常启动并进入 `Running` |
//! | `profile` | 从子进程 stdout 的 `[harness-node] argv=[…]` 行里找 `--profile` | 若 profile 没透传，argv 里不会出现它 |
//!
//! 前置：需要系统 `node` 与 `scripts/mock-harness.mjs`；缺任一则跳过（与 `mock_launch.rs` 同一口径）。

// 共享 fixture 提供 `env_with` / `env` / `launcher`，本测试只用它的
// `layout` / `config()`（Supervisor 内部自建 Launcher 与 env）。
#![allow(dead_code)]

mod fixture;

use std::time::{Duration, Instant};

use dsh_host::supervisor::{Supervisor, SupervisorConfig, SupervisorState};

use fixture::fixture;

/// 整个场景的上限（只防死锁，不参与判据）。
const SCENARIO_BUDGET: Duration = Duration::from_secs(45);

/// 轮询收集观测结果：是否见过 `Running`、是否见过 `Failed`，以及全部子进程日志行。
#[derive(Default)]
struct Observed {
    saw_running: bool,
    saw_failed: bool,
    log_lines: Vec<String>,
    /// 观测到的状态序列（诊断用：失败时能看清到底走到了哪一步）。
    states: Vec<String>,
}

fn drain(rx: &mut tokio::sync::broadcast::Receiver<SupervisorState>, out: &mut Observed) {
    loop {
        match rx.try_recv() {
            Ok(state) => {
                out.states.push(state_label(&state));
                match state {
                    SupervisorState::Running { .. } => out.saw_running = true,
                    SupervisorState::Failed { .. } => out.saw_failed = true,
                    SupervisorState::LaunchProgress(dsh_host::launch::LaunchEvent::Log(line)) => {
                        // `LogLine` 是「来源 + 已清洗文本」；判据只看文本内容。
                        out.log_lines.push(line.text);
                    }
                    _ => {}
                }
            }
            Err(tokio::sync::broadcast::error::TryRecvError::Empty) => return,
            Err(tokio::sync::broadcast::error::TryRecvError::Closed) => return,
            Err(tokio::sync::broadcast::error::TryRecvError::Lagged(n)) => {
                out.states.push(format!("<Lagged({n})>"));
            }
        }
    }
}

/// 状态的可读标签（诊断用）。
fn state_label(state: &SupervisorState) -> String {
    match state {
        SupervisorState::Idle => "Idle".to_string(),
        SupervisorState::Starting { attempt } => format!("Starting#{attempt}"),
        SupervisorState::LaunchProgress(event) => {
            format!("Progress({event:?})").chars().take(60).collect()
        }
        SupervisorState::Running { .. } => "Running".to_string(),
        SupervisorState::Crashed {
            restart_count,
            will_restart,
            ..
        } => {
            format!("Crashed#{restart_count}(restart={will_restart})")
        }
        SupervisorState::Failed { total_restarts, .. } => format!("Failed#{total_restarts}"),
        SupervisorState::Stopping => "Stopping".to_string(),
        SupervisorState::Stopped => "Stopped".to_string(),
    }
}

/// 轮询直到 `predicate` 成立或预算耗尽。
async fn poll_until(
    rx: &mut tokio::sync::broadcast::Receiver<SupervisorState>,
    budget: Duration,
    mut predicate: impl FnMut(&Observed) -> bool,
) -> Observed {
    let deadline = Instant::now() + budget;
    let mut out = Observed::default();
    loop {
        drain(rx, &mut out);
        if predicate(&out) || Instant::now() >= deadline {
            return out;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// `extra_envs` 必须真正到达子进程。
///
/// 判据是**只有环境变量能解释的成功/失败差异**：配置里**没有** `--fail` argv，
/// 唯一的故障注入源是 `DSH_MOCK_FAIL=startup`。因此：
///   · 观测到 `Failed`（或至少从未 `Running`）⇒ 环境送到了子进程；
///   · 观测到 `Running` ⇒ 环境没送到（正是死字段时代的症状）。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn extra_envs_reaches_child_process() {
    let Some(fx) = fixture() else {
        eprintln!("[skip] 未找到系统 node / mock 脚本，跳过 extra_envs 集成测试");
        return;
    };

    let config = SupervisorConfig {
        launcher_config: fx.config(Duration::from_secs(8)),
        max_restarts: 1,
        initial_backoff: Duration::from_millis(50),
        max_backoff: Duration::from_millis(100),
        backoff_multiplier: 2.0,
        stable_uptime: Duration::from_secs(1),
        host: None,
        profile: None,
        // 关键：**不传 `--fail`**，故障模式只能经环境变量到达。
        env: None,
        extra_args: Vec::new(),
        extra_envs: vec![("DSH_MOCK_FAIL".into(), "startup".into())],
    };

    let supervisor = Supervisor::new(fx.layout.clone(), config);
    let mut rx = supervisor.subscribe();
    supervisor.start().await;

    // 等到「失败」或「就绪」任一出现即可定论。
    let out = poll_until(&mut rx, SCENARIO_BUDGET, |o| o.saw_failed || o.saw_running).await;
    supervisor.stop().await;

    assert!(
        !out.saw_running,
        "子进程竟然就绪了——说明 `DSH_MOCK_FAIL=startup` **没有**到达子进程，\
         `extra_envs` 仍是死字段（这是本测试要防的回归）"
    );
    assert!(
        out.saw_failed,
        "既未就绪也未失败，观测窗口内没有任何定论（子进程日志 {} 行；状态序列={:?}）",
        out.log_lines.len(),
        out.states
    );
}

/// `profile` 必须透传到子进程 argv。
///
/// 观测点是 mock 自己打印的诊断行 `[harness-node] argv=[…]`——它记录的是
/// **子进程实际收到的 argv**，因此比「构造函数里赋了值」强得多。
///
/// ⚠️ 从**落盘日志**（`layout.log_path`）读，而不是从 `LaunchEvent::Log` 事件读：
/// 实测该事件的转发覆盖不到子进程的常规 stdout（本用例初版就因此拿到 0 行）。
/// 落盘是契约 C7 的证据链，也更稳。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn profile_reaches_child_argv() {
    let Some(fx) = fixture() else {
        eprintln!("[skip] 未找到系统 node / mock 脚本，跳过 profile 集成测试");
        return;
    };

    const PROFILE: &str = "desktop-safe-mode";

    // `profile` 命中安全模式时，启动器会改用它自己的 patch 层
    // （`Layout::safe_patch`），而共享 fixture 只建了普通 patch。
    // 缺它的话启动会在派生**之前**就以 MissingResource 失败——子进程根本不会跑，
    // 于是「argv 里有没有 --profile」也就无从观测。这里补一个占位。
    // （mock 不读 patch 内容，`missing_resources` 只要求文件存在。）
    if let Err(error) = std::fs::write(
        &fx.layout.safe_patch,
        "# dsh-host integration mock safe-mode patch placeholder\n[]\n",
    ) {
        eprintln!(
            "[skip] 无法写入 safe patch 占位 {}：{error}",
            fx.layout.safe_patch.display()
        );
        return;
    }

    let config = SupervisorConfig {
        launcher_config: fx.config(Duration::from_secs(15)),
        max_restarts: 0,
        initial_backoff: Duration::from_millis(50),
        max_backoff: Duration::from_millis(100),
        backoff_multiplier: 2.0,
        stable_uptime: Duration::from_secs(1),
        host: None,
        profile: Some(PROFILE.to_string()),
        env: None,
        extra_args: Vec::new(),
        extra_envs: Vec::new(),
    };

    let log_path = fx.layout.log_path.clone();
    let supervisor = Supervisor::new(fx.layout.clone(), config);
    let mut rx = supervisor.subscribe();
    supervisor.start().await;

    // 只需等到「已就绪」，此时子进程必然已经打印过 diagnostics。
    let out = poll_until(&mut rx, SCENARIO_BUDGET, |o| o.saw_running || o.saw_failed).await;
    supervisor.stop().await;

    // 落盘可能有毫秒级延迟：先读一次，再在「还没读到且未超时」时轮询重读。
    //
    // 这里刻意不用「`let mut content = String::new()` + loop 里赋值」的写法：
    // 初值从未被读取，clippy 的 `unused_assignments` 会报
    // `value assigned to content is never read`，而 CI 是 `-D warnings`。
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut content = std::fs::read_to_string(&log_path).unwrap_or_default();
    while !content.contains("argv=") && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
        content = std::fs::read_to_string(&log_path).unwrap_or_default();
    }

    let argv_line = content
        .lines()
        .find(|l| l.contains("argv="))
        .unwrap_or_else(|| {
            panic!(
                "日志 {} 里没有 argv 诊断行（profile 透传无法判定）。\
                 就绪={} 失败={}；日志 {} 字节；状态序列={:?}",
                log_path.display(),
                out.saw_running,
                out.saw_failed,
                content.len(),
                out.states
            )
        });

    assert!(
        argv_line.contains("--profile") && argv_line.contains(PROFILE),
        "子进程 argv 里没有 `--profile {PROFILE}`——profile 通道没生效。argv 行：{argv_line}"
    );
}
