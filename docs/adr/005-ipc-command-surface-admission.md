# ADR-005 — IPC 命令面准入纪律：只保留有真实调用方的命令

| | |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-09-10（批次 A2 固化为自动门禁） |
| 唯一产地 | `src-tauri/src/commands.rs` 模块文档、`scripts/verify-ipc-surface.mjs` |

## 背景

每个 `#[tauri::command]` 都是对本地页面开放的攻击面。而「写了但没有调用方」这类
断线**在 Rust 里不可见**：`src-tauri` 是 `rlib`，`pub` 项一律算可达，`dead_code`
永不触发。曾据此清出两类死代码：`open_external`（「以为将来有用」，核验后发现职责
已被导航白名单完整覆盖）与 `safe-mode.html`（见 ADR-043）。

## 决策

1. 每个 `#[tauri::command]` 只保留**有真实前端调用方**的；当前 20 个命令全部有调用方。
2. 死命令要么接上、要么删掉——**不得为「可能有用的未来 UI」预留**。
3. 命令不返回裸 `false` / 伪造成功：失败必须是封套里的 `success: false` + 稳定
   `error.code`（恢复页按钮「点了没反应」的根因就是静默 `false`，改为 `E7002` 后才
   能如实报错）。

## 备选方案与取舍

- **按功能分组批量保留命令**：否决。分组是开发者视角，调用方才是准入门。
- **靠 clippy `dead_code` 兜底**：否决，已实测对它完全失明（见背景）。
- **进 oRPC / tRPC**：否决。对端是 Rust，TS 类型推导收益失效，还多一层运行时。

## 后果

- 命令面收敛到 20 个且逐个可追到调用方；`ALLOW_UNUSED_COMMANDS` 是**空表**
  （这是目标状态，不是待办）。
- 新增例外必须在 `ALLOW_*` 里写明理由，否则门禁红。

## 守卫与证据

- `npm run verify:ipc-surface`（命令定义 ↔ 注册 ↔ 前端 `invoke`/`listen` ↔
  `local_page` 目标 ↔ `#[allow(dead_code)]` 登记；**E7** 专查菜单项 id ↔
  `handle_menu_event` 分支，「点了没反应的菜单项」只有它看得见）。
