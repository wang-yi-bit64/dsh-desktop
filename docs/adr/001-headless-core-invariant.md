# ADR-001 — 核心库保持无头，判定标准是「能否在没有窗口系统的机器上测试」

| | |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-09-10（批次 D 前后确立口径） |
| 唯一产地 | `crates/dsh-host/`（`Cargo.toml` 无 GUI 依赖）、`AGENTS.md` §3.1 |

## 背景

诊断包导出、日志尾部读取最初实现放在 `src-tauri` 壳层。两个后果：

1. 本机 GNU 工具链下 `src-tauri` 的测试二进制**根本加载不了**（Tauri 无条件链接
   `webview2-com-sys` 的 WinRT 导入，见 `AGENTS.md` §2 环境限制），写在壳层的逻辑
   本地一行都跑不到，只能等 CI。
2. 「无 GUI 依赖」这条边界本来是设计目标，但没有一条可执行的判据来裁定
   「这个逻辑该放哪」，每次都要靠争论。

## 决策

判定问题只有一个：**它能不能在没有窗口系统的机器上被测试？** 能，就放无头 crate；
不能，才放 `src-tauri`。INV-6 据此执行，诊断导出（`diagnostics_export.rs`）、
日志尾部（`logs_view.rs`）、组装清单读取（`runtime_manifest.rs`）全部从壳层下沉到
`crates/dsh-host`，该 crate 严格不依赖 Tauri / UI 框架 / 窗口系统。

## 备选方案与取舍

- **留在壳层，靠 L2 GUI 冒烟覆盖**：否决。冒烟起真实窗口，在无显示器的环境不可用，
  且把「纯函数级脱敏规则」的测试成本抬到「起一个桌面应用」。
- **为壳层建 mock harness 跑单测**：否决。等于给每个平台各造一遍窗口系统语义，
  重复建造，而逻辑本身（读文件、正则替换、拼 JSON）与窗口无关。

## 后果

- 本机可直接跑 `cargo test -p dsh-contracts -p dsh-host -p dsh-host-cli`，
  日常反馈闭环不依赖 CI。
- `src-tauri` 的单测只能编译、实际执行者是 CI（MSVC 工具链）——这是**已知且被接受
  的边界**，写入 `AGENTS.md` §2，不是遗漏。
- 代价：跨层搬运有一次性成本；下沉错了会把简单逻辑拖进 core crate。

## 守卫与证据

- CI `cargo test --workspace`（三平台）覆盖 `dsh-host` 全部下沉逻辑。
- `AGENTS.md` §2「已知环境限制」两节把边界写死，防止后人把不可本地执行当成缺陷修。
