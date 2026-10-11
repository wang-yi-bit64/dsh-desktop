//! S6-2 —— `recover` 子命令的黑盒测试（判据「一条命令完成三段流程」）。
//!
//! ## 为什么用黑盒（直接跑二进制）而不是调`recover::run`
//!
//! S6-2 的判据是**「一条命令完成三段流程；陌生人照文档能复现」**。
//! 这条判据的对象是**命令本身**，不是某个函数——所以测试必须
//! 真的派生 `dsh-host-cli` 进程、真的观察其 stdout 与退出码。
//! 只调`run()` 证明不了「一条命令能跑通」。
//!
//! 前置：需要 `target/debug/dsh-host-cli` 与系统 node。缺任一则跳过
//! （与 `mock_launch.rs` 同一口径，不让缺依赖伪装成通过）。

use std::path::{Path, PathBuf};
use std::process::Command;

/// 定位仓库根：从本文件位置向上找`Cargo.toml` 里含 `[workspace]` 的那层。
///
/// 不用 `dsh-host` 的 `tests/fixture`——那是**另一个 crate** 的 test 模块，
/// 在本 crate 里 `mod fixture;` 会报E0583（文件不存在）。CLI 测试必须自带。
fn repo_root() -> Option<PathBuf> {
    // CARGO_MANIFEST_DIR = <repo>/crates/dsh-host-cli
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let candidate = manifest.parent()?.parent()?.to_path_buf();
    let ws = candidate.join("Cargo.toml");
    ws.exists().then_some(candidate)
}

/// 演示的观察窗。给足 30s 以适配 CI 机器；它只防死锁，不参与判据。
const OBSERVE_SECS: &str = "30";

/// 找可执行文件：优先环境变量，其次 `target/debug/`。
fn cli_binary() -> Option<std::path::PathBuf> {
    if let Ok(custom) = std::env::var("DSH_CLI_BIN") {
        let path = std::path::PathBuf::from(custom);
        return path.exists().then_some(path);
    }
    let root = repo_root()?;
    for name in [
        "dsh-host-cli.exe", // Windows
        "dsh-host-cli",     // POSIX
    ] {
        let path = root.join("target").join("debug").join(name);
        if path.exists() {
            return Some(path);
        }
    }
    None
}

/// 把 mock 入口拷进临时资源目录，返回该目录路径。
fn mock_resource_dir(root: &Path, tag: &str) -> Option<std::path::PathBuf> {
    let source = root.join("scripts").join("mock-harness.mjs");
    if !source.exists() {
        return None;
    }
    let dir = std::env::temp_dir().join(format!("dsh-recover-test-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).ok()?;
    std::fs::copy(&source, dir.join("mock-harness.mjs")).ok()?;
    // 看门狗等 build/ 下的共用模块（mock 会尝试加载，找不到也只是退回旧行为）。
    if let Ok(entries) = std::fs::read_dir(root.join("build")) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|ext| ext == "mjs") {
                let _ = std::fs::copy(&path, dir.join(path.file_name().unwrap_or_default()));
            }
        }
    }
    Some(dir)
}

/// 跑一次 `recover`，返回 (stdout, 是否成功退出)。
fn run_recover(resource: &Path, data: &Path) -> Option<(String, bool)> {
    let binary = cli_binary()?;
    let output = Command::new(&binary)
        .arg("recover")
        .arg("--resource")
        .arg(resource)
        .arg("--data")
        .arg(data)
        .arg("--mock")
        .arg("--observe-secs")
        .arg(OBSERVE_SECS)
        .output()
        .ok()?;
    Some((
        String::from_utf8_lossy(&output.stdout).into_owned(),
        output.status.success(),
    ))
}

/// 三段流程一次跑通：启动 → 注入崩溃 → 退避递增重启 → 断路器开路。
///
/// 这是 S6-2 判据的可证伪版本：若退避被绕过（序列不递增），命令必须
/// **非零退出**——本用例的 `success` 断言随之失败。
#[test]
fn recover_completes_three_stages_and_exits_zero() {
    let Some(root) = repo_root() else {
        eprintln!("[skip] 未定位仓库根，跳过 recover 集成测试");
        return;
    };
    if cli_binary().is_none() {
        eprintln!("[skip] 未找到 target/debug/dsh-host-cli，先 cargo build -p dsh-host-cli");
        return;
    }
    let Some(resource) = mock_resource_dir(&root, "main") else {
        eprintln!("[skip] 未找到 scripts/mock-harness.mjs");
        return;
    };
    let data = std::env::temp_dir().join(format!("dsh-recover-data-{}", std::process::id()));

    let (stdout, success) = run_recover(&resource, &data).expect("recover 应可执行");

    assert!(
        success,
        "recover 未成功退出（判据：一���命令完成三段流程）。stdout:\n{stdout}"
    );
    // 退避必须**递增**——这一条是「可证伪」的核心，不接受「没报错」当通过。
    assert!(
        stdout.contains("退避严格增长 = true"),
        "未观测到退避增长。stdout:\n{stdout}"
    );
    assert!(
        stdout.contains("断路器开路 = true"),
        "断路器未开路。stdout:\n{stdout}"
    );
    // 序号自增说明确实重启了多次，而不是只崩一次就结束。
    assert!(
        stdout.contains("第 2 次尝试启动") && stdout.contains("第 3 次尝试启动"),
        "未观测到多次重启尝试。stdout:\n{stdout}"
    );

    let _ = std::fs::remove_dir_all(&resource);
    let _ = std::fs::remove_dir_all(&data);
}

/// 缺 `--mock` 时必须失败并说清原因（不得静默跑一次不崩溃的空演示）。
#[test]
fn recover_without_mock_fails_loudly() {
    let Some(root) = repo_root() else {
        return;
    };
    if cli_binary().is_none() {
        return;
    }
    let Some(resource) = mock_resource_dir(&root, "nomock") else {
        return;
    };
    let data = std::env::temp_dir().join(format!("dsh-recover-nomock-{}", std::process::id()));
    let binary = cli_binary().expect("已检查存在");

    let output = Command::new(&binary)
        .arg("recover")
        .arg("--resource")
        .arg(&resource)
        .arg("--data")
        .arg(&data)
        .output()
        .expect("recover 应可执行");

    assert!(
        !output.status.success(),
        "缺 --mock 时不得报告成功（不得空跑一次不崩溃的演示）"
    );
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        combined.contains("--mock"),
        "失败时必须说明需要 --mock，实际输出：\n{combined}"
    );

    let _ = std::fs::remove_dir_all(&resource);
    let _ = std::fs::remove_dir_all(&data);
}
