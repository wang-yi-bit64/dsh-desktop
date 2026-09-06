//! T05 — dsh-host-cli 黑盒测试。
//!
//! 直接运行编译出的二进制（`CARGO_BIN_EXE_dsh-host-cli`），校验退出码与关键
//! 输出。不需要系统 node / mock 资源；只依赖临时目录与占位文件。

use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

use dsh_host::contracts::{EXIT_MISSING_RESOURCE, EXIT_OK, EXIT_UNEXPECTED, EXIT_USAGE};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// 临时目录（自动清理）。
struct TempDir {
    path: PathBuf,
}

impl TempDir {
    fn new(label: &str) -> Self {
        let unique = format!(
            "dsh-host-cli-test-{label}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        );
        let path = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&path).expect("临时目录应可创建");
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn cli_binary() -> PathBuf {
    // Cargo 在运行集成测试时会注入 `CARGO_BIN_EXE_<bin>`（连字符 → 下划线）。
    std::env::var_os("CARGO_BIN_EXE_dsh_host_cli")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            // 兜底：直接运行测试二进制（非 cargo test）时回退到仓库 target/debug。
            let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            let root = manifest.join("..").join("..");
            let name = if cfg!(windows) {
                "dsh-host-cli.exe"
            } else {
                "dsh-host-cli"
            };
            root.join("target").join("debug").join(name)
        })
}

/// 运行 CLI 并断言退出码（返回值供进一步断言 stdout/stderr）。
fn run_ok(args: &[&str], code: i32) -> Output {
    let output = Command::new(cli_binary())
        .args(args)
        // 屏蔽宿主环境里的 DSH_MOCK，保证被测行为确定。
        .env_remove("DSH_MOCK")
        .output()
        .expect("CLI 应能启动");
    assert_eq!(
        output.status.code(),
        Some(code),
        "args={args:?} 退出码不符\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    output
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

/// 无参数 → clap 用法错误（退出码 2）。
#[test]
fn no_args_is_usage_error() {
    let output = Command::new(cli_binary())
        .env_remove("DSH_MOCK")
        .output()
        .expect("CLI 应能启动");
    assert_eq!(output.status.code(), Some(EXIT_USAGE), "无子命令应退出码 2");
}

/// `status` 指向空资源目录 → 资源缺失（退出码 3），输出 MISSING。
#[test]
fn status_on_empty_resource_reports_missing() {
    let resource = TempDir::new("empty-res");
    let data = TempDir::new("empty-data");
    let output = run_ok(
        &[
            "status",
            "--resource",
            &resource.path().display().to_string(),
            "--data",
            &data.path().display().to_string(),
        ],
        EXIT_MISSING_RESOURCE,
    );
    assert!(
        stdout(&output).contains("MISSING"),
        "缺失资源应打印 MISSING：{}",
        stdout(&output)
    );
}

/// `status` 资源齐备 → 退出码 0，输出 ok。
#[test]
fn status_reports_ok_when_resources_present() {
    let resource = TempDir::new("ok-res");
    let data = TempDir::new("ok-data");
    let resource = resource.path();
    let data = data.path();

    // 只要求「存在」，不要求可执行——status 只做存在性检查。
    let node_dir = resource.join("node");
    std::fs::create_dir_all(&node_dir).expect("node 目录应可创建");
    std::fs::write(
        node_dir.join(if cfg!(windows) { "node.exe" } else { "node" }),
        "",
    )
    .expect("node 占位应可写入");
    std::fs::write(resource.join("harness-node-entry.mjs"), "").expect("入口占位应可写入");
    std::fs::write(resource.join("dsh-desktop.patch.yml"), "[]\n").expect("patch 占位应可写入");
    let modules = resource
        .join("harness")
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("lib");
    std::fs::create_dir_all(&modules).expect("dsh 入口目录应可创建");
    std::fs::write(modules.join("bin.js"), "").expect("bin.js 占位应可写入");

    let output = run_ok(
        &[
            "status",
            "--resource",
            &resource.display().to_string(),
            "--data",
            &data.display().to_string(),
        ],
        EXIT_OK,
    );
    assert!(
        stdout(&output).contains("resources    : ok"),
        "齐备资源应打印 ok：{}",
        stdout(&output)
    );
}

/// `probe` 指向不可达端口 → 不健康（退出码 1），输出 unreachable。
#[test]
fn probe_unreachable_port_is_unhealthy() {
    let output = run_ok(&["probe", "--port", "1", "--timeout", "1"], EXIT_UNEXPECTED);
    assert!(
        stdout(&output).contains("unreachable"),
        "127.0.0.1:1 应不可达：{}",
        stdout(&output)
    );
}

/// `tail` 无日志文件 → 退出码 0，提示尚无日志。
#[test]
fn tail_without_log_file_is_ok() {
    let data = TempDir::new("no-log");
    let output = run_ok(
        &["tail", "--data", &data.path().display().to_string()],
        EXIT_OK,
    );
    assert!(
        stdout(&output).contains("尚无日志文件"),
        "应提示尚无日志：{}",
        stdout(&output)
    );
}

/// `stop` 无 pidfile → 退出码 0，提示无需停止。
#[test]
fn stop_without_pidfile_is_ok() {
    let data = TempDir::new("no-pid");
    let output = run_ok(
        &["stop", "--data", &data.path().display().to_string()],
        EXIT_OK,
    );
    assert!(
        stdout(&output).contains("无 pidfile"),
        "应提示无 pidfile：{}",
        stdout(&output)
    );
}
