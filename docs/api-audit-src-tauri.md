# src-tauri ↔ dsh-host 公开 API 静态深度审计

> 审计人：software-engineer（T05 收尾动作 3）
> 审计对象：`src-tauri/src/{layout.rs,state.rs,lib.rs}` 对 `crates/dsh-host`（post-T04）
> 公开 API 的逐符号引用（核对字段形状与方法签名，非只 grep 存在性）。
> 审计范围：dsh-host API 兼容性；GUI 全量编译仍被环境缺失 `windres` 阻塞（见 §5）。

## 1. 结论（TL;DR）

**GUI 代码本身无需改动。** 三个直接消费 dsh-host 的源文件逐符号核对通过；
其余 GUI 模块（commands / window / navigation / cookies / menu / recovery /
safe_mode / update / mobile_bridge）不直接引用 `dsh_host::*`（grep 全量验证），
只经由 `HarnessSupervisor` / `Layout` 的内部方法间接使用，签名也逐项吻合。
当前唯一阻断 `cargo check -p dsh-desktop` 的是 **环境缺 GNU `windres`**（
`tauri-build → tauri_winres → embed-resource` 对 windows target 无条件调用），
属环境问题而非代码错误（.cargo/config.toml 已记录本机无 MSVC / Windows SDK /
MinGW；GNU 工具链 bin 无 llvm-rc / llvm-windres / gcc / clang）。

## 2. `layout.rs`（Tauri 路径 → `dsh_host::paths::Layout` 适配层）

| 符号 | dsh-host 形状 | 调用点形状 | 结论 |
|---|---|---|---|
| `dsh_host::HostResult<Layout>` | `type HostResult<T> = Result<T, HostError>`（lib 再导出） | `resolve_layout() -> HostResult<Layout>` | OK |
| `dsh_host::HostError::MissingResource(&'static str, PathBuf)` | 变体签名 `(&'static str, PathBuf)` | `MissingResource("resource_dir", format!(...).into())`：字面量 `&'static str` + `PathBuf: From<String>` | OK |
| `Layout::resolve(resource_dir, app_data_dir)` | `resolve(impl AsRef<Path>, impl AsRef<Path>)` | `PathBuf`（resource_dir / app_data_dir），测试用 `&str` | OK |
| `Layout` 字段 | `pub resource_dir / node_entry / dsh_entry / dsh_home …` | `apply_mock()` 直写 `node_entry / dsh_entry`，测试读 `dsh_home` | OK |
| mock 语义 | `node_entry`/`dsh_entry` 都指向 mock 脚本 | `layout.rs::apply_mock` 一致 | OK |

`layout.rs::tests` 使用 `Layout::resolve("/res","/data")` —— `&str: AsRef<Path>`，OK。

## 3. `state.rs`（Harness 状态机 / HarnessSupervisor）

| 符号 | dsh-host 形状 | 调用点形状 | 结论 |
|---|---|---|---|
| `Launcher::new(Layout, LauncherConfig)` | `new(layout: Layout, config: LauncherConfig) -> Self` | `Launcher::new(self.layout.clone(), self.config)` | OK |
| `LauncherConfig` | `Copy + Clone`，字段 `probe / port_mode / max_port_attempts` | `LauncherConfig::default()`；`HarnessSupervisor::new` 存为 `config` | OK |
| `launcher.launch(None, closure)` | `launch(shell: Option<&HarnessEnv>, on_event: FnMut(LaunchEvent)) -> HostResult<LaunchOutcome>` | `.launch(None, move |event| supervisor.apply_launch_event(event))` | OK |
| `LaunchOutcome::Ready(RunningHarness)` | tuple variant | `Ok(LaunchOutcome::Ready(mut running))` | OK |
| `LaunchOutcome::Failed { cause, logs }` | struct variant | `Ok(LaunchOutcome::Failed { .. })` 通配匹配 | OK |
| `RunningHarness` 字段 | `endpoint/pid/logs/live_logs/exit/_job`；`live_logs` 为 `Arc<Mutex<LogRing>>` | `inner.running: Option<RunningHarness>` | OK |
| `RunningHarness::take_exit(&mut self)` | `-> Option<oneshot::Receiver<io::Result<ExitStatus>>>` | `let exit = running.take_exit(); if let Some(exit) = exit { spawn(async move { let status = exit.await.ok(); ... }) }` | OK |
| `RunningHarness::wait_exit(&mut self)` | `async -> Option<io::Result<ExitStatus>>` | `let exit = running.wait_exit().await;` 再 match `Some(Ok(status))` / `Some(Err(..))` / `None` | OK |
| `RunningHarness::terminate(&self)` | `-> ()`（平台进程树终止） | `running.terminate();` | OK |
| `LaunchEvent` 全变体 | `Preparing / Spawned{pid,port} / TokenFound{endpoint} / ReadyChecking{port} / Ready{endpoint} / Failed{cause} / Log(LogLine)` | `apply_launch_event` match 覆盖全部 7 变体 | OK |
| `LaunchEndpoint` | `{url: Url, token, host, port}`；`navigate_url(&[(&str,&str)]) -> Url`；`Display` | `endpoint.navigate_url(&[WINDOWS_QUERY_MODE, WINDOWS_QUERY_PLATFORM])`；类型 `LaunchEndpoint` | OK |
| `contracts::{AUTH_COOKIE_PREFIX, WINDOWS_QUERY_MODE, WINDOWS_QUERY_PLATFORM}` | `&str` / `(&str,&str)` / `(&str,&str)` 常量 | `clear_auth_cookies(&webview, AUTH_COOKIE_PREFIX)`；`&[WINDOWS_QUERY_MODE, WINDOWS_QUERY_PLATFORM]` | OK |
| `logs::{FailureCause, LogLine, LogRing, LogSource}` | `FailureCause`（C7 归因枚举）、`LogLine::new(LogSource, impl Into<String>)`、`LogRing::{new,push,tail,clear,push_desktop,latest_attempt}`、`extract_failure_cause(&[LogLine])` | `inner.logs.tail(200)` → `Vec<String>`；`LogLine::new(LogSource::Desktop, text)`；`extract_failure_cause(&attempt).unwrap_or(fallback)` | OK |
| `FailureCause::kind()/is_plugin_fault()/is_retryable()` | `-> &'static str / bool / bool` | `on_failed` 填充 `HarnessPhase::Failed{cause_kind, plugin_fault, retryable}` | OK |
| `Layout` | `Clone + Debug` | `HarnessSupervisor::layout()` 返回 `&Layout`；`layout.clone()` 传入 | OK |
| `harness_port()` 解析 | `HarnessPhase::Ready { url: String }` 存 `endpoint.navigate_url(...).to_string()` | 内部字段，无 dsh-host 调用 | 自洽 |
| `url::Url::parse` | — | `state.rs` 直接依赖 crate `url`（src-tauri Cargo.toml 含 `url = "2"`） | OK |

关键检查（不只存在性）：
- `running.take_exit()` 之后 `handle_post_ready_exit(status: Option<io::Result<ExitStatus>>)`
  与 `exit.await.ok()` 的类型完全一致。
- `stop()` 对 `running: Option<RunningHarness>` 用 `take()` + `let Some(mut running) = ... else`
  后调用 `terminate()`（`&self`）与 `wait_exit()`（`&mut self`），两者签名匹配。
- `logs.latest_attempt()` 返回 `Vec<&LogLine>`，`into_iter().cloned().collect::<Vec<LogLine>>()`
  后传给 `extract_failure_cause`，与 `fn(&[LogLine])` 匹配。

## 4. `lib.rs`（Tauri Builder 装配）

| 符号 | dsh-host 形状 | 调用点形状 | 结论 |
|---|---|---|---|
| `dsh_host::launch::LauncherConfig` | `pub struct LauncherConfig`（lib 再导出） | `LauncherConfig::default()` | OK |
| `Layout::ensure_dirs()` | `-> HostResult<()>` | `.setup` 内 `layout.ensure_dirs()?`（`HostError: std::error::Error` → `Box<dyn Error>`） | OK |
| `HarnessSupervisor::{new, start, stop}` | 内部方法（lib.rs 自身模块） | 装配与关窗回收 | OK |
| 事件订阅 / WebviewWindowBuilder / opener | Tauri API（非 dsh-host） | — | 超出本审计范围 |

## 5. 未解决问题

- `cargo check -p dsh-desktop` 无法在当前机器跑通：`tauri-build` 对 windows target
  无条件调用 `tauri_winres::compile()`（tauri-build 2.6.3 `lib.rs:604-682`），内部
  `embed-resource` 需要 GNU `windres.exe`。这是**环境缺口**，不是 GUI 代码缺陷；
  修复选项（待 team-lead 决策）：A. 提供便携 windres 并设 `RC` env；B. 视作环境阻塞。
- T05 集成测试与 fault-inject 全部走 `dsh-host` + `dsh-host-cli`（INV-6），不触发
  tauri-build，因此不受该环境缺口影响。

## 6. 结论

| 文件 | 逐符号结果 | 需改 |
|---|---|---|
| `src-tauri/src/layout.rs` | OK | 无 |
| `src-tauri/src/state.rs` | OK | 无 |
| `src-tauri/src/lib.rs` | OK | 无 |
| 其余 GUI 模块（不直接引用 dsh-host） | 不适用 | 无 |

**IS_PASS: YES（dsh-host API 兼容面）；GUI 编译被 windres 环境缺口阻塞（非代码错误）。**
