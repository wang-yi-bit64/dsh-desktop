//! S6-3 / 治 D11 —— Supervisor 退避与断路器的**性质测试**（property-based）。
//!
//! ## 为什么需要这一层（与已有的举例式测试差在哪）
//!
//! 已有的两层测试都是**举例式**（example-based）：
//!
//!   · `supervisor.rs` 的 `mod tests`：挑几个具体参数断言（如 500ms × 2 → 1s）；
//!   · `tests/supervisor_backoff.rs`：真派生进程，观测一次退避序列 `[100,200,400]`。
//!
//! 它们能证明「这几个点对」，**证明不了「没有反例」**。而这两个函数的输入空间是
//! 连续的——`Duration`、`f64` 倍数、`usize` 上限——举例测试对它的覆盖是零测度的。
//! S6-3 要的正是补上这一层：随机采样 + **自动收缩**，失败时打印最小反例序列。
//!
//! ## 覆盖的不变式（S6-3 判据逐条对应）
//!
//! | 判据 | 测试 |
//! |------|------|
//! | 退避必须单调增长且有上限 | [`backoff_is_monotone_and_bounded`] |
//! | （退避公式本身正确） | [`backoff_follows_geometric_formula`] |
//! | 退避必须在有限步内收敛到上限 | [`backoff_converges_when_multiplier_exceeds_one`] |
//! | `mult == 1.0` 的退化分支 | [`backoff_is_constant_when_multiplier_is_unity`] |
//! | 断路器必须在有限次内开路 | [`breaker_trips_exactly_after_max_restarts`] |
//! | 重启次数有界 | [`restart_count_is_bounded`] |
//! | 无非法相位转移 | [`emitted_phase_sequence_is_legal`] |
//!
//! ## proptest 首轮就证伪了我写错的两条不变式（都是判据的问题，不是代码的问题）
//!
//! 1. 「任意 `mult` 都收敛到上限」——错。`mult == 1.0` 是**常量退避**，永不收敛。
//!    现由 [`backoff_is_constant_when_multiplier_is_unity`] 单独覆盖。
//! 2. 「128 步内必收敛」——错。那是硬编码魔数；几何序列需要
//!    `⌈ln(max/initial)/ln(mult)⌉` 步，`mult = 1.0224` 时约 130 步即越界。
//!    现改为按解析式算步数（[`backoff_converges_when_multiplier_exceeds_one`]）
//!    并以闭式比对（[`backoff_follows_geometric_formula`]）。
//!
//! 这两条正是性质测试的价值所在：**举例式测试挑不到这类边界**。
//!
//! ## 判定谓词本身也有守卫
//!
//! [`legality_predicate_rejects_illegal_sequences`] 用**手工构造的非法序列**
//! 反证 [`check_legal_sequence`] 真的会拒绝——否则「性质测试全绿」可能只是
//! 因为谓词恒真（本仓反复踩到的那一类：判据退化成永远通过）。
//!
//! ## 关于「无非法相位转移」的诚实边界 ⚠️
//!
//! [`emitted_phase_sequence_is_legal`] 跑的是一个**模型**：它用**真实的**
//! [`next_backoff`] / [`decide_restart`]，按 `Supervisor::start()` 里那段计数协议
//! 推演相位序列（源：`crates/dsh-host/src/supervisor.rs` 的重启协程）。
//! 模型与真实现之间**存在漂移的可能**——这是本测试的残余风险。
//! 缓解：真实协程的相位序列由 `tests/supervisor_backoff.rs` 端到端观测（真派生
//! `mock-harness` 进程），两者覆盖不同的失效面，不可互相替代。
//!
//! ## 参数域约束（为什么不是全空间）
//!
//! `backoff_multiplier` 限定在 `[1.0, 4.0]`：**单调性只在倍数 ≥ 1 时被承诺**
//! （契约 C10 的 `Default` 是 `2.0`）。倍数 < 1 会让退避**递减**，那是一个未设防的
//! 配置面——见 [`sub_unity_multiplier_is_unguarded_known_gap`]，那里把该边界
//! **显式登记为已知缺口**，而不是靠缩小参数域把它藏起来。

use std::time::Duration;

use dsh_host::supervisor::{decide_restart, next_backoff};
use proptest::prelude::*;

/// 推演出的单步记录（镜像 `Supervisor::start()` 的一次循环）。
#[derive(Debug, Clone, PartialEq, Eq)]
struct Step {
    /// `SupervisorState::Starting { attempt }` 的 attempt。
    attempt: usize,
    /// `SupervisorState::Crashed { next_backoff }`；开路那次为 `None`。
    backoff: Option<Duration>,
    /// `Crashed { will_restart }`。
    will_restart: bool,
    /// 是否落到 `SupervisorState::Failed`（断路器开路）。
    failed: bool,
}

/// 按 `Supervisor::start()` 的计数协议推演一串相位序列。
///
/// 与真实协程的对应关系：
///   · `attempt = restart_count + 1`（在每轮循环开头 `send(Starting { attempt })`）
///   · 启动失败（`LaunchOutcome::Failed`）必然发生 —— 这里模拟「持续崩溃」
///   · `restart_count += 1` 后 `will_restart = decide_restart(...)`
///   · `will_restart == false` ⇒ `send(Failed)` 并 `break`
///
/// 刻意**不**接入 `stable_uptime` 重置：该分支只在 `LaunchOutcome::Ready` 路径上，
/// 而「持续崩溃」走的是 `Failed` 路径（见 `docs/recover-demo.md` §5 的说明）。
fn simulate(max_restarts: usize, initial: Duration, mult: f64, max_backoff: Duration) -> Vec<Step> {
    let mut steps = Vec::new();
    let mut restart_count = 0usize;
    let mut current = initial;

    // 上限 +2 是「不可能到达」的哨兵：真断路器会在 max_restarts + 1 步内停下。
    // 若代码退化成无限重启，本循环会撞上它，而下面的合法性断言会报红。
    for _ in 0..(max_restarts + 2) {
        let attempt = restart_count + 1;
        restart_count += 1;

        if decide_restart(restart_count, max_restarts) {
            steps.push(Step {
                attempt,
                backoff: Some(current),
                will_restart: true,
                failed: false,
            });
            current = next_backoff(current, mult, max_backoff);
        } else {
            steps.push(Step {
                attempt,
                backoff: None,
                will_restart: false,
                failed: true,
            });
            return steps;
        }
    }
    steps
}

/// 合法性谓词：相位序列必须满足的全部不变式。
///
/// 返回 `Ok(())` 或首个违规原因。**这个谓词本身由
/// [`legality_predicate_rejects_illegal_sequences`] 守卫**。
fn check_legal_sequence(
    steps: &[Step],
    max_restarts: usize,
    max_backoff: Duration,
) -> Result<(), String> {
    if steps.is_empty() {
        return Err("序列为空".to_string());
    }

    // L1：attempt 从 1 开始、逐次 +1（不得跳号或回退 ⇒ 无非法相位转移）。
    for (i, step) in steps.iter().enumerate() {
        let expected = i + 1;
        if step.attempt != expected {
            return Err(format!(
                "第 {i} 步 attempt={} 应为 {expected}（相位转移非法：跳号或回退）",
                step.attempt
            ));
        }
    }

    // L2：attempt 不得越过 max_restarts + 1。
    if steps.len() > max_restarts + 1 {
        return Err(format!(
            "序列长 {} 超过 max_restarts+1 = {}（重启次数无界）",
            steps.len(),
            max_restarts + 1
        ));
    }

    // L3：恰好一次 will_restart == false，且必为最后一步（断路器开路即终止）。
    let trip_indexes: Vec<usize> = steps
        .iter()
        .enumerate()
        .filter(|(_, s)| !s.will_restart)
        .map(|(i, _)| i)
        .collect();
    if trip_indexes.len() != 1 {
        return Err(format!(
            "will_restart=false 出现 {} 次，应恰好 1 次",
            trip_indexes.len()
        ));
    }
    if trip_indexes[0] != steps.len() - 1 {
        return Err("断路器开路之后仍有步骤（Failed 之后不得再 Starting）".to_string());
    }

    // L4：开路那一步必须带 failed 标记，且此前各步不得带。
    if !steps[trip_indexes[0]].failed {
        return Err("开路那一步未标记 failed".to_string());
    }
    if steps[..steps.len() - 1].iter().any(|s| s.failed) {
        return Err("非末步出现 failed".to_string());
    }

    // L5：重启次数恰好等于 max_restarts（不多不少）。
    let restarts = steps.iter().filter(|s| s.will_restart).count();
    if restarts != max_restarts {
        return Err(format!("实际重启 {restarts} 次，应为 {max_restarts} 次"));
    }

    // L6：退避单调不减，且不超过上限。
    let mut prev: Option<Duration> = None;
    for step in steps {
        let Some(d) = step.backoff else { continue };
        if d > max_backoff {
            return Err(format!("退避 {d:?} 超过上限 {max_backoff:?}"));
        }
        if let Some(p) = prev {
            if d < p {
                return Err(format!("退避下降：{p:?} → {d:?}"));
            }
        }
        prev = Some(d);
    }

    Ok(())
}

/// 生成「合法配置」的策略：倍数 ∈ [1.0, 4.0]，且 `max_backoff ≥ initial`。
fn config_strategy() -> impl Strategy<Value = (usize, Duration, f64, Duration)> {
    (0usize..=24, 1u64..=5_000, 1.0f64..=4.0, 1u64..=120_000).prop_map(
        |(max_restarts, initial_ms, mult, max_ms)| {
            let initial = Duration::from_millis(initial_ms);
            let max_backoff = Duration::from_millis(max_ms.max(initial_ms));
            (max_restarts, initial, mult, max_backoff)
        },
    )
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 512, ..ProptestConfig::default() })]

    /// 不变式一：退避**单调不减**且**不超过上限**。
    #[test]
    fn backoff_is_monotone_and_bounded(
        max_restarts in 0usize..=24,
        initial_ms in 1u64..=5_000,
        mult in 1.0f64..=4.0,
        max_ms in 1u64..=120_000,
    ) {
        let initial = Duration::from_millis(initial_ms);
        let max_backoff = Duration::from_millis(max_ms.max(initial_ms));
        let steps = simulate(max_restarts, initial, mult, max_backoff);

        let seq: Vec<Duration> = steps.iter().filter_map(|s| s.backoff).collect();
        for pair in seq.windows(2) {
            prop_assert!(
                pair[1] >= pair[0],
                "退避下降：{:?} → {:?}（max_restarts={}, initial={:?}, mult={}, max={:?}）",
                pair[0], pair[1], max_restarts, initial, mult, max_backoff
            );
        }
        for d in &seq {
            prop_assert!(
                *d <= max_backoff,
                "退避 {:?} 超过上限 {:?}（序列 {:?}）", d, max_backoff, seq
            );
        }
    }

    /// 不变式二：`next_backoff` 必须**精确实现几何增长**——n 次迭代后的值等于
    /// `min(max, initial × multⁿ)`。
    ///
    /// 这条比「收敛」更基本：收敛只是它在 `mult > 1` 时的推论。用闭式比对而非
    /// 硬编码步数上限——初版写成「128 步内必收敛」，被 proptest 用
    /// `mult = 1.0224` 当场证伪（几何序列需要 ⌈ln(18)/ln(1.0224)⌉ ≈ 130 步）。
    /// **魔数上限是脆弱断言，公式才是判据。**
    #[test]
    fn backoff_follows_geometric_formula(
        initial_ms in 1u64..=5_000,
        mult in 1.0f64..=4.0,
        max_ms in 1u64..=120_000,
        n in 0usize..=32,
    ) {
        let initial = Duration::from_millis(initial_ms);
        let max_backoff = Duration::from_millis(max_ms.max(initial_ms));

        let mut cur = initial;
        for _ in 0..n {
            cur = next_backoff(cur, mult, max_backoff);
        }

        let expected = Duration::from_secs_f64(
            (initial.as_secs_f64() * mult.powi(n as i32)).min(max_backoff.as_secs_f64()),
        );
        // 逐次 `from_secs_f64` 会累积纳秒级舍入；容差取 1µs 与相对 1e-6 的较大者，
        // 足以容纳舍入，又远小于公式写错时的量级偏离。
        let tol = Duration::from_secs_f64(1e-6f64).max(expected.mul_f64(1e-6));
        // 用 `abs_diff` 而不是手写 `if a > b { a - b } else { b - a }`：
        // 后者会被 clippy 判为 `manual_abs_diff`，而 CI 是 `-D warnings`——
        // 本机 GNU 工具链下 clippy 会 ICE，`cargo check` 又不跑 clippy lint，
        // 所以这个错误是本机测不出来、只能在 CI 暴露的那一类（2026-10-13 实测）。
        let diff = cur.abs_diff(expected);
        prop_assert!(
            diff <= tol,
            "几何公式不符：n={n} 次迭代得 {:?}，闭式给出 {:?}（initial={:?}, mult={}, max={:?}）",
            cur, expected, initial, mult, max_backoff
        );
    }

    /// 不变式三：`mult > 1` 时退避在**有限且可解析计算**的步数内收敛到上限。
    ///
    /// 参数域下限取 1.1（而非 1.0）：`mult → 1⁺` 时所需步数发散（数学事实，不是缺陷），
    /// 取 1.1 使上界有界（约 ⌈ln(120000)/ln(1.1)⌉ ≈ 123 步），测试因此能在秒级跑完。
    /// `mult == 1.0` 的退化行为由 [`backoff_is_constant_when_multiplier_is_unity`] 单独覆盖。
    #[test]
    fn backoff_converges_when_multiplier_exceeds_one(
        initial_ms in 1u64..=5_000,
        mult in 1.1f64..=4.0,
        max_ms in 1u64..=120_000,
    ) {
        let initial = Duration::from_millis(initial_ms);
        let max_backoff = Duration::from_millis(max_ms.max(initial_ms));
        if initial >= max_backoff {
            // 初值已在上限：无需迭代。
            prop_assert_eq!(next_backoff(initial, mult, max_backoff), max_backoff);
            return Ok(());
        }

        let ratio = max_backoff.as_secs_f64() / initial.as_secs_f64();
        let steps = (ratio.ln() / mult.ln()).ceil().max(0.0) as usize + 1;
        let mut cur = initial;
        for _ in 0..steps {
            cur = next_backoff(cur, mult, max_backoff);
        }
        prop_assert_eq!(
            cur, max_backoff,
            "{} 步（解析式给出）未收敛：initial={:?}, mult={}, max={:?}, 停在 {:?}",
            steps, initial, mult, max_backoff, cur
        );
        // 收敛后必须停住。
        prop_assert_eq!(next_backoff(cur, mult, max_backoff), max_backoff);
    }

    /// 退化分支：`mult == 1.0` ⇒ **常量退避**，只承诺有界、不承诺收敛。
    ///
    /// proptest 首轮就把这一支找了出来（当时我的不变式写的「任意 mult 都收敛」是错的）。
    /// 它不是缺陷，而是合法的退化配置；单独成测试是为了让「不收敛」这件事
    /// **有名字、有断言**，而不是被参数域悄悄排除。
    #[test]
    fn backoff_is_constant_when_multiplier_is_unity(
        initial_ms in 1u64..=5_000,
        max_ms in 1u64..=120_000,
    ) {
        let initial = Duration::from_millis(initial_ms);
        let max_backoff = Duration::from_millis(max_ms.max(initial_ms));
        let after = next_backoff(initial, 1.0, max_backoff);
        prop_assert!(after <= max_backoff, "越界：{:?} > {:?}", after, max_backoff);
        if initial < max_backoff {
            prop_assert_eq!(
                after, initial,
                "mult=1.0 应保持常量退避，实际 {:?} → {:?}", initial, after
            );
        }
    }

    /// 不变式三：断路器在**恰好** `max_restarts` 次重启后开路。
    #[test]
    fn breaker_trips_exactly_after_max_restarts(max_restarts in 0usize..=64) {
        // max=0 时首次崩溃即开路。
        prop_assert_eq!(decide_restart(1, max_restarts), max_restarts >= 1);
        // 恰好在第 max+1 次崩溃开路，之前都放行。
        for n in 1..=max_restarts {
            prop_assert!(
                decide_restart(n, max_restarts),
                "max_restarts={} 时第 {} 次崩溃不应开路", max_restarts, n
            );
        }
        prop_assert!(
            !decide_restart(max_restarts + 1, max_restarts),
            "max_restarts={} 时第 {} 次崩溃必须开路", max_restarts, max_restarts + 1
        );
    }

    /// 不变式四：任意配置下重启次数**有界**且等于 `max_restarts`。
    #[test]
    fn restart_count_is_bounded(
        (max_restarts, initial, mult, max_backoff) in config_strategy()
    ) {
        let steps = simulate(max_restarts, initial, mult, max_backoff);
        prop_assert!(
            steps.len() <= max_restarts + 1,
            "步数 {} 超过 max_restarts+1 = {}（退避/断路器失效导致无界重启）",
            steps.len(), max_restarts + 1
        );
    }

    /// 不变式五：**无非法相位转移** —— 整条相位序列必须满足 `check_legal_sequence`。
    #[test]
    fn emitted_phase_sequence_is_legal(
        (max_restarts, initial, mult, max_backoff) in config_strategy()
    ) {
        let steps = simulate(max_restarts, initial, mult, max_backoff);
        if let Err(reason) = check_legal_sequence(&steps, max_restarts, max_backoff) {
            // 把完整序列打进反例输出——这正是 S6-3 判据要的「反例序列」。
            prop_assert!(
                false,
                "相位序列非法：{}\n配置：max_restarts={}, initial={:?}, mult={}, max_backoff={:?}\n序列：{:?}",
                reason, max_restarts, initial, mult, max_backoff, steps
            );
        }
    }
}

// ---------------------------------------------------------------------------
// 判据自身的守卫
// ---------------------------------------------------------------------------

/// 反证 `check_legal_sequence` **真的会拒绝**非法序列。
///
/// 若它恒返回 `Ok`，「性质测试全绿」就毫无意义。这里逐类构造非法序列，
/// 断言判定确有区分力（本仓反复踩到的坑：判据退化成永远通过）。
#[test]
fn legality_predicate_rejects_illegal_sequences() {
    let max_backoff = Duration::from_secs(10);
    let legal =
        |attempt: usize, backoff: Option<Duration>, will_restart: bool, failed: bool| Step {
            attempt,
            backoff,
            will_restart,
            failed,
        };

    // 基线：一份合法序列必须放行（否则下面的拒绝可能是「恒拒」造成的假象）。
    let ok = vec![
        legal(1, Some(Duration::from_millis(100)), true, false),
        legal(2, None, false, true),
    ];
    assert!(
        check_legal_sequence(&ok, 1, max_backoff).is_ok(),
        "合法序列被误拒：{:?}",
        check_legal_sequence(&ok, 1, max_backoff)
    );

    // 非法①：attempt 跳号。
    let skipped = vec![
        legal(1, Some(Duration::from_millis(100)), true, false),
        legal(3, None, false, true),
    ];
    assert!(
        check_legal_sequence(&skipped, 1, max_backoff).is_err(),
        "attempt 跳号未被拒"
    );

    // 非法②：attempt 回退。
    let backwards = vec![
        legal(1, Some(Duration::from_millis(100)), true, false),
        legal(2, Some(Duration::from_millis(200)), true, false),
        legal(1, None, false, true),
    ];
    assert!(
        check_legal_sequence(&backwards, 2, max_backoff).is_err(),
        "attempt 回退未被拒"
    );

    // 非法③：Failed 之后还有步骤。
    let after_failed = vec![
        legal(1, None, false, true),
        legal(2, Some(Duration::from_millis(100)), true, false),
    ];
    assert!(
        check_legal_sequence(&after_failed, 1, max_backoff).is_err(),
        "Failed 之后仍有步骤未被拒"
    );

    // 非法④：退避下降。
    let decreasing = vec![
        legal(1, Some(Duration::from_millis(400)), true, false),
        legal(2, Some(Duration::from_millis(200)), true, false),
        legal(3, None, false, true),
    ];
    assert!(
        check_legal_sequence(&decreasing, 2, max_backoff).is_err(),
        "退避下降未被拒"
    );

    // 非法⑤：退避超过上限。
    let overshoot = vec![
        legal(1, Some(Duration::from_secs(11)), true, false),
        legal(2, None, false, true),
    ];
    assert!(
        check_legal_sequence(&overshoot, 1, max_backoff).is_err(),
        "退避越上限未被拒"
    );

    // 非法⑥：重启次数与上限不符。
    let too_few = vec![legal(1, None, false, true)];
    assert!(
        check_legal_sequence(&too_few, 3, max_backoff).is_err(),
        "重启次数不足未被拒"
    );

    // 非法⑦：空序列。
    assert!(
        check_legal_sequence(&[], 1, max_backoff).is_err(),
        "空序列未被拒"
    );
}

/// 显式登记一个**已知未设防的边界**：`backoff_multiplier < 1.0` 会让退避递减。
///
/// 这不是要通过它证明什么，而是**把缺口写成会运行的事实**：性质测试的参数域
/// 刻意限定在 `[1.0, 4.0]`，若不写这一条，缩小参数域就等同于把缺口藏起来。
/// 契约 C10 的 `Default` 是 `2.0`，且 `SupervisorConfig` 的该字段是公开的——
/// 想彻底关闭这个面，需要在配置校验或 `next_backoff` 里加下界钳制（属运行时语义
/// 决策，见 `docs/dev-plan-defect-remediation.md` 的 S6 记录）。
#[test]
fn sub_unity_multiplier_is_unguarded_known_gap() {
    let cur = Duration::from_secs(8);
    let next = next_backoff(cur, 0.5, Duration::from_secs(10));
    assert!(
        next < cur,
        "若此处不再成立，说明已给 multiplier 加了下界钳制——请同步订正本测试与 S6 记录"
    );
    assert_eq!(next, Duration::from_secs(4));
}
