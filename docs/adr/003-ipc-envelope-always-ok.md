# ADR-003 — 统一 IPC 封套 IpcEnvelope，外层 Result 恒为 Ok

| | |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-09-10（批次 E）；`Err` 装箱修订于 2026-09-11 |
| 唯一产地 | `crates/dsh-contracts/src/ipc.rs`、`src-tauri/src/commands.rs` |

## 背景

批次 E 把 17 个命令从 `Result<T, String>` 改成 `IpcEnvelope<T>`，让前端能按错误码
与类别分派。改动本身正确，但引入过两起事故：

1. **静默断页**：`frontend/updates.html` 继续把封套当快照用，`snapshot.phase`
   恒为 `undefined`，整页每次调用早退、永不渲染——没有编译错误、没有异常、没有日志。
2. **三平台 clippy 全红**：`ensure_local_origin` 的 `Err` 位置放了 `IpcEnvelope<()>`
   （128 字节），触发 `clippy::result_large_err`（`-D warnings` 下即错误）。

## 决策

1. 所有命令返回 `CommandResult<T> = Result<IpcEnvelope<T>, String>`，**外层 `Result`
   恒为 `Ok`**——它只为满足 Tauri 对 async 命令的编译要求；成败与错误码全在内层封套。
   **返回 `Err` 会让封套连同 `error.code` / `error.category` 一起丢失**，页面退回读字符串。
2. 确实需要大 `Err` 的助手函数（`ensure_local_origin`）用 `Box<IpcEnvelope<()>>`，
   `guard!` 宏相应 `failed(*error)`。
3. 页面必须解包 `success`，把 `envelope.data` 当载荷用；注意 `updates://status` 这类
   **事件**给的是裸快照——同一页面两种载荷形态，别弄混。

## 备选方案与取舍

- **给 `AppError` 拆箱改共享契约**：否决。会让所有错误构造多一次分配，却只修得掉
  那一处 clippy 报错，成本与收益不成比例。
- **`#[allow(clippy::result_large_err)]`**：否决。本仓口径是能修根因不压制
  （`Box` 正是 clippy 自己给的建议之一）；真要压制必须连同理由写进文档。

## 后果

- 前端可稳定按错误码分派；跨页面「调了命令没解包」成为一类**必须有门禁**的缺陷
  （P6 检查，见 ADR-032）。
- 改命令返回形态属于破坏性变更：编译器不会报任何错，只有运行时冒烟看得见。

## 守卫与证据

- `npm run verify:shell-pages`（P6 专查封套解包；updates.html 事故即它抓到）。
- `npm run verify:ipc-surface`（命令定义 ↔ 注册 ↔ 前端调用一致性）。
- `cargo clippy --workspace --all-targets -- -D warnings`（与 CI 逐字一致，本地先跑）。
