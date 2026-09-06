//! T05 — 生命周期与 pidfile 清扫的集成面（C6 / INV-3）。
//!
//! 单元层已覆盖 `stop`/`stop_child` 的 SIGTERM→SIGKILL 语义细节；本文件从
//! `RunningHarness`（Launcher 产出）与 pidfile 清扫两个角度做端到端验证。

mod fixture;

use std::time::Duration;

use dsh_host::process::{
    clear_pid_file, now_seconds, read_pid_file, sweep_stale_process, write_pid_file, PidRecord,
};

use fixture::fixture;

/// 结束一个 RunningHarness 并断言退出可被观察到（C6 的平台级入口）。
#[tokio::test]
async fn terminate_then_wait_exit_observes_stop() {
    let Some(fx) = fixture() else {
        eprintln!("[skip] 未找到系统 node / mock 脚本，跳过 terminate 生命周期");
        return;
    };

    let env = fx.env();
    let launcher = fx.launcher(Duration::from_secs(20));
    let mut running = launcher
        .run(Some(&env), |_event| {})
        .await
        .expect("mock 应能就绪");

    running.terminate();
    let outcome = running
        .wait_exit()
        .await
        .expect("terminate 后应能等到退出")
        .expect("exit watcher 不应返回 IO 错误");
    // Windows：taskkill /F 以退出码结束；POSIX：SIGTERM/SIGKILL → code 为 None。
    // exit watcher 是「子进程已结束」的权威信号（Windows 上 tokio Child 句柄
    // 可能迟一个调度 tick 才 drop，OpenProcess 对已退出对象仍可能成功，
    // 因此不做额外 liveness 断言；无孤儿由 fault-inject 的 findOrphans 覆盖）。
    assert!(
        outcome.code().is_some() || !outcome.success(),
        "terminate 后子进程应已结束：{outcome:?}"
    );
}

/// pidfile：dead 记录被 `sweep_stale_process` 清掉（不 panic、不误杀）。
#[test]
fn sweep_clears_dead_pidfile_record() {
    let Some(fx) = fixture() else {
        eprintln!("[skip] 未找到系统 node / mock 脚本，跳过 pidfile 清扫");
        return;
    };

    let record = PidRecord {
        // 几乎不可能存活的 PID：不存在 → 应直接清掉死记录。
        pid: u32::MAX - 1,
        port: 0,
        resource_dir: fx.resource_dir.clone(),
        started_at: now_seconds(),
    };
    write_pid_file(&fx.layout, &record).expect("pidfile 应可写入");
    assert_eq!(read_pid_file(&fx.layout), Some(record));

    let swept = sweep_stale_process(&fx.layout).expect("清扫不应失败");
    assert_eq!(swept, None, "死记录不应返回被清扫的 pid");
    assert!(read_pid_file(&fx.layout).is_none(), "死记录应被 sweep 清理");
}

/// pidfile：外部进程（镜像不在资源目录）不被误杀，记录被清掉。
#[test]
fn sweep_never_kills_foreign_process() {
    let Some(fx) = fixture() else {
        eprintln!("[skip] 未找到系统 node / mock 脚本，跳过外部进程防误杀");
        return;
    };

    // 当前测试进程一定存活，但其镜像不在 fixture 资源目录下。
    let foreign = std::process::id();
    let record = PidRecord {
        pid: foreign,
        port: 0,
        resource_dir: fx.resource_dir.clone(),
        started_at: now_seconds(),
    };
    write_pid_file(&fx.layout, &record).expect("pidfile 应可写入");

    let swept = sweep_stale_process(&fx.layout).expect("清扫不应失败");
    assert_eq!(swept, None, "外部进程不得被清扫");
    assert!(
        read_pid_file(&fx.layout).is_none(),
        "外部进程的残留记录应被清理"
    );
    // 测试进程自身必须仍存活（未被误杀）。
    assert!(
        dsh_host::process::is_process_alive(foreign),
        "外部进程不应被终止"
    );
}

/// pidfile round-trip + 显式清理（CLI stop 依赖的同一组原语）。
#[test]
fn pidfile_round_trip_and_clear() {
    let Some(fx) = fixture() else {
        eprintln!("[skip] 未找到系统 node / mock 脚本，跳过 pidfile 原语");
        return;
    };

    let record = PidRecord {
        pid: 4242,
        port: 4173,
        resource_dir: fx.resource_dir.clone(),
        started_at: now_seconds(),
    };
    write_pid_file(&fx.layout, &record).expect("pidfile 应可写入");
    assert_eq!(read_pid_file(&fx.layout), Some(record));

    clear_pid_file(&fx.layout);
    assert!(read_pid_file(&fx.layout).is_none());
}

/// 启动成功后 pidfile 记录了真实子进程（next-start 清扫的依据）。
#[tokio::test]
async fn ready_launch_writes_live_pidfile() {
    let Some(fx) = fixture() else {
        eprintln!("[skip] 未找到系统 node / mock 脚本，跳过 pidfile 写入验证");
        return;
    };

    let env = fx.env();
    let launcher = fx.launcher(Duration::from_secs(20));
    let mut running = launcher
        .run(Some(&env), |_event| {})
        .await
        .expect("mock 应能就绪");
    let pid = running.pid;

    let record = read_pid_file(&fx.layout).expect("启动后应写入 pidfile");
    assert_eq!(record.pid, pid);
    assert_eq!(record.resource_dir, fx.resource_dir);
    assert!(record.port > 0);

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
