# ADR-006 — 壳与上游边界：UI 归上游，注入只做壳→页单向

| | |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-09-10（「无初始化脚本」误判同日更正） |
| 唯一产地 | `src-tauri/src/lib.rs` 主窗口 builder、`src-tauri/src/harness_ui.rs` |

## 背景

一个曾被误判的机制问题：早期文档写「Harness 页没有 preload / initialization script，
任何 `window.*` 全局都无处定义」——**这句话是错的**。Tauri 的
`WebviewWindowBuilder::initialization_script` 会在每次顶层导航前执行脚本，正是
preload 的等价物，本仓已用它注入手机状态指示器。「定义不了全局」这个理由不成立。

**但结论不变，理由要换成成立的**：Harness 是远程 origin。页面若要回连宿主，就得为
这个远程 origin 开一个 IPC 入口，而本仓命令面是收紧的（ADR-005）；注入机制只用于
**壳层 → 页面**的单向下发。曾有一个补丁把原生目录选择器改成
`window.dshDesktopDirectoryPicker.pick()`，该全局从未被定义，工作区导入必然弹
「无法打开文件夹 / bridge is unavailable」（见 ADR-013）。

## 决策

1. 不重写 Harness UI：**UI 归上游 / 官方**，本仓是壳。
2. 不为 Harness 远程 origin 开反向 IPC；注入只做单向（壳 → 页面）。
3. 页内手机状态指示器是单向注入的边界样板：**只渲染状态、不可点击**——配对/停止
  仍只走原生 `Phone` 菜单，因此它不渲染成按钮，也就不需要新命令。

## 备选方案与取舍

- **为 Harness 页开 renderer 全局桥做功能**：否决。等于给远程 origin 一个命令面，
  与收紧的 IPC 准入冲突；且上游 stock 路径（`ctx.uiWorkspace.pickDirectory()` →
  Host seam → 进程内原生对话框）本来就存在，绕一圈没有收益。
- **把注入机制扩展成双向总线**：否决。单向下发的定位是安全边界，扩成总线就要按
  远程输入全面审计。

## 后果

- `harness-ui-inject.js` 按 origin 自我早退（本地页与子框架不注入），新增推送点
  （连接翻转、页面加载完成）都不新增 IPC 命令。
- 任何「让页面控制宿主」的新需求都要重新过本轮论证，不许拿「有注入机制」当先例。

## 守卫与证据

- `scripts/prepare-harness.mjs::assertPickerSurfaceIsHostBacked()`（构建期校验补丁
  后的文件不引用 `window.dshDesktop*` 且仍走 `ctx.uiWorkspace.pickDirectory()`）。
- `npm run verify:harness-inject`（19 项断言 + 可证伪性检查，含 origin 自早退）。
