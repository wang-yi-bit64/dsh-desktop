//! 停止语义（契约 C6）。
//!
//! 原仓库：SIGTERM → 4s 竞速 → SIGKILL；Windows 用 `taskkill /T /F /PID` 杀
//! 进程树。本项目在此基础上：
//!
//! * POSIX 上优先杀**进程组**（spawn 时用 `process_group(0)`，故 pgid == pid），
//!   确保 harness 派生的 pwsh / git / ripgrep 后代一起收走；
//! * 只有在确认子进程确实是组长时才用 `killpg`（用 `getpgid` 判定），避免把
//!   信号打进测试进程自己的进程组；
//! * Windows 保留 `taskkill /T /F` 作为 Job Object 之外的兜底。

use std::time::Duration;

use tokio::process::Child;

use crate::process::HarnessProcess;

/// 停止结果。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StopOutcome {
    /// 调用前子进程已经不在了。
    AlreadyGone,
    /// 收到 SIGTERM / taskkill 后自行退出。
    Exited(Option<i32>),
    /// 宽容期内没退出，被强杀。
    Killed,
}

impl StopOutcome {
    /// 拿到的退出码（强杀路径上没有可信退出码）。
    pub fn exit_code(self) -> Option<i32> {
        match self {
            StopOutcome::Exited(code) => code,
            StopOutcome::Killed | StopOutcome::AlreadyGone => None,
        }
    }

    /// 是否走到了强杀（说明子进程忽略了 SIGTERM，值得记进日志）。
    pub fn was_killed(self) -> bool {
        matches!(self, StopOutcome::Killed)
    }
}

/// 按契约 C6 停止一个已派生的 Harness 子进程。
///
/// # 参数
///
/// * `process` — [`HarnessProcess`]；方法会消费其中的子进程。
/// * `timeout` — SIGTERM 之后的宽容期，通常取
///   [`crate::contracts::GRACEFUL_STOP_TIMEOUT`]（4s）。
///
/// # 示例
///
/// ```no_run
/// use dsh_host::contracts::GRACEFUL_STOP_TIMEOUT;
/// use dsh_host::process::HarnessProcess;
/// use dsh_host::stop::stop;
///
/// # async fn example(mut process: HarnessProcess) {
/// let outcome = stop(&mut process, GRACEFUL_STOP_TIMEOUT).await;
/// assert!(matches!(outcome, _));
/// # }
/// ```
pub async fn stop(process: &mut HarnessProcess, timeout: Duration) -> StopOutcome {
    match process.try_wait() {
        Ok(Some(status)) => return StopOutcome::Exited(status.code()),
        Ok(None) => {}
        Err(_) => return StopOutcome::AlreadyGone,
    }

    let Some(pid) = process.id() else {
        return StopOutcome::AlreadyGone;
    };

    signal_tree(pid, Signal::Terminate);

    match tokio::time::timeout(timeout, process.wait()).await {
        Ok(Ok(status)) => StopOutcome::Exited(status.code()),
        Ok(Err(_)) => StopOutcome::AlreadyGone,
        Err(_) => {
            // 宽容期到：强杀进程树。
            signal_tree(pid, Signal::Kill);
            let _ = tokio::time::timeout(Duration::from_secs(2), process.wait()).await;
            StopOutcome::Killed
        }
    }
}

/// 停止一个裸 `Child`（CLI 与测试直接派生的场景）。
pub async fn stop_child(child: &mut Child, timeout: Duration) -> StopOutcome {
    match child.try_wait() {
        Ok(Some(status)) => return StopOutcome::Exited(status.code()),
        Ok(None) => {}
        Err(_) => return StopOutcome::AlreadyGone,
    }

    let Some(pid) = child.id() else {
        return StopOutcome::AlreadyGone;
    };

    signal_tree(pid, Signal::Terminate);

    match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) => StopOutcome::Exited(status.code()),
        Ok(Err(_)) => StopOutcome::AlreadyGone,
        Err(_) => {
            signal_tree(pid, Signal::Kill);
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
            StopOutcome::Killed
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum Signal {
    Terminate,
    Kill,
}

/// 向子进程（及其进程树）发送信号。
fn signal_tree(pid: u32, signal: Signal) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // /T 杀进程树，/F 强制。Job Object 已经覆盖「父死子亡」，这里处理
        // 主动停止与 Job Object 失效两种情形。
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        let _ = signal;
    }

    #[cfg(unix)]
    {
        let signal = match signal {
            Signal::Terminate => libc::SIGTERM,
            Signal::Kill => libc::SIGKILL,
        };
        unsafe {
            // 只有确认子进程是组长时才杀整个进程组，否则误伤调用方所在组。
            let pgid = libc::getpgid(pid as i32);
            if pgid == pid as i32 {
                libc::killpg(pid as i32, signal);
            } else {
                libc::kill(pid as i32, signal);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;
    use tokio::process::Command;

    /// 找一个可用于测试的子进程解释器（Node；找不到则跳过）。
    fn node_binary() -> Option<String> {
        for candidate in ["node", "node.exe"] {
            if std::process::Command::new(candidate)
                .arg("--version")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|status| status.success())
                .unwrap_or(false)
            {
                return Some(candidate.to_string());
            }
        }
        None
    }

    fn spawn_node(script: &str) -> Option<Child> {
        let node = node_binary()?;
        Command::new(node)
            .args(["-e", script])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .ok()
    }

    #[tokio::test]
    async fn already_exited_child_reports_code() {
        let Some(mut child) = spawn_node("process.exit(7)") else {
            eprintln!("[skip] 未找到 node，跳过停止语义测试");
            return;
        };
        let outcome = stop_child(&mut child, crate::contracts::GRACEFUL_STOP_TIMEOUT).await;
        assert_eq!(outcome, StopOutcome::Exited(Some(7)));
    }

    #[tokio::test]
    async fn running_child_is_gone_after_stop() {
        let Some(mut child) = spawn_node("setInterval(() => {}, 1000)") else {
            eprintln!("[skip] 未找到 node，跳过停止语义测试");
            return;
        };
        let outcome = stop_child(&mut child, Duration::from_millis(500)).await;
        // 平台差异：Windows 上 taskkill /F 直接结束；POSIX 上走 SIGTERM。
        assert!(
            matches!(outcome, StopOutcome::Exited(_) | StopOutcome::Killed),
            "实际结果：{outcome:?}"
        );
        assert!(
            child.try_wait().ok().flatten().is_some(),
            "停止后子进程不应存在"
        );
    }

    #[tokio::test]
    async fn child_ignoring_terminate_is_killed_after_grace_period() {
        let Some(mut child) =
            spawn_node("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)")
        else {
            eprintln!("[skip] 未找到 node，跳过停止语义测试");
            return;
        };
        let outcome = stop_child(&mut child, Duration::from_millis(300)).await;
        assert!(
            child.try_wait().ok().flatten().is_some(),
            "强杀后子进程不应存在"
        );
        assert!(
            matches!(outcome, StopOutcome::Killed | StopOutcome::Exited(_)),
            "实际结果：{outcome:?}"
        );
    }

    #[test]
    fn outcome_helpers() {
        assert_eq!(StopOutcome::Exited(Some(7)).exit_code(), Some(7));
        assert!(!StopOutcome::Exited(Some(7)).was_killed());
        assert!(StopOutcome::Killed.was_killed());
        assert_eq!(StopOutcome::Killed.exit_code(), None);
        assert_eq!(StopOutcome::AlreadyGone.exit_code(), None);
    }
}
