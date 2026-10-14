//! `recover` 子命令：崩溃自愈演示（S6-2 / 治 D12）。
//!
//! ## 它是什么
//!
//! **一条命令完成三段流程**——启动 → 注入崩溃 → 指数退避重启——并如实报告
//! 观测到的退避序列与断路器是否开路。全程无 GUI、无窗口系统（INV-6）。
//!
//! ## 为什么它存在（不只是"演示"）
//!
//! `dsh_host::Supervisor`此前**全仓没有任何运行时调用方**：
//! `dsh-host-cli` 直接走 `Launcher` 一次性启动，`src-tauri` 用的是另一个类型
//! `HarnessSupervisor`（`src-tauri/src/state.rs:122`），只做一次性启动、
//! 没有退避与断路器。因此「崩溃自愈 + 指数退避 + 断路器」这套能力
//! 在 `AGENTS.md` §7.2 里被记为「已接线」是**不成立的**，已于 2026-10-11 订正为
//! 「⚠️ 未接线」并登记在 `scripts/verify-claims.mjs` 的 `UNWIRED_ALLOW`。
//!
//! 本命令是该模块**第一个真实的运行时消费者**——它让上面那条宣称可以重新
//! 成立，也是 S6-2 判据「一条命令完成三段流程」的载体。
//!
//! ## 判据与可证伪性
//!
//! 成功条件是**观测到真实的退避增长**，而不是「没报错」：
//! 退出码 `EXIT_OK` 只在「至少观测到两次 `Crashed` 且后一次 `next_backoff`
//! 严格大于前一次」时给出。若 Supervisor 的退避被绕过（恒返回初值），
//! 本命令会打印观测到的序列并返回失败——判据可被注入缺陷证伪。
//!
//! ## 故障模式只暴露「启动即失败」两种（`--fail`）
//!
//! `startup` / `no-url` 都走 `LaunchOutcome::Failed` 分支，该分支
//! **不经过**稳定窗口重置，因此退避可被如实观测。⚠️ 刻意**不**暴露
//! `after-ready`：它走 `Ready` 分支，每次崩溃都会因超过
//! `SUPERVISOR_STABLE_UPTIME` 被重置计数与退避，观测到的将永远是初值。

use std::time::{Duration, Instant};

use dsh_host::contracts::{EXIT_OK, EXIT_UNEXPECTED};
use dsh_host::launch::{LauncherConfig, PortMode};
use dsh_host::paths::Layout;
use dsh_host::supervisor::{Supervisor, SupervisorConfig, SupervisorState};
use dsh_host::ProbeConfig;

use crate::cli::RecoverArgs;
use crate::commands::{apply_mock_if_requested, ExitCode};

/// 退避上限：给演示留足时间，同时让「增长」在几秒内可见。
const DEMO_MAX_BACKOFF: Duration = Duration::from_millis(400);

/// 执行 `recover`：跑一轮崩溃自愈演示并返回进程退出码。
///
/// # 参数
///
/// | 参数 | 说明 |
/// |------|------|
/// | `args.resource` | 只读资源目录（需含入口脚本与 node） |
/// | `args.data` | 可写数据目录（pidfile / 日志落在此） |
/// | `args.fail` | 崩溃注入模式，默认 `startup` |
/// | `args.observe_secs` | 观察窗口秒数，默认 60 |
/// | `json` | 为 `true` 时输出单个 JSON 对象（供脚本消费） |
///
/// # 返回
///
/// `EXIT_OK`（0）—— 观测到真实的退避增长；
/// `EXIT_UNEXPECTED`（1）—— 观察窗口内未观测到退避增长（含未观测到崩溃）。
pub async fn run(args: RecoverArgs, json: bool) -> ExitCode {
    let mut layout = Layout::resolve(&args.resource, &args.data);

    // 演示必须用 mock：真实 Harness 不会「按需崩溃」。`--mock` 缺失时
    // 直接失败并说清原因，而不是悄悄跑一次不崩溃的空演示。
    if !args.mock {
        if json {
            println!(
                "{}",
                serde_json::json!({
                    "outcome": "recover",
                    "ok": false,
                    "reason": "mock_required",
                    "hint": "recover 需要 --mock（真实 Harness 无法按需崩溃注入）",
                })
            );
        } else {
            eprintln!(
                "[cli] recover 需要 --mock：真实 Harness 无法按需注入崩溃。\
                 试：dsh-host-cli recover --resource <res> --data <data> --mock"
            );
        }
        return EXIT_UNEXPECTED;
    }
    apply_mock_if_requested(&mut layout, true);

    let fail = args.fail.as_mock_value();
    let launcher_config = LauncherConfig {
        probe: ProbeConfig::fast(Duration::from_secs(args.timeout.unwrap_or(30).max(1))),
        port_mode: if args.port.is_some() {
            PortMode::Fixed(args.port.unwrap_or(0))
        } else {
            PortMode::Reserved
        },
        ..LauncherConfig::default()
    };

    let config = SupervisorConfig {
        launcher_config,
        max_restarts: 3,
        initial_backoff: Duration::from_millis(100),
        max_backoff: DEMO_MAX_BACKOFF,
        backoff_multiplier: 2.0,
        // 稳定窗口取一个**大于观察窗**的值：让 `uptime >= stable_uptime`
        // 永不成立，从而本次演示全程不触发重置——退避序列才如实反映
        // 「连续崩溃 → 退避增长 → 断路器开路」这条路径。
        // （真实默认值是 30s；此处是演示参数，语义上等价于「崩溃得足够快」。）
        stable_uptime: Duration::from_secs(u64::MAX / 2),
        host: args.host.clone(),
        // `recover` 不做安全模式，也不需要自定义基底环境；`env: None` +
        // 非空 `extra_envs` 会让 Supervisor 捕获当前进程环境作基底，
        // 从而让下面的 `DSH_MOCK_FAIL` **真正生效**（此前 `extra_envs` 是死字段，
        // mock 的故障模式只靠 `--fail` argv 走到）。
        profile: None,
        env: None,
        extra_args: vec!["--fail".into(), fail.into()],
        extra_envs: vec![("DSH_MOCK_FAIL".into(), fail.into())],
    };

    let supervisor = Supervisor::new(layout.clone(), config);
    let mut rx = supervisor.subscribe();

    if !json {
        println!(
            "[cli] recover 演示开始：注入故障模式 = {fail}，观察窗口 {}s",
            args.observe_secs
        );
        println!("[cli] 预期：启动失败 → 退避 100ms → 200ms → 400ms（递增） → 断路器开路");
    }

    let started = Instant::now();
    supervisor.start().await;

    let deadline = started + Duration::from_secs(args.observe_secs);
    let mut backoffs: Vec<Duration> = Vec::new();
    let mut attempts = 0usize;
    let mut breaker_tripped = false;

    // 轮询到「退避已增长且断路器已开路」，或观察窗耗尽。
    // 两者必须在同一循环里等：`Supervisor::stop()` 会 abort 协程，
    // 中途 stop 之后 `Failed` 永远不会来。
    loop {
        loop {
            match rx.try_recv() {
                Ok(SupervisorState::Starting { attempt }) => {
                    attempts = attempts.max(attempt);
                    if !json {
                        println!("[cli]第 {attempt} 次尝试启动");
                    }
                }
                Ok(SupervisorState::Crashed {
                    restart_count,
                    will_restart,
                    next_backoff,
                    ..
                }) => {
                    if let Some(d) = next_backoff {
                        backoffs.push(d);
                        if !json {
                            println!(
                                "[cli] 崩溃 #{restart_count}（将重启={will_restart}）→ 退避 {}",
                                format_duration(d)
                            );
                        }
                    }
                }
                Ok(SupervisorState::Failed { total_restarts, .. }) => {
                    breaker_tripped = true;
                    if !json {
                        // 措辞要说准：`total_restarts` 是**累计崩溃次数**
                        // （含开路那一次），不是「重启了几次」。`max_restarts: N`
                        // 对应的是「崩溃 N+1 次开路」，故这里会是 N+1。
                        println!(
                            "[cli] 断路器开路：累计崩溃 {total_restarts} 次（上限 max_restarts 允许 {total_restarts} - 1 次重启），Supervisor 停止"
                        );
                    }
                    break;
                }
                Ok(_) => {}
                Err(tokio::sync::broadcast::error::TryRecvError::Empty) => break,
                Err(tokio::sync::broadcast::error::TryRecvError::Closed) => break,
                Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_)) => {}
            }
        }

        // 断路器一旦开路，监督协程即 `break`，**不会再有新的 `Crashed`**。
        // 因此此刻即可定论并退出循环——反之，若退避已观测齐备而开路迟迟不来，
        // 继续等只是空耗到观察窗结束（实测会白等满 30s）。
        if breaker_tripped {
            break;
        }
        if Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    supervisor.stop().await;
    let elapsed = started.elapsed();

    let grew = backoffs.windows(2).any(|w| w[1] > w[0]);
    let ok = grew && breaker_tripped;

    if json {
        println!(
            "{}",
            serde_json::json!({
                "outcome": "recover",
                "ok": ok,
                "backoff_grew": grew,
                "breaker_tripped": breaker_tripped,
                "observed_backoffs_ms": backoffs.iter().map(|d| d.as_millis() as u64).collect::<Vec<_>>(),
                "max_attempt": attempts,
                "elapsed_ms": elapsed.as_millis() as u64,
                "fail_mode": fail,
            })
        );
    } else {
        println!("[cli] —— 汇总 ——");
        println!(
            "[cli] 观测到 {} 次崩溃，退避序列 = {:?}",
            backoffs.len(),
            backoffs
        );
        println!(
            "[cli] 退避严格增长 = {grew}；断路器开路 = {breaker_tripped}；耗时 {:.1}s",
            elapsed.as_secs_f64()
        );
        if ok {
            println!("[cli] ✅ 自愈链路成立：崩溃 → 退避递增 → 有界重启 → 断路器开路");
        } else if backoffs.is_empty() {
            println!(
                "[cli] ❌ 观察窗内未观测到任何崩溃：故障注入可能未生效（检查 --mock 与资源目录）"
            );
        } else {
            println!("[cli] ❌ 退避未增长（观测到 {backoffs:?}）：自愈链路不可信，属缺陷");
        }
    }

    if ok {
        EXIT_OK
    } else {
        EXIT_UNEXPECTED
    }
}

/// 把 `Duration` 渲染成便于人读的短文本（ms / s）。
fn format_duration(d: Duration) -> String {
    let ms = d.as_millis();
    if ms < 1000 {
        format!("{ms}ms")
    } else {
        format!("{:.1}s", d.as_secs_f64())
    }
}
