//! P4 —— 断言「**启动过程中** `stop()` 不得残留孤儿进程」。
//!
//! ## 为什么单独立一条（这是接线文档里唯一标了「无测试覆盖」的边界）
//!
//! `Supervisor::stop()`（`crates/dsh-host/src/supervisor.rs`）做三件事：
//! 置 `is_stopping` → `terminate()` 活跃实例 → `abort()` 监督协程。
//!
//! 问题在于**活跃实例只在 `LaunchOutcome::Ready` 之后才被缓存**
//! （`*guard = Some(ActiveInstance { running })`）。也就是说，在「子进程已 spawn
//! 但还没就绪」的窗口里 `stop()`：
//!
//!   · `active_instance` 仍是 `None` ⇒ **不会调用 `terminate()`**；
//!   · 只剩 `abort()` 把监督协程连同**进行中的 `Launcher::launch()` future** 一起丢弃；
//!   · 那个 future 里握着的子进程句柄随 drop 释放，孤儿防护**只能**依赖
//!     Win32 Job Object / POSIX PDEATHSIG 的兜底——没有任何断言证明它真的兜住了。
//!
//! 这正是 `docs/dev-plan-supervisor-shell-wiring.md` §5.3 的 E3，也是接线前
//! **唯一**标着「需补测试」的边界。桌面壳的「菜单 → 停止」「退出守卫」都会走到
//! 这条路径，因此它不该只靠推理。
//!
//! ## 判据怎么做到精确（不误伤并行测试）
//!
//! 不扫「所有 mock-harness 进程」——那会被同仓其它正在跑的用例污染。
//! 这里用子进程**真实 pid**（L2 在 `LaunchEvent::Spawned` 里给出）配合
//! `dsh_host::process::is_process_alive`，判定对象唯一且无歧义。
//!
//! ## 场景选择
//!
//! 用 `DSH_MOCK_FAIL=no-url`：mock 会 spawn、打印诊断，然后**挂住不打印就绪 URL**。
//! 于是 `Spawned` 一定发生、`Ready` 一定不发生 ⇒ 稳定停在「启动中」窗口。
//! 就绪超时设成 60s，确保 `stop()` 不会晚于超时失败（否则测的是另一条路径）。

// 共享 fixture 提供 `env_with` / `env` / `launcher`，本测试只用其 `layout` / `config()`。
#![allow(dead_code)]

mod fixture;

use std::time::{Duration, Instant};

use dsh_host::process::is_process_alive;
use dsh_host::supervisor::{Supervisor, SupervisorConfig, SupervisorState};

use fixture::fixture;

/// 就绪总超时：刻意取大，保证 `stop()` 发生在它之前。
const READY_TIMEOUT: Duration = Duration::from_secs(60);

/// 等 `Spawned` 事件里的 pid。
async fn wait_for_spawned_pid(
    rx: &mut tokio::sync::broadcast::Receiver<SupervisorState>,
    budget: Duration,
) -> Option<u32> {
    let deadline = Instant::now() + budget;
    while Instant::now() < deadline {
        match rx.try_recv() {
            Ok(SupervisorState::LaunchProgress(dsh_host::launch::LaunchEvent::Spawned {
                pid,
                ..
            })) => return Some(pid),
            Ok(_) => {}
            Err(tokio::sync::broadcast::error::TryRecvError::Empty) => {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Err(tokio::sync::broadcast::error::TryRecvError::Closed) => return None,
            Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_)) => {}
        }
    }
    None
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

/// **启动中 `stop()` 必须回收子进程**。
///
/// 可证伪性：若把 `Supervisor::stop()` 里的 `terminate()` 与 Job Object 兜底任一处
/// 去掉，本用例会红——它会报出仍然存活的 pid。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stop_during_startup_reclaims_the_child_process() {
    let Some(fx) = fixture() else {
        eprintln!("[skip] 未找到系统 node / mock 脚本，跳过「启动中 stop」集成测试");
        return;
    };

    let config = SupervisorConfig {
        launcher_config: fx.config(READY_TIMEOUT),
        max_restarts: 0,
        initial_backoff: Duration::from_millis(50),
        max_backoff: Duration::from_millis(100),
        backoff_multiplier: 2.0,
        stable_uptime: Duration::from_secs(1),
        host: None,
        profile: None,
        env: None,
        // mock 会 spawn 后**挂住不打印 URL** ⇒ 稳定停在「已 spawn、未就绪」窗口。
        extra_args: Vec::new(),
        extra_envs: vec![("DSH_MOCK_FAIL".into(), "no-url".into())],
    };

    let supervisor = Supervisor::new(fx.layout.clone(), config);
    let mut rx = supervisor.subscribe();
    supervisor.start().await;

    let pid = wait_for_spawned_pid(&mut rx, Duration::from_secs(30))
        .await
        .expect("应在 30s 内观测到 LaunchEvent::Spawned（否则本用例没有测到目标窗口）");
    assert!(
        is_process_alive(pid),
        "刚 spawn 的子进程 pid={pid} 应当存活——若此处已否，说明 spawn 与断言之间出了别的问题"
    );

    // ← 关键动作：**在尚未就绪时**停止。
    supervisor.stop().await;

    assert!(
        wait_until_gone(pid, Duration::from_secs(10)).await,
        "启动中 stop() 之后子进程 pid={pid} 仍存活——**孤儿进程**。\
         这说明「子进程已 spawn、未就绪」窗口里的终止路径没有兜住\
         （见本文件头部与接线文档 §5.3 / E3）"
    );
}
