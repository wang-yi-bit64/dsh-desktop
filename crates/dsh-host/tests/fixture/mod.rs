//! 集成测试夹具（T05）。
//!
//! 让 `cargo test -p dsh-host` 在不组装 300MB 真实资源的前提下，把「spawn →
//! 就绪 → 停止 → 失败归因」整条链路跑在系统 Node + `scripts/mock-harness.mjs`
//! 上（不变量 INV-6）。
//!
//! `fixture()` 返回 `None` 表示前置条件不满足（找不到系统 node / 找不到仓库
//! mock 脚本），测试应直接跳过而不是失败——这样无 Node 的沙箱也能跑其余纯逻辑
//! 测试。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use dsh_host::env::{harness_env_with_overrides, HarnessEnv};
use dsh_host::launch::{Launcher, LauncherConfig, PortMode};
use dsh_host::paths::Layout;
use dsh_host::readiness::ProbeConfig;

/// 夹具内多个临时目录的后缀计数器（并行测试保证唯一）。
static COUNTER: AtomicU64 = AtomicU64::new(0);

/// 一次集成测试用到的临时布局 + 宿主环境构造器。
///
/// Drop 时清理临时资源目录与数据目录。
pub struct MockFixture {
    /// 已替换为「系统 node + mock 入口」的布局。
    pub layout: Layout,
    /// 临时资源目录（mock-harness.mjs / patch 占位）。
    pub resource_dir: PathBuf,
    /// 临时数据目录（DSH_HOME / launch-root / logs / pidfile）。
    pub data_dir: PathBuf,
}

impl Drop for MockFixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.resource_dir);
        let _ = std::fs::remove_dir_all(&self.data_dir);
    }
}

impl MockFixture {
    /// 构造一次启动用的宿主环境（继承当前进程环境 + C2 契约项 + 附加覆盖）。
    ///
    /// `extra` 里的键值覆盖契约项（与 CLI `--env K=V` 同一语义），
    /// 故障模式变量（`DSH_MOCK_FAIL` 等）由此注入。
    pub fn env_with(&self, extra: &[(&str, &str)]) -> HarnessEnv {
        let overrides: Vec<(String, String)> = extra
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect();
        let shell = HarnessEnv::from_pairs(std::env::vars());
        harness_env_with_overrides(&self.layout, &shell, None, &overrides)
    }

    /// 无附加覆盖的宿主环境。
    pub fn env(&self) -> HarnessEnv {
        self.env_with(&[])
    }

    /// 快速探测配置（毫秒级稳定窗 + 显式总超时），避免测试等待平台默认 120s。
    pub fn config(&self, total_timeout: std::time::Duration) -> LauncherConfig {
        LauncherConfig {
            probe: ProbeConfig::fast(total_timeout),
            port_mode: PortMode::Reserved,
            max_port_attempts: dsh_host::contracts::MAX_PORT_ATTEMPTS,
        }
    }

    /// 构建启动器（mock 就绪 + 快速探测）。
    pub fn launcher(&self, total_timeout: std::time::Duration) -> Launcher {
        Launcher::new(self.layout.clone(), self.config(total_timeout))
    }
}

/// 前置条件齐备时返回夹具，否则 `None`。
pub fn fixture() -> Option<MockFixture> {
    let node = find_system_node()?;
    let mock_source = repo_root()?.join("scripts").join("mock-harness.mjs");
    if !mock_source.is_file() {
        return None;
    }

    let unique = format!(
        "dsh-host-test-{}-{}-{}",
        std::process::id(),
        dsh_host::process::now_seconds(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let root = std::env::temp_dir().join(unique);
    let resource_dir = root.join("resource");
    let data_dir = root.join("data");
    std::fs::create_dir_all(&resource_dir).ok()?;

    // patch 占位：mock 不读内容，missing_resources 只要求存在。
    std::fs::write(
        resource_dir.join("dsh-desktop.patch.yml"),
        "# dsh-host integration mock patch placeholder\n[]\n",
    )
    .ok()?;
    let mock_dest = resource_dir.join("mock-harness.mjs");
    std::fs::copy(&mock_source, &mock_dest).ok()?;

    // 把布局指向「系统 node + mock 入口」：node_entry / dsh_entry 都落到
    // mock 脚本，node_executable 指向真实系统 node（不复制大体积二进制）。
    let mut layout = Layout::resolve(&resource_dir, &data_dir);
    layout.node_executable = node;
    layout.node_entry = mock_dest.clone();
    layout.dsh_entry = mock_dest;
    layout.patch = resource_dir.join("dsh-desktop.patch.yml");

    Some(MockFixture {
        layout,
        resource_dir,
        data_dir,
    })
}

/// 仓库根（`<repo>/scripts/mock-harness.mjs` 所在目录）。
pub fn repo_root() -> Option<PathBuf> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let candidate = manifest_dir.join("..").join("..");
    let candidate = candidate.canonicalize().ok()?;
    if candidate.join("scripts").join("mock-harness.mjs").is_file() {
        Some(candidate)
    } else {
        None
    }
}

/// 在 PATH 上找一个可运行的 Node.js。
pub fn find_system_node() -> Option<PathBuf> {
    if let Ok(overridden) = std::env::var("DSH_TEST_NODE") {
        let path = PathBuf::from(overridden);
        if path.is_file() && node_is_runnable(&path) {
            return Some(path);
        }
    }
    let file_name = if cfg!(windows) { "node.exe" } else { "node" };
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(file_name);
        if candidate.is_file() && node_is_runnable(&candidate) {
            return Some(candidate);
        }
    }
    None
}

fn node_is_runnable(path: &Path) -> bool {
    std::process::Command::new(path)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}
