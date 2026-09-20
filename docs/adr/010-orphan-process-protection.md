# ADR-010 — 孤儿进程防护三平台策略（INV-3）

| | |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-09（随 launch 链路定型；三平台硬门禁 2026-09-12 起） |
| 唯一产地 | `crates/dsh-host/src/process.rs`、`launch.rs` 派生路径 |

## 背景

主程序崩溃/被强杀时，Harness 子进程必须不残留。三平台可用的内核机制不同，
只能各用各的原语；而「只靠启动时清理陈旧 pidfile」不构成防护——宿主被杀的瞬间
孤儿已经产生。

## 决策

1. Windows：Win32 `JobObject` + `KILL_ON_JOB_CLOSE`——宿主句柄关闭即整树回收。
2. Linux：`PR_SET_PDEATHSIG` + 进程组。
3. macOS：无 `PDEATHSIG` 等价物，用**进程组 + Node 侧父死看门狗**
   （`build/parent-death-watchdog.mjs`，细节见 ADR-011）+ 启动时退出扫描清理。

## 备选方案与取舍

- **只靠启动时退出扫描（pidfile）**：否决。那是善后不是防护；窗口期内孤儿在跑。
- **三平台统一用轮询守护进程**：否决。Windows/Linux 有内核级原语可用时，
  用户态轮询白白多一个进程与一份失败模式。
- **macOS 用 `kqueue`/`EVFILT_PROC`**：未采纳。父进程是 Tauri 宿主自己，信号要在
  子进程侧观测父 pid；看门狗方案不依赖 macOS 版本特性，且能被本地实测
  （`DSH_PARENT_DEATH_WATCHDOG=1` 可在非 darwin 强制启用）。

## 后果

- 三平台各有专属失败模式，测试必须**逐平台**真实杀宿主（fault-inject 的
  A：SIGTERM 宿主 / B：强杀宿主）。
- 2026-09-12 冒烟转三平台硬门禁后，这两个场景当场暴露了 macOS 的长期缺口
  （导致 ADR-011 的补丁）。

## 守卫与证据

- `npm run fault-inject`（孤儿进程清理 + 退出码归因，6 类故障场景 / 10 项断言；
  2026-09-12 起三平台硬门禁）。
- `scripts/mock-harness.mjs` 与真实入口共用同一套看门狗挂载点（见 ADR-011）。
