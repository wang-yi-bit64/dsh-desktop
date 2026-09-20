# ADR-013 — 目录选择器走 Host seam，禁止引入 renderer 全局桥

| | |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-09（批次 A~G 期间修复） |
| 唯一产地 | `scripts/prepare-harness.mjs::assertPickerSurfaceIsHostBacked()`、上游 stock 选择器 |

## 背景

一个 `patch-package` 补丁把原生目录选择器改成 `window.dshDesktopDirectoryPicker.pick()`。
该全局**在整个仓库中从未被定义**（从没有任何注入脚本定义过它），于是工作区导入时
必然弹出「无法打开文件夹 / DSH Desktop directory picker bridge is unavailable」。

即便今天有能力定义这样一个全局（见 ADR-006 关于 initialization_script 的更正），
也不该走这条路：页面回连宿主就要为 Harness 这个远程 origin 开一个 IPC 入口，
而本仓命令面是收紧的。

## 决策

目录选择器走**上游 stock 实现**：客户端调用 `ctx.uiWorkspace.pickDirectory()` →
Host `ctx.directoryPicker` seam → `@deepseek-ai/dsh-host-directory-picker-native`
在 Harness 进程内拉起 Win32 `IFileOpenDialog`。因为 Harness 绑定 `127.0.0.1`，
`directory-picker-auto` 必定解析到 native 组合，无需任何 renderer IPC。

## 备选方案与取舍

- **注入 `window.dshDesktop*` 全局 + 新增 IPC 命令**：否决。为远程 origin 开命令面
  （违反 ADR-006），且 `pick()` 的失败态（用户取消 vs 真故障）还要再设计一遍；
  stock 路径本来就存在。
- **删掉补丁、接受原生选择器在部分环境不可用**：否决。不可用是补丁造成的假象，
  不是上游限制。

## 后果

- 补丁面收缩：这条补丁的存在本身就是「壳越界改上游」的例子，构建期断言防止复发。
- 新补丁的原则：**改上游行为可以，不许把宿主能力塞给远程 origin 页面**。

## 守卫与证据

- `assertPickerSurfaceIsHostBacked()`：应用补丁后校验该文件不再引用
  `window.dshDesktop*` 且仍调用 `ctx.uiWorkspace.pickDirectory()`，违反即构建失败。
