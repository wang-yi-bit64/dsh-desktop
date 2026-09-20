# ADR-025 — 剪枝外来平台原生变体（linuxdeploy 杀手）

| | |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-09-12（含 rc.1 引入新布局后的复发修订） |
| 唯一产地 | `scripts/prune-platform-variants.mjs` |

## 背景

Linux 的 `build` job 曾**连续多轮**以 `failed to run linuxdeploy` 收场，而
tauri-bundler 在默认日志级别下**吞掉 linuxdeploy 的 stderr**，CI 上只留下一句
无信息量的错误（deb 正常，Windows/macOS 不经 linuxdeploy——红灯只出现在一个平台）。
用 `-v` 拿到真实报错才定位：

```
ERROR: Could not find dependency: libc.musl-x86_64.so.1
```

根因：linuxdeploy 会遍历 AppDir 内**每一个** ELF 并解析其动态依赖。
`@koromix/koffi-linux-x64` 在同一包里并列 glibc 与 musl 两份构建，`node-pty` 的
`prebuilds/` 也带齐所有平台架构；其中 musl 变体在 glibc 的 ubuntu runner 上
**必然**解析失败，于是整个 AppImage 打包被拖垮。

## 决策

在瘦身之后、打包之前调用 `prune-platform-variants.mjs` 剪掉外来变体。判据**有界**，
只对「目录名本身充当平台选择器」的两种布局动手：`prebuilds/`（prebuildify 约定）
与 libc 前缀目录（`musl_*` / 裸 `glibc`/`musl`）。包**名**里带平台后缀的
（`@img/sharp-linux-x64`）不碰——npm 已按 `os`/`cpu` 过滤。另有一道保险：
`prebuilds/` 目录之外只对**有同平台邻居**的目录按名删，永远不会删掉
「最后一个能用的」。剪掉它们不影响运行时：发布的 node 是 glibc 链接的，
koffi 按运行时 libc 选构建。

**复发（2026-09-12，rc.1 升级）**：新依赖
`@deepseek-ai/node-addon-system-linux-x64` 的布局是**裸 libc 名**
（`bin/glibc/system.node` 与 `bin/musl/system.node` 并列），而安全丝只认
`linux-x64` / `linux_x64`，不认裸名 `glibc` → `bin/musl` 逃过剪枝，linuxdeploy 又在
它上面 `Failed to run ldd`。修法：Linux 目标的保留名补上 `glibc`。

## 备选方案与取舍

- **遇到再删（不建通用判据）**：否决。每轮升级都可能引入新布局（已经复发一次），
  逐个案处理等于把打包可靠性挂在运气上。
- **扩大判据到所有含平台后缀的目录名**：否决。npm 已按 `os`/`cpu` 过滤的场景
  多此一举，且误删风险随判据半径上升。有界是刻意的。

## 后果

- AppImage 打包从「连续多轮红」变为可预期。
- 升级 DSH 时请复核：新版可能再带来新的「平台选择器目录名」写法；若再报
  `failed to run linuxdeploy`，先 `-v` 看是哪个 ELF，再核对这里的判据。

## 守卫与证据

- `npm run verify:variants`（19 项断言，含反向断言：**没有 glibc 邻居的孤独
  `bin/musl` 必须保留**——证明删除是「有邻居」驱动的，不是见到 musl 就删）。
- 可伪证性：把**现有**瘦身门禁 `pruneNodeModules()` 作用于同一棵树，必须复现出
  「`musl_x64/koffi.node` 原样幸存」——证明该缺陷逃得过当时全部门禁。
