//! 子进程派生与生命周期守护（契约 C1，不变量 INV-3）。
//!
//! 命令形态（C1）：
//!
//! ```text
//! node --expose-internals harness-node-entry.mjs <dsh>/lib/bin.js web \
//!      --patch <patch.yml> --no-open --host 127.0.0.1 --port <port>
//! ```
//!
//! 孤儿进程防护（INV-3）——任何退出路径（正常关窗 / 崩溃 / 强杀 / panic）都
//! 不允许残留 node 子进程：
//!
//! | 平台 | 机制 |
//! |---|---|
//! | Windows | `CREATE_NEW_PROCESS_GROUP` + **Job Object**（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`） |
//! | Linux | `process_group(0)` + `prctl(PR_SET_PDEATHSIG, SIGTERM)` |
//! | macOS | `process_group(0)`（无 PDEATHSIG 等价物，见风险 R-7）+ 启动时陈旧进程清扫 |
//!
//! 另外提供 pidfile 机制：启动时若发现上一次的进程仍存活且**镜像路径落在
//! 本应用资源目录内**，先 SIGTERM / `taskkill /T /F` 再派生，兜住 macOS 与
//! 「父进程被强杀」两类残留。

use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};

use serde::{Deserialize, Serialize};
use tokio::process::{Child, ChildStderr, ChildStdout, Command};

use crate::contracts::{HARNESS_CLI, HARNESS_HOST, HARNESS_NO_OPEN, NODE_EXPOSE_INTERNALS};
use crate::env::HarnessEnv;
use crate::paths::Layout;
use crate::HostResult;

/// C1 — 传给 `<dsh>/lib/bin.js` 的参数（不含 node 自身的参数）。
///
/// # 示例
///
/// ```
/// use std::path::Path;
/// use dsh_host::paths::Layout;
/// use dsh_host::process::build_harness_arguments;
///
/// let layout = Layout::resolve(Path::new("/res"), Path::new("/data"));
/// let args = build_harness_arguments(&layout, 4173);
/// assert_eq!(args[0], "web");
/// assert!(args.windows(2).any(|pair| pair == ["--port", "4173"]));
/// ```
pub fn build_harness_arguments(layout: &Layout, port: u16) -> Vec<String> {
    vec![
        HARNESS_CLI.to_string(),
        "--patch".to_string(),
        layout.patch.display().to_string(),
        // 桌面窗口是唯一展示面：不交给系统浏览器打开。
        HARNESS_NO_OPEN.to_string(),
        "--host".to_string(),
        HARNESS_HOST.to_string(),
        "--port".to_string(),
        port.to_string(),
    ]
}

/// C1 — 完整的 node argv：`--expose-internals <entry> <bin.js> <harness args>`。
///
/// `--expose-internals` 是 Cordis HMR 的前提，只授予本子进程，绝不授予 webview。
pub fn build_node_arguments(layout: &Layout, port: u16) -> Vec<String> {
    let mut args = vec![
        NODE_EXPOSE_INTERNALS.to_string(),
        layout.node_entry.display().to_string(),
        layout.dsh_entry.display().to_string(),
    ];
    args.extend(build_harness_arguments(layout, port));
    args
}

/// 已派生的 Harness 子进程（持有平台守护句柄，Drop 即触发内核回收）。
///
/// `Debug` 手工实现（`win32job::Job` 没有实现），便于 `unwrap_err` / 日志。
pub struct HarnessProcess {
    child: Child,
    /// Windows Job Object：存活期内保持句柄打开；一旦宿主进程被杀，句柄由
    /// 内核关闭并连带杀绝整个进程树。
    #[cfg(windows)]
    _job: Option<win32job::Job>,
}

impl std::fmt::Debug for HarnessProcess {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HarnessProcess")
            .field("pid", &self.child.id())
            .finish_non_exhaustive()
    }
}

impl HarnessProcess {
    /// 子进程 PID。
    pub fn id(&self) -> Option<u32> {
        self.child.id()
    }

    /// 非阻塞地检查子进程是否已退出。
    pub fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
        self.child.try_wait()
    }

    /// 等待子进程退出。
    pub async fn wait(&mut self) -> std::io::Result<ExitStatus> {
        self.child.wait().await
    }

    /// 取出 stdout 管道（只能取一次）。
    pub fn take_stdout(&mut self) -> Option<ChildStdout> {
        self.child.stdout.take()
    }

    /// 取出 stderr 管道（只能取一次）。
    pub fn take_stderr(&mut self) -> Option<ChildStderr> {
        self.child.stderr.take()
    }

    /// 拆成「管道 + Child + 平台守护句柄」三份，交给不同的 owner。
    ///
    /// 启动编排（[`crate::launch`]）需要：管道交给日志泵、`Child` 交给
    /// exit watcher、Job Object 留在启动器（它决定进程树的生死）。一次借用
    /// 冲突都不留，代价是把所有权显式拆开。
    pub fn into_parts(mut self) -> HarnessParts {
        HarnessParts {
            stdout: self.child.stdout.take(),
            stderr: self.child.stderr.take(),
            child: self.child,
            #[cfg(windows)]
            job: self._job,
        }
    }
}

/// [`HarnessProcess::into_parts`] 的返回值。
pub struct HarnessParts {
    /// stdout 管道（无 `Lines` 包装，由调用方决定读取方式）。
    pub stdout: Option<ChildStdout>,
    /// stderr 管道。
    pub stderr: Option<ChildStderr>,
    /// 子进程本体。
    pub child: Child,
    /// Windows Job Object：只要它存活，进程树就随句柄关闭而被内核回收。
    #[cfg(windows)]
    pub job: Option<win32job::Job>,
}

/// 派生 Harness 子进程。
///
/// # 参数
///
/// * `layout` — 目录布局（提供 node 二进制与入口路径）。
/// * `environment` — 已组装好的子进程环境（见 [`crate::env::harness_env`]）。
/// * `port` — 监听端口。
///
/// # 前置条件
///
/// 调用方应先用 [`Layout::missing_resources`] 确认资源齐备，否则返回
/// [`crate::HostError::MissingResource`]。
///
/// # 示例
///
/// ```no_run
/// use std::path::Path;
/// use dsh_host::env::{capture_shell_environment, harness_env};
/// use dsh_host::paths::Layout;
/// use dsh_host::process::spawn;
///
/// # #[tokio::main(flavor = "current_thread")]
/// # async fn main() {
/// let layout = Layout::resolve(Path::new("resources"), Path::new("userdata"));
/// let shell = capture_shell_environment().unwrap();
/// let env = harness_env(&layout, &shell, None);
/// let child = spawn(&layout, &env, 4173).unwrap();
/// # }
/// ```
pub fn spawn(layout: &Layout, environment: &HarnessEnv, port: u16) -> HostResult<HarnessProcess> {
    if let Some((name, path)) = layout.missing_resources().into_iter().next() {
        return Err(crate::HostError::missing(name, path));
    }
    layout.ensure_exec_bits()?;

    let mut command = Command::new(&layout.node_executable);
    command
        .args(build_node_arguments(layout, port))
        .current_dir(&layout.launch_root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .envs(environment.as_pairs())
        // ELECTRON_RUN_AS_NODE 对本项目不适用，但清掉宿主的残留更稳。
        .env_remove("ELECTRON_RUN_AS_NODE")
        // 宿主自行管理停止语义（C6），不要让 tokio 在 drop 时直接 kill。
        .kill_on_drop(false);

    apply_platform_guards(&mut command)?;

    let child = command.spawn().map_err(crate::HostError::Spawn)?;

    #[cfg(windows)]
    {
        let job = assign_kill_on_close_job(&child)?;
        Ok(HarnessProcess { child, _job: job })
    }
    #[cfg(not(windows))]
    {
        Ok(HarnessProcess { child })
    }
}

/// 平台守护：进程组隔离 + 父死子亡。
#[cfg(windows)]
fn apply_platform_guards(command: &mut Command) -> HostResult<()> {
    // CREATE_NEW_PROCESS_GROUP：隔离 Ctrl+C 广播（对齐原仓库 detached 的意图，
    // 规避 harness 内部 kill(0) 波及桌面宿主）。
    // CREATE_NO_WINDOW：任何后代控制台窗口都不允许抢焦点。
    // tokio 的 Command 在 Windows 上自带 creation_flags，无需 CommandExt。
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    Ok(())
}

#[cfg(target_os = "linux")]
fn apply_platform_guards(command: &mut Command) -> HostResult<()> {
    use std::os::unix::process::CommandExt;

    command.process_group(0);
    unsafe {
        command.pre_exec(|| {
            // 父进程死亡时内核直接投递 SIGTERM。
            // 已知 race（计划中如实记录）：若父进程在 prctl 之前就死了，
            // 这里兜不住，由启动时 pidfile 清扫补位。
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
            Ok(())
        });
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn apply_platform_guards(command: &mut Command) -> HostResult<()> {
    use std::os::unix::process::CommandExt;
    // macOS 没有 PDEATHSIG 等价物（风险 R-7）：只能靠进程组 + 启动清扫。
    command.process_group(0);
    Ok(())
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn apply_platform_guards(command: &mut Command) -> HostResult<()> {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
    Ok(())
}

/// 把子进程挂到 Job Object 上，实现内核级「父死子亡」。
#[cfg(windows)]
fn assign_kill_on_close_job(child: &Child) -> HostResult<Option<win32job::Job>> {
    use win32job::{ExtendedLimitInfo, Job};

    let mut limits = ExtendedLimitInfo::new();
    limits.limit_kill_on_job_close();

    let job = Job::create_with_limit_info(&mut limits).map_err(|error| {
        crate::HostError::ProcessGuard(format!("Job::create_with_limit_info 失败：{error}"))
    })?;

    // win32job 用的是 winapi 的 `c_void`，与标准库的不是同一个类型；
    // 两者布局一致，用 `as *mut _` 交给编译器推断目标类型。
    let handle = match child.raw_handle() {
        Some(handle) => handle as *mut _,
        None => return Ok(None),
    };

    job.assign_process(handle).map_err(|error| {
        crate::HostError::ProcessGuard(format!("AssignProcessToJobObject 失败：{error}"))
    })?;

    Ok(Some(job))
}

// ---------------------------------------------------------------------------
// 陈旧进程清扫（INV-3 的兜底路径）
// ---------------------------------------------------------------------------

/// pidfile 内容：上一次启动的进程信息。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PidRecord {
    /// 子进程 PID。
    pub pid: u32,
    /// 监听端口。
    pub port: u16,
    /// 启动时的资源目录（用于确认「是本应用的进程」而不是别的 node）。
    pub resource_dir: PathBuf,
    /// 启动时间戳（秒）。
    pub started_at: u64,
}

/// 写入 pidfile。
pub fn write_pid_file(layout: &Layout, record: &PidRecord) -> std::io::Result<()> {
    if let Some(parent) = layout.pid_file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let payload = serde_json::to_string_pretty(record).map_err(std::io::Error::other)?;
    std::fs::write(&layout.pid_file, payload)
}

/// 读取 pidfile（不存在或格式损坏时返回 `None`）。
pub fn read_pid_file(layout: &Layout) -> Option<PidRecord> {
    let payload = std::fs::read_to_string(&layout.pid_file).ok()?;
    serde_json::from_str::<PidRecord>(&payload).ok()
}

/// 删除 pidfile。
pub fn clear_pid_file(layout: &Layout) {
    let _ = std::fs::remove_file(&layout.pid_file);
}

/// 进程是否存活。
pub fn is_process_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                false
            } else {
                windows_sys::Win32::Foundation::CloseHandle(handle);
                true
            }
        }
    }
    #[cfg(unix)]
    {
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }
}

/// 进程的镜像 / 命令行是否属于本应用（避免误杀系统上其它 node 进程）。
pub fn process_belongs_to(pid: u32, resource_dir: &Path) -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
        use windows_sys::Win32::System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
        };

        unsafe {
            let handle: HANDLE = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return false;
            }
            let mut buffer = [0u16; 4096];
            let mut size = buffer.len() as u32;
            let ok = QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut size);
            CloseHandle(handle);
            if ok == 0 {
                return false;
            }
            let image = String::from_utf16_lossy(&buffer[..size as usize]);
            let image = image.to_lowercase();
            let resource = resource_dir.display().to_string().to_lowercase();
            !resource.is_empty() && image.starts_with(&resource)
        }
    }
    #[cfg(unix)]
    {
        let Ok(cmdline) = std::fs::read(format!("/proc/{pid}/cmdline")) else {
            return false;
        };
        let cmdline = String::from_utf8_lossy(&cmdline).replace('\0', " ");
        let resource = resource_dir.display().to_string();
        !resource.is_empty() && cmdline.contains(&resource)
    }
}

/// 启动期清扫：若 pidfile 记录的进程仍存活且属于本应用，先终止再返回其 PID。
///
/// 这是 macOS（无 PDEATHSIG）与「宿主被 `kill -9`」两条路径上唯一的兜底。
pub fn sweep_stale_process(layout: &Layout) -> HostResult<Option<u32>> {
    let Some(record) = read_pid_file(layout) else {
        return Ok(None);
    };
    if record.pid == 0 || !is_process_alive(record.pid) {
        clear_pid_file(layout);
        return Ok(None);
    }
    if !process_belongs_to(record.pid, &record.resource_dir) {
        clear_pid_file(layout);
        return Ok(None);
    }

    terminate_process_tree(record.pid);
    // 给内核一点回收时间，随后无论如何都清掉 pidfile。
    std::thread::sleep(std::time::Duration::from_millis(200));
    clear_pid_file(layout);
    Ok(Some(record.pid))
}

/// 尽最大努力终止整个进程树。
pub fn terminate_process_tree(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
    #[cfg(unix)]
    {
        // 进程组：spawn 时用了 process_group(0)，pgid == pid。
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
        if is_process_alive(pid) {
            unsafe {
                libc::kill(pid as i32, libc::SIGKILL);
            }
        }
    }
}

/// 当前时间戳（秒，用于 pidfile）。
pub fn now_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout(root: &Path) -> Layout {
        Layout::resolve(root.join("res"), root.join("data"))
    }

    #[test]
    fn harness_arguments_match_contract_c1() {
        let layout = layout(Path::new(if cfg!(windows) { "C:\\t" } else { "/t" }));
        let args = build_harness_arguments(&layout, 1234);
        assert_eq!(
            args,
            vec![
                "web",
                "--patch",
                &layout.patch.display().to_string(),
                "--no-open",
                "--host",
                "127.0.0.1",
                "--port",
                "1234"
            ]
        );
    }

    #[test]
    fn node_arguments_start_with_expose_internals() {
        let layout = layout(Path::new(if cfg!(windows) { "C:\\t" } else { "/t" }));
        let args = build_node_arguments(&layout, 1234);
        assert_eq!(args[0], "--expose-internals");
        assert_eq!(args[1], layout.node_entry.display().to_string());
        assert_eq!(args[2], layout.dsh_entry.display().to_string());
        assert_eq!(args[3], "web");
    }

    #[test]
    fn spawn_reports_missing_resources_instead_of_panicking() {
        let layout = layout(Path::new(if cfg!(windows) {
            "C:\\definitely-missing-dsh"
        } else {
            "/definitely-missing-dsh"
        }));
        let env = HarnessEnv::default();
        let error = spawn(&layout, &env, 4173).unwrap_err();
        assert!(
            matches!(error, crate::HostError::MissingResource(..)),
            "实际错误：{error:?}"
        );
    }

    #[test]
    fn pid_file_round_trip() {
        let unique = format!("dsh-host-pid-{}", std::process::id());
        let root = std::env::temp_dir().join(unique);
        let layout = layout(&root);
        let record = PidRecord {
            pid: 4242,
            port: 4173,
            resource_dir: root.join("res"),
            started_at: now_seconds(),
        };
        write_pid_file(&layout, &record).unwrap();
        assert_eq!(read_pid_file(&layout), Some(record));

        clear_pid_file(&layout);
        assert!(read_pid_file(&layout).is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn sweep_ignores_absent_or_dead_records() {
        let unique = format!("dsh-host-sweep-{}", std::process::id());
        let root = std::env::temp_dir().join(unique);
        let layout = layout(&root);

        // 无 pidfile。
        assert_eq!(sweep_stale_process(&layout).unwrap(), None);

        // pidfile 指向一个几乎不可能存在的 PID。
        write_pid_file(
            &layout,
            &PidRecord {
                pid: u32::MAX - 1,
                port: 4173,
                resource_dir: root.join("res"),
                started_at: now_seconds(),
            },
        )
        .unwrap();
        assert_eq!(sweep_stale_process(&layout).unwrap(), None);
        assert!(read_pid_file(&layout).is_none(), "死记录应被清理");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn sweep_ignores_foreign_processes() {
        let unique = format!("dsh-host-sweep-foreign-{}", std::process::id());
        let root = std::env::temp_dir().join(unique);
        let layout = layout(&root);

        write_pid_file(
            &layout,
            &PidRecord {
                // 当前进程一定存活，但镜像不在资源目录下 → 不得误杀。
                pid: std::process::id(),
                port: 4173,
                resource_dir: root.join("res"),
                started_at: now_seconds(),
            },
        )
        .unwrap();
        assert_eq!(sweep_stale_process(&layout).unwrap(), None);
        assert!(read_pid_file(&layout).is_none());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn current_process_is_alive() {
        assert!(is_process_alive(std::process::id()));
    }

    #[cfg(unix)]
    #[test]
    fn process_belongs_to_reads_proc_cmdline() {
        // 当前进程的 cmdline 里含有测试二进制所在目录。
        let exe = std::env::current_exe().unwrap();
        assert!(process_belongs_to(
            std::process::id(),
            exe.parent().unwrap()
        ));
        assert!(!process_belongs_to(
            std::process::id(),
            Path::new("/nonexistent-resource-dir-xyz")
        ));
    }
}
