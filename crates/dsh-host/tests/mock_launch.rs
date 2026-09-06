//! T05 — 用 mock-harness 端到端验证启动编排（C1/C3/C4/C7 的集成面）。
//!
//! 覆盖：happy path（`launch()` GUI 语义）与 `--fail` 四种故障模式
//! （`run()` CLI / 测试语义）：startup / no-url / port-in-use / after-ready。
//!
//! 前置条件不满足（无系统 node / 无 mock 脚本）时直接跳过。

mod fixture;

use std::time::Duration;

use dsh_host::contracts::{
    EXIT_HARNESS_FAILED, EXIT_PORT_IN_USE, EXIT_READY_TIMEOUT, MAX_PORT_ATTEMPTS,
};
use dsh_host::launch::{LaunchEvent, LaunchOutcome};
use dsh_host::process::is_process_alive;

use fixture::fixture;

/// 最大等退出时长（after-ready 用 `DSH_MOCK_AFTER_READY_MS` 压到 1s）。
const EXIT_WAIT: Duration = Duration::from_secs(10);

/// 等 live 日志里出现某行（最多约 2s），避免退出 watcher 与日志泵的轻微竞态。
async fn wait_live_contains(running: &dsh_host::launch::RunningHarness, needle: &str) -> bool {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    loop {
        if running
            .live_tail(200)
            .iter()
            .any(|line| line.contains(needle))
        {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// happy path：GUI 语义 `launch()` 折叠成 `LaunchOutcome::Ready`。
#[tokio::test]
async fn happy_path_reaches_ready_via_launch() {
    let Some(fx) = fixture() else {
        eprintln!("[skip] 未找到系统 node / mock 脚本，跳过 happy path");
        return;
    };

    let env = fx.env();
    let launcher = fx.launcher(Duration::from_secs(20));
    let mut events: Vec<LaunchEvent> = Vec::new();
    let outcome = launcher
        .launch(Some(&env), |event| events.push(event))
        .await
        .expect("宿主自身故障不应出现");

    let mut running = match outcome {
        LaunchOutcome::Ready(running) => running,
        LaunchOutcome::Failed { cause, .. } => panic!("mock 不应启动失败：{cause}"),
    };

    // 端点信息完整（C3：端口 >0、token 非空、host 是回环地址）。
    assert!(running.endpoint.port > 0, "端口应由内核分配");
    assert!(!running.endpoint.token.is_empty(), "token 不应为空");
    assert_eq!(running.endpoint.host, "127.0.0.1");
    assert!(running.endpoint.url.as_str().contains("token="));

    // 启动事件序列：Preparing → Spawned → TokenFound → ReadyChecking → Ready。
    let saw = |kind: &str| {
        events.iter().any(|event| {
            matches!(
                (kind, event),
                ("preparing", LaunchEvent::Preparing)
                    | ("spawned", LaunchEvent::Spawned { .. })
                    | ("token", LaunchEvent::TokenFound { .. })
                    | ("ready_checking", LaunchEvent::ReadyChecking { .. })
                    | ("ready", LaunchEvent::Ready { .. })
            )
        })
    };
    assert!(saw("preparing"));
    assert!(saw("spawned"));
    assert!(saw("token"));
    assert!(saw("ready_checking"));
    assert!(saw("ready"));

    // mock 诊断行已进入 live 日志（C3 之外的输出可被日志环容忍）。
    assert!(
        wait_live_contains(&running, "[arness-node] runtime").await,
        "缺少 runtime 诊断行"
    );
    // T05 增强：`[harness-node] argv=` 提前到 diagnostics，日志里应能看到真实 argv。
    assert!(
        wait_live_contains(&running, "[harness-node] argv=").await,
        "缺少 argv 诊断行"
    );

    // terminate + wait_exit：exit watcher 是「子进程已结束」的权威信号
    // （Windows 上 tokio Child 句柄可能迟一个调度 tick 才 drop，此时
    // OpenProcess 仍能打开已退出进程对象，故不额外做 liveness 断言；
    // 无孤儿由 scripts/fault-inject.mjs 的 findOrphans 覆盖）。
    running.terminate();
    let exit = running
        .wait_exit()
        .await
        .expect("terminate 后应能等到退出")
        .expect("exit watcher 不应返回 IO 错误");
    assert!(
        exit.code().is_some() || !exit.success(),
        "terminate 后子进程应已结束：{exit:?}"
    );
}

/// startup 故障：快速失败并归因 `dsh_entry_failed`（C7 优先于兜底退出码）。
#[tokio::test]
async fn startup_failure_is_classified_as_dsh_entry_failed() {
    let Some(fx) = fixture() else {
        eprintln!("[skip] 未找到系统 node / mock 脚本，跳过 startup 故障");
        return;
    };

    let env = fx.env_with(&[("DSH_MOCK_FAIL", "startup")]);
    let launcher = fx.launcher(Duration::from_secs(10));
    let error = match launcher.run(Some(&env), |_event| {}).await {
        Ok(_) => panic!("mock startup 失败时 run() 不应返回 Ok"),
        Err(error) => error,
    };

    assert_eq!(
        error.exit_code(),
        EXIT_HARNESS_FAILED,
        "harness 启动失败应映射到退出码 8：{error}"
    );
    assert_eq!(
        error.to_failure_cause().kind(),
        "dsh_entry_failed",
        "日志归因应命中 DSH entry failed：{error}"
    );
}

/// no-url 故障：进程存活但不打印 token → 就绪总超时（C4），归因 startup_timeout。
#[tokio::test]
async fn no_url_times_out_with_startup_timeout() {
    let Some(fx) = fixture() else {
        eprintln!("[skip] 未找到系统 node / mock 脚本，跳过 no-url 超时");
        return;
    };

    let env = fx.env_with(&[("DSH_MOCK_FAIL", "no-url")]);
    // 总超时压到 2s：真实平台默认 120s 不适用于测试。
    let launcher = fx.launcher(Duration::from_secs(2));
    let error = match launcher.run(Some(&env), |_event| {}).await {
        Ok(_) => panic!("mock 不打印 URL 时 run() 不应返回 Ok"),
        Err(error) => error,
    };

    assert_eq!(
        error.exit_code(),
        EXIT_READY_TIMEOUT,
        "no-url 应映射到就绪超时退出码 6：{error}"
    );
    assert_eq!(
        error.to_failure_cause().kind(),
        "startup_timeout",
        "归因应为 startup_timeout：{error}"
    );
}

/// port-in-use 故障：EADDRINUSE → 快速失败 + 换端口重试**耗尽** → PortInUse（C1 端口策略）。
///
/// 架构师裁决（T05 偏差 1）：必须断言重试真实发生——只靠 exit 7 + 耗时无法区分
/// 「耗尽 MAX_PORT_ATTEMPTS 次」与「重试循环被删 / MAX_PORT_ATTEMPTS 被误改后
/// 只试 1 次就返回 exit 7」。因此用 `on_event` 对 `LaunchEvent::Spawned` 计数
/// （lib 层事件，不数日志字符串）。
#[tokio::test]
async fn port_in_use_retries_then_fails_fast() {
    let Some(fx) = fixture() else {
        eprintln!("[skip] 未找到系统 node / mock 脚本，跳过 port-in-use 故障");
        return;
    };

    let env = fx.env_with(&[
        ("DSH_MOCK_FAIL", "port-in-use"),
        // 把 mock 的 EADDRINUSE 保活时长从默认 500ms 拉到 2s：确保宿主日志泵在
        // 探测循环里稳定置位 port_in_use（消除「子进程退出先于置位」竞态）。
        // 保活时长几乎不增加墙钟——wait_for_ready 判出 PortInUse 后宿主
        // terminate_process_tree 会提前杀死仍在保活的 mock，三次总耗时仍 ≪ 25s。
        ("DSH_MOCK_PORT_IN_USE_MS", "2000"),
    ]);
    let launcher = fx.launcher(Duration::from_secs(15));
    let started_at = std::time::Instant::now();
    let mut spawned = 0usize;
    let error = match launcher
        .run(Some(&env), |event| {
            if matches!(event, LaunchEvent::Spawned { .. }) {
                spawned += 1;
            }
        })
        .await
    {
        Ok(_) => panic!("mock EADDRINUSE 时 run() 不应返回 Ok"),
        Err(error) => error,
    };

    // 重试真实发生：spawned 必须等于 MAX_PORT_ATTEMPTS（== 3）。
    assert_eq!(
        spawned, MAX_PORT_ATTEMPTS,
        "应真实重试 MAX_PORT_ATTEMPTS 次后失败（spawned={spawned}）"
    );
    // 快速失败：远小于平台默认 120s 就绪超时。
    assert!(
        started_at.elapsed() < Duration::from_secs(25),
        "EADDRINUSE 应快速失败而非干等 120s"
    );
    assert_eq!(
        error.exit_code(),
        EXIT_PORT_IN_USE,
        "EADDRINUSE 重试耗尽应映射到退出码 7：{error}"
    );
    assert_eq!(
        error.to_failure_cause().kind(),
        "port_in_use",
        "归因应为 port_in_use：{error}"
    );
}

/// after-ready 故障：就绪后子进程崩溃 → exit watcher 捕获（RunningHarness 通道）。
#[tokio::test]
async fn after_ready_crash_is_captured_by_exit_watcher() {
    let Some(fx) = fixture() else {
        eprintln!("[skip] 未找到系统 node / mock 脚本，跳过 after-ready 故障");
        return;
    };

    let env = fx.env_with(&[
        ("DSH_MOCK_FAIL", "after-ready"),
        // 把崩溃从默认 5s 压到 1s，缩短测试时间。
        ("DSH_MOCK_AFTER_READY_MS", "1000"),
    ]);
    let launcher = fx.launcher(Duration::from_secs(20));
    let mut running = launcher
        .run(Some(&env), |_event| {})
        .await
        .expect("after-ready 的启动阶段应成功就绪");

    // 取出 exit watcher，等待 mock 在 Ready 之后崩溃（退出码 7）。
    let exit = running
        .take_exit()
        .expect("RunningHarness 应持有 exit watcher");
    let status = tokio::time::timeout(EXIT_WAIT, exit)
        .await
        .expect("mock 应在超时前崩溃")
        .expect("exit watcher 通道不应关闭")
        .expect("等待子进程退出不应失败");
    assert_eq!(status.code(), Some(7), "mock after-ready 以退出码 7 崩溃");

    // 崩溃行（uncaught exception）应进入 live 日志。
    assert!(
        wait_live_contains(&running, "uncaught exception: mock crash after ready").await,
        "崩溃行应被日志捕获"
    );
    // exit watcher 已观察到退出码 7（权威信号）；无孤儿由 fault-inject 覆盖。
}

/// 失败路径 `run()` 返回错误后，pidfile 留下本次尝试记录（下一次 start 的清扫依据）。
///
/// 用 no-url 故障：进程在超时前一直存活；execute() 的超时分支必须 terminate +
/// 等待退出后才返回（exit watcher 是权威信号，无孤儿由 fault-inject 覆盖）。
#[tokio::test]
async fn failed_launch_leaves_pidfile_for_next_sweep() {
    let Some(fx) = fixture() else {
        eprintln!("[skip] 未找到系统 node / mock 脚本，跳过失败清理验证");
        return;
    };

    let env = fx.env_with(&[("DSH_MOCK_FAIL", "no-url")]);
    let launcher = fx.launcher(Duration::from_secs(2));
    let error = match launcher.run(Some(&env), |_event| {}).await {
        Ok(_) => panic!("mock 不打印 URL 时 run() 不应返回 Ok"),
        Err(error) => error,
    };
    assert_eq!(error.to_failure_cause().kind(), "startup_timeout");

    // 每次 spawn 都会写 pidfile；失败返回后记录仍在，供下一次 start 清扫。
    let stale = dsh_host::process::read_pid_file(&fx.layout)
        .expect("失败路径应留下 pidfile 记录（下一次 start 会清扫）");
    assert!(stale.pid > 0, "pidfile 应记录本次尝试的 pid");
}

/// 平台级退出：显式 terminate 后 exit watcher 观察到子进程结束。
#[tokio::test]
async fn terminate_reaps_process_tree() {
    let Some(fx) = fixture() else {
        eprintln!("[skip] 未找到系统 node / mock 脚本，跳过 terminate 验证");
        return;
    };

    let env = fx.env();
    let launcher = fx.launcher(Duration::from_secs(20));
    let mut running = launcher
        .run(Some(&env), |_event| {})
        .await
        .expect("mock 应能就绪");
    assert!(is_process_alive(running.pid), "就绪后 mock 进程应存活");

    running.terminate();
    let exit = running
        .wait_exit()
        .await
        .expect("terminate 后应能等到退出")
        .expect("exit watcher 不应返回 IO 错误");
    assert!(
        exit.code().is_some() || !exit.success(),
        "terminate 后子进程应已结束：{exit:?}"
    );
}
