//! V1 —— 生命周期竞态窗口的故障注入测试（core 层）。
//!
//! 对应 `docs/dev-plan-external-assessment-response.md` §3 V1 的六窗口矩阵。
//! 本文件负责 **core 层**（`crates/dsh-host`，本机可跑）；壳层两窗（V1-2 / V1-3）
//! 与 V1-6 的「页面路径」由 `src-tauri/src/state.rs` 的纯函数断言承担，
//! 只在 CI（MSVC）执行——GNU 工具链下 `dsh-desktop` 测试二进制无法加载
//! （`docs/incidents/local-toolchain-limits.md`）。
//!
//! ## 窗口 × 断言覆盖矩阵
//!
//! | 窗口 | 场景 | 本文件用例 | 断言对象 |
//! |---|---|---|---|
//! | V1-1 | 退避等待期间 `stop()` | [`stop_during_backoff_prevents_the_pending_restart`] | 停止后**不得**再有 `Spawned`；终态 `Stopped`；`is_running()` 为假；`stop()` 时延 < 上界（这条专门证伪 `abort()`） |
//! | V1-2 | 关窗/退出与自动重启同时发生 | —（壳层，见 `state.rs` `bridge_state_generation_*` + `stale_generation_*`） | 代号失配 ⇒ 桥丢弃迟到状态，且壳层内部状态一字未动 |
//! | V1-3 | 崩溃后端口变化，前端仍访问旧端口 | —（壳层，见 `state.rs` `ready_write_*`） | 新端点/新 token/新 URL 覆盖旧值（断言打在 `SupervisorInner` 真实字段上） |
//! | V1-4 | 两个监管周期同时控制同一服务 | [`concurrent_start_does_not_spawn_a_second_cycle`]、[`start_after_terminal_failure_runs_a_fresh_cycle`] | 并发 `start()` 不叠加循环；终态后**可以**重启 |
//! | V1-5 | 子进程退出但输出管道未结束 | [`child_exit_is_detected_despite_the_log_pipe`] | Ready 后退出**必须**被观测到（不得挂住） |
//! | V1-6 | 启动成功但服务未真正就绪 | [`never_ready_ends_in_failed_instead_of_endless_wait`] | 不就绪 ⇒ `Failed` 终态，且耗时有界 |
//!
//! 矩阵本身可证伪：删掉任一用例，对应窗口即从「已钉住」退回「未覆盖」——
//! 这一点由 `scripts/verify-plan-facts.mjs` 之外的**人工复核**保证（本表与
//! 文件名一一对应，改名/删用例必须同步改表）。
//!
//! ## 守卫 × 可证伪性（哪些「双保险」是真能独立测出来的）
//!
//! V1-1 的实现用两条机制阻止「退避结束后悄悄重启」：`stop()` 里的
//! `handle.abort()` 与协程循环头的 `while !is_stopping`。审阅发现**只有前者
//! 有独立信号**，后者被 `abort()` 完全遮蔽：
//!
//! | 拆掉的守卫 | 会红的断言 | 不会红的断言 |
//! |---|---|---|
//! | `handle.abort()` | `stop()` 时延上界 | `spawned`（`while` 兜住了） |
//! | `while !is_stopping` | 无 | 全部 |
//! | 两者同拆 | `spawned` 计数 | — |
//!
//! 因此本文件**不为 `while` 的「有效性」背书**，只在文档里登记它是纵深防御
//! （`abort()` 失效或 `supervision_task` 句柄已丢时，循环仍能自行收敛）。
//! 想让它可独立证伪，需要暴露一个测试专用钩子——属生产代码改动，另案决策。
//!
//! ## 为什么这些断言值得写（不是「测试覆盖率凑数」）
//!
//! 四个窗口的共同点是：**坏掉时编译完全正常，且只有竞态窗口里才看得出来**。
//! 例如 V1-1 的退避期 `stop()`——若停止信号在退避 sleep 之后被忽略，用户点了
//! 「停止」却在一个退避周期后看见 Harness 又起来了；V1-5 的管道未收尾——若
//! 退出侦测依赖 stdout 关闭，子进程已死而宿主永远等下去，界面卡在「启动中」。
//!
//! ## 前置条件与跳过口径
//!
//! 需要系统 `node` 与 `scripts/mock-harness.mjs`；缺任一则整组跳过并把原因
//! 打到 stderr（与 `mock_launch.rs` 同一口径：不让缺依赖伪装成通过）。

// 共享 fixture 提供 `env_with` / `env` / `launcher`，本文件只用 `layout` / `config()`。
#![allow(dead_code)]

mod fixture;

use std::time::{Duration, Instant};

use dsh_host::supervisor::{Supervisor, SupervisorConfig, SupervisorState};

use fixture::fixture;

/// 单场景墙钟预算。只防「夹具死锁」，**不参与任何判据**——判据全部是
/// 「观测到 / 未观测到某状态」，与机器快慢无关。
const SCENARIO_BUDGET: Duration = Duration::from_secs(30);

/// 一次观测的记账。刻意不用 `Vec<SupervisorState>`：`SupervisorState` 含
/// `DiagnosticReport`，不比大小也无 `PartialEq`，且断言关心的只是「发生过几次」。
#[derive(Default, Debug)]
struct Observed {
    /// `LaunchEvent::Spawned` 的次数（= 真正派生了几个子进程）。
    spawned: usize,
    /// `Starting` 次数（= 监管循环尝试了几轮）。
    attempts: usize,
    /// `Crashed` 次数。
    crashed: usize,
    /// 是否见到 `Running`。
    running: bool,
    /// 是否见到 `Failed`。
    failed: bool,
    /// 是否见到 `Stopped`。
    stopped: bool,
}

/// 把广播通道里**当前已到达**的事件全部吃掉并记账（非阻塞）。
///
/// `Lagged` 刻意吞掉而不是 panic：core 的通道容量由契约常量给出，慢消费丢事件
/// 属设计内行为；本文件的判据都写成「不得出现 X」与「最终见到 Y」，
/// 丢中间事件不会把结论反转成假绿（`stopped` / `spawned` 都由终态或计数兜住）。
fn drain(rx: &mut tokio::sync::broadcast::Receiver<SupervisorState>, into: &mut Observed) {
    loop {
        match rx.try_recv() {
            Ok(SupervisorState::LaunchProgress(dsh_host::launch::LaunchEvent::Spawned {
                ..
            })) => into.spawned += 1,
            Ok(SupervisorState::Starting { .. }) => into.attempts += 1,
            Ok(SupervisorState::Running { .. }) => into.running = true,
            Ok(SupervisorState::Crashed { .. }) => into.crashed += 1,
            Ok(SupervisorState::Failed { .. }) => into.failed = true,
            Ok(SupervisorState::Stopped) => into.stopped = true,
            Ok(_) => {}
            Err(tokio::sync::broadcast::error::TryRecvError::Empty) => return,
            Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_)) => continue,
            // 通道关闭 = 监管协程已退出（sender 全数 drop）。此时事件流结束。
            Err(tokio::sync::broadcast::error::TryRecvError::Closed) => return,
        }
    }
}

/// 轮询直到 `pred` 对累计观测成立，或预算耗尽；返回最终观测。
async fn poll_until(
    rx: &mut tokio::sync::broadcast::Receiver<SupervisorState>,
    budget: Duration,
    pred: impl FnMut(&Observed) -> bool,
) -> Observed {
    poll_until_with(rx, budget, Observed::default(), pred).await
}

/// 同 [`poll_until`]，但**接着已有记账继续**（不重置计数）。
///
/// 多段观测必须用这个版本：`Observed` 是累计量，若第二段从零开始，
/// 「已经发生过的事件」（上一段吃掉的 `Failed` / `Spawned`）就再也看不见了。
/// 初版本在 V1-4 的「终态后重启」用例上踩过——第二段永远等不到早就发生过的
/// `Stopped`。
async fn poll_until_with(
    rx: &mut tokio::sync::broadcast::Receiver<SupervisorState>,
    budget: Duration,
    mut seed: Observed,
    mut pred: impl FnMut(&Observed) -> bool,
) -> Observed {
    let deadline = Instant::now() + budget;
    loop {
        drain(rx, &mut seed);
        if pred(&seed) || Instant::now() >= deadline {
            return seed;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// 观测窗口内把事件流吃干净（用于「停止之后不该再有任何 spawn」这类否定断言）。
async fn settle(
    rx: &mut tokio::sync::broadcast::Receiver<SupervisorState>,
    into: &mut Observed,
    window: Duration,
) {
    let deadline = Instant::now() + window;
    while Instant::now() < deadline {
        drain(rx, into);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    drain(rx, into);
}

// ---------------------------------------------------------------------------
// V1-1 — 退避等待期间 stop
// ---------------------------------------------------------------------------

/// **退避等待期间 `stop()` 必须取消待执行的重启。**
///
/// 场景：`DSH_MOCK_FAIL=startup` 让每次启动立刻失败 ⇒ 监管协程上报
/// `Crashed { will_restart: true }` 然后进入 `sleep(initial_backoff)`。
/// 在**退避 sleep 期间**调用 `stop()`。
///
/// 判据（四条，全部是否定式 / 上界式，不依赖机器快慢）：
/// 1. 停止后**不得**再出现 `Spawned`——退避期结束后悄悄重启 = 用户点了停止却看见
///    服务又起来，这是本窗口唯一真实的产品后果；
/// 2. 必须观测到 `Stopped`（终态到位，不是悬空）；
/// 3. `is_running()` 为假（活跃实例已释放）；
/// 4. `stop()` 必须在 [`STOP_UPPER_BOUND`] 内返回——**这一条专门证伪 `abort()`**。
///
/// ## 两条守卫各自的可证伪性（审计结论，2026-10-12）
///
/// `stop()` 里有两条独立机制都能阻止退避结束后的重启：
/// `handle.abort()`（`stop()` 内）与循环头的 `while !is_stopping`（协程内）。
/// 它们的**作用不同**，因此信号也不同：
///
/// | 拆掉的守卫 | 哪个断言会红 | 为什么 |
/// |---|---|---|
/// | `handle.abort()` | **判据 4**（`stop()` 变慢） | 没有取消 ⇒ `stop()` 只能等 `sleep` 自然醒来，再靠 `while` 退出，耗时 ≈ 剩余退避（≈10s） |
/// | `while !is_stopping` | **无** | `abort()` 已经把协程在 `sleep` 处取消，永远走不到第二次 spawn |
/// | 两条同拆 | 判据 1（`spawned` 变 2） | 协程活到退避结束并重新 spawn |
///
/// 结论要如实说：**`while !is_stopping` 在当前实现下不是可独立证伪的守卫**，
/// 它的价值是纵深防御——`abort()` 失效、或 `supervision_task` 句柄已丢失（此时
/// `stop()` 根本拿不到 `handle` 去 abort）时，循环仍能在下一个检查点自行收敛。
/// 本用例不把它当作「已验证有效」的证据。
///
/// 判据 4 能成立的前提是 `BACKOFF` 远大于 `STOP_UPPER_BOUND`（10s vs 2s，
/// 差 5 倍），CI 抖动吃不掉这个差距；`stop()` 取上界而不是精确值，是为了
/// 不把「调度偶发延迟」变成假红。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stop_during_backoff_prevents_the_pending_restart() {
    let Some(fx) = fixture() else {
        eprintln!("[skip] 未找到系统 node / mock 脚本，跳过 V1-1 退避期 stop");
        return;
    };

    // 退避取 10s：既要够长，保证 `Crashed` 上报与 `stop()` 之间稳定落在 sleep 里
    // （取 10ms 时 `stop()` 很可能在 sleep 之后才到达，测到的是另一条路径）；
    // 又要够长，让「没有 abort」这件事表现为**秒级**的 `stop()` 阻塞。
    const BACKOFF: Duration = Duration::from_secs(10);

    // `stop()` 的返回上界。只用于区分「abort 生效（毫秒级）」与
    // 「等退避自然醒来（≈10s）」，两者差 5 倍以上，与机器快慢无关。
    const STOP_UPPER_BOUND: Duration = Duration::from_secs(2);

    // 停止之后继续观测的窗口：只为捕捉「`stop()` 返回后仍有迟到的 spawn」。
    // 不需要覆盖整个退避——真发生了未取消的重启，判据 4 已经先红。
    const SETTLE: Duration = Duration::from_secs(3);

    let config = SupervisorConfig {
        launcher_config: fx.config(Duration::from_secs(8)),
        max_restarts: 3,
        initial_backoff: BACKOFF,
        max_backoff: BACKOFF,
        backoff_multiplier: 2.0,
        stable_uptime: Duration::from_secs(1),
        host: None,
        profile: None,
        env: None,
        extra_args: vec!["--fail".into(), "startup".into()],
        extra_envs: vec![("DSH_MOCK_FAIL".into(), "startup".into())],
    };

    let supervisor = Supervisor::new(fx.layout.clone(), config);
    let mut rx = supervisor.subscribe();
    supervisor.start().await;

    // 等第一次崩溃上报：那一刻协程刚进入 sleep(BACKOFF)。
    let first = poll_until(&mut rx, SCENARIO_BUDGET, |o| o.crashed >= 1).await;
    assert!(
        first.crashed >= 1,
        "未观测到首次 Crashed（场景未进入退避窗口，本用例没有测到目标竞态）：{first:?}"
    );
    assert_eq!(
        first.spawned, 1,
        "退避开始前应恰好派生 1 个子进程：{first:?}"
    );

    // ← 关键动作：在退避 sleep **期间**停止。
    let stopped_at = Instant::now();
    supervisor.stop().await;
    let stop_elapsed = stopped_at.elapsed();

    let mut after = Observed {
        spawned: first.spawned,
        attempts: first.attempts,
        crashed: first.crashed,
        running: first.running,
        failed: first.failed,
        stopped: first.stopped,
    };
    settle(&mut rx, &mut after, SETTLE).await;

    assert_eq!(
        after.spawned, 1,
        "退避期 stop() 之后又派生了子进程（spawned={}，期望 1）——\
         待执行的重启没有被取消，用户会看见「点了停止又自己起来」。\
         stop() 耗时 {stop_elapsed:?}，累计观测 {after:?}",
        after.spawned
    );
    assert!(
        after.stopped,
        "stop() 之后必须到达终态 Stopped，实际未观测到：{after:?}"
    );
    assert!(
        !supervisor.is_running().await,
        "stop() 之后不得仍有活跃实例：{after:?}"
    );
    // 判据 4：`abort()` 的独立信号。
    // 若 `handle.abort()` 被移除，协程只能等 `sleep(BACKOFF)` 自然醒来才读到
    // `is_stopping` 并退出，`stop()` 会阻塞约一个完整退避（≈10s）。
    assert!(
        stop_elapsed < STOP_UPPER_BOUND,
        "stop() 在退避期耗时 {stop_elapsed:?}，超过上界 {STOP_UPPER_BOUND:?}\
         （退避为 {BACKOFF:?}）——说明监管协程没有被 abort，\
         `stop()` 只能等退避 sleep 自然结束。用户点「停止」会卡住数秒，\
         这期间界面停在「Stopping…」。"
    );
}

// ---------------------------------------------------------------------------
// V1-4 — 两个监管周期同时控制同一服务
// ---------------------------------------------------------------------------

/// **并发 `start()` 不得派生第二个监管循环。**
///
/// 场景：`startup` 失败 + `max_restarts=2` ⇒ 正常路径恰好派生
/// `max_restarts + 1 = 3` 个子进程（1 次首启 + 2 次重启）。
/// 在第一次 `start()` 之后**立刻**再 `start()` 一次（此时协程仍在运行）。
///
/// 判据：总 `Spawned` 恰好为 3。若 `start()` 是叠加的（第二条循环也跑起来），
/// 计数会翻倍成 6 —— 那正是「两个周期同时控制同一服务」的产品后果。
///
/// 该用例同时钉住 `supervisor.rs` 模块文档声明的**互斥**语义（不是幂等，
/// 也不是叠加）。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_start_does_not_spawn_a_second_cycle() {
    let Some(fx) = fixture() else {
        eprintln!("[skip] 未找到系统 node / mock 脚本，跳过 V1-4 并发 start");
        return;
    };

    const MAX_RESTARTS: usize = 2;
    // 退避压到 10ms：本用例关心的是**循环条数**，不是退避时长。
    const FAST: Duration = Duration::from_millis(10);

    let config = SupervisorConfig {
        launcher_config: fx.config(Duration::from_secs(8)),
        max_restarts: MAX_RESTARTS,
        initial_backoff: FAST,
        max_backoff: FAST,
        backoff_multiplier: 2.0,
        stable_uptime: Duration::from_secs(1),
        host: None,
        profile: None,
        env: None,
        extra_args: vec!["--fail".into(), "startup".into()],
        extra_envs: vec![("DSH_MOCK_FAIL".into(), "startup".into())],
    };

    let supervisor = Supervisor::new(fx.layout.clone(), config);
    let mut rx = supervisor.subscribe();

    // 连发三次 start()：第一次派生循环，后两次必须被互斥挡掉。
    supervisor.start().await;
    supervisor.start().await;
    supervisor.start().await;

    // 等到断路器开路（Failed）：此后循环已 break，计数不再增长。
    let observed = poll_until(&mut rx, SCENARIO_BUDGET, |o| o.failed).await;
    // 再吃一小段，捕捉「终态之后仍在偷偷派生」的情况。
    let mut observed = observed;
    settle(&mut rx, &mut observed, Duration::from_millis(500)).await;

    assert!(
        observed.failed,
        "三次并发 start() 之后应正常走到 Failed（断路器开路），实际：{observed:?}"
    );
    assert_eq!(
        observed.spawned,
        MAX_RESTARTS + 1,
        "并发 start() 派生了 {} 个子进程，期望 {}（= max_restarts + 1）——\
         多出来的那部分说明存在第二个监管循环（{observed:?}）",
        observed.spawned,
        MAX_RESTARTS + 1
    );
    assert_eq!(
        observed.attempts,
        MAX_RESTARTS + 1,
        "Starting 上报次数应与派生次数一致（{observed:?}）"
    );
}

/// **终态 `Failed` 之后 `start()` 必须能真的开一轮新循环。**
///
/// 这条与上一条是一对：互斥若写成「句柄为 `Some` 就永远返回」，错误页的
/// 「重试」会永久卡死——那比叠加更糟（用户看得见的重试按钮变成死按钮）。
///
/// 判据：`Failed` 之后再 `start()`，`Spawned` 计数必须继续增长。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn start_after_terminal_failure_runs_a_fresh_cycle() {
    let Some(fx) = fixture() else {
        eprintln!("[skip] 未找到系统 node / mock 脚本，跳过 V1-4 终态后重启");
        return;
    };

    const FAST: Duration = Duration::from_millis(10);

    let config = SupervisorConfig {
        launcher_config: fx.config(Duration::from_secs(8)),
        // 不自动重启：第一次失败即终态，把「重新 start」的语义独立出来。
        max_restarts: 0,
        initial_backoff: FAST,
        max_backoff: FAST,
        backoff_multiplier: 2.0,
        stable_uptime: Duration::from_secs(1),
        host: None,
        profile: None,
        env: None,
        extra_args: vec!["--fail".into(), "startup".into()],
        extra_envs: vec![("DSH_MOCK_FAIL".into(), "startup".into())],
    };

    let supervisor = Supervisor::new(fx.layout.clone(), config);
    let mut rx = supervisor.subscribe();
    supervisor.start().await;

    let observed = poll_until(&mut rx, SCENARIO_BUDGET, |o| o.failed).await;
    assert!(
        observed.failed,
        "max_restarts=0 时首次失败必须直接进 Failed：{observed:?}"
    );
    let spawned_before = observed.spawned;
    assert_eq!(spawned_before, 1, "终态前应恰好派生 1 次：{observed:?}");

    // ⚠️ 必须等**协程真的结束**（它自己发出的 `Stopped`）再重试。
    //
    // `Failed` 是在 `break` **之前**发出的（`supervisor.rs` 的 Failed 分支），
    // 因此「看到 Failed」不等于「句柄已 finished」。此时立刻 `start()` 会被互斥
    // 判定挡掉（`handle.is_finished() == false`）——这是**互斥语义的正确表现**，
    // 不是缺陷：真实调用方（错误页的「重试」）要经过一轮用户交互，早已越过这个
    // 毫秒级间隙。初版本用例就踩了这个竞态（断言红在测试自身，而非产品）。
    let observed = poll_until_with(&mut rx, SCENARIO_BUDGET, observed, |o| o.stopped).await;
    assert!(
        observed.stopped,
        "协程在 Failed 之后应自行发出 Stopped 并结束，实际未观测到：{observed:?}"
    );

    // 终态之后重启：必须真的开新循环。
    supervisor.start().await;
    let mut observed = poll_until_with(&mut rx, SCENARIO_BUDGET, observed, |o| {
        o.spawned > spawned_before
    })
    .await;
    settle(&mut rx, &mut observed, Duration::from_millis(300)).await;
    supervisor.stop().await;

    assert!(
        observed.spawned > spawned_before,
        "终态 Failed 之后 start() 没有派生新子进程（spawned 仍为 {spawned_before}）——\
         互斥写成了「永久拒绝」，错误页的重试会变成死按钮：{observed:?}"
    );
}

// ---------------------------------------------------------------------------
// V1-5 — 子进程退出但输出管道未正确结束
// ---------------------------------------------------------------------------

/// **子进程在 Ready 之后退出时，退出侦测不得被日志管道挂住。**
///
/// 场景：`DSH_MOCK_FAIL=after-ready` + `DSH_MOCK_AFTER_READY_MS=200`，
/// `max_restarts=0` ⇒ Ready 之后 200ms 子进程自己 `exit(7)`。
///
/// 为什么要单独立一条：宿主的日志泵握着子进程 stdout/stderr 的读端。若「子进程
/// 已退出」的判定被写成「等管道读到 EOF」，那么**任何未关闭继承句柄的子进程**
/// 都会让宿主永远等下去——界面卡在「启动中」，而进程早已死掉。这条路径在
/// `Ready` → `Failed` 的转换上唯一可观测。
///
/// 判据：
/// 1. 先观测到 `Running`（证明确实就绪过，否则测的是启动失败路径）；
/// 2. 就绪后**必须**在预算内观测到 `Failed`（退出侦测生效，未挂住）；
/// 3. 终态后 `is_running()` 为假（活跃实例已释放，收尾任务跑完了）。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn child_exit_is_detected_despite_the_log_pipe() {
    let Some(fx) = fixture() else {
        eprintln!("[skip] 未找到系统 node / mock 脚本，跳过 V1-5 退出侦测");
        return;
    };

    let config = SupervisorConfig {
        // 就绪探测给足 15s：本用例测的是**退出**，不是超时。
        launcher_config: fx.config(Duration::from_secs(15)),
        max_restarts: 0,
        initial_backoff: Duration::from_millis(10),
        max_backoff: Duration::from_millis(10),
        backoff_multiplier: 2.0,
        stable_uptime: Duration::from_secs(1),
        host: None,
        profile: None,
        env: None,
        extra_args: vec!["--fail".into(), "after-ready".into()],
        extra_envs: vec![
            ("DSH_MOCK_FAIL".into(), "after-ready".into()),
            ("DSH_MOCK_AFTER_READY_MS".into(), "200".into()),
        ],
    };

    let supervisor = Supervisor::new(fx.layout.clone(), config);
    let mut rx = supervisor.subscribe();
    supervisor.start().await;

    let observed = poll_until(&mut rx, SCENARIO_BUDGET, |o| o.failed).await;
    supervisor.stop().await;

    assert!(
        observed.running,
        "必须先观测到 Running（就绪成功）才谈得上「就绪后退出」，实际：{observed:?}"
    );
    assert!(
        observed.failed,
        "子进程在 Ready 之后 exit(7)，但 {}s 内未观测到 Failed——\
         退出侦测很可能被日志管道读端挂住了（宿主永远等 EOF）：{observed:?}",
        SCENARIO_BUDGET.as_secs()
    );
    assert!(
        !supervisor.is_running().await,
        "终态之后不应仍有活跃实例（收尾未完成）：{observed:?}"
    );
}

// ---------------------------------------------------------------------------
// V1-6 — 进程启动成功但服务未真正就绪
// ---------------------------------------------------------------------------

/// **不就绪必须收敛到 `Failed` 终态，而不是无限等待。**
///
/// 场景：`DSH_MOCK_FAIL=no-url` —— mock 会 spawn、打印诊断，然后**挂住不打印
/// 就绪 URL**（`scripts/mock-harness.mjs` 的 `no-url` 分支 `setInterval` 保活）。
/// 就绪总超时压到 2s，`max_restarts=0`。
///
/// 与 `mock_launch.rs::no_url_times_out_with_startup_timeout` 的分工：那条钉的是
/// **启动器**层面的退出码与归因（`EXIT_READY_TIMEOUT` / `startup_timeout`）；
/// 本条钉的是**监管器**层面——同样的场景经 Supervisor 之后必须同样收敛，
/// 不能因为进了重启循环就变成「一直重试、永不进错误页」。
///
/// 判据：
/// 1. 必须观测到 `Failed`；
/// 2. 从 `start()` 到 `Failed` 的墙钟**有界**（< 3 × 就绪超时 + 余量）——
///    这一条是「不是无限等待」的直接证据；
/// 3. 不得出现 `Crashed { will_restart: true }`（`max_restarts=0` 时没有任何
///    重启额度，上报可重启就等于承诺了不会发生的重启）。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn never_ready_ends_in_failed_instead_of_endless_wait() {
    let Some(fx) = fixture() else {
        eprintln!("[skip] 未找到系统 node / mock 脚本，跳过 V1-6 不就绪收敛");
        return;
    };

    const READY_TIMEOUT: Duration = Duration::from_secs(2);

    let config = SupervisorConfig {
        launcher_config: fx.config(READY_TIMEOUT),
        max_restarts: 0,
        initial_backoff: Duration::from_millis(10),
        max_backoff: Duration::from_millis(10),
        backoff_multiplier: 2.0,
        stable_uptime: Duration::from_secs(1),
        host: None,
        profile: None,
        env: None,
        extra_args: Vec::new(),
        // no-url：spawn 成功、打印诊断、永不打印就绪 URL。
        extra_envs: vec![("DSH_MOCK_FAIL".into(), "no-url".into())],
    };

    let supervisor = Supervisor::new(fx.layout.clone(), config);
    let mut rx = supervisor.subscribe();

    let started = Instant::now();
    supervisor.start().await;
    let observed = poll_until(&mut rx, SCENARIO_BUDGET, |o| o.failed).await;
    let elapsed = started.elapsed();
    supervisor.stop().await;

    assert!(
        observed.failed,
        "不就绪的进程在 {}s 内没有收敛到 Failed——界面会永远停在「启动中」：{observed:?}",
        SCENARIO_BUDGET.as_secs()
    );
    assert_eq!(
        observed.crashed, 0,
        "max_restarts=0 时不得上报可重启的 Crashed（那是在承诺不会发生的重启）：{observed:?}"
    );
    // 有界性：就绪超时 2s + 派生/探测开销。取 3 倍 + 10s 余量，宁宽不假红。
    let bound = READY_TIMEOUT * 3 + Duration::from_secs(10);
    assert!(
        elapsed < bound,
        "收敛耗时 {elapsed:?} 超过上界 {bound:?}（就绪超时 {READY_TIMEOUT:?}）——\
         说明超时链路没有在超时后立刻收敛"
    );
}
